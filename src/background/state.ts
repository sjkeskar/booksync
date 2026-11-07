import type { TreePreference } from '../adapters/browser/bookmarks';
import type { HLC } from '../core/hlc';
import type { SyncNode, TNode } from '../core/model';
import { DEFAULT_SAFETY } from '../core/safety';

export interface Settings {
  deviceName: string;
  intervalMin: number;
  treePref: TreePreference;
  maxDeletes: number;
  maxDeleteFraction: number;
  budgetMB: number;
}

export const DEFAULT_SETTINGS: Settings = {
  deviceName: '',
  intervalMin: 5,
  treePref: 'auto',
  maxDeletes: DEFAULT_SAFETY.maxDeletes,
  maxDeleteFraction: DEFAULT_SAFETY.maxDeleteFraction,
  budgetMB: 50,
};

export interface PeerCacheEntry {
  version: string;
  lastSync: number;
  deviceName: string;
  browser: string;
  extVersion: string;
  nodes: SyncNode[];
}

/** Everything the extension persists in chrome.storage.local (besides settings/status/logs). */
export interface LocalState {
  deviceId: string;
  incarnation: string;
  writeSeq: number;
  clock: HLC;
  base: TNode[] | null;
  baseRoots: string[];
  known: SyncNode[];
  ids: [string, string][];
  lastSync: number;
  everPushed: boolean;
  lastPushedHash: string;
  lastPushedVersion: string;
  lastPushAt: number;
  approvedRisky: Record<string, string>;
  journal: { applying: boolean; at: number } | null;
  peerCache: Record<string, PeerCacheEntry>;
  lastHousekeeping: number;
  joinBackup: TNode[] | null;
}

export type Phase =
  | 'not-configured'
  | 'signin-required'
  | 'locked'
  | 'needs-join'
  | 'idle'
  | 'syncing'
  | 'needs-approval'
  | 'offline'
  | 'error';

export interface PendingRisky {
  id: string;
  title: string;
  url: string;
}

export interface Status {
  phase: Phase;
  message: string;
  lastSync: number;
  lastAttempt: number;
  lastError: string;
  pendingDeletes: { count: number; total: number } | null;
  pendingRisky: PendingRisky[];
  join: { localCount: number; remoteCount: number } | null;
  warnings: string[];
  bookmarkCount: number;
  deviceCount: number;
  email: string;
}

export const EMPTY_STATUS: Status = {
  phase: 'not-configured',
  message: 'Not set up yet',
  lastSync: 0,
  lastAttempt: 0,
  lastError: '',
  pendingDeletes: null,
  pendingRisky: [],
  join: null,
  warnings: [],
  bookmarkCount: 0,
  deviceCount: 0,
  email: '',
};

export function randomId(len = 10): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = crypto.getRandomValues(new Uint8Array(len));
  return [...r].map((x) => a[x % 36]).join('');
}

export function freshLocalState(): LocalState {
  return {
    deviceId: randomId(10),
    incarnation: randomId(16),
    writeSeq: 0,
    clock: '',
    base: null,
    baseRoots: [],
    known: [],
    ids: [],
    lastSync: 0,
    everPushed: false,
    lastPushedHash: '',
    lastPushedVersion: '',
    lastPushAt: 0,
    approvedRisky: {},
    journal: null,
    peerCache: {},
    lastHousekeeping: 0,
    joinBackup: null,
  };
}

const K = { state: 'syncState', settings: 'settings', status: 'status', logs: 'logs' } as const;

export async function loadState(): Promise<LocalState> {
  const r = await chrome.storage.local.get(K.state);
  return { ...freshLocalState(), ...((r[K.state] as Partial<LocalState>) ?? {}) };
}

export async function saveState(s: LocalState): Promise<void> {
  await chrome.storage.local.set({ [K.state]: s });
}

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(K.settings);
  return { ...DEFAULT_SETTINGS, ...((r[K.settings] as Partial<Settings>) ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [K.settings]: s });
}

export async function loadStatus(): Promise<Status> {
  const r = await chrome.storage.local.get(K.status);
  return { ...EMPTY_STATUS, ...((r[K.status] as Partial<Status>) ?? {}) };
}

export async function saveStatus(s: Status): Promise<void> {
  await chrome.storage.local.set({ [K.status]: s });
}

// ---- logs: counts and ids only — never URLs or titles ----
export interface LogEntry {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}
const MAX_LOGS = 500;
let logQueue: Promise<void> = Promise.resolve();

export function log(level: LogEntry['level'], msg: string): Promise<void> {
  logQueue = logQueue.then(async () => {
    const r = await chrome.storage.local.get(K.logs);
    const logs = ((r[K.logs] as LogEntry[]) ?? []).concat({ t: Date.now(), level, msg });
    await chrome.storage.local.set({ [K.logs]: logs.slice(-MAX_LOGS) });
  });
  return logQueue;
}

export async function loadLogs(): Promise<LogEntry[]> {
  return ((await chrome.storage.local.get(K.logs))[K.logs] as LogEntry[]) ?? [];
}
