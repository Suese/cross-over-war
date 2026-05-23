// Pipe Dream kingdom — playful plumber-themed parody. Mushroom huts dot the
// primary biome (verdant plains + forests). Bonus: heroes move further per
// turn — they've got the springs in their boots.

import { createEntity, addComponent } from '../../game/ecs/world.js';
import {
  registerPrefab, registerMapObjectType, registerHero, registerKingdom,
  registerTerrain, declareAssetReference,
} from '../../game/ecs/registry.js';
import { registerStandardCastle, registerPaintBiomeDecorator } from '../../game/modules/kingdomLib.js';

const MODULE_NAME = 'pipe-dream';
const KINGDOM_ID = 'pipe-dream/kingdom';
const CASTLE_PREFAB_ID = 'pipe-dream/castle';
const CASTLE_TYPE_ID = 'pipe-dream/castle';
const PRIMARY_BIOME_ID = 'pipe-dream/primary';
const SECONDARY_BIOME_ID = 'pipe-dream/secondary';

const HUT_TYPE_ID = 'pipe-dream/mushroom-hut';
const HUT_PREFAB_ID = 'pipe-dream/mushroom-hut';
const HUT_DEFAULT_MESSAGE = 'Sorry {heroName} — the princess is in another castle.';

// Pastry-themed terrain IDs — Pipe Dream reskins plains, hills, and mountains
// as edible scenery. Brick is the impassable mountain variant (only fliers).
const PASTRY_PLAINS_ID = 'pipe-dream/pastry-plains';
const PASTRY_HILLS_ID = 'pipe-dream/pastry-hills';
const PASTRY_MOUNTAINS_ID = 'pipe-dream/pastry-mountains';
const BRICK_ID = 'pipe-dream/brick';

const HUT_FOOTPRINT_OFFSETS = [
  { dq:  1, dr:  0 },
  { dq: -1, dr:  0 },
  { dq:  1, dr: -1 },
  { dq:  0, dr: -1 },
];

const ACCENT = 0xff4a3a; // overall-red

