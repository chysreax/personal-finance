import { h } from '../dom.js';
import { card, segmented, emptyState, select, statCard } from '../components.js';
import { barChart, lineChart, donutChart, hbarList, heatStrip } from '../charts.js';
import { pageHeader } from './shared.js';
import * as D from '../../core/dates.js';
import { formatPct } from '../../core/money.js';
import { monthlySeries, netWorthSeries, categoryTotals, categoryOf, topPayees, weekdayAverages, categorySpendInMonth, liveCategories, indexOf } from '../../core/finance.js';
import { generateInsights } from '../../core/insights.js';
import { insightItem } from './shared.js';

export const title = 'Analytics';

const RANGES = [
  { value: 3, label: '3M' },
  { value: 6, label: '6M' },
  { value: 12, label: '12M' },
  { value: 'ytd', label: 'YTD' },
  { value: 'all', label: 'All' },
];
const state = { range: 6, category: null };

function monthsFor(range, data, today) {
  if (range === 'ytd') return D.monthsBetween(`${today.slice(0, 4)}-01`, D.monthKey(today));
  if (range === 'all') {
    const txs = indexOf(data).txs;
    const first = txs.length ? D.monthKey(txs[txs.length - 1].date) : D.monthKey(today);
    const keys = D.monthsBetween(first, D.monthKey(today));
    return keys.length > 60 ? keys.slice(-60) : keys;
  }
  return D.lastNMonths(range, today);
}

