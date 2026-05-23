// Lobby + waiting-room bootstrap for Crossover War.
// Host/Join PeerJS pattern: the room code is the host's peer id, shared via URL.

import { HostNet, ClientNet } from './net.js';
import { startGameSession } from './game/bootstrap.js';
import { listSaves, loadSave, deleteSave } from './game/persistence.js';
import { MESSAGE_KINDS } from './game/protocol.js';
import {
  loadAllProfiles, saveProfile, deleteProfile,
  loadActiveProfileName, saveActiveProfileName,
  defaultLobbyProfile, paintPreview, lobbyEmblems, lobbyKingdoms,
  sanitiseFlagConfig,
} from './lobbyProfiles.js';
import { defaultFlagConfigFor } from './game/render/playerColors.js';

let mode = null;       // 'host' | 'client'
let host = null;       // HostNet
let client = null;     // ClientNet
let myId = null;
let myName = 'Commander';
let roomCode = null;

// Local player's flag profile — updated live as the user fiddles with the
// editor, broadcast as part of `join` actions so the host (and through it,
// every other client) can render this player's flag mesh.
let myProfile = defaultLobbyProfile();

let lobby = {
  players: [],
  started: false,
};
let gameSession = null;
let pendingSaveSnapshot = null;   // set when the host picks a save before clicking Start

const $ = (id) => document.getElementById(id);

// Name is loaded from the active profile (or the editor's default) once the
// profile editor wires up below. We no longer keep a parallel
// `crossOverWarName` key — `crossOverWarActiveProfile` is the source of truth.

// ── URL ?room= picks the lobby mode ─────────────────────────────────────────
{
  const params = new URLSearchParams(window.location.search);
  const incomingRoom = params.get('room');
  if (incomingRoom) {
    $('join-code').value = incomingRoom;
    $('lobby-host').style.display = 'none';
    $('lobby-divider').style.display = 'none';
  } else {
    $('lobby-join').style.display = 'none';
    $('lobby-divider').style.display = 'none';
  }
}

// ── Lobby buttons ───────────────────────────────────────────────────────────
$('host-btn').addEventListener('click', () => { pendingSaveSnapshot = null; startHost(); });
$('host-load-btn').addEventListener('click', toggleSavedGamesList);
$('join-btn').addEventListener('click', startClient);
$('start-btn').addEventListener('click', () => {
  if (mode !== 'host') return;
  lobby.started = true;
  broadcastLobby();
  startHostSession();
});
$('add-cpu-btn').addEventListener('click', () => {
  if (mode !== 'host') return;
  addCpuPlayer();
});
$('copy-code').addEventListener('click', () => {
  const url = roomUrl(roomCode);
  navigator.clipboard?.writeText(url);
  const btn = $('copy-code');
  const prev = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = prev; }, 1500);
});

// ── Slider value bindings ───────────────────────────────────────────────
// Each range input mirrors its current value into the paired <output> tag
// so the user can see what they're picking without playing slider-by-feel.
function bindSliderOutput(inputId, outputId) {
  const input = $(inputId);
  const output = $(outputId);
  if (!input || !output) return;
  const sync = () => { output.value = input.value; };
  input.addEventListener('input', sync);
  sync();
}
bindSliderOutput('min-castles', 'min-castles-value');
bindSliderOutput('max-castles', 'max-castles-value');
bindSliderOutput('min-biomes',  'min-biomes-value');
bindSliderOutput('max-biomes',  'max-biomes-value');
installThresholdSlider();
installProfileEditor();

