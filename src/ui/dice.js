/** Grand Tour 3D dice — ivory cubes on a green felt tray (reference-style). */

import { playDiceRoll } from '../lib/sounds.js';

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

  rollAt(a, b, startAt) {
    const delay = Math.max(0, (startAt || Date.now()) - Date.now());
    if (delay < 4) return this.roll(a, b);
    setTimeout(() => this.roll(a, b), delay);
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
    try { playDiceRoll(); } catch { /* audio unavailable */ }

    setTimeout(() => {
      rolling = false;
    }, DICE_ROLL_MS);
  },
};
