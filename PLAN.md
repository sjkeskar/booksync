# Bookmark Sync — Implementation Plan

Private Chromium extension (Chrome, Edge, Brave, Vivaldi) that keeps bookmarks in sync across a
person's desktop browsers, using an **end-to-end encrypted** store in their own Google Drive
(`appDataFolder`). Used by the owner and family; installed unpacked, never published.

---

## 1. Decisions

| Topic | Decision |
|---|---|
| Browsers | Chromium-based desktop browsers, Manifest V3. Mobile browsers can't run extensions. |
| Backend | Google Drive `appDataFolder`, scope `drive.appdata` only. Pluggable `StorageBackend` interface. |
| Auth | `chrome.identity.launchWebAuthFlow` + implicit token flow (works in all Chromium browsers). No client secret. Token kept in `chrome.storage.session` (memory). |
| Encryption | **Mandatory.** PBKDF2-SHA256 (600k) → HKDF → AES-256-GCM. Non-extractable `CryptoKey` cached in IndexedDB. AAD binds file path + schema. |
| Concurrency | Each device writes **only its own file**; all devices merge all files with a deterministic CRDT merge. No shared-file overwrites. |
| Dedupe | On: same parent + same normalized URL → one survivor (lowest id). |
| Distribution | Unpacked, from private repo. Fixed `key` in manifest → identical extension ID on every PC (needed for the OAuth redirect URI). |
| Chrome Sync | Warn user to turn off native bookmark sync to avoid two systems fighting. |

## 2. Architecture

```
src/core/         pure TypeScript, no chrome.* — fully unit/property tested
  hlc.ts          hybrid logical clock
  fracIndex.ts    fractional position keys
  urlNorm.ts      URL normalization (dedupe/matching)
  model.ts        SyncNode / SyncState / DeviceFile types + helpers
  merge.ts        LWW-per-field CRDT merge of N states
  invariants.ts   orphans, cycles, dedupe, position repair (deterministic)
  diff.ts         local tree vs. base → field changes stamped with HLC
  initialJoin.ts  first-time content matching (union only, never deletes)
  planner.ts      merged state vs. local tree → ordered browser ops
  safety.ts       mass-delete gate, risky-URL approval detection
  export.ts       Netscape bookmarks.html + JSON export
  retention.ts    snapshot retention (GFS) decisions
src/adapters/browser/   chrome.bookmarks ↔ LocalTree, apply plan, id map
src/adapters/storage/   StorageBackend: gdrive.ts, memory.ts; crypto.ts; codec.ts
src/background/         service worker: orchestrator, triggers, lock, journal, housekeeping
src/ui/                 popup, options (wizard, settings, devices, export, restore, logs)
test/                   unit, property (fast-check), multi-device simulator
```

## 3. Remote layout (Drive appDataFolder; all files encrypted except meta.json)

```
meta.json                      { schema, kdf:{salt,iterations}, keyEpoch, check (encrypted) }
devices/<deviceId>.bin         one per device, written ONLY by that device
snapshots/YYYY-MM-DD.bin       merged tree; GFS retention
housekeeping.json              lease { deviceId, expires } so usually one PC does cleanup
```
Drive allows duplicate names; we use names as flat strings (`devices__<id>.bin`) and housekeeping
keeps the newest of any duplicate.

## 4. Data model

```ts
type HLC = { ms: number; c: number; dev: string };
type LWW<T> = { v: T; t: HLC };
interface SyncNode {
  id: string;                       // UUID; roots: root:bar | root:other | root:mobile
  kind: 'bookmark' | 'folder';
  title: LWW<string>;
  url?: LWW<string>;
  place: LWW<{ parent: string; pos: string }>;
  deleted: LWW<boolean>;
  added: number;                    // dateAdded (ms)
}
interface DeviceFile {
  schema: 1; deviceId; deviceName; browser; incarnation; writeSeq;
  lastSync: number; seen: Record<deviceId, HLC>; nodes: Record<id, SyncNode>;
}
```
Merge: per field, highest HLC wins (tie → compare `dev`). Commutative, associative, idempotent.

## 5. Sync cycle (under lock, journaled)

1. Lock; skip if a bookmark import is in progress.
2. Read local tree. 3. Diff vs. base → local changes (HLC stamped).
4. Pull changed remote device files (etag cache). Verify incarnation of own file (cloned-profile detection).
5. Merge → invariants (orphans resurrect parents, cycle break, dedupe).
6. Safety gate: > 20 deletes or > 10% of tree → pause for approval. New/changed `javascript:`/`data:` URLs from other devices → held for approval.
7. Plan ops (folders top-down → moves → updates → bookmarks → removes bottom-up).
8. Journal; 9. Apply (events suppressed); 10. Push own file if content changed (or daily heartbeat).
11. Commit base. 12. If remote changed during sync → schedule immediate resync.

