/**
 * Pre-app screens: create a vault, unlock it, or restore it from GitHub.
 * Nothing decrypted exists in memory until one of these succeeds.
 */
import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { field, passwordInput, select, setFieldError, confirmDialog } from './components.js';
import { renderStrength } from './views/settings.js';
import { CURRENCIES } from '../core/money.js';
import { passphraseStrength, openWithPassphrase, assertEnvelope } from '../core/crypto.js';
import { emptyData, normalizeData } from '../core/schema.js';
import { generateDemoData } from '../core/demo.js';
import { tokenShape } from '../core/redact.js';
import { createGistClient } from '../services/github.js';

function shell(...children) {
  return h(
    'div',
    { class: 'lock-screen' },
    h(
      'div',
      { class: 'lock-card' },
      h('div', { class: 'brand brand-lg' }, h('span', { class: 'brand-mark' }, icon('wallet', 22)), h('span', {}, 'Ledgerly')),
      ...children,
    ),
    h('p', { class: 'lock-foot small' }, icon('shield', 13), ' End-to-end encrypted · AES-256-GCM · HMAC-SHA256 · your keys never leave this device'),
  );
}

function busy(btn, on, label) {
  btn.disabled = on;
  btn.classList.toggle('loading', on);
  if (label) btn.querySelector('.btn-label').textContent = label;
}

function submitButton(label) {
  return h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, h('span', { class: 'btn-label' }, label));
}

/**
 * @param {HTMLElement} root
 * @param {object} app  app context (vault, storage, session, onUnlocked)
 */
export function showLockScreen(root, app, mode = app.storage.hasVault() ? 'unlock' : 'create', notice) {
  const screens = { create: createScreen, unlock: unlockScreen, restore: restoreScreen };
  mount(root, screens[mode](app, (m, n) => showLockScreen(root, app, m, n), notice));
  root.querySelector('input')?.focus();
}

function noticeEl(notice) {
  return notice ? h('p', { class: `callout callout-${notice.tone || 'info'}`, role: 'status' }, icon(notice.tone === 'danger' ? 'alert' : 'info', 16), notice.text) : null;
}

/* ---------- unlock ---------- */

function unlockScreen(app, go, notice) {
  const pw = passwordInput({ autocomplete: 'current-password', placeholder: 'Master passphrase', 'aria-label': 'Master passphrase' });
  const input = pw.querySelector('input');
  const fPw = field('Master passphrase', pw);
  const btn = submitButton('Unlock');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value) return;
        setFieldError(fPw, '');
        busy(btn, true, 'Deriving key…');
        try {
          const { data, warnings } = await app.vault.unlock(input.value);
          input.value = '';
          await app.onUnlocked(data, { warnings });
        } catch (err) {
          busy(btn, false, 'Unlock');
          if (err.code === 'THROTTLED') {
            setFieldError(fPw, `Too many attempts. Try again in ${Math.ceil((err.retryAt - Date.now()) / 1000)}s.`);
          } else if (err.code === 'WRONG_PASSPHRASE') {
            setFieldError(fPw, `Incorrect passphrase${err.attempts >= 3 ? ` (${err.attempts} failed attempts)` : ''}`);
            form.classList.remove('shake');
            void form.offsetWidth;
            form.classList.add('shake');
            input.select();
          } else if (err.code === 'TAMPERED') {
            go('unlock', { tone: 'danger', text: 'Local vault failed its integrity check — it was modified or corrupted. Restore from GitHub or erase this device.' });
          } else {
            setFieldError(fPw, err.message || 'Could not unlock');
          }
        }
      },
    },
    h('h1', { class: 'lock-title' }, 'Welcome back'),
    h('p', { class: 'muted' }, 'Your vault is locked. Enter your passphrase to decrypt it on this device.'),
    noticeEl(notice),
    fPw,
    btn,
  );
  const meta = app.storage.readMeta();
  return shell(
    form,
    h(
      'div',
      { class: 'lock-links' },
      meta.gistId ? h('button', { class: 'link-btn', type: 'button', onclick: () => go('restore') }, icon('cloud', 14), 'Restore from GitHub') : null,
      h('button', {
        class: 'link-btn danger', type: 'button', onclick: async () => {
          const ok = await confirmDialog({ title: 'Forgot your passphrase?', message: 'Your data is end-to-end encrypted, so it cannot be recovered without the passphrase. You can erase this device and start over (your GitHub gist is not touched).', confirmLabel: 'Erase this device', danger: true, requireText: 'ERASE' });
          if (ok) {
            app.storage.wipe();
            go('create');
          }
        },
      }, 'Forgot passphrase?'),
    ),
  );
}

/* ---------- create ---------- */

