// GameRoom: host-authoritative wrapper around the ECS world.
//
// Wire protocol (see protocol.js):
//   • init_snapshot   — full state, sent on connect or after a resync request.
//   • delta           — change ops + triggered events, after each host action.
//   • state_hash      — FNV-1a of canonical world state, sent right after each delta.
//   • players_changed — roster updates (join, leave, name-matched reconnect).
//
// Tile data is not in any of these — clients regenerate from `seed` on first
// snapshot. The host's GameRoom mutates state through the ECS's tracked
// helpers (see ecs/world.js), draining world.pendingChanges into deltas after
// each handler. Persistence to localStorage runs after every delta.

import {
  createWorld, createEntity, addComponent, getComponent, getWorldState,
  forEachEntityWith, setChangeRecording, consumePendingChanges,
  setComponentTracked, patchComponentTracked, createTrackedEntity,
} from './ecs/world.js';
import { createRegistry, getTerrain, spawnFromPrefab } from './ecs/registry.js';
import { loadAllModules } from './modules/moduleLoader.js';
import {
  recomputeFogForAllPlayers, ensurePlayerFogInitialised,
  flattenFog, inflateFog,
} from './map/fog.js';
import { generateMap, findSpawnHex } from './map/mapgen.js';
import { findPath, invalidateTileIndex } from './map/pathfinding.js';
import { hashWorld, MESSAGE_KINDS } from './protocol.js';
import { writeSave, newSaveId } from './persistence.js';

const STARTING_HERO_ARCHETYPES = ['base/bob', 'base/alice'];
const MAP_WIDTH = 256;
const MAP_HEIGHT = 256;
const MIN_SPAWN_SEPARATION = 40;
const STARTING_MOVEMENT_MAX = 50;

export class GameRoom {
  constructor({ assets, broadcast, sendTo, log }) {
    this.world = createWorld();
    this.registry = createRegistry();
    this.assets = assets;
    this.broadcast = broadcast ?? (() => {});
    this.sendTo = sendTo ?? ((_id, _msg) => {});
    this.log = log ?? (() => {});

    this.players = [];           // [{ playerId, name, connected: bool, originalPlayerId: <savedId|null> }]
    this.started = false;
    this.seed = Math.floor(Math.random() * 1_000_000);
    this.sequenceNumber = 0;
    this.saveId = newSaveId();   // updated when a save is loaded

    loadAllModules({ world: this.world, registry: this.registry, assets: this.assets });

    const stateEntityId = getWorldState(this.world);
    addComponent(this.world, stateEntityId, 'WorldState', {
      playerOrder: [],
      currentPlayerIndex: 0,
      turnNumber: 1,
      seed: this.seed,
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      fogByPlayer: {},
      phase: 'lobby',
    });

    // Recording begins AFTER the constructor sets up baseline state — those
    // initial values go out as part of init_snapshot, not as deltas.
    setChangeRecording(this.world, true);
  }

  // ── Lobby plumbing ─────────────────────────────────────────────────────
  // Add a player. If a saved-but-disconnected slot has the same name, we
  // restore it instead of appending. Returns the slot's playerId.
  addPlayer(connectingPlayerId, name) {
    const reusableSlot = this.players.find(p => !p.connected && p.name === name);
    if (reusableSlot) {
      // Map the saved hero(s) from the old id to the new id.
      remapOwnership(this.world, reusableSlot.playerId, connectingPlayerId);
      remapFog(this.world, reusableSlot.playerId, connectingPlayerId);
      remapPlayerOrder(this.world, reusableSlot.playerId, connectingPlayerId);
      reusableSlot.originalPlayerId = reusableSlot.playerId;
      reusableSlot.playerId = connectingPlayerId;
      reusableSlot.connected = true;
      this._publishPlayersChanged();
      return connectingPlayerId;
    }
    if (this.players.some(p => p.playerId === connectingPlayerId)) return connectingPlayerId;
    this.players.push({ playerId: connectingPlayerId, name, connected: true, originalPlayerId: null });
    this._publishPlayersChanged();
    return connectingPlayerId;
  }

  markPlayerDisconnected(playerId) {
    const slot = this.players.find(p => p.playerId === playerId);
    if (!slot) return;
    slot.connected = false;
    this._publishPlayersChanged();
  }

