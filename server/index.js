import http from 'http';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes, randomInt } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  HUMANOID_CAP,
  pickHumanoidBudget,
  scheduleHumanoidJoins,
  processHumanoidQueue,
  maintainBotHostedRoom,
  onRealHumanJoined,
  onHumanoidKicked,
  clearBotHostedRoomId,
  countHumanoids,
  createHumanoidSlot,
  humanoidLobbyDeps,
} from './humanoidLobby.js';
import {
  validateIncomingState,
  noteCommittedState,
  mayRequestRoll,
} from './stateGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim() || null;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const REJOIN_GRACE_MS = 2 * 60 * 1000;
const MAX_ROOMS = 400;
const WS_PING_MS = 20_000;
const DATA_DIR = (process.env.DATA_DIR || '').trim() || null;

/** Strip markup from display names so they can't inject HTML anywhere. */
function cleanName(name, fallback = 'Player') {
  const n = String(name ?? '').replace(/[<>&"'`\\]/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 18);
  return n || fallback;
}

if (IS_PROD && JWT_SECRET === 'dev-secret-change-in-production') {
  console.error('FATAL: Set JWT_SECRET to a long random string in production.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '64kb' }));

const rateBuckets = new Map();
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
function rateLimit({ windowMs = 60_000, max = 60 }) {
  return (req, res, next) => {
    const key = `${clientIp(req)}:${req.baseUrl || req.path}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    return next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > 120_000) rateBuckets.delete(key);
  }
}, 120_000);

const rooms = new Map();
const roomSubs = new Map();
const lobbySubs = new Set();
let lobbyBroadcastTimer = null;
const profiles = new Map();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function profileForClient(p) {
  return {
    id: p.id,
    name: p.name,
    photo: p.photo,
    mode: p.mode,
    email: p.email,
    coins: p.coins,
    karma: p.karma,
    gamesPlayed: p.gamesPlayed,
    gamesWon: p.gamesWon,
    joinedAt: p.joinedAt,
    inventory: p.inventory,
  };
}

function upsertProfile(user) {
  let p = profiles.get(user.id);
  if (!p) {
    p = {
      id: user.id,
      name: user.name,
      photo: user.photo || null,
      mode: user.mode,
      email: user.email || null,
      coins: 0,
      karma: 0,
      gamesPlayed: 0,
      gamesWon: 0,
      joinedAt: Date.now(),
      inventory: [],
    };
    profiles.set(user.id, p);
  } else {
    p.name = user.name;
    if (user.photo) p.photo = user.photo;
    if (user.email) p.email = user.email;
  }
  return p;
}

function cleanEmoji(e) {
  if (typeof e !== 'string') return null;
  const v = e.replace(/[<>&"'`\\]/g, '').trim();
  return v && v.length <= 8 ? v : null;
}

function cleanColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null;
}

function secureRoomId() {
  for (let i = 0; i < 16; i++) {
    const id = randomBytes(4).toString('base64url').slice(0, 6).toLowerCase();
    if (!rooms.has(id)) return id;
  }
  return randomBytes(6).toString('hex').slice(0, 8);
}

function pruneRooms() {
  let changed = false;
  const now = Date.now();
  for (const [id, room] of rooms) {
    const occupied = room.slots.filter(Boolean).length;
    if (room.status === 'playing') {
      if (now - room.updatedAt > ROOM_TTL_MS * 2) {
        rooms.delete(id);
        roomSubs.delete(id);
        changed = true;
      }
      continue;
    }
    if (occupied === 0 || now - room.updatedAt > ROOM_TTL_MS) {
      clearBotHostedRoomId(id);
      rooms.delete(id);
      roomSubs.delete(id);
      changed = true;
    }
  }
  if (changed) scheduleLobbyBroadcast();
}

function occupiedCount(room) {
  return room.slots.filter(Boolean).length;
}

function publicRoomList() {
  pruneRooms();
  return [...rooms.values()]
    .filter(r => !r.private && r.status === 'lobby')
    .filter(r => occupiedCount(r) > 0 || r.humanoidHosted)
    .sort((a, b) => {
      const openA = a.slots.filter(s => !s).length;
      const openB = b.slots.filter(s => !s).length;
      if (openB !== openA) return openB - openA;
      if (a.humanoidHosted !== b.humanoidHosted) return a.humanoidHosted ? 1 : -1;
      return humanCount(b) - humanCount(a) || b.updatedAt - a.updatedAt;
    })
    .map(roomToClient);
}

function publicSpectateList() {
  pruneRooms();
  return [...rooms.values()]
    .filter(r => !r.private && r.status === 'playing')
    .filter(r => humanCount(r) > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 24)
    .map(room => {
      const alive = (room.gameState?.players || []).filter(p => !p.dead).length
        || (room.players || []).length;
      return {
        id: room.id,
        status: 'playing',
        rules: room.rules,
        humans: humanCount(room),
        alivePlayers: alive,
        maxPlayers: room.maxPlayers,
        updatedAt: room.updatedAt,
        players: (room.players || []).map(p => ({
          name: p.name,
          emoji: p.emoji,
          color: p.color,
          bot: !!p.bot,
        })),
      };
    });
}

function liveActivityStats() {
  pruneRooms();
  const playing = [...rooms.values()].filter(r => r.status === 'playing');
  let humansPlaying = 0;
  for (const room of playing) {
    for (const p of room.players || []) {
      if (p.bot) continue;
      const gp = room.gameState?.players?.find(x => x.userId === p.userId);
      if (gp?.dead) continue;
      humansPlaying += 1;
    }
  }
  const publicPlaying = playing.filter(r => !r.private).length;
  return {
    activeRooms: playing.length,
    humansPlaying,
    publicPlaying,
  };
}

const JOIN_COLORS = ['#FF1744', '#F50057', '#651FFF', '#3D5AFE', '#00E5FF', '#00E676', '#FFEA00', '#FF9100'];
const JOIN_EMOJIS = ['🚂', '✈️', '🚢', '🎩', '🚗', '🚀'];

function pickJoinColor(room, preferred) {
  const taken = room.slots.filter(Boolean).map(s => s.color);
  let color = cleanColor(preferred) || JOIN_COLORS[0];
  if (taken.includes(color)) {
    color = JOIN_COLORS.find(c => !taken.includes(c)) || color;
  }
  return color;
}

/** Public lobbies with at least one real human — never bot-hosted mastermind rooms. */
function findJoinableHumanPublicRoom(userId) {
  return [...rooms.values()]
    .filter(r => !r.private && r.status === 'lobby')
    .filter(r => !r.humanoidHosted)
    .filter(r => humanCount(r) > 0)
    .filter(r => !r.slots.some(s => s?.userId === userId))
    .filter(r => !r.kicked?.[userId])
    .filter(r => r.slots.some(s => !s))
    .sort((a, b) => {
      const ah = humanCount(a);
      const bh = humanCount(b);
      if (bh !== ah) return bh - ah;
      const ao = a.slots.filter(s => !s).length;
      const bo = b.slots.filter(s => !s).length;
      if (ao !== bo) return ao - bo;
      return b.updatedAt - a.updatedAt;
    })[0] || null;
}

function seatUserInRoom(room, user, { emoji, color } = {}) {
  if (room.kicked?.[user.id]) {
    return { ok: false, error: 'removed' };
  }
  if (room.slots.some(s => s?.userId === user.id)) {
    return { ok: true, already: true };
  }
  let idx = room.slots.findIndex(s => !s);
  if (idx < 0 && room.rules?.allowBots) {
    for (let i = room.slots.length - 1; i >= 0; i--) {
      if (room.slots[i]?.bot) { idx = i; break; }
    }
  }
  if (idx < 0) return { ok: false, error: 'Room full' };
  room.slots[idx] = {
    userId: user.id,
    name: cleanName(user.name),
    emoji: cleanEmoji(emoji) || JOIN_EMOJIS[idx % JOIN_EMOJIS.length],
    color: pickJoinColor(room, color),
    bot: false,
    isHost: false,
  };
  room.updatedAt = Date.now();
  onRealHumanJoined(room, hoidCtx());
  return { ok: true };
}

function createPublicRoom(user, { rules, maxPlayers, emoji, color } = {}) {
  const id = secureRoomId();
  const max = Math.min(6, Math.max(2, +(maxPlayers || 4)));
  const room = {
    id,
    private: false,
    status: 'lobby',
    hostId: user.id,
    adminSlot: 0,
    maxPlayers: max,
    slots: Array.from({ length: max }, () => null),
    rules: { ...rules, title: 'Buildup.io' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    humanoidBudget: pickHumanoidBudget(),
    humanoidQueue: [],
    lobbyChat: [],
  };
  room.slots[0] = {
    userId: user.id,
    name: cleanName(user.name),
    emoji: cleanEmoji(emoji) || '🚂',
    color: cleanColor(color) || '#3D5AFE',
    bot: false,
    isHost: true,
  };
  rooms.set(id, room);
  return room;
}

function wasRoomMember(room, userId) {
  if (!userId) return false;
  return room.slots?.some(s => s?.userId === userId)
    || room.players?.some(p => p.userId === userId);
}

function roomToClient(room, viewerId = null) {
  const base = {
    id: room.id,
    private: room.private,
    status: room.status,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    slots: room.slots,
    rules: room.rules,
    updatedAt: room.updatedAt,
    humans: humanCount(room),
    openSeats: room.slots.filter(s => !s).length,
    humanoidHosted: !!room.humanoidHosted,
  };
  if (room.status === 'playing') {
    base.players = room.players;
    base.adminId = room.adminId ?? 0;
    base.gameState = room.gameState || null;
    base.stateSeq = room.stateSeq || 0;
    if (viewerId) {
      const absent = room.absent?.[viewerId];
      if (absent) {
        base.rejoinUntil = absent.until;
        base.rejoinSecondsLeft = Math.max(0, Math.ceil((absent.until - Date.now()) / 1000));
      }
    }
  }
  if (viewerId) {
    const kicked = room.kicked?.[viewerId];
    if (kicked) base.kicked = kicked;
  }
  return base;
}

function markAbsent(room, userId) {
  if (!room || room.status !== 'playing' || !userId) return;
  if (room.kicked?.[userId]) return;
  if (!wasRoomMember(room, userId)) return;
  const gp = room.gameState?.players?.find(p => p.userId === userId);
  if (gp?.dead) return;
  room.absent = room.absent || {};
  const now = Date.now();
  room.absent[userId] = { since: room.absent[userId]?.since || now, until: now + REJOIN_GRACE_MS };
  room.updatedAt = now;
}

function clearAbsent(room, userId) {
  if (room?.absent?.[userId]) {
    delete room.absent[userId];
    room.updatedAt = Date.now();
  }
}

function syncRoomAdminFromState(room, state) {
  if (!room || !state?.players?.length) return;
  const idx = state.players.findIndex(p => p.isAdmin && !p.dead);
  const pick = idx >= 0 ? idx : state.players.findIndex(p => !p.dead);
  if (pick < 0) return;
  room.adminId = pick;
  const hp = state.players[pick];
  if (hp?.userId && !hp.bot) room.hostId = hp.userId;
}

function kickPlayerFromGame(room, userId, reason) {
  room.kicked = room.kicked || {};
  room.kicked[userId] = { reason, at: Date.now() };
  if (room.absent?.[userId]) delete room.absent[userId];
  if (room.gameState?.players) {
    const gp = room.gameState.players.find(p => p.userId === userId);
    if (gp) {
      gp.dead = true;
      if (gp.isAdmin) {
        room.gameState.players.forEach(p => { p.isAdmin = false; });
        const next = room.gameState.players.find(p => !p.dead && !p.bot)
          || room.gameState.players.find(p => !p.dead);
        if (next) next.isAdmin = true;
      }
    }
    syncRoomAdminFromState(room, room.gameState);
  }
  room.updatedAt = Date.now();
  if (!room.gameState) return;
  room.stateSeq = (room.stateSeq || 0) + 1;
  room.stateWriter = null;
  const payload = JSON.stringify({
    type: 'game_state',
    roomId: room.id,
    state: room.gameState,
    seq: room.stateSeq,
  });
  const subs = roomSubs.get(room.id);
  if (subs) {
    for (const ws of subs) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}

function processAbsentTimeouts() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status !== 'playing' || !room.absent) continue;
    for (const [uid, info] of Object.entries(room.absent)) {
      if (now >= info.until) {
        kickPlayerFromGame(room, uid, 'timeout');
        delete room.absent[uid];
      }
    }
  }
}

const BOT_EMOJIS = ['🤖', '🦾', '👾', '🎮', '⚡', '🔮'];
const BOT_COLORS = ['#FF1744', '#F50057', '#651FFF', '#3D5AFE', '#00E5FF', '#00E676', '#FFEA00', '#FF9100', '#76FF03', '#D500F9'];

function hoidCtx() {
  return humanoidLobbyDeps({
    pickJoinColor,
    joinColors: JOIN_COLORS,
    broadcastRoom,
    transferHost,
    secureRoomId,
    rooms,
    maxRooms: MAX_ROOMS,
  });
}

function mastermindFillTarget(room) {
  if (!room.rules?.allowBots) return 0;
  const diff = room.rules.diff || 'classic';
  const humans = humanCount(room);
  const maxFillers = Math.max(0, room.slots.length - humans);
  if (maxFillers <= 0) return 0;
  if (diff === 'relaxed') return Math.min(1, maxFillers);
  if (diff === 'shark') return maxFillers;
  return Math.min(2, maxFillers);
}

function clearPrivateAutoSeats(room) {
  if (!room.private) return;
  for (let i = 0; i < room.slots.length; i++) {
    if (room.slots[i]?.bot) room.slots[i] = null;
  }
  room.humanoidQueue = [];
}

function syncLobbyFillers(room) {
  if (room.status !== 'lobby') return;
  if (room.rules?.allowBots) {
    syncRoomBots(room);
    return;
  }
  if (room.private) clearPrivateAutoSeats(room);
  if (!room.private) {
    scheduleHumanoidJoins(room, humanCount(room), hoidCtx());
  }
}

function syncRoomBots(room) {
  if (!room.rules?.allowBots) return;
  const target = mastermindFillTarget(room);
  const deps = hoidCtx();
  const usedNames = new Set(room.slots.filter(Boolean).map(s => s.name));
  const humanoidIdx = [];

  for (let i = 0; i < room.slots.length; i++) {
    const s = room.slots[i];
    if (!s) continue;
    if (s.bot && !s.humanoid) room.slots[i] = null;
    else if (s.humanoid) humanoidIdx.push(i);
  }

  while (humanoidIdx.length > target) {
    const idx = humanoidIdx.pop();
    room.slots[idx] = null;
  }

  let have = humanoidIdx.length;
  for (let i = 0; i < room.slots.length && have < target; i++) {
    if (!room.slots[i]) {
      room.slots[i] = createHumanoidSlot(room, i, usedNames, deps);
      have += 1;
    }
  }
  room.humanoidQueue = [];
}

function kickLobbySlot(room, hostId, slotIndex) {
  if (room.status !== 'lobby') return { ok: false, error: 'Game already started' };
  if (room.hostId !== hostId) return { ok: false, error: 'Host only' };
  const idx = +slotIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx >= room.slots.length) {
    return { ok: false, error: 'Invalid seat' };
  }
  const slot = room.slots[idx];
  if (!slot) return { ok: false, error: 'Seat is empty' };
  if (!slot.bot && slot.userId === hostId) {
    return { ok: false, error: 'Cannot kick yourself' };
  }
  room.slots[idx] = null;
  onHumanoidKicked(room, slot);
  if (!slot.bot) {
    room.kicked = room.kicked || {};
    room.kicked[slot.userId] = { reason: 'admin', at: Date.now() };
  }
  room.updatedAt = Date.now();
  return { ok: true };
}

