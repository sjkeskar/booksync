import { decrypt, encrypt } from './crypto';

const MAX_PLAIN = 64 * 1024 * 1024; // refuse to inflate beyond 64 MB (decompression bombs)

async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([data]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error('File too large after decompression');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export const gzip = (d: Uint8Array<ArrayBuffer>) => pipe(d, new CompressionStream('gzip'));
export const gunzip = (d: Uint8Array<ArrayBuffer>) => pipe(d, new DecompressionStream('gzip'), MAX_PLAIN);

/** JSON → gzip → AES-GCM (AAD binds it to `aad`). */
export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  return encrypt(key, await gzip(new TextEncoder().encode(JSON.stringify(value))), aad);
}

export async function openJson(key: CryptoKey, blob: Uint8Array<ArrayBuffer>, aad: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await gunzip(await decrypt(key, blob, aad))));
}

export async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}
