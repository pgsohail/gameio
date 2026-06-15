/* ============================================================
   mastermind.js — MASTERMIND 🧠  (v5, "lookahead")
   ------------------------------------------------------------
   Integrates with engine.js via bots.js (override.*) + the
   directly-imported registerMastermind / mastermindThinkTime /
   mastermindRaiseCash. Verified against botCore.js + engine.js.

   v5 priorities (in order):
     1. COMPLETE MY OWN SETS. Buying/trading the missing piece of
        a set the bot already has a foothold in beats everything.
     2. ASSEMBLE toward sets — value tiles that move me to one-away.
     3. SEE 1-2-3 STEPS AHEAD on rivals: detect when an opponent is
        one OR two tiles from a monopoly and act early to block it
        (buy the blocker, outbid, refuse/charge for trades, and —
        with power cards — demolish what they build).
     4. DESTROY: kill-pressure building + power-card offense.
     5. SURVIVE: never bankrupt myself; a dead bot can't win.

   Power cards: engine.js forbids bots from the normal play path
   (canPlayPowerNow requires !p.bot). So Mastermind applies card
   effects itself at the top of its build phase (correct timing —
   end of its turn — and the resulting state broadcasts on endTurn).
   Toggle with MASTERMIND.usePowerCards.
============================================================ */

import { registerPersonality, _engine as E } from './botCore.js';

const DICE_P = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const AIR_RENTS = [0, 50, 100, 150, 250, 400, 600, 800, 1000];
const UTL_MULT = [0, 4, 10, 20, 30];

/* ===========================================================
   LANDING-FREQUENCY MODEL (Markov stationary distribution)
=========================================================== */
let _lm = { sig: '', freq: null };
function landingModel() {
  const tiles = E.TILES();
  const n = tiles.length;
  const jailIdx = tiles.findIndex(t => t.type === 'jail');
  const sig = `${n}:${jailIdx}`;
  if (_lm.sig === sig && _lm.freq) return _lm.freq;
  const moves = [];
  for (let d = 2; d <= 12; d++) moves.push([d, DICE_P[d] / 36]);
  const dest = (i, d) => {
    let j = (i + d) % n;
    if (tiles[j] && tiles[j].type === 'gotojail' && jailIdx >= 0) j = jailIdx;
    return j;
  };
  let v = new Array(n).fill(1 / n);
  for (let iter = 0; iter < 300; iter++) {
    const nv = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const vi = v[i];
      if (!vi) continue;
      for (const [d, pr] of moves) nv[dest(i, d)] += vi * pr;
    }
    let s = 0, diff = 0;
    for (let i = 0; i < n; i++) s += nv[i];
    if (s > 0) for (let i = 0; i < n; i++) nv[i] /= s;
    for (let i = 0; i < n; i++) diff += Math.abs(nv[i] - v[i]);
    v = nv;
    if (diff < 1e-10) break;
  }
  _lm = { sig, freq: v };
  return v;
}
function landRate(idx) {
  const f = landingModel();
  const r = f[idx];
  return (r != null && r > 0) ? r : 7 / E.TILES().length;
}
function horizon() {
  const ph = E.gamePhase();
  return ph === 'early' ? 22 : ph === 'mid' ? 14 : 8;
}

/* ===========================================================
   RENT / INCOME
=========================================================== */
function rentIfOwned(t, pid) {
  const me = E.S().players[pid];
  if (!me) return 0;
  if (t.type === 'city') {
    let r = t.rents[0];
    const others = E.groupTiles(t.group).filter(x => x !== t);
    if (E.S().rules.double && others.every(x => x.owner === pid)) r *= 2;
    return r;
  }
  if (t.type === 'air') return AIR_RENTS[Math.min(8, E.countType(me, 'air') + 1)] || 50;
  if (t.type === 'utl') return 7 * (UTL_MULT[Math.min(4, E.countType(me, 'utl') + 1)] || 4);
  return 0;
}
function incomeOf(t, pid) {
  const rent = E.rentOf(t, pid) || rentIfOwned(t, pid);
  if (!rent) return 0;
  const opp = Math.max(1, E.alive().length - 1);
  return rent * landRate(t.idx) * opp;
}
function monopolyPotential(g, pl) {
  const tiles = E.groupTiles(g);
  const opp = Math.max(1, E.alive().length - 1);
  let income = 0, buildCost = 0;
  tiles.forEach(t => {
    const rent3 = t.rents ? t.rents[3] : t.price * 3;
    income += rent3 * landRate(t.idx) * opp;
    buildCost += (t.houseCost || t.price) * 3;
  });
  const afford = Math.min(1, Math.max(0.35, pl.cash / Math.max(1, buildCost)));
  return income * horizon() * afford;
}

