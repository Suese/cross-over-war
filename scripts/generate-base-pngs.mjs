// One-shot script that writes simple textured PNGs for the base module's
// three starting terrains. Each PNG is a 64×64 RGBA image with deterministic
// noise so they tile pleasantly when wrapped around a hex face.
//
// Run with: node scripts/generate-base-pngs.mjs
// Idempotent — overwrites the files in modules/base/assets/.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(here, '../src/modules/base/assets');
mkdirSync(assetsDir, { recursive: true });

// ── PNG encoder (RGBA, 8-bit) ──────────────────────────────────────────────
function crc32(bytes) {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    value ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 0);
  return Buffer.concat([length, typeBytes, payload, crc]);
}

function encodePng(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // color type: truecolor with alpha
  header[10] = 0;  // compression
  header[11] = 0;  // filter
  header[12] = 0;  // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter byte: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Simple pseudo-random helpers, deterministic per call.
function makeRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

// Drop a pixel onto an RGBA buffer.
function setPixel(buffer, width, x, y, r, g, b, a = 255) {
  const offset = (y * width + x) * 4;
  buffer[offset]     = r;
  buffer[offset + 1] = g;
  buffer[offset + 2] = b;
  buffer[offset + 3] = a;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ── Texture recipes ────────────────────────────────────────────────────────
const SIZE = 64;

function generateGrass() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const random = makeRandom(0x91A55);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const wobble = (random() - 0.5) * 30;
      const r = clamp(60 + wobble * 0.5, 30, 110);
      const g = clamp(140 + wobble,     90, 200);
      const b = clamp(50 + wobble * 0.4, 20, 100);
      setPixel(pixels, SIZE, x, y, r | 0, g | 0, b | 0);
    }
  }
  // Sprinkle darker grass tufts.
  for (let i = 0; i < 120; i++) {
    const x = (random() * SIZE) | 0;
    const y = (random() * SIZE) | 0;
    setPixel(pixels, SIZE, x, y, 40, 100, 30);
  }
  return encodePng(SIZE, SIZE, pixels);
}

function generateWater() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const random = makeRandom(0xA471);
  for (let y = 0; y < SIZE; y++) {
    // Horizontal banding for waves.
    const bandShift = Math.sin(y * 0.4) * 12;
    for (let x = 0; x < SIZE; x++) {
      const wobble = (random() - 0.5) * 16 + bandShift;
      const r = clamp(30 + wobble * 0.3,  10,  80);
      const g = clamp(110 + wobble * 0.6, 60, 180);
      const b = clamp(190 + wobble,        120, 240);
      setPixel(pixels, SIZE, x, y, r | 0, g | 0, b | 0);
    }
  }
  // Tiny highlights for foam.
  for (let i = 0; i < 30; i++) {
    const x = (random() * SIZE) | 0;
    const y = (random() * SIZE) | 0;
    setPixel(pixels, SIZE, x, y, 220, 240, 255);
  }
  return encodePng(SIZE, SIZE, pixels);
}

function generateMountain() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const random = makeRandom(0x5CA1E);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const wobble = (random() - 0.5) * 40;
      // Rock base — desaturated brown-grey.
      const r = clamp(110 + wobble, 60, 180);
      const g = clamp(100 + wobble, 50, 160);
      const b = clamp(90  + wobble, 40, 150);
      setPixel(pixels, SIZE, x, y, r | 0, g | 0, b | 0);
    }
  }
  // Snowy specks near the top of the texture so it reads as elevated.
  for (let i = 0; i < 80; i++) {
    const x = (random() * SIZE) | 0;
    const y = (random() * (SIZE * 0.4)) | 0;
    setPixel(pixels, SIZE, x, y, 240, 240, 245);
  }
  return encodePng(SIZE, SIZE, pixels);
}

// ── Write the three textures ───────────────────────────────────────────────
const outputs = [
  ['grass.png',    generateGrass()],
  ['water.png',    generateWater()],
  ['mountain.png', generateMountain()],
];

for (const [name, bytes] of outputs) {
  const path = resolve(assetsDir, name);
  writeFileSync(path, bytes);
  console.log(`wrote ${path} (${bytes.length} bytes)`);
}
