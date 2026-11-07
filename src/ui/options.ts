import { act, ago, api, bytes, clear, download, h, onStatusChange, phasePill, toast, type StatusInfo } from './common';

const main = document.getElementById('main')!;
const tabs = [...document.querySelectorAll<HTMLButtonElement>('nav.tabs button')];
type Tab = 'overview' | 'setup' | 'devices' | 'export' | 'settings' | 'security' | 'log';
let current: Tab = 'overview';

function select(tab: Tab) {
  current = tab;
  for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  void render();
}
for (const b of tabs) b.onclick = () => select(b.dataset.tab as Tab);

const card = (...c: (Node | string | null | false)[]) => h('section', { class: 'card stack' }, ...c);

async function render() {
  let info: StatusInfo;
  try {
    info = await api<StatusInfo>({ type: 'status' });
  } catch (e) {
    clear(main, card(h('p', {}, e instanceof Error ? e.message : String(e))));
    return;
  }
  const views: Record<Tab, (i: StatusInfo) => Promise<Node[]>> = { overview, setup, devices, export: exportView, settings, security, log: logView };
  try {
    clear(main, ...(await views[current](info)));
  } catch (e) {
    clear(main, card(h('h2', {}, 'Something went wrong'), h('p', { class: 'break' }, e instanceof Error ? e.message : String(e))));
  }
}

// ----------------------------------------------------------------------------- overview
async function overview(i: StatusInfo): Promise<Node[]> {
  const s = i.status;
  const sync = h('button', { class: 'primary' }, 'Sync now');
  sync.onclick = () => act(sync, () => api({ type: 'syncNow' }));
  const out: Node[] = [
    card(
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Status'), phasePill(s.phase)),
      h('p', { class: 'break' }, s.message),
      h('p', { class: 'muted' }, `Last synced ${ago(s.lastSync)} · ${s.deviceCount} device(s) · ${s.bookmarkCount.toLocaleString()} bookmarks`),
      i.email ? h('p', { class: 'muted small' }, `Google account: ${i.email}`) : null,
      s.lastError && s.phase !== 'idle' ? h('div', { class: 'callout danger small break' }, s.lastError) : null,
      ...s.warnings.map((w) => h('div', { class: 'callout small' }, w)),
      h('div', { class: 'row' }, sync, ['not-configured', 'needs-join', 'locked', 'signin-required'].includes(s.phase) ? h('button', { onclick: () => select('setup') }, 'Go to setup') : null),
    ),
  ];
  if (s.pendingDeletes) {
    const d = s.pendingDeletes;
    const keep = h('button', { class: 'primary' }, 'Keep them (restore everywhere)');
    const allow = h('button', { class: 'danger' }, `Delete ${d.count} bookmarks here too`);
    keep.onclick = () => act(keep, () => api({ type: 'keepMine' }), 'Kept and re-shared');
    allow.onclick = () => act(allow, () => api({ type: 'approveDeletes' }), 'Deleted');
    out.push(
      card(
        h('h2', {}, 'Sync paused: large deletion'),
        h('div', { class: 'callout warn' }, `Another device deleted ${d.count} of the ${d.total} bookmarks in this browser. Nothing has been removed here yet.`),
        h('p', { class: 'small muted' }, 'If this was a mistake, keep them — they come back on every device. You can also restore a daily snapshot from “Export & restore”.'),
        h('div', { class: 'row' }, keep, allow),
      ),
    );
  }
  if (s.pendingRisky.length) {
    out.push(
      card(
        h('h2', {}, 'Script bookmarks waiting for approval'),
        h('p', { class: 'small muted' }, 'Bookmarklets (javascript: or data: links) run code on the page you are viewing. They are only added after you allow them.'),
        ...s.pendingRisky.map((r) => {
          const ok = h('button', {}, 'Allow');
          const no = h('button', { class: 'danger' }, 'Delete everywhere');
          ok.onclick = () => act(ok, () => api({ type: 'approveRisky', id: r.id, url: r.url }));
          no.onclick = () => act(no, () => api({ type: 'rejectRisky', id: r.id }));
          return h('div', { class: 'callout stack' }, h('strong', { class: 'break' }, r.title || '(untitled)'), h('code', { class: 'break' }, r.url), h('div', { class: 'row' }, ok, no));
        }),
      ),
    );
  }
  out.push(
    card(
      h('h2', {}, 'Tip'),
      h('p', { class: 'small' }, 'If this browser also syncs bookmarks through its own account sync (Chrome Sync, Edge Sync), turn that off for bookmarks — two sync systems will fight over the same items.'),
      h('p', { class: 'small muted' }, `Version ${i.version} (build ${i.build}) · extension id ${i.extensionId}`),
    ),
  );
  return out;
}

