/** Decorative only: a faint light follows the pointer across archive cards (see styles.css). */
const surfaces = '.metric-card, .product-card, .tea-card';

export function followPointer() {
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  let target: HTMLElement | null = null;
  let x = 0;
  let y = 0;
  let frame = 0;
  const paint = () => {
    frame = 0;
    if (!target) return;
    const box = target.getBoundingClientRect();
    target.style.setProperty('--spot-x', `${x - box.left}px`);
    target.style.setProperty('--spot-y', `${y - box.top}px`);
  };
  document.addEventListener('pointermove', event => {
    if (!fine.matches || calm.matches || !(event.target instanceof Element)) return;
    target = event.target.closest<HTMLElement>(surfaces);
    x = event.clientX; y = event.clientY;
    if (target && !frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
}
