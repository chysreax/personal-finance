import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoData } from '../js/core/demo.js';
import { normalizeData } from '../js/core/schema.js';
import { netWorth, accountBalances, monthTotals, budgetStatus, healthScore, filterTransactions, goalProgress, netWorthSeries } from '../js/core/finance.js';
import { suggestCategory, normalizePayee } from '../js/core/categorize.js';
import { detectRecurring, forecast, dueRecurring, nextOccurrence } from '../js/core/recurring.js';
import { generateInsights } from '../js/core/insights.js';
import { lastNMonths, addMonths } from '../js/core/dates.js';
import { createStore } from '../js/state/store.js';

const TODAY = '2026-09-18';
const demo = generateDemoData(TODAY, 42);

test('demo data passes the sanitiser untouched', () => {
  const { data, dropped } = normalizeData(JSON.parse(JSON.stringify(demo)));
  assert.equal(dropped, 0);
  assert.equal(data.transactions.length, demo.transactions.length);
});

test('balances: transfers move money, net worth = assets − liabilities', () => {
  const bal = accountBalances(demo, TODAY);
  const nw = netWorth(demo, TODAY);
  const sum = [...bal.values()].reduce((s, v) => s + v, 0);
  assert.equal(nw.net, sum);
  assert.equal(nw.assets - nw.liabilities, nw.net);
  // net-worth series ends at today's net worth
  const series = netWorthSeries(demo, lastNMonths(12, TODAY), TODAY);
  assert.equal(series[series.length - 1], nw.net);
});

test('monthly totals exclude transfers', () => {
  const m = monthTotals(demo, '2026-08');
  assert.ok(m.income >= 520_000);
  const transfersAug = demo.transactions.filter((t) => t.type === 'transfer' && t.date.startsWith('2026-08'));
  assert.ok(transfersAug.length > 0);
  assert.equal(m.net, m.income - m.expense);
});

test('budget velocity projects month-end spend', () => {
  const s = budgetStatus(demo, '2026-09', TODAY);
  assert.ok(s.length >= 5);
  for (const b of s) {
    assert.equal(b.projected, Math.round((b.spent / 18) * 30));
    assert.ok(['ok', 'watch', 'pace', 'over'].includes(b.status));
  }
});

test('health score is bounded with five components', () => {
  const hs = healthScore(demo, TODAY);
  assert.equal(hs.components.length, 5);
  assert.ok(hs.score >= 0 && hs.score <= 100);
  assert.equal(hs.components.reduce((s, c) => s + c.max, 0), 100);
});

test('auto-categorisation: rules > history > keywords', () => {
  assert.equal(normalizePayee('SQ *GREEN VALLEY MARKET #1234'), 'sq green valley market');
  assert.equal(suggestCategory(demo, 'LYFT RIDE 9911', 'expense').categoryId, 'cat_transport');
  assert.equal(suggestCategory(demo, 'Netflix', 'expense').source, 'history');
  assert.equal(suggestCategory(demo, 'Local Farmers Market', 'expense').source, 'rule');
  assert.equal(suggestCategory(demo, 'zzqx', 'expense'), null);
});

test('recurring detection finds untracked monthly bills', () => {
  const found = detectRecurring(demo, TODAY);
  const names = found.map((f) => f.payee);
  assert.ok(names.includes('Comcast Internet'));
  assert.ok(names.includes('T-Mobile Phone Bill'));
  assert.ok(!names.includes('Netflix'), 'already-tracked items are not suggested');
  assert.equal(found.find((f) => f.payee === 'Comcast Internet').frequency, 'monthly');
  // fuel on the 9th and 23rd of every month is (correctly) seen as roughly bi-weekly
  assert.equal(found.find((f) => f.payee === 'Shell Fuel Station')?.frequency, 'biweekly');
});

test('forecast and due items', () => {
  const fc = forecast(demo, TODAY, 90);
  assert.equal(fc.points.length, 91);
  assert.ok(fc.events.some((e) => e.payee === 'Acme Corp Payroll'));
  const due = dueRecurring(demo, TODAY);
  assert.equal(due.length, 1);
  assert.equal(due[0].item.payee, 'Equinox Gym');
  assert.equal(nextOccurrence('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
});

test('posting due recurring items creates transactions and advances the schedule', () => {
  const store = createStore(structuredClone(demo));
  const before = store.data.transactions.length;
  store.dispatch({ type: 'recurring/postDue', today: TODAY });
  assert.equal(store.data.transactions.length, before + 1);
  assert.equal(dueRecurring(store.data, TODAY).length, 0);
});

test('search matches payee, tag and amount', () => {
  assert.ok(filterTransactions(demo, { q: 'netflix' }).length >= 10);
  assert.ok(filterTransactions(demo, { q: '#vacation' }).length === 2);
  assert.ok(filterTransactions(demo, { q: '15.49' }).length >= 10);
  assert.ok(filterTransactions(demo, { type: 'income', sort: 'amount-desc' })[0].amount >= 520_000);
});

test('goal projections', () => {
  const g = demo.goals[0];
  const p = goalProgress(g, TODAY);
  assert.ok(p.pct > 0 && p.pct < 1);
  assert.ok(p.requiredMonthly > 0);
  assert.ok(['on-track', 'behind'].includes(p.status));
});

test('insights are generated and sorted by severity', () => {
  const ins = generateInsights(demo, TODAY);
  assert.ok(ins.length >= 3);
  const order = ['critical', 'warning', 'action', 'info', 'positive'];
  for (let i = 1; i < ins.length; i++) assert.ok(order.indexOf(ins[i - 1].severity) <= order.indexOf(ins[i].severity));
  assert.ok(ins.some((i) => i.id === 'recurring-due'));
  assert.ok(ins.some((i) => i.id === 'uncategorized'));
});
