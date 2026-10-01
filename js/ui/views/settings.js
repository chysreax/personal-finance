import { h, mount, downloadText, readFileText } from '../dom.js';
import { icon } from '../icons.js';
import { card, field, select, segmented, passwordInput, toast, confirmDialog, passphraseDialog, openModal, badge, categoryDot, setFieldError } from '../components.js';
import { pageHeader, button } from './shared.js';
import { relativeTime } from '../../core/dates.js';
import { CURRENCIES } from '../../core/money.js';
import { makeExport, normalizeData } from '../../core/schema.js';
import { isEnvelope, openWithPassphrase, passphraseStrength, deriveKeys } from '../../core/crypto.js';
import { liveCategories, live, categoryOf } from '../../core/finance.js';
import { tokenShape } from '../../core/redact.js';

export const title = 'Settings';

export const SYNC_LABEL = {
  disconnected: ['Local only', 'neutral', 'cloudOff'],
  idle: ['Ready', 'neutral', 'cloud'],
  syncing: ['Syncing…', 'info', 'refresh'],
  pending: ['Changes pending', 'info', 'clock'],
  synced: ['Synced', 'success', 'cloudCheck'],
  offline: ['Offline', 'warning', 'cloudOff'],
  'rate-limited': ['Rate limited', 'warning', 'clock'],
  auth: ['Reconnect needed', 'warning', 'key'],
  tampered: ['Integrity alert', 'danger', 'shield'],
  malformed: ['Remote unreadable', 'danger', 'alert'],
  missing: ['Remote missing', 'danger', 'alert'],
  rekeyed: ['Passphrase needed', 'warning', 'lock'],
  error: ['Sync error', 'danger', 'alert'],
};

const TTL_OPTIONS = [
  { value: '1', label: '1 hour' },
  { value: '8', label: '8 hours' },
  { value: '24', label: '24 hours' },
  { value: '168', label: '7 days' },
  { value: '720', label: '30 days' },
];

export function render(app) {
  return h(
    'div',
    { class: 'view settings' },
    pageHeader('Settings', 'Sync, security, preferences and your data.'),
    syncSection(app),
    h('div', { class: 'grid grid-2' }, securitySection(app), prefsSection(app)),
    dataSection(app),
    h('div', { class: 'grid grid-2' }, categoriesSection(app), rulesSection(app)),
    aboutSection(app),
  );
}

/* ---------- cloud sync ---------- */

function syncSection(app) {
  const st = app.sync.state;
  const meta = app.storage.readMeta();
  const [label, tone, ic] = SYNC_LABEL[st.status] || SYNC_LABEL.error;
  const connected = !!meta.gistId && !!app.session.getToken();

  const statusRow = h(
    'div',
    { class: 'sync-status' },
    badge(label, tone, ic),
    st.lastSyncAt ? h('span', { class: 'small muted' }, `Last sync ${relativeTime(st.lastSyncAt)}`) : null,
    st.message ? h('p', { class: `sync-msg ${tone === 'danger' ? 'neg' : ''}` }, st.message) : null,
  );

  const resolution = resolutionBlock(app, st.status);

  let body;
  if (connected) {
    const expires = app.session.tokenExpiresAt;
    body = h(
      'div',
      { class: 'stack' },
      h(
        'dl',
        { class: 'kv' },
        h('div', {}, h('dt', {}, 'GitHub account'), h('dd', {}, `@${meta.login || 'unknown'}`)),
        h('div', {}, h('dt', {}, 'Vault gist'), h('dd', {}, h('a', { href: `https://gist.github.com/${meta.gistId}`, target: '_blank', rel: 'noopener noreferrer' }, `${meta.gistId.slice(0, 10)}…`, icon('arrowRight', 12)))),
        h('div', {}, h('dt', {}, 'Revision'), h('dd', { class: 'num' }, `#${st.remoteRev || meta.remoteRev}`)),
        h('div', {}, h('dt', {}, 'Ciphertext fingerprint'), h('dd', { class: 'mono' }, st.fingerprint || '—')),
        h('div', {}, h('dt', {}, 'Token'), h('dd', {}, `${meta.rememberToken ? 'Encrypted on this device' : 'Memory only'} · expires ${expires ? new Date(expires).toLocaleString() : '—'}`)),
        st.rateRemaining !== null && h('div', {}, h('dt', {}, 'API quota left'), h('dd', { class: 'num' }, String(st.rateRemaining))),
      ),
      h(
        'div',
        { class: 'row wrap gap-sm' },
        button('Sync now', { icon: 'refresh', variant: 'primary', onClick: () => app.sync.syncNow().then(() => toastSync(app)) }),
        button('Verify integrity', { icon: 'shield', variant: 'secondary', onClick: () => verify(app) }),
        button('Disconnect', { icon: 'logout', variant: 'ghost', onClick: () => { app.sync.disconnect(); toast('Token removed from this device'); app.rerender(); } }),
        button('Delete remote vault', { icon: 'trash', variant: 'ghost', cls: 'btn-danger-text', onClick: () => destroy(app) }),
      ),
    );
  } else {
    body = connectForm(app, meta);
  }

  return card(
    'Cloud sync · GitHub Gist',
    { subtitle: 'Your data is encrypted on this device before upload. GitHub only ever stores ciphertext.', cls: 'sync-card' },
    statusRow,
    resolution,
    body,
  );
}

