// Tile rendering — streaming model loads, with per-submesh InstancedMesh.
//
// Lifecycle for each terrain id used by the map:
//   1. `buildFromWorld` collects tiles by effective terrain id.
//   2. For each terrain it immediately builds a *placeholder* InstancedMesh
//      (a flat grey cylinder, one instance per tile) so the map reads as
//      "loading" rather than blank.
//   3. The terrain's `modelKey` is requested through the asset loader. The
//      load is fire-and-forget; the request callback runs when the GLB
//      arrives.
//   4. On callback, the placeholder is disposed and a real InstancedMesh
//      group is built — one InstancedMesh per submesh inside the GLB, with
//      the submesh's local matrix baked into each tile's instance matrix.
//   5. `acquireModel(modelKey)` pins the model against LRU eviction for as
//      long as the InstancedMeshes reference its geometry/material. `dispose`
//      releases that pin when the manager is torn down.
//
// Fog of war drives instance scaling: hidden tiles' instances are collapsed
// to zero; visible / explored tiles render with their baked base matrix.
// Each terrain group caches per-instance base matrices so a fog update only
// pays for matrix-copy, not matrix-multiply.

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

const PLACEHOLDER_TILE_HEIGHT = 0.4;
const VISIBLE_COLOUR = new Color(1.0, 1.0, 1.0);
const PLACEHOLDER_COLOUR = new Color(0.55, 0.55, 0.58);
const EXPLORED_COLOUR = new Color(0.32, 0.32, 0.36);
const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);

