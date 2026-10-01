import { h, mount, clear, downloadText, readFileText } from '../dom.js';
import { icon } from '../icons.js';
import { card, emptyState, select, segmented, openModal, field, toast, confirmDialog } from '../components.js';
import { pageHeader, button, txRow } from './shared.js';
import * as D from '../../core/dates.js';
import { filterTransactions, liveCategories, liveAccounts, allTags, rangeFor, RANGE_PRESETS, indexOf, categoryOf } from '../../core/finance.js';
import { toCSV, csvToDrafts } from '../../core/csv.js';
import { suggestCategory } from '../../core/categorize.js';
import { UNCATEGORIZED } from '../../core/schema.js';

export const title = 'Transactions';

const PAGE = 60;
function dayLabel(iso, today) {
  const d = D.diffDays(today, iso);
  if (d === 0) return `Today · ${D.formatDate(iso, 'short')}`;
  if (d === -1) return `Yesterday · ${D.formatDate(iso, 'short')}`;
  return D.formatDate(iso, d > 0 || iso.slice(0, 4) !== today.slice(0, 4) ? 'medium' : 'weekday');
}

const state = { q: '', type: 'all', categoryId: '', accountId: '', tag: '', range: 'all', sort: 'date-desc', limit: PAGE, selected: new Set() };

