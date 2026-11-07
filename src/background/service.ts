import { applyOps, readRawTree, type RawTree } from '../adapters/browser/bookmarks';
import { AuthError, FILES, newestByName, RetryableError, type RemoteFile, type StorageBackend } from '../adapters/storage/backend';
import { openJson, sealJson, sha256Hex } from '../adapters/storage/codec';
import { deriveKey, makeKeyCheck, newKdfParams, verifyKeyCheck, type KdfParams } from '../adapters/storage/crypto';
import type { KeyStore } from '../adapters/storage/keystore';
import { DEVICE_FILE_SCHEMA, nodesToState, stateToNodes, validateDeviceFile, type DeviceFile } from '../core/deviceFile';
import { runSync, type EngineOutput } from '../core/engine';
import { toJsonExport, toNetscapeHtml, type ExportOptions } from '../core/export';
import { Clock } from '../core/hlc';
import { IdMap } from '../core/idmap';
import type { JoinMode } from '../core/initialJoin';
import { materialize } from '../core/materialize';
import { mergeStates, type PeerView } from '../core/merge';
import { addNode, countBookmarks, newTree, ROOTS, treeFromList, treeToList, type TNode, type Tree } from '../core/model';
import { plan as makePlan } from '../core/planner';
import { DELETE_DEVICE_AGE, HEARTBEAT_INTERVAL, isoDate, pruneForBudget, snapshotsToKeep } from '../core/retention';
import * as events from './events';
import {
  freshLocalState,
  loadSettings,
  loadState,
  loadStatus,
  log,
  randomId,
  saveState,
  saveStatus,
  type LocalState,
  type Settings,
  type Status,
} from './state';

export interface Meta {
  schema: 1;
  kdf: KdfParams;
  keyEpoch: number;
  check: string;
  createdAt: number;
}

interface SnapshotFile {
  schema: 1;
  date: string;
  deviceId: string;
  nodes: TNode[];
}

export interface EventSource {
  takeEventTimes(): Promise<Record<string, number>>;
  clearEventTimes(c: Record<string, number>): Promise<void>;
  beginApply(): void;
  endApply(): Set<string>;
  isImporting(): boolean;
}

export interface ServiceDeps {
  backend: () => StorageBackend;
  keyStore: KeyStore;
  now?: () => number;
  events?: EventSource;
  version?: string;
  browserName?: () => Promise<string>;
  /** Called with the delay when the service wants another sync soon. */
  scheduleResync?: (ms: number) => void;
  /** Lower KDF cost for tests. */
  kdfIterations?: number;
  onSignIn?: () => Promise<string>;
}

export type SyncOutcome =
  | 'ok'
  | 'busy'
  | 'importing'
  | 'not-configured'
  | 'locked'
  | 'needs-join'
  | 'needs-approval'
  | 'signin-required'
  | 'offline'
  | 'error';

export interface SyncOptions {
  joinMode?: JoinMode;
  allowDeletes?: boolean;
  reason?: string;
}

const newSyncId = () => randomId(16);

