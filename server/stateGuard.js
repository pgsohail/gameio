/**
 * Server-side referee for client-relayed game state.
 *
 * The game rules still run in the browser, but the server no longer trusts
 * whatever a client sends. Every incoming state is checked against the last
 * accepted state for that room:
 *   - only seated, alive players may write
 *   - identities, admin flag and eliminations cannot be forged
 *   - nobody can mint money (bank payouts are bounded and only for the turn actor)
 *   - only the turn actor (or a legit timeout / vote kick) may pass the turn
 *   - dice must match the roll the server issued
 */

export const TURN_LIMIT_MS = 180_000;
export const TURN_BONUS_MS = 30_000;
const TILE_CREDIT_MAX = 700;      // max cash from mortgaging / selling one tile's buildings
const BANK_BURST_EXTRA = 1500;    // cards, power cards, pot and misc bank payouts per update
const MAX_CASH = 10_000_000;

const num = v => typeof v === 'number' && Number.isFinite(v);

export function botRunnerUserId(state) {
  const humans = (state?.players || []).filter(p => !p.bot && !p.dead && p.userId);
  if (!humans.length) return null;
  return humans.reduce((a, b) => ((a.id ?? 0) < (b.id ?? 0) ? a : b)).userId;
}

export function turnActorUserId(state) {
  const cur = state?.players?.[state.turn];
  if (!cur) return null;
  if (cur.bot) return botRunnerUserId(state);
  return cur.userId || null;
}

function totalCash(state) {
  let sum = num(state.pot) ? state.pot : 0;
  for (const p of state.players || []) sum += num(p.cash) ? p.cash : 0;
  return sum;
}

function shapeOk(state, prev) {
  if (!state || typeof state !== 'object') return 'bad state';
  if (!Array.isArray(state.players) || !state.players.length || state.players.length > 8) return 'bad players';
  if (prev && state.players.length !== prev.players.length) return 'player count changed';
  if (!Number.isInteger(state.turn) || state.turn < 0 || state.turn >= state.players.length) return 'bad turn';
  for (const p of state.players) {
    if (!p || typeof p !== 'object') return 'bad player';
    if (!num(p.cash) || Math.abs(p.cash) > MAX_CASH) return 'bad cash';
    if (p.pos != null && (!Number.isInteger(p.pos) || p.pos < 0 || p.pos > 400)) return 'bad pos';
  }
  if (state.pot != null && (!num(state.pot) || state.pot < 0 || state.pot > MAX_CASH)) return 'bad pot';
  if (state.dice != null) {
    if (!Array.isArray(state.dice) || state.dice.length !== 2) return 'bad dice';
    if (!state.dice.every(d => Number.isInteger(d) && d >= 1 && d <= 6)) return 'bad dice';
  }
  if (state.tiles != null) {
    if (!Array.isArray(state.tiles) || state.tiles.length > 400) return 'bad tiles';
    if (prev?.tiles && state.tiles.length !== prev.tiles.length) return 'tile count changed';
  }
  return null;
}

/**
 * @param {object} ctx { room, prev, next, userId, now }
 * @returns {{ ok: true, state } | { ok: false, reason }}
 */
