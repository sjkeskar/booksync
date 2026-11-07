import { childrenOf, ROOTS, type Kind, type TNode, type Tree } from './model';

export type Op =
  | { op: 'create'; id: string; kind: Kind; parent: string; index: number; title: string; url?: string }
  | { op: 'update'; id: string; title?: string; url?: string }
  | { op: 'move'; id: string; parent: string; index: number }
  | { op: 'remove'; id: string };

export interface Plan {
  ops: Op[];
  /** Bookmarks (not folders) that the plan would delete from this browser. */
  removedBookmarks: number;
  /** Target nodes not created/updated because they need user approval. */
  held: string[];
}

/**
 * Ordered browser operations turning `local` into `target`. Indices refer to the browser state
 * at the moment each op runs. Only same-parent moves to a *lower* index and appends are produced,
 * which sidesteps Chrome's off-by-one on forward moves within a folder.
 *
 * Order: create folders (top-down) → cross-parent moves → removals (top-most only, after
 * survivors moved out) → create bookmarks → updates → reorder.
 */
export function plan(
  local: Tree,
  target: Tree,
  isHeld: (t: TNode, l: TNode | undefined) => boolean = () => false,
): Plan {
  const roots = ROOTS.filter((r) => local.children.has(r) && target.children.has(r));
  const parentOf = new Map<string, string>();
  const kids = new Map<string, string[]>();
  const kindOf = new Map<string, Kind>();
  for (const r of ROOTS) if (local.children.has(r)) kids.set(r, [...childrenOf(local, r)]);
  for (const n of local.nodes.values()) {
    parentOf.set(n.id, n.parent);
    kindOf.set(n.id, n.kind);
    if (n.kind === 'folder') kids.set(n.id, [...childrenOf(local, n.id)]);
  }

  const order: TNode[] = [];
  const inTarget = new Set<string>();
  const held: string[] = [];
  const heldUpdate = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const p = queue.shift()!;
    for (const c of childrenOf(target, p)) {
      const tn = target.nodes.get(c)!;
      const ln = local.nodes.get(c);
      if (tn.kind === 'bookmark' && isHeld(tn, ln)) {
        held.push(c);
        if (!ln) continue;
        heldUpdate.add(c);
      }
      order.push(tn);
      inTarget.add(c);
      if (tn.kind === 'folder') queue.push(c);
    }
  }

  const ops: Op[] = [];
  const detach = (id: string) => {
    const p = parentOf.get(id)!;
    const arr = kids.get(p)!;
    arr.splice(arr.indexOf(id), 1);
  };
  const attach = (id: string, parent: string, index: number) => {
    kids.get(parent)!.splice(index, 0, id);
    parentOf.set(id, parent);
  };

  // 1. folders
  for (const tn of order) {
    if (tn.kind !== 'folder' || parentOf.has(tn.id)) continue;
    const index = kids.get(tn.parent)!.length;
    ops.push({ op: 'create', id: tn.id, kind: 'folder', parent: tn.parent, index, title: tn.title });
    attach(tn.id, tn.parent, index);
    kids.set(tn.id, []);
    kindOf.set(tn.id, 'folder');
  }
  const created = new Set(ops.map((o) => o.id));

  // 2. cross-parent moves (survivors leave folders that may be removed next)
  for (const tn of order) {
    const cur = parentOf.get(tn.id);
    if (cur === undefined || cur === tn.parent) continue;
    if (kindOf.get(tn.id) !== tn.kind) continue; // kind mismatch handled as remove + create
    detach(tn.id);
    const index = kids.get(tn.parent)!.length;
    ops.push({ op: 'move', id: tn.id, parent: tn.parent, index });
    attach(tn.id, tn.parent, index);
  }

  // 3. removals
  let removedBookmarks = 0;
  const countBm = (id: string): number => {
    if (kindOf.get(id) === 'bookmark') return 1;
    let n = 0;
    for (const c of kids.get(id) ?? []) n += countBm(c);
    return n;
  };
  const toRemove: string[] = [];
  for (const id of parentOf.keys()) {
    const kindMismatch = inTarget.has(id) && kindOf.get(id) !== target.nodes.get(id)!.kind;
    if (inTarget.has(id) && !kindMismatch) continue;
    const p = parentOf.get(id)!;
    const parentSurvives = roots.includes(p as (typeof ROOTS)[number]) || (inTarget.has(p) && !toRemove.includes(p));
    if (parentSurvives) toRemove.push(id);
  }
  for (const id of toRemove) {
    if (!parentOf.has(id)) continue; // already dropped with an ancestor
    removedBookmarks += countBm(id);
    ops.push({ op: 'remove', id });
    detach(id);
    const drop = (x: string) => {
      for (const c of kids.get(x) ?? []) drop(c);
      parentOf.delete(x);
      kids.delete(x);
    };
    drop(id);
  }

  // 4. bookmarks (and re-created kind-mismatched nodes)
  for (const tn of order) {
    if (parentOf.has(tn.id)) continue;
    const index = kids.get(tn.parent)!.length;
    const op: Op = { op: 'create', id: tn.id, kind: tn.kind, parent: tn.parent, index, title: tn.title };
    if (tn.url !== undefined) op.url = tn.url;
    ops.push(op);
    attach(tn.id, tn.parent, index);
    if (tn.kind === 'folder') kids.set(tn.id, []);
    created.add(tn.id);
  }

  // 5. updates
  for (const tn of order) {
    if (created.has(tn.id)) continue;
    const ln = local.nodes.get(tn.id);
    if (!ln) continue;
    const u: Op & { op: 'update' } = { op: 'update', id: tn.id };
    if (ln.title !== tn.title) u.title = tn.title;
    if (tn.kind === 'bookmark' && tn.url !== undefined && ln.url !== tn.url && !heldUpdate.has(tn.id)) u.url = tn.url;
    if (u.title !== undefined || u.url !== undefined) ops.push(u);
  }

  // 6. reorder (only backward moves within a parent)
  const parents: string[] = [...roots, ...order.filter((n) => n.kind === 'folder').map((n) => n.id)];
  for (const p of parents) {
    const desired = childrenOf(target, p).filter((c) => inTarget.has(c));
    const cur = kids.get(p)!;
    for (let i = 0; i < desired.length; i++) {
      const want = desired[i]!;
      if (cur[i] === want) continue;
      const j = cur.indexOf(want);
      cur.splice(j, 1);
      cur.splice(i, 0, want);
      ops.push({ op: 'move', id: want, parent: p, index: i });
    }
  }

  return { ops, removedBookmarks, held };
}

