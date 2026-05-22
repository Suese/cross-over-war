// Testing module — sandbox content used to exercise the engine.
//
// Now provides:
//   • Camp Fire        — one-shot collectable; visiting destroys it
//   • Mushroom Hut     — 4-hex conquerable POI inside a bramble cove
//   • Testing Castle   — conquerable POI + footprint that anchors a biome
//   • Fish School      — placeholder POI in shallow water
//
// And a `testing/biome` decorator that:
//   • paints the biome's plains hexes with forest-hills (40mp) / forest
//     (20mp) / plains (5mp) via perlin
//   • paints the biome's dusty-hills hexes with mountain (80mp) / dusty-
//     hills (20mp) via perlin
//   • paints the biome's deep-ocean hexes with shallow-ocean / deep-ocean
//   • scatters mushroom huts, campfires, and fish schools proportional to
//     the biome's area
//
// Castles are placed by the engine (one per player). Their `BiomeAnchor`
// component selects this decorator, which the engine invokes on the hexes
// assigned to the castle.

import {
  CylinderGeometry, ConeGeometry, SphereGeometry, BoxGeometry, PlaneGeometry,
  Mesh, MeshStandardMaterial, Group, DoubleSide,
} from 'three';
import { createEntity, addComponent, getComponent, forEachEntityWith } from '../../game/ecs/world.js';
import {
  registerPrefab,
  registerMapObjectType,
  registerBiomeDecorator,
  getTerrain,
  spawnFromPrefab,
} from '../../game/ecs/registry.js';
import { resolveTerrainCost } from '../../game/ecs/traversal.js';
import { hexKey } from '../../game/map/hex.js';
import { createSeededNoise2D, fractalNoise2D } from '../../game/map/perlin.js';

const MODULE_NAME = 'testing';

const CAMPFIRE_TYPE_ID = 'testing/campfire';
const CAMPFIRE_PREFAB_ID = 'testing/campfire';
const CAMPFIRE_DEFAULT_MESSAGE = 'You find nothing.';

const HUT_TYPE_ID = 'testing/mushroom-hut';
const HUT_PREFAB_ID = 'testing/mushroom-hut';
const HUT_DEFAULT_MESSAGE = 'Sorry {heroName} but the princess is in another castle.';

const CASTLE_TYPE_ID = 'testing/castle';
const CASTLE_PREFAB_ID = 'testing/castle';
const CASTLE_BIOME_DECORATOR_ID = 'testing/biome';
const CASTLE_DEFAULT_MESSAGE = 'Welcome to your testing castle, {heroName}.';

const FISH_TYPE_ID = 'testing/fish-school';
const FISH_PREFAB_ID = 'testing/fish-school';
const FISH_DEFAULT_MESSAGE = 'A school of silver fish darts away as you approach. {heroName} finds nothing.';

// Mushroom Hut footprint (relative to its anchor): cove of bramble walls
// around an open-south entry tile.
const HUT_FOOTPRINT_OFFSETS = [
  { dq:  1, dr:  0 },   // E
  { dq: -1, dr:  0 },   // W
  { dq:  1, dr: -1 },   // NE
  { dq:  0, dr: -1 },   // NW
];

// Castle footprint: a ring of bramble hexes around the central POI tile.
// SE is left open so heroes can approach the keep on foot (the gate hex).
const CASTLE_FOOTPRINT_OFFSETS = [
  { dq:  1, dr:  0 },   // E
  { dq: -1, dr:  0 },   // W
  { dq:  1, dr: -1 },   // NE
  { dq:  0, dr: -1 },   // NW
  { dq: -1, dr:  1 },   // SW
];

