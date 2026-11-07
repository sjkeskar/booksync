import { keysBetween } from './fracIndex';
import type { HLC } from './hlc';
import { childrenOf, isRoot, ROOTS, type SyncNode, type SyncState, type TNode, type Tree } from './model';
import { normalizeUrl } from './urlNorm';

export type JoinMode = 'merge' | 'remote' | 'local';

/**
 * Match a browser tree that has never been synced (raw local ids) against the synced view,
 * top-down: folders by (matched parent, case-insensitive title, order), bookmarks by
 * (matched parent, normalized URL, order). Returns local id → sync id.
 */
export function matchTrees(local: Tree, view: Tree): Map<string, string> {
  const match = new Map<string, string>();
  const walk = (lp: string, rp: string) => {
    const folders = new Map<string, string[]>();
    const marks = new Map<string, string[]>();
    for (const rid of childrenOf(view, rp)) {
      const r = view.nodes.get(rid)!;
      const key = r.kind === 'folder' ? r.title.trim().toLowerCase() : normalizeUrl(r.url ?? '');
      const m = r.kind === 'folder' ? folders : marks;
      const g = m.get(key);
      if (g) g.push(rid);
      else m.set(key, [rid]);
    }
    for (const lid of childrenOf(local, lp)) {
      const l = local.nodes.get(lid)!;
      const key = l.kind === 'folder' ? l.title.trim().toLowerCase() : normalizeUrl(l.url ?? '');
      const g = (l.kind === 'folder' ? folders : marks).get(key);
      const rid = g?.shift();
      if (!rid) continue;
      match.set(lid, rid);
      if (l.kind === 'folder') walk(lid, rid);
    }
  };
  for (const r of ROOTS) if (local.children.has(r) && view.children.has(r)) walk(r, r);
  return match;
}

export interface JoinInput {
  mode: JoinMode;
  local: Tree; // raw local ids, roots already mapped to root ids
  remote: SyncState;
  view: Tree; // materialize(remote)
  stamp: () => HLC;
  newId: () => string;
}

export interface JoinResult {
  state: SyncState;
  /** raw local id → sync id for every local node */
  ids: Map<string, string>;
  added: number;
  matched: number;
  /** Remote nodes tombstoned (mode 'local' only). */
  deleted: number;
}

/**
 * First sync of a device. 'merge' is a pure union — nothing anywhere is deleted.
 *  - merge:  matched nodes take the synced values; unmatched local nodes are added after the
 *            existing children of their (matched) parent.
 *  - remote: browser becomes the synced copy (unmatched local nodes will be removed by the planner).
 *  - local:  synced copy becomes the browser's tree (unmatched remote nodes are tombstoned).
 */
export function joinStates(inp: JoinInput): JoinResult {
  const { mode, local, remote, view } = inp;
  const match = matchTrees(local, view);
  const ids = new Map<string, string>();
  for (const n of local.nodes.values()) ids.set(n.id, match.get(n.id) ?? inp.newId());
  const mapId = (raw: string) => (isRoot(raw) ? raw : ids.get(raw)!);

  const state: SyncState = { ...remote };
  let added = 0;
  let deleted = 0;
  const t = inp.stamp();

  const make = (l: TNode, parent: string, pos: string): SyncNode => {
    const n: SyncNode = {
      id: ids.get(l.id)!,
      kind: l.kind,
      added: l.added,
      title: { v: l.title, t },
      place: { v: { parent, pos }, t },
      del: { v: false, t },
    };
    if (l.kind === 'bookmark') n.url = { v: l.url ?? '', t };
    return n;
  };

  if (mode === 'remote') {
    return { state, ids, added: 0, matched: match.size, deleted: 0 };
  }

  for (const [rawParent, kids] of local.children) {
    if (!kids.length) continue;
    const parent = mapId(rawParent);
    if (mode === 'merge') {
      const fresh = kids.filter((k) => !match.has(k));
      if (!fresh.length) continue;
      const existing = childrenOf(view, parent);
      const last = existing.length ? remote[existing[existing.length - 1]!]?.place.v.pos ?? null : null;
      const keys = keysBetween(last, null, fresh.length);
      fresh.forEach((k, i) => {
        state[ids.get(k)!] = make(local.nodes.get(k)!, parent, keys[i]!);
        added++;
      });
    } else {
      const keys = keysBetween(null, null, kids.length);
      kids.forEach((k, i) => {
        const l = local.nodes.get(k)!;
        const sid = ids.get(k)!;
        const r = remote[sid];
        if (!r) {
          state[sid] = make(l, parent, keys[i]!);
          added++;
          return;
        }
        const n: SyncNode = { ...r, title: { v: l.title, t }, place: { v: { parent, pos: keys[i]! }, t }, del: { v: false, t } };
        if (l.kind === 'bookmark') n.url = { v: l.url ?? '', t };
        state[sid] = n;
      });
    }
  }

  if (mode === 'local') {
    const keep = new Set(match.values());
    for (const n of view.nodes.values()) {
      if (keep.has(n.id) || !state[n.id]) continue;
      state[n.id] = { ...state[n.id]!, del: { v: true, t } };
      deleted++;
    }
  }
  return { state, ids, added, matched: match.size, deleted };
}
