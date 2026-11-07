/* In-memory stand-ins for the chrome.* APIs the extension uses. Behaviour mirrors Chrome where it
   matters (ids are strings, permanent folders can't be removed, forward moves inside one folder
   count the index before removal). */

type Node = { id: string; parentId?: string; title: string; url?: string; dateAdded: number; children?: Node[]; folderType?: string; syncing?: boolean };
type Listener = (...args: unknown[]) => void;

class Evt {
  private ls: Listener[] = [];
  addListener(l: Listener) {
    this.ls.push(l);
  }
  removeListener(l: Listener) {
    this.ls = this.ls.filter((x) => x !== l);
  }
  hasListener(l: Listener) {
    return this.ls.includes(l);
  }
  emit(...a: unknown[]) {
    for (const l of this.ls) l(...a);
  }
}

export class FakeBookmarks {
  private seq = 100;
  root: Node;
  byId = new Map<string, Node>();
  onCreated = new Evt();
  onRemoved = new Evt();
  onChanged = new Evt();
  onMoved = new Evt();
  onChildrenReordered = new Evt();
  onImportBegan = new Evt();
  onImportEnded = new Evt();

  constructor(opts: { folderTypes?: boolean; titles?: [string, string, string] } = {}) {
    const [b, o, m] = opts.titles ?? ['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks'];
    const mk = (id: string, title: string, ft: string): Node => ({ id, parentId: '0', title, dateAdded: 0, children: [], ...(opts.folderTypes !== false ? { folderType: ft } : {}) });
    this.root = { id: '0', title: '', dateAdded: 0, children: [mk('1', b, 'bookmarks-bar'), mk('2', o, 'other'), mk('3', m, 'mobile')] };
    const index = (n: Node) => {
      this.byId.set(n.id, n);
      n.children?.forEach(index);
    };
    index(this.root);
  }

  private snap(n: Node, deep: boolean): chrome.bookmarks.BookmarkTreeNode {
    const p = n.parentId ? this.byId.get(n.parentId) : undefined;
    const out: Record<string, unknown> = { id: n.id, title: n.title, dateAdded: n.dateAdded };
    if (n.parentId) out.parentId = n.parentId;
    if (p) out.index = p.children!.indexOf(n);
    if (n.url !== undefined) out.url = n.url;
    if (n.folderType) out.folderType = n.folderType;
    if (n.syncing !== undefined) out.syncing = n.syncing;
    if (deep && n.children) out.children = n.children.map((c) => this.snap(c, true));
    return out as unknown as chrome.bookmarks.BookmarkTreeNode;
  }

  async getTree() {
    return [this.snap(this.root, true)];
  }
  async get(id: string) {
    const n = this.byId.get(id);
    if (!n) throw new Error(`Can't find bookmark for id.`);
    return [this.snap(n, false)];
  }
  async create(d: { parentId?: string; index?: number; title?: string; url?: string }) {
    const p = this.byId.get(d.parentId ?? '2');
    if (!p || !p.children) throw new Error("Can't find parent bookmark for id.");
    const n: Node = { id: String(this.seq++), parentId: p.id, title: d.title ?? '', dateAdded: Date.now() };
    if (d.url !== undefined) n.url = d.url;
    else n.children = [];
    const idx = d.index === undefined ? p.children.length : Math.min(d.index, p.children.length);
    p.children.splice(idx, 0, n);
    this.byId.set(n.id, n);
    this.onCreated.emit(n.id, this.snap(n, false));
    return this.snap(n, false);
  }
  async update(id: string, ch: { title?: string; url?: string }) {
    const n = this.byId.get(id);
    if (!n) throw new Error("Can't find bookmark for id.");
    if (ch.title !== undefined) n.title = ch.title;
    if (ch.url !== undefined) n.url = ch.url;
    this.onChanged.emit(id, { title: n.title, url: n.url });
    return this.snap(n, false);
  }
  async move(id: string, dest: { parentId?: string; index?: number }) {
    const n = this.byId.get(id);
    if (!n || !n.parentId || n.parentId === '0') throw new Error("Can't modify the root bookmark folders.");
    const newP = this.byId.get(dest.parentId ?? n.parentId)!;
    for (let a: Node | undefined = newP; a; a = a.parentId ? this.byId.get(a.parentId) : undefined) if (a.id === id) throw new Error("Can't move a folder into itself");
    const oldP = this.byId.get(n.parentId)!;
    const oldIndex = oldP.children!.indexOf(n);
    let index = dest.index ?? newP.children!.length;
    // Chrome quirk: in the same folder, the index refers to positions before removal.
    if (oldP === newP && index > oldIndex) index--;
    oldP.children!.splice(oldIndex, 1);
    newP.children!.splice(Math.min(index, newP.children!.length), 0, n);
    n.parentId = newP.id;
    this.onMoved.emit(id, { parentId: newP.id, index, oldParentId: oldP.id, oldIndex });
    return this.snap(n, false);
  }
  async remove(id: string) {
    const n = this.byId.get(id);
    if (!n) throw new Error("Can't find bookmark for id.");
    if (n.children?.length) throw new Error("Can't remove non-empty folder (use recursive to force).");
    return this.removeTree(id);
  }
  async removeTree(id: string) {
    const n = this.byId.get(id);
    if (!n || !n.parentId || n.parentId === '0') throw new Error("Can't modify the root bookmark folders.");
    const p = this.byId.get(n.parentId)!;
    const index = p.children!.indexOf(n);
    p.children!.splice(index, 1);
    const drop = (x: Node) => {
      this.byId.delete(x.id);
      x.children?.forEach(drop);
    };
    drop(n);
    this.onRemoved.emit(id, { parentId: p.id, index, node: this.snap(n, true) });
  }
}

class FakeArea {
  data: Record<string, unknown> = {};
  onChanged = new Evt();
  async get(keys?: string | string[] | null) {
    if (keys == null) return structuredClone(this.data);
    const ks = typeof keys === 'string' ? [keys] : keys;
    const out: Record<string, unknown> = {};
    for (const k of ks) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>) {
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { newValue: v, oldValue: this.data[k] };
      this.data[k] = structuredClone(v);
    }
    this.onChanged.emit(changes);
  }
  async remove(keys: string | string[]) {
    for (const k of typeof keys === 'string' ? [keys] : keys) delete this.data[k];
  }
  async clear() {
    this.data = {};
  }
  async setAccessLevel() {}
}

export function installFakeChrome(opts: ConstructorParameters<typeof FakeBookmarks>[0] = {}) {
  const bookmarks = new FakeBookmarks(opts);
  const local = new FakeArea();
  const session = new FakeArea();
  const fake = {
    bookmarks,
    storage: { local, session, onChanged: new Evt() },
    runtime: { id: 'testextension', getManifest: () => ({ version: '0.0.0' }), onMessage: new Evt(), onStartup: new Evt(), onInstalled: new Evt(), sendMessage: async () => undefined },
    alarms: { create: () => undefined, clear: async () => true, onAlarm: new Evt() },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
    idle: { onStateChanged: new Evt() },
    identity: { getRedirectURL: () => 'https://testextension.chromiumapp.org/', launchWebAuthFlow: async () => undefined },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}