function toastSync(app) {
  const s = app.sync.state.status;
  if (s === 'synced') toast('Everything is in sync', { tone: 'success' });
  else toast(app.sync.state.message || SYNC_LABEL[s]?.[0] || 'Sync finished', { tone: SYNC_LABEL[s]?.[1] === 'danger' ? 'danger' : 'warning' });
}

function connectForm(app, meta) {
  const tokenWrap = passwordInput({ placeholder: 'github_pat_… or ghp_…', autocomplete: 'off', name: 'pfm-token', 'aria-describedby': 'token-help' });
  const tokenInput = tokenWrap.querySelector('input');
  const gist = h('input', { class: 'input', type: 'text', placeholder: 'Leave blank to find or create automatically', value: meta.gistId || '', autocomplete: 'off', spellcheck: 'false' });
  const remember = h('input', { type: 'checkbox', checked: meta.rememberToken });
  const ttl = select(TTL_OPTIONS, String(meta.tokenTtlHours), { class: 'input' });
  const fToken = field('Personal access token', tokenWrap, {
    hint: h('span', { id: 'token-help' }, 'Needs only the ', h('strong', {}, 'gist'), ' scope (classic) or ', h('strong', {}, 'Gists: read & write'), ' (fine-grained). ', h('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=Personal%20Finance%20Manager', target: '_blank', rel: 'noopener noreferrer' }, 'Create a token ↗')),
  });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('cloud', 16), 'Connect & sync');
  const form = h(
    'form',
    {
      class: 'form-grid',
      autocomplete: 'off',
      onsubmit: async (e) => {
        e.preventDefault();
        const token = tokenInput.value.trim();
        setFieldError(fToken, '');
        if (tokenShape(token) === 'invalid') {
          setFieldError(fToken, 'That does not look like a GitHub token (ghp_… or github_pat_…)');
          return;
        }
        btn.disabled = true;
        btn.classList.add('loading');
        try {
          const res = await app.sync.connect({ token, gistId: gist.value.trim(), remember: remember.checked, ttlHours: Number(ttl.value) });
          tokenInput.value = '';
          toast(res.created ? `Created encrypted vault gist for @${res.login}` : `Connected to @${res.login}`, { tone: 'success' });
          app.rerender();
        } catch (err) {
          setFieldError(fToken, err.message || 'Could not connect');
        } finally {
          btn.disabled = false;
          btn.classList.remove('loading');
        }
      },
    },
    h('div', { class: 'span-2' }, fToken),
    field('Vault gist ID (optional)', gist, { hint: 'Use the same gist on every device to share data.' }),
    field('Token lifetime', ttl, { hint: 'Purged from memory after this time even if you stay active.' }),
    h('label', { class: 'check span-2' }, remember, h('span', {}, 'Remember on this device — stored encrypted with your vault key, never in plaintext')),
    h('div', { class: 'span-2 row end' }, btn),
  );
  return form;
}

