// Three.js scene + render loop.
//
// Camera looks almost straight down with a ~10° forward tilt so foreground
// hexes read as closer than background ones. The camera follows a
// pannable "target point" so WASD / middle-drag scroll the map.
//
// Tiles are owned by a TerrainInstanceManager (see terrainInstances.js),
// which renders 65k+ hexes via InstancedMesh in a handful of draw calls.
// Heroes still use individual meshes (a handful of entities).

import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  Group,
  Vector3,
  Color,
  Raycaster,
  Vector2,
  PCFSoftShadowMap,
} from 'three';
import { hexToPixel } from '../map/hex.js';
import { buildHeroMesh, setHeroPosition } from './heroMesh.js';
import { buildPathOverlay } from './pathOverlay.js';
import { playerColorHex } from './playerColors.js';
import { forEachEntityWith, getComponent, hasComponent } from '../ecs/world.js';

const HEX_SIZE = 1.0;
const CAMERA_DOWN_ANGLE_DEGREES = 80;
const DEFAULT_CAMERA_DISTANCE = 38;
const MIN_CAMERA_DISTANCE = 8;
const MAX_CAMERA_DISTANCE = 300;

// Placeholder geometry / material shared by every "waiting for the asset to
// arrive" mesh — heroes, map objects with an `AssetReference`, etc. Built
// once at module load so we don't pay the geometry-allocation cost per
// entity that's mid-stream.
const PLACEHOLDER_GEOMETRY = new BoxGeometry(0.6, 0.8, 0.6);
const PLACEHOLDER_MATERIAL = new MeshStandardMaterial({
  color: 0x9a9aa2, roughness: 0.9, metalness: 0.0,
});

// Build a streamed mesh: a grey placeholder cube returned synchronously,
// with a background asset request that swaps the cube for the GLB scene
// (cloned per-entity so multiple instances can share a single source asset)
// when the bytes arrive. The mesh stashes `userData.assetRelease` so the
// renderer can drop the asset refcount when the mesh leaves the scene.
function buildStreamedMesh(assets, modelKey, requestedBy) {
  const group = new Group();
  const placeholder = new Mesh(PLACEHOLDER_GEOMETRY, PLACEHOLDER_MATERIAL);
  placeholder.position.y = 0.4;
  placeholder.castShadow = true;
  placeholder.receiveShadow = false;
  group.add(placeholder);
  let acquired = false;
  assets.requestModel(modelKey, (scene) => {
    if (!scene) return;
    assets.acquireModel(modelKey);
    acquired = true;
    group.remove(placeholder);
    const instance = scene.clone(true);
    instance.traverse((child) => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
    });
    instance.position.set(0, 0, 0);
    group.add(instance);
  }, { requestedBy: requestedBy ?? 'streamed-mesh' });
  group.userData.assetRelease = () => {
    if (acquired) {
      assets.releaseModel(modelKey);
      acquired = false;
    }
  };
  return group;
}

