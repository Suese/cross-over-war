// Wires the ECS world, three.js renderer, input handling, and HUD overlay
// into a running game session.
//
// Host vs client:
//   • Host owns a GameRoom that drives the authoritative world and
//     broadcasts snapshots. Client input is applied via gameRoom.handleAction.
//   • Client owns a passive world that ingests snapshots; tile data is NOT
//     in the snapshot — the client regenerates tiles from the seed embedded
//     in WorldState the first time it sees a snapshot. Client input is sent
//     to the host via the provided sendAction callback.

import { createWorld, getComponent, forEachEntityWith } from './ecs/world.js';
import { createRegistry, getTerrain } from './ecs/registry.js';
import { loadAllModules } from './modules/moduleLoader.js';
import { createAssetLoader } from './modules/assetLoader.js';
import { logMissingAssetsToConsole, formatMissingAssetsMarkdown } from './modules/assetAudit.js';
import { GameRoom } from './gameRoom.js';
import { createSceneRenderer } from './render/sceneRenderer.js';
import { createTerrainInstanceManager } from './render/terrainInstances.js';
import { installPointerInput } from './input/pointerInput.js';
import { installCursorHud } from './input/cursorHud.js';
import { installHudOverlay } from './ui/hudOverlay.js';
import { findPath, estimateTurnsForPath, invalidateTileIndex } from './map/pathfinding.js';
import { generateMap } from './map/mapgen.js';

