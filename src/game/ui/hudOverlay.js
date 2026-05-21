// In-game HUD: turn banner, hero stats, end-turn button (with movement-left
// warning), and a status line.
//
// Pure DOM — the renderer paints the canvas underneath. Reuses the existing
// #game-ui markup from index.html and replaces its placeholder children.

import { forEachEntityWith, getComponent, getWorldState } from '../ecs/world.js';

export function installHudOverlay(rootElement, callbacks) {
  rootElement.innerHTML = '';

  const turnBanner = document.createElement('div');
  turnBanner.id = 'turn-banner';
  rootElement.appendChild(turnBanner);

  const heroPanel = document.createElement('div');
  heroPanel.id = 'hero-panel';
  rootElement.appendChild(heroPanel);

  const actionBar = document.createElement('div');
  actionBar.id = 'action-bar';
  const endTurnButton = document.createElement('button');
  endTurnButton.id = 'btn-end-turn';
  endTurnButton.className = 'primary';
  endTurnButton.textContent = 'End turn';
  endTurnButton.addEventListener('click', () => callbacks.onEndTurnClicked?.());
  const leaveButton = document.createElement('button');
  leaveButton.id = 'btn-leave';
  leaveButton.textContent = 'Leave';
  leaveButton.addEventListener('click', () => callbacks.onLeaveClicked?.());
  actionBar.appendChild(endTurnButton);
  actionBar.appendChild(leaveButton);
  rootElement.appendChild(actionBar);

  const statusLine = document.createElement('div');
  statusLine.id = 'status-line';
  rootElement.appendChild(statusLine);

  function render(world, viewerPlayerId, players) {
    const stateEntityId = getWorldState(world);
    const worldState = getComponent(world, stateEntityId, 'WorldState');
    if (!worldState) return;

    const currentPlayer = players[worldState.currentPlayerIndex];
    const isMyTurn = currentPlayer && currentPlayer.playerId === viewerPlayerId;

    turnBanner.textContent = (isMyTurn ? 'YOUR TURN' : (currentPlayer?.name ?? '???') + "'s turn")
      + ' · Day ' + worldState.turnNumber;
    turnBanner.classList.toggle('my-turn', !!isMyTurn);

    // Hero panel for the viewer.
    heroPanel.innerHTML = '';
    const heroEntries = [];
    forEachEntityWith(world, ['Hero', 'Position', 'Movement', 'Ownership'],
      (entityId, hero, position, movement, ownership) => {
        if (ownership.playerId !== viewerPlayerId) return;
        heroEntries.push({ entityId, hero, position, movement });
      });
    if (heroEntries.length === 0) {
      heroPanel.innerHTML = '<div class="hero-row muted">No heroes yet</div>';
    } else {
      for (const entry of heroEntries) {
        const row = document.createElement('div');
        row.className = 'hero-row';
        row.dataset.heroEntityId = entry.entityId;
        if (entry.entityId === callbacks.getSelectedHeroEntityId?.()) row.classList.add('selected');
        row.innerHTML = `
          <strong>${escapeHtml(entry.hero.name)}</strong>
          <span class="movement">${entry.movement.movementLeft}/${entry.movement.movementMax} mp</span>
          <span class="pos">(${entry.position.q}, ${entry.position.r})</span>
        `;
        row.addEventListener('click', () => callbacks.onHeroClicked?.(entry.entityId));
        heroPanel.appendChild(row);
      }
    }

    endTurnButton.disabled = !isMyTurn;
    endTurnButton.textContent = isMyTurn ? 'End turn' : 'Waiting…';
  }

  function setStatus(text) { statusLine.textContent = text ?? ''; }

  return { render, setStatus };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
