/** Uniform integer in [1, faces] — crypto RNG when available, no modulo bias. */
export function rollDie(faces = 6) {
  if (faces < 1) return 1;
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const limit = 256 - (256 % faces);
    const buf = new Uint8Array(1);
    do {
      crypto.getRandomValues(buf);
    } while (buf[0] >= limit);
    return (buf[0] % faces) + 1;
  }
  return Math.floor(Math.random() * faces) + 1;
}

export function rollDicePair(faces = 6) {
  return [rollDie(faces), rollDie(faces)];
}
