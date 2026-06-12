import { countriesForBoard, AIRPORTS, UTILITIES, GROUP_PALETTE } from '../data/countries.js';
import { POWER_DRAW_CHANCE, pickRandomPowerCard, powerCardById } from '../data/powerCards.js';
import { flagModalHTML, flagSrc } from '../lib/flags.js';
import { fmt, rand, shuffle, $ } from '../lib/format.js';
import { buildTileParts, tileIcon as tileIconHTML } from '../ui/tiles.js';
import { buildPropSheet, propBodyHTML } from '../ui/propModal.js';
import { renderCountryBrackets, scheduleCountryBrackets } from '../ui/countryBrackets.js';
import { Dice3D, DICE_ROLL_MS } from '../ui/dice.js';
import {
  playCountryMonopoly, playGameOverWin, playJailBars, playPurchaseTing, playTradeSuccess,
} from '../lib/sounds.js';
import {
  bindPropDockResize, clearPropDock, clearPropTileFocus, focusPropTile,
  playBuildAnimation, playCountryMonopolyAnim, playDestroyAnimationSync, playJailArrest, playPurchaseGlow,
  playTileCashFx, playTradeSuccessAnim, positionPropDock, renderTileBuildings,
} from '../ui/buildAnim.js';
import { initLobby, playAgainAfterGame, setGameBrandVisible } from '../ui/lobby.js';
import { BRIGHT_COLORS } from '../lib/colors.js';
import { getUser } from '../lib/auth.js';
import {
  isMpGame, isMultiplayerActive, isApplyingRemote, queueStateBroadcast,
  broadcastStateNow, broadcastDiceRoll, registerStateSync, registerStateImporter,
  registerDiceRollHandler, rebuildDeck,
} from '../lib/multiplayer.js';

/* ============================================================
   PROCEDURAL BOARD GENERATOR — any size, country groups
============================================================ */
function genBoard(per){
  const n=per*4;
  const slots=new Array(n).fill(null);
  slots[0]={type:'go',name:'START',flag:'🧭'};
  slots[per]={type:'jail',name:'Prison',flag:'⛓️'};
  slots[2*per]={type:'fair',name:'Vacation',flag:'🏖️'};
  slots[3*per]={type:'gotojail',name:'Go to Prison',flag:'☠️'};
  const placeNear=(i,t)=>{i=((i%n)+n)%n;
    for(let d=0;d<n;d++)for(const j of [i+d,i-d]){const k=((j%n)+n)%n;if(slots[k]==null){slots[k]=t;return k;}}};
  const nAir=per<=10?4:per<=13?6:8;
  const nUtl=per<=10?2:per<=13?3:4;
  const nSur=Math.max(3,Math.round(n/13));
  const nTre=nSur;
  for(let k=0;k<nAir;k++)placeNear(Math.round(n*(k+0.5)/nAir),{type:'air',name:AIRPORTS[k%AIRPORTS.length],group:'air',price:200,flag:'✈️',airVariant:k%AIRPORTS.length});
  for(let k=0;k<nUtl;k++){const u=UTILITIES[k%UTILITIES.length];placeNear(Math.round(n*(k+0.62)/nUtl),{type:'utl',name:u.name,flag:u.flag,utlKey:u.key,group:'utl',price:150});}
  placeNear(Math.round(n*0.09),{type:'tax',name:'Earnings Tax',amount:200,flag:'🧾'});
  placeNear(Math.round(n*0.79),{type:'tax',name:'Premium Tax',amount:150,flag:'💎'});
  for(let k=0;k<nSur;k++)placeNear(Math.round(n*(k+0.33)/nSur),{type:'fortune',name:'Surprise',flag:'❓'});
  for(let k=0;k<nTre;k++)placeNear(Math.round(n*(k+0.85)/nTre),{type:'treasury',name:'Treasure',flag:'🧰'});
  // remaining slots → cities, grouped by country
  const cityIdx=[];for(let i=0;i<n;i++)if(slots[i]==null)cityIdx.push(i);
  const cCount=cityIdx.length;
  const twos=(3-(cCount%3))%3, threes=(cCount-2*twos)/3;
  const sizes=[];if(twos>0)sizes.push(2);for(let i=0;i<threes;i++)sizes.push(3);if(twos>1)sizes.push(2);
  const numG=sizes.length;
  GROUPS={air:{name:'Airports',color:'#3E4A5E',flag:'✈️'},utl:{name:'Utilities',color:'#2E7890',flag:'⚡'}};
  let ci=0;
  const boardCountries=countriesForBoard(numG);
  sizes.forEach((sz,g)=>{
    const country=boardCountries[g];
    const base=Math.round((60+(numG<=1?0:g/(numG-1))*340)/10)*10;
    const gid='g'+g;
    GROUPS[gid]={name:country.name,color:GROUP_PALETTE[g%GROUP_PALETTE.length],flag:country.flag,iso:country.iso};
    for(let m=0;m<sz;m++){
      slots[cityIdx[ci++]]={type:'city',name:country.cities[m%country.cities.length],group:gid,price:base+(m===sz-1?20:0),flag:country.flag,iso:country.iso};
    }
  });
  return slots;
}
function boardStats(per){
  const b=genBoard(per);
  const cities=b.filter(t=>t.type==='city').length;
  const countries=new Set(b.filter(t=>t.type==='city').map(t=>t.group)).size;
  const air=b.filter(t=>t.type==='air').length, utl=b.filter(t=>t.type==='utl').length;
  return `${per * 4} tiles, ${cities} cities in ${countries} countries, ${air} airports, ${utl} utilities`;
}

/* ---------------- card decks (board-agnostic) ---------------- */
const FORTUNE=[
  {x:'Tailwinds all the way — advance to START and collect your salary.',f:s=>goTo(s,0,true)},
  {x:'A red-eye east. Move directly to the most expensive city on the board.',f:s=>goTo(s,priciest(),true)},
  {x:'Budget backpacking — travel to the cheapest city on the board.',f:s=>goTo(s,cheapest(),true)},
  {x:'Shortcut through the hills. Advance 5 tiles.',f:s=>moveBy(s,5)},
  {x:'Your visa was misfiled. Go directly to Prison. Do not pass START.',f:s=>sendToJail(s)},
  {x:'Take the express to the nearest airport. If it is owned, pay the owner double rent.',f:s=>nearestAirport(s)},
  {x:'You overslept and missed boarding. Move back 3 tiles.',f:s=>moveBy(s,-3)},
  {x:'Speeding fine on the autobahn. Pay $40.',f:s=>charge(s,40)},
  {x:'Your travel vlog goes viral. Collect $120.',f:s=>credit(s,120)},
  {x:'Airline bumps you to first class and refunds the fare. Collect $75.',f:s=>credit(s,75)},
  {x:'Currency exchange works in your favor. Collect $60.',f:s=>credit(s,60)},
  {x:'Lost luggage claim finally pays out. Collect $90.',f:s=>credit(s,90)},
  {x:'Renovation audit: pay $30 per house and $120 per hotel you own.',f:s=>repairs(s,30,120)},
  {x:'Customs duty on souvenirs. Pay $55.',f:s=>charge(s,55)},
  {x:'You win the street-food championship. Collect $100.',f:s=>credit(s,100)},
  {x:'Frequent-flyer status upgrade — keep this card to leave Prison free.',f:s=>{s.cur.goojf++;log(`<b>${s.cur.name}</b> pockets a <b>Get Out of Prison Free</b> card.`,s.cur)}},
  {x:'A rival pays you to swap seats. Collect $25 from every player.',f:s=>collectEach(s,25)},
  {x:'Charter a boat party for the table. Pay every player $20.',f:s=>payEach(s,20)},
  {x:'Wrong terminal! Walk back 2 tiles.',f:s=>moveBy(s,-2)},
  {x:'A tailor in the bazaar overcharges you. Pay $30.',f:s=>charge(s,30)},
];
const TREASURY=[
  {x:'City bond matures. Collect $150.',f:s=>credit(s,150)},
  {x:'Tax refund arrives. Collect $50.',f:s=>credit(s,50)},
  {x:'Hotel review bonus — collect $40.',f:s=>credit(s,40)},
  {x:'Hospital bill abroad. Pay $110.',f:s=>charge(s,110)},
  {x:'Language school tuition. Pay $80.',f:s=>charge(s,80)},
  {x:'You inherit a tiny vineyard. Collect $130.',f:s=>credit(s,130)},
  {x:'Street performance tips. Collect $20.',f:s=>credit(s,20)},
  {x:'It is your birthday! Collect $20 from every player.',f:s=>collectEach(s,20)},
  {x:'Crowdfund a friend\'s café — pay $35.',f:s=>charge(s,35)},
  {x:'Consulting gig pays out. Collect $95.',f:s=>credit(s,95)},
  {x:'Travel insurance premium due. Pay $60.',f:s=>charge(s,60)},
  {x:'Second prize in a photography contest. Collect $70.',f:s=>credit(s,70)},
  {x:'Return to START and collect your salary.',f:s=>goTo(s,0,true)},
  {x:'Property assessment: pay $45 per house and $130 per hotel you own.',f:s=>repairs(s,45,130)},
  {x:'Embassy paperwork fee. Pay $50.',f:s=>charge(s,50)},
  {x:'Diplomatic immunity — keep this card to leave Prison free.',f:s=>{s.cur.goojf++;log(`<b>${s.cur.name}</b> pockets a <b>Get Out of Prison Free</b> card.`,s.cur)}},
  {x:'Pickpocketed in the plaza. Pay $40.',f:s=>charge(s,40)},
  {x:'Sell your travel photos to a magazine. Collect $85.',f:s=>credit(s,85)},
  {x:'A grateful tourist tips you for directions. Collect $15.',f:s=>credit(s,15)},
  {x:'Sponsor the Vacation fireworks. Pay $75.',f:s=>charge(s,75)},
];
function priciest(){let bi=0,bp=-1;TILES.forEach((t,i)=>{if(t.type==='city'&&t.price>bp){bp=t.price;bi=i;}});return bi;}
function cheapest(){let bi=0,bp=1e9;TILES.forEach((t,i)=>{if(t.type==='city'&&t.price<bp){bp=t.price;bi=i;}});return bi;}

/* ============================================================
   STATE
============================================================ */
const PLAYER_COLORS=BRIGHT_COLORS;
const TOKEN_EMOJI=['🚂','✈️','🚢','🎩','🚗','🚀','🐪','🦁','🏎️','🛸','🎒','🌍','🛳️','🚁','🏍️','🐘'];
const DIFF={relaxed:{buyBuf:350,buildRes:450,bidMult:0.9},classic:{buyBuf:180,buildRes:250,bidMult:1.1},shark:{buyBuf:60,buildRes:120,bidMult:1.35}};
let tradeSeq=1;
const DICE_SYNC_LEAD_MS = 250;
const TURN_LIMIT_MS = 120_000;
const TURN_ENGAGE_WARN_MS = 20_000;
const TURN_BONUS_MS = 30_000;
const TRADE_QUEUE_MAX = 5;
const TRADE_EXPIRE_WARN_MS = 10_000;
let turnTimerInterval = null;
let turnTimeoutHandled = false;
const tradeActivityLog = [];
const S={players:[],turn:0,phase:'idle',dice:[1,1],doubles:0,fortune:[],treasury:[],pot:0,over:false,recentTrades:[],openTrades:[],rules:{},
  turnStartedAt:0,voteKick:{voters:[]},
  get cur(){return this.players[this.turn];}};

let GROUPS={};
let TILES=[],N=0,PER=0,GRID=0,JAIL_IDX=0;
const AIR_RENTS=[0,50,100,150,250,400,600,800,1000];
const UTL_MULT=[0,4,10,20,30];

/* ============================================================
   LOBBY → GAME
============================================================ */
function exportGameState() {
  return {
    turn: S.turn,
    phase: S.phase,
    dice: S.dice,
    doubles: S.doubles,
    pot: S.pot,
    over: S.over,
    pendingDouble: !!S.pendingDouble,
    players: S.players.map(p => ({
      id: p.id,
      userId: p.userId,
      name: p.name,
      bot: p.bot,
      emoji: p.emoji,
      color: p.color,
      isAdmin: p.isAdmin,
      cash: p.cash,
      pos: p.pos,
      jail: p.jail,
      jailTurns: p.jailTurns,
      goojf: p.goojf,
      dead: p.dead,
      debt: p.debt ? { ...p.debt } : null,
      powerCards: p.powerCards ? [...p.powerCards] : [],
      rentSurge: p.rentSurge,
      taxShield: p.taxShield,
      turnsSurvived: p.turnsSurvived || 0,
      turnEngaged: !!p.turnEngaged,
      turnBonusUsed: !!p.turnBonusUsed,
    })),
    tiles: TILES.map(t => ({
      owner: t.owner,
      houses: t.houses,
      mortgaged: t.mortgaged,
    })),
    fortuneKeys: S.fortune.map(c => c.x),
    treasuryKeys: S.treasury.map(c => c.x),
    turnStartedAt: S.turnStartedAt || 0,
    voteKick: S.voteKick ? { voters: [...(S.voteKick.voters || [])] } : { voters: [] },
    voteKickedUsers: [...(S.voteKickedUsers || [])],
    auction: serializeAuction(),
    openTrades: (S.openTrades || []).map(t => ({
      id: t.id,
      fromId: t.fromId,
      toId: t.toId,
      offerIdx: [...t.offerIdx],
      wantIdx: [...t.wantIdx],
      offerCash: t.offerCash,
      wantCash: t.wantCash,
      status: t.status,
      awaitingId: t.awaitingId,
      round: t.round,
      history: t.history.map(h => ({
        round: h.round,
        by: h.by,
        offerIdx: h.offerIdx ? [...h.offerIdx] : undefined,
        wantIdx: h.wantIdx ? [...h.wantIdx] : undefined,
        offerCash: h.offerCash,
        wantCash: h.wantCash,
        text: h.text,
      })),
    })),
    tradeSeq,
  };
}

let remoteRollUntil = 0;

function importGameState(state) {
  if (!state || !state.players?.length) return;
  S.turn = state.turn ?? 0;
  S.phase = state.phase ?? 'idle';
  if (Date.now() >= remoteRollUntil) S.dice = state.dice || [1, 1];
  S.doubles = state.doubles ?? 0;
  S.pot = state.pot ?? 0;
  S.over = !!state.over;
  S.pendingDouble = !!state.pendingDouble;
  state.players.forEach((sp, i) => {
    const p = S.players[i];
    if (!p) return;
    Object.assign(p, {
      cash: sp.cash,
      pos: sp.pos,
      jail: sp.jail,
      jailTurns: sp.jailTurns,
      goojf: sp.goojf,
      dead: sp.dead,
      debt: sp.debt,
      powerCards: sp.powerCards || [],
      rentSurge: sp.rentSurge,
      taxShield: sp.taxShield,
      turnsSurvived: sp.turnsSurvived || 0,
      turnEngaged: !!sp.turnEngaged,
      turnBonusUsed: !!sp.turnBonusUsed,
    });
  });
  if (state.tiles) {
    state.tiles.forEach((st, i) => {
      const t = TILES[i];
      if (!t) return;
      t.owner = st.owner;
      t.houses = st.houses;
      t.mortgaged = st.mortgaged;
    });
  }
  if (state.fortuneKeys) S.fortune = rebuildDeck(FORTUNE, state.fortuneKeys);
  if (state.treasuryKeys) S.treasury = rebuildDeck(TREASURY, state.treasuryKeys);
  S.turnStartedAt = state.turnStartedAt || S.turnStartedAt || Date.now();
  S.voteKick = state.voteKick ? { voters: [...(state.voteKick.voters || [])] } : { voters: [] };
  S.voteKickedUsers = state.voteKickedUsers ? [...state.voteKickedUsers] : (S.voteKickedUsers || []);
  if (state.tradeSeq) tradeSeq = state.tradeSeq;
  if (state.openTrades) {
    S.openTrades = state.openTrades.map(t => ({
      ...t,
      offerIdx: [...(t.offerIdx || [])],
      wantIdx: [...(t.wantIdx || [])],
      history: (t.history || []).map(h => ({
        ...h,
        offerIdx: h.offerIdx ? [...h.offerIdx] : undefined,
        wantIdx: h.wantIdx ? [...h.wantIdx] : undefined,
      })),
    }));
  }
  restoreAuctionState(state.auction);
  if (Date.now() >= remoteRollUntil) {
    Dice3D.setValues(S.dice[0], S.dice[1], false);
  }
  renderAll();
  checkVoteKick();
  postSyncTurn();
}