// Decorator densities — biome content scales with the number of hexes
// the engine assigns to each biome.
const HUT_HEXES_PER = 80;       // 1 mushroom hut per N land hexes
const CAMPFIRE_HEXES_PER = 30;  // 1 campfire per N land hexes
const FISH_HEXES_PER = 50;      // 1 fish school per N sea hexes

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering testing content (castle, mushroom hut, campfire, fish school, biome decorator)');

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
      addComponent(world, entityId, 'Position', { q: params.q ?? 0, r: params.r ?? 0 });
      addComponent(world, entityId, 'MapObject', { typeId: CAMPFIRE_TYPE_ID });
      addComponent(world, entityId, 'Visitable', { message: params.message ?? CAMPFIRE_DEFAULT_MESSAGE });
      addComponent(world, entityId, 'ConsumedOnVisit', {});
      addComponent(world, entityId, 'Actionable', { actionTypeId: 'base/take' });
      return entityId;
    });

    // ── Mushroom Hut ────────────────────────────────────────────────────
    registerMapObjectType(registry, {
      id: HUT_TYPE_ID,
      name: 'Mushroom Hut',
      description: 'A toadstool-shaped cottage. Smoke curls from the window.',
      prefabId: HUT_PREFAB_ID,
      buildMesh: () => buildMushroomHutMesh(),
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
      for (const offset of HUT_FOOTPRINT_OFFSETS) {
        const wallId = createEntity(world);
        addComponent(world, wallId, 'Position', { q: anchorQ + offset.dq, r: anchorR + offset.dr });
        addComponent(world, wallId, 'TerrainOverride', { terrainId: 'bramble' });
      }
      return poiId;
    });

    // ── Castle ──────────────────────────────────────────────────────────
    registerMapObjectType(registry, {
      id: CASTLE_TYPE_ID,
      name: 'Testing Castle',
      description: 'A stout keep with four corner towers and a banner flying from the highest spire.',
      prefabId: CASTLE_PREFAB_ID,
      buildMesh: () => buildCastleMesh(),
    });
    registerPrefab(registry, CASTLE_PREFAB_ID, (world, params) => {
      const anchorQ = params.q ?? 0;
      const anchorR = params.r ?? 0;
      const poiId = createEntity(world);
      addComponent(world, poiId, 'Position', { q: anchorQ, r: anchorR });
      addComponent(world, poiId, 'MapObject', { typeId: CASTLE_TYPE_ID });
      addComponent(world, poiId, 'Visitable', { message: params.message ?? CASTLE_DEFAULT_MESSAGE });
      addComponent(world, poiId, 'Actionable', { actionTypeId: 'base/visit' });
      addComponent(world, poiId, 'Conquerable', {});
      // Castle tag — defeat condition queries for entities with this.
      addComponent(world, poiId, 'Castle', {});
      // BiomeAnchor — the engine maps every nearby tile to this anchor and
      // invokes the named decorator on those hexes.
      addComponent(world, poiId, 'BiomeAnchor', { decoratorId: CASTLE_BIOME_DECORATOR_ID });
      // Each player starts owning their castle outright.
      if (params.playerId) addComponent(world, poiId, 'Ownership', { playerId: params.playerId });
      // Footprint walls — bramble TerrainOverrides making the castle keep
      // unapproachable except from above.
      for (const offset of CASTLE_FOOTPRINT_OFFSETS) {
        const wallId = createEntity(world);
        addComponent(world, wallId, 'Position', { q: anchorQ + offset.dq, r: anchorR + offset.dr });
        addComponent(world, wallId, 'TerrainOverride', { terrainId: 'bramble' });
      }
      return poiId;
    });

    // ── Fish School ─────────────────────────────────────────────────────
    registerMapObjectType(registry, {
      id: FISH_TYPE_ID,
      name: 'Fish School',
      description: 'A shimmering school of fish weaving through the shallows.',
      prefabId: FISH_PREFAB_ID,
      buildMesh: () => buildFishSchoolMesh(),
    });
    registerPrefab(registry, FISH_PREFAB_ID, (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Position', { q: params.q ?? 0, r: params.r ?? 0 });
      addComponent(world, entityId, 'MapObject', { typeId: FISH_TYPE_ID });
      addComponent(world, entityId, 'Visitable', { message: params.message ?? FISH_DEFAULT_MESSAGE });
      addComponent(world, entityId, 'ConsumedOnVisit', {});
      addComponent(world, entityId, 'Actionable', { actionTypeId: 'base/take' });
      return entityId;
    });

    // ── Biome decorator ─────────────────────────────────────────────────
    registerBiomeDecorator(registry, {
      id: CASTLE_BIOME_DECORATOR_ID,
      // Road carver reduces worked tiles inside this biome back to plains.
      baseTerrainId: 'plains',
      decorate({ world, registry: reg, anchorQ, anchorR, biomeHexes, seed, occupiedHexes }) {
        // Seed the noise field per-castle so neighbouring biomes don't end
        // up with identical patterns sitting next to each other.
        const noise = createSeededNoise2D(seed + (anchorQ * 9301) + (anchorR * 49297));

        // Classify biome hexes by what the coarse mapgen produced. Tiles
        // that already carry a TerrainOverride (castle footprint brambles
        // for example) are left alone — the override wins visually +
        // path-wise regardless of Tile.terrainId.
        const landHexes = [];
        const mountainHexes = [];
        const seaHexes = [];
        for (const hex of biomeHexes) {
          const tile = getComponent(world, hex.entityId, 'Tile');
          if (!tile) continue;
          if (tile.terrainId === 'plains') landHexes.push({ tile, hex });
          else if (tile.terrainId === 'dusty-hills') mountainHexes.push({ tile, hex });
          else if (tile.terrainId === 'deep-ocean') seaHexes.push({ tile, hex });
        }

        // LAND: forest-hills / forest / plains
        for (const { tile, hex } of landHexes) {
          const n = fractalNoise2D(noise, hex.q * 0.13, hex.r * 0.13, 3, 0.55, 2.0);
          if (n > 0.45) tile.terrainId = 'forest-hills';
          else if (n > 0.05) tile.terrainId = 'forest';
          else tile.terrainId = 'plains';
        }
        // MOUNTAIN: mountain / dusty-hills
        for (const { tile, hex } of mountainHexes) {
          const n = fractalNoise2D(noise, hex.q * 0.2, hex.r * 0.2, 2, 0.6, 2.0);
          tile.terrainId = n > 0.0 ? 'mountain' : 'dusty-hills';
        }
        // SEA: shallow / deep
        for (const { tile, hex } of seaHexes) {
          const n = fractalNoise2D(noise, hex.q * 0.16, hex.r * 0.16, 2, 0.55, 2.0);
          tile.terrainId = n > 0.0 ? 'shallow-ocean' : 'deep-ocean';
        }

        // Scatter mushroom huts on plains land hexes. The hut has a 4-hex
        // footprint, so we re-validate each anchor against occupiedHexes
        // immediately before placing.
        const hutTarget = Math.floor(landHexes.length / HUT_HEXES_PER);
        const hutAnchors = shuffleCopy(landHexes.map(h => h.hex));
        let hutsPlaced = 0;
        for (const candidate of hutAnchors) {
          if (hutsPlaced >= hutTarget) break;
          if (occupiedHexes.has(hexKey(candidate.q, candidate.r))) continue;
          let valid = true;
          for (const off of HUT_FOOTPRINT_OFFSETS) {
            if (occupiedHexes.has(hexKey(candidate.q + off.dq, candidate.r + off.dr))) {
              valid = false; break;
            }
          }
          if (!valid) continue;
          spawnFromPrefab(reg, HUT_PREFAB_ID, world, { q: candidate.q, r: candidate.r });
          occupiedHexes.add(hexKey(candidate.q, candidate.r));
          for (const off of HUT_FOOTPRINT_OFFSETS) {
            occupiedHexes.add(hexKey(candidate.q + off.dq, candidate.r + off.dr));
          }
          hutsPlaced++;
        }

        // Scatter campfires on the rest of the land tiles.
        const campfireTarget = Math.floor(landHexes.length / CAMPFIRE_HEXES_PER);
        let campfiresPlaced = 0;
        for (const candidate of shuffleCopy(landHexes.map(h => h.hex))) {
          if (campfiresPlaced >= campfireTarget) break;
          const key = hexKey(candidate.q, candidate.r);
          if (occupiedHexes.has(key)) continue;
          spawnFromPrefab(reg, CAMPFIRE_PREFAB_ID, world, { q: candidate.q, r: candidate.r });
          occupiedHexes.add(key);
          campfiresPlaced++;
        }

        // Scatter fish schools in sea hexes (placeholder POIs).
        const fishTarget = Math.floor(seaHexes.length / FISH_HEXES_PER);
        let fishPlaced = 0;
        for (const candidate of shuffleCopy(seaHexes.map(h => h.hex))) {
          if (fishPlaced >= fishTarget) break;
          const key = hexKey(candidate.q, candidate.r);
          if (occupiedHexes.has(key)) continue;
          spawnFromPrefab(reg, FISH_PREFAB_ID, world, { q: candidate.q, r: candidate.r });
          occupiedHexes.add(key);
          fishPlaced++;
        }
      },
    });
  },
};

