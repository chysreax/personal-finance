/** App chrome: sidebar (desktop), icon rail (tablet), bottom bar + drawer (mobile). */
import { h, mount, clear } from './dom.js';
import { icon } from './icons.js';
import { SYNC_LABEL } from './views/settings.js';
import { relativeTime } from '../core/dates.js';
import { BLOCKING } from '../services/sync.js';

export const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', mobile: true },
  { id: 'transactions', label: 'Transactions', icon: 'list', mobile: true },
  { id: 'analytics', label: 'Analytics', icon: 'chart', mobile: true },
  { id: 'budgets', label: 'Budgets', icon: 'wallet', mobile: true },
  { id: 'goals', label: 'Goals', icon: 'target' },
  { id: 'recurring', label: 'Recurring', icon: 'repeat' },
  { id: 'accounts', label: 'Accounts', icon: 'bank' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function createShell(app) {
  const navLinks = new Map();
  const bottomLinks = new Map();
  const navItem = (n) => {
    const a = h('a', { class: 'nav-link', href: `#/${n.id}`, title: n.label, onclick: () => closeDrawer() }, icon(n.icon, 19), h('span', { class: 'nav-label' }, n.label));
    navLinks.set(n.id, a);
    return h('li', {}, a);
  };

  const syncCard = h('button', { class: 'sync-card-mini', type: 'button', onclick: () => app.navigate('settings') });
  const sidebar = h(
    'aside',
    { class: 'sidebar', id: 'sidebar', 'aria-label': 'Main navigation' },
    h('a', { class: 'brand', href: '#/dashboard' }, h('span', { class: 'brand-mark' }, icon('wallet', 18)), h('span', { class: 'brand-name' }, 'Ledgerly')),
    h('nav', {}, h('ul', { class: 'nav' }, NAV.map(navItem))),
    h('div', { class: 'sidebar-foot' }, syncCard, h('button', { class: 'nav-link lock-btn', type: 'button', onclick: () => app.lock('manual'), title: 'Lock vault' }, icon('lock', 19), h('span', { class: 'nav-label' }, 'Lock vault'))),
  );

  const titleEl = h('span', { class: 'topbar-title' });
  const syncPill = h('button', { class: 'sync-pill', type: 'button', onclick: () => app.navigate('settings'), 'aria-live': 'polite' });
  const themeBtn = h('button', { class: 'icon-btn', type: 'button', onclick: () => app.cycleTheme() });
  const banner = h('div', { class: 'banner-host' });
  const main = h('main', { id: 'main', class: 'content', tabindex: '-1' });

  const topbar = h(
    'header',
    { class: 'topbar' },
    h('button', { class: 'icon-btn menu-btn', type: 'button', 'aria-label': 'Open menu', 'aria-controls': 'sidebar', onclick: () => openDrawer() }, icon('menu', 20)),
    titleEl,
    h('div', { class: 'topbar-actions' }, syncPill, themeBtn, h('button', { class: 'icon-btn hide-sm', type: 'button', 'aria-label': 'Lock vault', title: 'Lock vault', onclick: () => app.lock('manual') }, icon('lock', 18))),
  );

  const bottom = h(
    'nav',
    { class: 'bottom-nav', 'aria-label': 'Primary' },
    NAV.filter((n) => n.mobile).map((n) => {
      const a = h('a', { href: `#/${n.id}`, class: 'bottom-link' }, icon(n.icon, 20), h('span', {}, n.label === 'Transactions' ? 'Activity' : n.label));
      bottomLinks.set(n.id, a);
      return a;
    }),
    h('button', { class: 'bottom-link', type: 'button', onclick: () => openDrawer(), 'aria-label': 'More' }, icon('more', 20), h('span', {}, 'More')),
  );
  const fab = h('button', { class: 'fab', type: 'button', 'aria-label': 'Add transaction', onclick: () => app.forms.transaction() }, icon('plus', 24));
  const scrim = h('div', { class: 'scrim', onclick: () => closeDrawer() });

  const root = h('div', { class: 'app-shell' }, h('a', { class: 'skip-link', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'Skip to content'), sidebar, scrim, h('div', { class: 'main-col' }, topbar, banner, main), bottom, fab);

  function openDrawer() {
    root.classList.add('drawer-open');
    navLinks.values().next().value?.focus();
  }
  function closeDrawer() {
    root.classList.remove('drawer-open');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('drawer-open')) closeDrawer();
  });

  function setRoute(id, label) {
    titleEl.textContent = label;
    for (const [k, a] of navLinks) {
      a.classList.toggle('active', k === id);
      if (k === id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const inBottom = bottomLinks.has(id);
    for (const [k, a] of bottomLinks) a.classList.toggle('active', k === id);
    bottom.lastChild.classList.toggle('active', !inBottom);
    closeDrawer();
  }

  function setSync(st) {
    const [label, tone, ic] = SYNC_LABEL[st.status] || SYNC_LABEL.error;
    const when = st.status === 'synced' && st.lastSyncAt ? relativeTime(st.lastSyncAt) : '';
    syncPill.className = `sync-pill tone-${tone} ${st.status === 'syncing' ? 'spinning' : ''}`;
    syncPill.title = st.message || label;
    mount(syncPill, icon(ic, 15), h('span', { class: 'sync-pill-label' }, label));
    mount(
      syncCard,
      h('span', { class: `sync-dot tone-${tone} ${st.status === 'syncing' ? 'spinning' : ''}` }, icon(ic, 16)),
      h('span', { class: 'sync-text' }, h('strong', {}, label), h('span', { class: 'small muted' }, st.status === 'disconnected' ? 'Set up GitHub sync' : when || (st.login ? `@${st.login}` : ''))),
    );
    clear(banner);
    if (BLOCKING.has(st.status) || st.status === 'auth') {
      banner.appendChild(
        h(
          'div',
          { class: `banner banner-${tone}`, role: 'alert' },
          icon(ic, 18),
          h('span', {}, st.message || label),
          h('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: () => (st.status === 'rekeyed' ? app.promptRemotePassphrase() : app.navigate('settings')) }, st.status === 'rekeyed' ? 'Enter passphrase' : 'Resolve'),
        ),
      );
    }
  }

  function setTheme(pref) {
    mount(themeBtn, icon(pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'monitor', 18));
    themeBtn.setAttribute('aria-label', `Theme: ${pref}. Click to change.`);
    themeBtn.title = `Theme: ${pref}`;
  }

  return { root, main, setRoute, setSync, setTheme };
}