function onRemoteDiceRoll(msg) {
  const uid = getUser()?.id;
  if (msg.rollerUserId && uid && msg.rollerUserId === uid) return;
  const d1 = +msg.d1;
  const d2 = +msg.d2;
  if (d1 < 1 || d2 < 1) return;
  const startAt = msg.startAt || Date.now();
  remoteRollUntil = startAt + DICE_ROLL_MS + 200;
  S.dice = [d1, d2];
  const isDouble = d1 === d2 && S.rules.doubles;
  Dice3D.rollAt(d1, d2, startAt);
  const p = S.players[S.turn];
  const label = msg.rollerName || p?.name || 'Player';
  const total = d1 + d2;
  if (S.phase === 'jail' || p?.jail) {
    msg(`${label} rolls for doubles…`);
  } else {
    log(`<b>${label}</b> rolls <b>${d1} + ${d2} = ${total}</b>${isDouble ? ' (doubles!)' : ''}.`, p || undefined);
  }
}

registerDiceRollHandler(onRemoteDiceRoll);

function postSyncTurn() {
  if (!isMpGame() || isApplyingRemote()) return;
  const p = S.cur;
  if (!p) return;
  if (p.bot && isMpHost()) setTimeout(botTurn, 900);
}

registerStateSync(exportGameState);
registerStateImporter(importGameState);

function isMpHost() {
  if (!isMpGame()) return true;
  const uid = getUser()?.id;
  return S.players.some(p => p.isAdmin && p.userId === uid);
}

function isMyTurn() {
  const me = localHuman();
  const cur = S.cur;
  return !!(me && cur && cur.userId === me.userId && !cur.bot);
}

function assertMyTurn() {
  if (!isMpGame()) return true;
  return isMyTurn();
}

function startGameFromLobby({ rules, players, adminId = 0, multiplayer = false }) {
  try {
    const per = rules.per;
    S.multiplayer = !!multiplayer;
    S.rules = {
      ...rules,
      title: 'Buildup.io',
      diff: DIFF[rules.diff] || DIFF.classic,
    };
    S.players = players.map((p, i) => ({
      id: i,
      userId: p.userId || null,
      name: p.name,
      bot: p.bot,
      emoji: p.emoji,
      color: p.color || PLAYER_COLORS[i],
      isAdmin: p.isAdmin ?? i === adminId,
      cash: S.rules.cash,
      pos: 0,
      jail: false,
      jailTurns: 0,
      goojf: 0,
      dead: false,
      debt: null,
      powerCards: [],
      rentSurge: false,
      taxShield: false,
      turnsSurvived: 0,
      turnEngaged: false,
      turnBonusUsed: false,
    }));
    S.fortune = shuffle(FORTUNE);
    S.treasury = shuffle(TREASURY);
    S.recentTrades = [];
    S.openTrades = [];
    tradeSeq = 1;
    S.over = false;
    S.turn = 0;
    S.phase = 'idle';
    initBoard(per);
    $('roomLobby')?.classList.add('hidden');
    document.body.classList.remove('room-lobby-mode');
    $('lobby')?.classList.add('hidden');
    setGameBrandVisible(true);
    $('hud')?.classList.remove('hidden');
    S.turnStartedAt=Date.now();
    S.voteKick={voters:[]};
    ensureTurnTimer();
    const vk=$('voteKickBtn'); if(vk)vk.onclick=castVoteKick;
    const bb=$('bankruptBtn'); if(bb)bb.onclick=()=>voluntaryBankrupt(localHuman());
    renderAll();
    log(`${S.rules.title} begins: ${N} tiles · ${S.players.length} travelers · ${fmt(S.rules.cash)} each.`);
    startTurn();
  } catch (e) {
    console.error(e);
    throw e;
  }
}

initLobby(startGameFromLobby, boardStats, per => {
  initBoard(per, { preview: true });
});

/* ============================================================
   BOARD BUILD
============================================================ */
function gridPos(i){
  if(i<=PER)   return {r:GRID,c:GRID-i,side:'bottom'};
  if(i<=2*PER) return {r:GRID-(i-PER),c:1,side:'left'};
  if(i<=3*PER) return {r:1,c:1+(i-2*PER),side:'top'};
  return {r:1+(i-3*PER),c:GRID,side:'right'};
}

const DOCK_HTML=`<button class="btn" id="rollBtn">🎲 Roll Dice</button>
<button class="btn" id="buyBtn">Buy</button>
<button class="btn ghost" id="auctionBtn">Auction</button>
<button class="btn ghost" id="skipBtn">Pass</button>
<button class="btn ghost" id="endBtn">End Turn</button>
<button class="btn" id="jailPayBtn">Pay $100 fine</button>
<button class="btn ghost" id="jailCardBtn">Use jail card</button>
<button class="btn hidden" id="settleDebtBtn" type="button">Pay debt</button>
<button class="btn ghost hidden" id="powerCardsBtn" type="button">🃏 Power cards</button>`;

function bindDockWires(){
  if(!$('rollBtn'))return;
  $('rollBtn').onclick=humanRoll;
  $('buyBtn').onclick=()=>{markTurnEngagement();buyCurrent(S.cur);afterAction(false);};
  $('auctionBtn').onclick=()=>{
    const t=TILES[S.cur.pos];
    if(t.owner==null&&t.price&&S.rules.auction){log(`<b>${S.cur.name}</b> sends ${t.name} to auction.`,S.cur);afterAction(true,t);}
  };
  $('skipBtn').onclick=()=>{markTurnEngagement();
    const t=TILES[S.cur.pos];
    log(`<b>${S.cur.name}</b> passes on ${t.name}.`,S.cur);afterAction(false);
  };
  $('endBtn').onclick=()=>{markTurnEngagement();endTurn();};
  $('settleDebtBtn').onclick=()=>{const p=localHuman();if(p)settleDebt(p);};
  $('jailPayBtn').onclick=()=>payJailFine(S.cur);
  $('jailCardBtn').onclick=()=>useJailCard(S.cur);
}

function mountHubDock(){
  const slot=$('hubDockSlot');
  if(!slot)return;
  slot.innerHTML=DOCK_HTML;
  bindDockWires();
  $('dock')?.classList.add('hidden');
}

function initBoard(per,{preview=false}={}){
  TILES=genBoard(per);
  N=TILES.length;PER=per;GRID=per+1;
  JAIL_IDX=TILES.findIndex(t=>t.type==='jail');
  TILES.forEach((t,i)=>{t.idx=i;t.owner=null;t.houses=0;t.mortgaged=false;
    if(t.type==='city'){
      const b=Math.max(2,Math.round(t.price*0.1/2)*2);
      t.rents=[b,b*5,b*15,b*30,b*42,b*55];
      t.houseCost=50+Math.floor((i/N)*4)*50;
    }});
  const EDGE=Math.max(74,Math.min(108,Math.round(1040/per)));
  const CORNER=Math.round(EDGE*1.88);
  document.documentElement.style.setProperty('--corner',CORNER+'px');
  document.documentElement.style.setProperty('--edge',EDGE+'px');
  const board=$('board');
  if(!board)return;
  board.innerHTML='';
  board.style.gridTemplateColumns=`${CORNER}px repeat(${per-1},${EDGE}px) ${CORNER}px`;
  board.style.gridTemplateRows=board.style.gridTemplateColumns;
  const countryLayer=document.createElement('div');countryLayer.id='countryLayer';

  const hub=document.createElement('div');hub.id='hub';
  hub.style.gridRow=`2/${GRID}`;hub.style.gridColumn=`2/${GRID}`;
  hub.innerHTML=`
    <div id="hubBrand">
      <div id="hubLogo">${S.rules?.title||'Buildup.io'}</div>
      <div id="hubRibbon">Advanced Edition</div>
    </div>
    <div id="hubMid">
      <div id="diceLayer"></div>
      <div id="hubDockSlot"></div>
      <div id="hubStatus">
        <div id="potChip" ${S.rules.vacation?'':'style="display:none"'}><small>Vacation</small><span id="potVal">$0</span></div>
        <div id="hubMsg"></div>
        <div id="hubActivity" class="hub-activity" aria-live="polite"></div>
      </div>
    </div>`;
  board.appendChild(hub);
  if(!preview)mountHubDock();
  Dice3D.init($('diceLayer'));
  Dice3D.setValues(1+rand(6),1+rand(6),false);

  TILES.forEach((t,i)=>{
    const p=gridPos(i);
    const el=document.createElement('div');
    const isCorner=i%per===0;
    el.className=`tile s-${p.side}`+(isCorner?' corner':'')+(t.type==='city'?' t-city':'')+(t.type==='air'?' t-air t-special':'')+(t.type==='utl'?' t-utl t-special':'')+(t.type==='tax'?' t-tax t-special':'')+(t.type==='fortune'?' t-sur t-special':'')+(t.type==='treasury'?' t-tre t-special':'');
    if(isCorner)el.classList.add(i===0?'c-go':i===per?'c-jail':i===2*per?'c-fair':'c-gtj');
    el.style.gridRow=p.r;el.style.gridColumn=p.c;
    t.side=p.side;
    if(t.type==='city'&&GROUPS[t.group])el.style.setProperty('--group-color',GROUPS[t.group].color);
    if(t.type==='city'&&t.iso){const fsrc=flagSrc(t.iso);if(fsrc)el.style.setProperty('--flag-watermark',`url("${fsrc}")`);}
    let inner='',outer='';
    ({inner,outer}=buildTileParts(t));
    el.innerHTML=`<div class="tc">${inner}</div>${outer}<div class="tokens"></div>`;
    el.onclick=()=>openPropDetail(i);
    board.appendChild(el);t.el=el;
  });
  const table=$('table');
  $('countryLayer')?.remove();
  if(table) table.insertBefore(countryLayer,board);

  fitScene();
  window.addEventListener('resize', () => { fitScene(); scheduleCountryBrackets(TILES, GROUPS, S.players); });
  scheduleCountryBrackets(TILES, GROUPS, S.players);
}
function fitScene(){
  const t=$('table');if(!t||!$('board')?.firstChild)return;
  const W=t.offsetWidth+56,H=t.offsetHeight+56;
  const logW=Math.min(220,innerWidth*0.2);
  const s=Math.min((innerWidth-logW-48)/W,(innerHeight-96)/H,1);
  document.documentElement.style.setProperty('--scene-scale',String(s));
  scheduleCountryBrackets(TILES,GROUPS,S.players);
}
document.addEventListener('click',e=>{
  if(e.target.id==='logBtn'){
    const d=$('logDrawer');
    if(!d)return;
    d.classList.toggle('closed');
    e.target.textContent=d.classList.contains('closed')?'Show':'Hide';
  }
});

function rollDiceValues(){
  S.dice=[1+rand(6),1+rand(6)];
  return S.dice[0]+S.dice[1];
}
function msUntilDiceDone(startAt){
  return Math.max(0,(startAt||Date.now())+DICE_ROLL_MS-Date.now());
}
function rollDiceAndBroadcast(p){
  const d1=1+rand(6), d2=1+rand(6);
  S.dice=[d1,d2];
  const startAt=isMpGame()?Date.now()+DICE_SYNC_LEAD_MS:Date.now();
  remoteRollUntil=startAt+DICE_ROLL_MS+320;
  if(isMpGame()){
    broadcastDiceRoll(d1,d2,p.name,p.userId,startAt);
    Dice3D.rollAt(d1,d2,startAt);
    return {total:d1+d2,startAt};
  }
  Dice3D.roll(d1,d2);
  return {total:d1+d2,startAt};
}
function rollDice(){return rollDiceAndBroadcast(S.cur).total;}

/* ============================================================
   RENDER
============================================================ */
function renderAll(){
  renderPlayers();
  renderActionsCard();
  renderTiles();
  renderDock();
  renderTradeCard();
  renderPot();
  scheduleCountryBrackets(TILES,GROUPS,S.players);
  if (isMultiplayerActive() && !isApplyingRemote()) queueStateBroadcast();
}
function localHuman(){
  const uid=getUser()?.id;
  if(uid)return S.players.find(p=>!p.bot&&!p.dead&&p.userId===uid);
  return S.players.find(p=>!p.bot&&!p.dead);
}
function turnMsg(p){
  const me=localHuman();
  if(me&&p.id===me.id)return 'Your turn — roll the dice.';
  return `${p.name}'s turn — roll the dice.`;
}
function renderPot(){if($('potVal'))$('potVal').textContent=fmt(S.pot);}
function playerTileLabel(p){
  const t=TILES[p.pos];
  if(!t)return '';
  const n=t.name.length>16?t.name.slice(0,15)+'…':t.name;
  return n;
}
function renderPlayers(){
  const wrap=$('playersCard');
  if(!wrap)return;
  const human=localHuman();
  const rows=S.players.map((p,i)=>{
    const tags=[p.jail?'⛓️ Jail':'',p.goojf?`🎟${p.goojf>1?'×'+p.goojf:''}`:''].filter(Boolean).join(' · ');
    const loc=!p.dead&&TILES[p.pos]?playerTileLabel(p):'';
    const crown=p.isAdmin?'<span class="p-crown" title="Room admin">👑</span>':'';
    const botBadge=p.bot?'<span class="p-bot" aria-hidden="true">🤖</span>':'';
    const powerBadge=S.rules.powerCards&&p.powerCards?.length
      ?`<span class="p-power-badge" title="${p.powerCards.length} power card${p.powerCards.length>1?'s':''}">🃏 ${p.powerCards.length}</span>`:'';
    return `<div class="player-row${i===S.turn&&!p.dead?' current':''}${p.dead?' dead':''}${p.debt?' player-row--debt':''}" style="--pc:${p.color}">
      <span class="p-av p-av--${i%6}">${p.emoji}</span>
      <span class="p-info">
        <span class="p-name">${crown}${p.name}${botBadge}${powerBadge}</span>
        ${loc?`<span class="p-loc">On ${loc}</span>`:''}
        ${p.debt?`<span class="p-debt">Owes ${fmt(p.debt.amount)}</span>`:''}
        ${p.rentSurge?'<span class="p-buff">⚡ Rent surge</span>':''}
        ${p.taxShield?'<span class="p-buff">🛡️ Shielded</span>':''}
        ${tags?`<span class="p-tags">${tags}</span>`:''}
      </span>
      <span class="p-aside">
        <span class="p-cash">${p.dead?'Bankrupt':fmt(p.cash)}</span>
      </span>
    </div>`;
  }).join('');
  wrap.innerHTML=`<div class="hud-card-head"><span class="hud-card-icon" aria-hidden="true">👥</span><h4 class="players-title">Travelers</h4></div><div class="players-list">${rows}</div>`;
}
function aliveHumans(){
  return S.players.filter(p=>!p.dead&&!p.bot);
}
function voteKickMajority(){
  const alive=aliveHumans();
  const cur=S.cur;
  if(!cur||cur.bot)return 1;
  const others=alive.filter(p=>p.id!==cur.id);
  return Math.max(1,Math.ceil(others.length/2));
}
function markTurnEngagement(){
  const p=S.cur;
  if(p&&!p.dead&&!p.bot)p.turnEngaged=true;
}

function handleTurnTimeout(){
  if(S.over||turnTimeoutHandled)return;
  const cur=S.cur;
  if(!cur||cur.dead||cur.bot)return;
  const elapsed=Date.now()-(S.turnStartedAt||0);
  if(elapsed<TURN_LIMIT_MS)return;
  if(isMpGame()&&!isMpHost())return;
  turnTimeoutHandled=true;
  if(cur.turnEngaged&&!cur.turnBonusUsed){
    cur.turnBonusUsed=true;
    S.turnStartedAt=Date.now();
    turnTimeoutHandled=false;
    log(`⏱️ <b>${cur.name}</b> is playing — ${Math.ceil(TURN_BONUS_MS/1000)}s added.`,cur);
    if(isMpGame())broadcastStateNow();
    return;
  }
  if(cur.turnEngaged){
    log(`⏱️ <b>${cur.name}</b>'s turn ended (time up).`,cur);
    endTurn();
    if(isMpGame())broadcastStateNow();
    return;
  }
  log(`⏱️ <b>${cur.name}</b> was removed for being idle too long.`,cur);
  if(cur.userId){
    if(!S.voteKickedUsers)S.voteKickedUsers=[];
    if(!S.voteKickedUsers.includes(cur.userId))S.voteKickedUsers.push(cur.userId);
  }
  bankrupt(cur,null);
  S.voteKick={voters:[]};
  if(isMpGame())broadcastStateNow();
  if(!S.over)setTimeout(startTurn,500);
}