export class SyncService {
  private running: Promise<SyncOutcome> | null = null;
  private backoff = 0;
  private readonly now: () => number;
  private readonly ev: EventSource;

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.ev = deps.events ?? events;
  }

  private get backend() {
    return this.deps.backend();
  }

  // ------------------------------------------------------------------ status helpers
  private async setStatus(patch: Partial<Status>): Promise<Status> {
    const s = { ...(await loadStatus()), ...patch };
    await saveStatus(s);
    return s;
  }

  // ------------------------------------------------------------------ remote meta / key
  private async readMeta(files: RemoteFile[]): Promise<{ meta: Meta; file: RemoteFile } | null> {
    const f = newestByName(files).get(FILES.meta);
    if (!f) return null;
    const meta = JSON.parse(new TextDecoder().decode(await this.backend.read(f.id))) as Meta;
    if (meta.schema !== 1 || typeof meta.keyEpoch !== 'number' || !meta.kdf || !meta.check) throw new Error('meta.json is invalid');
    return { meta, file: f };
  }

  private async writeMeta(meta: Meta, existing?: RemoteFile): Promise<void> {
    await this.backend.write(FILES.meta, new TextEncoder().encode(JSON.stringify(meta)), existing?.id);
  }

  /** Does a synced copy already exist for this Google account? */
  async remoteExists(): Promise<boolean> {
    return !!(await this.readMeta(await this.backend.list()));
  }

  /** First device ever: create the encrypted store with this passphrase. */
  async createRemote(passphrase: string): Promise<void> {
    const files = await this.backend.list();
    if (await this.readMeta(files)) throw new Error('A synced copy already exists for this account — enter its passphrase instead.');
    const kdf = newKdfParams(this.deps.kdfIterations);
    const key = await deriveKey(passphrase, kdf);
    const meta: Meta = { schema: 1, kdf, keyEpoch: 1, check: await makeKeyCheck(key), createdAt: this.now() };
    await this.writeMeta(meta);
    await this.deps.keyStore.save(key, meta.keyEpoch);
    await log('info', 'Created encrypted sync store');
  }

  /** Join an existing store: verify the passphrase and remember the key on this device. */
  async unlock(passphrase: string): Promise<void> {
    const m = await this.readMeta(await this.backend.list());
    if (!m) throw new Error('No synced copy found for this account.');
    const key = await deriveKey(passphrase, m.meta.kdf);
    if (!(await verifyKeyCheck(key, m.meta.check))) throw new Error('Wrong passphrase.');
    await this.deps.keyStore.save(key, m.meta.keyEpoch);
    await log('info', `Unlocked with key epoch ${m.meta.keyEpoch}`);
  }

  // ------------------------------------------------------------------ sync
  sync(opts: SyncOptions = {}): Promise<SyncOutcome> {
    if (this.running) return Promise.resolve('busy');
    this.running = this.syncLocked(opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async syncLocked(opts: SyncOptions): Promise<SyncOutcome> {
    if (this.ev.isImporting()) return 'importing';
    const started = this.now();
    await this.setStatus({ phase: 'syncing', message: 'Syncing…', lastAttempt: started });
    try {
      const r = await this.doSync(opts);
      this.backoff = 0;
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof AuthError) {
        await this.setStatus({ phase: 'signin-required', message: 'Sign in to Google again', lastError: msg });
        await log('warn', `Auth: ${msg}`);
        return 'signin-required';
      }
      if (e instanceof RetryableError) {
        this.backoff = Math.min(Math.max(this.backoff * 2, 30_000), 30 * 60_000);
        this.deps.scheduleResync?.(Math.max(this.backoff, e.retryAfterMs));
        await this.setStatus({ phase: 'offline', message: 'Offline — will retry', lastError: msg });
        await log('warn', `Retryable: ${msg}`);
        return 'offline';
      }
      await this.setStatus({ phase: 'error', message: 'Sync failed', lastError: msg });
      await log('error', msg);
      return 'error';
    }
  }

  private async doSync(opts: SyncOptions): Promise<SyncOutcome> {
    const now = this.now();
    const settings = await loadSettings();
    const st = await loadState();
    const k = await this.deps.keyStore.load();
    if (!k) {
      await this.setStatus({ phase: 'not-configured', message: 'Set up sync in Options' });
      return 'not-configured';
    }
    const files = await this.backend.list();
    const m = await this.readMeta(files);
    if (!m) {
      await this.setStatus({ phase: 'not-configured', message: 'The synced copy was removed — set up sync again' });
      return 'not-configured';
    }
    if (m.meta.keyEpoch !== k.epoch) {
      await this.setStatus({ phase: 'locked', message: 'The sync passphrase was changed on another device — enter the new one' });
      return 'locked';
    }
    const key = k.key;
    const byName = newestByName(files);
    const ids = new IdMap(st.ids);
    const raw = await readRawTree(settings.treePref);
    const warnings: string[] = [];
    if (raw.dualStorage) warnings.push(`This browser keeps separate account and local bookmarks; syncing the ${raw.usingAccountTree ? 'account' : 'local'} set.`);

    // Crash during a previous apply: whatever is in the browser now is the agreed base.
    if (st.journal?.applying && st.base) {
      st.base = treeToList(ids.mapTree(raw.tree, newSyncId));
      st.baseRoots = [...raw.tree.children.keys()].filter((r) => (ROOTS as readonly string[]).includes(r));
      st.journal = null;
      await log('warn', 'Recovered from an interrupted sync');
    }

    // Own file checks: evicted (removed by housekeeping / remote reset) or cloned profile.
    let own = byName.get(FILES.device(st.deviceId));
    if (st.base && st.everPushed && !own) {
      await log('warn', 'This device’s sync file is gone (evicted or reset) — rejoining with a merge');
      Object.assign(st, { base: null, known: [], ids: [], everPushed: false, lastPushedHash: '', lastPushedVersion: '', writeSeq: 0 });
      ids.entries().forEach(([l]) => ids.deleteLocal(l));
      opts = { ...opts, joinMode: 'merge' };
    } else if (own && st.lastPushedVersion && own.version !== st.lastPushedVersion) {
      const df = await this.readDevice(key, own, st.deviceId).catch((e) => {
        if (e instanceof RetryableError || e instanceof AuthError) throw e;
        return null;
      });
      // Our own upload whose bookkeeping didn't get saved (crash right after writing)?
      const ownLostWrite =
        !!df && df.incarnation === st.incarnation && df.writeSeq === st.writeSeq + 1 && (await sha256Hex(JSON.stringify(df.nodes))) === (await sha256Hex(JSON.stringify(st.known)));
      // Same content we wrote; Drive bumped the version for a metadata change (e.g. revision cleanup).
      const metadataOnly = !!df && df.incarnation === st.incarnation && df.writeSeq === st.writeSeq;
      if (ownLostWrite || metadataOnly) {
        Object.assign(st, { writeSeq: df!.writeSeq, lastPushedVersion: own.version });
      } else {
        const old = st.deviceId;
        st.deviceId = randomId(10);
        st.incarnation = randomId(16);
        Object.assign(st, { writeSeq: 0, everPushed: false, lastPushedHash: '', lastPushedVersion: '' });
        own = undefined;
        await log('warn', `Another installation is using device id ${old}; this one is now ${st.deviceId}`);
      }
    }

    // Peers
    const peers: PeerView[] = [];
    const seen = new Set<string>();
    for (const f of byName.values()) {
      if (!FILES.isDevice(f.name)) continue;
      const id = FILES.deviceIdOf(f.name);
      if (id === st.deviceId) continue;
      seen.add(id);
      let entry = st.peerCache[id];
      if (!entry || entry.version !== f.version) {
        try {
          const df = await this.readDevice(key, f, id);
          entry = { version: f.version, lastSync: df.lastSync, deviceName: df.deviceName, browser: df.browser, extVersion: df.extVersion, nodes: df.nodes };
          st.peerCache[id] = entry;
        } catch (e) {
          if (e instanceof RetryableError || e instanceof AuthError) throw e;
          warnings.push(`Could not read the sync file of device ${id}`);
          await log('warn', `Skipping device ${id}: ${e instanceof Error ? e.message : e}`);
          continue;
        }
      }
      peers.push({ state: nodesToState(entry.nodes), lastSync: entry.lastSync });
    }
    for (const id of Object.keys(st.peerCache)) if (!seen.has(id)) delete st.peerCache[id];

    // Initial join needs the user's choice when both sides have bookmarks.
    const joining = !st.base;
    let eventTimes = new Map<string, number>();
    let consumed: Record<string, number> = {};
    let local: Tree;
    if (joining) {
      const localCount = countBookmarks(raw.tree);
      const remoteCount = countBookmarks(materialize(mergeStates(...peers.map((p) => p.state))));
      let mode = opts.joinMode;
      if (!mode && (localCount === 0 || remoteCount === 0)) mode = 'merge';
      if (!mode) {
        await saveState(st);
        await this.setStatus({ phase: 'needs-join', message: 'Choose how to combine this browser’s bookmarks with the synced copy', join: { localCount, remoteCount }, warnings });
        return 'needs-join';
      }
      opts = { ...opts, joinMode: mode };
      st.joinBackup = treeToList(raw.tree);
      local = raw.tree;
      await log('info', `Initial join (${mode}): ${localCount} local, ${remoteCount} synced bookmarks`);
    } else {
      consumed = await this.ev.takeEventTimes();
      for (const [lid, t] of Object.entries(consumed)) {
        const sid = ids.toSync(lid);
        if (sid) eventTimes.set(sid, t);
      }
      local = ids.mapTree(raw.tree, newSyncId);
      for (const [lid, t] of Object.entries(consumed)) {
        const sid = ids.toSync(lid);
        if (sid && !eventTimes.has(sid)) eventTimes.set(sid, t);
      }
    }

    const clock = new Clock(st.deviceId, st.clock, this.now);
    const out = runSync({
      base: st.base ? treeFromList(st.base, st.baseRoots.length ? st.baseRoots : ROOTS) : null,
      known: nodesToState(st.known),
      local,
      remotes: peers,
      clock,
      eventTimes,
      now,
      ...(opts.joinMode ? { joinMode: opts.joinMode } : {}),
      newId: newSyncId,
      approvedRisky: st.approvedRisky,
      safety: { maxDeletes: settings.maxDeletes, maxDeleteFraction: settings.maxDeleteFraction },
      ...(opts.allowDeletes ? { allowDeletes: true } : {}),
    });
    if (out.ids) for (const [l, s] of out.ids) ids.set(l, s);
    if (out.dedupeRemoved.length) await log('info', `Removed ${out.dedupeRemoved.length} duplicate bookmark(s)`);

    let base: Tree;
    if (out.blocked) {
      base = out.local;
      await log('warn', `Paused: sync would delete ${out.blocked.count} of ${out.blocked.total} bookmarks`);
    } else {
      // Write-ahead: if the worker dies mid-apply, the next run adopts the browser as base.
      st.known = stateToNodes(out.state);
      st.ids = ids.entries();
      st.clock = clock.state;
      st.journal = { applying: true, at: now };
      await saveState(st);
      base = await this.applyPlan(out, ids, raw, settings);
      st.journal = null;
    }

    st.base = treeToList(base);
    st.baseRoots = [...base.children.keys()].filter((r) => (ROOTS as readonly string[]).includes(r));
    st.known = stateToNodes(out.state);
    st.ids = ids.entries();
    st.clock = clock.state;
    st.lastSync = now;
    await saveState(st);
    if (!joining) await this.ev.clearEventTimes(consumed);

    await this.push(st, key, own, settings);
    await saveState(st);

    try {
      await this.housekeeping(st, key, byName, out.view, false);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      await log('warn', `Housekeeping: ${e instanceof Error ? e.message : e}`);
    }
    await saveState(st);

    // Another device wrote while we were syncing → go again shortly.
    const after = newestByName(await this.backend.list());
    for (const f of after.values()) {
      if (!FILES.isDevice(f.name)) continue;
      const id = FILES.deviceIdOf(f.name);
      if (id !== st.deviceId && st.peerCache[id]?.version !== f.version) {
        this.deps.scheduleResync?.(3000);
        break;
      }
    }

    const pendingRisky = out.plan.held.map((id) => {
      const n = out.view.nodes.get(id)!;
      return { id, title: n.title.slice(0, 200), url: (n.url ?? '').slice(0, 500) };
    });
    const blocked = out.blocked;
    await this.setStatus({
      phase: blocked ? 'needs-approval' : pendingRisky.length ? 'needs-approval' : 'idle',
      message: blocked
        ? `Waiting for approval: ${blocked.count} bookmarks would be deleted`
        : pendingRisky.length
          ? `${pendingRisky.length} script bookmark(s) waiting for approval`
          : 'Up to date',
      lastSync: now,
      lastError: '',
      pendingDeletes: blocked ? { count: blocked.count, total: blocked.total } : null,
      pendingRisky,
      join: null,
      warnings,
      bookmarkCount: countBookmarks(out.view),
      deviceCount: peers.length + 1,
    });
    return blocked ? 'needs-approval' : 'ok';
  }

  private async applyPlan(out: EngineOutput, ids: IdMap, raw: RawTree, settings: Settings): Promise<Tree> {
    if (!out.plan.ops.length) return out.local;
    this.ev.beginApply();
    let res: Awaited<ReturnType<typeof applyOps>>;
    let during: Set<string>;
    try {
      res = await applyOps(out.plan.ops, ids, raw.rootMap);
    } finally {
      during = this.ev.endApply();
    }
    if (res.failed.length) await log('warn', `${res.failed.length} of ${out.plan.ops.length} bookmark changes failed; will retry`);
    await log('info', `Applied ${res.applied} change(s) to this browser`);
    const after = ids.mapTree((await readRawTree(settings.treePref)).tree, newSyncId);
    // Changes the user made while we were applying must not be absorbed into the base.
    const userIds = new Set<string>();
    for (const l of during) if (!res.touched.has(l)) {
      const s = ids.toSync(l);
      if (s) userIds.add(s);
    }
    if (!userIds.size) return after;
    const t = newTree([...after.children.keys()].filter((r) => (ROOTS as readonly string[]).includes(r)));
    const skip = new Set<string>();
    for (const n of treeToList(after)) {
      if (userIds.has(n.id) || skip.has(n.parent)) {
        skip.add(n.id);
        continue;
      }
      addNode(t, { ...n });
    }
    return t;
  }

  private async readDevice(key: CryptoKey, f: RemoteFile, expectId: string): Promise<DeviceFile> {
    const df = validateDeviceFile(await openJson(key, await this.backend.read(f.id), `device:${expectId}`));
    if (df.deviceId !== expectId) throw new Error('device id mismatch');
    return df;
  }

  private async push(st: LocalState, key: CryptoKey, own: RemoteFile | undefined, settings: Settings): Promise<void> {
    const now = this.now();
    const nodes = st.known;
    const hash = await sha256Hex(JSON.stringify(nodes));
    if (st.everPushed && hash === st.lastPushedHash && now - st.lastPushAt < HEARTBEAT_INTERVAL) return;
    const df: DeviceFile = {
      schema: DEVICE_FILE_SCHEMA,
      deviceId: st.deviceId,
      deviceName: settings.deviceName || (await this.deps.browserName?.()) || 'Browser',
      browser: (await this.deps.browserName?.()) ?? 'Chromium',
      incarnation: st.incarnation,
      writeSeq: st.writeSeq + 1,
      lastSync: now,
      extVersion: this.deps.version ?? '0',
      nodes,
    };
    const f = await this.backend.write(FILES.device(st.deviceId), await sealJson(key, df, `device:${st.deviceId}`), own?.id);
    Object.assign(st, { writeSeq: df.writeSeq, lastPushedHash: hash, lastPushedVersion: f.version, lastPushAt: now, everPushed: true });
  }

  // ------------------------------------------------------------------ approvals
  async approveDeletes(): Promise<SyncOutcome> {
    return this.sync({ allowDeletes: true, reason: 'approved deletes' });
  }

  /** Keep the bookmarks a paused sync wanted to delete — and re-share them with every device. */
  async keepMine(): Promise<SyncOutcome> {
    const st = await loadState();
    if (st.base) {
      const known = nodesToState(st.known);
      const view = materialize(mergeStates(known, ...Object.values(st.peerCache).map((p) => nodesToState(p.nodes))));
      const base = treeFromList(st.base, st.baseRoots.length ? st.baseRoots : ROOTS);
      const kept = newTree([...base.children.keys()]);
      const skip = new Set<string>();
      for (const n of treeToList(base)) {
        if (!view.nodes.has(n.id) || skip.has(n.parent)) {
          skip.add(n.id);
          continue;
        }
        addNode(kept, { ...n });
      }
      st.base = treeToList(kept);
      await saveState(st);
      await log('info', `Keeping ${skip.size} item(s) instead of deleting them`);
    }
    return this.sync({ reason: 'keep mine' });
  }

  async approveRisky(id: string, url: string): Promise<SyncOutcome> {
    const st = await loadState();
    st.approvedRisky[id] = url;
    await saveState(st);
    return this.sync({ reason: 'approved script bookmark' });
  }

  /** Reject a script bookmark: delete it everywhere. */
  async rejectRisky(id: string): Promise<SyncOutcome> {
    const st = await loadState();
    const known = nodesToState(st.known);
    const n = known[id];
    if (n) {
      const clock = new Clock(st.deviceId, st.clock, this.now);
      known[id] = { ...n, del: { v: true, t: clock.stamp() } };
      st.known = stateToNodes(known);
      st.clock = clock.state;
      await saveState(st);
    }
    return this.sync({ reason: 'rejected script bookmark' });
  }

  // ------------------------------------------------------------------ housekeeping
  async housekeeping(st: LocalState, key: CryptoKey, byName: Map<string, RemoteFile>, view: Tree, force: boolean): Promise<void> {
    const now = this.now();
    if (!force && now - st.lastHousekeeping < 20 * 3600_000) return;
    const settings = await loadSettings();
    const leaseF = byName.get(FILES.lease);
    let lease: { deviceId: string; until: number; lastRun: number } | null = null;
    if (leaseF) {
      try {
        lease = JSON.parse(new TextDecoder().decode(await this.backend.read(leaseF.id)));
      } catch {
        lease = null;
      }
    }
    if (!force && lease && lease.lastRun > now - 20 * 3600_000) {
      st.lastHousekeeping = lease.lastRun;
      return;
    }
    if (!force && lease && lease.until > now && lease.deviceId !== st.deviceId) return;
    let leaseId = leaseF?.id;
    const writeLease = async (l: object) => {
      leaseId = (await this.backend.write(FILES.lease, new TextEncoder().encode(JSON.stringify(l)), leaseId)).id;
    };
    await writeLease({ deviceId: st.deviceId, until: now + 10 * 60_000, lastRun: lease?.lastRun ?? 0 });

    const all = await this.backend.list();
    let deleted = 0;
    // 1. duplicate names → keep newest
    const newest = newestByName(all);
    for (const f of all) {
      if (newest.get(f.name)?.id !== f.id && f.id !== leaseId) {
        await this.backend.remove(f.id);
        deleted++;
      }
    }
    // 2. devices gone for 180 days
    for (const f of newest.values()) {
      if (!FILES.isDevice(f.name)) continue;
      const id = FILES.deviceIdOf(f.name);
      if (id === st.deviceId) continue;
      const last = st.peerCache[id]?.lastSync ?? f.modified;
      if (now - last > DELETE_DEVICE_AGE) {
        await this.backend.remove(f.id);
        delete st.peerCache[id];
        newest.delete(f.name);
        deleted++;
        await log('info', `Removed sync file of device ${id} (inactive > 180 days)`);
      }
    }
    // 3. today's snapshot (skip if identical to the most recent one)
    const today = isoDate(now);
    const snaps = [...newest.values()].filter((f) => FILES.isSnapshot(f.name));
    if (!newest.has(FILES.snapshot(today))) {
      const nodes = treeToList(view);
      const hash = await sha256Hex(JSON.stringify(nodes));
      if (hash !== (await this.lastSnapshotHash())) {
        const snap: SnapshotFile = { schema: 1, date: today, deviceId: st.deviceId, nodes };
        const f = await this.backend.write(FILES.snapshot(today), await sealJson(key, snap, `snapshot:${today}`));
        snaps.push(f);
        await chrome.storage.local.set({ lastSnapshotHash: hash });
      }
    }
    // 4. GFS retention + storage budget
    const keep = snapshotsToKeep(snaps.map((f) => FILES.snapshotDateOf(f.name)), today);
    const kept = [];
    for (const f of snaps) {
      if (keep.has(FILES.snapshotDateOf(f.name))) kept.push(f);
      else {
        await this.backend.remove(f.id);
        deleted++;
      }
    }
    const other = [...newest.values()].filter((f) => !FILES.isSnapshot(f.name)).reduce((s, f) => s + f.size, 0);
    for (const name of pruneForBudget(kept.map((f) => ({ name: f.name, size: f.size, date: FILES.snapshotDateOf(f.name) })), other, settings.budgetMB * 1024 * 1024)) {
      const f = kept.find((x) => x.name === name)!;
      await this.backend.remove(f.id);
      deleted++;
    }
    // 5. old revisions (Drive keeps them and they count toward quota)
    let revs = 0;
    for (const f of newest.values()) {
      if (!FILES.isDevice(f.name) && f.name !== FILES.meta) continue;
      const list = await this.backend.listRevisions(f.id);
      if (list.length <= 1) continue;
      const head = list.reduce((a, b) => (b.modified >= a.modified ? b : a));
      for (const r of list) if (r.id !== head.id) {
        await this.backend.deleteRevision(f.id, r.id);
        revs++;
      }
    }
    await writeLease({ deviceId: st.deviceId, until: now, lastRun: now });
    st.lastHousekeeping = now;
    await log('info', `Housekeeping: removed ${deleted} file(s), ${revs} old revision(s)`);
  }

  private async lastSnapshotHash(): Promise<string> {
    return ((await chrome.storage.local.get('lastSnapshotHash')).lastSnapshotHash as string) ?? '';
  }

  // ------------------------------------------------------------------ devices / storage
  async devices() {
    const st = await loadState();
    const files = newestByName(await this.backend.list());
    const out = [];
    for (const f of files.values()) {
      if (!FILES.isDevice(f.name)) continue;
      const id = FILES.deviceIdOf(f.name);
      const c = st.peerCache[id];
      out.push({
        id,
        self: id === st.deviceId,
        name: id === st.deviceId ? (await loadSettings()).deviceName || 'This browser' : (c?.deviceName ?? 'Unknown'),
        browser: c?.browser ?? '',
        lastSync: id === st.deviceId ? st.lastSync : (c?.lastSync ?? f.modified),
        size: f.size,
      });
    }
    return out;
  }

  async forgetDevice(id: string): Promise<void> {
    const st = await loadState();
    if (id === st.deviceId) throw new Error('Cannot forget this device');
    for (const f of await this.backend.list()) if (f.name === FILES.device(id)) await this.backend.remove(f.id);
    delete st.peerCache[id];
    await saveState(st);
    await log('info', `Forgot device ${id}`);
  }

  async storageUsage() {
    const files = await this.backend.list();
    const sum = (p: (f: RemoteFile) => boolean) => files.filter(p).reduce((s, f) => s + f.size, 0);
    return {
      devices: sum((f) => FILES.isDevice(f.name)),
      snapshots: sum((f) => FILES.isSnapshot(f.name)),
      other: sum((f) => !FILES.isDevice(f.name) && !FILES.isSnapshot(f.name)),
      fileCount: files.length,
      snapshotCount: files.filter((f) => FILES.isSnapshot(f.name)).length,
      budget: (await loadSettings()).budgetMB * 1024 * 1024,
    };
  }

  // ------------------------------------------------------------------ export / snapshots / restore
  async listSnapshots(): Promise<string[]> {
    return [...newestByName(await this.backend.list()).values()]
      .filter((f) => FILES.isSnapshot(f.name))
      .map((f) => FILES.snapshotDateOf(f.name))
      .sort()
      .reverse();
  }

  private async requireKey(): Promise<CryptoKey> {
    const k = await this.deps.keyStore.load();
    if (!k) throw new Error('Sync is not unlocked on this device');
    return k.key;
  }

  async snapshotTree(date: string): Promise<Tree> {
    const key = await this.requireKey();
    const f = newestByName(await this.backend.list()).get(FILES.snapshot(date));
    if (!f) throw new Error('Snapshot not found');
    const s = (await openJson(key, await this.backend.read(f.id), `snapshot:${date}`)) as SnapshotFile;
    if (s.schema !== 1 || !Array.isArray(s.nodes)) throw new Error('Snapshot is invalid');
    return treeFromList(s.nodes);
  }

  async currentTree(): Promise<Tree> {
    const st = await loadState();
    const merged = mergeStates(nodesToState(st.known), ...Object.values(st.peerCache).map((p) => nodesToState(p.nodes)));
    if (Object.keys(merged).length) return materialize(merged);
    const raw = await readRawTree((await loadSettings()).treePref);
    return raw.tree;
  }

  async exportBookmarks(source: 'current' | string, format: 'html' | 'json', opts: ExportOptions): Promise<string> {
    const tree = source === 'current' ? await this.currentTree() : await this.snapshotTree(source);
    return format === 'html' ? toNetscapeHtml(tree, opts) : JSON.stringify(toJsonExport(tree, opts), null, 2);
  }

  /** Folder list for the export picker. */
  async folders(): Promise<{ id: string; path: string }[]> {
    const t = await this.currentTree();
    const out: { id: string; path: string }[] = [];
    const names: Record<string, string> = { 'root:bar': 'Bookmarks bar', 'root:other': 'Other bookmarks', 'root:mobile': 'Mobile bookmarks' };
    for (const n of treeToList(t)) {
      if (n.kind !== 'folder') continue;
      const parentPath = names[n.parent] ?? out.find((o) => o.id === n.parent)?.path ?? '';
      out.push({ id: n.id, path: `${parentPath} / ${n.title}` });
    }
    return out;
  }

  /** Make this browser look like the snapshot; the next sync shares that with every device. */
  async restoreSnapshot(date: string): Promise<SyncOutcome> {
    const target = await this.snapshotTree(date);
    const st = await loadState();
    const settings = await loadSettings();
    if (!st.base) throw new Error('Finish setting up sync before restoring');
    const ids = new IdMap(st.ids);
    const raw = await readRawTree(settings.treePref);
    const local = ids.mapTree(raw.tree, newSyncId);
    const p = makePlan(local, target);
    this.ev.beginApply();
    try {
      await applyOps(p.ops, ids, raw.rootMap);
    } finally {
      this.ev.endApply();
    }
    st.ids = ids.entries();
    await saveState(st);
    await log('info', `Restored snapshot ${date} (${p.ops.length} change(s))`);
    return this.sync({ reason: 'restore' });
  }

  // ------------------------------------------------------------------ resets
  /** Delete everything in the app folder. Bookmarks in browsers are untouched. */
  async wipeRemote(): Promise<void> {
    for (const f of await this.backend.list()) await this.backend.remove(f.id);
    await this.deps.keyStore.clear();
    const st = await loadState();
    Object.assign(st, { everPushed: false, lastPushedHash: '', lastPushedVersion: '', peerCache: {}, writeSeq: 0 });
    await saveState(st);
    await this.setStatus({ phase: 'not-configured', message: 'Synced data removed. Bookmarks in your browsers are unchanged.' });
    await log('warn', 'Removed all synced data from Google Drive');
  }

  /**
   * New passphrase. Snapshots readable with the current key are re-encrypted; other devices'
   * files are removed — each device asks for the new passphrase and rejoins by merging, so no
   * bookmark is lost. Also the recovery path for a forgotten passphrase (then snapshots are lost).
   */
  async changePassphrase(passphrase: string): Promise<void> {
    const files = await this.backend.list();
    const m = await this.readMeta(files);
    const oldKey = (await this.deps.keyStore.load())?.key;
    const kdf = newKdfParams(this.deps.kdfIterations);
    const key = await deriveKey(passphrase, kdf);
    const epoch = (m?.meta.keyEpoch ?? 0) + 1;
    const newest = newestByName(files);
    for (const f of files) {
      if (f.name === FILES.meta) continue;
      if (FILES.isSnapshot(f.name) && oldKey && newest.get(f.name)?.id === f.id) {
        const date = FILES.snapshotDateOf(f.name);
        try {
          const s = await openJson(oldKey, await this.backend.read(f.id), `snapshot:${date}`);
          await this.backend.write(f.name, await sealJson(key, s, `snapshot:${date}`), f.id);
          continue;
        } catch {
          /* unreadable → removed below */
        }
      }
      await this.backend.remove(f.id);
    }
    await this.writeMeta({ schema: 1, kdf, keyEpoch: epoch, check: await makeKeyCheck(key), createdAt: m?.meta.createdAt ?? this.now() }, m?.file);
    await this.deps.keyStore.save(key, epoch);
    const st = await loadState();
    Object.assign(st, { everPushed: false, lastPushedHash: '', lastPushedVersion: '', peerCache: {} });
    await saveState(st);
    await log('warn', `Passphrase changed (key epoch ${epoch})`);
  }

  /** Forget everything sync-related on this device (bookmarks stay). */
  async resetLocal(): Promise<void> {
    await this.deps.keyStore.clear();
    await saveState(freshLocalState());
    await saveStatus({ ...(await loadStatus()), phase: 'not-configured', message: 'Set up sync in Options', pendingDeletes: null, pendingRisky: [], join: null });
    await log('warn', 'Local sync state reset');
  }
}
