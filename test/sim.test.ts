import { describe, expect, it } from 'vitest';
import { materialize } from '../src/core/materialize';
import type { PeerView } from '../src/core/merge';
import { RECOVERED_ID, ROOT_BAR, ROOT_OTHER } from '../src/core/model';
import { DAY } from '../src/core/retention';
import { rng, seqId, show, SimDevice } from './util';

function world(n: number, start = Date.UTC(2026, 0, 1)) {
  let now = start;
  const clock = () => now;
  const newId = seqId('id');
  const devices = Array.from({ length: n }, (_, i) => new SimDevice(`dev${i}`, clock, newId));
  const store = new Map<string, PeerView>();
  return {
    devices,
    store,
    tick: (ms = 1000) => (now += ms),
    syncAll: (rounds = 2) => {
      for (let r = 0; r < rounds; r++) for (const d of devices) d.sync(store);
    },
  };
}

function expectConverged(devs: SimDevice[]) {
  const ref = show(devs[0]!.synced());
  for (const d of devs) {
    expect(show(d.synced())).toBe(ref);
    expect(show(materialize(d.known))).toBe(ref);
  }
}

const titles = (d: SimDevice, parent = ROOT_BAR) => d.browser.children.get(parent)!.map((id) => d.browser.nodes.get(id)!.title);

describe('first-time join', () => {
  it('remote empty → uploads; second device with more bookmarks merges without loss or duplicates', () => {
    const w = world(2);
    const [a, b] = w.devices as [SimDevice, SimDevice];
    a.add(ROOT_BAR, 'Shared', 'https://shared.com');
    const af = a.add(ROOT_BAR, 'Work');
    a.add(af, 'Jira', 'https://jira.com');
    a.sync(w.store);

    // B has the same things plus extras (the "browser has more than the sync file" case)
    b.add(ROOT_BAR, 'shared dup', 'https://SHARED.com/');
    const bf = b.add(ROOT_BAR, 'work');
    b.add(bf, 'Jira', 'https://jira.com');
    b.add(bf, 'Confluence', 'https://wiki.com');
    b.add(ROOT_OTHER, 'Recipes', 'https://food.com');
    const out = b.sync(w.store);
    expect(out.join).toEqual({ added: 2, matched: 3, deleted: 0 });

    w.syncAll();
    expectConverged(w.devices);
    expect(show(a.synced(), false)).toMatchInlineSnapshot(`
      "root:bar
        Shared <https://shared.com>
        [Work]
          Jira <https://jira.com>
          Confluence <https://wiki.com>
      root:other
        Recipes <https://food.com>
      root:mobile"
    `);
  });

  it('reinstall on the same PC (lost local state) does not duplicate', () => {
    const w = world(2);
    const [a, b] = w.devices as [SimDevice, SimDevice];
    for (let i = 0; i < 30; i++) a.add(ROOT_BAR, `b${i}`, `https://e.com/${i}`);
    w.syncAll();
    // B "reinstalls": extension state wiped, browser bookmarks remain
    b.base = null;
    b.known = {};
    b.ids = new (b.ids.constructor as new () => typeof b.ids)();
    w.store.delete('dev1');
    b.sync(w.store);
    w.syncAll();
    expect(a.browser.nodes.size).toBe(30);
    expectConverged(w.devices);
  });

  it('mode "remote" replaces the browser; mode "local" replaces the synced copy', () => {
    const w = world(3);
    const [a, b, c] = w.devices as [SimDevice, SimDevice, SimDevice];
    a.add(ROOT_BAR, 'A', 'https://a.com');
    a.sync(w.store);
    b.add(ROOT_BAR, 'B', 'https://b.com');
    b.sync(w.store, { joinMode: 'remote' });
    expect(titles(b)).toEqual(['A']);
    c.add(ROOT_BAR, 'C', 'https://c.com');
    c.sync(w.store, { joinMode: 'local' });
    w.syncAll();
    expectConverged(w.devices);
    expect(titles(a)).toEqual(['C']);
  });
});

