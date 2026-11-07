import { act, ago, api, clear, h, onStatusChange, phasePill, type StatusInfo } from './common';

const content = document.getElementById('content')!;
const pill = document.getElementById('pill')!;

const openOptions = (hash = '') => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash}`) });
  window.close();
};

async function render() {
  let info: StatusInfo;
  try {
    info = await api<StatusInfo>({ type: 'status' });
  } catch (e) {
    clear(content, h('p', {}, e instanceof Error ? e.message : String(e)));
    return;
  }
  const s = info.status;
  clear(pill, phasePill(s.phase));
  const blocks: (Node | null)[] = [];

  blocks.push(h('p', { class: 'break' }, s.message));
  if (s.phase !== 'not-configured') {
    blocks.push(
      h('p', { class: 'muted small' }, `Last synced ${ago(s.lastSync)} · ${s.deviceCount} device${s.deviceCount === 1 ? '' : 's'} · ${s.bookmarkCount.toLocaleString()} bookmarks`),
    );
  }

  if (['not-configured', 'needs-join', 'locked', 'signin-required'].includes(s.phase)) {
    blocks.push(h('button', { class: 'primary', onclick: () => openOptions('#setup') }, s.phase === 'not-configured' ? 'Set up sync' : 'Continue setup'));
  }

  if (s.pendingDeletes) {
    const d = s.pendingDeletes;
    const allow = h('button', { class: 'danger' }, `Delete ${d.count}`);
    const keep = h('button', { class: 'primary' }, 'Keep them');
    allow.onclick = () => act(allow, () => api({ type: 'approveDeletes' }), 'Deleted');
    keep.onclick = () => act(keep, () => api({ type: 'keepMine' }), 'Kept and re-shared');
    blocks.push(
      h(
        'div',
        { class: 'callout warn stack' },
        h('strong', {}, `Another device deleted ${d.count} of your ${d.total} bookmarks.`),
        h('p', { class: 'small' }, 'Sync is paused on this browser until you decide. “Keep them” restores them on every device.'),
        h('div', { class: 'row' }, keep, allow, h('button', { onclick: () => openOptions('#export') }, 'Snapshots…')),
      ),
    );
  }

  for (const r of s.pendingRisky) {
    const ok = h('button', {}, 'Allow');
    const no = h('button', { class: 'danger' }, 'Delete everywhere');
    ok.onclick = () => act(ok, () => api({ type: 'approveRisky', id: r.id, url: r.url }));
    no.onclick = () => act(no, () => api({ type: 'rejectRisky', id: r.id }));
    blocks.push(
      h(
        'div',
        { class: 'callout warn stack' },
        h('strong', {}, 'Script bookmark from another device'),
        h('div', { class: 'small break' }, r.title || '(untitled)'),
        h('code', { class: 'break' }, r.url.length > 160 ? `${r.url.slice(0, 160)}…` : r.url),
        h('p', { class: 'small muted' }, 'Bookmarklets run code on the page you are viewing. Allow only if you recognise it.'),
        h('div', { class: 'row' }, ok, no),
      ),
    );
  }

  for (const w of s.warnings) blocks.push(h('div', { class: 'callout small' }, w));
  if (s.lastError && s.phase !== 'idle') blocks.push(h('div', { class: 'callout danger small break' }, s.lastError));

  const syncBtn = h('button', { class: 'primary' }, 'Sync now');
  syncBtn.onclick = () => act(syncBtn, () => api({ type: 'syncNow' }));
  if (s.phase === 'not-configured') syncBtn.disabled = true;
  blocks.push(h('div', { class: 'row' }, syncBtn, h('span', { class: 'spacer' }), h('button', { onclick: () => openOptions() }, 'Options')));

  clear(content, ...blocks);
}

onStatusChange(() => void render());
void render();