// Fisher-Yates copy-and-shuffle. Returns a new array.
function shuffleCopy(source) {
  const copy = source.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ── Meshes ──────────────────────────────────────────────────────────────

function buildCampfireMesh() {
  const group = new Group();
  const base = new Mesh(
    new CylinderGeometry(0.42, 0.5, 0.16, 10),
    new MeshStandardMaterial({ color: 0x3a2418, roughness: 0.95, metalness: 0.0 }),
  );
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

function buildMushroomHutMesh() {
  const inner = new Group();
  const stem = new Mesh(
    new CylinderGeometry(0.55, 0.72, 1.55, 16),
    new MeshStandardMaterial({ color: 0xe8d3a8, roughness: 0.9 }),
  );
  stem.position.set(0, 0.77, 0);
  stem.castShadow = true;
  stem.receiveShadow = true;
  inner.add(stem);
  const door = new Mesh(
    new BoxGeometry(0.42, 0.7, 0.06),
    new MeshStandardMaterial({ color: 0x3a2418, roughness: 0.95 }),
  );
  door.position.set(0, 0.5, 0.6);
  door.castShadow = true;
  inner.add(door);
  const windowPane = new Mesh(
    new BoxGeometry(0.22, 0.22, 0.04),
    new MeshStandardMaterial({
      color: 0xffe4a0, emissive: 0xffaa44, emissiveIntensity: 0.85, roughness: 0.4,
    }),
  );
  windowPane.position.set(-0.35, 1.08, 0.59);
  inner.add(windowPane);
  const cap = new Mesh(
    new SphereGeometry(1.0, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2 + 0.15),
    new MeshStandardMaterial({ color: 0xc23026, roughness: 0.55 }),
  );
  cap.position.set(0, 1.45, 0);
  cap.scale.set(1.0, 0.7, 1.0);
  cap.castShadow = true;
  inner.add(cap);
  const flagPole = new Mesh(
    new CylinderGeometry(0.025, 0.025, 0.65, 6),
    new MeshStandardMaterial({ color: 0x222a36, roughness: 0.6 }),
  );
  flagPole.position.set(0, 2.32, 0);
  flagPole.name = 'conquest-flag-pole';
  flagPole.visible = false;
  inner.add(flagPole);
  const flagCloth = new Mesh(
    new PlaneGeometry(0.42, 0.26),
    new MeshStandardMaterial({
      color: 0xffffff, roughness: 0.7, metalness: 0.0, side: DoubleSide, emissive: 0x000000,
    }),
  );
  flagCloth.position.set(0.225, 2.5, 0);
  flagCloth.name = 'conquest-flag';
  flagCloth.visible = false;
  inner.add(flagCloth);
  const spotMaterial = new MeshStandardMaterial({ color: 0xfaf0e0, roughness: 0.7 });
  const spots = [
    { x: -0.40, y: 1.86, z: -0.35 },
    { x:  0.42, y: 1.92, z: -0.20 },
    { x:  0.05, y: 2.02, z:  0.20 },
    { x: -0.25, y: 1.70, z:  0.45 },
    { x:  0.55, y: 1.62, z:  0.40 },
  ];
  for (const pos of spots) {
    const spot = new Mesh(new SphereGeometry(0.12, 8, 6), spotMaterial);
    spot.position.set(pos.x, pos.y, pos.z);
    inner.add(spot);
  }
  const outer = new Group();
  inner.scale.set(1.125, 1.125, 1.125);
  inner.position.set(0, 0, -0.75);
  outer.add(inner);
  return outer;
}

// Castle — outer wall ring + 4 corner towers + central keep + flag on top.
function buildCastleMesh() {
  const inner = new Group();
  const stoneMat = new MeshStandardMaterial({ color: 0xa8a39a, roughness: 0.9 });
  const stoneLightMat = new MeshStandardMaterial({ color: 0xb5b1a8, roughness: 0.85 });
  const roofMat = new MeshStandardMaterial({ color: 0x484956, roughness: 0.65 });
  const woodMat = new MeshStandardMaterial({ color: 0x3a2418, roughness: 0.9 });

  // Outer wall — short wide cylinder
  const wall = new Mesh(new CylinderGeometry(0.78, 0.86, 0.55, 16), stoneMat);
  wall.position.y = 0.275;
  wall.castShadow = true;
  wall.receiveShadow = true;
  inner.add(wall);

  // Four corner towers + conical caps
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(angle) * 0.68;
    const z = Math.sin(angle) * 0.68;
    const tower = new Mesh(new CylinderGeometry(0.18, 0.22, 1.4, 10), stoneLightMat);
    tower.position.set(x, 0.7, z);
    tower.castShadow = true;
    inner.add(tower);
    const roof = new Mesh(new ConeGeometry(0.24, 0.4, 10), roofMat);
    roof.position.set(x, 1.6, z);
    inner.add(roof);
  }

  // Central keep
  const keep = new Mesh(new CylinderGeometry(0.38, 0.42, 1.7, 12), stoneMat);
  keep.position.y = 0.85;
  keep.castShadow = true;
  inner.add(keep);
  const keepRoof = new Mesh(new ConeGeometry(0.46, 0.55, 12), roofMat);
  keepRoof.position.y = 1.98;
  inner.add(keepRoof);

  // Gate facing south
  const gate = new Mesh(new BoxGeometry(0.36, 0.42, 0.08), woodMat);
  gate.position.set(0, 0.21, 0.86);
  inner.add(gate);

  // Conquest flag on the keep spire — named submeshes the renderer tints.
  const flagPole = new Mesh(
    new CylinderGeometry(0.03, 0.03, 0.65, 6),
    new MeshStandardMaterial({ color: 0x2a2520, roughness: 0.6 }),
  );
  flagPole.position.set(0, 2.55, 0);
  flagPole.name = 'conquest-flag-pole';
  flagPole.visible = false;
  inner.add(flagPole);
  const flagCloth = new Mesh(
    new PlaneGeometry(0.46, 0.3),
    new MeshStandardMaterial({
      color: 0xffffff, roughness: 0.65, side: DoubleSide,
    }),
  );
  flagCloth.position.set(0.245, 2.74, 0);
  flagCloth.name = 'conquest-flag';
  flagCloth.visible = false;
  inner.add(flagCloth);

  const outer = new Group();
  outer.add(inner);
  return outer;
}

// Fish school — a cluster of small fish-shaped boxes hovering just above
// the water surface. Color-graded blue-silver to read against dark seas.
function buildFishSchoolMesh() {
  const group = new Group();
  const bodyMat = new MeshStandardMaterial({
    color: 0x9ed8f0, roughness: 0.45, metalness: 0.25,
    emissive: 0x123040, emissiveIntensity: 0.2,
  });
  const fishes = [
    { x:  0.0,  z:  0.0,  yaw: 0.0 },
    { x:  0.22, z:  0.16, yaw: 0.3 },
    { x: -0.18, z:  0.12, yaw: -0.25 },
    { x:  0.12, z: -0.2,  yaw: 0.6 },
    { x: -0.14, z: -0.08, yaw: -0.5 },
    { x:  0.28, z: -0.05, yaw: 0.15 },
  ];
  for (const f of fishes) {
    const body = new Mesh(new BoxGeometry(0.22, 0.05, 0.08), bodyMat);
    body.position.set(f.x, 0.12, f.z);
    body.rotation.y = f.yaw;
    group.add(body);
    // Tail
    const tail = new Mesh(new ConeGeometry(0.04, 0.08, 6), bodyMat);
    tail.position.set(f.x - 0.13 * Math.cos(f.yaw), 0.12, f.z + 0.13 * Math.sin(f.yaw));
    tail.rotation.z = Math.PI / 2;
    tail.rotation.y = f.yaw;
    group.add(tail);
  }
  return group;
}
