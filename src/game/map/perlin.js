// Tiny wrapper around simplex-noise to keep callers free of vendor specifics
// and to expose a seeded constructor.

import { createNoise2D } from 'simplex-noise';

// Deterministic PRNG (mulberry32) — simplex-noise wants a random function.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededNoise2D(seed) {
  return createNoise2D(mulberry32(seed));
}

// Fractal noise (sum of octaves). Useful for richer terrain shapes.
export function fractalNoise2D(noiseFunction, x, y, octaves = 4, persistence = 0.5, lacunarity = 2.0) {
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  let normalizer = 0;
  for (let octave = 0; octave < octaves; octave++) {
    total += noiseFunction(x * frequency, y * frequency) * amplitude;
    normalizer += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return total / normalizer;
}
