// Three.js scene + render loop.
//
// Camera looks almost straight down with a ~10° forward tilt so foreground
// hexes read as closer than background ones (top-down with a hint of
// perspective). The camera follows a pannable "target point" so WASD / drag
// can scroll the map without rotating it.

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
import { buildTileMesh, applyFogStateToTile } from './tileMesh.js';
import { buildHeroMesh, setHeroPosition } from './heroMesh.js';
import { buildPathOverlay } from './pathOverlay.js';
import { forEachEntityWith, getComponent } from '../ecs/world.js';

const HEX_SIZE = 1.0;
const CAMERA_DOWN_ANGLE_DEGREES = 80;   // 0 = horizon, 90 = straight down. 80° ≈ 10° tilt from straight-down.

export function createSceneRenderer(canvas, registry, assets) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(new Color(0x070a12), 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const scene = new Scene();
  scene.background = new Color(0x070a12);

  const tileGroup = new Group();
  const objectGroup = new Group();
  const pathGroup = new Group();
  scene.add(tileGroup, objectGroup, pathGroup);

  const ambient = new AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const sun = new DirectionalLight(0xfff1d0, 1.05);
  sun.position.set(40, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  scene.add(sun);

  const camera = new PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 0.1, 500);
  const cameraTarget = new Vector3(0, 0, 0);
  let cameraDistance = 32;
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

  // Maps from entity id → three.js Object3D so the sync pass can find and
  // update or remove the right node when the ECS state changes.
  const tileMeshesByEntityId = new Map();
  const objectMeshesByEntityId = new Map();
  let activePathOverlay = null;

  function syncTiles(world, viewerPlayerId) {
    const seen = new Set();
    forEachEntityWith(world, ['Tile'], (entityId, tile) => {
      seen.add(entityId);
      let mesh = tileMeshesByEntityId.get(entityId);
      if (!mesh) {
        mesh = buildTileMesh(registry, assets, tile, HEX_SIZE);
        tileGroup.add(mesh);
        tileMeshesByEntityId.set(entityId, mesh);
      }
      applyFogStateToTile(mesh, viewerPlayerId, world);
    });
    // Garbage-collect any tile mesh whose entity disappeared.
    for (const [entityId, mesh] of tileMeshesByEntityId) {
      if (!seen.has(entityId)) {
        tileGroup.remove(mesh);
        tileMeshesByEntityId.delete(entityId);
      }
    }
  }

  function syncObjects(world, viewerPlayerId) {
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

      // Hide heroes outside the viewer's fog (still alive, just unseen).
      const fog = viewerPlayerId ? getViewerFog(world, viewerPlayerId) : null;
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
  function zoomCamera(factor) {
    cameraDistance = Math.max(8, Math.min(80, cameraDistance * factor));
    applyCameraPlacement();
  }
  function centerOnHex(q, r) {
    const point = hexToPixel(q, r, HEX_SIZE);
    cameraTarget.set(point.x, 0, point.z);
    applyCameraPlacement();
  }
  function handleResize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', handleResize);
  handleResize();

  // Project a screen-space point to a world-space hex coordinate using a
  // ray cast against the y=0 plane.
  const raycaster = new Raycaster();
  const screenVector = new Vector2();
  function screenToWorldGroundPoint(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    screenVector.x = ((screenX - rect.left) / rect.width) * 2 - 1;
    screenVector.y = -(((screenY - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(screenVector, camera);
    // Plane y=0; t = -origin.y / direction.y.
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
    syncTiles,
    syncObjects,
    showPath,
    clearPath,
    panCamera,
    zoomCamera,
    centerOnHex,
    screenToWorldGroundPoint,
    render,
  };
}

function getViewerFog(world, playerId) {
  const stateEntity = world._worldStateEntity;
  if (!stateEntity) return null;
  const componentStore = world.componentStores.get('WorldState');
  if (!componentStore) return null;
  const state = componentStore.get(stateEntity);
  if (!state || !state.fogByPlayer || !state.fogByPlayer[playerId]) return null;
  return state.fogByPlayer[playerId];
}
