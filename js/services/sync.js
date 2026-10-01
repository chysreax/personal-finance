/**
 * Sync engine: GitHub Gist as a pseudo-cloud NoSQL document store.
 *
 *   pull (conditional GET, ETag) → verify HMAC → decrypt → validate schema
 *        → LWW merge with local → push (PATCH) only if remote is missing something
 *
 * Safety rules:
 *   • remote data that fails integrity or schema checks is NEVER merged and
 *     NEVER silently overwritten — sync pauses until the user decides;
 *   • stale reads (GitHub caches gists briefly) are detected via `rev` and do
 *     not trigger push storms;
 *   • offline / rate-limit / server errors back off and resume automatically,
 *     local edits stay queued (meta.dirty survives reloads).
 */
import { assertEnvelope, open, keysMatch, deriveKeys, fingerprint, CryptoError } from '../core/crypto.js';
import { normalizeData, SchemaError } from '../core/schema.js';
import { mergeData, pruneTombstones } from '../core/merge.js';
import { GitHubError } from './github.js';
import { tokenShape, redact } from '../core/redact.js';

const MAX_GIST_CHARS = 9_500_000; // GitHub rejects files ≳10 MB
export const BLOCKING = new Set(['tampered', 'malformed', 'rekeyed', 'missing']);

/**
 * @param {{
 *   client: ReturnType<import('./github.js').createGistClient>,
 *   vault: ReturnType<import('./vault.js').createVault>,
 *   session: ReturnType<import('./vault.js').createSession>,
 *   storage: ReturnType<import('./storage.js').createLocalStore>,
 *   getData: () => object, getVersion: () => number, applyRemote: (data: object) => void,
 *   online?: () => boolean, visible?: () => boolean, pollMs?: number, debounceMs?: number,
 * }} deps
 */
