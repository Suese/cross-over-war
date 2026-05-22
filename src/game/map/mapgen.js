// Map generation.
//
// Produces a centred rectangle of axial hex coordinates (default 256×256)
// and stamps a terrain id at each cell from fractal-noise height samples.
// To keep the map visually rectangular in pixel space (rather than a
// parallelogram), each row r shifts its q range by -floor(r/2).

import { hexKey } from './hex.js';
import { createSeededNoise2D, fractalNoise2D } from './perlin.js';
import { spawnFromPrefab } from '../ecs/registry.js';
import { resolveTerrainCost } from '../ecs/traversal.js';

// Default sea / land / mountain thresholds in [0, 1]. The lobby slider
// overrides these per game; the internal fractal noise produces samples in
// [-1, 1] which we remap to [0, 1] before applying the cutoffs.
const DEFAULT_SEA_THRESHOLD = 0.40;
const DEFAULT_MOUNTAIN_THRESHOLD = 0.725;

// Convert seed bytes into a deterministic [0, 1) PRNG. Used to vary noise
// parameters per seed so a "1337 map" and a "1338 map" feel structurally
// different (one might be archipelago-y, one continental) without losing
// reproducibility.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derive scale / octave count / persistence (turbulence) / lacunarity from
// the seed. Same seed → same params, every time.
function noiseParametersFromSeed(seed) {
  const rng = mulberry32(seed ^ 0xC0DE);
  return {
    scale:        0.025 + rng() * 0.07,   // [0.025, 0.095]  — controls feature size
    octaves:      2     + Math.floor(rng() * 4),   // [2, 5]
    persistence:  0.40  + rng() * 0.30,   // [0.40, 0.70]    — turbulence
    lacunarity:   1.80  + rng() * 0.45,   // [1.80, 2.25]
  };
}

export function generateMap(world, registry, options = {}) {
  const width = options.width ?? 256;
  const height = options.height ?? 256;
  const seed = options.seed ?? 1337;
  const tilePrefabId = options.tilePrefabId ?? 'base/tile';
  // User-supplied thresholds in [0, 1] space.
  const seaThreshold = options.seaThreshold ?? DEFAULT_SEA_THRESHOLD;
  const mountainThreshold = options.mountainThreshold ?? DEFAULT_MOUNTAIN_THRESHOLD;

  const params = noiseParametersFromSeed(seed);
  const noise = createSeededNoise2D(seed);
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);

  const created = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const r = rowIndex - halfHeight;
    const rowShift = Math.floor(r / 2);
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      const q = columnIndex - halfWidth - rowShift;
      const rawSample = fractalNoise2D(
        noise,
        q * params.scale,
        r * params.scale,
        params.octaves, params.persistence, params.lacunarity,
      );
      // fractalNoise2D returns roughly [-1, 1]. Remap to [0, 1] for the
      // user-friendly threshold comparison.
      const normalised = (rawSample + 1) * 0.5;
      let terrainId;
      if (normalised < seaThreshold) terrainId = 'deep-ocean';
      else if (normalised < mountainThreshold) terrainId = 'plains';
      else terrainId = 'dusty-hills';
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
    if (resolveTerrainCost(terrain, ['Land']) == null) continue;
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
