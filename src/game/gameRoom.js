// GameRoom: host-authoritative wrapper around the ECS world.
//
// • Owns the ECS world and registry.
// • Loads every module on construction (so terrains, prefabs, etc. are ready).
// • Generates the initial map, spawns one hero per player.
// • Exposes handleAction(playerId, action) for both the host (driving its own
//   inputs) and remote clients (forwarded by the host's net layer).
// • Produces JSON snapshots that the client can ingest verbatim.

import { createWorld, createEntity, addComponent, getComponent, getWorldState, forEachEntityWith, collectEntitiesWith } from './ecs/world.js';
import { createRegistry, getTerrain, spawnFromPrefab } from './ecs/registry.js';
import { loadAllModules } from './modules/moduleLoader.js';
import { recomputeFogForAllPlayers, flattenFog, inflateFog } from './map/fog.js';
import { generateMap, findSpawnHex } from './map/mapgen.js';
import { findPath } from './map/pathfinding.js';

const STARTING_HERO_ARCHETYPES = ['base/bob', 'base/alice'];
const MAP_RADIUS = 12;
const MIN_SPAWN_SEPARATION = 6;

export class GameRoom {
  // Pass any pre-built asset loader so modules can pull textures out of it.
  // `broadcast` is invoked whenever world state changes that clients should
  // see; for host-local play it can be a no-op.
  constructor({ assets, broadcast, log }) {
    this.world = createWorld();
    this.registry = createRegistry();
    this.assets = assets;
    this.broadcast = broadcast ?? (() => {});
    this.log = log ?? (() => {});
    this.players = [];      // [{ playerId, name }]
    this.started = false;
    this.currentPlayerIndex = 0;
    this.turnNumber = 1;
    this.seed = Math.floor(Math.random() * 1_000_000);

    loadAllModules({ world: this.world, registry: this.registry, assets: this.assets });

    // Initialize the world-state singleton with bookkeeping.
    const stateEntityId = getWorldState(this.world);
    addComponent(this.world, stateEntityId, 'WorldState', {
      playerOrder: [],
      currentPlayerIndex: 0,
      turnNumber: 1,
      seed: this.seed,
      mapRadius: MAP_RADIUS,
      fogByPlayer: {},
      phase: 'lobby',
    });
  }

  // ── Lobby plumbing (called by host's net code) ────────────────────────
  addPlayer(playerId, name) {
    if (this.players.some(p => p.playerId === playerId)) return;
    this.players.push({ playerId, name });
  }
  removePlayer(playerId) {
    this.players = this.players.filter(p => p.playerId !== playerId);
  }

  // Build the map, place heroes, mark fog. Called once when the host clicks
  // "Start game".
  startGame() {
    if (this.started) return;
    this.started = true;

    const tiles = generateMap(this.world, this.registry, {
      radius: MAP_RADIUS,
      seed: this.seed,
      tilePrefabId: 'base/tile',
    });

    const takenSpawns = [];
    const playerCount = this.players.length;
    // Spread spawns around a circle of radius MAP_RADIUS-2 so heroes start far apart.
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex++) {
      const player = this.players[playerIndex];
      const angle = (playerIndex / playerCount) * Math.PI * 2;
      const ringRadius = MAP_RADIUS - 2;
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

  // ── Snapshot wire format ──────────────────────────────────────────────
  buildSnapshot() {
    const componentsByName = {};
    for (const [name, store] of this.world.componentStores) {
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
    return {
      players: this.players,
      nextEntityId: this.world.nextEntityId,
      entityIds: Array.from(this.world.entities),
      components: componentsByName,
    };
  }
  publishSnapshot() {
    this.broadcast({ type: 'snapshot', snapshot: this.buildSnapshot() });
  }

  // Restore world state from a host's snapshot (client side).
  static applySnapshot(world, registry, snapshot) {
    world.nextEntityId = snapshot.nextEntityId;
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
  }

  // ── Actions ───────────────────────────────────────────────────────────
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
    if (!path) {
      movement.plannedPath = null;
      this.publishSnapshot();
      return;
    }
    movement.plannedPath = { steps: path.steps };
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

    // Reset movement for the player whose turn just started.
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
    let foundTerrain = null;
    forEachEntityWith(this.world, ['Tile'], (entityId, tile) => {
      if (tile.q === q && tile.r === r) foundTerrain = tile.terrainId;
    });
    return foundTerrain;
  }
}
