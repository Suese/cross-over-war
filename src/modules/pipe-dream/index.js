// Pipe Dream kingdom — playful plumber-themed parody. Mushroom huts dot the
// primary biome (verdant plains + forests). Bonus: heroes move further per
// turn — they've got the springs in their boots.

import { createEntity, addComponent } from '../../game/ecs/world.js';
import {
  registerPrefab, registerMapObjectType, registerHero, registerKingdom,
  declareAssetReference,
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
    // Primary: lots of mushroom huts among forest + plains.
    registerPaintBiomeDecorator(registry, {
      id: PRIMARY_BIOME_ID,
      baseTerrainId: 'plains',
      paintRules: {
        'plains':      { high: 'forest-hills', mid: 'forest', low: 'plains', scale: 0.13 },
        'dusty-hills': { high: 'mountain', low: 'dusty-hills', scale: 0.20 },
        'deep-ocean':  { high: 'shallow-ocean', low: 'deep-ocean', scale: 0.16 },
      },
      scatters: [
        { prefabId: HUT_PREFAB_ID, density: 1/60, terrainIds: ['plains'], footprintOffsets: HUT_FOOTPRINT_OFFSETS },
        { prefabId: 'testing/campfire', density: 1/35, terrainIds: ['plains', 'forest', 'forest-hills'] },
        { prefabId: 'testing/fish-school', density: 1/50, terrainIds: ['shallow-ocean', 'deep-ocean'] },
      ],
    });
    // Secondary: a few stray huts on a quieter forest stretch.
    registerPaintBiomeDecorator(registry, {
      id: SECONDARY_BIOME_ID,
      baseTerrainId: 'plains',
      paintRules: {
        'plains':      { high: 'forest', mid: 'forest', low: 'plains', scale: 0.18 },
        'dusty-hills': { low: 'dusty-hills' },
        'deep-ocean':  { low: 'deep-ocean' },
      },
      scatters: [
        { prefabId: HUT_PREFAB_ID, density: 1/120, terrainIds: ['plains'], footprintOffsets: HUT_FOOTPRINT_OFFSETS },
        { prefabId: 'testing/campfire', density: 1/40, terrainIds: ['plains', 'forest'] },
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
