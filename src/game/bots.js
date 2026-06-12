/* ============================================================
   bots.js — Smart bot brains for Buildup.io
   4 personalities: TYCOON 🏗️, SHARK 🦈, BANKER 🏦, GAMBLER 🎲
   (the 5th, MASTERMIND 🧠, lives in mastermind.js)
============================================================ */

let CTX = null;
export function initBots(ctx) { CTX = ctx; }

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

export const PERSONALITIES = {
  tycoon: {
    key: 'tycoon', label: 'Tycoon 🏗️',
    buyAggro: 1.25, reserve: 120, buildReserve: 160, bidMult: 1.2,
    monopolyHunger: 1.4, denial: 0.7, incomeWeight: 1.1,
    tradeFair: 0.85, lowball: 1.15,
    proposeEvery: 2, jailIQ: 0.8,
  },
  shark: {
    key: 'shark', label: 'Shark 🦈',
    buyAggro: 1.05, reserve: 160, buildReserve: 220, bidMult: 1.1,
    monopolyHunger: 1.1, denial: 1.5, incomeWeight: 1.0,
    tradeFair: 1.05, lowball: 0.7,
    proposeEvery: 2, jailIQ: 1.0,
  },
  banker: {
    key: 'banker', label: 'Banker 🏦',
    buyAggro: 0.85, reserve: 320, buildReserve: 380, bidMult: 0.95,
    monopolyHunger: 0.9, denial: 0.9, incomeWeight: 1.3,
    tradeFair: 0.97, lowball: 0.95,
    proposeEvery: 3, jailIQ: 1.0,
  },
  gambler: {
    key: 'gambler', label: 'Gambler 🎰',
    buyAggro: 1.5, reserve: 40, buildReserve: 80, bidMult: 1.35,
    monopolyHunger: 1.2, denial: 0.4, incomeWeight: 0.8,
    tradeFair: 0.75, lowball: 1.0,
    proposeEvery: 1, jailIQ: 0.5,
  },
};
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
const brainOf = p => PERSONALITIES[p.botBrain] || PERSONALITIES.banker;

function reserveFor(p, brain, building = false) {
  const base = building ? brain.buildReserve : brain.reserve;
  const threat = rentThreat(p) * (0.4 + 0.6 * brain.denial);
  const phase = gamePhase();
  const phaseMult = phase === 'early' ? 0.7 : phase === 'mid' ? 1 : 1.25;
  return brain.hooks?.reserve
    ? brain.hooks.reserve(p, base, threat, phase)
    : Math.round((base + threat * 0.6) * phaseMult);
}

export function botShouldBuy(p, t) {
  const brain = brainOf(p);
  if (brain.override?.shouldBuy) return brain.override.shouldBuy(p, t);
  if (t.owner != null || !t.price || p.cash < t.price) return false;
  const v = acquireValue(t, p, brain) * brain.buyAggro;
  const keep = reserveFor(p, brain);
  if (gamePhase() === 'early' && p.cash - t.price >= keep * 0.6) return v >= t.price * 0.8;
  return v >= t.price && p.cash - t.price >= keep;
}

export function botNextBid(p, tile, currentBid, leaderId = null) {
  const brain = brainOf(p);
  if (brain.override?.nextBid) return brain.override.nextBid(p, tile, currentBid, leaderId);
  if (leaderId === p.id) return null;
  const ceiling = Math.min(
    Math.round(acquireValue(tile, p, brain) * brain.bidMult),
    p.cash - Math.round(reserveFor(p, brain) * 0.5),
  );
  const inc = currentBid < 100 ? 10 : currentBid < 400 ? 50 : 100;
  const next = currentBid + inc;
  if (next > ceiling || next > p.cash) return null;
  if (brain.key === 'gambler' && Math.random() < 0.3 && next + 50 <= ceiling) return next + 50;
  return next;
}

export function botJailDecision(p) {
  const brain = brainOf(p);
  if (brain.hooks?.jail) return brain.hooks.jail(p);
  const phase = gamePhase();
  if (p.goojf > 0 && (phase !== 'late' || brain.jailIQ < 0.7)) return 'card';
  if (phase === 'late' && brain.jailIQ >= 0.7 && rentThreat(p) > 250) return 'roll';
  if (p.cash >= 300 * brain.jailIQ + 100) return 'pay';
  return 'roll';
}

