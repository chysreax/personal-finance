/** Theme handling: 'system' follows prefers-color-scheme; explicit choices win. */
const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return mq?.matches ? 'dark' : 'light';
}

export function applyTheme(pref) {
  const mode = resolveTheme(pref);
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#0c111b' : '#f5f6fa');
}

export function watchSystemTheme(getPref) {
  mq?.addEventListener('change', () => {
    if (getPref() === 'system') applyTheme('system');
  });
}
