// End-to-end sync tests against an in-memory fake of the GitHub Gists API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGistClient, VAULT_FILE } from '../js/services/github.js';
import { createLocalStore } from '../js/services/storage.js';
import { createSession, createVault } from '../js/services/vault.js';
import { createSync } from '../js/services/sync.js';
import { createStore } from '../js/state/store.js';
import { deriveKeys } from '../js/core/crypto.js';
import { emptyData } from '../js/core/schema.js';

const TOKEN = `ghp_${'T'.repeat(36)}`;

function fakeGitHub() {
  const gists = new Map();
  const log = [];
  let seq = 0;
  const faults = { next: null, outage: 0 }; // one-shot injected response / N network failures
  const json = (status, body, headers = {}) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600), ...headers } });

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    const headers = init.headers || {};
    log.push({ url, method, auth: headers.Authorization || null });
    if (faults.outage > 0) {
      faults.outage--;
      throw new TypeError('Failed to fetch');
    }
    if (faults.next) {
      const f = faults.next;
      faults.next = null;
      if (f === 'network') throw new TypeError('Failed to fetch');
      return f();
    }
    if (headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.pathname === '/user') return json(200, { login: 'octo' });
    if (parts[0] === 'gists' && parts.length === 1) {
      if (method === 'GET') return json(200, [...gists.entries()].map(([id, g]) => ({ id, files: { [VAULT_FILE]: { filename: VAULT_FILE } }, updated_at: g.updated })));
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        const id = `abc${(++seq).toString(16).padStart(29, '0')}`;
        gists.set(id, { content: body.files[VAULT_FILE].content, etag: `"e${seq}"`, updated: new Date().toISOString(), public: body.public });
        return json(201, { id });
      }
    }
    if (parts[0] === 'gists' && parts.length === 2) {
      const g = gists.get(parts[1]);
      if (!g) return json(404, { message: 'Not Found' });
      if (method === 'GET') {
        if (headers['If-None-Match'] === g.etag) return new Response(null, { status: 304, headers: { 'x-ratelimit-remaining': '4999' } });
        return json(200, { id: parts[1], files: { [VAULT_FILE]: { content: g.content, truncated: false } }, updated_at: g.updated }, { etag: g.etag });
      }
      if (method === 'PATCH') {
        g.content = JSON.parse(init.body).files[VAULT_FILE].content;
        g.etag = `"e${++seq}"`;
        return json(200, { id: parts[1] }, { etag: g.etag });
      }
      if (method === 'DELETE') {
        gists.delete(parts[1]);
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { message: 'Not Found' });
  }
  return { fetchImpl, gists, log, faults };
}

function memoryBackend() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => [...m.values()].join('\n') };
}

async function device(gh, keys, initial = emptyData()) {
  const backend = memoryBackend();
  const storage = createLocalStore(backend);
  const session = createSession();
  const vault = createVault({ storage, session });
  session.setKeys(keys);
  const store = createStore(initial);
  const client = createGistClient({ getToken: () => session.getToken(), fetchImpl: gh.fetchImpl, baseDelayMs: 1, retries: 1 });
  const sync = createSync({
    client, vault, session, storage, pollMs: 1e9, debounceMs: 1e9,
    getData: () => store.data,
    getVersion: () => store.version,
    applyRemote: (data) => store.dispatch({ type: 'data/replace', data, source: 'remote' }),
  });
  store.subscribe((_d, action) => action.source !== 'remote' && sync.notifyLocalChange());
  await vault.persist(store.data);
  return { storage, session, vault, store, sync, backend };
}

const acct = { id: 'acc1', name: 'Checking', type: 'checking', opening: 10_000 };
const tx = (id, payee, amount = 1_000) => ({ id, date: '2026-09-10', amount, type: 'expense', accountId: 'acc1', payee });

test('two devices converge through an encrypted gist (create, read, update, delete)', async (t) => {
  const gh = fakeGitHub();
  const keys = await deriveKeys('shared vault passphrase', { iterations: 100_000 });
  const A = await device(gh, keys);
  const B = await device(gh, keys);
  t.after(() => { A.sync.stop(); B.sync.stop(); });

  A.store.dispatch({ type: 'entity/upsert', collection: 'accounts', record: acct });
  A.store.dispatch({ type: 'entity/upsert', collection: 'transactions', record: tx('t1', 'Very Secret Payee') });

  // CREATE
  const res = await A.sync.connect({ token: TOKEN, remember: false, ttlHours: 1 });
  assert.equal(res.created, true);
  assert.equal(gh.gists.size, 1);
  const stored = [...gh.gists.values()][0];
  assert.equal(stored.public, false, 'vault gist must be secret');
  assert.ok(!stored.content.includes('Very Secret Payee'), 'GitHub must only ever see ciphertext');
  assert.ok(stored.content.includes('AES-256-GCM'));

  // READ (B discovers the gist automatically)
  await B.sync.connect({ token: TOKEN, ttlHours: 1 });
  assert.equal(B.sync.state.status, 'synced');
  assert.equal(B.store.data.transactions.find((x) => x.id === 't1')?.payee, 'Very Secret Payee');

  // concurrent edits on both devices
  A.store.dispatch({ type: 'entity/upsert', collection: 'transactions', record: tx('t2', 'From A') });
  B.store.dispatch({ type: 'entity/upsert', collection: 'transactions', record: tx('t3', 'From B') });
  await A.sync.syncNow();
  await B.sync.syncNow();
  await A.sync.syncNow();
  const ids = (s) => s.store.data.transactions.filter((x) => !x.deleted).map((x) => x.id).sort();
  assert.deepEqual(ids(A), ['t1', 't2', 't3']);
  assert.deepEqual(ids(B), ['t1', 't2', 't3']);

  // DELETE propagates as a tombstone
  B.store.dispatch({ type: 'entity/delete', collection: 'transactions', id: 't1' });
  await B.sync.syncNow();
  await A.sync.syncNow();
  assert.deepEqual(ids(A), ['t2', 't3']);

  // unchanged remote → conditional GET answered with 304
  await A.sync.syncNow();
  const last = gh.log[gh.log.length - 1];
  assert.equal(last.method, 'GET');

  // token never in a URL; Authorization only ever sent to api.github.com
  for (const r of gh.log) {
    assert.ok(!r.url.includes(TOKEN));
    if (r.auth) assert.ok(r.url.startsWith('https://api.github.com/'));
  }
  // local storage never holds plaintext data or the token
  assert.ok(!A.backend.dump().includes('From A'));
  assert.ok(!A.backend.dump().includes(TOKEN));

  // DELETE the remote vault
  await A.sync.destroyRemote();
  assert.equal(gh.gists.size, 0);
  assert.equal(A.sync.state.status, 'disconnected');
});

