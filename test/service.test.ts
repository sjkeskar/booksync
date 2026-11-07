import { beforeEach, describe, expect, it } from 'vitest';
import { FILES, MemoryBackend } from '../src/adapters/storage/backend';
import { MemoryKeyStore } from '../src/adapters/storage/keystore';
import { SyncService, type EventSource } from '../src/background/service';
import { loadState, loadStatus } from '../src/background/state';
import { DAY } from '../src/core/retention';
import { installFakeChrome } from './fakeChrome';

class Ev implements EventSource {
  times: Record<string, number> = {};
  async takeEventTimes() {
    return { ...this.times };
  }
  async clearEventTimes() {
    this.times = {};
  }
  beginApply() {}
  endApply() {
    return new Set<string>();
  }
  isImporting() {
    return false;
  }
}

let now = Date.UTC(2026, 10, 1);
const backend = new MemoryBackend();

class Device {
  chrome = installFakeChrome();
  keys = new MemoryKeyStore();
  svc = new SyncService({ backend: () => backend, keyStore: this.keys, now: () => now, events: new Ev(), version: 't', browserName: async () => this.name, kdfIterations: 100_000 });
  constructor(readonly name: string) {}
  use() {
    (globalThis as unknown as { chrome: unknown }).chrome = this.chrome;
    return this;
  }
  async run<T>(fn: (s: SyncService) => Promise<T>): Promise<T> {
    this.use();
    return fn(this.svc);
  }
  async add(parentId: string, title: string, url?: string) {
    this.use();
    return chrome.bookmarks.create({ parentId, title, ...(url ? { url } : {}) });
  }
  titles(parentId = '1') {
    return (this.chrome.bookmarks.byId.get(parentId)!.children ?? []).map((n) => n.title);
  }
  count() {
    let n = 0;
    for (const x of this.chrome.bookmarks.byId.values()) if (x.url) n++;
    return n;
  }
}

beforeEach(() => {
  backend.files.clear();
  backend.now = () => now;
});

async function twoDevices() {
  const a = new Device('PC-A');
  await a.add('1', 'GitHub', 'https://github.com');
  await a.run((s) => s.createRemote('family passphrase'));
  expect(await a.run((s) => s.sync())).toBe('ok');
  const b = new Device('PC-B');
  await b.run((s) => s.unlock('family passphrase'));
  expect(await b.run((s) => s.sync())).toBe('ok');
  return { a, b };
}

