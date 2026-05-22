// Hero mesh. If a hero archetype declares a model asset and that GLB is
// present, we drop it in. Otherwise we draw a coloured cube as the user
// requested — explicitly so missing models read as "unfinished art" rather
// than disguising the gap.
//
// For the demo we go with the cube fallback so everything is offline-clean.

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

  // Bright "nose" wedge sticking out of the front for an unambiguous facing
  // indicator — tiny but visible at typical zoom.
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

  // Hero names live in the right-click info panel rather than as a floating
  // sprite above the mesh — the map reads cleaner without persistent labels.

  // If the registry references a model and the asset exists, swap in the
  // model. Done after the cube is in place so something is always visible.
  if (hero?.modelKey && assets.hasAsset(hero.modelKey)) {
    assets.loadModel(hero.modelKey, { requestedBy: 'hero:' + (hero.archetypeId ?? hero.name) })
      .then(modelRoot => {
        if (!modelRoot) return;
        group.remove(body);
        group.remove(head);
        modelRoot.traverse(child => {
          if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
        });
        modelRoot.position.set(0, 0, 0);
        group.add(modelRoot);
      })
      .catch(error => console.warn('hero model load failed:', error));
  }

  return group;
}

export function setHeroPosition(meshGroup, q, r, hexSize) {
  const point = hexToPixel(q, r, hexSize);
  meshGroup.position.set(point.x, 0, point.z);
}
