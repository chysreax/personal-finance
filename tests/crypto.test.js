import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKeys, seal, open, openWithPassphrase, CryptoError, passphraseStrength, isEnvelope } from '../js/core/crypto.js';

const FAST = { iterations: 100_000 };
const meta = { rev: 3, deviceId: 'dev_test1234' };

test('seal → open round-trips and ciphertext hides plaintext', async () => {
  const keys = await deriveKeys('correct horse battery staple', FAST);
  const value = { payee: 'Secret Merchant', amount: 4200 };
  const env = await seal(keys, value, meta);
  assert.ok(isEnvelope(env));
  assert.equal(env.cipher.name, 'AES-256-GCM');
  assert.equal(env.mac.alg, 'HMAC-SHA256');
  assert.ok(!JSON.stringify(env).includes('Secret Merchant'), 'plaintext leaked into envelope');
  const { value: out, meta: m } = await open(keys, env);
  assert.deepEqual(out, value);
  assert.equal(m.rev, 3);
});

test('fresh IV per seal: same plaintext gives different ciphertext', async () => {
  const keys = await deriveKeys('pass phrase one two', FAST);
  const a = await seal(keys, { x: 1 }, meta);
  const b = await seal(keys, { x: 1 }, meta);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.notEqual(a.ct, b.ct);
});

test('wrong passphrase is reported as WRONG_PASSPHRASE, not tampering', async () => {
  const env = await seal(await deriveKeys('right passphrase here', FAST), { ok: true }, meta);
  await assert.rejects(openWithPassphrase('wrong passphrase here', env), (e) => e instanceof CryptoError && e.code === 'WRONG_PASSPHRASE');
});

test('HMAC detects ciphertext tampering', async () => {
  const keys = await deriveKeys('tamper test passphrase', FAST);
  const env = await seal(keys, { balance: 100 }, meta);
  const flipped = env.ct[10] === 'A' ? 'B' : 'A';
  const bad = { ...env, ct: env.ct.slice(0, 10) + flipped + env.ct.slice(11) };
  await assert.rejects(open(keys, bad), (e) => e.code === 'TAMPERED');
});

test('HMAC detects metadata tampering (rev rollback)', async () => {
  const keys = await deriveKeys('tamper test passphrase', FAST);
  const env = await seal(keys, { balance: 100 }, meta);
  await assert.rejects(open(keys, { ...env, meta: { ...env.meta, rev: 1 } }), (e) => e.code === 'TAMPERED');
});

test('malformed envelopes are rejected structurally', async () => {
  const keys = await deriveKeys('structure test pass', FAST);
  for (const bad of [null, 'x', [], { format: 'pfm-vault' }, { format: 'other', v: 1 }]) {
    await assert.rejects(open(keys, bad), (e) => e instanceof CryptoError);
  }
});

test('absurd KDF parameters are refused (DoS guard)', async () => {
  const keys = await deriveKeys('dos guard passphrase', FAST);
  const env = await seal(keys, {}, meta);
  await assert.rejects(openWithPassphrase('dos guard passphrase', { ...env, kdf: { ...env.kdf, iterations: 1e9 } }), (e) => e.code === 'UNSUPPORTED');
});

test('passphrase strength scores', () => {
  assert.ok(passphraseStrength('password').score <= 1);
  assert.ok(passphraseStrength('Tr0ub4dor&3-xyz!').score >= 3);
  assert.ok(passphraseStrength('orbit maple canyon violet ember').score >= 3);
});
