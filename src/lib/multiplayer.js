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

export function enableMultiplayer(ws, id) {
  spectatorMode = false;
  mpGame = true;
  socket = ws;
  roomId = id;
}

export function enableSpectator(ws, id) {
  spectatorMode = true;
  mpGame = true;
  socket = ws;
  roomId = id;
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
}

export function applyGameState(state) {
  if (importStateFn) importStateFn(state);
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
  const seq = Date.now();
  socket.send(JSON.stringify({
    type: 'game_log',
    roomId,
    html,
    color: color || '#fff',
    meta,
    seq,
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
  if (importStateFn) {
    applyingRemote = true;
    try {
      importStateFn(msg.state);
    } finally {
      applyingRemote = false;
    }
  }
  return true;
}

export function broadcastStateNow() {
  if (spectatorMode || applyingRemote || !mpGame || !exportStateFn || !roomId || !socket
    || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'game_state',
    roomId,
    state: exportStateFn(),
    seq: Date.now(),
  }));
}

export function queueStateBroadcast() {
  if (spectatorMode || applyingRemote || !mpGame || !exportStateFn || !roomId || !socket
    || socket.readyState !== WebSocket.OPEN) return;
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(broadcastStateNow, 40);
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