describe('concurrent edits on multiple PCs', () => {
  function setup() {
    const w = world(2);
    const [a, b] = w.devices as [SimDevice, SimDevice];
    const f = a.add(ROOT_BAR, 'Folder');
    a.add(f, 'one', 'https://1.com');
    a.sync(w.store);
    b.sync(w.store);
    w.syncAll();
    return { w, a, b, fa: f, fb: b.localOf(a.ids.toSync(f)!) };
  }

  it('both add different bookmarks to the same folder → both kept, same order everywhere', () => {
    const { w, a, b, fa, fb } = setup();
    a.add(fa, 'from A', 'https://a.com');
    b.add(fb, 'from B', 'https://b.com');
    w.tick();
    a.sync(w.store);
    b.sync(w.store);
    w.syncAll();
    expectConverged(w.devices);
    expect(titles(a, fa).sort()).toEqual(['from A', 'from B', 'one']);
  });

  it('both add the same URL → deduped to one', () => {
    const { w, a, b, fa, fb } = setup();
    a.add(fa, 'News', 'https://news.com/?utm_source=a');
    b.add(fb, 'News!', 'https://news.com');
    a.sync(w.store);
    b.sync(w.store);
    w.syncAll();
    expectConverged(w.devices);
    expect(titles(a, fa).length).toBe(2);
  });

  it('later edit to the same title wins (real time of the edit, not sync time)', () => {
    const { w, a, b, fa, fb } = setup();
    const ka = a.browser.children.get(fa)![0]!;
    const kb = b.browser.children.get(fb)![0]!;
    const sid = a.ids.toSync(ka)!;
    // B edits first (offline for a while), A edits later; B syncs last.
    b.rename(kb, 'B title');
    b.eventTimes.set(sid, w.tick(1000));
    a.rename(ka, 'A title');
    a.eventTimes.set(sid, w.tick(1000));
    a.sync(w.store);
    w.tick(60_000);
    b.sync(w.store);
    w.syncAll();
    expectConverged(w.devices);
    expect(titles(a, fa)).toEqual(['A title']);
  });

  it('folder deleted on A while B adds into it → folder survives with B’s new item', () => {
    const { w, a, b, fa, fb } = setup();
    a.remove(fa);
    b.add(fb, 'new on B', 'https://new.com');
    a.sync(w.store);
    b.sync(w.store);
    w.syncAll();
    expectConverged(w.devices);
    expect(show(a.synced(), false)).toContain('new on B');
    expect(show(a.synced(), false)).not.toContain('one <');
  });

  it('rename on A + move on B both apply', () => {
    const { w, a, b, fa, fb } = setup();
    a.rename(fa, 'Renamed');
    b.move(fb, ROOT_OTHER, 0);
    a.sync(w.store);
    b.sync(w.store);
    w.syncAll();
    expectConverged(w.devices);
    expect(titles(a, ROOT_OTHER)).toEqual(['Renamed']);
  });

  it('move cycle (X into Y on A, Y into X on B) resolves via Recovered', () => {
    const w = world(2);
    const [a, b] = w.devices as [SimDevice, SimDevice];
    const x = a.add(ROOT_BAR, 'X');
    const y = a.add(ROOT_BAR, 'Y');
    a.sync(w.store);
    b.sync(w.store);
    a.move(y, x, 0);
    b.move(b.localOf(a.ids.toSync(x)!), b.localOf(a.ids.toSync(y)!), 0);
    a.sync(w.store);
    w.tick();
    b.sync(w.store);
    w.syncAll();
    expectConverged(w.devices);
    expect(a.synced().nodes.has(RECOVERED_ID)).toBe(true);
  });

  it('mass deletion from another device needs approval', () => {
    const w = world(2);
    const [a, b] = w.devices as [SimDevice, SimDevice];
    for (let i = 0; i < 40; i++) a.add(ROOT_BAR, `b${i}`, `https://e.com/${i}`);
    w.syncAll();
    for (const id of [...a.browser.children.get(ROOT_BAR)!]) a.remove(id);
    a.sync(w.store);
    b.sync(w.store);
    expect(b.lastBlocked?.count).toBe(40);
    expect(b.browser.children.get(ROOT_BAR)!.length).toBe(40);
    b.sync(w.store, { allowDeletes: true });
    expect(b.browser.children.get(ROOT_BAR)!.length).toBe(0);
  });

  it('risky bookmarklet from another device is held until approved', () => {
    const w = world(2);
    const [a, b] = w.devices as [SimDevice, SimDevice];
    a.add(ROOT_BAR, 'evil', 'javascript:alert(1)');
    w.syncAll();
    expect(b.browser.nodes.size).toBe(0);
    // Held node must not be treated as a local delete on the next sync
    b.sync(w.store);
    expect(Object.values(b.known).every((n) => !n.del.v)).toBe(true);
    const sid = a.ids.toSync(a.browser.children.get(ROOT_BAR)![0]!)!;
    b.approvedRisky[sid] = 'javascript:alert(1)';
    b.sync(w.store);
    expect(b.browser.nodes.size).toBe(1);
  });

  it('PC off for 4 months: deletions made elsewhere stick, nothing else is lost', () => {
    const w = world(2);
    const [a, b] = w.devices as [SimDevice, SimDevice];
    a.add(ROOT_BAR, 'keep', 'https://keep.com');
    const gone = a.add(ROOT_BAR, 'gone', 'https://gone.com');
    w.syncAll();
    a.remove(gone);
    a.sync(w.store);
    b.add(ROOT_BAR, 'offline add', 'https://off.com'); // B is off; this edit waits locally
    w.tick(120 * DAY);
    a.sync(w.store); // tombstone is old, but B hasn't acknowledged it → kept
    expect(Object.values(a.known).some((n) => n.title.v === 'gone')).toBe(true);
    b.sync(w.store);
    w.syncAll();
    expectConverged(w.devices);
    expect(titles(a)).toEqual(['keep', 'offline add']);
    // Now everyone has acknowledged → pruned on the next syncs
    w.syncAll();
    expect(Object.values(a.known).some((n) => n.title.v === 'gone')).toBe(false);
    expect(Object.values(b.known).some((n) => n.title.v === 'gone')).toBe(false);
  });

  it('PC off for 7 months and evicted: rejoins by union merge, loses nothing', () => {
    const w = world(2);
    const [a, b] = w.devices as [SimDevice, SimDevice];
    a.add(ROOT_BAR, 'keep', 'https://keep.com');
    w.syncAll();
    b.add(ROOT_BAR, 'offline add', 'https://off.com');
    w.tick(200 * DAY);
    a.add(ROOT_BAR, 'new on A', 'https://a.com');
    w.store.delete('dev1'); // housekeeping removed B's file after 180 days
    a.sync(w.store);
    b.sync(w.store);
    w.syncAll();
    expectConverged(w.devices);
    expect(titles(a).sort()).toEqual(['keep', 'new on A', 'offline add']);
  });

  it('a single PC that was off for months keeps everything', () => {
    const w = world(1);
    const [a] = w.devices as [SimDevice];
    a.add(ROOT_BAR, 'keep', 'https://keep.com');
    a.sync(w.store);
    w.tick(300 * DAY);
    a.sync(w.store);
    expect(titles(a)).toEqual(['keep']);
  });
});

