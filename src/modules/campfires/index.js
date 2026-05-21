// Campfires — the first collectable map object.
//
// Visiting a campfire (stepping onto its hex) shows "You find nothing." and
// the campfire is consumed. Demonstrates four module-system extension points
// in one place:
//   • registerMapObjectType — declares the kind, its display name + mesh
//   • registerPrefab        — concrete factory that attaches the components
//   • registerWorldSpawner  — scatters instances across freshly-generated maps
//   • a `Collectable` component carrying the visit-time message
//
// Density is roughly 1 campfire per 200 walkable land tiles. Spawners run
// after hero placement, so campfires never sit on a hero's starting hex.

import {
  CylinderGeometry, ConeGeometry, MeshStandardMaterial, Mesh, Group,
} from 'three';
import { createEntity, addComponent } from '../../game/ecs/world.js';
import {
  registerPrefab,
  registerMapObjectType,
  registerWorldSpawner,
  getTerrain,
  spawnFromPrefab,
} from '../../game/ecs/registry.js';
import { forEachEntityWith } from '../../game/ecs/world.js';
import { resolveTerrainCost } from '../../game/ecs/traversal.js';
import { hexKey } from '../../game/map/hex.js';

const MODULE_NAME = 'campfires';
const TYPE_ID = 'campfires/campfire';
const PREFAB_ID = 'campfires/campfire';
const DENSITY_TILES_PER_FIRE = 200;
const DEFAULT_MESSAGE = 'You find nothing.';

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering campfire collectable + world spawner');

    registerMapObjectType(registry, {
      id: TYPE_ID,
      name: 'Camp Fire',
      description: 'An old campfire still smouldering at the edges. Whoever sat here is long gone.',
      prefabId: PREFAB_ID,
      buildMesh: () => buildCampfireMesh(),
    });

    registerPrefab(registry, PREFAB_ID, (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Position', {
        q: params.q ?? 0,
        r: params.r ?? 0,
      });
      addComponent(world, entityId, 'MapObject', { typeId: TYPE_ID });
      addComponent(world, entityId, 'Collectable', {
        message: params.message ?? DEFAULT_MESSAGE,
      });
      return entityId;
    });

    registerWorldSpawner(registry, ({ world, registry: reg, occupiedHexes }) => {
      // Build the candidate pool: every land-traversable tile that no hero is
      // already standing on. We don't bother stripping mountains because
      // they're land-traversable — campfires belong on mountains too.
      const candidates = [];
      forEachEntityWith(world, ['Tile'], (_entityId, tile) => {
        const terrain = getTerrain(reg, tile.terrainId);
        if (resolveTerrainCost(terrain, ['Land']) == null) return;
        const key = hexKey(tile.q, tile.r);
        if (occupiedHexes.has(key)) return;
        candidates.push({ q: tile.q, r: tile.r });
      });
      if (candidates.length === 0) return;

      const targetCount = Math.max(1, Math.round(candidates.length / DENSITY_TILES_PER_FIRE));
      for (let placed = 0; placed < targetCount && candidates.length > 0; placed++) {
        const index = Math.floor(Math.random() * candidates.length);
        const tile = candidates[index];
        // Fast remove: swap with last, pop.
        candidates[index] = candidates[candidates.length - 1];
        candidates.pop();
        spawnFromPrefab(reg, PREFAB_ID, world, { q: tile.q, r: tile.r });
        occupiedHexes.add(hexKey(tile.q, tile.r));
      }
    });
  },
};

// Cube/cone composite mesh — a low charred ring with bright flames on top.
// Kept small (under one tile diameter) so it reads as "on" the hex rather
// than "filling" it.
function buildCampfireMesh() {
  const group = new Group();

  const baseMaterial = new MeshStandardMaterial({ color: 0x3a2418, roughness: 0.95, metalness: 0.0 });
  const base = new Mesh(new CylinderGeometry(0.42, 0.5, 0.16, 10), baseMaterial);
  base.position.y = 0.08;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const outerFlame = new Mesh(
    new ConeGeometry(0.32, 0.78, 10),
    new MeshStandardMaterial({
      color: 0xff7a2a, emissive: 0xff5414, emissiveIntensity: 0.9, roughness: 0.55,
    }),
  );
  outerFlame.position.y = 0.48;
  outerFlame.castShadow = true;
  group.add(outerFlame);

  const innerFlame = new Mesh(
    new ConeGeometry(0.16, 0.4, 8),
    new MeshStandardMaterial({
      color: 0xffe27a, emissive: 0xffd964, emissiveIntensity: 1.0, roughness: 0.4,
    }),
  );
  innerFlame.position.y = 0.36;
  group.add(innerFlame);

  return group;
}