function transferHost(room) {
  room.slots.forEach(s => { if (s) s.isHost = false; });
  const nextIdx = room.slots.findIndex(s => s && !s.bot);
  if (nextIdx < 0) return false;
  room.hostId = room.slots[nextIdx].userId;
  room.slots[nextIdx].isHost = true;
  room.adminSlot = nextIdx;
  return true;
}

function humanCount(room) {
  return room.slots.filter(s => s && !s.bot).length;
}

function lobbyRoomsPayload() {
  maintainBotHostedRoom(rooms, humanCount, hoidCtx());
  const live = liveActivityStats();
  return {
    type: 'lobby_rooms',
    rooms: publicRoomList(),
    spectateRooms: publicSpectateList(),
    playingCount: live.publicPlaying,
    live,
  };
}

function broadcastLobbyRooms() {
  if (!lobbySubs.size) return;
  const payload = JSON.stringify(lobbyRoomsPayload());
  for (const ws of lobbySubs) {
    if (ws.readyState !== 1) {
      lobbySubs.delete(ws);
      continue;
    }
    try { ws.send(payload); } catch { lobbySubs.delete(ws); }
  }
}

function scheduleLobbyBroadcast() {
  if (lobbyBroadcastTimer) return;
  lobbyBroadcastTimer = setTimeout(() => {
    lobbyBroadcastTimer = null;
    broadcastLobbyRooms();
  }, 120);
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify({ type: 'room_update', room: roomToClient(room) });
  const subs = roomSubs.get(roomId);
  if (subs) {
    for (const ws of subs) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
  scheduleLobbyBroadcast();
}

const LOBBY_CHAT_MAX = 120;
const CHAT_BURST = 8;            // messages allowed instantly
const CHAT_REFILL_MS = 300;      // one more message every 300ms after the burst
const GAME_LOG_MAX = 200;
const chatBuckets = new Map();

/** Token bucket: fast typing is fine, only real spam is limited. */
function takeChatToken(userId, now = Date.now()) {
  let b = chatBuckets.get(userId);
  if (!b) {
    b = { tokens: CHAT_BURST, at: now };
    chatBuckets.set(userId, b);
  }
  const refill = Math.floor((now - b.at) / CHAT_REFILL_MS);
  if (refill > 0) {
    b.tokens = Math.min(CHAT_BURST, b.tokens + refill);
    b.at += refill * CHAT_REFILL_MS;
  }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

function sendChatError(ws, roomId, text, error) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'chat_error', roomId, text, error }));
}

