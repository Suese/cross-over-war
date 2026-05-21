// Tile rendering with InstancedMesh — one InstancedMesh per terrain id so
// that a 256×256 map (≈65 000 tiles) renders in a handful of draw calls.
//
// Three.js's CylinderGeometry with 6 segments is already pointy-top — the
// first vertex sits on +Z, with flat edges along ±X. That matches our
// pointy-top axial→pixel math (`x = √3·(q + r/2)`, `z = 1.5·r`), so the
// geometry is used un-rotated and the cylinder radius is set equal to the
// hex size — adjacent tiles then share their flat edges with no gap.
//
// Fog of war is driven by per-instance colour for visible/explored states.
// Hidden tiles' terrain instances are collapsed to zero scale; a separate
// "shroud" InstancedMesh fills those slots with a uniformly dark cylinder
// so unexplored areas read as fog of war rather than as black voids.
//
// Every InstancedMesh has `frustumCulled = false` because three.js computes
// the bounding sphere from the base geometry (a unit-radius cylinder at the
// origin), not from instance matrices — scrolling the camera so origin
// leaves the frustum would otherwise cull the whole map. Per-draw-call
// count stays tiny (one per terrain + one shroud), so the saving is moot.

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
  // Shroud — one InstancedMesh sized to every tile on the map. An instance
  // is rendered at its hex position when that hex is in shroud (neither
  // visible nor explored) and zero-scaled otherwise.
  const shroudMaterial = new MeshStandardMaterial({
    color: 0x0a0d18,
    roughness: 1.0,
    metalness: 0.0,
  });
  let shroudMesh = null;
  let shroudTiles = null;     // [{ q, r }, …] parallel to shroudMesh instance order
  const reusableMatrix = new Matrix4();

  function disposeMeshGroup(group) {
    scene.remove(group.mesh);
    group.mesh.dispose?.();
    group.material.dispose?.();
  }
  function disposeAll() {
    for (const group of groupsByTerrainId.values()) disposeMeshGroup(group);
    groupsByTerrainId.clear();
    if (shroudMesh) {
      scene.remove(shroudMesh);
      shroudMesh.dispose?.();
      shroudMesh = null;
      shroudTiles = null;
    }
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

    // Collect any per-hex TerrainOverride entities first so we can group
    // tiles by their *effective* terrain id (base or overridden) below.
    // Overrides only show up after world spawners have run, which is
    // before the first buildFromWorld call.
    const overridesByHexKey = new Map();
    forEachEntityWith(world, ['TerrainOverride', 'Position'], (_id, override, position) => {
      overridesByHexKey.set(position.q + ',' + position.r, override.terrainId);
    });

    const tilesByTerrainId = new Map();
    const allTiles = [];
    forEachEntityWith(world, ['Tile'], (entityId, tile) => {
      const effectiveTerrainId = overridesByHexKey.get(tile.q + ',' + tile.r) ?? tile.terrainId;
      const list = tilesByTerrainId.get(effectiveTerrainId) ?? [];
      list.push({ q: tile.q, r: tile.r });
      tilesByTerrainId.set(effectiveTerrainId, list);
      allTiles.push({ q: tile.q, r: tile.r });
    });

    for (const [terrainId, tiles] of tilesByTerrainId) {
      const material = makeMaterialForTerrain(terrainId);
      const mesh = new InstancedMesh(geometry, material, tiles.length);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
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

    // Shroud mesh — sized to every tile, all instances zero-scaled until the
    // first fog update flips the unexplored ones into place.
    shroudTiles = allTiles;
    shroudMesh = new InstancedMesh(geometry, shroudMaterial, allTiles.length);
    shroudMesh.castShadow = false;
    shroudMesh.receiveShadow = true;
    shroudMesh.frustumCulled = false;
    for (let instanceIndex = 0; instanceIndex < allTiles.length; instanceIndex++) {
      shroudMesh.setMatrixAt(instanceIndex, HIDDEN_MATRIX);
    }
    shroudMesh.instanceMatrix.needsUpdate = true;
    scene.add(shroudMesh);
  }

  // viewerPlayerId may be null (omniscient — render every tile fully lit).
  // fogOverride: { visibleKeys, exploredKeys } takes precedence over the
  // world's fog when supplied — used to drive shroud-puncture animations.
  function updateFogForViewer(world, viewerPlayerId, fogOverride) {
    const fog = fogOverride ?? viewerFog(world, viewerPlayerId);
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

    // Shroud is the inverse — full-scale on hidden tiles, zero on the rest.
    if (shroudMesh && shroudTiles) {
      for (let instanceIndex = 0; instanceIndex < shroudTiles.length; instanceIndex++) {
        const tile = shroudTiles[instanceIndex];
        const key = tile.q + ',' + tile.r;
        if (fogState(fog, key) === 'hidden') {
          const point = hexToPixel(tile.q, tile.r, hexSize);
          reusableMatrix.identity().setPosition(point.x, -TILE_HEIGHT / 2, point.z);
          shroudMesh.setMatrixAt(instanceIndex, reusableMatrix);
        } else {
          shroudMesh.setMatrixAt(instanceIndex, HIDDEN_MATRIX);
        }
      }
      shroudMesh.instanceMatrix.needsUpdate = true;
    }
  }

  return { buildFromWorld, updateFogForViewer, dispose: disposeAll };
}

function fogState(fog, key) {
  if (!fog) return 'visible';
  // Accept either ECS-shaped fog ({ visible, explored: Set }) or override-shaped
  // fog ({ visibleKeys, exploredKeys: Set }).
  const visible = fog.visibleKeys ?? fog.visible;
  const explored = fog.exploredKeys ?? fog.explored;
  if (visible?.has(key)) return 'visible';
  if (explored?.has(key)) return 'explored';
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
