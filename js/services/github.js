/**
 * Minimal GitHub Gists REST client used as a serverless document store.
 *
 * Resilience: per-request timeout, exponential backoff with jitter for
 * network/5xx/secondary-rate-limit failures, primary rate-limit awareness
 * (x-ratelimit-*), conditional GETs with ETags (304s are free), and typed
 * errors so the sync engine can react precisely.
 *
 * Token hygiene: the PAT is read through a getter at request time, sent only
 * in the Authorization header to api.github.com, never placed in a URL, never
 * included in an error message.
 */
import { redact } from '../core/redact.js';

export const API = 'https://api.github.com';
export const VAULT_FILE = 'pfm-vault.json';
export const VAULT_DESCRIPTION = 'Personal Finance Manager — encrypted vault (AES-256-GCM). Do not edit by hand.';
const RAW_HOST = 'gist.githubusercontent.com';

export class GitHubError extends Error {
  /**
   * @param {'NETWORK'|'TIMEOUT'|'UNAUTHORIZED'|'FORBIDDEN'|'RATE_LIMITED'|'NOT_FOUND'|'INVALID_RESPONSE'|'SERVER'|'TOO_LARGE'|'NO_TOKEN'} code
   */
  constructor(code, message, extra = {}) {
    super(redact(message));
    this.name = 'GitHubError';
    this.code = code;
    this.status = extra.status ?? 0;
    this.resetAt = extra.resetAt ?? null;
  }
  get retryable() {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT' || this.code === 'SERVER';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{getToken: () => string|null, fetchImpl?: typeof fetch, timeoutMs?: number, retries?: number,
 *          onRateLimit?: (info: {remaining: number, limit: number, resetAt: number}) => void, baseDelayMs?: number}} o
 */
