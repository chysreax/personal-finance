/**
 * Rule-based insight engine: turns transaction patterns into short,
 * actionable recommendations. Each insight is plain data; the UI decides how
 * to render it (never as HTML).
 */
import * as D from './dates.js';
import { formatMoney, formatPct } from './money.js';
import { UNCATEGORIZED } from './schema.js';
import {
  live, indexOf, categoryOf, budgetStatus, monthTotals, historyMonths, averageMonthly, netWorth, goalProgress,
} from './finance.js';
import { detectRecurring, dueRecurring, forecast, monthlyEquivalent } from './recurring.js';

const RANK = { critical: 0, warning: 1, action: 2, info: 3, positive: 4 };

/**
 * @typedef {{id: string, severity: 'critical'|'warning'|'action'|'info'|'positive', title: string, detail: string,
 *   action?: {label: string, route?: string, command?: string}}} Insight
 * @returns {Insight[]}
 */
export function generateInsights(data, today) {
  const cur = data.settings.currency;
  const money = (c) => formatMoney(c, cur, { whole: Math.abs(c) >= 100_000 });
  const out = [];
  const key = D.monthKey(today);
  const day = D.parseISO(today).getDate();

  // 1. Cash-flow forecast dips below zero.
  if (live(data.accounts).length) {
    const fc = forecast(data, today, 60);
    if (fc.lowest.balance < 0 && fc.start >= 0) {
      out.push({
        id: 'forecast-negative',
        severity: 'critical',
        title: `Cash may run short around ${D.formatDate(fc.lowest.date, 'short')}`,
        detail: `Projected liquid balance bottoms out at ${money(fc.lowest.balance)} based on scheduled bills and your typical spending.`,
        action: { label: 'View forecast', route: 'recurring' },
      });
    }
  }

  // 2. Budget velocity alerts.
  for (const s of budgetStatus(data, key, today)) {
    if (s.status === 'over') {
      out.push({
        id: `budget-over-${s.budget.id}`,
        severity: 'critical',
        title: `${s.category.name} is over budget`,
        detail: `${money(s.spent)} spent of ${money(s.limit)} (${formatPct(s.pct)}). ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left this month.`,
        action: { label: 'Review budget', route: 'budgets' },
      });
    } else if (s.status === 'pace') {
      out.push({
        id: `budget-pace-${s.budget.id}`,
        severity: 'warning',
        title: `${s.category.name} is on pace to exceed its budget`,
        detail: `At the current rate you'll spend ~${money(s.projected)} vs a ${money(s.limit)} limit. Keep it under ${money(s.dailyAllowance)}/day to stay on track.`,
        action: { label: 'See budgets', route: 'budgets' },
      });
    }
  }

  // 3. Due recurring payments.
  const due = dueRecurring(data, today);
  if (due.length) {
    const n = due.reduce((s, d) => s + d.dates.length, 0);
    out.push({
      id: 'recurring-due',
      severity: 'action',
      title: `${n} scheduled payment${n === 1 ? ' is' : 's are'} due`,
      detail: due.slice(0, 3).map((d) => `${d.item.payee} ${money(d.item.amount)}`).join(' · '),
      action: { label: 'Post now', command: 'post-due' },
    });
  }

  // 4. Category spikes: month-to-date vs the same days of the previous 3 months.
  const prev = historyMonths(data, today, 3);
  if (prev.length >= 2 && day >= 5) {
    const mtd = new Map();
    const base = new Map();
    for (const t of indexOf(data).txs) {
      if (t.type !== 'expense') continue;
      const d = +t.date.slice(8, 10);
      if (d > day) continue;
      const k = D.monthKey(t.date);
      const cat = t.categoryId || UNCATEGORIZED;
      if (k === key) mtd.set(cat, (mtd.get(cat) || 0) + t.amount);
      else if (prev.includes(k)) base.set(cat, (base.get(cat) || 0) + t.amount / prev.length);
    }
    const spikes = [...mtd.entries()]
      .map(([cat, v]) => ({ cat, v, avg: base.get(cat) || 0 }))
      .filter((x) => x.avg > 0 && x.v > x.avg * 1.4 && x.v - x.avg > 5_000)
      .sort((a, b) => b.v - b.avg - (a.v - a.avg))
      .slice(0, 2);
    for (const s of spikes) {
      const c = categoryOf(data, s.cat);
      out.push({
        id: `spike-${s.cat}`,
        severity: 'warning',
        title: `${c.name} spending is up ${Math.round((s.v / s.avg - 1) * 100)}%`,
        detail: `${money(s.v)} so far this month vs a typical ${money(Math.round(s.avg))} by day ${day}.`,
        action: { label: 'Explore', route: `transactions?category=${s.cat}&range=month` },
      });
    }
  }

  // 5. Savings rate.
  const last = prev[0] ? monthTotals(data, prev[0]) : null;
  if (last && last.income > 0) {
    const r = last.savingsRate;
    if (r < 0) {
      out.push({
        id: 'savings-negative',
        severity: 'warning',
        title: `You spent more than you earned in ${D.monthLabel(prev[0], 'long')}`,
        detail: `Expenses exceeded income by ${money(-last.net)}. Review the biggest categories to find quick wins.`,
        action: { label: 'Analyze', route: 'analytics' },
      });
    } else if (r < 0.1) {
      out.push({
        id: 'savings-low',
        severity: 'info',
        title: `Savings rate was ${formatPct(r)} last month`,
        detail: `Raising it to 20% means keeping ${money(Math.round(last.income * 0.2))}/month. Automating a transfer on payday helps.`,
      });
    } else if (r >= 0.2) {
      out.push({
        id: 'savings-great',
        severity: 'positive',
        title: `Great month: you saved ${formatPct(r)} of income`,
        detail: `${money(last.net)} kept in ${D.monthLabel(prev[0], 'long')} — above the 20% benchmark.`,
      });
    }
  }

  // 6. Emergency fund coverage.
  const nw = netWorth(data, today);
  const avg = averageMonthly(data, today, 3);
  if (avg.expense > 0 && live(data.accounts).length) {
    const months = nw.liquid / avg.expense;
    if (months < 3) {
      out.push({
        id: 'emergency-low',
        severity: 'warning',
        title: `Emergency fund covers ${Math.max(0, months).toFixed(1)} months`,
        detail: `Aim for 3–6 months (${money(avg.expense * 3)}–${money(avg.expense * 6)}). A dedicated savings goal makes progress visible.`,
        action: { label: 'Create goal', route: 'goals' },
      });
    } else if (months >= 6) {
      out.push({
        id: 'emergency-good',
        severity: 'positive',
        title: `Solid safety net: ${months.toFixed(1)} months of expenses`,
        detail: 'Consider investing surplus cash beyond 6 months of expenses.',
      });
    }
  }

  // 7. Subscriptions total.
  const subs = live(data.recurring).filter((r) => r.active && r.type === 'expense' && r.categoryId === 'cat_subscriptions');
  if (subs.length >= 2) {
    const monthly = subs.reduce((s, r) => s + monthlyEquivalent(r), 0);
    out.push({
      id: 'subscriptions',
      severity: 'info',
      title: `${subs.length} subscriptions cost ${money(monthly)}/month`,
      detail: `That's ${money(monthly * 12)} a year. Cancelling one you rarely use is the easiest saving there is.`,
      action: { label: 'Review', route: 'recurring' },
    });
  }

  // 8. Unusually large recent expense (> mean + 3σ within its category).
  const recentFrom = D.addDays(today, -14);
  const byCat = new Map();
  for (const t of indexOf(data).txs) {
    if (t.type !== 'expense') continue;
    if (!byCat.has(t.categoryId)) byCat.set(t.categoryId, []);
    byCat.get(t.categoryId).push(t);
  }
  const outliers = [];
  for (const [, txs] of byCat) {
    const older = txs.filter((t) => t.date < recentFrom);
    if (older.length < 5) continue;
    const mean = older.reduce((s, t) => s + t.amount, 0) / older.length;
    const sd = Math.sqrt(older.reduce((s, t) => s + (t.amount - mean) ** 2, 0) / older.length);
    for (const t of txs) if (t.date >= recentFrom && t.date <= today && t.amount > mean + 3 * sd && t.amount > 2_000) outliers.push({ t, mean });
  }
  outliers.sort((a, b) => b.t.amount - a.t.amount);
  for (const { t, mean } of outliers.slice(0, 1)) {
    out.push({
      id: `outlier-${t.id}`,
      severity: 'info',
      title: `Unusual expense: ${t.payee}`,
      detail: `${money(t.amount)} on ${D.formatDate(t.date, 'short')} — about ${(t.amount / mean).toFixed(1)}× your usual ${categoryOf(data, t.categoryId).name.toLowerCase()} spend.`,
      action: { label: 'View', route: `transactions?q=${encodeURIComponent(t.payee)}` },
    });
  }

  // 9. Possible duplicates (same payee + amount within 1 day, last 30 days).
  const dupFrom = D.addDays(today, -30);
  const seen = new Map();
  let dupes = 0;
  for (const t of indexOf(data).txs) {
    if (t.date < dupFrom || t.type === 'transfer') continue;
    const k = `${t.payee.toLowerCase()}|${t.amount}|${t.type}`;
    const prior = seen.get(k);
    if (prior && Math.abs(D.diffDays(prior, t.date)) <= 1) dupes++;
    seen.set(k, t.date);
  }
  if (dupes) {
    out.push({
      id: 'duplicates',
      severity: 'info',
      title: `${dupes} possible duplicate transaction${dupes === 1 ? '' : 's'}`,
      detail: 'Same payee and amount recorded within a day of each other — worth a quick check.',
      action: { label: 'Review', route: 'transactions?range=90d' },
    });
  }

  // 10. Goals behind schedule.
  for (const g of live(data.goals)) {
    const p = goalProgress(g, today);
    if (p.status === 'behind' && p.requiredMonthly) {
      out.push({
        id: `goal-${g.id}`,
        severity: 'info',
        title: `"${g.name}" needs ${money(p.requiredMonthly)}/month`,
        detail: p.avgMonthly
          ? `You're contributing ~${money(p.avgMonthly)}/month; at that pace you'd finish ${p.projectedDate ? D.formatDate(p.projectedDate) : 'later'}.`
          : `No contributions in the last 90 days. ${money(p.remaining)} to go before ${D.formatDate(g.deadline)}.`,
        action: { label: 'Open goals', route: 'goals' },
      });
    } else if (p.status === 'done') {
      out.push({ id: `goal-done-${g.id}`, severity: 'positive', title: `Goal reached: ${g.name} 🎉`, detail: `You saved ${money(g.target)}.` });
    }
  }

  // 11. Recurring payments detected but not tracked.
  const found = detectRecurring(data, today);
  if (found.length) {
    out.push({
      id: 'recurring-detected',
      severity: 'action',
      title: `${found.length} recurring payment${found.length === 1 ? '' : 's'} detected`,
      detail: `${found.slice(0, 3).map((f) => f.payee).join(', ')} — track them to improve your forecast.`,
      action: { label: 'Review', route: 'recurring' },
    });
  }

  // 12. Uncategorised transactions.
  const uncategorized = indexOf(data).txs.filter((t) => t.type !== 'transfer' && (t.categoryId || UNCATEGORIZED) === UNCATEGORIZED).length;
  if (uncategorized) {
    out.push({
      id: 'uncategorized',
      severity: 'action',
      title: `${uncategorized} uncategorized transaction${uncategorized === 1 ? '' : 's'}`,
      detail: 'Auto-categorize them using your history and merchant rules.',
      action: { label: 'Auto-categorize', command: 'auto-categorize' },
    });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
