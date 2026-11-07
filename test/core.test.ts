import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diff, lisIndices } from '../src/core/diff';
import { toNetscapeHtml } from '../src/core/export';
import { isValidKey, keyBetween, keysBetween } from '../src/core/fracIndex';
import { Clock, fmtHlc, parseHlc } from '../src/core/hlc';
import { matchTrees } from '../src/core/initialJoin';
import { materialize } from '../src/core/materialize';
import { dedupe, mergeStates, pruneTombstones } from '../src/core/merge';
import { RECOVERED_ID, ROOT_BAR, ROOT_OTHER, type SyncNode, type SyncState } from '../src/core/model';
import { applyPlanToTree, plan } from '../src/core/planner';
import { pruneForBudget, snapshotsToKeep, DAY } from '../src/core/retention';
import { needsDeleteApproval, makeHoldPredicate } from '../src/core/safety';
import { isRiskyUrl, normalizeUrl } from '../src/core/urlNorm';
import { cloneTree, rng, show, tree, type Rng } from './util';
import { addNode, newTree, type TNode, type Tree } from '../src/core/model';

describe('hlc', () => {
  it('orders by ms, then counter, then device', () => {
    expect(fmtHlc(5, 0, 'a') < fmtHlc(6, 0, 'a')).toBe(true);
    expect(fmtHlc(5, 1, 'a') > fmtHlc(5, 0, 'z')).toBe(true);
    expect(fmtHlc(5, 0, 'b') > fmtHlc(5, 0, 'a')).toBe(true);
    expect(parseHlc(fmtHlc(1730000000000, 7, 'dev1'))).toEqual({ ms: 1730000000000, c: 7, dev: 'dev1' });
  });
  it('stamps are monotonic and exceed the floor', () => {
    let now = 1000;
    const c = new Clock('d', '', () => now);
    const a = c.stamp();
    const b = c.stamp();
    expect(b > a).toBe(true);
    now = 500; // clock went backwards
    expect(c.stamp() > b).toBe(true);
    const floor = fmtHlc(99999, 3, 'x');
    expect(c.stamp(undefined, floor) > floor).toBe(true);
    expect(c.stamp(10, floor) > floor).toBe(true);
  });
});

describe('fracIndex', () => {
  it('generates keys strictly between neighbours', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(1000), { minLength: 1, maxLength: 200 }), (seq) => {
        const keys: string[] = [];
        for (const r of seq) {
          const i = r % (keys.length + 1);
          const k = keyBetween(keys[i - 1] ?? null, keys[i] ?? null);
          expect(isValidKey(k)).toBe(true);
          keys.splice(i, 0, k);
        }
        for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
      }),
    );
  });
  it('bulk keys stay short', () => {
    const ks = keysBetween(null, null, 5000);
    expect(new Set(ks).size).toBe(5000);
    expect([...ks].sort()).toEqual(ks);
    expect(Math.max(...ks.map((k) => k.length))).toBeLessThanOrEqual(5);
  });
});

describe('urlNorm', () => {
  it('normalizes for matching', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/a/?utm_source=x&b=1#h')).toBe('https://example.com/a?b=1#h');
    expect(normalizeUrl('https://example.com/')).toBe(normalizeUrl('https://example.com'));
    expect(normalizeUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(isRiskyUrl(' JavaScript:void(0)')).toBe(true);
    expect(isRiskyUrl('data:text/html,hi')).toBe(true);
    expect(isRiskyUrl('https://x')).toBe(false);
  });
});

const T = (ms: number, dev = 'a') => fmtHlc(ms, 0, dev);
function node(id: string, parent: string, pos: string, t: number, extra: Partial<SyncNode> = {}): SyncNode {
  return {
    id,
    kind: 'bookmark',
    added: 0,
    title: { v: id, t: T(t) },
    url: { v: `https://e.com/${id}`, t: T(t) },
    place: { v: { parent, pos }, t: T(t) },
    del: { v: false, t: T(t) },
    ...extra,
  };
}
function folder(id: string, parent: string, pos: string, t: number, extra: Partial<SyncNode> = {}): SyncNode {
  const n = node(id, parent, pos, t, extra);
  delete n.url;
  n.kind = 'folder';
  return n;
}

