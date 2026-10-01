/**
 * Inactivity auto-lock. Any pointer/key/scroll activity resets the clock; a
 * warning toast appears 30 s before locking. Time spent in a background tab
 * counts as inactivity, and is checked again the moment the tab is visible.
 */
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'];

export function startAutoLock({ minutes, onLock, onWarn }) {
  if (!minutes) return () => {};
  const limit = minutes * 60_000;
  let last = Date.now();
  let warned = false;
  let dismissWarn = null;

  const activity = () => {
    last = Date.now();
    if (warned) {
      warned = false;
      dismissWarn?.();
      dismissWarn = null;
    }
  };
  const check = () => {
    const idle = Date.now() - last;
    if (idle >= limit) {
      stop();
      onLock('idle');
    } else if (idle >= limit - 30_000 && !warned) {
      warned = true;
      dismissWarn = onWarn?.(activity) || null;
    }
  };
  const onVisible = () => document.visibilityState === 'visible' && check();

  EVENTS.forEach((e) => window.addEventListener(e, activity, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(check, 5_000);

  function stop() {
    clearInterval(timer);
    EVENTS.forEach((e) => window.removeEventListener(e, activity, { capture: true }));
    document.removeEventListener('visibilitychange', onVisible);
    dismissWarn?.();
  }
  return stop;
}
