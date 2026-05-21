// Base module — the minimum a brand-new world needs.
//
// Registers:
//   • three terrain types: grass, water, mountain (textures auto-loaded from
//     this module's assets/ folder if present, else a colour fallback).
//   • a tile prefab that adds a Tile component to a fresh entity.
//   • a hero prefab that adds Hero / Position / Movement / Ownership.
//   • two named hero archetypes: "Bob" and "Alice", identical.

import {
  createEntity,
  addComponent,
} from '../../game/ecs/world.js';
import {
  registerTerrain,
  registerPrefab,
  registerHero,
  declareAssetReference,
} from '../../game/ecs/registry.js';

const MODULE_NAME = 'base';

export default {
  name: MODULE_NAME,
  depends: [],
  register({ registry, log }) {
    log('registering terrains, prefabs, and heroes');

    // ── Terrain definitions ─────────────────────────────────────────────
    registerTerrain(registry, {
      id: 'grass',
      name: 'Grass',
      movementCost: 1,
      walkable: true,
      water: false,
      fallbackColor: 0x7fbf5e,
      textureKey: 'base/grass.png',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME,
      kind: 'texture',
      assetKey: 'base/grass.png',
      declaredFor: 'terrain:grass',
    });

    registerTerrain(registry, {
      id: 'water',
      name: 'Water',
      movementCost: 999,           // effectively impassable on foot
      walkable: false,
      water: true,
      fallbackColor: 0x4b94c4,
      textureKey: 'base/water.png',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME,
      kind: 'texture',
      assetKey: 'base/water.png',
      declaredFor: 'terrain:water',
    });

    registerTerrain(registry, {
      id: 'mountain',
      name: 'Mountain',
      movementCost: 3,
      walkable: true,
      fallbackColor: 0x8a7c6a,
      textureKey: 'base/mountain.png',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME,
      kind: 'texture',
      assetKey: 'base/mountain.png',
      declaredFor: 'terrain:mountain',
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
        modelKey: params.modelKey ?? 'base/hero.glb', // intentionally missing for the demo → cube fallback
      });
      addComponent(world, entityId, 'Position', {
        q: params.q ?? 0,
        r: params.r ?? 0,
      });
      addComponent(world, entityId, 'Movement', {
        movementMax: params.movementMax ?? 20,
        movementLeft: params.movementLeft ?? params.movementMax ?? 20,
        plannedPath: null,           // { steps, costs } when the player has plotted a route
      });
      addComponent(world, entityId, 'Ownership', {
        playerId: params.playerId ?? null,
      });
      return entityId;
    });

    // Declare the model so it shows up in docs/missing_assets.md until art
    // is dropped in.
    declareAssetReference(registry, {
      moduleName: MODULE_NAME,
      kind: 'model',
      assetKey: 'base/hero.glb',
      declaredFor: 'hero:base',
    });

    // ── Hero archetypes ────────────────────────────────────────────────
    registerHero(registry, {
      id: 'base/bob',
      name: 'Bob',
      prefabId: 'base/hero',
      defaults: {
        archetypeId: 'base/bob',
        visionRadius: 4,
        movementMax: 20,
      },
    });
    registerHero(registry, {
      id: 'base/alice',
      name: 'Alice',
      prefabId: 'base/hero',
      defaults: {
        archetypeId: 'base/alice',
        visionRadius: 4,
        movementMax: 20,
      },
    });
  },
};
