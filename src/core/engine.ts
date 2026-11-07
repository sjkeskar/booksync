import { diff } from './diff';
import { Clock } from './hlc';
import { joinStates, type JoinMode } from './initialJoin';
import { materialize } from './materialize';
import { dedupe, mergeStates, pruneTombstones, type PeerView } from './merge';
import { addNode, countBookmarks, isRoot, newTree, treeRoots, treeToList, type SyncState, type Tree } from './model';
import { plan as makePlan, type Plan } from './planner';
import { TOMBSTONE_MAX_AGE } from './retention';
import { DEFAULT_SAFETY, makeHoldPredicate, needsDeleteApproval, type SafetyConfig } from './safety';

export interface EngineInput {
  /** Tree after previous sync; null on first sync of this device (initial join). */
  base: Tree | null;
  /** Own state persisted from previous sync. */
  known: SyncState;
  /** Browser tree. Sync ids for a normal sync; raw local ids (roots mapped) for a join. */
  local: Tree;
  /** States of the other devices (every device file present in the store). */
  remotes: PeerView[];
  clock: Clock;
  /** sync id → wall time of the user's change, from bookmark events. */
  eventTimes?: Map<string, number>;
  now: number;
  joinMode?: JoinMode;
  newId: () => string;
  approvedRisky?: Record<string, string>;
  safety?: SafetyConfig;
  /** User approved this sync's deletions. */
  allowDeletes?: boolean;
}

export interface EngineOutput {
  /** New own state: persist locally and upload as this device's file. */
  state: SyncState;
  view: Tree;
  /** Browser tree with sync ids (equals input.local for normal syncs). */
  local: Tree;
  plan: Plan;
  /** Set when the plan must not be applied without the user's approval. */
  blocked: { reason: 'mass-delete'; count: number; total: number } | null;
  /** Join only: raw local id → sync id. */
  ids?: Map<string, string>;
  join?: { added: number; matched: number; deleted: number };
  dedupeRemoved: string[];
}

export function mapTreeIds(raw: Tree, ids: Map<string, string>): Tree {
  const t = newTree(treeRoots(raw));
  const m = (id: string) => (isRoot(id) ? id : ids.get(id) ?? id);
  for (const n of treeToList(raw)) addNode(t, { ...n, id: m(n.id), parent: m(n.parent) });
  return t;
}

/** One complete, pure sync step. All IO (browser, Drive, storage) happens outside. */
export function runSync(inp: EngineInput): EngineOutput {
  const merged0 = mergeStates(inp.known, ...inp.remotes.map((r) => r.state));
  let state1: SyncState;
  let local = inp.local;
  let ids: Map<string, string> | undefined;
  let join: EngineOutput['join'];

  if (!inp.base) {
    const view0 = materialize(merged0);
    const j = joinStates({
      mode: inp.joinMode ?? 'merge',
      local: inp.local,
      remote: merged0,
      view: view0,
      stamp: () => inp.clock.stamp(),
      newId: inp.newId,
    });
    state1 = j.state;
    ids = j.ids;
    local = mapTreeIds(inp.local, j.ids);
    join = { added: j.added, matched: j.matched, deleted: j.deleted };
  } else {
    const patch = diff({
      base: inp.base,
      local,
      known: inp.known,
      current: merged0,
      stamp: (id, floor) => inp.clock.stamp(inp.eventTimes?.get(id), floor),
    });
    state1 = mergeStates(merged0, patch);
  }

  const pruned = pruneTombstones(state1, inp.now, TOMBSTONE_MAX_AGE, inp.remotes);
  const { state, removed } = dedupe(pruned);
  const view = materialize(state);
  const plan = makePlan(local, view, makeHoldPredicate(inp.approvedRisky ?? {}));

  const total = countBookmarks(local);
  const explicitReplace = !inp.base && inp.joinMode === 'remote';
  const blocked =
    !inp.allowDeletes && !explicitReplace && needsDeleteApproval(plan.removedBookmarks, total, inp.safety ?? DEFAULT_SAFETY)
      ? { reason: 'mass-delete' as const, count: plan.removedBookmarks, total }
      : null;

  const out: EngineOutput = { state, view, local, plan, blocked, dedupeRemoved: removed };
  if (ids) out.ids = ids;
  if (join) out.join = join;
  return out;
}

/**
 * Base for the next sync when the user chose to keep bookmarks a blocked sync wanted to delete:
 * dropping them from the base makes the next diff re-assert them as live.
 */
export function baseWithout(base: Tree, local: Tree, view: Tree): Tree {
  const t = newTree(treeRoots(base));
  const keepOut = new Set<string>();
  for (const n of local.nodes.values()) if (!view.nodes.has(n.id)) keepOut.add(n.id);
  for (const n of treeToList(base)) {
    if (keepOut.has(n.id) || !t.children.has(n.parent)) continue;
    addNode(t, { ...n });
  }
  return t;
}
