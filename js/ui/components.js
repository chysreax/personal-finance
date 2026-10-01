/** Reusable UI primitives (all built through the safe `h` builder). */
import { h, clear } from './dom.js';
import { icon } from './icons.js';

/* ---------- toasts ---------- */

let toastRoot;
function toastHost() {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', role: 'region', 'aria-live': 'polite', 'aria-label': 'Notifications' });
    document.body.appendChild(toastRoot);
  }
  return toastRoot;
}

/**
 * @param {string} message
 * @param {{tone?: 'info'|'success'|'warning'|'danger', action?: {label: string, fn: () => void}, timeout?: number}} [o]
 */
export function toast(message, o = {}) {
  const tone = o.tone || 'info';
  const ic = { success: 'check', warning: 'alert', danger: 'alert', info: 'info' }[tone];
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  const el = h(
    'div',
    { class: `toast toast-${tone}`, role: tone === 'danger' ? 'alert' : 'status' },
    h('span', { class: 'toast-icon' }, icon(ic, 16)),
    h('span', { class: 'toast-msg' }, message),
    o.action &&
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { o.action.fn(); close(); } }, o.action.label),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: close }, icon('x', 14)),
  );
  toastHost().appendChild(el);
  const host = toastHost();
  while (host.children.length > 4) host.firstChild.remove();
  timer = setTimeout(close, o.timeout ?? (o.action ? 6000 : 3500));
  return close;
}

/* ---------- modal ---------- */

const openModals = [];

/**
 * @param {{title: string, body: Node, footer?: Node[], size?: 'sm'|'md'|'lg', onClose?: () => void, dismissible?: boolean}} o
 */
export function openModal(o) {
  const previous = document.activeElement;
  const titleId = `m-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = h(
    'div',
    { class: `modal modal-${o.size || 'md'}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h(
      'header',
      { class: 'modal-head' },
      h('h2', { id: titleId, class: 'modal-title' }, o.title),
      o.dismissible !== false && h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x', 18)),
    ),
    h('div', { class: 'modal-body' }, o.body),
    o.footer && h('footer', { class: 'modal-foot' }, o.footer),
  );
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === backdrop && o.dismissible !== false) close(); } }, dialog);

  function onKey(e) {
    if (openModals[openModals.length - 1] !== api) return;
    if (e.key === 'Escape' && o.dismissible !== false) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (x) => !x.disabled && x.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.classList.add('leaving');
    openModals.splice(openModals.indexOf(api), 1);
    setTimeout(() => backdrop.remove(), 160);
    if (!openModals.length) document.body.classList.remove('modal-open');
    o.onClose?.();
    if (previous && previous.focus) previous.focus();
  }
  const api = { close, el: dialog };
  openModals.push(api);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    const auto = dialog.querySelector('[autofocus], input:not([type=hidden]), select, textarea, .modal-foot .btn-primary');
    (auto || dialog).focus();
  });
  return api;
}

export const closeAllModals = () => [...openModals].forEach((m) => m.close());

/** Promise-based confirmation dialog. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, requireText }) {
  return new Promise((resolve) => {
    let ok = false;
    const input = requireText
      ? h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${requireText} to confirm`, placeholder: requireText })
      : null;
    const confirmBtn = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', disabled: !!requireText }, confirmLabel);
    if (input) input.addEventListener('input', () => (confirmBtn.disabled = input.value.trim() !== requireText));
    const m = openModal({
      title,
      size: 'sm',
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, message), input && h('p', { class: 'small' }, 'Type ', h('strong', requireText), ' to confirm.'), input),
      footer: [
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Cancel'),
        confirmBtn,
      ],
      onClose: () => resolve(ok),
    });
    confirmBtn.addEventListener('click', () => {
      ok = true;
      m.close();
    });
  });
}

/** Ask for a passphrase. `verify` may throw to show an inline error and keep the dialog open. */
export function passphraseDialog({ title, message, confirmLabel = 'Continue', verify }) {
  return new Promise((resolve) => {
    let result = null;
    const input = passwordInput({ placeholder: 'Passphrase', autocomplete: 'current-password' });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, confirmLabel);
    const form = h(
      'form',
      { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        const value = input.querySelector('input').value;
        if (!value) return;
        btn.disabled = true;
        btn.classList.add('loading');
        err.textContent = '';
        try {
          if (verify) await verify(value);
          result = value;
          m.close();
        } catch (ex) {
          err.textContent = ex.message || 'Incorrect passphrase';
          btn.disabled = false;
          btn.classList.remove('loading');
        }
      } },
      h('p', { class: 'muted' }, message),
      input,
      err,
      h('div', { class: 'row end' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), btn),
    );
    const m = openModal({ title, size: 'sm', body: form, onClose: () => resolve(result) });
  });
}

/* ---------- form bits ---------- */