function checkVoteKick(){
  if(!S.voteKick?.voters?.length)return;
  const cur=S.cur;
  if(!cur||cur.dead||cur.bot)return;
  const needed=voteKickMajority();
  const valid=new Set(aliveHumans().map(p=>p.id));
  const count=S.voteKick.voters.filter(id=>valid.has(id)&&id!==cur.id).length;
  const mayExecute=!isMpGame()||isMpHost();
  if(count>=needed&&mayExecute){
    log(`🗳️ Vote kick — <b>${cur.name}</b> is removed for stalling.`,cur);
    if(cur.userId){
      if(!S.voteKickedUsers)S.voteKickedUsers=[];
      if(!S.voteKickedUsers.includes(cur.userId))S.voteKickedUsers.push(cur.userId);
    }
    bankrupt(cur,null);
    S.voteKick={voters:[]};
    broadcastStateNow();
    if(!S.over)setTimeout(startTurn,500);
  }
}
function castVoteKick(){
  const me=localHuman();
  const cur=S.cur;
  if(!me||!cur||me.id===cur.id||cur.dead||cur.bot)return;
  if(!S.voteKick)S.voteKick={voters:[]};
  if(!S.voteKick.voters.includes(me.id)){
    S.voteKick.voters.push(me.id);
    log(`🗳️ <b>${me.name}</b> voted to kick <b>${cur.name}</b>.`);
  }
  if(isMpGame())broadcastStateNow();
  checkVoteKick();
  renderActionsCard();
}
function renderActionsCard(){
  const card=$('playerActionsCard');
  if(!card)return;
  const human=localHuman();
  const inGame=human&&!human.dead&&!S.over;
  card.classList.toggle('hidden',!inGame);
  if(!inGame)return;
  const cur=S.cur;
  const elapsed=Math.max(0,Date.now()-(S.turnStartedAt||Date.now()));
  const left=Math.max(0,TURN_LIMIT_MS-elapsed);
  const secs=Math.ceil(left/1000);
  const m=Math.floor(secs/60);
  const s=secs%60;
  const val=$('turnTimerVal');
  const ring=$('turnTimerRing');
  const hint=$('turnTimerHint');
  const pct=Math.min(100,(elapsed/TURN_LIMIT_MS)*100);
  if(val)val.textContent=`${m}:${String(s).padStart(2,'0')}`;
  if(ring)ring.style.setProperty('--pct',`${pct}`);
  if(hint){
    hint.classList.remove('turn-timer__hint--urgent');
    if(cur?.dead)hint.textContent='';
    else if(cur?.id===human?.id){
      if(left<=TURN_ENGAGE_WARN_MS&&!cur.turnEngaged){
        hint.textContent=`⚠️ ${secs}s left — roll or act now!`;
        hint.classList.add('turn-timer__hint--urgent');
      }else if(left<=TURN_ENGAGE_WARN_MS){
        hint.textContent=`You're active — ${secs}s left on your turn.`;
      }else hint.textContent='Your turn — roll or act before time runs out.';
    }else if(left<=TURN_ENGAGE_WARN_MS&&!cur?.turnEngaged){
      hint.textContent=`${cur?.name||'Player'} has ${secs}s — may be removed if idle.`;
    }else hint.textContent=`${cur?.name||'Player'}'s turn`;
  }
  const kickBtn=$('voteKickBtn');
  const status=$('voteKickStatus');
  const canVote=cur&&!cur.dead&&!cur.bot&&human&&human.id!==cur.id;
  const showKick=canVote&&(elapsed>=60_000||left<=TURN_ENGAGE_WARN_MS);
  kickBtn?.classList.toggle('hidden',!showKick);
  if(status){
    const needed=voteKickMajority();
    const votes=S.voteKick?.voters?.filter(id=>id!==cur?.id).length||0;
    if(showKick&&votes>0){
      status.textContent=`${votes}/${needed} votes to kick ${cur.name}`;
      status.classList.remove('hidden');
    }else status.classList.add('hidden');
  }
  $('bankruptBtn')?.classList.toggle('hidden',!human||human.dead);
}
function ensureTurnTimer(){
  if(turnTimerInterval)return;
  turnTimerInterval=setInterval(()=>{
    if(S.over||!$('hud')||$('hud').classList.contains('hidden'))return;
    renderActionsCard();
    handleTurnTimeout();
    maintainOpenTrades();
    checkVoteKick();
  },1000);
}
function renderTiles(){
  TILES.forEach(t=>{
    if(!t.el)return;
    t.el.classList.toggle('mortgaged',!!t.mortgaged);
    t.el.classList.remove('landed');
    const owned=t.owner!=null&&!S.players[t.owner].dead;
    t.el.classList.toggle('owned',owned);
    if(owned)t.el.style.setProperty('--own',S.players[t.owner].color);
    else t.el.style.removeProperty('--own');
    let mark=t.el.querySelector('.mortgage-mark');
    if(t.mortgaged){
      if(!mark){
        mark=document.createElement('div');
        mark.className='mortgage-mark';
        mark.setAttribute('aria-hidden','true');
        mark.innerHTML='<svg class="mortgage-mark__svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 9V7a5 5 0 00-10 0v2H5a1 1 0 00-1 1v10a1 1 0 001 1h14a1 1 0 001-1V10a1 1 0 00-1-1h-2zm-8-2a3 3 0 016 0v2H9V7z"/></svg>';
        t.el.appendChild(mark);
      }
    }else if(mark)mark.remove();
    renderTileBuildings(t);
    t.el.querySelector('.tokens').innerHTML='';
  });
  const atPos={};
  S.players.forEach(p=>{if(!p.dead){if(!atPos[p.pos])atPos[p.pos]=[];atPos[p.pos].push(p);}});
  Object.entries(atPos).forEach(([pos,group])=>{
    const tile=TILES[+pos];
    if(!tile?.el)return;
    tile.el.style.setProperty('--land',group.length===1?group[0].color:'#F2C66B');
    tile.el.classList.add('landed');
    group.forEach((p,i)=>{
      const pi=S.players.findIndex(x=>x.id===p.id);
      const tk=document.createElement('span');
      tk.className=`tk tk--${pi%6}`+(group.length>1?' tk--multi':'')+(pi===S.turn?' tk--turn':'');
      tk.style.setProperty('--tk-color',p.color);
      tk.dataset.idx=String(i);
      tk.dataset.total=String(group.length);
      tk.textContent=p.emoji;
      tk.title=`${p.name} · ${tile.name}`;
      tile.el.querySelector('.tokens').appendChild(tk);
    });
  });
}
function renderDock(){
  const p=S.cur,ph=S.phase;
  if(!p)return;
  const me=localHuman();
  const show=(id,on)=>{const el=$(id);if(el)el.classList.toggle('hidden',!on);};
  const jailing=ph==='jail';
  const humanTurn=isMyTurn()&&!S.over;
  if(isMpGame()&&!humanTurn&&!p.bot&&!S.over){
    msg(`Waiting for ${p.name}…`);
  }
  show('rollBtn',humanTurn&&(ph==='roll'||jailing));
  if($('rollBtn'))$('rollBtn').textContent=jailing?'🎲 Roll for doubles':'🎲 Roll Dice';
  show('buyBtn',humanTurn&&ph==='buy');show('skipBtn',humanTurn&&ph==='buy');
  show('auctionBtn',humanTurn&&ph==='buy'&&S.rules.auction);
  show('endBtn',humanTurn&&ph==='end');
  show('jailPayBtn',humanTurn&&jailing&&p.cash>=100);
  show('jailCardBtn',humanTurn&&jailing&&p.goojf>0);
  if(ph==='buy'&&humanTurn){
    const t=TILES[p.pos];
    $('buyBtn').textContent=`Buy · ${fmt(t.price)}`;
    $('buyBtn').disabled=p.cash<t.price;
    $('skipBtn').textContent='Pass';
    if($('auctionBtn'))$('auctionBtn').disabled=false;
    focusPropTile(t);
  }
  $('hubDockSlot')?.classList.toggle('hub-dock--buy',humanTurn&&ph==='buy');
  if(ph!=='buy'&&propOpenIdx==null)clearPropTileFocus();
  const human=localHuman();
  if(human?.debt){
    show('settleDebtBtn',true);
    const sb=$('settleDebtBtn');
    if(sb){
      sb.textContent=`Pay debt · ${fmt(human.debt.amount)}`;
      sb.disabled=human.cash<human.debt.amount;
    }
  }else show('settleDebtBtn',false);
  const canPower=!!human&&S.rules.powerCards&&!S.over&&human.powerCards?.length>0
    &&p.id===human.id&&!human.dead&&(ph==='roll'||ph==='end');
  show('powerCardsBtn',canPower);
  const pcb=$('powerCardsBtn');
  if(pcb&&canPower)pcb.textContent=`🃏 Power cards (${human.powerCards.length})`;
  if(p.bot)['rollBtn','buyBtn','skipBtn','auctionBtn','endBtn','jailPayBtn','jailCardBtn','settleDebtBtn','powerCardsBtn'].forEach(id=>{const el=$(id);if(el)el.classList.add('hidden');});
}
function tradeTileSummary(idxs,cash){
  const parts=idxs.map(i=>TILES[i]?.name).filter(Boolean);
  if(cash)parts.push(fmt(cash));
  return parts.length?parts.join(' · '):'—';
}
function recordTrade(from,to,offerIdx,wantIdx,offerCash,wantCash,tradeId=null){
  S.recentTrades.unshift({
    id:tradeId,
    fromName:from.name,toName:to.name,fromEmoji:from.emoji,toEmoji:to.emoji,
    fromColor:from.color,toColor:to.color,
    offerIdx:[...offerIdx],wantIdx:[...wantIdx],offerCash,wantCash,
  });
  if(S.recentTrades.length>6)S.recentTrades.length=6;
}
function renderTradeRecent(){
  const list=$('tradeRecentList');
  if(!list)return;
  const trades=S.recentTrades||[];
  if(!trades.length){
    list.innerHTML='<div class="trade-feed-empty">No past trades yet.</div>';
    return;
  }
  list.innerHTML=trades.map((t,i)=>{
    const gave=tradeTileSummary(t.offerIdx,t.offerCash);
    const got=tradeTileSummary(t.wantIdx,t.wantCash);
    return `<button type="button" class="trade-feed-item" data-recent="${i}">
      <span class="trade-feed-item__row">
        <span class="trade-feed-item__avatars">
          <span class="trade-feed-av p-av p-av--0" style="--pc:${t.fromColor}">${t.fromEmoji}</span>
          <span class="trade-feed-av p-av p-av--1" style="--pc:${t.toColor}">${t.toEmoji}</span>
        </span>
        <span class="trade-feed-item__main">${tradeEsc(t.fromName)} ↔ ${tradeEsc(t.toName)}</span>
        <span class="trade-feed-item__badge trade-feed-item__badge--done">Done</span>
      </span>
      <span class="trade-feed-item__sub">${tradeEsc(gave)} → ${tradeEsc(got)}</span>
    </button>`;
  }).join('');
  list.querySelectorAll('[data-recent]').forEach(btn=>{
    btn.onclick=()=>openCompletedTradeView(+btn.dataset.recent);
  });
}
function renderTradeCard(){
  const card=$('tradeCard');
  if(!card)return;
  const human=localHuman();
  const partners=human?alive().filter(x=>x.id!==human.id):[];
  const on=!!human&&S.rules.trades&&!S.over;
  card.classList.toggle('hidden',!on);
  const btn=$('tradeBtn');
  if(btn){
    btn.disabled=partners.length===0;
    btn.classList.toggle('trade-card-btn--disabled',partners.length===0);
  }
  renderOpenTrades();
  renderTradeRecent();
}
function msg(t){const el=$('hubMsg');if(el)el.textContent=t;}
function formatLogHtml(html){
  return html.replace(/\$([\d,]+)/g,'<span class="money">$$$1</span>');
}
function logPlainText(html){
  const el=document.createElement('div');
  el.innerHTML=html;
  return (el.textContent||'').trim();
}
function renderHubActivity(){
  const hub=$('hubActivity'),logEl=$('log');
  if(!hub||!logEl)return;
  const lines=[...logEl.querySelectorAll('.logline')].slice(0,2);
  if(!lines.length){hub.innerHTML='';return;}
  hub.innerHTML=lines.map((l,i)=>{
    const text=logPlainText(l.innerHTML);
    return `<p class="hub-activity-line${i===0?' hub-activity-line--new':''}">${tradeEsc(text)}</p>`;
  }).join('');
}
function openTradeFromLog(tradeId,kind='open'){
  if(kind==='done'){
    const i=S.recentTrades?.findIndex(t=>t.id===tradeId);
    if(i>=0)openCompletedTradeView(i);
    return;
  }
  const trade=getOpenTrade(tradeId);
  if(trade)openTradeDetail(trade.id,trade.awaitingId===localHuman()?.id?'incoming':null);
}
function pushTradeActivity(entry){
  tradeActivityLog.unshift(entry);
  if(tradeActivityLog.length>5)tradeActivityLog.length=5;
  renderLogTradeSection();
}
function renderLogTradeSection(){
  const panel=$('logTradesPanel');
  if(!panel)return;
  if(!tradeActivityLog.length){
    panel.innerHTML='<p class="log-trades-empty">No recent trade offers yet.</p>';
    return;
  }
  panel.innerHTML=tradeActivityLog.map((e,i)=>`<button type="button" class="log-trade-item" data-log-trade="${i}">
    <span class="log-trade-item__main">${formatLogHtml(e.text)}</span>
    <span class="log-trade-item__sub">${tradeEsc(e.summary||'')}</span>
  </button>`).join('');
  panel.querySelectorAll('[data-log-trade]').forEach(btn=>{
    btn.onclick=()=>{
      const e=tradeActivityLog[+btn.dataset.logTrade];
      if(e)openTradeFromLog(e.tradeId,e.kind);
    };
  });
}
function log(html,p,meta={}){
  const logEl=$('log');
  if(!logEl)return;
  const d=document.createElement('div');
  d.className='logline'+(meta.tradeId?' logline--trade':'');
  if(p)d.style.setProperty('--lc',p.color);
  d.innerHTML=formatLogHtml(html);
  if(meta.tradeId){
    d.dataset.tradeId=meta.tradeId;
    d.title='Click to view trade details';
    d.onclick=()=>openTradeFromLog(meta.tradeId,meta.kind||'open');
  }
  logEl.prepend(d);
  while(logEl.children.length>90)logEl.lastChild.remove();
  renderHubActivity();
}
function tileIcon(t){return tileIconHTML(t);}
function tileSub(t){if(t.type==='city')return GROUPS[t.group]?.name||'City';if(t.type==='air')return 'Airport';if(t.type==='utl')return 'Utility';return t.type;}
function propHeadHTML(t){
  if(t.type==='city')return flagModalHTML(t.iso);
  if(t.type==='air'||t.type==='utl')return `<span class="prop-icon-sm">${tileIcon(t)}</span>`;
  return `<span class="prop-icon-sm">${t.flag||'🌐'}</span>`;
}
function propRentHTML(t){
  let rows='';
  if(t.type==='city'){
    const lb=['Base rent','1 house','2 houses','3 houses','4 houses','Hotel'];
    rows=`<div class="rh"><span>when</span><span>get</span></div>`;
    rows+=t.rents.map((r,k)=>`<div class="prop-row${t.houses===k&&t.owner!=null?' hl':''}"><span>${lb[k]}</span><b>${fmt(r)}</b></div>`).join('');
  }else if(t.type==='air'){
    const tot=TILES.filter(x=>x.type==='air').length;
    rows=`<div class="rh"><span>when</span><span>get</span></div>`;
    rows+=Array.from({length:tot},(_,k)=>`<div class="prop-row"><span>Own ${k+1}</span><b>${fmt(AIR_RENTS[k+1])}</b></div>`).join('');
  }else if(t.type==='utl'){
    const tot=TILES.filter(x=>x.type==='utl').length;
    rows=`<div class="rh"><span>when</span><span>get</span></div>`;
    rows+=Array.from({length:tot},(_,k)=>`<div class="prop-row"><span>Own ${k+1}</span><b>dice × ${UTL_MULT[k+1]}</b></div>`).join('');
  }else if(t.type==='tax')rows=`<div class="prop-row"><span>Charge</span><b>${fmt(t.amount)}</b></div>`;
  else if(t.type==='fair'&&S.rules.vacation)rows=`<div class="prop-row"><span>Pot waiting</span><b>${fmt(S.pot)}</b></div>`;
  return rows;
}
function propOwnerHTML(t){
  if(t.owner!=null&&!S.players[t.owner].dead){
    const o=S.players[t.owner];
    let s=t.mortgaged?'<div class="lbl" style="color:var(--danger);margin-top:2px">Mortgaged</div>':'';
    const oi=S.players.findIndex(x=>x.id===t.owner);
    return `<div class="prop-owner"><div class="av p-av p-av--${oi%6}" style="--pc:${o.color};width:32px;height:32px;font-size:16px">${o.emoji}</div><div><div class="lbl">Owner</div><div class="name">${o.name}</div>${s}</div></div>`;
  }
  if(t.price)return `<div class="prop-owner"><div class="av" style="background:rgba(255,255,255,.08);font-size:14px">—</div><div><div class="lbl">Owner</div><div class="name" style="color:var(--muted)">Unowned</div></div></div>`;
  return '';
}
function propFootHTML(t){
  if(!t.price&&t.type!=='city')return '';
  const h=t.type==='city'?`<div class="pf"><small>House</small><b>${fmt(t.houseCost)}</b></div><div class="pf"><small>Hotel</small><b>${fmt(t.houseCost)}</b></div>`:'<div class="pf"></div><div class="pf"></div>';
  return `<div class="prop-foot"><div class="pf"><small>Price</small><b>${fmt(t.price||0)}</b></div>${h}</div>`;
}
function buildPropHTML(t,idx,actions=''){
  const body=propBodyHTML(propRentHTML(t),propOwnerHTML(t),propFootHTML(t));
  const owner=t.owner!=null&&!S.players[t.owner]?.dead?S.players[t.owner].color:null;
  return buildPropSheet(t,GROUPS,body,actions,{ownerColor:owner});
}
function propMgmtButtons(t,p){
  if(!p||t.owner!==p.id||S.over||S.phase==='moving'||S.phase==='buy')return [];
  const out=[];
  const full=t.type==='city'&&ownsGroup(p,t.group);
  const groupBuilt=t.type==='city'&&groupTiles(t.group).some(x=>x.houses>0);
  if(t.type==='city'&&full&&!t.mortgaged&&groupTiles(t.group).every(x=>!x.mortgaged)){
    if(t.houses<5)out.push(`<button class="btn prop-act-build" id="propBuild" type="button"${p.cash<t.houseCost?' disabled':''}>Upgrade · ${fmt(t.houseCost)}</button>`);
    if(t.houses>0)out.push(`<button class="btn ghost prop-act-destroy" id="propDestroy" type="button">Destroy · +${fmt(Math.floor(t.houseCost/2))}</button>`);
  }
  if(S.rules.mortgage&&!t.mortgaged&&t.houses===0&&!groupBuilt)
    out.push(`<button class="btn ghost prop-act-mort" id="propMortgage" type="button">Mortgage · +${fmt(Math.floor(t.price/2))}</button>`);
  if(t.mortgaged){
    const cost=Math.ceil(t.price/2*1.1);
    out.push(`<button class="btn prop-act-unmort" id="propUnmortgage" type="button"${p.cash<cost?' disabled':''}>Unmortgage · ${fmt(cost)}</button>`);
  }
  return out;
}
let propOpenIdx=null;
function closePropDetail(){
  const modal=$('propModal');
  modal.classList.add('hidden');
  modal.classList.remove('prop-modal--dock');
  propOpenIdx=null;
  clearPropTileFocus();
  clearPropDock();
}
function usePropDock(t,human){
  return human&&t.owner===human.id&&!S.over&&S.phase!=='moving'&&S.phase!=='buy';
}
function propActionButtons(t,human){
  const btns=[];
  if(human)btns.push(...propMgmtButtons(t,human));
  btns.push('<button class="btn ghost" id="propClose" type="button">Close</button>');
  return btns;
}
function updatePropDetail(i){
  const t=TILES[i],human=localHuman();
  const body=$('propCardBody');
  const rents=body.querySelector('.prop-rents');
  if(rents)rents.innerHTML=propRentHTML(t);
  const sheet=body.querySelector('.prop-sheet');
  if(sheet){
    sheet.setAttribute('data-build',String(t.houses||0));
    sheet.classList.toggle('prop-sheet--max',t.houses===5);
  }
  const actions=body.querySelector('.prop-actions');
  if(actions)actions.innerHTML=propActionButtons(t,human).join('');
  renderPlayers();
  wirePropModal(t,i,human);
}
function wirePropModal(t,i,p){
  $('propClose').onclick=closePropDetail;
  if(!p||t.owner!==p.id)return;
  const build=$('propBuild');
  if(build)build.onclick=async()=>{
    if(p.cash<t.houseCost||build.disabled)return;
    const prev=t.houses;
    p.cash-=t.houseCost;
    t.houses++;
    log(`🏗️ <b>${p.name}</b> builds ${t.houses===5?'a hotel':'a house'} in ${t.name}.`,p);
    await playBuildAnimation(t,prev);
    updatePropDetail(i);
    renderDock();
  };
  const destroy=$('propDestroy');
  if(destroy)destroy.onclick=async()=>{
    if(t.houses<=0)return;
    const before=t.houses;
    await playDestroyAnimationSync(t,before);
    t.houses--;
    p.cash+=Math.floor(t.houseCost/2);
    log(`🔨 <b>${p.name}</b> destroys a building in ${t.name}.`,p);
    renderTileBuildings(t);
    updatePropDetail(i);
    renderDock();
  };
  const mort=$('propMortgage');
  if(mort)mort.onclick=()=>{
    t.mortgaged=true;p.cash+=Math.floor(t.price/2);log(`<b>${p.name}</b> mortgages ${t.name}.`,p);renderAll();updatePropDetail(i);
  };
  const unmort=$('propUnmortgage');
  if(unmort)unmort.onclick=()=>{
    const cost=Math.ceil(t.price/2*1.1);
    if(p.cash>=cost){p.cash-=cost;t.mortgaged=false;log(`<b>${p.name}</b> lifts the mortgage on ${t.name}.`,p);renderAll();updatePropDetail(i);}
  };
}
function openPropDetail(i){
  $('logDrawer')?.classList.remove('closed');
  const t=TILES[i],human=localHuman();
  const modal=$('propModal');
  if(!modal||!t?.el)return;
  const sameOpen=propOpenIdx===i&&!modal.classList.contains('hidden');
  const actions=`<div class="prop-actions">${propActionButtons(t,human).join('')}</div>`;
  $('propCardBody').innerHTML=buildPropHTML(t,i,actions);
  const sheet=$('propCardBody').querySelector('.prop-sheet');
  if(sheet){
    sheet.setAttribute('data-build',String(t.houses||0));
    sheet.classList.toggle('prop-sheet--max',t.houses===5);
  }
  const dock=usePropDock(t,human);
  modal.classList.toggle('prop-modal--dock',dock);
  modal.classList.remove('hidden');
  propOpenIdx=i;
  wirePropModal(t,i,human);
  if(dock){
    bindPropDockResize(TILES);
    focusPropTile(t);
    if(!sameOpen)requestAnimationFrame(()=>positionPropDock(i,TILES));
  }else{
    clearPropTileFocus();
    clearPropDock();
  }
}
function showDetail(i){openPropDetail(i);}