export function createTerrainInstanceManager({ scene, registry, assets, hexSize }) {
  // Geometry shared by every placeholder cylinder.
  const placeholderGeometry = new CylinderGeometry(hexSize, hexSize, PLACEHOLDER_TILE_HEIGHT, 6);

  // groupsByTerrainId values:
  //   {
  //     tiles: [{q,r}],
  //     submeshes: [{ instancedMesh, baseMatrices }],
  //     disposableMaterials: Material[],   // owned by us; disposed on rebuild
  //     modelKey: string|null,             // for `releaseModel` on dispose
  //     state: 'placeholder' | 'loaded',
  //   }
  const groupsByTerrainId = new Map();

  // Shroud — one InstancedMesh sized to every tile on the map.
  const shroudMaterial = new MeshStandardMaterial({
    color: 0x0a0d18, roughness: 1.0, metalness: 0.0,
  });
  let shroudMesh = null;
  let shroudTiles = null;
  const reusableMatrix = new Matrix4();

  // Latest fog used by the renderer. The async asset-load swap needs to apply
  // current fog state to the newly-built submeshes so they don't blink as
  // fully visible. Captured by `updateFogForViewer` and replayed in `swapInRealGroup`.
  let lastFogReference = null;

  function disposeGroup(group) {
    for (const submesh of group.submeshes) {
      scene.remove(submesh.instancedMesh);
      submesh.instancedMesh.dispose?.();
    }
    for (const material of group.disposableMaterials) material.dispose?.();
    if (group.modelKey && group.state === 'loaded') assets.releaseModel(group.modelKey);
  }

  function disposeAll() {
    for (const group of groupsByTerrainId.values()) disposeGroup(group);
    groupsByTerrainId.clear();
    if (shroudMesh) {
      scene.remove(shroudMesh);
      shroudMesh.dispose?.();
      shroudMesh = null;
      shroudTiles = null;
    }
  }

  // Build the placeholder group for a terrain id. Always one InstancedMesh
  // of the shared grey cylinder geometry.
  function buildPlaceholderGroup(terrainId, tiles) {
    const material = new MeshStandardMaterial({
      color: PLACEHOLDER_COLOUR.clone(),
      roughness: 0.95,
      metalness: 0.0,
    });
    const instancedMesh = new InstancedMesh(placeholderGeometry, material, tiles.length);
    instancedMesh.castShadow = false;
    instancedMesh.receiveShadow = true;
    instancedMesh.frustumCulled = false;
    const baseMatrices = new Array(tiles.length);
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const point = hexToPixel(tile.q, tile.r, hexSize);
      const matrix = new Matrix4().setPosition(point.x, -PLACEHOLDER_TILE_HEIGHT / 2, point.z);
      baseMatrices[i] = matrix;
      instancedMesh.setMatrixAt(i, matrix);
      instancedMesh.setColorAt(i, VISIBLE_COLOUR);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
    scene.add(instancedMesh);
    return {
      tiles,
      submeshes: [{ instancedMesh, baseMatrices }],
      disposableMaterials: [material],
      modelKey: null,
      state: 'placeholder',
    };
  }

  // Build the real group from a loaded GLB scene root: one InstancedMesh per
  // mesh found in the scene, with the mesh's matrixWorld baked into each
  // tile's instance matrix.
  function buildLoadedGroup(terrainId, tiles, sceneRoot, modelKey) {
    sceneRoot.updateMatrixWorld(true);
    const recipes = [];
    sceneRoot.traverse((child) => {
      if (!child.isMesh) return;
      if (!child.geometry || !child.material) return;
      recipes.push({
        geometry: child.geometry,
        material: child.material,
        localMatrix: child.matrixWorld.clone(),
      });
    });
    if (recipes.length === 0) {
      // GLB had nothing renderable — degrade to a placeholder shape so the
      // user sees *something* rather than empty hexes.
      return buildPlaceholderGroup(terrainId, tiles);
    }

    const submeshes = [];
    for (const recipe of recipes) {
      const instancedMesh = new InstancedMesh(recipe.geometry, recipe.material, tiles.length);
      instancedMesh.castShadow = false;
      instancedMesh.receiveShadow = true;
      instancedMesh.frustumCulled = false;
      const baseMatrices = new Array(tiles.length);
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        const point = hexToPixel(tile.q, tile.r, hexSize);
        const tilePlacement = new Matrix4().setPosition(point.x, 0, point.z);
        const combined = tilePlacement.multiply(recipe.localMatrix);
        baseMatrices[i] = combined;
        instancedMesh.setMatrixAt(i, combined);
        instancedMesh.setColorAt(i, VISIBLE_COLOUR);
      }
      instancedMesh.instanceMatrix.needsUpdate = true;
      if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
      scene.add(instancedMesh);
      submeshes.push({ instancedMesh, baseMatrices });
    }
    assets.acquireModel(modelKey);
    return {
      tiles,
      submeshes,
      disposableMaterials: [],     // materials come from the GLB; loader owns them
      modelKey,
      state: 'loaded',
    };
  }

  function swapInRealGroup(terrainId, tiles, sceneRoot, modelKey) {
    // Map rebuild may have happened mid-load; abort if our tiles are stale.
    const existing = groupsByTerrainId.get(terrainId);
    if (!existing || existing.tiles !== tiles) return;
    disposeGroup(existing);
    const next = buildLoadedGroup(terrainId, tiles, sceneRoot, modelKey);
    groupsByTerrainId.set(terrainId, next);
    if (lastFogReference) applyFogToGroup(next, lastFogReference);
  }

  function buildFromWorld(world) {
    disposeAll();

    // Collect any per-hex TerrainOverride entities first so we can group
    // tiles by their *effective* terrain id (base or overridden).
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
      // Show a placeholder immediately, then request the real asset.
      const placeholder = buildPlaceholderGroup(terrainId, tiles);
      groupsByTerrainId.set(terrainId, placeholder);

      const terrain = getTerrain(registry, terrainId);
      const modelKey = terrain?.modelKey;
      if (!modelKey) continue;
      assets.requestModel(modelKey, (sceneRoot) => {
        if (!sceneRoot) return;
        swapInRealGroup(terrainId, tiles, sceneRoot, modelKey);
      }, { requestedBy: 'terrain:' + terrainId });
    }

    // Shroud mesh — sized to every tile.
    shroudTiles = allTiles;
    shroudMesh = new InstancedMesh(placeholderGeometry, shroudMaterial, allTiles.length);
    shroudMesh.castShadow = false;
    shroudMesh.receiveShadow = true;
    shroudMesh.frustumCulled = false;
    for (let i = 0; i < allTiles.length; i++) {
      shroudMesh.setMatrixAt(i, HIDDEN_MATRIX);
    }
    shroudMesh.instanceMatrix.needsUpdate = true;
    scene.add(shroudMesh);
  }

  function applyFogToGroup(group, fog) {
    const { tiles, submeshes } = group;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const key = tile.q + ',' + tile.r;
      const state = fogState(fog, key);
      for (const submesh of submeshes) {
        if (state === 'hidden') {
          submesh.instancedMesh.setMatrixAt(i, HIDDEN_MATRIX);
        } else {
          submesh.instancedMesh.setMatrixAt(i, submesh.baseMatrices[i]);
          submesh.instancedMesh.setColorAt(i, state === 'visible' ? VISIBLE_COLOUR : EXPLORED_COLOUR);
        }
      }
    }
    for (const submesh of submeshes) {
      submesh.instancedMesh.instanceMatrix.needsUpdate = true;
      if (submesh.instancedMesh.instanceColor) submesh.instancedMesh.instanceColor.needsUpdate = true;
    }
  }

  function updateFogForViewer(world, viewerPlayerId, fogOverride) {
    const fog = fogOverride ?? viewerFog(world, viewerPlayerId);
    lastFogReference = fog;
    for (const group of groupsByTerrainId.values()) applyFogToGroup(group, fog);

    // Shroud is the inverse — full-scale on hidden tiles, zero on the rest.
    if (shroudMesh && shroudTiles) {
      for (let i = 0; i < shroudTiles.length; i++) {
        const tile = shroudTiles[i];
        const key = tile.q + ',' + tile.r;
        if (fogState(fog, key) === 'hidden') {
          const point = hexToPixel(tile.q, tile.r, hexSize);
          reusableMatrix.identity().setPosition(point.x, -PLACEHOLDER_TILE_HEIGHT / 2, point.z);
          shroudMesh.setMatrixAt(i, reusableMatrix);
        } else {
          shroudMesh.setMatrixAt(i, HIDDEN_MATRIX);
        }
      }
      shroudMesh.instanceMatrix.needsUpdate = true;
    }
  }

  return { buildFromWorld, updateFogForViewer, dispose: disposeAll };
}

function fogState(fog, key) {
  if (!fog) return 'visible';
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
