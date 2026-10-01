/**
 * Zero-knowledge vault envelope.
 *
 *   passphrase ──PBKDF2-SHA256 (600k, 16-byte salt)──► 512 bits
 *                                  ├─ bits[0..32)  → AES-256-GCM key  (confidentiality)
 *                                  └─ bits[32..64) → HMAC-SHA256 key  (integrity / tamper evidence)
 *
 * The envelope is encrypt-then-MAC: AES-GCM authenticates the ciphertext and
 * header (as AAD); an independent HMAC-SHA256 over a canonical serialisation of
 * every envelope field lets the app tell "wrong passphrase" (key-check fails)
 * apart from "data was modified outside the app" (key-check ok, MAC fails).
 * Keys are non-extractable CryptoKeys — the raw bits are wiped after import.
 */

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const FORMAT = 'pfm-vault';
export const VERSION = 1;
export const KDF_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;
const KEY_CHECK_LABEL = 'pfm:key-check:v1';
const MAX_CIPHERTEXT_CHARS = 40 * 1024 * 1024;

export class CryptoError extends Error {
  /** @param {'MALFORMED'|'UNSUPPORTED'|'WRONG_PASSPHRASE'|'TAMPERED'|'KEY_MISMATCH'} code */
  constructor(code, message) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

/* ---------- encoding ---------- */

export function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64ToBytes(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new CryptoError('MALFORMED', 'Invalid base64 field in vault');
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export async function sha256Hex(text) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', te.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- keys ---------- */

/**
 * @typedef {{encKey: CryptoKey, macKey: CryptoKey, salt: string, iterations: number, keyCheck: string}} VaultKeys
 */

/**
 * Derive the encryption + MAC key pair from a passphrase.
 * @param {string} passphrase
 * @param {{salt?: string, iterations?: number}} [o]
 * @returns {Promise<VaultKeys>}
 */
export async function deriveKeys(passphrase, o = {}) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new CryptoError('WRONG_PASSPHRASE', 'Passphrase required');
  }
  const iterations = o.iterations ?? KDF_ITERATIONS;
  assertIterations(iterations);
  const saltBytes = o.salt ? b64ToBytes(o.salt) : randomBytes(16);
  const base = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, base, 512),
  );
  try {
    const encKey = await subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const macKey = await subtle.importKey('raw', bits.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    const keyCheck = bytesToB64(new Uint8Array(await subtle.sign('HMAC', macKey, te.encode(KEY_CHECK_LABEL))));
    return { encKey, macKey, salt: bytesToB64(saltBytes), iterations, keyCheck };
  } finally {
    bits.fill(0);
  }
}

function assertIterations(n) {
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) {
    throw new CryptoError('UNSUPPORTED', 'Vault uses unsupported key-derivation parameters');
  }
}

/** True when `keys` were derived with the salt/params of `env`. */
export const keysMatch = (keys, env) =>
  !!keys && !!env && keys.salt === env.kdf.salt && keys.iterations === env.kdf.iterations;

/* ---------- envelope ---------- */

/**
 * Structural validation of an untrusted envelope. Throws CryptoError('MALFORMED').
 * @returns {object} the envelope (narrowed)
 */
export function assertEnvelope(env) {
  const bad = (why) => {
    throw new CryptoError('MALFORMED', `Vault payload is malformed (${why})`);
  };
  if (!env || typeof env !== 'object' || Array.isArray(env)) bad('not an object');
  if (env.format !== FORMAT) bad('unknown format');
  if (env.v !== VERSION) throw new CryptoError('UNSUPPORTED', `Unsupported vault version ${String(env.v).slice(0, 8)}`);
  const k = env.kdf;
  if (!k || k.name !== 'PBKDF2-SHA256' || typeof k.salt !== 'string' || k.salt.length > 64) bad('kdf');
  assertIterations(k.iterations);
  if (typeof env.keyCheck !== 'string' || env.keyCheck.length > 128) bad('key check');
  if (!env.cipher || env.cipher.name !== 'AES-256-GCM' || typeof env.cipher.iv !== 'string') bad('cipher');
  if (typeof env.ct !== 'string' || env.ct.length === 0 || env.ct.length > MAX_CIPHERTEXT_CHARS) bad('ciphertext');
  const m = env.meta;
  if (!m || !Number.isSafeInteger(m.rev) || m.rev < 0 || !Number.isFinite(m.updatedAt) || typeof m.deviceId !== 'string')
    bad('meta');
  if (m.deviceId.length > 64) bad('device id');
  if (!env.mac || env.mac.alg !== 'HMAC-SHA256' || typeof env.mac.value !== 'string') bad('mac');
  return env;
}

export function isEnvelope(x) {
  try {
    assertEnvelope(x);
    return true;
  } catch {
    return false;
  }
}