// ── Profile + flag editor ───────────────────────────────────────────────
// Editor lives in the main lobby panel; controls bind to `myProfile` and
// repaint a small live preview canvas whenever anything changes. Saved
// profiles persist to localStorage so a returning player picks up where
// they left off.
function installProfileEditor() {
  const previewCanvas = $('flag-preview-canvas');
  const summaryCanvas = $('profile-summary-preview');
  const stripeSelect = $('flag-stripe');
  const emblemSelect = $('flag-emblem');
  const emblemPositionSelect = $('flag-emblem-position');
  const emblemSizeInput = $('flag-emblem-size');
  const emblemSizeOutput = $('flag-emblem-size-value');
  const colourInputs = [$('flag-colour-1'), $('flag-colour-2'), $('flag-colour-3')];
  const emblemColour = $('flag-emblem-colour');
  const profileSelect = $('profile-select');
  if (!previewCanvas || !stripeSelect || !emblemSelect) return;

  // Populate emblem dropdown from the lobby registry (modules have already
  // registered their emblems via loadAllModules).
  for (const emblem of lobbyEmblems()) {
    const option = document.createElement('option');
    option.value = emblem.id;
    option.textContent = emblem.name;
    emblemSelect.appendChild(option);
  }

  // Load profiles + last-active name out of localStorage. The active name is
  // just the commander name the player was using last session — it's only a
  // selection hint, not a separate identity.
  let profiles = loadAllProfiles();
  const lastActive = loadActiveProfileName();
  if (lastActive && profiles[lastActive]) {
    myProfile = {
      name: lastActive,
      flag: sanitiseFlagConfig(profiles[lastActive].flag),
      kingdomId: profiles[lastActive].kingdomId ?? null,
    };
  }
  installKingdomPicker();
  installEditorTabs();
  refreshProfileDropdown();
  applyProfileToInputs();
  redrawPreview();

  // ── Editor → state ────────────────────────────────────────────────────
  function readEditorIntoProfile() {
    const sizePercent = Number(emblemSizeInput.value);
    myProfile = {
      name: $('name-input').value.trim().slice(0, 16) || 'Commander',
      flag: sanitiseFlagConfig({
        colours: colourInputs.map(input => input.value),
        stripe: stripeSelect.value,
        emblemId: emblemSelect.value,
        emblemColour: emblemColour.value,
        emblemSize: Number.isFinite(sizePercent) ? sizePercent / 100 : 0.6,
        emblemPosition: emblemPositionSelect.value,
      }),
      kingdomId: myProfile.kingdomId ?? null,
    };
    if (emblemSizeOutput) emblemSizeOutput.value = Math.round(myProfile.flag.emblemSize * 100) + '%';
  }

  function onEditorChanged() {
    readEditorIntoProfile();
    redrawPreview();
    // If the current name matches an already-saved profile, treat live edits
    // as auto-saves so the player doesn't lose tweaks on close. Typing a new
    // name (one that isn't saved yet) does NOT auto-create a profile — the
    // player has to click Save once to opt in.
    if (profiles[myProfile.name]) {
      saveProfile(myProfile.name, myProfile.flag, myProfile.kingdomId);
      saveActiveProfileName(myProfile.name);
      profiles = loadAllProfiles();
    }
    refreshProfileDropdown();
    broadcastProfileIfInLobby();
  }
  for (const input of [
    ...colourInputs,
    emblemColour, stripeSelect, emblemSelect,
    emblemPositionSelect, emblemSizeInput,
  ]) {
    input.addEventListener('input', onEditorChanged);
    input.addEventListener('change', onEditorChanged);
  }
  $('name-input').addEventListener('input', onEditorChanged);

  // ── State → editor ───────────────────────────────────────────────────
  function applyProfileToInputs() {
    $('name-input').value = myProfile.name;
    stripeSelect.value = myProfile.flag.stripe;
    emblemSelect.value = myProfile.flag.emblemId;
    emblemPositionSelect.value = myProfile.flag.emblemPosition ?? 'center';
    const sizePercent = Math.round((myProfile.flag.emblemSize ?? 0.6) * 100);
    emblemSizeInput.value = String(sizePercent);
    if (emblemSizeOutput) emblemSizeOutput.value = sizePercent + '%';
    for (let i = 0; i < colourInputs.length; i++) {
      colourInputs[i].value = hexToCss(myProfile.flag.colours[i]);
    }
    emblemColour.value = hexToCss(myProfile.flag.emblemColour);
    refreshKingdomPickerSelection();
  }

  function redrawPreview() {
    paintPreview(previewCanvas, myProfile.flag);
    if (summaryCanvas) paintPreview(summaryCanvas, myProfile.flag);
  }

  // ── Profile dropdown ─────────────────────────────────────────────────
  // The dropdown lists saved profile names (== commander names). The
  // selection mirrors `myProfile.name` when that name matches a stored
  // profile; otherwise nothing is selected (the player has either typed a
  // new name or edited an existing profile's name without saving yet).
  function refreshProfileDropdown() {
    profileSelect.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = Object.keys(profiles).length ? '— Unsaved —' : '— No saved profiles —';
    profileSelect.appendChild(blank);
    for (const key of Object.keys(profiles).sort()) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = key;
      profileSelect.appendChild(option);
    }
    const matches = !!profiles[myProfile.name];
    profileSelect.value = matches ? myProfile.name : '';
    $('profile-delete').disabled = !matches;
    // Save is always enabled when the name field has content — it creates
    // a new profile if the name isn't saved yet, or overwrites otherwise.
    $('profile-save').disabled = !($('name-input').value.trim());
  }

  profileSelect.addEventListener('change', () => {
    const selected = profileSelect.value;
    if (!selected) {
      // The "—" option just deselects — the editor keeps its current state.
      saveActiveProfileName(null);
      refreshProfileDropdown();
      return;
    }
    const entry = profiles[selected];
    if (!entry) return;
    myProfile = {
      name: selected,
      flag: sanitiseFlagConfig(entry.flag),
      kingdomId: entry.kingdomId ?? null,
    };
    saveActiveProfileName(selected);
    applyProfileToInputs();
    redrawPreview();
    refreshProfileDropdown();
    broadcastProfileIfInLobby();
  });

  $('profile-save').addEventListener('click', () => {
    readEditorIntoProfile();
    if (!myProfile.name) return;
    saveProfile(myProfile.name, myProfile.flag, myProfile.kingdomId);
    saveActiveProfileName(myProfile.name);
    profiles = loadAllProfiles();
    refreshProfileDropdown();
  });

  $('profile-delete').addEventListener('click', () => {
    if (!profiles[myProfile.name]) return;
    if (!window.confirm('Delete profile "' + myProfile.name + '"?')) return;
    deleteProfile(myProfile.name);
    saveActiveProfileName(null);
    profiles = loadAllProfiles();
    refreshProfileDropdown();
  });

  // ── Kingdom picker ───────────────────────────────────────────────────
  // Card-grid picker. "Random" is the first card and means the host picks a
  // kingdom for this player at game start. Clicking a card writes its
  // kingdom id (or null for Random) onto myProfile and auto-saves through
  // the same onEditorChanged path the rest of the editor uses.
  function installKingdomPicker() {
    const root = $('kingdom-picker');
    if (!root) return;
    root.innerHTML = '';
    const cards = [];
    function addCard(kingdom) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'kingdom-card';
      card.dataset.kingdomId = kingdom?.id ?? '';
      const isRandom = !kingdom;
      const accent = isRandom ? '#7d8aa1' : hexToCss(kingdom.accentColour ?? 0x888888);
      card.style.borderLeftColor = accent;
      const title = document.createElement('div');
      title.className = 'kingdom-card-title';
      title.textContent = isRandom ? 'Random' : kingdom.name;
      card.appendChild(title);
      const desc = document.createElement('div');
      desc.className = 'kingdom-card-desc';
      desc.textContent = isRandom
        ? "Let the host pick a kingdom for you at game start."
        : (kingdom.description ?? '');
      card.appendChild(desc);
      card.addEventListener('click', () => {
        myProfile.kingdomId = kingdom?.id ?? null;
        refreshKingdomPickerSelection();
        // Persist + broadcast through the normal editor change path so the
        // active profile (and connected clients) pick up the new kingdom.
        if (profiles[myProfile.name]) {
          saveProfile(myProfile.name, myProfile.flag, myProfile.kingdomId);
          profiles = loadAllProfiles();
          refreshProfileDropdown();
        }
        broadcastProfileIfInLobby();
      });
      root.appendChild(card);
      cards.push(card);
    }
    addCard(null);
    for (const kingdom of lobbyKingdoms()) addCard(kingdom);
    refreshKingdomPickerSelection();
  }

  function refreshKingdomPickerSelection() {
    const root = $('kingdom-picker');
    if (!root) return;
    const target = myProfile.kingdomId ?? '';
    for (const card of root.querySelectorAll('.kingdom-card')) {
      card.classList.toggle('selected', (card.dataset.kingdomId ?? '') === target);
    }
  }

  // ── Tab strip (Flag / Kingdom) ───────────────────────────────────────
  // Wires the .tab-btn header strip to show/hide the matching .tab-pane.
  // Pure UI affordance — nothing else in the editor cares which tab is
  // active.
  function installEditorTabs() {
    const editor = $('profile-editor');
    if (!editor) return;
    const tabs = editor.querySelectorAll('.tab-btn');
    const panes = editor.querySelectorAll('.tab-pane');
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        for (const t of tabs) t.classList.toggle('active', t === tab);
        for (const p of panes) p.classList.toggle('active', p.dataset.tab === target);
      });
    }
  }
}

