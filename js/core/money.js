/**
 * Money helpers. All amounts are stored as integer minor units ("cents") to
 * avoid floating point drift; formatting happens only at the edges.
 */

export const MAX_CENTS = 1e13; // 100 billion major units — far beyond any personal ledger

export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'IDR', 'JPY', 'SGD', 'AUD', 'CAD', 'CHF', 'INR', 'MYR', 'CNY', 'KRW', 'BRL', 'MXN', 'ZAR',
];

/**
 * Parse user input ("1,234.56", "1.234,56", "-12", "$40") into cents.
 * Returns NaN when the input is not a usable number.
 * @param {string|number} input
 */
export function toCents(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input * 100) : NaN;
  }
  if (typeof input !== 'string') return NaN;
  let s = input.trim().replace(/[\s '’]/g, '').replace(/[^\d.,-]/g, '');
  if (!s || s === '-' ) return NaN;
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal separator.
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma !== -1) {
    // Only commas: decimal when exactly 1–2 digits follow the last comma.
    const tail = s.length - lastComma - 1;
    s = (tail === 1 || tail === 2) && s.indexOf(',') === lastComma ? s.replace(',', '.') : s.split(',').join('');
  } else if (lastDot !== -1 && s.indexOf('.') !== lastDot) {
    s = s.split('.').join(''); // "1.234.567" → thousands separators
  }
  if (!/^\d*\.?\d*$/.test(s) || s === '.') return NaN;
  const value = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_CENTS) return NaN;
  return negative ? -value : value;
}

export const fromCents = (cents) => cents / 100;

const fmtCache = new Map();
function formatter(currency, locale, opts) {
  const key = `${currency}|${locale || ''}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale || undefined, { style: 'currency', currency, ...opts });
    } catch {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', ...opts });
    }
    fmtCache.set(key, f);
  }
  return f;
}

/**
 * Format cents as currency.
 * @param {number} cents
 * @param {string} currency
 * @param {{compact?: boolean, sign?: boolean, locale?: string, whole?: boolean}} [o]
 */
export function formatMoney(cents, currency = 'USD', o = {}) {
  const v = (Number.isFinite(cents) ? cents : 0) / 100;
  const opts = {};
  if (o.compact && Math.abs(v) >= 10_000) {
    opts.notation = 'compact';
    opts.maximumFractionDigits = 1;
  } else if (o.whole) {
    opts.maximumFractionDigits = 0;
  }
  if (o.sign) opts.signDisplay = 'exceptZero';
  return formatter(currency, o.locale, opts).format(v);
}

/** Plain decimal string suitable for an <input> value. */
export function centsToInput(cents) {
  if (!Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2).replace(/\.00$/, '');
}

export function formatPct(ratio, digits = 0) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export const sum = (arr, fn = (x) => x) => arr.reduce((acc, x) => acc + fn(x), 0);
