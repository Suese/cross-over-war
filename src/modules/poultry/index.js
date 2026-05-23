// Poultry kingdom — chickens that march, fly, and squabble. Bonus: heroes
// move further per turn (they're, uh, semi-airborne). Primary biome favours
// dusty plains; secondary biome contributes more dusty hills to the map.

import {
  registerHero, registerKingdom,
} from '../../game/ecs/registry.js';
import { registerStandardCastle, registerPaintBiomeDecorator } from '../../game/modules/kingdomLib.js';

const MODULE_NAME = 'poultry';
const KINGDOM_ID = 'poultry/kingdom';
const CASTLE_PREFAB_ID = 'poultry/castle';
const CASTLE_TYPE_ID = 'poultry/castle';
const PRIMARY_BIOME_ID = 'poultry/primary';
const SECONDARY_BIOME_ID = 'poultry/secondary';

const ACCENT = 0xf2c84a; // wheat-yellow

const HERO_IDS = [
  'poultry/biff-chicken',
  'poultry/spliff-chicken',
  'poultry/mama-biff',
  'poultry/biff-spawn',
];

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering Poultry kingdom');

    registerStandardCastle(registry, {
      prefabId: CASTLE_PREFAB_ID,
      typeId: CASTLE_TYPE_ID,
      name: 'The Roost',
      description: 'A sprawling tiered coop. Feathers everywhere. The clucking never stops.',
      accentColour: ACCENT,
      biomeDecoratorId: PRIMARY_BIOME_ID,
      defaultMessage: 'Welcome home to The Roost, {heroName}.',
    });

    // Primary: dusty plains + the occasional bramble nest.
    registerPaintBiomeDecorator(registry, {
      id: PRIMARY_BIOME_ID,
      baseTerrainId: 'plains',
      paintRules: {
        'plains':      { high: 'rocky-hills', mid: 'plains', low: 'plains', scale: 0.13 },
        'rocky-hills': { high: 'mountain', mid: 'rocky-hills', low: 'rocky-hills', scale: 0.20 },
        'deep-ocean':  { high: 'shallow-ocean', low: 'deep-ocean', scale: 0.18 },
      },
      scatters: [
        { prefabId: 'testing/campfire', density: 1/32, terrainIds: ['plains', 'rocky-hills'] },
        { prefabId: 'testing/fish-school', density: 1/55, terrainIds: ['shallow-ocean'] },
      ],
    });
    // Secondary: dust bowl — a contribution of arid badlands to the wider map.
    registerPaintBiomeDecorator(registry, {
      id: SECONDARY_BIOME_ID,
      baseTerrainId: 'rocky-hills',
      paintRules: {
        'plains':      { high: 'rocky-hills', mid: 'rocky-hills', low: 'plains', scale: 0.18 },
        'rocky-hills': { high: 'mountain', mid: 'rocky-hills', low: 'rocky-hills', scale: 0.20 },
        'deep-ocean':  { low: 'deep-ocean' },
      },
      scatters: [
        { prefabId: 'testing/campfire', density: 1/45, terrainIds: ['plains', 'rocky-hills'] },
      ],
    });

    registerHero(registry, { id: HERO_IDS[0], name: 'BiffChicken',    prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[0], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[1], name: 'SpliffChicken',  prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[1], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[2], name: 'MamaBiff',       prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[2], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[3], name: 'BiffSpawn',      prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[3], visionRadius: 4, movementMax: 20 } });

    registerKingdom(registry, {
      id: KINGDOM_ID,
      name: 'Poultry',
      description: 'A clucking war machine. Half-fluttering, half-running, heroes cover extra ground each turn.',
      accentColour: ACCENT,
      castlePrefabId: CASTLE_PREFAB_ID,
      primaryBiomeId: PRIMARY_BIOME_ID,
      secondaryBiomeId: SECONDARY_BIOME_ID,
      heroIds: HERO_IDS,
      bonus: { movementMaxBonus: 25 },
    });
  },
};
