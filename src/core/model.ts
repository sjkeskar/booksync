import type { HLC } from './hlc';

export type Kind = 'bookmark' | 'folder';

export const ROOT_BAR = 'root:bar';
export const ROOT_OTHER = 'root:other';
export const ROOT_MOBILE = 'root:mobile';
export const ROOTS = [ROOT_BAR, ROOT_OTHER, ROOT_MOBILE] as const;
export type RootId = (typeof ROOTS)[number];

/** Folder created on demand for orphans and cycle victims. Same id on every device. */
export const RECOVERED_ID = 'sys:recovered';
export const RECOVERED_TITLE = 'Recovered (Bookmark Sync)';

export function isRoot(id: string): id is RootId {
  return (ROOTS as readonly string[]).includes(id);
}

export interface LWW<T> {
  v: T;
  t: HLC;
}

export interface Place {
  parent: string;
  pos: string;
}

/** Replicated bookmark/folder record. Every mutable field is an independent LWW register. */
export interface SyncNode {
  id: string;
  kind: Kind;
  added: number;
  title: LWW<string>;
  url?: LWW<string>;
  place: LWW<Place>;
  del: LWW<boolean>;
}

export type SyncState = Record<string, SyncNode>;

export function maxFieldT(n: SyncNode | undefined): HLC {
  if (!n) return '';
  let t = n.title.t;
  if (n.url && n.url.t > t) t = n.url.t;
  if (n.place.t > t) t = n.place.t;
  if (n.del.t > t) t = n.del.t;
  return t;
}

export function maxStateT(s: SyncState): HLC {
  let t = '';
  for (const n of Object.values(s)) {
    const m = maxFieldT(n);
    if (m > t) t = m;
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// Tree: an ordered, materialized view (what a browser shows). Roots are implicit (not in nodes).
// ---------------------------------------------------------------------------------------------

export interface TNode {
  id: string;
  kind: Kind;
  title: string;
  url?: string;
  parent: string;
  added: number;
}

export interface Tree {
  nodes: Map<string, TNode>;
  children: Map<string, string[]>;
}

export function newTree(roots: readonly string[] = ROOTS): Tree {
  return { nodes: new Map(), children: new Map(roots.map((r) => [r, []])) };
}

export function childrenOf(t: Tree, id: string): string[] {
  return t.children.get(id) ?? [];
}

/** Append (or insert at index) a node; parent must already exist. */
export function addNode(t: Tree, n: TNode, index?: number): void {
  const kids = t.children.get(n.parent);
  if (!kids) throw new Error(`addNode: unknown parent ${n.parent} for ${n.id}`);
  if (t.nodes.has(n.id)) throw new Error(`addNode: duplicate id ${n.id}`);
  t.nodes.set(n.id, n);
  if (index === undefined || index >= kids.length) kids.push(n.id);
  else kids.splice(index, 0, n.id);
  if (n.kind === 'folder' && !t.children.has(n.id)) t.children.set(n.id, []);
}

export function treeRoots(t: Tree): string[] {
  return ROOTS.filter((r) => t.children.has(r));
}

/** Depth-first, parent-before-children order. */
export function treeToList(t: Tree): TNode[] {
  const out: TNode[] = [];
  const walk = (id: string) => {
    for (const c of childrenOf(t, id)) {
      const n = t.nodes.get(c);
      if (!n) continue;
      out.push(n);
      if (n.kind === 'folder') walk(c);
    }
  };
  for (const r of treeRoots(t)) walk(r);
  return out;
}

export function treeFromList(list: TNode[], roots: readonly string[] = ROOTS): Tree {
  const t = newTree(roots);
  for (const n of list) addNode(t, { ...n });
  return t;
}

export function* descendants(t: Tree, id: string): Generator<TNode> {
  for (const c of childrenOf(t, id)) {
    const n = t.nodes.get(c);
    if (!n) continue;
    yield n;
    if (n.kind === 'folder') yield* descendants(t, c);
  }
}

export function countBookmarks(t: Tree): number {
  let n = 0;
  for (const x of t.nodes.values()) if (x.kind === 'bookmark') n++;
  return n;
}