/** Apply a plan to an in-memory tree (used by tests and the simulator to mirror a browser). */
export function applyPlanToTree(t: Tree, ops: Op[]): void {
  for (const o of ops) {
    switch (o.op) {
      case 'create': {
        const n: TNode = { id: o.id, kind: o.kind, title: o.title, parent: o.parent, added: 0 };
        if (o.url !== undefined) n.url = o.url;
        t.nodes.set(o.id, n);
        t.children.get(o.parent)!.splice(o.index, 0, o.id);
        if (o.kind === 'folder') t.children.set(o.id, []);
        break;
      }
      case 'update': {
        const n = t.nodes.get(o.id)!;
        if (o.title !== undefined) n.title = o.title;
        if (o.url !== undefined) n.url = o.url;
        break;
      }
      case 'move': {
        const n = t.nodes.get(o.id)!;
        const from = t.children.get(n.parent)!;
        from.splice(from.indexOf(o.id), 1);
        t.children.get(o.parent)!.splice(o.index, 0, o.id);
        n.parent = o.parent;
        break;
      }
      case 'remove': {
        const n = t.nodes.get(o.id)!;
        const from = t.children.get(n.parent)!;
        from.splice(from.indexOf(o.id), 1);
        const drop = (id: string) => {
          for (const c of t.children.get(id) ?? []) drop(c);
          t.children.delete(id);
          t.nodes.delete(id);
        };
        drop(o.id);
        break;
      }
    }
  }
}
