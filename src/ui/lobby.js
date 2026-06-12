import { $ } from '../lib/format.js';
import { BRIGHT_COLORS } from '../lib/colors.js';
import {
  continueAsGuest, getRemember, getUser, initGoogleSignIn,
  onAuthChange, restoreSession, setRemember, signOut,
} from '../lib/auth.js';
import {
  connectRoomSocket, getToken, markAbsentKeepalive, roomLink, roomsApi, subscribeWhenOpen,
} from '../lib/api.js';
import {
  enableMultiplayer, detachMultiplayer, handleSocketMessage, handleDiceRollMessage, applyGameState,
} from '../lib/multiplayer.js';
import { initAccount, renderHub, renderProfilePage } from './account.js';
import { boardName, boardTagline } from '../lib/boards.js';
import { playPlayerJoin, playPlayerLeave, playBotJoin } from '../lib/sounds.js';

const TOKEN_EMOJI = ['🚂', '✈️', '🚢', '🎩', '🚗', '🚀'];
const RULE_ICONS = [
  { key: 'double', icon: '🏘️', title: '×2 rent on full sets' },
  { key: 'vacation', icon: '🏖️', title: 'Vacation pot' },
  { key: 'auction', icon: '🔨', title: 'Auctions' },
  { key: 'noJailRent', icon: '⛓️', title: 'No jail rent' },
  { key: 'mortgage', icon: '🏦', title: 'Mortgage' },
  { key: 'doubles', icon: '🎲', title: 'Doubles roll again' },
  { key: 'powerCards', icon: '🃏', title: 'Power cards' },
  { key: 'allowBots', icon: '🤖', title: 'Fill with bots' },
  { key: 'randomOrder', icon: '🔀', title: 'Random turn order' },
];

let chosenPer = 12;
let maxPlayers = 4;
let hostEmoji = '🚂';
let hostColor = BRIGHT_COLORS[4];
let boardJoinEmoji = '🚂';
let boardJoinColor = BRIGHT_COLORS[4];
let tokGridEl = null;
let onStartGame = null;
let onPreviewBoard = null;
let currentRoomId = null;
let lastRoomRules = null;
let roomSocket = null;
let roomsPanelOpen = false;
let rulesSaveTimer = null;
let gameStarted = false;
let gameMultiplayer = false;
let gamePausedAway = false;
let wsReconnectTimer = null;
let lobbyPollTimer = null;
let prevSlotSnapshot = null;
let lobbyWasSeated = false;
let botSoundQueue = 0;

const DIFF_HINTS = {
  relaxed: 'Gentler bots and slower bidding.',
  classic: 'Balanced bots and classic pacing.',
  shark: 'Aggressive bots that overbid and build fast.',
};
const CASH_HINTS = {
  1500: '$1,500 each. Tight economy.',
  2000: '$2,000 each. Standard opening bankroll.',
  3000: '$3,000 each. More buying power.',
  5000: '$5,000 each. Fast property grabs.',
  7500: '$7,500 each. High stakes opener.',
  10000: '$10,000 each. Maximum chaos economy.',
};
const SALARY_HINTS = {
  200: '$200 per GO. Slower cash flow.',
  300: '$300 each time you pass GO.',
  400: '$400 per GO. Healthier mid-game income.',
  500: '$500 per GO. Fast recovery after big spends.',
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function boardLabel(per) {
  return boardName(per);
}

function ruleIconsHtml(rules) {
  return RULE_ICONS.map(r => {
    const on = rules[r.key];
    return `<span class="room-rule-ico${on ? ' on' : ''}" title="${esc(r.title)}">${r.icon}</span>`;
  }).join('');
}

function slotAvatars(slots, max) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const p = slots[i];
    if (p) {
      const crown = p.isHost ? '<span class="room-slot__crown">👑</span>' : '';
      const isBot = p.bot && !p.humanoid;
      const humanoidCls = p.humanoid ? ' room-slot--humanoid' : '';
      out.push(`<span class="room-slot room-slot--filled${humanoidCls}" style="--pc:${p.color}" title="${esc(p.name)}">${crown}${isBot ? '🤖' : p.emoji}</span>`);
    } else {
      out.push('<span class="room-slot room-slot--empty"></span>');
    }
  }
  return out.join('');
}

function guestName() {
  return $('homeNameInput')?.value?.trim().slice(0, 18) || 'Guest';
}

async function ensureUser() {
  const u = getUser();
  if (u) return u;
  setRemember($('rememberMe')?.checked ?? true);
  try {
    return await continueAsGuest(guestName());
  } catch {
    $('authBar')?.classList.add('home-auth--pulse');
    $('homePlayAs')?.classList.add('home-auth--pulse');
    setTimeout(() => {
      $('authBar')?.classList.remove('home-auth--pulse');
      $('homePlayAs')?.classList.remove('home-auth--pulse');
    }, 1600);
    return null;
  }
}

function showView(name) {
  $('lobbyHome')?.classList.toggle('hidden', name !== 'home');
  $('lobbyCreate')?.classList.toggle('hidden', name !== 'create');
  $('lobbyProfile')?.classList.toggle('hidden', name !== 'profile');
  $('lobbyStore')?.classList.toggle('hidden', name !== 'store');
  const inLobby = ['home', 'create', 'profile', 'store'].includes(name);
  $('hubTop')?.classList.toggle('hidden', !inLobby);
  if (inLobby) sessionStorage.setItem(LOBBY_VIEW_KEY, name);
  if (name === 'profile') renderProfilePage();
}

function renderAuthBar() {
  const u = getUser();
  $('authGuest')?.classList.toggle('hidden', !!u);
  $('authSigned')?.classList.toggle('hidden', !u);
  $('homePlayAs')?.classList.toggle('hidden', !!u);
  if (!u) return;
  const av = $('authAvatar');
  if (av) {
    av.innerHTML = u.photo
      ? `<img src="${esc(u.photo)}" alt="" width="28" height="28">`
      : (u.mode === 'google' ? 'G' : '👤');
  }
  const nameEl = $('authUserName');
  if (nameEl) nameEl.textContent = u.name;
  renderHub();
}

