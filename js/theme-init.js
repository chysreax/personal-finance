// Runs before first paint (render-blocking, tiny) so the saved theme never flashes.
(function () {
  var pref = 'system';
  try {
    var meta = JSON.parse(localStorage.getItem('pfm:meta') || '{}');
    if (meta.theme === 'light' || meta.theme === 'dark') pref = meta.theme;
  } catch (e) {
    /* storage unavailable */
  }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