export function createSceneRenderer(canvas) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(new Color(0x070a12), 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const scene = new Scene();
  scene.background = new Color(0x070a12);

  const objectGroup = new Group();
  const pathGroup = new Group();
  scene.add(objectGroup, pathGroup);

  const ambient = new AmbientLight(0xffffff, 0.65);
  scene.add(ambient);
  const sun = new DirectionalLight(0xfff1d0, 1.0);
  sun.position.set(60, 120, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  scene.add(sun);

  const camera = new PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
  const cameraTarget = new Vector3(0, 0, 0);
  let cameraDistance = DEFAULT_CAMERA_DISTANCE;

  function applyCameraPlacement() {
    const angle = (CAMERA_DOWN_ANGLE_DEGREES * Math.PI) / 180;
    const horizontalOffset = Math.cos(angle) * cameraDistance;
    const verticalOffset = Math.sin(angle) * cameraDistance;
    camera.position.set(
      cameraTarget.x,
      cameraTarget.y + verticalOffset,
      cameraTarget.z + horizontalOffset,
    );
    camera.lookAt(cameraTarget);
  }
  applyCameraPlacement();

  const objectMeshesByEntityId = new Map();
  // Meshes whose entity no longer exists but that we keep on screen for a
  // brief grace window — e.g. a campfire collected mid-animation should
  // remain visible until the hero finishes walking onto it.
  const meshGraveyard = new Map();   // entityId → { mesh, removeAt }
  let activePathOverlay = null;

  function syncObjects(world, viewerPlayerId, registry, assets, options = {}) {
    const heroAnimations = options.heroAnimations;
    const fogOverride = options.fogOverride;
    const nowMs = options.nowMs ?? performance.now();

    // Sweep the graveyard first so already-expired ghosts release their slots
    // before this frame's `seen` pass repopulates `objectMeshesByEntityId`.
    for (const [entityId, entry] of meshGraveyard) {
      if (nowMs >= entry.removeAt) {
        releaseAndRemoveMesh(entry.mesh);
        meshGraveyard.delete(entityId);
      }
    }

    const seen = new Set();
    const fog = fogOverride ?? viewerFog(world, viewerPlayerId);
    const fogVisibleSet = fog?.visibleKeys ?? fog?.visible;
    const fogExploredSet = fog?.exploredKeys ?? fog?.explored;

    forEachEntityWith(world, ['Hero', 'Position'], (entityId, hero, position) => {
      seen.add(entityId);
      const ownership = getComponent(world, entityId, 'Ownership');
      const ownerPlayerId = ownership ? ownership.playerId : null;
      const heroKey = position.q + ',' + position.r;
      // Discovery gate: the hero's own player always sees their heroes; for
      // anyone else, mesh construction (and any asset load) waits until the
      // viewer's fog reveals their position. Once discovered the mesh sticks
      // around even if fog re-shrouds them — invariant with current map.
      const discovered = !fog
        || ownerPlayerId === viewerPlayerId
        || fogVisibleSet?.has(heroKey)
        || fogExploredSet?.has(heroKey);
      let mesh = objectMeshesByEntityId.get(entityId);
      if (!mesh) {
        if (!discovered) return;
        mesh = buildHeroMesh(registry, assets, hero, ownerPlayerId);
        objectGroup.add(mesh);
        objectMeshesByEntityId.set(entityId, mesh);
      }

      // Position + facing come from the animation system when one is active.
      const animation = heroAnimations ? heroAnimations.sample(entityId, nowMs) : null;
      let displayQ = position.q;
      let displayR = position.r;
      if (animation) {
        mesh.position.set(animation.x, 0, animation.z);
        mesh.quaternion.copy(heroAnimations.quaternionForYaw(animation.yaw));
        displayQ = animation.currentQ;
        displayR = animation.currentR;
      } else {
        setHeroPosition(mesh, position.q, position.r, HEX_SIZE);
        // Clear any leftover yaw from a previous animation.
        mesh.quaternion.identity();
      }

      const displayKey = displayQ + ',' + displayR;
      const heroVisible = !fog || fogVisibleSet?.has(displayKey) || ownerPlayerId === viewerPlayerId;
      mesh.visible = heroVisible;
    });

    forEachEntityWith(world, ['MapObject', 'Position'], (entityId, mapObject, position) => {
      seen.add(entityId);
      const objectKey = position.q + ',' + position.r;
      const discovered = !fog || fogVisibleSet?.has(objectKey) || fogExploredSet?.has(objectKey);
      let mesh = objectMeshesByEntityId.get(entityId);
      if (!mesh) {
        if (!discovered) return;
        mesh = buildMapObjectMesh(world, registry, assets, mapObject, entityId);
        if (!mesh) return;
        objectGroup.add(mesh);
        objectMeshesByEntityId.set(entityId, mesh);
      }
      const point = hexToPixel(position.q, position.r, HEX_SIZE);
      mesh.position.set(point.x, 0, point.z);
      // Map objects don't move, so revealing them once is enough — show them
      // both when visible and explored, but keep them hidden under shroud.
      mesh.visible = !fog || fogVisibleSet?.has(objectKey) || fogExploredSet?.has(objectKey);
      // Conquest flag — generic convention: if the mesh has children named
      // 'conquest-flag' and/or 'conquest-flag-pole', the renderer tints them
      // to the owner's colour and toggles visibility based on the entity's
      // Ownership + Conquerable components. Mesh authors opt in just by
      // adding those named children to their buildMesh output.
      updateConquestFlag(mesh, world, entityId);
    });

    // Move missing entities' meshes into the graveyard for a short grace
    // period so they don't vanish mid-animation when the host destroys the
    // entity at the same moment the hero "arrives".
    const graceMs = heroAnimations?.hasActiveAnimation() ? animationGraceMs(heroAnimations, nowMs) : 0;
    for (const [entityId, mesh] of objectMeshesByEntityId) {
      if (seen.has(entityId)) continue;
      if (graceMs > 0) {
        meshGraveyard.set(entityId, { mesh, removeAt: nowMs + graceMs });
      } else {
        releaseAndRemoveMesh(mesh);
      }
      objectMeshesByEntityId.delete(entityId);
    }
  }

  // Remove a mesh from the scene and let any streaming subscriber release
  // its asset refcount. Meshes built via `buildHeroMesh` /
  // `buildMapObjectMesh` stash a `userData.assetRelease` callback so the LRU
  // cache learns they're no longer pinning a model.
  function releaseAndRemoveMesh(mesh) {
    objectGroup.remove(mesh);
    mesh.userData?.assetRelease?.();
  }

  // Resolve the mesh for a map-object entity. Preference order:
  //   1. The entity carries an `AssetReference { modelKey }` component →
  //      build a placeholder grey cube and stream the GLB; once the asset
  //      loads, swap the placeholder for the GLB scene.
  //   2. The registered map-object type provides a procedural `buildMesh`
  //      function → call it (existing pattern for hand-built meshes like
  //      castles and mushroom huts).
  //   3. Nothing renderable — return null so the renderer skips the entity.
  function buildMapObjectMesh(world, registry, assets, mapObject, entityId) {
    const assetRef = getComponent(world, entityId, 'AssetReference');
    if (assetRef?.modelKey) return buildStreamedMesh(assets, assetRef.modelKey, 'mapObject:' + (mapObject.typeId ?? entityId));
    const type = registry.mapObjectTypes.get(mapObject.typeId);
    if (type?.buildMesh) return type.buildMesh(registry, assets, mapObject);
    return null;
  }

  // The grace window is exactly the time remaining on the longest active
  // animation. The collectable mesh stays on screen until the hero visually
  // lands on it, then disappears the instant the animation completes — same
  // moment the visit popover fires (see bootstrap.queueAnimationsFromEvents).
  function animationGraceMs(heroAnimations, nowMs) {
    return heroAnimations.maxRemainingMs?.(nowMs) ?? 0;
  }

  function showPath(pathPlan) {
    if (activePathOverlay) {
      pathGroup.remove(activePathOverlay);
      activePathOverlay.traverse(child => { if (child.geometry) child.geometry.dispose(); });
      activePathOverlay = null;
    }
    if (!pathPlan || !pathPlan.path) return;
    activePathOverlay = buildPathOverlay(pathPlan, HEX_SIZE);
    pathGroup.add(activePathOverlay);
  }
  function clearPath() { showPath(null); }

  function panCamera(deltaWorldX, deltaWorldZ) {
    cameraTarget.x += deltaWorldX;
    cameraTarget.z += deltaWorldZ;
    applyCameraPlacement();
  }
  function setCameraTargetXZ(x, z) {
    cameraTarget.x = x;
    cameraTarget.z = z;
    applyCameraPlacement();
  }
  function zoomCamera(factor) {
    cameraDistance = Math.max(MIN_CAMERA_DISTANCE, Math.min(MAX_CAMERA_DISTANCE, cameraDistance * factor));
    applyCameraPlacement();
  }
  function centerOnHex(q, r) {
    const point = hexToPixel(q, r, HEX_SIZE);
    cameraTarget.set(point.x, 0, point.z);
    applyCameraPlacement();
  }
  function handleResize() {
    // Use the window's own dimensions rather than canvas.clientWidth so the
    // first call (which can run before layout has measured the canvas) still
    // gets a correct size. updateStyle=true keeps the canvas CSS pinned to
    // the matching pixel size as a belt-and-braces measure.
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, true);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', handleResize);
  handleResize();

  const raycaster = new Raycaster();
  const screenVector = new Vector2();
  function screenToWorldGroundPoint(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    screenVector.x = ((screenX - rect.left) / rect.width) * 2 - 1;
    screenVector.y = -(((screenY - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(screenVector, camera);
    const direction = raycaster.ray.direction;
    if (Math.abs(direction.y) < 1e-6) return null;
    const t = -raycaster.ray.origin.y / direction.y;
    if (t < 0) return null;
    return new Vector3().copy(raycaster.ray.origin).addScaledVector(direction, t);
  }

  function render() {
    renderer.render(scene, camera);
  }

  return {
    canvas,
    renderer,
    scene,
    camera,
    cameraTarget,
    HEX_SIZE,
    syncObjects,
    showPath,
    clearPath,
    panCamera,
    setCameraTargetXZ,
    zoomCamera,
    centerOnHex,
    screenToWorldGroundPoint,
    render,
  };
}

function updateConquestFlag(meshGroup, world, entityId) {
  const flagCloth = meshGroup.getObjectByName?.('conquest-flag');
  const flagPole = meshGroup.getObjectByName?.('conquest-flag-pole');
  if (!flagCloth && !flagPole) return;
  const isConquerable = hasComponent(world, entityId, 'Conquerable');
  const ownership = getComponent(world, entityId, 'Ownership');
  const ownerId = ownership?.playerId ?? null;
  const visible = isConquerable && !!ownerId;
  if (flagCloth) {
    flagCloth.visible = visible;
    if (visible && flagCloth.material?.color) {
      flagCloth.material.color.setHex(playerColorHex(ownerId));
    }
  }
  if (flagPole) flagPole.visible = visible;
}

function viewerFog(world, viewerPlayerId) {
  if (!viewerPlayerId) return null;
  const stateEntityId = world._worldStateEntity;
  if (!stateEntityId) return null;
  const store = world.componentStores.get('WorldState');
  if (!store) return null;
  const state = store.get(stateEntityId);
  if (!state?.fogByPlayer) return null;
  return state.fogByPlayer[viewerPlayerId] ?? null;
}
