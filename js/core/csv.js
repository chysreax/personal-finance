/**
 * CSV import/export. Export neutralises spreadsheet formula injection
 * (cells beginning with = + - @ TAB CR are prefixed with an apostrophe).
 * Import auto-detects common bank-statement column layouts and date formats.
 */
import { toCents } from './money.js';
import { cleanText, cleanTags } from './schema.js';
import { isISODate } from './dates.js';

const FORMULA_RE = /^[=+\-@\t\r]/;

function cell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v !== 'number' && FORMULA_RE.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows, columns) {
  const head = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(c.get(r))).join(','));
  return [head, ...body].join('\r\n');
}

/** RFC 4180 parser (quoted fields, escaped quotes, CRLF/LF). */
export function parseCSV(text, maxRows = 50_000) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  const delim = detectDelimiter(s);
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error(`CSV has more than ${maxRows} rows`);
    } else field += ch;
    i++;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(s) {
  const nl = s.indexOf('\n');
  const firstLine = s.slice(0, nl === -1 ? 500 : nl);
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'posted date', 'posting date', 'booking date', 'tanggal', 'value date'],
  payee: ['payee', 'description', 'merchant', 'name', 'details', 'narrative', 'memo', 'keterangan', 'counterparty'],
  amount: ['amount', 'value', 'transaction amount', 'jumlah', 'amount (usd)'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'outflow'],
  credit: ['credit', 'deposit', 'deposits', 'money in', 'paid in', 'inflow'],
  category: ['category', 'kategori'],
  type: ['type', 'transaction type'],
  tags: ['tags', 'labels'],
  note: ['note', 'notes', 'comment', 'reference'],
  account: ['account', 'account name'],
};

function mapHeaders(header) {
  const norm = header.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = norm.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[key] = idx;
  }
  // "memo" may have been claimed as payee; prefer a real description column.
  if (map.payee !== undefined && map.note === map.payee) delete map.note;
  return map;
}

function detectDateOrder(values) {
  // Decide between M/D/Y and D/M/Y by looking for a first component > 12.
  let dmy = false;
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v.trim());
    if (m && +m[1] > 12) dmy = true;
  }
  return dmy ? 'dmy' : 'mdy';
}

export function parseDate(v, order = 'mdy') {
  const s = String(v || '').trim();
  let m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/.exec(s);
  if (m) return fmt(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return order === 'dmy' ? fmt(y, +m[2], +m[1]) : fmt(y, +m[1], +m[2]);
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    const d = new Date(t);
    return fmt(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}
const fmt = (y, m, d) => {
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isISODate(iso) ? iso : null;
};

/**
 * Turn CSV text into transaction drafts (no ids, no account yet).
 * @param {string} text
 * @param {{categoriesByName: Map<string,string>}} ctx
 * @returns {{drafts: object[], errors: string[], columns: object}}
 */
export function csvToDrafts(text, ctx) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { drafts: [], errors: ['The file has no data rows.'], columns: {} };
  const cols = mapHeaders(rows[0]);
  const errors = [];
  if (cols.date === undefined) errors.push('No "date" column found.');
  if (cols.amount === undefined && cols.debit === undefined && cols.credit === undefined) errors.push('No "amount" (or debit/credit) column found.');
  if (errors.length) return { drafts: [], errors, columns: cols };

  const order = detectDateOrder(rows.slice(1, 200).map((r) => r[cols.date] || ''));
  const drafts = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const date = parseDate(r[cols.date], order);
    if (!date) return errors.push(`Row ${line}: unreadable date "${cleanText(r[cols.date], 20)}"`);
    let signed;
    if (cols.amount !== undefined && String(r[cols.amount] || '').trim() !== '') {
      const raw = String(r[cols.amount]).trim();
      signed = toCents(raw.replace(/^\((.*)\)$/, '-$1'));
    } else {
      const debit = toCents(String(r[cols.debit] ?? '')) || 0;
      const credit = toCents(String(r[cols.credit] ?? '')) || 0;
      signed = credit - Math.abs(debit);
    }
    if (!Number.isFinite(signed) || signed === 0) return errors.push(`Row ${line}: invalid amount`);
    let type = signed < 0 ? 'expense' : 'income';
    const typeCell = cols.type !== undefined ? String(r[cols.type] || '').toLowerCase() : '';
    if (/expense|debit|withdraw/.test(typeCell)) type = 'expense';
    else if (/income|credit|deposit/.test(typeCell)) type = 'income';
    const catName = cols.category !== undefined ? cleanText(r[cols.category], 40).toLowerCase() : '';
    drafts.push({
      date,
      type,
      amount: Math.abs(signed),
      payee: cleanText(r[cols.payee], 80) || 'Imported',
      categoryId: (catName && ctx.categoriesByName.get(catName)) || null,
      tags: cols.tags !== undefined ? cleanTags(r[cols.tags]) : [],
      note: cols.note !== undefined ? cleanText(r[cols.note], 280) : '',
      accountName: cols.account !== undefined ? cleanText(r[cols.account], 60) : '',
    });
  });
  return { drafts, errors, columns: cols };
}
