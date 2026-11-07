const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|yclid|igshid|_ga|_gl)$/i;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Canonical form of a URL for matching/dedupe only (never written back to the browser).
 * Lowercases scheme/host, drops default ports, credentials, tracking params and a trailing slash.
 */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s;
  const params = u.search
    .slice(1)
    .split('&')
    .filter((p) => p && !TRACKING.test(safeDecode(p.split('=')[0] ?? '')));
  const search = params.length ? `?${params.join('&')}` : '';
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  return `${u.protocol}//${u.host}${path}${search}${u.hash}`;
}

const RISKY = /^\s*(javascript|data|vbscript):/i;

/** URLs that can execute code or render arbitrary content when clicked. */
export function isRiskyUrl(url: string | undefined): boolean {
  return !!url && RISKY.test(url);
}
