# Bookmark Sync (private)

A Chromium extension (Chrome, Edge, Brave, Vivaldi) that keeps bookmarks in sync across your
desktop browsers. Everything is **end-to-end encrypted** and stored in a hidden app folder in
your own Google Drive. It's meant for you and your family; it isn't published to any store.

* Each browser writes only its own file, and every browser merges all the files in the same
  deterministic way. Two PCs syncing at the same moment can't overwrite each other.
* First-time setup on a browser that already has bookmarks: you choose to **merge** (the default,
  nothing is deleted), use the synced copy, or use this browser's bookmarks.
* Same URL in the same folder → deduplicated. Edits to different fields on two PCs (rename on one,
  move on another) are both kept. When both PCs edit the same field, the edit made later wins,
  going by when it was actually made.
* Large deletions coming from another device pause sync until you approve them.
  `javascript:`/`data:` bookmarks coming from another device wait for your approval.
* Daily encrypted snapshots: 14 daily, 8 weekly, 12 monthly. You can restore one, or export the
  current bookmarks or any snapshot as a standard `bookmarks.html` file that any browser can import.

Design details: [PLAN.md](PLAN.md).

---

## 1. Owner setup (once)

You need Node.js 20+ (Windows, macOS or Linux) and a Google account that owns the Google Cloud
project. Do the owner setup on **one** machine only, and build there. Every other PC, on any OS,
just receives a copy of the built `dist/` folder.

```bash
npm install
npm run keygen      # creates extension-key.pem + config.local.json, prints the extension ID
```

`keygen` pins the extension ID so it is **the same on every PC**. Google sign-in depends on this.
It runs entirely on your machine; nothing is downloaded. It creates two files next to
`package.json`, both git-ignored:

| File | What it is | Needed for building? |
|---|---|---|
| `config.local.json` | The **public** half of the key (`manifestKey`), the extension ID it produces, and your Google client ID (added later). The build copies `manifestKey` into `dist/manifest.json`, which fixes the ID. | **Yes.** It's the only file the build reads. |
| `extension-key.pem` | The matching **private** RSA key (`-----BEGIN PRIVATE KEY-----`). It's only used to sign a packed `.crx` file, which this project doesn't do because it's loaded unpacked. | No. Keep it as a backup. |

Back up both, e.g. in your password manager. If you lose `config.local.json` but still have
`extension-key.pem`, this prints the `manifestKey` value to put back into a new
`config.local.json` (same ID as before):

```bash
node -e "console.log(require('crypto').createPublicKey(require('fs').readFileSync('extension-key.pem')).export({type:'spki',format:'der'}).toString('base64'))"
```

If you lose
both, run `npm run keygen -- --force` to get a **new** ID. You'd then need to update the redirect
URI in Google Cloud and reinstall the extension on every PC. Nothing in the files is a password,
but keep `extension-key.pem` private anyway: it proves which extension is "yours".

### Google Cloud project

1. Go to <https://console.cloud.google.com/> → create a project (e.g. "Bookmark Sync").
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding/Audience):
   * User type **External**, app name "Bookmark Sync", your email as support/developer contact.
   * **Data access / Scopes:** add `https://www.googleapis.com/auth/drive.appdata` only.
   * **Audience / Publishing status:** click **Publish app** ("In production").
     *Leave it in "Testing" and every sign-in expires after 7 days.* `drive.appdata` is
     intended to be a non-sensitive scope, which shouldn't require Google verification. Family
     members may still see an "unverified app" notice, which they can accept via *Advanced → Go to
     Bookmark Sync*.