function hexToCss(value) {
  const hex = (typeof value === 'number' ? value : 0xffffff) & 0xffffff;
  return '#' + hex.toString(16).padStart(6, '0');
}

// Broadcast the local player's profile whenever it changes after the lobby
// has been joined. The host stores it inside `lobby.players[i].profile`
// and re-broadcasts; clients pick it up from the next lobby/init message.
function broadcastProfileIfInLobby() {
  if (mode === 'host') {
    const slot = lobby.players.find(p => p.id === myId);
    if (slot) {
      slot.profile = myProfile;
      broadcastLobby();
      renderWaiting();
    }
  } else if (mode === 'client' && client) {
    client.send({ type: 'profile_update', profile: myProfile });
  }
}

// ── Threshold slider (two draggable handles, three regions) ─────────────
function installThresholdSlider() {
  const slider = $('threshold-slider');
  if (!slider) return;
  const handleSea = $('threshold-handle-sea');
  const handleMountain = $('threshold-handle-mountain');
  const regionSea = $('threshold-region-sea');
  const regionLand = $('threshold-region-land');
  const regionMountain = $('threshold-region-mountain');
  const output = $('threshold-value');

  function readState() {
    return {
      sea: clampUnit(Number(slider.dataset.sea)),
      mountain: clampUnit(Number(slider.dataset.mountain)),
    };
  }
  function writeState(state) {
    // Keep the handles ordered with a small gap so the land band always
    // has somewhere to live.
    const minGap = 0.05;
    let { sea, mountain } = state;
    sea = clampUnit(sea);
    mountain = clampUnit(mountain);
    if (mountain < sea + minGap) mountain = Math.min(1, sea + minGap);
    if (sea > mountain - minGap) sea = Math.max(0, mountain - minGap);
    slider.dataset.sea = String(sea);
    slider.dataset.mountain = String(mountain);
    render(sea, mountain);
  }
  function render(sea, mountain) {
    handleSea.style.left = (sea * 100) + '%';
    handleMountain.style.left = (mountain * 100) + '%';
    regionSea.style.width = (sea * 100) + '%';
    regionLand.style.left = (sea * 100) + '%';
    regionLand.style.width = ((mountain - sea) * 100) + '%';
    regionMountain.style.left = (mountain * 100) + '%';
    regionMountain.style.width = ((1 - mountain) * 100) + '%';
    if (output) output.value = Math.round(sea * 100) + '% · ' + Math.round(mountain * 100) + '%';
  }

  function startDrag(handle, event) {
    event.preventDefault();
    const which = handle.dataset.handle;
    function onMove(moveEvent) {
      const rect = slider.getBoundingClientRect();
      const t = clampUnit((moveEvent.clientX - rect.left) / rect.width);
      const current = readState();
      if (which === 'sea') writeState({ sea: t, mountain: current.mountain });
      else writeState({ sea: current.sea, mountain: t });
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  handleSea.addEventListener('pointerdown', (e) => startDrag(handleSea, e));
  handleMountain.addEventListener('pointerdown', (e) => startDrag(handleMountain, e));

  // First render reads the initial values from data-* attributes.
  const initial = readState();
  writeState(initial);
}

function clampUnit(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function readTerrainThresholds() {
  const slider = $('threshold-slider');
  const sea = clampUnit(Number(slider?.dataset.sea ?? 0.4));
  const mountain = clampUnit(Number(slider?.dataset.mountain ?? 0.725));
  return {
    seaThreshold: sea,
    mountainThreshold: Math.max(sea + 0.05, mountain),
  };
}

function toggleSavedGamesList() {
  const container = $('saved-games');
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    return;
  }
  renderSavedGamesList();
  container.classList.remove('hidden');
}

function renderSavedGamesList() {
  const container = $('saved-games');
  container.innerHTML = '';
  const saves = listSaves();
  if (saves.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No saved games yet.';
    container.appendChild(empty);
    return;
  }
  for (const meta of saves) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const date = new Date(meta.savedAt);
    const dateStr = date.toLocaleString();
    const playerNames = (meta.players ?? []).map(p => p.name).join(', ');
    row.innerHTML = `
      <div class="meta">
        <span class="label">${escapeHtml(meta.label ?? 'Game')}</span>
        <span class="sub">${dateStr} · ${escapeHtml(playerNames)} · Day ${meta.turnNumber ?? 1}</span>
      </div>
    `;
    row.addEventListener('click', () => beginHostFromSave(meta.id));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!window.confirm('Delete this saved game?')) return;
      deleteSave(meta.id);
      renderSavedGamesList();
    });
    row.appendChild(deleteBtn);
    container.appendChild(row);
  }
}