/* ============================================================
   HELPERS
============================================================ */
const ownedBy=p=>TILES.filter(t=>t.owner===p.id);
const groupTiles=g=>TILES.filter(t=>t.group===g);
function netWorth(p){let n=p.cash;ownedBy(p).forEach(t=>{n+=t.mortgaged?0:Math.floor(t.price/2);
  if(t.houses)n+=t.houses===5?Math.floor(t.houseCost*5/2):Math.floor(t.houses*t.houseCost/2);});return n;}
function ownsGroup(p,g){return groupTiles(g).every(t=>t.owner===p.id);}
function ownedGroupIds(p){return Object.keys(GROUPS).filter(g=>ownsGroup(p,g));}
function celebrateCountryMonopoly(p,groupId){
  const grp=GROUPS[groupId];
  if(!grp)return;
  log(`🌍 <b>${p.name}</b> now controls all of <b>${grp.name}</b> ${grp.flag}!`,p);
  playCountryMonopoly();
  playCountryMonopolyAnim(p,groupTiles(groupId),{flag:grp.flag,name:grp.name});
}
function celebrateNewMonopolies(p,before){
  ownedGroupIds(p).forEach(g=>{if(!before.has(g))celebrateCountryMonopoly(p,g);});
}
function countType(p,type){return TILES.filter(t=>t.type===type&&t.owner===p.id&&!t.mortgaged).length;}
const alive=()=>S.players.filter(p=>!p.dead);

function bankPay(amount){if(S.rules.vacation){S.pot+=amount;renderPot();}}
function credit(s,amt){s.cur.cash+=amt;log(`<b>${s.cur.name}</b> collects $${amt.toLocaleString()}.`,s.cur);}
function charge(s,amt){payTo(s.cur,null,amt);}
function collectEach(s,amt){alive().forEach(p=>{if(p!==s.cur)payTo(p,s.cur,amt);});}
function payEach(s,amt){alive().forEach(p=>{if(p!==s.cur&&!s.cur.dead)payTo(s.cur,p,amt);});}
function repairs(s,ph,ht){let total=0;
  ownedBy(s.cur).forEach(t=>{total+=t.houses===5?ht:(t.houses||0)*ph;});
  if(total>0){log(`<b>${s.cur.name}</b> owes $${total.toLocaleString()} in repairs.`,s.cur);payTo(s.cur,null,total);}
  else log(`<b>${s.cur.name}</b> owns no buildings — nothing to repair.`,s.cur);}
function nearestAirport(s){let i=s.cur.pos;do{i=(i+1)%N;}while(TILES[i].type!=='air');
  s.cur.pos=i;log(`<b>${s.cur.name}</b> dashes to ${TILES[i].name}.`,s.cur);renderTiles();resolveTile(s.cur,{airDouble:true});}

function payTo(payer,creditor,amount,tile){
  if(payer.dead)return;
  if(!creditor&&amount>0&&payer.taxShield){
    payer.taxShield=false;
    log(`🛡️ <b>${payer.name}</b>'s Tax Shield blocks ${fmt(amount)}.`,payer);
    renderPlayers();
    return;
  }
  let owed=amount;
  if(payer.bot&&payer.cash<owed)liquidate(payer,owed);
  const paid=Math.min(payer.cash,owed);
  payer.cash-=paid;
  owed-=paid;
  const fxTile=tile||TILES[payer.pos];
  if(creditor){creditor.cash+=paid;log(`<b>${payer.name}</b> pays <b>${creditor.name}</b> $${paid.toLocaleString()}.`,payer);}
  else if(paid>0){
    bankPay(paid);
    log(`<b>${payer.name}</b> pays $${paid.toLocaleString()}${S.rules.vacation?' into the Vacation pot':' to the bank'}.`,payer);
  }
  if(paid>0&&fxTile){
    playTileCashFx(fxTile,-paid,{color:payer.color});
    if(creditor)playTileCashFx(fxTile,paid,{color:creditor.color,delay:380});
  }
  if(owed>0){
    if(payer.bot){
      liquidate(payer,owed);
      const extra=Math.min(payer.cash,owed);
      payer.cash-=extra;
      owed-=extra;
      if(creditor)creditor.cash+=extra;
      else bankPay(extra);
      if(owed>0||(payer.cash<=0&&netWorth(payer)<=0))bankrupt(payer,creditor);
    }else{
      payer.debt={amount:owed,creditorId:creditor?.id??null};
      log(`⚠️ <b>${payer.name}</b> still owes <b>${fmt(owed)}</b> — trade, manage estates, or pay when ready.`,payer);
      msg(`You owe ${fmt(owed)}. Raise cash via trades — you choose when to pay or declare bankruptcy.`);
    }
  }else if(payer.debt&&!payer.bot)delete payer.debt;
  renderPlayers();renderPot();
}
function settleDebt(p){
  if(!p?.debt||p.cash<p.debt.amount)return;
  const amt=p.debt.amount;
  const cred=p.debt.creditorId!=null?S.players[p.debt.creditorId]:null;
  p.cash-=amt;
  if(cred){cred.cash+=amt;log(`<b>${p.name}</b> settles debt — pays <b>${cred.name}</b> ${fmt(amt)}.`,p);}
  else{
    bankPay(amt);
    log(`<b>${p.name}</b> settles debt — pays ${fmt(amt)}${S.rules.vacation?' into the Vacation pot':' to the bank'}.`,p);
  }
  delete p.debt;
  msg('Debt cleared.');
  renderAll();
}
function voluntaryBankrupt(p){
  if(!p||p.dead||p.bot||S.over)return;
  if(!confirm('Declare bankruptcy and leave the game? Your properties return to the bank.'))return;
  const wasTurn=S.players[S.turn]===p;
  if(p.debt)delete p.debt;
  bankrupt(p,null);
  if(wasTurn&&!S.over)endTurn();
}
function liquidate(p,target){
  let guard=400;
  while(p.cash<target&&guard--){
    const wh=ownedBy(p).filter(t=>t.houses>0).sort((a,b)=>a.houseCost-b.houseCost)[0];
    if(wh){
      if(wh.houses===5){wh.houses=0;p.cash+=Math.floor(wh.houseCost*5/2);log(`<b>${p.name}</b> sells the hotel in ${wh.name}.`,p);}
      else{wh.houses--;p.cash+=Math.floor(wh.houseCost/2);log(`<b>${p.name}</b> sells a house in ${wh.name}.`,p);}
      continue;
    }
    const un=ownedBy(p).filter(t=>!t.mortgaged).sort((a,b)=>a.price-b.price)[0];
    if(un){
      if(S.rules.mortgage){un.mortgaged=true;p.cash+=Math.floor(un.price/2);log(`<b>${p.name}</b> mortgages ${un.name}.`,p);}
      else{un.owner=null;p.cash+=Math.floor(un.price/2);log(`<b>${p.name}</b> sells ${un.name} back to the bank.`,p);}
      continue;
    }
    break;
  }
  renderTiles();
}
function bankrupt(p,creditor){
  if(p.dead)return;p.dead=true;
  if(p.eliminatedAt==null)p.eliminatedAt=S.players.reduce((n,x)=>n+(x.turnsSurvived||0),0);
  log(`💥 <b>${p.name}</b> goes <b>bankrupt</b>${creditor?` — assets pass to <b>${creditor.name}</b>`:''}.`,p);
  ownedBy(p).forEach(t=>{t.houses=0;
    if(creditor&&!creditor.dead)t.owner=creditor.id;
    else{t.owner=null;t.mortgaged=false;}});
  if(creditor)creditor.cash+=Math.max(0,p.cash);
  p.cash=0;renderAll();checkWin();
}
function gameOverLeaderboard(winner){
  return [...S.players].sort((a,b)=>{
    if(a.id===winner.id)return -1;
    if(b.id===winner.id)return 1;
    if(!a.dead&&b.dead)return -1;
    if(a.dead&&!b.dead)return 1;
    const td=(b.turnsSurvived||0)-(a.turnsSurvived||0);
    if(td)return td;
    return netWorth(b)-netWorth(a);
  });
}

function showGameOverModal(winner){
  $('winWinnerEmoji').textContent=winner.emoji;
  $('winWinnerName').textContent=winner.name;
  $('winWinnerWorth').textContent=`${fmt(netWorth(winner))} · ${ownedBy(winner).length} properties`;
  const lb=$('winLeaderboard');
  if(lb){
    lb.innerHTML=gameOverLeaderboard(winner).map((p,i)=>{
      const isWin=p.id===winner.id;
      return `<div class="game-over-row${isWin?' game-over-row--winner':''}" style="animation-delay:${0.25+i*0.07}s">
        <span class="game-over-row__rank">${i+1}</span>
        <span class="game-over-row__player"><span class="game-over-row__tok">${p.emoji}</span><span>${p.name}</span>${isWin?'<span class="game-over-row__badge">winner</span>':''}</span>
        <span class="game-over-row__stat">${p.turnsSurvived||0}</span>
        <span class="game-over-row__stat">${fmt(netWorth(p))}</span>
      </div>`;
    }).join('');
  }
  $('winShareBtn').onclick=async()=>{
    const text=`${winner.emoji} ${winner.name} won ${S.rules.title}!`;
    const url=location.href.split('?')[0];
    try{
      if(navigator.share)await navigator.share({title:'Buildup.io',text,url});
      else{
        await navigator.clipboard.writeText(`${text} ${url}`);
        const btn=$('winShareBtn');
        const prev=btn?.textContent;
        if(btn)btn.textContent='Link copied!';
        setTimeout(()=>{if(btn&&prev)btn.textContent=prev;},2000);
      }
    }catch{/* cancelled */}
  };
  $('winPlayAgainBtn').onclick=()=>playAgainAfterGame();
  $('winModal')?.classList.remove('hidden');
  playGameOverWin();
}

function checkWin(){
  const al=alive();
  if(al.length===1&&!S.over){S.over=true;showGameOverModal(al[0]);}
  return S.over;
}