export function render(app, params = {}) {
  if (params.category !== undefined || params.range || params.q !== undefined) {
    Object.assign(state, { q: params.q || '', categoryId: params.category || '', range: params.range || 'all', type: 'all', accountId: '', tag: '', limit: PAGE });
    app.replaceRoute('transactions'); // consume params so a re-render keeps user edits
  }
  const data = app.data;
  const listHost = h('div', { class: 'tx-host' });
  const summary = h('div', { class: 'tx-summary' });
  const bulkBar = h('div', { class: 'bulk-bar', hidden: true });

  const search = h('input', {
    class: 'input', type: 'search', id: 'tx-search', placeholder: 'Search payee, note, #tag, amount…', value: state.q, autocomplete: 'off', 'aria-label': 'Search transactions',
    oninput: (e) => {
      state.q = e.target.value;
      state.limit = PAGE;
      refresh();
    },
  });

  const mkSelect = (id, options, key, labelText) =>
    select(options, state[key], {
      id,
      'aria-label': labelText,
      class: 'input input-sm',
      onchange: (e) => {
        state[key] = e.target.value;
        state.limit = PAGE;
        refresh();
      },
    });

  const catSel = mkSelect('tx-cat', [
    { value: '', label: 'All categories' },
    { value: UNCATEGORIZED, label: '❔ Uncategorized' },
    { group: 'Expense', options: liveCategories(data, 'expense').filter((c) => c.id !== UNCATEGORIZED).map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` })) },
    { group: 'Income', options: liveCategories(data, 'income').map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` })) },
  ], 'categoryId', 'Category');
  const accSel = mkSelect('tx-acc', [{ value: '', label: 'All accounts' }, ...liveAccounts(data).map((a) => ({ value: a.id, label: a.name }))], 'accountId', 'Account');
  const rangeSel = mkSelect('tx-range', Object.entries(RANGE_PRESETS).map(([value, label]) => ({ value, label })), 'range', 'Date range');
  const tags = allTags(data);
  const tagSel = tags.length ? mkSelect('tx-tag', [{ value: '', label: 'All tags' }, ...tags.slice(0, 50).map((t) => ({ value: t, label: `#${t}` }))], 'tag', 'Tag') : null;
  const sortSel = mkSelect('tx-sort', [
    { value: 'date-desc', label: 'Newest first' },
    { value: 'date-asc', label: 'Oldest first' },
    { value: 'amount-desc', label: 'Largest first' },
    { value: 'amount-asc', label: 'Smallest first' },
  ], 'sort', 'Sort');

  const typeCtl = segmented(
    [{ value: 'all', label: 'All' }, { value: 'expense', label: 'Expenses' }, { value: 'income', label: 'Income' }, { value: 'transfer', label: 'Transfers' }],
    state.type,
    (v) => {
      state.type = v;
      state.limit = PAGE;
      refresh();
    },
    { label: 'Transaction type', size: 'sm' },
  );

  const hasFilters = () => state.q || state.type !== 'all' || state.categoryId || state.accountId || state.tag || state.range !== 'all';
  const resetBtn = button('Clear filters', { variant: 'ghost', size: 'sm', icon: 'x', onClick: () => {
    Object.assign(state, { q: '', type: 'all', categoryId: '', accountId: '', tag: '', range: 'all', limit: PAGE });
    app.rerender();
  } });

  function currentRows() {
    const [from, to] = rangeFor(state.range, app.today());
    return filterTransactions(app.data, { ...state, from, to });
  }

  function refresh() {
    const rows = currentRows();
    resetBtn.hidden = !hasFilters();
    // summary
    let inc = 0;
    let exp = 0;
    for (const t of rows) {
      if (t.type === 'income') inc += t.amount;
      else if (t.type === 'expense') exp += t.amount;
    }
    mount(
      summary,
      h('span', {}, h('strong', {}, rows.length.toLocaleString()), ` transaction${rows.length === 1 ? '' : 's'}`),
      h('span', { class: 'pos' }, `+${app.money(inc)}`),
      h('span', {}, `−${app.money(exp)}`),
      h('span', { class: inc - exp >= 0 ? 'pos' : 'neg' }, `Net ${app.money(inc - exp, { sign: true })}`),
    );
    // prune selection to visible rows
    const visible = new Set(rows.map((r) => r.id));
    for (const id of state.selected) if (!visible.has(id)) state.selected.delete(id);
    renderBulk();

    if (!rows.length) {
      mount(
        listHost,
        indexOf(app.data).txs.length
          ? emptyState({ icon: 'search', title: 'No matching transactions', text: 'Try a different search or clear the filters.' })
          : emptyState({ icon: 'list', title: 'No transactions yet', text: 'Add one manually or import a CSV export from your bank.', action: { label: 'Add transaction', fn: () => app.forms.transaction() } }),
      );
      return;
    }
    const shown = rows.slice(0, state.limit);
    const list = h('ul', { class: 'tx-list' });
    const byDate = state.sort.startsWith('date');
    let lastDate = null;
    const dayNet = new Map();
    if (byDate) for (const r of rows) dayNet.set(r.date, (dayNet.get(r.date) || 0) + (r.type === 'income' ? r.amount : r.type === 'expense' ? -r.amount : 0));
    for (const t of shown) {
      if (byDate && t.date !== lastDate) {
        lastDate = t.date;
        const net = dayNet.get(t.date);
        list.appendChild(h('li', { class: 'tx-day' }, h('span', {}, dayLabel(t.date, app.today())), h('span', { class: `num ${net > 0 ? 'pos' : ''}` }, app.money(net, { sign: true }))));
      }
      list.appendChild(
        txRow(app, t, {
          selectable: true,
          selected: state.selected.has(t.id),
          showDate: !byDate,
          onToggle: (id, on) => {
            if (on) state.selected.add(id);
            else state.selected.delete(id);
            list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('selected', on);
            renderBulk();
          },
        }),
      );
    }
    mount(listHost, list);
    if (rows.length > shown.length) {
      listHost.appendChild(
        h('div', { class: 'load-more' }, button(`Show ${Math.min(PAGE, rows.length - shown.length)} more`, { variant: 'secondary', onClick: () => { state.limit += PAGE; refresh(); } }), h('span', { class: 'muted small' }, `${shown.length} of ${rows.length}`)),
      );
    }
  }

  function renderBulk() {
    const n = state.selected.size;
    bulkBar.hidden = n === 0;
    if (!n) return clear(bulkBar);
    const recat = select(
      [{ value: '', label: 'Set category…' }, { group: 'Expense', options: liveCategories(app.data, 'expense').map((c) => ({ value: c.id, label: c.name })) }, { group: 'Income', options: liveCategories(app.data, 'income').map((c) => ({ value: c.id, label: c.name })) }],
      '',
      {
        class: 'input input-sm',
        'aria-label': 'Set category for selected',
        onchange: (e) => {
          const catId = e.target.value;
          if (!catId) return;
          const recs = app.data.transactions.filter((t) => state.selected.has(t.id) && t.type !== 'transfer').map((t) => ({ ...t, categoryId: catId }));
          app.store.dispatch({ type: 'entity/bulkUpsert', collection: 'transactions', records: recs });
          toast(`Updated ${recs.length} transaction${recs.length === 1 ? '' : 's'}`, { tone: 'success' });
          state.selected.clear();
        },
      },
    );
    mount(
      bulkBar,
      h('strong', {}, `${n} selected`),
      recat,
      button('Delete', { variant: 'danger', size: 'sm', icon: 'trash', onClick: async () => {
        if (n > 1 && !(await confirmDialog({ title: `Delete ${n} transactions?`, message: 'You can undo right after.', confirmLabel: 'Delete', danger: true }))) return;
        const ids = [...state.selected];
        state.selected.clear();
        app.actions.remove('transactions', ids);
      } }),
      button('Clear', { variant: 'ghost', size: 'sm', onClick: () => { state.selected.clear(); refresh(); } }),
    );
  }

  const exportCsv = () => {
    const rows = currentRows();
    const { accounts } = indexOf(app.data);
    const csv = toCSV(rows, [
      { label: 'Date', get: (t) => t.date },
      { label: 'Type', get: (t) => t.type },
      { label: 'Payee', get: (t) => t.payee },
      { label: 'Amount', get: (t) => (t.type === 'expense' ? -t.amount : t.amount) / 100 },
      { label: 'Category', get: (t) => (t.type === 'transfer' ? '' : categoryOf(app.data, t.categoryId).name) },
      { label: 'Account', get: (t) => accounts.get(t.accountId)?.name || '' },
      { label: 'To account', get: (t) => (t.toAccountId ? accounts.get(t.toAccountId)?.name || '' : '') },
      { label: 'Tags', get: (t) => t.tags.join(', ') },
      { label: 'Note', get: (t) => t.note },
    ]);
    downloadText(`transactions-${app.today()}.csv`, csv, 'text/csv');
    toast(`Exported ${rows.length} rows`, { tone: 'success' });
  };

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('div', { class: 'search-wrap' }, icon('search', 16), search),
    typeCtl,
    h('div', { class: 'toolbar-filters' }, rangeSel, catSel, accSel, tagSel, sortSel, resetBtn),
  );

  const view = h(
    'div',
    { class: 'view' },
    pageHeader('Transactions', 'Search, filter, tag and categorize every movement of money.', [
      button('Import CSV', { icon: 'upload', variant: 'ghost', onClick: () => importCsvDialog(app) }),
      button('Export', { icon: 'download', variant: 'ghost', onClick: exportCsv }),
      button('Add', { icon: 'plus', variant: 'primary', onClick: () => app.forms.transaction() }),
    ]),
    card(null, { cls: 'card-flush' }, toolbar, summary, bulkBar, listHost),
  );
  refresh();
  return view;
}

