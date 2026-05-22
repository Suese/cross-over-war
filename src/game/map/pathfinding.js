// A* over the hex grid. Tile data is read out of the ECS world: each tile
// entity has a Tile component (q, r, terrainId), and the registry tells us
// each terrain's traversal components (PassableByLand, PassableByAir, …)
// with their per-mode costs. The mover supplies a list of mode tags (e.g.
// ['Land']) — the pathfinder calls `resolveTerrainCost(terrain, modes)` per
// candidate tile, picking the lowest-cost matching mode or skipping the
// tile if none match. See ecs/traversal.js for the compositional rules.
//
// Cost units are "movement points" — a hero with movementMax=20 can spend up
// to 20 points worth of terrain on a turn. We return both the path and a
// running "cost-to-reach" array so the renderer can colour the part the hero
// can reach this turn (green) versus the rest (red).

import { HEX_DIRECTIONS, hexKey, hexDistance } from './hex.js';
import { forEachEntityWith, getComponent } from '../ecs/world.js';
import { getTerrain } from '../ecs/registry.js';
import { resolveTerrainCost } from '../ecs/traversal.js';

// Build (or reuse) a hex-key → { entityId, tile, terrain } lookup over every
// Tile entity. The 256×256 default map has 65 000 entries, so caching this on
// the world matters — A* would otherwise rebuild the whole index on every
// call. Mapgen and any caller that mutates tiles should `invalidateTileIndex`
// to force a rebuild on the next lookup.
function getOrBuildTileIndex(world, registry) {
  if (world._tileIndex && world._tileIndexRegistryRef === registry) {
    return world._tileIndex;
  }
  const index = new Map();
  forEachEntityWith(world, ['Tile'], (entityId, tile) => {
    const terrain = getTerrain(registry, tile.terrainId);
    if (!terrain) return;
    index.set(hexKey(tile.q, tile.r), { entityId, tile, terrain });
  });
  // Layer TerrainOverride entities on top — each one replaces the base
  // terrain at its hex with a different registered terrain (e.g. base/grass
  // → base/bramble around a structure). Built once on first findPath call
  // after game start; if any code starts adding/removing overrides mid-game
  // it must call invalidateTileIndex() so this gets rebuilt.
  forEachEntityWith(world, ['TerrainOverride', 'Position'], (_id, override, position) => {
    const entry = index.get(hexKey(position.q, position.r));
    if (!entry) return;
    const resolved = getTerrain(registry, override.terrainId);
    if (resolved) entry.effectiveTerrain = resolved;
  });
  world._tileIndex = index;
  world._tileIndexRegistryRef = registry;
  return index;
}

export function invalidateTileIndex(world) {
  world._tileIndex = null;
  world._tileIndexRegistryRef = null;
}

// Look up the effective terrain at a hex — base Tile.terrainId, or whatever
// the TerrainOverride at this position promotes it to. Returns null if no
// tile entity exists for (q, r). Builds on the same cached index used by
// pathfinding so per-frame callers (the renderer) are O(1).
export function getEffectiveTerrainAt(world, registry, q, r) {
  const index = getOrBuildTileIndex(world, registry);
  const entry = index.get(hexKey(q, r));
  if (!entry) return null;
  return entry.effectiveTerrain ?? entry.terrain;
}

