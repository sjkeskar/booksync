/** Shared UI helpers. All dynamic text goes through textContent — never innerHTML. */

export async function api<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: T; error?: string } | undefined;
  if (!r) throw new Error('No response from the extension background');
  if (!r.ok) throw new Error(r.error ?? 'Unknown error');
  return r.data as T;
}

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function clear(el: Element, ...children: Child[]) {
  el.replaceChildren(...(children.filter((c) => c !== null && c !== undefined && c !== false) as (Node | string)[]));
}

export function ago(ms: number): string {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 36) return `${hr} h ago`;
  return `${Math.round(hr / 24)} days ago`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function toast(text: string) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface StatusInfo {
  status: {
    phase: string;
    message: string;
    lastSync: number;
    lastError: string;
    pendingDeletes: { count: number; total: number } | null;
    pendingRisky: { id: string; title: string; url: string }[];
    join: { localCount: number; remoteCount: number } | null;
    warnings: string[];
    bookmarkCount: number;
    deviceCount: number;
  };
  email: string;
  clientConfigured: boolean;
  version: string;
  build: string;
  extensionId: string;
  redirectUri: string;
  unlocked: boolean;
}

export function phasePill(phase: string): HTMLElement {
  const map: Record<string, [string, string]> = {
    idle: ['Up to date', 'ok'],
    syncing: ['Syncing', ''],
    'needs-approval': ['Needs you', 'warn'],
    'needs-join': ['Needs you', 'warn'],
    locked: ['Locked', 'warn'],
    'signin-required': ['Sign in', 'warn'],
    'not-configured': ['Not set up', ''],
    offline: ['Offline', 'warn'],
    error: ['Error', 'err'],
  };
  const [label, cls] = map[phase] ?? [phase, ''];
  return h('span', { class: `pill ${cls}` }, h('span', { class: 'dot' }), label);
}

/** Run an async action with a busy button and error toast. */
export async function act(btn: HTMLButtonElement | null, fn: () => Promise<unknown>, okText?: string) {
  if (btn) btn.disabled = true;
  try {
    await fn();
    if (okText) toast(okText);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function onStatusChange(cb: () => void) {
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && (c.status || c.googleEmail)) cb();
  });
}
