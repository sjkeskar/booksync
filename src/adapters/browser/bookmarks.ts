import type { IdMap } from '../../core/idmap';
import { addNode, newTree, ROOT_BAR, ROOT_MOBILE, ROOT_OTHER, type RootId, type TNode, type Tree } from '../../core/model';
import type { Op } from '../../core/planner';

type BTN = chrome.bookmarks.BookmarkTreeNode & {
  folderType?: 'bookmarks-bar' | 'other' | 'mobile' | 'managed';
  syncing?: boolean;
  unmodifiable?: string;
};

export type TreePreference = 'auto' | 'account' | 'local';

export interface RawTree {
  /** Local browser ids; root folders appear as root:bar / root:other / root:mobile. */
  tree: Tree;
  /** root id → browser's local id for that root folder */
  rootMap: Partial<Record<RootId, string>>;
  /** The browser shows two sets of roots (Chrome account storage + local storage). */
  dualStorage: boolean;
  usingAccountTree: boolean;
}

const TYPE_TO_ROOT: Record<string, RootId> = { 'bookmarks-bar': ROOT_BAR, other: ROOT_OTHER, mobile: ROOT_MOBILE };
const INDEX_TO_ROOT: RootId[] = [ROOT_BAR, ROOT_OTHER, ROOT_MOBILE];

/** Pick the permanent folders this extension syncs (pure; exported for tests). */
export function pickRoots(top: BTN[], pref: TreePreference): { roots: Map<RootId, BTN>; dual: boolean; account: boolean } {
  const candidates = top.filter((n) => !n.url && n.folderType !== 'managed' && !n.unmodifiable);
  const hasTypes = candidates.some((n) => n.folderType);
  const dual = candidates.some((n) => n.syncing === true) && candidates.some((n) => n.syncing === false);
  const wantAccount = pref === 'account' || (pref === 'auto' && dual);
  const roots = new Map<RootId, BTN>();
  candidates.forEach((n, i) => {
    const r = hasTypes ? TYPE_TO_ROOT[n.folderType ?? ''] : INDEX_TO_ROOT[i];
    if (!r) return;
    if (dual && n.syncing !== wantAccount) return;
    if (!roots.has(r)) roots.set(r, n);
  });
  return { roots, dual, account: dual && wantAccount };
}

export async function readRawTree(pref: TreePreference = 'auto'): Promise<RawTree> {
  const [root] = (await chrome.bookmarks.getTree()) as BTN[];
  const { roots, dual, account } = pickRoots((root?.children ?? []) as BTN[], pref);
  const tree = newTree([...roots.keys()]);
  const rootMap: Partial<Record<RootId, string>> = {};
  const walk = (parentKey: string, nodes: BTN[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.unmodifiable) continue;
      const t: TNode = { id: n.id, kind: n.url !== undefined ? 'bookmark' : 'folder', title: n.title ?? '', parent: parentKey, added: n.dateAdded ?? 0 };
      if (n.url !== undefined) t.url = n.url;
      addNode(tree, t);
      if (t.kind === 'folder') walk(n.id, n.children as BTN[] | undefined);
    }
  };
  for (const [rid, node] of roots) {
    rootMap[rid] = node.id;
    walk(rid, node.children as BTN[] | undefined);
  }
  return { tree, rootMap, dualStorage: dual, usingAccountTree: account };
}

export interface ApplyResult {
  applied: number;
  failed: { op: Op; error: string }[];
  /** Local ids this run created or changed (for telling own events from the user's). */
  touched: Set<string>;
}

/**
 * Execute planner ops against chrome.bookmarks. Ops use sync ids; the IdMap translates and is
 * updated with ids of newly created nodes. Failures are collected, not thrown: whatever didn't
 * apply is simply retried by the next sync's plan.
 */
export async function applyOps(ops: Op[], ids: IdMap, rootMap: Partial<Record<RootId, string>>): Promise<ApplyResult> {
  const toLocal = (sid: string) => {
    const r = rootMap[sid as RootId];
    if (r) return r;
    return ids.toLocal(sid);
  };
  const res: ApplyResult = { applied: 0, failed: [], touched: new Set() };
  for (const op of ops) {
    try {
      switch (op.op) {
        case 'create': {
          const parentId = toLocal(op.parent);
          if (!parentId) throw new Error('parent missing');
          const details: chrome.bookmarks.CreateDetails = { parentId, index: op.index, title: op.title };
          if (op.url !== undefined) details.url = op.url;
          const created = await chrome.bookmarks.create(details);
          ids.set(created.id, op.id);
          res.touched.add(created.id);
          break;
        }
        case 'update': {
          const id = toLocal(op.id);
          if (!id) throw new Error('node missing');
          const changes: { title?: string; url?: string } = {};
          if (op.title !== undefined) changes.title = op.title;
          if (op.url !== undefined) changes.url = op.url;
          await chrome.bookmarks.update(id, changes);
          res.touched.add(id);
          break;
        }
        case 'move': {
          const id = toLocal(op.id);
          const parentId = toLocal(op.parent);
          if (!id || !parentId) throw new Error('node or parent missing');
          const [cur] = await chrome.bookmarks.get(id);
          let index = op.index;
          // Chrome counts the index before removing the node from its old slot.
          if (cur && cur.parentId === parentId && cur.index !== undefined && cur.index < index) index += 1;
          await chrome.bookmarks.move(id, { parentId, index });
          res.touched.add(id);
          break;
        }
        case 'remove': {
          const id = toLocal(op.id);
          if (!id) break;
          const [cur] = await chrome.bookmarks.get(id).catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);
          if (!cur) break;
          if (cur.url === undefined) await chrome.bookmarks.removeTree(id);
          else await chrome.bookmarks.remove(id);
          res.touched.add(id);
          break;
        }
      }
      res.applied++;
    } catch (e) {
      res.failed.push({ op, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return res;
}

export async function bookmarkCount(): Promise<number> {
  const raw = await readRawTree();
  let n = 0;
  for (const x of raw.tree.nodes.values()) if (x.kind === 'bookmark') n++;
  return n;
}
