/**
 * Device-local persistence. Only three keys exist:
 *   pfm:meta   — non-sensitive device state (gist id, sync cursors, preferences)
 *   pfm:vault  — the dataset as an encrypted envelope (ciphertext only)
 *   pfm:token  — OPTIONAL encrypted PAT envelope (only if "remember" is on)
 * Nothing financial and no token is ever written in plaintext.
 */
import { uid } from '../core/ids.js';

const K = { meta: 'pfm:meta', vault: 'pfm:vault', token: 'pfm:token' };

export class StorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageError';
  }
}

export const META_DEFAULTS = Object.freeze({
  deviceId: '',
  gistId: null,
  login: null,
  etag: null,
  remoteRev: 0,
  localRev: 0,
  lastSyncAt: 0,
  dirty: false,
  theme: 'system',
  autoLockMinutes: 15,
  rememberToken: false,
  tokenTtlHours: 8,
  failedUnlocks: 0,
  unlockBlockedUntil: 0,
});

/** @param {Storage} [backend] */
export function createLocalStore(backend = globalThis.localStorage) {
  const mem = new Map(); // fallback when storage is unavailable (private mode, blocked)
  const be = backend || {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  };

  function read(key) {
    try {
      const raw = be.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function write(key, value) {
    try {
      be.setItem(key, JSON.stringify(value));
    } catch (err) {
      const quota = err && (err.name === 'QuotaExceededError' || err.code === 22);
      throw new StorageError(quota ? 'Browser storage is full — export a backup and free some space' : 'Browser storage is unavailable');
    }
  }
  function remove(key) {
    try {
      be.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  let metaCache = null;
  function readMeta() {
    if (metaCache) return metaCache;
    const raw = read(K.meta);
    const m = { ...META_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (typeof m.deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(m.deviceId)) m.deviceId = uid('dev_');
    if (m.gistId !== null && !/^[a-f0-9]{5,40}$/i.test(String(m.gistId))) m.gistId = null;
    if (!['system', 'light', 'dark'].includes(m.theme)) m.theme = 'system';
    metaCache = m;
    return m;
  }

  return {
    readMeta,
    writeMeta(patch) {
      metaCache = { ...readMeta(), ...patch };
      write(K.meta, metaCache);
      return metaCache;
    },
    readVault: () => read(K.vault),
    writeVault: (env) => write(K.vault, env),
    hasVault: () => read(K.vault) !== null,
    readToken: () => read(K.token),
    writeToken: (env) => write(K.token, env),
    clearToken: () => remove(K.token),
    wipe() {
      for (const k of Object.values(K)) remove(k);
      metaCache = null;
    },
  };
}
