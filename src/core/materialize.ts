import {
  addNode,
  isRoot,
  newTree,
  RECOVERED_ID,
  RECOVERED_TITLE,
  ROOT_OTHER,
  ROOTS,
  type SyncNode,
  type SyncState,
  type Tree,
} from './model';

function byPos(state: SyncState) {
  return (a: string, b: string) => {
    const pa = state[a]!.place.v.pos;
    const pb = state[b]!.place.v.pos;
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

/**
 * Deterministic projection of the replicated state into an ordered tree.
 *  - A deleted folder is shown again if anything live still lives below it (delete never destroys
 *    what the deleting device hadn't seen).
 *  - Nodes whose parent is unknown, or which sit in a move cycle, go to the Recovered folder.
 *  - Siblings are ordered by (pos, id).
 * Because the state converges and this is a pure function, every device shows the same tree.
 */
export function materialize(state: SyncState): Tree {
  const visible = new Set<string>();
  for (const id in state) {
    let cur: SyncNode | undefined = state[id];
    if (!cur || cur.del.v) continue;
    const seen = new Set<string>();
    while (cur && !visible.has(cur.id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      visible.add(cur.id);
      const p: string = cur.place.v.parent;
      const parent: SyncNode | undefined = isRoot(p) ? undefined : state[p];
      cur = parent && parent.kind === 'folder' ? parent : undefined;
    }
  }

  const eff = new Map<string, string>();
  for (const id of visible) {
    const p = state[id]!.place.v.parent;
    if (isRoot(p)) eff.set(id, p);
    else if (visible.has(p) && state[p]!.kind === 'folder') eff.set(id, p);
    else eff.set(id, RECOVERED_ID);
  }

  // Break move cycles: the node in the cycle that moved most recently goes to Recovered.
  const sorted = [...visible].sort();
  const color = new Map<string, 1 | 2>();
  for (const start of sorted) {
    if (color.has(start)) continue;
    const path: string[] = [];
    let cur = start;
    for (;;) {
      if (isRoot(cur) || cur === RECOVERED_ID || color.get(cur) === 2) {
        for (const p of path) color.set(p, 2);
        break;
      }
      if (color.get(cur) === 1) {
        const cyc = path.slice(path.indexOf(cur));
        let victim = cyc[0]!;
        for (const c of cyc) {
          const tc = state[c]!.place.t;
          const tv = state[victim]!.place.t;
          if (tc > tv || (tc === tv && c > victim)) victim = c;
        }
        eff.set(victim, RECOVERED_ID);
        for (const p of path) color.delete(p);
        path.length = 0;
        cur = start;
        continue;
      }
      color.set(cur, 1);
      path.push(cur);
      cur = eff.get(cur)!;
    }
  }

  const kids = new Map<string, string[]>();
  for (const id of visible) {
    const p = eff.get(id)!;
    const k = kids.get(p);
    if (k) k.push(id);
    else kids.set(p, [id]);
  }
  const cmp = byPos(state);
  for (const k of kids.values()) k.sort(cmp);

  const tree = newTree();
  const needRecovered = kids.has(RECOVERED_ID);
  const build = (parent: string) => {
    for (const id of kids.get(parent) ?? []) {
      const n = state[id]!;
      addNode(tree, {
        id,
        kind: n.kind,
        title: n.title.v,
        ...(n.kind === 'bookmark' && n.url ? { url: n.url.v } : {}),
        parent,
        added: n.added,
      });
      if (n.kind === 'folder') build(id);
    }
  };
  for (const r of ROOTS) build(r);
  if (needRecovered) {
    addNode(tree, { id: RECOVERED_ID, kind: 'folder', title: RECOVERED_TITLE, parent: ROOT_OTHER, added: 0 });
    build(RECOVERED_ID);
  }
  return tree;
}
