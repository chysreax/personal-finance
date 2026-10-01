import { h } from '../dom.js';
import { icon } from '../icons.js';
import { card, emptyState, statCard, badge } from '../components.js';
import { pageHeader, button } from './shared.js';
import { liveAccounts, accountBalances, netWorth, isLiability, indexOf } from '../../core/finance.js';
import { ACCOUNT_TYPE_LABEL } from '../forms.js';

export const title = 'Accounts';

export function render(app) {
  const data = app.data;
  const today = app.today();
  const money = app.money;
  const nw = netWorth(data, today);
  const bal = accountBalances(data, today);
  const counts = new Map();
  for (const t of indexOf(data).txs) {
    counts.set(t.accountId, (counts.get(t.accountId) || 0) + 1);
    if (t.toAccountId) counts.set(t.toAccountId, (counts.get(t.toAccountId) || 0) + 1);
  }
  const accounts = liveAccounts(data);
  const groups = [
    ['Assets', accounts.filter((a) => !isLiability(a))],
    ['Liabilities', accounts.filter((a) => isLiability(a))],
  ];

  const tile = (a) =>
    h(
      'button',
      { class: ['acc-tile', a.archived && 'archived'], type: 'button', onclick: () => app.forms.account(a), 'aria-label': `Edit ${a.name}` },
      h('span', { class: `acc-stripe slot-bg-${a.color}` }),
      h('span', { class: 'acc-tile-top' }, h('span', { class: 'acc-type' }, ACCOUNT_TYPE_LABEL[a.type]), a.archived ? badge('Archived', 'neutral') : icon('edit', 14)),
      h('span', { class: 'acc-tile-name' }, a.name),
      h('span', { class: `acc-tile-bal ${(bal.get(a.id) ?? 0) < 0 ? 'neg' : ''}` }, money(bal.get(a.id) ?? 0)),
      h('span', { class: 'small muted' }, `${counts.get(a.id) || 0} transactions`),
    );

  return h(
    'div',
    { class: 'view' },
    pageHeader('Accounts', 'Balances are computed live from your starting balance plus every transaction.', button('Add account', { icon: 'plus', variant: 'primary', onClick: () => app.forms.account() })),
    h(
      'div',
      { class: 'kpi-grid kpi-3' },
      statCard({ label: 'Net worth', value: money(nw.net), icon: 'bank', tone: 'hero' }),
      statCard({ label: 'Assets', value: money(nw.assets), icon: 'up', foot: `Liquid ${money(nw.liquid)}` }),
      statCard({ label: 'Liabilities', value: money(nw.liabilities), icon: 'down', foot: nw.assets ? `${Math.round((nw.liabilities / nw.assets) * 100)}% of assets` : '' }),
    ),
    accounts.length
      ? groups
          .filter(([, list]) => list.length)
          .map(([name, list]) => card(name, { subtitle: money(list.reduce((s, a) => s + (bal.get(a.id) ?? 0), 0)) }, h('div', { class: 'acc-grid' }, list.map(tile))))
      : card(null, {}, emptyState({ icon: 'bank', title: 'No accounts yet', text: 'Add checking, savings, credit cards, loans or investments.', action: { label: 'Add account', fn: () => app.forms.account() } })),
  );
}