/* ============================================================
   TURN FLOW
============================================================ */
function startTurn(){
  if(S.over)return;
  while(S.cur.dead)S.turn=(S.turn+1)%S.players.length;
  S.doubles=0;
  turnTimeoutHandled=false;
  S.turnStartedAt=Date.now();
  S.voteKick={voters:[]};
  const p=S.cur;
  if(!p.dead){
    p.turnsSurvived=(p.turnsSurvived||0)+1;
    p.turnEngaged=false;
    p.turnBonusUsed=false;
  }
  p.rentSurge=false;
  if(p.jail){S.phase='jail';msg(`${p.name} is in prison (attempt ${p.jailTurns+1} of 3).`);}
  else{S.phase='roll';msg(turnMsg(p));}
  renderAll();
  if(isMpGame()){
    if(p.bot&&isMpHost())setTimeout(botTurn,900);
    return;
  }
  if(p.bot)setTimeout(botTurn,900);
}
function endTurn(){
  if(S.over)return;
  if(isMpGame()&&!isMyTurn())return;
  markTurnEngagement();
  S.phase='idle';
  S.turn=(S.turn+1)%S.players.length;
  if(isMpGame())broadcastStateNow();
  setTimeout(startTurn,420);
}

function humanRoll(){
  if(!assertMyTurn())return;
  markTurnEngagement();
  if(S.phase==='jail'){jailRoll(S.cur);return;}
  if(S.phase==='roll')doRoll(S.cur);
}
function doRoll(p){
  if(isMpGame()&&!isMyTurn())return;
  S.phase='moving';renderDock();
  const {total,startAt}=rollDiceAndBroadcast(p);
  const isDouble=S.dice[0]===S.dice[1]&&S.rules.doubles;
  if(!isMpGame()){
    log(`<b>${p.name}</b> rolls <b>${S.dice[0]} + ${S.dice[1]} = ${total}</b>${isDouble?' (doubles!)':''}.`,p);
  }
  setTimeout(()=>{
    if(isDouble)S.doubles++;
    if(S.doubles>=3){log(`<b>${p.name}</b> rolls three doubles in a row — straight to prison!`,p);sendToJail({cur:p});finishMovePhase(p,false);return;}
    if(isMpGame())broadcastStateNow();
    animateMove(p,total,()=>resolveTile(p,{rolledDouble:isDouble}));
  },msUntilDiceDone(startAt));
}
function animateMove(p,steps,done){
  const dir=steps<0?-1:1;let left=Math.abs(steps);
  const step=()=>{
    if(left===0){done();return;}
    p.pos=(p.pos+dir+N)%N;
    if(p.pos===0&&dir===1){
      p.cash+=S.rules.salary;
      log(`<b>${p.name}</b> passes START and collects $${S.rules.salary.toLocaleString()}.`,p);
      playTileCashFx(TILES[0],S.rules.salary,{color:p.color});
      renderPlayers();
    }
    left--;renderTiles();setTimeout(step,130);
  };step();
}
function moveBy(s,n){animateMove(s.cur,n,()=>resolveTile(s.cur,{fromCard:true}));}
function goTo(s,idx,collectGo){
  const p=s.cur;
  if(collectGo&&idx<=p.pos&&!(idx===0&&p.pos===0)){
    p.cash+=S.rules.salary;
    log(`<b>${p.name}</b> passes START and collects $${S.rules.salary.toLocaleString()}.`,p);
    playTileCashFx(TILES[0],S.rules.salary,{color:p.color});
  }
  p.pos=idx;renderAll();resolveTile(p,{fromCard:true});
}
function sendToJail(s){const p=s.cur;p.pos=JAIL_IDX;p.jail=true;p.jailTurns=0;
  log(`⛓️ <b>${p.name}</b> is locked up in prison.`,p);renderAll();
  const jailTile=TILES[JAIL_IDX];
  playJailBars();
  playJailArrest(jailTile);
}

function resolveTile(p,opts={}){
  if(S.over||p.dead){finishMovePhase(p,false);return;}
  const t=TILES[p.pos];
  t.el.style.setProperty('--land',p.color);
  t.el.style.setProperty('--flash',p.color);
  t.el.classList.remove('justlanded');void t.el.offsetWidth;t.el.classList.add('justlanded');
  const again=!!opts.rolledDouble;
  switch(t.type){
    case 'go': log(`<b>${p.name}</b> lands on START.`,p);finishMovePhase(p,again);break;
    case 'jail': log(`<b>${p.name}</b> is just visiting prison.`,p);finishMovePhase(p,again);break;
    case 'fair':
      if(S.rules.vacation&&S.pot>0){
        const pot=S.pot;
        p.cash+=pot;
        log(`🏖️ <b>${p.name}</b> lands on Vacation and scoops the pot: $${pot.toLocaleString()}!`,p);
        S.pot=0;renderPot();
        playTileCashFx(t,pot,{color:p.color});
      }
      else log(`🏖️ <b>${p.name}</b> takes a day off on Vacation.`,p);
      finishMovePhase(p,again);break;
    case 'gotojail': sendToJail({cur:p});finishMovePhase(p,false);break;
    case 'tax': log(`<b>${p.name}</b> hits ${t.name}.`,p);payTo(p,null,t.amount,t);finishMovePhase(p,again);break;
    case 'fortune': drawCard(p,'fortune',again);break;
    case 'treasury': drawCard(p,'treasury',again);break;
    default:{
      if(t.owner==null){
        if(p.bot){
          if(isMpGame()&&!isMpHost()){finishMovePhase(p,again);break;}
          if(botWantsBuy(p,t)){buyCurrent(p);finishMovePhase(p,again);}
          else if(S.rules.auction){log(`<b>${p.name}</b> sends ${t.name} to auction.`,p);startAuction(t,{playerId:p.id,again});}
          else{log(`<b>${p.name}</b> passes on ${t.name}.`,p);finishMovePhase(p,again);}
        }else{
          S.phase='buy';S.pendingDouble=again;
          msg(`${t.name} — ${fmt(t.price)} · Buy or Auction below`);
          renderDock();
        }
      }else if(t.owner===p.id){log(`<b>${p.name}</b> visits their own ${t.name}.`,p);finishMovePhase(p,again);}
      else if(t.mortgaged||S.players[t.owner].dead){log(`<b>${p.name}</b> stays rent-free — ${t.name} is mortgaged.`,p);finishMovePhase(p,again);}
      else if(S.rules.noJailRent&&S.players[t.owner].jail){log(`<b>${p.name}</b> stays rent-free — the owner of ${t.name} is in prison.`,p);finishMovePhase(p,again);}
      else{
        const owner=S.players[t.owner];const rent=computeRent(t,opts);
        log(`<b>${p.name}</b> lands on <b>${t.name}</b>. Rent owed to ${owner.name}: $${rent.toLocaleString()}.`,p);
        payTo(p,owner,rent,t);finishMovePhase(p,again);
      }
    }
  }
}
function computeRent(t,opts={}){
  const owner=S.players[t.owner];
  let r=0;
  if(t.type==='city'){r=t.rents[t.houses||0];
    if((t.houses||0)===0&&S.rules.double&&ownsGroup(owner,t.group))r*=2;}
  else if(t.type==='air'){r=AIR_RENTS[countType(owner,'air')]||0;if(opts.airDouble)r*=2;}
  else if(t.type==='utl'){const d=S.dice[0]+S.dice[1]||7;r=d*(UTL_MULT[countType(owner,'utl')]||0);}
  if(r>0&&owner.rentSurge)r*=2;
  return r;
}
function buyCurrent(p){
  if(isMpGame()&&!isMyTurn())return false;
  const t=TILES[p.pos];
  if(t.owner!=null||!t.price||p.cash<t.price)return false;
  const groupsBefore=new Set(ownedGroupIds(p));
  p.cash-=t.price;t.owner=p.id;t.houses=0;t.mortgaged=false;
  log(`🏷️ <b>${p.name}</b> buys <b>${t.name}</b> for $${t.price.toLocaleString()}.`,p);
  renderAll();
  playPurchaseTing();
  playPurchaseGlow(t,p.color);
  celebrateNewMonopolies(p,groupsBefore);
  return true;
}
function finishMovePhase(p,rollAgain){
  if(S.over)return;
  if(p.dead){endTurn();return;}
  renderAll();if(checkWin())return;
  const runBots=!isMpGame()||isMpHost();
  if(rollAgain&&!p.jail){
    S.phase='roll';renderDock();
    if(p.bot){if(runBots)setTimeout(()=>doRoll(p),900);}
    else msg('Doubles! Roll again.');
  }else if(p.bot){
    if(runBots)setTimeout(()=>{botBuild(p);endTurn();},700);
  }else{
    S.phase='end';
    msg(isMyTurn()?'Tap your properties to upgrade — or end your turn.':`Waiting for ${p.name}…`);
    renderDock();
  }
}

/* ---------- jail ---------- */
function payJailFine(p){
  payTo(p,null,100);if(p.dead){endTurn();return;}
  p.jail=false;p.jailTurns=0;
  log(`<b>${p.name}</b> pays the $100 fine and walks free.`,p);
  S.phase='roll';msg('Free again — roll the dice.');renderAll();
  if(p.bot)setTimeout(()=>doRoll(p),800);
}
function useJailCard(p){
  if(p.goojf<1)return;p.goojf--;p.jail=false;p.jailTurns=0;
  log(`🎟️ <b>${p.name}</b> uses a Get Out of Prison Free card.`,p);
  S.phase='roll';msg('Free again — roll the dice.');renderAll();
  if(p.bot)setTimeout(()=>doRoll(p),800);
}
function jailRoll(p){
  if(isMpGame()&&!isMyTurn())return;
  S.phase='moving';renderDock();
  const {total,startAt}=rollDiceAndBroadcast(p);
  setTimeout(()=>{
    if(S.dice[0]===S.dice[1]){
      p.jail=false;p.jailTurns=0;
      log(`<b>${p.name}</b> rolls doubles (${S.dice[0]}-${S.dice[1]}) and breaks out!`,p);
      animateMove(p,total,()=>resolveTile(p,{}));
    }else{
      p.jailTurns++;
      log(`<b>${p.name}</b> fails to roll doubles.`,p);
      if(p.jailTurns>=3){
        log(`<b>${p.name}</b> must pay the $100 fine after 3 attempts.`,p);
        payTo(p,null,100);if(p.dead){endTurn();return;}
        p.jail=false;p.jailTurns=0;
        animateMove(p,total,()=>resolveTile(p,{}));
      }else if(p.bot)setTimeout(endTurn,600);
      else{S.phase='end';msg('Still locked up. End your turn.');renderAll();}
    }
  },msUntilDiceDone(startAt));
}

/* ---------- power cards ---------- */
function removePowerCard(p,cardId){
  const i=p.powerCards.indexOf(cardId);
  if(i>=0)p.powerCards.splice(i,1);
}
function awardPowerCard(p,deck,again){
  const def=pickRandomPowerCard();
  p.powerCards.push(def.id);
  $('powerAwardIcon').textContent=def.emoji;
  $('powerAwardName').textContent=def.name;
  $('powerAwardDesc').textContent=def.desc;
  $('powerAwardModal').classList.remove('hidden');
  log(`🃏 <b>${p.name}</b> uncovers a rare <b>${def.name}</b> ${def.emoji} from ${deck==='fortune'?'Surprise':'Treasure'}!`,p);
  const done=()=>{
    $('powerAwardModal').classList.add('hidden');
    renderAll();
    if(!S.over)finishMovePhase(p,again);
  };
  $('powerAwardOk').onclick=done;
  if(p.bot)setTimeout(done,1600);
}
function canPlayPowerNow(p){
  return S.rules.powerCards&&!p.bot&&!p.dead&&S.cur.id===p.id&&(S.phase==='roll'||S.phase==='end');
}
function powerTargets(p,cardId){
  if(cardId==='demolition'){
    return TILES.map((t,i)=>({t,i})).filter(({t})=>t.type==='city'&&t.owner!=null&&t.owner!==p.id&&t.houses>0&&!S.players[t.owner].dead);
  }
  if(cardId==='phantom_build'){
    return TILES.map((t,i)=>({t,i})).filter(({t})=>t.type==='city'&&t.owner===p.id&&!t.mortgaged&&t.houses<5&&ownsGroup(p,t.group));
  }
  if(cardId==='summon')return TILES.map((t,i)=>({t,i})).filter(({t})=>t.type==='city');
  return [];
}
function applyPowerCard(p,cardId,targetIdx){
  const def=powerCardById(cardId);
  if(!def||!p.powerCards.includes(cardId)||!canPlayPowerNow(p))return;
  removePowerCard(p,cardId);
  $('powerCardsModal').classList.add('hidden');
  $('powerTargetModal').classList.add('hidden');
  switch(cardId){
    case 'rent_surge':
      p.rentSurge=true;
      log(`⚡ <b>${p.name}</b> plays <b>Rent Surge</b> — rent doubled until their next turn.`,p);
      renderAll();
      return;
    case 'heist':
      p.cash+=200;
      log(`💎 <b>${p.name}</b> plays <b>Treasury Heist</b> and grabs ${fmt(200)}.`,p);
      renderAll();
      return;
    case 'shake_down':{
      const others=alive().filter(x=>x.id!==p.id);
      let total=0;
      others.forEach(o=>{
        const pay=Math.min(35,o.cash);
        o.cash-=pay;p.cash+=pay;total+=pay;
      });
      log(`📉 <b>${p.name}</b> plays <b>Market Shake-down</b> — collects ${fmt(total)} from rivals.`,p);
      renderAll();
      return;
    }
    case 'tax_shield':
      p.taxShield=true;
      log(`🛡️ <b>${p.name}</b> plays <b>Tax Shield</b> — next bank fee is cancelled.`,p);
      renderAll();
      return;
    case 'vacation_pull':{
      let take=100;
      if(S.pot>0){
        take=Math.min(S.pot,Math.max(100,Math.floor(S.pot/2)));
        S.pot-=take;
      }
      p.cash+=take;
      log(`🏖️ <b>${p.name}</b> plays <b>Vacation Pull</b> and scoops ${fmt(take)}${S.rules.vacation&&S.pot>=0?' from the pot':' from the bank'}.`,p);
      renderAll();
      return;
    }
    case 'demolition':{
      const t=TILES[targetIdx];
      if(!t||t.type!=='city'||t.owner===p.id||!t.houses)return;
      const prev=t.houses;
      if(t.houses===5){t.houses=4;log(`💥 <b>${p.name}</b> demolishes the hotel in <b>${t.name}</b> — down to 4 houses.`,p);}
      else{t.houses--;log(`💥 <b>${p.name}</b> demolishes a house in <b>${t.name}</b>.`,p);}
      playDestroyAnimationSync(t,prev);
      renderAll();
      return;
    }
    case 'phantom_build':{
      const t=TILES[targetIdx];
      if(!t||t.owner!==p.id||t.houses>=5)return;
      const prev=t.houses;
      t.houses++;
      log(`✨ <b>${p.name}</b> plays <b>Phantom Build</b> — free ${t.houses===5?'hotel':'house'} in <b>${t.name}</b>.`,p);
      playBuildAnimation(t,prev);
      renderAll();
      return;
    }
    case 'summon':{
      const t=TILES[targetIdx];
      if(!t||t.type!=='city')return;
      p.pos=targetIdx;
      log(`🌀 <b>${p.name}</b> plays <b>Summoning Gate</b> — teleports to <b>${t.name}</b>.`,p);
      renderAll();
      resolveTile(p,{fromCard:true});
      return;
    }
    default:
      renderAll();
  }
}
function openPowerTargetPicker(p,cardId){
  const def=powerCardById(cardId);
  const targets=powerTargets(p,cardId);
  if(!targets.length){
    msg('No valid targets for that card right now.');
    return;
  }
  $('powerTargetEyebrow').textContent=def.name;
  $('powerTargetTitle').textContent=cardId==='summon'?'Choose a city to teleport to'
    :cardId==='demolition'?'Choose a building to destroy':'Choose where to build';
  const list=$('powerTargetList');
  list.innerHTML=targets.map(({t,i})=>{
    const owner=t.owner!=null?S.players[t.owner].name:'';
    const build=t.houses===5?'Hotel':(t.houses?`${t.houses} house${t.houses>1?'s':''}`:'Empty');
    const sub=cardId==='summon'?GROUPS[t.group]?.name||'City':`${owner} · ${build}`;
    return `<button type="button" class="power-target-item" data-idx="${i}">
      <span class="power-target-item__name">${tradeEsc(t.name)}</span>
      <span class="power-target-item__sub">${tradeEsc(sub)}</span>
    </button>`;
  }).join('');
  $('powerCardsModal').classList.add('hidden');
  $('powerTargetModal').classList.remove('hidden');
  list.querySelectorAll('.power-target-item').forEach(btn=>{
    btn.onclick=()=>applyPowerCard(p,cardId,+btn.dataset.idx);
  });
}
function beginPowerCardUse(p,cardId){
  if(['demolition','phantom_build','summon'].includes(cardId))openPowerTargetPicker(p,cardId);
  else applyPowerCard(p,cardId);
}
function openPowerCardsModal(){
  const p=localHuman();
  if(!p||!canPlayPowerNow(p))return;
  const list=$('powerHandList');
  const counts={};
  p.powerCards.forEach(id=>{counts[id]=(counts[id]||0)+1;});
  list.innerHTML=Object.entries(counts).map(([id,n])=>{
    const def=powerCardById(id);
    if(!def)return '';
    return `<div class="power-hand-card power-hand-card--${def.rarity}">
      <div class="power-hand-card__top">
        <span class="power-hand-card__emoji">${def.emoji}</span>
        <span class="power-hand-card__rarity">${def.rarity}</span>
      </div>
      <h3>${tradeEsc(def.name)}${n>1?` ×${n}`:''}</h3>
      <p>${tradeEsc(def.desc)}</p>
      <button type="button" class="btn vio power-hand-card__use" data-id="${id}">Play card</button>
    </div>`;
  }).join('');
  $('powerCardsModal').classList.remove('hidden');
  list.querySelectorAll('.power-hand-card__use').forEach(btn=>{
    btn.onclick=()=>beginPowerCardUse(p,btn.dataset.id);
  });
}
$('powerCardsBtn')?.addEventListener('click',openPowerCardsModal);
$('powerCardsClose')?.addEventListener('click',()=>$('powerCardsModal').classList.add('hidden'));
$('powerTargetCancel')?.addEventListener('click',()=>{
  $('powerTargetModal').classList.add('hidden');
  openPowerCardsModal();
});

