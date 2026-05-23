// GameRoom: host-authoritative wrapper around the ECS world.
//
// Wire protocol (see protocol.js):
//   • init_snapshot   — full state (including tiles), sent on connect or
//                       after a resync request.
//   • delta           — change ops + triggered events, after each host action.
//   • state_hash      — FNV-1a of canonical world state, sent right after each delta.
//   • players_changed — roster updates (join, leave, name-matched reconnect).
//
// Map generation runs in three explicit passes inside startNewGame():
//   Pass 1 — base terrain (deep-ocean / plains / rocky-hills) from perlin
//   Pass 2 — biome anchors: castles (one per player + neutrals up to max),
//            plus additional biome anchors in the gaps, then per-tile
//            assignment to nearest anchor within its radius
//   Pass 3 — decoration: each biome's registered decorator paints its
//            assigned hexes; the base decorator fills the gaps
//
// The host's GameRoom mutates state through the ECS's tracked helpers
// (see ecs/world.js), draining world.pendingChanges into deltas after each
// handler. Persistence to localStorage runs after every delta.

import {
  createWorld, createEntity, addComponent, getComponent, hasComponent, getWorldState,
  forEachEntityWith, collectEntitiesWith, setChangeRecording, consumePendingChanges,
  setComponentTracked, patchComponentTracked, createTrackedEntity,
  destroyTrackedEntity, destroyEntity,
} from './ecs/world.js';
import { createRegistry, getTerrain, spawnFromPrefab, getKingdom, listKingdoms } from './ecs/registry.js';
import { loadAllModules } from './modules/moduleLoader.js';
import {
  recomputeFogForAllPlayers, ensurePlayerFogInitialised,
  flattenFog, inflateFog,
} from './map/fog.js';
import { generateMap } from './map/mapgen.js';
import { findPath, invalidateTileIndex } from './map/pathfinding.js';
import { collectTraversalModes, resolveTerrainCost, resolveWorkableCost } from './ecs/traversal.js';
import { hexKey, hexDistance, hexesInRadius, HEX_DIRECTIONS } from './map/hex.js';
import { createSeededNoise2D, fractalNoise2D } from './map/perlin.js';
import { hashWorld, MESSAGE_KINDS } from './protocol.js';
import { writeSave, newSaveId } from './persistence.js';

// Fallback hero archetype pool, used when a kingdom doesn't supply enough
// hero ids of its own (or when no kingdom resolved at all).
const STARTING_HERO_ARCHETYPES = ['base/bob', 'base/alice', 'base/john', 'base/ringo'];
// Each faction starts with exactly one castle and one hero — the player
// picks both in the lobby. Kingdom-level "extra hero" bonuses are intentionally
// no longer honoured; a single hero is part of the starting contract.
const HEROES_PER_PLAYER = 1;
const DEFAULT_MAP_DIMENSION = 64;
const STARTING_MOVEMENT_MAX = 50;
const DAYS_PER_WEEK = 7;
// Biome radius is derived from total biome count. Empirical trim — perfect
// circular packing isn't possible on a hex grid, and we want a visible gap
// of base-decorator territory between most biomes.
const CASTLE_RADIUS_PACK_FACTOR = 0.7;
const CASTLE_RADIUS_FLOOR = 5;
const ADDITIONAL_BIOME_MIN_SCALE = 0.5;
const ADDITIONAL_BIOME_MAX_SCALE = 2.0;
const ADDITIONAL_BIOME_PLACEMENT_ATTEMPTS = 60;

// Mountain walls that ring every biome. Each map rolls a closure density in
// [BIOME_WALL_MIN, BIOME_WALL_MAX]; unassigned hexes adjacent to any biome
// then sample a fractal noise field, and tiles whose noise sample falls
// below the density become 'mountain'. 0.5 → roughly half the perimeter is
// mountain (most open); 0.9 → roughly nine in ten (most closed).
const BIOME_WALL_MIN = 0.5;
const BIOME_WALL_MAX = 0.9;
const BIOME_WALL_NOISE_SCALE = 0.22;
// Local thickness range — each hex samples a slow noise field that decides
// how far from the biome boundary the wall reaches at that point. The same
// threshold applies on both sides, so total band width varies between
// 2 * MIN and 2 * MAX hexes across the map (segments of thick range
// alternating with passable saddles).
const BIOME_WALL_THICKNESS_MIN = 1;
const BIOME_WALL_THICKNESS_MAX = 3;
const BIOME_WALL_THICKNESS_NOISE_SCALE = 0.06;
// Coast wall — a biome's land tile that sits adjacent to ocean has a
// chance to become its kingdom's mountain terrain. Capped at 1 hex deep
// (the shoreline rim only) and rolled at its own lower density so cliffs
// read as occasional headlands, not a continuous sea wall.
const BIOME_COAST_DENSITY = 0.4;

// Road-carver cost constants. The inter-biome carver picks the lowest-cost
// path through workable terrain by default; the water cost lets it route
// along the coast at a small premium; the unworkable cost is a last-resort
// chisel through bramble / mountain cliff (the user spec puts this at 1000).
const ROAD_WATER_COST = 2;
const ROAD_UNWORKABLE_COST = 1000;
const DEFAULT_BIOME_BASE_TERRAIN_ID = 'plains';

const DEFAULT_BIOME_SETTINGS = {
  minCastles: 2,
  maxCastles: 2,
  minAdditionalBiomes: 0,
  maxAdditionalBiomes: 2,
};

