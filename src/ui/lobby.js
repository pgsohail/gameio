import { $, fmt } from '../lib/format.js';
import { wireDiscordLinks } from '../lib/community.js';
import { BRIGHT_COLORS } from '../lib/colors.js';
import {
  continueAsGuest, getRemember, getUser, initGoogleSignIn,
  onAuthChange, restoreSession, setRemember, signOut,
} from '../lib/auth.js';
import {
  connectRoomSocket, getToken, markAbsentKeepalive, roomLink, roomsApi, sendRoomSocket, subscribeWhenOpen,
} from '../lib/api.js';
import {
  enableMultiplayer, enableSpectator, detachMultiplayer, handleSocketMessage, handleDiceRollMessage, applyGameState,
} from '../lib/multiplayer.js';
import { initAccount, renderHub, renderProfilePage } from './account.js';
import { boardName, boardTagline } from '../lib/boards.js';
import { playPlayerJoin, playPlayerLeave, playBotJoin, playChatPing } from '../lib/sounds.js';
import { setGameBrandVisible } from '../lib/gameShell.js';

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

let chosenPer = 10;
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
let gameSpectating = false;
let gamePausedAway = false;
let wsReconnectTimer = null;
let lobbyPollTimer = null;
let prevSlotSnapshot = null;
let lobbyWasSeated = false;
let botSoundQueue = 0;

const DIFF_HINTS = {
  relaxed: 'Easygoing rivals and patient auction pacing.',
  classic: 'Balanced competition and standard pacing.',
  shark: 'Ruthless bidding and fast build-ups.',
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

function formatRoomCode(id) {
  const code = String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6).toUpperCase();
  if (!code) return '------';
  if (code.length <= 3) return code;
  return `${code.slice(0, 3)}·${code.slice(3)}`;
}

function roomCodeMarkup(id, { mini = false, compact = false } = {}) {
  const raw = String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6).toUpperCase();
  if (!raw) {
    return '<span class="room-code room-code--empty">------</span>';
  }
  const a = raw.slice(0, 3);
  const b = raw.slice(3);
  const cls = `room-code${mini ? ' room-code--mini' : ''}${compact ? ' room-code--compact' : ''}`;
  const tail = b
    ? `<span class="room-code__dot">·</span><span class="room-code__seg">${esc(b)}</span>`
    : '';
  return `<span class="${cls}"><span class="room-code__hash">#</span><span class="room-code__seg">${esc(a)}</span>${tail}</span>`;
}

function setRoomCodeEl(el, id, opts) {
  if (!el) return;
  el.innerHTML = roomCodeMarkup(id, opts);
}

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

function openSeatsInRoom(r) {
  return r.openSeats ?? r.slots?.filter(s => !s).length ?? 0;
}

function isJoinableOpenRoom(r) {
  if (!r || r.private) return false;
  if (r.status !== 'lobby') return false;
  return openSeatsInRoom(r) > 0;
}

