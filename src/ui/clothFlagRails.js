/** Waving cloth flag bands on the wooden rail (canvas + cylindrical warp). */

const DPR = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
const PAD = 12;
const ANIMATE = true;

let railShade = null;
let bands = [];
let animId = 0;

function getRailShade() {
  if (railShade) return railShade;
  const N = 64;
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = N;
  const x = c.getContext('2d');
  for (let i = 0; i < N; i++) {
    const n = ((i + 0.5) / N) * 2 - 1;
    const lit = Math.cos((n * Math.PI) / 2);
    const spec = Math.pow(Math.max(0, Math.cos((n - 0.12) * 2.6)), 24);
    const w = Math.min(0.5, spec * 0.45 + Math.max(0, lit - 0.85) * 0.6);
    const k = Math.min(0.85, (1 - lit) * 0.95);
    x.fillStyle = `rgba(255,255,255,${w})`;
    x.fillRect(0, i, 1, 1);
    x.fillStyle = `rgba(0,0,0,${k})`;
    x.fillRect(0, i, 1, 1);
  }
  railShade = c;
  return railShade;
}

function cylWarp(img, len, rail) {
  const H = Math.round(rail + 6);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(len));
  c.height = H;
  const x = c.getContext('2d');
  const imgW = img.naturalWidth;
  const imgH = img.naturalHeight;
  for (let dy = 0; dy < H; dy++) {
    const n = ((dy + 0.5) / H) * 2 - 1;
    const v = Math.asin(Math.max(-1, Math.min(1, n))) / Math.PI + 0.5;
    const sy = Math.min(imgH - 1, v * imgH);
    x.drawImage(img, 0, sy, imgW, Math.max(1, imgH / H), 0, dy, c.width, 1);
  }
  return c;
}

function flagCode(iso) {
  if (!iso) return null;
  const c = iso.toLowerCase();
  return c === 'uk' ? 'gb' : c;
}

function drawBand(b, t, rail) {
  const { ctx, side, len, phase } = b;
  const w = parseFloat(b.cv.style.width) || len;
  const h = parseFloat(b.cv.style.height) || rail + PAD * 2;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (side === 'left') {
    ctx.translate(rail + PAD * 2, 0);
    ctx.rotate(Math.PI / 2);
  }
  if (side === 'right') {
    ctx.translate(0, len);
    ctx.rotate(-Math.PI / 2);
  }

  const SLICE = 2;
  const OVER = 3;
  const H = rail + OVER * 2;
  const ROLL = 9;
  const shade = getRailShade();

  for (let x = 0; x < len; x += SLICE) {
    const u = x / 26;
    const w1 = Math.sin(u * 1.9 + t * 2.0 + phase) * 1.3;
    const w2 = Math.sin(u * 0.7 - t * 1.3 + phase * 1.7) * 0.9;
    const w3 = Math.sin(u * 4.3 + t * 3.1) * 0.5;
    const edge = Math.min(1, x / 28, (len - x) / 28);
    const dy = (w1 + w2 + w3) * edge;
    const slope =
      (Math.cos(u * 1.9 + t * 2.0 + phase) * 1.9 * 1.3 +
        Math.cos(u * 0.7 - t * 1.3 + phase * 1.7) * 0.7 * 0.9) *
      edge;
    const squash = 1 - Math.min(0.08, Math.abs(slope) * 0.02);
    const dh = H * squash;
    const top = PAD - OVER + dy + (H - dh) / 2;

    if (b.warped) {
      const sx = (x / len) * b.warped.width;
      const sw = (SLICE / len) * b.warped.width;
      ctx.drawImage(b.warped, sx, 0, sw, b.warped.height, x, top, SLICE, dh);
    } else {
      ctx.fillStyle = b.fallback || '#666';
      ctx.fillRect(x, top, SLICE, dh);
    }

    const l = Math.max(-0.35, Math.min(0.35, slope * 0.07));
    ctx.fillStyle = l > 0 ? `rgba(255,255,255,${l * 0.55})` : `rgba(0,0,0,${-l * 0.75})`;
    ctx.fillRect(x, top, SLICE, dh);
    ctx.drawImage(shade, 0, 0, 1, 64, x, top, SLICE, dh);

    const dEnd = Math.min(x, len - x - SLICE);
    if (dEnd < ROLL) {
      const k = 1 - dEnd / ROLL;
      ctx.fillStyle = `rgba(0,0,0,${0.55 * k * k})`;
      ctx.fillRect(x, top, SLICE, dh);
      if (dEnd > ROLL * 0.3 && dEnd < ROLL * 0.55) {
        ctx.fillStyle = 'rgba(255,255,255,.25)';
        ctx.fillRect(x, top, SLICE, dh);
      }
    }
  }
}

function loop(now) {
  const t = now / 1000;
  for (const b of bands) drawBand(b, t, b.rail);
  if (ANIMATE && bands.length) animId = requestAnimationFrame(loop);
}

export function stopClothFlags() {
  cancelAnimationFrame(animId);
  animId = 0;
  bands = [];
}

/**
 * @param {HTMLElement} layer  #countryLayer
 * @param {'top'|'bottom'|'left'|'right'} side
 * @param {number} fromPx  offset along the rail (from layer edge)
 * @param {number} lenPx   span along the rail
 * @param {string} iso     country iso
 * @param {string} [fallback] CSS color if image fails
 */
export function addClothBand(layer, side, fromPx, lenPx, iso, fallback = '#666', phase = 0) {
  const code = flagCode(iso);
  if (!code || lenPx < 4) return;

  const table = layer.closest('#table');
  const rail = parseFloat(getComputedStyle(table || layer).paddingTop) || 26;

  const horiz = side === 'top' || side === 'bottom';
  const len = Math.max(4, Math.round(lenPx));
  const w = horiz ? len : rail + PAD * 2;
  const h = horiz ? rail + PAD * 2 : len;

  const cv = document.createElement('canvas');
  cv.className = 'cloth-flag';
  cv.width = w * DPR;
  cv.height = h * DPR;
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;

  const layerW = layer.clientWidth;
  const layerH = layer.clientHeight;

  if (side === 'top') {
    cv.style.left = `${fromPx}px`;
    cv.style.top = `${-PAD}px`;
  } else if (side === 'bottom') {
    cv.style.left = `${fromPx}px`;
    cv.style.top = `${layerH - rail - PAD}px`;
  } else if (side === 'left') {
    cv.style.left = `${-PAD}px`;
    cv.style.top = `${fromPx}px`;
  } else {
    cv.style.left = `${layerW - rail - PAD}px`;
    cv.style.top = `${fromPx}px`;
  }

  layer.appendChild(cv);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = `https://flagcdn.com/w320/${code}.png`;

  const band = {
    cv,
    ctx: cv.getContext('2d'),
    img,
    side,
    len,
    rail,
    fallback,
    warped: null,
    phase: typeof phase === 'number' ? phase : 0,
  };

  img.onload = () => {
    band.warped = cylWarp(img, len, rail);
  };

  bands.push(band);
}

export function startClothFlags() {
  cancelAnimationFrame(animId);
  if (bands.length) animId = requestAnimationFrame(loop);
}