test('tampered remote pauses sync, preserves local data, and can be restored', async (t) => {
  const gh = fakeGitHub();
  const keys = await deriveKeys('tamper scenario passphrase', { iterations: 100_000 });
  const A = await device(gh, keys);
  t.after(() => A.sync.stop());
  A.store.dispatch({ type: 'entity/upsert', collection: 'accounts', record: acct });
  await A.sync.connect({ token: TOKEN, ttlHours: 1 });
  const [id, g] = [...gh.gists.entries()][0];

  const env = JSON.parse(g.content);
  env.meta.rev = 999; // attacker bumps the revision to force adoption
  g.content = JSON.stringify(env);
  g.etag = '"forged"';
  A.storage.writeMeta({ etag: null });
  await A.sync.syncNow();
  assert.equal(A.sync.state.status, 'tampered');
  assert.equal(A.store.data.accounts.length, 1, 'local data untouched');

  // further syncs are blocked until the user decides
  const before = gh.log.length;
  await A.sync.syncNow();
  assert.equal(gh.log.length, before);

  await A.sync.resolve('overwrite-remote');
  assert.equal(A.sync.state.status, 'synced');
  const verified = await A.sync.verifyRemote();
  assert.ok(verified.rev >= 1);
  assert.ok(gh.gists.has(id));
});

test('malformed remote JSON is detected and never merged', async (t) => {
  const gh = fakeGitHub();
  const keys = await deriveKeys('malformed scenario pass', { iterations: 100_000 });
  const A = await device(gh, keys);
  t.after(() => A.sync.stop());
  await A.sync.connect({ token: TOKEN, ttlHours: 1 });
  const g = [...gh.gists.values()][0];
  g.content = '{"format":"pfm-vault", "oops": ';
  g.etag = '"broken"';
  await A.sync.syncNow();
  assert.equal(A.sync.state.status, 'malformed');
});

test('invalid token, rate limits and network drops map to recoverable states', async (t) => {
  const gh = fakeGitHub();
  const keys = await deriveKeys('error scenario passphrase', { iterations: 100_000 });
  const A = await device(gh, keys);
  t.after(() => A.sync.stop());
  await A.sync.connect({ token: TOKEN, ttlHours: 1 });

  gh.faults.next = () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } });
  A.storage.writeMeta({ etag: null });
  await A.sync.syncNow();
  assert.equal(A.sync.state.status, 'rate-limited');
  assert.match(A.sync.state.message, /rate limit/i);
  A.sync.stop();
});

test('network failure goes offline (with retry) and 401 purges the token', async (t) => {
  const gh = fakeGitHub();
  const keys = await deriveKeys('offline scenario passphrase', { iterations: 100_000 });
  const A = await device(gh, keys);
  t.after(() => A.sync.stop());
  await A.sync.connect({ token: TOKEN, ttlHours: 1 });

  // a persistent outage exhausts the client's retry and surfaces as "offline"
  gh.faults.outage = 3;
  A.storage.writeMeta({ etag: null });
  await A.sync.syncNow();
  assert.equal(A.sync.state.status, 'offline');
  assert.equal(gh.faults.outage, 1, 'request was retried once before giving up');
  gh.faults.outage = 0;

  gh.faults.next = () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  A.sync.stop();
  await A.sync.syncNow();
  assert.equal(A.sync.state.status, 'auth');
  assert.equal(A.session.getToken(), null, 'token purged after 401');
});

test('connect rejects strings that are not GitHub tokens', async () => {
  const gh = fakeGitHub();
  const keys = await deriveKeys('reject scenario passphrase', { iterations: 100_000 });
  const A = await device(gh, keys);
  await assert.rejects(A.sync.connect({ token: 'my-password-123' }), /does not look like/);
  assert.equal(gh.log.length, 0, 'nothing sent over the network');
});
