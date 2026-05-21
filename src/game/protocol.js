// Wire protocol between host and clients.
//
// Host → client messages always carry a monotonic `seq` so clients can detect
// gaps and request resync. The kinds are:
//
//   init_snapshot     — full world serialisation. Sent on connect and after
//                       any client requests a resync.
//   delta             — list of ECS change ops + a list of triggered events;
//                       generated from world.consumePendingChanges() after
//                       each host action.
//   state_hash        — FNV-1a hash of canonical world state at `seq`. Clients
//                       apply the matching delta, hash their own state, and
//                       request a resync on mismatch.
//   players_changed   — lobby roster updates outside the ECS (joins/leaves,
//                       reconnect-by-name match). Also seq-tracked.
//
// Client → host:
//   action            — the existing { name: 'plan_path' | ... } shape.
//   resync_request    — sent when a delta arrives out of order or a hash
//                       check fails. The host responds with init_snapshot.

export const MESSAGE_KINDS = Object.freeze({
  INIT_SNAPSHOT: 'init_snapshot',
  DELTA: 'delta',
  STATE_HASH: 'state_hash',
  PLAYERS_CHANGED: 'players_changed',
  ACTION: 'action',
  RESYNC_REQUEST: 'resync_request',
});

// ── FNV-1a 32-bit on a canonical JSON projection of the world ─────────────
// Excludes Tile components (clients regenerate them from seed) and any
// renderer-side derived state. Deterministic across host/client given the
// same op log.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1aOfString(text) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Force unsigned 32-bit.
  return hash >>> 0;
}

export function hashWorld(world) {
  return fnv1aOfString(canonicalSerialise(world));
}

// Produce a deterministic JSON string from a world's components (sets sorted
// for stable hashing). Tile components are skipped intentionally — both
// host and client derive them from the seed.
export function canonicalSerialise(world) {
  const componentEntries = [];
  for (const [name, store] of world.componentStores) {
    if (name === 'Tile') continue;
    const entries = [];
    for (const [entityId, data] of store) {
      entries.push([entityId, canonicaliseValue(data)]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    componentEntries.push([name, entries]);
  }
  componentEntries.sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify({
    nextEntityId: world.nextEntityId,
    entities: Array.from(world.entities).sort((a, b) => a - b),
    components: componentEntries,
  });
}

function canonicaliseValue(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Set) {
    return ['__Set__', Array.from(value).sort()];
  }
  if (Array.isArray(value)) return value.map(canonicaliseValue);
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const key of keys) out[key] = canonicaliseValue(value[key]);
    return out;
  }
  return value;
}