// Minimal priority queue (binary heap) keyed by numeric priority.
class PriorityQueue {
  constructor() { this.heap = []; }
  push(value, priority) {
    this.heap.push({ value, priority });
    this._bubbleUp(this.heap.length - 1);
  }
  pop() {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._bubbleDown(0);
    }
    return top.value;
  }
  get size() { return this.heap.length; }
  _bubbleUp(index) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heap[parent].priority <= this.heap[index].priority) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }
  _bubbleDown(index) {
    const length = this.heap.length;
    while (true) {
      const left = index * 2 + 1;
      const right = index * 2 + 2;
      let smallest = index;
      if (left < length && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
      if (right < length && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
      if (smallest === index) break;
      [this.heap[smallest], this.heap[index]] = [this.heap[index], this.heap[smallest]];
      index = smallest;
    }
  }
}

// Find a path from start to goal. Returns null if no path exists.
//
// options.exploredKeys: Set<"q,r"> — when provided, undiscovered tiles are
// treated as impassable. The start tile is always considered passable (the
// hero is standing on it), and the goal must be in the explored set.
// options.blockedKeys: Set<"q,r"> — tiles occupied by other heroes / map
// objects. The start tile must NOT be in this set (callers exclude their own
// hero's position). The goal counts as blocked too — no walking into a hero.
// options.traversalModes: string[] — the mover's mode tags (e.g. ['Land']).
//   Ignored when options.costFn is provided.
// options.costFn(terrain, q, r): number | null — custom cost rule. Return
//   the step cost or null for impassable. Used by the road carver to pick
//   different costs for workable land vs water vs unworkable terrain. When
//   omitted, the default cost is `resolveTerrainCost(terrain, traversalModes)`.
// options.maxStepCost: number — any tile whose individual entry cost is
//   greater than this is treated as impassable. Used for hero pathing: MP
//   resets every turn (no banking), so a tile costing more than the hero's
//   per-turn cap can never be entered. Omit / `Infinity` for "no limit"
//   (the road carver doesn't care).
export function findPath(world, registry, start, goal, options = {}) {
  if (!start || !goal) return null;
  if (start.q === goal.q && start.r === goal.r) return { steps: [], costs: [] };

  const traversalModes = options.traversalModes ?? ['Land'];
  const customCostFn = typeof options.costFn === 'function' ? options.costFn : null;
  const maxStepCost = options.maxStepCost ?? Infinity;
  const stepCostFor = (terrain, q, r) => {
    const cost = customCostFn ? customCostFn(terrain, q, r) : resolveTerrainCost(terrain, traversalModes);
    if (cost == null) return null;
    if (cost > maxStepCost) return null;
    return cost;
  };
  const blocked = options.blockedKeys;
  const tileIndex = getOrBuildTileIndex(world, registry);
  const goalKey = hexKey(goal.q, goal.r);
  const goalTile = tileIndex.get(goalKey);
  const goalCarrier = goalTile?.effectiveTerrain ?? goalTile?.terrain;
  if (!goalCarrier || stepCostFor(goalCarrier, goal.q, goal.r) == null) return null;
  if (blocked && blocked.has(goalKey)) return null;

  const explored = options.exploredKeys;
  if (explored && !explored.has(goalKey)) return null;

  const startKey = hexKey(start.q, start.r);
  if (!tileIndex.has(startKey)) return null;

  const frontier = new PriorityQueue();
  frontier.push(startKey, 0);
  const cameFrom = new Map();
  const costSoFar = new Map();
  cameFrom.set(startKey, null);
  costSoFar.set(startKey, 0);

  while (frontier.size > 0) {
    const currentKey = frontier.pop();
    if (currentKey === goalKey) break;

    const [currentQ, currentR] = currentKey.split(',').map(Number);
    for (const direction of HEX_DIRECTIONS) {
      const nextQ = currentQ + direction.q;
      const nextR = currentR + direction.r;
      const nextKey = hexKey(nextQ, nextR);
      const nextTile = tileIndex.get(nextKey);
      if (!nextTile) continue;
      const stepCost = stepCostFor(nextTile.effectiveTerrain ?? nextTile.terrain, nextQ, nextR);
      if (stepCost == null) continue;
      if (explored && !explored.has(nextKey)) continue;
      if (blocked && blocked.has(nextKey)) continue;
      const newCost = costSoFar.get(currentKey) + stepCost;
      const previousBest = costSoFar.get(nextKey);
      if (previousBest !== undefined && newCost >= previousBest) continue;
      costSoFar.set(nextKey, newCost);
      const heuristic = hexDistance({ q: nextQ, r: nextR }, goal);
      frontier.push(nextKey, newCost + heuristic);
      cameFrom.set(nextKey, currentKey);
    }
  }

  if (!cameFrom.has(goalKey)) return null;

  // Reconstruct path (excluding the start tile — we only return the steps).
  const reversed = [];
  let cursor = goalKey;
  while (cursor && cursor !== startKey) {
    const [q, r] = cursor.split(',').map(Number);
    reversed.push({ q, r, cumulativeCost: costSoFar.get(cursor) });
    cursor = cameFrom.get(cursor);
  }
  reversed.reverse();
  return {
    steps: reversed,
    costs: reversed.map(step => step.cumulativeCost),
  };
}

// Convenience: split a path into the "this-turn" prefix (reachable within
// `movementLeft` points) and the "later-turns" suffix.
export function splitPathByMovementBudget(path, movementLeft) {
  if (!path) return { thisTurn: [], later: [] };
  const thisTurn = [];
  const later = [];
  for (const step of path.steps) {
    if (step.cumulativeCost <= movementLeft) thisTurn.push(step);
    else later.push(step);
  }
  return { thisTurn, later };
}

// How many turns will the full path take, given a per-turn budget?
export function estimateTurnsForPath(path, movementPerTurn) {
  if (!path || path.steps.length === 0) return 0;
  const totalCost = path.steps[path.steps.length - 1].cumulativeCost;
  return Math.max(1, Math.ceil(totalCost / Math.max(1, movementPerTurn)));
}