export function render(app) {
  const data = app.data;
  const today = app.today();
  const money = app.money;
  const compact = (c) => app.money(c, { compact: true });
  const months = monthsFor(state.range, data, today);
  const from = D.monthStart(months[0]);
  const to = D.monthEnd(months[months.length - 1]) > today ? today : D.monthEnd(months[months.length - 1]);

  const rangeCtl = segmented(RANGES, state.range, (v) => {
    state.range = v;
    app.rerender();
  }, { label: 'Time range' });

  if (!indexOf(data).txs.length) {
    return h('div', { class: 'view' }, pageHeader('Analytics', null, rangeCtl), card(null, {}, emptyState({ icon: 'chart', title: 'No data to analyze yet', text: 'Add or import transactions to unlock charts and insights.' })));
  }

  const labels = months.map((k) => (months.length > 12 ? `${D.monthLabel(k, 'tiny')}${k.slice(2, 4)}` : D.monthLabel(k)));
  const fullLabels = months.map((k) => D.monthLabel(k, 'long'));
  const series = monthlySeries(data, months);
  // Averages use complete months only, so a partial current month never drags them down.
  const complete = series.filter((m) => m.key < D.monthKey(today));
  const basis = complete.length ? complete : series;
  const totalInc = basis.reduce((s, m) => s + m.income, 0);
  const totalExp = basis.reduce((s, m) => s + m.expense, 0);
  const best = series.reduce((b, m) => (m.net > (b?.net ?? -Infinity) ? m : b), null);
  const cats = categoryTotals(data, from, to, 'expense');

  const kpis = h(
    'div',
    { class: 'kpi-grid' },
    statCard({ label: 'Avg. monthly income', value: money(Math.round(totalInc / basis.length)), icon: 'up', foot: `over ${basis.length} complete month${basis.length === 1 ? '' : 's'}` }),
    statCard({ label: 'Avg. monthly spending', value: money(Math.round(totalExp / basis.length)), icon: 'down' }),
    statCard({ label: 'Savings rate', value: totalInc ? formatPct((totalInc - totalExp) / totalInc) : '—', icon: 'pulse', foot: `${money(totalInc - totalExp, { sign: true })} kept` }),
    statCard({ label: 'Best month', value: best ? D.monthLabel(best.key, 'long') : '—', icon: 'trendUp', foot: best ? `${money(best.net, { sign: true })} net` : '' }),
  );

  const flow = card(
    'Income vs. spending',
    { subtitle: `${fullLabels[0]} – ${fullLabels[fullLabels.length - 1]}` },
    barChart({
      labels, fullLabels,
      series: [{ name: 'Income', values: series.map((x) => x.income), slot: 0 }, { name: 'Spending', values: series.map((x) => x.expense), slot: 1 }],
      format: money, formatAxis: compact, height: 260, caption: 'Monthly income and spending',
    }),
  );

  const net = card(
    'Net cash flow',
    { subtitle: 'Income minus spending per month' },
    barChart({ labels, fullLabels, series: [{ name: 'Net', values: series.map((x) => x.net), slot: 2 }], format: (v) => money(v, { sign: true }), formatAxis: compact, height: 200, caption: 'Monthly net cash flow' }),
  );

  const nw = card(
    'Net worth trend',
    { subtitle: 'Month-end, all accounts' },
    lineChart({ labels, fullLabels, series: [{ name: 'Net worth', values: netWorthSeries(data, months, today), slot: 0, area: true }], format: money, formatAxis: compact, height: 220, zero: false, caption: 'Net worth over time' }),
  );

  const top = cats.slice(0, 7);
  const rest = cats.slice(7).reduce((s, c) => s + c.total, 0);
  const items = top.map((c) => {
    const cat = categoryOf(data, c.categoryId);
    return { id: c.categoryId, label: cat.name, icon: cat.icon, value: c.total, slot: cat.color };
  });
  if (rest) items.push({ id: 'other', label: 'Other', value: rest, slot: -1 });
  if (!state.category || !cats.some((c) => c.categoryId === state.category)) state.category = cats[0]?.categoryId || null;

  const breakdown = card(
    'Spending by category',
    { subtitle: 'Click a category to see its trend' },
    items.length
      ? donutChart({ items, format: money, centerLabel: 'Total spent', size: 200, onSelect: (it) => { if (it.id !== 'other') { state.category = it.id; app.rerender(); } } })
      : emptyState({ icon: 'chart', title: 'No spending in this range' }),
  );

  const catSelect = select(
    liveCategories(data, 'expense').map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` })),
    state.category,
    { class: 'input input-sm', 'aria-label': 'Category', onchange: (e) => { state.category = e.target.value; app.rerender(); } },
  );
  const catVals = months.map((k) => categorySpendInMonth(data, state.category, k));
  const avg = Math.round(catVals.reduce((s, v) => s + v, 0) / Math.max(1, catVals.length));
  const catCat = categoryOf(data, state.category);
  const trend = card(
    'Category trend',
    { subtitle: `Average ${money(avg)}/month`, actions: catSelect },
    lineChart({
      labels, fullLabels,
      series: [{ name: catCat.name, values: catVals, slot: catCat.color < 0 ? 0 : catCat.color, area: true }],
      format: money, formatAxis: compact, height: 220, caption: `${catCat.name} spending by month`,
    }),
  );

  const payees = topPayees(data, from, to, 8);
  const payeeCard = card(
    'Top merchants',
    { subtitle: 'Where you spend most often' },
    payees.length
      ? hbarList(payees.map((p) => ({ label: p.payee, value: p.total, sub: `${p.count} transaction${p.count === 1 ? '' : 's'} · ${categoryOf(data, p.categoryId).name}`, categoryId: p.categoryId })), {
          format: money,
          slotOf: (it) => Math.max(0, categoryOf(data, it.categoryId).color),
        })
      : emptyState({ icon: 'list', title: 'No merchants yet' }),
  );

  const wd = weekdayAverages(data, from, to);
  const weekday = card(
    'Spending by weekday',
    { subtitle: 'Average spend per day of week' },
    heatStrip(wd, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], { format: money }),
    h('p', { class: 'small muted mt' }, (() => {
      const max = Math.max(...wd);
      const i = wd.indexOf(max);
      return max ? `${['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][i]} are your biggest spending days (${money(max)} on average).` : '';
    })()),
  );

  const insights = generateInsights(data, today);
  const insightCard = card('Recommendations', { subtitle: `${insights.length} insight${insights.length === 1 ? '' : 's'} from your patterns` }, insights.length ? h('ul', { class: 'insights' }, insights.map((i) => insightItem(app, i))) : emptyState({ icon: 'sparkle', title: 'All clear' }));

  return h(
    'div',
    { class: 'view' },
    pageHeader('Analytics', 'Trends, distributions and patterns in your money.', rangeCtl),
    kpis,
    h('div', { class: 'grid grid-2' }, flow, breakdown),
    h('div', { class: 'grid grid-2' }, nw, trend),
    h('div', { class: 'grid grid-3' }, payeeCard, h('div', { class: 'stack' }, net, weekday), insightCard),
  );
}
