// Game registry. Modules call into this during their register() pass to
// declare terrains, prefabs, hero archetypes, map-object types, etc.
//
// The registry deliberately stays dumb — it just holds named definitions.
// Systems and game code look things up by id.

export function createRegistry() {
  return {
    moduleOrder: [],
    terrains: new Map(),    // id → definition
    prefabs: new Map(),     // id → spawn function (world, params) → entityId
    heroes: new Map(),      // id → hero archetype { name, prefabId, stats... }
    mapObjectTypes: new Map(),  // id → { name, prefabId, buildMesh, onVisit? }
    actionTypes: new Map(),     // id → { icon, label } — UI templates referenced by the Actionable component
    biomeDecorators: new Map(), // id → decorate({ world, registry, biomeHexes, anchor*, seed, mapWidth, mapHeight, occupiedHexes })
    baseDecorator: null,        // optional decorator that runs once over every tile not claimed by a biome
    worldSpawners: [],      // [(context) => void] — invoked once after biomes + base decorator
    assetReferences: [],    // [{ moduleName, kind, id, path }] — for audit
  };
}

export function registerTerrain(registry, definition) {
  if (!definition.id) throw new Error('registerTerrain: id required');
  if (registry.terrains.has(definition.id)) {
    throw new Error('terrain id already registered: ' + definition.id);
  }
  registry.terrains.set(definition.id, definition);
}

export function getTerrain(registry, terrainId) {
  return registry.terrains.get(terrainId) ?? null;
}

export function registerPrefab(registry, prefabId, spawnFunction) {
  if (!prefabId) throw new Error('registerPrefab: id required');
  if (registry.prefabs.has(prefabId)) {
    throw new Error('prefab id already registered: ' + prefabId);
  }
  registry.prefabs.set(prefabId, spawnFunction);
}

export function spawnFromPrefab(registry, prefabId, world, params) {
  const factory = registry.prefabs.get(prefabId);
  if (!factory) throw new Error('unknown prefab: ' + prefabId);
  return factory(world, params ?? {});
}

export function registerHero(registry, definition) {
  if (!definition.id) throw new Error('registerHero: id required');
  if (registry.heroes.has(definition.id)) {
    throw new Error('hero id already registered: ' + definition.id);
  }
  registry.heroes.set(definition.id, definition);
}

export function registerMapObjectType(registry, definition) {
  if (!definition.id) throw new Error('registerMapObjectType: id required');
  registry.mapObjectTypes.set(definition.id, definition);
}

// Register a UI action template — icon + label paired with an id that the
// Actionable component on entities references. Lets modules introduce new
// hover-prompt kinds ('base/take', 'mymod/inspect', …) without bloating the
// per-instance Actionable payload with duplicate strings.
export function registerActionType(registry, definition) {
  if (!definition.id) throw new Error('registerActionType: id required');
  if (registry.actionTypes.has(definition.id)) {
    throw new Error('action type already registered: ' + definition.id);
  }
  registry.actionTypes.set(definition.id, definition);
}

export function getActionType(registry, actionTypeId) {
  return registry.actionTypes.get(actionTypeId) ?? null;
}

// Register a function that scatters entities across the freshly-generated
// world. Each spawner is invoked once at the start of a new game, after
// terrain, castles, heroes, biome decorators, and the base decorator have
// all run — i.e., very last in the setup pipeline. The context object
// carries the world, registry, map dimensions, seed, and a mutable Set of
// 'q,r' keys that have already been claimed.
export function registerWorldSpawner(registry, spawnerFn) {
  if (typeof spawnerFn !== 'function') throw new Error('registerWorldSpawner: function required');
  registry.worldSpawners.push(spawnerFn);
}

// Register a biome decorator. Castles reference a decorator by id via the
// BiomeAnchor component on the castle entity; the engine runs each
// decorator once over the hexes assigned to its anchor.
//
// The `decorate` function receives a context object:
//   {
//     world, registry,
//     anchorEntityId,                  // the castle / anchor entity
//     anchorQ, anchorR,                // anchor's hex
//     biomeHexes: [{ entityId, q, r }],// tiles in this biome
//     mapWidth, mapHeight, seed,       // for noise-driven placement
//     occupiedHexes,                   // mutable Set<"q,r"> — read before placing, add after
//   }
export function registerBiomeDecorator(registry, definition) {
  if (!definition.id) throw new Error('registerBiomeDecorator: id required');
  if (typeof definition.decorate !== 'function') throw new Error('registerBiomeDecorator: decorate(fn) required');
  if (registry.biomeDecorators.has(definition.id)) {
    throw new Error('biome decorator id already registered: ' + definition.id);
  }
  registry.biomeDecorators.set(definition.id, definition);
}

// Set the global base decorator — runs once over every tile that isn't
// claimed by any biome. There's only one (the most recently set wins) so a
// late-loading module can replace it cleanly. Context shape:
//   { world, registry, hexes: [{ entityId, q, r }], mapWidth, mapHeight, seed }
export function setBaseDecorator(registry, decorate) {
  if (typeof decorate !== 'function') throw new Error('setBaseDecorator: function required');
  registry.baseDecorator = { decorate };
}

// Record that a definition expects to find a particular asset on disk.
// The asset loader and audit step both read from this list.
export function declareAssetReference(registry, reference) {
  registry.assetReferences.push(reference);
}
