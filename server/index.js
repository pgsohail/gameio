import http from 'http';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  HUMANOID_CAP,
  scheduleHumanoidJoins,
  processHumanoidQueue,
  maintainBotHostedRoom,
  onRealHumanJoined,
  onHumanoidKicked,
  clearBotHostedRoomId,
  countHumanoids,
  humanoidLobbyDeps,
} from './humanoidLobby.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim() || null;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const REJOIN_GRACE_MS = 2 * 60 * 1000;
const MAX_ROOMS = 400;
const WS_PING_MS = 30_000;

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

function secureRoomId() {
  return randomBytes(8).toString('base64url').slice(0, 10).toLowerCase();
}

function pruneRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const occupied = room.slots.filter(Boolean).length;
    if (room.status === 'playing') {
      if (now - room.updatedAt > ROOM_TTL_MS * 2) {
        rooms.delete(id);
        roomSubs.delete(id);
      }
      continue;
    }
    if (occupied === 0 || now - room.updatedAt > ROOM_TTL_MS) {
      clearBotHostedRoomId(id);
      rooms.delete(id);
      roomSubs.delete(id);
    }
  }
}

function occupiedCount(room) {
  return room.slots.filter(Boolean).length;
}

function publicRoomList() {
  pruneRooms();
  return [...rooms.values()]
    .filter(r => !r.private && r.status === 'lobby')
    .filter(r => humanCount(r) > 0 || r.humanoidHosted)
    .filter(r => r.slots.some(s => !s))
    .sort((a, b) => humanCount(b) - humanCount(a) || b.updatedAt - a.updatedAt)
    .map(roomToClient);
}

const JOIN_COLORS = ['#FF1744', '#F50057', '#651FFF', '#3D5AFE', '#00E5FF', '#00E676', '#FFEA00', '#FF9100'];
const JOIN_EMOJIS = ['🚂', '✈️', '🚢', '🎩', '🚗', '🚀'];

function pickJoinColor(room, preferred) {
  const taken = room.slots.filter(Boolean).map(s => s.color);
  let color = preferred || JOIN_COLORS[0];
  if (taken.includes(color)) {
    color = JOIN_COLORS.find(c => !taken.includes(c)) || color;
  }
  return color;
}

