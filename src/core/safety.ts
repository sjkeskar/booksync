import type { TNode } from './model';
import { isRiskyUrl } from './urlNorm';

export interface SafetyConfig {
  /** Ask before a sync deletes more than this many bookmarks from this browser... */
  maxDeletes: number;
  /** ...or more than this fraction of them (only for trees with at least 50 bookmarks). */
  maxDeleteFraction: number;
}

export const DEFAULT_SAFETY: SafetyConfig = { maxDeletes: 20, maxDeleteFraction: 0.1 };

export function needsDeleteApproval(removed: number, totalLocal: number, cfg: SafetyConfig = DEFAULT_SAFETY): boolean {
  if (removed > cfg.maxDeletes) return true;
  return totalLocal >= 50 && removed / totalLocal > cfg.maxDeleteFraction;
}

/**
 * A synced bookmark whose URL can run code (javascript:, data:, vbscript:) is held until the user
 * approves that exact URL — unless this browser already has it with the same URL.
 */
export function makeHoldPredicate(approved: Record<string, string>) {
  return (t: TNode, l: TNode | undefined): boolean => {
    if (!isRiskyUrl(t.url)) return false;
    if (l && l.url === t.url) return false;
    return approved[t.id] !== t.url;
  };
}
