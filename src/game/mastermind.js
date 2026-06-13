/* ============================================================
   mastermind.js — MASTERMIND 🧠  (v2, "maxed")
   ------------------------------------------------------------
   Expert bot: Markov landing model, phase-aware valuation,
   smart liquidation, and +EV trade proposals.
============================================================ */

import { registerPersonality, _engine as E } from './botCore.js';

const DICE_P = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const AIR_RENTS = [0, 50, 100, 150, 250, 400, 600, 800, 1000];
const UTL_MULT = [0, 4, 10, 20, 30];

/* —— TRUE LANDING-FREQUENCY MODEL (Markov stationary dist.) —— */
let _lm = { sig: '', freq: null };

function landingModel() {
  const tiles = E.TILES();
  const n = tiles.length;
  const jailIdx = tiles.findIndex(t => t.type === 'jail');
  const gotoIdx = tiles.findIndex(t => t.type === 'gotojail');
  const sig = `${n}:${jailIdx}:${gotoIdx}`;
  if (_lm.sig === sig && _lm.freq) return _lm.freq;

  const moves = [];
  for (let d = 2; d <= 12; d++) moves.push([d, DICE_P[d] / 36]);

  const dest = (i, d) => {
    let j = (i + d) % n;
    if (tiles[j]?.type === 'gotojail' && jailIdx >= 0) j = jailIdx;
    return j;
  };

  let v = new Array(n).fill(1 / n);
  for (let iter = 0; iter < 240; iter++) {
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

function valueOf(t, p) {
  if (!t.price) return 0;
  let v = t.price;
  if (t.type === 'city') {
    const g = t.group, sz = E.groupSize(g), mine = E.ownedInGroup(p, g);
    if (mine === sz - 1) {
      v = Math.max(v, Math.round(monopolyPotential(g, p) * 0.55 + t.price));
    } else if (mine > 0) {
      v *= 1 + 0.4 * mine;
    }
    E.alive().forEach(o => {
      if (o.id === p.id) return;
      if (E.ownedInGroup(o, g) === sz - 1) {
        v = Math.max(v, Math.round(monopolyPotential(g, o) * 0.4 + t.price));
      }
    });
  } else if (t.type === 'air') v *= 1 + 0.25 * E.countType(p, 'air');
  else if (t.type === 'utl') v *= 1 + 0.18 * E.countType(p, 'utl');
  v += incomeOf(t, p.id) * horizon() * 0.5;
  if (E.gamePhase() === 'late') v *= 1.12;
  return Math.round(v);
}

function releaseCost(t, me, to) {
  let c = valueOf(t, me) * 0.9;
  if (t.type === 'city') {
    const sz = E.groupSize(t.group), theirs = E.ownedInGroup(to, t.group);
    if (theirs === sz - 1) c += monopolyPotential(t.group, to) * 0.6;
    else if (theirs > 0) c += t.price * 0.35;
    if (E.ownedInGroup(me, t.group) === sz) c += t.price * 3;
  }
  return Math.round(c);
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

const MASTERMIND = {
  key: 'mastermind', label: 'Mastermind 🧠',
  buyAggro: 1.0, reserve: 150, buildReserve: 200, bidMult: 1.0,
  monopolyHunger: 1.6, denial: 2.0, incomeWeight: 1.6,
  tradeFair: 1.0, lowball: 0.8, proposeEvery: 1, jailIQ: 1.0,

  hooks: {
    reserve(p, _base, _threat, phase) {
      const t = deepThreat(p);
      const survival = t.worst + t.expected * 1.2;
      const floor = phase === 'early' ? 60 : phase === 'mid' ? 160 : 260;
      const capFrac = phase === 'early' ? 0.45 : phase === 'mid' ? 0.6 : 0.75;
      return Math.round(Math.max(floor, Math.min(survival, p.cash * capFrac)));
    },

    jail(p) {
      const phase = E.gamePhase();
      const t = deepThreat(p);
      if (phase === 'late' && t.expected > 55) return 'roll';
      if (p.goojf > 0) return 'card';
      if (p.cash >= 280 && phase !== 'late') return 'pay';
      return 'roll';
    },
  },
};

function reserveOf(p) { return MASTERMIND.hooks.reserve(p, 0, 0, E.gamePhase()); }

export function mastermindShouldBuy(p, t) {
  if (t.owner != null || !t.price || p.cash < t.price) return false;
  const keep = reserveOf(p);
  const v = valueOf(t, p);
  if (E.gamePhase() === 'early') return p.cash - t.price >= keep * 0.5 && v >= t.price * 0.7;
  return v >= t.price && p.cash - t.price >= keep;
}

export function mastermindNextBid(p, tile, currentBid, leaderId = null) {
  if (leaderId === p.id) return null;
  const keep = reserveOf(p);
  const ceiling = Math.min(valueOf(tile, p), p.cash - Math.round(keep * 0.4));
  const inc = currentBid < 100 ? 10 : currentBid < 400 ? 50 : 100;
  const next = currentBid + inc;
  return (next <= ceiling && next <= p.cash) ? next : null;
}

export function mastermindEvaluateTrade(bot, trade) {
  const from = E.S().players[trade.fromId];
  let get = trade.offerCash;
  trade.offerIdx.forEach(i => { get += valueOf(E.TILES()[i], bot); });
  let give = trade.wantCash, gifts = 0;
  trade.wantIdx.forEach(i => {
    const t = E.TILES()[i];
    give += releaseCost(t, bot, from);
    if (t.type === 'city' && E.ownedInGroup(from, t.group) === E.groupSize(t.group) - 1) {
      gifts += monopolyPotential(t.group, from) * 0.5;
    }
  });

  if (gifts > 0) {
    const need = Math.ceil(give + gifts * 1.2 - get);
    if (need <= 0) return { action: 'accept' };
    if (need <= from.cash) return { action: 'counter', counter: {
      offerIdx: [...trade.wantIdx], wantIdx: [...trade.offerIdx],
      offerCash: trade.wantCash, wantCash: trade.offerCash + need,
    } };
    return { action: 'decline' };
  }

  if (get >= give) return { action: 'accept' };
  const deficit = Math.ceil(give - get);
  if (deficit <= from.cash * 0.85) {
    const ask = Math.ceil(deficit * 1.05);
    return { action: 'counter', counter: {
      offerIdx: [...trade.wantIdx], wantIdx: [...trade.offerIdx],
      offerCash: Math.max(0, trade.wantCash - Math.min(trade.wantCash, ask)),
      wantCash: trade.offerCash + Math.max(0, ask - trade.wantCash),
    } };
  }
  return { action: 'decline' };
}

export function mastermindBuildPhase(p) {
  let built = false, guard = 90;
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
      let roi = gain * landRate(t.idx) * opp / t.houseCost;
      if (h < 3) roi *= 1.5;
      if (h >= 3 && cand.some(x => x.group === t.group && x.houses < 3)) roi *= 0.15;
      E.alive().forEach(o => { if (o.id !== p.id) roi *= 1 + E.landProbNext(o.pos, t.idx) * 2; });
      return { t, roi };
    }).sort((a, b) => b.roi - a.roi);
    const best = scored[0];
    const keep = reserveOf(p);
    if (!best || best.roi <= 0 || p.cash - best.t.houseCost < keep) break;
    p.cash -= best.t.houseCost;
    best.t.houses++;
    built = true;
    E.log(`🏗️ <b>${p.name}</b> builds ${best.t.houses === 5 ? 'a hotel' : 'a house'} in ${best.t.name}.`, p);
  }
  if (E.S().rules.mortgage) {
    E.ownedBy(p).filter(t => t.mortgaged)
      .sort((a, b) => incomeOf(b, p.id) - incomeOf(a, p.id))
      .forEach(t => {
        const cost = Math.ceil(t.price / 2 * 1.1);
        if (p.cash - cost > reserveOf(p) + 100) {
          p.cash -= cost; t.mortgaged = false;
          E.log(`<b>${p.name}</b> lifts the mortgage on ${t.name}.`, p);
        }
      });
  }
  return built;
}

