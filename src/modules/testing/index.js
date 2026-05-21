// Testing module — sandbox content used to exercise the engine. Currently
// hosts two map-object types:
//
//   • Camp Fire     — a single-hex collectable; visiting consumes it and
//                     pops "You find nothing.".
//   • Mushroom Hut  — a four-hex structure with a Point-of-Interest entrance
//                     and three TerrainModifier-only walls (PassableByAir
//                     only). Demonstrates the prefab-as-composition pattern:
//                     a single prefab call stamps out a coordinated cluster
//                     of POI + walls + visible mesh.
//
// Both types are scattered by world spawners after hero placement. Adding a
// new sandbox object means adding a registerMapObjectType / registerPrefab /
// registerWorldSpawner triple here, never touching engine code.

import {
  CylinderGeometry, ConeGeometry, SphereGeometry, BoxGeometry,
  Mesh, MeshStandardMaterial, Group,
} from 'three';
import { createEntity, addComponent, forEachEntityWith } from '../../game/ecs/world.js';
import {
  registerPrefab,
  registerMapObjectType,
  registerWorldSpawner,
  getTerrain,
  spawnFromPrefab,
} from '../../game/ecs/registry.js';
import { resolveTerrainCost } from '../../game/ecs/traversal.js';
import { hexKey } from '../../game/map/hex.js';

const MODULE_NAME = 'testing';

const CAMPFIRE_TYPE_ID = 'testing/campfire';
const CAMPFIRE_PREFAB_ID = 'testing/campfire';
const CAMPFIRE_DENSITY_TILES_PER = 200;
const CAMPFIRE_DEFAULT_MESSAGE = 'You find nothing.';

const HUT_TYPE_ID = 'testing/mushroom-hut';
const HUT_PREFAB_ID = 'testing/mushroom-hut';
const HUT_DENSITY_TILES_PER = 600;
const HUT_DEFAULT_MESSAGE = 'Sorry {heroName} but the princess is in another castle.';

// Mushroom Hut footprint relative to the anchor (entrance) hex. The anchor
// is the POI; everything in this list becomes a TerrainModifier-only entity
// that overrides passability to PassableByAir alone.
const HUT_FOOTPRINT_OFFSETS = [
  { dq:  0, dr: -1 },   // N
  { dq:  1, dr: -1 },   // NE
  { dq: -1, dr:  0 },   // W
];

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering testing content (campfire + mushroom hut)');

    // ── Camp Fire ───────────────────────────────────────────────────────
    registerMapObjectType(registry, {
      id: CAMPFIRE_TYPE_ID,
      name: 'Camp Fire',
      description: 'An old campfire still smouldering at the edges. Whoever sat here is long gone.',
      prefabId: CAMPFIRE_PREFAB_ID,
      buildMesh: () => buildCampfireMesh(),
    });

    registerPrefab(registry, CAMPFIRE_PREFAB_ID, (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Position', {
        q: params.q ?? 0,
        r: params.r ?? 0,
      });
      addComponent(world, entityId, 'MapObject', { typeId: CAMPFIRE_TYPE_ID });
      addComponent(world, entityId, 'Collectable', {
        message: params.message ?? CAMPFIRE_DEFAULT_MESSAGE,
      });
      return entityId;
    });

    registerWorldSpawner(registry, ({ world, registry: reg, occupiedHexes }) => {
      const candidates = [];
      forEachEntityWith(world, ['Tile'], (_id, tile) => {
        if (!isLandTile(tile, reg)) return;
        const key = hexKey(tile.q, tile.r);
        if (occupiedHexes.has(key)) return;
        candidates.push({ q: tile.q, r: tile.r });
      });
      if (candidates.length === 0) return;
      const target = Math.max(1, Math.round(candidates.length / CAMPFIRE_DENSITY_TILES_PER));
      let placed = 0;
      while (placed < target && candidates.length > 0) {
        const idx = Math.floor(Math.random() * candidates.length);
        const tile = candidates[idx];
        candidates[idx] = candidates[candidates.length - 1];
        candidates.pop();
        const key = hexKey(tile.q, tile.r);
        if (occupiedHexes.has(key)) continue;
        spawnFromPrefab(reg, CAMPFIRE_PREFAB_ID, world, { q: tile.q, r: tile.r });
        occupiedHexes.add(key);
        placed++;
      }
    });

    // ── Mushroom Hut ────────────────────────────────────────────────────
    registerMapObjectType(registry, {
      id: HUT_TYPE_ID,
      name: 'Mushroom Hut',
      description: 'A toadstool-shaped cottage. Smoke curls from the window.',
      prefabId: HUT_PREFAB_ID,
      buildMesh: () => buildMushroomHutMesh(),
    });

    // The prefab stamps out four entities in one call: the POI at the anchor
    // (carries the visible mesh + visit message) plus a TerrainModifier-only
    // entity per footprint hex. Demonstrates how prefabs combine atomic
    // pieces (rendering, POI, terrain override) into one logical object.
    registerPrefab(registry, HUT_PREFAB_ID, (world, params) => {
      const anchorQ = params.q ?? 0;
      const anchorR = params.r ?? 0;

      const poiId = createEntity(world);
      addComponent(world, poiId, 'Position', { q: anchorQ, r: anchorR });
      addComponent(world, poiId, 'MapObject', { typeId: HUT_TYPE_ID });
      addComponent(world, poiId, 'PointOfInterest', {
        message: params.message ?? HUT_DEFAULT_MESSAGE,
      });

      for (const offset of HUT_FOOTPRINT_OFFSETS) {
        const wallId = createEntity(world);
        addComponent(world, wallId, 'Position', {
          q: anchorQ + offset.dq,
          r: anchorR + offset.dr,
        });
        addComponent(world, wallId, 'TerrainModifier', {
          components: { PassableByAir: { cost: 1 } },
        });
      }

      return poiId;
    });

    registerWorldSpawner(registry, ({ world, registry: reg, occupiedHexes }) => {
      // Build a hex→tile lookup once so we can validate the full footprint
      // against base terrain without N×forEach scans.
      const tilesByKey = new Map();
      forEachEntityWith(world, ['Tile'], (_id, tile) => {
        tilesByKey.set(hexKey(tile.q, tile.r), tile);
      });
      if (tilesByKey.size === 0) return;

      const candidates = [];
      for (const [key, tile] of tilesByKey) {
        if (occupiedHexes.has(key)) continue;
        if (!isLandTile(tile, reg)) continue;
        let valid = true;
        for (const off of HUT_FOOTPRINT_OFFSETS) {
          const fk = hexKey(tile.q + off.dq, tile.r + off.dr);
          if (occupiedHexes.has(fk)) { valid = false; break; }
          const ft = tilesByKey.get(fk);
          if (!ft || !isLandTile(ft, reg)) { valid = false; break; }
        }
        if (valid) candidates.push({ q: tile.q, r: tile.r });
      }
      if (candidates.length === 0) return;

      const target = Math.max(1, Math.round(tilesByKey.size / HUT_DENSITY_TILES_PER));
      let placed = 0;
      while (placed < target && candidates.length > 0) {
        const idx = Math.floor(Math.random() * candidates.length);
        const anchor = candidates[idx];
        candidates[idx] = candidates[candidates.length - 1];
        candidates.pop();
        // Earlier huts (or any other spawner) may have claimed an overlap.
        if (occupiedHexes.has(hexKey(anchor.q, anchor.r))) continue;
        let stillValid = true;
        for (const off of HUT_FOOTPRINT_OFFSETS) {
          if (occupiedHexes.has(hexKey(anchor.q + off.dq, anchor.r + off.dr))) {
            stillValid = false;
            break;
          }
        }
        if (!stillValid) continue;
        spawnFromPrefab(reg, HUT_PREFAB_ID, world, { q: anchor.q, r: anchor.r });
        occupiedHexes.add(hexKey(anchor.q, anchor.r));
        for (const off of HUT_FOOTPRINT_OFFSETS) {
          occupiedHexes.add(hexKey(anchor.q + off.dq, anchor.r + off.dr));
        }
        placed++;
      }
    });
  },
};