async function beginHostFromSave(saveId) {
  const saved = loadSave(saveId);
  if (!saved) {
    setStatus('Could not read that save.');
    return;
  }
  pendingSaveSnapshot = saved.snapshot;
  setStatus('Resuming "' + (saved.meta?.label ?? 'game') + '"…');
  await startHost();
}

// ── Net bootstrap ───────────────────────────────────────────────────────────
async function startHost() {
  myName = readName();
  setStatus('Connecting to peer network…');
  host = new HostNet();
  try {
    myId = await host.start();
  } catch (err) {
    setStatus('Could not connect to PeerJS: ' + msg(err));
    return;
  }
  roomCode = myId;

  if (pendingSaveSnapshot) {
    // Seed lobby with the snapshot's player roster — disconnected by default
    // until peers reconnect by name.
    lobby.players = (pendingSaveSnapshot.players ?? []).map(p => ({
      id: p.playerId,
      name: p.name,
      connected: false,
      profile: p.profile ?? null,
    }));
    // Add the host themselves if not in the save (they'd usually be — match
    // by name, swap id; otherwise prepend).
    const myMatch = lobby.players.find(p => p.name === myName && !p.connected);
    if (myMatch) {
      myMatch.id = myId;
      myMatch.connected = true;
      myMatch.profile = myProfile;
    } else {
      lobby.players.unshift({ id: myId, name: myName, connected: true, profile: myProfile });
    }
  } else {
    lobby.players = [{ id: myId, name: myName, connected: true, profile: myProfile }];
  }

  host.on('connect', (peerId) => {
    host.sendTo(peerId, { type: 'lobby', lobby });
    // If the game is already running, tell bootstrap to register this peer
    // and ship them an init snapshot. We only know the name once they send
    // their 'join' action, so init_snapshot follows that.
  });
  host.on('disconnect', (peerId) => {
    const slot = lobby.players.find(p => p.id === peerId);
    if (slot) slot.connected = false;
    broadcastLobby();
    renderWaiting();
    gameSession?.announceClientDisconnected?.(peerId);
  });
  host.on('action', (fromId, data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'join') {
      const name = String(data.name || 'Player').slice(0, 16);
      const profile = data.profile ?? null;
      // Returning player? Match by name + disconnected slot; rebind id.
      const reusable = lobby.players.find(p => !p.connected && p.name === name);
      if (reusable) {
        reusable.id = fromId;
        reusable.connected = true;
        if (profile) reusable.profile = profile;
      } else if (!lobby.players.some(p => p.id === fromId)) {
        lobby.players.push({ id: fromId, name, connected: true, profile });
      }
      broadcastLobby();
      renderWaiting();
      // If the game is already running, hand the client an init snapshot.
      gameSession?.announceClientConnected?.(fromId, name, profile);
      return;
    }
    if (data.type === 'profile_update') {
      const slot = lobby.players.find(p => p.id === fromId);
      if (slot) {
        slot.profile = data.profile ?? slot.profile;
        broadcastLobby();
        renderWaiting();
        gameSession?.updatePlayerProfile?.(fromId, slot.profile);
      }
      return;
    }
    if (data.type === 'action') {
      gameSession?.handleClientAction?.(fromId, data.action);
    }
  });

  mode = 'host';
  enterWaiting();
}

