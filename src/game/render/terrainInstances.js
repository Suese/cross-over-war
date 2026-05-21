// Tile rendering with InstancedMesh — one InstancedMesh per terrain id so
// that a 256×256 map (≈65 000 tiles) renders in a handful of draw calls.
//
// Three.js's CylinderGeometry with 6 segments is already pointy-top — the
// first vertex sits on +Z, with flat edges along ±X. That matches our
// pointy-top axial→pixel math (`x = √3·(q + r/2)`, `z = 1.5·r`), so the
// geometry is used un-rotated and the cylinder radius is set equal to the
// hex size — adjacent tiles then share their flat edges with no gap.
//
// Fog of war is driven by per-instance colour for visible/explored states,
// and by collapsing the instance's matrix to zero scale for hidden tiles.

import {
  CylinderGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Color,
  Matrix4,
} from 'three';
import { hexToPixel } from '../map/hex.js';
import { getTerrain } from '../ecs/registry.js';
import { forEachEntityWith } from '../ecs/world.js';

const TILE_HEIGHT = 0.4;
const VISIBLE_COLOUR = new Color(1.0, 1.0, 1.0);
const EXPLORED_COLOUR = new Color(0.32, 0.32, 0.36);
const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);

export function createTerrainInstanceManager({ scene, registry, assets, hexSize }) {
  const geometry = new CylinderGeometry(hexSize, hexSize, TILE_HEIGHT, 6);
  const groupsByTerrainId = new Map(); // terrainId → { mesh, tiles, material }
  const reusableMatrix = new Matrix4();

  function disposeMeshGroup(group) {
    scene.remove(group.mesh);
    group.mesh.dispose?.();
    group.material.dispose?.();
  }
  function disposeAll() {
    for (const group of groupsByTerrainId.values()) disposeMeshGroup(group);
    groupsByTerrainId.clear();
  }

  function makeMaterialForTerrain(terrainId) {
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
    return material;
  }

  function buildFromWorld(world) {
    disposeAll();

    const tilesByTerrainId = new Map();
    forEachEntityWith(world, ['Tile'], (entityId, tile) => {
      const list = tilesByTerrainId.get(tile.terrainId) ?? [];
      list.push({ q: tile.q, r: tile.r });
      tilesByTerrainId.set(tile.terrainId, list);
    });

    for (const [terrainId, tiles] of tilesByTerrainId) {
      const material = makeMaterialForTerrain(terrainId);
      const mesh = new InstancedMesh(geometry, material, tiles.length);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      // Pre-place every instance at its hex pixel. Fog updates will mutate
      // these matrices and colours after the fact.
      for (let instanceIndex = 0; instanceIndex < tiles.length; instanceIndex++) {
        const tile = tiles[instanceIndex];
        const point = hexToPixel(tile.q, tile.r, hexSize);
        reusableMatrix.identity().setPosition(point.x, -TILE_HEIGHT / 2, point.z);
        mesh.setMatrixAt(instanceIndex, reusableMatrix);
        mesh.setColorAt(instanceIndex, VISIBLE_COLOUR);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      scene.add(mesh);
      groupsByTerrainId.set(terrainId, { mesh, tiles, material });
    }
  }

  // viewerPlayerId may be null (omniscient — render every tile fully lit).
  function updateFogForViewer(world, viewerPlayerId) {
    const fog = viewerFog(world, viewerPlayerId);
    for (const group of groupsByTerrainId.values()) {
      const { mesh, tiles } = group;
      for (let instanceIndex = 0; instanceIndex < tiles.length; instanceIndex++) {
        const tile = tiles[instanceIndex];
        const key = tile.q + ',' + tile.r;
        const state = fogState(fog, key);
        if (state === 'hidden') {
          mesh.setMatrixAt(instanceIndex, HIDDEN_MATRIX);
        } else {
          const point = hexToPixel(tile.q, tile.r, hexSize);
          reusableMatrix.identity().setPosition(point.x, -TILE_HEIGHT / 2, point.z);
          mesh.setMatrixAt(instanceIndex, reusableMatrix);
          mesh.setColorAt(instanceIndex, state === 'visible' ? VISIBLE_COLOUR : EXPLORED_COLOUR);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  return { buildFromWorld, updateFogForViewer, dispose: disposeAll };
}

function fogState(fog, key) {
  if (!fog) return 'visible';
  if (fog.visible.has(key)) return 'visible';
  if (fog.explored.has(key)) return 'explored';
  return 'hidden';
}

function viewerFog(world, viewerPlayerId) {
  if (!viewerPlayerId) return null;
  const stateEntityId = world._worldStateEntity;
  if (!stateEntityId) return null;
  const store = world.componentStores.get('WorldState');
  if (!store) return null;
  const worldState = store.get(stateEntityId);
  if (!worldState?.fogByPlayer) return null;
  return worldState.fogByPlayer[viewerPlayerId] ?? null;
}
