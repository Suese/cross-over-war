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
    worldSpawners: [],      // [(context) => void] — invoked once after map-gen + hero placement
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
// terrain and hero spawns but before fog initialisation. The context object
// carries the world, registry, map dimensions, seed, and a mutable Set of
// 'q,r' keys that have already been claimed — spawners should add their own
// placements to this Set so later spawners don't collide.
export function registerWorldSpawner(registry, spawnerFn) {
  if (typeof spawnerFn !== 'function') throw new Error('registerWorldSpawner: function required');
  registry.worldSpawners.push(spawnerFn);
}

// Record that a definition expects to find a particular asset on disk.
// The asset loader and audit step both read from this list.
export function declareAssetReference(registry, reference) {
  registry.assetReferences.push(reference);
}
