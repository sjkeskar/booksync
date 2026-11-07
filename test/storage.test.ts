import { describe, expect, it } from 'vitest';
import { FILES, MemoryBackend, newestByName } from '../src/adapters/storage/backend';
import { gzip, openJson, sealJson } from '../src/adapters/storage/codec';
import { decrypt, deriveKey, encrypt, generatePassphrase, makeKeyCheck, newKdfParams, verifyKeyCheck } from '../src/adapters/storage/crypto';

const fastKdf = () => newKdfParams(100_000);

describe('crypto', () => {
  it('round-trips with the right key + AAD and rejects anything else', async () => {
    const kdf = fastKdf();
    const key = await deriveKey('correct horse', kdf);
    expect(key.extractable).toBe(false);
    const blob = await sealJson(key, { hello: 'wörld' }, 'device:abc');
    expect(await openJson(key, blob, 'device:abc')).toEqual({ hello: 'wörld' });
    await expect(openJson(key, blob, 'device:xyz')).rejects.toThrow(/Decryption failed/); // swapped file
    const wrong = await deriveKey('wrong horse', kdf);
    await expect(openJson(wrong, blob, 'device:abc')).rejects.toThrow(/Decryption failed/);
    const tampered = blob.slice();
    tampered[tampered.length - 1]! ^= 1;
    await expect(openJson(key, tampered, 'device:abc')).rejects.toThrow(/Decryption failed/);
  });

  it('same passphrase + salt derives the same key; different salt does not', async () => {
    const kdf = fastKdf();
    const a = await deriveKey('pw', kdf);
    const b = await deriveKey('pw', kdf);
    const c = await deriveKey('pw', fastKdf());
    const blob = await encrypt(a, new TextEncoder().encode('x'), 'aad');
    expect(new TextDecoder().decode(await decrypt(b, blob, 'aad'))).toBe('x');
    await expect(decrypt(c, blob, 'aad')).rejects.toThrow();
  });

  it('key check detects a wrong passphrase', async () => {
    const kdf = fastKdf();
    const check = await makeKeyCheck(await deriveKey('pw', kdf));
    expect(await verifyKeyCheck(await deriveKey('pw', kdf), check)).toBe(true);
    expect(await verifyKeyCheck(await deriveKey('nope', kdf), check)).toBe(false);
  });

  it('refuses weak KDF parameters from a tampered meta.json', async () => {
    await expect(deriveKey('pw', { name: 'PBKDF2-SHA256', iterations: 10, salt: 'AAAA' })).rejects.toThrow(/weak/);
  });

  it('generated passphrases are 6 distinct-ish words', () => {
    const p = generatePassphrase();
    expect(p.split('-')).toHaveLength(6);
    expect(generatePassphrase()).not.toBe(p);
  });

  it('refuses decompression bombs', async () => {
    const key = await deriveKey('pw', fastKdf());
    const big = await gzip(new Uint8Array(70 * 1024 * 1024));
    const { encrypt: enc } = await import('../src/adapters/storage/crypto');
    const blob = await enc(key, big, 'x');
    await expect(openJson(key, blob, 'x')).rejects.toThrow(/too large/);
  });
});

describe('backend helpers', () => {
  it('names and duplicate resolution', async () => {
    expect(FILES.isDevice(FILES.device('ab12'))).toBe(true);
    expect(FILES.deviceIdOf('device-ab12.bin')).toBe('ab12');
    expect(FILES.isSnapshot('snapshot-2026-11-07.bin')).toBe(true);
    expect(FILES.isDevice('device-../x.bin')).toBe(false);
    const m = new MemoryBackend();
    let t = 0;
    m.now = () => ++t;
    await m.write('a', new Uint8Array([1]));
    const b = await m.write('a', new Uint8Array([2]));
    expect(newestByName(await m.list()).get('a')!.id).toBe(b.id);
  });
});
