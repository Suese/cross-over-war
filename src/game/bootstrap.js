// Wires the ECS world, three.js renderer, input handling, and HUD overlay
// into a running game session. Called by main.js after the host clicks
// "Start game" or the client receives its first snapshot.
//
// Host vs client:
//   • Host owns a GameRoom that drives the authoritative world and
//     broadcasts snapshots. Client input goes through GameRoom.handleAction.
//   • Client owns a passive world that ingests snapshots; client input is
//     sent to the host via the provided sendAction callback.

import { createWorld, getComponent, getWorldState, forEachEntityWith, collectEntitiesWith } from './ecs/world.js';
import { createRegistry, getTerrain } from './ecs/registry.js';
import { loadAllModules } from './modules/moduleLoader.js';
import { createAssetLoader } from './modules/assetLoader.js';
import { logMissingAssetsToConsole, formatMissingAssetsMarkdown } from './modules/assetAudit.js';
import { GameRoom } from './gameRoom.js';
import { createSceneRenderer } from './render/sceneRenderer.js';
import { installPointerInput } from './input/pointerInput.js';
import { installCursorHud } from './input/cursorHud.js';
import { installHudOverlay } from './ui/hudOverlay.js';
import { findPath, estimateTurnsForPath } from './map/pathfinding.js';
import { hexKey } from './map/hex.js';