/* ===========================================================
   OPPONENT-STATE MODEL
=========================================================== */
function liquidation(pl) {
  let c = pl.cash;
  E.ownedBy(pl).forEach(t => {
    if (t.houses) c += t.houses * Math.floor((t.houseCost || t.price) / 2);
    if (!t.mortgaged) c += Math.floor(t.price / 2);
  });
  return c;
}
function leaderId() {
  const ord = [...E.alive()].sort((a, b) => E.netWorth(b) - E.netWorth(a));
  return ord[0]?.id ?? -1;
}
function rankOf(pl) {
  const ord = [...E.alive()].sort((a, b) => E.netWorth(b) - E.netWorth(a));
  const i = ord.findIndex(x => x.id === pl.id);
  return i < 0 ? ord.length + 1 : i + 1;
}
function isEndgame() { return E.alive().length <= 2 || E.gamePhase() === 'late'; }

function dangerOf(o) {
  if (o.id === leaderId()) return 1.3;
  return rankOf(o) <= 2 ? 0.9 : 0.45;
}
function threatWeight(o) { return MASTERMIND.denial * dangerOf(o); }

function threatFrom(opp, me) {
  let expc = 0, worst = 0;
  E.TILES().forEach(t => {
    if (t.owner !== opp.id || t.mortgaged) return;
    const r = E.rentOf(t);
    if (!r) return;
    const pr = E.landProbNext(me.pos, t.idx);
    expc += r * pr;
    if (pr > 0) worst = Math.max(worst, r);
    worst = Math.max(worst, r * 0.15);
  });
  return { expected: expc, worst };
}
function deepThreat(p) {
  const tiles = E.TILES();
  const opTiles = tiles.filter(t => {
    if (t.owner == null || t.owner === p.id || t.mortgaged) return false;
    const o = E.S().players[t.owner];
    return o && !o.dead;
  });
  let exp1 = 0, worst = 0;
  opTiles.forEach(t => {
    const r = E.rentOf(t);
    if (!r) return;
    const pr = E.landProbNext(p.pos, t.idx);
    exp1 += r * pr;
    if (pr > 0) worst = Math.max(worst, r);
    worst = Math.max(worst, r * 0.2);
  });
  const pos2 = (p.pos + 7) % tiles.length;
  let exp2 = 0;
  opTiles.forEach(t => { exp2 += E.rentOf(t) * E.landProbNext(pos2, t.idx); });
  return { expected: exp1 + exp2 * 0.8, worst };
}
function canFinish(opp, me) {
  const exposure = threatFrom(me, opp);
  return liquidation(opp) < exposure.worst * 0.9;
}

/* ===========================================================
   SET LOOKAHEAD  (1-2-3 steps ahead)
=========================================================== */
const cityGroups = () => [...new Set(E.TILES().filter(t => t.type === 'city').map(t => t.group))];

function mySetNeeds(pl) {
  return cityGroups().map(g => {
    const sz = E.groupSize(g), have = E.ownedInGroup(pl, g);
    return { g, sz, have, need: sz - have };
  }).filter(x => x.have > 0 && x.need > 0);
}
function oppNearSets(me) {
  const out = [];
  cityGroups().forEach(g => {
    const sz = E.groupSize(g);
    E.alive().forEach(o => {
      if (o.id === me.id) return;
      const have = E.ownedInGroup(o, g);
      const need = sz - have;
      if (have > 0 && (need === 1 || (need === 2 && sz >= 3))) out.push({ o, g, sz, have, need });
    });
  });
  return out;
}
function missingTilesOf(who, g) {
  return E.groupTiles(g).filter(t => t.owner !== who.id);
}

