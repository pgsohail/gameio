/** Real-time multiplayer: WebSocket game-state relay between clients. */

let roomId = null;
let socket = null;
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

export function isMultiplayerActive() {
  return !!roomId;
}

export function isApplyingRemote() {
  return applyingRemote;
}

export function attachMultiplayer(ws, id) {
  socket = ws;
  roomId = id;
}

export function detachMultiplayer() {
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

export function queueStateBroadcast() {
  if (applyingRemote || !exportStateFn || !roomId || !socket || socket.readyState !== WebSocket.OPEN) return;
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !exportStateFn) return;
    socket.send(JSON.stringify({
      type: 'game_state',
      roomId,
      state: exportStateFn(),
      seq: Date.now(),
    }));
  }, 60);
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