async function renderRoomList() {
  const section = $('publicRoomsSection');
  const list = $('roomList');
  const empty = $('homeRoomsEmpty');
  if (!section || !list) return;
  try {
    const { rooms } = await roomsApi.list();
    const show = roomsPanelOpen || rooms.length > 0;
    section.classList.toggle('hidden', !show);
    empty?.classList.toggle('hidden', !show || rooms.length > 0);
    if (!rooms.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = rooms.map(r => {
      const humans = r.humans ?? r.slots?.filter(s => s && !s.bot).length ?? 0;
      const open = r.openSeats ?? r.slots?.filter(s => !s).length ?? 0;
      const total = r.maxPlayers || r.slots?.length || 4;
      return `
      <button type="button" class="room-card room-card--public" data-room="${esc(r.id)}">
        <div class="room-card__left">
          <span class="room-card__id">${esc(r.id)}</span>
          <span class="room-card__meta">${humans} playing · ${open} seat${open === 1 ? '' : 's'} open</span>
          <div class="room-card__slots">${slotAvatars(r.slots, total)}</div>
        </div>
        <div class="room-card__right">
          <span class="room-card__mode">🗺 ${boardLabel(r.rules.per)}</span>
          <div class="room-card__rules">${ruleIconsHtml(r.rules)}</div>
          <span class="room-card__cash">▶ ${r.rules.cash}</span>
        </div>
      </button>`;
    }).join('');
    list.querySelectorAll('.room-card').forEach(btn => {
      btn.onclick = () => joinRoom(btn.dataset.room);
    });
  } catch {
    section.classList.add('hidden');
  }
}

function gatherRules() {
  return {
    per: chosenPer,
    title: 'Buildup.io',
    diff: document.querySelector('.diff-chip.glass-seg__btn.on, .diff-chip.on')?.dataset.val || 'classic',
    cash: +(document.querySelector('.cash-chip.glass-seg__btn.on, .cash-chip.on')?.dataset.val || 2000),
    salary: +(document.querySelector('.salary-chip.glass-seg__btn.on, .salary-chip.on')?.dataset.val || 300),
    double: $('ruleDouble')?.checked ?? true,
    vacation: $('ruleVacation')?.checked ?? true,
    auction: $('ruleAuction')?.checked ?? true,
    trades: true,
    noJailRent: $('ruleNoJailRent')?.checked ?? true,
    mortgage: $('ruleMortgage')?.checked ?? true,
    doubles: $('ruleDoubles')?.checked ?? true,
    powerCards: $('rulePowerCards')?.checked ?? false,
    allowBots: $('ruleAllowBots')?.checked ?? true,
    randomOrder: $('ruleRandomOrder')?.checked ?? false,
  };
}

function gatherBoardRules() {
  const rules = {
    per: +(document.querySelector('.board-sz.on')?.dataset.per || lastRoomRules?.per || 12),
    cash: +(document.querySelector('.board-cash.on')?.dataset.val || 2000),
    salary: +(document.querySelector('.board-sal.on')?.dataset.val || 300),
    diff: lastRoomRules?.diff || 'classic',
    title: 'Buildup.io',
    trades: true,
  };
  document.querySelectorAll('.board-rule').forEach(inp => {
    rules[inp.dataset.rule] = inp.checked;
  });
  return rules;
}

function applyBoardRules(rules, { hostOnly = true, isHost = false } = {}) {
  lastRoomRules = { ...rules };
  const setSeg = (selector, val, key = 'val') => {
    document.querySelectorAll(selector).forEach(btn => {
      const v = key === 'per' ? btn.dataset.per : btn.dataset.val;
      btn.classList.toggle('on', String(v) === String(val));
    });
  };
  setSeg('.board-sz', rules.per, 'per');
  setSeg('.board-cash', rules.cash);
  setSeg('.board-sal', rules.salary);
  document.querySelectorAll('.board-rule').forEach(inp => {
    const k = inp.dataset.rule;
    if (k in rules) inp.checked = !!rules[k];
    inp.disabled = hostOnly && !isHost;
  });
  document.querySelectorAll('#boardAdvBody .glass-seg__btn').forEach(btn => {
    btn.disabled = hostOnly && !isHost;
  });
  $('boardAdvHostOnly')?.classList.toggle('hidden', isHost);
  $('boardAdvBody')?.classList.toggle('room-panel__section--locked', hostOnly && !isHost);
}

function scheduleRulesSave() {
  if (!currentRoomId) return;
  const u = getUser();
  clearTimeout(rulesSaveTimer);
  rulesSaveTimer = setTimeout(async () => {
    try {
      const rules = gatherBoardRules();
      const { room } = await roomsApi.update(currentRoomId, { rules });
      if (room.rules.per !== lastRoomRules?.per) onPreviewBoard?.(room.rules.per);
      renderBoardLobby(room);
    } catch { /* host only */ }
  }, 450);
}

function stopLobbyPoll() {
  if (lobbyPollTimer) clearInterval(lobbyPollTimer);
  lobbyPollTimer = null;
}

function startLobbyPoll(roomId) {
  stopLobbyPoll();
  lobbyPollTimer = setInterval(async () => {
    if (gameStarted || currentRoomId !== roomId) {
      stopLobbyPoll();
      return;
    }
    try {
      const { room } = await roomsApi.get(roomId);
      if (room.status === 'lobby') renderBoardLobby(room);
    } catch { /* room expired */ }
  }, 2000);
}

function onRoomSocketMessage(roomId, msg) {
  const u = getUser();
  if (handleDiceRollMessage(msg)) return;
  if (handleSocketMessage(msg, u?.id)) return;
  if (msg.type === 'room_update' && msg.room?.id === roomId) {
    renderBoardLobby(msg.room);
  }
  if (msg.type === 'game_start') {
    startFromPayload(msg);
  }
}

function startFromPayload(payload) {
  if (gameStarted) return;
  const u = getUser();
  if (!u || !onStartGame) return;
  gameStarted = true;
  gameMultiplayer = isMp;
  stopLobbyPoll();
  const adminId = payload.adminId ?? 0;
  const humanCount = payload.players.filter(p => !p.bot).length;
  const isMp = humanCount > 1;
  const players = payload.players.map((p, i) => ({
    userId: p.userId,
    name: p.userId === u.id ? u.name : p.name,
    bot: !!p.bot,
    humanoid: !!p.humanoid,
    botBrain: p.botBrain || null,
    emoji: p.emoji,
    color: p.color,
    isAdmin: i === adminId,
  }));
  const rid = String(payload.roomId || currentRoomId || '').toLowerCase();
  if (rid) currentRoomId = rid;
  try {
    onStartGame({ rules: payload.rules, players, adminId, multiplayer: isMp });
    if (isMp && rid) {
      if (!roomSocket || roomSocket.readyState === WebSocket.CLOSED) {
        subscribeRoom(rid);
      }
      enableMultiplayer(roomSocket, rid);
      subscribeWhenOpen(roomSocket, { type: 'subscribe', roomId: rid });
    } else {
      detachMultiplayer();
      disconnectRoomSocket();
    }
  } catch (e) {
    gameStarted = false;
    detachMultiplayer();
    alert(e?.message || 'Could not start the game. Try refreshing and creating a new room.');
  }
}

function disconnectRoomSocket() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  roomSocket?.close();
  roomSocket = null;
}