/* ===========================================================
   VALUATION  (own-set-first, lookahead denial)
=========================================================== */
function valueOf(t, p) {
  if (!t.price) return 0;
  let v = t.price;
  if (t.type === 'city') {
    const g = t.group, sz = E.groupSize(g), mine = E.ownedInGroup(p, g);
    if (mine === sz - 1) {
      v = Math.max(v, Math.round(monopolyPotential(g, p) * 0.6 * MASTERMIND.monopolyHunger + t.price));
    } else if (mine > 0) {
      v *= 1 + 0.5 * mine * MASTERMIND.monopolyHunger;
      if (mine + 1 === sz - 1) v += monopolyPotential(g, p) * 0.18 * MASTERMIND.monopolyHunger;
    }
    E.alive().forEach(o => {
      if (o.id === p.id) return;
      const oc = E.ownedInGroup(o, g);
      if (oc === sz - 1)
        v = Math.max(v, Math.round(monopolyPotential(g, o) * 0.22 * threatWeight(o) + t.price));
      else if (oc === sz - 2 && sz >= 3)
        v = Math.max(v, Math.round(monopolyPotential(g, o) * 0.07 * threatWeight(o) + t.price));
    });
  } else if (t.type === 'air') v *= 1 + 0.25 * E.countType(p, 'air');
  else if (t.type === 'utl') v *= 1 + 0.18 * E.countType(p, 'utl');
  v += incomeOf(t, p.id) * horizon() * 0.5 * MASTERMIND.incomeWeight;
  if (E.gamePhase() === 'late') v *= 1.12;
  return Math.round(v);
}
function releaseCost(t, me, to) {
  let c = valueOf(t, me) * 0.9;
  if (t.type === 'city') {
    const sz = E.groupSize(t.group), theirs = E.ownedInGroup(to, t.group);
    if (theirs === sz - 1) c += monopolyPotential(t.group, to) * 0.5 * threatWeight(to);
    else if (theirs === sz - 2 && sz >= 3) c += monopolyPotential(t.group, to) * 0.15 * threatWeight(to);
    else if (theirs > 0) c += t.price * 0.35;
    if (E.ownedInGroup(me, t.group) === sz) c += t.price * 3;
  }
  return Math.round(c);
}
function feedRisk(to, idxList) {
  let risk = 0;
  idxList.forEach(i => {
    const t = E.TILES()[i];
    if (t.type !== 'city') return;
    const sz = E.groupSize(t.group);
    const after = E.ownedInGroup(to, t.group) + 1;
    if (after >= sz) risk += monopolyPotential(t.group, to) * 0.4;
    else if (after === sz - 1) risk += monopolyPotential(t.group, to) * 0.05;
    else if (after > 0) risk += t.price * 0.2;
  });
  return risk * threatWeight(to);
}

/* ===========================================================
   PERSONALITY
=========================================================== */
const MASTERMIND = {
  key: 'mastermind', label: 'Mastermind 🧠',
  buyAggro: 1.1, reserve: 120, buildReserve: 160, bidMult: 1.1,
  monopolyHunger: 1.8, denial: 2.0, incomeWeight: 1.7,
  tradeFair: 1.0, lowball: 0.9, proposeEvery: 1, jailIQ: 1.0,
  aggression: 1.35,
  usePowerCards: true,

  hooks: {
    reserve(p, _base, _threat, phase) {
      const t = deepThreat(p);
      const exposure = t.worst + t.expected * 1.1;
      const floor = phase === 'early' ? 50 : phase === 'mid' ? 130 : 220;
      const capFrac = phase === 'early' ? 0.4 : phase === 'mid' ? 0.55 : 0.7;
      const cushion = p.cash / Math.max(1, exposure);
      let a = MASTERMIND.aggression;
      if (cushion < 1.2) a = 1;
      else if (cushion < 2) a = Math.min(a, 1.15);
      a = Math.max(1, a);
      const raw = Math.max(floor, Math.min(exposure, p.cash * capFrac));
      return Math.round(Math.max(floor, raw / a));
    },
    jail(p) {
      const phase = E.gamePhase();
      const t = deepThreat(p);
      if (phase === 'late' && t.expected > 55) return 'roll';
      if (p.goojf > 0 && phase !== 'late') return 'card';
      if (p.cash >= 280 && phase !== 'late') return 'pay';
      return 'roll';
    },
  },
};
function reserveOf(p) { return MASTERMIND.hooks.reserve(p, 0, 0, E.gamePhase()); }

