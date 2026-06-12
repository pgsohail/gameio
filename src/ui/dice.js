/** Grand Tour 3D dice — ivory cubes on a green felt tray (reference-style). */

let audioCtx = null;

function audio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function noiseBurst(at, dur, freq, q, vol, type = 'bandpass') {
  const ctx = audio();
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(at);
}

function thud(at, vol) {
  noiseBurst(at, 0.07, 220, 1.2, vol);
  const ctx = audio();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(120, at);
  o.frequency.exponentialRampToValueAtTime(55, at + 0.08);
  g.gain.setValueAtTime(vol * 0.9, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.1);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + 0.12);
}

function clack(at, vol) {
  noiseBurst(at, 0.03, 2600 + Math.random() * 1200, 3, vol, 'highpass');
}

function rattle(at) {
  for (let i = 0; i < 5; i++) clack(at + i * 0.05 + Math.random() * 0.03, 0.05 + Math.random() * 0.05);
}

function playThrowSounds(delayS) {
  const t0 = audio().currentTime + delayS;
  rattle(t0);
  thud(t0 + 0.71, 0.5);
  clack(t0 + 0.72, 0.18);
  thud(t0 + 1.16, 0.3);
  clack(t0 + 1.17, 0.12);
  thud(t0 + 1.46, 0.16);
  if (Math.random() < 0.6) clack(t0 + 0.78 + Math.random() * 0.2, 0.22);
}

const FACE_UP = {
  1: [0, 0],
  2: [90, 0],
  3: [0, 90],
  4: [0, -90],
  5: [-90, 0],
  6: [0, 180],
};

const FACES = [1, 2, 3, 4, 5, 6].map((n) => `<div class="die-face die-f${n}"></div>`).join('');

function dieWrapHTML(id, leftPct) {
  return `<div class="die-wrap" id="${id}" style="left:${leftPct}%">
    <div class="die-shadow"></div>
    <div class="die die-cube">${FACES}</div>
  </div>`;
}

let wrapA;
let wrapB;
let rolling = false;

function rand(n) {
  return Math.floor(Math.random() * n);
}

function spins() {
  return 360 * (3 + rand(3));
}

export const DICE_ROLL_MS = 1950;

function rollDie(dieEl, wrapEl, value, delayMs, endX, endY) {
  const shadow = wrapEl.querySelector('.die-shadow');
  wrapEl.classList.remove('throwing');
  wrapEl.style.animation = 'none';
  if (shadow) shadow.style.animation = 'none';
  void wrapEl.offsetWidth;

  const startX = -(300 + rand(80));
  const startY = -(140 + rand(80));
  wrapEl.style.setProperty('--sx', `${startX}px`);
  wrapEl.style.setProperty('--sy', `${startY}px`);
  wrapEl.style.setProperty('--ex', `${endX}px`);
  wrapEl.style.setProperty('--ey', `${endY}px`);
  wrapEl.style.animationDelay = `${delayMs}ms`;
  if (shadow) shadow.style.animationDelay = `${delayMs}ms`;

  dieEl.style.transition = 'none';
  dieEl.style.transform =
    `translateZ(var(--die-half)) rotateZ(${rand(360)}deg) rotateX(${rand(360)}deg) rotateY(${rand(360)}deg)`;
  void dieEl.offsetWidth;

  dieEl.style.transition = '';
  dieEl.style.transitionDelay = `${delayMs}ms`;

  const [bx, by] = FACE_UP[value];
  const rx = bx + spins() * (Math.random() < 0.5 ? -1 : 1);
  const ry = by + spins() * (Math.random() < 0.5 ? -1 : 1);
  const yaw = rand(50) - 25 + 360 * (2 + rand(2)) * (Math.random() < 0.5 ? -1 : 1);

  dieEl.style.transform =
    `translateZ(var(--die-half)) rotateZ(${yaw}deg) rotateX(${rx}deg) rotateY(${ry}deg)`;
  wrapEl.classList.add('throwing');
  wrapEl.dataset.val = value;
}

function setDie(wrap, value) {
  const die = wrap?.querySelector('.die-cube');
  if (!die) return;
  const [bx, by] = FACE_UP[value];
  die.style.transition = 'none';
  die.style.transform = `translateZ(var(--die-half)) rotateX(${bx}deg) rotateY(${by}deg)`;
  wrap.dataset.val = value;
}

export const Dice3D = {
  init(el) {
    if (!el) return;
    el.innerHTML = `<div class="dice-stage">
      <div class="dice-tray">
        ${dieWrapHTML('dieWrapA', 38)}
        ${dieWrapHTML('dieWrapB', 62)}
      </div>
    </div>`;
    wrapA = el.querySelector('#dieWrapA');
    wrapB = el.querySelector('#dieWrapB');
    setDie(wrapA, 1);
    setDie(wrapB, 1);
  },

  setValues(a, b, spin) {
    if (spin) this.roll(a, b);
    else {
      setDie(wrapA, a);
      setDie(wrapB, b);
    }
  },

  roll(a, b) {
    if (rolling || !wrapA || !wrapB) return;
    rolling = true;

    const x1 = -(40 + rand(60));
    const y1 = rand(70) - 35;
    const x2 = 40 + rand(60);
    const y2 = rand(70) - 35;

    rollDie(wrapA.querySelector('.die-cube'), wrapA, a, 0, x1, y1);
    rollDie(wrapB.querySelector('.die-cube'), wrapB, b, 130, x2, y2);
    try {
      playThrowSounds(0);
      playThrowSounds(0.13);
    } catch {
      /* audio unavailable */
    }

    setTimeout(() => {
      rolling = false;
    }, DICE_ROLL_MS);
  },
};
