/** Small view helpers shared across screens. */
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { categoryDot, badge } from '../components.js';
import { categoryOf, indexOf } from '../../core/finance.js';
import { formatDate } from '../../core/dates.js';

export function pageHeader(title, subtitle, actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', {}, h('h1', { class: 'page-title', tabindex: '-1' }, title), subtitle && h('p', { class: 'page-sub' }, subtitle)),
    actions && h('div', { class: 'page-actions' }, actions),
  );
}

export function button(label, { icon: ic, onClick, variant = 'secondary', size, title, cls } = {}) {
  return h(
    'button',
    { class: ['btn', `btn-${variant}`, size && `btn-${size}`, cls], type: 'button', onclick: onClick, title, 'aria-label': !label && title ? title : undefined },
    ic && icon(ic, size === 'sm' ? 14 : 16),
    label && h('span', { class: 'btn-label' }, label),
  );
}

const SEVERITY = {
  critical: { icon: 'alert', tone: 'danger' },
  warning: { icon: 'alert', tone: 'warning' },
  action: { icon: 'zap', tone: 'primary' },
  info: { icon: 'info', tone: 'info' },
  positive: { icon: 'check', tone: 'success' },
};

export function insightItem(app, ins) {
  const sev = SEVERITY[ins.severity];
  return h(
    'li',
    { class: `insight insight-${sev.tone}` },
    h('span', { class: 'insight-icon' }, icon(sev.icon, 16)),
    h(
      'div',
      { class: 'insight-body' },
      h('p', { class: 'insight-title' }, ins.title),
      h('p', { class: 'insight-detail' }, ins.detail),
    ),
    ins.action &&
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm insight-action',
          type: 'button',
          onclick: () => (ins.action.command ? app.actions.run(ins.action.command) : app.navigate(ins.action.route)),
        },
        ins.action.label,
        icon('chevronRight', 14),
      ),
  );
}

export function txRow(app, t, { selectable, selected, onToggle, showDate } = {}) {
  const data = app.data;
  const { accounts } = indexOf(data);
  const cat = t.type === 'transfer' ? null : categoryOf(data, t.categoryId);
  const acc = accounts.get(t.accountId);
  const to = t.toAccountId ? accounts.get(t.toAccountId) : null;
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  const amountCls = t.type === 'income' ? 'pos' : t.type === 'expense' ? '' : 'muted';
  const future = t.date > app.today();
  return h(
    'li',
    { class: ['tx-row', selected && 'selected'], dataset: { id: t.id } },
    selectable &&
      h('label', { class: 'tx-check', onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: !!selected, 'aria-label': `Select ${t.payee}`, onchange: (e) => onToggle?.(t.id, e.target.checked) })),
    h(
      'button',
      { class: 'tx-main', type: 'button', onclick: () => app.forms.transaction(t), 'aria-label': `Edit ${t.payee} ${app.money(t.amount)}` },
      t.type === 'transfer' ? h('span', { class: 'cat-dot cat-dot-md transfer' }, icon('repeat', 15)) : categoryDot(cat),
      h(
        'span',
        { class: 'tx-text' },
        h('span', { class: 'tx-payee' }, t.type === 'transfer' ? `${acc?.name || 'Account'} → ${to?.name || 'Account'}` : t.payee),
        h(
          'span',
          { class: 'tx-meta' },
          showDate && h('span', {}, formatDate(t.date, 'short')),
          cat && h('span', {}, cat.name),
          t.type !== 'transfer' && acc && h('span', { class: 'hide-sm' }, acc.name),
          t.recurringId && h('span', { class: 'tx-flag', title: 'From a recurring schedule' }, icon('repeat', 11)),
          future && badge('Scheduled', 'info'),
          ...t.tags.slice(0, 3).map((tag) => h('span', { class: 'tag' }, `#${tag}`)),
        ),
      ),
      h('span', { class: `tx-amount ${amountCls}` }, `${sign}${app.money(t.amount)}`),
    ),
  );
}

export function statusBadge(status) {
  const map = {
    over: ['Over budget', 'danger', 'alert'],
    pace: ['Over pace', 'warning', 'trendUp'],
    watch: ['Nearing limit', 'warning', 'info'],
    ok: ['On track', 'success', 'check'],
    done: ['Completed', 'success', 'check'],
    'on-track': ['On track', 'success', 'check'],
    behind: ['Behind', 'warning', 'clock'],
    overdue: ['Past deadline', 'danger', 'alert'],
    'no-deadline': ['Open-ended', 'neutral', 'flag'],
  };
  const [label, tone, ic] = map[status] || [status, 'neutral'];
  return badge(label, tone, ic);
}

export const toneFor = (status) => ({ over: 'danger', pace: 'warning', watch: 'warning', ok: 'primary' })[status] || 'primary';
