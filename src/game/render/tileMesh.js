// Hex tile mesh. Each tile is a short flat hexagonal cylinder textured with
// the terrain's texture (if a PNG was found in the module's assets folder),
// otherwise tinted with the terrain's fallback colour.

import {
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Color,
} from 'three';
import { hexToPixel } from '../map/hex.js';
import { getTerrain } from '../ecs/registry.js';
import { getComponent } from '../ecs/world.js';

const TILE_HEIGHT = 0.4;

// Three.js's CylinderGeometry with 6 segments produces a flat-top hex by
// default; for pointy-top alignment we rotate the mesh 30° around Y.
// One geometry instance shared across all tiles to keep things light.
const sharedGeometry = new CylinderGeometry(0.95, 0.95, TILE_HEIGHT, 6);

const materialCache = new Map(); // terrainId → MeshStandardMaterial

function getOrCreateMaterial(registry, assets, terrainId) {
  if (materialCache.has(terrainId)) return materialCache.get(terrainId);
  const terrain = getTerrain(registry, terrainId);
  const baseColor = terrain?.fallbackColor ? new Color(terrain.fallbackColor) : new Color(0x888888);
  const material = new MeshStandardMaterial({
    color: baseColor,
    roughness: 0.95,
    metalness: 0.0,
  });
  if (terrain?.textureKey) {
    const texture = assets.getTexture(terrain.textureKey, { requestedBy: 'terrain:' + terrainId });
    if (texture) {
      texture.repeat.set(1, 1);
      material.map = texture;
    }
  }
  materialCache.set(terrainId, material);
  return material;
}

export function buildTileMesh(registry, assets, tile, hexSize) {
  const material = getOrCreateMaterial(registry, assets, tile.terrainId);
  const mesh = new Mesh(sharedGeometry, material);
  mesh.rotation.y = Math.PI / 6; // align to pointy-top
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  const point = hexToPixel(tile.q, tile.r, hexSize);
  mesh.position.set(point.x, -TILE_HEIGHT / 2, point.z);
  mesh.userData.tileEntityKey = tile.q + ',' + tile.r;
  mesh.userData.terrainId = tile.terrainId;
  return mesh;
}

// Apply fog/explored state for a viewer. Cloned material so individual tiles
// can be dimmed without mutating the shared one.
const FOG_HIDDEN = 0;
const FOG_EXPLORED_ONLY = 1;
const FOG_VISIBLE = 2;

function classifyTileForViewer(viewerPlayerId, tileKey, world) {
  if (!viewerPlayerId) return FOG_VISIBLE;
  const stateEntityId = world._worldStateEntity;
  if (!stateEntityId) return FOG_VISIBLE;
  const worldState = getComponent(world, stateEntityId, 'WorldState');
  if (!worldState?.fogByPlayer || !worldState.fogByPlayer[viewerPlayerId]) return FOG_VISIBLE;
  const fog = worldState.fogByPlayer[viewerPlayerId];
  if (fog.visible.has(tileKey)) return FOG_VISIBLE;
  if (fog.explored.has(tileKey)) return FOG_EXPLORED_ONLY;
  return FOG_HIDDEN;
}

export function applyFogStateToTile(mesh, viewerPlayerId, world) {
  const tileKey = mesh.userData.tileEntityKey;
  const state = classifyTileForViewer(viewerPlayerId, tileKey, world);
  if (state === FOG_HIDDEN) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  // Use a per-mesh material override for dimming so we can change opacity /
  // brightness without disturbing the shared base material.
  if (!mesh.userData.fogMaterial) {
    mesh.userData.fogMaterial = mesh.material.clone();
    mesh.material = mesh.userData.fogMaterial;
  }
  const material = mesh.userData.fogMaterial;
  if (state === FOG_VISIBLE) {
    material.color.setRGB(1, 1, 1).multiply(getBaseColor(mesh));
    material.emissive.setRGB(0, 0, 0);
  } else {
    // Explored but not visible — desaturated, darker.
    material.color.copy(getBaseColor(mesh)).multiplyScalar(0.45);
    material.emissive.setRGB(0, 0, 0);
  }
}

function getBaseColor(mesh) {
  if (!mesh.userData.baseColor) {
    mesh.userData.baseColor = mesh.material.color.clone();
  }
  return mesh.userData.baseColor;
}