async function startClient() {
  const code = extractRoomCode($('join-code').value);
  if (!code) { setStatus('Enter a room link or code first.'); return; }
  myName = readName();
  setStatus('Joining…');
  client = new ClientNet();
  try {
    myId = await client.start();
  } catch (err) {
    setStatus('Could not init peer: ' + msg(err));
    return;
  }
  client.on('message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'lobby') {
      lobby = data.lobby;
      if (lobby.started && !gameSession) startClientSession();
      else renderWaiting();
      return;
    }
    // Anything else is wire-protocol traffic for an active game.
    if (!gameSession) startClientSession();
    gameSession.ingestMessage(data);
  });
  client.on('close', () => setStatus('Disconnected from host.'));
  client.on('error', (err) => setStatus('Net: ' + msg(err)));

  try {
    await client.connect(code);
  } catch (err) {
    setStatus('Failed to connect: ' + msg(err));
    return;
  }
  client.send({ type: 'join', name: myName, profile: myProfile });
  roomCode = code;
  mode = 'client';
  enterWaiting();
}

// ── Lobby + waiting UI ──────────────────────────────────────────────────────
function enterWaiting() {
  show('waiting');
  renderWaiting();
}

// ── CPU player slots ───────────────────────────────────────────────────────
// CPU players live in the same `lobby.players` array as human players, with
// `isComputer: true` plus a generated id. The host owns their config (name,
// kingdom, flag) and authors all their actions during play. CPU profile
// flags default to a palette-derived flag keyed off the synthetic id so
// they read as a distinct team on the map.

