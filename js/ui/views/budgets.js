import { h } from '../dom.js';
import { icon } from '../icons.js';
import { card, emptyState, progressBar, categoryDot, statCard, toast } from '../components.js';
import { pageHeader, button, statusBadge, toneFor } from './shared.js';
import * as D from '../../core/dates.js';
import { formatPct } from '../../core/money.js';
import { budgetStatus, categoryTotals, categoryOf, suggestBudget, live } from '../../core/finance.js';
import { UNCATEGORIZED } from '../../core/schema.js';

export const title = 'Budgets';
const state = { month: null };

export function render(app) {
  const data = app.data;
  const today = app.today();
  const current = D.monthKey(today);
  if (!state.month || state.month > current) state.month = current;
  const key = state.month;
  const money = app.money;
  const isCurrent = key === current;
  const list = budgetStatus(data, key, today);
  const [y, m] = key.split('-').map(Number);
  const dim = D.daysInMonth(y, m);
  const day = isCurrent ? D.parseISO(today).getDate() : key < current ? dim : 0;

  const nav = h(
    'div',
    { class: 'month-nav' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', onclick: () => { state.month = D.shiftMonth(key, -1); app.rerender(); } }, icon('chevronLeft', 18)),
    h('span', { class: 'month-label' }, D.monthLabel(key, 'long')),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', disabled: isCurrent, onclick: () => { state.month = D.shiftMonth(key, 1); app.rerender(); } }, icon('chevronRight', 18)),
  );

  const totalLimit = list.reduce((s, b) => s + b.limit, 0);
  const totalSpent = list.reduce((s, b) => s + b.spent, 0);
  const totalProjected = list.reduce((s, b) => s + b.projected, 0);
  const daysLeft = isCurrent ? dim - day + 1 : 0;
  const safeDaily = daysLeft ? Math.max(0, Math.floor((totalLimit - totalSpent) / daysLeft)) : 0;
  const alerts = list.filter((b) => b.status === 'over' || b.status === 'pace').length;

  const kpis = list.length
    ? h(
        'div',
        { class: 'kpi-grid' },
        statCard({ label: 'Budgeted', value: money(totalLimit), icon: 'wallet', foot: `${list.length} categor${list.length === 1 ? 'y' : 'ies'}` }),
        statCard({ label: 'Spent', value: money(totalSpent), icon: 'down', foot: totalLimit ? `${formatPct(totalSpent / totalLimit)} used · ${formatPct(day / dim)} of month gone` : '' }),
        statCard({
          label: isCurrent ? 'Projected month-end' : 'Remaining',
          value: isCurrent ? money(totalProjected) : money(totalLimit - totalSpent),
          icon: 'trendUp',
          tone: isCurrent ? (totalProjected > totalLimit ? 'neg' : 'pos') : totalLimit - totalSpent >= 0 ? 'pos' : 'neg',
          foot: isCurrent ? (totalProjected > totalLimit ? `${money(totalProjected - totalLimit)} over at current pace` : 'Within budget at current pace') : '',
        }),
        statCard({ label: isCurrent ? 'Safe to spend / day' : 'Alerts', value: isCurrent ? money(safeDaily) : String(alerts), icon: isCurrent ? 'zap' : 'alert', foot: isCurrent ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : '' }),
      )
    : null;

  const cards = list.map((b) =>
    h(
      'article',
      { class: `budget budget-${b.status}` },
      h(
        'header',
        { class: 'row between' },
        h('div', { class: 'row gap-sm' }, categoryDot(b.category), h('div', {}, h('h3', { class: 'budget-name' }, b.category.name), h('p', { class: 'small muted' }, `${money(b.limit)} / month`))),
        h('div', { class: 'row gap-sm' }, statusBadge(b.status), h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Edit ${b.category.name} budget`, onclick: () => app.forms.budget(b.budget) }, icon('edit', 16))),
      ),
      h('div', { class: 'budget-amounts' }, h('span', { class: 'budget-spent' }, money(b.spent)), h('span', { class: 'muted' }, ` of ${money(b.limit)}`), h('span', { class: 'budget-pct num' }, formatPct(b.pct))),
      progressBar(b.pct, { tone: toneFor(b.status), marker: isCurrent ? b.elapsedPct : undefined, label: `${b.category.name}: ${formatPct(b.pct)} used` }),
      h(
        'p',
        { class: 'budget-note small' },
        b.status === 'over'
          ? `${money(-b.remaining)} over the limit.`
          : isCurrent
            ? b.status === 'pace'
              ? `⚡ Spending velocity alert — projected ${money(b.projected)} by month-end (${money(b.projected - b.limit)} over). Keep it under ${money(b.dailyAllowance)}/day.`
              : `${money(b.remaining)} left · about ${money(b.dailyAllowance)}/day for ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} · projected ${money(b.projected)}`
            : `${money(b.remaining)} left unspent.`,
      ),
    ),
  );

  // Categories with spending but no budget.
  const budgeted = new Set(live(data.budgets).map((b) => b.categoryId));
  const unbudgeted = categoryTotals(data, D.monthStart(key), D.monthEnd(key), 'expense').filter((c) => !budgeted.has(c.categoryId) && c.categoryId !== UNCATEGORIZED);

  const suggestAll = () => {
    const cands = categoryTotals(data, D.monthStart(D.shiftMonth(current, -3)), D.monthEnd(D.shiftMonth(current, -1)), 'expense')
      .filter((c) => !budgeted.has(c.categoryId) && c.categoryId !== UNCATEGORIZED)
      .map((c) => ({ categoryId: c.categoryId, limit: suggestBudget(data, c.categoryId, today) }))
      .filter((c) => c.limit > 0);
    if (!cands.length) return toast('Need at least one full month of history to suggest budgets');
    app.store.dispatch({ type: 'entity/bulkUpsert', collection: 'budgets', records: cands });
    toast(`Created ${cands.length} budget${cands.length === 1 ? '' : 's'} from your 3-month averages`, { tone: 'success' });
  };

  return h(
    'div',
    { class: 'view' },
    pageHeader('Budgets', 'Monthly limits with spending-velocity alerts. The tick on each bar marks where you should be today.', [
      nav,
      button('Suggest', { icon: 'wand', variant: 'ghost', onClick: suggestAll, title: 'Create budgets from your 3-month averages' }),
      button('New budget', { icon: 'plus', variant: 'primary', onClick: () => app.forms.budget() || toast('Every expense category already has a budget') }),
    ]),
    kpis,
    list.length
      ? h('div', { class: 'budget-grid' }, cards)
      : card(null, {}, emptyState({ icon: 'wallet', title: 'No budgets yet', text: 'Pick a category and a monthly limit — or let the app suggest limits from your history.', action: { label: 'Create budget', fn: () => app.forms.budget() } })),
    unbudgeted.length
      ? card(
          'Unbudgeted spending',
          { subtitle: `${D.monthLabel(key, 'long')} spending in categories without a limit` },
          h(
            'ul',
            { class: 'unbudgeted' },
            unbudgeted.map((c) => {
              const cat = categoryOf(data, c.categoryId);
              const sug = suggestBudget(data, c.categoryId, today);
              return h(
                'li',
                {},
                categoryDot(cat, 'sm'),
                h('span', { class: 'grow' }, cat.name),
                h('span', { class: 'num' }, money(c.total)),
                button(sug ? `Budget ${money(sug)}` : 'Add budget', { size: 'sm', variant: 'ghost', icon: 'plus', onClick: () => app.forms.budget(null, { categoryId: c.categoryId, limit: sug || undefined }) }),
              );
            }),
          ),
        )
      : null,
  );
}
