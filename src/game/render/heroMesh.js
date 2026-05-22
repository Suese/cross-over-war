// Hero mesh — coloured cube placeholder with a streaming swap-in for the
// hero's `modelKey` GLB if one exists. The cube renders immediately so the
// game is interactive while the model bytes are still in flight; once the
// asset loader resolves, the body and head boxes are replaced with the GLB
// scene (cloned so multiple heroes can share a single source asset).

import {
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  Group,
  Color,
} from 'three';
import { hexToPixel } from '../map/hex.js';
import { playerColorHex } from './playerColors.js';

export function buildHeroMesh(registry, assets, hero, ownerPlayerId) {
  const group = new Group();
  const colour = new Color(playerColorHex(ownerPlayerId));

  // Cube body — elongated along +Z so a "nose" sticks out front. Once we
  // rotate the group around Y to face the direction of movement, the
  // elongation makes the facing direction visually obvious.
  const bodyMaterial = new MeshStandardMaterial({
    color: colour,
    roughness: 0.5,
    metalness: 0.15,
    emissive: colour.clone().multiplyScalar(0.05),
  });
  const body = new Mesh(new BoxGeometry(0.55, 0.7, 0.9), bodyMaterial);
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);

  // Smaller "head" cube, slightly forward (+Z) so the front face reads as
  // the leading edge.
  const head = new Mesh(new BoxGeometry(0.45, 0.45, 0.45), bodyMaterial.clone());
  head.material.color.copy(colour).multiplyScalar(1.2);
  head.position.set(0, 1.15, 0.12);
  head.castShadow = true;
  group.add(head);

  // Bright "nose" wedge — kept even after the model loads so the facing
  // indicator survives the swap.
  const noseMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0.1,
    emissive: new Color(colour).multiplyScalar(0.4),
  });
  const nose = new Mesh(new BoxGeometry(0.18, 0.18, 0.22), noseMaterial);
  nose.position.set(0, 0.55, 0.55);
  nose.castShadow = true;
  group.add(nose);

  // Stream the model if the archetype declared one. Asset loader returns
  // null synchronously when the file is missing, so heroes without a GLB
  // simply stay as the coloured cube.
  if (hero?.modelKey) {
    let acquired = false;
    assets.requestModel(hero.modelKey, (scene) => {
      if (!scene) return;
      // Pin the asset against LRU eviction while this mesh references it.
      assets.acquireModel(hero.modelKey);
      acquired = true;
      group.remove(body);
      group.remove(head);
      body.geometry.dispose();
      body.material.dispose();
      head.geometry.dispose();
      head.material.dispose();
      const instance = scene.clone(true);
      instance.traverse((child) => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
      });
      instance.position.set(0, 0, 0);
      group.add(instance);
    }, { requestedBy: 'hero:' + (hero.archetypeId ?? hero.name) });

    // When the renderer removes this group from the scene, the caller is
    // expected to invoke `disposeMesh(group)` (see sceneRenderer) which uses
    // the metadata below to release the refcount.
    group.userData.assetRelease = () => {
      if (acquired) {
        assets.releaseModel(hero.modelKey);
        acquired = false;
      }
    };
  }

  return group;
}

export function setHeroPosition(meshGroup, q, r, hexSize) {
  const point = hexToPixel(q, r, hexSize);
  meshGroup.position.set(point.x, 0, point.z);
}
