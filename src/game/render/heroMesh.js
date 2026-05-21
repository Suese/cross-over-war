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
  CanvasTexture,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
} from 'three';
import { hexToPixel } from '../map/hex.js';

const PLAYER_PALETTE = [
  0xff5c5c, // red
  0x5cb6ff, // blue
  0x5cff8b, // green
  0xffd95c, // yellow
  0xa56cff, // purple
  0xff905c, // orange
];

function colourForPlayer(playerId) {
  if (!playerId) return 0xbbbbbb;
  // Deterministic hash: sum of char codes mod palette length.
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) hash = (hash + playerId.charCodeAt(i)) >>> 0;
  return PLAYER_PALETTE[hash % PLAYER_PALETTE.length];
}

function buildLabelSprite(text) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 38, size, 52);
  ctx.font = 'bold 36px "Inter", system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, 66);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(2.0, 2.0, 1);
  sprite.position.set(0, 1.6, 0);
  return sprite;
}

export function buildHeroMesh(registry, assets, hero, ownerPlayerId) {
  const group = new Group();
  const colour = new Color(colourForPlayer(ownerPlayerId));

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

  // Name label above the head.
  const label = buildLabelSprite(hero?.name ?? 'Hero');
  label.position.y = 1.85;
  group.add(label);

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
