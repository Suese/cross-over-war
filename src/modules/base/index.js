// Base module — terrains, prefabs, heroes, action types, and the base
// decorator that handles every tile not claimed by a biome.

import {
  createEntity,
  addComponent,
  getComponent,
} from '../../game/ecs/world.js';
import {
  registerTerrain,
  registerPrefab,
  registerHero,
  registerActionType,
  setBaseDecorator,
  declareAssetReference,
} from '../../game/ecs/registry.js';
import { createSeededNoise2D, fractalNoise2D } from '../../game/map/perlin.js';

const MODULE_NAME = 'base';

export default {
  name: MODULE_NAME,
  depends: [],
  register({ registry, log }) {
    log('registering terrains, prefabs, heroes, action types, base decorator');

    // ── Action types ────────────────────────────────────────────────────
    registerActionType(registry, { id: 'base/take',  icon: '🫳', label: 'Take' });
    registerActionType(registry, { id: 'base/visit', icon: '🚩', label: 'Visit' });

    // ── Terrain definitions ─────────────────────────────────────────────
    // The base mapgen produces a coarse classification — plains for any
    // land, deep-ocean for any sea, dusty-hills for any mountain. The
    // base decorator (registered below) refines plains/deep-ocean into a
    // grass/plains and shallow/deep mix. Biome decorators refine further
    // (forest, forest hills, mountain) on the hexes they're assigned.

    // Each terrain points at a .glb tile model under this module's assets/
    // folder. The renderer instances one InstancedMesh per submesh inside
    // each model; if a .glb is missing, the tile falls back to a coloured
    // cylinder using `fallbackColor` (and optional `textureKey`).

    registerTerrain(registry, {
      id: 'plains',
      name: 'Plains',
      description: 'Open meadow. Easy going for any traveller on foot.',
      components: {
        PassableByLand: { cost: 5 },
        PassableByAir: { cost: 1 },
        // Road carver baseline — costs nothing to "work" because there's
        // nothing to clear. Plains are the default base terrain that other
        // workable tiles get reduced to when a road is carved through.
        WorkableTerrain: { cost: 1 },
      },
      fallbackColor: 0x8fcc6a,
      textureKey: 'base/grass.png',
      modelKey: 'base/plains.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'texture',
      assetKey: 'base/grass.png', declaredFor: 'terrain:plains',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/plains.glb', declaredFor: 'terrain:plains',
    });

    registerTerrain(registry, {
      id: 'grassy-hills',
      name: 'Grassy Hills',
      description: 'Rolling slopes of knee-high grass. Slower than open plain.',
      components: {
        PassableByLand: { cost: 7 },
        PassableByAir: { cost: 1 },
        WorkableTerrain: { cost: 2 },
      },
      fallbackColor: 0x6ea84a,
      modelKey: 'base/grassy-hills.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/grassy-hills.glb', declaredFor: 'terrain:grassy-hills',
    });

    registerTerrain(registry, {
      id: 'forest',
      name: 'Forest',
      description: 'Dense trees and undergrowth. Slow going on foot.',
      components: {
        PassableByLand: { cost: 20 },
        PassableByAir: { cost: 1 },
        // Trees can be felled — workable, but more expensive than open ground.
        WorkableTerrain: { cost: 5 },
      },
      fallbackColor: 0x355e36,
      modelKey: 'base/forest.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/forest.glb', declaredFor: 'terrain:forest',
    });

    registerTerrain(registry, {
      id: 'forest-hills',
      name: 'Forest Hills',
      description: 'Wooded slopes — steep climbs through dense growth.',
      components: {
        PassableByLand: { cost: 40 },
        PassableByAir: { cost: 1 },
        // Wooded slopes — most expensive workable terrain.
        WorkableTerrain: { cost: 12 },
      },
      fallbackColor: 0x44653c,
      modelKey: 'base/forest-hills.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/forest-hills.glb', declaredFor: 'terrain:forest-hills',
    });

    registerTerrain(registry, {
      id: 'dusty-hills',
      name: 'Dusty Hills',
      description: 'Rolling, broken slopes. Slow going on foot; trivial for anything that flies.',
      components: {
        PassableByLand: { cost: 20 },
        PassableByAir: { cost: 1 },
        WorkableTerrain: { cost: 8 },
      },
      fallbackColor: 0xa68a5e,
      textureKey: 'base/mountain.png',
      modelKey: 'base/dusty-hills.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'texture',
      assetKey: 'base/mountain.png', declaredFor: 'terrain:dusty-hills',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/dusty-hills.glb', declaredFor: 'terrain:dusty-hills',
    });

    registerTerrain(registry, {
      id: 'mountain',
      name: 'Mountain',
      description: 'Sheer rock and treacherous footing. Only the determined press through on foot.',
      components: {
        PassableByLand: { cost: 80 },
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0x6e5d48,
      modelKey: 'base/mountains.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/mountains.glb', declaredFor: 'terrain:mountain',
    });

    registerTerrain(registry, {
      id: 'deep-ocean',
      name: 'Deep Ocean',
      description: 'Open sea. Ships sail freely; fliers cross overhead. No footing for a land army.',
      components: {
        PassableByWater: { cost: 1 },
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0x2c6691,
      textureKey: 'base/water.png',
      modelKey: 'base/deep-ocean.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'texture',
      assetKey: 'base/water.png', declaredFor: 'terrain:deep-ocean',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/deep-ocean.glb', declaredFor: 'terrain:deep-ocean',
    });

    registerTerrain(registry, {
      id: 'shallow-ocean',
      name: 'Shallow Ocean',
      description: 'Coastal shoals. Same cost to cross by water, but the water reads paler from above.',
      components: {
        PassableByWater: { cost: 1 },
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0x6cb4d4,
      modelKey: 'base/shallow-ocean.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/shallow-ocean.glb', declaredFor: 'terrain:shallow-ocean',
    });

    registerTerrain(registry, {
      id: 'bramble',
      name: 'Bramble',
      description: 'A dense thicket of thorny vines. Nothing on foot gets through, and there\'s no water to swim — only fliers can cross.',
      components: {
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0x3a4d24,
      modelKey: 'base/bramble.glb',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/bramble.glb', declaredFor: 'terrain:bramble',
    });

    // ── Tile prefab ─────────────────────────────────────────────────────
    registerPrefab(registry, 'base/tile', (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Tile', {
        q: params.q,
        r: params.r,
        terrainId: params.terrainId,
      });
      return entityId;
    });

    // ── Hero prefab ─────────────────────────────────────────────────────
    registerPrefab(registry, 'base/hero', (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Hero', {
        archetypeId: params.archetypeId ?? 'base/hero',
        name: params.name ?? 'Hero',
        visionRadius: params.visionRadius ?? 4,
        modelKey: params.modelKey ?? 'base/hero.glb',
      });
      addComponent(world, entityId, 'Position', { q: params.q ?? 0, r: params.r ?? 0 });
      addComponent(world, entityId, 'Movement', {
        movementMax: params.movementMax ?? 20,
        movementLeft: params.movementLeft ?? params.movementMax ?? 20,
        plannedPath: null,
      });
      addComponent(world, entityId, 'Ownership', { playerId: params.playerId ?? null });
      addComponent(world, entityId, 'BlocksMovement', {});
      addComponent(world, entityId, 'TraversesLand', {});
      return entityId;
    });

    declareAssetReference(registry, {
      moduleName: MODULE_NAME,
      kind: 'model',
      assetKey: 'base/hero.glb',
      declaredFor: 'hero:base',
    });

    // ── Hero archetypes ────────────────────────────────────────────────
    registerHero(registry, {
      id: 'base/bob', name: 'Bob', prefabId: 'base/hero',
      defaults: { archetypeId: 'base/bob', visionRadius: 4, movementMax: 20 },
    });
    registerHero(registry, {
      id: 'base/alice', name: 'Alice', prefabId: 'base/hero',
      defaults: { archetypeId: 'base/alice', visionRadius: 4, movementMax: 20 },
    });
    registerHero(registry, {
      id: 'base/john', name: 'John', prefabId: 'base/hero',
      defaults: { archetypeId: 'base/john', visionRadius: 4, movementMax: 20 },
    });
    registerHero(registry, {
      id: 'base/ringo', name: 'Ringo', prefabId: 'base/hero',
      defaults: { archetypeId: 'base/ringo', visionRadius: 4, movementMax: 20 },
    });

    // ── Base decorator ──────────────────────────────────────────────────
    // Runs once over every tile that isn't inside any biome. Modulates the
    // coarse mapgen output with perlin noise: plains → plains | grassy-hills,
    // deep-ocean → deep-ocean | shallow-ocean. Dusty hills are left alone
    // here — they only appear in biomes once the biome decorator has had a
    // chance to refine them.
    setBaseDecorator(registry, ({ world, hexes, seed }) => {
      const noise = createSeededNoise2D(seed + 7901);
      for (const hex of hexes) {
        const tile = getComponent(world, hex.entityId, 'Tile');
        if (!tile) continue;
        const sample = fractalNoise2D(noise, hex.q * 0.18, hex.r * 0.18, 3, 0.55, 2.0);
        if (tile.terrainId === 'plains') {
          tile.terrainId = sample > 0.15 ? 'grassy-hills' : 'plains';
        } else if (tile.terrainId === 'deep-ocean') {
          tile.terrainId = sample > 0.1 ? 'shallow-ocean' : 'deep-ocean';
        }
        // dusty-hills outside any biome stays as-is — biomes handle further refinement.
      }
    });
  },
};