function isPublicLobbyRoom(r) {
  if (!r || r.private) return false;
  return r.status === 'lobby';
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
  if (inLobby && !$('lobby')?.classList.contains('hidden')) refreshLiveStats();
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

let lobbyChatMessages = [];
let lobbyChatMuted = false;
let chatCollapsed = false;
let lobbyCanSendChat = false;
let myChatProfile = { name: '', emoji: '🚂', color: '#3D5AFE' };

function syncMyChatProfile(profile) {
  if (!profile) return;
  myChatProfile = {
    name: profile.name || myChatProfile.name,
    emoji: profile.emoji || myChatProfile.emoji,
    color: profile.color || myChatProfile.color,
  };
}

function clearLobbyChat() {
  lobbyChatMessages = [];
  lobbyCanSendChat = false;
  renderLobbyChatFeed();
  syncLobbyChatCompose(false);
}

function setLobbyChatHistory(messages) {
  lobbyChatMessages = Array.isArray(messages) ? [...messages] : [];
  renderLobbyChatFeed();
}

function appendLobbyChatMessage(msg, { silent = false } = {}) {
  if (!msg?.text) return;
  const u = getUser();
  const optIdx = lobbyChatMessages.findIndex(m =>
    m.pending && m.userId === msg.userId && m.text === msg.text);
  if (optIdx >= 0) {
    lobbyChatMessages[optIdx] = { ...msg, pending: false };
    renderLobbyChatFeed(true);
    return;
  }
  if (msg.id && lobbyChatMessages.some(m => m.id === msg.id)) return;
  lobbyChatMessages.push(msg);
  if (lobbyChatMessages.length > 100) lobbyChatMessages = lobbyChatMessages.slice(-100);
  renderLobbyChatFeed(true);
  if (!silent && !lobbyChatMuted && u && msg.userId !== u.id) playChatPing();
  requestAnimationFrame(() => {
    const feed = $('lobbyChatFeed');
    if (feed) feed.scrollTop = feed.scrollHeight;
  });
}

function syncLobbyChatCompose(canSend) {
  lobbyCanSendChat = !!canSend && !gameSpectating;
  const input = $('lobbyChatInput');
  const send = $('lobbyChatForm')?.querySelector('.chat-panel__send');
  if (input) {
    input.disabled = !lobbyCanSendChat;
    if (gameSpectating) {
      input.placeholder = 'Spectators can read only…';
    } else {
      input.placeholder = canSend ? 'Type a message…' : 'Join the room to chat…';
    }
  }
  if (send) send.disabled = !lobbyCanSendChat;
}

function refreshRoomChatAccess({ inRoom = false } = {}) {
  if (gameSpectating) {
    syncLobbyChatCompose(false);
    return;
  }
  const canSend = !gameSpectating && (!!inRoom || (gameStarted && !!currentRoomId));
  syncLobbyChatCompose(canSend);
}

function showRoomChat(mode = 'lobby') {
  const dock = $('roomChatDock');
  if (!dock) return;
  dock.classList.remove('hidden', 'room-chat-dock--lobby', 'room-chat-dock--game');
  dock.classList.add(mode === 'game' ? 'room-chat-dock--game' : 'room-chat-dock--lobby');
  dock.classList.toggle('room-chat-dock--collapsed', chatCollapsed && mode === 'game');
}

function hideRoomChat() {
  $('roomChatDock')?.classList.add('hidden');
}

function toggleChatCollapsed() {
  chatCollapsed = !chatCollapsed;
  $('roomChatDock')?.classList.toggle('room-chat-dock--collapsed', chatCollapsed);
  const btn = $('lobbyChatCollapse');
  if (btn) {
    btn.title = chatCollapsed ? 'Expand chat' : 'Minimize chat';
    btn.setAttribute('aria-label', chatCollapsed ? 'Expand chat' : 'Minimize chat');
  }
}

function renderLobbyChatFeed(scrollToEnd = false) {
  const feed = $('lobbyChatFeed');
  if (!feed) return;
  const u = getUser();

  if (!lobbyChatMessages.length) {
    feed.innerHTML = '<p class="chat-panel__empty">No messages yet — say hi to the room.</p>';
    return;
  }

  let html = '';
  let prevUserId = null;
  for (const m of lobbyChatMessages) {
    const mine = u && m.userId === u.id;
    const showName = !mine && m.userId !== prevUserId;
    prevUserId = m.userId;
    html += `
      <article class="chat-msg ${mine ? 'chat-msg--out' : 'chat-msg--in'}">
        ${mine ? '' : `<span class="chat-msg__avatar" style="--mc:${esc(m.color || '#888')}">${esc(m.emoji || '🚂')}</span>`}
        <div class="chat-msg__body">
          ${showName ? `<span class="chat-msg__author">${esc(m.name || 'Player')}</span>` : ''}
          <p class="chat-msg__text${m.pending ? ' chat-msg__text--pending' : ''}">${esc(m.text)}</p>
        </div>
      </article>`;
  }

  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
  feed.innerHTML = html;
  if (scrollToEnd || atBottom) feed.scrollTop = feed.scrollHeight;
}

function sendLobbyChatMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !lobbyCanSendChat || !currentRoomId || !roomSocket) return false;
  const u = getUser();
  if (!u) return false;
  const optimistic = {
    id: `opt-${Date.now()}`,
    userId: u.id,
    name: myChatProfile.name || u.name,
    emoji: myChatProfile.emoji,
    color: myChatProfile.color,
    text: trimmed.slice(0, 280),
    at: Date.now(),
    pending: true,
  };
  appendLobbyChatMessage(optimistic, { silent: true });
  const ok = sendRoomSocket(roomSocket, {
    type: 'lobby_chat',
    roomId: currentRoomId,
    text: optimistic.text,
  });
  if (!ok) {
    lobbyChatMessages = lobbyChatMessages.filter(m => m.id !== optimistic.id);
    renderLobbyChatFeed();
  }
  return ok;
}

