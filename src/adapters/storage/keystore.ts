/**
 * Persists the derived AES key as a non-extractable CryptoKey in the extension's IndexedDB.
 * The extension can use it to encrypt/decrypt, but its raw bytes can never be read back — and
 * the passphrase itself is never stored.
 */
export interface KeyStore {
  load(): Promise<{ key: CryptoKey; epoch: number } | null>;
  save(key: CryptoKey, epoch: number): Promise<void>;
  clear(): Promise<void>;
}

const DB = 'bookmark-sync';
const STORE = 'keys';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}

export const idbKeyStore: KeyStore = {
  async load() {
    const v = (await tx('readonly', (s) => s.get('enc'))) as { key: CryptoKey; epoch: number } | undefined;
    return v ?? null;
  },
  async save(key, epoch) {
    if (key.extractable) throw new Error('refusing to store an extractable key');
    await tx('readwrite', (s) => s.put({ key, epoch }, 'enc'));
  },
  async clear() {
    await tx('readwrite', (s) => s.delete('enc'));
  },
};

export class MemoryKeyStore implements KeyStore {
  v: { key: CryptoKey; epoch: number } | null = null;
  async load() {
    return this.v;
  }
  async save(key: CryptoKey, epoch: number) {
    this.v = { key, epoch };
  }
  async clear() {
    this.v = null;
  }
}
