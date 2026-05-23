// Wires the ECS world, three.js renderer, input handling, and HUD overlay
// into a running game session.
//
// Host vs client:
//   • Host owns a GameRoom that broadcasts init_snapshot / delta / state_hash
//     / players_changed messages. Local input is applied via gameRoom.handleAction.
//   • Client maintains a passive ECS world. The host sends one full
//     init_snapshot, then deltas; the client applies them in sequence and
//     verifies state_hash messages. On a gap or mismatch the client sends
//     a `resync_request` action and the host responds with a fresh
//     init_snapshot.

import {
  createWorld, getComponent, hasComponent, forEachEntityWith,
  applyChangeOps, addComponent, setChangeRecording,
} from './ecs/world.js';
import { playerColorCss, defaultFlagConfigFor } from './render/playerColors.js';
import { paintFlagToCanvas } from './render/flagMesh.js';
import { createRegistry, getTerrain } from './ecs/registry.js';
import { loadAllModules } from './modules/moduleLoader.js';
import { createAssetLoader } from './modules/assetLoader.js';
import { logMissingAssetsToConsole, formatMissingAssetsMarkdown } from './modules/assetAudit.js';
import { GameRoom } from './gameRoom.js';
import { createSceneRenderer } from './render/sceneRenderer.js';
import { createTerrainInstanceManager } from './render/terrainInstances.js';
import { createHeroAnimations } from './render/heroAnimations.js';
import { installPointerInput } from './input/pointerInput.js';
import { installCursorHud } from './input/cursorHud.js';
import { installHudOverlay } from './ui/hudOverlay.js';
import { installInfoOverlay } from './ui/infoOverlay.js';
import { showOkay, showYesNo } from './ui/dialogs.js';
import { findPath, estimateTurnsForPath, invalidateTileIndex } from './map/pathfinding.js';
import { collectTraversalModes, resolveTerrainCost, listPassableModes } from './ecs/traversal.js';
import { inflateFog } from './map/fog.js';
import { hashWorld, MESSAGE_KINDS } from './protocol.js';