export function mastermindRaiseCash(p, target) {
  let guard = 140;
  while (p.cash < target && guard--) {
    const housed = E.ownedBy(p).filter(t => t.houses > 0)
      .sort((a, b) => incomeOf(a, p.id) - incomeOf(b, p.id))[0];
    if (housed) {
      if (housed.houses === 5) { housed.houses = 4; p.cash += Math.floor(housed.houseCost / 2); }
      else { housed.houses--; p.cash += Math.floor(housed.houseCost / 2); }
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

export function mastermindBestProposal(bot) {
  const tradableOf = pl => E.ownedBy(pl).filter(t => !t.mortgaged && t.houses === 0);
  let best = null;
  const consider = c => { if (c && (!best || c.score > best.score)) best = c; };

  E.alive().forEach(opp => {
    if (opp.id === bot.id) return;
    const theirs = tradableOf(opp), mine = tradableOf(bot);

    theirs.forEach(t => {
      if (t.type !== 'city' || E.ownedInGroup(bot, t.group) !== E.groupSize(t.group) - 1) return;
      const worth = valueOf(t, bot);
      const ask = releaseCost(t, opp, bot);
      let cash = Math.round(Math.min(worth * 0.85, ask * 0.85));
      cash = Math.min(cash, Math.floor(bot.cash * 0.6));
      if (cash < t.price * 0.9) return;
      consider({ score: worth - cash, toId: opp.id, offerIdx: [], wantIdx: [t.idx], offerCash: cash, wantCash: 0 });
    });

    theirs.forEach(theirT => {
      if (theirT.type !== 'city' || E.ownedInGroup(bot, theirT.group) !== E.groupSize(theirT.group) - 1) return;
      mine.forEach(myT => {
        if (myT.type !== 'city' || E.ownedInGroup(opp, myT.group) !== E.groupSize(myT.group) - 1) return;
        const gain = valueOf(theirT, bot) - releaseCost(myT, bot, opp);
        const balance = Math.round(Math.max(0, -gain) * 1.05);
        if (balance > bot.cash * 0.6) return;
        consider({ score: gain + theirT.price * 0.6, toId: opp.id, offerIdx: [myT.idx], wantIdx: [theirT.idx], offerCash: balance, wantCash: 0 });
      });
    });
  });

  if (!best || best.score <= 0) return null;
  if (bot.cash - best.offerCash < reserveOf(bot) * 0.5) return null;
  return best;
}

export function mastermindThinkTime(decision = 'roll') {
  const base = { roll: 700, buy: 1100, trade: 1700, auction: 900, build: 800 }[decision] || 800;
  return Math.round(base + Math.random() * 700);
}

export function registerMastermind() {
  MASTERMIND.override = {
    shouldBuy: mastermindShouldBuy,
    nextBid: mastermindNextBid,
    evaluateTrade: mastermindEvaluateTrade,
    buildPhase: mastermindBuildPhase,
    raiseCash: mastermindRaiseCash,
    bestProposal: mastermindBestProposal,
  };
  registerPersonality('mastermind', MASTERMIND);
  return MASTERMIND;
}

export default MASTERMIND;