/* ---------- cards ---------- */
function drawCard(p,deck,again){
  if(S.rules.powerCards&&Math.random()<POWER_DRAW_CHANCE){
    awardPowerCard(p,deck,again);
    return;
  }
  const pile=deck==='fortune'?S.fortune:S.treasury;
  const card=pile.shift();pile.push(card);
  const body=$('drawCardBody');body.className='drawcard '+deck;
  $('dcTitle').textContent=deck==='fortune'?'Surprise':'Treasure';
  $('dcIcon').textContent=deck==='fortune'?'❓':'🧰';
  $('dcText').textContent=card.x;
  $('cardModal').classList.remove('hidden');
  log(`${deck==='fortune'?'❓':'🧰'} <b>${p.name}</b> draws: <i>${card.x}</i>`,p);
  const apply=()=>{
    $('cardModal').classList.add('hidden');
    const before=p.pos,beforeJail=p.jail;
    card.f({cur:p});renderAll();
    const moved=p.pos!==before||p.jail!==beforeJail;
    if(!moved&&!S.over)finishMovePhase(p,again);
    else if(p.jail&&!beforeJail)finishMovePhase(p,false);
  };
  $('dcOk').onclick=apply;
  if(p.bot)setTimeout(apply,1700);
}

/* ============================================================
   AUCTION
============================================================ */
let A=null;
function serializeAuction(){
  if(!A||!A.tile)return null;
  const tileIdx=TILES.indexOf(A.tile);
  if(tileIdx<0)return null;
  return{
    tileIdx,bid:A.bid,leader:A.leader,
    active:[...A.active],idx:A.idx,
    history:A.history.map(h=>({...h})),
    afterPlayerId:A.afterPlayerId,afterAgain:!!A.afterAgain,
  };
}
function setupAuctionModal(tile){
  $('aucPropHead').innerHTML=`${propHeadHTML(tile)}<h3 class="auc-hero__name">${tile.name}</h3><div class="auc-hero__list">List price ${fmt(tile.price)}</div>`;
  $('aucRentPanel').innerHTML=`<div class="prop-rents">${propRentHTML(tile)||'<div class="prop-row"><span>Special tile</span><b>—</b></div>'}</div>${propFootHTML(tile)}`;
  $('aucHistory').innerHTML='';
  const lav0=$('aucLeadAv');
  if(lav0){lav0.textContent='—';lav0.classList.remove('has-lead');lav0.style.removeProperty('--pc');}
}
function updateAucRestoreBar(){
  const bar=$('aucRestoreBar');
  if(!bar)return;
  const min=$('aucModal')?.classList.contains('overlay--minimized');
  const open=A&&!$('aucModal')?.classList.contains('hidden');
  bar.classList.toggle('hidden',!(min&&open));
  if(A?.tile)bar.textContent=`🔨 ${A.tile.name} — tap to open auction`;
}
function updateTradeRestoreBar(){
  const bar=$('tradeRestoreBar');
  if(!bar)return;
  const min=$('tradeReviewModal')?.classList.contains('overlay--minimized');
  const open=viewingTradeId&&!$('tradeReviewModal')?.classList.contains('hidden');
  bar.classList.toggle('hidden',!(min&&open));
  const t=viewingTradeId?getOpenTrade(viewingTradeId):null;
  if(t){
    const from=S.players[t.fromId],to=S.players[t.toId];
    bar.textContent=`🤝 ${from?.name||'?'} → ${to?.name||'?'} — tap to review`;
  }
}
function restoreAuctionState(data){
  if(!data){
    if(A){$('aucModal')?.classList.add('hidden');A=null;updateAucRestoreBar();}
    return;
  }
  const tile=TILES[data.tileIdx];
  if(!tile)return;
  const wasActive=!!A;
  A={
    tile,bid:data.bid??0,leader:data.leader??null,
    active:[...(data.active||[])],idx:data.idx??0,
    history:(data.history||[]).map(h=>({...h})),
    afterPlayerId:data.afterPlayerId,afterAgain:!!data.afterAgain,
  };
  if(!wasActive)setupAuctionModal(tile);
  $('aucModal')?.classList.remove('hidden');
  aucRender();
  updateAucRestoreBar();
  if(!wasActive&&aucCur()?.bot&&isMpHost())setTimeout(aucStep,400);
}
function startAuction(tile,after={}){
  const bidders=alive().filter(p=>p.cash>=10);
  if(bidders.length===0){
    const p=after.playerId!=null?S.players.find(x=>x.id===after.playerId):S.cur;
    if(p)finishMovePhase(p,!!after.again);
    return;
  }
  A={
    tile,bid:0,leader:null,active:bidders.map(p=>p.id),idx:0,history:[],
    afterPlayerId:after.playerId??S.cur?.id,afterAgain:!!after.again,
  };
  setupAuctionModal(tile);
  $('aucModal')?.classList.remove('hidden','overlay--minimized');
  $('aucRestoreBar')?.classList.add('hidden');
  aucRender();aucStep();
  if(isMultiplayerActive())broadcastStateNow();
}
function aucCur(){return S.players[A.active[A.idx%A.active.length]];}
function aucRender(){
  $('aucBid').textContent=fmt(A.bid);
  const lead=A.leader!=null?S.players[A.leader]:null;
  $('aucLeader').textContent=lead?`${lead.name} is leading`:'No bids yet';
  const lav=$('aucLeadAv');
  if(lav){
    if(lead){lav.textContent=lead.emoji;lav.style.setProperty('--pc',lead.color);lav.classList.add('has-lead');}
    else{lav.textContent='—';lav.style.removeProperty('--pc');lav.classList.remove('has-lead');}
  }
  $('aucHistory').innerHTML=A.history.slice(0,8).map(h=>{
    const p=S.players[h.pid];
    return `<div class="auc-hist" style="--hc:${p.color}"><span class="av-sm" style="background:${p.color}">${p.emoji}</span><span><b>${p.name}</b> bids ${fmt(h.amount)}</span></div>`;
  }).join('');
  $('aucPlayers').innerHTML=alive().map(p=>{
    const folded=!A.active.includes(p.id);
    return `<span class="aucP${folded?' folded':''}${A.leader===p.id?' lead':''}" style="--pc:${p.color};border-left:3px solid ${p.color}">${p.emoji} ${p.name}</span>`;
  }).join('');
  const cur=aucCur();
  const humanUp=cur&&!cur.bot&&(!isMpGame()||cur.userId===getUser()?.id);
  ['aucB10','aucB50','aucB100','aucFold'].forEach(id=>$(id).disabled=!humanUp);
  if(humanUp){
    $('aucStatus').textContent=`${cur.name}, raise or fold.`;
    $('aucB10').disabled=cur.cash<A.bid+10;
    $('aucB50').disabled=cur.cash<A.bid+50;
    $('aucB100').disabled=cur.cash<A.bid+100;
  }
}
function aucBid(p,amount){
  if(isMpGame()&&!p.bot&&p.userId!==getUser()?.id)return;
  A.bid=amount;A.leader=p.id;
  A.history.unshift({pid:p.id,amount});
  log(`🔨 <b>${p.name}</b> bids ${fmt(amount)} for ${A.tile.name}.`,p);
  A.idx++;aucRender();
  if(isMultiplayerActive())broadcastStateNow();
  setTimeout(aucStep,650);
}
function aucFold(p){
  if(isMpGame()&&!p.bot&&p.userId!==getUser()?.id)return;
  A.active=A.active.filter(id=>id!==p.id);
  if(A.idx>=A.active.length)A.idx=0;
  log(`<b>${p.name}</b> folds.`,p);
  aucRender();
  if(isMultiplayerActive())broadcastStateNow();
  setTimeout(aucStep,500);
}
function aucStep(){
  if(!A)return;
  if(isMpGame()&&!isMpHost()){aucRender();return;}
  if(A.active.length===0){aucEnd(null);return;}
  if(A.active.length===1&&A.leader===A.active[0]){aucEnd(A.leader);return;}
  if(A.active.length===1&&A.leader==null){
    const p=S.players[A.active[0]];
    if(p.bot){if(botWantsBid(p,10))aucBid(p,10);else aucEnd(null);return;}
  }
  const cur=aucCur();
  if(cur.id===A.leader){A.idx++;setTimeout(aucStep,60);return;}
  if(cur.bot){
    $('aucStatus').textContent=`${cur.name} is thinking…`;aucRender();
    setTimeout(()=>{
      const next=A.bid+(A.bid<100?10:50);
      if(botWantsBid(cur,next)&&cur.cash>=next)aucBid(cur,next);
      else aucFold(cur);
    },800);
  }else aucRender();
}
function botWantsBid(p,amount){
  const t=A.tile;
  let val=t.price*S.rules.diff.bidMult;
  if(t.type==='city'&&groupTiles(t.group).every(x=>x.owner===p.id||x===t))val*=1.6;
  return amount<=Math.min(val,p.cash-80);
}
$('aucB10').onclick=()=>{const p=aucCur();if(!p.bot)aucBid(p,A.bid+10);};
$('aucB50').onclick=()=>{const p=aucCur();if(!p.bot)aucBid(p,A.bid+50);};
$('aucB100').onclick=()=>{const p=aucCur();if(!p.bot)aucBid(p,A.bid+100);};
$('aucFold').onclick=()=>{const p=aucCur();if(!p.bot)aucFold(p);};
function aucEnd(winnerId){
  if(isMpGame()&&!isMpHost())return;
  $('aucModal').classList.add('hidden');
  $('aucModal')?.classList.remove('overlay--minimized');
  $('aucRestoreBar')?.classList.add('hidden');
  const t=A.tile,afterPlayerId=A.afterPlayerId,afterAgain=A.afterAgain;
  if(winnerId!=null){
    const w=S.players[winnerId];
    const groupsBefore=new Set(ownedGroupIds(w));
    w.cash-=A.bid;t.owner=w.id;t.houses=0;t.mortgaged=false;
    log(`🔨 <b>${w.name}</b> wins the auction for <b>${t.name}</b> at $${A.bid.toLocaleString()}.`,w);
    renderAll();
    playPurchaseTing();
    playPurchaseGlow(t,w.color);
    celebrateNewMonopolies(w,groupsBefore);
  }else{log(`🔨 No takers — ${t.name} stays with the bank.`);renderAll();}
  A=null;
  if(isMultiplayerActive())broadcastStateNow();
  if(afterPlayerId!=null){
    const p=S.players.find(x=>x.id===afterPlayerId);
    if(p)finishMovePhase(p,afterAgain);
  }
}