let chatSeq = 0;

function sanitizeLobbyChatText(text) {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, 280).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F<>]/g, '');
}

function isLobbyChatter(room, userId) {
  return isRoomChatter(room, userId);
}

function isRoomChatter(room, userId) {
  if (!room || !userId) return false;
  if (room.status === 'lobby') {
    return room.slots?.some(s => s?.userId === userId && !s.bot);
  }
  if (room.status === 'playing') {
    const slot = room.slots?.find(s => s?.userId === userId && !s.bot);
    const p = room.players?.find(x => x.userId === userId);
    if (!slot && (!p || p.bot)) return false;
    const gp = room.gameState?.players?.find(x => x.userId === userId);
    if (gp?.dead) return false;
    return true;
  }
  return false;
}

function isSpectatorChatter(room, userId) {
  if (!room || !userId || room.status !== 'playing') return false;
  return !isRoomChatter(room, userId);
}

function isRoomSubscriber(roomId, ws) {
  return roomSubs.get(roomId)?.has(ws);
}

function chatterProfile(room, userId, ws) {
  if (room.status === 'lobby') {
    const slot = room.slots?.find(s => s?.userId === userId);
    if (!slot) return null;
    return {
      name: slot.name || ws?.user?.name || 'Player',
      emoji: slot.emoji || '🚂',
      color: slot.color || '#3D5AFE',
    };
  }
  const p = room.players?.find(x => x.userId === userId)
    || room.slots?.find(s => s?.userId === userId);
  if (!p) return null;
  return {
    name: p.name || ws?.user?.name || 'Player',
    emoji: p.emoji || '🚂',
    color: p.color || '#3D5AFE',
  };
}