export function validateIncomingState({ room, prev, next, userId, now = Date.now() }) {
  const bad = shapeOk(next, prev);
  if (bad) return { ok: false, reason: bad };

  // First state of a game: only sanity limits.
  if (!prev) {
    const start = Math.max(5000, +(room.rules?.cash || room.rules?.startCash || 0) * 2);
    if (next.players.some(p => p.cash > start)) return { ok: false, reason: 'start cash too high' };
    if (next.players.some(p => p.dead)) return { ok: false, reason: 'dead at start' };
    if (room.players?.length && next.players.length !== room.players.length) {
      return { ok: false, reason: 'player count mismatch' };
    }
    next.over = false;
    next.voteKickedUsers = [];
    next.voteKick = { voters: [] };
    // Identity comes from the server's seat list, not the client.
    if (room.players?.length) {
      next.players.forEach((p, i) => {
        const o = room.players[i];
        if (!o) return;
        p.userId = o.userId;
        p.name = o.name;
        p.bot = !!o.bot;
        p.humanoid = !!o.humanoid;
        p.emoji = o.emoji;
        p.color = o.color;
        p.isAdmin = i === (room.adminId ?? 0);
      });
    }
    return { ok: true, state: next };
  }

  const senderPrev = prev.players.find(p => p.userId === userId && !p.bot);
  if (!senderPrev) return { ok: false, reason: 'not a player' };
  if (senderPrev.dead) return { ok: false, reason: 'eliminated' };
  if (prev.over) return { ok: false, reason: 'game over' };

  const actor = turnActorUserId(prev);
  const isActor = actor === userId;
  const prevCur = prev.players[prev.turn];
  const isAdmin = !!senderPrev.isAdmin;
  const kicked = room.kicked || {};
  const absent = room.absent || {};
  const turnAge = now - (room.turnSince || now);
  const timedOut = turnAge >= TURN_LIMIT_MS - 3000;

  // 1. Identity fields are locked to the server's copy.
  next.players.forEach((p, i) => {
    const o = prev.players[i];
    p.id = o.id;
    p.userId = o.userId;
    p.name = o.name;
    p.bot = o.bot;
    p.humanoid = o.humanoid;
    p.botBrain = o.botBrain;
    p.emoji = o.emoji;
    p.color = o.color;
  });

  // 2. Vote kick: a client can only add its own vote.
  const prevVoters = new Set(prev.voteKick?.voters || []);
  const nextVoters = (next.voteKick?.voters || [])
    .filter(v => prevVoters.has(v) || v === senderPrev.id);
  next.voteKick = { voters: [...new Set(nextVoters)] };
  const aliveHumanIds = new Set(prev.players.filter(p => !p.dead && !p.bot).map(p => p.id));
  const votesAgainstCur = [...new Set([...prevVoters, ...nextVoters])]
    .filter(v => aliveHumanIds.has(v) && v !== prevCur?.id).length;
  const othersAlive = [...aliveHumanIds].filter(id => id !== prevCur?.id).length;
  const majority = Math.max(1, Math.ceil(othersAlive / 2));
  const voteKickPasses = !!prevCur && !prevCur.bot && votesAgainstCur >= majority;
  const adminMayRemoveCur = isAdmin && prevCur && !prevCur.bot && (timedOut || voteKickPasses);

  // 3. Eliminations: no resurrection; only legit causes can kill someone else.
  const killed = new Set();
  for (let i = 0; i < next.players.length; i++) {
    const p = next.players[i];
    const o = prev.players[i];
    if (o.dead) { p.dead = true; continue; }
    if (!p.dead) continue;
    const legit = o.userId === userId
      || o.bot
      || (o.userId && (kicked[o.userId] || absent[o.userId]))
      || (i === prev.turn && adminMayRemoveCur)
      || (o.debt && isActor); // creditor-side bankruptcy settlement on the actor's client
    if (!legit) return { ok: false, reason: `cannot eliminate ${o.name}` };
    killed.add(i);
  }

  // 4. Admin flag only moves when the current admin is gone.
  const prevAdminIdx = prev.players.findIndex(p => p.isAdmin);
  const prevAdmin = prev.players[prevAdminIdx];
  const adminGone = prevAdminIdx < 0 || next.players[prevAdminIdx]?.dead
    || (prevAdmin?.userId && (kicked[prevAdmin.userId] || absent[prevAdmin.userId]));
  if (!adminGone) next.players.forEach((p, i) => { p.isAdmin = !!prev.players[i].isAdmin; });

  // 5. Kick list: only for players legitimately removed in this update or already kicked.
  const prevKickList = new Set(prev.voteKickedUsers || []);
  next.voteKickedUsers = [...new Set(next.voteKickedUsers || [])].filter(uid => {
    if (prevKickList.has(uid)) return true;
    const idx = next.players.findIndex(p => p.userId === uid);
    return idx === prev.turn && killed.has(idx) && adminMayRemoveCur;
  });

  // 6. Money: nobody can mint cash beyond legit bank payouts.
  let credits = 0;
  if (Array.isArray(next.tiles) && Array.isArray(prev.tiles)) {
    for (let i = 0; i < next.tiles.length; i++) {
      const a = prev.tiles[i] || {};
      const b = next.tiles[i] || {};
      if (!a.mortgaged && b.mortgaged) credits += TILE_CREDIT_MAX;
      if ((b.houses || 0) < (a.houses || 0)) credits += TILE_CREDIT_MAX;
      if (a.owner != null && b.owner == null && !killed.has(a.owner)) credits += TILE_CREDIT_MAX;
      // Ownership can't be grabbed from a living human except via trade or bankruptcy.
      if (a.owner != null && b.owner !== a.owner) {
        const from = prev.players[a.owner];
        if (from && !from.bot && !from.dead && !killed.has(a.owner)) {
          const viaTrade = (prev.openTrades || []).some(t =>
            (t.fromId === a.owner && t.toId === b.owner && (t.offerIdx || []).includes(i))
            || (t.toId === a.owner && t.fromId === b.owner && (t.wantIdx || []).includes(i)));
          const ownAction = from.userId === userId && b.owner == null;
          if (!viaTrade && !ownAction) return { ok: false, reason: 'illegal property transfer' };
        }
      }
    }
  }
  const salary = Math.max(0, +(room.rules?.salary || 300));
  const bankAllowance = (isActor ? salary * 2 + BANK_BURST_EXTRA : 0) + credits;
  const minted = totalCash(next) - totalCash(prev);
  if (minted > bankAllowance) return { ok: false, reason: `cash +${minted} exceeds ${bankAllowance}` };

  // Per-turn cap on bank payouts so repeated small updates can't farm money.
  if (!room.mint || room.mint.turnKey !== room.turnKey) room.mint = { turnKey: room.turnKey, total: 0 };
  const mintedNet = Math.max(0, minted - credits);
  if (mintedNet > 0) {
    const turnCap = salary * 4 + BANK_BURST_EXTRA * 3;
    if (room.mint.total + mintedNet > turnCap) return { ok: false, reason: 'turn payout cap' };
    room.mint.total += mintedNet;
  }

  // 7. Turn passing.
  if (next.turn !== prev.turn) {
    const curGone = !prevCur || prevCur.dead || next.players[prev.turn]?.dead
      || (prevCur.userId && (kicked[prevCur.userId] || absent[prevCur.userId]));
    const allowed = isActor || curGone || (isAdmin && timedOut);
    if (!allowed) return { ok: false, reason: 'not your turn' };
    if (next.players[next.turn]?.dead) {
      // must land on a living player
      return { ok: false, reason: 'turn to dead player' };
    }
  }

  // 8. Dice must be what the server rolled.
  const sameDice = (a, b) => Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
  if (next.dice && !sameDice(next.dice, prev.dice)) {
    const ld = room.lastDice;
    if (!ld || !sameDice(next.dice, [ld.d1, ld.d2])) {
      next.dice = prev.dice ? [...prev.dice] : [1, 1];
    }
  }
  if (room.lastDice?.pending && sameDice(next.dice, [room.lastDice.d1, room.lastDice.d2])) {
    room.lastDice.pending = false;
  }

  // 9. Game over only when at most one player is left.
  if (next.over && !prev.over) {
    const alive = next.players.filter(p => !p.dead).length;
    if (alive > 1) next.over = false;
  }

  return { ok: true, state: next };
}

