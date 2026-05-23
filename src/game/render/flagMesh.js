// Player-customisable flags.
//
// Each player picks three colours, a stripe direction, an emblem, and an
// emblem colour in the lobby. The resulting `FlagConfig` is broadcast to
// every client and used to build a small flag mesh that gets mounted to
// every entity with a `BearsFlag` component (heroes and Conquerable POIs).
//
// The mesh layout is shared across all entities: a thin pole + a cloth
// plane whose CanvasTexture is regenerated from the player's flag config.
// Mounting is driven by the entity mesh — `buildHeroMesh` and the
// procedural POI meshes attach an empty `flag-attach` Group at the
// position they want the pole's base; the renderer adds the flag mesh as
// that group's child.
//
// FlagConfig shape (kept tiny so it serialises cheaply on the wire):
//   {
//     colours:       [number, number, number],   // three 24-bit RGB hex values
//     stripe:        'horizontal' | 'vertical' | 'diagonal',
//     emblemId:      string,                     // registered emblem id, or 'base/blank'
//     emblemColour:  number,                     // 24-bit RGB hex
//   }

import {
  Color,
  CylinderGeometry,
  PlaneGeometry,
  Mesh,
  MeshStandardMaterial,
  CanvasTexture,
  DoubleSide,
  Group,
  SRGBColorSpace,
} from 'three';
import { getEmblem } from '../ecs/registry.js';

const POLE_HEIGHT = 0.75;
const POLE_RADIUS = 0.025;
const CLOTH_WIDTH = 0.50;
const CLOTH_HEIGHT = 0.32;
// In-game cloth texture matches the cloth's aspect ratio so the stripes /
// emblem don't get stretched when mapped onto the plane.
const FLAG_TEXTURE_WIDTH = 200;
const FLAG_TEXTURE_HEIGHT = 128;

export const VALID_STRIPES = ['horizontal', 'vertical', 'diagonal'];
export const VALID_EMBLEM_POSITIONS = ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

// Default flag if a player has nothing configured yet (or a remote player's
// config hasn't arrived). Crimson over white over navy with a sun emblem in
// gold — a neutral-but-distinctive look, not tied to any palette index.
export const DEFAULT_FLAG_CONFIG = Object.freeze({
  colours: [0xc81428, 0xffffff, 0x1a4a8a],
  stripe: 'horizontal',
  emblemId: 'base/sun',
  emblemColour: 0xd4a834,
  emblemSize: 0.6,
  emblemPosition: 'center',
});

// Build a mesh group containing the pole and the cloth. The cloth's
// material owns a CanvasTexture that's regenerated whenever the flag
// config changes — call `applyFlagConfig(group, config, registry)` to
// repaint without rebuilding the geometry.
export function buildFlagMesh(flagConfig, registry) {
  const group = new Group();
  group.name = 'mounted-flag';

  const poleMaterial = new MeshStandardMaterial({ color: 0x2a2520, roughness: 0.6 });
  const pole = new Mesh(new CylinderGeometry(POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 6), poleMaterial);
  pole.name = 'flag-pole';
  pole.position.y = POLE_HEIGHT / 2;
  group.add(pole);

  const canvas = document.createElement('canvas');
  canvas.width = FLAG_TEXTURE_WIDTH;
  canvas.height = FLAG_TEXTURE_HEIGHT;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;

  const clothMaterial = new MeshStandardMaterial({
    map: texture,
    roughness: 0.65,
    metalness: 0.0,
    side: DoubleSide,
  });
  const cloth = new Mesh(new PlaneGeometry(CLOTH_WIDTH, CLOTH_HEIGHT), clothMaterial);
  cloth.name = 'flag-cloth';
  // The pole-bound edge of the cloth sits flush with the pole; the rest
  // billows to one side.
  cloth.position.set(CLOTH_WIDTH / 2, POLE_HEIGHT - CLOTH_HEIGHT / 2, 0);
  group.add(cloth);

  group.userData.flagCanvas = canvas;
  group.userData.flagTexture = texture;
  applyFlagConfig(group, flagConfig, registry);
  return group;
}

// Repaint an existing mounted flag with a new config. No-op if the mesh
// wasn't produced by `buildFlagMesh`.
export function applyFlagConfig(meshGroup, flagConfig, registry) {
  const canvas = meshGroup.userData?.flagCanvas;
  const texture = meshGroup.userData?.flagTexture;
  if (!canvas || !texture) return;
  const config = sanitiseConfig(flagConfig);
  paintFlagTexture(canvas, config, registry);
  texture.needsUpdate = true;
  meshGroup.userData.flagConfig = config;
}

// Free the GPU resources tied to a mounted flag. Call before discarding
// the mesh (e.g. when its owning entity changes flags or is removed).
export function disposeFlagMesh(meshGroup) {
  meshGroup.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose?.();
      const material = child.material;
      if (Array.isArray(material)) material.forEach(m => m.map?.dispose?.());
      else material?.map?.dispose?.();
      material?.dispose?.();
    }
  });
}

