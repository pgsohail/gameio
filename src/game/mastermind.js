/* ============================================================
   mastermind.js — MASTERMIND 🧠
============================================================ */

import { PERSONALITIES, registerPersonality, _engine as E } from './botCore.js';

function portfolioIncome(pl) {
  return E.ownedBy(pl).reduce((s, t) => s + E.expectedIncome(t, pl.id), 0);
}

function monopolyPotential(g, pl) {
  const tiles = E.groupTiles(g);
  const oppCount = E.alive().length - 1;
  let income = 0, buildCost = 0;
  tiles.forEach(t => {
    income += t.rents[3] * E.baseLandRate() * oppCount;
    buildCost += t.houseCost * 3;
  });
  const afford = Math.min(1, Math.max(0.35, pl.cash / Math.max(1, buildCost)));
  return income * 20 * afford;
}

function deepThreat(p) {
  let exp1 = 0, worst = 0;
  const opTiles = E.TILES().filter(t => {
    if (t.owner == null || t.owner === p.id || t.mortgaged) return false;
    const o = E.S().players[t.owner];
    return o && !o.dead;
  });
  opTiles.forEach(t => {
    const r = E.rentOf(t);
    if (!r) return;
    const pr = E.landProbNext(p.pos, t.idx);
    exp1 += r * pr;
    if (pr > 0) worst = Math.max(worst, r);
  });
  let exp2 = 0;
  const pos2 = (p.pos + 7) % E.TILES().length;
  opTiles.forEach(t => { exp2 += E.rentOf(t) * E.landProbNext(pos2, t.idx); });
  return { expected: exp1 + exp2 * 0.8, worst };
}

const MASTERMIND = {
  key: 'mastermind', label: 'Mastermind 🧠',
  buyAggro: 1.0, reserve: 150, buildReserve: 200, bidMult: 1.0,
  monopolyHunger: 1.6, denial: 2.0, incomeWeight: 1.6,
  tradeFair: 1.0, lowball: 0.8,
  proposeEvery: 1, jailIQ: 1.0,

  hooks: {
    reserve(p, _base, _threat, phase) {
      const t = deepThreat(p);
      const survival = t.worst * (phase === 'late' ? 1.0 : 0.6) + t.expected;
      const floor = phase === 'early' ? 60 : phase === 'mid' ? 140 : 220;
      return Math.round(Math.max(floor, Math.min(survival, p.cash * 0.55, 900)));
    },

    jail(p) {
      const phase = E.gamePhase();
      const t = deepThreat(p);
      if (phase === 'late' && t.expected > 60) return 'roll';
      if (p.goojf > 0) return 'card';
      if (p.cash >= 300 && phase !== 'late') return 'pay';
      return 'roll';
    },
  },
};

function geniusAcquireValue(t, p) {
  let v = E.acquireValue(t, p, MASTERMIND);
  if (t.type === 'city') {
    const g = t.group, sz = E.groupSize(g);
    if (E.ownedInGroup(p, g) === sz - 1) {
      v = Math.max(v, Math.round(monopolyPotential(g, p) * 0.5 + t.price));
    }
    E.alive().forEach(o => {
      if (o.id === p.id) return;
      if (E.ownedInGroup(o, g) === sz - 1) {
        v = Math.max(v, Math.round(monopolyPotential(g, o) * 0.35 + t.price));
      }
    });
  }
  return v;
}

export function mastermindShouldBuy(p, t) {
  if (t.owner != null || !t.price || p.cash < t.price) return false;
  const keep = MASTERMIND.hooks.reserve(p, 0, 0, E.gamePhase());
  const v = geniusAcquireValue(t, p);
  if (E.gamePhase() === 'early') return p.cash - t.price >= keep * 0.5 && v >= t.price * 0.75;
  return v >= t.price && p.cash - t.price >= keep;
}

export function mastermindNextBid(p, tile, currentBid, leaderId = null) {
  if (leaderId === p.id) return null;
  const keep = MASTERMIND.hooks.reserve(p, 0, 0, E.gamePhase());
  const ceiling = Math.min(geniusAcquireValue(tile, p), p.cash - Math.round(keep * 0.4));
  const inc = currentBid < 100 ? 10 : currentBid < 400 ? 50 : 100;
  const next = currentBid + inc;
  return (next <= ceiling && next <= p.cash) ? next : null;
}

export function mastermindEvaluateTrade(bot, trade) {
  const from = E.S().players[trade.fromId];
  let get = trade.offerCash;
  trade.offerIdx.forEach(i => { get += geniusAcquireValue(E.TILES()[i], bot); });
  let give = trade.wantCash, gifts = 0;
  trade.wantIdx.forEach(i => {
    const t = E.TILES()[i];
    give += E.releaseCost(t, bot, from, MASTERMIND);
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
  let built = false, guard = 80;
  while (guard--) {
    const cand = E.ownedBy(p).filter(t =>
      t.type === 'city' && E.ownsGroup(p, t.group) && !t.mortgaged && t.houses < 5 &&
      E.groupTiles(t.group).every(x => !x.mortgaged));
    if (!cand.length) break;
    const oppCount = E.alive().length - 1;
    const scored = cand.map(t => {
      const h = t.houses || 0;
      const cur = h === 0 && E.S().rules.double ? t.rents[0] * 2 : t.rents[h];
      const gain = t.rents[h + 1] - cur;
      let roi = gain * E.baseLandRate() * oppCount / t.houseCost;
      if (h < 3) roi *= 1.5;
      if (h >= 3 && cand.some(x => x.group === t.group && x.houses < 3)) roi *= 0.15;
      E.alive().forEach(o => { if (o.id !== p.id) roi *= 1 + E.landProbNext(o.pos, t.idx) * 2; });
      return { t, roi };
    }).sort((a, b) => b.roi - a.roi);
    const best = scored[0];
    const keep = MASTERMIND.hooks.reserve(p, 0, 0, E.gamePhase());
    if (!best || best.roi <= 0 || p.cash - best.t.houseCost < keep) break;
    p.cash -= best.t.houseCost;
    best.t.houses++;
    built = true;
    E.log(`🏗️ <b>${p.name}</b> builds ${best.t.houses === 5 ? 'a hotel' : 'a house'} in ${best.t.name}.`, p);
  }
  if (E.S().rules.mortgage) {
    E.ownedBy(p).filter(t => t.mortgaged)
      .sort((a, b) => E.expectedIncome(b, p.id) - E.expectedIncome(a, p.id))
      .forEach(t => {
        const cost = Math.ceil(t.price / 2 * 1.1);
        const keep = MASTERMIND.hooks.reserve(p, 0, 0, E.gamePhase());
        if (p.cash - cost > keep + 100) {
          p.cash -= cost; t.mortgaged = false;
          E.log(`<b>${p.name}</b> lifts the mortgage on ${t.name}.`, p);
        }
      });
  }
  return built;
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
  };
  registerPersonality('mastermind', MASTERMIND);
  return MASTERMIND;
}

export default MASTERMIND;