/* ===========================================================
   BUYING  (own-set first, then block 1-2 steps ahead)
=========================================================== */
export function mastermindShouldBuy(p, t) {
  if (t.owner != null || !t.price || p.cash < t.price) return false;
  const keep = reserveOf(p);
  const v = valueOf(t, p) * MASTERMIND.buyAggro;

  if (t.type === 'city') {
    const sz = E.groupSize(t.group), mine = E.ownedInGroup(p, t.group);
    if (mine === sz - 1) return p.cash - t.price >= keep * 0.25;
    if (mine + 1 === sz - 1) return p.cash - t.price >= keep * 0.4;
    const block1 = E.alive().some(o => o.id !== p.id && E.ownedInGroup(o, t.group) === sz - 1);
    if (block1) return p.cash - t.price >= keep * 0.2;
    const block2 = sz >= 3 && E.alive().some(o => o.id !== p.id && E.ownedInGroup(o, t.group) === sz - 2);
    if (block2) return p.cash - t.price >= keep * 0.7;
  }
  if (E.gamePhase() === 'early') return p.cash - t.price >= keep * 0.5 && v >= t.price * 0.7;
  return v >= t.price && p.cash - t.price >= keep;
}

export function mastermindNextBid(p, tile, currentBid, leaderIdArg = null) {
  if (leaderIdArg === p.id) return null;
  const keep = reserveOf(p);
  let ceil = valueOf(tile, p) * MASTERMIND.bidMult;
  if (tile.type === 'city') {
    const sz = E.groupSize(tile.group), mine = E.ownedInGroup(p, tile.group);
    if (mine === sz - 1) ceil *= 1.6;
    else if (mine + 1 === sz - 1) ceil *= 1.25;
    const denies = E.alive().some(o => o.id !== p.id &&
      (E.ownedInGroup(o, tile.group) === sz - 1 || (sz >= 3 && E.ownedInGroup(o, tile.group) === sz - 2)));
    if (denies) ceil *= 1.45;
  }
  const ceiling = Math.min(ceil, p.cash - Math.round(keep * 0.4));
  const inc = currentBid < 100 ? 10 : currentBid < 400 ? 50 : 100;
  const next = currentBid + inc;
  return (next <= ceiling && next <= p.cash) ? next : null;
}

/* ===========================================================
   TRADE EVALUATION  (never feed a rival toward a set)
=========================================================== */
export function mastermindEvaluateTrade(bot, trade) {
  const from = E.S().players[trade.fromId];
  if (!from) return { action: 'decline' };
  let get = trade.offerCash;
  trade.offerIdx.forEach(i => { get += valueOf(E.TILES()[i], bot); });
  let give = trade.wantCash;
  trade.wantIdx.forEach(i => { give += releaseCost(E.TILES()[i], bot, from); });

  const feed = feedRisk(from, trade.wantIdx);
  const required = give + feed;
  if (get - required >= 0) return { action: 'accept' };

  const lowLiquidity = bot.cash < reserveOf(bot) * 0.6;
  const cashIn = trade.offerCash - trade.wantCash;
  if (lowLiquidity && cashIn > 0 && feed < 1 && dangerOf(from) < 0.6) {
    if (required - get <= cashIn * 0.5) return { action: 'accept' };
  }

  const deficit = Math.ceil(required - get);
  if (deficit <= from.cash * 0.85) {
    const ask = Math.ceil(deficit * (1 + 0.05 * MASTERMIND.tradeFair));
    return { action: 'counter', counter: {
      offerIdx: [...trade.wantIdx], wantIdx: [...trade.offerIdx],
      offerCash: Math.max(0, trade.wantCash - Math.min(trade.wantCash, ask)),
      wantCash: trade.offerCash + Math.max(0, ask - trade.wantCash),
    } };
  }
  return { action: 'decline' };
}

