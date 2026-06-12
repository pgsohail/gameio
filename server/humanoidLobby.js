import { randomBytes } from 'crypto';
import { pickHumanoidName } from './humanoidNames.js';

export const HUMANOID_CAP = 2;
export const HUMANOID_STALE_MS = 2 * 60 * 1000;
const JOIN_MIN_MS = 8_000;
const JOIN_MAX_MS = 48_000;
const STALE_JOIN_MIN_MS = 10_000;
const STALE_JOIN_MAX_MS = 70_000;

export const HUMANOID_EMOJIS = [
  '🚂', '✈️', '🚢', '🎩', '🚗', '🚀', '🦁', '🏎️', '🛸', '🌍', '🐪', '🎒',
  '🦊', '🐯', '🦄', '🐬', '🦅', '🐺', '🦋', '🌟', '⚡', '🔥', '💎', '🎯',
];

let botHostedRoomId = null;

export function getBotHostedRoomId() {
  return botHostedRoomId;
}

export function clearBotHostedRoomId(roomId) {
  if (botHostedRoomId === roomId) botHostedRoomId = null;
}

export function countHumanoids(room) {
  return room.slots.filter(s => s?.humanoid).length;
}

function roomHasEmptySeats(room) {
  return room.slots.some(s => !s);
}

function queuedSlotIndexes(room) {
  return new Set((room.humanoidQueue || []).map(q => q.slotIndex));
}

function shouldFillAllStale(room, humanCount) {
  return !room.private
    && room.status === 'lobby'
    && !room.rules?.allowBots
    && !room.humanoidHosted
    && humanCount >= 1
    && Date.now() - (room.waitingSince || room.createdAt) >= HUMANOID_STALE_MS;
}

function updateWaitingSince(room, humanCount) {
  if (room.status !== 'lobby' || !roomHasEmptySeats(room)) {
    delete room.waitingSince;
    return;
  }
  if (humanCount < 1 && !room.humanoidHosted) {
    delete room.waitingSince;
    return;
  }
  if (!room.waitingSince) room.waitingSince = Date.now();
}

function pickHumanoidEmoji(room) {
  const taken = new Set(room.slots.filter(Boolean).map(s => s.emoji));
  const pool = HUMANOID_EMOJIS.filter(e => !taken.has(e));
  const src = pool.length ? pool : HUMANOID_EMOJIS;
  return src[Math.floor(Math.random() * src.length)];
}

function pickHumanoidColor(room, joinColors, pickJoinColor) {
  const taken = new Set(room.slots.filter(Boolean).map(s => s.color));
  const free = joinColors.filter(c => !taken.has(c));
  const preferred = (free.length ? free : joinColors)[Math.floor(Math.random() * (free.length || joinColors.length))];
  return pickJoinColor(room, preferred);
}

export function createHumanoidSlot(room, slotIndex, usedNames, deps) {
  const { pickJoinColor, joinColors } = deps;
  const name = pickHumanoidName(usedNames);
  usedNames.add(name);
  return {
    userId: `humanoid:${room.id}:${slotIndex}:${randomBytes(4).toString('hex')}`,
    name,
    emoji: pickHumanoidEmoji(room),
    color: pickHumanoidColor(room, joinColors, pickJoinColor),
    bot: true,
    humanoid: true,
    botBrain: 'mastermind',
    isHost: false,
  };
}

function humanoidTargetCount(room, humanCount) {
  if (room.status !== 'lobby' || room.rules?.allowBots || room.humanoidHosted) return 0;
  if (humanCount < 1) return 0;

  const emptySlots = room.slots.map((s, i) => (!s ? i : -1)).filter(i => i >= 0);
  const available = emptySlots.filter(i => !queuedSlotIndexes(room).has(i));
  if (!available.length) return 0;

  const have = countHumanoids(room);
  const queued = room.humanoidQueue?.length || 0;

  if (shouldFillAllStale(room, humanCount)) {
    return Math.max(0, available.length - queued);
  }

  const budget = room.humanoidBudget ?? HUMANOID_CAP;
  const cap = Math.min(budget, HUMANOID_CAP);
  return Math.max(0, Math.min(available.length, cap - have - queued));
}

export function scheduleHumanoidJoins(room, humanCount, deps) {
  if (room.status !== 'lobby' || room.rules?.allowBots || room.humanoidHosted) return false;
  updateWaitingSince(room, humanCount);
  const need = humanoidTargetCount(room, humanCount);
  if (need <= 0) return false;

  room.humanoidQueue = room.humanoidQueue || [];
  const usedNames = new Set(room.slots.filter(Boolean).map(s => s.name));
  const stale = shouldFillAllStale(room, humanCount);
  let scheduled = false;

  for (let i = 0; i < need; i++) {
    const slotIndex = room.slots.findIndex((s, idx) => !s && !queuedSlotIndexes(room).has(idx));
    if (slotIndex < 0) break;

    const minD = stale ? STALE_JOIN_MIN_MS : JOIN_MIN_MS;
    const maxD = stale ? STALE_JOIN_MAX_MS : JOIN_MAX_MS;
    const base = minD + Math.random() * (maxD - minD);
    const stagger = i * (4_000 + Math.random() * 12_000);
    const name = pickHumanoidName(usedNames);
    usedNames.add(name);

    room.humanoidQueue.push({
      slotIndex,
      at: Date.now() + base + stagger,
      name,
    });
    scheduled = true;
  }
  return scheduled;
}

