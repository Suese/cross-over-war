// Base module — terrains, prefabs, heroes, action types, and the base
// decorator that handles every tile not claimed by a biome.

import {
  createEntity,
  addComponent,
  getComponent,
} from '../../game/ecs/world.js';
import {
  registerTerrain,
  registerPrefab,
  registerHero,
  registerActionType,
  registerEmblem,
  setBaseDecorator,
  declareAssetReference,
} from '../../game/ecs/registry.js';
import { createSeededNoise2D, fractalNoise2D } from '../../game/map/perlin.js';

const MODULE_NAME = 'base';

export default {
  name: MODULE_NAME,
  depends: [],
  register({ registry, log }) {
    log('registering terrains, prefabs, heroes, action types, base decorator');

    // ── Action types ────────────────────────────────────────────────────
    registerActionType(registry, { id: 'base/take',  icon: '🫳', label: 'Take' });
    registerActionType(registry, { id: 'base/visit', icon: '🚩', label: 'Visit' });

    // ── Flag emblems ────────────────────────────────────────────────────
    // Players pick one of these in the lobby flag editor; the renderer paints
    // it in their chosen emblem colour onto the centre of the flag cloth.
    // The `draw` function fills a `size`×`size` canvas — keep shapes inside
    // ~85% of the bounds so they read at thumbnail scales.
    registerEmblem(registry, {
      id: 'base/blank', name: 'Blank',
      draw: () => { /* intentionally empty — solid stripes only */ },
    });
    registerEmblem(registry, {
      id: 'base/sun', name: 'Sun',
      draw: (ctx, size, colourHex) => {
        ctx.fillStyle = '#' + colourHex.toString(16).padStart(6, '0');
        const cx = size / 2, cy = size / 2;
        const innerRadius = size * 0.18;
        const rayInner = size * 0.22;
        const rayOuter = size * 0.42;
        ctx.beginPath(); ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2); ctx.fill();
        for (let i = 0; i < 12; i++) {
          const angle = (i / 12) * Math.PI * 2;
          const xa = cx + Math.cos(angle) * rayInner;
          const ya = cy + Math.sin(angle) * rayInner;
          const xb = cx + Math.cos(angle) * rayOuter;
          const yb = cy + Math.sin(angle) * rayOuter;
          ctx.lineWidth = size * 0.06;
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke();
        }
      },
    });
    registerEmblem(registry, {
      id: 'base/skull', name: 'Skull',
      draw: (ctx, size, colourHex) => {
        ctx.fillStyle = '#' + colourHex.toString(16).padStart(6, '0');
        const cx = size / 2, cy = size * 0.46;
        ctx.beginPath();
        ctx.ellipse(cx, cy, size * 0.28, size * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
        // Eye sockets — punch with destination-out so we can see whatever the
        // cloth painted underneath.
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath(); ctx.arc(cx - size * 0.10, cy - size * 0.02, size * 0.06, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + size * 0.10, cy - size * 0.02, size * 0.06, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // Jaw teeth — small fill rectangle on top of the cloth.
        ctx.fillRect(cx - size * 0.12, cy + size * 0.20, size * 0.24, size * 0.08);
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        for (let i = -2; i <= 2; i++) {
          ctx.fillRect(cx + i * size * 0.05 - size * 0.012, cy + size * 0.20, size * 0.024, size * 0.08);
        }
        ctx.restore();
      },
    });
    registerEmblem(registry, {
      id: 'base/crescent', name: 'Crescent',
      draw: (ctx, size, colourHex) => {
        ctx.fillStyle = '#' + colourHex.toString(16).padStart(6, '0');
        const cx = size / 2, cy = size / 2;
        ctx.beginPath(); ctx.arc(cx, cy, size * 0.36, 0, Math.PI * 2); ctx.fill();
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath(); ctx.arc(cx + size * 0.12, cy, size * 0.32, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      },
    });
    registerEmblem(registry, {
      id: 'base/eye', name: 'Eye',
      draw: (ctx, size, colourHex) => {
        const colour = '#' + colourHex.toString(16).padStart(6, '0');
        const cx = size / 2, cy = size / 2;
        ctx.strokeStyle = colour;
        ctx.fillStyle = colour;
        ctx.lineWidth = size * 0.05;
        // Outer almond.
        ctx.beginPath();
        ctx.moveTo(cx - size * 0.36, cy);
        ctx.quadraticCurveTo(cx, cy - size * 0.34, cx + size * 0.36, cy);
        ctx.quadraticCurveTo(cx, cy + size * 0.34, cx - size * 0.36, cy);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, size * 0.11, 0, Math.PI * 2); ctx.fill();
      },
    });
    registerEmblem(registry, {
      id: 'base/star', name: 'Star',
      draw: (ctx, size, colourHex) => {
        ctx.fillStyle = '#' + colourHex.toString(16).padStart(6, '0');
        const cx = size / 2, cy = size / 2;
        const outer = size * 0.4, inner = size * 0.18;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const angle = -Math.PI / 2 + i * Math.PI / 5;
          const radius = i % 2 === 0 ? outer : inner;
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
      },
    });

    // ── Terrain definitions ─────────────────────────────────────────────
    // The base mapgen produces a coarse classification — plains for any
    // land, deep-ocean for any sea, rocky-hills for any mountain. The
    // base decorator (registered below) refines plains/deep-ocean into a
    // grass/plains and shallow/deep mix. Biome decorators refine further
    // (forest, forest hills, mountain) on the hexes they're assigned.

    // Each terrain points at a .glb tile model under this module's assets/
    // folder. The renderer instances one InstancedMesh per submesh inside
    // each model; if a .glb is missing, the tile falls back to a coloured
    // cylinder using `fallbackColor` (and optional `textureKey`).

    registerTerrain(registry, {
      id: 'plains',
      name: 'Plains',
      description: 'Open meadow. Easy going for any traveller on foot.',
      components: {
        PassableByLand: { cost: 5 },
        PassableByAir: { cost: 1 },
        // Road carver baseline — costs nothing to "work" because there's
        // nothing to clear. Plains are the default base terrain that other
        // workable tiles get reduced to when a road is carved through.
        WorkableTerrain: { cost: 1 },
      },
      fallbackColor: 0x8fcc6a,
      textureKey: 'base/grass.png',
      modelKey: 'base/plains.glb',
      tileHeight: 0,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'texture',
      assetKey: 'base/grass.png', declaredFor: 'terrain:plains',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/plains.glb', declaredFor: 'terrain:plains',
    });

    // Plains variant — same gameplay as 'plains', different mesh. The base
    // decorator alternates between this and 'plains' via a fine-grained
    // noise sample so the meadow doesn't look like a single repeated tile.
    registerTerrain(registry, {
      id: 'plains-2',
      name: 'Plains',
      description: 'Open meadow. Easy going for any traveller on foot.',
      components: {
        PassableByLand: { cost: 5 },
        PassableByAir: { cost: 1 },
        WorkableTerrain: { cost: 1 },
      },
      fallbackColor: 0x8fcc6a,
      textureKey: 'base/grass.png',
      modelKey: 'base/plains-2.glb',
      tileHeight: 0,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/plains-2.glb', declaredFor: 'terrain:plains-2',
    });

    registerTerrain(registry, {
      id: 'grassy-hills',
      name: 'Grassy Hills',
      description: 'Rolling slopes of knee-high grass. Slower than open plain.',
      components: {
        PassableByLand: { cost: 7 },
        PassableByAir: { cost: 1 },
        WorkableTerrain: { cost: 2 },
      },
      fallbackColor: 0x6ea84a,
      modelKey: 'base/grassy-hills.glb',
      tileHeight: 0.25,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/grassy-hills.glb', declaredFor: 'terrain:grassy-hills',
    });

    registerTerrain(registry, {
      id: 'forest',
      name: 'Forest',
      description: 'Dense trees and undergrowth. Slow going on foot.',
      components: {
        PassableByLand: { cost: 80 },
        PassableByAir: { cost: 1 },
        // Trees can be felled — workable, but more expensive than open ground.
        WorkableTerrain: { cost: 5 },
      },
      fallbackColor: 0x355e36,
      modelKey: 'base/forest.glb',
      tileHeight: 0,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/forest.glb', declaredFor: 'terrain:forest',
    });

    registerTerrain(registry, {
      id: 'forest-hills',
      name: 'Forest Hills',
      description: 'Wooded slopes — steep climbs through dense growth.',
      components: {
        PassableByLand: { cost: 40 },
        PassableByAir: { cost: 1 },
        // Wooded slopes — most expensive workable terrain.
        WorkableTerrain: { cost: 12 },
      },
      fallbackColor: 0x44653c,
      modelKey: 'base/forest-hills.glb',
      tileHeight: 0.35,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/forest-hills.glb', declaredFor: 'terrain:forest-hills',
    });

    registerTerrain(registry, {
      id: 'rocky-hills',
      name: 'Rocky Hills',
      description: 'Rolling, broken slopes scattered with stone. Slow going on foot; trivial for anything that flies.',
      components: {
        PassableByLand: { cost: 60 },
        PassableByAir: { cost: 1 },
        WorkableTerrain: { cost: 8 },
      },
      fallbackColor: 0xa68a5e,
      textureKey: 'base/mountain.png',
      modelKey: 'base/rocky-hills.glb',
      tileHeight: 0.3,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'texture',
      assetKey: 'base/mountain.png', declaredFor: 'terrain:rocky-hills',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/rocky-hills.glb', declaredFor: 'terrain:rocky-hills',
    });

    registerTerrain(registry, {
      id: 'mountain',
      name: 'Mountain',
      description: 'Sheer rock and treacherous footing. Only the determined press through on foot.',
      components: {
        PassableByLand: { cost: 120 },
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0x6e5d48,
      modelKey: 'base/mountains.glb',
      tileHeight: 0.7,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/mountains.glb', declaredFor: 'terrain:mountain',
    });

    registerTerrain(registry, {
      id: 'deep-ocean',
      name: 'Deep Ocean',
      description: 'Open sea. Ships sail freely; fliers cross overhead. No footing for a land army.',
      components: {
        PassableByWater: { cost: 1 },
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0x2c6691,
      textureKey: 'base/water.png',
      modelKey: 'base/deep-ocean.glb',
      tileHeight: 0,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'texture',
      assetKey: 'base/water.png', declaredFor: 'terrain:deep-ocean',
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/deep-ocean.glb', declaredFor: 'terrain:deep-ocean',
    });

    registerTerrain(registry, {
      id: 'shallow-ocean',
      name: 'Shallow Ocean',
      description: 'Coastal shoals. Same cost to cross by water, but the water reads paler from above.',
      components: {
        PassableByWater: { cost: 1 },
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0x6cb4d4,
      modelKey: 'base/shallow-ocean.glb',
      tileHeight: 0,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/shallow-ocean.glb', declaredFor: 'terrain:shallow-ocean',
    });

    registerTerrain(registry, {
      id: 'bramble',
      name: 'Bramble',
      description: 'A dense thicket of thorny vines. Nothing on foot gets through, and there\'s no water to swim — only fliers can cross.',
      components: {
        PassableByAir: { cost: 1 },
      },
      fallbackColor: 0x3a4d24,
      modelKey: 'base/bramble.glb',
      tileHeight: 0,
    });
    declareAssetReference(registry, {
      moduleName: MODULE_NAME, kind: 'model',
      assetKey: 'base/bramble.glb', declaredFor: 'terrain:bramble',
    });

    // ── Tile prefab ─────────────────────────────────────────────────────
    registerPrefab(registry, 'base/tile', (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Tile', {
        q: params.q,
        r: params.r,
        terrainId: params.terrainId,
      });
      return entityId;
    });

    // ── Hero prefab ─────────────────────────────────────────────────────
    registerPrefab(registry, 'base/hero', (world, params) => {
      const entityId = createEntity(world);
      addComponent(world, entityId, 'Hero', {
        archetypeId: params.archetypeId ?? 'base/hero',
        name: params.name ?? 'Hero',
        visionRadius: params.visionRadius ?? 4,
        modelKey: params.modelKey ?? 'base/hero.glb',
      });
      addComponent(world, entityId, 'Position', { q: params.q ?? 0, r: params.r ?? 0 });
      addComponent(world, entityId, 'Movement', {
        movementMax: params.movementMax ?? 20,
        movementLeft: params.movementLeft ?? params.movementMax ?? 20,
        plannedPath: null,
      });
      addComponent(world, entityId, 'Ownership', { playerId: params.playerId ?? null });
      addComponent(world, entityId, 'BlocksMovement', {});
      addComponent(world, entityId, 'TraversesLand', {});
      // Every hero carries their player's flag — the renderer mounts a
      // generic flag mesh onto the entity's `flag-attach` child.
      addComponent(world, entityId, 'BearsFlag', {});
      return entityId;
    });

    declareAssetReference(registry, {
      moduleName: MODULE_NAME,
      kind: 'model',
      assetKey: 'base/hero.glb',
      declaredFor: 'hero:base',
    });

    // ── Hero archetypes ────────────────────────────────────────────────
    registerHero(registry, {
      id: 'base/bob', name: 'Bob', prefabId: 'base/hero',
      defaults: { archetypeId: 'base/bob', visionRadius: 4, movementMax: 20 },
    });
    registerHero(registry, {
      id: 'base/alice', name: 'Alice', prefabId: 'base/hero',
      defaults: { archetypeId: 'base/alice', visionRadius: 4, movementMax: 20 },
    });
    registerHero(registry, {
      id: 'base/john', name: 'John', prefabId: 'base/hero',
      defaults: { archetypeId: 'base/john', visionRadius: 4, movementMax: 20 },
    });
    registerHero(registry, {
      id: 'base/ringo', name: 'Ringo', prefabId: 'base/hero',
      defaults: { archetypeId: 'base/ringo', visionRadius: 4, movementMax: 20 },
    });

    // ── Base decorator ──────────────────────────────────────────────────
    // Runs once over every tile that isn't inside any biome. Modulates the
    // coarse mapgen output with perlin noise: plains → plains | plains-2 |
    // grassy-hills, deep-ocean → deep-ocean | shallow-ocean. Dusty hills are
    // left alone here — they only appear in biomes once the biome decorator
    // has had a chance to refine them.
    //
    // A second, finer-grained noise sample swaps half of the un-hilled plains
    // for the 'plains-2' variant so the meadow reads with visible texture
    // change rather than a single repeated mesh.
    setBaseDecorator(registry, ({ world, hexes, seed }) => {
      const noise = createSeededNoise2D(seed + 7901);
      const variantNoise = createSeededNoise2D(seed + 31337);
      for (const hex of hexes) {
        const tile = getComponent(world, hex.entityId, 'Tile');
        if (!tile) continue;
        const sample = fractalNoise2D(noise, hex.q * 0.18, hex.r * 0.18, 3, 0.55, 2.0);
        if (tile.terrainId === 'plains') {
          if (sample > 0.15) {
            tile.terrainId = 'grassy-hills';
          } else {
            // Finer-scale roll picks which of the two plains skins to use.
            const variant = fractalNoise2D(variantNoise, hex.q * 0.55, hex.r * 0.55, 3, 0.55, 2.0);
            tile.terrainId = variant > 0 ? 'plains-2' : 'plains';
          }
        } else if (tile.terrainId === 'deep-ocean') {
          tile.terrainId = sample > 0.1 ? 'shallow-ocean' : 'deep-ocean';
        }
        // rocky-hills outside any biome stays as-is — biomes handle further refinement.
      }
    });
  },
};