export function startGameSession({
  mode,                       // 'host' | 'client'
  canvas,
  hudRoot,
  myPlayerId,
  players,                    // initial player list (host only)
  net,                        // { broadcast(msg), sendAction(action) }
  onLeave,
}) {
  const assets = createAssetLoader();

  let gameRoom = null;
  let clientWorld = null;
  let clientRegistry = null;
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

  const renderer = createSceneRenderer(canvas);
  const terrainManager = createTerrainInstanceManager({
    scene: renderer.scene,
    registry: viewerRegistry(),
    assets,
    hexSize: renderer.HEX_SIZE,
  });

  if (mode === 'host') {
    terrainManager.buildFromWorld(viewerWorld());
  }

  // ── HUD ─────────────────────────────────────────────────────────────────
  let selectedHeroEntityId = null;
  const hud = installHudOverlay(hudRoot, {
    onEndTurnClicked: () => attemptEndTurn(),
    onLeaveClicked: () => onLeave?.(),
    onHeroClicked: (entityId) => {
      selectedHeroEntityId = entityId;
      const position = getComponent(viewerWorld(), entityId, 'Position');
      if (position) renderer.centerOnHex(position.q, position.r);
      rerender();
    },
    getSelectedHeroEntityId: () => selectedHeroEntityId,
  });
  const cursorHud = installCursorHud(document.body);

  // ── Input ───────────────────────────────────────────────────────────────
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
      sendAction({ name: 'plan_path', heroEntityId: heroId, goalQ: hex.q, goalR: hex.r });
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

  // ── Render passes ───────────────────────────────────────────────────────
  function rerender() {
    const world = viewerWorld();
    if (!world) return;
    terrainManager.updateFogForViewer(world, myPlayerId);
    renderer.syncObjects(world, myPlayerId, viewerRegistry(), assets);

    const heroId = ensureSelectedHero();
    if (heroId) {
      const position = getComponent(world, heroId, 'Position');
      const movement = getComponent(world, heroId, 'Movement');
      const plan = movement?.plannedPath;
      if (plan && plan.steps?.length) {
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

  function centerOnFirstHero() {
    const world = viewerWorld();
    if (!world) return;
    forEachEntityWith(world, ['Hero', 'Position', 'Ownership'], (entityId, hero, position, ownership) => {
      if (ownership.playerId !== myPlayerId) return;
      if (selectedHeroEntityId == null) selectedHeroEntityId = entityId;
      renderer.centerOnHex(position.q, position.r);
    });
  }
  if (mode === 'host') {
    centerOnFirstHero();
    rerender();
  }

  logMissingAssetsToConsole(assets, viewerRegistry());

  // ── Snapshot ingestion (client) ─────────────────────────────────────────
  function ensureClientTilesGenerated(snapshot) {
    if (!clientWorld) return;
    if (clientWorld.componentStores.get('Tile')?.size > 0) return;
    // Pull the seed straight out of the incoming snapshot rather than the
    // already-applied world state, because applySnapshot hasn't run yet.
    const worldStateEntries = snapshot.components?.WorldState ?? {};
    const firstEntry = Object.values(worldStateEntries)[0];
    if (!firstEntry) return;
    const seed = firstEntry.seed ?? 1337;
    const width = firstEntry.mapWidth ?? 256;
    const height = firstEntry.mapHeight ?? 256;
    console.log('[client] generating ' + width + '×' + height + ' map from seed ' + seed);
    const before = performance.now();
    generateMap(clientWorld, clientRegistry, { width, height, seed, tilePrefabId: 'base/tile' });
    invalidateTileIndex(clientWorld);
    console.log('[client] map generated in ' + Math.round(performance.now() - before) + 'ms');
  }

  function ingestSnapshot(snapshot) {
    if (mode === 'host') return;
    const firstSnapshot = !(clientWorld.componentStores.get('Tile')?.size > 0);
    ensureClientTilesGenerated(snapshot);
    GameRoom.applySnapshot(clientWorld, clientRegistry, snapshot);
    lastKnownPlayers = snapshot.players ?? lastKnownPlayers;
    if (selectedHeroEntityId != null && !clientWorld.entities.has(selectedHeroEntityId)) {
      selectedHeroEntityId = null;
    }
    if (firstSnapshot) {
      terrainManager.buildFromWorld(clientWorld);
      centerOnFirstHero();
    }
    rerender();
  }

  if (mode === 'host') {
    // After the constructor finished, hook the broadcast so post-startup
    // snapshots also trigger a host-side rerender.
    const originalBroadcast = net.broadcast;
    net.broadcast = (message) => {
      if (message?.type === 'snapshot') rerender();
      originalBroadcast?.(message);
    };
  }

  function sendAction(action) {
    if (mode === 'host') { gameRoom.handleAction(myPlayerId, action); return; }
    net.sendAction?.(action);
  }

  function attemptEndTurn() {
    const world = viewerWorld();
    if (!world) return;
    let stillHasMovement = false;
    forEachEntityWith(world, ['Movement', 'Ownership'], (entityId, movement, ownership) => {
      if (ownership.playerId !== myPlayerId) return;
      if (movement.movementLeft > 0) stillHasMovement = true;
    });
    if (stillHasMovement) {
      const ok = hud.confirmEndTurn('You still have movement points remaining. End the day anyway?');
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

function rebuildPathCosts(world, registry, startPosition, rawSteps) {
  const tileStore = world.componentStores.get('Tile');
  // Index built lazily — pathfinding may have already cached one on the world.
  let index = world._tileIndex;
  if (!index || world._tileIndexRegistryRef !== registry) {
    index = new Map();
    if (tileStore) {
      for (const tile of tileStore.values()) {
        const terrain = getTerrain(registry, tile.terrainId);
        if (!terrain) continue;
        index.set(tile.q + ',' + tile.r, { tile, terrain });
      }
    }
    world._tileIndex = index;
    world._tileIndexRegistryRef = registry;
  }

  let running = 0;
  const out = [];
  for (const step of rawSteps) {
    const lookup = index.get(step.q + ',' + step.r);
    running += lookup?.terrain?.movementCost ?? 1;
    out.push({ q: step.q, r: step.r, cumulativeCost: running });
  }
  return out;
}

function declarationListFor(registry, assets) {
  return registry.assetReferences.map(ref => ({
    moduleName: ref.moduleName,
    kind: ref.kind,
    assetKey: ref.assetKey,
    declaredFor: ref.declaredFor,
    exists: assets.hasAsset(ref.assetKey),
  }));
}