export function createGistClient(o) {
  const doFetch = o.fetchImpl || ((...a) => globalThis.fetch(...a));
  const timeoutMs = o.timeoutMs ?? 15_000;
  const maxRetries = o.retries ?? 3;
  const baseDelay = o.baseDelayMs ?? 700;
  let rate = { remaining: null, limit: null, resetAt: null };

  function readRate(res) {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining) && res.headers.get('x-ratelimit-remaining') !== null) {
      rate = { remaining, limit, resetAt: Number.isFinite(reset) ? reset * 1000 : null };
      o.onRateLimit?.(rate);
    }
  }

  async function once(method, url, { body, etag, auth = true } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (auth) {
      const token = o.getToken();
      if (!token) throw new GitHubError('NO_TOKEN', 'Not connected to GitHub');
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-None-Match'] = etag;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new GitHubError('TIMEOUT', 'GitHub did not respond in time');
      throw new GitHubError('NETWORK', 'Network error — you may be offline');
    } finally {
      clearTimeout(timer);
    }
    if (auth) readRate(res);
    if (res.status === 304) return { status: 304, etag, body: null };
    if (res.ok) {
      let json = null;
      if (res.status !== 204) {
        try {
          json = await res.json();
        } catch {
          throw new GitHubError('INVALID_RESPONSE', 'GitHub returned an unreadable response', { status: res.status });
        }
      }
      return { status: res.status, etag: res.headers.get('etag'), body: json };
    }
    let msg = '';
    try {
      msg = (await res.json())?.message || '';
    } catch {
      /* body is optional */
    }
    const status = res.status;
    if (status === 401) throw new GitHubError('UNAUTHORIZED', 'GitHub rejected the token (expired or revoked)', { status });
    if (status === 403 || status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (rate.remaining === 0 || status === 429 || /rate limit/i.test(msg)) {
        const resetAt = Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter * 1000 : rate.resetAt || Date.now() + 60_000;
        throw new GitHubError('RATE_LIMITED', 'GitHub API rate limit reached', { status, resetAt });
      }
      throw new GitHubError('FORBIDDEN', 'Token lacks the "gist" permission', { status });
    }
    if (status === 404) throw new GitHubError('NOT_FOUND', 'Vault gist not found (deleted, or token cannot see it)', { status });
    if (status === 422 && /too large|exceed/i.test(msg)) throw new GitHubError('TOO_LARGE', 'Vault exceeds GitHub gist size limits', { status });
    if (status >= 500) throw new GitHubError('SERVER', `GitHub is having trouble (HTTP ${status})`, { status });
    throw new GitHubError('INVALID_RESPONSE', `Unexpected GitHub response (HTTP ${status})`, { status });
  }

  async function request(method, path, opts = {}) {
    const url = path.startsWith('https://') ? path : API + path;
    let attempt = 0;
    for (;;) {
      try {
        return await once(method, url, opts);
      } catch (err) {
        const secondary = err.code === 'RATE_LIMITED' && err.resetAt && err.resetAt - Date.now() < 10_000;
        if ((!err.retryable && !secondary) || attempt >= maxRetries) throw err;
        const delay = secondary ? err.resetAt - Date.now() + 250 : baseDelay * 2 ** attempt + Math.random() * baseDelay;
        attempt++;
        await sleep(Math.max(0, delay));
      }
    }
  }

  function vaultFileOf(gist) {
    if (!gist || typeof gist !== 'object' || !gist.files || typeof gist.files !== 'object') {
      throw new GitHubError('INVALID_RESPONSE', 'Gist response is missing its files');
    }
    return gist.files[VAULT_FILE] || null;
  }

  async function fileContent(file) {
    if (!file) return null;
    if (!file.truncated && typeof file.content === 'string') return file.content;
    // Large files are truncated in the API response; fetch the raw blob (no auth header — the raw host never sees the token).
    let url;
    try {
      url = new URL(file.raw_url);
    } catch {
      throw new GitHubError('INVALID_RESPONSE', 'Gist raw URL is invalid');
    }
    if (url.protocol !== 'https:' || url.hostname !== RAW_HOST) throw new GitHubError('INVALID_RESPONSE', 'Unexpected raw URL host');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs * 2);
    try {
      const res = await doFetch(url.href, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal });
      if (!res.ok) throw new GitHubError('SERVER', `Could not download vault (HTTP ${res.status})`, { status: res.status });
      return await res.text();
    } catch (err) {
      if (err instanceof GitHubError) throw err;
      throw new GitHubError('NETWORK', 'Network error while downloading vault');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get rate() {
      return { ...rate };
    },

    /** Validate the token and report its identity + scopes. */
    async whoAmI() {
      const token = o.getToken();
      if (!token) throw new GitHubError('NO_TOKEN', 'Not connected to GitHub');
      const res = await request('GET', '/user');
      const login = typeof res.body?.login === 'string' ? res.body.login.slice(0, 64) : 'unknown';
      return { login };
    },

    /** Scan the user's gists for an existing vault file (first 300 gists). */
    async findVault() {
      for (let page = 1; page <= 3; page++) {
        const res = await request('GET', `/gists?per_page=100&page=${page}`);
        if (!Array.isArray(res.body)) throw new GitHubError('INVALID_RESPONSE', 'Unexpected gist list');
        const hit = res.body.find((g) => g && g.files && g.files[VAULT_FILE]);
        if (hit) return { id: String(hit.id), updatedAt: hit.updated_at };
        if (res.body.length < 100) break;
      }
      return null;
    },

    /** Read the vault. Returns {notModified:true} on 304, or {content: string|null, etag}. */
    async readVault(gistId, etag) {
      assertGistId(gistId);
      const res = await request('GET', `/gists/${gistId}`, { etag });
      if (res.status === 304) return { notModified: true, etag };
      const content = await fileContent(vaultFileOf(res.body));
      return { notModified: false, content, etag: res.etag, updatedAt: res.body.updated_at };
    },

    async createVault(content) {
      const res = await request('POST', '/gists', {
        body: { description: VAULT_DESCRIPTION, public: false, files: { [VAULT_FILE]: { content } } },
      });
      if (!res.body?.id) throw new GitHubError('INVALID_RESPONSE', 'Gist was not created');
      return { id: String(res.body.id), etag: res.etag };
    },

    async writeVault(gistId, content) {
      assertGistId(gistId);
      const res = await request('PATCH', `/gists/${gistId}`, { body: { files: { [VAULT_FILE]: { content } } } });
      return { etag: res.etag };
    },

    async deleteVault(gistId) {
      assertGistId(gistId);
      await request('DELETE', `/gists/${gistId}`);
    },
  };
}

export function assertGistId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{5,40}$/i.test(id)) throw new GitHubError('INVALID_RESPONSE', 'Invalid gist id');
}
