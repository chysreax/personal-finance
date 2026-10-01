import { h } from '../dom.js';
import { icon } from '../icons.js';
import { card, emptyState, categoryDot, badge, statCard, segmented, toast } from '../components.js';
import { lineChart } from '../charts.js';
import { pageHeader, button } from './shared.js';
import * as D from '../../core/dates.js';
import { live, categoryOf, indexOf, liveAccounts } from '../../core/finance.js';
import { forecast, detectRecurring, dueRecurring, monthlyEquivalent, FREQ_LABEL } from '../../core/recurring.js';
import { uid } from '../../core/ids.js';

export const title = 'Recurring';
const state = { horizon: 90 };

export function render(app) {
  const data = app.data;
  const today = app.today();
  const money = app.money;
  const compact = (c) => app.money(c, { compact: true });
  const items = live(data.recurring).sort((a, b) => (a.active === b.active ? (a.nextDate < b.nextDate ? -1 : 1) : a.active ? -1 : 1));
  const due = new Map(dueRecurring(data, today).map((d) => [d.item.id, d]));
  const found = detectRecurring(data, today);
  const { accounts } = indexOf(data);

  const active = items.filter((r) => r.active);
  const monthlyOut = active.filter((r) => r.type === 'expense').reduce((s, r) => s + monthlyEquivalent(r), 0);
  const monthlyIn = active.filter((r) => r.type === 'income').reduce((s, r) => s + monthlyEquivalent(r), 0);

  const fc = liveAccounts(data).length ? forecast(data, today, state.horizon) : null;

  const kpis = h(
    'div',
    { class: 'kpi-grid' },
    statCard({ label: 'Fixed costs / month', value: money(monthlyOut), icon: 'down', foot: `${money(monthlyOut * 12)} per year` }),
    statCard({ label: 'Recurring income / month', value: money(monthlyIn), icon: 'up' }),
    fc && statCard({ label: `Projected balance in ${state.horizon} days`, value: money(fc.end.projected), icon: 'trendUp', tone: fc.end.projected >= fc.start ? 'pos' : 'neg', foot: `Liquid today ${compact(fc.start)}` }),
    fc && statCard({ label: 'Lowest point', value: money(fc.lowest.balance), icon: 'alert', tone: fc.lowest.balance < 0 ? 'neg' : undefined, foot: D.formatDate(fc.lowest.date) }),
  );

  const forecastCard = fc
    ? card(
        'Cash-flow forecast',
        {
          subtitle: `Liquid accounts (checking, savings, cash). Typical day-to-day net: ${money(fc.dailyNet, { sign: true })}/day`,
          actions: segmented([{ value: 30, label: '30d' }, { value: 90, label: '90d' }, { value: 180, label: '180d' }], state.horizon, (v) => { state.horizon = v; app.rerender(); }, { label: 'Forecast horizon', size: 'sm' }),
        },
        lineChart({
          labels: fc.points.map((p) => D.formatDate(p.date, 'short')),
          fullLabels: fc.points.map((p) => D.formatDate(p.date, 'weekday')),
          series: [
            { name: 'Projected (scheduled + typical spending)', values: fc.points.map((p) => p.projected), slot: 0, area: true },
            { name: 'Scheduled items only', values: fc.points.map((p) => p.scheduled), slot: 1 },
          ],
          format: money,
          formatAxis: compact,
          height: 240,
          zero: fc.lowest.balance < 0,
          caption: 'Projected liquid balance',
        }),
      )
    : null;

  const list = items.length
    ? h(
        'ul',
        { class: 'rec-list' },
        items.map((r) => {
          const d = due.get(r.id);
          const acc = accounts.get(r.accountId);
          return h(
            'li',
            { class: ['rec', !r.active && 'inactive'] },
            categoryDot(categoryOf(data, r.categoryId)),
            h(
              'div',
              { class: 'rec-text' },
              h('span', { class: 'rec-name' }, r.payee),
              h('span', { class: 'small muted' }, `${FREQ_LABEL[r.frequency]} · ${acc?.name || 'Account'} · ≈ ${money(monthlyEquivalent(r))}/mo`),
            ),
            h(
              'div',
              { class: 'rec-when' },
              d ? badge(`${d.dates.length} due`, 'warning', 'zap') : r.active ? h('span', { class: 'small' }, D.relativeDay(r.nextDate, today)) : badge('Paused', 'neutral'),
            ),
            h('span', { class: `num rec-amt ${r.type === 'income' ? 'pos' : ''}` }, `${r.type === 'income' ? '+' : '−'}${money(r.amount)}`),
            h(
              'div',
              { class: 'rec-actions' },
              d && button('Post', { size: 'sm', variant: 'primary', icon: 'play', onClick: () => app.actions.postDue([r.id]), title: 'Record due occurrences as transactions' }),
              d && button('', { size: 'sm', variant: 'ghost', icon: 'skip', onClick: () => app.actions.skip(r.id), title: 'Skip this occurrence' }),
              h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Edit ${r.payee}`, onclick: () => app.forms.recurring(r) }, icon('edit', 16)),
            ),
          );
        }),
      )
    : emptyState({ icon: 'repeat', title: 'No recurring items', text: 'Add bills, subscriptions and paychecks to forecast your cash flow.', action: { label: 'Add recurring', fn: () => app.forms.recurring() } });

  const detected = found.length
    ? card(
        'Detected in your history',
        { subtitle: 'Payments that repeat on a regular schedule but are not tracked yet' },
        h(
          'ul',
          { class: 'rec-list' },
          found.slice(0, 8).map((f) =>
            h(
              'li',
              { class: 'rec' },
              categoryDot(categoryOf(data, f.categoryId)),
              h('div', { class: 'rec-text' }, h('span', { class: 'rec-name' }, f.payee), h('span', { class: 'small muted' }, `${FREQ_LABEL[f.frequency]} · seen ${f.count}× · ${Math.round(f.confidence * 100)}% confidence · next ≈ ${D.formatDate(f.nextDate, 'short')}`)),
              h('span', { class: `num rec-amt ${f.type === 'income' ? 'pos' : ''}` }, money(f.amount)),
              h(
                'div',
                { class: 'rec-actions' },
                button('Track', {
                  size: 'sm', variant: 'secondary', icon: 'plus',
                  onClick: () => {
                    app.actions.save('recurring', { id: uid('rec_'), payee: f.payee, amount: f.amount, type: f.type, categoryId: f.categoryId, accountId: f.accountId, frequency: f.frequency, nextDate: f.nextDate, active: true }, { message: `Tracking ${f.payee}` });
                  },
                }),
              ),
            ),
          ),
        ),
        found.length > 1
          ? h('div', { class: 'row end mt' }, button(`Track all ${found.length}`, { size: 'sm', variant: 'ghost', onClick: () => {
              app.store.dispatch({ type: 'entity/bulkUpsert', collection: 'recurring', records: found.map((f) => ({ payee: f.payee, amount: f.amount, type: f.type, categoryId: f.categoryId, accountId: f.accountId, frequency: f.frequency, nextDate: f.nextDate, active: true })) });
              toast(`Tracking ${found.length} recurring items`, { tone: 'success' });
            } }))
          : null,
      )
    : null;

  const upcoming = fc && fc.events.length
    ? card(
        'Next 30 days',
        {},
        h(
          'ul',
          { class: 'upcoming' },
          fc.events.filter((e) => e.date <= D.addDays(today, 30)).slice(0, 12).map((e) =>
            h('li', {}, h('span', { class: 'up-date' }, D.relativeDay(e.date, today)), categoryDot(categoryOf(data, e.categoryId), 'sm'), h('span', { class: 'up-name' }, e.payee), h('span', { class: `num ${e.type === 'income' ? 'pos' : ''}` }, `${e.type === 'income' ? '+' : '−'}${money(e.amount)}`)),
          ),
        ),
      )
    : null;

  return h(
    'div',
    { class: 'view' },
    pageHeader('Recurring & forecast', 'Bills, subscriptions and paychecks — and where your cash is headed.', [
      due.size ? button(`Post ${[...due.values()].reduce((s, d) => s + d.dates.length, 0)} due`, { icon: 'play', variant: 'secondary', onClick: () => app.actions.postDue() }) : null,
      button('Add recurring', { icon: 'plus', variant: 'primary', onClick: () => app.forms.recurring() }),
    ]),
    kpis,
    forecastCard,
    h('div', { class: 'grid grid-2-1' }, card('Scheduled items', { subtitle: `${active.length} active` }, list), h('div', { class: 'stack' }, upcoming, detected)),
  );
}
