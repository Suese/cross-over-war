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
import { createRegistry, listEmblems, listKingdoms } from './game/ecs/registry.js';
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

export function paintPreview(canvas, flagConfig) {
  paintFlagToCanvas(canvas, flagConfig, getLobbyRegistry());
}

// ── Profile storage ────────────────────────────────────────────────────────
//
// Storage shape: `{ [commanderName]: { flag, kingdomId } }`. The commander
// name and the profile key are the same string — that's the whole point of
// the name/profile unification. Picking a profile from the dropdown sets
// the player's name, flag, and kingdom together; clicking Save writes the
// current flag + kingdom under the current name.
//
// Two legacy shapes migrate transparently on read:
//   1. `{ [key]: { name, flag } }`  (pre-unification)        → use inner name as key
//   2. `{ [name]: FlagConfig }`     (post-unification, pre-kingdom) → wrap, kingdomId: null

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
        // value is a wrapper { flag, kingdomId }" (new).
        const name = String(value.name ?? key).trim().slice(0, 16) || key;
        out[name] = {
          flag: sanitiseFlagConfig(value.flag),
          kingdomId: value.kingdomId ?? null,
        };
      } else {
        // Bare flag config under the name key — wrap it.
        out[key] = {
          flag: sanitiseFlagConfig(value),
          kingdomId: null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveProfile(name, flagConfig, kingdomId = null) {
  const trimmed = String(name ?? '').trim().slice(0, 16);
  if (!trimmed) return;
  const profiles = loadAllProfiles();
  profiles[trimmed] = {
    flag: sanitiseFlagConfig(flagConfig),
    kingdomId: kingdomId ?? null,
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
  };
}

export { sanitiseFlagConfig };