/* ============================================================
   TRADES
============================================================ */
const tradeSel={offer:new Set(),want:new Set()};
let tradePartnerId=null,tradeCounterId=null,viewingTradeId=null;
function tradable(p){return ownedBy(p).filter(t=>!t.mortgaged&&t.houses===0);}
function propValue(t){return t.mortgaged?Math.floor(t.price/2):t.price;}
function tradeValue(props,cash){return props.reduce((s,t)=>s+propValue(t),0)+cash;}
function tradeEsc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}
function getOpenTrade(id){return S.openTrades.find(t=>t.id===id);}
function removeOpenTrade(id){S.openTrades=S.openTrades.filter(t=>t.id!==id);}
function tradeStatusLabel(t){
  if(t.status==='declined')return 'Declined';
  if(t.status==='pending'){
    const w=S.players[t.awaitingId];
    return w?`Waiting on ${w.name}`:'Pending';
  }
  return t.status;
}
function tradeCashBarHTML(label,amount,wallet){
  const pct=wallet>0?Math.min(100,Math.round((amount/wallet)*100)):0;
  return `<div class="trade-cash-bar">
    <div class="trade-cash-bar__row"><span>${tradeEsc(label)}</span><strong>${fmt(amount)}</strong></div>
    <div class="trade-cash-bar__track"><span style="width:${pct}%"></span></div>
  </div>`;
}
function maintainOpenTrades(){
  if(isMpGame()&&!isMpHost())return;
  const open=S.openTrades||[];
  if(open.length<=TRADE_QUEUE_MAX)return;
  const now=Date.now();
  let changed=false;
  for(const t of open){
    if(t.status!=='pending')continue;
    const awaiting=S.players[t.awaitingId];
    if(!awaiting||awaiting.bot)continue;
    if(!t.createdAt)t.createdAt=now;
    if(!t.expireWarnAt){
      t.expireWarnAt=now;
      t.expireAt=now+TRADE_EXPIRE_WARN_MS;
      const summary=`${tradeTileSummary(t.offerIdx,t.offerCash)} → ${tradeTileSummary(t.wantIdx,t.wantCash)}`;
      log(`⏳ Too many open trades — <b>${S.players[t.fromId]?.name}</b>'s offer to <b>${awaiting.name}</b> closes in 10s unless answered.`,S.players[t.fromId]);
      if(awaiting.id===localHuman()?.id)msg('Accept or reject the trade offer — it closes in 10 seconds.');
      pushTradeActivity({tradeId:t.id,kind:'open',text:`${S.players[t.fromId]?.name} → ${awaiting.name}`,summary});
      changed=true;
    }else if(t.expireAt&&now>=t.expireAt){
      log(`⌛ Trade offer from <b>${S.players[t.fromId]?.name}</b> to <b>${awaiting.name}</b> expired.`,S.players[t.fromId]);
      removeOpenTrade(t.id);
      changed=true;
    }
  }
  if(changed&&isMultiplayerActive())broadcastStateNow();
}
function cancelOpenTrade(id){
  const trade=getOpenTrade(id);
  const human=localHuman();
  if(!trade||!human||trade.fromId!==human.id)return;
  removeOpenTrade(id);
  log(`<b>${human.name}</b> cancelled their trade offer.`,human);
  if(isMultiplayerActive())broadcastStateNow();
  closeTradeReview();
  renderAll();
}
function addOpenTrade(from,to,offerIdx,wantIdx,offerCash,wantCash){
  const trade={
    id:tradeSeq++,fromId:from.id,toId:to.id,
    offerIdx:[...offerIdx],wantIdx:[...wantIdx],offerCash,wantCash,
    status:'pending',awaitingId:to.id,round:1,createdAt:Date.now(),
    history:[{round:1,by:from.id,offerIdx:[...offerIdx],wantIdx:[...wantIdx],offerCash,wantCash,text:`${from.name} proposed`}],
  };
  S.openTrades.unshift(trade);
  if(isMultiplayerActive())broadcastStateNow();
  return trade;
}
function counterOpenTrade(trade,by,offerIdx,wantIdx,offerCash,wantCash){
  const other=by.id===trade.fromId?trade.toId:trade.fromId;
  trade.fromId=by.id;
  trade.toId=other;
  trade.offerIdx=[...offerIdx];
  trade.wantIdx=[...wantIdx];
  trade.offerCash=offerCash;
  trade.wantCash=wantCash;
  trade.status='pending';
  trade.awaitingId=other;
  trade.round++;
  trade.history.unshift({
    round:trade.round,by:by.id,
    offerIdx:[...offerIdx],wantIdx:[...wantIdx],offerCash,wantCash,
    text:`${by.name} countered`,
  });
  if(isMultiplayerActive())broadcastStateNow();
}
function finalizeOpenTrade(trade){
  const from=S.players[trade.fromId],to=S.players[trade.toId];
  const fromGroups=new Set(ownedGroupIds(from));
  const toGroups=new Set(ownedGroupIds(to));
  const offerIdx=[...trade.offerIdx],wantIdx=[...trade.wantIdx];
  if(!executeTrade(from,to,offerIdx,wantIdx,trade.offerCash,trade.wantCash))return false;
  recordTrade(from,to,offerIdx,wantIdx,trade.offerCash,trade.wantCash,trade.id);
  const summary=`${tradeTileSummary(offerIdx,trade.offerCash)} ↔ ${tradeTileSummary(wantIdx,trade.wantCash)}`;
  log(`🤝 <b>${from.name}</b> and <b>${to.name}</b> complete a trade.`,from,{tradeId:trade.id,kind:'done'});
  pushTradeActivity({tradeId:trade.id,kind:'done',text:`${from.name} ↔ ${to.name} (done)`,summary});
  removeOpenTrade(trade.id);
  renderAll();
  playTradeSuccess();
  playTradeSuccessAnim(from,to,offerIdx,wantIdx,TILES);
  celebrateNewMonopolies(from,fromGroups);
  celebrateNewMonopolies(to,toGroups);
  return true;
}
function renderOpenTrades(){
  const list=$('tradeOpenList');
  if(!list)return;
  const open=S.openTrades||[];
  if(!open.length){
    list.innerHTML='<div class="trade-feed-empty">No active trades yet.</div>';
    return;
  }
  list.innerHTML=open.map(t=>{
    const from=S.players[t.fromId],to=S.players[t.toId];
    const gave=tradeTileSummary(t.offerIdx,t.offerCash);
    const wants=tradeTileSummary(t.wantIdx,t.wantCash);
    const st=tradeStatusLabel(t);
    const canCancel=localHuman()?.id===from.id&&t.status==='pending';
    return `<div class="trade-feed-item-wrap">
      <button type="button" class="trade-feed-item trade-feed-item--${t.status}" data-id="${t.id}">
        <span class="trade-feed-item__row">
          <span class="trade-feed-item__avatars">
            <span class="trade-feed-av p-av p-av--0" style="--pc:${from.color}">${from.emoji}</span>
            <span class="trade-feed-av p-av p-av--1" style="--pc:${to.color}">${to.emoji}</span>
          </span>
          <span class="trade-feed-item__main">${tradeEsc(from.name)} → ${tradeEsc(to.name)}</span>
          <span class="trade-feed-item__badge">${tradeEsc(st)}</span>
        </span>
        <span class="trade-feed-item__sub"><b>Gives:</b> ${tradeEsc(gave)} · <b>Wants:</b> ${tradeEsc(wants)}</span>
      </button>
      ${canCancel?`<button type="button" class="trade-feed-cancel" data-cancel="${t.id}" title="Cancel offer">✕</button>`:''}
    </div>`;
  }).join('');
  list.querySelectorAll('.trade-feed-item[data-id]').forEach(btn=>{
    btn.onclick=()=>openTradeDetail(+btn.dataset.id);
  });
  list.querySelectorAll('[data-cancel]').forEach(btn=>{
    btn.onclick=(e)=>{e.stopPropagation();cancelOpenTrade(+btn.dataset.cancel);};
  });
}
function getTradePartner(){return tradePartnerId!=null?S.players[tradePartnerId]:null;}
function selectTradePartner(id){
  if(tradePartnerId===id){tradePartnerId=null;tradeSel.want.clear();}
  else{tradePartnerId=id;tradeSel.want.clear();}
  renderTradePlayerPick();
  renderTradeLists();
}
function renderTradePlayerPick(){
  const wrap=$('tradePlayerPick');
  const me=localHuman();
  if(!wrap||!me)return;
  const others=alive().filter(x=>x.id!==me.id);
  wrap.innerHTML=others.map(x=>{
    const on=tradePartnerId===x.id;
    const pi=S.players.findIndex(p=>p.id===x.id);
    return `<label class="trade-player${on?' on':''}" data-id="${x.id}">
      <input type="radio" name="tradePartner" value="${x.id}"${on?' checked':''} aria-label="Trade with ${tradeEsc(x.name)}">
      <span class="trade-player__av p-av p-av--${pi%6}" style="--pc:${x.color}">${x.emoji}</span>
      <span class="trade-player__meta">
        <span class="trade-player__name">${tradeEsc(x.name)}</span>
        <span class="trade-player__cash">${fmt(x.cash)}</span>
      </span>
    </label>`;
  }).join('');
  wrap.querySelectorAll('.trade-player').forEach(el=>{
    el.onclick=(e)=>{
      if(e.target.tagName==='INPUT')return;
      e.preventDefault();
      selectTradePartner(+el.dataset.id);
    };
  });
  wrap.querySelectorAll('input[name="tradePartner"]').forEach(r=>{
    r.onchange=()=>{if(r.checked)selectTradePartner(+r.value);};
  });
}
function tradeCashStep(max){return max>=2000?100:max>=500?50:10;}
function syncTradeSliders(){
  const me=localHuman();
  const partner=getTradePartner();
  const offerSl=$('tradeOfferCash');
  const wantSl=$('tradeWantCash');
  if(!me||!offerSl)return;
  const offerMax=Math.max(0,me.cash);
  offerSl.max=offerMax;
  offerSl.step=tradeCashStep(offerMax);
  if(+offerSl.value>offerMax)offerSl.value=offerMax;
  $('tradeOfferCashVal').textContent=fmt(+offerSl.value);
  if($('tradeOfferWallet'))$('tradeOfferWallet').textContent=`Wallet ${fmt(me.cash)}`;
  if(partner&&wantSl){
    const wantMax=Math.max(0,partner.cash);
    wantSl.disabled=false;
    wantSl.max=wantMax;
    wantSl.step=tradeCashStep(wantMax);
    if(+wantSl.value>wantMax)wantSl.value=wantMax;
    $('tradeWantCashVal').textContent=fmt(+wantSl.value);
    if($('tradeWantWallet'))$('tradeWantWallet').textContent=`Wallet ${fmt(partner.cash)}`;
  }else if(wantSl){
    wantSl.disabled=true;
    wantSl.value=0;
    wantSl.max=0;
    $('tradeWantCashVal').textContent='$0';
    if($('tradeWantWallet'))$('tradeWantWallet').textContent='—';
  }
}
function bindTradeSliders(){
  [['tradeOfferCash','tradeOfferCashVal'],['tradeWantCash','tradeWantCashVal']].forEach(([id,valId])=>{
    const el=$(id);
    if(!el||el.dataset.bound)return;
    el.dataset.bound='1';
    el.oninput=()=>{$(valId).textContent=fmt(+el.value);};
  });
}
function openTrade(){
  const p=localHuman();
  if(!p)return;
  const partners=alive().filter(x=>x.id!==p.id);
  if(!partners.length)return;
  tradeCounterId=null;
  tradeSel.offer.clear();tradeSel.want.clear();
  tradePartnerId=null;
  $('tradeOfferCash').value=0;
  $('tradeWantCash').value=0;
  bindTradeSliders();
  renderTradePlayerPick();
  renderTradeLists();
  const head=$('tradeModal')?.querySelector('.trade-head h2');
  if(head)head.textContent=tradeCounterId?'Counter offer':'Create trade';
  $('tradeModal').classList.remove('hidden');
}
function loadTradeForCounter(trade,human){
  const partnerId=human.id===trade.fromId?trade.toId:trade.fromId;
  tradePartnerId=partnerId;
  tradeSel.offer.clear();tradeSel.want.clear();
  if(human.id===trade.fromId){
    trade.offerIdx.forEach(i=>tradeSel.offer.add(i));
    trade.wantIdx.forEach(i=>tradeSel.want.add(i));
    $('tradeOfferCash').value=trade.offerCash;
    $('tradeWantCash').value=trade.wantCash;
  }else{
    trade.wantIdx.forEach(i=>tradeSel.offer.add(i));
    trade.offerIdx.forEach(i=>tradeSel.want.add(i));
    $('tradeOfferCash').value=trade.wantCash;
    $('tradeWantCash').value=trade.offerCash;
  }
}
function renderTradeLists(){
  const p=localHuman();
  const partner=getTradePartner();
  const swap=$('tradeCols');
  if(swap)swap.classList.toggle('trade-swap--idle',!partner);
  if($('tradeOfferHeading'))$('tradeOfferHeading').textContent='You give';
  if($('tradeWantHeading'))$('tradeWantHeading').textContent=partner?`From ${partner.name}`:'You receive';
  const propose=$('tradePropose');
  if(propose)propose.disabled=!partner;
  const mk=(list,props,set,idle)=>{
    if(!list)return;
    if(idle){
      list.innerHTML='<div class="trade-empty">Choose a traveler above</div>';
      return;
    }
    list.innerHTML=props.length?props.map(t=>{
      const on=set.has(t.idx);
      return `<div class="trade-item${on?' on':''}" data-idx="${t.idx}"><span class="fi">${tileIcon(t)}</span><span class="fn">${tradeEsc(t.name)}</span></div>`;
    }).join(''):'<div class="trade-empty">No properties</div>';
    list.querySelectorAll('.trade-item').forEach(el=>{
      el.onclick=()=>{const i=+el.dataset.idx;if(set.has(i))set.delete(i);else set.add(i);renderTradeLists();};
    });
  };
  mk($('tradeOfferList'),p?tradable(p):[],tradeSel.offer,false);
  mk($('tradeWantList'),partner?tradable(partner):[],tradeSel.want,!partner);
  syncTradeSliders();
}
function executeTrade(from,to,offerIdx,wantIdx,offerCash,wantCash){
  const offerTiles=offerIdx.map(i=>TILES[i]),wantTiles=wantIdx.map(i=>TILES[i]);
  if(offerCash>from.cash||wantCash>to.cash)return false;
  if(offerTiles.some(t=>t.owner!==from.id||t.houses>0||t.mortgaged))return false;
  if(wantTiles.some(t=>t.owner!==to.id||t.houses>0||t.mortgaged))return false;
  from.cash-=offerCash;to.cash+=offerCash;
  to.cash-=wantCash;from.cash+=wantCash;
  offerTiles.forEach(t=>{t.owner=to.id;});
  wantTiles.forEach(t=>{t.owner=from.id;});
  return true;
}
function botAcceptsTrade(bot,human,offerIdx,wantIdx,offerCash,wantCash){
  const give=tradeValue(wantIdx.map(i=>TILES[i]),wantCash);
  const get=tradeValue(offerIdx.map(i=>TILES[i]),offerCash);
  let bonus=0;
  wantIdx.forEach(i=>{const t=TILES[i];if(t.type==='city'&&groupTiles(t.group).every(x=>x.owner===bot.id||x===t))bonus+=t.price*0.4;});
  offerIdx.forEach(i=>{const t=TILES[i];if(t.type==='city'&&groupTiles(t.group).every(x=>x.owner===human.id||x===t))bonus-=t.price*0.3;});
  return get+bonus>=give*0.92&&bot.cash>=wantCash+50;
}
function tradeItemsListHTML(idxs,cash){
  const items=idxs.map(i=>TILES[i]?.name).filter(Boolean);
  if(cash)items.push(`${fmt(cash)} cash`);
  if(!items.length)return '<span class="trade-review-none">Nothing</span>';
  return `<ul class="trade-review-list">${items.map(n=>`<li>${tradeEsc(n)}</li>`).join('')}</ul>`;
}
function tradeReviewPaneHTML(name,emoji,color,label,idxs,cash){
  const pi=S.players.findIndex(p=>p.name===name);
  return `<div class="trade-review-pane">
    <span class="trade-review-av p-av p-av--${Math.max(0,pi)%6}" style="--pc:${color}">${emoji}</span>
    <div class="trade-review-pane__meta">
      <span class="trade-review-pane__label">${tradeEsc(label)}</span>
      <span class="trade-review-pane__name">${tradeEsc(name)}</span>
      <div class="trade-review-pane__items">${tradeItemsListHTML(idxs,cash)}</div>
    </div>
  </div>`;
}
function openCompletedTradeView(idx){
  const t=S.recentTrades?.[idx];
  if(!t)return;
  viewingTradeId=null;
  const histWrap=$('tradeReviewHistory')?.parentElement;
  if(histWrap)histWrap.classList.add('hidden');
  const parties=$('tradeReviewParties');
  if(parties)parties.innerHTML=
    tradeReviewPaneHTML(t.fromName,t.fromEmoji,t.fromColor,'Gives',t.offerIdx,t.offerCash)+
    '<div class="trade-review-divider" aria-hidden="true">⇄</div>'+
    tradeReviewPaneHTML(t.toName,t.toEmoji,t.toColor,'Gets',t.wantIdx,t.wantCash);
  $('tradeReviewEyebrow').textContent='Past trade';
  $('tradeReviewTitle').textContent=`${t.fromName} traded with ${t.toName}`;
  const note=$('tradeReviewNote');
  if(note)note.textContent='This deal is finished.';
  $('tradeReviewActions')?.classList.add('hidden');
  const solo=$('tradeReviewSolo');
  solo?.classList.remove('hidden');
  $('tradeReviewNegotiate')?.classList.add('hidden');
  $('tradeReviewClose').textContent='Close';
  $('tradeReviewModal')?.classList.remove('hidden');
}
function renderTradeReview(trade,mode){
  const human=localHuman();
  if(!trade)return;
  viewingTradeId=trade.id;
  const from=S.players[trade.fromId],to=S.players[trade.toId];
  const histWrap=$('tradeReviewHistory')?.parentElement;
  if(histWrap)histWrap.classList.remove('hidden');
  const parties=$('tradeReviewParties');
  const note=$('tradeReviewNote');
  const actions=$('tradeReviewActions');
  const solo=$('tradeReviewSolo');
  const hist=$('tradeReviewHistory');
  if(parties)parties.innerHTML=
    tradeReviewPaneHTML(from.name,from.emoji,from.color,'Gives',trade.offerIdx,trade.offerCash)+
    tradeCashBarHTML(`${from.name} offers cash`,trade.offerCash,from.cash)+
    '<div class="trade-review-divider" aria-hidden="true">⇄</div>'+
    tradeReviewPaneHTML(to.name,to.emoji,to.color,'Gets',trade.wantIdx,trade.wantCash)+
    tradeCashBarHTML(`${to.name} offers cash`,trade.wantCash,to.cash);
  if(hist){
    hist.innerHTML=trade.history.map(h=>{
      const by=S.players[h.by];
      const detail=h.offerIdx
        ?`${tradeEsc(by?.name||'?')}: ${tradeEsc(tradeTileSummary(h.offerIdx,h.offerCash))} ⇄ ${tradeEsc(tradeTileSummary(h.wantIdx,h.wantCash))}`
        :tradeEsc(h.text||'');
      return `<div class="trade-hist-row"><span class="trade-hist-round">R${h.round}</span><span>${detail}</span></div>`;
    }).join('');
  }
  const canRespond=trade.status==='pending'&&human&&human.id===trade.awaitingId&&!to.bot;
  const canNegotiate=human&&(canRespond||trade.status==='declined'&&(human.id===trade.fromId||human.id===trade.toId));
  actions?.classList.toggle('hidden',!canRespond);
  solo?.classList.toggle('hidden',trade.status!=='declined'||canRespond);
  if(mode==='waiting'||(!mode&&trade.status==='pending'&&to.bot)){
    $('tradeReviewEyebrow').textContent='Active trade';
    $('tradeReviewTitle').textContent=`${from.name} offered ${to.name}`;
    if(note)note.textContent=`${to.name} is deciding. ${from.name} gives what's listed on the left; ${to.name} would give what's on the right.`;
  }else if(mode==='incoming'||canRespond){
    $('tradeReviewEyebrow').textContent='Needs your answer';
    $('tradeReviewTitle').textContent=`${from.name} wants to trade`;
    if(note)note.textContent=`Left = ${from.name} gives · Right = you give. Accept, reject, or negotiate.`;
  }else if(mode==='declined'||trade.status==='declined'){
    $('tradeReviewEyebrow').textContent='Trade declined';
    $('tradeReviewTitle').textContent=`${to.name} said no`;
    if(note)note.textContent='You can negotiate a new offer or close this.';
  }else if(mode==='accepted'){
    $('tradeReviewEyebrow').textContent='Trade complete';
    $('tradeReviewTitle').textContent='Deal done!';
    if(note)note.textContent=`${from.name} and ${to.name} completed the trade.`;
  }else{
    $('tradeReviewEyebrow').textContent='Active trade';
    $('tradeReviewTitle').textContent=`${from.name} ↔ ${to.name}`;
    if(note)note.textContent=`Round ${trade.round} · ${tradeStatusLabel(trade)} · Left gives / Right gets.`;
  }
  if(actions&&!actions.classList.contains('hidden')){
    $('tradeAccept').classList.remove('hidden');
    $('tradeReject').classList.remove('hidden');
    $('tradeNegotiate').classList.toggle('hidden',!canNegotiate);
    const delBtn=$('tradeDelete');
    if(delBtn){
      const canDel=human&&human.id===trade.fromId&&trade.status==='pending';
      delBtn.classList.toggle('hidden',!canDel);
      delBtn.onclick=()=>cancelOpenTrade(trade.id);
    }
  }
  if(solo&&!solo.classList.contains('hidden')){
    $('tradeReviewNegotiate').classList.toggle('hidden',!canNegotiate);
  }
}
function openTradeDetail(id,mode=null){
  const trade=getOpenTrade(id);
  if(!trade)return;
  renderTradeReview(trade,mode);
  $('tradeReviewModal')?.classList.remove('hidden','overlay--minimized');
  $('tradeRestoreBar')?.classList.add('hidden');
  updateTradeRestoreBar();
}
function closeTradeReview(){
  viewingTradeId=null;
  $('tradeReviewHistory')?.parentElement?.classList.remove('hidden');
  $('tradeReviewModal')?.classList.add('hidden');
  $('tradeReviewModal')?.classList.remove('overlay--minimized');
  $('tradeRestoreBar')?.classList.add('hidden');
}
function negotiateTrade(tradeId){
  const trade=getOpenTrade(tradeId??viewingTradeId);
  const human=localHuman();
  if(!trade||!human)return;
  tradeCounterId=trade.id;
  loadTradeForCounter(trade,human);
  closeTradeReview();
  bindTradeSliders();
  renderTradePlayerPick();
  renderTradeLists();
  syncTradeSliders();
  const head=$('tradeModal')?.querySelector('.trade-head h2');
  if(head)head.textContent='Counter offer';
  $('tradeModal').classList.remove('hidden');
}
function scheduleBotTradeResponse(trade){
  if(!trade||!S.players[trade.toId]?.bot)return;
  setTimeout(()=>respondBotToTrade(trade.id),850+Math.random()*500);
}
function respondBotToTrade(tradeId){
  const trade=getOpenTrade(tradeId);
  if(!trade||trade.status!=='pending')return;
  const from=S.players[trade.fromId],to=S.players[trade.toId];
  if(botAcceptsTrade(to,from,trade.offerIdx,trade.wantIdx,trade.offerCash,trade.wantCash)){
    renderTradeReview(trade,'accepted');
    $('tradeReviewModal')?.classList.remove('hidden');
    finalizeOpenTrade(trade);
    renderAll();
    setTimeout(closeTradeReview,1400);
  }else{
    trade.status='declined';
    trade.awaitingId=null;
    trade.history.unshift({round:trade.round,by:to.id,text:`${to.name} declined`});
    log(`<b>${to.name}</b> declines the trade offer.`,to);
    renderAll();
    openTradeDetail(tradeId,'declined');
  }
}
function proposeTrade(){
  const from=localHuman(),to=getTradePartner();
  if(!from)return;
  if(!to){msg('Choose a traveler to trade with.');return;}
  const offerIdx=[...tradeSel.offer],wantIdx=[...tradeSel.want];
  const offerCash=Math.max(0,+$('tradeOfferCash').value||0);
  const wantCash=Math.max(0,+$('tradeWantCash').value||0);
  if(!offerIdx.length&&!wantIdx.length&&!offerCash&&!wantCash){msg('Add something to trade.');return;}
  if(offerCash>from.cash||wantCash>to.cash){msg('Not enough cash for this trade.');return;}
  $('tradeModal').classList.add('hidden');
  let trade;
  const counterId=tradeCounterId;
  tradeCounterId=null;
  if(counterId){
    const existing=getOpenTrade(counterId);
    if(existing){
      counterOpenTrade(existing,from,offerIdx,wantIdx,offerCash,wantCash);
      trade=existing;
      to=S.players[trade.toId];
      const summary=`${tradeTileSummary(offerIdx,offerCash)} → ${tradeTileSummary(wantIdx,wantCash)}`;
      log(`🔄 <b>${from.name}</b> sends a counter-offer to <b>${to.name}</b>.`,from,{tradeId:trade.id,kind:'open'});
      pushTradeActivity({tradeId:trade.id,kind:'open',text:`${from.name} countered ${to.name}`,summary});
    }else trade=addOpenTrade(from,to,offerIdx,wantIdx,offerCash,wantCash);
  }else{
    trade=addOpenTrade(from,to,offerIdx,wantIdx,offerCash,wantCash);
    const summary=`${tradeTileSummary(offerIdx,offerCash)} → ${tradeTileSummary(wantIdx,wantCash)}`;
    log(`📨 <b>${from.name}</b> sends a trade offer to <b>${to.name}</b>.`,from,{tradeId:trade.id,kind:'open'});
    pushTradeActivity({tradeId:trade.id,kind:'open',text:`${from.name} → ${to.name}`,summary});
  }
  markTurnEngagement();
  renderAll();
  if(to.bot)scheduleBotTradeResponse(trade);
  else openTradeDetail(trade.id,'incoming');
}
function acceptIncomingTrade(){
  const trade=getOpenTrade(viewingTradeId);
  if(!trade||trade.status!=='pending')return;
  const to=S.players[trade.toId];
  if(to.bot)return;
  renderTradeReview(trade,'accepted');
  finalizeOpenTrade(trade);
  renderAll();
  setTimeout(closeTradeReview,1200);
}
function rejectIncomingTrade(){
  const trade=getOpenTrade(viewingTradeId);
  if(!trade)return;
  const from=S.players[trade.fromId],to=S.players[trade.toId];
  if(to.bot)return;
  trade.status='declined';
  trade.awaitingId=null;
  trade.history.unshift({round:trade.round,by:to.id,text:`${to.name} declined`});
  log(`<b>${to.name}</b> declines the trade offer from <b>${from.name}</b>.`,to);
  renderAll();
  if(isMultiplayerActive())broadcastStateNow();
  openTradeDetail(trade.id,'declined');
}
function dismissDeclinedTrade(){
  closeTradeReview();
}
function closeTradeViewModal(){
  closeTradeReview();
}
/* ============================================================
   ESTATE MANAGEMENT
============================================================ */
function openManage(p){
  const list=$('manageList');list.innerHTML='';
  const props=ownedBy(p);
  if(!props.length)list.innerHTML='<p style="color:var(--muted);font-size:13.5px">You don\'t own anything yet. Land on a city and buy it!</p>';
  props.sort((x,y)=>x.idx-y.idx).forEach(t=>{
    const row=document.createElement('div');row.className='mprop';
    const full=t.type==='city'&&ownsGroup(p,t.group);
    let status=t.mortgaged?'Mortgaged':(t.houses===5?'Hotel':(t.houses?`${t.houses} house${t.houses>1?'s':''}`:'No buildings'));
    if(t.type!=='city')status=t.mortgaged?'Mortgaged':'—';
    row.innerHTML=`<span class="fi" style="font-size:22px;width:28px;text-align:center">${tileIcon(t)}</span>
      <div class="mi"><div class="n">${t.name}</div><div class="s">${status}${full?' · full country':''}</div></div><div class="acts"></div>`;
    const acts=row.querySelector('.acts');
    const add=(label,fn,dis,gold)=>{const b=document.createElement('button');b.className='sbtn'+(gold?' gold':'');b.textContent=label;b.disabled=!!dis;
      b.onclick=()=>{fn();openManage(p);renderAll();};acts.appendChild(b);};
    if(t.type==='city'&&full&&!t.mortgaged&&groupTiles(t.group).every(x=>!x.mortgaged)){
      if(t.houses<5)add(`Build ${fmt(t.houseCost)}`,()=>{if(p.cash>=t.houseCost){p.cash-=t.houseCost;t.houses++;log(`🏗️ <b>${p.name}</b> builds ${t.houses===5?'a hotel':'a house'} in ${t.name}.`,p);}},p.cash<t.houseCost,true);
      if(t.houses>0)add(`Sell +${fmt(Math.floor(t.houseCost/2))}`,()=>{t.houses--;p.cash+=Math.floor(t.houseCost/2);log(`<b>${p.name}</b> sells a building in ${t.name}.`,p);});
    }
    const groupBuilt=t.type==='city'&&groupTiles(t.group).some(x=>x.houses>0);
    if(S.rules.mortgage&&!t.mortgaged&&t.houses===0&&!groupBuilt)
      add(`Mortgage +${fmt(Math.floor(t.price/2))}`,()=>{t.mortgaged=true;p.cash+=Math.floor(t.price/2);log(`<b>${p.name}</b> mortgages ${t.name}.`,p);});
    if(t.mortgaged){const cost=Math.ceil(t.price/2*1.1);
      add(`Unmortgage ${fmt(cost)}`,()=>{if(p.cash>=cost){p.cash-=cost;t.mortgaged=false;log(`<b>${p.name}</b> lifts the mortgage on ${t.name}.`,p);}},p.cash<cost);}
    list.appendChild(row);
  });
  $('manageModal').classList.remove('hidden');
}