function findJoinablePublicRoom(userId) {
  return [...rooms.values()]
    .filter(r => !r.private && r.status === 'lobby')
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
    name: user.name,
    emoji: emoji || JOIN_EMOJIS[idx % JOIN_EMOJIS.length],
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
    rules: { ...rules, title: 'Buildup.io', allowBots: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    humanoidBudget: HUMANOID_CAP,
    humanoidQueue: [],
  };
  room.slots[0] = {
    userId: user.id,
    name: user.name,
    emoji: emoji || '🚂',
    color: color || '#3D5AFE',
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

function kickPlayerFromGame(room, userId, reason) {
  room.kicked = room.kicked || {};
  room.kicked[userId] = { reason, at: Date.now() };
  if (room.absent?.[userId]) delete room.absent[userId];
  if (room.gameState?.players) {
    const gp = room.gameState.players.find(p => p.userId === userId);
    if (gp) gp.dead = true;
  }
  room.updatedAt = Date.now();
  const payload = JSON.stringify({
    type: 'game_state',
    roomId: room.id,
    state: room.gameState,
    seq: room.stateSeq || Date.now(),
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
const BOT_COLORS = ['#78909C', '#607D8B', '#546E7A', '#90A4AE', '#B0BEC5', '#455A64'];

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

function syncLobbyFillers(room) {
  if (room.status !== 'lobby') return;
  if (room.rules?.allowBots) syncRoomBots(room);
  else scheduleHumanoidJoins(room, humanCount(room), hoidCtx());
}

function syncRoomBots(room) {
  if (!room.rules?.allowBots) return;
  let n = room.slots.filter(s => s?.bot).length + 1;
  for (let i = 0; i < room.slots.length; i++) {
    if (!room.slots[i]) {
      room.slots[i] = {
        userId: `bot:${room.id}:${i}`,
        name: `Bot ${n}`,
        emoji: BOT_EMOJIS[i % BOT_EMOJIS.length],
        color: BOT_COLORS[i % BOT_COLORS.length],
        bot: true,
        isHost: false,
      };
      n += 1;
    }
  }
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

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify({ type: 'room_update', room: roomToClient(room) });
  const subs = roomSubs.get(roomId);
  if (!subs) return;
  for (const ws of subs) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastDiceRoll(roomId, msg) {
  const subs = roomSubs.get(roomId);
  if (!subs) return;
  const seq = msg.seq || Date.now();
  const now = Date.now();
  const clientStart = +(msg.startAt || 0);
  const startAt = clientStart > now + 40 ? clientStart : now + 120;
  const payload = JSON.stringify({
    type: 'dice_roll',
    roomId,
    d1: msg.d1,
    d2: msg.d2,
    rollerName: msg.rollerName,
    rollerUserId: msg.rollerUserId,
    startAt,
    seq,
  });
  for (const ws of subs) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastGameState(roomId, state, fromWs, fromUserId) {
  const room = rooms.get(roomId);
  if (room?.status === 'playing') {
    room.gameState = state;
    room.stateSeq = Date.now();
    room.updatedAt = Date.now();
    if (Array.isArray(state.voteKickedUsers)) {
      room.kicked = room.kicked || {};
      for (const uid of state.voteKickedUsers) {
        if (uid) room.kicked[uid] = { reason: 'vote', at: Date.now() };
      }
    }
  }
  const subs = roomSubs.get(roomId);
  if (!subs) return;
  const seq = room?.stateSeq || Date.now();
  const payload = JSON.stringify({
    type: 'game_state',
    roomId,
    state,
    seq,
    from: fromUserId,
  });
  for (const ws of subs) {
    if (ws.readyState === 1 && ws !== fromWs) ws.send(payload);
  }
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
  return { token, user, profile };
}

app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 40 }));
app.use('/api/rooms', rateLimit({ windowMs: 60_000, max: 150 }));

app.post('/api/auth/guest', (req, res) => {
  const name = String(req.body?.name || 'Guest').trim().slice(0, 18) || 'Guest';
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
      name: p.name || p.email?.split('@')[0] || 'Player',
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
    const n = String(name).trim().slice(0, 18);
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

app.get('/api/rooms', (_req, res) => {
  maintainBotHostedRoom(rooms, humanCount, hoidCtx());
  res.json({ rooms: publicRoomList() });
});

app.get('/api/rooms/:id', authMiddleware, (req, res) => {
  pruneRooms();
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  // Invite link is the secret for private lobbies — allow fetch while still in lobby
  if (room.private && room.status !== 'lobby' && !wasRoomMember(room, req.user.id)) {
    return res.status(403).json({ error: 'Private room' });
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
  };
  room.slots[0] = {
    userId: req.user.id,
    name: req.user.name,
    emoji: emoji || '🚂',
    color: color || '#3D5AFE',
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

  let room = findJoinablePublicRoom(user.id);
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

  const playRules = { ...(rules || {}), allowBots: false, title: 'Buildup.io' };
  room = createPublicRoom(user, { rules: playRules, maxPlayers, emoji, color });
  syncLobbyFillers(room);
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room, user.id), joined: true, created: true });
});

app.post('/api/rooms/:id/join', authMiddleware, (req, res) => {
  pruneRooms();
  const room = rooms.get(String(req.params.id || '').trim().toLowerCase());
  if (!room || room.status !== 'lobby') return res.status(404).json({ error: 'Room not found' });
  if (room.kicked?.[req.user.id]) {
    return res.status(403).json({ error: 'removed', kicked: room.kicked[req.user.id] });
  }
  if (room.slots.some(s => s?.userId === req.user.id)) {
    return res.json({ room: roomToClient(room, req.user.id) });
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
  delete room.players;
  delete room.absent;
  delete room.kicked;
  room.stateSeq = 0;
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
  const emptySlots = room.slots.filter(s => !s).length;
  if (emptySlots > 0) {
    const joined = room.slots.filter(Boolean).length;
    return res.status(400).json({
      error: `Lobby not full yet (${joined}/${room.maxPlayers} players). Wait for everyone to join.`,
    });
  }

  const players = room.slots.map(slot => ({
    userId: slot.userId,
    name: slot.name,
    emoji: slot.emoji,
    color: slot.color,
    bot: !!slot.bot,
    humanoid: !!slot.humanoid,
    botBrain: slot.botBrain || null,
    isAdmin: slot.userId === room.hostId,
  }));

  const humans = players.filter(p => !p.bot).length;
  const humanoids = players.filter(p => p.humanoid).length;
  if (players.length < 2) return res.status(400).json({ error: 'Need at least 2 players' });
  if (humans < 1) return res.status(400).json({ error: 'Need at least 1 human player' });
  if (!room.rules?.allowBots && humans < 2 && humanoids === 0) {
    return res.status(400).json({ error: 'Need at least 2 human players (or enable bots)' });
  }

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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  try {
    ws.user = jwt.verify(token, JWT_SECRET);
    ws.userId = ws.user.id;
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'subscribe' && msg.roomId) {
      const rid = String(msg.roomId).trim().toLowerCase();
      ws.roomId = rid;
      if (!roomSubs.has(rid)) roomSubs.set(rid, new Set());
      roomSubs.get(rid).add(ws);
      const room = rooms.get(rid);
      if (room) {
        clearAbsent(room, ws.userId);
        ws.send(JSON.stringify({ type: 'room_update', room: roomToClient(room, ws.userId) }));
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
              seq: room.stateSeq || Date.now(),
            }));
          }
        }
      }
    }
    if (msg.type === 'dice_roll' && msg.roomId) {
      const rid = String(msg.roomId).trim().toLowerCase();
      const room = rooms.get(rid);
      if (room?.status === 'playing') {
        room.updatedAt = Date.now();
        broadcastDiceRoll(rid, msg);
      }
    }
    if (msg.type === 'game_state' && msg.roomId && msg.state) {
      const rid = String(msg.roomId).trim().toLowerCase();
      const room = rooms.get(rid);
      if (room?.status === 'playing') {
        room.updatedAt = Date.now();
        broadcastGameState(rid, msg.state, ws, ws.userId);
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room && ws.userId) markAbsent(room, ws.userId);
      if (roomSubs.has(ws.roomId)) roomSubs.get(ws.roomId).delete(ws);
    }
  });
});

setInterval(pruneRooms, 60_000);
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
