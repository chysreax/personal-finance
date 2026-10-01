import { h } from '../dom.js';
import { icon } from '../icons.js';
import { card, statCard, emptyState, progressBar, categoryDot } from '../components.js';
import { barChart, donutChart, sparkline, gauge } from '../charts.js';
import { pageHeader, button, insightItem, txRow, statusBadge, toneFor } from './shared.js';
import * as D from '../../core/dates.js';
import { formatPct } from '../../core/money.js';
import {
  netWorth, netWorthSeries, monthTotals, monthlySeries, categoryTotals, categoryOf, budgetStatus, healthScore, indexOf, liveAccounts, accountBalances, isLiability,
} from '../../core/finance.js';
import { generateInsights } from '../../core/insights.js';
import { forecast, dueRecurring } from '../../core/recurring.js';
import { ACCOUNT_TYPE_LABEL } from '../forms.js';

export const title = 'Dashboard';

export function render(app) {
  const data = app.data;
  const today = app.today();
  const key = D.monthKey(today);
  const money = app.money;
  const compact = (c) => app.money(c, { compact: true });

  if (!liveAccounts(data).length && !indexOf(data).txs.length) {
    return h(
      'div',
      { class: 'view' },
      pageHeader('Welcome 👋', 'Let’s set up your finances.'),
      card(
        null,
        {},
        emptyState({
          icon: 'bank',
          title: 'Add your first account',
          text: 'Accounts hold your balances — checking, savings, credit cards, loans. Then add transactions or import a CSV from your bank.',
          action: { label: 'Add account', fn: () => app.forms.account() },
        }),
      ),
    );
  }

  const nw = netWorth(data, today);
  const months12 = D.lastNMonths(12, today);
  const nwSeries = netWorthSeries(data, months12, today);
  const prevNw = nwSeries[nwSeries.length - 2] ?? nw.net;
  const nwDelta = nw.net - prevNw;
  const cur = monthTotals(data, key);
  const prev = monthTotals(data, D.shiftMonth(key, -1));
  const day = D.parseISO(today).getDate();
  const dim = D.daysInMonth(+key.slice(0, 4), +key.slice(5));
  const budgets = budgetStatus(data, key, today);
  const budgetTotal = budgets.reduce((s, b) => s + b.limit, 0);

  const pctDelta = (a, b) => (b ? (a - b) / b : null);
  // Compare month-to-date spend with the same days of last month (fair on day 1 and day 30 alike).
  const prevKey = D.shiftMonth(key, -1);
  const prevMtd = indexOf(data).txs.reduce((s, t) => (t.type === 'expense' && D.monthKey(t.date) === prevKey && +t.date.slice(8) <= day ? s + t.amount : s), 0);
  const expDelta = pctDelta(cur.expense, prevMtd);

  const kpis = h(
    'div',
    { class: 'kpi-grid' },
    statCard({
      label: 'Net worth',
      value: money(nw.net),
      icon: 'bank',
      delta: `${nwDelta >= 0 ? '▲' : '▼'} ${compact(Math.abs(nwDelta))}`,
      deltaTone: nwDelta >= 0 ? 'pos' : 'neg',
      foot: 'vs last month',
      spark: sparkline(nwSeries, { slot: 0 }),
      tone: 'hero',
    }),
    statCard({
      label: `Income · ${D.monthLabel(key, 'long')}`,
      value: money(cur.income),
      icon: 'up',
      foot: `Last month ${compact(prev.income)}`,
    }),
    statCard({
      label: 'Spending this month',
      value: money(cur.expense),
      icon: 'down',
      delta: expDelta === null ? null : Math.abs(expDelta) < 0.005 ? '= 0%' : `${expDelta > 0 ? '▲' : '▼'} ${formatPct(Math.abs(expDelta))}`,
      deltaTone: expDelta === null || Math.abs(expDelta) < 0.005 ? 'neutral' : expDelta > 0 ? 'neg' : 'pos',
      foot: budgetTotal ? `vs last month · ${compact(budgetTotal)} budgeted` : 'vs same point last month',
    }),
    statCard({
      label: 'Net cash flow',
      value: money(cur.net, { sign: true }),
      icon: 'pulse',
      foot: cur.savingsRate === null ? 'No income yet this month' : `Savings rate ${formatPct(cur.savingsRate)}`,
      tone: cur.net >= 0 ? 'pos' : 'neg',
    }),
  );

  // Cash flow chart — last 6 months.
  const m6 = D.lastNMonths(6, today);
  const series = monthlySeries(data, m6);
  const flow = card(
    'Cash flow',
    { subtitle: 'Income vs. spending, last 6 months', actions: button('Analytics', { variant: 'ghost', size: 'sm', icon: 'chart', onClick: () => app.navigate('analytics') }) },
    barChart({
      labels: m6.map((k) => D.monthLabel(k)),
      fullLabels: m6.map((k) => D.monthLabel(k, 'long')),
      series: [
        { name: 'Income', values: series.map((x) => x.income), slot: 0 },
        { name: 'Spending', values: series.map((x) => x.expense), slot: 1 },
      ],
      format: money,
      formatAxis: compact,
      height: 240,
      caption: 'Monthly income and spending',
    }),
    (() => {
      const done = series.slice(0, -1);
      const inc = done.reduce((s, m) => s + m.income, 0) / Math.max(1, done.length);
      const exp = done.reduce((s, m) => s + m.expense, 0) / Math.max(1, done.length);
      return h(
        'dl',
        { class: 'flow-summary' },
        h('div', {}, h('dt', {}, 'Avg. income'), h('dd', {}, money(Math.round(inc)))),
        h('div', {}, h('dt', {}, 'Avg. spending'), h('dd', {}, money(Math.round(exp)))),
        h('div', {}, h('dt', {}, 'Avg. saved'), h('dd', { class: inc - exp >= 0 ? 'pos' : 'neg' }, money(Math.round(inc - exp), { sign: true }))),
        h('div', {}, h('dt', {}, 'Savings rate'), h('dd', {}, inc ? formatPct((inc - exp) / inc) : '—')),
      );
    })(),
  );

  // Health score.
  const hs = healthScore(data, today);
  const health = card(
    'Financial health',
    { subtitle: hs.grade },
    h('div', { class: 'health' }, gauge(hs.score, { label: 'out of 100' })),
    h(
      'ul',
      { class: 'health-list' },
      hs.components.map((c) =>
        h(
          'li',
          { title: c.detail },
          h('div', { class: 'row between' }, h('span', {}, c.label), h('span', { class: 'num muted' }, `${c.score}/${c.max}`)),
          progressBar(c.score / c.max, { tone: c.score / c.max >= 0.7 ? 'success' : c.score / c.max >= 0.4 ? 'warning' : 'danger', label: c.label }),
          h('p', { class: 'small muted' }, c.detail),
        ),
      ),
    ),
  );

  // Spending donut — rolling 30 days, so it is meaningful on the 1st of the month too.
  const from30 = D.addDays(today, -29);
  const cats = categoryTotals(data, from30, today, 'expense');
  const top = cats.slice(0, 6);
  const rest = cats.slice(6).reduce((s, c) => s + c.total, 0);
  const items = top.map((c) => {
    const cat = categoryOf(data, c.categoryId);
    return { id: c.categoryId, label: cat.name, icon: cat.icon, value: c.total, slot: cat.color };
  });
  if (rest > 0) items.push({ id: 'other', label: 'Other', value: rest, slot: -1 });
  const spend = card(
    'Where your money went',
    { subtitle: 'Last 30 days by category' },
    items.length
      ? donutChart({
          items,
          format: money,
          centerLabel: 'Spent',
          size: 180,
          onSelect: (it) => it.id !== 'other' && app.navigate(`transactions?category=${it.id}&range=90d`),
        })
      : emptyState({ icon: 'chart', title: 'No spending in the last 30 days' }),
  );

  // Budgets snapshot.
  const budgetCard = card(
    'Budgets',
    { subtitle: `${dim - day} days left in ${D.monthLabel(key, 'long')}`, actions: button('Manage', { variant: 'ghost', size: 'sm', onClick: () => app.navigate('budgets') }) },
    budgets.length
      ? h(
          'ul',
          { class: 'mini-budgets' },
          budgets.slice(0, 5).map((b) =>
            h(
              'li',
              {},
              h('div', { class: 'row between' }, h('span', { class: 'row gap-sm' }, categoryDot(b.category, 'sm'), b.category.name), statusBadge(b.status)),
              progressBar(b.pct, { tone: toneFor(b.status), marker: b.elapsedPct, label: `${b.category.name} budget` }),
              h('div', { class: 'row between small muted' }, h('span', {}, `${money(b.spent)} of ${money(b.limit)}`), h('span', {}, b.remaining >= 0 ? `${money(b.remaining)} left` : `${money(-b.remaining)} over`)),
            ),
          ),
        )
      : emptyState({ icon: 'wallet', title: 'No budgets yet', text: 'Set monthly limits and get alerts when you’re on pace to overspend.', action: { label: 'Create budget', fn: () => app.navigate('budgets') } }),
  );

  // Insights.
  const insights = generateInsights(data, today);
  const insightCard = card(
    'Insights',
    { subtitle: 'Automated recommendations from your activity' },
    insights.length
      ? h('ul', { class: 'insights' }, insights.slice(0, 4).map((i) => insightItem(app, i)))
      : emptyState({ icon: 'sparkle', title: 'All clear', text: 'Nothing needs your attention right now.' }),
  );

  // Upcoming bills.
  const fc = forecast(data, today, 30);
  const due = dueRecurring(data, today);
  const upcoming = card(
    'Upcoming',
    { subtitle: 'Scheduled in the next 30 days', actions: button('Recurring', { variant: 'ghost', size: 'sm', onClick: () => app.navigate('recurring') }) },
    due.length
      ? h(
          'div',
          { class: 'callout callout-action' },
          icon('zap', 16),
          h('span', {}, `${due.length} payment${due.length === 1 ? ' is' : 's are'} due`),
          button('Post now', { size: 'sm', variant: 'primary', onClick: () => app.actions.postDue() }),
        )
      : null,
    fc.events.length
      ? h(
          'ul',
          { class: 'upcoming' },
          fc.events.slice(0, 6).map((e) =>
            h(
              'li',
              {},
              h('span', { class: 'up-date' }, D.relativeDay(e.date, today)),
              categoryDot(categoryOf(data, e.categoryId), 'sm'),
              h('span', { class: 'up-name' }, e.payee),
              h('span', { class: `num ${e.type === 'income' ? 'pos' : ''}` }, `${e.type === 'income' ? '+' : '−'}${money(e.amount)}`),
            ),
          ),
        )
      : emptyState({ icon: 'calendar', title: 'Nothing scheduled', text: 'Track bills and paychecks to forecast your cash.' }),
  );

  // Recent transactions.
  const recent = indexOf(data).txs.filter((t) => t.date <= today).slice(0, 6);
  const recentCard = card(
    'Recent activity',
    { actions: button('View all', { variant: 'ghost', size: 'sm', onClick: () => app.navigate('transactions') }) },
    recent.length ? h('ul', { class: 'tx-list compact' }, recent.map((t) => txRow(app, t, { showDate: true }))) : emptyState({ icon: 'list', title: 'No transactions yet' }),
  );

  // Accounts.
  const bal = accountBalances(data, today);
  const accCard = card(
    'Accounts',
    { actions: button('Manage', { variant: 'ghost', size: 'sm', onClick: () => app.navigate('accounts') }) },
    h(
      'ul',
      { class: 'acc-mini' },
      liveAccounts(data)
        .filter((a) => !a.archived)
        .map((a) =>
          h(
            'li',
            {},
            h('span', { class: `acc-chip slot-bg-${a.color}` }),
            h('span', { class: 'acc-name' }, a.name, h('span', { class: 'small muted' }, ACCOUNT_TYPE_LABEL[a.type])),
            h('span', { class: `num ${isLiability(a) || bal.get(a.id) < 0 ? 'neg' : ''}` }, money(bal.get(a.id) ?? 0)),
          ),
        ),
    ),
    h('div', { class: 'acc-total row between' }, h('span', { class: 'muted' }, 'Assets / Liabilities'), h('span', { class: 'num' }, `${compact(nw.assets)} / ${compact(nw.liabilities)}`)),
  );

  const greeting = (() => {
    const hr = new Date().getHours();
    return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  })();

  return h(
    'div',
    { class: 'view' },
    pageHeader(greeting, D.formatDate(today, 'long'), [
      button('Add transaction', { variant: 'primary', icon: 'plus', onClick: () => app.forms.transaction(), cls: 'hide-sm' }),
    ]),
    kpis,
    h('div', { class: 'grid grid-2-1' }, flow, health),
    h('div', { class: 'grid grid-3' }, spend, budgetCard, insightCard),
    h('div', { class: 'grid grid-3' }, upcoming, recentCard, accCard),
  );
}
