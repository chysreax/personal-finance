import { h } from '../dom.js';
import { icon } from '../icons.js';
import { card, emptyState, progressBar, statCard } from '../components.js';
import { pageHeader, button, statusBadge } from './shared.js';
import * as D from '../../core/dates.js';
import { formatPct } from '../../core/money.js';
import { goalProgress, live, averageMonthly } from '../../core/finance.js';

export const title = 'Goals';

export function render(app) {
  const data = app.data;
  const today = app.today();
  const money = app.money;
  const goals = live(data.goals);
  const rows = goals.map((g) => ({ g, p: goalProgress(g, today) })).sort((a, b) => (a.p.status === 'done') - (b.p.status === 'done') || b.p.pct - a.p.pct);

  const totalTarget = goals.reduce((s, g) => s + g.target, 0);
  const totalSaved = goals.reduce((s, g) => s + Math.min(g.saved, g.target), 0);
  const needed = rows.reduce((s, r) => s + (r.p.status !== 'done' && r.p.requiredMonthly ? r.p.requiredMonthly : 0), 0);
  const surplus = (() => {
    const a = averageMonthly(data, today, 3);
    return a.income - a.expense;
  })();

  const kpis = goals.length
    ? h(
        'div',
        { class: 'kpi-grid' },
        statCard({ label: 'Saved toward goals', value: money(totalSaved), icon: 'target', foot: `${formatPct(totalTarget ? totalSaved / totalTarget : 0)} of ${money(totalTarget)}` }),
        statCard({ label: 'Needed per month', value: money(needed), icon: 'calendar', foot: 'to hit every deadline' }),
        statCard({ label: 'Avg. monthly surplus', value: money(surplus, { sign: true }), icon: 'pulse', tone: surplus >= needed ? 'pos' : 'neg', foot: surplus >= needed ? 'Enough to fund all goals' : `${money(needed - surplus)} short each month` }),
        statCard({ label: 'Completed', value: String(rows.filter((r) => r.p.status === 'done').length), icon: 'check', foot: `of ${goals.length} goal${goals.length === 1 ? '' : 's'}` }),
      )
    : null;

  const cards = rows.map(({ g, p }) =>
    h(
      'article',
      { class: `goal ${p.status === 'done' ? 'goal-done' : ''}` },
      h(
        'header',
        { class: 'row between' },
        h('div', { class: 'row gap-sm' }, h('span', { class: `goal-icon slot-soft-${g.color}` }, g.icon), h('div', {}, h('h3', { class: 'goal-name' }, g.name), h('p', { class: 'small muted' }, g.deadline ? `Target ${D.formatDate(g.deadline)}` : 'No deadline'))),
        statusBadge(p.status),
      ),
      h('div', { class: 'goal-amounts' }, h('span', { class: 'goal-saved' }, money(g.saved)), h('span', { class: 'muted' }, ` of ${money(g.target)}`)),
      h('div', { class: `goal-bar slot-${g.color}` }, progressBar(p.pct, { tone: 'goal', label: `${g.name} progress` }), h('span', { class: 'goal-pct num' }, formatPct(p.pct))),
      h(
        'dl',
        { class: 'goal-stats' },
        h('div', {}, h('dt', {}, 'Remaining'), h('dd', {}, money(p.remaining))),
        h('div', {}, h('dt', {}, 'Needed / month'), h('dd', {}, p.requiredMonthly !== null && p.status !== 'done' ? money(p.requiredMonthly) : '—')),
        h('div', {}, h('dt', {}, 'Your pace'), h('dd', {}, p.avgMonthly ? `${money(p.avgMonthly)}/mo` : '—')),
        h('div', {}, h('dt', {}, 'Projected'), h('dd', {}, p.status === 'done' ? 'Done 🎉' : p.projectedDate ? D.formatDate(p.projectedDate) : 'Add funds to project')),
      ),
      h(
        'footer',
        { class: 'row gap-sm' },
        button('Add funds', { icon: 'plus', variant: 'primary', size: 'sm', onClick: () => app.forms.contribute(g) }),
        button('Edit', { icon: 'edit', variant: 'ghost', size: 'sm', onClick: () => app.forms.goal(g) }),
      ),
    ),
  );

  return h(
    'div',
    { class: 'view' },
    pageHeader('Goals', 'Save toward what matters, with live progress and pace tracking.', button('New goal', { icon: 'plus', variant: 'primary', onClick: () => app.forms.goal() })),
    kpis,
    goals.length
      ? h('div', { class: 'goal-grid' }, cards)
      : card(null, {}, emptyState({ icon: 'target', title: 'No goals yet', text: 'An emergency fund, a trip, a down payment — set a target and watch it fill up.', action: { label: 'Create goal', fn: () => app.forms.goal() } })),
    goals.length ? h('p', { class: 'small muted center' }, icon('info', 13), ' Pace is your average contribution over the last 90 days.') : null,
  );
}
