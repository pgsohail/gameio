let audioCtx = null;

export function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

/** Bright cash-register "ting" when a property is purchased. */
export function playPurchaseTing() {
  try {
    const ctx = getAudio();
    const at = ctx.currentTime;

    const playTone = (freq, start, dur, vol, type = 'sine') => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(vol, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + dur + 0.02);
    };

    playTone(1568, at, 0.28, 0.18);
    playTone(2093, at + 0.04, 0.32, 0.12);
    playTone(2637, at + 0.07, 0.22, 0.06);
  } catch {
    /* audio blocked */
  }
}

/** Short handshake chime when a trade completes. */
export function playTradeSuccess() {
  try {
    const ctx = getAudio();
    const at = ctx.currentTime;
    const note = (freq, start, dur, vol, type = 'sine') => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(vol, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + dur + 0.02);
    };
    note(523, at, 0.14, 0.1);
    note(659, at + 0.05, 0.16, 0.11);
    note(784, at + 0.1, 0.22, 0.09);
    note(988, at + 0.14, 0.28, 0.07);
  } catch {
    /* audio blocked */
  }
}

/** Triumphant fanfare when a traveler owns a full country set. */
export function playCountryMonopoly() {
  try {
    const ctx = getAudio();
    const at = ctx.currentTime;
    const fan = (freq, start, dur, vol) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(freq, start);
      o.frequency.linearRampToValueAtTime(freq * 1.08, start + dur * 0.35);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(vol, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + dur + 0.03);
    };
    fan(392, at, 0.22, 0.14);
    fan(494, at + 0.08, 0.24, 0.12);
    fan(587, at + 0.16, 0.28, 0.11);
    fan(784, at + 0.24, 0.36, 0.09);
  } catch {
    /* audio blocked */
  }
}

/** Metallic jail-bar clang when a traveler is sent to prison. */
export function playJailBars() {
  try {
    const ctx = getAudio();
    const at = ctx.currentTime;

    const clang = (freq, start, dur, vol) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(freq, start);
      o.frequency.exponentialRampToValueAtTime(freq * 0.6, start + dur);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(vol, start + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + dur + 0.03);
    };

    clang(220, at, 0.18, 0.22);
    clang(165, at + 0.07, 0.22, 0.18);
    clang(196, at + 0.14, 0.2, 0.14);
    clang(130, at + 0.22, 0.28, 0.12);
  } catch {
    /* audio blocked */
  }
}
