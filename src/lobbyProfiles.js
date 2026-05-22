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
import { createRegistry, listEmblems } from './game/ecs/registry.js';
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

export function paintPreview(canvas, flagConfig) {
  paintFlagToCanvas(canvas, flagConfig, getLobbyRegistry());
}

// ── Profile storage ────────────────────────────────────────────────────────

// Shape of a stored profile: { name: string, flag: FlagConfig }. The name
// inside the profile is the *commander* name (what the player wants other
// players to see), not the profile's storage key.

export function loadAllProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveProfile(profileKey, profile) {
  if (!profileKey) return;
  const profiles = loadAllProfiles();
  profiles[profileKey] = {
    name: String(profile?.name ?? 'Commander').slice(0, 16),
    flag: sanitiseFlagConfig(profile?.flag),
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); } catch {}
}

export function deleteProfile(profileKey) {
  const profiles = loadAllProfiles();
  if (!(profileKey in profiles)) return;
  delete profiles[profileKey];
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); } catch {}
}

export function loadActiveProfileKey() {
  try { return localStorage.getItem(ACTIVE_PROFILE_KEY) || null; } catch { return null; }
}

export function saveActiveProfileKey(profileKey) {
  try { localStorage.setItem(ACTIVE_PROFILE_KEY, profileKey ?? ''); } catch {}
}

export function defaultLobbyProfile() {
  return {
    name: 'Commander',
    flag: { ...DEFAULT_FLAG_CONFIG, colours: [...DEFAULT_FLAG_CONFIG.colours] },
  };
}

export { sanitiseFlagConfig };