function randomInt(low, high) {
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export class GameRoom {
  constructor({ assets, mapSize, biomeSettings, terrainThresholds, broadcast, sendTo, log }) {
    this.world = createWorld();
    this.registry = createRegistry();
    this.assets = assets;
    this.broadcast = broadcast ?? (() => {});
    this.sendTo = sendTo ?? ((_id, _msg) => {});
    this.log = log ?? (() => {});

    // Map dimensions are baked in at construction. For fresh games the
    // lobby supplies a size; for loadFromSave() the saved snapshot overrides
    // these in the load path. Default to a small map so a forgotten/unset
    // size doesn't dump the user back on a 65k-tile slab.
    this.mapWidth = mapSize?.width ?? DEFAULT_MAP_DIMENSION;
    this.mapHeight = mapSize?.height ?? DEFAULT_MAP_DIMENSION;
    this.biomeSettings = { ...DEFAULT_BIOME_SETTINGS, ...(biomeSettings ?? {}) };
    this.terrainThresholds = {
      seaThreshold: terrainThresholds?.seaThreshold ?? 0.40,
      mountainThreshold: terrainThresholds?.mountainThreshold ?? 0.725,
    };

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
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
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
  //
  // `options` (all optional):
  //   kingdomId  — selected kingdom id, or null to let the host pick at start.
  //   isComputer — true if the host owns this slot's actions (CPU player).
  addPlayer(connectingPlayerId, name, profile = null, options = {}) {
    const { kingdomId = null, heroId = null, isComputer = false } = options;
    // Reconnect / re-announce calls (e.g. peer rejoining a saved game) should
    // never flip the CPU flag on a slot that already exists. We only honour
    // `isComputer` when creating a fresh slot below.
    const reusableSlot = this.players.find(p => !p.connected && p.name === name);
    if (reusableSlot) {
      // Map the saved hero(s) from the old id to the new id.
      remapOwnership(this.world, reusableSlot.playerId, connectingPlayerId);
      remapFog(this.world, reusableSlot.playerId, connectingPlayerId);
      remapPlayerOrder(this.world, reusableSlot.playerId, connectingPlayerId);
      reusableSlot.originalPlayerId = reusableSlot.playerId;
      reusableSlot.playerId = connectingPlayerId;
      reusableSlot.connected = true;
      if (profile) reusableSlot.profile = profile;
      if (kingdomId !== undefined) reusableSlot.kingdomId = kingdomId;
      if (heroId !== undefined) reusableSlot.heroId = heroId;
      this._publishPlayersChanged();
      return connectingPlayerId;
    }
    const existing = this.players.find(p => p.playerId === connectingPlayerId);
    if (existing) {
      if (profile) existing.profile = profile;
      if (kingdomId !== undefined) existing.kingdomId = kingdomId;
      if (heroId !== undefined) existing.heroId = heroId;
      return connectingPlayerId;
    }
    this.players.push({
      playerId: connectingPlayerId,
      name,
      profile,
      kingdomId,
      heroId,
      isComputer,
      connected: true,
      originalPlayerId: null,
    });
    this._publishPlayersChanged();
    return connectingPlayerId;
  }

  // Late update — a peer changed their flag/name in the lobby after joining.
  // The roster object is shared with the persistence layer + the wire so we
  // re-publish whenever a player edits in place.
  updatePlayerProfile(playerId, profile) {
    const slot = this.players.find(p => p.playerId === playerId);
    if (!slot) return;
    slot.profile = profile ?? slot.profile;
    this._publishPlayersChanged();
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

    // Resolve each player's kingdom *once* before the spawn passes — a null
    // kingdomId in the lobby payload means "host picks randomly", so we lock
    // it in here. Spawn code reads `player.resolvedKingdomId` from this point
    // forward.
    this._resolvePlayerKingdoms();

    // PASS 1 — base terrain (deep-ocean / plains / rocky-hills) from perlin
    const tiles = this._passOneTerrain();

    // PASS 2 — castles + additional biome anchors + tile→anchor assignment
    const biomeContext = this._passTwoBiomes(tiles);

    // PASS 2.5 — biome perimeter walls. Unassigned hexes adjacent to a
    // biome get rolled against a fractal noise field; tiles that pass
    // become 'mountain', sealing the biome off with a partially-broken
    // ring. Closure density is rolled per-map within [50%, 90%].
    this._passBiomeWalls(biomeContext);

    // Heroes spawn between passes so the decorator can avoid hero hexes.
    this._spawnHeroesAtCastles(biomeContext.ownedCastles);

    // PASS 3 — decorators (biome + base + remaining world spawners)
    this._passThreeDecorate(biomeContext);

    // PASS 4 — intra-biome roads. Carve a road from each biome anchor to
    // every POI inside the biome, reducing workable terrain to the biome's
    // base terrain along the way. Cumulative — each path sees the terrain
    // after the previous one was carved.
    this._passFourIntraBiomeRoads(biomeContext);

    // PASS 5 — inter-biome roads. Connect every castle to every other
    // castle via a land/sea route. Workable terrain (and sea hops at a
    // small premium) are preferred; bramble / mountain cliffs are crossed
    // at ROAD_UNWORKABLE_COST per hex only as a last resort. Each pair's
    // path is computed AFTER the previous carve so road trunks merge.
    this._passFiveInterBiomeRoads(biomeContext);

    const stateEntityId = getWorldState(this.world);
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['playerOrder'],
      this.players.map(p => p.playerId));
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['currentPlayerIndex'], 0);
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['turnNumber'], 1);
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['phase'], 'playing');

    for (const player of this.players) ensurePlayerFogInitialised(this.world, player.playerId);
    recomputeFogForAllPlayers(this.world, this.registry);

    // Setup mutations are drained — clients pull the initial state from
    // init_snapshot, not deltas.
    consumePendingChanges(this.world);
    this._persistToLocalStorage();

    // If the very first player happens to be a CPU, end their turn(s) for
    // them — this re-uses the same chain that runs after every action.
    this._scheduleCpuTick();
  }

  // ── Pass 1 ──────────────────────────────────────────────────────────────
  _passOneTerrain() {
    const tiles = generateMap(this.world, this.registry, {
      width: this.mapWidth,
      height: this.mapHeight,
      seed: this.seed,
      tilePrefabId: 'base/tile',
      seaThreshold: this.terrainThresholds.seaThreshold,
      mountainThreshold: this.terrainThresholds.mountainThreshold,
    });
    invalidateTileIndex(this.world);
    return tiles;
  }

  // Resolve each player's kingdom up-front. Players who left it on
  // "Random" in the lobby get a kingdom assigned here from whatever modules
  // registered. If no kingdoms are registered at all, this stays null and
  // the spawn code falls back to its baked-in defaults.
  _resolvePlayerKingdoms() {
    const allKingdoms = listKingdoms(this.registry);
    if (allKingdoms.length === 0) {
      for (const player of this.players) player.resolvedKingdomId = null;
      return;
    }
    for (const player of this.players) {
      const requested = player.kingdomId;
      if (requested && getKingdom(this.registry, requested)) {
        player.resolvedKingdomId = requested;
      } else {
        const pick = allKingdoms[Math.floor(Math.random() * allKingdoms.length)];
        player.resolvedKingdomId = pick.id;
      }
    }
  }

  // ── Pass 2 ──────────────────────────────────────────────────────────────
  // Place every biome anchor (player castles, neutral castles, additional
  // anchors), then assign each tile to the nearest anchor whose radius
  // covers it. Tiles outside all radii go to the base decorator.
  _passTwoBiomes(tiles) {
    const numPlayers = this.players.length;
    const settings = this.biomeSettings;
    // Min castles can't drop below player count — every player gets one.
    const minCastles = Math.max(numPlayers, settings.minCastles);
    const maxCastles = Math.max(minCastles, settings.maxCastles);
    const totalCastles = randomInt(minCastles, maxCastles);
    const minAdditional = Math.max(0, settings.minAdditionalBiomes);
    const maxAdditional = Math.max(minAdditional, settings.maxAdditionalBiomes);
    const numAdditional = randomInt(minAdditional, maxAdditional);
    const biomeCount = Math.max(1, totalCastles + numAdditional);

    // Castle biome radius — derived from map area divided by total biome
    // count. We trim by the pack factor so neighbouring biomes don't fight
    // for territory and the base decorator gets visible gaps to fill.
    const mapArea = this.mapWidth * this.mapHeight;
    const castleRadius = Math.max(
      CASTLE_RADIUS_FLOOR,
      Math.floor(Math.sqrt(mapArea / Math.PI / biomeCount) * CASTLE_RADIUS_PACK_FACTOR),
    );
    const castleSeparation = Math.max(castleRadius * 2, 6);

    const tilesByKey = new Map();
    for (const t of tiles) tilesByKey.set(hexKey(t.q, t.r), t);
    const isWalkableLand = (q, r) => {
      const tile = tilesByKey.get(hexKey(q, r));
      if (!tile) return false;
      const terrain = getTerrain(this.registry, tile.terrainId);
      return resolveTerrainCost(terrain, ['Land']) != null;
    };

    const registeredKingdoms = listKingdoms(this.registry);
    // Castle prefab ids fall back to the first registered kingdom's castle
    // when a player's kingdom is null *and* no kingdoms exist at all
    // (legacy / test setups). Modules normally register at least one.
    if (registeredKingdoms.length === 0) {
      throw new Error('no kingdoms registered — at least one kingdom module must register a castle prefab');
    }

    // ── Owned castles ────────────────────────────────────────────────────
    const placedCastles = [];
    const ownedCastles = [];
    const ringRadius = Math.max(2, Math.min(this.mapWidth, this.mapHeight) / 2 - Math.max(4, castleRadius));
    for (let i = 0; i < numPlayers; i++) {
      const angle = (i / numPlayers) * Math.PI * 2;
      const preferred = {
        q: Math.round(Math.cos(angle) * ringRadius),
        r: Math.round(Math.sin(angle) * ringRadius),
      };
      const spawn = this._findCastleSpawn(tiles, isWalkableLand, preferred, castleSeparation, placedCastles);
      if (!spawn) { this.log('no castle spawn for player ' + this.players[i].playerId); continue; }
      const kingdom = getKingdom(this.registry, this.players[i].resolvedKingdomId)
        ?? registeredKingdoms[0];
      const castleEntityId = spawnFromPrefab(this.registry, kingdom.castlePrefabId, this.world, {
        q: spawn.q, r: spawn.r, playerId: this.players[i].playerId,
      });
      this._stampBiomeAnchor(castleEntityId, kingdom.primaryBiomeId, castleRadius);
      const record = {
        entityId: castleEntityId, q: spawn.q, r: spawn.r,
        radius: castleRadius, playerId: this.players[i].playerId, playerIndex: i,
        kingdomId: kingdom.id,
      };
      placedCastles.push(record);
      ownedCastles.push(record);
    }

    // ── Neutral castles (any beyond numPlayers) ─────────────────────────
    for (let i = 0; i < totalCastles - numPlayers; i++) {
      const spawn = this._findNeutralCastleSpawn(tiles, isWalkableLand, castleSeparation, placedCastles);
      if (!spawn) break;
      const kingdom = registeredKingdoms[Math.floor(Math.random() * registeredKingdoms.length)];
      const castleEntityId = spawnFromPrefab(this.registry, kingdom.castlePrefabId, this.world, {
        q: spawn.q, r: spawn.r,
      });
      this._stampBiomeAnchor(castleEntityId, kingdom.primaryBiomeId, castleRadius);
      placedCastles.push({
        entityId: castleEntityId, q: spawn.q, r: spawn.r,
        radius: castleRadius, playerId: null, kingdomId: kingdom.id,
      });
    }

    // ── Additional biome anchors ────────────────────────────────────────
    // Placed in tiles outside any castle's radius so they never overlap
    // castle biomes. Each anchor's decorator is drawn from kingdom secondary
    // biome ids — these are the "wild" biomes a kingdom contributes to the
    // map outside its own capital region.
    const placedAdditional = [];
    const secondaryDecoratorIds = registeredKingdoms
      .map(k => k.secondaryBiomeId)
      .filter(Boolean);
    if (secondaryDecoratorIds.length > 0) {
      for (let attempt = 0; attempt < ADDITIONAL_BIOME_PLACEMENT_ATTEMPTS && placedAdditional.length < numAdditional; attempt++) {
        const candidate = tiles[Math.floor(Math.random() * tiles.length)];
        if (!isWalkableLand(candidate.q, candidate.r)) continue;
        let valid = true;
        for (const c of placedCastles) {
          if (hexDistance({ q: candidate.q, r: candidate.r }, { q: c.q, r: c.r }) < castleRadius + 1) {
            valid = false; break;
          }
        }
        if (!valid) continue;
        for (const a of placedAdditional) {
          if (hexDistance({ q: candidate.q, r: candidate.r }, { q: a.q, r: a.r }) < Math.max(a.radius, castleRadius)) {
            valid = false; break;
          }
        }
        if (!valid) continue;
        const scale = ADDITIONAL_BIOME_MIN_SCALE + Math.random() * (ADDITIONAL_BIOME_MAX_SCALE - ADDITIONAL_BIOME_MIN_SCALE);
        const radius = Math.max(3, Math.floor(castleRadius * scale));
        const decoratorId = secondaryDecoratorIds[Math.floor(Math.random() * secondaryDecoratorIds.length)];
        const anchorEntityId = createEntity(this.world);
        addComponent(this.world, anchorEntityId, 'Position', { q: candidate.q, r: candidate.r });
        addComponent(this.world, anchorEntityId, 'BiomeAnchor', { decoratorId, radius });
        placedAdditional.push({ entityId: anchorEntityId, q: candidate.q, r: candidate.r, radius, decoratorId });
      }
    }

    // ── Tile assignment ─────────────────────────────────────────────────
    // Nearest anchor whose radius covers the tile wins. A castle just
    // outside an additional biome anchor's radius won't steal tiles
    // since the castle is too far; conversely additional biomes can't
    // intrude on castle territory because anchors are pre-separated.
    const allAnchors = [...placedCastles, ...placedAdditional];
    const biomeHexesByAnchor = new Map();
    for (const a of allAnchors) biomeHexesByAnchor.set(a.entityId, []);
    const unassignedHexes = [];

    forEachEntityWith(this.world, ['Tile'], (entityId, tile) => {
      let nearest = null;
      let nearestDist = Infinity;
      for (const a of allAnchors) {
        const d = hexDistance({ q: tile.q, r: tile.r }, { q: a.q, r: a.r });
        if (d <= a.radius && d < nearestDist) {
          nearest = a;
          nearestDist = d;
        }
      }
      if (nearest) {
        biomeHexesByAnchor.get(nearest.entityId).push({ entityId, q: tile.q, r: tile.r });
      } else {
        unassignedHexes.push({ entityId, q: tile.q, r: tile.r });
      }
    });

    return {
      castles: placedCastles,
      ownedCastles,
      additionalBiomes: placedAdditional,
      biomeHexesByAnchor,
      unassignedHexes,
      castleRadius,
    };
  }

  // ── Pass 2.5 ────────────────────────────────────────────────────────────
  // Wall the biomes off with mountains. Three things happen here, all
  // gated by the same per-map closure density and a shared fractal noise:
  //
  //   1. Boundary band. Hexes within `localThickness` of a biome boundary
  //      are wall candidates. localThickness comes from a slow noise field
  //      so the band naturally swells and tapers along the boundary
  //      (saddles + ridges, not a uniform ring). MIN/MAX rings on each
  //      side give a total band width of 2..6 hexes.
  //
  //   2. Coast walls. A biome land hex that touches ocean is a 1-thick
  //      coast candidate. Rolled against a lower density (BIOME_COAST_DENSITY)
  //      so cliffs read as occasional headlands rather than a continuous
  //      sea wall.
  //
  //   3. Themed terrain. Each candidate's nearest biome anchor's kingdom
  //      contributes a `wallTerrainId` — pipe-dream's coast / boundary uses
  //      pastry-mountains; kingdoms without an override fall back to base
  //      'mountain'. Outside-biome candidates inherit the nearest biome's
  //      mountain art so the outer ring stays on theme.
  _passBiomeWalls(biomeContext) {
    const { biomeHexesByAnchor, unassignedHexes } = biomeContext;
    if (!biomeHexesByAnchor || biomeHexesByAnchor.size === 0) return;

    const density = BIOME_WALL_MIN + Math.random() * (BIOME_WALL_MAX - BIOME_WALL_MIN);
    const closureNoise = createSeededNoise2D(this.seed + 8849);
    const thicknessNoise = createSeededNoise2D(this.seed + 12347);

    // Fast lookup of every hex that belongs to any biome, plus a reverse
    // map back to its anchor entity for kingdom-aware terrain choice.
    const biomeHexKeys = new Set();
    const hexKeyToAnchor = new Map();
    const allBiomeHexes = [];
    for (const [anchorEntityId, hexes] of biomeHexesByAnchor.entries()) {
      for (const hex of hexes) {
        const key = hexKey(hex.q, hex.r);
        biomeHexKeys.add(key);
        hexKeyToAnchor.set(key, anchorEntityId);
        allBiomeHexes.push(hex);
      }
    }

    // Tile index for quick "is my neighbour ocean?" checks — built once,
    // dropped at end of pass.
    const tileByKey = new Map();
    forEachEntityWith(this.world, ['Tile'], (_id, tile) => {
      tileByKey.set(hexKey(tile.q, tile.r), tile);
    });

    // Resolve each anchor's wall terrain by following BiomeAnchor →
    // decoratorId → kingdom. Kingdoms without `wallTerrainId` fall back to
    // base 'mountain'. Reverse map lets additional-biome anchors share
    // their parent kingdom's theme.
    const kingdomByDecoratorId = new Map();
    for (const kingdom of listKingdoms(this.registry)) {
      if (kingdom.primaryBiomeId) kingdomByDecoratorId.set(kingdom.primaryBiomeId, kingdom);
      if (kingdom.secondaryBiomeId) kingdomByDecoratorId.set(kingdom.secondaryBiomeId, kingdom);
    }
    const wallTerrainByAnchor = new Map();
    for (const anchorEntityId of biomeHexesByAnchor.keys()) {
      const biomeAnchor = getComponent(this.world, anchorEntityId, 'BiomeAnchor');
      const kingdom = biomeAnchor ? kingdomByDecoratorId.get(biomeAnchor.decoratorId) : null;
      wallTerrainByAnchor.set(anchorEntityId, kingdom?.wallTerrainId ?? 'mountain');
    }

    const localThickness = (q, r) => {
      const sample = fractalNoise2D(
        thicknessNoise,
        q * BIOME_WALL_THICKNESS_NOISE_SCALE,
        r * BIOME_WALL_THICKNESS_NOISE_SCALE,
        3, 0.55, 2.0,
      );
      const normalised = (sample + 1) * 0.5;
      return Math.round(
        BIOME_WALL_THICKNESS_MIN + normalised * (BIOME_WALL_THICKNESS_MAX - BIOME_WALL_THICKNESS_MIN),
      );
    };
    const isOceanTerrain = (terrainId) =>
      terrainId === 'deep-ocean' || terrainId === 'shallow-ocean';
    const closureGate = (q, r, gateDensity) => {
      const sample = fractalNoise2D(
        closureNoise,
        q * BIOME_WALL_NOISE_SCALE,
        r * BIOME_WALL_NOISE_SCALE,
        3, 0.55, 2.0,
      );
      return ((sample + 1) * 0.5) < gateDensity;
    };

    // Walk every hex on the map once. The candidate state for each hex is
    // determined by its distance to the nearest opposite-type neighbour
    // and (for biome land hexes) whether it touches ocean.
    const considerHex = (hex, isBiome) => {
      const tile = tileByKey.get(hexKey(hex.q, hex.r));
      if (!tile) return;
      if (tile.terrainId !== 'plains' && tile.terrainId !== 'rocky-hills') return;

      let nearestOppositeDistance = Infinity;
      let nearestBiomeAnchor = isBiome ? hexKeyToAnchor.get(hexKey(hex.q, hex.r)) : null;
      let nearestBiomeDistance = Infinity;
      for (const ringHex of hexesInRadius(hex.q, hex.r, BIOME_WALL_THICKNESS_MAX)) {
        if (ringHex.q === hex.q && ringHex.r === hex.r) continue;
        const d = hexDistance({ q: hex.q, r: hex.r }, ringHex);
        const inBiome = biomeHexKeys.has(hexKey(ringHex.q, ringHex.r));
        if (inBiome !== isBiome && d < nearestOppositeDistance) nearestOppositeDistance = d;
        if (!isBiome && inBiome && d < nearestBiomeDistance) {
          nearestBiomeDistance = d;
          nearestBiomeAnchor = hexKeyToAnchor.get(hexKey(ringHex.q, ringHex.r));
        }
      }

      const thickness = localThickness(hex.q, hex.r);
      const inBoundaryBand = nearestOppositeDistance <= thickness;

      // Coast rule applies only to biome land hexes adjacent to ocean.
      let isCoast = false;
      if (isBiome) {
        for (const direction of HEX_DIRECTIONS) {
          const neighbour = tileByKey.get(hexKey(hex.q + direction.q, hex.r + direction.r));
          if (neighbour && isOceanTerrain(neighbour.terrainId)) { isCoast = true; break; }
        }
      }

      let qualifies = false;
      if (inBoundaryBand && closureGate(hex.q, hex.r, density)) qualifies = true;
      else if (isCoast && closureGate(hex.q, hex.r, BIOME_COAST_DENSITY)) qualifies = true;
      if (!qualifies) return;

      const wallTerrain = (nearestBiomeAnchor && wallTerrainByAnchor.get(nearestBiomeAnchor))
        ?? 'mountain';
      tile.terrainId = wallTerrain;
    };

    for (const hex of allBiomeHexes) considerHex(hex, true);
    if (unassignedHexes) {
      for (const hex of unassignedHexes) considerHex(hex, false);
    }
  }

  // Override the BiomeAnchor's decorator id and radius post-spawn. The
  // castle prefab itself bakes in a default decoratorId, but the kingdom
  // picker means the runtime selection wins.
  _stampBiomeAnchor(anchorEntityId, decoratorId, radius) {
    const anchor = getComponent(this.world, anchorEntityId, 'BiomeAnchor');
    if (!anchor) return;
    if (decoratorId) anchor.decoratorId = decoratorId;
    if (typeof radius === 'number') anchor.radius = radius;
  }

  _findCastleSpawn(tiles, isWalkableLand, preferred, separation, placed) {
    // Closest walkable land hex to `preferred` that's `separation` away
    // from every already-placed castle.
    const sorted = tiles.slice().sort((a, b) => {
      return hexDistance({ q: a.q, r: a.r }, preferred) - hexDistance({ q: b.q, r: b.r }, preferred);
    });
    for (const t of sorted) {
      if (!isWalkableLand(t.q, t.r)) continue;
      let ok = true;
      for (const c of placed) {
        if (hexDistance({ q: t.q, r: t.r }, { q: c.q, r: c.r }) < separation) { ok = false; break; }
      }
      if (ok) return { q: t.q, r: t.r };
    }
    return null;
  }

  _findNeutralCastleSpawn(tiles, isWalkableLand, separation, placed) {
    // Random walkable land hex separated from every other castle.
    const candidates = tiles.filter(t => {
      if (!isWalkableLand(t.q, t.r)) return false;
      for (const c of placed) {
        if (hexDistance({ q: t.q, r: t.r }, { q: c.q, r: c.r }) < separation) return false;
      }
      return true;
    });
    if (candidates.length === 0) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return { q: pick.q, r: pick.r };
  }

  // ── Heroes ──────────────────────────────────────────────────────────────
  _spawnHeroesAtCastles(ownedCastles) {
    // Build a quick lookup of tiles and per-hex overrides so the spawn
    // search can skip bramble walls without re-querying the world each step.
    const tilesByKey = new Map();
    forEachEntityWith(this.world, ['Tile'], (_id, tile) => tilesByKey.set(hexKey(tile.q, tile.r), tile));
    const overridesByKey = new Set();
    forEachEntityWith(this.world, ['TerrainOverride', 'Position'], (_id, _o, position) => {
      overridesByKey.add(hexKey(position.q, position.r));
    });

    const heroTakenKeys = new Set();
    for (const castle of ownedCastles) {
      const kingdom = getKingdom(this.registry, castle.kingdomId);
      const spawns = this._findHeroSpawnsAroundCastle(castle, tilesByKey, overridesByKey, heroTakenKeys, HEROES_PER_PLAYER);
      for (let i = 0; i < spawns.length; i++) {
        this._spawnPlayerHero(castle.playerId, castle.playerIndex, i, spawns[i], kingdom);
        heroTakenKeys.add(hexKey(spawns[i].q, spawns[i].r));
      }
    }
  }

  _findHeroSpawnsAroundCastle(castle, tilesByKey, overridesByKey, takenKeys, count) {
    // Walk outward in expanding hex rings until enough valid spawn tiles
    // are found. Skip the castle's bramble footprint (TerrainOverride
    // hexes) and tiles already claimed by other heroes.
    const out = [];
    for (let radius = 1; radius <= 4 && out.length < count; radius++) {
      const ring = hexesInRadius(castle.q, castle.r, radius).filter(h =>
        hexDistance({ q: h.q, r: h.r }, { q: castle.q, r: castle.r }) === radius,
      );
      for (const hex of ring) {
        const key = hexKey(hex.q, hex.r);
        if (out.some(o => o.q === hex.q && o.r === hex.r)) continue;
        if (takenKeys.has(key)) continue;
        if (overridesByKey.has(key)) continue;
        const tile = tilesByKey.get(key);
        if (!tile) continue;
        const terrain = getTerrain(this.registry, tile.terrainId);
        if (resolveTerrainCost(terrain, ['Land']) == null) continue;
        out.push({ q: hex.q, r: hex.r });
        if (out.length >= count) break;
      }
    }
    return out;
  }

  // ── Pass 3 ──────────────────────────────────────────────────────────────
  _passThreeDecorate(biomeContext) {
    const { biomeHexesByAnchor, unassignedHexes } = biomeContext;

    // occupiedHexes tracks every claim already in the world before
    // decorators run — castle anchors, bramble footprints, hero hexes. The
    // base + biome decorators read from this and add their own claims.
    const occupiedHexes = new Set();
    forEachEntityWith(this.world, ['Position', 'MapObject'], (_id, _mo, position) => {
      occupiedHexes.add(hexKey(position.q, position.r));
    });
    forEachEntityWith(this.world, ['Position', 'TerrainOverride'], (_id, _to, position) => {
      occupiedHexes.add(hexKey(position.q, position.r));
    });
    forEachEntityWith(this.world, ['Position', 'Hero'], (_id, _h, position) => {
      occupiedHexes.add(hexKey(position.q, position.r));
    });

    // Biome decorators — each anchor gets its assigned hexes painted by
    // its registered decorator. Decorators mutate Tile.terrainId in-place
    // and may spawnFromPrefab into the world.
    forEachEntityWith(this.world, ['BiomeAnchor', 'Position'], (anchorEntityId, biomeAnchor, position) => {
      const decorator = this.registry.biomeDecorators.get(biomeAnchor.decoratorId);
      if (!decorator) return;
      const biomeHexes = biomeHexesByAnchor.get(anchorEntityId) ?? [];
      decorator.decorate({
        world: this.world,
        registry: this.registry,
        anchorEntityId,
        anchorQ: position.q,
        anchorR: position.r,
        biomeHexes,
        mapWidth: this.mapWidth,
        mapHeight: this.mapHeight,
        seed: this.seed,
        occupiedHexes,
      });
    });

    // Base decorator — refines the tiles no biome claimed.
    const baseDecorator = this.registry.baseDecorator;
    if (baseDecorator) {
      baseDecorator.decorate({
        world: this.world,
        registry: this.registry,
        hexes: unassignedHexes,
        mapWidth: this.mapWidth,
        mapHeight: this.mapHeight,
        seed: this.seed,
      });
    }

    // Old-style world spawners — still supported for content that doesn't
    // care about biomes. They see the post-decoration world.
    for (const spawnerFn of this.registry.worldSpawners ?? []) {
      spawnerFn({
        world: this.world,
        registry: this.registry,
        mapWidth: this.mapWidth,
        mapHeight: this.mapHeight,
        seed: this.seed,
        occupiedHexes,
      });
    }

    invalidateTileIndex(this.world);
  }

  // ── Pass 4 ──────────────────────────────────────────────────────────────
  // Carve workable roads inside each biome from its anchor to every POI.
  // The carver picks the least-cost workable-terrain path and reduces each
  // tile along it to the biome's declared base terrain. Cumulative across
  // POIs so paths inside the same biome share trunks.
  _passFourIntraBiomeRoads(biomeContext) {
    const { biomeHexesByAnchor } = biomeContext;
    // hex → biome's base terrain id, for any hex that sits in a biome.
    const biomeBaseByHex = this._buildBiomeBaseByHexMap(biomeContext);
    biomeContext.biomeBaseByHex = biomeBaseByHex;

    const intraBiomeCostFn = (terrain /*, q, r */) => {
      // Roads inside a biome are workable-only — water and unworkable
      // tiles are off-limits for the intra-biome carver.
      return resolveWorkableCost(terrain);
    };

    forEachEntityWith(this.world, ['BiomeAnchor', 'Position'], (anchorEntityId, _anchor, anchorPos) => {
      const biomeHexes = biomeHexesByAnchor.get(anchorEntityId) ?? [];
      if (biomeHexes.length === 0) return;
      const biomeHexKeys = new Set(biomeHexes.map(h => hexKey(h.q, h.r)));
      const baseTerrainId = biomeBaseByHex.get(hexKey(anchorPos.q, anchorPos.r))
        ?? DEFAULT_BIOME_BASE_TERRAIN_ID;
      const poiHexes = this._collectPoiHexesIn(biomeHexKeys, anchorEntityId);
      const center = { q: anchorPos.q, r: anchorPos.r };
      for (const goal of poiHexes) {
        const path = findPath(this.world, this.registry, center, goal, {
          costFn: intraBiomeCostFn,
        });
        if (!path) continue;
        this._carveRoadAlong(path.steps, biomeBaseByHex);
        invalidateTileIndex(this.world);
      }
    });
  }

  // ── Pass 5 ──────────────────────────────────────────────────────────────
  // Connect every castle to every other castle via a single connected
  // network of roads. We connect each castle to its nearest already-placed
  // castle (MST-style) which gives all-pairs reachability transitively.
  // Cost function prefers workable land, then sea, then unworkable tiles
  // at the major penalty.
  _passFiveInterBiomeRoads(biomeContext) {
    const biomeBaseByHex = biomeContext.biomeBaseByHex
      ?? this._buildBiomeBaseByHexMap(biomeContext);

    const castles = [];
    forEachEntityWith(this.world, ['Castle', 'Position'], (entityId, _castle, position) => {
      castles.push({ entityId, q: position.q, r: position.r });
    });
    if (castles.length < 2) return;

    const interBiomeCostFn = (terrain /*, q, r */) => {
      if (!terrain) return null;
      const workable = resolveWorkableCost(terrain);
      if (workable != null) return workable;
      // Sea hop — small premium so we route along land when sane but the
      // carver naturally hugs the coast and uses water bridges when
      // they're shorter than walking the long way round.
      if (terrain.components?.PassableByWater) return ROAD_WATER_COST;
      // Bramble / mountain cliff / anything else with no workable + no
      // water passage. Allowed only as a last resort, at major cost.
      return ROAD_UNWORKABLE_COST;
    };

    // Connect each castle (in placement order) to its nearest predecessor.
    // The first castle is the network seed.
    const connected = [castles[0]];
    for (let i = 1; i < castles.length; i++) {
      const next = castles[i];
      let nearest = connected[0];
      let nearestDist = hexDistance(next, nearest);
      for (let j = 1; j < connected.length; j++) {
        const d = hexDistance(next, connected[j]);
        if (d < nearestDist) { nearest = connected[j]; nearestDist = d; }
      }
      const path = findPath(this.world, this.registry, nearest, next, {
        costFn: interBiomeCostFn,
      });
      if (path) {
        this._carveRoadAlong(path.steps, biomeBaseByHex);
        invalidateTileIndex(this.world);
      } else {
        this.log('pass5: no inter-biome path between castles ' + nearest.entityId + ' and ' + next.entityId);
      }
      connected.push(next);
    }
  }

  // Build hex → base-terrain-id map for every hex inside any biome anchor.
  // The carver consults this when reducing a tile back to "the local
  // biome's base". Hexes outside any biome aren't in the map; callers
  // default to DEFAULT_BIOME_BASE_TERRAIN_ID.
  _buildBiomeBaseByHexMap(biomeContext) {
    const out = new Map();
    for (const [anchorEntityId, hexes] of biomeContext.biomeHexesByAnchor) {
      const biomeAnchor = getComponent(this.world, anchorEntityId, 'BiomeAnchor');
      const decorator = biomeAnchor
        ? this.registry.biomeDecorators.get(biomeAnchor.decoratorId)
        : null;
      const baseTerrainId = decorator?.baseTerrainId ?? DEFAULT_BIOME_BASE_TERRAIN_ID;
      for (const hex of hexes) out.set(hexKey(hex.q, hex.r), baseTerrainId);
    }
    return out;
  }

  // Collect goal hexes for intra-biome roads — POIs (MapObject entities)
  // and BiomeAnchor entities that have a MapObject sitting on them. We
  // exclude the anchor itself (it's the start point) and any POI whose
  // tile is unworkable (a fish school on water has no road to it).
  _collectPoiHexesIn(biomeHexKeys, anchorEntityId) {
    const out = [];
    const seen = new Set();
    forEachEntityWith(this.world, ['MapObject', 'Position'], (entityId, _mo, position) => {
      if (entityId === anchorEntityId) return;
      const key = hexKey(position.q, position.r);
      if (!biomeHexKeys.has(key)) return;
      if (seen.has(key)) return;
      const terrain = this._effectiveTerrainAt(position.q, position.r);
      if (resolveWorkableCost(terrain) == null) return;
      seen.add(key);
      out.push({ q: position.q, r: position.r });
    });
    return out;
  }

  // Reduce every step on the path to the local biome's base terrain. Water
  // tiles are left as-is (you sail across them). TerrainOverride entities
  // sitting on a carved tile are destroyed — the road is now visible and
  // passable where bramble or other override used to stand.
  _carveRoadAlong(steps, biomeBaseByHex) {
    if (!steps || steps.length === 0) return;
    // Build a fast lookup of overrides keyed by hex so we can clear them
    // without iterating the world per step.
    const overrideEntitiesByKey = new Map();
    forEachEntityWith(this.world, ['TerrainOverride', 'Position'], (entityId, _override, position) => {
      overrideEntitiesByKey.set(hexKey(position.q, position.r), entityId);
    });
    // Tiles indexed by hex for direct mutation.
    const tilesByKey = new Map();
    forEachEntityWith(this.world, ['Tile'], (entityId, tile) => {
      tilesByKey.set(hexKey(tile.q, tile.r), { entityId, tile });
    });

    for (const step of steps) {
      const key = hexKey(step.q, step.r);
      const tileEntry = tilesByKey.get(key);
      if (!tileEntry) continue;
      const baseTerrain = getTerrain(this.registry, tileEntry.tile.terrainId);
      // Water tiles stay as water — the sail portion of the road needs them.
      if (baseTerrain?.components?.PassableByWater) continue;
      const baseTerrainId = biomeBaseByHex.get(key) ?? DEFAULT_BIOME_BASE_TERRAIN_ID;
      // If the carve clears anything (override or non-base terrain), do it.
      const overrideEntityId = overrideEntitiesByKey.get(key);
      if (overrideEntityId != null) {
        destroyEntity(this.world, overrideEntityId);
        overrideEntitiesByKey.delete(key);
      }
      if (tileEntry.tile.terrainId !== baseTerrainId) {
        tileEntry.tile.terrainId = baseTerrainId;
      }
    }
  }

  loadFromSave(savedSnapshot) {
    if (this.started) return;
    this.started = true;
    this.saveId = savedSnapshot.id ?? this.saveId;
    this.seed = savedSnapshot.seed;
    this.mapWidth = savedSnapshot.mapWidth ?? this.mapWidth;
    this.mapHeight = savedSnapshot.mapHeight ?? this.mapHeight;

    setChangeRecording(this.world, false);

    // The snapshot carries the full tile set now — biome decoration is
    // not trivially deterministic so we just trust the saved state.
    this.world.nextEntityId = savedSnapshot.nextEntityId;
    this.world.entities = new Set(savedSnapshot.entityIds);
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
    invalidateTileIndex(this.world);

    this.players = (savedSnapshot.players ?? []).map(savedPlayer => ({
      playerId: savedPlayer.playerId,
      name: savedPlayer.name,
      connected: false,
      profile: savedPlayer.profile ?? null,
      kingdomId: savedPlayer.kingdomId ?? null,
      heroId: savedPlayer.heroId ?? savedPlayer.profile?.heroId ?? null,
      isComputer: !!savedPlayer.isComputer,
      originalPlayerId: savedPlayer.playerId,
      vanquished: !!savedPlayer.vanquished,
    }));

    setChangeRecording(this.world, true);
  }

  _spawnPlayerHero(playerId, playerIndex, heroSlotIndex, spawn, kingdom) {
    // Setup-time spawn — mutations during startNewGame() are discarded from
    // the change buffer because clients pull the initial state from
    // init_snapshot, not deltas. We use the registry prefab directly here.
    //
    // Archetype resolution order:
    //   1. The player's lobby-picked heroId, if it belongs to this kingdom's pool
    //   2. A random pick from the kingdom's heroIds
    //   3. The base/* fallback pool (legacy / kingdomless setups)
    const player = this.players.find(p => p.playerId === playerId);
    const kingdomPool = (kingdom?.heroIds && kingdom.heroIds.length) ? kingdom.heroIds : null;
    let archetypeId = null;
    if (player?.heroId && kingdomPool?.includes(player.heroId)) {
      archetypeId = player.heroId;
    } else if (kingdomPool) {
      archetypeId = kingdomPool[Math.floor(Math.random() * kingdomPool.length)];
    } else {
      archetypeId = STARTING_HERO_ARCHETYPES[heroSlotIndex % STARTING_HERO_ARCHETYPES.length];
    }
    const archetype = this.registry.heroes.get(archetypeId);
    if (!archetype) throw new Error('missing hero archetype: ' + archetypeId);
    const bonus = kingdom?.bonus ?? {};
    const movementMax = STARTING_MOVEMENT_MAX + (bonus.movementMaxBonus ?? 0);
    const heroParams = {
      ...archetype.defaults,
      name: archetype.name,
      playerId,
      q: spawn.q,
      r: spawn.r,
      movementMax,
      movementLeft: movementMax,
    };
    // Hero model resolution: archetype's own modelKey wins; otherwise fall
    // back to the kingdom's defaultHeroModelKey; otherwise the prefab's
    // baked-in 'base/hero.glb' takes over inside spawnFromPrefab.
    if (heroParams.modelKey == null && kingdom?.defaultHeroModelKey) {
      heroParams.modelKey = kingdom.defaultHeroModelKey;
    }
    return spawnFromPrefab(this.registry, archetype.prefabId, this.world, heroParams);
  }

  // ── Snapshot (full init) ───────────────────────────────────────────────
  buildInitSnapshot() {
    // Ship every component store, including Tile. Biome decoration mutates
    // terrain in ways that aren't trivially deterministic across host and
    // client, so the snapshot just carries the host's authoritative state.
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
      seq: this.sequenceNumber,
      nextEntityId: this.world.nextEntityId,
      entityIds: Array.from(this.world.entities),
      components: componentsByName,
      seed: this.seed,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
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
    // CPU stub — if a turn change put a CPU into the active slot, end their
    // turn for them. Scheduled as a deferred tick so it runs *after* the
    // current call stack (including the broadcast / rerender chain) fully
    // unwinds — avoids any reentry pitfalls inside the synchronous broadcast
    // path and makes the CPU tick robust to throws further downstream.
    this._scheduleCpuTick();
  }

  _scheduleCpuTick() {
    if (this._cpuTickScheduled) return;
    this._cpuTickScheduled = true;
    setTimeout(() => {
      this._cpuTickScheduled = false;
      try {
        this._tickCpuTurnsIfActive();
      } catch (err) {
        this.log('cpu tick threw:', err?.message ?? err);
        console.error('[gameRoom] cpu tick threw', err);
      }
    }, 0);
  }

  // If the current active player is a CPU, dispatch end_turn on their behalf.
  // Loops through consecutive CPU slots until a human is current (or the
  // iteration cap trips). Each end_turn publishes its own delta, so the
  // viewer's HUD updates between CPUs.
  _tickCpuTurnsIfActive(maxIterations = 32) {
    for (let i = 0; i < maxIterations; i++) {
      const stateEntityId = getWorldState(this.world);
      const worldState = getComponent(this.world, stateEntityId, 'WorldState');
      if (!worldState || worldState.phase !== 'playing') return;
      const current = this.players[worldState.currentPlayerIndex];
      if (!current || !current.isComputer || current.vanquished) return;
      // Avoid re-entering handleAction's broadcaster — dispatch the end_turn
      // path directly, then publish that delta ourselves.
      const events = [];
      this._endTurn(current.playerId, { name: 'end_turn' }, events);
      this._publishDelta(events);
    }
    this.log('cpu turn loop hit iteration cap — bailing');
  }

  _planPath(playerId, action, events) {
    const heroEntityId = this._heroForPlayer(playerId, action.heroEntityId);
    if (!heroEntityId) return;
    const position = getComponent(this.world, heroEntityId, 'Position');
    const movement = getComponent(this.world, heroEntityId, 'Movement');
    const goal = { q: action.goalQ, r: action.goalR };
    const exploredKeys = this._playerExploredSet(playerId);
    const blockedKeys = collectBlockedKeysExcluding(this.world, heroEntityId, goal);
    const traversalModes = collectTraversalModes(this.world, heroEntityId);
    // movementMax acts as the per-turn ceiling on a single tile's entry cost.
    // MP doesn't accumulate across turns, so any tile costing more than the
    // cap is unreachable for this hero — refuse to plan into it.
    const path = findPath(this.world, this.registry, position, goal, {
      exploredKeys, blockedKeys, traversalModes,
      maxStepCost: movement?.movementMax ?? Infinity,
    });
    if (path) {
      patchComponentTracked(this.world, heroEntityId, 'Movement', ['plannedPath'], { steps: path.steps });
      events.push({ type: 'path_planned', heroEntityId, goal });
    } else {
      patchComponentTracked(this.world, heroEntityId, 'Movement', ['plannedPath'], null);
      events.push({ type: 'path_cleared', heroEntityId });
    }
  }

  _playerExploredSet(playerId) {
    const stateEntityId = getWorldState(this.world);
    const worldState = getComponent(this.world, stateEntityId, 'WorldState');
    return worldState?.fogByPlayer?.[playerId]?.explored ?? null;
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
    const exploredKeys = this._playerExploredSet(playerId);
    // The plan's terminal step is the original click goal — exempt it from
    // soft blocks so the walker can finish on a collectable / POI even if
    // intervening hexes route around them.
    const goalStep = plan.steps[plan.steps.length - 1];
    const blockedKeys = collectBlockedKeysExcluding(this.world, heroEntityId, goalStep);
    const traversalModes = collectTraversalModes(this.world, heroEntityId);
    const stepsRemaining = plan.steps.slice();
    const consumedPath = [];
    while (stepsRemaining.length > 0) {
      const next = stepsRemaining[0];
      const nextKey = next.q + ',' + next.r;
      // Block movement into tiles the planner couldn't have seen.
      if (exploredKeys && !exploredKeys.has(nextKey)) break;
      // Block movement into tiles occupied by another hero / map object.
      // Re-checked each step in case the world state changed since planning.
      if (blockedKeys.has(nextKey)) break;
      const terrain = this._effectiveTerrainAt(next.q, next.r);
      const cost = resolveTerrainCost(terrain, traversalModes);
      if (cost == null) break;
      if (movement.movementLeft < cost) break;
      patchComponentTracked(this.world, heroEntityId, 'Movement', ['movementLeft'], movement.movementLeft - cost);
      patchComponentTracked(this.world, heroEntityId, 'Position', ['q'], next.q);
      patchComponentTracked(this.world, heroEntityId, 'Position', ['r'], next.r);
      consumedPath.push({ q: next.q, r: next.r });
      stepsRemaining.shift();

      // Did we just step onto something visitable? One check, regardless of
      // whether the entity is a one-shot collectable or a persistent POI —
      // those used to be separate components, but their only real
      // difference is "destroy after". That's now its own atomic tag
      // (ConsumedOnVisit), so a tile can't accidentally be both.
      const visitableEntityId = findVisitableAt(this.world, next.q, next.r);
      if (visitableEntityId != null) {
        const visitable = getComponent(this.world, visitableEntityId, 'Visitable');
        const mapObject = getComponent(this.world, visitableEntityId, 'MapObject');
        const type = mapObject ? this.registry.mapObjectTypes.get(mapObject.typeId) : null;
        const heroComponent = getComponent(this.world, heroEntityId, 'Hero');
        const rawMessage = visitable?.message ?? '';
        const formattedMessage = rawMessage.replace(/\{heroName\}/g, heroComponent?.name ?? 'hero');
        const consumed = hasComponent(this.world, visitableEntityId, 'ConsumedOnVisit');
        events.push({
          type: 'entity_visited',
          playerId,
          heroEntityId,
          visitedEntityId: visitableEntityId,
          typeId: mapObject?.typeId ?? null,
          objectName: type?.name ?? null,
          message: formattedMessage,
          consumed,
        });
        // Conquest — visiting a Conquerable entity transfers Ownership to
        // the visiting player. Ownership is a pre-existing component (heroes
        // use it too); reusing it for POIs keeps the design atomic. We only
        // emit the patch when the owner actually changes — re-visiting your
        // own POI shouldn't generate delta traffic.
        if (hasComponent(this.world, visitableEntityId, 'Conquerable')) {
          const currentOwnership = getComponent(this.world, visitableEntityId, 'Ownership');
          if (currentOwnership?.playerId !== playerId) {
            if (currentOwnership) {
              patchComponentTracked(this.world, visitableEntityId, 'Ownership', ['playerId'], playerId);
            } else {
              setComponentTracked(this.world, visitableEntityId, 'Ownership', { playerId });
            }
          }
        }
        if (consumed) destroyTrackedEntity(this.world, visitableEntityId);
        break;
      }
    }
    if (consumedPath.length === 0) return;
    patchComponentTracked(this.world, heroEntityId, 'Movement', ['plannedPath'],
      stepsRemaining.length > 0 ? { steps: stepsRemaining } : null);

    // Snapshot the player's pre-move explored set so the client can replay
    // the fog reveal one tile at a time during the move animation.
    const exploredBaseline = exploredKeys ? Array.from(exploredKeys) : [];
    events.push({
      type: 'hero_moved',
      heroEntityId,
      playerId,
      fromQ,
      fromR,
      toQ: getComponent(this.world, heroEntityId, 'Position').q,
      toR: getComponent(this.world, heroEntityId, 'Position').r,
      path: consumedPath,
      exploredBaseline,
    });
    recomputeFogForAllPlayers(this.world, this.registry);
  }

  _endTurn(playerId, action, events) {
    if (!this._isCurrentPlayer(playerId)) return;
    const stateEntityId = getWorldState(this.world);
    const worldState = getComponent(this.world, stateEntityId, 'WorldState');
    const completedTurnNumber = worldState.turnNumber;
    const nextIndex = (worldState.currentPlayerIndex + 1) % this.players.length;
    const turnRolledOver = nextIndex === 0;
    const nextTurnNumber = worldState.turnNumber + (turnRolledOver ? 1 : 0);

    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['currentPlayerIndex'], nextIndex);
    patchComponentTracked(this.world, stateEntityId, 'WorldState', ['turnNumber'], nextTurnNumber);

    const incomingPlayerId = this.players[nextIndex].playerId;
    forEachEntityWith(this.world, ['Movement', 'Ownership'], (entityId, movement, ownership) => {
      if (ownership.playerId !== incomingPlayerId) return;
      patchComponentTracked(this.world, entityId, 'Movement', ['movementLeft'], movement.movementMax);
    });
    recomputeFogForAllPlayers(this.world, this.registry);
    events.push({ type: 'turn_ended', currentPlayerIndex: nextIndex, turnNumber: nextTurnNumber });

    // End of week — any player without a castle loses all their heroes.
    if (turnRolledOver && completedTurnNumber % DAYS_PER_WEEK === 0) {
      this._vanquishCastlelessPlayers(events);
      recomputeFogForAllPlayers(this.world, this.registry);
    }
  }

  // ── Defeat condition ──────────────────────────────────────────────────
  _vanquishCastlelessPlayers(events) {
    // Tally castle counts per player. A castle "belongs" to a player when
    // its Ownership.playerId matches — losing it (or never owning one)
    // means the player ends the week with 0 castles and is vanquished.
    const castleCounts = new Map();
    forEachEntityWith(this.world, ['Castle', 'Ownership'], (_id, _castle, ownership) => {
      if (!ownership.playerId) return;
      castleCounts.set(ownership.playerId, (castleCounts.get(ownership.playerId) ?? 0) + 1);
    });

    for (const player of this.players) {
      if (player.vanquished) continue;
      const count = castleCounts.get(player.playerId) ?? 0;
      if (count > 0) continue;
      player.vanquished = true;

      // Collect first, then destroy — destroy can't run during iteration.
      const heroIds = [];
      forEachEntityWith(this.world, ['Hero', 'Ownership'], (entityId, _hero, ownership) => {
        if (ownership.playerId === player.playerId) heroIds.push(entityId);
      });
      for (const id of heroIds) destroyTrackedEntity(this.world, id);

      events.push({ type: 'player_vanquished', playerId: player.playerId, name: player.name });
      this._publishPlayersChanged();
    }
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

  // Returns the resolved terrain definition for the given hex — base terrain
  // unless a TerrainOverride entity is sitting on it, in which case the
  // override's referenced terrain wins. Uses the pathfinder's cached tile
  // index when available; falls back to a linear scan otherwise.
  _effectiveTerrainAt(q, r) {
    const cache = this.world._tileIndex;
    if (cache) {
      const hit = cache.get(q + ',' + r);
      if (!hit) return null;
      return hit.effectiveTerrain ?? hit.terrain ?? null;
    }
    const baseTerrainId = this._terrainAt(q, r);
    let overrideTerrainId = null;
    forEachEntityWith(this.world, ['TerrainOverride', 'Position'], (_id, override, position) => {
      if (overrideTerrainId) return;
      if (position.q === q && position.r === r) overrideTerrainId = override.terrainId;
    });
    return getTerrain(this.registry, overrideTerrainId ?? baseTerrainId);
  }
}

