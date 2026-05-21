// Path overlay: green arrows along reachable-this-turn steps, an "X" at the
// final destination, and red arrows for any portion that spills into future
// turns. Built once per plan and replaced wholesale — keeps the code simple
// at the cost of allocating fresh meshes on each click, which is fine for
// the path sizes we deal with on an adventure map.

import {
  Group,
  Mesh,
  MeshBasicMaterial,
  ConeGeometry,
  PlaneGeometry,
  CanvasTexture,
  SpriteMaterial,
  Sprite,
  Color,
} from 'three';
import { hexToPixel } from '../map/hex.js';

const ARROW_OFFSET_Y = 0.05;

function makeArrowMesh(colourHex) {
  const geometry = new ConeGeometry(0.18, 0.55, 8);
  const material = new MeshBasicMaterial({ color: new Color(colourHex), transparent: true, opacity: 0.95 });
  const mesh = new Mesh(geometry, material);
  // Cone defaults to point along +Y. Rotate so the tip points along +Z and
  // we can yaw it to face the next step.
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function makeXSprite(colourHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#' + colourHex.toString(16).padStart(6, '0');
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(12, 12); ctx.lineTo(52, 52); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(52, 12); ctx.lineTo(12, 52); ctx.stroke();
  const texture = new CanvasTexture(canvas);
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(0.9, 0.9, 1);
  return sprite;
}

function yawTowards(fromPoint, toPoint) {
  return Math.atan2(toPoint.x - fromPoint.x, toPoint.z - fromPoint.z);
}

// pathPlan: { startQ, startR, path: { steps: [...], costs: [...] },
//             movementLeft, movementPerTurn }
export function buildPathOverlay(pathPlan, hexSize) {
  const group = new Group();
  const { steps } = pathPlan.path;
  if (steps.length === 0) return group;

  const greenHex = 0x44e08a;
  const redHex = 0xff6c6c;
  const startPixel = hexToPixel(pathPlan.startQ, pathPlan.startR, hexSize);

  let previousPoint = { x: startPixel.x, z: startPixel.z };
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    const stepPoint = hexToPixel(step.q, step.r, hexSize);
    const reachableThisTurn = step.cumulativeCost <= pathPlan.movementLeft;
    const colour = reachableThisTurn ? greenHex : redHex;
    const arrow = makeArrowMesh(colour);
    arrow.position.set(stepPoint.x, ARROW_OFFSET_Y, stepPoint.z);
    arrow.rotation.z = yawTowards(previousPoint, stepPoint);
    group.add(arrow);
    previousPoint = stepPoint;
  }

  // Destination marker — green if reachable in one turn, red otherwise.
  const lastStep = steps[steps.length - 1];
  const destinationPoint = hexToPixel(lastStep.q, lastStep.r, hexSize);
  const destinationReachable = lastStep.cumulativeCost <= pathPlan.movementLeft;
  const destinationColour = destinationReachable ? greenHex : redHex;
  const xSprite = makeXSprite(destinationColour);
  xSprite.position.set(destinationPoint.x, 0.5, destinationPoint.z);
  group.add(xSprite);

  return group;
}
