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

const STATE_BROADCAST_MS = 100;

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

export function enableMultiplayer(ws, id) {
  spectatorMode = false;
  mpGame = true;
  socket = ws;
  roomId = id;
  lastStateSig = '';
}

export function enableSpectator(ws, id) {
  spectatorMode = true;
  mpGame = true;
  socket = ws;
  roomId = id;
  lastStateSig = '';
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
  mpBroadcastPaused = 0;
  pendingRemoteState = null;
  if (importStateRaf) cancelAnimationFrame(importStateRaf);
  importStateRaf = 0;
}

export function applyGameState(state) {
  if (importStateFn) importStateFn(state);
}

function stateSignature(state) {
  if (!state) return '';
  const p = state.players?.map(x => `${x.cash}:${x.pos}:${x.dead ? 1 : 0}`).join('|') || '';
  return `${state.turn}:${state.phase}:${state.over ? 1 : 0}:${p}:${state.tradeSeq || 0}`;
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
}

export function broadcastDiceRoll(d1, d2, rollerName, rollerUserId, startAt) {
  if (!mpGame || !roomId || !socket || socket.readyState !== WebSocket.OPEN) return;
  const seq = Date.now();
  lastDiceSeq = seq;
  socket.send(JSON.stringify({
    type: 'dice_roll',
    roomId,
    d1,
    d2,
    rollerName,
    rollerUserId,
    startAt: startAt || Date.now() + 100,
    seq,
  }));
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
  if (msg.type !== 'dice_roll') return false;
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
  if (msg.type !== 'game_state' || !msg.state) return false;
  if (msg.from && msg.from === myUserId) return true;
  if (msg.seq && msg.seq <= lastRemoteSeq) return true;
  if (msg.seq) lastRemoteSeq = msg.seq;
  pendingRemoteState = msg.state;
  if (!importStateRaf) {
    importStateRaf = requestAnimationFrame(flushRemoteState);
  }
  return true;
}

export function broadcastStateNow() {
  if (spectatorMode || applyingRemote || mpBroadcastPaused > 0 || !mpGame || !exportStateFn || !roomId || !socket
    || socket.readyState !== WebSocket.OPEN) return;
  const state = exportStateFn();
  const sig = stateSignature(state);
  if (sig === lastStateSig) return;
  lastStateSig = sig;
  socket.send(JSON.stringify({
    type: 'game_state',
    roomId,
    state,
    seq: Date.now(),
  }));
}

export function queueStateBroadcast() {
  if (spectatorMode || applyingRemote || mpBroadcastPaused > 0 || !mpGame || !exportStateFn || !roomId || !socket
    || socket.readyState !== WebSocket.OPEN) return;
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(broadcastStateNow, STATE_BROADCAST_MS);
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
