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
import { forEachEntityWith, getComponent } from '../ecs/world.js';

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
  let activePathOverlay = null;

  function syncObjects(world, viewerPlayerId, registry, assets) {
    const seen = new Set();
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
      setHeroPosition(mesh, position.q, position.r, HEX_SIZE);

      const fog = viewerFog(world, viewerPlayerId);
      const key = position.q + ',' + position.r;
      const visible = !fog || fog.visible.has(key) || ownerPlayerId === viewerPlayerId;
      mesh.visible = visible;
    });
    for (const [entityId, mesh] of objectMeshesByEntityId) {
      if (!seen.has(entityId)) {
        objectGroup.remove(mesh);
        objectMeshesByEntityId.delete(entityId);
      }
    }
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