// Find the entity id of any Visitable sitting on a given hex. Returns null
// if nothing is there. Linear scan — fine since the visitable population is
// small relative to the tile count.
function findVisitableAt(world, q, r) {
  let result = null;
  forEachEntityWith(world, ['Visitable', 'Position'], (entityId, _visitable, position) => {
    if (result != null) return;
    if (position.q === q && position.r === r) result = entityId;
  });
  return result;
}

// Collect the "q,r" key of every blocking entity except the caller's own.
//
//   • Hard blocks (BlocksMovement) — heroes, anything the planner must
//     always route around. Never exempt.
//   • Soft blocks (Actionable)     — collectables and Conquerable POIs.
//     Heroes can't path *through* them, but the goal hex is exempt so the
//     planner can route TO an Actionable when the player clicks it.
//
// Pass `goalHex` for the soft-block exemption. Omit it (or pass null) for
// callers that want every Actionable treated as blocked (e.g. world-state
// snapshots).
function collectBlockedKeysExcluding(world, excludeEntityId, goalHex = null) {
  const blocked = new Set();
  const goalKey = goalHex ? (goalHex.q + ',' + goalHex.r) : null;
  forEachEntityWith(world, ['BlocksMovement', 'Position'], (entityId, _block, position) => {
    if (entityId === excludeEntityId) return;
    blocked.add(position.q + ',' + position.r);
  });
  forEachEntityWith(world, ['Actionable', 'Position'], (entityId, _act, position) => {
    if (entityId === excludeEntityId) return;
    const key = position.q + ',' + position.r;
    if (key === goalKey) return;
    blocked.add(key);
  });
  return blocked;
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
