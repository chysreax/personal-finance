/** Collision-resistant ids (122 bits of randomness), safe for the schema's id pattern. */
export function uid(prefix = '') {
  const raw = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replace(/-/g, '')
    : [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return prefix + raw.slice(0, 24);
}

/** Monotonic per-device clock so two edits in the same millisecond still order. */
let last = 0;
export function stamp(now = Date.now()) {
  last = Math.max(now, last + 1);
  return last;
}
