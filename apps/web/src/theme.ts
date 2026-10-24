import { useSyncExternalStore } from 'react';

/**
 * Light «Фарфоровое Чаепитие» or dark «Полуночное Святилище».
 * public/theme-boot.js picks the hour before the first paint (stored choice, else the system's);
 * this module keeps <html data-theme> in sync afterwards. Only a manual choice is stored.
 */
export type Theme = 'light' | 'dark';

const key = 'donarium-theme';
const root = document.documentElement;
const system = window.matchMedia('(prefers-color-scheme: light)');
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
const listeners = new Set<() => void>();
let shifting = 0;

function stored(): Theme | null {
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : null; } catch { return null; }
}
const preferred = (): Theme => stored() ?? (system.matches ? 'light' : 'dark');
const current = (): Theme => root.dataset.theme === 'light' ? 'light' : 'dark';

function apply(theme: Theme) {
  root.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  // The browser's own chrome takes the canvas colour of the hour, read from the tokens in styles.css.
  const canvas = getComputedStyle(root).getPropertyValue('--canvas').trim();
  if (canvas) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas);
  listeners.forEach(listener => listener());
}

/** Chosen by hand: remembered, and from now on preferred over the system setting. */
export function setTheme(theme: Theme) {
  try { localStorage.setItem(key, theme); } catch { /* Storage unavailable: the choice lasts for this page. */ }
  if (theme === current()) return;
  root.classList.add('theme-shift');
  shifting++;
  const settle = () => { if (--shifting === 0) root.classList.remove('theme-shift'); };
  if (!document.startViewTransition || calm.matches || document.hidden) {
    apply(theme);
    requestAnimationFrame(() => requestAnimationFrame(settle));
    return;
  }
  document.startViewTransition(() => apply(theme)).finished.finally(settle);
}

export function useTheme(): Theme {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, current);
}

// Without the boot script (blocked or cached away) the app still opens in the right hour.
if (root.dataset.theme !== 'light' && root.dataset.theme !== 'dark') apply(preferred());
// Until the owner chooses, the sanctuary follows the system; another tab's choice applies here too.
system.addEventListener('change', () => { if (!stored()) apply(preferred()); });
window.addEventListener('storage', event => { if (event.key === key || event.key === null) apply(preferred()); });
