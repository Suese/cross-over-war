// Compositional traversability.
//
// The world has two sides to "can this hero cross this terrain":
//
//   1. The terrain definition (in the registry) carries any number of
//      `PassableBy<Mode>` entries on its `components` map. Each one declares
//      "this mover-mode can cross me" along with the movement-point cost.
//
//          components: {
//            PassableByLand: { cost: 1 },
//            PassableByAir:  { cost: 1 },
//          }
//
//   2. The mover (currently always a hero entity) carries `Traverses<Mode>`
//      components — atomic tags. A hero with `TraversesLand` is a land
//      unit; a future amphibious hero would also carry `TraversesWater`.
//
// The pairing rule is direct: a mover with `Traverses<Mode>` may cross any
// terrain whose components include `PassableBy<Mode>`. When several modes
// match (e.g. an amphibious unit walking on a beach), the lowest cost wins.
//
// Components are deliberately atomic — adding a new mode means coining a
// new name pair (`PassableByUnderground` / `TraversesUnderground`) and that
// is the whole change. Nothing in the engine enumerates known modes.

const PASSABLE_PREFIX = 'PassableBy';
const TRAVERSES_PREFIX = 'Traverses';

// Pull every `Traverses<X>` tag the given entity carries and return the
// list of bare mode tags (e.g. ['Land', 'Air']). Returns [] if the entity
// has no traversal tags at all.
export function collectTraversalModes(world, entityId) {
  const modes = [];
  for (const [componentName, store] of world.componentStores) {
    if (!componentName.startsWith(TRAVERSES_PREFIX)) continue;
    if (!store.has(entityId)) continue;
    modes.push(componentName.slice(TRAVERSES_PREFIX.length));
  }
  return modes;
}

// Given a terrain definition and the mover's mode list, return the movement
// cost of crossing this terrain — or null if the mover has no matching
// traversal tag for any of the terrain's `PassableBy<Mode>` components.
export function resolveTerrainCost(terrain, traversalModes) {
  const components = terrain?.components;
  if (!components) return null;
  let bestCost = null;
  for (const mode of traversalModes) {
    const passable = components[PASSABLE_PREFIX + mode];
    if (!passable) continue;
    const cost = passable.cost ?? 1;
    if (bestCost == null || cost < bestCost) bestCost = cost;
  }
  return bestCost;
}

// List every mode this terrain is passable by, with its cost. Used by the
// right-click info panel; ordering reflects insertion order of the
// definition's `components` map.
export function listPassableModes(terrain) {
  const out = [];
  const components = terrain?.components;
  if (!components) return out;
  for (const name in components) {
    if (!name.startsWith(PASSABLE_PREFIX)) continue;
    out.push({ mode: name.slice(PASSABLE_PREFIX.length), cost: components[name]?.cost ?? 1 });
  }
  return out;
}

// Cost to "work" a tile — to clear or smooth it back to the biome's base
// terrain when carving a road. Terrain definitions opt in by including a
// `WorkableTerrain: { cost: N }` entry in their `components` map. Returns
// null when the terrain has no WorkableTerrain entry (water, mountain
// cliffs, bramble walls — the engine treats those as unworkable).
export function resolveWorkableCost(terrain) {
  const workable = terrain?.components?.WorkableTerrain;
  if (!workable) return null;
  return workable.cost ?? 1;
}
