import { runSync } from '../src/core/engine';
import { Clock } from '../src/core/hlc';
import { IdMap } from '../src/core/idmap';
import type { JoinMode } from '../src/core/initialJoin';
import { materialize } from '../src/core/materialize';
import type { PeerView } from '../src/core/merge';
import {
  addNode,
  childrenOf,
  newTree,
  ROOT_BAR,
  ROOT_MOBILE,
  ROOT_OTHER,
  ROOTS,
  treeToList,
  type SyncState,
  type TNode,
  type Tree,
} from '../src/core/model';
import { applyPlanToTree, type Op } from '../src/core/planner';

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(arr: T[]): T => arr[Math.floor(next() * arr.length)]!,
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;

type Spec = { id: string; t?: string; u?: string; c?: Spec[] };
/** Build a tree: { bar: [{id:'a', u:'http://a'}, {id:'f', c:[...]}], other: [...] } */
export function tree(spec: { bar?: Spec[]; other?: Spec[]; mobile?: Spec[] }): Tree {
  const t = newTree();
  const add = (parent: string, list: Spec[] = []) => {
    for (const s of list) {
      const folder = !!s.c;
      const n: TNode = { id: s.id, kind: folder ? 'folder' : 'bookmark', title: s.t ?? s.id, parent, added: 1 };
      if (!folder) n.url = s.u ?? `https://example.com/${s.id}`;
      addNode(t, n);
      if (folder) add(s.id, s.c);
    }
  };
  add(ROOT_BAR, spec.bar);
  add(ROOT_OTHER, spec.other);
  add(ROOT_MOBILE, spec.mobile);
  return t;
}

/** Canonical string of a tree's visible structure (ids, titles, urls, order). */
export function show(t: Tree, ids = true): string {
  const lines: string[] = [];
  const walk = (id: string, d: number) => {
    for (const c of childrenOf(t, id)) {
      const n = t.nodes.get(c)!;
      const label = n.kind === 'folder' ? `[${n.title}]` : `${n.title} <${n.url}>`;
      lines.push(`${'  '.repeat(d)}${ids ? c + ' ' : ''}${label}`);
      if (n.kind === 'folder') walk(c, d + 1);
    }
  };
  for (const r of ROOTS) if (t.children.has(r)) {
    lines.push(r);
    walk(r, 1);
  }
  return lines.join('\n');
}

export function cloneTree(t: Tree): Tree {
  const c = newTree([...t.children.keys()].filter((k) => (ROOTS as readonly string[]).includes(k)));
  for (const n of treeToList(t)) addNode(c, { ...n });
  return c;
}

let idSeq = 0;
export const seqId = (p = 's') => () => `${p}${(idSeq++).toString(36)}`;

/**
 * Simulated browser + extension, driving the real engine. The browser uses its own local ids,
 * like Chrome does, and the IdMap translates — exactly as the orchestrator will.
 */
export class SimDevice {
  browser: Tree = newTree();
  ids = new IdMap();
  base: Tree | null = null;
  known: SyncState = {};
  clock: Clock;
  eventTimes = new Map<string, number>();
  private localSeq = 0;
  lastBlocked: ReturnType<typeof runSync>['blocked'] = null;
  approvedRisky: Record<string, string> = {};
  lastSync = 0;

  constructor(
    readonly dev: string,
    readonly now: () => number,
    private readonly newId: () => string,
  ) {
    this.clock = new Clock(dev, '', now);
  }

  localId() {
    return `${this.dev}#${this.localSeq++}`;
  }

  // ---- user actions (local ids) ----
  add(parentLocal: string, title: string, url?: string): string {
    const id = this.localId();
    const n: TNode = { id, kind: url === undefined ? 'folder' : 'bookmark', title, parent: parentLocal, added: this.now() };
    if (url !== undefined) n.url = url;
    addNode(this.browser, n);
    return id;
  }
  rename(localId: string, title: string) {
    this.browser.nodes.get(localId)!.title = title;
  }
  setUrl(localId: string, url: string) {
    this.browser.nodes.get(localId)!.url = url;
  }
  remove(localId: string) {
    applyPlanToTree(this.browser, [{ op: 'remove', id: localId }]);
  }
  move(localId: string, parentLocal: string, index: number) {
    // refuse moving into own subtree, like Chrome
    let p: string | undefined = parentLocal;
    while (p && !(ROOTS as readonly string[]).includes(p)) {
      if (p === localId) return;
      p = this.browser.nodes.get(p)?.parent;
    }
    const n = this.browser.nodes.get(localId)!;
    const from = this.browser.children.get(n.parent)!;
    from.splice(from.indexOf(localId), 1);
    const to = this.browser.children.get(parentLocal)!;
    to.splice(Math.min(index, to.length), 0, localId);
    n.parent = parentLocal;
  }
  localOf(syncId: string) {
    return this.ids.toLocal(syncId)!;
  }

  /** The browser tree expressed in sync ids. */
  synced(): Tree {
    return this.ids.mapTree(this.browser, this.newId);
  }

  sync(store: Map<string, PeerView>, opts: { joinMode?: JoinMode; allowDeletes?: boolean } = {}) {
    if (this.base && !store.has(this.dev)) {
      // Evicted by housekeeping (or remote wiped): rejoin with a union merge, like the orchestrator.
      this.base = null;
      this.known = {};
      this.ids = new IdMap();
    }
    const remotes = [...store.entries()].filter(([d]) => d !== this.dev).map(([, s]) => s);
    const joining = this.base === null;
    const local = joining ? cloneTree(this.browser) : this.ids.mapTree(this.browser, this.newId);
    const out = runSync({
      base: this.base,
      known: this.known,
      local,
      remotes,
      clock: this.clock,
      eventTimes: this.eventTimes,
      now: this.now(),
      ...(opts.joinMode ? { joinMode: opts.joinMode } : {}),
      newId: this.newId,
      approvedRisky: this.approvedRisky,
      ...(opts.allowDeletes ? { allowDeletes: true } : {}),
    });
    if (out.ids) for (const [l, s] of out.ids) this.ids.set(l, s);
    this.lastBlocked = out.blocked;
    if (!out.blocked) {
      const ops: Op[] = out.plan.ops.map((o) => {
        switch (o.op) {
          case 'create': {
            const lid = this.localId();
            this.ids.set(lid, o.id);
            return { ...o, id: lid, parent: this.localOf(o.parent) };
          }
          case 'move':
            return { ...o, id: this.localOf(o.id), parent: this.localOf(o.parent) };
          default:
            return { ...o, id: this.localOf(o.id) };
        }
      });
      applyPlanToTree(this.browser, ops);
    }
    this.known = out.state;
    store.set(this.dev, { state: out.state, lastSync: this.now() });
    this.base = this.ids.mapTree(this.browser, this.newId);
    this.eventTimes.clear();
    this.lastSync = this.now();
    return out;
  }
}

export function view(s: SyncState) {
  return materialize(s);
}
