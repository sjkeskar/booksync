import type { SyncNode, SyncState } from './model';

export const DEVICE_FILE_SCHEMA = 1;

export interface DeviceFile {
  schema: 1;
  deviceId: string;
  deviceName: string;
  browser: string;
  /** Random per install; a mismatch on our own file means another machine shares our id. */
  incarnation: string;
  writeSeq: number;
  /** Wall time of the last upload (heartbeat for staleness). */
  lastSync: number;
  extVersion: string;
  nodes: SyncNode[];
}

export function stateToNodes(s: SyncState): SyncNode[] {
  return Object.keys(s)
    .sort()
    .map((k) => s[k]!);
}

export function nodesToState(nodes: SyncNode[]): SyncState {
  const s: SyncState = {};
  for (const n of nodes) s[n.id] = n;
  return s;
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isLww = (x: unknown, check: (v: unknown) => boolean) =>
  !!x && typeof x === 'object' && isStr((x as { t: unknown }).t) && check((x as { v: unknown }).v);

function validNode(n: unknown): n is SyncNode {
  if (!n || typeof n !== 'object') return false;
  const o = n as Record<string, unknown>;
  if (!isStr(o.id) || o.id.length > 64) return false;
  if (o.kind !== 'bookmark' && o.kind !== 'folder') return false;
  if (typeof o.added !== 'number') return false;
  if (!isLww(o.title, (v) => isStr(v) && v.length <= 4096)) return false;
  if (!isLww(o.del, (v) => typeof v === 'boolean')) return false;
  if (!isLww(o.place, (v) => !!v && typeof v === 'object' && isStr((v as { parent: unknown }).parent) && isStr((v as { pos: unknown }).pos)))
    return false;
  if (o.kind === 'bookmark' && !isLww(o.url, (v) => isStr(v) && v.length <= 65536)) return false;
  return true;
}

/** Defensive structural validation of a decrypted device file. Throws on anything unexpected. */
export function validateDeviceFile(x: unknown): DeviceFile {
  if (!x || typeof x !== 'object') throw new Error('device file: not an object');
  const o = x as Record<string, unknown>;
  if (o.schema !== DEVICE_FILE_SCHEMA) throw new Error(`device file: unsupported schema ${String(o.schema)}`);
  for (const k of ['deviceId', 'deviceName', 'browser', 'incarnation', 'extVersion']) if (!isStr(o[k])) throw new Error(`device file: bad ${k}`);
  if (typeof o.writeSeq !== 'number' || typeof o.lastSync !== 'number') throw new Error('device file: bad counters');
  if (!Array.isArray(o.nodes)) throw new Error('device file: nodes missing');
  for (const n of o.nodes) if (!validNode(n)) throw new Error('device file: invalid node');
  return o as unknown as DeviceFile;
}
