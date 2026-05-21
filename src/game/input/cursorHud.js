// Floating tooltip that follows the cursor and shows how long it would take
// the selected hero to reach the hex under the pointer — "X day(s)" if the
// destination is more than this turn's movement budget.

export function installCursorHud(container) {
  const el = document.createElement('div');
  el.id = 'cursor-hud';
  el.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 1500;
    background: rgba(8, 10, 18, 0.85);
    border: 1px solid #2a3346;
    border-radius: 6px;
    color: #e6ebf4;
    padding: 4px 10px;
    font: 12px/1.3 'Inter', system-ui, sans-serif;
    box-shadow: 0 4px 14px rgba(0,0,0,0.45);
    transform: translate(-50%, -130%);
    white-space: nowrap;
    display: none;
  `;
  container.appendChild(el);

  function show(x, y, html) {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.innerHTML = html;
    el.style.display = 'block';
  }
  function hide() { el.style.display = 'none'; }
  return { show, hide };
}
