/* Shared bot engine — math, registry, and context wiring. */

let CTX = null;
export function initBots(ctx) { CTX = ctx; }
export function getBotCtx() { return CTX; }

const S = () => CTX.S();
const TILES = () => CTX.TILES();
const GROUPS = () => CTX.GROUPS();
const N = () => TILES().length;
const log = (html, p) => CTX.log && CTX.log(html, p);

const DICE_P = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const AIR_RENTS = [0, 50, 100, 150, 250, 400, 600, 800, 1000];
const UTL_MULT = [0, 4, 10, 20, 30];

const alive = () => S().players.filter(p => !p.dead);
const ownedBy = p => TILES().filter(t => t.owner === p.id);
const groupTiles = g => TILES().filter(t => t.group === g);
const ownsGroup = (p, g) => groupTiles(g).every(t => t.owner === p.id);
const countType = (p, type) => TILES().filter(t => t.type === type && t.owner === p.id && !t.mortgaged).length;
const groupSize = g => groupTiles(g).length;
const ownedInGroup = (p, g) => groupTiles(g).filter(t => t.owner === p.id).length;

function netWorth(p) {
  let n = p.cash;
  ownedBy(p).forEach(t => {
    n += t.mortgaged ? 0 : Math.floor(t.price / 2);
    if (t.houses) n += t.houses === 5 ? Math.floor(t.houseCost * 5 / 2) : Math.floor(t.houses * t.houseCost / 2);
  });
  return n;
}

function gamePhase() {
  const buyable = TILES().filter(t => t.price);
  const free = buyable.filter(t => t.owner == null || S().players[t.owner]?.dead).length;
  const ratio = free / Math.max(1, buyable.length);
  return ratio > 0.45 ? 'early' : ratio > 0.15 ? 'mid' : 'late';
}

function landProbNext(pos, idx) {
  const steps = ((idx - pos) % N() + N()) % N();
  return (steps >= 2 && steps <= 12) ? DICE_P[steps] / 36 : 0;
}
const baseLandRate = () => 7 / N();

function rentOf(t, ownerOverride = null) {
  const ownerId = ownerOverride ?? t.owner;
  if (ownerId == null) return 0;
  const owner = S().players[ownerId];
  if (!owner || owner.dead || t.mortgaged) return 0;
  let r = 0;
  if (t.type === 'city') {
    r = t.rents[t.houses || 0];
    if ((t.houses || 0) === 0 && S().rules.double && ownsGroup(owner, t.group)) r *= 2;
  } else if (t.type === 'air') r = AIR_RENTS[countType(owner, 'air')] || 0;
  else if (t.type === 'utl') r = 7 * (UTL_MULT[countType(owner, 'utl')] || 0);
  if (r > 0 && owner.rentSurge) r *= 2;
  return r;
}

function expectedIncome(t, pid) {
  const rent = rentOf(t, pid) || estimateRentIfOwned(t, pid);
  if (!rent) return 0;
  let p = 0;
  alive().forEach(o => {
    if (o.id === pid) return;
    p += baseLandRate() + landProbNext(o.pos, t.idx) * 0.5;
  });
  return rent * p;
}

function estimateRentIfOwned(t, pid) {
  const me = S().players[pid];
  if (!me) return 0;
  if (t.type === 'city') {
    let r = t.rents[0];
    const others = groupTiles(t.group).filter(x => x !== t);
    if (S().rules.double && others.every(x => x.owner === pid)) r *= 2;
    return r;
  }
  if (t.type === 'air') return AIR_RENTS[Math.min(8, countType(me, 'air') + 1)] || 50;
  if (t.type === 'utl') return 7 * (UTL_MULT[Math.min(4, countType(me, 'utl') + 1)] || 4);
  return 0;
}

function rentThreat(p) {
  let worst = 0, weighted = 0;
  TILES().forEach(t => {
    if (t.owner == null || t.owner === p.id) return;
    const o = S().players[t.owner];
    if (!o || o.dead || t.mortgaged) return;
    const r = rentOf(t);
    if (!r) return;
    const pr = landProbNext(p.pos, t.idx);
    if (pr > 0) { weighted += r * pr; worst = Math.max(worst, r * Math.min(1, pr * 6)); }
    worst = Math.max(worst, r * 0.25);
  });
  return Math.round(Math.max(worst, weighted * 2));
}

function acquireValue(t, p, brain) {
  if (!t.price) return 0;
  let v = t.price;
  if (t.type === 'city') {
    const sz = groupSize(t.group);
    const mine = ownedInGroup(p, t.group);
    if (mine === sz - 1) v *= 2.2 + 0.6 * brain.monopolyHunger;
    else if (mine > 0) v *= 1 + 0.35 * mine * brain.monopolyHunger;
    alive().forEach(o => {
      if (o.id === p.id) return;
      if (ownedInGroup(o, t.group) === sz - 1) v = Math.max(v, t.price * (1.4 + 0.8 * brain.denial));
    });
  } else if (t.type === 'air') v *= 1 + 0.22 * countType(p, 'air');
  else if (t.type === 'utl') v *= 1 + 0.18 * countType(p, 'utl');
  v += expectedIncome(t, p.id) * 18 * brain.incomeWeight;
  if (gamePhase() === 'late') v *= 1.15;
  return Math.round(v);
}

function releaseCost(t, me, to, brain) {
  let c = acquireValue(t, me, brain) * 0.9;
  if (t.type === 'city') {
    const sz = groupSize(t.group);
    const theirs = ownedInGroup(to, t.group);
    if (theirs === sz - 1) c += t.price * (1.6 + 1.6 * brain.denial);
    else if (theirs > 0) c += t.price * 0.3 * brain.denial;
    if (ownedInGroup(me, t.group) === sz) c += t.price * 3;
  }
  return Math.round(c);
}

export const PERSONALITIES = {};
export function registerPersonality(key, brain) { PERSONALITIES[key] = brain; }

export function assignBotBrains(players, { mastermind = 0 } = {}) {
  const pool = ['tycoon', 'shark', 'banker', 'gambler'];
  let i = 0, geniuses = 0;
  players.forEach(p => {
    if (!p.bot) return;
    if (p.botBrain) return;
    if (geniuses < mastermind && PERSONALITIES.mastermind) { p.botBrain = 'mastermind'; geniuses++; }
    else { p.botBrain = pool[i % pool.length]; i++; }
  });
}

export const brainOf = p => PERSONALITIES[p.botBrain] || PERSONALITIES.banker;

export function reserveFor(p, brain, building = false) {
  const base = building ? brain.buildReserve : brain.reserve;
  const threat = rentThreat(p) * (0.4 + 0.6 * brain.denial);
  const phase = gamePhase();
  const phaseMult = phase === 'early' ? 0.7 : phase === 'mid' ? 1 : 1.25;
  return brain.hooks?.reserve
    ? brain.hooks.reserve(p, base, threat, phase)
    : Math.round((base + threat * 0.6) * phaseMult);
}

export const _engine = {
  acquireValue, releaseCost, expectedIncome, rentThreat, rentOf,
  landProbNext, baseLandRate, gamePhase, netWorth,
  alive, ownedBy, groupTiles, ownsGroup, ownedInGroup, groupSize, countType,
  reserveFor, S, TILES, GROUPS, log, brainOf,
};
