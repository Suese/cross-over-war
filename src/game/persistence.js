// localStorage-backed save slots for the host.
//
// Keys:
//   crossOverWar:saves               — JSON array of save metadata (newest first)
//   crossOverWar:save:<saveId>       — JSON blob of the full snapshot + meta
//
// Each save metadata entry: { id, label, savedAt, turnNumber, players: [{name}] }.

const SAVES_INDEX_KEY = 'crossOverWar:saves';
const SAVE_PREFIX = 'crossOverWar:save:';
const MAX_SAVE_SLOTS = 20;

function safeGetJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeSetJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('persistence: localStorage write failed', err);
    return false;
  }
}

export function listSaves() {
  const list = safeGetJson(SAVES_INDEX_KEY, []);
  if (!Array.isArray(list)) return [];
  return list;
}

export function loadSave(saveId) {
  return safeGetJson(SAVE_PREFIX + saveId, null);
}

// Pull the corresponding save entry, or create a new metadata blob. Reuses
// the same id for the lifetime of a session so we keep updating one slot.
export function writeSave({ id, label, snapshot, players, turnNumber }) {
  const meta = {
    id,
    label: label ?? autoLabel(players, turnNumber),
    savedAt: Date.now(),
    turnNumber: turnNumber ?? 1,
    players: (players ?? []).map(p => ({ name: p.name })),
  };
  const payloadOk = safeSetJson(SAVE_PREFIX + id, { meta, snapshot });
  if (!payloadOk) return false;

  const index = listSaves().filter(entry => entry.id !== id);
  index.unshift(meta);
  while (index.length > MAX_SAVE_SLOTS) {
    const removed = index.pop();
    try { localStorage.removeItem(SAVE_PREFIX + removed.id); } catch {}
  }
  safeSetJson(SAVES_INDEX_KEY, index);
  return true;
}

export function deleteSave(saveId) {
  try { localStorage.removeItem(SAVE_PREFIX + saveId); } catch {}
  const index = listSaves().filter(entry => entry.id !== saveId);
  safeSetJson(SAVES_INDEX_KEY, index);
}

function autoLabel(players, turnNumber) {
  const names = (players ?? []).map(p => p.name).slice(0, 3).join(', ');
  return (names || 'Game') + ' · Day ' + (turnNumber ?? 1);
}

export function newSaveId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