function resolutionBlock(app, status) {
  const wrap = (...kids) => h('div', { class: 'resolution' }, ...kids);
  if (status === 'tampered' || status === 'malformed') {
    return wrap(
      h('p', { class: 'small' }, 'Your local data is unaffected. If you did not change the gist yourself, someone or something else did — consider rotating your token.'),
      h(
        'div',
        { class: 'row wrap gap-sm' },
        button('Retry verification', { icon: 'refresh', variant: 'secondary', onClick: () => app.sync.resolve('retry') }),
        button("Restore remote from this device", {
          icon: 'upload', variant: 'danger', onClick: async () => {
            const ok = await confirmDialog({ title: 'Overwrite remote vault?', message: 'The remote copy will be replaced with this device’s verified data, re-encrypted with a fresh IV and HMAC.', confirmLabel: 'Overwrite remote', danger: true });
            if (ok) await app.sync.resolve('overwrite-remote');
          },
        }),
      ),
    );
  }
  if (status === 'missing') {
    return wrap(h('div', { class: 'row wrap gap-sm' }, button('Recreate vault gist', { icon: 'cloud', variant: 'primary', onClick: () => app.sync.resolve('recreate').then(() => toast('New vault gist created', { tone: 'success' })).catch((e) => toast(e.message, { tone: 'danger' })) }), button('Unlink', { variant: 'ghost', onClick: () => app.sync.disconnect({ unlink: true }) })));
  }
  if (status === 'rekeyed') {
    return wrap(button('Enter remote passphrase', { icon: 'key', variant: 'primary', onClick: () => app.promptRemotePassphrase() }));
  }
  return null;
}

async function verify(app) {
  try {
    const r = await app.sync.verifyRemote();
    openModal({
      title: 'Integrity verified',
      size: 'sm',
      body: h(
        'div',
        { class: 'stack' },
        h('p', { class: 'callout callout-success' }, icon('shield', 16), 'HMAC-SHA256 signature valid and AES-GCM authentication tag verified.'),
        h('dl', { class: 'kv' },
          h('div', {}, h('dt', {}, 'Revision'), h('dd', {}, `#${r.rev}`)),
          h('div', {}, h('dt', {}, 'Written'), h('dd', {}, new Date(r.updatedAt).toLocaleString())),
          h('div', {}, h('dt', {}, 'By device'), h('dd', { class: 'mono' }, r.deviceId.slice(0, 16))),
          h('div', {}, h('dt', {}, 'Fingerprint'), h('dd', { class: 'mono' }, r.fingerprint)),
          h('div', {}, h('dt', {}, 'Size'), h('dd', {}, `${(r.bytes / 1024).toFixed(1)} KB ciphertext`)),
        ),
      ),
    });
  } catch (err) {
    toast(err.code === 'TAMPERED' ? 'Integrity check FAILED — remote data was modified outside the app' : err.message, { tone: 'danger', timeout: 8000 });
  }
}

async function destroy(app) {
  const ok = await confirmDialog({
    title: 'Delete the remote vault?',
    message: 'This deletes the gist from GitHub. Data on this device stays intact; other devices will stop syncing.',
    confirmLabel: 'Delete gist',
    danger: true,
    requireText: 'DELETE',
  });
  if (!ok) return;
  try {
    await app.sync.destroyRemote();
    toast('Remote vault deleted', { tone: 'success' });
    app.rerender();
  } catch (err) {
    toast(err.message, { tone: 'danger' });
  }
}

/* ---------- security ---------- */

