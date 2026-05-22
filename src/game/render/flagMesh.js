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
const FLAG_TEXTURE_SIZE = 128;

// Default flag if a player has nothing configured yet (or a remote player's
// config hasn't arrived). Crimson over white over navy with a sun emblem in
// gold — a neutral-but-distinctive look, not tied to any palette index.
export const DEFAULT_FLAG_CONFIG = Object.freeze({
  colours: [0xc81428, 0xffffff, 0x1a4a8a],
  stripe: 'horizontal',
  emblemId: 'base/sun',
  emblemColour: 0xd4a834,
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
  canvas.width = FLAG_TEXTURE_SIZE;
  canvas.height = FLAG_TEXTURE_SIZE;
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
  if (!['horizontal', 'vertical', 'diagonal'].includes(merged.stripe)) merged.stripe = 'horizontal';
  if (typeof merged.emblemId !== 'string' || !merged.emblemId) merged.emblemId = 'base/blank';
  return merged;
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
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  paintStripes(ctx, size, config.colours, config.stripe);
  paintEmblem(ctx, size, config, registry);
}

function paintStripes(ctx, size, colours, stripe) {
  const [a, b, c] = colours;
  if (stripe === 'horizontal') {
    const band = size / 3;
    ctx.fillStyle = hexToCss(a); ctx.fillRect(0, 0, size, band);
    ctx.fillStyle = hexToCss(b); ctx.fillRect(0, band, size, band);
    ctx.fillStyle = hexToCss(c); ctx.fillRect(0, band * 2, size, band);
    return;
  }
  if (stripe === 'vertical') {
    const band = size / 3;
    ctx.fillStyle = hexToCss(a); ctx.fillRect(0, 0, band, size);
    ctx.fillStyle = hexToCss(b); ctx.fillRect(band, 0, band, size);
    ctx.fillStyle = hexToCss(c); ctx.fillRect(band * 2, 0, band, size);
    return;
  }
  // Diagonal: three bands cut top-left → bottom-right.
  // Fill the whole canvas with the middle colour first, then paint the
  // bottom-left triangle in `a` and the top-right triangle in `c`.
  ctx.fillStyle = hexToCss(b); ctx.fillRect(0, 0, size, size);
  // Offsets chosen so each diagonal band covers roughly a third of the area.
  const offset = size * 0.33;
  ctx.fillStyle = hexToCss(a);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size - offset, 0);
  ctx.lineTo(0, size - offset);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = hexToCss(c);
  ctx.beginPath();
  ctx.moveTo(size, size);
  ctx.lineTo(offset, size);
  ctx.lineTo(size, offset);
  ctx.closePath();
  ctx.fill();
}

function paintEmblem(ctx, size, config, registry) {
  if (!config.emblemId || config.emblemId === 'base/blank') return;
  const emblem = registry ? getEmblem(registry, config.emblemId) : null;
  if (!emblem?.draw) return;
  // Emblem renders into a temp canvas at the same resolution so its
  // composite operations don't bleed into the stripe layer.
  const tmp = document.createElement('canvas');
  tmp.width = size; tmp.height = size;
  const tmpCtx = tmp.getContext('2d');
  try {
    emblem.draw(tmpCtx, size, config.emblemColour & 0xffffff);
  } catch (err) {
    console.warn('emblem draw failed for ' + config.emblemId, err);
    return;
  }
  ctx.drawImage(tmp, 0, 0);
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
