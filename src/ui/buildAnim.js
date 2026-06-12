import { $ } from '../lib/format.js';

const BUILD_MS = 480;
const HOTEL_MS = 620;
const DESTROY_MS = 360;

const BUILD_HEIGHTS = {
  1: [16],
  2: [14, 20],
  3: [12, 17, 22],
  4: [11, 14, 18, 24],
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function buildingHTML(h, i, level, animate, spawnIdx) {
  const anim = animate && i === spawnIdx ? ' eb--new' : '';
  return `<div class="eb${anim}" style="--eb-h:${h}">
    <span class="eb-roof"></span>
    <span class="eb-body"><span class="eb-win"></span></span>
  </div>`;
}

function skylineHTML(level, animate = false, spawnIdx = -1) {
  if (!level) return '';
  if (level === 5) {
    return `<div class="estate-hotel${animate ? ' estate-hotel--new' : ''}">
      <div class="eh-crown" aria-hidden="true">★</div>
      <div class="eh-tower"><span class="eh-win"></span><span class="eh-win"></span><span class="eh-win"></span></div>
      <div class="eh-lobby"></div>
      <div class="eh-sign">HOTEL</div>
    </div>`;
  }
  const heights = BUILD_HEIGHTS[level] || [];
  return `<div class="estate-row estate-row--${level}">
    ${heights.map((h, i) => buildingHTML(h, i, level, animate, spawnIdx)).join('')}
  </div>`;
}

export function applyTileBuildLevel(t) {
  if (!t.el || t.type !== 'city') return;
  const lvl = t.houses || 0;
  for (let i = 0; i <= 5; i++) t.el.classList.remove(`tile-lvl-${i}`);
  t.el.classList.remove('tile-lvl-max');
  t.el.classList.add(`tile-lvl-${lvl}`);
  if (lvl === 5) t.el.classList.add('tile-lvl-max');
  const card = t.el.querySelector('.tile-card--city');
  card?.setAttribute('data-build', String(lvl));
}

export function renderTileBuildings(t, opts = {}) {
  const estate = t.el?.querySelector('.tile-estate');
  if (!estate) return;

  const count = t.houses || 0;
  const animate = !!opts.animate;
  const spawnIdx = opts.spawnIdx ?? count - 1;
  const kind = count === 5 ? 'hotel' : 'row';

  applyTileBuildLevel(t);

  estate.classList.toggle('tile-estate--empty', count === 0);
  estate.classList.toggle('tile-estate--hotel', count === 5);
  estate.innerHTML = `<div class="estate-skyline">${skylineHTML(count, animate, kind === 'hotel' ? -1 : spawnIdx)}</div>`;
}

export function focusPropTile(t) {
  document.querySelectorAll('.tile-prop-focus').forEach((el) => el.classList.remove('tile-prop-focus'));
  t.el?.classList.add('tile-prop-focus');
  document.body.classList.add('prop-tile-focus');
}

export function clearPropTileFocus() {
  document.querySelectorAll('.tile-prop-focus').forEach((el) => el.classList.remove('tile-prop-focus'));
  document.body.classList.remove('prop-tile-focus');
}

let dockTileIdx = null;

export function positionPropDock(tileIdx, tiles) {
  const t = tiles[tileIdx];
  const modal = $('propModal');
  const panel = modal?.querySelector('.modal');
  if (!t?.el || !panel) return;

  dockTileIdx = tileIdx;
  const rect = t.el.getBoundingClientRect();
  const pw = Math.min(300, panel.offsetWidth || 300);
  const ph = panel.offsetHeight || 360;
  const gap = 14;
  const vw = innerWidth;
  const vh = innerHeight;
  const tcx = rect.left + rect.width / 2;
  const tcy = rect.top + rect.height / 2;

  let left;
  let top;

  if (rect.top > vh * 0.52) {
    top = Math.max(64, rect.top - ph - gap);
    left = clamp(tcx - pw / 2, 10, vw - pw - 10);
  } else if (rect.bottom < vh * 0.38) {
    top = Math.min(vh - ph - 10, rect.bottom + gap);
    left = clamp(tcx - pw / 2, 10, vw - pw - 10);
  } else if (rect.left > vw * 0.52) {
    left = Math.max(10, rect.left - pw - gap);
    top = clamp(tcy - ph / 2, 64, vh - ph - 10);
  } else {
    left = Math.min(vw - pw - 10, rect.right + gap);
    top = clamp(tcy - ph / 2, 64, vh - ph - 10);
  }

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

export function clearPropDock() {
  dockTileIdx = null;
  const panel = $('propModal')?.querySelector('.modal');
  if (panel) {
    panel.style.left = '';
    panel.style.top = '';
  }
}

export function bindPropDockResize(tiles) {
  if (window._propDockResizeBound) return;
  window._propDockResizeBound = true;
  window.addEventListener('resize', () => {
    const modal = $('propModal');
    if (dockTileIdx == null || modal?.classList.contains('hidden') || !modal.classList.contains('prop-modal--dock')) return;
    positionPropDock(dockTileIdx, tiles);
  });
}

export async function playBuildAnimation(t, prevHouses) {
  focusPropTile(t);
  t.el.classList.add('tile-lvl-up');
  renderTileBuildings(t, {
    animate: true,
    spawnIdx: t.houses - 1,
    kind: prevHouses === 4 && t.houses === 5 ? 'hotel' : 'row',
  });
  await sleep(prevHouses === 4 && t.houses === 5 ? HOTEL_MS : BUILD_MS);
  t.el.classList.remove('tile-lvl-up');
}

export function playPurchaseGlow(t, color) {
  if (!t?.el) return;
  const glow = color || '#F2C66B';
  t.el.style.setProperty('--purchase-glow', glow);
  t.el.style.setProperty('--own', glow);

  const flash = document.createElement('div');
  flash.className = 'purchase-flash';
  flash.setAttribute('aria-hidden', 'true');
  t.el.appendChild(flash);
  flash.addEventListener('animationend', () => flash.remove(), { once: true });

  t.el.classList.remove('tile-purchased');
  void t.el.offsetWidth;
  t.el.classList.add('tile-purchased');
  const onDone = () => t.el.classList.remove('tile-purchased');
  t.el.addEventListener('animationend', onDone, { once: true });
  setTimeout(onDone, 800);
}

const JAIL_ARREST_MS = 2400;

export function playJailArrest(t) {
  if (!t?.el) return;
  const el = t.el;
  el.classList.add('jail-arrest-active');

  const overlay = document.createElement('div');
  overlay.className = 'jail-arrest';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="jail-arrest__dim"></div>
    <div class="jail-arrest__bars"></div>
    <div class="jail-arrest__stamp">ARRESTED</div>`;
  el.appendChild(overlay);

  const done = () => {
    overlay.remove();
    el.classList.remove('jail-arrest-active');
  };
  overlay.addEventListener('animationend', (e) => {
    if (e.animationName === 'jailArrestOut') done();
  }, { once: true });
  setTimeout(done, JAIL_ARREST_MS + 120);
}

export function playTileCashFx(t, amount, opts = {}) {
  if (!t?.el || !amount) return;
  const delay = opts.delay ?? 0;
  const run = () => {
    const gain = amount > 0;
    const el = document.createElement('div');
    el.className = `tile-cash-fx${gain ? ' tile-cash-fx--gain' : ' tile-cash-fx--pay'}`;
    const sign = gain ? '+' : '−';
    el.innerHTML = `<span class="tile-cash-fx__pill">${sign}$${Math.abs(amount).toLocaleString()}</span>`;
    t.el.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 1300);
    if (!gain) {
      t.el.classList.remove('tile-rent-hit');
      void t.el.offsetWidth;
      t.el.classList.add('tile-rent-hit');
      setTimeout(() => t.el.classList.remove('tile-rent-hit'), 800);
    }
  };
  if (delay) setTimeout(run, delay);
  else run();
}

const TRADE_BURST_MS = 1600;
const MONO_BURST_MS = 2200;

export function playTradeSuccessAnim(from, to, offerIdx, wantIdx, tiles) {
  const hub = $('hubMid');
  if (hub) {
    const burst = document.createElement('div');
    burst.className = 'trade-deal-burst';
    burst.setAttribute('aria-hidden', 'true');
    burst.innerHTML = `
      <span class="trade-deal-burst__p" style="--pc:${from.color}">${from.emoji}</span>
      <span class="trade-deal-burst__ring"></span>
      <span class="trade-deal-burst__hand">🤝</span>
      <span class="trade-deal-burst__p" style="--pc:${to.color}">${to.emoji}</span>`;
    hub.appendChild(burst);
    burst.addEventListener('animationend', () => burst.remove(), { once: true });
    setTimeout(() => burst.remove(), TRADE_BURST_MS + 80);
  }

  const swapped = [...new Set([...offerIdx, ...wantIdx])];
  swapped.forEach((idx, i) => {
    setTimeout(() => {
      const t = tiles[idx];
      if (!t?.el) return;
      t.el.classList.remove('tile-trade-swap');
      void t.el.offsetWidth;
      t.el.classList.add('tile-trade-swap');
      const spark = document.createElement('div');
      spark.className = 'trade-tile-spark';
      spark.setAttribute('aria-hidden', 'true');
      t.el.appendChild(spark);
      const done = () => {
        spark.remove();
        t.el.classList.remove('tile-trade-swap');
      };
      spark.addEventListener('animationend', done, { once: true });
      t.el.addEventListener('animationend', (e) => {
        if (e.animationName === 'tradeTileSwap') done();
      }, { once: true });
      setTimeout(done, 1100);
    }, i * 90);
  });
}

export function playCountryMonopolyAnim(player, groupTiles, meta = {}) {
  const flag = meta.flag || '🌍';
  const name = meta.name || 'Country';
  groupTiles.forEach((t, i) => {
    setTimeout(() => {
      if (!t?.el) return;
      t.el.style.setProperty('--mono-color', player.color);
      t.el.classList.remove('tile-monopoly');
      void t.el.offsetWidth;
      t.el.classList.add('tile-monopoly');

      const burst = document.createElement('div');
      burst.className = 'mono-burst';
      burst.setAttribute('aria-hidden', 'true');
      burst.innerHTML = `
        <span class="mono-burst__shine"></span>
        <span class="mono-burst__flag">${flag}</span>
        <span class="mono-burst__crown">👑</span>
        <span class="mono-burst__label">${name}</span>`;
      t.el.appendChild(burst);

      const cleanup = () => {
        burst.remove();
        t.el.classList.remove('tile-monopoly');
      };
      burst.addEventListener('animationend', cleanup, { once: true });
      setTimeout(cleanup, MONO_BURST_MS + 60);
    }, i * 130);
  });
}

export function playDestroyAnimationSync(t, beforeHouses) {
  focusPropTile(t);
  t.el.classList.add('tile-lvl-down');
  const estate = t.el.querySelector('.tile-estate');
  const target = estate?.querySelector('.eb:last-child, .estate-hotel');
  target?.classList.add(beforeHouses === 5 ? 'estate-hotel--out' : 'eb--out');
  return sleep(DESTROY_MS).then(() => {
    t.el.classList.remove('tile-lvl-down');
  });
}