function subscribeRoom(roomId) {
  disconnectRoomSocket();
  const rid = String(roomId).toLowerCase();
  roomSocket = connectRoomSocket(msg => onRoomSocketMessage(rid, msg));
  subscribeWhenOpen(roomSocket, { type: 'subscribe', roomId: rid });
  roomSocket?.addEventListener('close', () => {
    if (currentRoomId !== rid) return;
    wsReconnectTimer = setTimeout(() => {
      if (currentRoomId !== rid) return;
      const ws = connectRoomSocket(msg => onRoomSocketMessage(rid, msg));
      roomSocket = ws;
      subscribeWhenOpen(ws, { type: 'subscribe', roomId: rid });
      if (gameStarted && gameMultiplayer) enableMultiplayer(ws, rid);
    }, 1000);
  });
  startLobbyPoll(rid);
}

function exitBoardLobby() {
  prevSlotSnapshot = null;
  botSoundQueue = 0;
  gamePausedAway = false;
  updateReturnToGameBtn();
  $('roomLobby')?.classList.add('hidden');
  $('lobby')?.classList.remove('hidden');
  $('hubTop')?.classList.remove('hidden');
  $('scene')?.classList.remove('hidden');
  $('hud')?.classList.add('hidden');
  document.body.classList.remove('room-lobby-mode');
  setGameBrandVisible(false);
  stopLobbyPoll();
  detachMultiplayer();
  disconnectRoomSocket();
  gameStarted = false;
  gameMultiplayer = false;
  currentRoomId = null;
  lastRoomRules = null;
  lobbyWasSeated = false;
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url.pathname + url.search);
  sessionStorage.removeItem(ROOM_SESSION_KEY);
}

function enterBoardLobby(room) {
  currentRoomId = room.id;
  prevSlotSnapshot = null;
  sessionStorage.removeItem(LOBBY_VIEW_KEY);
  $('hubTop')?.classList.add('hidden');
  $('lobby')?.classList.add('hidden');
  onPreviewBoard?.(room.rules.per);
  $('roomLobby')?.classList.remove('hidden');
  document.body.classList.add('room-lobby-mode');
  setGameBrandVisible(true);
  hideInviteCard();
  persistRoomInUrl(room.id);
  updateBoardLinkUI(room.id);
  $('boardShareBox')?.classList.toggle('hidden', !room.private);
  renderBoardLobby(room);
  subscribeRoom(room.id);
}

function takenColorsFromRoom(room) {
  return (room?.slots || []).filter(Boolean).map(s => s.color);
}

function pickAvailableColor(preferred, taken) {
  if (!taken.includes(preferred)) return preferred;
  return BRIGHT_COLORS.find(c => !taken.includes(c)) || preferred;
}

function renderBoardJoinColors(room) {
  const sw = $('boardJoinColors');
  if (!sw) return;
  const taken = takenColorsFromRoom(room);
  boardJoinColor = pickAvailableColor(boardJoinColor, taken);
  sw.innerHTML = '';
  BRIGHT_COLORS.forEach(c => {
    const isTaken = taken.includes(c);
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'traveler-color'
      + (c === boardJoinColor ? ' on' : '')
      + (isTaken ? ' traveler-color--taken' : '');
    s.style.background = c;
    s.disabled = isTaken;
    s.title = isTaken ? 'Color taken' : '';
    s.onclick = () => {
      if (isTaken) return;
      sw.querySelectorAll('.traveler-color').forEach(x => x.classList.remove('on'));
      s.classList.add('on');
      boardJoinColor = c;
      $('boardJoinToken')?.style.setProperty('--pc', c);
    };
    sw.appendChild(s);
  });
  $('boardJoinToken')?.style.setProperty('--pc', boardJoinColor);
}

function snapshotSlots(slots) {
  return slots.map(s => (s ? `${s.userId}:${s.bot ? 'b' : 'h'}` : ''));
}

function playLobbySlotSounds(room) {
  const snap = snapshotSlots(room.slots);
  if (!prevSlotSnapshot) {
    prevSlotSnapshot = snap;
    return;
  }
  const u = getUser();
  let botAdds = 0;
  for (let i = 0; i < snap.length; i++) {
    const prev = prevSlotSnapshot[i] || '';
    const next = snap[i] || '';
    if (prev === next) continue;
    if (!prev && next) {
      const p = room.slots[i];
      if (p?.bot) botAdds += 1;
      else if (p?.userId !== u?.id) playPlayerJoin();
    } else if (prev && !next) {
      playPlayerLeave();
    } else if (prev && next && prev !== next) {
      const p = room.slots[i];
      if (p?.bot) botAdds += 1;
      else if (p?.userId !== u?.id) playPlayerJoin();
      else if (prev && !room.slots[i]?.bot) playPlayerLeave();
    }
  }
  if (botAdds > 0) {
    for (let j = 0; j < botAdds; j++) {
      playBotJoin(botSoundQueue * 0.12);
      botSoundQueue += 1;
    }
    setTimeout(() => { botSoundQueue = 0; }, botAdds * 120 + 200);
  }
  prevSlotSnapshot = snap;
}

