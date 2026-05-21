// Minimal ECS world.
//
// Entities are integer ids. Components are plain objects stored per-name in
// sparse maps (componentName → entityId → data). Systems are plain functions
// invoked with the world plus a context object; whether a system runs every
// tick, every frame, or only on events is decided by which phase it was added
// under.
//
// Compositional on purpose — there are no formal "component types". Anything
// can attach any-named component, and any system can query for any name.

export function createWorld() {
  return {
    nextEntityId: 1,
    entities: new Set(),
    componentStores: new Map(),       // name → Map<entityId, data>
    systemsByPhase: new Map(),        // phase → array of system functions
  };
}

export function createEntity(world) {
  const entityId = world.nextEntityId++;
  world.entities.add(entityId);
  return entityId;
}

export function destroyEntity(world, entityId) {
  if (!world.entities.has(entityId)) return;
  for (const store of world.componentStores.values()) store.delete(entityId);
  world.entities.delete(entityId);
}

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

export function removeComponent(world, entityId, componentName) {
  const store = world.componentStores.get(componentName);
  if (!store) return;
  store.delete(entityId);
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

// Iterate every entity that has all the named components. The callback
// receives (entityId, ...componentData) so positional destructuring stays
// readable in call sites.
export function forEachEntityWith(world, componentNames, callback) {
  if (componentNames.length === 0) return;
  const stores = componentNames.map(name => world.componentStores.get(name));
  if (stores.some(store => !store)) return;
  // Iterate the smallest store to keep the inner loop cheap.
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

// Collect entity ids that match a set of component names. Handy when callers
// need a list to iterate twice or sort.
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

// Singleton "world state" — a special entity that any module can stash
// scalar/global data on. Created lazily; identified by the 'WorldState' tag.
export function getWorldState(world) {
  if (world._worldStateEntity) return world._worldStateEntity;
  const entityId = createEntity(world);
  addComponent(world, entityId, 'WorldState', {});
  world._worldStateEntity = entityId;
  return entityId;
}
