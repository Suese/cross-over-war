// Engine API surface for modules.
//
// Modules should import from this file rather than reaching directly into
// engine internals. Anything re-exported here is part of the stable
// module-authoring contract; anything not here is engine-internal and may
// be reshaped without warning.
//
// Usage in a module:
//   import {
//     registerTerrain, registerPrefab, registerBiomeDecorator,
//     createEntity, addComponent, getComponent,
//     findPath, hexDistance, hexKey,
//     createSeededNoise2D, fractalNoise2D,
//     resolveTerrainCost, resolveWorkableCost,
//   } from '../../game/api.js';

// ── ECS world ─────────────────────────────────────────────────────────────
export {
  createEntity,
  addComponent,
  getComponent,
  hasComponent,
  forEachEntityWith,
  collectEntitiesWith,
} from './ecs/world.js';

// ── Registry (terrains, prefabs, heroes, decorators, action types) ───────
export {
  registerTerrain,
  registerPrefab,
  registerHero,
  registerMapObjectType,
  registerActionType,
  registerBiomeDecorator,
  registerWorldSpawner,
  registerEmblem,
  setBaseDecorator,
  declareAssetReference,
  spawnFromPrefab,
  getTerrain,
  getActionType,
  getEmblem,
  listEmblems,
} from './ecs/registry.js';

// ── Hex math ──────────────────────────────────────────────────────────────
export {
  HEX_DIRECTIONS,
  hexKey,
  parseHexKey,
  neighbours,
  hexDistance,
  hexToPixel,
  pixelToHex,
  hexesInRadius,
} from './map/hex.js';

// ── Pathfinding (A*) ──────────────────────────────────────────────────────
// findPath supports an optional `costFn(terrain, q, r) => number | null` for
// callers that need rules other than "the mover's traversal modes". See
// pathfinding.js for the full options reference.
export {
  findPath,
  invalidateTileIndex,
  splitPathByMovementBudget,
  estimateTurnsForPath,
  getEffectiveTerrainAt,
} from './map/pathfinding.js';

// ── Compositional traversability + workability ───────────────────────────
export {
  collectTraversalModes,
  resolveTerrainCost,
  resolveWorkableCost,
  listPassableModes,
} from './ecs/traversal.js';

// ── Noise (perlin) ────────────────────────────────────────────────────────
export {
  createSeededNoise2D,
  fractalNoise2D,
} from './map/perlin.js';

// ── Assets ────────────────────────────────────────────────────────────────
// The asset loader instance itself is created by the engine and threaded
// into every module's `register({ assets })` context — modules don't import
// it. These are the entry points modules touch:
//
//   • `assets.hasAsset(key)`              — is the file present?
//   • `assets.getTexture(key)`            — sync THREE.Texture handle
//   • `assets.requestModel(key, onLoad)`  — streaming request: callback fires
//                                            when the GLB bytes arrive. Returns
//                                            the cached scene if already loaded,
//                                            otherwise null.
//   • `assets.getModel(key)`              — sync accessor; returns the cached
//                                            scene or null without triggering
//                                            a load.
//   • `assets.loadModel(key)`             — promise variant of requestModel.
//   • `assets.acquireModel(key)` /
//     `assets.releaseModel(key)`          — refcount calls so a mesh can pin
//                                            the source asset against LRU
//                                            eviction.
//   • `assets.getModelState(key)`         — 'missing' | 'unloaded' | 'loading'
//                                            | 'loaded' | 'failed'.
//
// Modules occasionally want the createAssetLoader factory for tests; it lives
// at `src/game/modules/assetLoader.js` and is re-exported here for that case.
export { createAssetLoader } from './modules/assetLoader.js';
