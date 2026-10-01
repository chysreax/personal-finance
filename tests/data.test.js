import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeData, emptyData, cleanText, SchemaError } from '../js/core/schema.js';
import { mergeData, pruneTombstones } from '../js/core/merge.js';
import { toCents, formatMoney } from '../js/core/money.js';
import { toCSV, parseCSV, csvToDrafts } from '../js/core/csv.js';
import { createStore } from '../js/state/store.js';
import { redact, tokenShape } from '../js/core/redact.js';

test('toCents parses common formats', () => {
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('1.234,56'), 123456);
  assert.equal(toCents('12,5'), 1250);
  assert.equal(toCents('$40'), 4000);
  assert.equal(toCents('-7.10'), -710);
  assert.ok(Number.isNaN(toCents('abc')));
  assert.ok(Number.isNaN(toCents('')));
});

test('formatMoney formats cents', () => {
  assert.match(formatMoney(123456, 'USD', { locale: 'en-US' }), /\$1,234\.56/);
});

test('sanitiser strips control and bidi characters', () => {
  assert.equal(cleanText('a‮b\u0000c'), 'a b c');
  assert.equal(cleanText('x'.repeat(500), 10).length, 10);
});

test('normalizeData drops invalid records and keeps XSS strings inert', () => {
  const raw = {
    ...emptyData(),
    accounts: [{ id: 'acc1', name: 'Checking', type: 'checking', opening: 1000, updatedAt: 1 }],
    transactions: [
      { id: 'ok1', date: '2026-09-01', amount: 500, type: 'expense', accountId: 'acc1', payee: '<img src=x onerror=alert(1)>', updatedAt: 1 },
      { id: 'bad-amount', date: '2026-09-01', amount: -5, type: 'expense', accountId: 'acc1', updatedAt: 1 },
      { id: 'bad-date', date: '2026-13-40', amount: 5, type: 'expense', accountId: 'acc1', updatedAt: 1 },
      { id: '../../etc', date: '2026-09-01', amount: 5, type: 'expense', accountId: 'acc1', updatedAt: 1 },
      { id: 'float', date: '2026-09-01', amount: 1.5, type: 'expense', accountId: 'acc1', updatedAt: 1 },
      'garbage',
    ],
  };
  const { data, dropped } = normalizeData(raw);
  assert.equal(data.transactions.length, 1);
  assert.equal(dropped, 5);
  // Stored as plain text; rendering uses textContent so it can never execute.
  assert.equal(data.transactions[0].payee, '<img src=x onerror=alert(1)>');
  assert.equal(data.transactions[0].categoryId, 'cat_uncategorized');
});

test('normalizeData rejects non-datasets', () => {
  assert.throws(() => normalizeData([]), SchemaError);
  assert.throws(() => normalizeData({ hello: 1 }), SchemaError);
  assert.throws(() => normalizeData({ schema: 99, transactions: [] }), SchemaError);
});

test('LWW merge keeps both sides’ independent edits and propagates deletes', () => {
  const base = emptyData();
  const a = { ...base, transactions: [{ id: 't1', updatedAt: 10, payee: 'A' }, { id: 't2', updatedAt: 5, payee: 'old' }] };
  const b = { ...base, transactions: [{ id: 't2', updatedAt: 20, deleted: true }, { id: 't3', updatedAt: 7, payee: 'B' }] };
  const { data, stats } = mergeData(a, b);
  const byId = Object.fromEntries(data.transactions.map((t) => [t.id, t]));
  assert.equal(byId.t1.payee, 'A');
  assert.equal(byId.t2.deleted, true);
  assert.equal(byId.t3.payee, 'B');
  assert.ok(stats.localWins >= 1 && stats.remoteWins >= 2);
  // commutative
  const ba = mergeData(b, a).data.transactions.map((t) => JSON.stringify(t)).sort();
  assert.deepEqual(data.transactions.map((t) => JSON.stringify(t)).sort(), ba);
});

test('pruneTombstones removes only old tombstones', () => {
  const now = Date.now();
  const d = { ...emptyData(), transactions: [{ id: 'a', deleted: true, updatedAt: now - 200 * 864e5 }, { id: 'b', deleted: true, updatedAt: now }] };
  assert.deepEqual(pruneTombstones(d, now).transactions.map((t) => t.id), ['b']);
});

test('store stamps updatedAt monotonically and tombstones deletes', () => {
  const store = createStore();
  store.dispatch({ type: 'entity/upsert', collection: 'accounts', record: { id: 'acc1', name: 'Cash', type: 'cash', opening: 0 } });
  store.dispatch({ type: 'entity/upsert', collection: 'transactions', record: { id: 'tx1', date: '2026-09-02', amount: 100, type: 'expense', accountId: 'acc1' } });
  const first = store.data.transactions[0].updatedAt;
  store.dispatch({ type: 'entity/upsert', collection: 'transactions', record: { ...store.data.transactions[0], amount: 200 } });
  assert.ok(store.data.transactions[0].updatedAt > first);
  store.dispatch({ type: 'entity/delete', collection: 'transactions', id: 'tx1' });
  assert.equal(store.data.transactions[0].deleted, true);
  assert.equal(store.data.transactions[0].amount, undefined, 'tombstone keeps no payload');
});

test('CSV export neutralises formula injection; import round-trips', () => {
  const csv = toCSV([{ p: '=HYPERLINK("http://evil")', a: -12.5 }], [{ label: 'Payee', get: (r) => r.p }, { label: 'Amount', get: (r) => r.a }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(csv.includes('-12.5'));
  const rows = parseCSV('Date,Description,Amount\n2026-09-01,"Coffee, large",-4.50\n09/15/2026,Salary,3000\n');
  assert.equal(rows.length, 3);
  const { drafts, errors } = csvToDrafts('Date,Description,Amount\n2026-09-01,"Coffee, large",-4.50\n09/15/2026,Salary,3000\nbad,row,x\n', { categoriesByName: new Map() });
  assert.equal(drafts.length, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual([drafts[0].type, drafts[0].amount, drafts[0].payee], ['expense', 450, 'Coffee, large']);
  assert.equal(drafts[1].date, '2026-09-15');
});

test('token redaction and shape checks', () => {
  const tok = `ghp_${'a'.repeat(36)}`;
  assert.equal(redact(`failed with ${tok}`), 'failed with [redacted]');
  assert.equal(redact(`Authorization: Bearer ${'x'.repeat(20)}`).includes('x'.repeat(20)), false);
  assert.equal(tokenShape(tok), 'classic');
  assert.equal(tokenShape(`github_pat_${'b'.repeat(40)}`), 'fine-grained');
  assert.equal(tokenShape('hunter2'), 'invalid');
  assert.equal(tokenShape(`ghp_${'a'.repeat(36)}\r\nX-Evil: 1`), 'invalid');
});