const header = (env) =>
  [FORMAT, `v${env.v}`, env.kdf.name, env.kdf.iterations, env.kdf.salt, env.keyCheck, env.cipher.name, env.cipher.iv,
    env.meta.rev, env.meta.updatedAt, env.meta.deviceId].join('|');

const macInput = (env) => te.encode(`${header(env)}|${env.ct}`);

/**
 * Encrypt + MAC a JSON-serialisable value.
 * @param {VaultKeys} keys
 * @param {unknown} value
 * @param {{rev: number, deviceId: string, updatedAt?: number}} meta
 */
export async function seal(keys, value, meta) {
  const iv = randomBytes(12);
  const env = {
    format: FORMAT,
    v: VERSION,
    kdf: { name: 'PBKDF2-SHA256', iterations: keys.iterations, salt: keys.salt },
    keyCheck: keys.keyCheck,
    cipher: { name: 'AES-256-GCM', iv: bytesToB64(iv) },
    meta: { rev: meta.rev, updatedAt: meta.updatedAt ?? Date.now(), deviceId: meta.deviceId },
    ct: '',
    mac: { alg: 'HMAC-SHA256', value: '' },
  };
  const plaintext = te.encode(JSON.stringify(value));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(header(env)) }, keys.encKey, plaintext);
  env.ct = bytesToB64(new Uint8Array(ct));
  env.mac.value = bytesToB64(new Uint8Array(await subtle.sign('HMAC', keys.macKey, macInput(env))));
  return env;
}

/**
 * Verify integrity and decrypt. Order matters:
 *   1. structure  → MALFORMED
 *   2. key check  → WRONG_PASSPHRASE / KEY_MISMATCH
 *   3. HMAC       → TAMPERED
 *   4. AES-GCM    → TAMPERED (auth tag)
 * @param {VaultKeys} keys
 * @param {unknown} rawEnv
 * @returns {Promise<{value: unknown, meta: {rev:number, updatedAt:number, deviceId:string}}>}
 */
export async function open(keys, rawEnv) {
  const env = assertEnvelope(rawEnv);
  if (!keysMatch(keys, env)) {
    throw new CryptoError('KEY_MISMATCH', 'Vault was encrypted with a different passphrase or salt');
  }
  const checkOk = await subtle.verify('HMAC', keys.macKey, b64ToBytes(env.keyCheck), te.encode(KEY_CHECK_LABEL));
  if (!checkOk) throw new CryptoError('WRONG_PASSPHRASE', 'Incorrect passphrase');

  const macOk = await subtle.verify('HMAC', keys.macKey, b64ToBytes(env.mac.value), macInput(env));
  if (!macOk) {
    throw new CryptoError('TAMPERED', 'Integrity check failed: the vault was modified outside this app');
  }
  let plain;
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(env.cipher.iv), additionalData: te.encode(header(env)) },
      keys.encKey,
      b64ToBytes(env.ct),
    );
  } catch {
    throw new CryptoError('TAMPERED', 'Decryption failed: ciphertext authentication tag mismatch');
  }
  let value;
  try {
    value = JSON.parse(td.decode(plain));
  } catch {
    throw new CryptoError('MALFORMED', 'Decrypted payload is not valid JSON');
  }
  return { value, meta: { ...env.meta } };
}

/** Derive keys for an envelope's own salt, then open it. */
export async function openWithPassphrase(passphrase, rawEnv) {
  const env = assertEnvelope(rawEnv);
  const keys = await deriveKeys(passphrase, { salt: env.kdf.salt, iterations: env.kdf.iterations });
  const result = await open(keys, env);
  return { ...result, keys };
}

/** Short, human-comparable fingerprint of an envelope's ciphertext. */
export async function fingerprint(env) {
  const hex = await sha256Hex(env.ct + env.mac.value);
  return hex.slice(0, 16).match(/.{4}/g).join('·');
}

/* ---------- passphrase strength ---------- */

/**
 * Rough entropy estimate → 0..4 score. Not zxcvbn, but penalises the common
 * failure modes (short, single character class, repeats, sequences).
 */
export function passphraseStrength(p) {
  if (!p) return { score: 0, label: 'Empty', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 33;
  const unique = new Set(p).size;
  let bits = Math.log2(Math.max(pool, 2)) * p.length * Math.min(1, unique / Math.max(4, p.length * 0.6));
  if (/(.)\1{2,}/.test(p)) bits *= 0.8;
  if (/(0123|1234|2345|abcd|qwer|asdf|password|letmein)/i.test(p)) bits *= 0.6;
  const words = p.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3);
  if (words.length >= 4) bits = Math.max(bits, words.length * 11);
  const score = bits < 35 ? 0 : bits < 50 ? 1 : bits < 65 ? 2 : bits < 85 ? 3 : 4;
  return { score, bits: Math.round(bits), label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'][score] };
}