// ----------------------------------------------------------------------------- setup wizard
async function setup(i: StatusInfo): Promise<Node[]> {
  const s = i.status;
  if (!i.clientConfigured) {
    return [
      card(
        h('h2', {}, 'Step 0 · Google Cloud client id missing'),
        h('p', {}, 'This build has no Google OAuth client id. Follow “Owner setup” in the README, put the client id in config.local.json, run npm run build, and reload the extension.'),
        h('p', { class: 'small' }, 'Authorized redirect URI to register:'),
        h('code', { class: 'break' }, i.redirectUri),
      ),
    ];
  }
  // Step 1: Google sign-in
  const step1 = card(h('h2', {}, '1 · Google account'));
  if (!i.email || s.phase === 'signin-required') {
    const b = h('button', { class: 'primary' }, 'Sign in with Google');
    b.onclick = () => act(b, async () => void (await api({ type: 'signIn' })), 'Signed in');
    step1.append(
      h('p', {}, 'Your encrypted bookmarks are stored in a hidden app folder in your own Google Drive. The extension can only see that folder — none of your other files.'),
      b,
    );
    return [step1];
  }
  step1.append(h('p', {}, `Signed in as ${i.email}.`));

  // Step 2: passphrase
  const step2 = card(h('h2', {}, '2 · Encryption passphrase'));
  if (!i.unlocked || s.phase === 'locked' || s.phase === 'not-configured') {
    let exists = false;
    try {
      exists = await api<boolean>({ type: 'remoteExists' });
    } catch (e) {
      step2.append(h('div', { class: 'callout danger' }, e instanceof Error ? e.message : String(e)));
      return [step1, step2];
    }
    if (exists) {
      const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Sync passphrase', style: 'width:100%' });
      const b = h('button', { class: 'primary' }, 'Unlock');
      const go = () => act(b, () => api({ type: 'unlock', passphrase: pw.value }), 'Unlocked');
      b.onclick = go;
      pw.onkeydown = (e) => {
        if ((e as KeyboardEvent).key === 'Enter') void go();
      };
      step2.append(
        h('p', {}, s.phase === 'locked' ? 'The passphrase was changed on another device. Enter the new one.' : 'A synced copy already exists for this account. Enter the passphrase you chose on your first device.'),
        pw,
        b,
        h('p', { class: 'small muted' }, 'Forgot it? Use “Start over with a new passphrase” under Security & data — bookmarks in your browsers are kept.'),
      );
    } else {
      const suggestion = await api<string>({ type: 'generatePassphrase' });
      const pw = h('input', { type: 'text', autocomplete: 'new-password', spellcheck: 'false', style: 'width:100%', class: 'mono' });
      pw.value = suggestion;
      const pw2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again', style: 'width:100%' });
      const saved = h('input', { type: 'checkbox' });
      const regen = h('button', {}, 'Suggest another');
      regen.onclick = async () => (pw.value = await api<string>({ type: 'generatePassphrase' }));
      const kit = h('button', {}, 'Download recovery kit');
      kit.onclick = () =>
        download(
          'bookmark-sync-recovery-kit.txt',
          `Bookmark Sync — recovery kit\n\nGoogle account: ${i.email}\nSync passphrase: ${pw.value}\nCreated: ${new Date().toISOString()}\n\nKeep this in your password manager. Every browser you add needs this passphrase.\nIf it is lost, the synced copy cannot be decrypted (bookmarks in your browsers are not affected).\n`,
          'text/plain',
        );
      const create = h('button', { class: 'primary' }, 'Create encrypted sync');
      create.onclick = () => {
        if (pw.value.length < 12) return toast('Use at least 12 characters');
        if (pw.value !== pw2.value) return toast('The two passphrases differ');
        if (!saved.checked) return toast('Please confirm you saved the passphrase');
        return act(create, () => api({ type: 'createRemote', passphrase: pw.value }), 'Sync created');
      };
      step2.append(
        h('p', {}, 'This is the first device. Choose a passphrase — it encrypts everything before it leaves this computer. Google cannot read your bookmarks, and neither can anyone who gets into your Google account.'),
        h('label', { class: 'field' }, h('span', { class: 'small muted' }, 'Passphrase (a generated one is suggested)'), pw),
        h('div', { class: 'row' }, regen, kit),
        h('label', { class: 'field' }, h('span', { class: 'small muted' }, 'Confirm'), pw2),
        h('label', { class: 'check' }, saved, h('span', {}, 'I saved this passphrase in my password manager or the recovery kit. Without it the synced copy can’t be recovered.')),
        create,
      );
    }
    return [step1, step2];
  }
  step2.append(h('p', {}, 'Unlocked on this device.'));

  // Step 3: join
  if (s.phase === 'needs-join' && s.join) {
    const j = s.join;
    const name = 'joinmode';
    const opt = (value: string, title: string, desc: string, checked = false) =>
      h('label', {}, h('input', { type: 'radio', name, value, checked }), h('span', {}, h('strong', {}, title), h('br'), h('span', { class: 'small muted' }, desc)));
    const choices = h(
      'div',
      { class: 'choice' },
      opt('merge', 'Merge both (recommended)', 'Keeps everything from both sides. Matching folders and bookmarks are combined, nothing is deleted anywhere.', true),
      opt('remote', 'Use the synced copy', `This browser’s ${j.localCount} bookmarks are replaced by the ${j.remoteCount} synced ones.`),
      opt('local', 'Use this browser’s bookmarks', `The synced copy (${j.remoteCount} bookmarks) is replaced on every device by this browser’s ${j.localCount}.`),
    );
    const go = h('button', { class: 'primary' }, 'Continue');
    go.onclick = () => {
      const mode = (choices.querySelector('input:checked') as HTMLInputElement).value;
      if (mode !== 'merge' && !confirm(mode === 'remote' ? 'Replace this browser’s bookmarks with the synced copy?' : 'Replace the synced bookmarks on ALL devices with this browser’s?')) return;
      return act(go, () => api({ type: 'join', mode }), 'Done');
    };
    return [
      step1,
      step2,
      card(
        h('h2', {}, '3 · Combine bookmarks'),
        h('p', {}, `This browser has ${j.localCount} bookmarks and the synced copy has ${j.remoteCount}.`),
        choices,
        h('p', { class: 'small muted' }, 'A backup of this browser’s current bookmarks is kept, and you can export them first from “Export & restore”.'),
        go,
      ),
    ];
  }
  return [step1, step2, card(h('h2', {}, 'All set'), h('p', {}, 'Sync runs automatically when bookmarks change and every few minutes. Add another browser by installing the extension there and signing in with the same Google account and passphrase.'))];
}