function isLandTile(tile, registry) {
  const terrain = getTerrain(registry, tile.terrainId);
  return resolveTerrainCost(terrain, ['Land']) != null;
}

// ── Meshes ──────────────────────────────────────────────────────────────

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

// Mushroom hut — beige stem with a wide red-and-white cap, a dark door, and
// a glowing window. The cap is offset to -Z so it visually overhangs the
// three back hexes of the footprint.
function buildMushroomHutMesh() {
  const group = new Group();

  const stem = new Mesh(
    new CylinderGeometry(0.55, 0.72, 1.55, 16),
    new MeshStandardMaterial({ color: 0xe8d3a8, roughness: 0.9 }),
  );
  stem.position.set(0, 0.77, 0);
  stem.castShadow = true;
  stem.receiveShadow = true;
  group.add(stem);

  const door = new Mesh(
    new BoxGeometry(0.42, 0.7, 0.06),
    new MeshStandardMaterial({ color: 0x3a2418, roughness: 0.95 }),
  );
  door.position.set(0, 0.5, 0.6);
  door.castShadow = true;
  group.add(door);

  const windowPane = new Mesh(
    new BoxGeometry(0.22, 0.22, 0.04),
    new MeshStandardMaterial({
      color: 0xffe4a0, emissive: 0xffaa44, emissiveIntensity: 0.85, roughness: 0.4,
    }),
  );
  windowPane.position.set(-0.35, 1.08, 0.59);
  group.add(windowPane);

  // Cap — hemisphere with slight overhang, scaled flatter and shifted north
  // so it sits over the three back hexes of the footprint.
  const cap = new Mesh(
    new SphereGeometry(2.0, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2 + 0.15),
    new MeshStandardMaterial({ color: 0xc23026, roughness: 0.55 }),
  );
  cap.position.set(0, 1.45, -1.0);
  cap.scale.set(1.0, 0.7, 1.0);
  cap.castShadow = true;
  group.add(cap);

  // White spots dotted on the cap.
  const spotMaterial = new MeshStandardMaterial({ color: 0xfaf0e0, roughness: 0.7 });
  const spots = [
    { x: -0.70, y: 1.78, z: -1.40 },
    { x:  0.65, y: 1.92, z: -1.20 },
    { x:  0.05, y: 2.05, z: -1.00 },
    { x: -0.45, y: 1.62, z: -0.45 },
    { x:  0.95, y: 1.45, z: -1.70 },
    { x: -1.25, y: 1.40, z: -1.20 },
  ];
  for (const pos of spots) {
    const spot = new Mesh(new SphereGeometry(0.2, 8, 6), spotMaterial);
    spot.position.set(pos.x, pos.y, pos.z);
    group.add(spot);
  }

  return group;
}
