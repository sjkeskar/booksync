import { beforeEach, describe, expect, it } from 'vitest';
import { applyOps, pickRoots, readRawTree } from '../src/adapters/browser/bookmarks';
import { IdMap } from '../src/core/idmap';
import { addNode, newTree, ROOT_BAR, ROOT_OTHER, type TNode } from '../src/core/model';
import { plan } from '../src/core/planner';
import { installFakeChrome } from './fakeChrome';
import { rng, seqId, show } from './util';

describe('browser adapter', () => {
  let fake: ReturnType<typeof installFakeChrome>;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('reads roots by folderType, regardless of localized titles', async () => {
    fake = installFakeChrome({ titles: ['Favoritenleiste', 'Weitere Favoriten', 'Mobil'] });
    await chrome.bookmarks.create({ parentId: '1', title: 'A', url: 'https://a.com' });
    const raw = await readRawTree();
    expect(raw.rootMap).toEqual({ 'root:bar': '1', 'root:other': '2', 'root:mobile': '3' });
    expect(show(raw.tree, false)).toContain('A <https://a.com>');
  });

  it('falls back to root order when folderType is unavailable (older Chromium)', async () => {
    fake = installFakeChrome({ folderTypes: false });
    const raw = await readRawTree();
    expect(raw.rootMap).toEqual({ 'root:bar': '1', 'root:other': '2', 'root:mobile': '3' });
  });

  it('picks the account tree when Chrome shows both account and local bookmarks', () => {
    const mk = (id: string, ft: string, syncing: boolean) => ({ id, title: id, folderType: ft, syncing }) as never;
    const top = [mk('1', 'bookmarks-bar', false), mk('2', 'other', false), mk('4', 'bookmarks-bar', true), mk('5', 'other', true)];
    const auto = pickRoots(top, 'auto');
    expect(auto.dual).toBe(true);
    expect(auto.roots.get(ROOT_BAR)!.id).toBe('4');
    expect(pickRoots(top, 'local').roots.get(ROOT_OTHER)!.id).toBe('2');
  });

  it('applying a plan makes the browser equal the target (incl. Chrome move quirk)', async () => {
    for (let seed = 0; seed < 60; seed++) {
      fake = installFakeChrome();
      const r = rng(seed);
      const ids = new IdMap();
      const newId = seqId('x');
      // random initial browser content
      const folders = ['1', '2'];
      for (let i = 0; i < 15; i++) {
        const isF = r.chance(0.3);
        const n = await chrome.bookmarks.create({ parentId: r.pick(folders), title: `n${i}`, ...(isF ? {} : { url: `https://e.com/${i}` }) });
        if (isF) folders.push(n.id);
      }
      const local = ids.mapTree((await readRawTree()).tree, newId);
      // random target: shuffle some existing sync ids around + new nodes
      const target = newTree();
      const tf = [ROOT_BAR, ROOT_OTHER];
      for (const n of local.nodes.values()) {
        if (r.chance(0.2)) continue;
        if (n.kind === 'folder') {
          addNode(target, { ...n, parent: r.pick(tf), title: r.chance(0.3) ? n.title + '!' : n.title }, 0);
          tf.push(n.id);
        }
      }
      for (const n of local.nodes.values()) {
        if (n.kind === 'bookmark' && r.chance(0.8)) {
          const p = r.pick(tf);
          addNode(target, { ...n, parent: p }, r.int(target.children.get(p)!.length + 1));
        }
      }
      for (let i = 0; i < 5; i++) {
        const p = r.pick(tf);
        const t: TNode = { id: `new${i}`, kind: 'bookmark', title: `new${i}`, url: `https://new.com/${i}`, parent: p, added: 0 };
        addNode(target, t, r.int(target.children.get(p)!.length + 1));
      }
      const raw = await readRawTree();
      const p = plan(local, target);
      const res = await applyOps(p.ops, ids, raw.rootMap);
      expect(res.failed).toEqual([]);
      const after = ids.mapTree((await readRawTree()).tree, newId);
      expect(show(after)).toBe(show(target));
    }
  });
});