function pushLobbyChat(room, entry) {
  room.lobbyChat = room.lobbyChat || [];
  room.lobbyChat.push(entry);
  if (room.lobbyChat.length > LOBBY_CHAT_MAX) {
    room.lobbyChat = room.lobbyChat.slice(-LOBBY_CHAT_MAX);
  }
}

function broadcastLobbyChat(roomId, payload) {
  const subs = roomSubs.get(roomId);
  if (!subs) return;
  const data = JSON.stringify(payload);
  for (const ws of subs) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function sendLobbyChatHistory(ws, room) {
  if (!room?.lobbyChat?.length) return;
  ws.send(JSON.stringify({
    type: 'lobby_chat_history',
    roomId: room.id,
    messages: room.lobbyChat,
  }));
}

const LOG_TAG_OK = /^<\/?(b|i|em|strong|br)\s*\/?>$/i;
const LOG_SPAN_OK = /^<span\s+class="(log-muted|money)">$/i;
/** Only a handful of formatting tags survive; everything else is escaped. */
function sanitizeGameLogHtml(html) {
  if (typeof html !== 'string') return '';
  return html.slice(0, 600)
    .replace(/<[^>]*>?/g, tag => {
      if (LOG_TAG_OK.test(tag) || LOG_SPAN_OK.test(tag) || /^<\/span>$/i.test(tag)) return tag;
      return tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    });
}

function pushGameLog(room, entry) {
  room.gameLog = room.gameLog || [];
  room.gameLog.push(entry);
  if (room.gameLog.length > GAME_LOG_MAX) {
    room.gameLog = room.gameLog.slice(-GAME_LOG_MAX);
  }
}

function sendGameLogHistory(ws, room) {
  if (!room?.gameLog?.length) return;
  ws.send(JSON.stringify({
    type: 'game_log_history',
    roomId: room.id,
    entries: room.gameLog,
  }));
}

function broadcastRoomEvent(roomId, payload, fromWs = null) {
  const subs = roomSubs.get(roomId);
  if (!subs) return;
  const data = JSON.stringify(payload);
  for (const ws of subs) {
    if (ws.readyState === 1 && ws !== fromWs) ws.send(data);
  }
}

function handleLobbyChatMessage(ws, msg) {
  const rid = String(msg.roomId || ws.roomId || '').trim().toLowerCase();
  const room = rooms.get(rid);
  const text = sanitizeLobbyChatText(msg.text);
  if (!room || !isRoomChatter(room, ws.userId)) {
    sendChatError(ws, rid, text, 'not_allowed');
    return;
  }
  if (!text) return;

  const now = Date.now();
  if (!takeChatToken(ws.userId, now)) {
    sendChatError(ws, rid, text, 'slow_down');
    return;
  }

  const profile = chatterProfile(room, ws.userId, ws);
  if (!profile) return;

  const entry = {
    id: `${now}-${++chatSeq}-${String(ws.userId).slice(0, 8)}`,
    clientId: typeof msg.clientId === 'string' ? msg.clientId.slice(0, 40) : undefined,
    userId: ws.userId,
    name: profile.name,
    emoji: profile.emoji,
    color: profile.color,
    text,
    at: now,
  };
  pushLobbyChat(room, entry);
  broadcastLobbyChat(rid, { type: 'lobby_chat', roomId: rid, message: entry });
}

function handleSpectatorChatMessage(ws, msg) {
  const rid = String(msg.roomId || ws.roomId || '').trim().toLowerCase();
  const room = rooms.get(rid);
  if (!room || room.status !== 'playing' || !isSpectatorChatter(room, ws.userId)) {
    sendChatError(ws, rid, sanitizeLobbyChatText(msg.text), 'not_allowed');
    return;
  }
  if (!isRoomSubscriber(rid, ws)) return;

  const now = Date.now();
  const text = sanitizeLobbyChatText(msg.text);
  if (!text) return;
  if (!takeChatToken(ws.userId, now)) {
    sendChatError(ws, rid, text, 'slow_down');
    return;
  }

  const entry = {
    id: `sp-${now}-${++chatSeq}-${String(ws.userId).slice(0, 8)}`,
    clientId: typeof msg.clientId === 'string' ? msg.clientId.slice(0, 40) : undefined,
    userId: ws.userId,
    name: cleanName(ws.user?.name, 'Spectator'),
    emoji: '👁',
    color: '#FB923C',
    text,
    at: now,
    spectator: true,
  };
  pushLobbyChat(room, entry);
  broadcastLobbyChat(rid, { type: 'spectator_chat', roomId: rid, message: entry });
}

function handleGameLogMessage(ws, msg) {
  const rid = String(msg.roomId || ws.roomId || '').trim().toLowerCase();
  const room = rooms.get(rid);
  if (!room || room.status !== 'playing' || !isRoomChatter(room, ws.userId)) return;

  const html = sanitizeGameLogHtml(msg.html);
  if (!html) return;

  const entry = {
    id: `gl-${Date.now()}-${++chatSeq}`,
    html,
    color: cleanColor(msg.color) || '#fff',
    meta: msg.meta && typeof msg.meta === 'object' ? { tradeId: msg.meta.tradeId, kind: msg.meta.kind } : {},
    at: Date.now(),
    userId: ws.userId,
  };
  pushGameLog(room, entry);
  broadcastRoomEvent(rid, { type: 'game_log', roomId: rid, entry }, ws);
}

function handlePlayerMoveMessage(ws, msg) {
  const rid = String(msg.roomId || ws.roomId || '').trim().toLowerCase();
  const room = rooms.get(rid);
  if (!room || room.status !== 'playing' || !isRoomChatter(room, ws.userId)) return;

  const steps = +msg.steps;
  if (!Number.isInteger(steps) || !steps || Math.abs(steps) > 40) return;
  const target = msg.userId || ws.userId;
  if (target !== ws.userId) {
    const tp = room.players?.find(p => p.userId === target);
    if (!tp?.bot) return;
  }

  broadcastRoomEvent(rid, {
    type: 'player_move',
    roomId: rid,
    userId: target,
    steps,
    startAt: +(msg.startAt || Date.now()),
    seq: msg.seq || Date.now(),
  }, ws);
}

/** Server-authoritative dice: the server rolls, everyone (incl. roller) gets the same result. */
function handleRollRequest(ws, msg) {
  const rid = String(msg.roomId || ws.roomId || '').trim().toLowerCase();
  const room = rooms.get(rid);
  const reqId = typeof msg.reqId === 'string' ? msg.reqId.slice(0, 40) : null;
  const deny = reason => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'roll_denied', roomId: rid, reqId, reason }));
  };
  if (!room || room.status !== 'playing') return deny('not_playing');
  if (!isRoomChatter(room, ws.userId)) return deny('not_player');
  const now = Date.now();
  if (!mayRequestRoll(room, ws.userId, now)) return deny('not_your_roll');

  const d1 = randomInt(1, 7);
  const d2 = randomInt(1, 7);
  const state = room.gameState;
  const cur = state?.players?.[state.turn] || room.players?.[0];
  room.diceSeq = (room.diceSeq || 0) + 1;
  room.lastDice = { d1, d2, at: now, pending: true, turnKey: room.turnKey, seq: room.diceSeq };
  room.updatedAt = now;
  const payload = JSON.stringify({
    type: 'dice_roll',
    roomId: rid,
    d1,
    d2,
    rollerName: cur?.name || 'Player',
    rollerUserId: cur?.userId || ws.userId,
    requesterId: ws.userId,
    reqId,
    seq: room.diceSeq,
  });
  const subs = roomSubs.get(rid);
  if (!subs) return;
  for (const s of subs) {
    if (s.readyState === 1) s.send(payload);
  }
}

