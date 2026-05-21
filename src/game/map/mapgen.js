// Map generation. Walks every hex inside a bounding radius, samples fractal
// noise to choose a terrain id from the registry's "generationBuckets" rule,
// and spawns a tile prefab for each cell.

import { hexesInRadius, hexKey } from './hex.js';
import { createSeededNoise2D, fractalNoise2D } from './perlin.js';
import { spawnFromPrefab } from '../ecs/registry.js';

// Order of preference when picking a terrain from noise. The first bucket
// whose `maxHeight` exceeds the sample wins. Modules can override or extend
// this via the registry — for now we hard-code the base terrain mapping.
const DEFAULT_HEIGHT_BUCKETS = [
  { maxHeight: -0.20, terrainId: 'water' },
  { maxHeight:  0.45, terrainId: 'grass' },
  { maxHeight:  1.01, terrainId: 'mountain' },
];

function pickTerrainId(heightSample, buckets) {
  for (const bucket of buckets) {
    if (heightSample <= bucket.maxHeight) return bucket.terrainId;
  }
  return buckets[buckets.length - 1].terrainId;
}

export function generateMap(world, registry, options = {}) {
  const radius = options.radius ?? 12;
  const seed = options.seed ?? 1337;
  const tilePrefabId = options.tilePrefabId ?? 'base/tile';
  const heightBuckets = options.heightBuckets ?? DEFAULT_HEIGHT_BUCKETS;

  const noise = createSeededNoise2D(seed);
  const noiseScale = options.noiseScale ?? 0.12;

  const created = [];
  for (const cell of hexesInRadius(0, 0, radius)) {
    const sample = fractalNoise2D(noise, cell.q * noiseScale, cell.r * noiseScale, 4, 0.55, 2.0);
    const terrainId = pickTerrainId(sample, heightBuckets);
    const entityId = spawnFromPrefab(registry, tilePrefabId, world, {
      q: cell.q,
      r: cell.r,
      terrainId,
    });
    created.push({ entityId, q: cell.q, r: cell.r, terrainId });
  }
  return created;
}

// Pick a starting hex for a player — first walkable tile encountered while
// spiralling outward from a seed point. Used to spread heroes apart.
export function findSpawnHex(world, registry, tilesCreated, preferredCenter, minDistanceFromOthers, takenSpawns) {
  // tilesCreated is the array returned by generateMap; iterate by distance
  // from preferredCenter and return the first walkable, far-enough tile.
  const sorted = tilesCreated.slice().sort((a, b) => {
    const da = hexLikeDistance(a, preferredCenter);
    const db = hexLikeDistance(b, preferredCenter);
    return da - db;
  });
  for (const tile of sorted) {
    const terrain = registry.terrains.get(tile.terrainId);
    if (!terrain || !terrain.walkable) continue;
    let tooClose = false;
    for (const taken of takenSpawns) {
      if (hexLikeDistance(tile, taken) < minDistanceFromOthers) { tooClose = true; break; }
    }
    if (tooClose) continue;
    return { q: tile.q, r: tile.r };
  }
  return null;
}

function hexLikeDistance(a, b) {
  const aX = a.q;
  const aZ = a.r;
  const aY = -aX - aZ;
  const bX = b.q;
  const bZ = b.r;
  const bY = -bX - bZ;
  return (Math.abs(aX - bX) + Math.abs(aY - bY) + Math.abs(aZ - bZ)) / 2;
}
