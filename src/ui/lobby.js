import { $ } from '../lib/format.js';
import { BRIGHT_COLORS } from '../lib/colors.js';
import {
  continueAsGuest, getRemember, getUser, initGoogleSignIn,
  onAuthChange, restoreSession, setRemember, signOut,
} from '../lib/auth.js';
import { connectRoomSocket, roomLink, roomsApi } from '../lib/api.js';
import { initAccount, renderHub, renderProfilePage } from './account.js';

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
  const m = { 10: 'Classic', 12: 'Grand', 14: 'Huge', 18: 'Max' };
  return m[per] || 'Custom';
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
      out.push(`<span class="room-slot room-slot--filled" style="--pc:${p.color}" title="${esc(p.name)}">${crown}${p.bot ? '🤖' : p.emoji}</span>`);
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
    list.innerHTML = rooms.map(r => `
      <button type="button" class="room-card" data-room="${esc(r.id)}">
        <div class="room-card__left">
          <span class="room-card__id">${esc(r.id)}</span>
          <div class="room-card__slots">${slotAvatars(r.slots, r.maxPlayers)}</div>
        </div>
        <div class="room-card__right">
          <span class="room-card__mode">🗺 ${boardLabel(r.rules.per)}</span>
          <div class="room-card__rules">${ruleIconsHtml(r.rules)}</div>
          <span class="room-card__cash">▶ ${r.rules.cash}</span>
        </div>
      </button>
    `).join('');
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
  document.querySelectorAll('.board-seg .glass-seg__btn').forEach(btn => {
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

function startFromPayload(payload) {
  const u = getUser();
  if (!u || !onStartGame) return;
  const adminId = payload.adminId ?? 0;
  const players = payload.players.map((p, i) => ({
    name: p.userId === u.id ? u.name : p.name,
    bot: p.userId !== u.id && (p.bot || p.userId?.startsWith('bot_')),
    emoji: p.emoji,
    color: p.color,
    isAdmin: i === adminId,
  }));
  disconnectRoomSocket();
  currentRoomId = null;
  onStartGame({ rules: payload.rules, players, adminId });
}

function disconnectRoomSocket() {
  roomSocket?.close();
  roomSocket = null;
}

function subscribeRoom(roomId) {
  disconnectRoomSocket();
  roomSocket = connectRoomSocket(msg => {
    if (msg.type === 'room_update' && msg.room?.id === roomId) {
      renderBoardLobby(msg.room);
    }
    if (msg.type === 'game_start') {
      startFromPayload(msg);
    }
  });
  roomSocket?.addEventListener('open', () => {
    roomSocket.send(JSON.stringify({ type: 'subscribe', roomId }));
  });
}

function exitBoardLobby() {
  $('roomLobby')?.classList.add('hidden');
  $('lobby')?.classList.remove('hidden');
  $('hubTop')?.classList.remove('hidden');
  document.body.classList.remove('room-lobby-mode');
  disconnectRoomSocket();
  currentRoomId = null;
  lastRoomRules = null;
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url.pathname + url.search);
}

function enterBoardLobby(room) {
  currentRoomId = room.id;
  $('hubTop')?.classList.add('hidden');
  $('lobby')?.classList.add('hidden');
  onPreviewBoard?.(room.rules.per);
  $('roomLobby')?.classList.remove('hidden');
  document.body.classList.add('room-lobby-mode');
  updateBoardLinkUI(room.id);
  $('boardShareBox')?.classList.toggle('hidden', !room.private);
  renderBoardLobby(room);
  subscribeRoom(room.id);
}

function renderBoardJoinColors() {
  const sw = $('boardJoinColors');
  if (!sw) return;
  sw.innerHTML = '';
  BRIGHT_COLORS.forEach(c => {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'traveler-color' + (c === boardJoinColor ? ' on' : '');
    s.style.background = c;
    s.onclick = () => {
      sw.querySelectorAll('.traveler-color').forEach(x => x.classList.remove('on'));
      s.classList.add('on');
      boardJoinColor = c;
      $('boardJoinToken')?.style.setProperty('--pc', c);
    };
    sw.appendChild(s);
  });
  $('boardJoinToken')?.style.setProperty('--pc', boardJoinColor);
}

function renderBoardLobby(room) {
  const u = getUser();
  const inRoom = !!u && room.slots.some(s => s?.userId === u.id);
  const isHost = u && room.hostId === u.id;
  const full = room.slots.every(Boolean);
  const needsJoin = !inRoom && !full;

  $('boardRoomCode').textContent = `Room · ${room.id}`;
  $('boardWaitingSlots').innerHTML = slotAvatars(room.slots, room.maxPlayers);
  $('boardPlayerList').innerHTML = room.slots.filter(Boolean).map(p => `
    <li class="room-player-item">
      <span class="room-player-item__tok" style="--pc:${esc(p.color)}">${p.bot ? '🤖' : p.emoji}</span>
      <span class="room-player-item__meta">
        <span class="room-player-item__name">${esc(p.name)}</span>
        ${p.isHost ? '<span class="room-player-item__badge">Admin</span>' : ''}
      </span>
    </li>
  `).join('') || '<li class="room-player-item room-player-item--empty">Waiting for players…</li>';

  applyBoardRules(room.rules, { isHost });

  $('boardJoinPicker')?.classList.toggle('hidden', !needsJoin);
  $('boardWaitingSlots')?.classList.toggle('hidden', needsJoin);
  $('boardLaunchBtn')?.classList.toggle('hidden', !isHost);

  const title = $('boardWaitTitle');
  const sub = $('boardWaitSub');
  if (needsJoin) {
    if (title) title.textContent = full ? 'Room is full' : 'Join this game';
    if (sub) sub.textContent = full ? 'Spectate or return home' : 'Select your token & color';
    $('boardJoinBtn')?.toggleAttribute('disabled', full);
    renderBoardJoinColors();
  } else if (isHost) {
    if (title) title.textContent = 'Waiting for players';
    if (sub) sub.textContent = 'Share the link · tweak settings · launch when ready';
  } else {
    if (title) title.textContent = 'Waiting for host';
    if (sub) sub.textContent = 'The admin will launch the game';
  }
}

async function createLobbyRoom() {
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
  const u = await ensureUser();
  if (!u) return;
  try {
    const { room: existing } = await roomsApi.get(id);
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
    alert(e.message || 'Could not join room');
  }
}

async function confirmBoardJoin() {
  if (!currentRoomId) return;
  const u = await ensureUser();
  if (!u) return;
  try {
    const { room } = await roomsApi.join(currentRoomId, {
      emoji: boardJoinEmoji,
      color: boardJoinColor,
    });
    history.replaceState(null, '', roomLink(currentRoomId));
    renderBoardLobby(room);
  } catch (e) {
    alert(e.message || 'Could not join');
  }
}

async function launchWaitingRoom() {
  if (!currentRoomId) return;
  try {
    const payload = await roomsApi.launch(currentRoomId);
    startFromPayload(payload);
  } catch (e) {
    alert(e.message || 'Could not launch');
  }
}

async function quickPlayOffline() {
  const u = await ensureUser();
  if (!u) return;
  const rules = gatherRules();
  const players = [{ name: u.name, bot: false, emoji: hostEmoji, color: hostColor, isAdmin: true }];
  if (rules.allowBots) {
    players.push({
      name: 'Bot 2',
      bot: true,
      emoji: '🤖',
      color: BRIGHT_COLORS[1],
      isAdmin: false,
    });
  } else {
    alert('Turn on Bots in advanced rules, or create a room to play with friends.');
    return;
  }
  onStartGame?.({ rules, players, adminId: 0 });
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
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = prev; }, 2000);
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
  if (el && statsFn) el.textContent = statsFn(chosenPer);
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

