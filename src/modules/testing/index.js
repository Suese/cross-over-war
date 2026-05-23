// Testing module — generic neutrals available to every kingdom.
//
// Just two collectables now:
//   • Camp Fire    — single-use; visiting destroys it
//   • Fish School  — single-use placeholder in shallow water
//
// Kingdoms (pipe-dream, canada, medieval, poultry) own their own castles,
// biome decorators, and themed POIs. These two stay here because they're
// universally useful and don't belong to any one kingdom.

import {
  CylinderGeometry, ConeGeometry, BoxGeometry,
  Mesh, MeshStandardMaterial, Group,
} from 'three';
import { createEntity, addComponent } from '../../game/ecs/world.js';
import {
  registerPrefab,
  registerMapObjectType,
} from '../../game/ecs/registry.js';

const MODULE_NAME = 'testing';

const CAMPFIRE_TYPE_ID = 'testing/campfire';
const CAMPFIRE_PREFAB_ID = 'testing/campfire';
const CAMPFIRE_DEFAULT_MESSAGE = 'You find nothing.';

const FISH_TYPE_ID = 'testing/fish-school';
const FISH_PREFAB_ID = 'testing/fish-school';
const FISH_DEFAULT_MESSAGE = 'A school of silver fish darts away as you approach. {heroName} finds nothing.';

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering testing content (campfire, fish school)');

    registerMapObjectType(registry, {
      id: CAMPFIRE_TYPE_ID,
      name: 'Camp Fire',
      description: 'An old campfire still smouldering at the edges. Whoever sat here is long gone.',
      prefabId: CAMPFIRE_PREFAB_ID,
      buildMesh: () => buildCampfireMesh(),
    });
    registerPrefab(registry, CAMPFIRE_PREFAB_ID, (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Position', { q: params.q ?? 0, r: params.r ?? 0 });
      addComponent(world, entityId, 'MapObject', { typeId: CAMPFIRE_TYPE_ID });
      addComponent(world, entityId, 'Visitable', { message: params.message ?? CAMPFIRE_DEFAULT_MESSAGE });
      addComponent(world, entityId, 'ConsumedOnVisit', {});
      addComponent(world, entityId, 'Actionable', { actionTypeId: 'base/take' });
      return entityId;
    });

    registerMapObjectType(registry, {
      id: FISH_TYPE_ID,
      name: 'Fish School',
      description: 'A shimmering school of fish weaving through the shallows.',
      prefabId: FISH_PREFAB_ID,
      buildMesh: () => buildFishSchoolMesh(),
    });
    registerPrefab(registry, FISH_PREFAB_ID, (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Position', { q: params.q ?? 0, r: params.r ?? 0 });
      addComponent(world, entityId, 'MapObject', { typeId: FISH_TYPE_ID });
      addComponent(world, entityId, 'Visitable', { message: params.message ?? FISH_DEFAULT_MESSAGE });
      addComponent(world, entityId, 'ConsumedOnVisit', {});
      addComponent(world, entityId, 'Actionable', { actionTypeId: 'base/take' });
      return entityId;
    });
  },
};

// ── Meshes ──────────────────────────────────────────────────────────────

function buildCampfireMesh() {
  const group = new Group();
  const base = new Mesh(
    new CylinderGeometry(0.42, 0.5, 0.16, 10),
    new MeshStandardMaterial({ color: 0x3a2418, roughness: 0.95, metalness: 0.0 }),
  );
  base.position.y = 0.08;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);
  const outerFlame = new Mesh(
    new ConeGeometry(0.32, 0.78, 10),
    new MeshStandardMaterial({
      color: 0xff7a2a, emissive: 0xff5414, emissiveIntensity: 0.9, roughness: 0.55,
    }),
  );
  outerFlame.position.y = 0.48;
  outerFlame.castShadow = true;
  group.add(outerFlame);
  const innerFlame = new Mesh(
    new ConeGeometry(0.16, 0.4, 8),
    new MeshStandardMaterial({
      color: 0xffe27a, emissive: 0xffd964, emissiveIntensity: 1.0, roughness: 0.4,
    }),
  );
  innerFlame.position.y = 0.36;
  group.add(innerFlame);
  return group;
}

function buildFishSchoolMesh() {
  const group = new Group();
  const bodyMat = new MeshStandardMaterial({
    color: 0x9ed8f0, roughness: 0.45, metalness: 0.25,
    emissive: 0x123040, emissiveIntensity: 0.2,
  });
  const fishes = [
    { x:  0.0,  z:  0.0,  yaw: 0.0 },
    { x:  0.22, z:  0.16, yaw: 0.3 },
    { x: -0.18, z:  0.12, yaw: -0.25 },
    { x:  0.12, z: -0.2,  yaw: 0.6 },
    { x: -0.14, z: -0.08, yaw: -0.5 },
    { x:  0.28, z: -0.05, yaw: 0.15 },
  ];
  for (const f of fishes) {
    const body = new Mesh(new BoxGeometry(0.22, 0.05, 0.08), bodyMat);
    body.position.set(f.x, 0.12, f.z);
    body.rotation.y = f.yaw;
    group.add(body);
    const tail = new Mesh(new ConeGeometry(0.04, 0.08, 6), bodyMat);
    tail.position.set(f.x - 0.13 * Math.cos(f.yaw), 0.12, f.z + 0.13 * Math.sin(f.yaw));
    tail.rotation.z = Math.PI / 2;
    tail.rotation.y = f.yaw;
    group.add(tail);
  }
  return group;
}
