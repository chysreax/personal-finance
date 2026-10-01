/** Modal forms for every entity. Validation is inline; saving is optimistic. */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { openModal, field, select, segmented, setFieldError, confirmDialog } from './components.js';
import { toCents, centsToInput } from '../core/money.js';
import { ACCOUNT_TYPES, LIABILITY_TYPES, FREQUENCIES, UNCATEGORIZED } from '../core/schema.js';
import { liveAccounts, liveCategories, knownPayees, accountBalances, suggestBudget, live } from '../core/finance.js';
import { suggestCategory, SOURCE_LABEL } from '../core/categorize.js';
import { FREQ_LABEL } from '../core/recurring.js';
import { isISODate } from '../core/dates.js';

const TYPE_LABEL = { checking: 'Checking', savings: 'Savings', cash: 'Cash', investment: 'Investment', credit: 'Credit card', loan: 'Loan' };
export { TYPE_LABEL as ACCOUNT_TYPE_LABEL };

function amountInput(value, props = {}) {
  return h('input', { class: 'input input-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: value ? centsToInput(value) : '', ...props });
}

function categoryOptions(data, kind) {
  return liveCategories(data, kind).map((c) => ({ value: c.id, label: `${c.icon ? `${c.icon} ` : ''}${c.name}` }));
}

function accountOptions(data, includeArchivedId) {
  return liveAccounts(data)
    .filter((a) => !a.archived || a.id === includeArchivedId)
    .map((a) => ({ value: a.id, label: a.name }));
}

function footer(m, { onDelete, submitLabel = 'Save', extra } = {}) {
  return [
    onDelete && h('button', { class: 'btn btn-ghost btn-danger-text mr-auto', type: 'button', onclick: onDelete }, icon('trash', 16), 'Delete'),
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Cancel'),
    extra,
    h('button', { class: 'btn btn-primary', type: 'submit', form: m.formId }, submitLabel),
  ];
}

function formModal(title, buildBody, { onSubmit, onDelete, submitLabel, size, extra } = {}) {
  const formId = `form-${Math.random().toString(36).slice(2, 8)}`;
  const form = h('form', { id: formId, class: 'form-grid', novalidate: true });
  const m = { formId, close: () => {} };
  buildBody(form);
  const modal = openModal({ title, size, body: form, footer: footer(m, { onDelete: onDelete && (() => onDelete(modal)), submitLabel, extra: extra && extra(formId) }) });
  m.close = modal.close;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (onSubmit(modal, e.submitter) !== false) modal.close();
  });
  return modal;
}

/* ---------- transaction ---------- */

