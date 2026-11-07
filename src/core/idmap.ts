import { addNode, isRoot, newTree, treeRoots, treeToList, type Tree } from './model';

/** Bidirectional browser-local id ↔ sync id map. Roots are fixed and never stored. */
export class IdMap {
  private l2s = new Map<string, string>();
  private s2l = new Map<string, string>();

  constructor(entries: [string, string][] = []) {
    for (const [l, s] of entries) this.set(l, s);
  }

  set(localId: string, syncId: string): void {
    const oldS = this.l2s.get(localId);
    if (oldS !== undefined) this.s2l.delete(oldS);
    const oldL = this.s2l.get(syncId);
    if (oldL !== undefined) this.l2s.delete(oldL);
    this.l2s.set(localId, syncId);
    this.s2l.set(syncId, localId);
  }

  toSync(localId: string): string | undefined {
    return isRoot(localId) ? localId : this.l2s.get(localId);
  }

  toLocal(syncId: string): string | undefined {
    return isRoot(syncId) ? syncId : this.s2l.get(syncId);
  }

  deleteLocal(localId: string): void {
    const s = this.l2s.get(localId);
    if (s !== undefined) this.s2l.delete(s);
    this.l2s.delete(localId);
  }

  entries(): [string, string][] {
    return [...this.l2s.entries()];
  }

  get size(): number {
    return this.l2s.size;
  }

  /**
   * Convert a raw browser tree (local ids) to sync ids; local nodes never seen before get fresh
   * sync ids. Mappings for local ids no longer present are dropped.
   */
  mapTree(raw: Tree, newId: () => string): Tree {
    const t = newTree(treeRoots(raw));
    const present = new Set<string>();
    for (const n of treeToList(raw)) {
      present.add(n.id);
      let sid = this.l2s.get(n.id);
      if (sid === undefined) {
        sid = newId();
        this.set(n.id, sid);
      }
      addNode(t, { ...n, id: sid, parent: this.toSync(n.parent)! });
    }
    for (const l of [...this.l2s.keys()]) if (!present.has(l)) this.deleteLocal(l);
    return t;
  }
}