describe('randomized multi-device convergence', () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://site${i}.com`);
  for (let seed = 1; seed <= 200; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const w = world(3);
      for (let step = 0; step < 60; step++) {
        const d = r.pick(w.devices);
        const nodes = [...d.browser.nodes.values()];
        const folders = [ROOT_BAR, ROOT_OTHER, ...nodes.filter((n) => n.kind === 'folder').map((n) => n.id)];
        const action = r.int(10);
        if (action < 3 || !nodes.length) d.add(r.pick(folders), `t${r.int(50)}`, r.chance(0.25) ? undefined : r.pick(urls));
        else if (action < 4) d.remove(r.pick(nodes).id);
        else if (action < 5) d.rename(r.pick(nodes).id, `r${r.int(50)}`);
        else if (action < 7) {
          const n = r.pick(nodes);
          const p = r.pick(folders);
          d.move(n.id, p, r.int(5));
        } else if (action < 8) d.sync(w.store, { allowDeletes: true });
        else w.tick(r.int(5000));
        if (d.base && r.chance(0.3)) d.sync(w.store, { allowDeletes: true });
        if (!d.base && r.chance(0.5)) d.sync(w.store, { allowDeletes: true });
      }
      for (let round = 0; round < 3; round++) for (const d of w.devices) d.sync(w.store, { allowDeletes: true });
      expectConverged(w.devices);
      // Quiescent: one more round changes nothing
      const before = show(w.devices[0]!.synced());
      for (const d of w.devices) {
        const out = d.sync(w.store);
        expect(out.plan.ops).toEqual([]);
      }
      expect(show(w.devices[0]!.synced())).toBe(before);
    });
  }
});
