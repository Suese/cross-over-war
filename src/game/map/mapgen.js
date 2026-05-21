// Map generation.
//
// Produces a centred rectangle of axial hex coordinates (default 256×256)
// and stamps a terrain id at each cell from fractal-noise height samples.
// To keep the map visually rectangular in pixel space (rather than a
// parallelogram), each row r shifts its q range by -floor(r/2).

import { hexKey } from './hex.js';
import { createSeededNoise2D, fractalNoise2D } from './perlin.js';
import { spawnFromPrefab } from '../ecs/registry.js';
import { terrainSupportsAnyMode } from './pathfinding.js';

// Terrain id chosen from a height sample (height in [-1, 1]).
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
  const width = options.width ?? 256;
  const height = options.height ?? 256;
  const seed = options.seed ?? 1337;
  const tilePrefabId = options.tilePrefabId ?? 'base/tile';
  const heightBuckets = options.heightBuckets ?? DEFAULT_HEIGHT_BUCKETS;
  const noiseScale = options.noiseScale ?? 0.05;

  const noise = createSeededNoise2D(seed);
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);

  const created = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const r = rowIndex - halfHeight;
    const rowShift = Math.floor(r / 2);
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      const q = columnIndex - halfWidth - rowShift;
      const sample = fractalNoise2D(
        noise,
        q * noiseScale,
        r * noiseScale,
        4, 0.55, 2.0,
      );
      const terrainId = pickTerrainId(sample, heightBuckets);
      const entityId = spawnFromPrefab(registry, tilePrefabId, world, { q, r, terrainId });
      created.push({ entityId, q, r, terrainId });
    }
  }
  return created;
}

// Pick a starting hex for a player — first walkable tile encountered while
// spiralling outward from a seed point. Used to spread heroes apart.
export function findSpawnHex(world, registry, tilesCreated, preferredCenter, minDistanceFromOthers, takenSpawns) {
  const sorted = tilesCreated.slice().sort((a, b) => {
    const da = hexLikeDistance(a, preferredCenter);
    const db = hexLikeDistance(b, preferredCenter);
    return da - db;
  });
  for (const tile of sorted) {
    const terrain = registry.terrains.get(tile.terrainId);
    if (!terrainSupportsAnyMode(terrain, ['land'])) continue;
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
