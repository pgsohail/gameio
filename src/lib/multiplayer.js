/** Real-time multiplayer: game mode flag + WebSocket state relay. */

let roomId = null;
let socket = null;
let mpGame = false;
let applyingRemote = false;
let broadcastTimer = null;
let lastRemoteSeq = 0;
let exportStateFn = null;
let importStateFn = null;

export function registerStateSync(exporter) {
  exportStateFn = exporter;
}

export function registerStateImporter(importer) {
  importStateFn = importer;
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

export function enableMultiplayer(ws, id) {
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
  roomId = null;
  socket = null;
  clearTimeout(broadcastTimer);
  broadcastTimer = null;
  lastRemoteSeq = 0;
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
  if (applyingRemote || !mpGame || !exportStateFn || !roomId || !socket
    || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'game_state',
    roomId,
    state: exportStateFn(),
    seq: Date.now(),
  }));
}

export function queueStateBroadcast() {
  if (applyingRemote || !mpGame || !exportStateFn || !roomId || !socket
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
