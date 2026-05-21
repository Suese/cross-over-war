// Axial hex coordinates (q, r). Pointy-top layout — each row alternates
// horizontal offset by half a hex. Source of truth for everything
// hex-related: pixel projection, neighbours, distance, bounded radii.
//
// Reference: https://www.redblobgames.com/grids/hexagons/

const SQRT_3 = Math.sqrt(3);

// Six axial directions. Order is stable; angle ordering matches the
// 0..5 indices used elsewhere (e.g. for path arrow rotation).
export const HEX_DIRECTIONS = [
  { q:  1, r:  0 },
  { q:  1, r: -1 },
  { q:  0, r: -1 },
  { q: -1, r:  0 },
  { q: -1, r:  1 },
  { q:  0, r:  1 },
];

export function hexKey(q, r) {
  return q + ',' + r;
}

export function parseHexKey(key) {
  const [q, r] = key.split(',').map(Number);
  return { q, r };
}

export function neighbours(q, r) {
  const result = [];
  for (const direction of HEX_DIRECTIONS) {
    result.push({ q: q + direction.q, r: r + direction.r });
  }
  return result;
}

// Axial → cube → distance.
export function hexDistance(a, b) {
  const aX = a.q;
  const aZ = a.r;
  const aY = -aX - aZ;
  const bX = b.q;
  const bZ = b.r;
  const bY = -bX - bZ;
  return (Math.abs(aX - bX) + Math.abs(aY - bY) + Math.abs(aZ - bZ)) / 2;
}

// Project an axial coordinate to 2D pixel space. The renderer maps this
// directly to (x, z) in three.js with y as elevation.
export function hexToPixel(q, r, size) {
  const x = size * SQRT_3 * (q + r / 2);
  const z = size * 1.5 * r;
  return { x, z };
}

// Inverse: pixel → fractional axial → rounded axial.
export function pixelToHex(x, z, size) {
  const fractionalQ = (SQRT_3 / 3 * x - 1 / 3 * z) / size;
  const fractionalR = (2 / 3 * z) / size;
  return roundAxial(fractionalQ, fractionalR);
}

function roundAxial(fractionalQ, fractionalR) {
  const fractionalS = -fractionalQ - fractionalR;
  let q = Math.round(fractionalQ);
  let r = Math.round(fractionalR);
  let s = Math.round(fractionalS);

  const deltaQ = Math.abs(q - fractionalQ);
  const deltaR = Math.abs(r - fractionalR);
  const deltaS = Math.abs(s - fractionalS);

  if (deltaQ > deltaR && deltaQ > deltaS) q = -r - s;
  else if (deltaR > deltaS) r = -q - s;
  // (we ignore s after this; q,r are the axial answer)
  return { q, r };
}

// All hexes within `radius` of (q, r), inclusive.
export function hexesInRadius(centerQ, centerR, radius) {
  const result = [];
  for (let deltaQ = -radius; deltaQ <= radius; deltaQ++) {
    const rLow = Math.max(-radius, -deltaQ - radius);
    const rHigh = Math.min(radius, -deltaQ + radius);
    for (let deltaR = rLow; deltaR <= rHigh; deltaR++) {
      result.push({ q: centerQ + deltaQ, r: centerR + deltaR });
    }
  }
  return result;
}
