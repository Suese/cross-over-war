// Floating tooltip that follows the cursor and shows how long it would take
// the selected hero to reach the hex under the pointer — "X day(s)" if the
// destination is more than this turn's movement budget.
//
// `show(x, y, parts)` accepts either a single HTML string (legacy) or an
// array of HTML fragments. When an array is passed, each fragment renders on
// its own row; the HUD is capped at MAX_LINES rows and appends an ellipsis to
// the last visible row if input had more parts. Each row truncates
// horizontally to keep the HUD from sprawling sideways.

const MAX_LINES = 3;

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
    max-width: 220px;
    display: none;
  `;
  container.appendChild(el);

  function show(x, y, parts) {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    const items = Array.isArray(parts) ? parts.filter(Boolean) : [parts];
    const shown = items.slice(0, MAX_LINES);
    const truncated = items.length > MAX_LINES;
    el.innerHTML = shown.map((html, idx) => {
      const isLast = idx === shown.length - 1;
      const overflow = (isLast && truncated) ? ' …' : '';
      return '<div class="cursor-hud-line" style="'
        + 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'
        + '">' + html + overflow + '</div>';
    }).join('');
    el.style.display = 'block';
  }
  function hide() { el.style.display = 'none'; }
  return { show, hide };
}
