/**
 * Token hygiene: anything that could end up in a message, toast or error is
 * passed through `redact` so a PAT can never be echoed back to the screen.
 */
const PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,255}/g,
  /github_pat_[A-Za-z0-9_]{20,255}/g,
  /(bearer|token)\s+[A-Za-z0-9_.-]{12,}/gi,
];

export function redact(value) {
  let s = typeof value === 'string' ? value : String(value ?? '');
  for (const re of PATTERNS) s = s.replace(re, '[redacted]');
  return s.slice(0, 500);
}

/** Shape check for a GitHub PAT (classic `ghp_` or fine-grained `github_pat_`). */
export function tokenShape(token) {
  if (typeof token !== 'string') return 'invalid';
  const t = token.trim();
  if (/^ghp_[A-Za-z0-9]{36,255}$/.test(t)) return 'classic';
  if (/^github_pat_[A-Za-z0-9_]{22,255}$/.test(t)) return 'fine-grained';
  if (/^gh[ousr]_[A-Za-z0-9]{36,255}$/.test(t)) return 'other';
  return 'invalid';
}
