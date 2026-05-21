// Per-player fog of war.
//
// Each player has two sets of hex keys stored on WorldState.fogByPlayer:
//   • visible — currently within sight of one of their heroes.
//   • explored — has ever been visible.
//
// The host mutates these via the ECS's tracked set ops so every change is
// recorded as a delta. recomputeFogForPlayer compares the freshly-computed
// visible set against the previous one and emits set_add / set_remove ops
// only for the actual diff — keeps the wire payload small even when a hero
// barely moves.

import {
  collectEntitiesWith, getComponent, getWorldState,
  setAddTracked, setRemoveTracked, setReplaceTracked,
  patchComponentTracked,
} from '../ecs/world.js';
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

export function recomputeFogForPlayer(world, registry, playerId) {
  const stateEntity = getWorldState(world);
  const fog = ensurePlayerFogStore(world, playerId);

  // Compute the new visible set from scratch.
  const nextVisible = new Set();
  const heroIds = collectEntitiesWith(world, ['Hero', 'Position']);
  for (const heroId of heroIds) {
    const ownership = getComponent(world, heroId, 'Ownership');
    if (!ownership || ownership.playerId !== playerId) continue;
    const position = getComponent(world, heroId, 'Position');
    const hero = getComponent(world, heroId, 'Hero');
    const visionRadius = hero?.visionRadius ?? DEFAULT_HERO_VISION_RADIUS;
    for (const tile of hexesInRadius(position.q, position.r, visionRadius)) {
      nextVisible.add(hexKey(tile.q, tile.r));
    }
  }

  // Diff visible against previous, emit per-key set ops.
  const previousVisible = fog.visible;
  for (const key of previousVisible) {
    if (!nextVisible.has(key)) {
      setRemoveTracked(world, stateEntity, 'WorldState', ['fogByPlayer', playerId, 'visible'], key);
    }
  }
  for (const key of nextVisible) {
    if (!previousVisible.has(key)) {
      setAddTracked(world, stateEntity, 'WorldState', ['fogByPlayer', playerId, 'visible'], key);
      // Anything visible is also explored.
      if (!fog.explored.has(key)) {
        setAddTracked(world, stateEntity, 'WorldState', ['fogByPlayer', playerId, 'explored'], key);
      }
    } else if (!fog.explored.has(key)) {
      // Edge case — a player who reconnects with stale state. Record once.
      setAddTracked(world, stateEntity, 'WorldState', ['fogByPlayer', playerId, 'explored'], key);
    }
  }
}

export function recomputeFogForAllPlayers(world, registry) {
  const stateEntity = getWorldState(world);
  const state = getComponent(world, stateEntity, 'WorldState');
  const playerIds = state.playerOrder ?? [];
  for (const playerId of playerIds) recomputeFogForPlayer(world, registry, playerId);
}

export function ensurePlayerFogInitialised(world, playerId) {
  const stateEntity = getWorldState(world);
  const state = getComponent(world, stateEntity, 'WorldState');
  if (!state.fogByPlayer) {
    patchComponentTracked(world, stateEntity, 'WorldState', ['fogByPlayer'], {});
  }
  if (!state.fogByPlayer[playerId]) {
    // Replace ops so each Set survives the wire as an array.
    setReplaceTracked(world, stateEntity, 'WorldState', ['fogByPlayer', playerId, 'visible'], []);
    setReplaceTracked(world, stateEntity, 'WorldState', ['fogByPlayer', playerId, 'explored'], []);
  }
}

// Wire helpers — used only for the initial full snapshot and persistence.
export function flattenFog(fogByPlayer) {
  const out = {};
  for (const playerId in fogByPlayer) {
    out[playerId] = {
      explored: Array.from(fogByPlayer[playerId].explored ?? []),
      visible: Array.from(fogByPlayer[playerId].visible ?? []),
    };
  }
  return out;
}
export function inflateFog(flat) {
  const out = {};
  for (const playerId in flat) {
    out[playerId] = {
      explored: new Set(flat[playerId].explored ?? []),
      visible: new Set(flat[playerId].visible ?? []),
    };
  }
  return out;
}