export function botRunBuildPhase(p) {
  const brain = brainOf(p);
  if (brain.override?.buildPhase) return brain.override.buildPhase(p);
  let guard = 60, built = false;
  while (guard--) {
    const candidates = ownedBy(p).filter(t =>
      t.type === 'city' && ownsGroup(p, t.group) && !t.mortgaged && t.houses < 5 &&
      groupTiles(t.group).every(x => !x.mortgaged),
    );
    if (!candidates.length) break;
    const scored = candidates.map(t => {
      const h = t.houses || 0;
      const gain = (t.rents[h + 1] - (h === 0 && S().rules.double ? t.rents[0] * 2 : t.rents[h]));
      let roi = gain * (baseLandRate() * (alive().length - 1)) / t.houseCost;
      if (h >= 3 && candidates.some(x => x.group === t.group && (x.houses || 0) < 3)) roi *= 0.25;
      if (h === 2) roi *= 1.4;
      return { t, roi };
    }).sort((a, b) => b.roi - a.roi);
    const best = scored[0];
    const keep = reserveFor(p, brain, true);
    if (!best || p.cash - best.t.houseCost < keep) break;
    p.cash -= best.t.houseCost;
    best.t.houses++;
    built = true;
    log(`🏗️ <b>${p.name}</b> builds ${best.t.houses === 5 ? 'a hotel' : 'a house'} in ${best.t.name}.`, p);
  }
  if (S().rules.mortgage) {
    ownedBy(p).filter(t => t.mortgaged)
      .sort((a, b) => expectedIncome(b, p.id) - expectedIncome(a, p.id))
      .forEach(t => {
        const cost = Math.ceil(t.price / 2 * 1.1);
        if (p.cash - cost > reserveFor(p, brain, true) + 150) {
          p.cash -= cost; t.mortgaged = false;
          log(`<b>${p.name}</b> lifts the mortgage on ${t.name}.`, p);
        }
      });
  }
  return built;
}

function bundleValueIn(idxs, cash, me, brain) {
  return idxs.reduce((s, i) => s + acquireValue(TILES()[i], me, brain), 0) + cash;
}
function bundleCostOut(idxs, cash, me, them, brain) {
  return idxs.reduce((s, i) => s + releaseCost(TILES()[i], me, them, brain), 0) + cash;
}

export function botEvaluateTrade(bot, trade) {
  const brain = brainOf(bot);
  if (brain.override?.evaluateTrade) return brain.override.evaluateTrade(bot, trade);
  const from = S().players[trade.fromId];
  const get = bundleValueIn(trade.offerIdx, trade.offerCash, bot, brain);
  const give = bundleCostOut(trade.wantIdx, trade.wantCash, bot, from, brain);
  const giftsMonopoly = trade.wantIdx.some(i => {
    const t = TILES()[i];
    return t.type === 'city' && ownedInGroup(from, t.group) === groupSize(t.group) - 1;
  });
  if (giftsMonopoly && get < give * (1.25 + brain.denial * 0.5)) {
    if (give > 0 && bot.cash !== undefined) {
      const need = Math.ceil(give * (1.3 + brain.denial * 0.5) - get);
      if (need > 0 && need <= from.cash) {
        return { action: 'counter', counter: {
          offerIdx: [...trade.wantIdx], wantIdx: [...trade.offerIdx],
          offerCash: trade.wantCash, wantCash: trade.offerCash + need,
        } };
      }
    }
    return { action: 'decline' };
  }
  if (get >= give * brain.tradeFair) return { action: 'accept' };
  const deficit = Math.ceil(give * brain.tradeFair - get);
  if (deficit > 0 && deficit <= from.cash * 0.8 && get >= give * (brain.tradeFair - 0.35)) {
    return { action: 'counter', counter: {
      offerIdx: [...trade.wantIdx], wantIdx: [...trade.offerIdx],
      offerCash: Math.max(0, trade.wantCash - Math.min(trade.wantCash, deficit)),
      wantCash: trade.offerCash + Math.max(0, deficit - trade.wantCash),
    } };
  }
  return { action: 'decline' };
}

