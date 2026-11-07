/**
 * Hybrid logical clock encoded as a fixed-width, lexicographically sortable string:
 *   ms (9 chars base36) + counter (4 chars base36) + deviceId
 * String comparison == causal/temporal comparison, with deviceId as the final tie-breaker.
 * The empty string is the minimum HLC.
 */
export type HLC = string;

const MS_W = 9;
const C_W = 4;

export const ZERO_HLC: HLC = '';

export function fmtHlc(ms: number, c: number, dev: string): HLC {
  return Math.max(0, Math.floor(ms)).toString(36).padStart(MS_W, '0') + c.toString(36).padStart(C_W, '0') + dev;
}

export function parseHlc(h: HLC): { ms: number; c: number; dev: string } {
  if (!h) return { ms: 0, c: 0, dev: '' };
  return {
    ms: parseInt(h.slice(0, MS_W), 36),
    c: parseInt(h.slice(MS_W, MS_W + C_W), 36),
    dev: h.slice(MS_W + C_W),
  };
}

export function hlcMs(h: HLC): number {
  return h ? parseInt(h.slice(0, MS_W), 36) : 0;
}

export function maxHlc(a: HLC, b: HLC): HLC {
  return a > b ? a : b;
}

/** Smallest HLC strictly greater than `h` keeping its wall time (used for deterministic repairs). */
export function bumpHlc(h: HLC, dev?: string): HLC {
  const p = parseHlc(h);
  return fmtHlc(p.ms, p.c + 1, dev ?? p.dev);
}

export class Clock {
  private last: HLC;
  constructor(
    readonly dev: string,
    last: HLC = ZERO_HLC,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.last = last;
  }

  /**
   * Issue a timestamp for a local change.
   * @param eventMs wall time the user actually made the change (from bookmark events), if known.
   * @param floor   the newest timestamp this device had already seen for the item; the result is
   *                always greater, so a change made after seeing a value always supersedes it.
   */
  stamp(eventMs?: number, floor: HLC = ZERO_HLC): HLC {
    const l = parseHlc(this.last);
    let h: HLC;
    if (eventMs === undefined) {
      const ms = Math.max(this.now(), l.ms);
      h = fmtHlc(ms, ms === l.ms ? l.c + 1 : 0, this.dev);
    } else {
      h = fmtHlc(eventMs, 0, this.dev);
    }
    if (h <= floor) {
      const f = parseHlc(floor);
      h = fmtHlc(f.ms, f.c + 1, this.dev);
    }
    if (h > this.last) this.last = h;
    return h;
  }

  get state(): HLC {
    return this.last;
  }
}