export function createSync(deps) {
  const { client, vault, session, storage } = deps;
  const online = deps.online || (() => true);
  const visible = deps.visible || (() => true);
  const pollMs = deps.pollMs ?? 60_000;
  const debounceMs = deps.debounceMs ?? 1_500;

  let state = {
    status: 'disconnected',
    message: '',
    lastSyncAt: storage.readMeta().lastSyncAt,
    remoteRev: storage.readMeta().remoteRev,
    login: storage.readMeta().login,
    gistId: storage.readMeta().gistId,
    fingerprint: null,
    rateRemaining: null,
  };
  const listeners = new Set();
  let inFlight = null;
  let again = false;
  let timer = null;
  let pollTimer = null;
  let blockedUntil = 0;
  let backoff = 0;
  let pendingEnv = null;

  function set(patch) {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn(state));
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => run(), ms);
  }

  const hasRemote = () => !!storage.readMeta().gistId;

  /* ---------- core cycle ---------- */

  async function cycle({ forcePush = false, ignoreRemote = false } = {}) {
    const meta = storage.readMeta();
    if (!meta.gistId) return set({ status: 'disconnected', message: '' });
    if (!session.unlocked) return;
    if (!session.getToken()) return set({ status: 'auth', message: 'Reconnect GitHub to resume sync' });
    if (!online()) return set({ status: 'offline', message: 'Offline — changes are saved locally and will sync later' });
    if (blockedUntil > Date.now()) return set({ status: 'rate-limited' });
    if (BLOCKING.has(state.status) && !forcePush) return;

    set({ status: 'syncing', message: '' });
    let remoteRev = meta.remoteRev;
    let needPush = meta.dirty || forcePush;

    if (!ignoreRemote) {
      const res = await client.readVault(meta.gistId, meta.etag);
      if (!res.notModified) {
        if (res.content === null) {
          needPush = true; // vault file removed from the gist → rewrite it
        } else {
          let env;
          try {
            env = JSON.parse(res.content);
          } catch {
            throw new CryptoError('MALFORMED', 'Remote vault is not valid JSON');
          }
          assertEnvelope(env);
          if (!keysMatch(session.getKeys(), env)) {
            pendingEnv = env;
            return set({ status: 'rekeyed', message: 'The remote vault uses a different passphrase. Enter it to continue syncing.' });
          }
          const { value, meta: rmeta } = await open(session.getKeys(), env);
          const { data: remoteData } = normalizeData(value);
          const { data: merged, stats } = mergeData(deps.getData(), remoteData);
          if (stats.remoteWins > 0) deps.applyRemote(merged);
          const stale = rmeta.rev < meta.remoteRev;
          if (stats.localWins > 0 && !stale) needPush = true;
          if (!stale) remoteRev = rmeta.rev;
          set({ fingerprint: await fingerprint(env), remoteRev: rmeta.rev });
          storage.writeMeta({ etag: stale ? null : res.etag, remoteRev });
        }
      }
    }

    if (needPush) {
      const versionAtPush = deps.getVersion();
      const rev = Math.max(remoteRev, storage.readMeta().remoteRev) + 1;
      const env = await vault.sealForRemote(pruneTombstones(deps.getData()), rev);
      const content = JSON.stringify(env);
      if (content.length > MAX_GIST_CHARS) throw new GitHubError('TOO_LARGE', 'Vault exceeds GitHub gist size limits');
      await client.writeVault(meta.gistId, content);
      storage.writeMeta({ remoteRev: rev, etag: null, dirty: deps.getVersion() !== versionAtPush });
      set({ fingerprint: await fingerprint(env), remoteRev: rev });
    }

    const now = Date.now();
    storage.writeMeta({ lastSyncAt: now });
    backoff = 0;
    const dirty = storage.readMeta().dirty;
    set({ status: dirty ? 'pending' : 'synced', message: '', lastSyncAt: now, rateRemaining: client.rate.remaining });
    if (dirty) schedule(debounceMs);
  }

  function handleError(err) {
    if (err instanceof CryptoError) {
      if (err.code === 'TAMPERED' || err.code === 'WRONG_PASSPHRASE') {
        return set({ status: 'tampered', message: 'Remote vault failed HMAC-SHA256 integrity verification. It was modified outside this app or corrupted. Sync is paused to protect your data.' });
      }
      return set({ status: 'malformed', message: `Remote vault is unreadable: ${redact(err.message)}. Sync is paused; your local data is untouched.` });
    }
    if (err instanceof SchemaError) {
      return set({ status: 'malformed', message: `Remote dataset failed validation: ${redact(err.message)}. Sync is paused.` });
    }
    if (err instanceof GitHubError) {
      switch (err.code) {
        case 'UNAUTHORIZED':
        case 'NO_TOKEN':
          vault.forgetToken();
          return set({ status: 'auth', message: 'GitHub token is invalid, expired or revoked. Reconnect to resume sync.' });
        case 'FORBIDDEN':
          return set({ status: 'auth', message: 'Token is missing the "gist" scope (classic) or Gists read/write permission (fine-grained).' });
        case 'RATE_LIMITED':
          blockedUntil = err.resetAt || Date.now() + 60_000;
          schedule(Math.max(1_000, blockedUntil - Date.now() + 500));
          return set({ status: 'rate-limited', message: `GitHub rate limit reached. Sync resumes at ${new Date(blockedUntil).toLocaleTimeString()}.` });
        case 'NOT_FOUND':
          return set({ status: 'missing', message: 'The vault gist no longer exists (or the token cannot access it).' });
        case 'NETWORK':
        case 'TIMEOUT':
          backoff = Math.min(300_000, backoff ? backoff * 2 : 15_000);
          schedule(backoff);
          return set({ status: 'offline', message: 'Cannot reach GitHub — retrying automatically. Changes are safe locally.' });
        case 'SERVER':
          backoff = Math.min(300_000, backoff ? backoff * 2 : 20_000);
          schedule(backoff);
          return set({ status: 'error', message: `${err.message}. Retrying in ${Math.round(backoff / 1000)}s.` });
        default:
          return set({ status: 'error', message: redact(err.message) });
      }
    }
    return set({ status: 'error', message: redact(err?.message || 'Unknown sync error') });
  }

  function run(opts) {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    clearTimeout(timer);
    inFlight = cycle(opts)
      .catch(handleError)
      .finally(() => {
        inFlight = null;
        if (again) {
          again = false;
          schedule(250);
        }
      });
    return inFlight;
  }

  /* ---------- public API ---------- */

  return {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },

    /** Called by the store on every local mutation. */
    notifyLocalChange() {
      storage.writeMeta({ dirty: true });
      if (!hasRemote()) return;
      if (!BLOCKING.has(state.status)) set({ status: state.status === 'syncing' ? 'syncing' : 'pending' });
      schedule(debounceMs);
    },

    syncNow: () => run(),
    kick() {
      if (hasRemote() && !BLOCKING.has(state.status)) run();
    },

    start() {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (visible() && online() && hasRemote() && !BLOCKING.has(state.status)) run();
      }, pollMs);
      if (!hasRemote()) set({ status: 'disconnected' });
      else run();
    },
    stop() {
      clearInterval(pollTimer);
      clearTimeout(timer);
      pollTimer = null;
    },

    /**
     * Validate a PAT, find or create the vault gist, and run the first sync.
     * @param {{token: string, gistId?: string, remember?: boolean, ttlHours?: number}} o
     */
    async connect(o) {
      const token = (o.token || '').trim();
      if (tokenShape(token) === 'invalid') throw new GitHubError('UNAUTHORIZED', 'That does not look like a GitHub personal access token');
      const ttlHours = o.ttlHours || storage.readMeta().tokenTtlHours;
      session.setToken(token, ttlHours * 3_600_000);
      try {
        const { login } = await client.whoAmI();
        let gistId = (o.gistId || '').trim() || null;
        let created = false;
        if (gistId) {
          await client.readVault(gistId); // throws NOT_FOUND if unreachable
        } else {
          gistId = (await client.findVault())?.id || null;
        }
        if (!gistId) {
          const env = await vault.sealForRemote(deps.getData(), 1);
          gistId = (await client.createVault(JSON.stringify(env))).id;
          created = true;
          storage.writeMeta({ remoteRev: 1, dirty: false });
          set({ fingerprint: await fingerprint(env) });
        } else {
          storage.writeMeta({ remoteRev: 0, dirty: true });
        }
        storage.writeMeta({ gistId, login, etag: null, rememberToken: !!o.remember, tokenTtlHours: ttlHours });
        if (o.remember) await vault.rememberToken(token, ttlHours);
        else storage.clearToken();
        set({ status: 'syncing', login, gistId, message: '' });
        this.start();
        await inFlight;
        return { login, gistId, created };
      } catch (err) {
        if (err instanceof GitHubError && (err.code === 'UNAUTHORIZED' || err.code === 'FORBIDDEN')) vault.forgetToken();
        throw err;
      }
    },

    /** Forget the token (and optionally the gist link) on this device. */
    disconnect({ unlink = false } = {}) {
      this.stop();
      vault.forgetToken();
      if (unlink) storage.writeMeta({ gistId: null, login: null, etag: null, remoteRev: 0 });
      set({ status: unlink ? 'disconnected' : 'auth', message: unlink ? '' : 'Token removed from this device', gistId: unlink ? null : state.gistId });
    },

    /** User decision after tamper / malformed / missing. */
    async resolve(action) {
      if (action === 'overwrite-remote') {
        set({ status: 'idle' });
        storage.writeMeta({ etag: null });
        return run({ forcePush: true, ignoreRemote: true });
      }
      if (action === 'recreate') {
        const env = await vault.sealForRemote(deps.getData(), 1);
        const { id } = await client.createVault(JSON.stringify(env));
        storage.writeMeta({ gistId: id, etag: null, remoteRev: 1, dirty: false });
        set({ status: 'synced', gistId: id, fingerprint: await fingerprint(env), lastSyncAt: Date.now() });
        return;
      }
      if (action === 'retry') {
        set({ status: 'idle' });
        storage.writeMeta({ etag: null });
        return run();
      }
    },

    /** The remote was re-keyed on another device: derive its keys and adopt them. */
    async provideRemotePassphrase(passphrase) {
      if (!pendingEnv) return;
      const keys = await deriveKeys(passphrase, { salt: pendingEnv.kdf.salt, iterations: pendingEnv.kdf.iterations });
      await open(keys, pendingEnv); // throws WRONG_PASSPHRASE / TAMPERED
      const token = session.getToken();
      session.setKeys(keys);
      await vault.persist(deps.getData());
      const meta = storage.readMeta();
      if (token && meta.rememberToken) await vault.rememberToken(token, meta.tokenTtlHours);
      pendingEnv = null;
      storage.writeMeta({ etag: null });
      set({ status: 'idle', message: '' });
      return run();
    },

    /** Delete the remote gist (the "D" in CRUD). */
    async destroyRemote() {
      const { gistId } = storage.readMeta();
      if (!gistId) return;
      await client.deleteVault(gistId);
      storage.writeMeta({ gistId: null, etag: null, remoteRev: 0 });
      this.stop();
      set({ status: 'disconnected', gistId: null, fingerprint: null });
    },

    /** Re-download and verify the remote payload without merging. */
    async verifyRemote() {
      const { gistId } = storage.readMeta();
      const res = await client.readVault(gistId);
      if (res.content === null) throw new CryptoError('MALFORMED', 'Vault file missing from gist');
      let env;
      try {
        env = JSON.parse(res.content);
      } catch {
        throw new CryptoError('MALFORMED', 'Remote vault is not valid JSON');
      }
      const { meta } = await open(session.getKeys(), assertEnvelope(env));
      return { rev: meta.rev, updatedAt: meta.updatedAt, deviceId: meta.deviceId, fingerprint: await fingerprint(env), bytes: res.content.length };
    },
  };
}