/* ---------- CSV import ---------- */

export function importCsvDialog(app) {
  const accounts = liveAccounts(app.data).filter((a) => !a.archived);
  if (!accounts.length) return app.forms.account(null, { reason: 'Create the account these transactions belong to first.' });
  let drafts = [];
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', class: 'input' });
  const acc = select(accounts.map((a) => ({ value: a.id, label: a.name })), accounts[0].id);
  const auto = h('input', { type: 'checkbox', checked: true });
  const preview = h('div', { class: 'import-preview' }, h('p', { class: 'muted small' }, 'Expected columns: Date, Description/Payee, Amount (negative = expense) — or separate Debit/Credit columns. Optional: Category, Tags, Note.'));
  const importBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Import');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const text = await readFileText(file, 8 * 1024 * 1024);
      const byName = new Map(liveCategories(app.data).map((c) => [c.name.toLowerCase(), c.id]));
      const res = csvToDrafts(text, { categoriesByName: byName });
      drafts = res.drafts;
      clear(preview);
      if (res.errors.length && !drafts.length) {
        preview.append(h('p', { class: 'field-error' }, res.errors[0]));
      } else {
        preview.append(
          h('p', {}, h('strong', {}, `${drafts.length} transactions ready`), res.errors.length ? ` · ${res.errors.length} rows skipped` : ''),
          h(
            'ul',
            { class: 'import-sample' },
            drafts.slice(0, 5).map((d) => h('li', {}, h('span', {}, d.date), h('span', {}, d.payee), h('span', { class: d.type === 'income' ? 'pos num' : 'num' }, `${d.type === 'income' ? '+' : '−'}${app.money(d.amount)}`))),
          ),
          res.errors.length ? h('details', {}, h('summary', {}, 'Skipped rows'), h('ul', { class: 'small muted' }, res.errors.slice(0, 20).map((e) => h('li', {}, e)))) : null,
        );
      }
      importBtn.disabled = drafts.length === 0;
    } catch (err) {
      mount(preview, h('p', { class: 'field-error' }, err.message || 'Could not read file'));
    }
  });

  importBtn.addEventListener('click', () => {
    const data = app.data;
    const records = drafts.map((d) => {
      let categoryId = d.categoryId;
      if (!categoryId && auto.checked) categoryId = suggestCategory(data, d.payee, d.type)?.categoryId || null;
      return { ...d, accountId: acc.value, categoryId: categoryId || (d.type === 'income' ? 'cat_other_income' : UNCATEGORIZED) };
    });
    app.store.dispatch({ type: 'entity/bulkUpsert', collection: 'transactions', records });
    const categorized = records.filter((r) => r.categoryId !== UNCATEGORIZED).length;
    toast(`Imported ${records.length} transactions · ${categorized} categorized`, { tone: 'success' });
    m.close();
  });

  const m = openModal({
    title: 'Import bank CSV',
    body: h('div', { class: 'form-grid' }, h('div', { class: 'span-2' }, field('CSV file', fileInput)), h('div', { class: 'span-2' }, field('Into account', acc)), h('label', { class: 'check span-2' }, auto, h('span', {}, 'Auto-categorize using rules, history and merchant matching')), h('div', { class: 'span-2' }, preview)),
    footer: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), importBtn],
  });
}