function handleLobbyChatSubmit(e) {
  e.preventDefault();
  const input = $('lobbyChatInput');
  if (!input || input.disabled) return;
  const text = input.value;
  if (!sendLobbyChatMessage(text)) return;
  input.value = '';
  input.focus();
}

function joinBlockedMessage(err) {
  if (err === 'started') return 'This game has already started. You can no longer join.';
  if (err === 'full') return 'This room is full — all player seats are taken.';
  if (err === 'removed') return 'The admin removed you from this room.';
  if (err === 'private') return 'This is a private room — you need an invite link from the host.';
  return null;
}

function roomUserKicked(room, userId) {
  if (!userId || !room?.kicked) return null;
  if (room.kicked.reason) return room.kicked;
  return room.kicked[userId] || null;
}

function isRoomJoinable(room, userId) {
  if (!room || room.status !== 'lobby') return false;
  if (roomUserKicked(room, userId)) return false;
  if (userId && room.slots?.some(s => s?.userId === userId)) return true;
  return room.slots?.some(s => !s);
}

function syncLobbySeatedFlag(room) {
  const u = getUser();
  lobbyWasSeated = !!(u && room?.slots?.some(s => s?.userId === u.id));
}

let cachedFakePlaying = 0;
let fakePlayingUpdated = 0;
let liveStatsTimer = null;
const LIVE_STATS_POLL_MS = 2000;

function rollFakePlayingCount() {
  if (Math.random() < 0.32) return 100 + Math.floor(Math.random() * 96);
  return 50 + Math.floor(Math.random() * 50);
}

function fakePlayingDisplayCount() {
  const now = Date.now();
  if (!cachedFakePlaying || now - fakePlayingUpdated > 42000 + Math.random() * 36000) {
    cachedFakePlaying = rollFakePlayingCount();
    fakePlayingUpdated = now;
  }
  return cachedFakePlaying;
}

function formatLivePair(humans, rooms) {
  const h = Math.max(0, humans | 0);
  const r = Math.max(0, rooms | 0);
  return `${String(h).padStart(2, '0')}/${String(r).padStart(2, '0')}`;
}

function updateRoomsSectionHeader() {
  const playingEl = $('homePlayingCount');
  if (playingEl) playingEl.textContent = String(fakePlayingDisplayCount());
}

function updateLiveActivityUI(live = {}) {
  const humans = live.humansPlaying ?? 0;
  const rooms = live.activeRooms ?? 0;
  const pair = formatLivePair(humans, rooms);
  const active = humans > 0 || rooms > 0;

  ['lobbyLiveStat1', 'lobbyLiveStat2', 'lobbyLiveStat3', 'lobbyLiveStat4'].forEach(id => {
    const el = $(id);
    if (el) {
      el.textContent = pair;
      el.classList.toggle('lobby-live-stat--active', active);
    }
  });

  updateRoomsSectionHeader();
}

function shouldPollLiveStats() {
  if (document.hidden) return false;
  const lobby = $('lobby');
  if (!lobby || lobby.classList.contains('hidden')) return false;
  if (!$('roomLobby')?.classList.contains('hidden')) return false;
  return true;
}

async function refreshLiveStats() {
  if (!shouldPollLiveStats()) return;
  try {
    const live = await roomsApi.live();
    updateLiveActivityUI(live);
  } catch { /* keep last values */ }
}

function startLiveStatsPoll() {
  if (liveStatsTimer) clearInterval(liveStatsTimer);
  updateLiveActivityUI({});
  updateRoomsSectionHeader();
  refreshLiveStats();
  liveStatsTimer = setInterval(() => {
    refreshLiveStats();
    updateRoomsSectionHeader();
  }, LIVE_STATS_POLL_MS);
}