function sendToRoom(roomId, payload, exceptWs = null) {
  const subs = roomSubs.get(roomId);
  if (!subs) return;
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const ws of subs) {
    if (ws !== exceptWs && ws.readyState === 1) ws.send(data);
  }
}

function sendResync(ws, room, reason) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: 'game_state',
    roomId: room.id,
    state: room.gameState,
    seq: room.stateSeq || 0,
    resync: true,
    reason,
  }));
}

/**
 * Validate + commit + fan out a client's state immediately (no batching delay).
 * Optimistic concurrency: a write must be based on the latest committed state,
 * unless it continues the sender's own uncommitted chain of writes.
 */
function handleGameStateMessage(ws, msg) {
  const rid = String(msg.roomId || '').trim().toLowerCase();
  const room = rooms.get(rid);
  if (!room || room.status !== 'playing') return;
  if (!isRoomChatter(room, ws.userId)) return;

  const seq = room.stateSeq || 0;
  const base = Number.isFinite(+msg.baseSeq) ? +msg.baseSeq : -1;
  const chained = room.stateWriter === ws.userId && base >= (room.chainBase ?? 0);
  if (room.gameState && base !== seq && !chained) {
    sendResync(ws, room, 'stale');
    return;
  }

  let next;
  try {
    next = JSON.parse(JSON.stringify(msg.state));
  } catch {
    return;
  }
  const prev = room.gameState || null;
  const result = validateIncomingState({ room, prev, next, userId: ws.userId });
  if (!result.ok) {
    room.rejects = (room.rejects || 0) + 1;
    if (!IS_PROD || room.rejects % 20 === 1) {
      console.warn(`[state] room ${rid} rejected update from ${ws.userId}: ${result.reason}`);
    }
    if (prev) sendResync(ws, room, result.reason);
    return;
  }

  if (base === seq) room.chainBase = base;
  room.stateWriter = ws.userId;
  room.stateSeq = seq + 1;
  room.gameState = result.state;
  room.updatedAt = Date.now();
  noteCommittedState(room, prev, result.state);
  syncRoomAdminFromState(room, result.state);
  if (Array.isArray(result.state.voteKickedUsers)) {
    room.kicked = room.kicked || {};
    for (const uid of result.state.voteKickedUsers) {
      if (uid && !room.kicked[uid]) room.kicked[uid] = { reason: 'vote', at: Date.now() };
    }
  }

  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'state_ack', roomId: rid, seq: room.stateSeq }));
  }
  sendToRoom(rid, {
    type: 'game_state',
    roomId: rid,
    state: result.state,
    seq: room.stateSeq,
    from: ws.userId,
  }, ws);
  if (result.state.over && !prev?.over) scheduleSave();
}

function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization;
  if (!hdr?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(hdr.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function signUser(user, remember = true) {
  const expiresIn = remember ? '30d' : '1d';
  const token = jwt.sign(user, JWT_SECRET, { expiresIn });
  const profile = profileForClient(upsertProfile(user));
  scheduleSave();
  return { token, user, profile };
}

app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 40 }));
app.use('/api/rooms', rateLimit({ windowMs: 60_000, max: 150 }));

app.post('/api/auth/guest', (req, res) => {
  const name = cleanName(req.body?.name, 'Guest');
  const remember = req.body?.remember !== false;
  const user = { id: `guest_${randomBytes(8).toString('hex')}`, mode: 'guest', name, photo: null };
  res.json(signUser(user, remember));
});

