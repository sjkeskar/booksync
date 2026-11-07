import { bumpHlc, hlcMs } from './hlc';
import { isRoot, maxFieldT, type LWW, type SyncNode, type SyncState } from './model';
import { normalizeUrl } from './urlNorm';

function pick<T>(a: LWW<T>, b: LWW<T>): LWW<T> {
  if (a.t !== b.t) return b.t > a.t ? b : a;
  // Same timestamp but different values should never happen; break the tie deterministically.
  return JSON.stringify(b.v) > JSON.stringify(a.v) ? b : a;
}

export function mergeNode(a: SyncNode, b: SyncNode): SyncNode {
  const url = a.url && b.url ? pick(a.url, b.url) : (a.url ?? b.url);
  const n: SyncNode = {
    id: a.id,
    kind: a.kind,
    added: Math.min(a.added, b.added),
    title: pick(a.title, b.title),
    place: pick(a.place, b.place),
    del: pick(a.del, b.del),
  };
  if (url) n.url = url;
  return n;
}

/** CRDT join: commutative, associative, idempotent. Inputs are never mutated. */
export function mergeStates(...states: SyncState[]): SyncState {
  const out: SyncState = {};
  for (const s of states) {
    for (const id in s) {
      const n = s[id]!;
      const cur = out[id];
      out[id] = cur ? mergeNode(cur, n) : n;
    }
  }
  return out;
}

/**
 * Deterministic dedupe: live bookmarks with the same parent and normalized URL collapse to the one
 * with the smallest id. Losers get a tombstone whose timestamp is derived only from their own
 * fields, so every device computes the identical result independently.
 */
export function dedupe(state: SyncState): { state: SyncState; removed: string[] } {
  const groups = new Map<string, string[]>();
  for (const id in state) {
    const n = state[id]!;
    if (n.kind !== 'bookmark' || n.del.v || !n.url) continue;
    const key = `${n.place.v.parent}\n${normalizeUrl(n.url.v)}`;
    const g = groups.get(key);
    if (g) g.push(id);
    else groups.set(key, [id]);
  }
  let out: SyncState | null = null;
  const removed: string[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort();
    for (const id of ids.slice(1)) {
      const n = state[id]!;
      out ??= { ...state };
      out[id] = { ...n, del: { v: true, t: bumpHlc(maxFieldT(n)) } };
      removed.push(id);
    }
  }
  return { state: out ?? state, removed };
}

export interface PeerView {
  state: SyncState;
  /** Wall time the peer last uploaded its file. */
  lastSync: number;
}

/**
 * Drop tombstones older than maxAgeMs once every other device has acknowledged them — its file
 * either carries the tombstone, or no longer has the record and was written after the deletion
 * (meaning it pruned it). A device that was offline keeps tombstones alive until it returns or is
 * evicted, so a returning PC can never resurrect deleted bookmarks. Folders that still hold live
 * nodes are never pruned (they are shown resurrected).
 */
export function pruneTombstones(state: SyncState, nowMs: number, maxAgeMs: number, peers: PeerView[] = []): SyncState {
  const protectedIds = new Set<string>();
  for (const id in state) {
    const n = state[id]!;
    if (n.del.v) continue;
    let p = n.place.v.parent;
    const seen = new Set<string>();
    while (!isRoot(p) && state[p] && !seen.has(p)) {
      seen.add(p);
      protectedIds.add(p);
      p = state[p]!.place.v.parent;
    }
  }
  let out: SyncState | null = null;
  for (const id in state) {
    const n = state[id]!;
    if (!n.del.v || protectedIds.has(id)) continue;
    const delMs = hlcMs(maxFieldT(n));
    if (nowMs - delMs <= maxAgeMs) continue;
    const acked = peers.every((p) => {
      const pn = p.state[id];
      return pn ? pn.del.v : p.lastSync > delMs;
    });
    if (acked) {
      out ??= { ...state };
      delete out[id];
    }
  }
  return out ?? state;
}
