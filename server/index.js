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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
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
    if (room.status !== 'lobby' || occupied === 0 || now - room.updatedAt > ROOM_TTL_MS) {
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
    .filter(r => !r.private && r.status === 'lobby' && occupiedCount(r) > 0)
    .map(roomToClient);
}

function roomToClient(room) {
  return {
    id: room.id,
    private: room.private,
    status: room.status,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    slots: room.slots,
    rules: room.rules,
    updatedAt: room.updatedAt,
  };
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
  res.json({ rooms: publicRoomList() });
});

app.get('/api/rooms/:id', authMiddleware, (req, res) => {
  pruneRooms();
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.private && !room.slots.some(s => s?.userId === req.user.id)) {
    return res.status(403).json({ error: 'Private room' });
  }
  res.json({ room: roomToClient(room) });
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
  };
  room.slots[0] = {
    userId: req.user.id,
    name: req.user.name,
    emoji: emoji || '🚂',
    color: color || '#3D5AFE',
    bot: false,
    isHost: true,
  };
  rooms.set(id, room);
  res.json({ room: roomToClient(room) });
});

app.post('/api/rooms/:id/join', authMiddleware, (req, res) => {
  pruneRooms();
  const room = rooms.get(req.params.id);
  if (!room || room.status !== 'lobby') return res.status(404).json({ error: 'Room not found' });
  if (room.slots.some(s => s?.userId === req.user.id)) {
    return res.json({ room: roomToClient(room) });
  }
  const idx = room.slots.findIndex(s => !s);
  if (idx < 0) return res.status(400).json({ error: 'Room full' });
  const emojis = ['🚂', '✈️', '🚢', '🎩', '🚗', '🚀'];
  const colors = ['#FF1744', '#F50057', '#651FFF', '#3D5AFE', '#00E5FF', '#00E676', '#FFEA00', '#FF9100'];
  room.slots[idx] = {
    userId: req.user.id,
    name: req.user.name,
    emoji: req.body?.emoji || emojis[idx % emojis.length],
    color: req.body?.color || colors[idx % colors.length],
    bot: false,
    isHost: false,
  };
  room.updatedAt = Date.now();
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room) });
});

app.patch('/api/rooms/:id', authMiddleware, (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room || room.status !== 'lobby') return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== req.user.id) return res.status(403).json({ error: 'Host only' });
  const { rules, maxPlayers: maxIn } = req.body || {};
  if (rules && typeof rules === 'object') {
    room.rules = { ...room.rules, ...rules, title: 'Buildup.io' };
  }
  if (maxIn != null) {
    const max = Math.min(6, Math.max(2, +maxIn));
    if (max !== room.maxPlayers) {
      const next = Array.from({ length: max }, (_, i) => room.slots[i] ?? null);
      room.slots = next;
      room.maxPlayers = max;
    }
  }
  room.updatedAt = Date.now();
  broadcastRoom(room.id);
  res.json({ room: roomToClient(room) });
});

app.post('/api/rooms/:id/launch', authMiddleware, (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room || room.status !== 'lobby') return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== req.user.id) return res.status(403).json({ error: 'Host only' });

  const allowBots = room.rules.allowBots !== false;
  const players = [];
  room.slots.forEach((slot, i) => {
    if (slot) {
      players.push({
        userId: slot.userId,
        name: slot.name,
        emoji: slot.emoji,
        color: slot.color,
        bot: false,
        isAdmin: i === (room.adminSlot ?? 0),
      });
    } else if (allowBots) {
      const bi = players.length;
      players.push({
        userId: `bot_${bi}`,
        name: `Bot ${bi}`,
        emoji: ['🤖', '🎲', '🃏', '🎯'][bi % 4],
        color: ['#FF1744', '#651FFF', '#00E676', '#FFEA00'][bi % 4],
        bot: true,
        isAdmin: false,
      });
    }
  });

  if (players.length < 2) return res.status(400).json({ error: 'Need at least 2 players' });

  room.status = 'playing';
  room.updatedAt = Date.now();

  const payload = {
    type: 'game_start',
    rules: room.rules,
    players,
    adminId: room.adminSlot ?? 0,
  };

  const subs = roomSubs.get(room.id);
  if (subs) {
    for (const ws of subs) {
      if (ws.readyState !== 1) continue;
      const uid = ws.userId;
      ws.send(JSON.stringify({ ...payload, yourUserId: uid }));
    }
  }

  rooms.delete(room.id);
  roomSubs.delete(room.id);

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
  maxAge: IS_PROD ? '7d' : 0,
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
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
      ws.roomId = msg.roomId;
      if (!roomSubs.has(msg.roomId)) roomSubs.set(msg.roomId, new Set());
      roomSubs.get(msg.roomId).add(ws);
      const room = rooms.get(msg.roomId);
      if (room) ws.send(JSON.stringify({ type: 'room_update', room: roomToClient(room) }));
    }
  });

  ws.on('close', () => {
    if (ws.roomId && roomSubs.has(ws.roomId)) {
      roomSubs.get(ws.roomId).delete(ws);
    }
  });
});

setInterval(pruneRooms, 60_000);

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
