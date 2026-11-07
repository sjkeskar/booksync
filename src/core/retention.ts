export const DAY = 24 * 60 * 60 * 1000;
export const TOMBSTONE_MAX_AGE = 90 * DAY;
/** A device not seen for this long is ignored in merges and must rejoin. */
export const STALE_DEVICE_AGE = 60 * DAY;
/** A device file not updated for this long is deleted by housekeeping. */
export const DELETE_DEVICE_AGE = 180 * DAY;
export const HEARTBEAT_INTERVAL = DAY;

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}
export const DEFAULT_RETENTION: RetentionPolicy = { daily: 14, weekly: 8, monthly: 12 };

const toDay = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Monday-based week number since epoch. */
const weekOf = (dayMs: number) => Math.floor((dayMs / DAY + 3) / 7);
const monthOf = (s: string) => +s.slice(0, 4) * 12 + (+s.slice(5, 7) - 1);

/** Grandfather-father-son: which snapshot dates (YYYY-MM-DD) to keep. */
export function snapshotsToKeep(dates: string[], today: string, p: RetentionPolicy = DEFAULT_RETENTION): Set<string> {
  const keep = new Set<string>();
  const t = toDay(today);
  const sorted = [...new Set(dates)].sort().reverse(); // newest first
  for (const d of sorted) if ((t - toDay(d)) / DAY < p.daily && toDay(d) <= t) keep.add(d);
  const weekSeen = new Set<number>();
  for (const d of sorted) {
    const w = weekOf(toDay(d));
    if (weekOf(t) - w < p.weekly && !weekSeen.has(w)) {
      weekSeen.add(w);
      keep.add(d);
    }
  }
  const monthSeen = new Set<number>();
  for (const d of sorted) {
    const m = monthOf(d);
    if (monthOf(today) - m < p.monthly && !monthSeen.has(m)) {
      monthSeen.add(m);
      keep.add(d);
    }
  }
  return keep;
}

export interface SizedFile {
  name: string;
  size: number;
  /** sortable age key, oldest smallest */
  date: string;
}

/** Snapshots to delete (oldest first) so the total fits the budget, keeping at least minKeep. */
export function pruneForBudget(snapshots: SizedFile[], otherBytes: number, budget: number, minKeep = 7): string[] {
  const sorted = [...snapshots].sort((a, b) => (a.date < b.date ? -1 : 1));
  let total = otherBytes + sorted.reduce((s, f) => s + f.size, 0);
  const del: string[] = [];
  while (total > budget && sorted.length - del.length > minKeep) {
    const f = sorted[del.length]!;
    del.push(f.name);
    total -= f.size;
  }
  return del;
}
