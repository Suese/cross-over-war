// GameRoom: host-authoritative wrapper around the ECS world.
//
// Tile data is NOT included in snapshots. Both host and client run the same
// deterministic mapgen against the seed embedded in WorldState, so the tile
// entities exist identically on both sides without paying ~65k tiles' worth
// of bytes over the wire on every state change.

import { createWorld, createEntity, addComponent, getComponent, getWorldState, forEachEntityWith, collectEntitiesWith } from './ecs/world.js';
import { createRegistry, getTerrain, spawnFromPrefab } from './ecs/registry.js';
import { loadAllModules } from './modules/moduleLoader.js';
import { recomputeFogForAllPlayers, flattenFog, inflateFog } from './map/fog.js';
import { generateMap, findSpawnHex } from './map/mapgen.js';
import { findPath, invalidateTileIndex } from './map/pathfinding.js';

const STARTING_HERO_ARCHETYPES = ['base/bob', 'base/alice'];
const MAP_WIDTH = 256;
const MAP_HEIGHT = 256;
const MIN_SPAWN_SEPARATION = 40;
const STARTING_MOVEMENT_MAX = 50;

export class GameRoom {
  constructor({ assets, broadcast, log }) {
    this.world = createWorld();
    this.registry = createRegistry();
    this.assets = assets;
    this.broadcast = broadcast ?? (() => {});
    this.log = log ?? (() => {});
    this.players = [];
    this.started = false;
    this.seed = Math.floor(Math.random() * 1_000_000);

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
  }

  // ── Lobby plumbing (called by host's net code) ──────────────────────────
  addPlayer(playerId, name) {
    if (this.players.some(p => p.playerId === playerId)) return;
    this.players.push({ playerId, name });
  }
  removePlayer(playerId) {
    this.players = this.players.filter(p => p.playerId !== playerId);
  }

  // Build the map, place heroes, mark fog. Called once when the host clicks "Start game".
  startGame() {
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
    const playerCount = this.players.length;
    const ringRadius = Math.min(MAP_WIDTH, MAP_HEIGHT) / 2 - 12;
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex++) {
      const player = this.players[playerIndex];
      const angle = (playerIndex / playerCount) * Math.PI * 2;
      const preferred = {
        q: Math.round(Math.cos(angle) * ringRadius),
        r: Math.round(Math.sin(angle) * ringRadius),
      };
      const spawn = findSpawnHex(this.world, this.registry, tiles, preferred, MIN_SPAWN_SEPARATION, takenSpawns);
      if (!spawn) {
        this.log('no spawn found for player ' + player.playerId);
        continue;
      }
      takenSpawns.push(spawn);
      const archetypeId = STARTING_HERO_ARCHETYPES[playerIndex % STARTING_HERO_ARCHETYPES.length];
      const archetype = this.registry.heroes.get(archetypeId);
      const heroParams = {
        ...archetype.defaults,
        name: archetype.name,
        playerId: player.playerId,
        q: spawn.q,
        r: spawn.r,
        movementMax: STARTING_MOVEMENT_MAX,
        movementLeft: STARTING_MOVEMENT_MAX,
      };
      spawnFromPrefab(this.registry, archetype.prefabId, this.world, heroParams);
    }

    const stateEntityId = getWorldState(this.world);
    const worldState = getComponent(this.world, stateEntityId, 'WorldState');
    worldState.playerOrder = this.players.map(player => player.playerId);
    worldState.currentPlayerIndex = 0;
    worldState.turnNumber = 1;
    worldState.phase = 'playing';

