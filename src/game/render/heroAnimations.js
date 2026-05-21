// Hero movement animations.
//
// When a hero_moved event arrives we queue an animation per affected hero.
// The renderer reads the animation each frame and uses the interpolated
// position / facing direction instead of the hero's ECS Position. Once the
// animation finishes the renderer falls back to ECS position.
//
// The animation also drives "shroud puncture": for the duration of the
// animation we override the player's fog with
//   exploredBaseline ∪ tiles within vision radius of the current animated tile
// so the shroud retreats one tile at a time rather than snapping to its
// final state when the move completes.

import { Quaternion, Vector3 } from 'three';
import { hexToPixel, hexesInRadius, hexKey } from '../map/hex.js';

const STEP_DURATION_MS = 220;
const FACING_AXIS = new Vector3(0, 0, 1);   // hero meshes naturally face +Z

export function createHeroAnimations(hexSize) {
  // entityId → { fromQ, fromR, path, startedAt, totalDurationMs, playerId,
  //              exploredBaseline: Set<string>, visionRadius }
  const animations = new Map();

  function enqueueFromEvent(event, viewerPlayerId, heroComponent) {
    if (!event || event.type !== 'hero_moved') return;
    const startedAt = performance.now();
    const path = event.path ?? [];
    if (path.length === 0) return;
    const totalDurationMs = path.length * STEP_DURATION_MS;
    const visionRadius = heroComponent?.visionRadius ?? 4;
    const baseline = event.playerId === viewerPlayerId
      ? new Set(event.exploredBaseline ?? [])
      : null;
    animations.set(event.heroEntityId, {
      fromQ: event.fromQ,
      fromR: event.fromR,
      path,
      startedAt,
      totalDurationMs,
      playerId: event.playerId,
      exploredBaseline: baseline,
      visionRadius,
    });
  }

  function isAnimating(entityId) {
    return animations.has(entityId);
  }

  // Return { x, z, yaw, currentTileIndex, progress } at `nowMs`, or null
  // if no animation is active for `entityId`.
  function sample(entityId, nowMs) {
    const animation = animations.get(entityId);
    if (!animation) return null;
    const elapsedMs = nowMs - animation.startedAt;
    if (elapsedMs >= animation.totalDurationMs) {
      animations.delete(entityId);
      return null;
    }
    const stepIndex = Math.min(animation.path.length - 1, Math.floor(elapsedMs / STEP_DURATION_MS));
    const stepFraction = (elapsedMs - stepIndex * STEP_DURATION_MS) / STEP_DURATION_MS;

    const fromHex = stepIndex === 0
      ? { q: animation.fromQ, r: animation.fromR }
      : animation.path[stepIndex - 1];
    const toHex = animation.path[stepIndex];

    const fromPixel = hexToPixel(fromHex.q, fromHex.r, hexSize);
    const toPixel = hexToPixel(toHex.q, toHex.r, hexSize);
    const x = fromPixel.x + (toPixel.x - fromPixel.x) * stepFraction;
    const z = fromPixel.z + (toPixel.z - fromPixel.z) * stepFraction;

    const deltaX = toPixel.x - fromPixel.x;
    const deltaZ = toPixel.z - fromPixel.z;
    const yaw = Math.atan2(deltaX, deltaZ);

    return {
      x, z, yaw,
      currentTileIndex: stepIndex,
      currentQ: toHex.q,
      currentR: toHex.r,
      progress: elapsedMs / animation.totalDurationMs,
    };
  }

  // Compute the fog override that should apply to `viewerPlayerId` based on
  // the currently-active animation for THAT player. Returns null if no
  // override should be in effect (no active animation, or the animation
  // belongs to someone else).
  function fogOverrideFor(viewerPlayerId, nowMs) {
    let activeAnimation = null;
    let activeEntityId = null;
    for (const [entityId, animation] of animations) {
      if (animation.playerId !== viewerPlayerId) continue;
      if (!animation.exploredBaseline) continue;
      activeAnimation = animation;
      activeEntityId = entityId;
      break;  // single hero per player for now
    }
    if (!activeAnimation) return null;
    const elapsedMs = nowMs - activeAnimation.startedAt;
    if (elapsedMs >= activeAnimation.totalDurationMs) return null;
    const stepIndex = Math.min(activeAnimation.path.length - 1, Math.floor(elapsedMs / STEP_DURATION_MS));
    const currentTile = activeAnimation.path[stepIndex];

    const visibleKeys = new Set();
    for (const tile of hexesInRadius(currentTile.q, currentTile.r, activeAnimation.visionRadius)) {
      visibleKeys.add(hexKey(tile.q, tile.r));
    }
    // Explored = baseline ∪ every step's vision so far ∪ current vision.
    const exploredKeys = new Set(activeAnimation.exploredBaseline);
    for (let earlierStep = 0; earlierStep <= stepIndex; earlierStep++) {
      const tile = activeAnimation.path[earlierStep];
      for (const visionTile of hexesInRadius(tile.q, tile.r, activeAnimation.visionRadius)) {
        exploredKeys.add(hexKey(visionTile.q, visionTile.r));
      }
    }
    return { visibleKeys, exploredKeys };
  }

  function hasActiveAnimation() { return animations.size > 0; }

  function hasActiveAnimationForPlayer(playerId) {
    for (const animation of animations.values()) {
      if (animation.playerId === playerId) return true;
    }
    return false;
  }

  // String token that changes whenever the fog override would render
  // differently — used to gate the (expensive) per-instance fog update so
  // we only re-upload buffers when the hero crosses a tile boundary.
  function currentFogTick(viewerPlayerId, nowMs) {
    for (const [entityId, animation] of animations) {
      if (animation.playerId !== viewerPlayerId) continue;
      if (!animation.exploredBaseline) continue;
      const elapsedMs = nowMs - animation.startedAt;
      if (elapsedMs >= animation.totalDurationMs) continue;
      const stepIndex = Math.min(animation.path.length - 1, Math.floor(elapsedMs / STEP_DURATION_MS));
      return entityId + ':' + animation.startedAt + ':' + stepIndex;
    }
    return null;
  }

  function clearForEntity(entityId) { animations.delete(entityId); }

  function quaternionForYaw(yaw) {
    // Hero meshes face +Z by default. A yaw of 0 should leave them facing
    // their default direction; positive yaw rotates them around +Y.
    return new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  }

  return {
    enqueueFromEvent,
    isAnimating,
    sample,
    fogOverrideFor,
    currentFogTick,
    hasActiveAnimation,
    hasActiveAnimationForPlayer,
    clearForEntity,
    quaternionForYaw,
  };
}