async function tryJoinFromUrl() {
  const id = new URLSearchParams(location.search).get('room');
  if (!id) return;
  const u = await ensureUser();
  if (!u) return;
  try {
    const { room } = await roomsApi.get(id);
    if (room.status !== 'lobby') return;
    const inRoom = room.slots.some(s => s?.userId === u.id);
    if (inRoom) {
      enterBoardLobby(room);
      return;
    }
    enterBoardLobby(room);
  } catch { /* room gone */ }
}

export async function initLobby(startGame, boardStats, previewBoard) {
  onStartGame = startGame;
  onPreviewBoard = previewBoard;

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
    tryJoinFromUrl();
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
    if (lbl) lbl.textContent = `${chosenPer * 4} tiles`;
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
    if (e.key === 'Enter') $('quickPlayBtn')?.click();
  });
  const stopBubble = e => e.stopPropagation();
  $('homePlayAs')?.addEventListener('mousedown', stopBubble);
  $('homeNameInput')?.addEventListener('mousedown', stopBubble);
  $('homeNameInput')?.addEventListener('click', stopBubble);

  $('authSignOut')?.addEventListener('click', signOut);
  $('startBtn')?.addEventListener('click', createLobbyRoom);
  $('quickPlayBtn')?.addEventListener('click', quickPlayOffline);

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
  $('boardLeaveBtn')?.addEventListener('click', () => {
    exitBoardLobby();
    showView('home');
    renderRoomList();
  });
  $('roomRefresh')?.addEventListener('click', () => {
    roomsPanelOpen = true;
    renderRoomList();
    $('roomRefresh')?.classList.add('spin-once');
    setTimeout(() => $('roomRefresh')?.classList.remove('spin-once'), 600);
  });
  $('boardLaunchBtn')?.addEventListener('click', launchWaitingRoom);
  $('boardCopyLink')?.addEventListener('click', copyBoardLink);
  $('boardJoinBtn')?.addEventListener('click', confirmBoardJoin);
  $('boardJoinToken')?.addEventListener('click', ev => {
    ev.stopPropagation();
    showTokGrid($('boardJoinToken'), e => { boardJoinEmoji = e; });
  });
  $('authGateOk')?.addEventListener('click', () => $('authGate')?.classList.add('hidden'));

  document.addEventListener('click', () => {
    if (tokGridEl) { tokGridEl.remove(); tokGridEl = null; }
  });

  renderRoomList();
  showView('home');
  tryJoinFromUrl();
}