function sanitiseConfig(flagConfig) {
  const merged = { ...DEFAULT_FLAG_CONFIG, ...(flagConfig ?? {}) };
  const colours = Array.isArray(merged.colours) ? merged.colours.slice(0, 3) : [];
  while (colours.length < 3) colours.push(DEFAULT_FLAG_CONFIG.colours[colours.length]);
  merged.colours = colours.map(coerceHex);
  merged.emblemColour = coerceHex(merged.emblemColour);
  if (!VALID_STRIPES.includes(merged.stripe)) merged.stripe = 'horizontal';
  if (typeof merged.emblemId !== 'string' || !merged.emblemId) merged.emblemId = 'base/blank';
  merged.emblemSize = clampNumber(merged.emblemSize, 0.15, 1.0, DEFAULT_FLAG_CONFIG.emblemSize);
  if (!VALID_EMBLEM_POSITIONS.includes(merged.emblemPosition)) merged.emblemPosition = 'center';
  return merged;
}

function clampNumber(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function coerceHex(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value & 0xffffff;
  if (typeof value === 'string') {
    const trimmed = value.startsWith('#') ? value.slice(1) : value;
    const parsed = parseInt(trimmed, 16);
    if (Number.isFinite(parsed)) return parsed & 0xffffff;
  }
  return 0xffffff;
}

function hexToCss(hex) {
  return '#' + (hex & 0xffffff).toString(16).padStart(6, '0');
}

function paintFlagTexture(canvas, config, registry) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  paintStripes(ctx, w, h, config.colours, config.stripe);
  paintEmblem(ctx, w, h, config, registry);
}

function paintStripes(ctx, w, h, colours, stripe) {
  const [a, b, c] = colours;
  if (stripe === 'horizontal') {
    const band = h / 3;
    ctx.fillStyle = hexToCss(a); ctx.fillRect(0, 0, w, band);
    ctx.fillStyle = hexToCss(b); ctx.fillRect(0, band, w, band);
    ctx.fillStyle = hexToCss(c); ctx.fillRect(0, band * 2, w, band);
    return;
  }
  if (stripe === 'vertical') {
    const band = w / 3;
    ctx.fillStyle = hexToCss(a); ctx.fillRect(0, 0, band, h);
    ctx.fillStyle = hexToCss(b); ctx.fillRect(band, 0, band, h);
    ctx.fillStyle = hexToCss(c); ctx.fillRect(band * 2, 0, band, h);
    return;
  }
  // Diagonal: three bands cut top-left → bottom-right, anchored to the
  // actual canvas dimensions rather than a single `size` so non-square
  // canvases still get equal-area regions.
  ctx.fillStyle = hexToCss(b); ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = hexToCss(a);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w * 0.67, 0);
  ctx.lineTo(0, h * 0.67);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = hexToCss(c);
  ctx.beginPath();
  ctx.moveTo(w, h);
  ctx.lineTo(w * 0.33, h);
  ctx.lineTo(w, h * 0.33);
  ctx.closePath();
  ctx.fill();
}

function paintEmblem(ctx, w, h, config, registry) {
  if (!config.emblemId || config.emblemId === 'base/blank') return;
  const emblem = registry ? getEmblem(registry, config.emblemId) : null;
  if (!emblem?.draw) return;
  // Emblem authors paint into a square subcanvas. We allocate that square
  // sized by `emblemSize` relative to the shorter cloth axis, then composite
  // it onto the stripe layer at the requested corner / centre.
  const shortAxis = Math.min(w, h);
  const square = Math.max(8, Math.round(shortAxis * config.emblemSize));
  const tmp = document.createElement('canvas');
  tmp.width = square;
  tmp.height = square;
  const tmpCtx = tmp.getContext('2d');
  try {
    emblem.draw(tmpCtx, square, config.emblemColour & 0xffffff);
  } catch (err) {
    console.warn('emblem draw failed for ' + config.emblemId, err);
    return;
  }
  // Pad corner placements off the edge by a small fraction of the canvas so
  // the emblem sits inside the cloth rather than touching the seam.
  const padding = Math.round(shortAxis * 0.06);
  let dx, dy;
  switch (config.emblemPosition) {
    case 'top-left':     dx = padding;            dy = padding;            break;
    case 'top-right':    dx = w - square - padding; dy = padding;          break;
    case 'bottom-left':  dx = padding;            dy = h - square - padding; break;
    case 'bottom-right': dx = w - square - padding; dy = h - square - padding; break;
    case 'center':
    default:
      dx = (w - square) / 2;
      dy = (h - square) / 2;
      break;
  }
  ctx.drawImage(tmp, dx, dy);
}

// Convenience colour for surrounding UI tints (lobby dots, hero body, etc.).
// Returns the middle stripe colour, which usually reads as the "primary"
// across all three stripe directions.
export function primaryColourOf(flagConfig) {
  const config = sanitiseConfig(flagConfig);
  return new Color(config.colours[1]);
}

export { sanitiseConfig as sanitiseFlagConfig };

// Paint a flag onto an externally-supplied 2D canvas (e.g. the lobby's live
// preview). Sanitises the config first so it tolerates partial / malformed
// input straight out of the editor.
export function paintFlagToCanvas(canvas, flagConfig, registry) {
  const config = sanitiseConfig(flagConfig);
  paintFlagTexture(canvas, config, registry);
}