export function transactionForm(app, existing, preset = {}) {
  const data = app.data;
  if (!liveAccounts(data).length) {
    return accountForm(app, null, { reason: 'Add an account first — transactions belong to an account.' });
  }
  const tx = existing || { type: preset.type || 'expense', date: app.today(), accountId: preset.accountId || accountOptions(data)[0]?.value, tags: [], ...preset };
  let type = tx.type;
  let categoryTouched = !!existing && tx.categoryId && tx.categoryId !== UNCATEGORIZED;

  const amount = amountInput(tx.amount, { autofocus: true, 'aria-describedby': 'amount-hint' });
  const date = h('input', { class: 'input', type: 'date', value: tx.date, required: true });
  const payee = h('input', { class: 'input', type: 'text', maxlength: '80', autocomplete: 'off', list: 'payee-list', value: tx.payee || '', placeholder: 'e.g. Trader Joe’s' });
  const payees = h('datalist', { id: 'payee-list' }, knownPayees(data).map((p) => h('option', { value: p })));
  const catWrap = h('div');
  let category;
  const suggestion = h('p', { class: 'suggestion', 'aria-live': 'polite' });
  const account = select(accountOptions(data, tx.accountId), tx.accountId);
  const toAccount = select(accountOptions(data, tx.toAccountId).filter((o) => o.value !== tx.accountId), tx.toAccountId);
  const tags = h('input', { class: 'input', type: 'text', maxlength: '200', value: (tx.tags || []).join(', '), placeholder: 'work, vacation' });
  const note = h('textarea', { class: 'input', rows: '2', maxlength: '280', placeholder: 'Optional note' }, tx.note || '');

  const fAmount = field('Amount', h('div', { class: 'amount-wrap' }, h('span', { class: 'amount-cur' }, data.settings.currency), amount));
  const fDate = field('Date', date);
  const fPayee = field('Payee', h('div', {}, payee, payees));
  const fCat = field('Category', catWrap);
  const fAccount = field('From account', account);
  const fTo = field('To account', toAccount);
  const fTags = field('Tags', tags, { hint: 'Comma separated' });
  const fNote = field('Note', note);

  function renderCategory() {
    const opts = categoryOptions(data, type === 'income' ? 'income' : 'expense');
    const current = category?.value || tx.categoryId;
    category = select(opts, opts.some((o) => o.value === current) ? current : type === 'income' ? 'cat_other_income' : UNCATEGORIZED);
    category.addEventListener('change', () => {
      categoryTouched = true;
      suggestion.textContent = '';
    });
    clear(catWrap).appendChild(category);
    catWrap.appendChild(suggestion);
  }

  function suggest() {
    if (type === 'transfer' || categoryTouched) return;
    const sug = suggestCategory(data, payee.value, type);
    clear(suggestion);
    if (sug) {
      category.value = sug.categoryId;
      suggestion.append(icon('sparkle', 13), ` Auto-categorized (${SOURCE_LABEL[sug.source]})`);
    }
  }

  function applyType(t) {
    type = t;
    const transfer = t === 'transfer';
    fCat.hidden = transfer;
    fTo.hidden = !transfer;
    fPayee.hidden = transfer;
    fAccount.querySelector('label').textContent = transfer ? 'From account' : 'Account';
    renderCategory();
    suggest();
  }

  account.addEventListener('change', () => {
    const keep = toAccount.value;
    const opts = accountOptions(data).filter((o) => o.value !== account.value);
    clear(toAccount);
    opts.forEach((o) => toAccount.appendChild(h('option', { value: o.value, selected: o.value === keep }, o.label)));
  });
  payee.addEventListener('input', suggest);

  const typeCtl = segmented(
    [
      { value: 'expense', label: 'Expense', icon: 'down' },
      { value: 'income', label: 'Income', icon: 'up' },
      { value: 'transfer', label: 'Transfer', icon: 'repeat' },
    ],
    type,
    applyType,
    { label: 'Transaction type' },
  );

  return formModal(
    existing ? 'Edit transaction' : 'New transaction',
    (form) => {
      form.append(h('div', { class: 'span-2' }, typeCtl), h('div', { class: 'span-2' }, fAmount), fDate, fPayee, fCat, fAccount, fTo, h('div', { class: 'span-2' }, fTags), h('div', { class: 'span-2' }, fNote));
      applyType(type);
    },
    {
      submitLabel: existing ? 'Save changes' : 'Add transaction',
      extra: existing ? null : (formId) => h('button', { class: 'btn btn-ghost hide-sm', type: 'submit', form: formId, 'data-again': '1' }, 'Save & add another'),
      onSubmit: (modal, submitter) => {
        const cents = toCents(amount.value);
        let ok = true;
        setFieldError(fAmount, '');
        setFieldError(fDate, '');
        setFieldError(fTo, '');
        if (!Number.isFinite(cents) || cents <= 0) {
          setFieldError(fAmount, 'Enter an amount greater than zero');
          ok = false;
        }
        if (!isISODate(date.value)) {
          setFieldError(fDate, 'Pick a valid date');
          ok = false;
        }
        if (type === 'transfer' && (!toAccount.value || toAccount.value === account.value)) {
          setFieldError(fTo, 'Choose a different destination account');
          ok = false;
        }
        if (!ok) {
          modal.el.querySelector('.has-error input, .has-error select')?.focus();
          return false;
        }
        const record = {
          ...(existing || {}),
          type,
          amount: Math.abs(cents),
          date: date.value,
          payee: type === 'transfer' ? 'Transfer' : payee.value,
          categoryId: type === 'transfer' ? null : category.value,
          accountId: account.value,
          toAccountId: type === 'transfer' ? toAccount.value : null,
          tags: tags.value,
          note: note.value,
        };
        if (!app.actions.save('transactions', record)) return false;
        if (submitter?.dataset?.again) {
          setTimeout(() => transactionForm(app, null, { type, accountId: account.value, date: date.value }), 180);
        }
        return true;
      },
      onDelete: existing
        ? (modal) => {
            modal.close();
            app.actions.remove('transactions', existing.id);
          }
        : null,
    },
  );
}

/* ---------- account ---------- */

