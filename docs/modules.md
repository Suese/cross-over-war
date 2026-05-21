# Modules

Crossover War is built as a stack of **modules**. Each module is a folder under
`src/modules/<name>/` that contributes terrain types, prefabs, hero archetypes,
map-object types, world spawners, and the art assets that go with them. The
engine itself ships almost nothing — the `base` and `testing` modules are what
make the running game look like a game.

This document is the contract between the engine and module authors. It is
the source of truth for the module API. **When you add new capabilities to
the module system, update this file in the same change.**

---

## Quick start

1. Create a folder: `src/modules/<your-module-name>/`.
2. Drop an `index.js` file in it that default-exports a module definition (see
   [Module shape](#module-shape) below).
3. Drop any PNG / JPEG / WebP / GLB / GLTF art into `src/modules/<your-module-name>/assets/`.
4. Restart the dev server. The module is now installed — there is no central
   registration list to edit.

Vite's `import.meta.glob` discovers every `src/modules/*/index.js` and every
file under `src/modules/*/assets/**` at build / dev time. Delete a folder to
remove the module entirely.

---

## Module shape

```js
// src/modules/example/index.js
import { createEntity, addComponent } from '../../game/ecs/world.js';
import {
  registerTerrain,
  registerPrefab,
  registerHero,
  registerMapObjectType,
  registerWorldSpawner,
  declareAssetReference,
  spawnFromPrefab,
} from '../../game/ecs/registry.js';

export default {
  name: 'example',           // must match the folder name
  depends: ['base'],         // optional — list of other modules that must load first
  register({ world, registry, assets, moduleName, log }) {
    // Called once at game start, in dependency order. Register things here.
  },
};
```

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

A module's `register()` runs at **startup only**, in dependency order. It
should not mutate the world; it should declare things on the registry. The
world is populated later by `gameRoom.js` (host) or by the snapshot the host
ships (client).

### Dependencies and load order

```js
export default {
  name: 'mining-faction',
  depends: ['base'],
  register({ registry }) { /* … */ },
};
```

The loader (`src/game/modules/moduleLoader.js`) does a topological sort and
throws on missing deps or cycles. Within the same dependency tier the order
is whatever `import.meta.glob` returns — don't rely on it; use `depends` if
you need ordering.

`base` is currently the foundation; gameplay modules should almost always
declare `depends: ['base']`.

---

## Registry — what your module can register

The registry is intentionally a dumb bag of named definitions. Lookups happen
by id at runtime. Ids should be namespaced by module: `'base/grass'`,
`'mining-faction/dwarf-prospector'`, etc.

### Terrains — `registerTerrain(registry, definition)`

A terrain is a tile flavour. Every `Tile` entity carries a `terrainId` that
points at one of these.

```js
registerTerrain(registry, {
  id: 'grass',
  name: 'Grass',
  description: 'Open meadow. Easy going for any traveller on foot.',
  components: {
    PassableByLand: { cost: 1 },
    PassableByAir:  { cost: 1 },
  },
  fallbackColor: 0x7fbf5e,
  textureKey: 'base/grass.png',
});
```

| Field          | Description                                                    |
|----------------|----------------------------------------------------------------|
| `id`           | Unique within the registry; namespace by module.               |
| `name`         | Shown in the right-click info panel.                           |
| `description`  | Optional flavour text shown in the info panel.                 |
| `components`   | Map of `PassableBy<Mode>: { cost: N }` entries. See [Traversal](#traversal). |
| `fallbackColor`| `THREE.Color`-compatible hex. Used by the InstancedMesh material when the texture is missing. |
| `textureKey`   | Optional asset-loader key for the texture.                     |

The renderer creates one `InstancedMesh` per registered terrain id — a new
terrain id costs one draw call. Terrains are flavours like grass / desert /
lava, not per-tile decorations.

### Prefabs — `registerPrefab(registry, prefabId, spawn)`

A prefab is a factory function `(world, params) → entityId`. Prefabs are the
canonical way to spawn entities. They may attach any number of components and
even create **multiple coordinated entities** in one call — see
[Recipe: building a Wizard's Tower](#recipe-building-a-wizards-tower).

```js
registerPrefab(registry, 'mymod/torch', (world, params) => {
  const entityId = createEntity(world);
  addComponent(world, entityId, 'Position', { q: params.q, r: params.r });
  addComponent(world, entityId, 'MapObject', { typeId: 'mymod/torch' });
  return entityId;
});
```

Call your prefab via `spawnFromPrefab(registry, prefabId, world, params)`. The
return value (an entityId, or whatever the prefab chooses) is up to you, but
returning the "anchor" entity is the convention.

### Hero archetypes — `registerHero(registry, definition)`

A hero archetype is a named "character class" that resolves to a prefab + a
set of defaults. The base module ships `'base/bob'`, `'base/alice'`,
`'base/john'`, and `'base/ringo'` — all pointing at `'base/hero'` with
identical defaults. Each player starts the game with two heroes drawn from
this list (player 0 gets Bob + Alice, player 1 gets John + Ringo, then it
wraps).

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

`GameRoom._spawnPlayerHero` resolves an archetype and forwards
`archetype.defaults` as the params to the prefab.

### Action types — `registerActionType(registry, definition)`

UI templates for the hover cursor. Every `Actionable` component on an
entity references one of these by id, and the hover layer pulls the icon
+ label out of the registry to render the prompt. Per-instance memory is
just a string id, so a map full of campfires doesn't ship the same `'🫳
Take'` text fifty times.

```js
registerActionType(registry, {
  id: 'base/take',     // namespace by module; required, unique
  icon: '🫳',           // shown to the left of the label
  label: 'Take',       // shown after the icon
});
```

The base module ships `base/take` and `base/visit`; any module can declare
more (e.g. `'inspect'`, `'speak'`, `'fight'`) without touching engine code.

### Map-object types — `registerMapObjectType(registry, definition)`

A map-object type tells the renderer **how to draw** instances of a given
typeId and acts as a registry of metadata (name, description) the info panel
and visit events can pull from. Both collectables and points of interest are
map-object instances under the hood.

```js
registerMapObjectType(registry, {
  id: 'mymod/torch',
  name: 'Torch',
  description: 'A wall sconce, still burning.',
  prefabId: 'mymod/torch',
  buildMesh: (registry, assets, mapObject) => new THREE.Group(/* … */),
});
```

Instances of this type must carry a `MapObject { typeId: 'mymod/torch' }`
component plus a `Position`. The renderer iterates `MapObject + Position`
entities, looks the type up by `typeId`, and calls `buildMesh()` to construct
the Three.js group.

### World spawners — `registerWorldSpawner(registry, spawnerFn)`

Called once at the start of a fresh game, after the map terrain is generated
and player heroes are placed, **before** fog initialisation. Lets a module
scatter its instances across the world without the engine having to know
about them.

```js
registerWorldSpawner(registry, ({ world, registry, mapWidth, mapHeight, seed, occupiedHexes }) => {
  // walk world tiles, pick spots, spawn with spawnFromPrefab.
  // add each placed hex to `occupiedHexes` so later spawners don't collide.
});
```

| Context field   | Description                                                                  |
|-----------------|------------------------------------------------------------------------------|
| `world`         | The ECS world. Use `forEachEntityWith(world, ['Tile'], …)` to walk tiles.    |
| `registry`      | Same registry handed to your `register()` — useful for `spawnFromPrefab`.    |
| `mapWidth`      | Map width in hexes.                                                          |
| `mapHeight`     | Map height in hexes.                                                         |
| `seed`          | The host's map seed; use it if you want deterministic placement.             |
| `occupiedHexes` | Mutable `Set<"q,r">` seeded with every hero spawn. **Read it to skip claimed hexes; write into it for every hex you claim**, including all walls of multi-hex structures. |

Spawners run on the host inside `startNewGame()`. Loaded saves already
contain their entities — the snapshot replay bypasses this hook.

### Asset references — `declareAssetReference(registry, reference)`

Tells the asset audit which files this module *expects* to exist. The build
step (`scripts/audit-assets.mjs`, wired in as `prebuild`) writes the diff to
`docs/missing_assets.md`. Anything missing shows up there and in the
in-browser console.

```js
declareAssetReference(registry, {
  moduleName: 'base',
  kind: 'texture',                  // or 'model'
  assetKey: 'base/grass.png',       // 'moduleName/relativePath' inside assets/
  declaredFor: 'terrain:grass',     // free-text — appears in the audit output
});
```

Declare a reference for every asset key you pass into a `textureKey` /
`modelKey` field. The audit only matches **string literals** — runtime-built
asset keys are invisible to it.

---

## Entity components for map content

The registry tells the engine *what kinds of things exist*; ECS components on
entities tell the engine *what each individual instance does*. Map content is
assembled by attaching atomic components to entities — usually inside a prefab.

| Component         | What it does                                                                                    |
|-------------------|-------------------------------------------------------------------------------------------------|
| `Position`        | `{ q, r }` — the hex this entity sits on. Required for anything map-resident.                   |
| `MapObject`       | `{ typeId }` — selects a registered map-object type for rendering + metadata.                   |
| `Visitable`       | `{ message }` — stepping onto this entity's hex fires `entity_visited` and shows the message. Supports `{heroName}` substitution. |
| `ConsumedOnVisit` | Empty tag — when combined with `Visitable`, the entity is destroyed after the visit fires (one-shot pickups). |
| `Actionable`      | `{ actionTypeId }` — references a registered action type (`base/take`, `base/visit`, …) whose `{ icon, label }` the hover layer renders next to the cursor while flipping it to a pointer. Per-entity payload is just an id. |
| `TerrainModifier` | `{ components }` — per-hex override of `PassableBy*`. Pathfinder uses modifier instead of base terrain. |
| `BlocksMovement`  | Empty tag — the hex this entity is on is treated as occupied for pathfinding (heroes, big props). |
| `Traverses<Mode>` | Empty tag (e.g. `TraversesLand`) — the mover can cross terrain that declares `PassableBy<Mode>`. |
| `Hero`            | `{ archetypeId, name, visionRadius, modelKey }` — gameplay-side hero data.                      |
| `Movement`        | `{ movementMax, movementLeft, plannedPath }` — turn-budget bookkeeping.                         |
| `Ownership`       | `{ playerId }` — who controls this entity.                                                      |
| `Tile`            | `{ q, r, terrainId }` — map tile. Don't attach manually; created by `generateMap`.              |
| `WorldState`      | Singleton — turn order, fog, phase, seed. Owned by `gameRoom.js`.                               |

Attach components freely with `addComponent(world, entityId, 'YourName', data)`.
Anything is allowed — there is no central type registry. Atomic over monolithic:
prefer many small components (`Visitable`, `ConsumedOnVisit`, `BlocksMovement`,
`TraversesLand`) over one big bag of fields.

### How to make a Collectable

A one-shot pickup. Stepping onto its hex shows a message and removes the
entity. That's two behaviours, so it's two components: `Visitable` (the
message-on-step part) plus `ConsumedOnVisit` (the destroy-after part).

```js
// Prefab
registerPrefab(registry, 'mymod/wishing-coin', (world, params) => {
  const entityId = createEntity(world);
  addComponent(world, entityId, 'Position', { q: params.q, r: params.r });
  addComponent(world, entityId, 'MapObject', { typeId: 'mymod/wishing-coin' });
  addComponent(world, entityId, 'Visitable', { message: 'You found a coin, {heroName}!' });
  addComponent(world, entityId, 'ConsumedOnVisit', {});
  addComponent(world, entityId, 'Actionable', { actionTypeId: 'base/take' });
  return entityId;
});

// Type for the renderer
registerMapObjectType(registry, {
  id: 'mymod/wishing-coin',
  name: 'Wishing Coin',
  description: 'A glinting coin half-buried in the moss.',
  prefabId: 'mymod/wishing-coin',
  buildMesh: () => /* small disc THREE.Group */,
});
```

On the host, `gameRoom._moveAlongPath` checks every step for a `Visitable`
on the new tile; if it finds one, it halts the hero, emits an
`entity_visited` event, and (because `ConsumedOnVisit` is present)
destroys the entity. The client shows the Okay dialog once the hero's
walk animation finishes.

### How to make a Point of Interest

Same as a Collectable, but the entity **persists** so the hero can revisit
it. Just leave off `ConsumedOnVisit`:

```js
addComponent(world, entityId, 'Visitable', {
  message: 'Welcome to the well, {heroName}. Make a wish.',
});
addComponent(world, entityId, 'Actionable', { actionTypeId: 'base/visit' });
```

`{heroName}` substitution happens host-side at visit time, so the wire
payload already contains the formatted text. The hero halts on the
visitable tile and the entity stays in the world for next time.

A tile can never accidentally be both a collectable and a POI — there's
only one `Visitable` per entity, and the consumption behaviour is a
separate, opt-in tag.

### How to make a Map Object actionable (cursor + label)

Attach `Actionable { actionTypeId }` to anything you want the hover layer
to advertise as interactable, referencing a registered action type:

```js
// in your module's register():
registerActionType(registry, { id: 'mymod/trade', icon: '🪙', label: 'Trade' });

// in your prefab:
addComponent(world, entityId, 'Actionable', { actionTypeId: 'mymod/trade' });
```

The hover layer resolves the id through the registry, renders the icon +
label next to the cursor, and switches the canvas cursor to a pointer. It
doesn't look at `Visitable` or any other behaviour component — the UI hint
and the behaviour are independent. A non-visitable map object can still
be marked Actionable (a sign you inspect via right-click, say) and vice
versa.

### How to make a Map Object (no visit behaviour)

A `MapObject + Position` entity with no `Visitable` component is just
decoration — it renders, it shows up in the right-click info panel, but
stepping onto its hex does nothing special. Add `BlocksMovement` if you
want a static obstacle (boulder, ruin) heroes cannot pass through.

### How to make a Terrain Modifier

When a multi-hex structure needs to make non-anchor hexes impassable
without rewriting the underlying tile, attach a `TerrainModifier`:

```js
addComponent(world, wallId, 'Position', { q, r });
addComponent(world, wallId, 'TerrainModifier', {
  components: { PassableByAir: { cost: 1 } },   // fliers only
});
```

The pathfinder calls `resolveTerrainCost(modifier ?? terrain, modes)` for
each candidate tile, so the modifier completely replaces the base terrain's
`PassableBy*` entries for movement purposes (rendering is untouched — the
ground still shows whatever terrain texture is underneath).

If you start mutating modifiers mid-game, call `invalidateTileIndex(world)`
so the pathfinder rebuilds its cache. Spawn-time modifiers are picked up
automatically the first time `findPath` is called.

---

## Prefabs as composition

Prefabs are not 1:1 with single entities. A prefab can stamp out a whole
**cluster** of coordinated entities in a single call — that is how the
engine builds "buildings" without needing a `Building` concept.

The Mushroom Hut prefab in `src/modules/testing/` is the worked example:
one anchor entity (carries `MapObject + Position + Visitable + Actionable`
and the visible mesh) plus four wall entities (`Position +
TerrainModifier`). The hut emerges from the atoms; the engine has no idea
what a "Mushroom Hut" is.

Anything can go in a prefab, but on the main map the practical mix is
some combination of:

- **Rendering** — `MapObject { typeId }` on an anchor entity.
- **Visit behaviour** — `Visitable` on the anchor (+ `ConsumedOnVisit` to
  make it a one-shot pickup).
- **UI hint** — `Actionable { actionTypeId }` on the anchor so the hover
  layer shows the cursor prompt.
- **Passability changes** — `TerrainModifier` on non-anchor footprint hexes;
  `BlocksMovement` on the anchor if heroes shouldn't be able to stand on it.
- **Visible structure** — the type's `buildMesh` returns a `THREE.Group`
  that may visually span more than one hex (using local-space offsets), but
  it is still owned by one anchor entity.

---

## Traversal — `PassableBy<Mode>` on terrain, `Traverses<Mode>` on movers

Traversability is fully compositional. Each terrain's `components` map holds
zero or more `PassableBy<Mode>` entries, each carrying its own movement-point
cost. Each mover (currently always a hero entity) carries `Traverses<Mode>`
tag components. A mover can cross a terrain iff there exists a mode tag
common to both sides; when several modes match, the pathfinder picks the
cheapest one.

The base module declares three modes — `Land`, `Water`, `Air` — but nothing
in the engine enumerates them. To add an `Underground` traversal, register
new terrain with `PassableByUnderground: { cost: N }` and have whichever
units need it carry `TraversesUnderground`; no engine code changes.

Two helpers in `src/game/ecs/traversal.js` are what every consumer goes
through:

- `collectTraversalModes(world, entityId)` — returns the mover's mode tags.
- `resolveTerrainCost(terrain, modes)` — cheapest matching cost, or `null` if
  the mover cannot enter at all.
- `listPassableModes(terrain)` — every `{ mode, cost }` for the info panel.

---

## Recipe: building a Wizard's Tower

This is the canonical "complete building" walkthrough. The Wizard's Tower
will be a 3-hex structure: an entrance POI at the anchor, two stone wall
hexes forming a small footprint, a tall pointy mesh, fliers-only
passability for the walls. By the end you'll have map-object rendering,
visit behaviour, passability changes, and world placement — fully
integrated, no engine edits.

### 1. Create the folder

```
src/modules/wizards-tower/
├── index.js
└── assets/             # only if you want texture / model overrides
```

### 2. Write `index.js`

```js
// src/modules/wizards-tower/index.js
import {
  CylinderGeometry, ConeGeometry, BoxGeometry,
  Mesh, MeshStandardMaterial, Group,
} from 'three';
import { createEntity, addComponent, forEachEntityWith } from '../../game/ecs/world.js';
import {
  registerPrefab,
  registerMapObjectType,
  registerWorldSpawner,
  getTerrain,
  spawnFromPrefab,
} from '../../game/ecs/registry.js';
import { resolveTerrainCost } from '../../game/ecs/traversal.js';
import { hexKey } from '../../game/map/hex.js';

const MODULE_NAME = 'wizards-tower';
const TYPE_ID = 'wizards-tower/tower';
const PREFAB_ID = 'wizards-tower/tower';
const DENSITY_TILES_PER_TOWER = 800;

// Footprint: two walls behind the entrance (the POI). The walls become
// fliers-only TerrainModifier entities; the POI tile stays land-passable
// so heroes can walk up to it.
const WALL_OFFSETS = [
  { dq:  0, dr: -1 },   // N
  { dq:  1, dr: -1 },   // NE
];

export default {
  name: MODULE_NAME,
  depends: ['base'],
  register({ registry, log }) {
    log('registering wizard\'s tower');

    // ── 1) Tell the renderer how to draw the type ──────────────────────
    registerMapObjectType(registry, {
      id: TYPE_ID,
      name: "Wizard's Tower",
      description: 'A slender stone spire. The wizard rarely receives visitors.',
      prefabId: PREFAB_ID,
      buildMesh: () => buildTowerMesh(),
    });

    // ── 2) Prefab — stamps out the POI + walls in one call ─────────────
    registerPrefab(registry, PREFAB_ID, (world, params) => {
      const anchorQ = params.q ?? 0;
      const anchorR = params.r ?? 0;

      // POI / anchor: visible mesh + visit message + hover label.
      const poiId = createEntity(world);
      addComponent(world, poiId, 'Position', { q: anchorQ, r: anchorR });
      addComponent(world, poiId, 'MapObject', { typeId: TYPE_ID });
      addComponent(world, poiId, 'Visitable', {
        message: 'The wizard\'s door is locked, {heroName}. Try again another day.',
      });
      addComponent(world, poiId, 'Actionable', { actionTypeId: 'base/visit' });

      // Walls — no rendering, no visit. Just passability override.
      for (const offset of WALL_OFFSETS) {
        const wallId = createEntity(world);
        addComponent(world, wallId, 'Position', {
          q: anchorQ + offset.dq,
          r: anchorR + offset.dr,
        });
        addComponent(world, wallId, 'TerrainModifier', {
          components: { PassableByAir: { cost: 1 } },
        });
      }

      return poiId;
    });

    // ── 3) Spawner — scatter towers on the fresh map ───────────────────
    registerWorldSpawner(registry, ({ world, registry: reg, occupiedHexes }) => {
      const tilesByKey = new Map();
      forEachEntityWith(world, ['Tile'], (_id, tile) => {
        tilesByKey.set(hexKey(tile.q, tile.r), tile);
      });
      if (tilesByKey.size === 0) return;

      // Build the candidate list: anchor + every wall hex must be land,
      // and none of them may already be claimed.
      const candidates = [];
      for (const [key, tile] of tilesByKey) {
        if (occupiedHexes.has(key)) continue;
        if (!isLandTile(tile, reg)) continue;
        let valid = true;
        for (const off of WALL_OFFSETS) {
          const fk = hexKey(tile.q + off.dq, tile.r + off.dr);
          if (occupiedHexes.has(fk)) { valid = false; break; }
          const ft = tilesByKey.get(fk);
          if (!ft || !isLandTile(ft, reg)) { valid = false; break; }
        }
        if (valid) candidates.push({ q: tile.q, r: tile.r });
      }
      if (candidates.length === 0) return;

      const target = Math.max(1, Math.round(tilesByKey.size / DENSITY_TILES_PER_TOWER));
      let placed = 0;
      while (placed < target && candidates.length > 0) {
        const idx = Math.floor(Math.random() * candidates.length);
        const anchor = candidates[idx];
        candidates[idx] = candidates[candidates.length - 1];
        candidates.pop();
        // Earlier huts / towers may have claimed overlapping hexes.
        if (occupiedHexes.has(hexKey(anchor.q, anchor.r))) continue;
        let stillValid = true;
        for (const off of WALL_OFFSETS) {
          if (occupiedHexes.has(hexKey(anchor.q + off.dq, anchor.r + off.dr))) {
            stillValid = false;
            break;
          }
        }
        if (!stillValid) continue;
        spawnFromPrefab(reg, PREFAB_ID, world, { q: anchor.q, r: anchor.r });
        occupiedHexes.add(hexKey(anchor.q, anchor.r));
        for (const off of WALL_OFFSETS) {
          occupiedHexes.add(hexKey(anchor.q + off.dq, anchor.r + off.dr));
        }
        placed++;
      }
    });
  },
};

function isLandTile(tile, registry) {
  const terrain = getTerrain(registry, tile.terrainId);
  return resolveTerrainCost(terrain, ['Land']) != null;
}

function buildTowerMesh() {
  const inner = new Group();

  const stoneMat = new MeshStandardMaterial({ color: 0x8a8c95, roughness: 0.9 });
  const trunk = new Mesh(new CylinderGeometry(0.5, 0.6, 2.6, 12), stoneMat);
  trunk.position.y = 1.3;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  inner.add(trunk);

  const roof = new Mesh(
    new ConeGeometry(0.7, 0.9, 12),
    new MeshStandardMaterial({ color: 0x4a5fa2, roughness: 0.7 }),
  );
  roof.position.y = 3.05;
  roof.castShadow = true;
  inner.add(roof);

  const door = new Mesh(
    new BoxGeometry(0.35, 0.55, 0.05),
    new MeshStandardMaterial({ color: 0x3a2418, roughness: 0.9 }),
  );
  door.position.set(0, 0.4, 0.55);
  inner.add(door);

  // Shift the visible structure half a hex north into the wall footprint
  // so the POI tile to the south reads as "outside the tower".
  const outer = new Group();
  inner.position.set(0, 0, -0.75);
  outer.add(inner);
  return outer;
}
```

### 3. Restart the dev server

`import.meta.glob` re-scans on restart. Start a fresh game and the first
turn should reveal a few Wizard's Towers — each is a POI with two
fliers-only wall hexes behind it. Click one to plan a route; the planner
will refuse a path that tries to walk through the walls.

### 4. What you got, layer by layer

| Layer            | Where it lives                                                              |
|------------------|-----------------------------------------------------------------------------|
| Type metadata    | `registerMapObjectType` (rendering hook + display name)                     |
| Stamp behaviour  | `registerPrefab` (anchor POI + wall entities, all wired in one call)        |
| Placement        | `registerWorldSpawner` (footprint validation, claim hexes via `occupiedHexes`) |
| Rendering        | `buildTowerMesh()` returning a `THREE.Group` shifted into the cove          |
| Visit behaviour  | `Visitable` component on the anchor — engine fires the visit event         |
| Hover hint       | `Actionable` on the anchor — flips cursor to pointer + shows the label     |
| Passability      | `TerrainModifier` on each wall hex; pathfinder consults `modifier ?? terrain` |

No engine files were edited. Every piece is opt-in atomic component data
that existing systems were already looking for.

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
prefixed by the module name. `src/modules/base/assets/heroes/bob.glb` has
the asset key `'base/heroes/bob.glb'`.

Supported extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.glb`, `.gltf`.

### Looking assets up

The asset loader (`src/game/modules/assetLoader.js`) exposes:

- `hasAsset(key)` — quick check; doesn't trigger a load
- `getTexture(key, { requestedBy })` — synchronous; returns a `THREE.Texture`
  or null and logs to the "missing" list
- `loadModel(key, { requestedBy })` — async; resolves to a `THREE.Group` or
  null

`requestedBy` is a free-text breadcrumb that flows through to the missing-asset
log so you can tell which subsystem asked for the file.

### The audit

`scripts/audit-assets.mjs` runs before every build (`npm run build` →
`prebuild`). It greps each module's `index.js` for `declareAssetReference()`
literal calls, compares against the files actually present under `assets/`,
and writes the diff to `docs/missing_assets.md`. Missing references do not
break the build — they just show up in the report and as cube fallbacks at
runtime.

The audit reads source literally, so `declareAssetReference` calls that use
runtime-computed strings won't be picked up. Stick with string literals for
asset keys.

---

## Tracked mutations (host-authoritative state)

The game is host-authoritative. The host's `GameRoom` mutates the world, the
ECS records each mutation as a JSON-patch-like op into `world.pendingChanges`,
and after each action the GameRoom drains the buffer, broadcasts it as a
`delta` message, and the clients replay the ops.

If your code needs to mutate world state at runtime (e.g. a future POI visit
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

For one-time setup inside `register()` and inside world spawners the
un-tracked helpers (`addComponent`, etc.) are correct — those mutations are
part of the initial snapshot, not deltas, and any tracked ops emitted at
setup time get drained and discarded.

If you mutate state from a system that runs purely client-side (cosmetic-only
work, e.g. a particle system following a hero), keep it un-tracked and make
sure your changes are derivable from the replicated state — otherwise hosts
and clients will hash-disagree.

---

## Adding new module capabilities

When you want a module to do something the registry can't currently express
— register a new system phase, ship a brand-new content type, hook a new
lifecycle event — the work tends to be:

1. Add the storage + a `registerXxx()` helper to `src/game/ecs/registry.js`.
2. Add the consumer in `src/game/gameRoom.js`, in a system, or in a renderer,
   depending on where the new content actually does work.
3. **Document the new helper here.** Add it to
   [Registry](#registry--what-your-module-can-register) with the same shape
   as the existing entries.
4. If the new capability references assets, extend `declareAssetReference`
   support if needed and the audit script in `scripts/audit-assets.mjs`.
5. Update the base or testing module so the new helper has at least one
   in-tree usage.

---

## Maintaining this document

This file is the contract between the engine and module authors. Anything that
changes the API surface should land in the same change as the doc update:

- Adding a new `registerXxx` helper → new entry under
  [Registry](#registry--what-your-module-can-register).
- Adding a new field to an existing register call → add it to the field table
  for that helper.
- Adding a new context field to `register({...})` → update the
  [register context](#the-register-context) section.
- Adding a new component the engine reads → update the
  [Entity components for map content](#entity-components-for-map-content) table.
- Adding a new tracked mutation op → update [Tracked mutations](#tracked-mutations-host-authoritative-state).
- Adding support for a new asset file extension → update [Assets](#assets).

If you find the doc is out of date, treat the doc as the bug and fix it.
