// Kingdom helpers — shared scaffolding the four kingdom modules use to
// register a standard castle prefab, a paint-and-scatter biome decorator,
// and a simple placeholder mesh.
//
// The art here is intentionally lo-fi: a tinted box for the castle, with a
// `flag-attach` Group above it so the conquest flag mounts properly. The
// expectation is that real meshes replace these per kingdom later — the
// boxes are obvious placeholders that still play correctly.

import {
  BoxGeometry, Mesh, MeshStandardMaterial, Group,
} from 'three';
import { createEntity, addComponent, getComponent } from '../ecs/world.js';
import {
  registerPrefab, registerMapObjectType, registerBiomeDecorator, spawnFromPrefab,
} from '../ecs/registry.js';
import { hexKey } from '../map/hex.js';
import { createSeededNoise2D, fractalNoise2D } from '../map/perlin.js';

// Castle bramble ring. SE is left open so heroes can approach the keep
// directly without the engine having to wall-clip.
export const CASTLE_FOOTPRINT_OFFSETS = [
  { dq:  1, dr:  0 },   // E
  { dq: -1, dr:  0 },   // W
  { dq:  1, dr: -1 },   // NE
  { dq:  0, dr: -1 },   // NW
  { dq: -1, dr:  1 },   // SW
];

// Register a standard kingdom castle: bramble footprint, Conquerable + Castle
// + BearsFlag tags, BiomeAnchor seeded to the kingdom's primary decorator,
// and a tinted placeholder box mesh.
export function registerStandardCastle(registry, {
  prefabId, typeId, name, description,
  accentColour, biomeDecoratorId, defaultMessage,
}) {
  registerMapObjectType(registry, {
    id: typeId,
    name,
    description,
    prefabId,
    buildMesh: () => buildPlaceholderCastleMesh(accentColour),
  });
  registerPrefab(registry, prefabId, (world, params) => {
    const anchorQ = params.q ?? 0;
    const anchorR = params.r ?? 0;
    const poiId = createEntity(world);
    addComponent(world, poiId, 'Position', { q: anchorQ, r: anchorR });
    addComponent(world, poiId, 'MapObject', { typeId });
    addComponent(world, poiId, 'Visitable', { message: params.message ?? defaultMessage });
    addComponent(world, poiId, 'Actionable', { actionTypeId: 'base/visit' });
    addComponent(world, poiId, 'Conquerable', {});
    addComponent(world, poiId, 'BearsFlag', {});
    addComponent(world, poiId, 'Castle', {});
    addComponent(world, poiId, 'BiomeAnchor', { decoratorId: biomeDecoratorId });
    if (params.playerId) addComponent(world, poiId, 'Ownership', { playerId: params.playerId });
    for (const offset of CASTLE_FOOTPRINT_OFFSETS) {
      const wallId = createEntity(world);
      addComponent(world, wallId, 'Position', {
        q: anchorQ + offset.dq, r: anchorR + offset.dr,
      });
      addComponent(world, wallId, 'TerrainOverride', { terrainId: 'bramble' });
    }
    return poiId;
  });
}

// Placeholder castle: a single tinted box. Obvious that it needs a real
// model later, but plays correctly — flag-attach Group sits above the box
// top so the conquest flag mounts at the right height.
export function buildPlaceholderCastleMesh(accentColour) {
  const group = new Group();
  const box = new Mesh(
    new BoxGeometry(1.4, 1.6, 1.4),
    new MeshStandardMaterial({ color: accentColour ?? 0x888888, roughness: 0.8 }),
  );
  box.position.y = 0.8;
  box.castShadow = true;
  box.receiveShadow = true;
  group.add(box);
  const flagAttach = new Group();
  flagAttach.name = 'flag-attach';
  flagAttach.position.set(0, 1.75, 0);
  group.add(flagAttach);
  return group;
}

// Register a paint-and-scatter biome decorator. `paintRules` maps a base
// terrain id to a rule { high, mid, low, scale? } — the noise lookup picks
// one of those terrain ids depending on the noise value. `scatters` is a
// list of POI sprinkle rules — each places `density * matching-hexes` POIs
// onto hexes whose post-paint terrain is in `terrainIds`.
//
// Scatter rule shape:
//   { prefabId, density: 1/N, terrainIds: ['plains', ...], footprintOffsets? }
// `footprintOffsets` is for multi-hex POIs — every offset must also be
// unoccupied before the POI can be placed there.
export function registerPaintBiomeDecorator(registry, {
  id, baseTerrainId = 'plains', paintRules = {}, scatters = [],
}) {
  registerBiomeDecorator(registry, {
    id,
    baseTerrainId,
    decorate(ctx) {
      const { world, registry: reg, anchorQ, anchorR, biomeHexes, seed, occupiedHexes } = ctx;
      const noise = createSeededNoise2D(seed + (anchorQ * 9301) + (anchorR * 49297));

      // First pass — paint terrain. Group biome hexes by their pre-paint
      // base id so each rule only sees the hexes it was authored for.
      const byBaseTerrain = new Map();
      for (const hex of biomeHexes) {
        const tile = getComponent(world, hex.entityId, 'Tile');
        if (!tile) continue;
        if (!byBaseTerrain.has(tile.terrainId)) byBaseTerrain.set(tile.terrainId, []);
        byBaseTerrain.get(tile.terrainId).push({ tile, hex });
      }
      for (const [baseId, list] of byBaseTerrain) {
        const rule = paintRules[baseId];
        if (!rule) continue;
        const scale = rule.scale ?? 0.15;
        for (const { tile, hex } of list) {
          const n = fractalNoise2D(noise, hex.q * scale, hex.r * scale, 3, 0.55, 2.0);
          if (rule.high !== undefined && n > 0.45) tile.terrainId = rule.high;
          else if (rule.mid !== undefined && n > 0.05) tile.terrainId = rule.mid;
          else if (rule.low !== undefined) tile.terrainId = rule.low;
        }
      }

      // Second pass — scatter POIs onto hexes whose post-paint terrain
      // matches the scatter rule. Footprint scatters re-validate every
      // offset against `occupiedHexes` before placement.
      for (const scatter of scatters) {
        const validHexes = biomeHexes.filter((h) => {
          const tile = getComponent(world, h.entityId, 'Tile');
          return tile && scatter.terrainIds.includes(tile.terrainId);
        });
        const target = Math.floor(validHexes.length * scatter.density);
        let placed = 0;
        for (const candidate of shuffleCopy(validHexes)) {
          if (placed >= target) break;
          const key = hexKey(candidate.q, candidate.r);
          if (occupiedHexes.has(key)) continue;
          if (scatter.footprintOffsets) {
            let valid = true;
            for (const off of scatter.footprintOffsets) {
              if (occupiedHexes.has(hexKey(candidate.q + off.dq, candidate.r + off.dr))) {
                valid = false; break;
              }
            }
            if (!valid) continue;
            spawnFromPrefab(reg, scatter.prefabId, world, { q: candidate.q, r: candidate.r });
            occupiedHexes.add(key);
            for (const off of scatter.footprintOffsets) {
              occupiedHexes.add(hexKey(candidate.q + off.dq, candidate.r + off.dr));
            }
          } else {
            spawnFromPrefab(reg, scatter.prefabId, world, { q: candidate.q, r: candidate.r });
            occupiedHexes.add(key);
          }
          placed++;
        }
      }
    },
  });
}

function shuffleCopy(source) {
  const copy = source.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
