/**
 * Session secrets + the encrypted local vault.
 *
 * The session is the ONLY place decrypted secrets live: the non-extractable
 * CryptoKeys and the GitHub token. They sit in this module's closure (never on
 * window, never in the DOM, never logged) and `lock()` drops every reference.
 * The passphrase itself is never retained — only keys derived from it.
 */
import { deriveKeys, open, seal, CryptoError, assertEnvelope } from '../core/crypto.js';
import { normalizeData } from '../core/schema.js';

export function createSession() {
  let keys = null;
  let token = null;
  let tokenExpiresAt = 0;
  const listeners = new Set();
  const emit = (e) => listeners.forEach((fn) => fn(e));

  return {
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get unlocked() {
      return keys !== null;
    },
    getKeys: () => keys,
    setKeys(k) {
      keys = k;
    },
    /** Token getter enforces the session TTL on every read. */
    getToken() {
      if (token && Date.now() >= tokenExpiresAt) {
        token = null;
        tokenExpiresAt = 0;
        emit({ type: 'token-expired' });
      }
      return token;
    },
    get tokenExpiresAt() {
      return token ? tokenExpiresAt : 0;
    },
    setToken(t, ttlMs) {
      token = t;
      tokenExpiresAt = Date.now() + ttlMs;
    },
    clearToken() {
      token = null;
      tokenExpiresAt = 0;
    },
    lock(reason = 'manual') {
      keys = null;
      token = null;
      tokenExpiresAt = 0;
      emit({ type: 'locked', reason });
    },
  };
}

const MAX_TTL_MS = 30 * 86_400_000;

/**
 * @param {{storage: ReturnType<import('./storage.js').createLocalStore>, session: ReturnType<typeof createSession>}} deps
 */
export function createVault({ storage, session }) {
  const deviceId = () => storage.readMeta().deviceId;

  async function persist(data) {
    const keys = session.getKeys();
    if (!keys) throw new CryptoError('WRONG_PASSPHRASE', 'Vault is locked');
    const rev = storage.readMeta().localRev + 1;
    const env = await seal(keys, data, { rev, deviceId: deviceId() });
    storage.writeVault(env);
    storage.writeMeta({ localRev: rev });
    return env;
  }

  return {
    persist,

    /** Brand-new vault on this device. */
    async create(passphrase, data) {
      const keys = await deriveKeys(passphrase);
      session.setKeys(keys);
      storage.writeMeta({ localRev: 0, remoteRev: 0, etag: null, dirty: true, failedUnlocks: 0, unlockBlockedUntil: 0 });
      await persist(data);
    },

    /** Adopt keys + data that were just decrypted elsewhere (restore from GitHub). */
    async adopt(keys, data) {
      session.setKeys(keys);
      await persist(data);
    },

    /**
     * Unlock the local vault. Throws CryptoError:
     * WRONG_PASSPHRASE | TAMPERED | MALFORMED, plus 'THROTTLED' (via .code) after repeated failures.
     */
    async unlock(passphrase) {
      const meta = storage.readMeta();
      if (meta.unlockBlockedUntil > Date.now()) {
        const err = new CryptoError('WRONG_PASSPHRASE', 'Too many attempts');
        err.code = 'THROTTLED';
        err.retryAt = meta.unlockBlockedUntil;
        throw err;
      }
      const env = assertEnvelope(storage.readVault());
      try {
        const keys = await deriveKeys(passphrase, { salt: env.kdf.salt, iterations: env.kdf.iterations });
        const { value } = await open(keys, env);
        const { data, warnings } = normalizeData(value);
        storage.writeMeta({ failedUnlocks: 0, unlockBlockedUntil: 0 });
        session.setKeys(keys);
        return { data, warnings };
      } catch (err) {
        if (err.code === 'WRONG_PASSPHRASE') {
          const failed = meta.failedUnlocks + 1;
          // Progressive delay after 5 failures: 2s, 4s, 8s … capped at 5 minutes.
          const wait = failed >= 5 ? Math.min(300_000, 1000 * 2 ** (failed - 4)) : 0;
          storage.writeMeta({ failedUnlocks: failed, unlockBlockedUntil: wait ? Date.now() + wait : 0 });
          err.attempts = failed;
        }
        throw err;
      }
    },

    /** Encrypt the dataset for the remote store (same keys, explicit rev). */
    sealForRemote(data, rev) {
      const keys = session.getKeys();
      if (!keys) throw new CryptoError('WRONG_PASSPHRASE', 'Vault is locked');
      return seal(keys, data, { rev, deviceId: deviceId() });
    },

    /** Re-encrypt everything under a new passphrase (new salt). */
    async rekey(newPassphrase, data) {
      const token = session.getToken();
      const keys = await deriveKeys(newPassphrase);
      session.setKeys(keys);
      await persist(data);
      if (token && storage.readMeta().rememberToken) await this.rememberToken(token, storage.readMeta().tokenTtlHours);
      storage.writeMeta({ dirty: true });
    },

    /** Persist the PAT encrypted with the vault key (never plaintext). */
    async rememberToken(token, ttlHours) {
      const keys = session.getKeys();
      if (!keys) return;
      const expiresAt = Date.now() + Math.min(ttlHours * 3_600_000, MAX_TTL_MS);
      storage.writeToken(await seal(keys, { token, expiresAt }, { rev: 0, deviceId: deviceId() }));
    },

    /** Load a remembered PAT into memory; drops it if expired or unreadable. */
    async restoreToken() {
      const env = storage.readToken();
      if (!env) return false;
      try {
        const { value } = await open(session.getKeys(), env);
        if (!value || typeof value.token !== 'string' || !(value.expiresAt > Date.now())) throw new Error('expired');
        session.setToken(value.token, value.expiresAt - Date.now());
        return true;
      } catch {
        storage.clearToken();
        return false;
      }
    },

    forgetToken() {
      session.clearToken();
      storage.clearToken();
    },
  };
}
