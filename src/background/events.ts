/**
 * Bookmark change tracking.
 *  - Records the wall time of each user change (so concurrent edits resolve by when they were
 *    really made, not when the PC happened to sync).
 *  - While the extension itself applies a sync plan, events are collected separately so they are
 *    not mistaken for user edits.
 *  - Pauses syncing during a bookmark import.
 */
const KEY = 'eventTimes';
let times: Record<string, number> = {};
let loaded: Promise<void> | null = null;
let applying = 0;
const duringApply = new Set<string>();
let importing = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function load(): Promise<void> {
  loaded ??= chrome.storage.local.get(KEY).then((r) => {
    times = { ...((r[KEY] as Record<string, number>) ?? {}), ...times };
  });
  return loaded;
}

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void chrome.storage.local.set({ [KEY]: times }), 200);
}

function record(localId: string, onUserChange: () => void) {
  if (applying) {
    duringApply.add(localId);
    return;
  }
  times[localId] = Date.now();
  persistSoon();
  if (!importing) onUserChange();
}

export function installBookmarkListeners(onUserChange: () => void): void {
  void load();
  const bm = chrome.bookmarks;
  bm.onCreated.addListener((id) => record(id, onUserChange));
  bm.onRemoved.addListener((id) => record(id, onUserChange));
  bm.onChanged.addListener((id) => record(id, onUserChange));
  bm.onMoved.addListener((id) => record(id, onUserChange));
  bm.onChildrenReordered.addListener((id) => record(id, onUserChange));
  bm.onImportBegan?.addListener(() => {
    importing = true;
  });
  bm.onImportEnded?.addListener(() => {
    importing = false;
    onUserChange();
  });
}

export function isImporting(): boolean {
  return importing;
}

/** Snapshot of recorded local id → change time. */
export async function takeEventTimes(): Promise<Record<string, number>> {
  await load();
  return { ...times };
}

/** Forget the events consumed by a successful sync (newer ones for the same id are kept). */
export async function clearEventTimes(consumed: Record<string, number>): Promise<void> {
  await load();
  for (const [id, t] of Object.entries(consumed)) if (times[id] === t) delete times[id];
  await chrome.storage.local.set({ [KEY]: times });
}

export function beginApply(): void {
  if (applying++ === 0) duringApply.clear();
}

/** Local ids that changed while the plan was being applied. */
export function endApply(): Set<string> {
  applying = Math.max(0, applying - 1);
  return new Set(duringApply);
}
