/** Real-time multiplayer: game mode flag + WebSocket state relay. */

let roomId = null;
let socket = null;
let mpGame = false;
let spectatorMode = false;
let applyingRemote = false;
let broadcastTimer = null;
let lastRemoteSeq = 0;
let exportStateFn = null;
let importStateFn = null;
let onDiceRollFn = null;
let onGameLogFn = null;
let onPlayerMoveFn = null;
let lastDiceSeq = 0;
let lastMoveSeq = 0;
let lastStateSig = '';
let mpBroadcastPaused = 0;
let pendingRemoteState = null;
let importStateRaf = 0;
/** Seq of the latest server-committed state this client has (base for our next write). */
let knownSeq = 0;
const pendingRolls = new Map();
let rollReqCounter = 0;

/** Coalesce bursts of local changes into one frame (~16ms) — no artificial lag. */
const STATE_BROADCAST_MS = 16;
const ROLL_TIMEOUT_MS = 4000;

let writeGate = null;
let localIntentUntil = 0;

/**
 * Only clients that actually did something may write the shared state. Without this,
 * every client re-sent its own (possibly stale) copy after animations, rolling others back.
 */
export function registerWriteGate(fn) {
  writeGate = fn;
}

/** A real local action (click, key, admin/bot timer) — allow writes for a short window. */
export function noteLocalIntent(ms = 2500) {
  localIntentUntil = Math.max(localIntentUntil, Date.now() + ms);
}

function mayWrite() {
  if (Date.now() < localIntentUntil) return true;
  return writeGate ? !!writeGate() : true;
}

if (typeof document !== 'undefined') {
  const onInput = e => {
    if (!mpGame || spectatorMode) return;
    const t = e.target;
    if (!t?.closest) return;
    if (e.type === 'keydown' && !['Enter', ' '].includes(e.key)) return;
    if (t.closest('button, [role="button"], a, input, select, label, .tile, .t, [data-tile], [onclick]')) {
      noteLocalIntent();
    }
  };
  document.addEventListener('pointerdown', onInput, true);
  document.addEventListener('keydown', onInput, true);
}

export function registerStateSync(exporter) {
  exportStateFn = exporter;
}

export function registerStateImporter(importer) {
  importStateFn = importer;
}

export function registerDiceRollHandler(handler) {
  onDiceRollFn = handler;
}

export function registerGameLogHandler(handler) {
  onGameLogFn = handler;
}

export function registerPlayerMoveHandler(handler) {
  onPlayerMoveFn = handler;
}

export function isMpGame() {
  return mpGame;
}

export function isMultiplayerActive() {
  return mpGame && !!roomId;
}

export function isApplyingRemote() {
  return applyingRemote;
}

export function isSpectator() {
  return spectatorMode;
}

export function setMpBroadcastPaused(paused) {
  if (paused) mpBroadcastPaused += 1;
  else mpBroadcastPaused = Math.max(0, mpBroadcastPaused - 1);
}

function resetSyncCursors() {
  lastStateSig = '';
  lastRemoteSeq = 0;
  knownSeq = 0;
  lastDiceSeq = 0;
}

export function enableMultiplayer(ws, id) {
  const sameRoom = roomId === id && mpGame && !spectatorMode;
  spectatorMode = false;
  mpGame = true;
  socket = ws;
  roomId = id;
  // On a reconnect to the same room keep cursors; the server resends a full resync.
  if (!sameRoom) resetSyncCursors();
  else lastStateSig = '';
}

export function enableSpectator(ws, id) {
  spectatorMode = true;
  mpGame = true;
  socket = ws;
  roomId = id;
  resetSyncCursors();
}

export function attachMultiplayer(ws, id) {
  socket = ws;
  roomId = id;
}

export function detachMultiplayer() {
  mpGame = false;
  spectatorMode = false;
  roomId = null;
  socket = null;
  clearTimeout(broadcastTimer);
  broadcastTimer = null;
  lastRemoteSeq = 0;
  lastDiceSeq = 0;
  lastMoveSeq = 0;
  lastStateSig = '';
  knownSeq = 0;
  for (const p of pendingRolls.values()) { clearTimeout(p.timer); p.resolve(null); }
  pendingRolls.clear();
  mpBroadcastPaused = 0;
  pendingRemoteState = null;
  if (importStateRaf) cancelAnimationFrame(importStateRaf);
  importStateRaf = 0;
}

export function applyGameState(state) {
  if (importStateFn) importStateFn(state);
}

/**
 * Full-content signature. The old one only looked at cash/pos/turn, so auction bids,
 * houses, mortgages, votes etc. were silently never sent.
 */
function stateSignature(state) {
  if (!state) return '';
  try { return JSON.stringify(state); } catch { return String(Date.now()); }
}

function flushRemoteState() {
  importStateRaf = 0;
  if (!pendingRemoteState || !importStateFn) {
    pendingRemoteState = null;
    return;
  }
  const state = pendingRemoteState;
  pendingRemoteState = null;
  applyingRemote = true;
  try {
    importStateFn(state);
  } finally {
    applyingRemote = false;
  }
  // What we just imported is already on the server — don't echo it back.
  try { if (exportStateFn) lastStateSig = stateSignature(exportStateFn()); } catch { /* ignore */ }
}