app.post('/api/auth/google', async (req, res) => {
  const credential = req.body?.credential;
  if (!credential) return res.status(400).json({ error: 'Missing credential' });
  if (!googleClient) return res.status(503).json({ error: 'Google sign-in not configured on server' });
  const remember = req.body?.remember !== false;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    const user = {
      id: p.sub,
      mode: 'google',
      name: cleanName(p.name || p.email?.split('@')[0]),
      email: p.email,
      photo: p.picture || null,
    };
    res.json(signUser(user, remember));
  } catch {
    res.status(401).json({ error: 'Google sign-in failed' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const profile = profileForClient(upsertProfile(req.user));
  res.json({ user: req.user, profile });
});

app.patch('/api/profile', authMiddleware, (req, res) => {
  const p = upsertProfile(req.user);
  const { name } = req.body || {};
  if (name != null) {
    const n = cleanName(name, '');
    if (n) {
      p.name = n;
      req.user.name = n;
    }
  }
  res.json({ user: req.user, profile: profileForClient(p) });
});

app.get('/api/store', (_req, res) => {
  res.json({
    comingSoon: true,
    coinsEnabled: false,
    categories: [
      { id: 'all', label: 'All' },
      { id: 'appearance', label: 'Player appearance' },
      { id: 'maps', label: 'Board maps' },
      { id: 'upgrades', label: 'Upgrades' },
      { id: 'avatars', label: 'Profile pictures' },
      { id: 'coins', label: 'Coins' },
    ],
  });
});

app.get('/api/live', (_req, res) => {
  res.json(liveActivityStats());
});

app.get('/api/rooms', (_req, res) => {
  maintainBotHostedRoom(rooms, humanCount, hoidCtx());
  const live = liveActivityStats();
  res.json({
    rooms: publicRoomList(),
    spectateRooms: publicSpectateList(),
    playingCount: live.publicPlaying,
    live,
  });
});

app.get('/api/rooms/spectate/list', (_req, res) => {
  res.json({ rooms: publicSpectateList(), live: liveActivityStats() });
});

app.post('/api/rooms/:id/spectate', authMiddleware, (req, res) => {
  pruneRooms();
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.private) return res.status(403).json({ error: 'private', message: 'Private game' });
  if (room.status !== 'playing') {
    return res.status(400).json({ error: 'not_playing', message: 'This game is not in progress.' });
  }
  if (!humanCount(room)) {
    return res.status(400).json({ error: 'empty', message: 'No active players in this room.' });
  }
  res.json({ room: roomToClient(room, req.user.id) });
});

app.get('/api/rooms/:id', authMiddleware, (req, res) => {
  pruneRooms();
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status !== 'lobby' && !wasRoomMember(room, req.user.id)) {
    return res.status(403).json({
      error: room.private ? 'private' : 'started',
      message: room.private ? 'Private room' : 'Game already started',
    });
  }
  if (room.status === 'lobby') {
    const before = JSON.stringify(room.slots);
    syncLobbyFillers(room);
    if (JSON.stringify(room.slots) !== before) broadcastRoom(room.id);
  }
  res.json({ room: roomToClient(room, req.user.id) });
});

app.post('/api/rooms', authMiddleware, (req, res) => {
  pruneRooms();
  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: 'Server busy. Try again in a moment.' });
  }
  const { private: isPrivate, rules, maxPlayers, emoji, color } = req.body || {};
  const id = secureRoomId();
  const max = Math.min(6, Math.max(2, +(maxPlayers || 4)));
  const room = {
    id,
    private: !!isPrivate,
    status: 'lobby',
    hostId: req.user.id,
    adminSlot: 0,
    maxPlayers: max,
    slots: Array.from({ length: max }, () => null),
    rules: { ...rules, title: 'Buildup.io' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    humanoidBudget: HUMANOID_CAP,
    humanoidQueue: [],
    lobbyChat: [],
  };
  room.slots[0] = {
    userId: req.user.id,
    name: cleanName(req.user.name),
    emoji: cleanEmoji(emoji) || '🚂',
    color: cleanColor(color) || '#3D5AFE',
    bot: false,
    isHost: true,
  };
  syncLobbyFillers(room);
  rooms.set(id, room);
  res.json({ room: roomToClient(room) });
});

app.post('/api/rooms/quick-join', authMiddleware, (req, res) => {
  pruneRooms();
  const { rules, maxPlayers, emoji, color } = req.body || {};
  const user = req.user;

  for (const room of rooms.values()) {
    if (room.status === 'lobby' && room.slots.some(s => s?.userId === user.id)) {
      return res.json({ room: roomToClient(room, user.id), joined: false, created: false });
    }
  }

  let room = findJoinableHumanPublicRoom(user.id);
  let created = false;

  if (room) {
    const result = seatUserInRoom(room, user, { emoji, color });
    if (!result.ok) {
      room = null;
    } else {
      syncLobbyFillers(room);
      broadcastRoom(room.id);
      return res.json({ room: roomToClient(room, user.id), joined: true, created: false });
    }
  }

  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: 'Server busy. Try again in a moment.' });
  }

  const playRules = { ...(rules || {}), title: 'Buildup.io' };
  room = createPublicRoom(user, { rules: playRules, maxPlayers, emoji, color });
  syncLobbyFillers(room);
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room, user.id), joined: true, created: true });
});

app.post('/api/rooms/:id/join', authMiddleware, (req, res) => {
  pruneRooms();
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status !== 'lobby') {
    return res.status(403).json({ error: 'started', message: 'Game already started' });
  }
  if (room.kicked?.[req.user.id]) {
    return res.status(403).json({ error: 'removed', kicked: room.kicked[req.user.id] });
  }
  if (room.slots.some(s => s?.userId === req.user.id)) {
    return res.json({ room: roomToClient(room, req.user.id) });
  }
  if (!room.slots.some(s => !s)) {
    return res.status(400).json({ error: 'full', message: 'Room full' });
  }
  const result = seatUserInRoom(room, req.user, req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error || 'Room full' });
  syncLobbyFillers(room);
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room, req.user.id) });
});

app.patch('/api/rooms/:id', authMiddleware, (req, res) => {
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room || room.status !== 'lobby') return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== req.user.id) return res.status(403).json({ error: 'Host only' });
  const { rules, maxPlayers: maxIn } = req.body || {};
  if (rules && typeof rules === 'object') {
    room.rules = { ...room.rules, ...rules, title: 'Buildup.io' };
    syncLobbyFillers(room);
  }
  if (maxIn != null) {
    const max = Math.min(6, Math.max(2, +maxIn));
    if (max !== room.maxPlayers) {
      const next = Array.from({ length: max }, (_, i) => room.slots[i] ?? null);
      room.slots = next;
      room.maxPlayers = max;
      syncLobbyFillers(room);
    }
  }
  room.updatedAt = Date.now();
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room) });
});

