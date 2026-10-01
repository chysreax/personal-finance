/**
 * Single source of truth. A tiny Redux-style store: actions → pure reducer →
 * new immutable snapshot → subscribers (views, encrypted persistence, sync).
 * Every mutation stamps `updatedAt` so replicas can merge deterministically.
 */
import { stamp, uid } from '../core/ids.js';
import { emptyData, normalizeRecord, COLLECTIONS } from '../core/schema.js';
import { dueRecurring } from '../core/recurring.js';

export function createStore(initial = emptyData()) {
  let data = initial;
  let version = 0;
  const listeners = new Set();

  function dispatch(action) {
    const next = reduce(data, action);
    if (next === data) return data;
    data = next;
    version++;
    for (const fn of listeners) fn(data, action);
    return data;
  }

  return {
    get data() {
      return data;
    },
    get version() {
      return version;
    },
    dispatch,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Stamp a record so it wins over any older copy (even with clock skew). */
function touch(record, prev) {
  return { ...record, updatedAt: stamp(Math.max(Date.now(), (prev?.updatedAt || 0) + 1)) };
}

function upsert(list, record) {
  const i = list.findIndex((r) => r.id === record.id);
  if (i === -1) return [...list, touch(record)];
  const copy = list.slice();
  copy[i] = touch(record, list[i]);
  return copy;
}

function reduce(data, action) {
  switch (action.type) {
    case 'data/replace':
      return action.data;

    case 'entity/upsert': {
      const { collection } = action;
      if (!COLLECTIONS.includes(collection)) return data;
      const draft = { id: action.record.id || uid(), deleted: false, ...action.record, updatedAt: 1 };
      if (collection === 'transactions' && !draft.createdAt) draft.createdAt = Date.now();
      const clean = normalizeRecord(collection, draft);
      if (!clean) throw new Error(`Invalid ${collection.slice(0, -1)} record`);
      return { ...data, [collection]: upsert(data[collection], clean) };
    }

    case 'entity/bulkUpsert': {
      const { collection } = action;
      let list = data[collection];
      const byId = new Map(list.map((r, i) => [r.id, i]));
      list = list.slice();
      for (const rec of action.records) {
        const draft = { id: rec.id || uid(), deleted: false, createdAt: Date.now(), ...rec, updatedAt: 1 };
        const clean = normalizeRecord(collection, draft);
        if (!clean) continue;
        const i = byId.get(clean.id);
        if (i === undefined) {
          byId.set(clean.id, list.length);
          list.push(touch(clean));
        } else list[i] = touch(clean, list[i]);
      }
      return { ...data, [collection]: list };
    }

    case 'entity/delete': {
      const { collection } = action;
      const ids = new Set(action.ids || [action.id]);
      let changed = false;
      const list = data[collection].map((r) => {
        if (!ids.has(r.id) || r.deleted) return r;
        changed = true;
        return touch({ id: r.id, deleted: true }, r);
      });
      return changed ? { ...data, [collection]: list } : data;
    }

    case 'settings/update':
      return { ...data, settings: { ...data.settings, ...action.patch, updatedAt: stamp(Math.max(Date.now(), data.settings.updatedAt + 1)) } };

    case 'goal/contribute': {
      const goal = data.goals.find((g) => g.id === action.id && !g.deleted);
      if (!goal) return data;
      const saved = Math.max(0, goal.saved + action.amount);
      const history = [...goal.history, { date: action.date, amount: action.amount }].slice(-240);
      return { ...data, goals: upsert(data.goals, { ...goal, saved, history }) };
    }

    case 'recurring/postDue': {
      // Materialise every due occurrence as a transaction and advance the schedule.
      const due = dueRecurring(data, action.today).filter((d) => !action.ids || action.ids.includes(d.item.id));
      if (!due.length) return data;
      let txs = data.transactions;
      let recurring = data.recurring;
      for (const { item, dates, nextDate } of due) {
        for (const date of dates) {
          const tx = normalizeRecord('transactions', {
            id: uid('tx_'), date, amount: item.amount, type: item.type, accountId: item.accountId,
            categoryId: item.categoryId, payee: item.payee, note: item.note, tags: [], recurringId: item.id,
            createdAt: Date.now(), updatedAt: 1,
          });
          if (tx) txs = [...txs, touch(tx)];
        }
        recurring = upsert(recurring, { ...item, nextDate });
      }
      return { ...data, transactions: txs, recurring };
    }

    case 'recurring/skip': {
      const item = data.recurring.find((r) => r.id === action.id);
      if (!item) return data;
      const next = dueRecurring({ ...data, recurring: [item] }, action.today)[0];
      return next ? { ...data, recurring: upsert(data.recurring, { ...item, nextDate: next.nextDate }) } : data;
    }

    default:
      return data;
  }
}
