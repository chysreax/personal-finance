/**
 * Dataset schema, defaults and the sanitiser applied to EVERY untrusted input
 * (remote vault, JSON import, CSV import, local cache). Anything that does not
 * fit the schema is coerced or dropped — never passed through.
 */
import { isISODate } from './dates.js';
import { MAX_CENTS, CURRENCIES } from './money.js';
import { uid } from './ids.js';

export const SCHEMA_VERSION = 1;
export const EXPORT_FORMAT = 'pfm-export';

export const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'investment', 'credit', 'loan'];
export const LIABILITY_TYPES = new Set(['credit', 'loan']);
export const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);
export const TX_TYPES = ['expense', 'income', 'transfer'];
export const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
export const COLLECTIONS = ['accounts', 'categories', 'transactions', 'budgets', 'goals', 'recurring', 'rules'];
export const UNCATEGORIZED = 'cat_uncategorized';
const MAX_RECORDS = 200_000;
const PALETTE_SLOTS = 8;

export const DEFAULT_CATEGORIES = [
  ['cat_groceries', 'Groceries', 'expense', 2, '🛒'],
  ['cat_dining', 'Dining out', 'expense', 1, '🍽️'],
  ['cat_housing', 'Housing', 'expense', 0, '🏠'],
  ['cat_utilities', 'Utilities', 'expense', 3, '💡'],
  ['cat_transport', 'Transport', 'expense', 6, '🚌'],
  ['cat_subscriptions', 'Subscriptions', 'expense', 4, '🔁'],
  ['cat_shopping', 'Shopping', 'expense', 7, '🛍️'],
  ['cat_health', 'Health', 'expense', 5, '🩺'],
  ['cat_entertainment', 'Entertainment', 'expense', 4, '🎬'],
  ['cat_travel', 'Travel', 'expense', 0, '✈️'],
  ['cat_education', 'Education', 'expense', 6, '📚'],
  ['cat_insurance', 'Insurance', 'expense', 3, '🛡️'],
  ['cat_personal', 'Personal care', 'expense', 1, '💈'],
  ['cat_gifts', 'Gifts & donations', 'expense', 7, '🎁'],
  ['cat_fees', 'Fees & interest', 'expense', 5, '🧾'],
  [UNCATEGORIZED, 'Uncategorized', 'expense', -1, '❔'],
  ['cat_salary', 'Salary', 'income', 2, '💼'],
  ['cat_freelance', 'Freelance', 'income', 0, '🧑‍💻'],
  ['cat_investment_income', 'Investment income', 'income', 6, '📈'],
  ['cat_refunds', 'Refunds', 'income', 3, '↩️'],
  ['cat_other_income', 'Other income', 'income', 4, '➕'],
].map(([id, name, kind, color, icon]) => ({ id, name, kind, color, icon, updatedAt: 0, deleted: false }));

export const DEFAULT_SETTINGS = Object.freeze({ currency: 'USD', budgetWarn: 0.8, updatedAt: 0 });