export function accountForm(app, existing, { reason } = {}) {
  const data = app.data;
  const acc = existing || { type: 'checking', opening: 0, color: liveAccounts(data).length % 8 };
  const liability = () => LIABILITY_TYPES.has(type.value);
  const name = h('input', { class: 'input', type: 'text', maxlength: '60', value: acc.name || '', placeholder: 'e.g. Everyday Checking', autofocus: true });
  const type = select(ACCOUNT_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })), acc.type);
  const bal = amountInput(Math.abs(acc.opening) || '', {});
  const fName = field('Name', name);
  const fBal = field(existing ? 'Starting balance' : 'Current balance', bal);
  const archived = h('input', { type: 'checkbox', checked: !!acc.archived });
  const current = existing ? accountBalances(data, app.today()).get(existing.id) : null;
  const relabel = () => {
    fBal.querySelector('.field-label').textContent = liability() ? (existing ? 'Starting amount owed' : 'Amount owed') : existing ? 'Starting balance' : 'Current balance';
  };
  type.addEventListener('change', relabel);

  return formModal(
    existing ? 'Edit account' : 'New account',
    (form) => {
      if (reason) form.append(h('p', { class: 'callout span-2' }, icon('info', 16), reason));
      form.append(
        h('div', { class: 'span-2' }, fName),
        field('Type', type),
        fBal,
        existing &&
          h('p', { class: 'muted small span-2' }, `Balance today: ${app.money(current)}. The starting balance is the amount before any recorded transactions.`),
        existing && h('label', { class: 'check span-2' }, archived, h('span', {}, 'Archived (hidden from pickers, still counted in net worth)')),
      );
      relabel();
    },
    {
      submitLabel: existing ? 'Save changes' : 'Add account',
      onSubmit: () => {
        setFieldError(fName, name.value.trim() ? '' : 'Name is required');
        const cents = bal.value.trim() === '' ? 0 : toCents(bal.value);
        setFieldError(fBal, Number.isFinite(cents) ? '' : 'Enter a valid amount');
        if (!name.value.trim() || !Number.isFinite(cents)) return false;
        const opening = liability() ? -Math.abs(cents) : cents;
        return app.actions.save('accounts', { ...acc, name: name.value, type: type.value, opening, archived: archived.checked });
      },
      onDelete: existing
        ? async (modal) => {
            const count = live(data.transactions).filter((t) => t.accountId === existing.id || t.toAccountId === existing.id).length;
            if (count) {
              modal.close();
              const ok = await confirmDialog({
                title: 'Archive instead?',
                message: `"${existing.name}" has ${count} transaction${count === 1 ? '' : 's'}. Deleting it would orphan them, so it will be archived (hidden, still counted).`,
                confirmLabel: 'Archive account',
              });
              if (ok) app.actions.save('accounts', { ...existing, archived: true }, { message: 'Account archived' });
              return;
            }
            modal.close();
            app.actions.remove('accounts', existing.id);
          }
        : null,
    },
  );
}

/* ---------- budget ---------- */

export function budgetForm(app, existing, preset = {}) {
  const data = app.data;
  const taken = new Set(live(data.budgets).map((b) => b.categoryId));
  const opts = categoryOptions(data, 'expense').filter((o) => !taken.has(o.value) || o.value === existing?.categoryId);
  if (!opts.length) return null;
  const b = existing || { categoryId: preset.categoryId || opts[0].value };
  const cat = select(opts, b.categoryId, { disabled: !!existing });
  const limit = amountInput(b.limit || preset.limit, { autofocus: true });
  const fLimit = field('Monthly limit', limit);
  const hint = h('div', { class: 'span-2' });
  const refreshHint = () => {
    clear(hint);
    const sug = suggestBudget(data, cat.value, app.today());
    if (sug) {
      hint.append(
        h('button', { class: 'chip', type: 'button', onclick: () => (limit.value = centsToInput(sug)) }, icon('wand', 14), `Use 3-month average +5%: ${app.money(sug)}`),
      );
    }
  };
  cat.addEventListener('change', refreshHint);
  return formModal(
    existing ? 'Edit budget' : 'New budget',
    (form) => {
      form.append(field('Category', cat), fLimit, hint);
      refreshHint();
    },
    {
      size: 'sm',
      submitLabel: existing ? 'Save' : 'Create budget',
      onSubmit: () => {
        const cents = toCents(limit.value);
        if (!Number.isFinite(cents) || cents <= 0) {
          setFieldError(fLimit, 'Enter a limit greater than zero');
          return false;
        }
        return app.actions.save('budgets', { ...b, categoryId: cat.value, limit: cents });
      },
      onDelete: existing ? (modal) => { modal.close(); app.actions.remove('budgets', existing.id); } : null,
    },
  );
}

/* ---------- goal ---------- */

