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
        objectGroup.remove(entry.mesh);
        meshGraveyard.delete(entityId);
      }
    }

    const seen = new Set();
    const fog = fogOverride ?? viewerFog(world, viewerPlayerId);

    forEachEntityWith(world, ['Hero', 'Position'], (entityId, hero, position) => {
      seen.add(entityId);
      const ownership = getComponent(world, entityId, 'Ownership');
      const ownerPlayerId = ownership ? ownership.playerId : null;
      let mesh = objectMeshesByEntityId.get(entityId);
      if (!mesh) {
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

      const heroKey = displayQ + ',' + displayR;
      const fogVisible = fog?.visibleKeys ?? fog?.visible;
      const heroVisible = !fog || fogVisible?.has(heroKey) || ownerPlayerId === viewerPlayerId;
      mesh.visible = heroVisible;
    });

    forEachEntityWith(world, ['MapObject', 'Position'], (entityId, mapObject, position) => {
      seen.add(entityId);
      let mesh = objectMeshesByEntityId.get(entityId);
      if (!mesh) {
        const type = registry.mapObjectTypes.get(mapObject.typeId);
        if (!type?.buildMesh) return;
        mesh = type.buildMesh(registry, assets, mapObject);
        objectGroup.add(mesh);
        objectMeshesByEntityId.set(entityId, mesh);
      }
      const point = hexToPixel(position.q, position.r, HEX_SIZE);
      mesh.position.set(point.x, 0, point.z);
      // Map objects don't move, so revealing them once is enough — show them
      // both when visible and explored, but keep them hidden under shroud.
      const objectKey = position.q + ',' + position.r;
      const fogVisible = fog?.visibleKeys ?? fog?.visible;
      const fogExplored = fog?.exploredKeys ?? fog?.explored;
      mesh.visible = !fog || fogVisible?.has(objectKey) || fogExplored?.has(objectKey);
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
        objectGroup.remove(mesh);
      }
      objectMeshesByEntityId.delete(entityId);
    }
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