  // ── Start / load ───────────────────────────────────────────────────────
  startNewGame() {
    if (this.started) return;
    this.started = true;
    const tiles = generateMap(this.world, this.registry, {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      seed: this.seed,
      tilePrefabId: 'base/tile',
    });
    invalidateTileIndex(this.world);

    const takenSpawns = [];
    const ringRadius = Math.min(MAP_WIDTH, MAP_HEIGHT) / 2 - 12;
    for (let playerIndex = 0; playerIndex < this.players.length; playerIndex++) {
      const player = this.players[playerIndex];
      const angle = (playerIndex / this.players.length) * Math.PI * 2;
      const preferred = {
        q: Math.round(Math.cos(angle) * ringRadius),
        r: Math.round(Math.sin(angle) * ringRadius),
      };
      const spawn = findSpawnHex(this.world, this.registry, tiles, preferred, MIN_SPAWN_SEPARATION, takenSpawns);
      if (!spawn) { this.log('no spawn found for player ' + player.playerId); continue; }
      takenSpawns.push(spawn);
      this._spawnPlayerHero(player.playerId, playerIndex, spawn);
    }

    const stateEntityId = getWorldState(this.world);
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['playerOrder'],
      this.players.map(p => p.playerId));
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['currentPlayerIndex'], 0);
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['turnNumber'], 1);
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['phase'], 'playing');

    for (const player of this.players) ensurePlayerFogInitialised(this.world, player.playerId);
    recomputeFogForAllPlayers(this.world, this.registry);

    // The startup mutations form the first delta — but client doesn't have
    // an initial state to apply them to, so we drain & discard. Instead we
    // ship a full init_snapshot once they connect.
    consumePendingChanges(this.world);
    this._persistToLocalStorage();
  }

  loadFromSave(savedSnapshot) {
    if (this.started) return;
    this.started = true;
    this.saveId = savedSnapshot.id ?? this.saveId;
    this.seed = savedSnapshot.seed;

    // Stop recording while we replay the snapshot's initial state.
    setChangeRecording(this.world, false);

    // Regenerate tiles (host needs them locally for pathfinding/_terrainAt).
    generateMap(this.world, this.registry, {
      width: savedSnapshot.mapWidth ?? MAP_WIDTH,
      height: savedSnapshot.mapHeight ?? MAP_HEIGHT,
      seed: this.seed,
      tilePrefabId: 'base/tile',
    });
    invalidateTileIndex(this.world);

    // Wipe non-tile state and replace it with the saved snapshot.
    this.world.nextEntityId = savedSnapshot.nextEntityId;
    this.world.entities = new Set(savedSnapshot.entityIds);
    const tileStore = this.world.componentStores.get('Tile');
    this.world.componentStores = new Map();
    for (const componentName in savedSnapshot.components) {
      const map = new Map();
      for (const entityIdStr in savedSnapshot.components[componentName]) {
        const entityId = Number(entityIdStr);
        let data = savedSnapshot.components[componentName][entityIdStr];
        if (componentName === 'WorldState') {
          data = { ...data, fogByPlayer: inflateFog(data.fogByPlayer ?? {}) };
          this.world._worldStateEntity = entityId;
        }
        map.set(entityId, data);
      }
      this.world.componentStores.set(componentName, map);
    }
    if (tileStore) {
      for (const id of tileStore.keys()) this.world.entities.add(id);
      this.world.componentStores.set('Tile', tileStore);
    }

    // Replace lobby roster with saved players, marking everyone as not yet
    // reconnected. addPlayer() will rebind by name as peers arrive.
    this.players = (savedSnapshot.players ?? []).map(savedPlayer => ({
      playerId: savedPlayer.playerId,
      name: savedPlayer.name,
      connected: false,
      originalPlayerId: savedPlayer.playerId,
    }));

    setChangeRecording(this.world, true);
  }

  _spawnPlayerHero(playerId, playerIndex, spawn) {
    // Setup-time spawn — mutations during startNewGame() are discarded from
    // the change buffer because clients pull the initial state from
    // init_snapshot, not deltas. We use the registry prefab directly here.
    const archetypeId = STARTING_HERO_ARCHETYPES[playerIndex % STARTING_HERO_ARCHETYPES.length];
    const archetype = this.registry.heroes.get(archetypeId);
    const heroParams = {
      ...archetype.defaults,
      name: archetype.name,
      playerId,
      q: spawn.q,
      r: spawn.r,
      movementMax: STARTING_MOVEMENT_MAX,
      movementLeft: STARTING_MOVEMENT_MAX,
    };
    return spawnFromPrefab(this.registry, archetype.prefabId, this.world, heroParams);
  }

  // ── Snapshot (full init) ───────────────────────────────────────────────
  buildInitSnapshot() {
    const componentsByName = {};
    for (const [name, store] of this.world.componentStores) {
      if (name === 'Tile') continue;
      const flat = {};
      for (const [entityId, data] of store) {
        if (name === 'WorldState') {
          flat[entityId] = { ...data, fogByPlayer: flattenFog(data.fogByPlayer ?? {}) };
        } else {
          flat[entityId] = data;
        }
      }
      componentsByName[name] = flat;
    }
    const tileStore = this.world.componentStores.get('Tile');
    const tileEntityIds = tileStore ? new Set(tileStore.keys()) : new Set();
    const nonTileEntityIds = Array.from(this.world.entities).filter(id => !tileEntityIds.has(id));
    return {
      seq: this.sequenceNumber,
      nextEntityId: this.world.nextEntityId,
      entityIds: nonTileEntityIds,
      components: componentsByName,
      seed: this.seed,
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      players: this.players,
    };
  }

  sendInitSnapshotTo(targetPeerId) {
    const snapshot = this.buildInitSnapshot();
    this.sendTo(targetPeerId, { type: MESSAGE_KINDS.INIT_SNAPSHOT, snapshot });
  }

  // ── Actions ────────────────────────────────────────────────────────────
  handleAction(playerId, action) {
    if (!action || typeof action !== 'object') return;
    if (action.name === 'resync_request') {
      // Client noticed a gap — re-ship init_snapshot privately.
      this.sendInitSnapshotTo(playerId);
      return;
    }
    const events = [];
    switch (action.name) {
      case 'plan_path':       this._planPath(playerId, action, events); break;
      case 'clear_path':      this._clearPath(playerId, action, events); break;
      case 'move_along_path': this._moveAlongPath(playerId, action, events); break;
      case 'end_turn':        this._endTurn(playerId, action, events); break;
      default:
        this.log('unknown action: ' + action.name);
    }
    this._publishDelta(events);
  }

  _planPath(playerId, action, events) {
    const heroEntityId = this._heroForPlayer(playerId, action.heroEntityId);
    if (!heroEntityId) return;
    const position = getComponent(this.world, heroEntityId, 'Position');
    const goal = { q: action.goalQ, r: action.goalR };
    const path = findPath(this.world, this.registry, position, goal);
    const stateEntity = heroEntityId;
    if (path) {
      patchComponentTracked(this.world, stateEntity, 'Movement', ['plannedPath'], { steps: path.steps });
      events.push({ type: 'path_planned', heroEntityId, goal });
    } else {
      patchComponentTracked(this.world, stateEntity, 'Movement', ['plannedPath'], null);
      events.push({ type: 'path_cleared', heroEntityId });
    }
  }

  _clearPath(playerId, action, events) {
    const heroEntityId = this._heroForPlayer(playerId, action.heroEntityId);
    if (!heroEntityId) return;
    patchComponentTracked(this.world, heroEntityId, 'Movement', ['plannedPath'], null);
    events.push({ type: 'path_cleared', heroEntityId });
  }

  _moveAlongPath(playerId, action, events) {
    const heroEntityId = this._heroForPlayer(playerId, action.heroEntityId);
    if (!heroEntityId) return;
    if (!this._isCurrentPlayer(playerId)) return;
    const position = getComponent(this.world, heroEntityId, 'Position');
    const movement = getComponent(this.world, heroEntityId, 'Movement');
    const plan = movement.plannedPath;
    if (!plan || plan.steps.length === 0) return;

    const fromQ = position.q;
    const fromR = position.r;
    const stepsRemaining = plan.steps.slice();
    let consumedSteps = 0;
    while (stepsRemaining.length > 0) {
      const next = stepsRemaining[0];
      const terrain = getTerrain(this.registry, this._terrainAt(next.q, next.r));
      if (!terrain || !terrain.walkable) break;
      const cost = terrain.movementCost;
      if (movement.movementLeft < cost) break;
      patchComponentTracked(this.world, heroEntityId, 'Movement', ['movementLeft'], movement.movementLeft - cost);
      patchComponentTracked(this.world, heroEntityId, 'Position', ['q'], next.q);
      patchComponentTracked(this.world, heroEntityId, 'Position', ['r'], next.r);
      stepsRemaining.shift();
      consumedSteps++;
    }
    if (consumedSteps === 0) return;
    patchComponentTracked(this.world, heroEntityId, 'Movement', ['plannedPath'],
      stepsRemaining.length > 0 ? { steps: stepsRemaining } : null);

    events.push({
      type: 'hero_moved',
      heroEntityId,
      fromQ,
      fromR,
      toQ: getComponent(this.world, heroEntityId, 'Position').q,
      toR: getComponent(this.world, heroEntityId, 'Position').r,
      stepsConsumed: consumedSteps,
    });
    recomputeFogForAllPlayers(this.world, this.registry);
  }

  _endTurn(playerId, action, events) {
    if (!this._isCurrentPlayer(playerId)) return;
    const stateEntityId = getWorldState(this.world);
    const worldState = getComponent(this.world, stateEntityId, 'WorldState');
    const nextIndex = (worldState.currentPlayerIndex + 1) % this.players.length;
    const nextTurnNumber = worldState.turnNumber + (nextIndex === 0 ? 1 : 0);

    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['currentPlayerIndex'], nextIndex);
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['turnNumber'], nextTurnNumber);

    const incomingPlayerId = this.players[nextIndex].playerId;
    forEachEntityWith(this.world, ['Movement', 'Ownership'], (entityId, movement, ownership) => {
      if (ownership.playerId !== incomingPlayerId) return;
      patchComponentTracked(this.world, entityId, 'Movement', ['movementLeft'], movement.movementMax);
    });
    recomputeFogForAllPlayers(this.world, this.registry);
    events.push({ type: 'turn_ended', currentPlayerIndex: nextIndex, turnNumber: nextTurnNumber });
  }

  // ── Delta + hash broadcast ─────────────────────────────────────────────
  _publishDelta(events) {
    const ops = consumePendingChanges(this.world);
    if (ops.length === 0 && events.length === 0) return;
    this.sequenceNumber++;
    const deltaMessage = {
      type: MESSAGE_KINDS.DELTA,
      seq: this.sequenceNumber,
      ops,
      events,
    };
    this.broadcast(deltaMessage);
    // Hash check immediately after — same sequence number.
    this.broadcast({
      type: MESSAGE_KINDS.STATE_HASH,
      seq: this.sequenceNumber,
      hash: hashWorld(this.world),
    });
    this._persistToLocalStorage();
  }

  _publishPlayersChanged() {
    this.sequenceNumber++;
    this.broadcast({
      type: MESSAGE_KINDS.PLAYERS_CHANGED,
      seq: this.sequenceNumber,
      players: this.players,
    });
    this._persistToLocalStorage();
  }

  _persistToLocalStorage() {
    if (!this.started) return;
    const snapshot = this.buildInitSnapshot();
    snapshot.id = this.saveId;
    const stateEntityId = getWorldState(this.world);
    const worldState = getComponent(this.world, stateEntityId, 'WorldState');
    writeSave({
      id: this.saveId,
      snapshot,
      players: this.players,
      turnNumber: worldState?.turnNumber ?? 1,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  _heroForPlayer(playerId, heroEntityId) {
    if (!heroEntityId) return null;
    const ownership = getComponent(this.world, heroEntityId, 'Ownership');
    if (!ownership || ownership.playerId !== playerId) return null;
    return heroEntityId;
  }

  _isCurrentPlayer(playerId) {
    const stateEntityId = getWorldState(this.world);
    const worldState = getComponent(this.world, stateEntityId, 'WorldState');
    const current = this.players[worldState.currentPlayerIndex];
    return current && current.playerId === playerId;
  }

  _terrainAt(q, r) {
    const cache = this.world._tileIndex;
    if (cache) {
      const hit = cache.get(q + ',' + r);
      return hit ? hit.tile.terrainId : null;
    }
    let foundTerrain = null;
    forEachEntityWith(this.world, ['Tile'], (entityId, tile) => {
      if (tile.q === q && tile.r === r) foundTerrain = tile.terrainId;
    });
    return foundTerrain;
  }
}

// ── Reconnect helpers ───────────────────────────────────────────────────
// When a saved player reconnects with a fresh peer id, swap the old id out
// of every Ownership / WorldState.playerOrder / fog map reference.
function remapOwnership(world, oldPlayerId, newPlayerId) {
  if (oldPlayerId === newPlayerId) return;
  forEachEntityWith(world, ['Ownership'], (entityId, ownership) => {
    if (ownership.playerId !== oldPlayerId) return;
    patchComponentTracked(world, entityId, 'Ownership', ['playerId'], newPlayerId);
  });
}

function remapPlayerOrder(world, oldPlayerId, newPlayerId) {
  if (oldPlayerId === newPlayerId) return;
  const stateEntity = getWorldState(world);
  const worldState = getComponent(world, stateEntity, 'WorldState');
  const order = worldState.playerOrder ?? [];
  const next = order.map(id => id === oldPlayerId ? newPlayerId : id);
  patchComponentTracked(world, stateEntity, 'WorldState', ['playerOrder'], next);
}

function remapFog(world, oldPlayerId, newPlayerId) {
  if (oldPlayerId === newPlayerId) return;
  const stateEntity = getWorldState(world);
  const worldState = getComponent(world, stateEntity, 'WorldState');
  const fog = worldState.fogByPlayer?.[oldPlayerId];
  if (!fog) return;
  // Replace the whole fog entry for newPlayerId with the old data.
  patchComponentTracked(world, stateEntity, 'WorldState', ['fogByPlayer', newPlayerId], {
    visible: Array.from(fog.visible),
    explored: Array.from(fog.explored),
  });
  // Rehydrate Sets locally on the host (the patch above stamped arrays).
  worldState.fogByPlayer[newPlayerId] = {
    visible: new Set(fog.visible),
    explored: new Set(fog.explored),
  };
  patchComponentTracked(world, stateEntity, 'WorldState', ['fogByPlayer', oldPlayerId], null);
  delete worldState.fogByPlayer[oldPlayerId];
}