/**
 * Ask the server to roll. Resolves with {d1, d2} (also broadcast to everyone at the
 * same moment) or null if the server refused / timed out.
 */
export function requestServerRoll() {
  if (spectatorMode || !mpGame || !roomId || !socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve(null);
  }
  const reqId = `r${Date.now().toString(36)}${(++rollReqCounter).toString(36)}`;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingRolls.delete(reqId);
      resolve(null);
    }, ROLL_TIMEOUT_MS);
    pendingRolls.set(reqId, { resolve, timer });
    // Make sure the server has our latest state before it checks whose roll it is.
    flushPendingBroadcast();
    socket.send(JSON.stringify({ type: 'roll_request', roomId, reqId }));
  });
}

function flushPendingBroadcast() {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
    broadcastStateNow();
  }
}

export function broadcastGameLog(html, color, meta = {}) {
  if (spectatorMode || !mpGame || !roomId || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'game_log',
    roomId,
    html,
    color: color || '#fff',
    meta,
    seq: Date.now(),
  }));
}

export function broadcastPlayerMove(userId, steps, startAt) {
  if (spectatorMode || !mpGame || !roomId || !socket || socket.readyState !== WebSocket.OPEN) return;
  const seq = Date.now();
  lastMoveSeq = seq;
  socket.send(JSON.stringify({
    type: 'player_move',
    roomId,
    userId,
    steps,
    startAt: startAt || Date.now(),
    seq,
  }));
}

export function handleDiceRollMessage(msg) {
  if (msg.type === 'roll_denied') {
    const p = pendingRolls.get(msg.reqId);
    if (p) {
      clearTimeout(p.timer);
      pendingRolls.delete(msg.reqId);
      p.resolve(null);
    }
    return true;
  }
  if (msg.type !== 'dice_roll') return false;
  const own = msg.reqId && pendingRolls.get(msg.reqId);
  if (own) {
    clearTimeout(own.timer);
    pendingRolls.delete(msg.reqId);
    if (msg.seq) lastDiceSeq = Math.max(lastDiceSeq, +msg.seq);
    own.resolve({ d1: +msg.d1, d2: +msg.d2 });
    return true;
  }
  const seq = +(msg.seq || 0);
  if (seq && seq <= lastDiceSeq) return true;
  if (seq) lastDiceSeq = seq;
  onDiceRollFn?.(msg);
  return true;
}

export function handleGameLogMessage(msg) {
  if (msg.type === 'game_log_history' && Array.isArray(msg.entries)) {
    onGameLogFn?.({ type: 'history', entries: msg.entries });
    return true;
  }
  if (msg.type !== 'game_log' || !msg.entry) return false;
  onGameLogFn?.({ type: 'entry', entry: msg.entry });
  return true;
}

export function handlePlayerMoveMessage(msg) {
  if (msg.type !== 'player_move') return false;
  const seq = +(msg.seq || 0);
  if (seq && seq <= lastMoveSeq) return true;
  if (seq) lastMoveSeq = seq;
  onPlayerMoveFn?.(msg);
  return true;
}

export function handleSocketMessage(msg, myUserId) {
  if (msg.type === 'state_ack') {
    const seq = +msg.seq || 0;
    if (seq > knownSeq) knownSeq = seq;
    if (seq > lastRemoteSeq) lastRemoteSeq = seq;
    return true;
  }
  if (msg.type !== 'game_state' || !msg.state) return false;
  const seq = +msg.seq || 0;
  if (!msg.resync) {
    if (msg.from && msg.from === myUserId) return true;
    if (seq && seq <= lastRemoteSeq) return true;
  }
  if (seq > lastRemoteSeq || msg.resync) lastRemoteSeq = seq;
  knownSeq = seq;
  // Apply immediately (each WS message is its own task) so local writes are always
  // built on top of the newest committed state.
  pendingRemoteState = msg.state;
  if (importStateRaf) cancelAnimationFrame(importStateRaf);
  flushRemoteState();
  return true;
}

export function broadcastStateNow() {
  if (spectatorMode || applyingRemote || mpBroadcastPaused > 0 || !mpGame || !exportStateFn || !roomId || !socket
    || socket.readyState !== WebSocket.OPEN) return;
  if (!mayWrite()) return;
  const state = exportStateFn();
  const sig = stateSignature(state);
  if (sig === lastStateSig) return;
  lastStateSig = sig;
  socket.send(JSON.stringify({
    type: 'game_state',
    roomId,
    state,
    baseSeq: knownSeq,
  }));
}

export function queueStateBroadcast() {
  if (spectatorMode || applyingRemote || mpBroadcastPaused > 0 || !mpGame || !exportStateFn || !roomId || !socket
    || socket.readyState !== WebSocket.OPEN) return;
  if (broadcastTimer) return; // already scheduled for this frame
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastStateNow();
  }, STATE_BROADCAST_MS);
}

export function rebuildDeck(source, keys) {
  if (!Array.isArray(keys)) return source.slice();
  const out = [];
  const used = new Set();
  for (const x of keys) {
    const i = source.findIndex((c, idx) => c.x === x && !used.has(idx));
    if (i >= 0) {
      used.add(i);
      out.push(source[i]);
    }
  }
  return out.length ? out : source.slice();
}