function stopLiveStatsPoll() {
  if (liveStatsTimer) clearInterval(liveStatsTimer);
  liveStatsTimer = null;
}

async function renderRoomList() {
  const section = $('publicRoomsSection');
  const list = $('roomList');
  const empty = $('homeRoomsEmpty');
  if (!section || !list) return;
  try {
    const { rooms, spectateRooms = [], live = {} } = await roomsApi.list();
    updateLiveActivityUI(live);
    renderSpectateList(spectateRooms, live);
    const lobbyRooms = (rooms || []).filter(isPublicLobbyRoom).sort((a, b) => {
      const aj = openSeatsInRoom(a) > 0 ? 0 : 1;
      const bj = openSeatsInRoom(b) > 0 ? 0 : 1;
      if (aj !== bj) return aj - bj;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const show = roomsPanelOpen;
    section.classList.toggle('home-all-rooms--open', show);
    section.setAttribute('aria-hidden', show ? 'false' : 'true');
    $('homeAllRooms')?.classList.toggle('home-sec--active', show);
    empty?.classList.toggle('hidden', lobbyRooms.length > 0);
    if (!show) return;
    if (!lobbyRooms.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = lobbyRooms.map(r => {
      const open = openSeatsInRoom(r);
      const total = r.maxPlayers || r.slots?.length || 4;
      const filled = total - open;
      const botHost = !!r.humanoidHosted;
      const cash = r.rules?.cash ?? 2000;
      const canJoin = open > 0;
      const waitLabel = canJoin ? `${open} open` : 'Starting soon';
      return `
      <button type="button" class="room-card room-card--join room-card--home${botHost ? ' room-card--bot-host' : ''}${canJoin ? '' : ' room-card--full'}" data-room="${esc(r.id)}"${canJoin ? '' : ' disabled'}>
        <div class="room-card__head">
          <span class="room-card__code">${roomCodeMarkup(r.id, { mini: true })}${botHost ? '<span class="room-card__code-tag">Bot</span>' : ''}</span>
          <span class="room-card__sub">🗺 ${esc(boardLabel(r.rules?.per))} · ${filled}/${total} · ${waitLabel} · ${fmt(cash)}</span>
          <div class="room-card__players">${slotAvatars(r.slots, total)}</div>
        </div>
        <span class="room-card__join-pill">${canJoin ? 'Join' : 'Full'}</span>
      </button>`;
    }).join('');
    list.querySelectorAll('.room-card:not([disabled])').forEach(btn => {
      btn.onclick = () => joinRoom(btn.dataset.room);
    });
  } catch {
    if (roomsPanelOpen) section.classList.remove('hidden');
  }
}

let spectatePanelOpen = false;

function renderSpectateList(rooms = [], live = {}) {
  const section = $('spectateSection');
  const list = $('spectateList');
  const empty = $('spectateEmpty');
  if (!section || !list) return;
  const liveGames = rooms.filter(r => r.status === 'playing' && (r.humans ?? 0) > 0);
  const count = live.publicPlaying ?? liveGames.length;
  const countEl = $('spectateLiveCount');
  if (countEl) countEl.textContent = String(count);
  const show = spectatePanelOpen || liveGames.length > 0;
  section.classList.toggle('hidden', !show);
  empty?.classList.toggle('hidden', liveGames.length > 0);
  if (!liveGames.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = liveGames.map(r => {
    const alive = r.alivePlayers ?? r.players?.length ?? 0;
    const preview = (r.players || []).slice(0, 5).map(p =>
      `<span class="room-card__av" style="--pc:${esc(p.color || '#888')}" title="${esc(p.name)}">${esc(p.emoji || '🚂')}</span>`,
    ).join('');
    return `
      <button type="button" class="room-card room-card--spectate" data-spectate="${esc(r.id)}">
        <div class="room-card__left">
          <span class="room-card__id">${roomCodeMarkup(r.id)}</span>
          <span class="room-card__meta room-card__meta--live">🔴 LIVE · ${alive} playing</span>
          <div class="room-card__slots room-card__slots--preview">${preview}</div>
        </div>
        <div class="room-card__right">
          <span class="room-card__mode">🗺 ${boardLabel(r.rules?.per)}</span>
          <span class="room-card__spectate-btn">👁 Spectate</span>
        </div>
      </button>`;
  }).join('');
  list.querySelectorAll('[data-spectate]').forEach(btn => {
    btn.onclick = () => spectateRoom(btn.dataset.spectate);
  });
}

async function spectateRoom(id) {
  const rid = String(id || '').trim().toLowerCase();
  if (!rid) return;
  const u = await ensureUserForRoom();
  if (!u) return;
  try {
    const { room } = await roomsApi.spectate(rid);
    enterSpectate(room);
  } catch (e) {
    alert(e.message === 'private'
      ? 'This is a private game — you cannot spectate it.'
      : (e.message || 'Could not join as spectator. The game may have ended.'));
    renderRoomList();
  }
}

function enterSpectate(room) {
  stopLiveStatsPoll();
  stopLobbyPoll();
  gameSpectating = true;
  gameStarted = true;
  gameMultiplayer = true;
  gamePausedAway = false;
  currentRoomId = room.id;
  prevSlotSnapshot = null;
  persistRoomInUrl(room.id);
  hideInviteCard();
  $('lobby')?.classList.add('hidden');
  $('hubTop')?.classList.add('hidden');
  $('roomLobby')?.classList.add('hidden');
  document.body.classList.remove('room-lobby-mode');
  setGameBrandVisible(true);
  showRoomChat('game');
  refreshRoomChatAccess({ inRoom: false });
  subscribeRoom(room.id);
  const adminId = room.adminId ?? 0;
  const players = (room.players || []).map((p, i) => ({
    userId: p.userId,
    name: p.name,
    bot: !!p.bot,
    humanoid: !!p.humanoid,
    botBrain: p.botBrain || null,
    emoji: p.emoji,
    color: p.color,
    isAdmin: i === adminId,
  }));
  onStartGame({
    rules: room.rules,
    players,
    adminId,
    multiplayer: true,
    spectating: true,
    skipStartTurn: !!room.gameState,
  });
  enableSpectator(roomSocket, room.id);
  subscribeWhenOpen(roomSocket, { type: 'subscribe', roomId: room.id });
  if (room.gameState) applyGameState(room.gameState);
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
    per: +(document.querySelector('.board-sz.on')?.dataset.per || lastRoomRules?.per || 10),
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
      else handleRoomNoLongerJoinable(room);
    } catch (e) {
      if (e.message === 'started' || e.message === 'private') {
        handleRoomNoLongerJoinable({ id: roomId, status: 'playing' });
      }
      stopLobbyPoll();
    }
  }, 2000);
}

function onRoomSocketMessage(roomId, msg) {
  const u = getUser();
  if (handleDiceRollMessage(msg)) return;
  if (handleSocketMessage(msg, u?.id)) return;
  if (msg.type === 'room_update' && msg.room?.id === roomId) {
    if (msg.room.status === 'lobby') renderBoardLobby(msg.room);
    else handleRoomNoLongerJoinable(msg.room);
  }
  if (msg.type === 'game_start') {
    startFromPayload(msg);
  }
  if (msg.type === 'lobby_chat_history' && msg.roomId === roomId) {
    setLobbyChatHistory(msg.messages);
    return;
  }
  if (msg.type === 'lobby_chat' && msg.roomId === roomId && msg.message) {
    appendLobbyChatMessage(msg.message);
  }
}

function startFromPayload(payload) {
  if (gameStarted) return;
  const u = getUser();
  if (!u || !onStartGame) return;
  stopLobbyPoll();
  stopLiveStatsPoll();
  const adminId = payload.adminId ?? 0;
  const humanCount = payload.players.filter(p => !p.bot).length;
  const isMp = humanCount > 1;
  const inRoomSession = payload.players.length > 1;
  gameStarted = true;
  gameMultiplayer = isMp;
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
  const me = players.find(p => p.userId === u.id);
  if (me) syncMyChatProfile(me);
  if (rid && inRoomSession) {
    showRoomChat('game');
    refreshRoomChatAccess({ inRoom: true });
  } else {
    hideRoomChat();
  }
  $('hubTop')?.classList.add('hidden');
  $('scene')?.classList.remove('hidden');
  persistRoomInUrl(rid);
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
  hideRoomChat();
  clearLobbyChat();
  document.body.classList.remove('game-active', 'spectator-mode');
  startLiveStatsPoll();
  renderRoomList();
}

function enterBoardLobby(room) {
  stopLiveStatsPoll();
  currentRoomId = room.id;
  syncLobbySeatedFlag(room);
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
  showRoomChat('lobby');
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

function handleRoomNoLongerJoinable(room) {
  if (gameStarted) return;
  const u = getUser();
  if (canRejoinRoom(room, u?.id)) {
    void rejoinActiveGame(room);
    return;
  }
  lobbyWasSeated = false;
  const wasMember = wasPlayerInRoom(room, u?.id);
  alert(wasMember
    ? 'This game has already started.'
    : 'This game has already started. You can no longer join.');
  exitBoardLobby();
  showView('home');
  renderRoomList();
}

function renderBoardLobby(room) {
  const u = getUser();
  if (room.status !== 'lobby') {
    handleRoomNoLongerJoinable(room);
    return;
  }
  const inRoom = !!u && room.slots.some(s => s?.userId === u.id);
  const kicked = roomUserKicked(room, u?.id);

  if (!inRoom && kicked?.reason === 'admin') {
    lobbyWasSeated = false;
    alert('The admin removed you from this room.');
    exitBoardLobby();
    showView('home');
    renderRoomList();
    return;
  }

  if (lobbyWasSeated && !inRoom && !gameStarted) {
    lobbyWasSeated = false;
    alert('You are no longer in this room.');
    exitBoardLobby();
    showView('home');
    renderRoomList();
    return;
  }

  if (!inRoom && !room.slots.some(s => !s)) {
    lobbyWasSeated = false;
    alert('This room is full — all player seats are taken.');
    exitBoardLobby();
    showView('home');
    renderRoomList();
    return;
  }

  lobbyWasSeated = inRoom;
  if (inRoom && u) {
    const slot = room.slots.find(s => s?.userId === u.id);
    if (slot) syncMyChatProfile(slot);
  }

  const isHost = u && room.hostId === u.id;
  const full = room.slots.every(Boolean);
  const needsJoin = !inRoom && !full;
  const humans = room.slots.filter(s => s && !s.bot).length;
  const total = room.slots.filter(Boolean).length;
  const allowBots = !!room.rules?.allowBots;
  const humanoids = room.slots.filter(s => s && s.humanoid).length;
  const minHumans = 1;
  const canLaunch = total >= 2 && humans >= minHumans
    && (allowBots || humans >= 2 || humanoids >= 1);

  playLobbySlotSounds(room);

  setRoomCodeEl($('boardRoomCode'), room.id);
  $('boardWaitCount').textContent = `${total} / ${room.maxPlayers} players`;
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
        launchHint.textContent = 'Need at least 1 player in the room.';
      } else if (total < 2) {
        launchHint.textContent = 'Need at least 2 players to start.';
      } else if (!allowBots && humans < 2 && humanoids < 1) {
        launchHint.textContent = 'Need another player, a guest, or enable Fill with bots.';
      } else {
        launchHint.textContent = `Ready — ${total} player${total === 1 ? '' : 's'} (${room.maxPlayers} max). Empty seats stay open.`;
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
      ? `${mapName} · ${total} player${total === 1 ? '' : 's'} ready`
      : room.private
        ? 'Share the invite link with friends'
        : 'Public room — players can join from All rooms on the home page';
  } else {
    if (title) title.textContent = 'In the lobby';
    if (sub) sub.textContent = 'Waiting for the admin to launch';
  }

  refreshRoomChatAccess({ inRoom });
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
  lobbyWasSeated = false;
  try {
    const { room: existing } = await roomsApi.get(id);
    if (canRejoinRoom(existing, u.id)) {
      await rejoinActiveGame(existing);
      return;
    }
    if (!isRoomJoinable(existing, u.id)) {
      if (existing.status !== 'lobby') {
        alert('This game has already started. You can no longer join.');
      } else if (roomUserKicked(existing, u.id)) {
        alert('The admin removed you from this room.');
      } else {
        alert('This room is full — all player seats are taken.');
      }
      renderRoomList();
      return;
    }
    const alreadyIn = existing.slots.some(s => s?.userId === u.id);
    if (alreadyIn) {
      enterBoardLobby(existing);
      return;
    }
    const { room } = await roomsApi.join(id, { emoji: boardJoinEmoji, color: boardJoinColor });
    history.replaceState(null, '', roomLink(id));
    enterBoardLobby(room);
  } catch (e) {
    const blocked = joinBlockedMessage(e.message);
    const msg = blocked || (e.message || 'Could not join room');
    alert(msg);
    if (e.message === 'started') handleRoomNoLongerJoinable({ id, status: 'playing' });
    renderRoomList();
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
    if (pre.status !== 'lobby') {
      alert('This game has already started. You can no longer join.');
      handleRoomNoLongerJoinable(pre);
      return;
    }
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
    const blocked = joinBlockedMessage(e.message);
    const msg = blocked || (e.message === 'removed'
      ? 'The admin removed you from this room.'
      : (e.message || 'Could not join'));
    alert(msg);
    if (e.message === 'started') handleRoomNoLongerJoinable({ id: currentRoomId, status: 'playing' });
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

async function openPlaySetup({ privateRoom = false } = {}) {
  if (gamePausedAway) {
    alert(gameStarted
      ? 'You have a game in progress. Tap "Return to game" on the right to continue.'
      : 'You are still in a room. Tap "Return to room" on the right to go back.');
    return;
  }
  if (!(await ensureUser())) return;
  const priv = $('roomPrivate');
  if (priv) priv.checked = privateRoom;
  syncPrivateHint();
  renderHostTraveler();
  showView('create');
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
  gameSpectating = false;
  gamePausedAway = false;
  $('spectateBanner')?.classList.add('hidden');
  document.body.classList.remove('game-active', 'spectator-mode');
  $('hud')?.classList.add('hidden');
  $('scene')?.classList.add('hidden');
  $('roomLobby')?.classList.add('hidden');
  $('winModal')?.classList.add('hidden');
  hideRoomChat();
  clearLobbyChat();
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

export { setGameBrandVisible } from '../lib/gameShell.js';

async function onPlayerLeftGame() {
  if (!gameStarted) return;
  const rid = currentRoomId;
  if (rid && !gameSpectating) {
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
  hideRoomChat();
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
    if (currentRoomId) {
      showRoomChat('game');
      refreshRoomChatAccess({ inRoom: true });
    }
  } else if (currentRoomId) {
    $('roomLobby')?.classList.remove('hidden');
    document.body.classList.add('room-lobby-mode');
    setGameBrandVisible(true);
    showRoomChat('lobby');
    roomsApi.get(currentRoomId).then(({ room }) => {
      if (room.status === 'lobby') renderBoardLobby(room);
      else handleRoomNoLongerJoinable(room);
    }).catch(() => {
      exitBoardLobby();
      showView('home');
      renderRoomList();
    });
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
  if (roomUserKicked(room, userId)) return false;
  const gp = room.gameState?.players?.find(p => p.userId === userId);
  if (gp?.dead) return false;
  if (room.rejoinUntil && Date.now() > room.rejoinUntil) return false;
  return true;
}

function rejoinBlockedMessage(room) {
  const kicked = roomUserKicked(room, getUser()?.id);
  if (kicked?.reason === 'vote') {
    return 'Your teammates vote-kicked you from this game.';
  }
  if (kicked?.reason === 'leave') {
    return 'You left this game.';
  }
  if (kicked || (room.rejoinUntil && Date.now() > room.rejoinUntil)) {
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
  if (idEl) setRoomCodeEl(idEl, room.id, { compact: true });
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
  if (room.players?.length > 1) {
    showRoomChat('game');
    refreshRoomChatAccess({ inRoom: true });
  }
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
    if (!isRoomJoinable(room, u?.id) && !canRejoinRoom(room, u?.id)) {
      if (room.status !== 'lobby') {
        showInviteError(id, rejoinBlockedMessage(room), true);
      } else if (roomUserKicked(room, u?.id)) {
        showInviteError(id, 'The admin removed you from this room.', true);
      } else {
        showInviteError(id, 'This room is full — all player seats are taken.', true);
      }
      return;
    }
    const inRoom = room.slots.some(s => s?.userId === u.id);
    if (inRoom) {
      hideInviteCard();
      enterBoardLobby(room);
      return;
    }
    hideInviteCard();
    enterBoardLobby(room);
  } catch (e) {
    const blocked = joinBlockedMessage(e.message);
    showInviteError(
      id,
      blocked || e.message || 'Room not found. Ask the host for a new link (rooms reset if the server restarted).',
      !!blocked,
    );
  }
}

function showInviteCard(id, message, { rejoin = false, disableEnter = false } = {}) {
  stopRejoinTimer();
  pendingInviteRoomId = id;
  $('roomInviteCard')?.classList.toggle('room-invite-card--rejoin', rejoin);
  $('roomInviteEyebrow').textContent = rejoin ? 'Your game is waiting' : 'Game invite';
  $('roomInviteTimer')?.classList.toggle('hidden', !rejoin);
  const idEl = $('roomInviteId');
  if (idEl) setRoomCodeEl(idEl, id, { compact: true });
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
    if (!isRoomJoinable(room, u?.id)) {
      if (room.status !== 'lobby') {
        showInviteError(id, rejoinBlockedMessage(room), true);
      } else if (roomUserKicked(room, u?.id)) {
        showInviteError(id, 'The admin removed you from this room.', true);
      } else {
        showInviteError(id, 'This room is full — all player seats are taken.', true);
      }
      return false;
    }
    if (inRoom) {
      enterBoardLobby(room);
      return true;
    }
    showInviteCard(id, 'Pick your traveler and tap Enter room to join.');
    return true;
  } catch (e) {
    const blocked = joinBlockedMessage(e.message);
    showInviteError(
      id,
      blocked || e.message || 'Room not found or expired. The server may have restarted — ask the host for a new link.',
      !!blocked,
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
  wireDiscordLinks();
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
      chosenPer = +$('szRange')?.value || 10;
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
  $('quickPlayBtn')?.addEventListener('click', () => openPlaySetup({ privateRoom: false }));

  $('lobbyNewRoom')?.addEventListener('click', () => openPlaySetup({ privateRoom: true }));
  $('roomPrivate')?.addEventListener('change', syncPrivateHint);
  syncPrivateHint();
  $('homeAllRooms')?.addEventListener('click', () => {
    roomsPanelOpen = !roomsPanelOpen;
    renderRoomList();
  });
  $('homeSpectate')?.addEventListener('click', () => {
    spectatePanelOpen = true;
    renderRoomList();
    $('lobbyBelowFold')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('spectateRefresh')?.addEventListener('click', () => {
    spectatePanelOpen = true;
    renderRoomList();
    $('spectateRefresh')?.classList.add('spin-once');
    setTimeout(() => $('spectateRefresh')?.classList.remove('spin-once'), 600);
  });
  $('spectateExitBtn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('wt:player-left-game'));
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
  $('lobbyChatForm')?.addEventListener('submit', handleLobbyChatSubmit);
  $('lobbyChatMute')?.addEventListener('click', () => {
    lobbyChatMuted = !lobbyChatMuted;
    const btn = $('lobbyChatMute');
    btn?.classList.toggle('is-muted', lobbyChatMuted);
    btn?.querySelector('.chat-panel__mute-on')?.classList.toggle('hidden', lobbyChatMuted);
    btn?.querySelector('.chat-panel__mute-off')?.classList.toggle('hidden', !lobbyChatMuted);
  });
  $('lobbyChatCollapse')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleChatCollapsed();
  });
  $('lobbyChat')?.addEventListener('click', () => {
    if (chatCollapsed && $('roomChatDock')?.classList.contains('room-chat-dock--game')) {
      toggleChatCollapsed();
    }
  });
  document.addEventListener('wt:player-left-game', onPlayerLeftGame);
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

  cachedFakePlaying = rollFakePlayingCount();
  fakePlayingUpdated = Date.now();
  startLiveStatsPoll();

  renderRoomList();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLiveStats();
  });

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