function makeCpuId() {
  return 'cpu-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function addCpuPlayer() {
  const existingCpuCount = lobby.players.filter(p => p.isComputer).length;
  const id = makeCpuId();
  const name = 'CPU ' + (existingCpuCount + 1);
  const profile = {
    name,
    flag: sanitiseFlagConfig(defaultFlagConfigFor(id)),
    kingdomId: null,
  };
  lobby.players.push({
    id, name, profile,
    isComputer: true,
    connected: true,
  });
  broadcastLobby();
  renderWaiting();
}

function removeCpuPlayer(playerId) {
  const idx = lobby.players.findIndex(p => p.id === playerId && p.isComputer);
  if (idx < 0) return;
  lobby.players.splice(idx, 1);
  broadcastLobby();
  renderWaiting();
}

function updateCpuPlayer(playerId, updates) {
  const slot = lobby.players.find(p => p.id === playerId && p.isComputer);
  if (!slot) return;
  if (typeof updates.name === 'string') {
    slot.name = updates.name.trim().slice(0, 16) || slot.name;
    slot.profile = { ...slot.profile, name: slot.name };
  }
  if ('kingdomId' in updates) {
    slot.profile = { ...slot.profile, kingdomId: updates.kingdomId ?? null };
  }
  broadcastLobby();
  renderWaiting();
}

