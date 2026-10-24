// Runs before the first paint (a blocking same-origin script, allowed by the CSP) so the sanctuary
// never flashes the wrong hour. Keep the key and canvas colours in step with src/theme.ts and styles.css.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('donarium-theme'); } catch (error) { /* Storage unavailable. */ }
  if (theme !== 'light' && theme !== 'dark') theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  var scheme = document.querySelector('meta[name="color-scheme"]');
  var chrome = document.querySelector('meta[name="theme-color"]');
  if (scheme) scheme.setAttribute('content', theme);
  if (chrome) chrome.setAttribute('content', theme === 'light' ? '#f5f3ef' : '#0d0d10');
})();