export function startGameSession({
  mode,                 // 'host' | 'client'
  canvas,
  hudRoot,
  myPlayerId,
  players,              // host: initial player list
  net,                  // { broadcast(msg), sendTo(peerId, msg), sendAction(action) }
  loadFromSnapshot,     // host-only: an optional persistence-loaded snapshot to resume
  mapSize,              // host-only fresh-game: { width, height }; ignored when loading a save
  biomeSettings,        // host-only fresh-game: { minCastles, maxCastles, minAdditionalBiomes, maxAdditionalBiomes }
  terrainThresholds,    // host-only fresh-game: { seaThreshold, mountainThreshold } in [0, 1]
  onLeave,
}) {
  const assets = createAssetLoader();

  let gameRoom = null;
  let clientWorld = null;
  let clientRegistry = null;
  let lastKnownPlayers = players ?? [];

  // Client-side replication bookkeeping.
  let expectedSeq = 1;            // next delta seq the client expects to apply
  let pendingResync = false;      // true while a resync request is in flight
  let haveInitSnapshot = false;

  if (mode === 'host') {
    gameRoom = new GameRoom({
      assets,
      mapSize,
      biomeSettings,
      terrainThresholds,
      broadcast: (message) => net.broadcast?.(message),
      sendTo: (peerId, message) => net.sendTo?.(peerId, message),
      log: (...args) => console.log('[gameRoom]', ...args),
    });
    if (loadFromSnapshot) {
      // Saved game flow:
      //   1. Restore the snapshot — gameRoom.players gets replaced with the
      //      saved roster (all marked disconnected).
      //   2. Re-add each currently-connected lobby player; addPlayer matches
      //      by name and rebinds the old playerId onto the new peer id,
      //      remapping Ownership / fog / playerOrder along the way.
      gameRoom.loadFromSave(loadFromSnapshot);
      for (const player of lastKnownPlayers) {
        gameRoom.addPlayer(
          player.playerId ?? player.id,
          player.name,
          player.profile ?? null,
          { kingdomId: player.kingdomId ?? null, isComputer: !!player.isComputer },
        );
      }
    } else {
      for (const player of lastKnownPlayers) {
        gameRoom.addPlayer(
          player.playerId ?? player.id,
          player.name,
          player.profile ?? null,
          { kingdomId: player.kingdomId ?? null, isComputer: !!player.isComputer },
        );
      }
      gameRoom.startNewGame();
    }
  } else {
    clientWorld = createWorld();
    clientRegistry = createRegistry();
    loadAllModules({ world: clientWorld, registry: clientRegistry, assets });
  }

  // Assets stream in on demand — `terrainManager.buildFromWorld` lays down
  // placeholder cylinders for each terrain, requests the matching .glb, and
  // swaps the placeholders for real models as they arrive. Heroes and map
  // objects load their assets the moment the local viewer first discovers
  // them. No preload pass is needed.

  const renderer = createSceneRenderer(canvas);
  const terrainManager = createTerrainInstanceManager({
    scene: renderer.scene,
    registry: viewerRegistry(),
    assets,
    hexSize: renderer.HEX_SIZE,
  });
  const heroAnimations = createHeroAnimations(renderer.HEX_SIZE);

  if (mode === 'host') terrainManager.buildFromWorld(viewerWorld());

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
  const infoOverlay = installInfoOverlay(document.body);

  installPointerInput(renderer, {
    onHoverHex: (hex, event) => {
      const heroId = ensureSelectedHero();
      if (!heroId) { cursorHud.hide(); setCanvasCursor(''); return; }
      const position = getComponent(viewerWorld(), heroId, 'Position');
      const movement = getComponent(viewerWorld(), heroId, 'Movement');
      if (!position || !movement) { cursorHud.hide(); setCanvasCursor(''); return; }
      const exploredKeys = currentViewerExploredSet();
      // Quick gate: if the hex itself is unexplored, treat it as un-pathable
      // without paying for a failed A* search. Don't leak POI presence on
      // unexplored hexes either — the cursor stays default.
      if (exploredKeys && !exploredKeys.has(hex.q + ',' + hex.r)) {
        cursorHud.show(event.clientX, event.clientY,
          ['<span style="color:#ff8484">unknown</span>']);
        setCanvasCursor('');
        return;
      }
      const blockedKeys = collectBlockedKeysExcluding(viewerWorld(), heroId);
      const traversalModes = collectTraversalModes(viewerWorld(), heroId);
      const path = findPath(viewerWorld(), viewerRegistry(), position, hex, {
        exploredKeys, blockedKeys, traversalModes,
      });
      if (!path || path.steps.length === 0) {
        cursorHud.show(event.clientX, event.clientY, ['·']);
        setCanvasCursor('');
        return;
      }
      const totalCost = path.steps[path.steps.length - 1].cumulativeCost;
      const days = estimateTurnsForPath(path, movement.movementMax);
      const dayWord = days === 1 ? 'day' : 'days';
      const reachable = totalCost <= movement.movementLeft;
      const colour = reachable ? '#7fffa8' : '#ff8484';
      // If the hex carries an Actionable, look up its registered action
      // type for the icon + label, then render the prompt and flip the
      // cursor to a pointer. The hover layer doesn't know — or care —
      // whether the underlying behaviour is a collectable, a POI, or some
      // future kind of interaction; the entity carries an id, the registry
      // owns the strings.
      const actionable = findActionableAt(viewerWorld(), hex.q, hex.r);
      const actionType = actionable
        ? viewerRegistry().actionTypes.get(actionable.actionTypeId)
        : null;
      const actionLine = actionType
        ? '<span style="color:#ffd964">'
          + escapeHtml(actionType.icon ?? '')
          + (actionType.icon && actionType.label ? ' ' : '')
          + escapeHtml(actionType.label ?? '')
          + '</span>'
        : null;
      // Conquest flag — shown for any Conquerable entity on the hex. The
      // owner's name comes through with the player's tint; unowned states
      // are still surfaced (grey flag + "Unclaimed") so the player can tell
      // a structure is takeable before walking up to it.
      const conquest = findConquerableInfoAt(viewerWorld(), hex.q, hex.r);
      const conquestLine = conquest
        ? '<span style="color:' + conquest.color + '">⚑</span> '
          + (conquest.ownerName
              ? 'Owned by ' + escapeHtml(conquest.ownerName)
              : '<span style="opacity:0.7">Unclaimed</span>')
        : null;
      setCanvasCursor(actionable ? 'pointer' : '');
      const travelLine = '<span style="color:' + colour + '">'
        + days + ' ' + dayWord
        + '</span> <span style="opacity:0.7">·</span> '
        + totalCost + ' mp';
      cursorHud.show(
        event.clientX,
        event.clientY,
        [travelLine, actionLine, conquestLine],
      );
    },
    onPlanPath: (hex) => {
      if (isLocalCommandLocked()) return;
      const heroId = ensureSelectedHero();
      if (!heroId) return;
      sendAction({ name: 'plan_path', heroEntityId: heroId, goalQ: hex.q, goalR: hex.r });
    },
    onConfirmMove: () => {
      if (isLocalCommandLocked()) return;
      const heroId = ensureSelectedHero();
      if (!heroId) return;
      sendAction({ name: 'move_along_path', heroEntityId: heroId });
    },
    onClearPath: () => {
      if (isLocalCommandLocked()) return;
      const heroId = ensureSelectedHero();
      if (!heroId) return;
      sendAction({ name: 'clear_path', heroEntityId: heroId });
    },
    onInfoRequest: (hex, event) => {
      cursorHud.hide();
      const html = buildInfoPanelHtml(hex);
      if (!html) { infoOverlay.hide(); return; }
      infoOverlay.show(event.clientX, event.clientY, html);
    },
    onInfoMove: (event) => infoOverlay.move(event.clientX, event.clientY),
    onInfoRelease: () => infoOverlay.hide(),
  });

  // Push the current player list's flag configs into the renderer. Each
  // player carries an optional `.profile.flag` (set by the lobby flag
  // editor / loaded from localStorage); when missing we fall back to a
  // deterministic palette-derived default keyed off the player's id. The
  // renderer compares object identity to detect changes, so we always feed
  // it freshly-built objects rather than mutating in place.
  function syncFlagConfigs() {
    renderer.clearFlagConfigs();
    for (const player of lastKnownPlayers ?? []) {
      const playerId = player.playerId ?? player.id;
      if (!playerId) continue;
      const flag = player.profile?.flag ?? defaultFlagConfigFor(playerId);
      renderer.setFlagConfigForPlayer(playerId, flag);
    }
  }
  syncFlagConfigs();

  // ── Render passes ───────────────────────────────────────────────────────
  // rerender() runs on every state change (snapshot / delta). It rebuilds
  // the path overlay + HUD and seeds the renderer with the latest fog. The
  // per-frame loop below keeps the hero meshes in sync while an animation is
  // playing back and re-uploads fog instance data only when the discrete
  // animation step changes.
  let lastFogTick = '';

  function rerender() {
    const world = viewerWorld();
    if (!world) return;
    const nowMs = performance.now();
    const fogOverride = heroAnimations.fogOverrideFor(myPlayerId, nowMs);
    terrainManager.updateFogForViewer(world, myPlayerId, fogOverride);
    lastFogTick = heroAnimations.currentFogTick(myPlayerId, nowMs) ?? '';
    renderer.syncObjects(world, myPlayerId, viewerRegistry(), assets, {
      heroAnimations, fogOverride, nowMs,
    });

    const heroId = ensureSelectedHero();
    if (heroId) {
      const position = getComponent(world, heroId, 'Position');
      const movement = getComponent(world, heroId, 'Movement');
      const plan = movement?.plannedPath;
      if (plan && plan.steps?.length) {
        const traversalModes = collectTraversalModes(world, heroId);
        const enriched = rebuildPathCosts(world, viewerRegistry(), position, plan.steps, traversalModes);
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
    if (heroAnimations.hasActiveAnimation()) {
      const world = viewerWorld();
      if (world) {
        const nowMs = performance.now();
        const fogOverride = heroAnimations.fogOverrideFor(myPlayerId, nowMs);
        // Hero mesh sync is cheap (a handful of entities).
        renderer.syncObjects(world, myPlayerId, viewerRegistry(), assets, {
          heroAnimations, fogOverride, nowMs,
        });
        // Fog re-upload is expensive — only run when the step boundary moves.
        const tick = heroAnimations.currentFogTick(myPlayerId, nowMs) ?? '';
        if (tick !== lastFogTick) {
          terrainManager.updateFogForViewer(world, myPlayerId, fogOverride);
          lastFogTick = tick;
        }
      }
    } else if (lastFogTick !== '') {
      // Animation just ended — fall back to the ECS fog state.
      const world = viewerWorld();
      if (world) terrainManager.updateFogForViewer(world, myPlayerId, null);
      lastFogTick = '';
    }
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

  // ── Message handling (client) ───────────────────────────────────────────
  function ingestInitSnapshot(snapshot) {
    if (mode === 'host') return;
    // The snapshot now carries the full tile set — biome decorators mutate
    // terrain in ways that aren't trivially deterministic across host and
    // client, so we just take the host's word for it.
    clientWorld.nextEntityId = Math.max(snapshot.nextEntityId, clientWorld.nextEntityId);
    clientWorld.entities = new Set(snapshot.entityIds);
    clientWorld.componentStores = new Map();
    setChangeRecording(clientWorld, false);
    for (const componentName in snapshot.components) {
      const map = new Map();
      for (const entityIdStr in snapshot.components[componentName]) {
        const entityId = Number(entityIdStr);
        let data = snapshot.components[componentName][entityIdStr];
        if (componentName === 'WorldState') {
          data = { ...data, fogByPlayer: inflateFog(data.fogByPlayer ?? {}) };
          clientWorld._worldStateEntity = entityId;
        }
        map.set(entityId, data);
      }
      clientWorld.componentStores.set(componentName, map);
    }
    invalidateTileIndex(clientWorld);

    expectedSeq = (snapshot.seq ?? 0) + 1;
    pendingResync = false;
    haveInitSnapshot = true;
    lastKnownPlayers = snapshot.players ?? lastKnownPlayers;
    syncFlagConfigs();
    if (selectedHeroEntityId != null && !clientWorld.entities.has(selectedHeroEntityId)) {
      selectedHeroEntityId = null;
    }
    terrainManager.buildFromWorld(clientWorld);
    centerOnFirstHero();
    rerender();
  }

  function ingestDelta(message) {
    if (mode === 'host') return;
    if (!haveInitSnapshot) { requestResync('delta before snapshot'); return; }
    if (message.seq !== expectedSeq) {
      requestResync('seq gap: expected ' + expectedSeq + ', got ' + message.seq);
      return;
    }
    applyChangeOps(clientWorld, message.ops ?? []);
    expectedSeq++;
    queueAnimationsFromEvents(message.events ?? []);
    rerender();
  }

  function ingestStateHash(message) {
    if (mode === 'host') return;
    if (!haveInitSnapshot) return;
    // A state_hash matches the seq of the delta that produced it. If we
    // applied that delta already, our hash should match the host's.
    if (message.seq !== expectedSeq - 1) {
      // We're either behind or ahead of the host's hash — request resync.
      requestResync('hash seq mismatch: expected ' + (expectedSeq - 1) + ', got ' + message.seq);
      return;
    }
    const localHash = hashWorld(clientWorld);
    if (localHash !== message.hash) {
      console.warn('[client] hash mismatch at seq ' + message.seq + '; local=' + localHash.toString(16) + ' host=' + message.hash.toString(16));
      requestResync('hash mismatch');
    }
  }

  function ingestPlayersChanged(message) {
    if (mode === 'host') return;
    lastKnownPlayers = message.players ?? lastKnownPlayers;
    syncFlagConfigs();
    rerender();
  }

  function requestResync(reason) {
    if (pendingResync) return;
    pendingResync = true;
    console.warn('[client] requesting resync:', reason);
    net.sendAction?.({ name: 'resync_request' });
  }

  // Top-level dispatch — called by main.js when a net message arrives.
  function ingestMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case MESSAGE_KINDS.INIT_SNAPSHOT:   return ingestInitSnapshot(message.snapshot);
      case MESSAGE_KINDS.DELTA:           return ingestDelta(message);
      case MESSAGE_KINDS.STATE_HASH:      return ingestStateHash(message);
      case MESSAGE_KINDS.PLAYERS_CHANGED: return ingestPlayersChanged(message);
      default:
        console.warn('[client] unknown message type:', message.type);
    }
  }

  // For the host, broadcasts come *from* GameRoom and pass through net.
  // Hook the outgoing path so the host's own renderer re-syncs after each
  // state change.
  if (mode === 'host') {
    const originalBroadcast = net.broadcast;
    net.broadcast = (message) => {
      if (message?.type === MESSAGE_KINDS.DELTA) {
        queueAnimationsFromEvents(message.events ?? []);
        rerender();
      } else if (message?.type === MESSAGE_KINDS.PLAYERS_CHANGED) {
        lastKnownPlayers = message.players ?? lastKnownPlayers;
        syncFlagConfigs();
        rerender();
      }
      originalBroadcast?.(message);
    };
  }

  function sendAction(action) {
    if (mode === 'host') { gameRoom.handleAction(myPlayerId, action); return; }
    net.sendAction?.(action);
  }

  async function attemptEndTurn() {
    if (isLocalCommandLocked()) return;
    const world = viewerWorld();
    if (!world) return;
    let stillHasMovement = false;
    forEachEntityWith(world, ['Movement', 'Ownership'], (entityId, movement, ownership) => {
      if (ownership.playerId !== myPlayerId) return;
      if (movement.movementLeft > 0) stillHasMovement = true;
    });
    if (stillHasMovement) {
      const confirmed = await showYesNo(
        'You still have movement points remaining. End the day anyway?',
        { title: 'End turn?', yesLabel: 'End turn', noLabel: 'Cancel' },
      );
      if (!confirmed) return;
    }
    sendAction({ name: 'end_turn' });
  }

  // Suppress local user actions while one of the viewer's own heroes is mid
  // animation. Other players' animations don't lock our input — they only
  // affect their own UI. Without this, plotting + executing a second path
  // before the first move's animation finishes makes the hero visually snap
  // because the new event resets the animation's `fromQ,fromR` baseline to
  // the (already-updated) ECS Position.
  function isLocalCommandLocked() {
    return heroAnimations.hasActiveAnimationForPlayer(myPlayerId);
  }

  // Build the right-click-hold context panel content for whatever's on this
  // hex. Returns HTML, or null if there is nothing to describe (off-map).
  function buildInfoPanelHtml(hex) {
    const world = viewerWorld();
    if (!world) return null;
    const explored = currentViewerExploredSet();
    const key = hex.q + ',' + hex.r;

    // Unexplored hexes get a minimal panel — we shouldn't leak terrain or
    // hero presence the viewer hasn't scouted yet.
    if (explored && !explored.has(key)) {
      return sectionTitle('Unknown', '#ff8484')
        + plainLine('You haven\'t scouted this area.');
    }

    const sections = [];

    // Hero on this hex (if any) first — that's usually what a right-click
    // is asking about when a hero is standing there.
    const heroInfo = findHeroAt(world, hex.q, hex.r);
    if (heroInfo) sections.push(buildHeroSection(heroInfo));

    // Map object section — name, optional conquest info, description. Shown
    // for any MapObject + Position entity on the hex.
    const mapObjectInfo = findMapObjectInfoAt(world, viewerRegistry(), hex.q, hex.r);
    if (mapObjectInfo) sections.push(buildMapObjectSection(mapObjectInfo));

    const terrain = lookupTerrainAt(world, viewerRegistry(), hex.q, hex.r);
    const override = lookupOverrideTerrainAt(world, viewerRegistry(), hex.q, hex.r);
    if (terrain || override) sections.push(buildTerrainSection(terrain, override));

    if (sections.length === 0) return plainLine('Nothing here.');
    return sections.join('<div style="height:8px"></div>');
  }

  function buildMapObjectSection({ typeName, typeDescription, conquerable, owner }) {
    const ownerLine = conquerable
      ? plainLine(
          flagMarkerHtml(owner) + ' '
          + (owner.name
              ? 'Owned by <span style="color:' + owner.color + '">' + escapeHtml(owner.name) + '</span>'
              : '<span style="opacity:0.7">Unclaimed</span>')
        )
      : '';
    const description = typeDescription
      ? '<div style="opacity:0.8; margin-top:4px">' + escapeHtml(typeDescription) + '</div>'
      : '';
    return sectionTitle(typeName, '#ffd964') + ownerLine + description;
  }

  // Render a small player-flag image (or a neutral grey square for unclaimed
  // entities) for use inline in the right-click info panel. We paint into a
  // throwaway canvas and embed the PNG as a data URL so the produced HTML is
  // self-contained — the InfoOverlay receives the same `innerHTML` string it
  // does for any other section. `vertical-align: -3px` lines the image up
  // with the surrounding text baseline.
  function flagMarkerHtml(owner) {
    const w = 24, h = 16;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    if (owner?.ownerId) {
      const player = lastKnownPlayers.find(p => (p.playerId ?? p.id) === owner.ownerId);
      const flag = player?.profile?.flag ?? defaultFlagConfigFor(owner.ownerId);
      paintFlagToCanvas(canvas, flag, viewerRegistry());
    } else {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#666';
      ctx.fillRect(0, 0, w, h);
    }
    return '<img src="' + canvas.toDataURL('image/png')
      + '" width="' + w + '" height="' + h
      + '" style="vertical-align:-3px; border:1px solid rgba(0,0,0,0.45); border-radius:2px" alt="">';
  }

  function findMapObjectInfoAt(world, registry, q, r) {
    let result = null;
    forEachEntityWith(world, ['MapObject', 'Position'], (entityId, mapObject, position) => {
      if (result != null) return;
      if (position.q !== q || position.r !== r) return;
      const type = registry.mapObjectTypes.get(mapObject.typeId);
      const conquerable = hasComponent(world, entityId, 'Conquerable');
      let owner = null;
      if (conquerable) {
        const ownership = getComponent(world, entityId, 'Ownership');
        const ownerId = ownership?.playerId ?? null;
        const ownerPlayer = ownerId
          ? lastKnownPlayers.find(p => (p.playerId ?? p.id) === ownerId)
          : null;
        owner = {
          ownerId,
          name: ownerPlayer?.name ?? null,
          color: ownerId ? playerColorCss(ownerId) : '#888',
        };
      }
      result = {
        typeName: type?.name ?? 'Object',
        typeDescription: type?.description ?? null,
        conquerable,
        owner,
      };
    });
    return result;
  }

  function buildHeroSection({ entityId, hero, ownerPlayerName, isViewerOwned }) {
    const ownerLine = ownerPlayerName
      ? plainLine('<span style="opacity:0.75">' + (isViewerOwned ? 'Your hero' : 'Owned by ' + escapeHtml(ownerPlayerName)) + '</span>')
      : '';
    const modes = collectTraversalModes(viewerWorld(), entityId);
    const modesLine = modes.length
      ? plainLine('Traverses: <span style="color:#a8e6ff">' + modes.map(humaniseMode).join(', ') + '</span>')
      : '';
    return sectionTitle(hero.name ?? 'Hero', '#a8e6ff') + ownerLine + modesLine;
  }

  function buildTerrainSection(terrain, override) {
    // When a TerrainOverride is on the hex it fully replaces the base
    // terrain — show the override's name, description, and passability;
    // the base terrain is no longer relevant to the player.
    const effective = override ?? terrain;
    const passable = listPassableModes(effective);
    const traversalBody = passable.length
      ? '<div style="margin-top:2px">'
        + passable.map(entry =>
            '<div style="margin-left:6px">'
            + humaniseMode(entry.mode)
            + ': <span style="color:#a8e6ff">' + entry.cost + ' mp</span>'
            + '</div>',
          ).join('')
        + '</div>'
      : '<div style="color:#ff8484">Impassable</div>';
    const description = effective?.description
      ? '<div style="opacity:0.8; margin-top:4px">' + escapeHtml(effective.description) + '</div>'
      : '';
    return sectionTitle(effective?.name ?? effective?.id ?? 'Terrain', '#7fffa8')
      + '<div>Traversal:</div>'
      + traversalBody
      + description;
  }

  function sectionTitle(text, accent) {
    return '<div style="font-weight:600; color:' + accent + '; margin-bottom:2px">' + escapeHtml(text) + '</div>';
  }
  function plainLine(html) {
    return '<div>' + html + '</div>';
  }
  function humaniseMode(mode) {
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
  function escapeHtml(text) {
    return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  // Pulls the Actionable component data (icon + label) off whatever entity
  // sits on (q, r). The UI doesn't need to know anything about visit
  // semantics — anything with an Actionable shows up as interactable here.
  function findActionableAt(world, q, r) {
    let result = null;
    forEachEntityWith(world, ['Actionable', 'Position'], (_entityId, actionable, position) => {
      if (result != null) return;
      if (position.q === q && position.r === r) result = actionable;
    });
    return result;
  }

  // Returns conquest info for any Conquerable entity on (q, r). The flag is
  // tinted to the owner's colour; unconquered entries get a neutral grey so
  // hovering still tells you the thing IS conquerable.
  function findConquerableInfoAt(world, q, r) {
    let result = null;
    forEachEntityWith(world, ['Conquerable', 'Position'], (entityId, _c, position) => {
      if (result != null) return;
      if (position.q !== q || position.r !== r) return;
      const ownership = getComponent(world, entityId, 'Ownership');
      const ownerId = ownership?.playerId ?? null;
      const ownerPlayer = ownerId
        ? lastKnownPlayers.find(p => (p.playerId ?? p.id) === ownerId)
        : null;
      result = {
        ownerId,
        ownerName: ownerPlayer?.name ?? null,
        color: ownerId ? playerColorCss(ownerId) : '#888',
      };
    });
    return result;
  }

  // Set the canvas cursor without re-writing the style attribute when it's
  // already the value we want. Called on every hover; avoiding redundant
  // writes keeps DevTools' Layout panel quieter and is otherwise cost-free.
  function setCanvasCursor(value) {
    if (canvas.style.cursor !== value) canvas.style.cursor = value;
  }

  function findHeroAt(world, q, r) {
    let result = null;
    forEachEntityWith(world, ['Hero', 'Position'], (entityId, hero, position) => {
      if (result) return;
      if (position.q !== q || position.r !== r) return;
      const ownership = getComponent(world, entityId, 'Ownership');
      const ownerId = ownership?.playerId ?? null;
      const ownerPlayer = ownerId ? lastKnownPlayers.find(p => (p.playerId ?? p.id) === ownerId) : null;
      result = {
        entityId,
        hero,
        ownerPlayerName: ownerPlayer?.name ?? null,
        isViewerOwned: ownerId === myPlayerId,
      };
    });
    return result;
  }

  function lookupTerrainAt(world, registry, q, r) {
    // The pathfinding tile index is keyed by 'q,r'. It's already built (and
    // cached on the world) by every plan-path call, but rebuilding it here
    // when missing is cheap-ish for an info pop.
    const cache = world._tileIndex;
    if (cache) {
      const hit = cache.get(q + ',' + r);
      return hit ? hit.terrain : null;
    }
    let terrain = null;
    forEachEntityWith(world, ['Tile'], (entityId, tile) => {
      if (terrain) return;
      if (tile.q !== q || tile.r !== r) return;
      terrain = getTerrainFromRegistry(registry, tile.terrainId);
    });
    return terrain;
  }

  function lookupOverrideTerrainAt(world, registry, q, r) {
    const cache = world._tileIndex;
    if (cache) {
      const hit = cache.get(q + ',' + r);
      return hit?.effectiveTerrain ?? null;
    }
    let overrideTerrainId = null;
    forEachEntityWith(world, ['TerrainOverride', 'Position'], (_id, override, position) => {
      if (overrideTerrainId) return;
      if (position.q === q && position.r === r) overrideTerrainId = override.terrainId;
    });
    return overrideTerrainId ? (registry.terrains.get(overrideTerrainId) ?? null) : null;
  }

  function getTerrainFromRegistry(registry, terrainId) {
    return registry.terrains.get(terrainId) ?? null;
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

  // Pathfinding helper: explored Set for the local viewer, drawn from
  // whichever world this side owns.
  function currentViewerExploredSet() {
    const world = viewerWorld();
    if (!world) return null;
    const stateEntityId = world._worldStateEntity;
    if (!stateEntityId) return null;
    const store = world.componentStores.get('WorldState');
    if (!store) return null;
    const state = store.get(stateEntityId);
    return state?.fogByPlayer?.[myPlayerId]?.explored ?? null;
  }

  // Step duration is shared with heroAnimations.STEP_DURATION_MS. Kept here
  // as a constant so the popover defer-time aligns with the animation length
  // without having to round-trip through that module.
  const ANIMATION_STEP_MS = 220;

  function queueAnimationsFromEvents(events) {
    // Two-pass scan so deferred UI (popovers) reflects the full animation
    // duration regardless of event ordering in the array. The host emits
    // entity_visited inside the per-step loop and hero_moved only after,
    // so the visit event comes FIRST in the events array — without the
    // two-pass split, the popover would schedule at delay=0 and fire the
    // moment the user clicked, before the walk animation begins.
    let pendingDelayMs = 0;
    for (const event of events) {
      if (event?.type !== 'hero_moved') continue;
      const hero = getComponent(viewerWorld(), event.heroEntityId, 'Hero');
      heroAnimations.enqueueFromEvent(event, myPlayerId, hero);
      if (event.playerId === myPlayerId && Array.isArray(event.path)) {
        pendingDelayMs = Math.max(pendingDelayMs, event.path.length * ANIMATION_STEP_MS);
      }
    }
    for (const event of events) {
      if (event?.type !== 'entity_visited') continue;
      if (event.playerId !== myPlayerId) continue;
      const message = event.message ?? '';
      const title = event.objectName ?? null;
      setTimeout(() => { showOkay(message, { title }); }, pendingDelayMs);
    }
    // End-of-week vanquish announcements — only popped if the local player
    // is the one going down. Other-player vanquishes ride the delta silently;
    // the entity destroys land in the same op buffer so heroes just vanish.
    for (const event of events) {
      if (event?.type !== 'player_vanquished') continue;
      if (event.playerId !== myPlayerId) continue;
      const title = 'Vanquished';
      const message = 'Without a castle to anchor your domain, your heroes have scattered to the wind.';
      setTimeout(() => { showOkay(message, { title }); }, pendingDelayMs);
    }
  }

  function handleClientAction(fromPlayerId, action) {
    if (mode !== 'host' || !gameRoom) return;
    gameRoom.handleAction(fromPlayerId, action);
  }

  function announceClientConnected(peerId, name, profile = null) {
    if (mode !== 'host' || !gameRoom) return;
    gameRoom.addPlayer(peerId, name, profile, {
      kingdomId: profile?.kingdomId ?? null,
      isComputer: false,
    });
    gameRoom.sendInitSnapshotTo(peerId);
  }
  function announceClientDisconnected(peerId) {
    if (mode !== 'host' || !gameRoom) return;
    gameRoom.markPlayerDisconnected(peerId);
  }
  function updatePlayerProfile(peerId, profile) {
    if (mode !== 'host' || !gameRoom) return;
    gameRoom.updatePlayerProfile(peerId, profile);
  }

  return {
    ingestMessage,
    handleClientAction,
    announceClientConnected,
    announceClientDisconnected,
    updatePlayerProfile,
    rerender,
    getMissingAssetsMarkdown: () =>
      formatMissingAssetsMarkdown(assets.getMissingAssets(), declarationListFor(viewerRegistry(), assets)),
  };
}

// Local mirror of the host-side helper so the client's hover preview agrees
// with the host's authoritative planner about which tiles are blocked.
function collectBlockedKeysExcluding(world, excludeEntityId) {
  const blocked = new Set();
  forEachEntityWith(world, ['BlocksMovement', 'Position'], (entityId, _block, position) => {
    if (entityId === excludeEntityId) return;
    blocked.add(position.q + ',' + position.r);
  });
  return blocked;
}

function rebuildPathCosts(world, registry, startPosition, rawSteps, traversalModes) {
  const tileStore = world.componentStores.get('Tile');
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
    forEachEntityWith(world, ['TerrainOverride', 'Position'], (_id, override, position) => {
      const entry = index.get(position.q + ',' + position.r);
      if (!entry) return;
      const resolved = getTerrain(registry, override.terrainId);
      if (resolved) entry.effectiveTerrain = resolved;
    });
    world._tileIndex = index;
    world._tileIndexRegistryRef = registry;
  }

  const modes = traversalModes?.length ? traversalModes : ['Land'];
  let running = 0;
  const out = [];
  for (const step of rawSteps) {
    const lookup = index.get(step.q + ',' + step.r);
    const carrier = lookup?.effectiveTerrain ?? lookup?.terrain;
    const cost = resolveTerrainCost(carrier, modes);
    running += cost ?? 1;
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