function renderWaiting() {
  $('room-code').textContent = roomUrl(roomCode);
  const list = $('player-list');
  list.innerHTML = '';
  lobby.players.forEach((player, index) => {
    const li = document.createElement('li');
    if (player.connected === false) li.classList.add('disconnected');
    if (player.isComputer) li.classList.add('computer');
    const tag = player.isComputer ? ' · CPU'
      : (player.id === roomCode && mode === 'host' ? ' · Host'
        : (mode === 'client' && index === 0 ? ' · Host' : ''));
    const you = player.id === myId ? ' (you)' : '';
    li.innerHTML = `<canvas class="player-flag-icon" width="60" height="38"></canvas>
                    <strong class="player-name">${escapeHtml(player.name)}</strong>${you}
                    <span class="meta">${tag}</span>`;
    const iconCanvas = li.querySelector('canvas.player-flag-icon');
    const flag = sanitiseFlagConfig(player.profile?.flag ?? defaultFlagConfigFor(player.id));
    paintPreview(iconCanvas, flag);

    // Host gets inline controls for CPU slots — rename, kingdom select, remove.
    if (player.isComputer && mode === 'host') {
      const controls = document.createElement('div');
      controls.className = 'cpu-controls';
      // Name input
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.maxLength = 16;
      nameInput.value = player.name;
      nameInput.className = 'cpu-name-input';
      nameInput.addEventListener('change', () => updateCpuPlayer(player.id, { name: nameInput.value }));
      controls.appendChild(nameInput);
      // Kingdom select
      const kingdomSelect = document.createElement('select');
      kingdomSelect.className = 'cpu-kingdom-select';
      const randomOption = document.createElement('option');
      randomOption.value = '';
      randomOption.textContent = 'Random kingdom';
      kingdomSelect.appendChild(randomOption);
      for (const kingdom of lobbyKingdoms()) {
        const opt = document.createElement('option');
        opt.value = kingdom.id;
        opt.textContent = kingdom.name;
        kingdomSelect.appendChild(opt);
      }
      kingdomSelect.value = player.profile?.kingdomId ?? '';
      kingdomSelect.addEventListener('change', () => {
        updateCpuPlayer(player.id, { kingdomId: kingdomSelect.value || null });
      });
      controls.appendChild(kingdomSelect);
      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'small danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removeCpuPlayer(player.id));
      controls.appendChild(removeBtn);
      li.appendChild(controls);
    }

    list.appendChild(li);
  });
  // Only the host gets the CPU add button.
  const cpuControls = $('cpu-controls');
  if (cpuControls) cpuControls.style.display = mode === 'host' ? '' : 'none';
  $('host-controls').style.display = mode === 'host' ? '' : 'none';
  // Settings rows are only meaningful for fresh games — a saved game carries
  // its own map dimensions + biome layout, and resuming should ignore the
  // host's lobby slider state.
  const freshGame = mode === 'host' && !pendingSaveSnapshot;
  for (const id of ['map-size-row', 'min-castles-row', 'max-castles-row', 'min-biomes-row', 'max-biomes-row', 'threshold-row']) {
    const el = $(id);
    if (el) el.style.display = freshGame ? '' : 'none';
  }
  const connectedCount = lobby.players.filter(p => p.connected !== false).length;
  $('start-btn').disabled = connectedCount < 2 && !pendingSaveSnapshot;
  $('waiting-tag').textContent = mode === 'host'
    ? (pendingSaveSnapshot ? 'Resume the saved game whenever you\'re ready.'
        : (connectedCount < 2 ? 'Need at least 2 players to start.' : 'Start when everyone is in.'))
    : 'Waiting for the host to start the game…';
}