/* ===========================================================
   TRADE PROPOSALS
=========================================================== */
export function mastermindBestProposal(bot) {
  const tradableOf = pl => E.ownedBy(pl).filter(t => !t.mortgaged && t.houses === 0);
  const A = Math.max(1, MASTERMIND.aggression);
  let best = null;
  const consider = c => {
    if (!c) return;
    if (bot.cash - (c.offerCash || 0) < reserveOf(bot) * 0.4) return;
    if (!best || c.score > best.score) best = c;
  };
  const advancesMine = t => {
    if (t.type !== 'city') return 0;
    const sz = E.groupSize(t.group), mine = E.ownedInGroup(bot, t.group);
    if (mine === 0 || mine >= sz) return 0;
    return mine === sz - 1 ? 2 : (mine + 1 === sz - 1 ? 1 : 0);
  };
  const deadSingle = t => {
    if (t.type !== 'city' || E.ownedInGroup(bot, t.group) !== 1) return false;
    const sz = E.groupSize(t.group);
    return E.alive().some(o => o.id !== bot.id && E.ownedInGroup(o, t.group) >= sz - 1)
        || landRate(t.idx) < (5 / E.TILES().length);
  };

  E.alive().forEach(opp => {
    if (opp.id === bot.id) return;
    const theirs = tradableOf(opp), mine = tradableOf(bot);

    theirs.forEach(t => {
      const tier = advancesMine(t);
      if (!tier) return;
      const worth = valueOf(t, bot);
      const ask = releaseCost(t, opp, bot);
      const denyBonus = (opp.id === leaderId()) ? 1.2 : 1.0;
      let cash = Math.round(Math.min(worth * Math.min(1.0, 0.85 * A), ask) * denyBonus);
      cash = Math.min(cash, Math.floor(bot.cash * 0.7));
      if (cash < t.price * 0.8) return;
      consider({ score: (worth - cash) + (tier === 2 ? worth * 0.3 : worth * 0.12),
        toId: opp.id, offerIdx: [], wantIdx: [t.idx], offerCash: cash, wantCash: 0 });
    });

    theirs.filter(t => advancesMine(t) === 2).forEach(theirT => {
      mine.forEach(myT => {
        if (myT.type !== 'city' || E.ownedInGroup(opp, myT.group) !== E.groupSize(myT.group) - 1) return;
        const theirGain = monopolyPotential(myT.group, opp) * threatWeight(opp) * 0.4;
        const myGain = valueOf(theirT, bot) - releaseCost(myT, bot, opp);
        const balance = Math.round(Math.max(0, -myGain) * 1.05);
        if (balance > bot.cash * 0.6) return;
        const score = myGain + theirT.price * 0.6 - theirGain;
        if (score <= 0) return;
        consider({ score, toId: opp.id, offerIdx: [myT.idx], wantIdx: [theirT.idx], offerCash: balance, wantCash: 0 });
      });
    });

    theirs.filter(t => advancesMine(t) === 2).forEach(theirT => {
      const spares = mine
        .filter(m => !(m.type === 'city' && E.ownsGroup(bot, m.group)) && E.ownedInGroup(bot, m.group) <= 1)
        .sort((a, b) => valueOf(a, bot) - valueOf(b, bot)).slice(0, 2);
      if (!spares.length) return;
      if (spares.some(s => s.type === 'city' && E.ownedInGroup(opp, s.group) === E.groupSize(s.group) - 1)) return;
      const sparesVal = spares.reduce((a, s) => a + valueOf(s, bot), 0);
      const ask = releaseCost(theirT, opp, bot);
      const balance = Math.max(0, Math.round((ask - sparesVal) * 0.9));
      if (balance > bot.cash * 0.5) return;
      const score = valueOf(theirT, bot) - sparesVal * 0.6 - balance;
      if (score <= 0) return;
      consider({ score, toId: opp.id, offerIdx: spares.map(s => s.idx), wantIdx: [theirT.idx], offerCash: balance, wantCash: 0 });
    });

    if (dangerOf(opp) < 0.5) {
      mine.filter(deadSingle).forEach(t => {
        if (E.ownedInGroup(opp, t.group) === E.groupSize(t.group) - 1) return;
        const wantCash = Math.round(valueOf(t, bot) * (1 + 0.15 * MASTERMIND.lowball));
        if (wantCash > liquidation(opp) * 0.5) return;
        const score = wantCash - valueOf(t, bot) * 0.85;
        if (score <= 0) return;
        consider({ score, toId: opp.id, offerIdx: [t.idx], wantIdx: [], offerCash: 0, wantCash });
      });
    }
  });

  oppNearSets(bot).forEach(({ o: threat, g }) => {
    missingTilesOf(threat, g).forEach(t => {
      if (t.owner == null || t.owner === bot.id || t.owner === threat.id) return;
      if (t.mortgaged || t.houses > 0) return;
      const holder = E.S().players[t.owner];
      if (!holder || holder.dead) return;
      const denyVal = monopolyPotential(g, threat) * threatWeight(threat) * 0.4;
      let cash = Math.round(Math.min(denyVal * 0.6, valueOf(t, holder) * 1.5,
        (t.price || 100) * 4, bot.cash * 0.45));
      if (cash < t.price * 0.7) return;
      const score = denyVal - cash + valueOf(t, bot) * 0.3;
      consider({ score, toId: holder.id, offerIdx: [], wantIdx: [t.idx], offerCash: cash, wantCash: 0 });
    });
  });

  if (!best || best.score <= 0) return null;
  return best;
}

