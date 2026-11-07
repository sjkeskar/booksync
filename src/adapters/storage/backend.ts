export interface RemoteFile {
  id: string;
  name: string;
  size: number;
  /** ms since epoch */
  modified: number;
  /** changes on every content update */
  version: string;
}

export interface Revision {
  id: string;
  modified: number;
  size: number;
}

/** Minimal flat file store. Names are not unique (Drive allows duplicates); ids are. */
export interface StorageBackend {
  list(): Promise<RemoteFile[]>;
  read(id: string): Promise<Uint8Array<ArrayBuffer>>;
  /** Create a new file, or replace the content of `existingId`. */
  write(name: string, data: Uint8Array<ArrayBuffer>, existingId?: string): Promise<RemoteFile>;
  remove(id: string): Promise<void>;
  listRevisions(id: string): Promise<Revision[]>;
  deleteRevision(fileId: string, revisionId: string): Promise<void>;
}

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

export class AuthError extends Error {}

/** Remote naming scheme (flat). */
export const FILES = {
  meta: 'meta.json',
  lease: 'housekeeping.json',
  device: (id: string) => `device-${id}.bin`,
  snapshot: (date: string) => `snapshot-${date}.bin`,
  isDevice: (n: string) => /^device-[a-z0-9]{1,32}\.bin$/.test(n),
  isSnapshot: (n: string) => /^snapshot-\d{4}-\d{2}-\d{2}\.bin$/.test(n),
  deviceIdOf: (n: string) => n.slice(7, -4),
  snapshotDateOf: (n: string) => n.slice(9, -4),
};

/** Newest file per name; Drive can hold several files with the same name after a race. */
export function newestByName(files: RemoteFile[]): Map<string, RemoteFile> {
  const m = new Map<string, RemoteFile>();
  for (const f of files) {
    const cur = m.get(f.name);
    if (!cur || f.modified > cur.modified || (f.modified === cur.modified && f.id > cur.id)) m.set(f.name, f);
  }
  return m;
}

export class MemoryBackend implements StorageBackend {
  files = new Map<string, { meta: RemoteFile; data: Uint8Array<ArrayBuffer>; revs: Revision[] }>();
  private seq = 1;
  now = () => Date.now();
  failNext = 0;

  private maybeFail() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new RetryableError('simulated network failure');
    }
  }
  async list() {
    this.maybeFail();
    return [...this.files.values()].map((f) => ({ ...f.meta }));
  }
  async read(id: string) {
    this.maybeFail();
    const f = this.files.get(id);
    if (!f) throw new Error('not found');
    return f.data.slice();
  }
  async write(name: string, data: Uint8Array<ArrayBuffer>, existingId?: string) {
    this.maybeFail();
    const now = this.now();
    if (existingId && this.files.has(existingId)) {
      const f = this.files.get(existingId)!;
      f.data = data.slice();
      f.meta = { ...f.meta, size: data.length, modified: now, version: String(this.seq++) };
      f.revs.push({ id: `r${this.seq++}`, modified: now, size: data.length });
      return { ...f.meta };
    }
    const id = `f${this.seq++}`;
    const meta = { id, name, size: data.length, modified: now, version: String(this.seq++) };
    this.files.set(id, { meta, data: data.slice(), revs: [{ id: `r${this.seq++}`, modified: now, size: data.length }] });
    return { ...meta };
  }
  async remove(id: string) {
    this.maybeFail();
    this.files.delete(id);
  }
  async listRevisions(id: string) {
    return [...(this.files.get(id)?.revs ?? [])];
  }
  async deleteRevision(fileId: string, revId: string) {
    const f = this.files.get(fileId);
    if (!f) return;
    if (f.revs.length <= 1) throw new Error('cannot delete the only revision');
    if (f.revs.at(-1)!.id === revId) throw new Error('cannot delete head revision');
    f.revs = f.revs.filter((r) => r.id !== revId);
    f.meta = { ...f.meta, version: String(this.seq++) }; // Drive may bump version on metadata changes
  }
}