app.post('/api/rooms/:id/leave', authMiddleware, (req, res) => {
  pruneRooms();
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room) return res.json({ left: true, room: null });

  if (room.status === 'playing') {
    if (!wasRoomMember(room, req.user.id)) {
      return res.json({ left: true, room: null });
    }
    kickPlayerFromGame(room, req.user.id, 'leave');
    broadcastRoom(room.id);
    return res.json({ left: true, room: roomToClient(room, req.user.id) });
  }

  if (room.status !== 'lobby') {
    return res.json({ left: true, room: null });
  }
  const idx = room.slots.findIndex(s => s?.userId === req.user.id);
  if (idx < 0) return res.json({ room: roomToClient(room), left: true });
  const wasHost = room.hostId === req.user.id;
  room.slots[idx] = null;
  if (wasHost && !transferHost(room)) {
    rooms.delete(room.id);
    roomSubs.delete(room.id);
    scheduleLobbyBroadcast();
    return res.json({ left: true, room: null });
  }
  syncLobbyFillers(room);
  room.updatedAt = Date.now();
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room, req.user.id), left: true });
});

app.post('/api/rooms/:id/kick', authMiddleware, (req, res) => {
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room || room.status !== 'lobby') {
    return res.status(404).json({ error: 'Room not found or game started' });
  }
  const result = kickLobbySlot(room, req.user.id, req.body?.slotIndex);
  if (!result.ok) return res.status(400).json({ error: result.error });
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room, req.user.id) });
});

app.post('/api/rooms/:id/absent', authMiddleware, (req, res) => {
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room || room.status !== 'playing') {
    return res.json({ ok: true, room: room ? roomToClient(room, req.user.id) : null });
  }
  markAbsent(room, req.user.id);
  broadcastRoom(room.id);
  res.json({ ok: true, room: roomToClient(room, req.user.id) });
});

app.post('/api/rooms/:id/rematch', authMiddleware, (req, res) => {
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!wasRoomMember(room, req.user.id)) {
    return res.status(403).json({ error: 'Not in this room' });
  }
  if (room.status === 'playing') {
    // Never let one player wipe a live game: only after it is over,
    // or when nobody else (human) is still playing.
    const gs = room.gameState;
    const othersPlaying = (gs?.players || room.players || []).some(p =>
      !p.bot && p.userId !== req.user.id && !p.dead && !room.kicked?.[p.userId]);
    if (gs && !gs.over && othersPlaying) {
      return res.status(409).json({ error: 'in_progress', message: 'The game is still in progress.' });
    }
  }
  if (room.status === 'playing' && room.players?.length) {
    const slots = Array.from({ length: room.maxPlayers }, () => null);
    for (const p of room.players) {
      if (p.bot) continue;
      const idx = slots.findIndex(s => !s);
      if (idx < 0) break;
      slots[idx] = {
        userId: p.userId,
        name: p.name,
        emoji: p.emoji,
        color: p.color,
        bot: false,
      };
    }
    room.slots = slots;
    room.humanoidBudget = HUMANOID_CAP;
    room.humanoidQueue = [];
    room.waitingSince = Date.now();
    syncLobbyFillers(room);
  }
  room.status = 'lobby';
  delete room.gameState;
  delete room.gameLog;
  delete room.players;
  delete room.absent;
  delete room.kicked;
  delete room.lastDice;
  room.stateSeq = 0;
  room.stateWriter = null;
  room.updatedAt = Date.now();
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room, req.user.id) });
});

app.post('/api/rooms/:id/rejoin', authMiddleware, (req, res) => {
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room || room.status !== 'playing') {
    return res.status(404).json({ error: 'Game not found' });
  }
  const uid = req.user.id;
  if (room.kicked?.[uid]) {
    const why = room.kicked[uid].reason === 'vote' ? 'vote-kicked' : 'removed';
    return res.status(403).json({ error: why, kicked: room.kicked[uid] });
  }
  if (!wasRoomMember(room, uid)) {
    return res.status(403).json({ error: 'Not in this game' });
  }
  const absent = room.absent?.[uid];
  if (absent && Date.now() > absent.until) {
    kickPlayerFromGame(room, uid, 'timeout');
    return res.status(403).json({ error: 'rejoin-expired', kicked: room.kicked[uid] });
  }
  clearAbsent(room, uid);
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room, uid) });
});

app.post('/api/rooms/:id/launch', authMiddleware, (req, res) => {
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room || room.status !== 'lobby') return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== req.user.id) return res.status(403).json({ error: 'Host only' });

  syncLobbyFillers(room);
  const seated = room.slots.filter(Boolean);
  const humans = seated.filter(s => !s.bot).length;
  const humanoids = seated.filter(s => s.humanoid).length;
  if (seated.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 players to start.' });
  }
  if (humans < 1) {
    return res.status(400).json({ error: 'Need at least 1 player in the room.' });
  }
  if (!room.rules?.allowBots && humans < 2 && humanoids === 0) {
    return res.status(400).json({ error: 'Need 2 players, a guest, or enable Fill with bots.' });
  }

  const players = seated.map(slot => ({
    userId: slot.userId,
    name: slot.name,
    emoji: slot.emoji,
    color: slot.color,
    bot: !!slot.bot,
    humanoid: !!slot.humanoid,
    botBrain: slot.botBrain || null,
    isAdmin: slot.userId === room.hostId,
  }));

  if (room.rules.randomOrder) {
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }
  }
  const adminId = players.findIndex(p => p.userId === room.hostId);
  const finalAdminId = adminId >= 0 ? adminId : (room.adminSlot ?? 0);

  room.status = 'playing';
  room.updatedAt = Date.now();
  room.gameLog = [];
  room.gameState = null;
  room.stateSeq = 0;
  room.stateWriter = null;
  room.chainBase = 0;
  room.lastDice = null;
  room.diceSeq = 0;
  room.turnSince = Date.now();
  room.turnKey = 1;
  room.mint = null;

  room.players = players;
  room.adminId = finalAdminId;

  const payload = {
    type: 'game_start',
    roomId: room.id,
    rules: room.rules,
    players,
    adminId: finalAdminId,
  };

  const subs = roomSubs.get(room.id);
  if (subs) {
    for (const ws of subs) {
      if (ws.readyState !== 1) continue;
      const uid = ws.userId;
      ws.send(JSON.stringify({ ...payload, yourUserId: uid }));
    }
  }
  broadcastRoom(room.id);

  res.json({ ...payload, yourUserId: req.user.id });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    uptime: Math.floor(process.uptime()),
  });
});

const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath, {
  maxAge: IS_PROD ? '1h' : 0,
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(distPath, 'index.html'), err => { if (err) next(); });
});

