import { DriveBackend } from '../adapters/storage/gdrive';
import { GoogleAuth } from '../adapters/storage/googleAuth';
import { generatePassphrase } from '../adapters/storage/crypto';
import { idbKeyStore } from '../adapters/storage/keystore';
import type { JoinMode } from '../core/initialJoin';
import type { ExportOptions } from '../core/export';
import { installBookmarkListeners } from './events';
import { SyncService } from './service';
import { loadLogs, loadSettings, loadStatus, saveSettings, saveStatus, type Settings } from './state';

declare const __GOOGLE_CLIENT_ID__: string;
declare const __VERSION__: string;
declare const __BUILD_ID__: string;

const auth = new GoogleAuth(__GOOGLE_CLIENT_ID__);
const drive = new DriveBackend(auth);

async function browserName(): Promise<string> {
  const nav = navigator as Navigator & { userAgentData?: { brands: { brand: string }[] }; brave?: { isBrave(): Promise<boolean> } };
  let b = 'Chromium';
  const brands = nav.userAgentData?.brands.map((x) => x.brand) ?? [];
  if (nav.brave && (await nav.brave.isBrave().catch(() => false))) b = 'Brave';
  else if (brands.includes('Microsoft Edge')) b = 'Edge';
  else if (brands.includes('Opera')) b = 'Opera';
  else if (/Vivaldi/.test(navigator.userAgent)) b = 'Vivaldi';
  else if (brands.includes('Google Chrome')) b = 'Chrome';
  const os = (await chrome.runtime.getPlatformInfo()).os;
  const osName: Record<string, string> = { win: 'Windows', mac: 'macOS', linux: 'Linux', cros: 'ChromeOS', android: 'Android' };
  return `${b} on ${osName[os] ?? os}`;
}

let timer: ReturnType<typeof setTimeout> | undefined;
function schedule(ms: number, reason: string) {
  clearTimeout(timer);
  timer = setTimeout(() => void run(reason), ms);
  // A worker may be shut down before a long timer fires; an alarm is the durable fallback.
  if (ms >= 25_000) void chrome.alarms.create('retry', { when: Date.now() + ms });
}

const svc = new SyncService({
  backend: () => drive,
  keyStore: idbKeyStore,
  version: __VERSION__,
  browserName,
  scheduleResync: (ms) => schedule(ms, 'resync'),
});

async function run(reason: string) {
  await svc.sync({ reason });
}

async function ensureAlarm() {
  const s = await loadSettings();
  await chrome.alarms.create('periodic', { periodInMinutes: Math.max(1, s.intervalMin) });
}

// ---- triggers (registered synchronously at top level so they wake the worker) ----
installBookmarkListeners(() => schedule(5000, 'bookmark change'));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'periodic' || a.name === 'retry') void run(a.name);
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  schedule(3000, 'startup');
});
chrome.runtime.onInstalled.addListener((d) => {
  void ensureAlarm();
  if (d.reason === 'install') void chrome.runtime.openOptionsPage();
});
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'active') schedule(2000, 'active');
});

// ---- badge mirrors status ----
const BADGE: Record<string, [string, string]> = {
  'needs-approval': ['!', '#d97706'],
  'needs-join': ['!', '#d97706'],
  locked: ['🔒', '#d97706'],
  'signin-required': ['!', '#d97706'],
  'not-configured': ['?', '#6b7280'],
  error: ['×', '#dc2626'],
  offline: ['…', '#6b7280'],
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.status) {
    const phase = (changes.status.newValue as { phase?: string } | undefined)?.phase ?? '';
    const [text, color] = BADGE[phase] ?? ['', '#2563eb'];
    void chrome.action.setBadgeText({ text });
    void chrome.action.setBadgeBackgroundColor({ color });
  }
  if (changes.settings) void ensureAlarm();
});

