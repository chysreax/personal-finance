/**
 * Pure financial analytics over a dataset. Every function is deterministic
 * given (data, today) and memoised per data snapshot, so views can call them
 * freely on every render.
 */
import { LIABILITY_TYPES, LIQUID_TYPES, UNCATEGORIZED } from './schema.js';
import * as D from './dates.js';

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const live = (arr) => arr.filter((r) => !r.deleted);

const memoStore = new WeakMap();
function memo(data, key, fn) {
  let m = memoStore.get(data);
  if (!m) memoStore.set(data, (m = new Map()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}

/** Lookup tables + live transactions sorted newest first. */
export function indexOf(data) {
  return memo(data, 'index', () => {
    const accounts = new Map(data.accounts.map((a) => [a.id, a]));
    const categories = new Map(data.categories.map((c) => [c.id, c]));
    const txs = live(data.transactions).sort((a, b) =>
      a.date === b.date ? (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt) : a.date < b.date ? 1 : -1,
    );
    return { accounts, categories, txs };
  });
}

export function categoryOf(data, id) {
  const c = indexOf(data).categories.get(id || UNCATEGORIZED);
  return c && !c.deleted ? c : indexOf(data).categories.get(UNCATEGORIZED);
}

export const liveAccounts = (data) => live(data.accounts);
export const liveCategories = (data, kind) => live(data.categories).filter((c) => !kind || c.kind === kind);
export const isLiability = (acc) => LIABILITY_TYPES.has(acc.type);

/* ---------- balances & net worth ---------- */

export function accountBalances(data, today) {
  return memo(data, `bal:${today}`, () => {
    const bal = new Map(live(data.accounts).map((a) => [a.id, a.opening]));
    for (const t of indexOf(data).txs) {
      if (t.date > today) continue;
      if (t.type === 'income') bump(bal, t.accountId, t.amount);
      else if (t.type === 'expense') bump(bal, t.accountId, -t.amount);
      else {
        bump(bal, t.accountId, -t.amount);
        bump(bal, t.toAccountId, t.amount);
      }
    }
    return bal;
  });
}
function bump(map, id, delta) {
  if (map.has(id)) map.set(id, map.get(id) + delta);
}

export function netWorth(data, today) {
  return memo(data, `nw:${today}`, () => {
    const bal = accountBalances(data, today);
    let assets = 0;
    let liabilities = 0;
    let liquid = 0;
    for (const a of live(data.accounts)) {
      const b = bal.get(a.id) ?? 0;
      if (b >= 0) assets += b;
      else liabilities += -b;
      if (LIQUID_TYPES.has(a.type)) liquid += b;
    }
    return { assets, liabilities, net: assets - liabilities, liquid };
  });
}

/** Net worth at the end of each month in `keys` (transfers are net-zero). */
export function netWorthSeries(data, keys, today) {
  return memo(data, `nws:${keys.join()}:${today}`, () => {
    const ids = new Set(live(data.accounts).map((a) => a.id));
    let running = live(data.accounts).reduce((s, a) => s + a.opening, 0);
    const asc = [...indexOf(data).txs].reverse();
    const out = [];
    let i = 0;
    for (const k of keys) {
      const end = D.monthEnd(k) < today ? D.monthEnd(k) : today;
      while (i < asc.length && asc[i].date <= end) {
        const t = asc[i++];
        if (!ids.has(t.accountId)) continue;
        if (t.type === 'income') running += t.amount;
        else if (t.type === 'expense') running -= t.amount;
        else if (!ids.has(t.toAccountId)) running -= t.amount;
      }
      out.push(running);
    }
    return out;
  });
}

/* ---------- monthly cash flow ---------- */

function monthMap(data) {
  return memo(data, 'months', () => {
    const map = new Map();
    for (const t of indexOf(data).txs) {
      if (t.type === 'transfer') continue;
      const k = D.monthKey(t.date);
      let m = map.get(k);
      if (!m) map.set(k, (m = { income: 0, expense: 0, count: 0, byCat: new Map() }));
      m[t.type] += t.amount;
      m.count++;
      const cat = t.categoryId || UNCATEGORIZED;
      m.byCat.set(cat, (m.byCat.get(cat) || 0) + t.amount);
    }
    return map;
  });
}

export function monthTotals(data, key) {
  const m = monthMap(data).get(key);
  const income = m?.income || 0;
  const expense = m?.expense || 0;
  return { key, income, expense, net: income - expense, savingsRate: income > 0 ? (income - expense) / income : null, count: m?.count || 0 };
}

export const monthlySeries = (data, keys) => keys.map((k) => monthTotals(data, k));

export function categorySpendInMonth(data, categoryId, key) {
  return monthMap(data).get(key)?.byCat.get(categoryId) || 0;
}

/** Months (before the current one) that contain any activity, newest first. */
export function historyMonths(data, today, max = 12) {
  const current = D.monthKey(today);
  return [...monthMap(data).keys()].filter((k) => k < current).sort().reverse().slice(0, max);
}

export function averageMonthly(data, today, n = 3) {
  const keys = historyMonths(data, today, n);
  if (!keys.length) {
    const cur = monthTotals(data, D.monthKey(today));
    const day = D.parseISO(today).getDate();
    const dim = D.daysInMonth(...D.monthKey(today).split('-').map(Number));
    const f = dim / Math.max(day, 1);
    return { income: cur.income, expense: Math.round(cur.expense * f), months: 0 };
  }
  const t = keys.map((k) => monthTotals(data, k));
  return {
    income: Math.round(t.reduce((s, x) => s + x.income, 0) / keys.length),
    expense: Math.round(t.reduce((s, x) => s + x.expense, 0) / keys.length),
    months: keys.length,
  };
}

/* ---------- category analytics ---------- */

export function categoryTotals(data, from, to, kind = 'expense') {
  return memo(data, `ct:${from}:${to}:${kind}`, () => {
    const map = new Map();
    let total = 0;
    for (const t of indexOf(data).txs) {
      if (t.type !== kind || t.date < from || t.date > to) continue;
      const id = categoryOf(data, t.categoryId).id;
      const e = map.get(id) || { categoryId: id, total: 0, count: 0 };
      e.total += t.amount;
      e.count++;
      map.set(id, e);
      total += t.amount;
    }
    return [...map.values()]
      .map((e) => ({ ...e, share: total ? e.total / total : 0 }))
      .sort((a, b) => b.total - a.total);
  });
}

export function topPayees(data, from, to, n = 6) {
  const map = new Map();
  for (const t of indexOf(data).txs) {
    if (t.type !== 'expense' || t.date < from || t.date > to) continue;
    const e = map.get(t.payee) || { payee: t.payee, total: 0, count: 0, categoryId: t.categoryId };
    e.total += t.amount;
    e.count++;
    map.set(t.payee, e);
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, n);
}

/** Average spend per weekday (Mon..Sun) across the range. */
export function weekdayAverages(data, from, to) {
  const totals = Array(7).fill(0);
  const days = Array(7).fill(0);
  for (let d = from, guard = 0; d <= to && guard < 4000; d = D.addDays(d, 1), guard++) {
    days[(D.parseISO(d).getDay() + 6) % 7]++;
  }
  for (const t of indexOf(data).txs) {
    if (t.type !== 'expense' || t.date < from || t.date > to) continue;
    totals[(D.parseISO(t.date).getDay() + 6) % 7] += t.amount;
  }
  return totals.map((v, i) => (days[i] ? Math.round(v / days[i]) : 0));
}

/* ---------- budgets ---------- */

/**
 * Budget status with spending-velocity projection.
 * status: 'over' (limit exceeded) | 'pace' (projected to exceed) | 'watch' (≥ warn threshold) | 'ok'
 */
export function budgetStatus(data, key, today) {
  return memo(data, `bud:${key}:${today}`, () => {
    const [y, m] = key.split('-').map(Number);
    const dim = D.daysInMonth(y, m);
    const current = D.monthKey(today) === key;
    const past = key < D.monthKey(today);
    const elapsed = current ? D.parseISO(today).getDate() : past ? dim : 0;
    const warn = data.settings.budgetWarn ?? 0.8;
    return live(data.budgets)
      .map((b) => {
        const spent = categorySpendInMonth(data, b.categoryId, key);
        const pct = spent / b.limit;
        const elapsedPct = elapsed / dim;
        const projected = current && elapsed > 0 ? Math.round((spent / elapsed) * dim) : spent;
        const daysLeft = current ? dim - elapsed + 1 : past ? 0 : dim;
        const remaining = b.limit - spent;
        let status = 'ok';
        if (spent > b.limit) status = 'over';
        else if (current && elapsed >= 5 && projected > b.limit * 1.05) status = 'pace';
        else if (pct >= warn) status = 'watch';
        return {
          budget: b,
          category: categoryOf(data, b.categoryId),
          spent,
          limit: b.limit,
          pct,
          elapsedPct,
          projected,
          remaining,
          daysLeft,
          dailyAllowance: daysLeft > 0 ? Math.max(0, Math.floor(remaining / daysLeft)) : 0,
          status,
        };
      })
      .sort((a, b) => b.pct - a.pct);
  });
}

/** Suggested monthly limit: 3-month average, rounded up to a friendly number. */
export function suggestBudget(data, categoryId, today) {
  const keys = historyMonths(data, today, 3);
  if (!keys.length) return 0;
  const avg = keys.reduce((s, k) => s + categorySpendInMonth(data, categoryId, k), 0) / keys.length;
  const step = avg > 100_000 ? 5_000 : avg > 20_000 ? 1_000 : 500;
  return Math.ceil((avg * 1.05) / step) * step;
}

/* ---------- goals ---------- */

export function goalProgress(goal, today) {
  const pct = clamp(goal.saved / goal.target);
  const remaining = Math.max(0, goal.target - goal.saved);
  const since = D.addDays(today, -90);
  const recent = goal.history.filter((h) => h.date >= since).reduce((s, h) => s + h.amount, 0);
  const avgMonthly = Math.max(0, Math.round(recent / 3));
  let monthsLeft = null;
  let requiredMonthly = null;
  if (goal.deadline) {
    monthsLeft = Math.max(0, D.diffDays(today, goal.deadline) / 30.44);
    requiredMonthly = monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining;
  }
  const projectedDate = remaining === 0 ? today : avgMonthly > 0 ? D.addDays(today, Math.ceil((remaining / avgMonthly) * 30.44)) : null;
  let status = 'no-deadline';
  if (remaining === 0) status = 'done';
  else if (goal.deadline) {
    if (goal.deadline < today) status = 'overdue';
    else status = projectedDate && projectedDate <= goal.deadline ? 'on-track' : 'behind';
  }
  return { pct, remaining, avgMonthly, monthsLeft, requiredMonthly, projectedDate, status };
}

/* ---------- financial health score ---------- */

/**
 * 0–100 composite:
 *   savings rate 30 · emergency fund 25 · budget adherence 20 · debt load 15 · spending stability 10
 */
export function healthScore(data, today) {
  return memo(data, `health:${today}`, () => {
    const comps = [];
    const hist = historyMonths(data, today, 6);
    const recent = hist.slice(0, 3).map((k) => monthTotals(data, k));
    const inc = recent.reduce((s, m) => s + m.income, 0);
    const exp = recent.reduce((s, m) => s + m.expense, 0);
    const rate = inc > 0 ? (inc - exp) / inc : null;
    comps.push({
      key: 'savings',
      label: 'Savings rate',
      max: 30,
      score: rate === null ? 0 : Math.round(30 * clamp(rate / 0.2)),
      detail: rate === null ? 'No income recorded yet' : `${Math.round(rate * 100)}% of income kept (target 20%)`,
    });

    const nw = netWorth(data, today);
    const avg = averageMonthly(data, today, 3);
    const months = avg.expense > 0 ? nw.liquid / avg.expense : nw.liquid > 0 ? 12 : 0;
    comps.push({
      key: 'emergency',
      label: 'Emergency fund',
      max: 25,
      score: Math.round(25 * clamp(months / 6)),
      detail: `${Math.max(0, months).toFixed(1)} months of expenses in liquid accounts (target 6)`,
    });

    const prevKey = D.shiftMonth(D.monthKey(today), -1);
    const statuses = [...budgetStatus(data, prevKey, today), ...budgetStatus(data, D.monthKey(today), today)];
    const within = statuses.filter((s) => s.status !== 'over').length;
    comps.push({
      key: 'budgets',
      label: 'Budget adherence',
      max: 20,
      score: statuses.length ? Math.round((20 * within) / statuses.length) : 10,
      detail: statuses.length ? `${within} of ${statuses.length} budget-months within limit` : 'Set budgets to track adherence',
    });

    const ratio = nw.assets > 0 ? nw.liabilities / nw.assets : nw.liabilities > 0 ? 1 : 0;
    comps.push({
      key: 'debt',
      label: 'Debt load',
      max: 15,
      score: Math.round(15 * clamp(1 - ratio / 0.5)),
      detail: `Liabilities are ${Math.round(ratio * 100)}% of assets`,
    });

    const series = hist.map((k) => monthTotals(data, k).expense).filter((x) => x > 0);
    let cv = null;
    if (series.length >= 2) {
      const mean = series.reduce((s, x) => s + x, 0) / series.length;
      const sd = Math.sqrt(series.reduce((s, x) => s + (x - mean) ** 2, 0) / series.length);
      cv = sd / mean;
    }
    comps.push({
      key: 'stability',
      label: 'Spending stability',
      max: 10,
      score: cv === null ? 5 : Math.round(10 * clamp(1 - (cv - 0.1) / 0.4)),
      detail: cv === null ? 'Needs two months of history' : `Monthly spending varies ±${Math.round(cv * 100)}%`,
    });

    const score = comps.reduce((s, c) => s + c.score, 0);
    const grade = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 50 ? 'Fair' : 'Needs attention';
    return { score, grade, components: comps };
  });
}

/* ---------- transaction search ---------- */

export const RANGE_PRESETS = {
  month: 'This month',
  last: 'Last month',
  '90d': 'Last 90 days',
  '12m': 'Last 12 months',
  ytd: 'Year to date',
  all: 'All time',
};

export function rangeFor(preset, today) {
  const k = D.monthKey(today);
  switch (preset) {
    case 'month':
      return [D.monthStart(k), D.monthEnd(k)];
    case 'last': {
      const p = D.shiftMonth(k, -1);
      return [D.monthStart(p), D.monthEnd(p)];
    }
    case '90d':
      return [D.addDays(today, -89), today];
    case '3m':
      return [D.monthStart(D.shiftMonth(k, -2)), D.monthEnd(k)];
    case '6m':
      return [D.monthStart(D.shiftMonth(k, -5)), D.monthEnd(k)];
    case '12m':
      return [D.monthStart(D.shiftMonth(k, -11)), D.monthEnd(k)];
    case 'ytd':
      return [`${today.slice(0, 4)}-01-01`, D.monthEnd(k)];
    default:
      return ['1900-01-01', '2200-12-31'];
  }
}

/**
 * @param {object} data
 * @param {{q?: string, type?: string, categoryId?: string, accountId?: string, tag?: string, from?: string, to?: string, sort?: string}} f
 */
export function filterTransactions(data, f) {
  const { categories, accounts, txs } = indexOf(data);
  const q = (f.q || '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const out = txs.filter((t) => {
    if (f.type && f.type !== 'all' && t.type !== f.type) return false;
    if (f.categoryId && (t.categoryId || '') !== f.categoryId) return false;
    if (f.accountId && t.accountId !== f.accountId && t.toAccountId !== f.accountId) return false;
    if (f.tag && !t.tags.includes(f.tag)) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (terms.length) {
      const hay = [
        t.payee,
        t.note,
        t.tags.map((x) => `#${x}`).join(' '),
        categories.get(t.categoryId)?.name || '',
        accounts.get(t.accountId)?.name || '',
        (t.amount / 100).toFixed(2),
      ]
        .join(' ')
        .toLowerCase();
      if (!terms.every((term) => hay.includes(term))) return false;
    }
    return true;
  });
  switch (f.sort) {
    case 'date-asc':
      return out.reverse();
    case 'amount-desc':
      return out.sort((a, b) => b.amount - a.amount);
    case 'amount-asc':
      return out.sort((a, b) => a.amount - b.amount);
    default:
      return out;
  }
}

export function allTags(data) {
  return memo(data, 'tags', () => {
    const counts = new Map();
    for (const t of indexOf(data).txs) for (const tag of t.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  });
}

export function knownPayees(data) {
  return memo(data, 'payees', () => {
    const counts = new Map();
    for (const t of indexOf(data).txs) if (t.type !== 'transfer') counts.set(t.payee, (counts.get(t.payee) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([p]) => p);
  });
}
