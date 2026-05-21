# Modules

Crossover War is built as a stack of **modules**. Each module is a folder under
`src/modules/<name>/` that contributes terrain types, prefabs, hero archetypes,
points of interest, map-object types, systems, and the art assets that go with
them. The engine itself ships almost nothing — the `base` module is what makes
the running game look like a game.

The goal of this document is to make module authoring obvious. It is the source
of truth for the module API. **When you add new capabilities to the module
system, update this file in the same change.**

---

## Quick start: adding a module

1. Create a folder: `src/modules/<your-module-name>/`.
2. Drop an `index.js` file in it that default-exports a module definition (see
   [Module shape](#module-shape) below).
3. Drop any PNG / JPEG / WebP / GLB / GLTF art into `src/modules/<your-module-name>/assets/`.
4. Restart the dev server. The module is now installed — there is no central
   registration list to edit.

That is the entire workflow. Vite's `import.meta.glob` discovers every
`src/modules/*/index.js` and every file under `src/modules/*/assets/**` at
build / dev time.

To remove a module, delete its folder.

---

## Module shape

```js
// src/modules/example/index.js
import { createEntity, addComponent } from '../../game/ecs/world.js';
import {
  registerTerrain,
  registerPrefab,
  registerHero,
  registerPointOfInterestType,
  registerMapObjectType,
  declareAssetReference,
} from '../../game/ecs/registry.js';

export default {
  name: 'example',           // must match the folder name
  depends: ['base'],         // optional — list of other modules that must load first
  register({ world, registry, assets, moduleName, log }) {
    // Called once at game start, in dependency order. Register things here.
  },
};
```

The default export must be an object with:

| Field      | Required | Description                                                              |
|------------|----------|--------------------------------------------------------------------------|
| `name`     | no       | Must match the folder name if present. The loader warns on mismatch.     |
| `depends`  | no       | Array of module names that must `register()` before this one.            |
| `register` | **yes**  | Function called once. Receives a context object; see below.              |

### The `register` context

```ts
register({
  world,        // ECS world (only created at this point — usually you only touch registry)
  registry,     // The shared registry — most of your registrations go through here
  assets,       // Asset loader, for code that needs to ask whether an asset is present
  moduleName,   // The folder name; useful for namespacing ids
  log,          // console.log already prefixed with '[<module>]'
})
```

A module's `register()` runs at **startup only**. It should not mutate the
world; it should declare things on the registry. The world is populated later
by `gameRoom.js` (host) or by the snapshot the host ships (client).

---

## What you can register

The registry is intentionally a dumb bag of named definitions. Lookups happen
by id at runtime. Ids should be namespaced by module: `'base/grass'`,
`'mining-faction/dwarf-prospector'`, etc.

### Terrains — `registerTerrain(registry, definition)`

A terrain is a tile flavour. Every `Tile` component carries a `terrainId` that
points at one of these.

```js
registerTerrain(registry, {
  id: 'grass',              // required, unique
  name: 'Grass',
  movementCost: 1,
  walkable: true,           // false → impassable; pathfinding refuses it
  water: false,             // useful for vehicle-type checks later on
  fallbackColor: 0x7fbf5e,  // used by InstancedMesh material if no texture loads
  textureKey: 'base/grass.png', // optional — looked up in the asset loader
});
```

The renderer (`src/game/render/terrainInstances.js`) creates one `InstancedMesh`
per registered terrain id. So **a new terrain id = a new draw call**. Don't go
wild — terrains are flavours like grass / desert / lava, not per-tile
decorations.

### Prefabs — `registerPrefab(registry, prefabId, spawn)`

A prefab is a factory function `(world, params) → entityId`. Prefabs are the
canonical way to spawn entities. The base module ships two:

- `'base/tile'` — adds a `Tile { q, r, terrainId }` component
- `'base/hero'` — adds `Hero`, `Position`, `Movement`, `Ownership`

Call your prefab via `spawnFromPrefab(registry, prefabId, world, params)`. If
your prefab is the host-authoritative kind (it creates entities that need to
replicate to clients), use the tracked mutation helpers — see
[Tracked mutations](#tracked-mutations-host-authoritative-state).

### Hero archetypes — `registerHero(registry, definition)`

A hero archetype is a named "character class" that resolves to a prefab + a set
of defaults. The base module registers `'base/bob'`, `'base/alice'`,
`'base/john'`, and `'base/ringo'` — all pointing at `'base/hero'` with
identical defaults. Each player starts the game with two heroes drawn from this
list (player 0 gets Bob + Alice, player 1 gets John + Ringo, then it wraps).

```js
registerHero(registry, {
  id: 'base/bob',
  name: 'Bob',
  prefabId: 'base/hero',
  defaults: {
    archetypeId: 'base/bob',
    visionRadius: 4,
    movementMax: 20,
  },
});
```

`GameRoom._spawnHeroForPlayer` resolves an archetype and forwards
`archetype.defaults` as the params to the prefab.

### Points of interest — `registerPointOfInterestType(registry, definition)`

A POI is something on the map that triggers an effect when a hero enters it
(treasure chests, shrines, towns to capture). Currently the engine only stores
the registration; runtime visiting will hook in here.

```js
registerPointOfInterestType(registry, {
  id: 'base/treasure-chest',
  name: 'Treasure Chest',
  prefabId: 'base/treasure-chest',
  onVisit(world, hero, poiEntityId) { /* … */ },
});
```

### Map-object types — `registerMapObjectType(registry, definition)`

A map object is a passive entity on the map (resource pile, obstacle, decorative
prop). Same shape as POIs, minus `onVisit`. Currently just registered for
later use by spawners.

### Asset references — `declareAssetReference(registry, reference)`

Tells the asset audit which files this module *expects* to exist. The build
step (`scripts/audit-assets.mjs`, wired in as `prebuild`) writes the diff to
`docs/missing_assets.md`. Anything missing shows up there and in the
in-browser console.

```js
declareAssetReference(registry, {
  moduleName: 'base',
  kind: 'texture',        // or 'model'
  assetKey: 'base/grass.png',  // 'moduleName/relativePath' inside assets/
  declaredFor: 'terrain:grass', // free-text — appears in the audit output
});
```

You should declare a reference for every asset key you pass into a
`textureKey` / `modelKey` field. The audit will tell you what you're missing
in `docs/missing_assets.md`.

---

## Assets

### Where they live

Anything under `src/modules/<name>/assets/**` is auto-loaded:

```
src/modules/base/
├── index.js
└── assets/
    ├── grass.png
    ├── water.png
    └── mountain.png
```

Subdirectories are fine — the key is the path relative to `assets/`,
prefixed by the module name. `src/modules/base/assets/heroes/bob.glb` has the
asset key `'base/heroes/bob.glb'`.

Supported extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.glb`, `.gltf`.

### Looking assets up

The asset loader (`src/game/modules/assetLoader.js`) exposes:

- `hasAsset(key)` — quick check; doesn't trigger a load
- `getTexture(key, { requestedBy })` — synchronous; returns a `THREE.Texture` or
  null and logs to the "missing" list
- `loadModel(key, { requestedBy })` — async; resolves to a `THREE.Group` or
  null

`requestedBy` is a free-text breadcrumb that flows through to the missing-asset
log so you can tell which subsystem asked for the file.

### The audit

`scripts/audit-assets.mjs` runs before every build (`npm run build` →
`prebuild`). It greps each module's `index.js` for `declareAssetReference()`
literal calls, compares against the files actually present under
`assets/`, and writes the diff to `docs/missing_assets.md`. Missing references
do not break the build — they just show up in the report and as cube fallbacks
at runtime.

The audit reads source literally, so `declareAssetReference` calls that use
runtime-computed strings won't be picked up. Stick with string literals for
asset keys.

---

## Components used by the base module

These are the canonical components attached by the base prefabs. Any module is
free to add new components — there is no central type registry — but if you
extend a base prefab, you should know what's already on it.

| Component   | Attached by    | Fields                                                                 |
|-------------|----------------|------------------------------------------------------------------------|
| `Tile`      | `base/tile`    | `q`, `r`, `terrainId`                                                  |
| `Hero`      | `base/hero`    | `archetypeId`, `name`, `visionRadius`, `modelKey`                      |
| `Position`  | `base/hero`    | `q`, `r`                                                               |
| `Movement`  | `base/hero`    | `movementMax`, `movementLeft`, `plannedPath` (`{ steps, costs }` or null) |
| `Ownership` | `base/hero`    | `playerId`                                                             |
| `WorldState`| `gameRoom.js`  | `turn`, `activePlayerId`, `fogByPlayer`, `playerSlots`, …              |

Add your own components freely — `addComponent(world, entityId, 'YourName',
data)` is enough. For replication, see the next section.

---

## Tracked mutations (host-authoritative state)

The game is host-authoritative. The host's `GameRoom` mutates the world, the
ECS records each mutation as a JSON-patch-like op into `world.pendingChanges`,
and after each action the GameRoom drains the buffer, broadcasts it as a
`delta` message, and the clients replay the ops.

If your module needs to mutate world state at runtime (e.g. a POI's `onVisit`
handler), use the **tracked** helpers from `src/game/ecs/world.js`:

| Helper                                                          | Op emitted          |
|-----------------------------------------------------------------|---------------------|
| `createTrackedEntity(world)`                                    | `entity_create`     |
| `destroyTrackedEntity(world, id)`                               | `entity_destroy`    |
| `setComponentTracked(world, id, name, data)`                    | `component_set`     |
| `removeComponentTracked(world, id, name)`                       | `component_remove`  |
| `patchComponentTracked(world, id, name, path, value)`           | `component_patch`   |
| `setAddTracked(world, id, name, path, value)`                   | `set_add`           |
| `setRemoveTracked(world, id, name, path, value)`                | `set_remove`        |
| `setReplaceTracked(world, id, name, path, values)`              | `set_replace`       |

For one-time setup inside `register()` (which runs *before* a game session
exists) the un-tracked helpers (`addComponent`, etc.) are fine — there's no
client to replicate to yet. The host turns on recording when a session starts.

If you mutate state from a system that runs purely client-side (cosmetic-only
work, e.g. a particle system following a hero), keep it un-tracked and make
sure your changes are derivable from the replicated state — otherwise hosts
and clients will hash-disagree.

---

## Dependencies and load order

If your module needs definitions from another module, list them in `depends`:

```js
export default {
  name: 'mining-faction',
  depends: ['base'],         // base registers the 'base/hero' prefab we extend
  register({ registry }) {
    registerHero(registry, {
      id: 'mining-faction/dwarf-prospector',
      name: 'Dwarf Prospector',
      prefabId: 'base/hero',     // ← from base
      defaults: { /* … */ },
    });
  },
};
```

The loader (`src/game/modules/moduleLoader.js`) does a topological sort and
throws on missing deps or cycles. Within the same dependency tier the order
is whatever `import.meta.glob` returns — don't rely on it.

`base` is currently the only module that anything depends on. New gameplay
modules should almost always declare `depends: ['base']`.

---

## Adding new module capabilities

When you want a module to do something the registry can't currently express
— register a new system phase, ship a brand-new content type, hook a new
lifecycle event — the work tends to be:

1. Add the storage + a `registerXxx()` helper to `src/game/ecs/registry.js`.
2. Add the consumer in `src/game/gameRoom.js`, in a system, or in a renderer,
   depending on where the new content actually does work.
3. **Document the new helper here.** Add it to
   [What you can register](#what-you-can-register) with the same shape as the
   existing entries.
4. If the new capability references assets, extend `declareAssetReference`
   support if needed and the audit script in `scripts/audit-assets.mjs`.
5. Update the base module so the new helper has at least one in-tree usage.

The registry's existing collections (`pointOfInterestTypes`, `mapObjectTypes`)
are placeholders waiting for runtime wire-up — when you connect them, add the
runtime behaviour notes here.

---

## A complete example

A self-contained module that adds a "desert" terrain and a "Trader" hero
archetype:

```js
// src/modules/desert/index.js
import {
  registerTerrain,
  registerHero,
  declareAssetReference,
} from '../../game/ecs/registry.js';

const MODULE_NAME = 'desert';

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('adding desert terrain and trader hero');

    registerTerrain(registry, {
      id: 'desert',
      name: 'Desert',
      movementCost: 2,
      walkable: true,
      water: false,
      fallbackColor: 0xd9c388,
      textureKey: 'desert/sand.png',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME,
      kind: 'texture',
      assetKey: 'desert/sand.png',
      declaredFor: 'terrain:desert',
    });

    registerHero(registry, {
      id: 'desert/trader',
      name: 'Trader',
      prefabId: 'base/hero',
      defaults: {
        archetypeId: 'desert/trader',
        visionRadius: 5,
        movementMax: 24,
      },
    });
  },
};
```

Drop `src/modules/desert/assets/sand.png` next to it (or skip it and let
`docs/missing_assets.md` flag it). That's the whole module.

---

## Maintaining this document

This file is the contract between the engine and module authors. Anything that
changes the API surface should land in the same change as the doc update:

- Adding a new `registerXxx` helper → new entry under
  [What you can register](#what-you-can-register).
- Adding a new field to an existing register call → add it to the field table
  for that helper.
- Adding a new context field to `register({...})` → update the
  [The `register` context](#the-register-context) table.
- Adding a new component the base prefabs attach → update
  [Components used by the base module](#components-used-by-the-base-module).
- Adding a new tracked mutation op → update
  [Tracked mutations](#tracked-mutations-host-authoritative-state).
- Adding support for a new asset file extension → update [Assets](#assets).

If you find the doc is out of date, treat the doc as the bug and fix it.