function slotPicker(value) {
  let current = value;
  const root = h('div', { class: 'slot-picker', role: 'radiogroup', 'aria-label': 'Color' });
  const render = () => {
    clear(root);
    for (let i = 0; i < 8; i++) {
      root.appendChild(h('button', { type: 'button', role: 'radio', 'aria-checked': String(i === current), 'aria-label': `Color ${i + 1}`, class: `slot-swatch slot-bg-${i} ${i === current ? 'active' : ''}`, onclick: () => { current = i; render(); } }));
    }
  };
  render();
  root.getValue = () => current;
  return root;
}

export function goalForm(app, existing) {
  const g = existing || { color: live(app.data.goals).length % 8, icon: '🎯', saved: 0, history: [] };
  const name = h('input', { class: 'input', type: 'text', maxlength: '60', value: g.name || '', placeholder: 'e.g. Emergency fund', autofocus: true });
  const emoji = h('input', { class: 'input input-emoji', type: 'text', maxlength: '4', value: g.icon || '🎯', 'aria-label': 'Icon' });
  const target = amountInput(g.target);
  const saved = amountInput(g.saved || '');
  const deadline = h('input', { class: 'input', type: 'date', value: g.deadline || '', min: app.today() });
  const color = slotPicker(g.color);
  const fName = field('Goal name', h('div', { class: 'row gap-sm' }, emoji, name));
  const fTarget = field('Target amount', target);
  const fSaved = field(existing ? 'Saved so far' : 'Already saved', saved);
  return formModal(
    existing ? 'Edit goal' : 'New savings goal',
    (form) => form.append(h('div', { class: 'span-2' }, fName), fTarget, fSaved, field('Target date (optional)', deadline), field('Color', color)),
    {
      submitLabel: existing ? 'Save' : 'Create goal',
      onSubmit: () => {
        const t = toCents(target.value);
        const sv = saved.value.trim() ? toCents(saved.value) : 0;
        setFieldError(fName, name.value.trim() ? '' : 'Name is required');
        setFieldError(fTarget, Number.isFinite(t) && t > 0 ? '' : 'Enter a target greater than zero');
        setFieldError(fSaved, Number.isFinite(sv) && sv >= 0 ? '' : 'Enter a valid amount');
        if (!name.value.trim() || !(t > 0) || !(sv >= 0)) return false;
        const history = existing ? g.history : sv > 0 ? [{ date: app.today(), amount: sv }] : [];
        return app.actions.save('goals', { ...g, name: name.value, icon: emoji.value, target: t, saved: sv, deadline: deadline.value || null, color: color.getValue(), history });
      },
      onDelete: existing ? (modal) => { modal.close(); app.actions.remove('goals', existing.id); } : null,
    },
  );
}

export function contributeForm(app, goal) {
  let sign = 1;
  const amount = amountInput('', { autofocus: true });
  const date = h('input', { class: 'input', type: 'date', value: app.today(), max: app.today() });
  const fAmount = field('Amount', amount);
  return formModal(
    `Update “${goal.name}”`,
    (form) =>
      form.append(
        h('div', { class: 'span-2' }, segmented([{ value: 1, label: 'Add funds', icon: 'plus' }, { value: -1, label: 'Withdraw', icon: 'down' }], 1, (v) => (sign = v), { label: 'Direction' })),
        fAmount,
        field('Date', date),
      ),
    {
      size: 'sm',
      submitLabel: 'Apply',
      onSubmit: () => {
        const cents = toCents(amount.value);
        if (!Number.isFinite(cents) || cents <= 0) {
          setFieldError(fAmount, 'Enter an amount greater than zero');
          return false;
        }
        app.actions.contribute(goal.id, sign * cents, isISODate(date.value) ? date.value : app.today());
        return true;
      },
    },
  );
}

/* ---------- recurring ---------- */