export function emptyData() {
  return {
    schema: SCHEMA_VERSION,
    accounts: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    transactions: [],
    budgets: [],
    goals: [],
    recurring: [],
    rules: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

/* ---------- field sanitisers ---------- */

// C0/C1 controls, bidi overrides and zero-width chars are stripped from all text.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

export function cleanText(v, max = 120) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return '';
  return v.replace(CONTROL_RE, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const cleanId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);

export const cleanCents = (v, { min = -MAX_CENTS, max = MAX_CENTS } = {}) =>
  Number.isSafeInteger(v) && v >= min && v <= max ? v : null;

export const cleanDate = (v) => (isISODate(v) ? v : null);

const cleanTs = (v) => (Number.isFinite(v) && v >= 0 && v < 8.64e15 ? Math.floor(v) : 0);

const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

const cleanSlot = (v) => (Number.isInteger(v) && v >= -1 && v < PALETTE_SLOTS ? v : 0);

const EMOJI_MAX = 8;
const cleanIcon = (v) => {
  const s = cleanText(v, EMOJI_MAX);
  return /[<>"'&`]/.test(s) ? '' : s;
};

export function cleanTags(v) {
  if (!Array.isArray(v)) {
    if (typeof v === 'string') v = v.split(/[,;]/);
    else return [];
  }
  const out = new Set();
  for (const t of v) {
    const tag = cleanText(t, 32)
      .toLowerCase()
      .replace(/^#/, '')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .trim();
    if (tag) out.add(tag);
    if (out.size >= 12) break;
  }
  return [...out];
}

/* ---------- record normalisers (return null to drop) ---------- */

const base = (r) => {
  const id = cleanId(r.id);
  if (!id) return null;
  return { id, updatedAt: cleanTs(r.updatedAt), deleted: r.deleted === true };
};

const tombstone = (b) => (b.deleted ? { id: b.id, updatedAt: b.updatedAt, deleted: true } : null);

const NORMALIZERS = {
  accounts(r) {
    const b = base(r);
    if (!b) return null;
    const t = tombstone(b);
    if (t) return t;
    const name = cleanText(r.name, 60);
    if (!name) return null;
    return {
      ...b,
      name,
      type: oneOf(r.type, ACCOUNT_TYPES, 'checking'),
      opening: cleanCents(r.opening) ?? 0,
      archived: r.archived === true,
      color: cleanSlot(r.color),
    };
  },
  categories(r) {
    const b = base(r);
    if (!b) return null;
    const t = tombstone(b);
    if (t) return t;
    const name = cleanText(r.name, 40);
    if (!name) return null;
    return { ...b, name, kind: oneOf(r.kind, ['expense', 'income'], 'expense'), color: cleanSlot(r.color), icon: cleanIcon(r.icon) };
  },
  transactions(r) {
    const b = base(r);
    if (!b) return null;
    const t = tombstone(b);
    if (t) return t;
    const amount = cleanCents(r.amount, { min: 1 });
    const date = cleanDate(r.date);
    const accountId = cleanId(r.accountId);
    if (!amount || !date || !accountId) return null;
    const type = oneOf(r.type, TX_TYPES, 'expense');
    const toAccountId = type === 'transfer' ? cleanId(r.toAccountId) : null;
    if (type === 'transfer' && (!toAccountId || toAccountId === accountId)) return null;
    return {
      ...b,
      date,
      amount,
      type,
      accountId,
      toAccountId,
      categoryId: type === 'transfer' ? null : cleanId(r.categoryId) || UNCATEGORIZED,
      payee: cleanText(r.payee, 80) || (type === 'transfer' ? 'Transfer' : 'Unknown'),
      note: cleanText(r.note, 280),
      tags: cleanTags(r.tags),
      recurringId: cleanId(r.recurringId),
      createdAt: cleanTs(r.createdAt) || b.updatedAt,
    };
  },
  budgets(r) {
    const b = base(r);
    if (!b) return null;
    const t = tombstone(b);
    if (t) return t;
    const limit = cleanCents(r.limit, { min: 1 });
    const categoryId = cleanId(r.categoryId);
    if (!limit || !categoryId) return null;
    return { ...b, categoryId, limit };
  },
  goals(r) {
    const b = base(r);
    if (!b) return null;
    const t = tombstone(b);
    if (t) return t;
    const name = cleanText(r.name, 60);
    const target = cleanCents(r.target, { min: 1 });
    if (!name || !target) return null;
    const history = Array.isArray(r.history)
      ? r.history
          .map((h) => (h && cleanDate(h.date) && cleanCents(h.amount) ? { date: h.date, amount: h.amount } : null))
          .filter(Boolean)
          .slice(-240)
      : [];
    return {
      ...b,
      name,
      target,
      saved: cleanCents(r.saved, { min: 0 }) ?? 0,
      deadline: cleanDate(r.deadline),
      color: cleanSlot(r.color),
      icon: cleanIcon(r.icon) || '🎯',
      history,
    };
  },
  recurring(r) {
    const b = base(r);
    if (!b) return null;
    const t = tombstone(b);
    if (t) return t;
    const amount = cleanCents(r.amount, { min: 1 });
    const nextDate = cleanDate(r.nextDate);
    const accountId = cleanId(r.accountId);
    const payee = cleanText(r.payee, 80);
    if (!amount || !nextDate || !accountId || !payee) return null;
    return {
      ...b,
      payee,
      amount,
      type: oneOf(r.type, ['expense', 'income'], 'expense'),
      categoryId: cleanId(r.categoryId) || UNCATEGORIZED,
      accountId,
      frequency: oneOf(r.frequency, FREQUENCIES, 'monthly'),
      nextDate,
      active: r.active !== false,
      note: cleanText(r.note, 200),
    };
  },
  rules(r) {
    const b = base(r);
    if (!b) return null;
    const t = tombstone(b);
    if (t) return t;
    const pattern = cleanText(r.pattern, 60).toLowerCase();
    const categoryId = cleanId(r.categoryId);
    if (!pattern || !categoryId) return null;
    return { ...b, pattern, categoryId };
  },
};

export function normalizeRecord(collection, r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  return NORMALIZERS[collection](r);
}

function normalizeSettings(s) {
  const src = s && typeof s === 'object' ? s : {};
  const warn = Number(src.budgetWarn);
  return {
    currency: CURRENCIES.includes(src.currency) ? src.currency : DEFAULT_SETTINGS.currency,
    budgetWarn: Number.isFinite(warn) && warn >= 0.5 && warn <= 1 ? Math.round(warn * 100) / 100 : DEFAULT_SETTINGS.budgetWarn,
    updatedAt: cleanTs(src.updatedAt),
  };
}

/**
 * Validate + sanitise a whole dataset.
 * @param {unknown} raw
 * @param {{regenerateIds?: boolean}} [o] regenerate missing/invalid ids (imports) instead of dropping
 * @returns {{data: ReturnType<typeof emptyData>, dropped: number, warnings: string[]}}
 */
export function normalizeData(raw, o = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SchemaError('Dataset must be a JSON object');
  if (raw.format === EXPORT_FORMAT) raw = raw.data;
  if (!raw || typeof raw !== 'object') throw new SchemaError('Export file has no data section');
  const schema = raw.schema ?? SCHEMA_VERSION;
  if (schema !== SCHEMA_VERSION) throw new SchemaError(`Unsupported schema version: ${String(schema).slice(0, 8)}`);
  const known = COLLECTIONS.filter((c) => Array.isArray(raw[c]));
  if (known.length === 0) throw new SchemaError('No recognisable collections in dataset');

  const data = emptyData();
  const warnings = [];
  let dropped = 0;
  for (const c of COLLECTIONS) {
    const src = raw[c];
    if (src === undefined) continue;
    if (!Array.isArray(src)) {
      warnings.push(`"${c}" is not a list and was ignored`);
      continue;
    }
    if (src.length > MAX_RECORDS) throw new SchemaError(`"${c}" exceeds ${MAX_RECORDS} records`);
    const byId = new Map(c === 'categories' ? data.categories.map((x) => [x.id, x]) : []);
    for (const item of src) {
      let input = item;
      if (o.regenerateIds && item && typeof item === 'object' && !cleanId(item.id)) input = { ...item, id: uid() };
      const rec = normalizeRecord(c, input);
      if (!rec) {
        dropped++;
        continue;
      }
      const prev = byId.get(rec.id);
      if (!prev || rec.updatedAt >= prev.updatedAt) byId.set(rec.id, rec);
    }
    data[c] = [...byId.values()];
  }
  data.settings = normalizeSettings(raw.settings);

  // Referential repair: categories that no longer exist fall back to Uncategorized.
  const catIds = new Set(data.categories.filter((x) => !x.deleted).map((x) => x.id));
  if (!catIds.has(UNCATEGORIZED)) {
    data.categories = data.categories.filter((x) => x.id !== UNCATEGORIZED);
    data.categories.push({ ...DEFAULT_CATEGORIES.find((x) => x.id === UNCATEGORIZED) });
  }
  if (dropped) warnings.push(`${dropped} invalid record${dropped === 1 ? '' : 's'} skipped`);
  return { data, dropped, warnings };
}

export function makeExport(data) {
  return { format: EXPORT_FORMAT, version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data };
}
