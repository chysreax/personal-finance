/**
 * Composition root. Wires storage → session/vault → store → sync → UI.
 *
 *   ┌────────┐ dispatch ┌───────┐ notify ┌──────────────┐
 *   │ views  │ ───────► │ store │ ─────► │ render (rAF) │
 *   └────────┘          └───┬───┘        └──────────────┘
 *                           ├──► encrypted local persist (debounced)
 *                           └──► sync engine (debounced push / periodic pull)
 */
import { createLocalStore } from './services/storage.js';
import { createSession, createVault } from './services/vault.js';
import { createGistClient } from './services/github.js';
import { createSync } from './services/sync.js';
import { createStore } from './state/store.js';
import { emptyData } from './core/schema.js';
import { mergeData } from './core/merge.js';
import { stamp } from './core/ids.js';
import { COLLECTIONS } from './core/schema.js';
import { formatMoney } from './core/money.js';
import { todayISO } from './core/dates.js';
import { generateDemoData } from './core/demo.js';
import { redact } from './core/redact.js';
import { mount, h } from './ui/dom.js';
import { createShell } from './ui/shell.js';
import { showLockScreen } from './ui/lock.js';
import { toast, closeAllModals, passphraseDialog, card } from './ui/components.js';
import { pruneCharts, hideTip } from './ui/charts.js';
import { applyTheme, watchSystemTheme } from './ui/theme.js';
import { startAutoLock } from './ui/autolock.js';
import { createActions } from './ui/actions.js';
import * as forms from './ui/forms.js';
import * as dashboard from './ui/views/dashboard.js';
import * as transactions from './ui/views/transactions.js';
import * as analytics from './ui/views/analytics.js';
import * as budgets from './ui/views/budgets.js';
import * as goals from './ui/views/goals.js';
import * as recurring from './ui/views/recurring.js';
import * as accounts from './ui/views/accounts.js';
import * as settings from './ui/views/settings.js';

const VERSION = '1.0.0';
const BUILD = '__BUILD__';
const ROUTES = { dashboard, transactions, analytics, budgets, goals, recurring, accounts, settings };

/* ---------- services ---------- */

function safeLocalStorage() {
  try {
    const k = '__pfm_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null; // in-memory fallback (private browsing, blocked storage)
  }
}

const storage = createLocalStore(safeLocalStorage());
const session = createSession();
const vault = createVault({ storage, session });
const store = createStore(emptyData());
const client = createGistClient({ getToken: () => session.getToken() });
const sync = createSync({
  client,
  vault,
  session,
  storage,
  getData: () => store.data,
  getVersion: () => store.version,
  applyRemote: (data) => store.dispatch({ type: 'data/replace', data, source: 'remote' }),
  online: () => navigator.onLine !== false,
  visible: () => document.visibilityState === 'visible',
});

const root = document.getElementById('app');
let shell = null;
let route = { id: 'dashboard', params: {} };
let stopAutoLock = () => {};
let renderQueued = false;
let persistTimer = null;
let persistPromise = Promise.resolve();

/* ---------- app context passed to every view ---------- */

