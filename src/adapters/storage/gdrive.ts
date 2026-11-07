import { AuthError, RetryableError, type RemoteFile, type Revision, type StorageBackend } from './backend';
import type { GoogleAuth } from './googleAuth';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,size,modifiedTime,version';

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime: string;
  version: string;
}

const toRemote = (f: DriveFile): RemoteFile => ({ id: f.id, name: f.name, size: Number(f.size ?? 0), modified: Date.parse(f.modifiedTime), version: f.version });

/** Google Drive appDataFolder: a hidden per-app folder only this OAuth client can see. */
export class DriveBackend implements StorageBackend {
  constructor(private readonly auth: GoogleAuth) {}

  private async req(url: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
    const token = await this.auth.getToken(false);
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    } catch (e) {
      throw new RetryableError(`Network error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.ok) return res;
    if (res.status === 401) {
      await this.auth.invalidate();
      if (retryAuth) return this.req(url, init, false);
      throw new AuthError('Google sign-in expired');
    }
    const body = await res.text().catch(() => '');
    const retryAfter = Number(res.headers.get('retry-after') ?? '0') * 1000;
    if (res.status === 429 || res.status >= 500 || (res.status === 403 && /rate ?limit/i.test(body))) {
      throw new RetryableError(`Google Drive busy (${res.status})`, retryAfter);
    }
    let msg = body;
    try {
      msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
    } catch {
      /* not json */
    }
    const err = new Error(`Google Drive error ${res.status}: ${msg.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  async list(): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    let pageToken = '';
    do {
      const p = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: `nextPageToken,files(${FILE_FIELDS})` });
      if (pageToken) p.set('pageToken', pageToken);
      const r = (await (await this.req(`${API}/files?${p}`)).json()) as { files: DriveFile[]; nextPageToken?: string };
      out.push(...r.files.map(toRemote));
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  async read(id: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await (await this.req(`${API}/files/${encodeURIComponent(id)}?alt=media`)).arrayBuffer());
  }

  async write(name: string, data: Uint8Array<ArrayBuffer>, existingId?: string): Promise<RemoteFile> {
    if (existingId) {
      const r = await this.req(`${UPLOAD}/files/${encodeURIComponent(existingId)}?uploadType=media&fields=${FILE_FIELDS}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data,
      });
      return toRemote((await r.json()) as DriveFile);
    }
    const boundary = `bsync${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
    const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      data,
      `\r\n--${boundary}--`,
    ]);
    const r = await this.req(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return toRemote((await r.json()) as DriveFile);
  }

  async remove(id: string): Promise<void> {
    try {
      await this.req(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }

  async listRevisions(id: string): Promise<Revision[]> {
    const r = (await (await this.req(`${API}/files/${encodeURIComponent(id)}/revisions?fields=revisions(id,modifiedTime,size)&pageSize=1000`)).json()) as {
      revisions?: { id: string; modifiedTime: string; size?: string }[];
    };
    return (r.revisions ?? []).map((x) => ({ id: x.id, modified: Date.parse(x.modifiedTime), size: Number(x.size ?? 0) }));
  }

  async deleteRevision(fileId: string, revisionId: string): Promise<void> {
    try {
      await this.req(`${API}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, { method: 'DELETE' });
    } catch (e) {
      const s = (e as { status?: number }).status;
      if (s !== 404 && s !== 400 && s !== 403) throw e; // head/only revision can't be deleted
    }
  }

  async about(): Promise<{ email: string; name: string }> {
    const r = (await (await this.req(`${API}/about?fields=user(emailAddress,displayName)`)).json()) as { user: { emailAddress: string; displayName: string } };
    return { email: r.user.emailAddress, name: r.user.displayName };
  }
}