export function botBestProposal(bot) {
  const brain = brainOf(bot);
  const tradableOf = pl => ownedBy(pl).filter(t => !t.mortgaged && t.houses === 0);
  let best = null;
  const consider = c => { if (c && (!best || c.score > best.score)) best = c; };

  alive().forEach(opp => {
    if (opp.id === bot.id) return;
    const oppTradable = tradableOf(opp);

    oppTradable.forEach(t => {
      if (t.type !== 'city') return;
      if (ownedInGroup(bot, t.group) !== groupSize(t.group) - 1) return;
      const worth = acquireValue(t, bot, brain);
      const oppAsk = releaseCost(t, opp, bot, brainOf(opp));
      let cash = Math.round(Math.min(worth * 0.9, oppAsk * brain.lowball));
      cash = Math.min(cash, Math.floor(bot.cash * 0.65));
      if (cash < t.price * 0.9) return;
      const sweetener = tradableOf(bot).find(x =>
        x.type === 'city' && ownedInGroup(bot, x.group) === 1 &&
        ownedInGroup(opp, x.group) < groupSize(x.group) - 1 &&
        releaseCost(x, bot, opp, brain) < x.price * 1.1,
      );
      consider({
        score: worth - cash - (sweetener ? sweetener.price * 0.8 : 0),
        toId: opp.id,
        offerIdx: sweetener ? [sweetener.idx] : [],
        wantIdx: [t.idx], offerCash: cash, wantCash: 0,
      });
    });

    oppTradable.forEach(theirT => {
      if (theirT.type !== 'city' || ownedInGroup(bot, theirT.group) !== groupSize(theirT.group) - 1) return;
      tradableOf(bot).forEach(myT => {
        if (myT.type !== 'city' || ownedInGroup(opp, myT.group) !== groupSize(myT.group) - 1) return;
        const myGain = acquireValue(theirT, bot, brain) - releaseCost(myT, bot, opp, brain);
        if (myGain < -theirT.price * 0.2) return;
        const balance = Math.round(Math.max(0, -myGain) * 1.05);
        if (balance > bot.cash * 0.6) return;
        consider({
          score: myGain + theirT.price * 0.6,
          toId: opp.id, offerIdx: [myT.idx], wantIdx: [theirT.idx],
          offerCash: balance, wantCash: 0,
        });
      });
    });

    if (brain.denial >= 1.2) {
      oppTradable.forEach(t => {
        if (t.type !== 'city') return;
        const threatened = alive().some(third =>
          third.id !== bot.id && third.id !== opp.id &&
          ownedInGroup(third, t.group) === groupSize(t.group) - 1);
        if (!threatened) return;
        const cash = Math.min(Math.round(t.price * 1.2), Math.floor(bot.cash * 0.4));
        if (cash < t.price) return;
        consider({ score: t.price * 0.5, toId: opp.id, offerIdx: [], wantIdx: [t.idx], offerCash: cash, wantCash: 0 });
      });
    }
  });

  if (!best || best.score <= 0) return null;
  if (bot.cash - best.offerCash < reserveFor(bot, brain) * 0.5) return null;
  return best;
}

export function botMaybeProposeTrade(bot) {
  if (!CTX?.addOpenTrade || bot.dead || !bot.bot || !S().rules.trades) return false;
  const brain = brainOf(bot);
  bot._lastPropose = bot._lastPropose || 0;
  if ((bot.turnsSurvived || 0) - bot._lastPropose < brain.proposeEvery) return false;
  if ((S().openTrades || []).some(t => t.fromId === bot.id && t.status === 'pending')) return false;
  const deal = botBestProposal(bot);
  if (!deal) return false;
  bot._lastPropose = bot.turnsSurvived || 0;
  const to = S().players[deal.toId];
  const trade = CTX.addOpenTrade(bot, to, deal.offerIdx, deal.wantIdx, deal.offerCash, deal.wantCash);
  log(`📨 <b>${bot.name}</b> sends a trade offer to <b>${to.name}</b>.`, bot);
  if (to.bot) CTX.scheduleBotTradeResponse?.(trade);
  else CTX.openTradeDetail?.(trade.id, 'incoming');
  CTX.renderAll?.();
  return true;
}

export const _engine = {
  acquireValue, releaseCost, expectedIncome, rentThreat, rentOf,
  landProbNext, baseLandRate, gamePhase, netWorth,
  alive, ownedBy, groupTiles, ownsGroup, ownedInGroup, groupSize, countType,
  reserveFor, S, TILES, GROUPS, log,
};
