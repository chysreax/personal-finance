/**
 * High-level commands shared by every view. All mutations are optimistic:
 * the store updates (and the UI re-renders) immediately; persistence and
 * remote sync follow in the background. Deletes offer an Undo.
 */
import { toast } from './components.js';
import { autoCategorizeAll } from '../core/categorize.js';
import { dueRecurring } from '../core/recurring.js';
import { live } from '../core/finance.js';

const NOUN = {
  transactions: 'Transaction', accounts: 'Account', budgets: 'Budget', goals: 'Goal', recurring: 'Recurring item', categories: 'Category', rules: 'Rule',
};

export function createActions(app) {
  const { store } = app;

  function save(collection, record, { quiet = false, message } = {}) {
    const isNew = !record.id || !store.data[collection].some((r) => r.id === record.id && !r.deleted);
    try {
      store.dispatch({ type: 'entity/upsert', collection, record });
      if (!quiet) toast(message || `${NOUN[collection]} ${isNew ? 'added' : 'updated'}`, { tone: 'success' });
      return true;
    } catch (err) {
      toast(err.message || 'Could not save', { tone: 'danger' });
      return false;
    }
  }

  function remove(collection, ids, { label } = {}) {
    const list = Array.isArray(ids) ? ids : [ids];
    const snapshot = store.data[collection].filter((r) => list.includes(r.id) && !r.deleted);
    if (!snapshot.length) return;
    store.dispatch({ type: 'entity/delete', collection, ids: list });
    const what = label || (snapshot.length === 1 ? NOUN[collection] : `${snapshot.length} ${collection}`);
    toast(`${what} deleted`, {
      action: {
        label: 'Undo',
        fn: () => {
          store.dispatch({ type: 'entity/bulkUpsert', collection, records: snapshot.map((r) => ({ ...r, deleted: false })) });
          toast('Restored', { tone: 'success' });
        },
      },
    });
  }

  function postDue(ids) {
    const due = dueRecurring(store.data, app.today()).filter((d) => !ids || ids.includes(d.item.id));
    const n = due.reduce((s, d) => s + d.dates.length, 0);
    if (!n) return toast('Nothing is due right now');
    store.dispatch({ type: 'recurring/postDue', today: app.today(), ids });
    toast(`Posted ${n} scheduled transaction${n === 1 ? '' : 's'}`, { tone: 'success' });
  }

  function skip(id) {
    store.dispatch({ type: 'recurring/skip', id, today: app.today() });
    toast('Skipped this occurrence');
  }

  function autoCategorize() {
    const changed = autoCategorizeAll(store.data);
    const total = live(store.data.transactions).filter((t) => t.type !== 'transfer' && t.categoryId === 'cat_uncategorized').length;
    if (!changed.length) return toast(total ? 'No confident matches — add a rule in Settings' : 'Everything is already categorized');
    store.dispatch({ type: 'entity/bulkUpsert', collection: 'transactions', records: changed });
    toast(`Categorized ${changed.length} of ${total} transaction${total === 1 ? '' : 's'}`, { tone: 'success' });
  }

  function contribute(goalId, amount, date = app.today()) {
    store.dispatch({ type: 'goal/contribute', id: goalId, amount, date });
    toast(amount >= 0 ? `Added ${app.money(amount)} to goal` : `Withdrew ${app.money(-amount)}`, { tone: 'success' });
  }

  function run(command) {
    if (command === 'post-due') return postDue();
    if (command === 'auto-categorize') return autoCategorize();
  }

  return { save, remove, postDue, skip, autoCategorize, contribute, run };
}