// ---- messages from our own popup/options pages only ----
type Msg =
  | { type: 'status' }
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'remoteExists' }
  | { type: 'createRemote'; passphrase: string }
  | { type: 'unlock'; passphrase: string }
  | { type: 'generatePassphrase' }
  | { type: 'syncNow' }
  | { type: 'join'; mode: JoinMode }
  | { type: 'approveDeletes' }
  | { type: 'keepMine' }
  | { type: 'approveRisky'; id: string; url: string }
  | { type: 'rejectRisky'; id: string }
  | { type: 'devices' }
  | { type: 'forgetDevice'; id: string }
  | { type: 'storageUsage' }
  | { type: 'snapshots' }
  | { type: 'folders' }
  | { type: 'export'; source: string; format: 'html' | 'json'; opts: ExportOptions }
  | { type: 'restore'; date: string }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; settings: Partial<Settings> }
  | { type: 'logs' }
  | { type: 'changePassphrase'; passphrase: string }
  | { type: 'wipeRemote' }
  | { type: 'resetLocal' };

async function handle(m: Msg): Promise<unknown> {
  switch (m.type) {
    case 'status':
      return {
        status: await loadStatus(),
        email: (await auth.email()) ?? '',
        clientConfigured: auth.configured,
        version: __VERSION__,
        build: __BUILD_ID__,
        extensionId: chrome.runtime.id,
        redirectUri: chrome.identity.getRedirectURL(),
        unlocked: !!(await idbKeyStore.load()),
      };
    case 'signIn': {
      await auth.getToken(true);
      const me = await drive.about();
      await auth.setEmail(me.email);
      await saveStatus({ ...(await loadStatus()), email: me.email });
      return me;
    }
    case 'signOut':
      await auth.signOut();
      return null;
    case 'remoteExists':
      return svc.remoteExists();
    case 'createRemote':
      await svc.createRemote(m.passphrase);
      return svc.sync({ reason: 'setup' });
    case 'unlock':
      await svc.unlock(m.passphrase);
      return svc.sync({ reason: 'unlock' });
    case 'generatePassphrase':
      return generatePassphrase();
    case 'syncNow':
      return svc.sync({ reason: 'manual' });
    case 'join':
      return svc.sync({ joinMode: m.mode, reason: 'join' });
    case 'approveDeletes':
      return svc.approveDeletes();
    case 'keepMine':
      return svc.keepMine();
    case 'approveRisky':
      return svc.approveRisky(m.id, m.url);
    case 'rejectRisky':
      return svc.rejectRisky(m.id);
    case 'devices':
      return svc.devices();
    case 'forgetDevice':
      return svc.forgetDevice(m.id);
    case 'storageUsage':
      return svc.storageUsage();
    case 'snapshots':
      return svc.listSnapshots();
    case 'folders':
      return svc.folders();
    case 'export':
      return svc.exportBookmarks(m.source, m.format, m.opts);
    case 'restore':
      return svc.restoreSnapshot(m.date);
    case 'getSettings':
      return loadSettings();
    case 'saveSettings': {
      const s = { ...(await loadSettings()), ...m.settings };
      s.intervalMin = Math.min(120, Math.max(1, Math.round(s.intervalMin)));
      s.maxDeletes = Math.max(1, Math.round(s.maxDeletes));
      s.maxDeleteFraction = Math.min(1, Math.max(0.01, s.maxDeleteFraction));
      s.budgetMB = Math.min(1000, Math.max(5, Math.round(s.budgetMB)));
      s.deviceName = s.deviceName.slice(0, 60);
      await saveSettings(s);
      return s;
    }
    case 'logs':
      return loadLogs();
    case 'changePassphrase':
      await svc.changePassphrase(m.passphrase);
      return svc.sync({ reason: 'passphrase changed' });
    case 'wipeRemote':
      return svc.wipeRemote();
    case 'resetLocal':
      return svc.resetLocal();
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  // Only our own extension pages may drive the service.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  handle(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