/* ---------- optional persistence (set DATA_DIR to a mounted volume) ---------- */
let saveTimer = null;
function snapshotPath() {
  return DATA_DIR ? path.join(DATA_DIR, 'buildup-state.json') : null;
}
function saveStateNow() {
  const file = snapshotPath();
  if (!file) return;
  try {
    const data = {
      savedAt: Date.now(),
      profiles: [...profiles.values()],
      rooms: [...rooms.values()].map(r => ({ ...r, humanoidQueue: [] })),
    };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('[persist] save failed:', e.message);
  }
}
function scheduleSave() {
  if (!DATA_DIR || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveStateNow(); }, 2000);
}
function loadState() {
  const file = snapshotPath();
  if (!file || !fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of data.profiles || []) profiles.set(p.id, p);
    const now = Date.now();
    for (const r of data.rooms || []) {
      if (!r?.id || now - (r.updatedAt || 0) > ROOM_TTL_MS) continue;
      // Everyone was disconnected by the restart: give them the normal rejoin window.
      if (r.status === 'playing') {
        r.absent = {};
        for (const p of r.players || []) {
          if (!p.bot && p.userId) r.absent[p.userId] = { since: now, until: now + REJOIN_GRACE_MS };
        }
        r.turnSince = now;
      }
      rooms.set(r.id, r);
    }
    console.log(`[persist] restored ${profiles.size} profiles, ${rooms.size} rooms`);
  } catch (e) {
    console.warn('[persist] load failed:', e.message);
  }
}
if (DATA_DIR) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
  loadState();
  setInterval(saveStateNow, 15_000);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { saveStateNow(); process.exit(0); });
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 256 * 1024,
  perMessageDeflate: false, // lower latency; game frames are small
});

function verifyToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function handleRoomSubscribe(ws, msg) {
  const rid = String(msg.roomId).trim().toLowerCase();
  const room = rooms.get(rid);
  if (room?.private && room.status === 'playing' && !wasRoomMember(room, ws.userId)) return;
  if (ws.roomId && ws.roomId !== rid) roomSubs.get(ws.roomId)?.delete(ws);
  ws.roomId = rid;
  if (!roomSubs.has(rid)) roomSubs.set(rid, new Set());
  roomSubs.get(rid).add(ws);
  if (!room) return;
  clearAbsent(room, ws.userId);
  ws.send(JSON.stringify({ type: 'room_update', room: roomToClient(room, ws.userId) }));
  sendLobbyChatHistory(ws, room);
  sendGameLogHistory(ws, room);
  if (room.status === 'playing' && room.players) {
    ws.send(JSON.stringify({
      type: 'game_start',
      roomId: room.id,
      rules: room.rules,
      players: room.players,
      adminId: room.adminId ?? 0,
      yourUserId: ws.userId,
    }));
    if (room.gameState) {
      ws.send(JSON.stringify({
        type: 'game_state',
        roomId: room.id,
        state: room.gameState,
        seq: room.stateSeq || 0,
        resync: true,
      }));
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const lobbyOnly = url.searchParams.get('lobby') === '1';
  // Legacy: token in query string. New clients send {type:'auth'} as the first frame
  // so the JWT never appears in URLs / proxy logs.
  const queryUser = verifyToken(url.searchParams.get('token'));
  ws.lobbyOnly = lobbyOnly;
  if (queryUser) {
    ws.user = queryUser;
    ws.userId = queryUser.id;
  }
  let authTimer = null;
  if (!lobbyOnly && !ws.userId) {
    authTimer = setTimeout(() => {
      if (!ws.userId) ws.close(4001, 'Unauthorized');
    }, 8000);
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    ws.isAlive = true;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      return;
    }
    if (msg.type === 'auth') {
      const u = verifyToken(msg.token);
      if (!u) {
        if (!lobbyOnly) ws.close(4001, 'Unauthorized');
        return;
      }
      ws.user = u;
      ws.userId = u.id;
      clearTimeout(authTimer);
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      return;
    }
    if (msg.type === 'subscribe_lobby') {
      lobbySubs.add(ws);
      ws.lobbyFeed = true;
      ws.send(JSON.stringify(lobbyRoomsPayload()));
      return;
    }
    if (msg.type === 'unsubscribe_lobby') {
      lobbySubs.delete(ws);
      ws.lobbyFeed = false;
      return;
    }
    if (ws.lobbyOnly || !ws.userId) return;
    switch (msg.type) {
      case 'subscribe':
        if (msg.roomId) handleRoomSubscribe(ws, msg);
        return;
      case 'lobby_chat':
        if (msg.roomId) handleLobbyChatMessage(ws, msg);
        return;
      case 'spectator_chat':
        if (msg.roomId) handleSpectatorChatMessage(ws, msg);
        return;
      case 'game_log':
        if (msg.roomId) handleGameLogMessage(ws, msg);
        return;
      case 'player_move':
        if (msg.roomId) handlePlayerMoveMessage(ws, msg);
        return;
      case 'roll_request':
        if (msg.roomId) handleRollRequest(ws, msg);
        return;
      case 'game_state':
        if (msg.roomId && msg.state) handleGameStateMessage(ws, msg);
        return;
      default:
        // 'dice_roll' from clients is ignored: dice are rolled by the server now.
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    lobbySubs.delete(ws);
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      const subs = roomSubs.get(ws.roomId);
      if (subs) subs.delete(ws);
      // Only mark absent if this user has no other live socket in the room (e.g. a fast reconnect).
      const stillHere = subs && [...subs].some(s => s.userId === ws.userId && s.readyState === 1);
      if (room && ws.userId && !stillHere) markAbsent(room, ws.userId);
    }
  });
});

setInterval(() => {
  pruneRooms();
  scheduleLobbyBroadcast();
}, 60_000);
setInterval(processAbsentTimeouts, 5000);
setInterval(() => {
  processHumanoidQueue(rooms, humanCount, hoidCtx());
  maintainBotHostedRoom(rooms, humanCount, hoidCtx());
}, 4000);

const wsPing = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, WS_PING_MS);
wss.on('close', () => clearInterval(wsPing));

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — the server is probably already running.`);
    console.error(`  → Open http://localhost:${PORT}/api/health to check`);
    console.error(`  → Or stop the old process: lsof -ti :${PORT} | xargs kill\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Buildup.io server http://localhost:${PORT} (${NODE_ENV})`);
  if (!GOOGLE_CLIENT_ID) console.warn('Set GOOGLE_CLIENT_ID for Google sign-in');
});
