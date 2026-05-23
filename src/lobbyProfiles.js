// Lobby-time helpers for the player profile editor.
//
// A *profile* is a named bundle of preferences the player carries between
// games: their commander name, their flag config (3 colours + stripe +
// emblem + emblem colour), and (deferred) a preferred starting castle/biome
// type. Profiles persist in localStorage so the same player gets the same
// flag back next session.
//
// The lobby also needs an emblem registry so the preview canvas can paint
// module-provided emblems before any game session has started. We spin up a
// throwaway registry + world, run loadAllModules into it, and hand the
// registry out via `getLobbyRegistry()` for both the emblem dropdown and
// the preview canvas.

import { createWorld } from './game/ecs/world.js';
import { createRegistry, listEmblems, listKingdoms, getHero, getKingdom } from './game/ecs/registry.js';
import { loadAllModules } from './game/modules/moduleLoader.js';
import { createAssetLoader } from './game/modules/assetLoader.js';
import { sanitiseFlagConfig, paintFlagToCanvas, DEFAULT_FLAG_CONFIG } from './game/render/flagMesh.js';

const STORAGE_KEY = 'crossOverWarProfiles';
const ACTIVE_PROFILE_KEY = 'crossOverWarActiveProfile';

let cachedRegistry = null;

export function getLobbyRegistry() {
  if (cachedRegistry) return cachedRegistry;
  const registry = createRegistry();
  // Modules' register() needs a world even when their own setup doesn't use
  // it; pass a throwaway. The asset loader is also unused at lobby time but
  // every module receives it through context.
  loadAllModules({
    world: createWorld(),
    registry,
    assets: createAssetLoader(),
  });
  cachedRegistry = registry;
  return registry;
}

export function lobbyEmblems() {
  return listEmblems(getLobbyRegistry());
}

export function lobbyKingdoms() {
  return listKingdoms(getLobbyRegistry());
}

// Return the resolved hero archetypes for a kingdom, in the kingdom's declared
// order. Unknown / null kingdomId returns an empty list — callers fall back
// to "Random" semantics there.
export function lobbyHeroesForKingdom(kingdomId) {
  if (!kingdomId) return [];
  const registry = getLobbyRegistry();
  const kingdom = getKingdom(registry, kingdomId);
  if (!kingdom || !kingdom.heroIds) return [];
  const out = [];
  for (const heroId of kingdom.heroIds) {
    const hero = getHero(registry, heroId);
    if (hero) out.push(hero);
  }
  return out;
}

export function paintPreview(canvas, flagConfig) {
  paintFlagToCanvas(canvas, flagConfig, getLobbyRegistry());
}

// ── Profile storage ────────────────────────────────────────────────────────
//
// Storage shape: `{ [commanderName]: { flag, kingdomId, heroId } }`. The
// commander name and the profile key are the same string — that's the whole
// point of the name/profile unification. Picking a profile from the
// dropdown sets the player's name, flag, kingdom, and hero together;
// clicking Save writes all four under the current name.
//
// Legacy shapes migrate transparently on read:
//   1. `{ [key]: { name, flag } }`        (pre-unification)             → use inner name as key
//   2. `{ [name]: FlagConfig }`           (post-unification, pre-kingdom) → wrap, kingdomId/heroId: null
//   3. `{ [name]: { flag, kingdomId } }`  (pre-hero-picker)             → heroId: null

export function loadAllProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && 'flag' in value && !('colours' in value)) {
        // Pre-unification or current-shape entry. The 'colours' check is how
        // we tell apart "the value is a flag config" (current) from "the
        // value is a wrapper { flag, kingdomId, heroId }" (new).
        const name = String(value.name ?? key).trim().slice(0, 16) || key;
        out[name] = {
          flag: sanitiseFlagConfig(value.flag),
          kingdomId: value.kingdomId ?? null,
          heroId: value.heroId ?? null,
        };
      } else {
        // Bare flag config under the name key — wrap it.
        out[key] = {
          flag: sanitiseFlagConfig(value),
          kingdomId: null,
          heroId: null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveProfile(name, flagConfig, kingdomId = null, heroId = null) {
  const trimmed = String(name ?? '').trim().slice(0, 16);
  if (!trimmed) return;
  const profiles = loadAllProfiles();
  profiles[trimmed] = {
    flag: sanitiseFlagConfig(flagConfig),
    kingdomId: kingdomId ?? null,
    heroId: heroId ?? null,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); } catch {}
}

export function deleteProfile(name) {
  const profiles = loadAllProfiles();
  if (!(name in profiles)) return;
  delete profiles[name];
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); } catch {}
}

export function loadActiveProfileName() {
  try { return localStorage.getItem(ACTIVE_PROFILE_KEY) || null; } catch { return null; }
}

export function saveActiveProfileName(name) {
  try { localStorage.setItem(ACTIVE_PROFILE_KEY, name ?? ''); } catch {}
}

export function defaultLobbyProfile() {
  return {
    name: 'Commander',
    flag: { ...DEFAULT_FLAG_CONFIG, colours: [...DEFAULT_FLAG_CONFIG.colours] },
    kingdomId: null,  // null = host picks at game start
    heroId: null,     // null = host picks from the resolved kingdom's pool
  };
}

export { sanitiseFlagConfig };