export function processHumanoidQueue(rooms, humanCountFn, deps) {
  const now = Date.now();
  let anyBroadcast = false;

  for (const room of rooms.values()) {
    if (!room.humanoidQueue?.length) continue;
    let changed = false;
    const remaining = [];

    for (const job of room.humanoidQueue) {
      if (now < job.at) {
        remaining.push(job);
        continue;
      }
      if (room.status !== 'lobby' || room.slots[job.slotIndex]) continue;

      const usedNames = new Set(room.slots.filter(Boolean).map(s => s.name));
      const slot = createHumanoidSlot(room, job.slotIndex, usedNames, deps);
      if (job.name) slot.name = job.name;
      room.slots[job.slotIndex] = slot;
      changed = true;
    }

    room.humanoidQueue = remaining;
    if (changed) {
      room.updatedAt = Date.now();
      deps.broadcastRoom(room.id);
      anyBroadcast = true;
    }
    if (room.status === 'lobby' && !room.rules?.allowBots && !room.humanoidHosted) {
      scheduleHumanoidJoins(room, humanCountFn(room), deps);
    }
  }
  return anyBroadcast;
}

export function createBotHostedPublicRoom(deps) {
  const { rooms, secureRoomId, maxRooms, pickJoinColor, joinColors } = deps;
  if (botHostedRoomId && rooms.has(botHostedRoomId)) {
    const existing = rooms.get(botHostedRoomId);
    if (existing?.status === 'lobby' && existing.humanoidHosted) return existing;
    botHostedRoomId = null;
  }
  if (rooms.size >= maxRooms) return null;

  const id = secureRoomId();
  const max = 2;
  const usedNames = new Set();
  const hostId = `humanoid:${id}:0:${randomBytes(4).toString('hex')}`;
  const room = {
    id,
    private: false,
    status: 'lobby',
    hostId,
    humanoidHosted: true,
    adminSlot: 0,
    maxPlayers: max,
    slots: Array.from({ length: max }, () => null),
    rules: {
      title: 'Buildup.io',
      allowBots: false,
      per: 12,
      cash: 2000,
      salary: 300,
      diff: 'classic',
      double: true,
      vacation: true,
      auction: true,
      trades: true,
      noJailRent: true,
      mortgage: true,
      doubles: true,
      powerCards: false,
      randomOrder: false,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    waitingSince: Date.now(),
    humanoidBudget: 0,
    humanoidQueue: [],
  };
  room.slots[0] = {
    userId: hostId,
    name: pickHumanoidName(usedNames),
    emoji: pickHumanoidEmoji(room),
    color: pickHumanoidColor(room, joinColors, pickJoinColor),
    bot: true,
    humanoid: true,
    botBrain: 'mastermind',
    isHost: true,
  };
  rooms.set(id, room);
  botHostedRoomId = id;
  return room;
}

export function maintainBotHostedRoom(rooms, humanCountFn, deps) {
  if (botHostedRoomId && rooms.has(botHostedRoomId)) {
    const room = rooms.get(botHostedRoomId);
    if (room.status !== 'lobby' || !room.humanoidHosted) {
      botHostedRoomId = null;
    } else if (humanCountFn(room) > 0) {
      room.humanoidHosted = false;
      botHostedRoomId = null;
      deps.transferHost(room);
      deps.broadcastRoom(room.id);
      return;
    } else {
      return;
    }
  }

  const hasJoinableHumanLobby = [...rooms.values()].some(r =>
    !r.private
    && r.status === 'lobby'
    && humanCountFn(r) > 0
    && r.slots.some(s => !s),
  );
  if (hasJoinableHumanLobby) return;

  const created = createBotHostedPublicRoom(deps);
  if (created) deps.broadcastRoom(created.id);
}

export function onRealHumanJoined(room, deps) {
  if (!room.humanoidHosted) return;
  room.humanoidHosted = false;
  room.humanoidQueue = [];
  clearBotHostedRoomId(room.id);
  deps.transferHost(room);
}

export function onHumanoidKicked(room, slot) {
  if (slot?.humanoid) {
    room.humanoidBudget = Math.max(0, (room.humanoidBudget ?? HUMANOID_CAP) - 1);
  }
  if (room.humanoidHosted && slot?.isHost) {
    clearBotHostedRoomId(room.id);
    room.humanoidHosted = false;
  }
}

export function humanoidLobbyDeps(ctx) {
  return {
    pickJoinColor: ctx.pickJoinColor,
    joinColors: ctx.joinColors,
    broadcastRoom: ctx.broadcastRoom,
    transferHost: ctx.transferHost,
    secureRoomId: ctx.secureRoomId,
    rooms: ctx.rooms,
    maxRooms: ctx.maxRooms,
  };
}
