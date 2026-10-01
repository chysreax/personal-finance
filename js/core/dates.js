/**
 * Calendar helpers working on local "YYYY-MM-DD" strings. Dates are built at
 * local noon so DST transitions never shift a day.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');

export function isISODate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function parseISO(s) {
  const m = ISO_RE.exec(s);
  if (!m) return new Date(NaN);
  return new Date(+m[1], +m[2] - 1, +m[3], 12);
}

export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const todayISO = (now = new Date()) => toISO(now);

export function daysInMonth(year, month1) {
  return new Date(year, month1, 0).getDate();
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** Add months, clamping the day (Jan 31 + 1 month → Feb 28/29). */
export function addMonths(iso, n, anchorDay) {
  const d = parseISO(iso);
  const day = anchorDay || d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
  target.setDate(Math.min(day, daysInMonth(target.getFullYear(), target.getMonth() + 1)));
  return toISO(target);
}

export const diffDays = (a, b) => Math.round((parseISO(b) - parseISO(a)) / DAY_MS);

export const monthKey = (iso) => iso.slice(0, 7);

export function monthStart(key) {
  return `${key}-01`;
}

export function monthEnd(key) {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${pad(daysInMonth(y, m))}`;
}

export function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1, 12);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Last `n` month keys ending with the month of `refISO` (oldest first). */
export function lastNMonths(n, refISO = todayISO()) {
  const end = monthKey(refISO);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftMonth(end, -i));
  return out;
}

export function monthsBetween(fromKey, toKey) {
  const out = [];
  let k = fromKey;
  let guard = 0;
  while (k <= toKey && guard++ < 1200) {
    out.push(k);
    k = shiftMonth(k, 1);
  }
  return out;
}

const fmt = new Map();
function dtf(opts) {
  const key = JSON.stringify(opts);
  if (!fmt.has(key)) fmt.set(key, new Intl.DateTimeFormat(undefined, opts));
  return fmt.get(key);
}

export function formatDate(iso, style = 'medium') {
  if (!isISODate(iso)) return '—';
  const d = parseISO(iso);
  if (style === 'short') return dtf({ month: 'short', day: 'numeric' }).format(d);
  if (style === 'long') return dtf({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d);
  if (style === 'weekday') return dtf({ weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  return dtf({ month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

export function monthLabel(key, style = 'short') {
  const d = parseISO(`${key}-01`);
  if (style === 'long') return dtf({ month: 'long', year: 'numeric' }).format(d);
  if (style === 'tiny') return dtf({ month: 'narrow' }).format(d);
  return dtf({ month: 'short' }).format(d);
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function relativeDay(iso, today = todayISO()) {
  const d = diffDays(today, iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d < 7) return `In ${d} days`;
  return formatDate(iso, 'short');
}