// ----------------------------------------------------------------------------- devices
async function devices(): Promise<Node[]> {
  const list = await api<{ id: string; self: boolean; name: string; browser: string; lastSync: number; size: number }[]>({ type: 'devices' });
  const rows = list
    .sort((a, b) => Number(b.self) - Number(a.self) || b.lastSync - a.lastSync)
    .map((d) => {
      const stale = Date.now() - d.lastSync > 60 * 86_400_000;
      const forget = d.self ? null : h('button', { class: 'danger' }, 'Forget');
      if (forget)
        forget.onclick = () => {
          if (!confirm(`Forget “${d.name}”? Its sync file is deleted. Bookmarks are not affected; if that browser syncs again it rejoins by merging.`)) return;
          return act(forget, async () => {
            await api({ type: 'forgetDevice', id: d.id });
            await render();
          }, 'Device forgotten');
        };
      return h(
        'tr',
        {},
        h('td', {}, h('strong', {}, d.name), d.self ? h('span', { class: 'pill ok', style: 'margin-left:6px' }, 'this browser') : null, h('div', { class: 'small muted' }, d.browser)),
        h('td', {}, ago(d.lastSync), stale ? h('div', { class: 'small', style: 'color:var(--warn)' }, 'inactive; removed after 180 days') : null),
        h('td', { class: 'small muted' }, bytes(d.size)),
        h('td', {}, forget),
      );
    });
  return [
    card(
      h('h2', {}, 'Devices'),
      h('p', { class: 'small muted' }, 'Every browser that syncs this account. A device keeps deleted items from being cleaned up until it has seen them, so forget PCs you no longer use.'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Device'), h('th', {}, 'Last sync'), h('th', {}, 'Size'), h('th', {}))), h('tbody', {}, ...rows)),
    ),
  ];
}

// ----------------------------------------------------------------------------- export & restore
async function exportView(i: StatusInfo): Promise<Node[]> {
  if (!i.unlocked) return [card(h('h2', {}, 'Export & restore'), h('p', {}, 'Finish setup first.'))];
  const [snaps, folders] = await Promise.all([api<string[]>({ type: 'snapshots' }).catch(() => [] as string[]), api<{ id: string; path: string }[]>({ type: 'folders' })]);
  const source = h('select', {}, h('option', { value: 'current' }, 'Current bookmarks'), ...snaps.map((d) => h('option', { value: d }, `Snapshot of ${d}`)));
  const scope = h('select', {}, h('option', { value: '' }, 'Everything'), ...folders.map((f) => h('option', { value: f.id }, f.path)));
  const skipScripts = h('input', { type: 'checkbox', checked: true });
  const skipRecovered = h('input', { type: 'checkbox', checked: true });
  const fmt = h('select', {}, h('option', { value: 'html' }, 'HTML — import into any browser'), h('option', { value: 'json' }, 'JSON — full detail'));
  source.onchange = () => {
    scope.disabled = source.value !== 'current';
    if (scope.disabled) scope.value = '';
  };
  const dl = h('button', { class: 'primary' }, 'Download');
  dl.onclick = () =>
    act(dl, async () => {
      const opts: Record<string, unknown> = { skipScripts: skipScripts.checked, skipRecovered: skipRecovered.checked };
      if (scope.value) opts.folderId = scope.value;
      const text = await api<string>({ type: 'export', source: source.value, format: fmt.value, opts });
      const date = source.value === 'current' ? new Date().toISOString().slice(0, 10) : source.value;
      download(`bookmarks-${date}.${fmt.value}`, text, fmt.value === 'html' ? 'text/html' : 'application/json');
    });

  const restoreSel = h('select', {}, ...snaps.map((d) => h('option', { value: d }, d)));
  const restore = h('button', { class: 'danger' }, 'Restore this snapshot');
  restore.disabled = !snaps.length;
  restore.onclick = () => {
    if (!confirm(`Make your bookmarks exactly as they were on ${restoreSel.value}? This applies to every device. Bookmarks added since then are removed (they stay in newer snapshots).`)) return;
    return act(restore, () => api({ type: 'restore', date: restoreSel.value }), 'Restored');
  };

  return [
    card(
      h('h2', {}, 'Export bookmarks'),
      h('p', { class: 'small muted' }, 'Creates a standard bookmarks file on this computer — the format every browser imports (Settings → Import bookmarks → HTML file). Handy for sharing a folder with someone once. The file is not encrypted; it is never uploaded.'),
      h('label', { class: 'field' }, h('span', { class: 'small muted' }, 'From'), source),
      h('label', { class: 'field' }, h('span', { class: 'small muted' }, 'What'), scope),
      h('label', { class: 'field' }, h('span', { class: 'small muted' }, 'Format'), fmt),
      h('label', { class: 'check' }, skipScripts, h('span', {}, 'Leave out script bookmarks (javascript: links) — recommended when sharing')),
      h('label', { class: 'check' }, skipRecovered, h('span', {}, 'Leave out the “Recovered” folder')),
      dl,
    ),
    card(
      h('h2', {}, 'Restore a daily snapshot'),
      h('p', { class: 'small muted' }, 'One snapshot a day is kept for 14 days, then weekly for 8 weeks and monthly for a year.'),
      snaps.length ? h('div', { class: 'row' }, restoreSel, restore) : h('p', {}, 'No snapshots yet — the first one is made on the first sync of the day.'),
    ),
  ];
}

// ----------------------------------------------------------------------------- settings
async function settings(): Promise<Node[]> {
  const s = await api<{ deviceName: string; intervalMin: number; treePref: string; maxDeletes: number; maxDeleteFraction: number; budgetMB: number }>({ type: 'getSettings' });
  const name = h('input', { type: 'text', maxlength: '60', placeholder: 'e.g. Living-room PC' });
  name.value = s.deviceName;
  const interval = h('input', { type: 'number', min: '1', max: '120' });
  interval.value = String(s.intervalMin);
  const tree = h('select', {}, h('option', { value: 'auto' }, 'Automatic'), h('option', { value: 'account' }, 'Account bookmarks'), h('option', { value: 'local' }, 'Local bookmarks'));
  tree.value = s.treePref;
  const maxDel = h('input', { type: 'number', min: '1' });
  maxDel.value = String(s.maxDeletes);
  const frac = h('input', { type: 'number', min: '1', max: '100' });
  frac.value = String(Math.round(s.maxDeleteFraction * 100));
  const budget = h('input', { type: 'number', min: '5', max: '1000' });
  budget.value = String(s.budgetMB);
  const save = h('button', { class: 'primary' }, 'Save');
  save.onclick = () =>
    act(
      save,
      () =>
        api({
          type: 'saveSettings',
          settings: { deviceName: name.value.trim(), intervalMin: +interval.value, treePref: tree.value, maxDeletes: +maxDel.value, maxDeleteFraction: +frac.value / 100, budgetMB: +budget.value },
        }),
      'Saved',
    );
  const f = (label: string, el: HTMLElement, hint?: string) => h('label', { class: 'field' }, h('span', {}, label), el, hint ? h('span', { class: 'small muted' }, hint) : null);
  return [
    card(
      h('h2', {}, 'Settings'),
      f('Device name', name, 'Shown in the device list on your other browsers.'),
      f('Sync every (minutes)', interval, 'Changes you make sync within seconds anyway; this is how often other devices’ changes are fetched.'),
      f('Which bookmarks to sync', tree, 'Only matters when the browser shows separate account and local bookmarks.'),
      f('Ask before deleting more than (bookmarks)', maxDel),
      f('…or more than (% of bookmarks)', frac),
      f('Google Drive space budget (MB)', budget, 'Old snapshots are trimmed to stay under this (at least 7 are always kept).'),
      save,
    ),
  ];
}

// ----------------------------------------------------------------------------- security & data
async function security(i: StatusInfo): Promise<Node[]> {
  const out: Node[] = [];
  out.push(
    card(
      h('h2', {}, 'How your data is protected'),
      h(
        'ul',
        { class: 'small' },
        h('li', {}, 'Bookmarks are encrypted on this computer with AES-256-GCM before upload; the key comes from your passphrase (PBKDF2, 600,000 rounds).'),
        h('li', {}, 'The key is stored here as a non-exportable browser key; the passphrase itself is never stored.'),
        h('li', {}, 'Google Drive access is limited to this extension’s hidden app folder; the sign-in token lives in memory only.'),
        h('li', {}, 'Script bookmarks from other devices need your approval; large deletions pause sync.'),
        h('li', {}, 'The activity log records counts only, never URLs or titles.'),
      ),
    ),
  );
  if (i.unlocked) {
    try {
      const u = await api<{ devices: number; snapshots: number; other: number; fileCount: number; snapshotCount: number; budget: number }>({ type: 'storageUsage' });
      const total = u.devices + u.snapshots + u.other;
      out.push(
        card(
          h('h2', {}, 'Google Drive usage'),
          h('div', { class: 'bar' }, h('span', { style: `width:${Math.min(100, (100 * total) / u.budget).toFixed(1)}%` })),
          h('p', { class: 'small' }, `${bytes(total)} of ${bytes(u.budget)} budget · device files ${bytes(u.devices)} · ${u.snapshotCount} snapshots ${bytes(u.snapshots)} · ${u.fileCount} files`),
        ),
      );
    } catch {
      /* not signed in */
    }
  }
  const np = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New passphrase (12+ characters)', style: 'width:100%' });
  const np2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat', style: 'width:100%' });
  const change = h('button', {}, 'Change passphrase');
  change.onclick = () => {
    if (np.value.length < 12) return toast('Use at least 12 characters');
    if (np.value !== np2.value) return toast('The two passphrases differ');
    if (!confirm('Change the passphrase? Every other browser will ask for the new one and then merge its bookmarks back in.')) return;
    return act(change, () => api({ type: 'changePassphrase', passphrase: np.value }), 'Passphrase changed');
  };
  out.push(
    card(
      h('h2', {}, 'Passphrase'),
      h('p', { class: 'small muted' }, 'Also use this if you forgot the passphrase: it starts over with a new one. Your bookmarks are safe in your browsers; only older snapshots that can’t be decrypted are lost.'),
      np,
      np2,
      change,
    ),
  );
  const signOut = h('button', {}, 'Sign out of Google');
  signOut.onclick = () => act(signOut, () => api({ type: 'signOut' }), 'Signed out');
  const wipe = h('button', { class: 'danger' }, 'Remove all synced data');
  wipe.onclick = () => {
    if (prompt('This deletes the encrypted copy, all snapshots and device files from Google Drive for every device. Bookmarks in your browsers stay. Type DELETE to confirm.') !== 'DELETE') return;
    return act(wipe, () => api({ type: 'wipeRemote' }), 'Synced data removed');
  };
  const reset = h('button', { class: 'danger' }, 'Reset this browser');
  reset.onclick = () => {
    if (!confirm('Forget sync settings on this browser? Bookmarks stay. You’ll need to set it up again.')) return;
    return act(reset, () => api({ type: 'resetLocal' }), 'Reset');
  };
  out.push(
    card(
      h('h2', {}, 'Account & data'),
      h('p', { class: 'small muted' }, 'You can also delete the hidden data from Google Drive → Settings → Manage apps.'),
      h('div', { class: 'row' }, signOut, reset, wipe),
    ),
  );
  return out;
}

// ----------------------------------------------------------------------------- log
async function logView(): Promise<Node[]> {
  const logs = (await api<{ t: number; level: string; msg: string }[]>({ type: 'logs' })).slice().reverse();
  const dl = h('button', {}, 'Download log');
  dl.onclick = () => download('bookmark-sync-log.txt', logs.map((l) => `${new Date(l.t).toISOString()} ${l.level.toUpperCase()} ${l.msg}`).join('\n'), 'text/plain');
  return [
    card(
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Activity log'), h('span', { class: 'spacer' }), dl),
      h('p', { class: 'small muted' }, 'Counts and ids only — no URLs or titles are ever logged.'),
      logs.length
        ? h(
            'table',
            {},
            h('tbody', {}, ...logs.slice(0, 200).map((l) => h('tr', {}, h('td', { class: 'small muted', style: 'white-space:nowrap' }, new Date(l.t).toLocaleString()), h('td', { class: 'small' }, l.level), h('td', { class: 'small break' }, l.msg)))),
          )
        : h('p', {}, 'Nothing yet.'),
    ),
  ];
}

onStatusChange(() => {
  if (current === 'overview' || current === 'setup') void render();
});
const fromHash = () => {
  const t = location.hash.slice(1) as Tab;
  return tabs.some((b) => b.dataset.tab === t) ? t : 'overview';
};
window.addEventListener('hashchange', () => {
  if (fromHash() !== current) select(fromHash());
});
select(fromHash());
