// Canada kingdom — Mounties, lakes, deep forests. Bonus: heroes get a
// little extra movement and the secondary biome tilts toward mountain so
// the kingdom contributes rugged terrain to the wider map.

import {
  registerHero, registerKingdom,
} from '../../game/ecs/registry.js';
import { registerStandardCastle, registerPaintBiomeDecorator } from '../../game/modules/kingdomLib.js';

const MODULE_NAME = 'canada';
const KINGDOM_ID = 'canada/kingdom';
const CASTLE_PREFAB_ID = 'canada/castle';
const CASTLE_TYPE_ID = 'canada/castle';
const PRIMARY_BIOME_ID = 'canada/primary';
const SECONDARY_BIOME_ID = 'canada/secondary';

const ACCENT = 0xc81428; // maple-red

const HERO_IDS = [
  'canada/mountie-laframboise',
  'canada/mountie-tremblay',
  'canada/mountie-macdonald',
  'canada/mountie-okafor',
];

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering Canada kingdom');

    registerStandardCastle(registry, {
      prefabId: CASTLE_PREFAB_ID,
      typeId: CASTLE_TYPE_ID,
      name: 'Mountie Garrison',
      description: 'A timber-and-stone outpost flying a red banner. Patrol horses graze in the yard.',
      accentColour: ACCENT,
      biomeDecoratorId: PRIMARY_BIOME_ID,
      defaultMessage: 'Welcome back to the garrison, Constable {heroName}.',
    });

    // Primary: forests and forest-hills with the occasional lake.
    registerPaintBiomeDecorator(registry, {
      id: PRIMARY_BIOME_ID,
      baseTerrainId: 'plains',
      paintRules: {
        'plains':      { high: 'forest-hills', mid: 'forest', low: 'plains', scale: 0.11 },
        'dusty-hills': { high: 'mountain', mid: 'dusty-hills', low: 'dusty-hills', scale: 0.18 },
        'deep-ocean':  { high: 'shallow-ocean', mid: 'shallow-ocean', low: 'deep-ocean', scale: 0.20 },
      },
      scatters: [
        { prefabId: 'testing/campfire', density: 1/30, terrainIds: ['plains', 'forest'] },
        { prefabId: 'testing/fish-school', density: 1/40, terrainIds: ['shallow-ocean'] },
      ],
    });
    // Secondary: mountain pass — bonus rugged terrain on the wild map.
    registerPaintBiomeDecorator(registry, {
      id: SECONDARY_BIOME_ID,
      baseTerrainId: 'dusty-hills',
      paintRules: {
        'plains':      { high: 'forest-hills', mid: 'dusty-hills', low: 'plains', scale: 0.20 },
        'dusty-hills': { high: 'mountain', mid: 'mountain', low: 'dusty-hills', scale: 0.20 },
        'deep-ocean':  { low: 'deep-ocean' },
      },
      scatters: [
        { prefabId: 'testing/campfire', density: 1/40, terrainIds: ['plains', 'forest-hills'] },
      ],
    });

    registerHero(registry, { id: HERO_IDS[0], name: 'Constable Laframboise', prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[0], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[1], name: 'Sergeant Tremblay',     prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[1], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[2], name: 'Inspector MacDonald',   prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[2], visionRadius: 4, movementMax: 20 } });
    registerHero(registry, { id: HERO_IDS[3], name: 'Corporal Okafor',       prefabId: 'base/hero', defaults: { archetypeId: HERO_IDS[3], visionRadius: 4, movementMax: 20 } });

    registerKingdom(registry, {
      id: KINGDOM_ID,
      name: 'Canada',
      description: 'Mounties always get their hero. Steady riders cover a little more ground each turn.',
      accentColour: ACCENT,
      castlePrefabId: CASTLE_PREFAB_ID,
      primaryBiomeId: PRIMARY_BIOME_ID,
      secondaryBiomeId: SECONDARY_BIOME_ID,
      heroIds: HERO_IDS,
      bonus: { movementMaxBonus: 20 },
    });
  },
};