Triggers: debounced bookmark events (5 s), startup, alarm (default 5 min), idle→active, Sync now.

## 6. Conflict rules

| Case | Rule |
|---|---|
| Concurrent adds in one folder | Both kept; order by pos then id |
| Same URL added twice in same folder | Dedupe → lowest id survives |
| Rename vs. add-child / rename vs. move | Different fields → both apply |
| Same field edited twice | Later HLC wins |
| Delete vs. edit | Later HLC wins |
| Folder deleted while child added elsewhere | Child alive → parent chain resurrected |
| Move cycle | Node with newest `place` HLC in the cycle moved to `Other/Recovered` |
| Parent unknown | Move to `Other/Recovered` |
| Clock skew | HLC; remote timestamps > now + 5 min clamped, UI warning |

## 7. First-time join (no base on this device)

* Remote empty → upload. Local empty → download.
* Both non-empty → user picks **Merge (default)** / Use synced copy / Use this browser's.
* Before any choice: local backup to `storage.local` + offered JSON/HTML export.
* Merge: roots by type; folders by (matched parent, title ci, ordinal); bookmarks by
  (matched parent, normalized URL). Unmatched local → new nodes; unmatched remote → created
  locally. **Absence never means deletion.**
* Reinstall → new deviceId + content matching → no duplicates. Cloned profile → own file changed
  by someone else (incarnation or writeSeq mismatch) → new deviceId. Evicted device (own file
  gone) → rejoin by union merge.

## 8. Security

Threats & defenses: encrypted-at-rest (GCM, AAD = path+schema), least privilege (`bookmarks`,
`storage`, `unlimitedStorage`, `alarms`, `identity`, `idle`; hosts: googleapis + accounts.google),
no content scripts, no remote code, strict CSP, zero runtime deps, logs never contain URLs/titles,
token in session storage only, risky-URL approval, per-person accounts & passphrases.
Lost passphrase → "Reset sync" re-keys from local bookmarks. Passphrase change → re-encrypt, bump
`keyEpoch`.

## 9. Storage retention

| Item | Policy |
|---|---|
| Device files | Upload only on content change (+ ≤1 heartbeat/day); daily delete of non-head revisions |
| Snapshots | 14 daily, 8 weekly, 12 monthly; skip if hash unchanged |
| Tombstones | GC after 90 days **once every device file acknowledges them** (carries the tombstone, or was written after the deletion and no longer has the record). An offline PC therefore blocks GC instead of resurrecting deleted items. |
| Stale devices | Flagged at 60 days, file auto-deleted at 180 days; manual "Forget". An evicted PC that returns rejoins by union merge. |
| Duplicates | Newest of same-named files kept |
| Budget | 50 MB cap → prune oldest snapshots (keep ≥ 7) |
| Wipe | "Remove all synced data" button |

## 10. Export

Netscape `bookmarks.html` (importable by every major browser) or JSON. Source: current tree or any
retained snapshot. Scope: everything or one folder subtree. Option to drop `javascript:` bookmarks.
Generated locally, downloaded via `<a download>`; never stored unencrypted in Drive.

## 11. Phases

| # | Phase | Status |
|---|---|---|
| 0 | Manual verification (needs real Google project) — README §8 | manual, pending |
| 1 | Core engine + unit/property/simulator tests | done |
| 2 | Browser adapter: read tree, id map, apply plan, event tracking | done |
| 3 | Crypto + codec + StorageBackend (memory, Google Drive) + OAuth | done |
| 4 | Orchestrator: triggers, journal, safety gate, backoff, clone/eviction detection | done |
| 5 | UI: setup wizard, popup, options | done |
| 6 | Housekeeping (revisions, GFS snapshots, stale devices, duplicates, budget) + export/restore | done |
| 7 | Simulator + service tests, build, README | done |

### Phase 0 checklist (manual, by owner)
- Create Google Cloud project, enable Drive API, OAuth consent screen (External, **In production**),
  Web-application client with redirect `https://<extension-id>.chromiumapp.org/`.
- Confirm `drive.appdata` doesn't trigger verification and sign-in doesn't expire after 7 days.
- Confirm identical extension ID on all PCs (manifest `key`).
- Confirm `folderType` / account-vs-local bookmark trees on your Chrome version.