describe('merge', () => {
  it('is commutative, associative, idempotent', () => {
    const r = rng(1);
    const gen = (): SyncState => {
      const s: SyncState = {};
      for (let i = 0; i < 6; i++) {
        const id = `n${r.int(5)}`;
        s[id] = node(id, ROOT_BAR, 'V', r.int(10), {
          title: { v: `t${r.int(3)}`, t: T(r.int(10), r.pick(['a', 'b'])) },
          del: { v: r.chance(0.3), t: T(r.int(10)) },
        });
      }
      return s;
    };
    for (let k = 0; k < 200; k++) {
      const a = gen();
      const b = gen();
      const c = gen();
      expect(mergeStates(a, b)).toEqual(mergeStates(b, a));
      expect(mergeStates(mergeStates(a, b), c)).toEqual(mergeStates(a, mergeStates(b, c)));
      expect(mergeStates(a, a)).toEqual(a);
    }
  });
  it('field-level LWW keeps concurrent edits to different fields', () => {
    const base = node('x', ROOT_BAR, 'V', 1);
    const a = { x: { ...base, title: { v: 'renamed', t: T(5, 'a') } } };
    const b = { x: { ...base, place: { v: { parent: ROOT_OTHER, pos: 'V' }, t: T(6, 'b') } } };
    const m = mergeStates(a, b).x!;
    expect(m.title.v).toBe('renamed');
    expect(m.place.v.parent).toBe(ROOT_OTHER);
  });
  it('dedupes same URL in same folder deterministically', () => {
    const s: SyncState = {
      b: node('b', ROOT_BAR, 'a', 2, { url: { v: 'https://x.com/?utm_source=1', t: T(2) } }),
      a: node('a', ROOT_BAR, 'b', 3, { url: { v: 'https://X.com', t: T(3) } }),
      c: node('c', ROOT_OTHER, 'a', 3, { url: { v: 'https://x.com', t: T(3) } }),
    };
    const r = dedupe(s);
    expect(r.removed).toEqual(['b']);
    expect(r.state.b!.del.v).toBe(true);
    expect(dedupe(r.state).removed).toEqual([]);
  });
  it('prunes old tombstones but not folders that still hold live nodes', () => {
    const now = 1000 * DAY;
    const s: SyncState = {
      gone: node('gone', ROOT_BAR, 'a', 0, { del: { v: true, t: T(1) } }),
      fresh: node('fresh', ROOT_BAR, 'b', 0, { del: { v: true, t: T(now - DAY) } }),
      f: folder('f', ROOT_BAR, 'c', 0, { del: { v: true, t: T(1) } }),
      kid: node('kid', 'f', 'a', now),
    };
    const p = pruneTombstones(s, now, 90 * DAY);
    expect(Object.keys(p).sort()).toEqual(['f', 'fresh', 'kid']);
  });
});

describe('materialize', () => {
  it('orders by pos then id, resurrects parents of live nodes', () => {
    const s: SyncState = {
      f: folder('f', ROOT_BAR, 'V', 1, { del: { v: true, t: T(5) } }),
      k: node('k', 'f', 'V', 6),
      z: node('z', ROOT_BAR, 'a', 1),
      y: node('y', ROOT_BAR, 'a', 1),
    };
    expect(show(materialize(s))).toMatchInlineSnapshot(`
      "root:bar
        f [f]
          k k <https://e.com/k>
        y y <https://e.com/y>
        z z <https://e.com/z>
      root:other
      root:mobile"
    `);
  });
  it('sends orphans and cycle victims to Recovered', () => {
    const s: SyncState = {
      o: node('o', 'unknown', 'V', 1),
      a: folder('a', 'b', 'V', 5),
      b: folder('b', 'a', 'V', 7),
    };
    const t = materialize(s);
    expect(t.nodes.get('o')!.parent).toBe(RECOVERED_ID);
    expect(t.nodes.get('b')!.parent).toBe(RECOVERED_ID); // moved last
    expect(t.nodes.get('a')!.parent).toBe('b');
    expect(t.children.get(ROOT_OTHER)!.at(-1)).toBe(RECOVERED_ID);
  });
});

describe('diff', () => {
  const clock = () => {
    let n = 100;
    return (_id: string, floor: string) => {
      const h = T(n++, 'me');
      return h > floor ? h : floor + '1';
    };
  };
  it('only stamps changed fields', () => {
    const known: SyncState = { a: node('a', ROOT_BAR, 'V', 1), b: node('b', ROOT_BAR, 'k', 1) };
    const base = materialize(known);
    const local = cloneTree(base);
    local.nodes.get('a')!.title = 'A!';
    const p = diff({ base, local, known, current: known, stamp: clock() });
    expect(Object.keys(p)).toEqual(['a']);
    expect(p.a!.title.v).toBe('A!');
    expect(p.a!.place.t).toBe(known.a!.place.t);
  });
  it('detects deletes, creates and reorders with minimal re-keying', () => {
    const known: SyncState = {
      a: node('a', ROOT_BAR, '1', 1),
      b: node('b', ROOT_BAR, '2', 1),
      c: node('c', ROOT_BAR, '3', 1),
      d: node('d', ROOT_BAR, '4', 1),
    };
    const base = materialize(known);
    const local = tree({ bar: [{ id: 'b' }, { id: 'n' }, { id: 'c' }, { id: 'd' }, { id: 'a' }] });
    for (const id of ['a', 'b', 'c', 'd']) local.nodes.get(id)!.url = `https://e.com/${id}`;
    const p = diff({ base, local, known, current: known, stamp: clock() });
    expect(p.n!.del.v).toBe(false);
    expect(Object.keys(p).sort()).toEqual(['a', 'n']);
    const merged = mergeStates(known, p);
    expect(show(materialize(merged), false)).toBe(show(local, false));
  });
  it('lis', () => {
    expect(lisIndices([3, 1, 2, 5, 4]).map((i) => [3, 1, 2, 5, 4][i])).toEqual([1, 2, 4]);
    expect(lisIndices([])).toEqual([]);
  });
});