export function recurringForm(app, existing, preset = {}) {
  const data = app.data;
  if (!liveAccounts(data).length) return accountForm(app, null, { reason: 'Add an account first.' });
  const r = existing || { type: 'expense', frequency: 'monthly', nextDate: app.today(), active: true, accountId: accountOptions(data)[0]?.value, ...preset };
  let type = r.type;
  const payee = h('input', { class: 'input', type: 'text', maxlength: '80', value: r.payee || '', placeholder: 'e.g. Netflix', autofocus: true });
  const amount = amountInput(r.amount);
  const freq = select(FREQUENCIES.map((f) => ({ value: f, label: FREQ_LABEL[f] })), r.frequency);
  const next = h('input', { class: 'input', type: 'date', value: r.nextDate });
  const catWrap = h('div');
  let cat;
  const renderCat = () => {
    const opts = categoryOptions(data, type);
    const keep = cat?.value || r.categoryId;
    cat = select(opts, opts.some((o) => o.value === keep) ? keep : opts[0]?.value);
    clear(catWrap).appendChild(cat);
  };
  const account = select(accountOptions(data, r.accountId), r.accountId);
  const active = h('input', { type: 'checkbox', checked: r.active !== false });
  const fPayee = field('Payee', payee);
  const fAmount = field('Amount', amount);
  const fNext = field('Next date', next);
  payee.addEventListener('input', () => {
    const sug = suggestCategory(data, payee.value, type);
    if (sug && cat) cat.value = sug.categoryId;
  });
  return formModal(
    existing ? 'Edit recurring item' : 'New recurring item',
    (form) => {
      form.append(
        h('div', { class: 'span-2' }, segmented([{ value: 'expense', label: 'Bill / expense', icon: 'down' }, { value: 'income', label: 'Income', icon: 'up' }], type, (v) => { type = v; renderCat(); }, { label: 'Type' })),
        fPayee, fAmount, field('Frequency', freq), fNext, field('Category', catWrap), field('Account', account),
        h('label', { class: 'check span-2' }, active, h('span', {}, 'Active (included in forecasts and due reminders)')),
      );
      renderCat();
    },
    {
      submitLabel: existing ? 'Save' : 'Add recurring',
      onSubmit: () => {
        const cents = toCents(amount.value);
        setFieldError(fPayee, payee.value.trim() ? '' : 'Payee is required');
        setFieldError(fAmount, Number.isFinite(cents) && cents > 0 ? '' : 'Enter an amount greater than zero');
        setFieldError(fNext, isISODate(next.value) ? '' : 'Pick a valid date');
        if (!payee.value.trim() || !(cents > 0) || !isISODate(next.value)) return false;
        return app.actions.save('recurring', { ...r, type, payee: payee.value, amount: cents, frequency: freq.value, nextDate: next.value, categoryId: cat.value, accountId: account.value, active: active.checked });
      },
      onDelete: existing ? (modal) => { modal.close(); app.actions.remove('recurring', existing.id); } : null,
    },
  );
}

/* ---------- category & rule ---------- */

export function categoryForm(app, existing) {
  const c = existing || { kind: 'expense', icon: '🏷️', color: 0 };
  const name = h('input', { class: 'input', type: 'text', maxlength: '40', value: c.name || '', autofocus: true });
  const emoji = h('input', { class: 'input input-emoji', type: 'text', maxlength: '4', value: c.icon || '', 'aria-label': 'Icon' });
  const kind = select([{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }], c.kind, { disabled: !!existing });
  const color = slotPicker(c.color < 0 ? 0 : c.color);
  const fName = field('Name', h('div', { class: 'row gap-sm' }, emoji, name));
  const builtIn = existing && existing.id === UNCATEGORIZED;
  return formModal(
    existing ? 'Edit category' : 'New category',
    (form) => form.append(h('div', { class: 'span-2' }, fName), field('Kind', kind), field('Color', color)),
    {
      size: 'sm',
      onSubmit: () => {
        setFieldError(fName, name.value.trim() ? '' : 'Name is required');
        if (!name.value.trim()) return false;
        return app.actions.save('categories', { ...c, name: name.value, icon: emoji.value, kind: kind.value, color: color.getValue() });
      },
      onDelete: existing && !builtIn ? (modal) => { modal.close(); app.actions.remove('categories', existing.id); } : null,
    },
  );
}

export function ruleForm(app, existing) {
  const r = existing || {};
  const pattern = h('input', { class: 'input', type: 'text', maxlength: '60', value: r.pattern || '', placeholder: 'e.g. whole foods', autofocus: true });
  const cat = select([{ group: 'Expense', options: categoryOptions(app.data, 'expense') }, { group: 'Income', options: categoryOptions(app.data, 'income') }], r.categoryId || 'cat_groceries');
  const fPattern = field('When payee contains', pattern, { hint: 'Case-insensitive text match' });
  return formModal(
    existing ? 'Edit rule' : 'New auto-categorization rule',
    (form) => form.append(fPattern, field('Set category to', cat)),
    {
      size: 'sm',
      onSubmit: () => {
        setFieldError(fPattern, pattern.value.trim() ? '' : 'Enter some text to match');
        if (!pattern.value.trim()) return false;
        return app.actions.save('rules', { ...r, pattern: pattern.value, categoryId: cat.value });
      },
      onDelete: existing ? (modal) => { modal.close(); app.actions.remove('rules', existing.id); } : null,
    },
  );
}