function broadcastLobby() {
  if (mode !== 'host' || !host) return;
  host.broadcast({ type: 'lobby', lobby });
}

function startHostSession() {
  show('game-ui');
  const canvas = $('board');
  const hudRoot = $('game-ui');
  const players = lobby.players.map(p => ({
    playerId: p.id,
    name: p.name,
    profile: p.profile ?? null,
    kingdomId: p.profile?.kingdomId ?? null,
    isComputer: !!p.isComputer,
  }));
  const mapSize = pendingSaveSnapshot ? null : readSelectedMapSize();
  const biomeSettings = pendingSaveSnapshot ? null : readBiomeSettings();
  const terrainThresholds = pendingSaveSnapshot ? null : readTerrainThresholds();
  gameSession = startGameSession({
    mode: 'host',
    canvas,
    hudRoot,
    myPlayerId: myId,
    players,
    loadFromSnapshot: pendingSaveSnapshot,
    mapSize,
    biomeSettings,
    terrainThresholds,
    net: {
      broadcast: (message) => host?.broadcast(message),
      sendTo: (peerId, message) => host?.sendTo(peerId, message),
      sendAction: () => {},
    },
    onLeave: () => location.reload(),
  });
  // For peers already in the room when the host clicks Start: send each an init snapshot.
  for (const player of lobby.players) {
    if (player.id === myId) continue;
    if (player.connected === false) continue;
    gameSession.announceClientConnected(player.id, player.name);
  }
}

function startClientSession() {
  show('game-ui');
  const canvas = $('board');
  const hudRoot = $('game-ui');
  const players = lobby.players.map(p => ({
    playerId: p.id,
    name: p.name,
    profile: p.profile ?? null,
    kingdomId: p.profile?.kingdomId ?? null,
    isComputer: !!p.isComputer,
  }));
  gameSession = startGameSession({
    mode: 'client',
    canvas,
    hudRoot,
    myPlayerId: myId,
    players,
    net: {
      broadcast: () => {},
      sendTo: () => {},
      sendAction: (action) => client?.send({ type: 'action', action }),
    },
    onLeave: () => location.reload(),
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function show(id) {
  ['lobby', 'waiting', 'game-ui'].forEach(x => {
    const el = $(x);
    if (!el) return;
    if (x === id) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });
}

function setStatus(text) { const el = $('lobby-status'); if (el) el.textContent = text; }

function readName() {
  return ($('name-input')?.value || '').trim().slice(0, 16) || 'Commander';
}

function roomUrl(code) {
  if (!code) return '';
  const u = new URL(window.location.href);
  u.searchParams.set('room', code);
  u.hash = '';
  return u.toString();
}

function extractRoomCode(input) {
  const s = (input || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const r = u.searchParams.get('room');
    if (r) return r;
  } catch {}
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function msg(e) { return e?.message || String(e); }

function readSelectedMapSize() {
  const select = $('map-size-select');
  const raw = Number(select?.value ?? 64);
  // Allow 64 / 128 / 256 only — anything else falls back to the safe default.
  const dimension = [64, 128, 256].includes(raw) ? raw : 64;
  return { width: dimension, height: dimension };
}

function readBiomeSettings() {
  // Read raw slider values; gameRoom does the final clamping (e.g. floor
  // min-castles at numPlayers so every player still gets a castle).
  const minCastles = clampInt($('min-castles')?.value, 1, 8, 2);
  const maxCastles = clampInt($('max-castles')?.value, 1, 8, 2);
  const minBiomes  = clampInt($('min-biomes')?.value,  0, 8, 0);
  const maxBiomes  = clampInt($('max-biomes')?.value,  0, 8, 2);
  return {
    minCastles: Math.min(minCastles, maxCastles),
    maxCastles: Math.max(minCastles, maxCastles),
    minAdditionalBiomes: Math.min(minBiomes, maxBiomes),
    maxAdditionalBiomes: Math.max(minBiomes, maxBiomes),
  };
}

function clampInt(value, low, high, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(low, Math.min(high, Math.round(n)));
}