export function startGameSession({
  mode,                       // 'host' | 'client'
  canvas,
  hudRoot,                    // #game-ui container
  myPlayerId,
  players,                    // initial player list (host only)
  net,                        // { broadcast(msg), sendAction(action) } — see below
  onLeave,
}) {
  const assets = createAssetLoader();

  let gameRoom = null;          // host only
  let clientWorld = null;       // client only
  let clientRegistry = null;    // client only
  let lastKnownPlayers = players ?? [];

  if (mode === 'host') {
    gameRoom = new GameRoom({
      assets,
      broadcast: (message) => net.broadcast?.(message),
      log: (...args) => console.log('[gameRoom]', ...args),
    });
    for (const player of lastKnownPlayers) gameRoom.addPlayer(player.playerId ?? player.id, player.name);
    gameRoom.startGame();
  } else {
    clientWorld = createWorld();
    clientRegistry = createRegistry();
    loadAllModules({ world: clientWorld, registry: clientRegistry, assets });
  }

  const renderer = createSceneRenderer(canvas, viewerRegistry(), assets);

  // ── HUD ────────────────────────────────────────────────────────────────
  let selectedHeroEntityId = null;
  const hud = installHudOverlay(hudRoot, {
    onEndTurnClicked: () => attemptEndTurn(),
    onLeaveClicked: () => onLeave?.(),
    onHeroClicked: (entityId) => { selectedHeroEntityId = entityId; rerender(); },
    getSelectedHeroEntityId: () => selectedHeroEntityId,
  });

  const cursorHud = installCursorHud(document.body);

  // ── Input ──────────────────────────────────────────────────────────────
  installPointerInput(renderer, {
    onHoverHex: (hex, event) => {
      const heroId = ensureSelectedHero();
      if (!heroId) { cursorHud.hide(); return; }
      const position = getComponent(viewerWorld(), heroId, 'Position');
      const movement = getComponent(viewerWorld(), heroId, 'Movement');
      if (!position || !movement) { cursorHud.hide(); return; }
      const path = findPath(viewerWorld(), viewerRegistry(), position, hex);
      if (!path || path.steps.length === 0) {
        cursorHud.show(event.clientX, event.clientY, '·');
        return;
      }
      const totalCost = path.steps[path.steps.length - 1].cumulativeCost;
      const days = estimateTurnsForPath(path, movement.movementMax);
      const dayWord = days === 1 ? 'day' : 'days';
      const reachable = totalCost <= movement.movementLeft;
      const colour = reachable ? '#7fffa8' : '#ff8484';
      cursorHud.show(
        event.clientX,
        event.clientY,
        '<span style="color:' + colour + '">' + days + ' ' + dayWord + '</span>'
          + ' <span style="opacity:0.7">·</span> '
          + totalCost + ' mp',
      );
    },
    onPlanPath: (hex) => {
      const heroId = ensureSelectedHero();
      if (!heroId) return;
      sendAction({
        name: 'plan_path',
        heroEntityId: heroId,
        goalQ: hex.q,
        goalR: hex.r,
      });
    },
    onConfirmMove: () => {
      const heroId = ensureSelectedHero();
      if (!heroId) return;
      sendAction({ name: 'move_along_path', heroEntityId: heroId });
    },
    onClearPath: () => {
      const heroId = ensureSelectedHero();
      if (!heroId) return;
      sendAction({ name: 'clear_path', heroEntityId: heroId });
    },
  });

  // ── Render loop ────────────────────────────────────────────────────────
  function rerender() {
    const world = viewerWorld();
    if (!world) return;
    renderer.syncTiles(world, myPlayerId);
    renderer.syncObjects(world, myPlayerId);

    // Path overlay for the selected hero.
    const heroId = ensureSelectedHero();
    if (heroId) {
      const position = getComponent(world, heroId, 'Position');
      const movement = getComponent(world, heroId, 'Movement');
      const plan = movement?.plannedPath;
      if (plan && plan.steps?.length) {
        // Recompute cumulative costs so red/green split is accurate.
        const enriched = rebuildPathCosts(world, viewerRegistry(), position, plan.steps);
        renderer.showPath({
          startQ: position.q,
          startR: position.r,
          path: { steps: enriched },
          movementLeft: movement.movementLeft,
          movementPerTurn: movement.movementMax,
        });
      } else {
        renderer.clearPath();
      }
    } else {
      renderer.clearPath();
    }

    hud.render(world, myPlayerId, lastKnownPlayers);
  }

  function loop() {
    renderer.render();
    requestAnimationFrame(loop);
  }
  loop();
  rerender();

  // Center the camera on this player's first hero once available.
  function centerOnFirstHero() {
    const world = viewerWorld();
    if (!world) return;
    forEachEntityWith(world, ['Hero', 'Position', 'Ownership'], (entityId, hero, position, ownership) => {
      if (ownership.playerId !== myPlayerId) return;
      if (selectedHeroEntityId == null) selectedHeroEntityId = entityId;
      renderer.centerOnHex(position.q, position.r);
    });
  }
  centerOnFirstHero();
  rerender();

  // Log any unresolved assets so the user sees the gap in the console.
  logMissingAssetsToConsole(assets, viewerRegistry());

  // ── External integration: snapshot ingestion + action sending ─────────
  function ingestSnapshot(snapshot) {
    if (mode === 'host') return; // host owns the source of truth
    GameRoom.applySnapshot(clientWorld, clientRegistry, snapshot);
    lastKnownPlayers = snapshot.players ?? lastKnownPlayers;
    if (selectedHeroEntityId != null && !clientWorld.entities.has(selectedHeroEntityId)) {
      selectedHeroEntityId = null;
    }
    if (selectedHeroEntityId == null) centerOnFirstHero();
    rerender();
  }

  function ingestHostSnapshotNotification(snapshot) {
    // Host's own GameRoom calls broadcast(); the host doesn't ingest its
    // own snapshot, it rerenders directly off the live world.
    rerender();
  }

  if (mode === 'host') {
    // Re-render whenever the game room publishes (broadcast happens in
    // parallel for clients).
    const originalBroadcast = net.broadcast;
    net.broadcast = (message) => {
      if (message?.type === 'snapshot') ingestHostSnapshotNotification(message.snapshot);
      originalBroadcast?.(message);
    };
  }

  function sendAction(action) {
    if (mode === 'host') {
      gameRoom.handleAction(myPlayerId, action);
      return;
    }
    net.sendAction?.(action);
  }

  function attemptEndTurn() {
    const world = viewerWorld();
    if (!world) return;
    // Warn if the viewer still has heroes with movement points left.
    let stillHasMovement = false;
    forEachEntityWith(world, ['Movement', 'Ownership'], (entityId, movement, ownership) => {
      if (ownership.playerId !== myPlayerId) return;
      if (movement.movementLeft > 0) stillHasMovement = true;
    });
    if (stillHasMovement) {
      const ok = hud.confirmEndTurn(
        'You still have movement points remaining. End the day anyway?',
      );
      if (!ok) return;
    }
    sendAction({ name: 'end_turn' });
  }

  function ensureSelectedHero() {
    if (selectedHeroEntityId != null && viewerWorld().entities.has(selectedHeroEntityId)) {
      return selectedHeroEntityId;
    }
    selectedHeroEntityId = null;
    forEachEntityWith(viewerWorld(), ['Hero', 'Position', 'Ownership'], (entityId, hero, position, ownership) => {
      if (ownership.playerId !== myPlayerId) return;
      if (selectedHeroEntityId == null) selectedHeroEntityId = entityId;
    });
    return selectedHeroEntityId;
  }

  function viewerWorld() {
    return mode === 'host' ? gameRoom.world : clientWorld;
  }
  function viewerRegistry() {
    return mode === 'host' ? gameRoom.registry : clientRegistry;
  }

  // Lets the host's net layer forward client actions into the GameRoom.
  function handleClientAction(fromPlayerId, action) {
    if (mode !== 'host' || !gameRoom) return;
    gameRoom.handleAction(fromPlayerId, action);
  }

  return {
    ingestSnapshot,
    handleClientAction,
    rerender,
    getMissingAssetsMarkdown: () =>
      formatMissingAssetsMarkdown(assets.getMissingAssets(), declarationListFor(viewerRegistry(), assets)),
  };
}

// Rebuild a step list's cumulativeCost field from terrain. We do this on the
// viewer side because the snapshot only carries the steps — costs are easy
// enough to recompute and saves wire bytes.
function rebuildPathCosts(world, registry, startPosition, rawSteps) {
  let running = 0;
  const out = [];
  for (const step of rawSteps) {
    let terrainId = null;
    forEachEntityWith(world, ['Tile'], (entityId, tile) => {
      if (tile.q === step.q && tile.r === step.r) terrainId = tile.terrainId;
    });
    const terrain = terrainId ? getTerrain(registry, terrainId) : null;
    running += terrain?.movementCost ?? 1;
    out.push({ q: step.q, r: step.r, cumulativeCost: running });
  }
  return out;
}

// Build a list of declared asset references, marked exists / missing, for
// the audit step. The asset loader knows which keys it actually has.
function declarationListFor(registry, assets) {
  return registry.assetReferences.map(ref => ({
    moduleName: ref.moduleName,
    kind: ref.kind,
    assetKey: ref.assetKey,
    declaredFor: ref.declaredFor,
    exists: assets.hasAsset(ref.assetKey),
  }));
}
