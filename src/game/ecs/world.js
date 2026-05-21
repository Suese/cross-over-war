// Minimal ECS world.
//
// Entities are integer ids. Components are plain objects stored per-name in
// sparse maps (componentName → entityId → data). Systems are plain functions
// invoked with the world plus a context object.
//
// Compositional on purpose — there are no formal "component types". Anything
// can attach any-named component, and any system can query for any name.
//
// ── Change tracking for delta replication ─────────────────────────────────
// The host's GameRoom mutates state via tracked helpers (createTrackedEntity,
// setComponentTracked, patchComponentTracked, ...). Each helper records an
// operation onto world.pendingChanges; after an action handler finishes the
// GameRoom drains the buffer and ships it as a `delta` message. The same
// helpers apply the change locally, so the host's authoritative world and
// the broadcast delta stay in lockstep.
//
// Ops are intentionally small enough that any client can replay them by
// dispatching on `op`:
//   { op: 'entity_create',     id }
//   { op: 'entity_destroy',    id }
//   { op: 'component_set',     entity, name, value }
//   { op: 'component_remove',  entity, name }
//   { op: 'component_patch',   entity, name, path: [...], value }       // value=null removes the key
//   { op: 'set_add',           entity, name, path: [...], value }       // add to a Set
//   { op: 'set_remove',        entity, name, path: [...], value }       // remove from a Set
//   { op: 'set_replace',       entity, name, path: [...], values: [] }  // wholesale Set replace
//
// `path` is the sequence of keys to descend into the component's data object
// (skipping the component itself). For example, to patch
//   WorldState.fogByPlayer.<playerId>.visible (a Set)
// use { op: 'set_add', entity: stateId, name: 'WorldState',
//       path: ['fogByPlayer', '<playerId>', 'visible'], value: 'q,r' }.

export function createWorld() {
  return {
    nextEntityId: 1,
    entities: new Set(),
    componentStores: new Map(),       // name → Map<entityId, data>
    systemsByPhase: new Map(),
    pendingChanges: [],               // recorded ops drained after each action
    recordChanges: false,             // host turns this on; client leaves it off
  };
}

export function setChangeRecording(world, on) {
  world.recordChanges = !!on;
}

export function consumePendingChanges(world) {
  const drained = world.pendingChanges;
  world.pendingChanges = [];
  return drained;
}

function recordOp(world, op) {
  if (world.recordChanges) world.pendingChanges.push(op);
}

// ── Entity lifecycle ──────────────────────────────────────────────────────
export function createEntity(world) {
  const entityId = world.nextEntityId++;
  world.entities.add(entityId);
  return entityId;
}

export function createTrackedEntity(world) {
  const entityId = createEntity(world);
  recordOp(world, { op: 'entity_create', id: entityId });
  return entityId;
}

export function destroyEntity(world, entityId) {
  if (!world.entities.has(entityId)) return;
  for (const store of world.componentStores.values()) store.delete(entityId);
  world.entities.delete(entityId);
}

export function destroyTrackedEntity(world, entityId) {
  if (!world.entities.has(entityId)) return;
  destroyEntity(world, entityId);
  recordOp(world, { op: 'entity_destroy', id: entityId });
}

// ── Component storage ─────────────────────────────────────────────────────
function getStore(world, componentName) {
  let store = world.componentStores.get(componentName);
  if (store) return store;
  store = new Map();
  world.componentStores.set(componentName, store);
  return store;
}

export function addComponent(world, entityId, componentName, data) {
  if (!world.entities.has(entityId)) {
    throw new Error('addComponent: entity ' + entityId + ' does not exist');
  }
  getStore(world, componentName).set(entityId, data ?? {});
  return data;
}

export function setComponentTracked(world, entityId, componentName, data) {
  addComponent(world, entityId, componentName, data);
  recordOp(world, {
    op: 'component_set',
    entity: entityId,
    name: componentName,
    value: serializeForOp(data),
  });
}

export function removeComponent(world, entityId, componentName) {
  const store = world.componentStores.get(componentName);
  if (!store) return;
  store.delete(entityId);
}

export function removeComponentTracked(world, entityId, componentName) {
  removeComponent(world, entityId, componentName);
  recordOp(world, { op: 'component_remove', entity: entityId, name: componentName });
}

export function getComponent(world, entityId, componentName) {
  const store = world.componentStores.get(componentName);
  if (!store) return null;
  return store.get(entityId) ?? null;
}

export function hasComponent(world, entityId, componentName) {
  const store = world.componentStores.get(componentName);
  if (!store) return false;
  return store.has(entityId);
}

// Patch a nested key inside a component's data object. `path` is the chain of
// keys leading to the field — empty path means "the component data itself".
// Pass value=null to delete a key.
export function patchComponentTracked(world, entityId, componentName, path, value) {
  const data = getComponent(world, entityId, componentName);
  if (!data) throw new Error('patchComponentTracked: missing component ' + componentName);
  applyPathSet(data, path, value);
  recordOp(world, {
    op: 'component_patch',
    entity: entityId,
    name: componentName,
    path: path.slice(),
    value: serializeForOp(value),
  });
}