function createScreen(app, go, notice) {
  const pw = passwordInput({ autocomplete: 'new-password', placeholder: 'At least 10 characters' });
  const pw2 = passwordInput({ autocomplete: 'new-password', placeholder: 'Repeat passphrase' });
  const input = pw.querySelector('input');
  const meter = h('div', { class: 'strength' });
  renderStrength(meter, '');
  input.addEventListener('input', () => renderStrength(meter, input.value));
  const fPw = field('Create a master passphrase', h('div', {}, pw, meter));
  const fPw2 = field('Confirm passphrase', pw2);
  const guess = (Intl.NumberFormat().resolvedOptions().locale || '').toUpperCase();
  const defaultCur = /ID/.test(guess) ? 'IDR' : /GB/.test(guess) ? 'GBP' : /JP/.test(guess) ? 'JPY' : /DE|FR|ES|IT|NL/.test(guess) ? 'EUR' : 'USD';
  const currency = select(CURRENCIES.map((c) => ({ value: c, label: c })), defaultCur);
  const demo = h('input', { type: 'checkbox', checked: true });
  const btn = submitButton('Create encrypted vault');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const p = input.value;
        setFieldError(fPw, '');
        setFieldError(fPw2, '');
        if (p.length < 10 || passphraseStrength(p).score < 2) return setFieldError(fPw, 'Use at least 10 characters with a “Fair” or better rating');
        if (p !== pw2.querySelector('input').value) return setFieldError(fPw2, 'Passphrases do not match');
        busy(btn, true, 'Deriving key…');
        try {
          const data = demo.checked ? generateDemoData(app.today()) : emptyData();
          data.settings = { ...data.settings, currency: currency.value, updatedAt: Date.now() };
          if (demo.checked && currency.value !== 'USD') data.settings.currency = currency.value;
          await app.vault.create(p, data);
          input.value = '';
          await app.onUnlocked(data, { fresh: true });
        } catch (err) {
          busy(btn, false, 'Create encrypted vault');
          setFieldError(fPw, err.message || 'Could not create vault');
        }
      },
    },
    h('h1', { class: 'lock-title' }, 'Your private finance hub'),
    h('p', { class: 'muted' }, 'Everything is encrypted with a passphrase only you know. There is no account and no server — and no way to recover a lost passphrase.'),
    noticeEl(notice),
    fPw,
    fPw2,
    field('Currency', currency),
    h('label', { class: 'check' }, demo, h('span', {}, 'Start with 12 months of demo data (you can erase it later)')),
    btn,
  );
  return shell(form, h('div', { class: 'lock-links' }, h('button', { class: 'link-btn', type: 'button', onclick: () => go('restore') }, icon('cloud', 14), 'I already have a vault on GitHub')));
}

/* ---------- restore from GitHub ---------- */

function restoreScreen(app, go, notice) {
  const meta = app.storage.readMeta();
  const tokenWrap = passwordInput({ autocomplete: 'off', placeholder: 'github_pat_… or ghp_…' });
  const tokenInput = tokenWrap.querySelector('input');
  const pw = passwordInput({ autocomplete: 'current-password', placeholder: 'Vault passphrase' });
  const gist = h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', value: meta.gistId || '', placeholder: 'Optional — found automatically' });
  const remember = h('input', { type: 'checkbox' });
  const fToken = field('GitHub personal access token', tokenWrap, { hint: 'Scope: gist (classic) or Gists read/write (fine-grained).' });
  const fPw = field('Vault passphrase', pw);
  const fGist = field('Vault gist ID', gist);
  const btn = submitButton('Restore vault');
  const form = h(
    'form',
    {
      class: 'stack',
      autocomplete: 'off',
      onsubmit: async (e) => {
        e.preventDefault();
        [fToken, fPw, fGist].forEach((f) => setFieldError(f, ''));
        const token = tokenInput.value.trim();
        if (tokenShape(token) === 'invalid') return setFieldError(fToken, 'That does not look like a GitHub token');
        const passphrase = pw.querySelector('input').value;
        if (!passphrase) return setFieldError(fPw, 'Passphrase required');
        busy(btn, true, 'Connecting…');
        // Throwaway client scoped to this attempt; the token is only promoted to the session on success.
        const client = createGistClient({ getToken: () => token, retries: 2 });
        try {
          const { login } = await client.whoAmI();
          let gistId = gist.value.trim();
          if (!gistId) {
            gistId = (await client.findVault())?.id;
            if (!gistId) throw Object.assign(new Error('No vault gist found on this account'), { field: fGist });
          }
          const res = await client.readVault(gistId);
          if (!res.content) throw Object.assign(new Error('That gist has no vault file'), { field: fGist });
          let env;
          try {
            env = assertEnvelope(JSON.parse(res.content));
          } catch {
            throw Object.assign(new Error('The gist content is not a valid encrypted vault'), { field: fGist });
          }
          busy(btn, true, 'Decrypting…');
          let opened;
          try {
            opened = await openWithPassphrase(passphrase, env);
          } catch (err) {
            throw Object.assign(new Error(err.code === 'TAMPERED' ? 'Vault failed integrity verification — it was modified outside the app' : 'Incorrect passphrase for this vault'), { field: fPw });
          }
          const { data } = normalizeData(opened.value);
          app.storage.writeMeta({ gistId, login, etag: null, remoteRev: opened.meta.rev, dirty: false, rememberToken: remember.checked, failedUnlocks: 0, unlockBlockedUntil: 0 });
          await app.vault.adopt(opened.keys, data);
          const ttl = app.storage.readMeta().tokenTtlHours;
          app.session.setToken(token, ttl * 3_600_000);
          if (remember.checked) await app.vault.rememberToken(token, ttl);
          else app.storage.clearToken();
          tokenInput.value = '';
          await app.onUnlocked(data, { restored: true });
        } catch (err) {
          busy(btn, false, 'Restore vault');
          setFieldError(err.field || fToken, err.message || 'Restore failed');
        }
      },
    },
    h('h1', { class: 'lock-title' }, 'Restore from GitHub'),
    h('p', { class: 'muted' }, 'Download your encrypted vault from a secret gist and decrypt it here. This replaces any vault on this device.'),
    noticeEl(notice),
    fToken,
    fPw,
    fGist,
    h('label', { class: 'check' }, remember, h('span', {}, 'Remember token on this device (encrypted)')),
    btn,
  );
  return shell(form, h('div', { class: 'lock-links' }, h('button', { class: 'link-btn', type: 'button', onclick: () => go(app.storage.hasVault() ? 'unlock' : 'create') }, icon('chevronLeft', 14), 'Back')));
}