let fieldSeq = 0;
export function field(label, control, { hint, error, id } = {}) {
  const cid = id || control.id || `f${++fieldSeq}`;
  const target = control.matches?.('input, select, textarea') ? control : control.querySelector?.('input, select, textarea');
  if (target && !target.id) target.id = cid;
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field-label', for: target?.id || cid }, label),
    control,
    hint && h('p', { class: 'field-hint' }, hint),
    h('p', { class: 'field-error', role: 'alert' }, error || ''),
  );
}

export function setFieldError(fieldEl, message) {
  const e = fieldEl.querySelector('.field-error');
  if (e) e.textContent = message || '';
  fieldEl.classList.toggle('has-error', !!message);
}

export function select(options, value, props = {}) {
  return h(
    'select',
    { class: 'input', ...props },
    options.map((o) =>
      o.group
        ? h('optgroup', { label: o.group }, o.options.map((x) => h('option', { value: x.value, selected: x.value === value }, x.label)))
        : h('option', { value: o.value, selected: o.value === value }, o.label),
    ),
  );
}

export function passwordInput(props = {}) {
  const input = h('input', { class: 'input', type: 'password', spellcheck: 'false', autocapitalize: 'off', ...props });
  const toggle = h('button', { class: 'icon-btn input-addon', type: 'button', 'aria-label': 'Show value', 'aria-pressed': 'false' }, icon('eye', 16));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide value' : 'Show value');
    clear(toggle).appendChild(icon(show ? 'eyeOff' : 'eye', 16));
  });
  return h('div', { class: 'input-wrap' }, input, toggle);
}

/** Segmented control. */
export function segmented(options, value, onChange, { label, size } = {}) {
  const root = h('div', { class: `segmented ${size ? `segmented-${size}` : ''}`, role: 'radiogroup', 'aria-label': label || 'Options' });
  const render = (v) => {
    clear(root);
    for (const o of options) {
      root.appendChild(
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: o.value === v ? 'active' : '',
            'aria-checked': String(o.value === v),
            tabindex: o.value === v ? '0' : '-1',
            onclick: () => {
              render(o.value);
              onChange(o.value);
            },
            onkeydown: (e) => {
              if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
              e.preventDefault();
              const i = options.findIndex((x) => x.value === v);
              const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
              render(next.value);
              onChange(next.value);
              root.querySelector('[aria-checked="true"]')?.focus();
            },
          },
          o.icon && icon(o.icon, 15),
          o.label,
        ),
      );
    }
  };
  render(value);
  root.setValue = render;
  return root;
}

/* ---------- display ---------- */

export function card(title, { actions, subtitle, cls } = {}, ...body) {
  return h(
    'section',
    { class: ['card', cls] },
    (title || actions) &&
      h('header', { class: 'card-head' }, h('div', {}, title && h('h3', { class: 'card-title' }, title), subtitle && h('p', { class: 'card-sub' }, subtitle)), actions && h('div', { class: 'card-actions' }, actions)),
    body,
  );
}

export function progressBar(ratio, { tone = 'primary', marker, label } = {}) {
  const pct = Math.max(0, Math.min(1, ratio || 0));
  const bar = h(
    'div',
    { class: `progress progress-${tone}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct * 100)), 'aria-label': label || 'Progress' },
    h('div', { class: 'progress-fill', style: { '--w': `${(pct * 100).toFixed(2)}%` } }),
    marker !== undefined && h('div', { class: 'progress-marker', style: { left: `${Math.min(100, marker * 100).toFixed(2)}%` }, title: 'Expected by today' }),
  );
  return bar;
}

export function badge(text, tone = 'neutral', ic) {
  return h('span', { class: `badge badge-${tone}` }, ic && icon(ic, 12), text);
}

export function emptyState({ icon: ic = 'sparkle', title, text, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(ic, 26)),
    h('h3', {}, title),
    text && h('p', { class: 'muted' }, text),
    action && h('button', { class: 'btn btn-primary', type: 'button', onclick: action.fn }, icon('plus', 16), action.label),
  );
}

export function statCard({ label, value, delta, deltaTone, icon: ic, foot, spark, tone }) {
  return h(
    'div',
    { class: ['stat', tone && `stat-${tone}`] },
    h('div', { class: 'stat-top' }, h('span', { class: 'stat-label' }, label), ic && h('span', { class: 'stat-icon' }, icon(ic, 16))),
    h('div', { class: 'stat-value' }, value),
    h('div', { class: 'stat-foot' }, delta && h('span', { class: `delta delta-${deltaTone || 'neutral'}` }, delta), foot && h('span', { class: 'muted' }, foot)),
    spark,
  );
}

export function categoryDot(cat, size = 'md') {
  return h('span', { class: `cat-dot cat-dot-${size} slot-${cat?.color ?? -1}`, 'aria-hidden': 'true' }, cat?.icon || '•');
}

export function skeleton(lines = 3) {
  return h('div', { class: 'skeleton-block' }, Array.from({ length: lines }, () => h('div', { class: 'skeleton' })));
}
