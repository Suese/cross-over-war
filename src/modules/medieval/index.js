// Medieval kingdom — knights, barons, dukes.

import {
  registerHero, registerKingdom,
} from '../../game/ecs/registry.js';
import { registerStandardCastle, registerPaintBiomeDecorator } from '../../game/modules/kingdomLib.js';

const MODULE_NAME = 'medieval';
const KINGDOM_ID = 'medieval/kingdom';
const CASTLE_PREFAB_ID = 'medieval/castle';
const CASTLE_TYPE_ID = 'medieval/castle';
const PRIMARY_BIOME_ID = 'medieval/primary';
const SECONDARY_BIOME_ID = 'medieval/secondary';

const ACCENT = 0x4a78c8; // royal blue

const HERO_IDS = [
  'medieval/sir-cedric',
  'medieval/baron-helmsworth',
  'medieval/duke-arnault',
  'medieval/dame-isolde',
  'medieval/sir-percival',
];

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering Medieval kingdom');

    registerStandardCastle(registry, {
      prefabId: CASTLE_PREFAB_ID,
      typeId: CASTLE_TYPE_ID,
      name: 'Royal Keep',
      description: 'A high-walled stone fortress flying the royal banner.',
      accentColour: ACCENT,
      biomeDecoratorId: PRIMARY_BIOME_ID,
      defaultMessage: 'Hail and welcome, {heroName}, to the royal keep.',
    });

    // Primary: rolling grassy hills with sprinkled forest.
    registerPaintBiomeDecorator(registry, {
      id: PRIMARY_BIOME_ID,
      baseTerrainId: 'plains',
      paintRules: {
        'plains':      { high: 'grassy-hills', mid: 'plains', low: 'plains', scale: 0.14 },
        'dusty-hills': { high: 'mountain', low: 'dusty-hills', scale: 0.20 },
        'deep-ocean':  { high: 'shallow-ocean', low: 'deep-ocean', scale: 0.18 },
      },
      scatters: [
        { prefabId: 'testing/campfire', density: 1/28, terrainIds: ['plains', 'grassy-hills'] },
        { prefabId: 'testing/fish-school', density: 1/55, terrainIds: ['shallow-ocean'] },
      ],
    });
    // Secondary: dense forest — the kingdom's hunting preserve away from home.
    registerPaintBiomeDecorator(registry, {
      id: SECONDARY_BIOME_ID,
      baseTerrainId: 'plains',
      paintRules: {
        'plains':      { high: 'forest-hills', mid: 'forest', low: 'forest', scale: 0.13 },
        'dusty-hills': { high: 'mountain', low: 'dusty-hills', scale: 0.20 },
        'deep-ocean':  { low: 'deep-ocean' },
      },
      scatters: [
        { prefabId: 'testing/campfire', density: 1/32, terrainIds: ['forest', 'forest-hills'] },
      ],
    });

    registerHero(registry, { id: HERO_IDS[0], name: 'Sir Cedric',       prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[0], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[1], name: 'Baron Helmsworth', prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[1], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[2], name: 'Duke Arnault',     prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[2], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[3], name: 'Dame Isolde',      prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[3], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[4], name: 'Sir Percival',     prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[4], visionRadius: 4, movementMax: 20 } });

    registerKingdom(registry, {
      id: KINGDOM_ID,
      name: 'Medieval',
      description: 'Knights, banners, and a high-walled royal keep.',
      accentColour: ACCENT,
      castlePrefabId: CASTLE_PREFAB_ID,
      primaryBiomeId: PRIMARY_BIOME_ID,
      secondaryBiomeId: SECONDARY_BIOME_ID,
      heroIds: HERO_IDS,
      bonus: {},
    });
  },
};
