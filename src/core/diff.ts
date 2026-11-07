import { keysBetween } from './fracIndex';
import type { HLC } from './hlc';
import { maxFieldT, RECOVERED_ID, type SyncNode, type SyncState, type TNode, type Tree } from './model';

export interface DiffInput {
  /** The tree this device had right after its previous sync. */
  base: Tree;
  /** The tree the browser has now (ids already mapped to sync ids). */
  local: Tree;
  /** This device's own state from its previous sync (causality floor for timestamps). */
  known: SyncState;
  /** Current merged state (own + remote). Positions are computed against it. */
  current: SyncState;
  /** Issue a timestamp for a change to `id`, strictly greater than `floor`. */
  stamp: (id: string, floor: HLC) => HLC;
}

/** Indices (into `seq`) of a longest strictly increasing subsequence. */
export function lisIndices(seq: number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: number[] = [];
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k >= 0) {
    out.push(k);
    k = prev[k]!;
  }
  return out.reverse();
}

/**
 * Turn what the user did in the browser since the last sync (base → local) into a patch of
 * timestamped field updates. Unchanged fields are never touched, so concurrent edits to other
 * fields on other devices survive.
 */
export function diff(inp: DiffInput): SyncState {
  const { base, local, known, current } = inp;
  const patch: SyncState = {};
  const stamps = new Map<string, HLC>();
  const stampFor = (id: string) => {
    let s = stamps.get(id);
    if (!s) {
      s = inp.stamp(id, maxFieldT(known[id]));
      stamps.set(id, s);
    }
    return s;
  };
  const edit = (id: string): SyncNode => {
    let n = patch[id];
    if (!n) {
      const c = current[id]!;
      n = { ...c };
      patch[id] = n;
    }
    return n;
  };
  const needsPlace = new Set<string>();

  for (const l of local.nodes.values()) {
    if (l.id === RECOVERED_ID) continue;
    const b = base.nodes.get(l.id);
    const cur = current[l.id];
    if (!cur) {
      // New locally — or known to base but already pruned remotely; only a real change revives it.
      if (b && !changed(l, b)) continue;
      patch[l.id] = createNode(l, stampFor(l.id));
      needsPlace.add(l.id);
      continue;
    }
    if (!b) {
      // Present locally, known in state, absent from base: the browser has it, so it is live.
      const n = edit(l.id);
      const t = stampFor(l.id);
      n.title = { v: l.title, t };
      if (l.url !== undefined) n.url = { v: l.url, t };
      n.del = { v: false, t };
      needsPlace.add(l.id);
      continue;
    }
    let touched = false;
    if (l.title !== b.title) {
      edit(l.id).title = { v: l.title, t: stampFor(l.id) };
      touched = true;
    }
    if (l.url !== undefined && l.url !== b.url) {
      edit(l.id).url = { v: l.url, t: stampFor(l.id) };
      touched = true;
    }
    if (l.parent !== b.parent) {
      needsPlace.add(l.id);
      touched = true;
    }
    if (touched) edit(l.id).del = { v: false, t: stampFor(l.id) };
  }

  for (const b of base.nodes.values()) {
    if (b.id === RECOVERED_ID || local.nodes.has(b.id) || !current[b.id]) continue;
    edit(b.id).del = { v: true, t: stampFor(b.id) };
  }

  // Positions: keep the longest run of siblings whose relative order is unchanged; give every
  // other (new, moved, reordered) sibling a fresh key between its stable neighbours.
  const posOf = (id: string) => (patch[id] ?? current[id])!.place.v.pos;
  for (const [parent, allKids] of local.children) {
    // Skip the synthetic Recovered folder itself and nodes that no longer exist in any state.
    // Also skip nodes the user didn't move here but another device has since moved elsewhere:
    // re-placing them would silently revert that remote move.
    const kids = allKids.filter((k) => {
      if (k === RECOVERED_ID) return false;
      const c = patch[k] ?? current[k];
      if (!c) return false;
      if (!needsPlace.has(k) && parent !== RECOVERED_ID && c.place.v.parent !== parent) return false;
      return true;
    });
    if (!kids.length) continue;
    const baseIdx = new Map<string, number>();
    childrenOfBase(base, parent).forEach((id, i) => baseIdx.set(id, i));
    const cand: string[] = [];
    for (const k of kids) {
      if (needsPlace.has(k) || !baseIdx.has(k)) continue;
      const c = (patch[k] ?? current[k])!;
      if (parent !== RECOVERED_ID && c.place.v.parent !== parent) continue;
      cand.push(k);
    }
    const stable = new Set(lisIndices(cand.map((k) => baseIdx.get(k)!)).map((i) => cand[i]!));

    let i = 0;
    let lower: string | null = null;
    while (i < kids.length) {
      if (stable.has(kids[i]!)) {
        lower = posOf(kids[i]!);
        i++;
        continue;
      }
      const run: string[] = [];
      while (i < kids.length && !stable.has(kids[i]!)) run.push(kids[i++]!);
      let upper: string | null = i < kids.length ? posOf(kids[i]!) : null;
      while (upper !== null && lower !== null && upper <= lower) {
        run.push(kids[i++]!);
        while (i < kids.length && !stable.has(kids[i]!)) run.push(kids[i++]!);
        upper = i < kids.length ? posOf(kids[i]!) : null;
      }
      const keys = keysBetween(lower, upper, run.length);
      run.forEach((id, k) => {
        const n = patch[id] ?? edit(id);
        n.place = { v: { parent, pos: keys[k]! }, t: stampFor(id) };
      });
      lower = keys[keys.length - 1] ?? lower;
    }
  }
  return patch;
}

function childrenOfBase(t: Tree, id: string): string[] {
  return t.children.get(id) ?? [];
}

function changed(l: TNode, b: TNode): boolean {
  return l.title !== b.title || l.url !== b.url || l.parent !== b.parent;
}

function createNode(l: TNode, t: HLC): SyncNode {
  const n: SyncNode = {
    id: l.id,
    kind: l.kind,
    added: l.added,
    title: { v: l.title, t },
    place: { v: { parent: l.parent, pos: '' }, t },
    del: { v: false, t },
  };
  if (l.kind === 'bookmark') n.url = { v: l.url ?? '', t };
  return n;
}