/* ===========================================================
   BUILD PHASE  (power cards → mobilize → build with kill-pressure)
=========================================================== */
export function mastermindBuildPhase(p) {
  if (MASTERMIND.usePowerCards) {
    try { mastermindMaybePlayPowerCards(p); } catch { /* non-fatal */ }
  }

  let built = false, guard = 120;
  while (guard--) {
    const cand = E.ownedBy(p).filter(t =>
      t.type === 'city' && E.ownsGroup(p, t.group) && !t.mortgaged && t.houses < 5 &&
      E.groupTiles(t.group).every(x => !x.mortgaged));
    if (!cand.length) break;
    const opp = Math.max(1, E.alive().length - 1);
    const scored = cand.map(t => {
      const h = t.houses || 0;
      const cur = h === 0 && E.S().rules.double ? t.rents[0] * 2 : t.rents[h];
      const gain = t.rents[h + 1] - cur;
      let roi = gain * landRate(t.idx) * opp / (t.houseCost || t.price);
      if (h < 3) roi *= 1.6;
      if (h >= 3 && cand.some(x => x.group === t.group && x.houses < 3)) roi *= 0.12;
      let imminent = 1;
      E.alive().forEach(o => {
        if (o.id === p.id) return;
        const pr = E.landProbNext(o.pos, t.idx);
        imminent += pr * 2.5;
        if (canFinish(o, p)) imminent += pr * 6;
      });
      roi *= imminent;
      return { t, roi };
    }).sort((a, b) => b.roi - a.roi);
    const best = scored[0];
    const keep = reserveOf(p);
    if (!best || best.roi <= 0 || p.cash - (best.t.houseCost || best.t.price) < keep) break;
    p.cash -= (best.t.houseCost || best.t.price);
    best.t.houses++;
    built = true;
    E.log(`🏗️ <b>${p.name}</b> builds ${best.t.houses === 5 ? 'a hotel' : 'a house'} in ${best.t.name}.`, p);
  }

  if (E.S().rules.mortgage) mobilizeMortgages(p);
  return built;
}

function mobilizeMortgages(p) {
  if (!E.S().rules.mortgage) return;
  const a = Math.max(1, MASTERMIND.aggression);
  const buffer = Math.max(40, 120 / a);
  const score = t => {
    let s = incomeOf(t, p.id);
    if (t.type === 'city' && (E.ownsGroup(p, t.group) ||
        E.ownedInGroup(p, t.group) >= E.groupSize(t.group) - 1)) s += t.price * 1.5;
    else s += t.price * 0.6;
    return s;
  };
  E.ownedBy(p).filter(t => t.mortgaged).sort((x, y) => score(y) - score(x)).forEach(t => {
    const cost = Math.ceil(t.price / 2 * 1.1);
    if (p.cash - cost > reserveOf(p) + buffer) {
      p.cash -= cost; t.mortgaged = false;
      E.log(`<b>${p.name}</b> lifts the mortgage on ${t.name}.`, p);
    }
  });
}