/** Called whenever a new state is committed, to track turn timing on the server clock. */
export function noteCommittedState(room, prev, next, now = Date.now()) {
  if (!prev || prev.turn !== next.turn || !room.turnSince) {
    room.turnSince = now;
    room.turnKey = (room.turnKey || 0) + 1;
    room.turnBonus = false;
  }
  // Admin's turn-bonus extension (engaged player gets +30s once per turn).
  const cur = next.players[next.turn];
  const prevCur = prev?.players?.[prev.turn];
  if (prev && prev.turn === next.turn && cur?.turnBonusUsed && !prevCur?.turnBonusUsed && !room.turnBonus) {
    room.turnBonus = true;
    room.turnSince = now;
  }
}

/** Is userId allowed to ask the server for a dice roll right now? */
export function mayRequestRoll(room, userId, now = Date.now()) {
  const state = room.gameState;
  if (!state) {
    // Before the first state arrives, only the first player (or bot runner) may roll.
    const p0 = room.players?.[0];
    if (!p0) return false;
    if (p0.bot) {
      const humans = room.players.filter(p => !p.bot && p.userId);
      return humans[0]?.userId === userId;
    }
    return p0.userId === userId;
  }
  if (state.over) return false;
  if (turnActorUserId(state) !== userId) return false;
  const ld = room.lastDice;
  if (ld?.pending && ld.turnKey === room.turnKey && now - ld.at < 8000) return false;
  return true;
}
