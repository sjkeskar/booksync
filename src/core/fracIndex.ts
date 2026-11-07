/**
 * Fractional indexing: string keys that sort lexicographically and always admit a key between
 * any two distinct keys. Lets devices insert into a folder concurrently without renumbering.
 * Keys never end in the smallest digit so a key "before" always exists.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0]!;

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  }
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

export function isValidKey(k: string): boolean {
  if (!k || k.endsWith(ZERO)) return false;
  for (const ch of k) if (!DIGITS.includes(ch)) return false;
  return true;
}

/** A key strictly between a and b (null = open end). Requires a < b. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
  return midpoint(a ?? '', b);
}

/** n keys strictly between a and b, ascending, with logarithmic length growth. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  const mid = keyBetween(a, b);
  if (n === 1) return [mid];
  const left = Math.floor((n - 1) / 2);
  return [...keysBetween(a, mid, left), mid, ...keysBetween(mid, b, n - 1 - left)];
}