/* ===========================================================
   RAISE CASH  (sell least-income first; never go suicidal)
=========================================================== */
export function mastermindRaiseCash(p, target) {
  let guard = 160;
  while (p.cash < target && guard--) {
    const housed = E.ownedBy(p).filter(t => t.houses > 0)
      .sort((a, b) => incomeOf(a, p.id) - incomeOf(b, p.id))[0];
    if (housed) {
      housed.houses--; p.cash += Math.floor((housed.houseCost || housed.price) / 2);
      E.log(`<b>${p.name}</b> sells a building in ${housed.name}.`, p);
      continue;
    }
    const single = E.ownedBy(p).filter(t => !t.mortgaged &&
      !(t.type === 'city' && E.ownsGroup(p, t.group)))
      .sort((a, b) => incomeOf(a, p.id) - incomeOf(b, p.id))[0];
    if (single && E.S().rules.mortgage) {
      single.mortgaged = true; p.cash += Math.floor(single.price / 2);
      E.log(`<b>${p.name}</b> mortgages ${single.name}.`, p);
      continue;
    }
    const any = E.ownedBy(p).filter(t => !t.mortgaged).sort((a, b) => a.price - b.price)[0];
    if (any && E.S().rules.mortgage) {
      any.mortgaged = true; p.cash += Math.floor(any.price / 2);
      E.log(`<b>${p.name}</b> mortgages ${any.name}.`, p);
      continue;
    }
    if (any && !E.S().rules.mortgage) {
      any.owner = null; p.cash += Math.floor(any.price / 2);
      E.log(`<b>${p.name}</b> sells ${any.name} back to the bank.`, p);
      continue;
    }
    break;
  }
}

/* ===========================================================
   POWER CARDS — applied directly (engine forbids the bot path)
=========================================================== */
function cardListOf(p) { return Array.isArray(p.powerCards) ? p.powerCards : []; }
function removeCard(p, id) {
  const i = p.powerCards.indexOf(id);
  if (i >= 0) p.powerCards.splice(i, 1);
  if (Array.isArray(p.publicPowers)) {
    const j = p.publicPowers.indexOf(id);
    if (j >= 0) p.publicPowers.splice(j, 1);
  }
}
function potSize() { const s = E.S(); return typeof s.pot === 'number' ? s.pot : 0; }
function bestDemoTarget(bot) {
  let best = null, bv = 0;
  E.TILES().forEach(t => {
    if (t.type !== 'city' || t.owner == null || t.owner === bot.id || t.mortgaged || !t.houses) return;
    const o = E.S().players[t.owner];
    if (!o || o.dead) return;
    const v = E.rentOf(t) * (0.4 + E.landProbNext(bot.pos, t.idx) * 3) * dangerOf(o);
    if (v > bv) { bv = v; best = t; }
  });
  return best;
}
function bestFreeBuildTarget(bot) {
  return E.ownedBy(bot)
    .filter(t => t.type === 'city' && E.ownsGroup(bot, t.group) && !t.mortgaged && t.houses < 5)
    .sort((a, b) => (landRate(b.idx) * (b.rents[(b.houses || 0) + 1] || 0))
                  - (landRate(a.idx) * (a.rents[(a.houses || 0) + 1] || 0)))[0];
}
function rivalAboutToHitMe(bot) {
  let p = 0;
  E.TILES().forEach(t => {
    if (t.owner !== bot.id || t.mortgaged) return;
    E.alive().forEach(o => { if (o.id !== bot.id) p = Math.max(p, E.landProbNext(o.pos, t.idx) * (1 + (t.houses || 0))); });
  });
  return p;
}

export function mastermindPowerCardPhase(p) {
  const cards = cardListOf(p);
  if (!cards.length) return null;
  const has = id => cards.includes(id);
  if (has('bailout') && p.cash < reserveOf(p) * 0.5) return { cardId: 'bailout', target: null };
  if (has('heist') && p.cash < reserveOf(p) * 0.7) return { cardId: 'heist', target: null };
  if (has('demolition')) {
    const t = bestDemoTarget(p);
    if (t && E.rentOf(t) > Math.max(80, reserveOf(p) * 0.4)) return { cardId: 'demolition', target: t.idx };
  }
  const canKill = E.alive().some(o => o.id !== p.id && canFinish(o, p));
  if (has('rent_surge') && (rivalAboutToHitMe(p) > 0.16 || canKill)) return { cardId: 'rent_surge', target: null };
  if (has('phantom_build')) {
    const t = bestFreeBuildTarget(p);
    if (t) return { cardId: 'phantom_build', target: t.idx };
  }
  if (has('vacation_pull') && potSize() > Math.max(150, reserveOf(p))) return { cardId: 'vacation_pull', target: null };
  if (has('shake_down') && E.alive().length > 2) return { cardId: 'shake_down', target: null };
  return null;
}

