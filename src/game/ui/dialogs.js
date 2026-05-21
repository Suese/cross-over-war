// Promise-based modal dialogs.
//
//   await showOkay('You find nothing.');
//   const yes = await showYesNo('End the day anyway?', { yesLabel: 'End turn' });
//
// Each dialog renders into a shared stacking container under document.body.
// A dimmed full-screen backdrop blocks pointer events behind it; Enter chooses
// the primary action, Escape chooses the secondary (or dismisses an Okay).
// Multiple dialogs can stack — the most recently opened receives keyboard
// focus and intercepts Enter/Escape until it resolves.

const STACK_CONTAINER_ID = 'dialog-stack';
const openDialogStack = [];

function ensureStackContainer() {
  let stack = document.getElementById(STACK_CONTAINER_ID);
  if (stack) return stack;
  stack = document.createElement('div');
  stack.id = STACK_CONTAINER_ID;
  stack.style.cssText = `
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2000;
  `;
  document.body.appendChild(stack);
  document.addEventListener('keydown', handleGlobalKey, true);
  return stack;
}

function handleGlobalKey(event) {
  if (openDialogStack.length === 0) return;
  const top = openDialogStack[openDialogStack.length - 1];
  if (event.key === 'Enter') { event.preventDefault(); top.onPrimary(); }
  else if (event.key === 'Escape') { event.preventDefault(); top.onSecondary(); }
}

function buildBackdrop() {
  const node = document.createElement('div');
  node.className = 'dialog-backdrop';
  node.style.cssText = `
    position: absolute;
    inset: 0;
    pointer-events: auto;
    background: rgba(4, 7, 14, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  return node;
}

function buildPanel(title, message) {
  const panel = document.createElement('div');
  panel.className = 'dialog-panel';
  panel.style.cssText = `
    background: rgba(14, 18, 28, 0.97);
    border: 1px solid #3a4660;
    border-radius: 10px;
    color: #e6ebf4;
    padding: 22px 24px 20px;
    min-width: 280px;
    max-width: 420px;
    font: 14px/1.45 'Inter', system-ui, sans-serif;
    box-shadow: 0 18px 50px rgba(0,0,0,0.55);
  `;
  if (title) {
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:600; font-size:15px; margin-bottom:8px; color:#a8e6ff;';
    titleEl.textContent = title;
    panel.appendChild(titleEl);
  }
  const messageEl = document.createElement('div');
  messageEl.style.cssText = 'margin-bottom:18px; white-space:pre-wrap;';
  messageEl.textContent = message;
  panel.appendChild(messageEl);
  return panel;
}

function buildButtonRow() {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';
  return row;
}

function makeButton(label, primary, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  if (primary) btn.className = 'primary';
  btn.addEventListener('click', onClick);
  return btn;
}

function openDialog({ backdrop, onPrimary, onSecondary, focusEl }) {
  const stack = ensureStackContainer();
  stack.appendChild(backdrop);
  const entry = { backdrop, onPrimary, onSecondary };
  openDialogStack.push(entry);
  focusEl?.focus();
  return () => {
    const index = openDialogStack.indexOf(entry);
    if (index >= 0) openDialogStack.splice(index, 1);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  };
}

export function showOkay(message, options = {}) {
  return new Promise((resolve) => {
    const backdrop = buildBackdrop();
    const panel = buildPanel(options.title, message);
    const row = buildButtonRow();
    let close = null;
    const okay = makeButton(options.okLabel ?? 'OK', true, () => { close(); resolve(); });
    row.appendChild(okay);
    panel.appendChild(row);
    backdrop.appendChild(panel);
    close = openDialog({
      backdrop,
      onPrimary: () => { close(); resolve(); },
      onSecondary: () => { close(); resolve(); },
      focusEl: okay,
    });
  });
}

export function showYesNo(message, options = {}) {
  return new Promise((resolve) => {
    const backdrop = buildBackdrop();
    const panel = buildPanel(options.title, message);
    const row = buildButtonRow();
    let close = null;
    const no = makeButton(options.noLabel ?? 'No', false, () => { close(); resolve(false); });
    const yes = makeButton(options.yesLabel ?? 'Yes', true, () => { close(); resolve(true); });
    row.appendChild(no);
    row.appendChild(yes);
    panel.appendChild(row);
    backdrop.appendChild(panel);
    close = openDialog({
      backdrop,
      onPrimary: () => { close(); resolve(true); },
      onSecondary: () => { close(); resolve(false); },
      focusEl: yes,
    });
  });
}
