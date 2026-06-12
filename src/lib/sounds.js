let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { /* no audio */ }
  }
  return audioCtx;
}

function tone(freq, { duration = 0.12, type = 'sine', gain = 0.08, delay = 0 } = {}) {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playPlayerJoin() {
  tone(880, { duration: 0.14, gain: 0.07 });
  tone(1174, { duration: 0.18, gain: 0.05, delay: 0.07 });
}

export function playPlayerLeave() {
  tone(520, { duration: 0.2, type: 'triangle', gain: 0.06 });
  tone(380, { duration: 0.25, type: 'triangle', gain: 0.04, delay: 0.08 });
}

export function playBotJoin(stagger = 0) {
  tone(660, { duration: 0.1, type: 'square', gain: 0.04, delay: stagger });
  tone(990, { duration: 0.12, gain: 0.035, delay: stagger + 0.05 });
}