4. **Credentials → Create credentials → OAuth client ID**:
   * Application type **Web application**.
   * **Authorized redirect URIs:** `https://<extension-id>.chromiumapp.org/` (printed by
     `npm run keygen`, and also shown in the extension's Setup page).
5. Copy the **Client ID** into `config.local.json`:

   ```json
   { "manifestKey": "…", "extensionId": "…", "googleClientId": "1234-abc.apps.googleusercontent.com" }
   ```

6. Build:

   ```bash
   npm run build      # → dist/
   ```

## 2. Install on each PC (you and family)

1. Copy the `dist/` folder to the PC, e.g. `C:\Apps\bookmark-sync`.
   Keep it there: the browser loads the extension from that folder.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** → **Load unpacked** → select the folder.
4. Check that the ID shown matches the one from `npm run keygen`.
5. The Options page opens:
   1. **Sign in with Google.** Each person uses their **own** Google account.
   2. **First browser of that person:** choose a passphrase (a generated one is suggested), save
      the recovery kit in a password manager, then create the sync.
      **Every other browser of theirs:** enter the same passphrase.
   3. If the browser already has bookmarks, choose **Merge both**.
6. Turn off the browser's own bookmark sync (Chrome Sync / Edge Sync → Bookmarks) on that profile.
   Otherwise the two systems fight over the same bookmarks.

Each family member gets their own private, separately encrypted bookmark set. Nobody can see
anyone else's.

### Linux PCs

The extension itself is identical on Linux: same `dist/` folder, same extension ID, same Google
client. Only where you put the folder and how the browser was installed differ.

1. **Copy the built `dist/` folder** into your home directory, in a *non-hidden* folder.
   From the Windows build machine, for example:

   ```bash
   scp -r dist/ you@linux-pc:~/Apps/bookmark-sync
   ```

   Or use a USB stick, or build on Linux (see *Building on Linux* below). Avoid `/tmp` (cleared
   on reboot) and hidden folders like `~/.local/...` (sandboxed browsers can't read them).
   The folder only needs to be readable by your user: `chmod -R u+rX ~/Apps/bookmark-sync`.

2. **Find out how the browser was installed.** This decides whether it can read that folder:

   | Install type | How to tell | What to do |
   |---|---|---|
   | Distro package / vendor `.deb` / `.rpm` (e.g. `google-chrome-stable`, `brave-browser`, `microsoft-edge-stable`, `vivaldi-stable`) | `which google-chrome` points to `/usr/bin` or `/opt` | Nothing; any folder you own works. |
   | **Snap** (Ubuntu's default `chromium`, also `brave`) | `snap list` shows it | Works only from a non-hidden folder in your home directory, e.g. `~/Apps/bookmark-sync`. |
   | **Flatpak** (Flathub: `com.google.Chrome`, `org.chromium.Chromium`, `com.brave.Browser`, `com.microsoft.Edge`, `com.vivaldi.Vivaldi`) | `flatpak list --app` shows it | Give it read access to the folder once (replace the app ID), then restart the browser: `flatpak override --user --filesystem=~/Apps/bookmark-sync:ro com.google.Chrome` |

3. **Load it**, as on Windows: open `chrome://extensions` (or `chromium://extensions`,
   `brave://extensions`, `edge://extensions`, `vivaldi://extensions`) → **Developer mode** →
   **Load unpacked** → `~/Apps/bookmark-sync`.
   Check that the ID is the same as on your other PCs. Then continue with step 5 above (sign in,
   passphrase, merge).

4. **Turn off the browser's own bookmark sync**, as on Windows. Chromium from a distro has no
   Google sync by default, so there is nothing to turn off there.

Notes:
- Google sign-in opens in a browser popup, exactly as on Windows. Nothing extra to install.
- The device appears as e.g. "Chrome on Linux" in the Devices list. Rename it in Settings if you
  have several Linux PCs.
- The extension's encryption key lives in the browser profile (`~/.config/google-chrome/`,
  `~/snap/chromium/…`, or `~/.var/app/<app-id>/…` for Flatpak). Like on Windows, anyone who can
  read your home directory can use it, so use a login password and preferably disk encryption
  (LUKS, usually offered by the installer).

### Building on Linux (optional)

You only need this if you want to build on Linux instead of copying `dist/` from your Windows
machine.

```bash
# Node 20+ — e.g. via your distro, NodeSource, or nvm:
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22

git clone <your private repo> bookmark-sync && cd bookmark-sync
npm install
```

**Do not run `npm run keygen` again.** That creates a *new* extension ID, which breaks Google
sign-in and makes the build a different extension from the one on your other PCs. Copy
`config.local.json` from the original machine instead (it's the only file the build needs;
`extension-key.pem` can stay where it is):

```bash
scp you@windows-pc:path/to/bookmark-sync/config.local.json .
npm run build      # → dist/, then load it as above
```

## 3. Updating

```bash
git pull           # or copy the new source
npm install
npm run build
```

Copy the new `dist/` over the old folder on each PC, then click **Reload** on the extension card.
On Linux, from the build machine:

```bash
rsync -a --delete dist/ you@linux-pc:~/Apps/bookmark-sync/
```

Keep the folder path the same; a Flatpak override only covers that path.
The Overview tab shows the version and build ID, so you can confirm every PC runs the same build.

## 4. Everyday use

* Sync runs a few seconds after you change a bookmark, every 5 minutes, on browser start, and
  when you come back to the PC. The toolbar badge shows `!` when something needs you.
* **Export & restore:** download `bookmarks.html` (everything, or one folder) to share with
  someone. The recipient imports it via their browser's *Import bookmarks → HTML file*. You can
  also restore any daily snapshot.
* **Devices:** see every synced browser; forget PCs you no longer use.
* **Lost passphrase:** Security & data → change passphrase on any unlocked PC (or on a PC after
  *Reset this browser*). Bookmarks in your browsers are kept, and the other browsers ask for the
  new passphrase and merge back in.
* **Remove everything from Drive:** Security & data → *Remove all synced data*, or
  Google Drive → Settings → Manage apps → Bookmark Sync → Delete hidden app data.

## 5. Security model

| Threat | Protection |
|---|---|
| Someone reads your Drive / Google account | AES-256-GCM, with the key derived from the passphrase (PBKDF2-SHA256, 600k rounds). Drive only stores ciphertext. |
| Files swapped or tampered with in Drive | Each file is authenticated and bound to its name via GCM associated data. Decrypted files are also schema-validated. Replaying an old file is harmless because merging is monotonic. |
| Extension sees more than it needs | `drive.appdata` scope only, meaning just its own hidden folder. No content scripts, no `tabs`, no `<all_urls>`. Hosts: `www.googleapis.com`, `oauth2.googleapis.com`. |
| Token theft | Implicit-flow token kept in `chrome.storage.session` (memory only). The token's audience is checked against this client ID. No client secret exists. |
| Key theft from disk | The derived key is stored as a non-extractable `CryptoKey` in IndexedDB. The passphrase is never stored. |
| Malicious bookmarklet injected via sync | `javascript:`/`data:`/`vbscript:` URLs from other devices need explicit approval. |
| Mass deletion (mistake or attack) | Sync pauses if it would delete more than 20 bookmarks, or more than 10% of a tree of 50 or more. You can keep them (restores them on every device) or approve. |
| Supply chain | No runtime dependencies (only browser built-ins). Build-time dev dependencies are pinned in `package-lock.json`. Strict extension CSP. |
| Logs leak browsing | Logs hold counts and IDs only, never URLs or titles. |

## 6. Storage use in Drive

| Item | Policy |
|---|---|
| Device files | One per browser (about 300 KB gzipped per 5k bookmarks). Uploaded only when content changes, plus at most one heartbeat a day. Old revisions are deleted daily. |
| Snapshots | 14 daily, 8 weekly, 12 monthly (at most 34). Skipped when nothing changed. |
| Deleted-item markers | Cleaned up 90 days after every device has seen them. |
| Inactive devices | Flagged at 60 days and removed at 180 days. If that PC comes back, it rejoins by merging. |
| Budget | 50 MB by default (configurable). The oldest snapshots are trimmed first, and at least 7 are kept. |

## 7. Development

```bash
npm test           # unit + property + multi-device simulator + service tests
npm run typecheck
npm run build
npm run preview    # UI preview with a mocked background at http://localhost:5178/
                   #   ?state=approval | join | new
```

Layout:

```
src/core/                 pure sync engine (no chrome.*): HLC, CRDT merge, diff, planner,
                          initial join, dedupe, export, retention — see PLAN.md
src/adapters/browser/     chrome.bookmarks read/apply
src/adapters/storage/     crypto, codec, Google Drive backend, OAuth, key store
src/background/           service worker, SyncService orchestrator, state, events
src/ui/                   popup + options pages
test/                     vitest suites; test/util.ts has the multi-device simulator
```

## 8. Things to check by hand (can't be automated here)

These need a real Google project and real browsers:

- [ ] Sign-in works in Chrome **and** Edge/Brave with the same build. The extension ID is identical everywhere.
- [ ] After about 2 hours, sync still works without a sign-in prompt (silent token refresh).
- [ ] With the consent screen "In production", sign-in still works after 8+ days.
- [ ] On a Chrome profile that shows separate account and local bookmarks, the Overview warning
      names the set being synced.
- [ ] Edge: "Favorites bar" and "Other favorites" map correctly. Bookmarks land in the right roots.
- [ ] Linux: the extension loads and signs in from a Snap or Flatpak browser, if you use one.
      Bookmarks from Windows and Linux PCs merge into one set.