/* ============================================================
   BOTS
============================================================ */
function botTurn(){
  const p=S.cur;if(S.over||p.dead||!p.bot)return;
  if(isMpGame()&&!isMpHost())return;
  if(p.jail){
    if(p.goojf>0){useJailCard(p);return;}
    if(p.cash>=400){payJailFine(p);return;}
    jailRoll(p);return;
  }
  msg(`${p.name} is rolling…`);doRoll(p);
}
function botWantsBuy(p,t){
  const completes=t.type==='city'&&groupTiles(t.group).every(x=>x.owner===p.id||x===t);
  return p.cash>=t.price+(completes?0:S.rules.diff.buyBuf);
}
function botBuild(p){
  let guard=40;
  while(guard--){
    const b=ownedBy(p).filter(t=>t.type==='city'&&ownsGroup(p,t.group)&&!t.mortgaged&&t.houses<5&&groupTiles(t.group).every(x=>!x.mortgaged))
      .sort((x,y)=>x.houses-y.houses||x.houseCost-y.houseCost)[0];
    if(b&&p.cash>=b.houseCost+S.rules.diff.buildRes){
      p.cash-=b.houseCost;b.houses++;
      log(`🏗️ <b>${p.name}</b> builds ${b.houses===5?'a hotel':'a house'} in ${b.name}.`,p);
    }else break;
  }
  if(S.rules.mortgage)ownedBy(p).filter(t=>t.mortgaged).forEach(t=>{
    const cost=Math.ceil(t.price/2*1.1);
    if(p.cash>cost+500){p.cash-=cost;t.mortgaged=false;log(`<b>${p.name}</b> lifts the mortgage on ${t.name}.`,p);}
  });
  renderAll();
}

/* ============================================================
   DOCK WIRES
============================================================ */
bindDockWires();
$('tradeBtn')?.addEventListener('click',openTrade);
$('tradeCancel')?.addEventListener('click',()=>$('tradeModal')?.classList.add('hidden'));
$('tradePropose')?.addEventListener('click',proposeTrade);
$('tradeAccept')?.addEventListener('click',acceptIncomingTrade);
$('tradeReject')?.addEventListener('click',rejectIncomingTrade);
$('tradeNegotiate')?.addEventListener('click',()=>negotiateTrade(viewingTradeId));
$('tradeReviewNegotiate')?.addEventListener('click',()=>negotiateTrade(viewingTradeId));
$('tradeReviewClose')?.addEventListener('click',closeTradeViewModal);
$('tradeReviewModal').onclick=e=>{if(e.target.id==='tradeReviewModal')closeTradeViewModal();};
$('aucMinBtn')?.addEventListener('click',()=>{
  $('aucModal')?.classList.add('overlay--minimized');
  updateAucRestoreBar();
});
$('aucRestoreBar')?.addEventListener('click',()=>{
  $('aucModal')?.classList.remove('overlay--minimized');
  $('aucRestoreBar')?.classList.add('hidden');
});
$('tradeReviewMinBtn')?.addEventListener('click',()=>{
  $('tradeReviewModal')?.classList.add('overlay--minimized');
  updateTradeRestoreBar();
});
$('tradeRestoreBar')?.addEventListener('click',()=>{
  $('tradeReviewModal')?.classList.remove('overlay--minimized');
  $('tradeRestoreBar')?.classList.add('hidden');
});
$('propModal').onclick=e=>{if(e.target.id==='propModal')closePropDetail();};
$('manageClose')?.addEventListener('click',()=>$('manageModal')?.classList.add('hidden'));
function afterAction(toAuction,tile){
  if(isMpGame()&&!isMyTurn())return;
  const again=S.pendingDouble;S.pendingDouble=false;
  if(toAuction)startAuction(tile,{playerId:S.cur?.id,again});
  else finishMovePhase(S.cur,again);
}

/* ============================================================
   PREVIEW — skip lobby to test property modal (?preview=prop)
============================================================ */
function runPropPreview(){
  const params=new URLSearchParams(location.search);
  const mode=params.get('preview');
  if(!mode||!['prop','build','mortgage','all','board'].includes(mode))return;
  const openModal=params.get('open')!=='0';

  const per=+(params.get('per')||12);
  S.rules={
    per,title:'Buildup.io',diff:DIFF.classic,
    cash:2000,salary:300,double:true,vacation:true,auction:true,trades:true,
    noJailRent:true,mortgage:true,doubles:true,
  };
  S.players=[{
    id:0,name:'You',bot:false,emoji:'🚂',color:'#E0524A',
    cash:+(params.get('cash')??5000),pos:0,jail:false,jailTurns:0,goojf:0,dead:false,
  }];
  S.turn=0;S.phase='end';S.over=false;S.pot=0;S.doubles=0;
  S.fortune=shuffle(FORTUNE);S.treasury=shuffle(TREASURY);

  initBoard(per);

  const human=S.players[0];
  const cityGroups=[...new Set(TILES.filter(t=>t.type==='city').map(t=>t.group))];
  const ownGroup=(g,{houses=0,mortgaged=false,allMortgaged=false}={})=>{
    const tiles=groupTiles(g);
    tiles.forEach(t=>{t.owner=human.id;t.houses=0;t.mortgaged=false;});
    if(tiles[0])tiles[0].houses=houses;
    if(allMortgaged)tiles.forEach(t=>{t.mortgaged=true;});
    else if(mortgaged&&tiles[0])tiles[0].mortgaged=true;
    return tiles[0];
  };

  let focus=null;
  if(mode==='mortgage'){
    focus=ownGroup(cityGroups[0],{allMortgaged:true});
  }else if(mode==='board'&&cityGroups.length>=2){
    const houses=Math.min(5,Math.max(0,+(params.get('houses')??3)));
    focus=ownGroup(cityGroups[0],{houses});
    ownGroup(cityGroups[1],{allMortgaged:true});
    if(cityGroups[2])ownGroup(cityGroups[2],{});
  }else if(mode==='all'&&cityGroups.length>1){
    const houses=Math.min(5,Math.max(0,+(params.get('houses')??2)));
    focus=ownGroup(cityGroups[0],{houses});
    ownGroup(cityGroups[1],{});
  }else{
    const houses=Math.min(5,Math.max(0,+(params.get('houses')??2)));
    focus=ownGroup(cityGroups[0],{houses});
  }
  if(!focus)return;

  $('lobby')?.remove();
  $('hud').classList.remove('hidden');
  document.body.classList.add('preview-mode');
  renderAll();

  const hints={
    mortgage:'Preview — mortgaged tiles are dimmed with your color + stamp. Click a tile to unmortgage.',
    board:'Preview — green houses on one set, mortgaged stamp on another. Click tiles to manage.',
    all:'Preview — built city opens in modal. Bare owned cities show Mortgage.',
    prop:'Preview — Upgrade & Destroy. Also try ?preview=board or ?preview=mortgage for tile looks.',
    build:'Preview — Upgrade & Destroy. Also try ?preview=board or ?preview=mortgage for tile looks.',
  };
  msg(hints[mode]||hints.prop);
  if(openModal)requestAnimationFrame(()=>openPropDetail(focus.idx));
}
runPropPreview();
