// Right-click-hold info panel — HoMM3-style. The user holds the right mouse
// button on something (terrain, hero, …) and a small panel pops up near the
// cursor describing it. Releasing the button hides it.
//
// This file owns nothing about *what* to show — it's a dumb show/hide widget.
// The bootstrap wires the pointer-input hooks to a content builder.

export function installInfoOverlay(host) {
  const el = document.createElement('div');
  el.id = 'info-overlay';
  el.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 1600;
    background: rgba(8, 10, 18, 0.93);
    border: 1px solid #3a4660;
    border-radius: 8px;
    color: #e6ebf4;
    padding: 10px 14px;
    font: 12px/1.45 'Inter', system-ui, sans-serif;
    box-shadow: 0 8px 22px rgba(0,0,0,0.55);
    min-width: 180px;
    max-width: 260px;
    transform: translate(12px, 12px);
    display: none;
  `;
  host.appendChild(el);

  function show(screenX, screenY, html) {
    el.innerHTML = html;
    el.style.display = 'block';
    positionWithinViewport(screenX, screenY);
  }

  function move(screenX, screenY) {
    if (el.style.display === 'none') return;
    positionWithinViewport(screenX, screenY);
  }

  function hide() {
    el.style.display = 'none';
  }

  // Keep the panel on-screen even when the cursor sits near the right or
  // bottom edge by flipping the offset direction once it would overflow.
  function positionWithinViewport(screenX, screenY) {
    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const offsetX = (screenX + 12 + rect.width > viewportWidth) ? -rect.width - 12 : 12;
    const offsetY = (screenY + 12 + rect.height > viewportHeight) ? -rect.height - 12 : 12;
    el.style.left = (screenX + offsetX) + 'px';
    el.style.top = (screenY + offsetY) + 'px';
    el.style.transform = 'none';
  }

  return { show, move, hide };
}
