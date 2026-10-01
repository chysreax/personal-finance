/**
 * Recurring payments: schedule maths, automatic detection from history, and a
 * day-by-day cash-flow forecast.
 */
import * as D from './dates.js';
import { live, netWorth } from './finance.js';
import { normalizePayee } from './categorize.js';

export const FREQ_DAYS = { weekly: 7, biweekly: 14, monthly: 30.44, quarterly: 91.31, yearly: 365.25 };
export const PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
const TOLERANCE = { weekly: 1, biweekly: 2, monthly: 4, quarterly: 10, yearly: 20 };
export const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

export function nextOccurrence(iso, freq) {
  switch (freq) {
    case 'weekly':
      return D.addDays(iso, 7);
    case 'biweekly':
      return D.addDays(iso, 14);
    case 'quarterly':
      return D.addMonths(iso, 3);
    case 'yearly':
      return D.addMonths(iso, 12);
    default:
      return D.addMonths(iso, 1);
  }
}

/** All scheduled dates of `item` in [from, to]. */
export function occurrences(item, from, to, cap = 400) {
  const out = [];
  let d = item.nextDate;
  while (d <= to && out.length < cap) {
    if (d >= from) out.push(d);
    d = nextOccurrence(d, item.frequency);
  }
  return out;
}

export const monthlyEquivalent = (item) => Math.round(item.amount * PER_MONTH[item.frequency]);

/** Items whose next date has arrived, with every missed occurrence (max 24). */
export function dueRecurring(data, today) {
  return live(data.recurring)
    .filter((r) => r.active && r.nextDate <= today)
    .map((r) => {
      const dates = occurrences(r, '1900-01-01', today, 24);
      let next = r.nextDate;
      for (let i = 0; i < dates.length; i++) next = nextOccurrence(next, r.frequency);
      return { item: r, dates, nextDate: next };
    });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Find payees that look recurring (≥3 hits, regular interval, stable amount)
 * and are not yet tracked.
 */
export function detectRecurring(data, today) {
  const tracked = new Set(live(data.recurring).map((r) => `${r.type}:${normalizePayee(r.payee)}`));
  const since = D.addDays(today, -400);
  const groups = new Map();
  for (const t of live(data.transactions)) {
    if (t.type === 'transfer' || t.date < since || t.date > today) continue;
    const key = `${t.type}:${normalizePayee(t.payee)}`;
    if (key.endsWith(':') || tracked.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = [];
  for (const [key, txs] of groups) {
    if (txs.length < 3) continue;
    txs.sort((a, b) => (a.date < b.date ? -1 : 1));
    const intervals = [];
    for (let i = 1; i < txs.length; i++) intervals.push(D.diffDays(txs[i - 1].date, txs[i].date));
    const med = median(intervals);
    const freq = Object.keys(FREQ_DAYS).find((f) => Math.abs(med - FREQ_DAYS[f]) <= TOLERANCE[f]);
    if (!freq) continue;
    const regular = intervals.filter((x) => Math.abs(x - FREQ_DAYS[freq]) <= TOLERANCE[freq] * 1.5).length / intervals.length;
    const amounts = txs.map((t) => t.amount);
    const medAmt = median(amounts);
    const stable = amounts.filter((a) => Math.abs(a - medAmt) <= medAmt * 0.2).length / amounts.length;
    if (regular < 0.75 || stable < 0.75) continue;
    const last = txs[txs.length - 1];
    if (D.diffDays(last.date, today) > FREQ_DAYS[freq] * 1.5 + 5) continue; // stopped
    let nextDate = nextOccurrence(last.date, freq);
    let guard = 0;
    while (nextDate < today && guard++ < 60) nextDate = nextOccurrence(nextDate, freq);
    out.push({
      key,
      payee: last.payee,
      type: last.type,
      amount: Math.round(medAmt),
      frequency: freq,
      nextDate,
      count: txs.length,
      categoryId: last.categoryId,
      accountId: last.accountId,
      confidence: Math.round(regular * stable * 100) / 100,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || b.amount - a.amount);
}

/**
 * Forecast liquid balance for the next `days` days.
 *  scheduled — starting liquid balance + recurring items only
 *  projected — scheduled + typical non-recurring net flow (90-day average)
 */
export function forecast(data, today, days = 90) {
  const start = netWorth(data, today).liquid;
  const end = D.addDays(today, days);
  const recurring = live(data.recurring).filter((r) => r.active);
  const recurringKeys = new Set(recurring.map((r) => normalizePayee(r.payee)));

  const events = [];
  for (const r of recurring) {
    const first = r.nextDate < today ? today : r.nextDate;
    for (const d of occurrences({ ...r, nextDate: r.nextDate }, '1900-01-01', end, 200)) {
      events.push({ date: d < today ? first : d, payee: r.payee, amount: r.amount, type: r.type, id: r.id, categoryId: r.categoryId });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));

  const since = D.addDays(today, -90);
  let discretionary = 0;
  for (const t of live(data.transactions)) {
    if (t.type === 'transfer' || t.date < since || t.date > today) continue;
    if (t.recurringId || recurringKeys.has(normalizePayee(t.payee))) continue;
    discretionary += t.type === 'income' ? t.amount : -t.amount;
  }
  const dailyNet = Math.round(discretionary / 90);

  const byDate = new Map();
  for (const e of events) byDate.set(e.date, (byDate.get(e.date) || 0) + (e.type === 'income' ? e.amount : -e.amount));

  const points = [];
  let scheduled = start;
  let projected = start;
  let lowest = { date: today, balance: start };
  for (let i = 0; i <= days; i++) {
    const d = D.addDays(today, i);
    const delta = byDate.get(d) || 0;
    scheduled += delta;
    projected += delta + (i > 0 ? dailyNet : 0);
    points.push({ date: d, scheduled, projected });
    if (projected < lowest.balance) lowest = { date: d, balance: projected };
  }
  return { start, points, events, dailyNet, lowest, end: points[points.length - 1] };
}
