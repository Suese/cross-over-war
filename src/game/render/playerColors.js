// Shared player color palette. Heroes pick from it for their cube tint, the
// conquest-flag mesh tints from it, and the right-click info panel + cursor
// HUD pull a CSS form for owner labels. Keeping one source of truth means
// "Bob's red on the map" and "Bob's red in the UI" actually match.

export const PLAYER_PALETTE = [
  0xff5c5c, // red
  0x5cb6ff, // blue
  0x5cff8b, // green
  0xffd95c, // yellow
  0xa56cff, // purple
  0xff905c, // orange
];

const UNOWNED_HEX = 0xbbbbbb;

export function playerColorHex(playerId) {
  if (!playerId) return UNOWNED_HEX;
  // Deterministic hash → palette index. Same id always lands on the same color.
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) hash = (hash + playerId.charCodeAt(i)) >>> 0;
  return PLAYER_PALETTE[hash % PLAYER_PALETTE.length];
}

export function playerColorCss(playerId) {
  const hex = playerColorHex(playerId);
  return '#' + hex.toString(16).padStart(6, '0');
}