    recomputeFogForAllPlayers(this.world, this.registry);
    this.publishSnapshot();
  }

  // ── Snapshot wire format ────────────────────────────────────────────────
  // Tile components are deliberately omitted — clients regenerate from the
  // seed in WorldState, which is way cheaper than serialising 65k tiles.
  buildSnapshot() {
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
    // Entity-id list also strips tile ids — clients will regenerate them.
    const tileEntityIds = new Set();
    const tileStore = this.world.componentStores.get('Tile');
    if (tileStore) for (const id of tileStore.keys()) tileEntityIds.add(id);
    const nonTileEntityIds = Array.from(this.world.entities).filter(id => !tileEntityIds.has(id));
    return {
      players: this.players,
      nextEntityId: this.world.nextEntityId,
      entityIds: nonTileEntityIds,
      components: componentsByName,
    };
  }
  publishSnapshot() {
    this.broadcast({ type: 'snapshot', snapshot: this.buildSnapshot() });
  }

  // Restore world state from a host's snapshot (client side). Preserves any
  // existing Tile component store the client has already generated locally.
  static applySnapshot(world, registry, snapshot) {
    const existingTileStore = world.componentStores.get('Tile');
    const existingTileEntityIds = existingTileStore ? Array.from(existingTileStore.keys()) : [];

    world.nextEntityId = Math.max(snapshot.nextEntityId, world.nextEntityId);
    world.entities = new Set(snapshot.entityIds);
    world.componentStores = new Map();
    for (const componentName in snapshot.components) {
      const map = new Map();
      for (const entityIdStr in snapshot.components[componentName]) {
        const entityId = Number(entityIdStr);
        let data = snapshot.components[componentName][entityIdStr];
        if (componentName === 'WorldState') {
          data = { ...data, fogByPlayer: inflateFog(data.fogByPlayer ?? {}) };
          world._worldStateEntity = entityId;
        }
        map.set(entityId, data);
      }
      world.componentStores.set(componentName, map);
    }

    // Re-introduce tile entities — they're not in the snapshot but the client
    // generated them locally from the seed.
    if (existingTileStore) {
      for (const id of existingTileEntityIds) world.entities.add(id);
      world.componentStores.set('Tile', existingTileStore);
    }
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  handleAction(playerId, action) {
    if (!action || typeof action !== 'object') return;
    switch (action.name) {
      case 'plan_path':       return this.planPath(playerId, action);
      case 'clear_path':      return this.clearPath(playerId, action);
      case 'move_along_path': return this.moveAlongPath(playerId, action);
      case 'end_turn':        return this.endTurn(playerId, action);
      default:
        this.log('unknown action: ' + action.name);
    }
  }

  planPath(playerId, action) {
    const hero = this._findHero(playerId, action.heroEntityId);
    if (!hero) return;
    const position = getComponent(this.world, hero.entityId, 'Position');
    const movement = getComponent(this.world, hero.entityId, 'Movement');
    const goal = { q: action.goalQ, r: action.goalR };
    const path = findPath(this.world, this.registry, position, goal);
    movement.plannedPath = path ? { steps: path.steps } : null;
    this.publishSnapshot();
  }

  clearPath(playerId, action) {
    const hero = this._findHero(playerId, action.heroEntityId);
    if (!hero) return;
    const movement = getComponent(this.world, hero.entityId, 'Movement');
    movement.plannedPath = null;
    this.publishSnapshot();
  }

  moveAlongPath(playerId, action) {
    const hero = this._findHero(playerId, action.heroEntityId);
    if (!hero) return;
    if (!this._isCurrentPlayer(playerId)) return;
    const position = getComponent(this.world, hero.entityId, 'Position');
    const movement = getComponent(this.world, hero.entityId, 'Movement');
    const plan = movement.plannedPath;
    if (!plan || plan.steps.length === 0) return;

    const stepsRemaining = plan.steps.slice();
    while (stepsRemaining.length > 0) {
      const next = stepsRemaining[0];
      const terrain = getTerrain(this.registry, this._terrainAt(next.q, next.r));
      if (!terrain || !terrain.walkable) break;
      const cost = terrain.movementCost;
      if (movement.movementLeft < cost) break;
      movement.movementLeft -= cost;
      position.q = next.q;
      position.r = next.r;
      stepsRemaining.shift();
    }
    movement.plannedPath = stepsRemaining.length > 0 ? { steps: stepsRemaining } : null;

    recomputeFogForAllPlayers(this.world, this.registry);
    this.publishSnapshot();
  }

  endTurn(playerId, action) {
    if (!this._isCurrentPlayer(playerId)) return;
    const stateEntityId = getWorldState(this.world);
    const worldState = getComponent(this.world, stateEntityId, 'WorldState');
    worldState.currentPlayerIndex = (worldState.currentPlayerIndex + 1) % this.players.length;
    if (worldState.currentPlayerIndex === 0) worldState.turnNumber += 1;

    const incomingPlayerId = this.players[worldState.currentPlayerIndex].playerId;
    forEachEntityWith(this.world, ['Movement', 'Ownership'], (entityId, movement, ownership) => {
      if (ownership.playerId !== incomingPlayerId) return;
      movement.movementLeft = movement.movementMax;
    });
    recomputeFogForAllPlayers(this.world, this.registry);
    this.publishSnapshot();
  }

  _findHero(playerId, heroEntityId) {
    if (!heroEntityId) return null;
    const ownership = getComponent(this.world, heroEntityId, 'Ownership');
    if (!ownership || ownership.playerId !== playerId) return null;
    return { entityId: heroEntityId };
  }

  _isCurrentPlayer(playerId) {
    const stateEntityId = getWorldState(this.world);
    const worldState = getComponent(this.world, stateEntityId, 'WorldState');
    const current = this.players[worldState.currentPlayerIndex];
    return current && current.playerId === playerId;
  }

  _terrainAt(q, r) {
    // Use the cached tile index that pathfinding maintains so this is O(1)
    // instead of an O(65 000) scan.
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