function securitySection(app) {
  const meta = app.storage.readMeta();
  const lockSel = select(
    [{ value: '1', label: '1 minute' }, { value: '5', label: '5 minutes' }, { value: '15', label: '15 minutes' }, { value: '30', label: '30 minutes' }, { value: '60', label: '1 hour' }, { value: '0', label: 'Never' }],
    String(meta.autoLockMinutes),
    { class: 'input', onchange: (e) => { app.setAutoLock(Number(e.target.value)); toast('Auto-lock updated', { tone: 'success' }); } },
  );
  return card(
    'Security',
    { subtitle: 'Zero-knowledge: your passphrase never leaves this device and is never stored.' },
    h(
      'ul',
      { class: 'sec-list' },
      h('li', {}, icon('lock', 16), h('span', {}, h('strong', {}, 'AES-256-GCM'), ' encryption, keys from PBKDF2-SHA256 (600k iterations)')),
      h('li', {}, icon('shield', 16), h('span', {}, h('strong', {}, 'HMAC-SHA256'), ' integrity seal detects tampering')),
      h('li', {}, icon('key', 16), h('span', {}, 'Tokens held in memory; optionally stored ', h('strong', {}, 'encrypted'))),
      h('li', {}, icon('eyeOff', 16), h('span', {}, 'Strict CSP + Trusted Types, no inline scripts, no third-party code')),
    ),
    field('Auto-lock after inactivity', lockSel, { hint: 'Locking purges keys, token and decrypted data from memory.' }),
    h('div', { class: 'row wrap gap-sm' }, button('Lock now', { icon: 'lock', variant: 'secondary', onClick: () => app.lock('manual') }), button('Change passphrase', { icon: 'key', variant: 'ghost', onClick: () => changePassphrase(app) })),
  );
}

function changePassphrase(app) {
  const cur = passwordInput({ autocomplete: 'current-password' });
  const next = passwordInput({ autocomplete: 'new-password' });
  const conf = passwordInput({ autocomplete: 'new-password' });
  const meter = h('div', { class: 'strength' });
  const fCur = field('Current passphrase', cur);
  const fNext = field('New passphrase', h('div', {}, next, meter));
  const fConf = field('Confirm new passphrase', conf);
  const nextInput = next.querySelector('input');
  nextInput.addEventListener('input', () => renderStrength(meter, nextInput.value));
  const btn = h('button', { class: 'btn btn-primary', type: 'submit', form: 'pp-form' }, 'Re-encrypt vault');
  const form = h('form', {
    id: 'pp-form', class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const p0 = cur.querySelector('input').value;
      const p1 = nextInput.value;
      const p2 = conf.querySelector('input').value;
      [fCur, fNext, fConf].forEach((f) => setFieldError(f, ''));
      if (passphraseStrength(p1).score < 2 || p1.length < 10) return setFieldError(fNext, 'Use at least 10 characters with a “Fair” or better rating');
      if (p1 !== p2) return setFieldError(fConf, 'Passphrases do not match');
      btn.disabled = true;
      btn.classList.add('loading');
      try {
        const keys = app.session.getKeys();
        const check = await deriveKeys(p0, { salt: keys.salt, iterations: keys.iterations });
        if (check.keyCheck !== keys.keyCheck) throw new Error('Current passphrase is incorrect');
        await app.vault.rekey(p1, app.data);
        app.sync.notifyLocalChange();
        m.close();
        toast('Vault re-encrypted with your new passphrase. Other devices will ask for it on next sync.', { tone: 'success', timeout: 6000 });
      } catch (err) {
        setFieldError(fCur, err.message);
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    },
  }, fCur, fNext, fConf);
  const m = openModal({ title: 'Change passphrase', size: 'sm', body: form, footer: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), btn] });
}

export function renderStrength(meter, value) {
  const st = passphraseStrength(value);
  mount(meter, h('div', { class: `strength-bar s${st.score}` }, h('span'), h('span'), h('span'), h('span')), h('span', { class: 'small muted' }, value ? `${st.label} · ~${st.bits} bits` : 'Use 4+ random words or 12+ mixed characters'));
}