function renderBoardLobby(room) {
  const u = getUser();
  const inRoom = !!u && room.slots.some(s => s?.userId === u.id);
  if (lobbyWasSeated && !inRoom && !gameStarted) {
    lobbyWasSeated = false;
    const msg = room.kicked?.reason === 'admin'
      ? 'The admin removed you from this room.'
      : 'You are no longer in this room.';
    alert(msg);
    exitBoardLobby();
    showView('home');
    renderRoomList();
    return;
  }
  lobbyWasSeated = inRoom;

  if (!inRoom && room.kicked?.reason === 'admin') {
    alert('The admin removed you from this room.');
    exitBoardLobby();
    showView('home');
    renderRoomList();
    return;
  }

  const isHost = u && room.hostId === u.id;
  const full = room.slots.every(Boolean);
  const needsJoin = !inRoom && !full;
  const humans = room.slots.filter(s => s && !s.bot).length;
  const total = room.slots.filter(Boolean).length;
  const allowBots = !!room.rules?.allowBots;
  const humanoids = room.slots.filter(s => s && s.humanoid).length;
  const minHumans = allowBots ? 1 : 1;
  const canLaunch = full && total >= 2 && humans >= minHumans && (allowBots || humans >= 2 || humanoids >= 1);

  playLobbySlotSounds(room);

  $('boardRoomCode').textContent = room.id;
  $('boardWaitCount').textContent = `${humans} human${humans === 1 ? '' : 's'} · ${total}/${room.maxPlayers}`;
  $('boardWaitingSlots').innerHTML = slotAvatars(room.slots, room.maxPlayers);
  $('boardPlayerList').innerHTML = room.slots.map((p, i) => {
    if (!p) return '';
    const canKick = isHost && !gameStarted && !p.isHost;
    const isBot = p.bot && !p.humanoid;
    const humanoidCls = p.humanoid ? ' room-player-item--humanoid' : '';
    return `
    <li class="room-player-item${isBot ? ' room-player-item--bot' : ''}${humanoidCls}">
      <span class="room-player-item__tok${p.humanoid ? ' room-player-item__tok--humanoid' : ''}" style="--pc:${esc(p.color)}">${isBot ? '🤖' : p.emoji}</span>
      <span class="room-player-item__meta">
        <span class="room-player-item__name">${esc(p.name)}</span>
        <span class="room-player-item__badges">
          ${p.isHost ? '<span class="room-player-item__badge">Admin</span>' : ''}
          ${isBot ? '<span class="room-player-item__badge room-player-item__badge--bot">Bot</span>' : ''}
        </span>
      </span>
      ${canKick ? `<button type="button" class="room-player-kick" data-slot="${i}" title="Remove from room" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}
    </li>`;
  }).filter(Boolean).join('') || '<li class="room-player-item room-player-item--empty">Waiting for players…</li>';

  applyBoardRules(room.rules, { isHost });

  $('boardJoinPicker')?.classList.toggle('hidden', !needsJoin);
  $('boardWaitingSlots')?.classList.toggle('hidden', needsJoin);
  $('boardLaunchBtn')?.classList.toggle('hidden', !isHost);

  const launchBtn = $('boardLaunchBtn');
  const launchHint = $('boardLaunchHint');
  if (isHost) {
    launchBtn?.toggleAttribute('disabled', !canLaunch || gameStarted);
    launchHint?.classList.toggle('hidden', canLaunch);
    if (launchHint && !canLaunch) {
      if (humans < minHumans) {
        launchHint.textContent = allowBots
          ? 'Need at least 1 player (bots can fill the rest).'
          : humans < 2 && humanoids < 1
            ? 'Need another player — or wait for a traveler to join.'
            : `Waiting for players (${total}/${room.maxPlayers})…`;
      } else if (!full) {
        launchHint.textContent = allowBots
          ? `Filling seats… ${total}/${room.maxPlayers}`
          : `Waiting for players (${humans}/${room.maxPlayers})…`;
      } else {
        launchHint.textContent = 'Need at least 2 players to start.';
      }
    }
  } else {
    launchHint?.classList.add('hidden');
  }

  const mapName = boardName(room.rules?.per);
  const title = $('boardWaitTitle');
  const sub = $('boardWaitSub');
  if (needsJoin) {
    if (title) title.textContent = full ? 'Room is full' : 'Join this game';
    if (sub) sub.textContent = full
      ? 'All seats are taken.'
      : `${mapName} · pick your token`;
    $('boardJoinBtn')?.toggleAttribute('disabled', full);
    renderBoardJoinColors(room);
  } else if (isHost) {
    if (title) title.textContent = canLaunch ? 'Ready to launch' : 'Waiting for players';
    if (sub) sub.textContent = canLaunch
      ? `${mapName} · all seats filled`
      : room.private
        ? 'Share the invite link with friends'
        : 'Public room — players can join from All rooms on the home page';
  } else {
    if (title) title.textContent = 'In the lobby';
    if (sub) sub.textContent = 'Waiting for the admin to launch';
  }
}

async function createLobbyRoom() {
  if (gamePausedAway) {
    alert(gameStarted
      ? 'You have a game in progress. Tap "Return to game" on the right to continue.'
      : 'You are still in a room. Tap "Return to room" on the right to go back.');
    return;
  }
  const u = await ensureUser();
  if (!u) return;
  try {
    const { room } = await roomsApi.create({
      private: $('roomPrivate')?.checked ?? false,
      rules: gatherRules(),
      maxPlayers,
      emoji: hostEmoji,
      color: hostColor,
    });
    if (room.private) history.replaceState(null, '', roomLink(room.id));
    enterBoardLobby(room);
    renderRoomList();
  } catch (e) {
    alert(e.message || 'Could not create room');
  }
}

async function joinRoom(id) {
  if (gamePausedAway) {
    alert(gameStarted
      ? 'You have a game in progress. Tap "Return to game" on the right to continue.'
      : 'You are still in a room. Tap "Return to room" on the right to go back.');
    return;
  }
  const u = await ensureUser();
  if (!u) return;
  id = String(id || '').trim().toLowerCase();
  try {
    const { room: existing } = await roomsApi.get(id);
    if (existing.kicked?.reason === 'admin') {
      alert('The admin removed you from this room.');
      return;
    }
    const alreadyIn = existing.slots.some(s => s?.userId === u.id);
    if (alreadyIn) {
      enterBoardLobby(existing);
      return;
    }
    const full = existing.slots.every(Boolean);
    if (full) {
      enterBoardLobby(existing);
      return;
    }
    const { room } = await roomsApi.join(id, { emoji: boardJoinEmoji, color: boardJoinColor });
    history.replaceState(null, '', roomLink(id));
    enterBoardLobby(room);
  } catch (e) {
    const msg = e.message === 'removed'
      ? 'The admin removed you from this room.'
      : (e.message || 'Could not join room');
    alert(msg);
  }
}

async function kickLobbyMember(slotIndex) {
  if (!currentRoomId || gameStarted) return;
  try {
    const { room } = await roomsApi.kick(currentRoomId, slotIndex);
    renderBoardLobby(room);
  } catch (e) {
    alert(e.message || 'Could not remove player');
  }
}

async function confirmBoardJoin() {
  if (!currentRoomId) return;
  const u = await ensureUser();
  if (!u) return;
  try {
    const { room: pre } = await roomsApi.get(currentRoomId);
    const taken = takenColorsFromRoom(pre);
    const color = pickAvailableColor(boardJoinColor, taken);
    const { room } = await roomsApi.join(currentRoomId, {
      emoji: boardJoinEmoji,
      color,
    });
    boardJoinColor = color;
    history.replaceState(null, '', roomLink(currentRoomId));
    renderBoardLobby(room);
  } catch (e) {
    const msg = e.message === 'removed'
      ? 'The admin removed you from this room.'
      : (e.message || 'Could not join');
    alert(msg);
  }
}

async function launchWaitingRoom() {
  if (!currentRoomId || gameStarted) return;
  const btn = $('boardLaunchBtn');
  if (btn?.disabled) return;
  btn?.setAttribute('disabled', 'true');
  try {
    const payload = await roomsApi.launch(currentRoomId);
    startFromPayload(payload);
  } catch (e) {
    btn?.toggleAttribute('disabled', false);
    alert(e.message || 'Could not launch');
  }
}

async function quickPlayPublic() {
  if (gamePausedAway) {
    alert(gameStarted
      ? 'You have a game in progress. Tap "Return to game" on the right to continue.'
      : 'You are still in a room. Tap "Return to room" on the right to go back.');
    return;
  }
  const u = await ensureUser();
  if (!u) return;
  const btn = $('quickPlayBtn');
  btn?.setAttribute('disabled', '');
  try {
    const rules = { ...gatherRules(), allowBots: false };
    const { room, created } = await roomsApi.quickJoin({
      rules,
      maxPlayers: 2,
      emoji: hostEmoji,
      color: hostColor,
    });
    enterBoardLobby(room);
    roomsPanelOpen = true;
    renderRoomList();
    const sub = $('boardWaitSub');
    if (sub && created) {
      sub.textContent = 'Public room — waiting for players. Others can join from All rooms.';
    }
  } catch (e) {
    alert(e.message || 'Could not join a public game. Try again.');
  } finally {
    btn?.removeAttribute('disabled');
  }
}

function updateBoardLinkUI(roomId) {
  const link = roomLink(roomId);
  const input = $('boardRoomLink');
  if (input) input.value = link;
}

async function copyBoardLink() {
  const link = $('boardRoomLink')?.value || roomLink(currentRoomId || '');
  try {
    await navigator.clipboard.writeText(link);
    const btn = $('boardCopyLink');
    const lbl = btn?.querySelector('.room-share__copy-label');
    if (lbl) {
      const prev = lbl.textContent;
      lbl.textContent = 'Copied!';
      setTimeout(() => { lbl.textContent = prev; }, 2000);
    }
  } catch {
    $('boardRoomLink')?.select();
  }
}

function updateAdvHints() {
  const diff = document.querySelector('.diff-chip.on')?.dataset.val || 'classic';
  const cash = document.querySelector('.cash-chip.on')?.dataset.val || '2000';
  const salary = document.querySelector('.salary-chip.on')?.dataset.val || '300';
  const dh = $('diffHint');
  const ch = $('cashHint');
  const sh = $('salaryHint');
  if (dh) dh.textContent = DIFF_HINTS[diff] || DIFF_HINTS.classic;
  if (ch) ch.textContent = CASH_HINTS[cash] || CASH_HINTS[2000];
  if (sh) sh.textContent = SALARY_HINTS[salary] || SALARY_HINTS[300];
}

function bindChipGroup(selector, onPick) {
  document.querySelectorAll(selector).forEach(ch => {
    ch.onclick = () => {
      if (ch.disabled) return;
      const group = ch.closest('.pick-row, .glass-seg') || document;
      group.querySelectorAll(selector).forEach(x => x.classList.remove('on'));
      ch.classList.add('on');
      onPick?.(ch);
    };
  });
}

function updateSizeInfo(statsFn) {
  const el = $('sizeInfo');
  if (!el) return;
  const tag = boardTagline(chosenPer);
  const stats = statsFn ? statsFn(chosenPer) : '';
  el.textContent = tag ? `${boardName(chosenPer)} — ${tag}. ${stats}` : stats;
}

function showTokGrid(btn, onPick) {
  if (tokGridEl) tokGridEl.remove();
  tokGridEl = document.createElement('div');
  tokGridEl.className = 'tokgrid';
  TOKEN_EMOJI.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    if (e === btn.textContent) b.classList.add('on');
    b.onclick = ev => {
      ev.stopPropagation();
      btn.textContent = e;
      onPick?.(e);
      tokGridEl.remove();
      tokGridEl = null;
    };
    tokGridEl.appendChild(b);
  });
  const r = btn.getBoundingClientRect();
  tokGridEl.style.left = `${Math.min(r.left, innerWidth - 260)}px`;
  tokGridEl.style.top = `${r.bottom + 6}px`;
  document.body.appendChild(tokGridEl);
}

function renderHostTraveler() {
  const wrap = $('hostTraveler');
  if (!wrap) return;
  const u = getUser();
  wrap.innerHTML = '';
  wrap.style.setProperty('--pc', hostColor);
  wrap.className = 'traveler-card';
  wrap.innerHTML = `
    <button type="button" class="traveler-card__token" style="--pc:${hostColor}">${hostEmoji}</button>
    <p class="traveler-card__name">${esc(u?.name || guestName())}</p>
    <p class="traveler-card__sub">Pick your token &amp; color</p>
    <div class="traveler-card__colors"></div>`;
  const sw = wrap.querySelector('.traveler-card__colors');
  BRIGHT_COLORS.forEach(c => {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'traveler-color' + (c === hostColor ? ' on' : '');
    s.style.background = c;
    s.setAttribute('aria-label', `Color ${c}`);
    s.onclick = () => {
      sw.querySelectorAll('.traveler-color').forEach(x => x.classList.remove('on'));
      s.classList.add('on');
      hostColor = c;
      wrap.style.setProperty('--pc', c);
      wrap.querySelector('.traveler-card__token')?.style.setProperty('--pc', c);
    };
    sw.appendChild(s);
  });
  wrap.querySelector('.traveler-card__token').onclick = ev => {
    ev.stopPropagation();
    showTokGrid(wrap.querySelector('.traveler-card__token'), e => { hostEmoji = e; });
  };
}

function syncPrivateHint() {
  const on = $('roomPrivate')?.checked ?? false;
  $('privateCreateHint')?.classList.toggle('hidden', !on);
}

const ROOM_SESSION_KEY = 'ma_active_room';
const LOBBY_VIEW_KEY = 'ma_lobby_view';
const REJOIN_GRACE_MS = 2 * 60 * 1000;
let pendingInviteRoomId = null;
let rejoinTimerInterval = null;
let pendingRejoinRoom = null;

function resetGameSession() {
  gameStarted = false;
  gameMultiplayer = false;
  gamePausedAway = false;
  $('hud')?.classList.add('hidden');
  $('scene')?.classList.add('hidden');
  $('roomLobby')?.classList.add('hidden');
  $('winModal')?.classList.add('hidden');
  document.body.classList.remove('room-lobby-mode');
  setGameBrandVisible(false);
  detachMultiplayer();
  disconnectRoomSocket();
  currentRoomId = null;
  sessionStorage.removeItem(ROOM_SESSION_KEY);
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url.pathname + url.search);
  $('lobby')?.classList.remove('hidden');
  $('hubTop')?.classList.remove('hidden');
  updateReturnToGameBtn();
}

export async function leaveActiveGame() {
  if (!gameStarted) return;
  if (!confirm('Leave this game? You forfeit your properties and return to the home screen.')) return;

  const { forfeitLocalHuman } = await import('../game/engine.js');
  forfeitLocalHuman();

  const rid = currentRoomId;
  if (rid) {
    try { await roomsApi.leave(rid); } catch { /* room gone */ }
  }

  resetGameSession();
  showView('home');
  renderRoomList();
}

export async function playAgainAfterGame() {
  $('winModal')?.classList.add('hidden');
  $('hud')?.classList.add('hidden');
  $('scene')?.classList.add('hidden');
  setGameBrandVisible(false);
  gameStarted = false;
  gamePausedAway = false;
  updateReturnToGameBtn();
  detachMultiplayer();

  const rid = (currentRoomId || sessionStorage.getItem(ROOM_SESSION_KEY) || '').toLowerCase();
  if (!rid) {
    $('lobby')?.classList.remove('hidden');
    $('hubTop')?.classList.remove('hidden');
    showView('home');
    return;
  }

  try {
    const { room } = await roomsApi.rematch(rid);
    currentRoomId = room.id;
    const u = getUser();
    const inRoom = room.slots?.some(s => s?.userId === u?.id);
    const others = room.slots?.filter(s => s && s.userId !== u?.id).length || 0;
    if (inRoom) {
      enterBoardLobby(room);
      return;
    }
  } catch { /* room gone */ }

  currentRoomId = null;
  sessionStorage.removeItem(ROOM_SESSION_KEY);
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url.pathname + url.search);
  $('lobby')?.classList.remove('hidden');
  $('hubTop')?.classList.remove('hidden');
  showView('home');
}

export function setGameBrandVisible(on) {
  const el = $('gameBrand');
  if (!el) return;
  el.classList.toggle('hidden', !on);
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
}

function isInRoomLobby() {
  return !!(currentRoomId && !$('roomLobby')?.classList.contains('hidden'));
}

function isInActiveSession() {
  return gameStarted || isInRoomLobby();
}

function updateReturnToGameBtn() {
  const btn = $('returnToGameBtn');
  if (!btn) return;
  btn.classList.toggle('hidden', !gamePausedAway);
  const label = btn.querySelector('.return-game-btn__label');
  if (label) {
    label.textContent = gameStarted ? 'Return to game' : 'Return to room';
  }
  btn.setAttribute('aria-label', gameStarted ? 'Return to game' : 'Return to room');
}

function pauseSessionToHome() {
  if (!isInActiveSession()) {
    showView('home');
    return;
  }
  if (gameStarted && currentRoomId) {
    roomsApi.markAbsent(currentRoomId).catch(() => {});
  }
  gamePausedAway = true;
  $('hud')?.classList.add('hidden');
  $('scene')?.classList.add('hidden');
  $('roomLobby')?.classList.add('hidden');
  document.body.classList.remove('room-lobby-mode');
  setGameBrandVisible(false);
  $('lobby')?.classList.remove('hidden');
  $('hubTop')?.classList.remove('hidden');
  showView('home');
  updateReturnToGameBtn();
}

function resumePausedSession() {
  if (!gamePausedAway) return;
  gamePausedAway = false;
  updateReturnToGameBtn();
  $('lobby')?.classList.add('hidden');
  $('hubTop')?.classList.add('hidden');
  $('scene')?.classList.remove('hidden');
  if (gameStarted) {
    $('hud')?.classList.remove('hidden');
    setGameBrandVisible(true);
  } else if (currentRoomId) {
    $('roomLobby')?.classList.remove('hidden');
    document.body.classList.add('room-lobby-mode');
    setGameBrandVisible(true);
  }
}

function handleBrandClick(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  pauseSessionToHome();
}

function roomIdFromUrl() {
  const raw = new URLSearchParams(location.search).get('room');
  return raw ? raw.trim().toLowerCase() : null;
}

function persistRoomInUrl(id) {
  if (!id) return;
  history.replaceState(null, '', roomLink(id));
  sessionStorage.setItem(ROOM_SESSION_KEY, id);
}

function stopRejoinTimer() {
  if (rejoinTimerInterval) {
    clearInterval(rejoinTimerInterval);
    rejoinTimerInterval = null;
  }
  pendingRejoinRoom = null;
}

function formatRejoinCountdown(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function rejoinSecondsLeft(room) {
  if (room.rejoinUntil) return Math.max(0, room.rejoinUntil - Date.now());
  if (room.rejoinSecondsLeft != null) return room.rejoinSecondsLeft * 1000;
  return REJOIN_GRACE_MS;
}

function hideInviteCard() {
  stopRejoinTimer();
  $('roomInviteCard')?.classList.remove('room-invite-card--rejoin');
  $('roomInviteTimer')?.classList.add('hidden');
  $('roomInviteCard')?.classList.add('hidden');
}

function dismissInviteCard() {
  hideInviteCard();
  pendingInviteRoomId = null;
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url.pathname + url.search);
  sessionStorage.removeItem(ROOM_SESSION_KEY);
}

async function ensureUserForRoom() {
  const u = getUser();
  if (u && getToken()) return u;
  setRemember($('rememberMe')?.checked ?? true);
  try {
    return await continueAsGuest(guestName() || 'Guest');
  } catch {
    alert('Could not connect to the server. Check your internet and try again.');
    return null;
  }
}

function wasPlayerInRoom(room, userId) {
  if (!userId) return false;
  return room.slots?.some(s => s?.userId === userId)
    || room.players?.some(p => p.userId === userId);
}

function canRejoinRoom(room, userId) {
  if (room.status !== 'playing' || !wasPlayerInRoom(room, userId)) return false;
  if (room.kicked) return false;
  const gp = room.gameState?.players?.find(p => p.userId === userId);
  if (gp?.dead) return false;
  if (room.rejoinUntil && Date.now() > room.rejoinUntil) return false;
  return true;
}

function rejoinBlockedMessage(room) {
  if (room.kicked?.reason === 'vote') {
    return 'Your teammates vote-kicked you from this game.';
  }
  if (room.kicked?.reason === 'leave') {
    return 'You left this game.';
  }
  if (room.kicked || (room.rejoinUntil && Date.now() > room.rejoinUntil)) {
    return 'Your 2-minute rejoin window expired — you were removed from the game.';
  }
  const gp = room.gameState?.players?.find(p => p.userId === getUser()?.id);
  if (gp?.dead) return 'You are no longer in this game.';
  return 'This game ended or is no longer available.';
}

function updateRejoinTimerDisplay(room) {
  const left = rejoinSecondsLeft(room);
  const val = $('roomInviteTimerVal');
  if (val) val.textContent = formatRejoinCountdown(left);
  return left;
}

function showRejoinCard(room) {
  pendingRejoinRoom = room;
  pendingInviteRoomId = room.id;
  const card = $('roomInviteCard');
  card?.classList.add('room-invite-card--rejoin');
  $('roomInviteEyebrow').textContent = 'Your game is waiting';
  const idEl = $('roomInviteId');
  if (idEl) idEl.textContent = room.id;
  $('roomInviteSub').textContent = 'Get back in before time runs out or you\'ll be removed from the match.';
  $('roomInviteTimer')?.classList.remove('hidden');
  const label = $('roomInviteEnter')?.querySelector('.home-play__label');
  if (label) label.textContent = 'Back into game';
  $('roomInviteEnter')?.removeAttribute('disabled');
  card?.classList.remove('hidden');
  $('lobby')?.classList.remove('hidden');
  showView('home');
  updateRejoinTimerDisplay(room);
  stopRejoinTimer();
  rejoinTimerInterval = setInterval(async () => {
    const r = pendingRejoinRoom;
    if (!r) return;
    const left = updateRejoinTimerDisplay(r);
    if (left <= 0) {
      stopRejoinTimer();
      $('roomInviteSub').textContent = rejoinBlockedMessage({ rejoinUntil: Date.now() - 1 });
      $('roomInviteTimer')?.classList.add('hidden');
      $('roomInviteEnter')?.setAttribute('disabled', '');
      return;
    }
    if (left % 10000 < 1000) {
      try {
        const { room: fresh } = await roomsApi.get(r.id);
        pendingRejoinRoom = fresh;
        if (!canRejoinRoom(fresh, getUser()?.id)) {
          stopRejoinTimer();
          $('roomInviteSub').textContent = rejoinBlockedMessage(fresh);
          $('roomInviteTimer')?.classList.add('hidden');
          $('roomInviteEnter')?.setAttribute('disabled', '');
        }
      } catch { /* keep counting */ }
    }
  }, 1000);
}

async function rejoinActiveGame(room) {
  const u = getUser();
  if (!u || !onStartGame) return false;
  try {
    const { room: fresh } = await roomsApi.rejoin(room.id);
    room = fresh;
  } catch (e) {
    const msg = e.message === 'vote-kicked'
      ? 'Your teammates vote-kicked you from this game.'
      : e.message === 'rejoin-expired'
        ? 'Your 2-minute rejoin window expired — you were removed from the game.'
        : (e.message || 'Could not rejoin this game.');
    showInviteError(room.id, msg, true);
    return false;
  }
  hideInviteCard();
  gameStarted = true;
  currentRoomId = room.id;
  prevSlotSnapshot = null;
  persistRoomInUrl(room.id);
  $('lobby')?.classList.add('hidden');
  $('hubTop')?.classList.add('hidden');
  $('roomLobby')?.classList.add('hidden');
  document.body.classList.remove('room-lobby-mode');
  setGameBrandVisible(true);

  const adminId = room.adminId ?? 0;
  const humans = (room.players || []).filter(p => !p.bot).length;
  const players = (room.players || []).map((p, i) => ({
    userId: p.userId,
    name: p.userId === u.id ? u.name : p.name,
    bot: !!p.bot,
    emoji: p.emoji,
    color: p.color,
    isAdmin: i === adminId || p.userId === room.hostId,
  }));

  subscribeRoom(room.id);
  gameMultiplayer = humans > 1;
  onStartGame({ rules: room.rules, players, adminId, multiplayer: gameMultiplayer });
  if (gameMultiplayer) enableMultiplayer(roomSocket, room.id);
  subscribeWhenOpen(roomSocket, { type: 'subscribe', roomId: room.id });
  if (room.gameState) applyGameState(room.gameState);
  return true;
}

async function openInviteRoom() {
  const id = (pendingInviteRoomId || roomIdFromUrl() || sessionStorage.getItem(ROOM_SESSION_KEY) || '').toLowerCase();
  if (!id) return;
  const u = await ensureUserForRoom();
  if (!u) return;
  try {
    const { room } = await roomsApi.get(id);
    if (canRejoinRoom(room, u.id)) {
      await rejoinActiveGame(pendingRejoinRoom || room);
      return;
    }
    if (room.status !== 'lobby') {
      showInviteError(id, rejoinBlockedMessage(room), true);
      return;
    }
    const inRoom = room.slots.some(s => s?.userId === u.id);
    if (room.slots.every(Boolean) && !inRoom) {
      alert('This room is full — all player seats are taken.');
      return;
    }
    enterBoardLobby(room);
  } catch (e) {
    alert(e.message || 'Room not found. Ask the host for a new link (rooms reset if the server restarted).');
  }
}

function showInviteCard(id, message, { rejoin = false, disableEnter = false } = {}) {
  stopRejoinTimer();
  pendingInviteRoomId = id;
  $('roomInviteCard')?.classList.toggle('room-invite-card--rejoin', rejoin);
  $('roomInviteEyebrow').textContent = rejoin ? 'Your game is waiting' : 'Game invite';
  $('roomInviteTimer')?.classList.toggle('hidden', !rejoin);
  const idEl = $('roomInviteId');
  if (idEl) idEl.textContent = id;
  const sub = $('roomInviteSub');
  if (sub) sub.textContent = message;
  const enterBtn = $('roomInviteEnter');
  const label = enterBtn?.querySelector('.home-play__label');
  if (label) label.textContent = rejoin ? 'Back into game' : 'Enter room';
  if (disableEnter) enterBtn?.setAttribute('disabled', '');
  else enterBtn?.removeAttribute('disabled');
  $('roomInviteCard')?.classList.remove('hidden');
  $('lobby')?.classList.remove('hidden');
  showView('home');
}

function showInviteError(id, message, disableEnter = false) {
  showInviteCard(id, message, { disableEnter });
}

async function handleRoomDeepLink() {
  let id = roomIdFromUrl() || sessionStorage.getItem(ROOM_SESSION_KEY);
  if (!id) {
    hideInviteCard();
    pendingInviteRoomId = null;
    return false;
  }
  id = id.toLowerCase();

  if (currentRoomId === id && !$('roomLobby')?.classList.contains('hidden')) {
    return true;
  }

  if (!roomIdFromUrl()) persistRoomInUrl(id);

  if (!getToken()) {
    await ensureUserForRoom();
  }

  if (!getToken()) {
    showInviteError(id, 'Enter your name or sign in, then tap Enter room.');
    return false;
  }

  try {
    const { room } = await roomsApi.get(id);
    const u = getUser();
    const inRoom = !!u && room.slots.some(s => s?.userId === u.id);
    if (canRejoinRoom(room, u?.id)) {
      showRejoinCard(room);
      const nav = performance.getEntriesByType?.('navigation')?.[0];
      if (nav?.type === 'reload') {
        await rejoinActiveGame(room);
        return true;
      }
      return true;
    }
    if (room.status !== 'lobby') {
      showInviteError(id, rejoinBlockedMessage(room), true);
      return false;
    }
    if (room.slots.every(Boolean) && !inRoom) {
      showInviteError(id, 'This room is full — all player seats are taken.', true);
      return false;
    }
    enterBoardLobby(room);
    return true;
  } catch {
    showInviteError(
      id,
      'Room not found or expired. The server may have restarted — ask the host for a new link.',
      true,
    );
    return false;
  }
}

export async function initLobby(startGame, boardStats, previewBoard) {
  onStartGame = startGame;
  onPreviewBoard = previewBoard;
  document.body.classList.add('lobby-booting');

  const rememberBox = $('rememberMe');
  if (rememberBox) rememberBox.checked = getRemember();
  rememberBox?.addEventListener('change', () => setRemember(rememberBox.checked));

  await restoreSession();
  renderAuthBar();
  renderHostTraveler();
  renderBoardJoinColors();
  initGoogleSignIn();
  initAccount({ navigate: showView });

  onAuthChange(() => {
    renderAuthBar();
    renderHostTraveler();
    $('authGate')?.classList.add('hidden');
    handleRoomDeepLink();
  });

  bindChipGroup('.szchip', ch => {
    if (ch.dataset.per === 'custom') {
      $('customSize')?.classList.remove('hidden');
      chosenPer = +$('szRange')?.value || 12;
    } else {
      $('customSize')?.classList.add('hidden');
      chosenPer = +ch.dataset.per;
    }
    updateSizeInfo(boardStats);
  });
  bindChipGroup('.diff-chip', updateAdvHints);
  bindChipGroup('.cash-chip', updateAdvHints);
  bindChipGroup('.salary-chip', updateAdvHints);
  updateAdvHints();
  bindChipGroup('.max-chip', ch => { maxPlayers = +ch.dataset.max; });
  bindChipGroup('.board-sz', () => scheduleRulesSave());
  bindChipGroup('.board-cash', () => scheduleRulesSave());
  bindChipGroup('.board-sal', () => scheduleRulesSave());

  $('szRange')?.addEventListener('input', () => {
    chosenPer = +$('szRange').value;
    const lbl = $('szLabel');
    if (lbl) lbl.textContent = boardName(chosenPer);
    updateSizeInfo(boardStats);
  });

  $('rulePowerCards')?.addEventListener('change', () => {
    $('powerPreview')?.classList.toggle('hidden', !$('rulePowerCards')?.checked);
  });

  document.querySelectorAll('.board-rule').forEach(inp => {
    inp.addEventListener('change', scheduleRulesSave);
  });

  updateSizeInfo(boardStats);

  $('homeNameInput')?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (!$('roomInviteCard')?.classList.contains('hidden')) $('roomInviteEnter')?.click();
    else $('quickPlayBtn')?.click();
  });
  const stopBubble = e => e.stopPropagation();
  $('homePlayAs')?.addEventListener('mousedown', stopBubble);
  $('homeNameInput')?.addEventListener('mousedown', stopBubble);
  $('homeNameInput')?.addEventListener('click', stopBubble);

  $('authSignOut')?.addEventListener('click', signOut);
  $('startBtn')?.addEventListener('click', createLobbyRoom);
  $('quickPlayBtn')?.addEventListener('click', quickPlayPublic);

  const openCreate = async ({ privateRoom = true } = {}) => {
    if (!(await ensureUser())) return;
    const priv = $('roomPrivate');
    if (priv) priv.checked = privateRoom;
    syncPrivateHint();
    renderHostTraveler();
    showView('create');
  };
  $('lobbyNewRoom')?.addEventListener('click', () => openCreate({ privateRoom: true }));
  $('roomPrivate')?.addEventListener('change', syncPrivateHint);
  syncPrivateHint();
  $('homeAllRooms')?.addEventListener('click', () => {
    roomsPanelOpen = true;
    renderRoomList();
    $('publicRoomsSection')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('lobbyBackCreate')?.addEventListener('click', () => showView('home'));
  $('gameBrand')?.addEventListener('click', handleBrandClick);
  $('returnToGameBtn')?.addEventListener('click', resumePausedSession);
  document.addEventListener('click', e => {
    if (e.target.closest('#hubLogo')) handleBrandClick(e);
  });
  $('hubTop')?.querySelector('.hub-top__brand')?.addEventListener('click', () => {
    if (gamePausedAway) return;
    if (isInActiveSession()) pauseSessionToHome();
    else showView('home');
  });
  $('boardLeaveBtn')?.addEventListener('click', async () => {
    const rid = currentRoomId;
    if (rid) {
      try { await roomsApi.leave(rid); } catch { /* room gone */ }
    }
    exitBoardLobby();
    showView('home');
    renderRoomList();
  });
  $('leaveGameBtn')?.addEventListener('click', () => leaveActiveGame());
  $('roomRefresh')?.addEventListener('click', () => {
    roomsPanelOpen = true;
    renderRoomList();
    $('roomRefresh')?.classList.add('spin-once');
    setTimeout(() => $('roomRefresh')?.classList.remove('spin-once'), 600);
  });
  $('boardLaunchBtn')?.addEventListener('click', launchWaitingRoom);
  $('boardCopyLink')?.addEventListener('click', copyBoardLink);
  $('boardJoinBtn')?.addEventListener('click', confirmBoardJoin);
  $('boardPlayerList')?.addEventListener('click', e => {
    const btn = e.target.closest('.room-player-kick');
    if (!btn) return;
    e.preventDefault();
    kickLobbyMember(+btn.dataset.slot);
  });
  $('boardJoinToken')?.addEventListener('click', ev => {
    ev.stopPropagation();
    showTokGrid($('boardJoinToken'), e => { boardJoinEmoji = e; });
  });
  $('authGateOk')?.addEventListener('click', () => $('authGate')?.classList.add('hidden'));

  document.addEventListener('click', () => {
    if (tokGridEl) { tokGridEl.remove(); tokGridEl = null; }
  });

  $('roomInviteEnter')?.addEventListener('click', openInviteRoom);
  $('roomInviteDismiss')?.addEventListener('click', dismissInviteCard);

  window.addEventListener('beforeunload', () => {
    if (gameStarted && currentRoomId) markAbsentKeepalive(currentRoomId);
  });
  window.addEventListener('pagehide', () => {
    if (gameStarted && currentRoomId) markAbsentKeepalive(currentRoomId);
  });

  renderRoomList();

  setInterval(() => {
    if (!$('lobbyHome')?.classList.contains('hidden')) renderRoomList();
  }, 5000);

  const inRoom = await handleRoomDeepLink();
  if (!inRoom && $('roomLobby')?.classList.contains('hidden')) {
    const saved = sessionStorage.getItem(LOBBY_VIEW_KEY);
    const hasRoom = roomIdFromUrl() || sessionStorage.getItem(ROOM_SESSION_KEY);
    if (!hasRoom && saved && saved !== 'home') showView(saved);
    else showView('home');
  }

  document.body.classList.remove('lobby-booting');
}