describe('planner', () => {
  it('applying the plan turns local into target (random trees)', () => {
    for (let seed = 0; seed < 400; seed++) {
      const r = rng(seed);
      const pool = Array.from({ length: 25 }, (_, i) => `n${i}`);
      // Make kinds consistent across both trees for shared ids
      const kinds = new Map(pool.map((id) => [id, r.chance(0.3)]));
      const build = (ids: string[]) => {
        const t = newTree();
        const folders = [ROOT_BAR, ROOT_OTHER];
        for (const id of ids) {
          const parent = r.pick(folders);
          const isF = kinds.get(id)!;
          const n: TNode = { id, kind: isF ? 'folder' : 'bookmark', title: id + r.int(2), parent, added: 0 };
          if (!isF) n.url = `https://e.com/${r.int(2)}`;
          addNode(t, n, r.int(t.children.get(parent)!.length + 1));
          if (isF) folders.push(id);
        }
        return t;
      };
      const local = build(pool.filter(() => r.chance(0.7)));
      const target = build(pool.filter(() => r.chance(0.7)));
      const p = plan(local, target);
      const sim = cloneTree(local);
      applyPlanToTree(sim, p.ops);
      expect(show(sim)).toBe(show(target));
    }
  });
  it('holds risky URLs until approved', () => {
    const local = tree({});
    const target = tree({ bar: [{ id: 'js', u: 'javascript:alert(1)' }, { id: 'ok' }] });
    const p = plan(local, target, makeHoldPredicate({}));
    expect(p.held).toEqual(['js']);
    expect(p.ops.map((o) => o.id)).toEqual(['ok']);
    const p2 = plan(local, target, makeHoldPredicate({ js: 'javascript:alert(1)' }));
    expect(p2.held).toEqual([]);
  });
  it('counts removed bookmarks for the safety gate', () => {
    const local = tree({ bar: [{ id: 'f', c: [{ id: 'a' }, { id: 'b' }] }, { id: 'c' }] });
    const p = plan(local, tree({ bar: [{ id: 'c' }] }));
    expect(p.removedBookmarks).toBe(2);
    expect(needsDeleteApproval(21, 1000)).toBe(true);
    expect(needsDeleteApproval(5, 30)).toBe(false);
    expect(needsDeleteApproval(10, 60)).toBe(true);
  });
});

describe('initial join matching', () => {
  it('matches folders by title and bookmarks by normalized URL', () => {
    const remote = tree({ bar: [{ id: 'R1', t: 'News', c: [{ id: 'R2', u: 'https://bbc.com/' }] }, { id: 'R3', u: 'https://x.com' }] });
    const local = tree({ bar: [{ id: 'L1', t: 'news', c: [{ id: 'L2', u: 'https://BBC.com' }, { id: 'L3' }] }, { id: 'L4' }] });
    const m = matchTrees(local, remote);
    expect([...m.entries()]).toEqual([
      ['L1', 'R1'],
      ['L2', 'R2'],
    ]);
  });
});

describe('export', () => {
  it('writes an importable Netscape bookmark file', () => {
    const t = tree({ bar: [{ id: 'f', t: 'A & B', c: [{ id: 'x', t: '<script>', u: 'https://e.com/?a=1&b="2"' }] }, { id: 'j', u: 'javascript:1' }] });
    const html = toNetscapeHtml(t, { skipScripts: true });
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true"');
    expect(html).toContain('<H3 ADD_DATE="0" LAST_MODIFIED="0">A &amp; B</H3>');
    expect(html).toContain('HREF="https://e.com/?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(toNetscapeHtml(t, { folderId: 'f' })).not.toContain('Bookmarks bar');
  });
});

describe('retention', () => {
  it('keeps GFS snapshots', () => {
    const dates: string[] = [];
    const start = Date.UTC(2025, 0, 1);
    for (let d = 0; d < 700; d++) dates.push(new Date(start + d * DAY).toISOString().slice(0, 10));
    const today = dates.at(-1)!;
    const keep = snapshotsToKeep(dates, today);
    expect(keep.size).toBeLessThanOrEqual(34);
    expect(keep.size).toBeGreaterThanOrEqual(26);
    for (const d of dates.slice(-14)) expect(keep.has(d)).toBe(true);
    expect(keep.has(dates[0]!)).toBe(false);
  });
  it('prunes oldest snapshots to fit the budget', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, size: 10, date: `2026-01-${String(i + 1).padStart(2, '0')}` }));
    expect(pruneForBudget(files, 50, 200)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(pruneForBudget(files, 1000, 200).length).toBe(13); // keeps 7
  });
});