/* ---------- preferences ---------- */

function prefsSection(app) {
  const meta = app.storage.readMeta();
  const theme = segmented(
    [{ value: 'system', label: 'System', icon: 'monitor' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }],
    meta.theme,
    (v) => app.setTheme(v),
    { label: 'Theme' },
  );
  const currency = select(CURRENCIES.map((c) => ({ value: c, label: c })), app.data.settings.currency, {
    class: 'input',
    onchange: (e) => { app.store.dispatch({ type: 'settings/update', patch: { currency: e.target.value } }); toast(`Currency set to ${e.target.value}`, { tone: 'success' }); },
  });
  const warn = select([{ value: '0.7', label: '70%' }, { value: '0.8', label: '80%' }, { value: '0.9', label: '90%' }], String(app.data.settings.budgetWarn), {
    class: 'input',
    onchange: (e) => app.store.dispatch({ type: 'settings/update', patch: { budgetWarn: Number(e.target.value) } }),
  });
  return card('Preferences', {}, field('Theme', theme), h('div', { class: 'form-grid' }, field('Currency', currency, { hint: 'Synced across devices' }), field('Budget warning at', warn)));
}

/* ---------- data portability ---------- */

function dataSection(app) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', id: 'import-json', onchange: (e) => importJson(app, e.target.files[0]).finally(() => (e.target.value = '')) });
  return card(
    'Your data',
    { subtitle: 'Fallback import/export — works fully offline.' },
    h(
      'div',
      { class: 'data-actions' },
      tileBtn('download', 'Encrypted backup', 'Same AES-GCM + HMAC format as the cloud vault', async () => {
        const env = await app.vault.sealForRemote(app.data, app.storage.readMeta().remoteRev);
        downloadText(`pfm-backup-${app.today()}.vault.json`, JSON.stringify(env, null, 2));
        toast('Encrypted backup downloaded', { tone: 'success' });
      }),
      tileBtn('file', 'Plain JSON export', 'Readable by other tools — unencrypted', async () => {
        const ok = await confirmDialog({ title: 'Export unencrypted data?', message: 'The file will contain all your financial data in plain text. Store it somewhere safe.', confirmLabel: 'Export' });
        if (!ok) return;
        downloadText(`pfm-export-${app.today()}.json`, JSON.stringify(makeExport(app.data), null, 2));
      }),
      tileBtn('upload', 'Import JSON', 'Plain export or encrypted backup — validated & sanitized', () => fileInput.click()),
      tileBtn('sparkle', 'Load demo data', 'Merge 12 months of sample activity', async () => {
        const ok = await confirmDialog({ title: 'Load demo data?', message: 'Sample accounts, transactions, budgets and goals will be merged into your vault.', confirmLabel: 'Load demo' });
        if (ok) app.loadDemo();
      }),
      tileBtn('trash', 'Erase this device', 'Remove vault, token and settings from this browser', async () => {
        const ok = await confirmDialog({ title: 'Erase all local data?', message: 'This removes the encrypted vault and token from this browser. Your remote gist (if any) is not touched.', confirmLabel: 'Erase device', danger: true, requireText: 'ERASE' });
        if (ok) app.wipe();
      }, 'danger'),
    ),
    fileInput,
  );
}

function tileBtn(ic, label, sub, onClick, tone) {
  return h('button', { class: ['data-tile', tone && `data-tile-${tone}`], type: 'button', onclick: onClick }, h('span', { class: 'data-tile-icon' }, icon(ic, 18)), h('span', { class: 'data-tile-label' }, label), h('span', { class: 'small muted' }, sub));
}