const HERO_IDS = [
  'pipe-dream/plumber-joe',
  'pipe-dream/plumber-lou',
  'pipe-dream/princess-lily',
  'pipe-dream/mushroom-knight',
];

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering Pipe Dream kingdom');

    // ── Terrains ────────────────────────────────────────────────────────
    // The Pipe Dream biome reskins the standard plains / hills / mountain
    // family as pastry, plus an impassable "Brick" mountain variant. Costs
    // mirror the base terrains so movement planning behaves identically —
    // this is a visual swap, not a balance change. Each terrain owns its
    // own .glb under this module's assets/ folder; the colour fallback
    // ships behind the streamed mesh until it loads.
    registerTerrain(registry, {
      id: PASTRY_PLAINS_ID,
      name: 'Pastry Plains',
      description: 'Sheets of golden dough rolled flat across the lowlands. Walks like ordinary plain.',
      components: {
        PassableByLand: { cost: 5 },
        PassableByAir: { cost: 1 },
        WorkableTerrain: { cost: 1 },
      },
      fallbackColor: 0xf2c98a,
      modelKey: 'pipe-dream/pastry-plains.glb',
      tileHeight: 0,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'pipe-dream/pastry-plains.glb', declaredFor: 'terrain:' + PASTRY_PLAINS_ID,
    });

    registerTerrain(registry, {
      id: PASTRY_HILLS_ID,
      name: 'Pastry Hills',
      description: 'Rolling buttery mounds. Slower going than the plains.',
      components: {
        PassableByLand: { cost: 7 },
        PassableByAir: { cost: 1 },
        WorkableTerrain: { cost: 2 },
      },
      fallbackColor: 0xd9a35a,
      modelKey: 'pipe-dream/pastry-hills.glb',
      tileHeight: 0.25,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'pipe-dream/pastry-hills.glb', declaredFor: 'terrain:' + PASTRY_HILLS_ID,
    });

    registerTerrain(registry, {
      id: PASTRY_MOUNTAINS_ID,
      name: 'Pastry Mountains',
      description: 'Towering loaves baked into peaks. Steep climbs, but passable on foot.',
      components: {
        PassableByLand: { cost: 120 },
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0xa46a32,
      modelKey: 'pipe-dream/pastry-mountains.glb',
      tileHeight: 0.7,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'pipe-dream/pastry-mountains.glb', declaredFor: 'terrain:' + PASTRY_MOUNTAINS_ID,
    });

    registerTerrain(registry, {
      id: BRICK_ID,
      name: 'Brick',
      description: 'A sheer wall of red brickwork. Nothing on foot crosses; only fliers.',
      components: {
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0xa83c2a,
      modelKey: 'pipe-dream/brick.glb',
      tileHeight: 0.7,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'pipe-dream/brick.glb', declaredFor: 'terrain:' + BRICK_ID,
    });

    // ── Mushroom Hut ────────────────────────────────────────────────────
    // Moved here from the legacy testing module — pipe-dream is where the
    // mushroom motif lives. The 4-hex bramble cove still surrounds the hut.
    registerMapObjectType(registry, {
      id: HUT_TYPE_ID,
      name: 'Mushroom Hut',
      description: 'A toadstool-shaped cottage. Smoke curls from the window.',
      prefabId: HUT_PREFAB_ID,
    });
    registerPrefab(registry, HUT_PREFAB_ID, (world, params) => {
      const anchorQ = params.q ?? 0;
      const anchorR = params.r ?? 0;
      const poiId = createEntity(world);
      addComponent(world, poiId, 'Position', { q: anchorQ, r: anchorR });
      addComponent(world, poiId, 'MapObject', { typeId: HUT_TYPE_ID });
      addComponent(world, poiId, 'Visitable', { message: params.message ?? HUT_DEFAULT_MESSAGE });
      addComponent(world, poiId, 'Actionable', { actionTypeId: 'base/visit' });
      addComponent(world, poiId, 'Conquerable', {});
      addComponent(world, poiId, 'BearsFlag', {});
      addComponent(world, poiId, 'AssetReference', {
        modelKey: 'pipe-dream/mushroom-hut.glb',
        flagAttachY: 1.9,
      });
      for (const offset of HUT_FOOTPRINT_OFFSETS) {
        const wallId = createEntity(world);
        addComponent(world, wallId, 'Position', { q: anchorQ + offset.dq, r: anchorR + offset.dr });
        addComponent(world, wallId, 'TerrainOverride', { terrainId: 'bramble' });
      }
      return poiId;
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'pipe-dream/mushroom-hut.glb', declaredFor: 'mapObject:' + HUT_TYPE_ID,
    });

    // ── Castle ──────────────────────────────────────────────────────────
    registerStandardCastle(registry, {
      prefabId: CASTLE_PREFAB_ID,
      typeId: CASTLE_TYPE_ID,
      name: 'Pipe Dream Keep',
      description: 'A blocky brick stronghold trimmed in green. Pipes vent steam from every wall.',
      accentColour: ACCENT,
      biomeDecoratorId: PRIMARY_BIOME_ID,
      defaultMessage: 'Welcome to the Pipe Dream keep, {heroName}.',
    });

    // ── Biomes ──────────────────────────────────────────────────────────
    // Primary: pastry plains + hills with brick-walled mountain peaks. Plain
    // mapgen tiles paint to pastry equivalents; dusty mountain tiles become
    // pastry mountains with an occasional impassable brick wall on top.
    registerPaintBiomeDecorator(registry, {
      id: PRIMARY_BIOME_ID,
      baseTerrainId: PASTRY_PLAINS_ID,
      paintRules: {
        'plains':      { high: PASTRY_HILLS_ID, mid: PASTRY_PLAINS_ID, low: PASTRY_PLAINS_ID, scale: 0.13 },
        'dusty-hills': { high: BRICK_ID, mid: PASTRY_MOUNTAINS_ID, low: PASTRY_HILLS_ID, scale: 0.20 },
        'deep-ocean':  { high: 'shallow-ocean', low: 'deep-ocean', scale: 0.16 },
      },
      scatters: [
        { prefabId: HUT_PREFAB_ID, density: 1/60, terrainIds: [PASTRY_PLAINS_ID], footprintOffsets: HUT_FOOTPRINT_OFFSETS },
        { prefabId: 'testing/campfire', density: 1/35, terrainIds: [PASTRY_PLAINS_ID, PASTRY_HILLS_ID] },
        { prefabId: 'testing/fish-school', density: 1/50, terrainIds: ['shallow-ocean', 'deep-ocean'] },
      ],
    });
    // Secondary: a few stray pastry plains + occasional huts when this
    // biome lands as a wild patch on the map. No brick walls out here.
    registerPaintBiomeDecorator(registry, {
      id: SECONDARY_BIOME_ID,
      baseTerrainId: PASTRY_PLAINS_ID,
      paintRules: {
        'plains':      { high: PASTRY_HILLS_ID, mid: PASTRY_PLAINS_ID, low: PASTRY_PLAINS_ID, scale: 0.18 },
        'dusty-hills': { high: PASTRY_MOUNTAINS_ID, low: PASTRY_HILLS_ID, scale: 0.20 },
        'deep-ocean':  { low: 'deep-ocean' },
      },
      scatters: [
        { prefabId: HUT_PREFAB_ID, density: 1/120, terrainIds: [PASTRY_PLAINS_ID], footprintOffsets: HUT_FOOTPRINT_OFFSETS },
        { prefabId: 'testing/campfire', density: 1/40, terrainIds: [PASTRY_PLAINS_ID, PASTRY_HILLS_ID] },
      ],
    });

    // ── Heroes ──────────────────────────────────────────────────────────
    registerHero(registry, { id: HERO_IDS[0], name: 'Plumber Joe',     prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[0], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[1], name: 'Plumber Lou',     prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[1], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[2], name: 'Princess Lily',   prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[2], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[3], name: 'Mushroom Knight', prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[3], visionRadius: 4, movementMax: 20 } });

    // ── Kingdom registration ────────────────────────────────────────────
    registerKingdom(registry, {
      id: KINGDOM_ID,
      name: 'Pipe Dream',
      description: 'Plumbers, princesses, and the occasional mushroom. Their heroes bounce — extra movement per turn.',
      accentColour: ACCENT,
      castlePrefabId: CASTLE_PREFAB_ID,
      primaryBiomeId: PRIMARY_BIOME_ID,
      secondaryBiomeId: SECONDARY_BIOME_ID,
      heroIds: HERO_IDS,
      bonus: { movementMaxBonus: 30 },
    });
  },
};
