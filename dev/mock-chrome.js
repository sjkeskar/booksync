// Mock of the extension background for UI previews. ?state=... picks a scenario.
const scenario = new URLSearchParams(location.search).get('state') || 'idle';
const now = Date.now();
const base = { phase: 'idle', message: 'Up to date', lastSync: now - 120000, lastError: '', pendingDeletes: null, pendingRisky: [], join: null, warnings: [], bookmarkCount: 1342, deviceCount: 3 };
const statuses = {
  idle: base,
  approval: { ...base, phase: 'needs-approval', message: 'Waiting for approval: 42 bookmarks would be deleted', pendingDeletes: { count: 42, total: 1342 }, pendingRisky: [{ id: 'x', title: 'Dark mode toggle', url: 'javascript:(function(){document.body.style.filter="invert(1)"})()' }] },
  join: { ...base, phase: 'needs-join', message: 'Choose how to combine', join: { localCount: 213, remoteCount: 1342 } },
  new: { ...base, phase: 'not-configured', message: 'Set up sync in Options', deviceCount: 0, bookmarkCount: 0, lastSync: 0 },
};
const info = () => ({ status: statuses[scenario] || base, email: scenario === 'new' ? '' : 'family@example.com', clientConfigured: true, version: '0.1.0', build: 'preview', extensionId: 'kmagjjkcpodbjmkdegfmoeemgkaclgdd', redirectUri: 'https://kmagjjkcpodbjmkdegfmoeemgkaclgdd.chromiumapp.org/', unlocked: scenario !== 'new' });
const responses = {
  status: info,
  remoteExists: () => false,
  generatePassphrase: () => 'cedar-lantern-otter-quartz-meadow-ember',
  devices: () => [
    { id: 'a', self: true, name: 'Living-room PC', browser: 'Chrome on Windows', lastSync: now - 120000, size: 182000 },
    { id: 'b', self: false, name: 'Laptop', browser: 'Edge on Windows', lastSync: now - 3600000 * 5, size: 179000 },
    { id: 'c', self: false, name: 'Old desktop', browser: 'Brave on Linux', lastSync: now - 86400000 * 75, size: 120000 },
  ],
  snapshots: () => ['2026-11-07', '2026-11-06', '2026-11-05', '2026-10-27'],
  folders: () => [{ id: 'f1', path: 'Bookmarks bar / Work' }, { id: 'f2', path: 'Other bookmarks / Recipes' }],
  getSettings: () => ({ deviceName: 'Living-room PC', intervalMin: 5, treePref: 'auto', maxDeletes: 20, maxDeleteFraction: 0.1, budgetMB: 50 }),
  storageUsage: () => ({ devices: 540000, snapshots: 4200000, other: 900, fileCount: 21, snapshotCount: 17, budget: 50 * 1024 * 1024 }),
  logs: () => [{ t: now - 60000, level: 'info', msg: 'Applied 3 change(s) to this browser' }, { t: now - 3600000, level: 'warn', msg: 'Paused: sync would delete 42 of 1342 bookmarks' }],
};
window.chrome = {
  runtime: { id: 'mock', sendMessage: async (m) => ({ ok: true, data: (responses[m.type] || (() => null))() }), getURL: (p) => p },
  storage: { onChanged: { addListener() {} } },
  tabs: { create() {} },
};