async function importJson(app, file) {
  if (!file) return;
  let raw;
  try {
    raw = JSON.parse(await readFileText(file, 20 * 1024 * 1024));
  } catch {
    return toast('That file is not valid JSON', { tone: 'danger' });
  }
  let dataset;
  try {
    if (isEnvelope(raw)) {
      let opened = null;
      const pass = await passphraseDialog({
        title: 'Encrypted backup',
        message: 'Enter the passphrase this backup was encrypted with.',
        confirmLabel: 'Decrypt',
        verify: async (p) => {
          try {
            opened = await openWithPassphrase(p, raw);
          } catch (err) {
            throw new Error(err.code === 'TAMPERED' ? 'Backup failed integrity verification (tampered or corrupted)' : 'Incorrect passphrase');
          }
        },
      });
      if (!pass || !opened) return;
      dataset = normalizeData(opened.value);
    } else {
      dataset = normalizeData(raw, { regenerateIds: true });
    }
  } catch (err) {
    return toast(`Import rejected: ${err.message}`, { tone: 'danger', timeout: 7000 });
  }
  const { data, warnings } = dataset;
  const counts = ['accounts', 'transactions', 'budgets', 'goals', 'recurring'].map((c) => `${live(data[c]).length} ${c}`).join(' · ');
  const mode = await new Promise((resolve) => {
    let choice = null;
    const m = openModal({
      title: 'Import data',
      size: 'sm',
      body: h('div', { class: 'stack' }, h('p', {}, h('strong', {}, 'Validated: '), counts), warnings.length ? h('p', { class: 'small warn' }, warnings.join('. ')) : null, h('p', { class: 'muted small' }, 'Merge keeps the newest version of each record. Replace discards your current data.')),
      footer: [
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { choice = 'replace'; m.close(); } }, 'Replace'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { choice = 'merge'; m.close(); } }, 'Merge'),
      ],
      onClose: () => resolve(choice),
    });
  });
  if (!mode) return;
  app.importData(data, mode);
  toast(`Import complete (${mode})`, { tone: 'success' });
}

/* ---------- categories & rules ---------- */

function categoriesSection(app) {
  const groups = ['expense', 'income'].map((kind) =>
    h(
      'div',
      { class: 'cat-group' },
      h('h4', { class: 'eyebrow' }, kind === 'expense' ? 'Expense' : 'Income'),
      h('ul', { class: 'chip-list' }, liveCategories(app.data, kind).map((c) => h('li', {}, h('button', { class: 'cat-chip', type: 'button', onclick: () => app.forms.category(c), 'aria-label': `Edit ${c.name}` }, categoryDot(c, 'sm'), c.name)))),
    ),
  );
  return card('Categories', { actions: button('Add', { icon: 'plus', size: 'sm', variant: 'ghost', onClick: () => app.forms.category() }) }, groups);
}

function rulesSection(app) {
  const rules = live(app.data.rules);
  return card(
    'Auto-categorization rules',
    { subtitle: 'Applied before learned history and merchant matching', actions: h('div', { class: 'row gap-sm' }, button('Run now', { icon: 'wand', size: 'sm', variant: 'ghost', onClick: () => app.actions.autoCategorize() }), button('Add', { icon: 'plus', size: 'sm', variant: 'ghost', onClick: () => app.forms.rule() })) },
    rules.length
      ? h('ul', { class: 'rule-list' }, rules.map((r) => h('li', {}, h('button', { class: 'rule', type: 'button', onclick: () => app.forms.rule(r) }, h('span', { class: 'mono' }, `“${r.pattern}”`), icon('arrowRight', 14), categoryDot(categoryOf(app.data, r.categoryId), 'sm'), h('span', {}, categoryOf(app.data, r.categoryId).name)))))
      : h('p', { class: 'muted small' }, 'No rules yet. Example: payee contains “whole foods” → Groceries.'),
  );
}

/* ---------- about ---------- */

function aboutSection(app) {
  return card(
    null,
    { cls: 'about' },
    h('div', { class: 'row between wrap' }, h('span', { class: 'small muted' }, `Personal Finance Manager v${app.version} · build ${app.build}`), h('a', { class: 'small', href: 'https://github.com/chysreax/personal-finance#readme', target: '_blank', rel: 'noopener noreferrer' }, 'Documentation & architecture ↗')),
  );
}

