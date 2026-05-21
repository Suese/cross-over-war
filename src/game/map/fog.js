// Per-player fog of war. Each player has two sets of hex keys:
//   • visible — currently within sight of one of their heroes / locations.
//   • explored — has ever been visible (so unobscured terrain stays drawn
//     in dimmed colour even when no one is looking).
//
// Both sets live on the per-player WorldState component so they snapshot/
// replicate the same way the rest of the world does.

import { collectEntitiesWith, getComponent, getWorldState, hasComponent } from '../ecs/world.js';
import { hexKey, hexesInRadius } from './hex.js';

const DEFAULT_HERO_VISION_RADIUS = 4;

function ensurePlayerFogStore(world, playerId) {
  const stateEntity = getWorldState(world);
  const state = getComponent(world, stateEntity, 'WorldState');
  if (!state.fogByPlayer) state.fogByPlayer = {};
  if (!state.fogByPlayer[playerId]) {
    state.fogByPlayer[playerId] = { explored: new Set(), visible: new Set() };
  }
  return state.fogByPlayer[playerId];
}

// Recompute a single player's visible set from their heroes' positions, and
// merge those tiles into their explored set.
export function recomputeFogForPlayer(world, registry, playerId) {
  const fog = ensurePlayerFogStore(world, playerId);
  fog.visible = new Set();
  const heroIds = collectEntitiesWith(world, ['Hero', 'Position']);
  for (const heroId of heroIds) {
    const ownership = getComponent(world, heroId, 'Ownership');
    if (!ownership || ownership.playerId !== playerId) continue;
    const position = getComponent(world, heroId, 'Position');
    const hero = getComponent(world, heroId, 'Hero');
    const visionRadius = hero?.visionRadius ?? DEFAULT_HERO_VISION_RADIUS;
    for (const tile of hexesInRadius(position.q, position.r, visionRadius)) {
      const key = hexKey(tile.q, tile.r);
      fog.visible.add(key);
      fog.explored.add(key);
    }
  }
}

export function recomputeFogForAllPlayers(world, registry) {
  const stateEntity = getWorldState(world);
  const state = getComponent(world, stateEntity, 'WorldState');
  const playerIds = state.playerOrder ?? [];
  for (const playerId of playerIds) recomputeFogForPlayer(world, registry, playerId);
}

export function getFogForPlayer(world, playerId) {
  return ensurePlayerFogStore(world, playerId);
}

// When we snapshot the world for the wire, JS Sets don't survive JSON. Use
// these helpers to flatten / restore.
export function flattenFog(fogByPlayer) {
  const out = {};
  for (const playerId in fogByPlayer) {
    out[playerId] = {
      explored: Array.from(fogByPlayer[playerId].explored),
      visible: Array.from(fogByPlayer[playerId].visible),
    };
  }
  return out;
}

export function inflateFog(flat) {
  const out = {};
  for (const playerId in flat) {
    out[playerId] = {
      explored: new Set(flat[playerId].explored),
      visible: new Set(flat[playerId].visible),
    };
  }
  return out;
}
