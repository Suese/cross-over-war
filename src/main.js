// Lobby + waiting-room bootstrap for Crossover War.
// Host/Join PeerJS pattern: the room code is the host's peer id, shared via URL.

import { HostNet, ClientNet } from './net.js';

const PLAYER_COLORS = ['#c81428', '#1a4a8a', '#1a8a50', '#d4a834', '#6a3aa8', '#c46a14'];

let mode = null;       // 'host' | 'client'
let host = null;       // HostNet
let client = null;     // ClientNet
let myId = null;       // our peer id (host id if mode==='host')
let myName = 'Commander';
let roomCode = null;   // host's peer id (for clients) or own id (for host)

// Authoritative lobby state — only the host mutates this; clients receive
// snapshots over the wire. Game logic lives elsewhere (added later).
let lobby = {
  players: [],   // [{ id, name }]
  started: false,
};

// ── Elements ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Saved name ──────────────────────────────────────────────────────────────
{
  try {
    const saved = localStorage.getItem('crossOverWarName');
    if (saved) $('name-input').value = saved;
  } catch {}
}

// ── URL ?room= picks the lobby mode ─────────────────────────────────────────
// Arrived via a join link → show only the Join section.
// Fresh visit → show only the Host section (with a hidden code-paste fallback
// surfaced via a tiny "have a code?" toggle below the host button).
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
$('host-btn').addEventListener('click', startHost);
$('join-btn').addEventListener('click', startClient);
$('start-btn').addEventListener('click', () => {
  if (mode !== 'host') return;
  lobby.started = true;
  broadcastLobby();
  enterGame();
});
$('copy-code').addEventListener('click', () => {
  const url = roomUrl(roomCode);
  navigator.clipboard?.writeText(url);
  const btn = $('copy-code');
  const prev = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = prev; }, 1500);
});
$('btn-leave')?.addEventListener('click', () => location.reload());

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
  lobby.players = [{ id: myId, name: myName }];

  host.on('connect', (peerId) => {
    // Send current lobby snapshot to the newly-connected client; they will
    // register themselves with a 'join' action that includes their name.
    host.sendTo(peerId, { type: 'lobby', lobby });
  });
  host.on('disconnect', (peerId) => {
    lobby.players = lobby.players.filter(p => p.id !== peerId);
    broadcastLobby();
    renderWaiting();
  });
  host.on('action', (fromId, data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'join') {
      const name = String(data.name || 'Player').slice(0, 16);
      if (!lobby.players.some(p => p.id === fromId)) {
        lobby.players.push({ id: fromId, name });
        broadcastLobby();
        renderWaiting();
      }
    }
    // Future: forward game actions to the game module.
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
      if (lobby.started) enterGame();
      else renderWaiting();
    }
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
  lobby.players.forEach((p, i) => {
    const li = document.createElement('li');
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    const tag = p.id === roomCode && mode === 'host' ? ' · Host'
              : (mode === 'client' && i === 0 ? ' · Host' : '');
    const you = p.id === myId ? ' (you)' : '';
    li.innerHTML = `<span class="player-dot" style="background:${color}"></span>
                    <strong>${escapeHtml(p.name)}</strong>${you}
                    <span class="meta">${tag}</span>`;
    list.appendChild(li);
  });
  $('host-controls').style.display = mode === 'host' ? '' : 'none';
  $('start-btn').disabled = lobby.players.length < 2;
  $('waiting-tag').textContent = mode === 'host'
    ? (lobby.players.length < 2 ? 'Need at least 2 players to start.' : 'Start when everyone is in.')
    : 'Waiting for the host to start the game…';
}

function broadcastLobby() {
  if (mode !== 'host' || !host) return;
  host.broadcast({ type: 'lobby', lobby });
}

function enterGame() {
  show('game-ui');
  // Placeholder banner — actual gameplay will land in a follow-up module.
  $('turn-banner').textContent = 'Game started — implementation pending.';
  const sb = $('scoreboard');
  sb.innerHTML = '';
  lobby.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'score-card';
    div.innerHTML = `<span class="player-dot" style="background:${PLAYER_COLORS[i % PLAYER_COLORS.length]}"></span>
                     <strong>${escapeHtml(p.name)}</strong>${p.id === myId ? ' (you)' : ''}`;
    sb.appendChild(div);
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
  // Strip hash and any other query params we didn't set.
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