const app = {
  version: VERSION,
  build: BUILD.startsWith('__') ? 'dev' : BUILD,
  store,
  storage,
  session,
  vault,
  sync,
  get data() {
    return store.data;
  },
  today: () => todayISO(),
  money: (cents, o) => formatMoney(cents, store.data.settings.currency, o),
  navigate(r) {
    const target = `#/${r}`;
    if (location.hash === target) renderRoute();
    else location.hash = target;
  },
  replaceRoute(r) {
    history.replaceState(null, '', `#/${r}`);
    route = parseRoute();
  },
  rerender: () => renderRoute(),
  forms: {
    transaction: (t, preset) => forms.transactionForm(app, t, preset),
    account: (a, o) => forms.accountForm(app, a, o),
    budget: (b, p) => forms.budgetForm(app, b, p),
    goal: (g) => forms.goalForm(app, g),
    contribute: (g) => forms.contributeForm(app, g),
    recurring: (r, p) => forms.recurringForm(app, r, p),
    category: (c) => forms.categoryForm(app, c),
    rule: (r) => forms.ruleForm(app, r),
  },
  actions: null,
  lock,
  setTheme,
  cycleTheme() {
    const order = ['system', 'light', 'dark'];
    setTheme(order[(order.indexOf(storage.readMeta().theme) + 1) % order.length]);
  },
  setAutoLock(minutes) {
    storage.writeMeta({ autoLockMinutes: minutes });
    armAutoLock();
  },
  importData,
  loadDemo() {
    importData(generateDemoData(todayISO(), Date.now() % 100000), 'merge');
    toast('Demo data loaded', { tone: 'success' });
  },
  wipe() {
    sync.stop();
    session.lock('wipe');
    storage.wipe();
    location.reload();
  },
  promptRemotePassphrase() {
    return passphraseDialog({
      title: 'Remote vault passphrase',
      message: 'The vault on GitHub was re-encrypted with a different passphrase (changed on another device). Enter it to adopt the new key on this device.',
      confirmLabel: 'Unlock remote',
      verify: async (p) => {
        try {
          await sync.provideRemotePassphrase(p);
        } catch (err) {
          throw new Error(err.code === 'TAMPERED' ? 'Remote failed integrity verification' : 'Incorrect passphrase');
        }
      },
    }).then((ok) => ok && toast('Passphrase updated — sync resumed', { tone: 'success' }));
  },
  onUnlocked,
};
app.actions = createActions(app);

/* ---------- routing ---------- */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const id = ROUTES[path] ? path : 'dashboard';
  const params = Object.fromEntries(new URLSearchParams(query));
  return { id, params };
}

function renderRoute() {
  if (!shell) return;
  const next = parseRoute();
  const same = next.id === route.id;
  route = next;
  const mod = ROUTES[route.id];
  const active = document.activeElement;
  const focusId = active && active.id && shell.main.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const scrollY = window.scrollY;
  let node;
  try {
    node = mod.render(app, route.params);
  } catch (err) {
    node = h('div', { class: 'view' }, card('Something went wrong', {}, h('p', { class: 'muted' }, `This view could not be rendered: ${redact(err.message)}`), h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => app.navigate('dashboard') }, 'Back to dashboard')));
  }
  hideTip();
  mount(shell.main, node);
  pruneCharts();
  shell.setRoute(route.id, mod.title);
  document.title = `${mod.title} · Ledgerly`;
  if (same) {
    window.scrollTo(0, scrollY);
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ }
      }
    }
  } else {
    window.scrollTo(0, 0);
    shell.main.querySelector('.page-title')?.focus({ preventScroll: true });
  }
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderRoute();
  });
}

/* ---------- persistence ---------- */

function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  if (!session.unlocked) return persistPromise;
  const data = store.data;
  persistPromise = persistPromise
    .then(() => vault.persist(data))
    .catch((err) => toast(redact(err.message || 'Could not save locally'), { tone: 'danger' }));
  return persistPromise;
}

store.subscribe((_data, action) => {
  if (!session.unlocked) return;
  queueRender();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 250);
  if (action.source !== 'remote') sync.notifyLocalChange();
});

sync.subscribe((st) => {
  shell?.setSync(st);
  if (shell && route.id === 'settings') queueRender();
});

session.on((e) => {
  if (e.type === 'token-expired') {
    toast('GitHub token session expired and was purged from memory', { tone: 'warning' });
    setTimeout(() => sync.kick(), 0);
  }
});

/* ---------- import ---------- */

function importData(incoming, mode) {
  if (mode === 'replace') {
    // Replace must also win against the remote copy: stamp every imported record
    // as newest and tombstone every local record that is not in the import.
    const next = { ...incoming, schema: incoming.schema };
    for (const c of COLLECTIONS) {
      const ids = new Set(incoming[c].map((r) => r.id));
      const fresh = incoming[c].map((r) => ({ ...r, updatedAt: stamp() }));
      const gone = store.data[c].filter((r) => !ids.has(r.id)).map((r) => ({ id: r.id, deleted: true, updatedAt: stamp() }));
      next[c] = [...fresh, ...gone];
    }
    next.settings = { ...incoming.settings, updatedAt: stamp() };
    store.dispatch({ type: 'data/replace', data: next });
  } else {
    store.dispatch({ type: 'data/replace', data: mergeData(store.data, incoming).data });
  }
}

