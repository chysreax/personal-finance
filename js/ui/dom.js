/**
 * XSS-safe DOM builder. This is the ONLY way the app creates markup:
 *   • text is always inserted as Text nodes (never parsed as HTML);
 *   • `innerHTML`/`outerHTML`/`srcdoc` props are refused outright;
 *   • inline event-handler attributes (on*) are refused — handlers are bound
 *     as functions via addEventListener;
 *   • href/src only accept same-document fragments or https URLs.
 * The CSP additionally enforces Trusted Types with no policies, so any string
 * reaching an HTML sink would throw at runtime.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const FORBIDDEN_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'insertAdjacentHTML']);
const ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9:._-]*$/;
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly', 'required', 'multiple', 'indeterminate']);

export function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (s.startsWith('#')) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.href : '#';
  } catch {
    return '#';
  }
}

function apply(el, props, isSvg) {
  for (const [key, val] of Object.entries(props)) {
    if (val === undefined || val === null || val === false) continue;
    if (FORBIDDEN_PROPS.has(key)) throw new Error(`Refusing to set ${key}`);
    if (key === 'class' || key === 'className') {
      const cls = Array.isArray(val) ? val.filter(Boolean).join(' ') : String(val);
      if (isSvg) el.setAttribute('class', cls);
      else el.className = cls;
    } else if (key === 'text') {
      el.textContent = String(val);
    } else if (key === 'style') {
      // CSSOM writes are permitted under a strict style-src CSP (attributes are not).
      for (const [p, v] of Object.entries(val)) if (v !== undefined && v !== null) el.style.setProperty(p, String(v));
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(val)) el.dataset[k] = String(v);
    } else if (key === 'on') {
      for (const [evt, fn] of Object.entries(val)) if (typeof fn === 'function') el.addEventListener(evt, fn);
    } else if (key.startsWith('on') && typeof val === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (key === 'ref' && typeof val === 'function') {
      val(el);
    } else if (!isSvg && PROPS.has(key)) {
      el[key] = val;
    } else {
      if (!ATTR_NAME.test(key) || /^on/i.test(key)) throw new Error(`Refusing attribute ${key}`);
      const v = val === true ? '' : URL_ATTRS.has(key) ? safeUrl(val) : String(val);
      el.setAttribute(key, v);
    }
  }
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** HTML element: h('div', {class: 'x'}, 'text', child, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
  } else if (props) apply(el, props, false);
  append(el, children);
  return el;
}

/** SVG element */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) apply(el, props, true);
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Trigger a download of in-memory text (Blob URL, revoked right after). */
export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { download: filename, style: { display: 'none' } });
  a.href = url; // blob: URL created by us — set as property, bypassing the https-only attribute filter
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileText(file, maxBytes = 15 * 1024 * 1024) {
  if (file.size > maxBytes) return Promise.reject(new Error(`File is larger than ${Math.round(maxBytes / 1048576)} MB`));
  return file.text();
}

export const prefersReducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