describe('SyncService end to end', () => {
  it('first device creates the store; files are encrypted', async () => {
    const a = new Device('PC-A');
    await a.add('1', 'Secret bank', 'https://secret-bank.example');
    await a.run((s) => s.createRemote('pw one two'));
    expect(await a.run((s) => s.sync())).toBe('ok');
    const names = [...backend.files.values()].map((f) => f.meta.name).sort();
    expect(names.some((n) => FILES.isDevice(n))).toBe(true);
    expect(names.some((n) => FILES.isSnapshot(n))).toBe(true);
    for (const f of backend.files.values()) {
      const text = new TextDecoder('latin1').decode(f.data);
      expect(text).not.toContain('secret-bank');
      expect(text).not.toContain('Secret bank');
    }
  });

  it('wrong passphrase is rejected; a browser with its own bookmarks must choose how to join', async () => {
    const a = new Device('PC-A');
    await a.add('1', 'A1', 'https://a1.com');
    await a.add('1', 'Shared', 'https://shared.com');
    await a.run((s) => s.createRemote('right'));
    await a.run((s) => s.sync());

    const b = new Device('PC-B');
    await b.add('1', 'Shared', 'https://shared.com/');
    await b.add('2', 'B only', 'https://b.com');
    await expect(b.run((s) => s.unlock('wrong'))).rejects.toThrow(/Wrong passphrase/);
    await b.run((s) => s.unlock('right'));
    expect(await b.run((s) => s.sync())).toBe('needs-join');
    expect((await b.run(() => loadStatus())).join).toEqual({ localCount: 2, remoteCount: 2 });
    expect(b.count()).toBe(2); // nothing touched yet
    expect(await b.run((s) => s.sync({ joinMode: 'merge' }))).toBe('ok');
    expect(await a.run((s) => s.sync())).toBe('ok');
    expect(a.titles('1')).toEqual(['A1', 'Shared']);
    expect(a.titles('2')).toEqual(['B only']);
    expect(b.titles('1')).toEqual(['A1', 'Shared']);
  });

  it('two PCs adding at the same time both keep both', async () => {
    const { a, b } = await twoDevices();
    await a.add('1', 'from A', 'https://a.com');
    await b.add('1', 'from B', 'https://b.com');
    await a.run((s) => s.sync());
    await b.run((s) => s.sync());
    await a.run((s) => s.sync());
    expect([...a.titles()].sort()).toEqual(['GitHub', 'from A', 'from B']);
    expect(a.titles()).toEqual(b.titles());
  });

  it('mass deletion pauses; "keep mine" restores everywhere', async () => {
    const { a, b } = await twoDevices();
    for (let i = 0; i < 30; i++) await a.add('2', `bm${i}`, `https://e.com/${i}`);
    await a.run((s) => s.sync());
    await b.run((s) => s.sync());
    expect(b.count()).toBe(31);
    // A deletes everything in Other bookmarks
    a.use();
    for (const n of [...a.chrome.bookmarks.byId.get('2')!.children!]) await chrome.bookmarks.remove(n.id);
    await a.run((s) => s.sync());
    expect(await b.run((s) => s.sync())).toBe('needs-approval');
    expect((await b.run(() => loadStatus())).pendingDeletes).toEqual({ count: 30, total: 31 });
    expect(b.count()).toBe(31);
    expect(await b.run((s) => s.keepMine())).toBe('ok');
    expect(await a.run((s) => s.sync())).toBe('ok');
    expect(a.count()).toBe(31);
  });

  it('approving the deletion applies it', async () => {
    const { a, b } = await twoDevices();
    for (let i = 0; i < 30; i++) await a.add('2', `bm${i}`, `https://e.com/${i}`);
    await a.run((s) => s.sync());
    await b.run((s) => s.sync());
    a.use();
    for (const n of [...a.chrome.bookmarks.byId.get('2')!.children!]) await chrome.bookmarks.remove(n.id);
    await a.run((s) => s.sync());
    expect(await b.run((s) => s.sync())).toBe('needs-approval');
    expect(await b.run((s) => s.approveDeletes())).toBe('ok');
    expect(b.count()).toBe(1);
  });

  it('script bookmarks from another PC wait for approval', async () => {
    const { a, b } = await twoDevices();
    await a.add('1', 'Bookmarklet', 'javascript:alert(1)');
    await a.run((s) => s.sync());
    await b.run((s) => s.sync());
    const st = await b.run(() => loadStatus());
    expect(st.pendingRisky).toHaveLength(1);
    expect(b.titles()).toEqual(['GitHub']);
    await b.run((s) => s.approveRisky(st.pendingRisky[0]!.id, st.pendingRisky[0]!.url));
    expect(b.titles()).toEqual(['GitHub', 'Bookmarklet']);
  });

  it('cloned profile (same device id on two PCs) is detected and re-identified', async () => {
    const { a } = await twoDevices();
    const c = new Device('PC-C (clone of A)');
    c.chrome.storage.local.data = structuredClone(a.chrome.storage.local.data);
    c.keys.v = a.keys.v;
    await c.add('1', 'GitHub', 'https://github.com');
    await a.add('1', 'A again', 'https://again.com');
    await a.run((s) => s.sync());
    const idBefore = (await c.run(() => loadState())).deviceId;
    expect(await c.run((s) => s.sync())).toBe('ok');
    const idAfter = (await c.run(() => loadState())).deviceId;
    expect(idAfter).not.toBe(idBefore);
    expect(await a.run((s) => s.sync())).toBe('ok');
    expect(await c.run((s) => s.sync())).toBe('ok');
    expect(c.titles()).toEqual(a.titles());
  });

  it('evicted device (file removed) rejoins without duplicates', async () => {
    const { a, b } = await twoDevices();
    const bId = (await b.run(() => loadState())).deviceId;
    for (const [id, f] of backend.files) if (f.meta.name === FILES.device(bId)) backend.files.delete(id);
    await b.add('1', 'while away', 'https://away.com');
    expect(await b.run((s) => s.sync())).toBe('ok');
    await a.run((s) => s.sync());
    expect(a.titles()).toEqual(['GitHub', 'while away']);
    expect(b.titles()).toEqual(['GitHub', 'while away']);
  });

  it('passphrase change: other PC is locked until it enters the new one, then rejoins losslessly', async () => {
    const { a, b } = await twoDevices();
    await b.add('1', 'B unsynced', 'https://b.com');
    await a.run((s) => s.changePassphrase('new secret'));
    expect(await a.run((s) => s.sync())).toBe('ok');
    expect(await b.run((s) => s.sync())).toBe('locked');
    await expect(b.run((s) => s.unlock('family passphrase'))).rejects.toThrow(/Wrong/);
    await b.run((s) => s.unlock('new secret'));
    expect(await b.run((s) => s.sync())).toBe('ok');
    await a.run((s) => s.sync());
    expect(a.titles()).toEqual(['GitHub', 'B unsynced']);
    expect(b.titles()).toEqual(['GitHub', 'B unsynced']);
  });

  it('housekeeping: drops old revisions, keeps GFS snapshots, removes devices gone 180 days', async () => {
    const { a, b } = await twoDevices();
    for (let d = 0; d < 60; d++) {
      now += DAY;
      await a.add('1', `day${d}`, `https://d.com/${d}`);
      await a.run((s) => s.sync());
    }
    const snaps = [...backend.files.values()].filter((f) => FILES.isSnapshot(f.meta.name));
    expect(snaps.length).toBeLessThanOrEqual(14 + 8 + 12);
    expect(snaps.length).toBeGreaterThan(14);
    const own = [...backend.files.values()].find((f) => f.meta.name === FILES.device((a.chrome.storage.local.data.syncState as { deviceId: string }).deviceId))!;
    expect(own.revs.length).toBeLessThanOrEqual(2);
    // Revision cleanup bumps the file version; must not be mistaken for a cloned profile.
    const logs = (a.chrome.storage.local.data.logs as { msg: string }[]).map((l) => l.msg).join(' | ');
    expect(logs).not.toContain('Another installation');
    // B never syncs again
    now += 200 * DAY;
    await a.run((s) => s.sync());
    const bId = (await b.run(() => loadState())).deviceId;
    expect([...backend.files.values()].some((f) => f.meta.name === FILES.device(bId))).toBe(false);
    expect((await a.run((s) => s.devices())).length).toBe(1);
  });

  it('housekeeping removes duplicate files left by racing devices', async () => {
    const { a } = await twoDevices();
    const snap = [...backend.files.values()].find((f) => FILES.isSnapshot(f.meta.name))!;
    // another device raced and wrote the same snapshot name
    await backend.write(snap.meta.name, snap.data);
    expect([...backend.files.values()].filter((f) => f.meta.name === snap.meta.name)).toHaveLength(2);
    now += DAY;
    await a.run((s) => s.sync());
    const names = [...backend.files.values()].map((f) => f.meta.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exports current bookmarks and snapshots as importable HTML', async () => {
    const { a } = await twoDevices();
    const f = await a.add('2', 'Recipes');
    await a.add(f.id, 'Soup', 'https://soup.com');
    await a.run((s) => s.sync());
    const html = await a.run((s) => s.exportBookmarks('current', 'html', {}));
    expect(html).toContain('<DT><A HREF="https://soup.com"');
    expect(html).toContain('<H3 ADD_DATE');
    const folders = await a.run((s) => s.folders());
    const recipes = folders.find((x) => x.path.endsWith('Recipes'))!;
    const sub = await a.run((s) => s.exportBookmarks('current', 'html', { folderId: recipes.id }));
    expect(sub).toContain('Soup');
    expect(sub).not.toContain('github');
    const dates = await a.run((s) => s.listSnapshots());
    expect(dates.length).toBe(1);
    expect(await a.run((s) => s.exportBookmarks(dates[0]!, 'json', {}))).toContain('GitHub');
  });

  it('restoring a snapshot propagates to other devices', async () => {
    const { a, b } = await twoDevices();
    const dates = await a.run((s) => s.listSnapshots());
    await a.add('1', 'later', 'https://later.com');
    await a.run((s) => s.sync());
    await b.run((s) => s.sync());
    expect(b.titles()).toEqual(['GitHub', 'later']);
    await a.run((s) => s.restoreSnapshot(dates[0]!));
    await b.run((s) => s.sync());
    expect(a.titles()).toEqual(['GitHub']);
    expect(b.titles()).toEqual(['GitHub']);
  });

  it('network failure → offline, then recovers', async () => {
    const { a } = await twoDevices();
    backend.failNext = 1;
    expect(await a.run((s) => s.sync())).toBe('offline');
    expect(await a.run((s) => s.sync())).toBe('ok');
  });

  it('wipe remote leaves bookmarks alone and requires setup again', async () => {
    const { a, b } = await twoDevices();
    await a.run((s) => s.wipeRemote());
    expect(backend.files.size).toBe(0);
    expect(a.titles()).toEqual(['GitHub']);
    expect(await b.run((s) => s.sync())).toBe('not-configured');
    expect(b.titles()).toEqual(['GitHub']);
  });
});