function applyPathSet(rootData, path, value) {
  if (path.length === 0) {
    throw new Error('component_patch needs a non-empty path; use setComponentTracked to replace the whole component');
  }
  let cursor = rootData;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const key = path[depth];
    if (cursor[key] == null || typeof cursor[key] !== 'object') {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  const finalKey = path[path.length - 1];
  if (value === null) delete cursor[finalKey];
  else cursor[finalKey] = value;
}

// ── Set-aware ops (because JSON.stringify can't preserve Sets) ────────────
function getSetAt(world, entityId, componentName, path) {
  const data = getComponent(world, entityId, componentName);
  if (!data) throw new Error('set op: missing component ' + componentName);
  let cursor = data;
  for (let depth = 0; depth < path.length; depth++) {
    const key = path[depth];
    if (cursor[key] == null) {
      // Materialise an empty Set so first-time additions just work.
      cursor[key] = depth === path.length - 1 ? new Set() : {};
    }
    cursor = cursor[key];
  }
  return cursor;
}

export function setAddTracked(world, entityId, componentName, path, value) {
  const set = getSetAt(world, entityId, componentName, path);
  set.add(value);
  recordOp(world, { op: 'set_add', entity: entityId, name: componentName, path: path.slice(), value });
}

export function setRemoveTracked(world, entityId, componentName, path, value) {
  const set = getSetAt(world, entityId, componentName, path);
  set.delete(value);
  recordOp(world, { op: 'set_remove', entity: entityId, name: componentName, path: path.slice(), value });
}

export function setReplaceTracked(world, entityId, componentName, path, values) {
  const data = getComponent(world, entityId, componentName);
  if (!data) throw new Error('set_replace: missing component ' + componentName);
  let cursor = data;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const key = path[depth];
    if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  const finalKey = path[path.length - 1];
  cursor[finalKey] = new Set(values);
  recordOp(world, {
    op: 'set_replace',
    entity: entityId,
    name: componentName,
    path: path.slice(),
    values: Array.from(values),
  });
}

// Convert Set values to arrays so they survive JSON.stringify in op payloads.
function serializeForOp(value) {
  if (value instanceof Set) return Array.from(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const key in value) out[key] = serializeForOp(value[key]);
    return out;
  }
  if (Array.isArray(value)) return value.map(serializeForOp);
  return value;
}

// ── Delta application (client side) ───────────────────────────────────────
// Applies the inverse of the tracked ops without re-recording them.
export function applyChangeOps(world, ops) {
  const wasRecording = world.recordChanges;
  world.recordChanges = false;
  try {
    for (const op of ops) applyOneOp(world, op);
  } finally {
    world.recordChanges = wasRecording;
  }
}

function applyOneOp(world, op) {
  switch (op.op) {
    case 'entity_create': {
      world.entities.add(op.id);
      if (op.id >= world.nextEntityId) world.nextEntityId = op.id + 1;
      return;
    }
    case 'entity_destroy': {
      destroyEntity(world, op.id);
      return;
    }
    case 'component_set': {
      addComponent(world, op.entity, op.name, deepClone(op.value));
      return;
    }
    case 'component_remove': {
      removeComponent(world, op.entity, op.name);
      return;
    }
    case 'component_patch': {
      const data = getComponent(world, op.entity, op.name);
      if (!data) return;
      applyPathSet(data, op.path, deepClone(op.value));
      return;
    }
    case 'set_add': {
      const set = getSetAt(world, op.entity, op.name, op.path);
      set.add(op.value);
      return;
    }
    case 'set_remove': {
      const set = getSetAt(world, op.entity, op.name, op.path);
      set.delete(op.value);
      return;
    }
    case 'set_replace': {
      const data = getComponent(world, op.entity, op.name);
      if (!data) return;
      let cursor = data;
      for (let depth = 0; depth < op.path.length - 1; depth++) {
        const key = op.path[depth];
        if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = {};
        cursor = cursor[key];
      }
      cursor[op.path[op.path.length - 1]] = new Set(op.values);
      return;
    }
    default:
      console.warn('unknown change op:', op);
  }
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const key in value) out[key] = deepClone(value[key]);
  return out;
}

// ── Queries ───────────────────────────────────────────────────────────────
export function forEachEntityWith(world, componentNames, callback) {
  if (componentNames.length === 0) return;
  const stores = componentNames.map(name => world.componentStores.get(name));
  if (stores.some(store => !store)) return;
  let smallest = stores[0];
  for (const store of stores) if (store.size < smallest.size) smallest = store;
  for (const entityId of smallest.keys()) {
    let missing = false;
    const data = [];
    for (const store of stores) {
      if (!store.has(entityId)) { missing = true; break; }
      data.push(store.get(entityId));
    }
    if (missing) continue;
    callback(entityId, ...data);
  }
}

export function collectEntitiesWith(world, componentNames) {
  const results = [];
  forEachEntityWith(world, componentNames, (entityId) => results.push(entityId));
  return results;
}

export function addSystem(world, phase, systemFunction) {
  let list = world.systemsByPhase.get(phase);
  if (!list) {
    list = [];
    world.systemsByPhase.set(phase, list);
  }
  list.push(systemFunction);
}

export function runPhase(world, phase, context) {
  const systems = world.systemsByPhase.get(phase);
  if (!systems) return;
  for (const system of systems) system(world, context);
}

export function getWorldState(world) {
  if (world._worldStateEntity) return world._worldStateEntity;
  const entityId = createEntity(world);
  addComponent(world, entityId, 'WorldState', {});
  world._worldStateEntity = entityId;
  return entityId;
}