/* ---------- lock / unlock lifecycle ---------- */

async function onUnlocked(data, opts = {}) {
  store.dispatch({ type: 'data/replace', data, source: 'remote' });
  if (!session.getToken()) await vault.restoreToken();
  shell = createShell(app);
  mount(root, shell.root);
  shell.setTheme(storage.readMeta().theme);
  shell.setSync(sync.state);
  route = { id: '', params: {} };
  renderRoute();
  sync.start();
  armAutoLock();
  if (opts.fresh) toast('Vault created. Everything you add is encrypted on this device.', { tone: 'success', timeout: 5000 });
  else if (opts.restored) toast('Vault restored and decrypted from GitHub', { tone: 'success' });
  if (opts.warnings?.length) toast(opts.warnings.join('. '), { tone: 'warning' });
}

async function lock(reason = 'manual') {
  if (!session.unlocked) return;
  await persistNow();
  sync.stop();
  stopAutoLock();
  closeAllModals();
  hideTip();
  shell = null;
  session.lock(reason);
  // Drop decrypted data from memory.
  store.dispatch({ type: 'data/replace', data: emptyData(), source: 'remote' });
  showLockScreen(root, app, 'unlock', {
    tone: 'info',
    text: reason === 'idle' ? 'Locked after inactivity. Keys, token and decrypted data were purged from memory.' : 'Vault locked. Keys, token and decrypted data were purged from memory.',
  });
}

function armAutoLock() {
  stopAutoLock();
  stopAutoLock = startAutoLock({
    minutes: storage.readMeta().autoLockMinutes,
    onLock: (r) => lock(r),
    onWarn: (stay) => toast('Locking soon due to inactivity', { tone: 'warning', timeout: 30_000, action: { label: 'Stay unlocked', fn: stay } }),
  });
}

function setTheme(pref) {
  storage.writeMeta({ theme: pref });
  applyTheme(pref);
  shell?.setTheme(pref);
}

/* ---------- global wiring ---------- */

window.addEventListener('hashchange', () => renderRoute());
window.addEventListener('online', () => sync.kick());
window.addEventListener('offline', () => sync.kick());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync.kick();
  else if (persistTimer) persistNow();
});
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  toast(redact(e.reason?.message || 'Unexpected error'), { tone: 'danger' });
});
window.addEventListener('error', (e) => {
  if (e.message && /ResizeObserver loop/.test(e.message)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
});
document.addEventListener('keydown', (e) => {
  if (!shell || e.ctrlKey || e.metaKey || e.altKey || document.body.classList.contains('modal-open')) return;
  const t = e.target;
  if (t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'n') {
    e.preventDefault();
    app.forms.transaction();
  } else if (e.key === '/') {
    e.preventDefault();
    if (route.id !== 'transactions') app.navigate('transactions');
    requestAnimationFrame(() => document.getElementById('tx-search')?.focus());
  }
});

watchSystemTheme(() => storage.readMeta().theme);
applyTheme(storage.readMeta().theme);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  let updateRequested = false;
  // Trusted Types treats a worker URL as a script sink. The only policy the CSP
  // allows ("pfm-sw") can mint exactly one value — no HTML policy exists at all.
  const ttPolicy = window.trustedTypes?.createPolicy('pfm-sw', {
    createScriptURL: (url) => {
      if (url !== './sw.js') throw new TypeError('Blocked script URL');
      return url;
    },
  });
  navigator.serviceWorker
    .register(ttPolicy ? ttPolicy.createScriptURL('./sw.js') : './sw.js', { scope: './' })
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is available', { timeout: 15_000, action: { label: 'Reload', fn: () => { updateRequested = true; nw.postMessage('skip-waiting'); } } });
          }
        });
      });
    })
    .catch(() => {
      /* offline support is best-effort */
    });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested) return;
    updateRequested = false;
    location.reload();
  });
}

showLockScreen(root, app);
document.documentElement.classList.add('ready');