function mastermindMaybePlayPowerCards(p) {
  if (!E.S().rules || !E.S().rules.powerCards) return;
  let plays = 2;
  while (plays-- > 0) {
    const cards = cardListOf(p);
    if (!cards.length) return;
    const has = id => cards.includes(id);
    const lowCash = p.cash < reserveOf(p) * 0.6;

    if (has('heist') && lowCash) {
      removeCard(p, 'heist'); p.cash += 200;
      E.log(`💎 <b>${p.name}</b> plays Treasury Heist (+$200).`, p);
      continue;
    }
    if (has('bailout') && lowCash) {
      removeCard(p, 'bailout'); p.cash += 120;
      E.log(`🏦 <b>${p.name}</b> plays Emergency Bailout (+$120).`, p);
      continue;
    }

    if (has('demolition')) {
      const t = bestDemoTarget(p);
      if (t && E.rentOf(t) > Math.max(80, reserveOf(p) * 0.4)) {
        removeCard(p, 'demolition');
        if (t.houses === 5) {
          t.houses = 4;
          E.log(`💥 <b>${p.name}</b> demolishes the hotel in ${t.name}.`, p);
        } else {
          t.houses--;
          E.log(`💥 <b>${p.name}</b> demolishes a house in ${t.name}.`, p);
        }
        continue;
      }
    }

    const canKill = E.alive().some(o => o.id !== p.id && canFinish(o, p));
    if (has('rent_surge') && !p.rentSurge && (rivalAboutToHitMe(p) > 0.16 || canKill)) {
      removeCard(p, 'rent_surge'); p.rentSurge = true;
      E.log(`⚡ <b>${p.name}</b> plays Rent Surge — rent doubled until their next turn.`, p);
      continue;
    }

    if (has('phantom_build')) {
      const t = bestFreeBuildTarget(p);
      if (t) {
        removeCard(p, 'phantom_build'); t.houses++;
        E.log(`✨ <b>${p.name}</b> plays Phantom Build — free ${t.houses === 5 ? 'hotel' : 'house'} in ${t.name}.`, p);
        continue;
      }
    }

    if (has('vacation_pull') && potSize() > Math.max(150, reserveOf(p))) {
      removeCard(p, 'vacation_pull');
      const s = E.S();
      let take = 100;
      if (s.pot > 0) { take = Math.min(s.pot, Math.max(100, Math.floor(s.pot / 2))); s.pot -= take; }
      p.cash += take;
      E.log(`🏖️ <b>${p.name}</b> plays Vacation Pull (+${take}).`, p);
      continue;
    }

    if (has('shake_down') && E.alive().length > 2) {
      removeCard(p, 'shake_down');
      let total = 0;
      E.alive().forEach(o => { if (o.id !== p.id) { const pay = Math.min(35, o.cash); o.cash -= pay; total += pay; } });
      p.cash += total;
      E.log(`📉 <b>${p.name}</b> plays Market Shake-down (+${total}).`, p);
      continue;
    }

    if (has('insider_tip') && lowCash) {
      removeCard(p, 'insider_tip'); p.cash += 90;
      E.log(`📡 <b>${p.name}</b> plays Insider Tip (+$90).`, p);
      continue;
    }

    return;
  }
}

/* ===========================================================
   PACING + REGISTER
=========================================================== */
export function mastermindThinkTime(decision = 'roll') {
  const base = { roll: 220, buy: 380, trade: 520, auction: 300, build: 280, power: 360 }[decision] || 280;
  return Math.round(base + Math.random() * 160);
}

export function registerMastermind() {
  MASTERMIND.override = {
    shouldBuy: mastermindShouldBuy,
    nextBid: mastermindNextBid,
    evaluateTrade: mastermindEvaluateTrade,
    buildPhase: mastermindBuildPhase,
    raiseCash: mastermindRaiseCash,
    bestProposal: mastermindBestProposal,
    powerCardPhase: mastermindPowerCardPhase,
  };
  registerPersonality('mastermind', MASTERMIND);
  return MASTERMIND;
}

export default MASTERMIND;
