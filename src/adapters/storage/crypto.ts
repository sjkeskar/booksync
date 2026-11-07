/**
 * End-to-end encryption. Nothing leaves the device unencrypted except meta.json (KDF parameters
 * and a key-check blob — no secrets).
 *
 *   passphrase ──PBKDF2-SHA256(salt, iterations)──► master bits
 *   master ──HKDF("bookmark-sync/enc/v1")──► AES-256-GCM key (non-extractable)
 *
 * Blob format: [1 byte version=1][12 byte random IV][ciphertext+tag]
 * AAD binds each blob to its purpose/path (e.g. "device:ab12…"), so files can't be swapped.
 */
export const KDF_ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const CHECK_PLAINTEXT = 'bookmark-sync key check v1';

export interface KdfParams {
  name: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // base64
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function newKdfParams(iterations = KDF_ITERATIONS): KdfParams {
  return { name: 'PBKDF2-SHA256', iterations, salt: b64(randomBytes(16)) };
}

export async function deriveKey(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  if (kdf.name !== 'PBKDF2-SHA256' || kdf.iterations < 100_000) throw new Error('Unsupported or weak KDF parameters');
  const pw = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(kdf.salt), iterations: kdf.iterations }, pw, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('bookmark-sync/enc/v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

export class DecryptError extends Error {}

export async function decrypt(key: CryptoKey, blob: Uint8Array<ArrayBuffer>, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length < 13 + 16 || blob[0] !== 1) throw new DecryptError('Unrecognized encrypted blob');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(1, 13), additionalData: enc.encode(aad) }, key, blob.subarray(13));
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError('Decryption failed (wrong passphrase or tampered file)');
  }
}

export async function makeKeyCheck(key: CryptoKey): Promise<string> {
  return b64(await encrypt(key, enc.encode(CHECK_PLAINTEXT), 'meta:check'));
}

export async function verifyKeyCheck(key: CryptoKey, check: string): Promise<boolean> {
  try {
    return dec.decode(await decrypt(key, unb64(check), 'meta:check')) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

// ----- passphrase helper -----
const WORDS =
  'acorn amber anchor apple arrow aspen atlas autumn badge bamboo banjo barley basil beacon berry birch biscuit blossom bramble breeze brick bridge bronze brook butter cabin cactus candle canyon cargo carrot castle cedar cello chalk cherry cider cinder citrus clover cobalt comet copper coral cotton crater cricket crystal cypress daisy dawn delta denim desert dolphin dragon drift dune eagle ember emerald falcon feather fern fiddle flint forest fossil fountain fox galaxy garden garnet geyser ginger glacier granite grape gravel harbor harvest hazel heron hickory honey horizon iris island ivory jade jasmine juniper kayak kettle kiwi lagoon lantern lava lemon lilac linen lotus lunar maple marble meadow melon meteor mint mirror mosaic moss nectar needle nickel nutmeg oasis ocean olive onyx orbit orchid otter paddle palm pebble pepper pine planet plum pollen poppy prairie quartz quill rabbit radish raven reef ribbon river robin rocket saffron sage salmon sapphire satin scarlet sequoia shadow shell silver slate sparrow spruce stone summit sunset swan thistle thunder timber topaz tulip tundra velvet violet walnut willow winter wren yarrow zephyr';

/** Six random words from a 192-word list ≈ 45 bits; combined with 600k PBKDF2 rounds. */
export function generatePassphrase(words = 6): string {
  const list = WORDS.split(' ');
  const out: string[] = [];
  const rnd = new Uint32Array(words);
  crypto.getRandomValues(rnd);
  for (const r of rnd) out.push(list[r % list.length]!);
  return out.join('-');
}
