// Lobby + waiting-room bootstrap for Crossover War.
// Host/Join PeerJS pattern: the room code is the host's peer id, shared via URL.

import { HostNet, ClientNet } from './net.js';
import { startGameSession } from './game/bootstrap.js';
import { listSaves, loadSave, deleteSave } from './game/persistence.js';
import { MESSAGE_KINDS } from './game/protocol.js';

const PLAYER_COLORS = ['#c81428', '#1a4a8a', '#1a8a50', '#d4a834', '#6a3aa8', '#c46a14'];

let mode = null;       // 'host' | 'client'
let host = null;       // HostNet
let client = null;     // ClientNet
let myId = null;
let myName = 'Commander';
let roomCode = null;

let lobby = {
  players: [],
  started: false,
};
let gameSession = null;
let pendingSaveSnapshot = null;   // set when the host picks a save before clicking Start

const $ = (id) => document.getElementById(id);

// ── Saved name ──────────────────────────────────────────────────────────────
{
  try {
    const saved = localStorage.getItem('crossOverWarName');
    if (saved) $('name-input').value = saved;
  } catch {}
}

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
$('copy-code').addEventListener('click', () => {
  const url = roomUrl(roomCode);
  navigator.clipboard?.writeText(url);
  const btn = $('copy-code');
  const prev = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = prev; }, 1500);
});

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
  persistName(myName);
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
    }));
    // Add the host themselves if not in the save (they'd usually be — match
    // by name, swap id; otherwise prepend).
    const myMatch = lobby.players.find(p => p.name === myName && !p.connected);
    if (myMatch) {
      myMatch.id = myId;
      myMatch.connected = true;
    } else {
      lobby.players.unshift({ id: myId, name: myName, connected: true });
    }
  } else {
    lobby.players = [{ id: myId, name: myName, connected: true }];
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
      // Returning player? Match by name + disconnected slot; rebind id.
      const reusable = lobby.players.find(p => !p.connected && p.name === name);
      if (reusable) {
        reusable.id = fromId;
        reusable.connected = true;
      } else if (!lobby.players.some(p => p.id === fromId)) {
        lobby.players.push({ id: fromId, name, connected: true });
      }
      broadcastLobby();
      renderWaiting();
      // If the game is already running, hand the client an init snapshot.
      gameSession?.announceClientConnected?.(fromId, name);
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
  persistName(myName);
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
  client.send({ type: 'join', name: myName });
  roomCode = code;
  mode = 'client';
  enterWaiting();
}

// ── Lobby + waiting UI ──────────────────────────────────────────────────────
function enterWaiting() {
  show('waiting');
  renderWaiting();
}

function renderWaiting() {
  $('room-code').textContent = roomUrl(roomCode);
  const list = $('player-list');
  list.innerHTML = '';
  lobby.players.forEach((player, index) => {
    const li = document.createElement('li');
    if (player.connected === false) li.classList.add('disconnected');
    const color = PLAYER_COLORS[index % PLAYER_COLORS.length];
    const tag = player.id === roomCode && mode === 'host' ? ' · Host'
              : (mode === 'client' && index === 0 ? ' · Host' : '');
    const you = player.id === myId ? ' (you)' : '';
    li.innerHTML = `<span class="player-dot" style="background:${color}"></span>
                    <strong>${escapeHtml(player.name)}</strong>${you}
                    <span class="meta">${tag}</span>`;
    list.appendChild(li);
  });
  $('host-controls').style.display = mode === 'host' ? '' : 'none';
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
  const players = lobby.players.map(p => ({ playerId: p.id, name: p.name }));
  gameSession = startGameSession({
    mode: 'host',
    canvas,
    hudRoot,
    myPlayerId: myId,
    players,
    loadFromSnapshot: pendingSaveSnapshot,
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
  const players = lobby.players.map(p => ({ playerId: p.id, name: p.name }));
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
function persistName(n) { try { localStorage.setItem('crossOverWarName', n); } catch {} }

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
