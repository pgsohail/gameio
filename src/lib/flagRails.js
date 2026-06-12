/** CSS flag paints for wrapped wooden rails (stripes bend at corners). */

function tricolor(c1, c2, c3, rail) {
  const t3 = rail / 3;
  return {
    h: (outerIsTop) =>
      `linear-gradient(${outerIsTop ? 180 : 0}deg, ${c1} ${t3}px, ${c2} ${t3}px ${t3 * 2}px, ${c3} ${t3 * 2}px)`,
    v: (outerIsLeft) =>
      `linear-gradient(${outerIsLeft ? 90 : 270}deg, ${c1} ${t3}px, ${c2} ${t3}px ${t3 * 2}px, ${c3} ${t3 * 2}px)`,
    corner: (cx, cy) =>
      `radial-gradient(circle at ${cx} ${cy}, ${c3} 0 ${t3}px, ${c2} ${t3}px ${t3 * 2}px, ${c1} ${t3 * 2}px)`,
  };
}

function solidEmblem(base, dot, r) {
  return {
    h: () => base,
    v: () => base,
    emblem: (x) => `radial-gradient(circle at ${x} 50%, ${dot} 0 ${r}px, transparent ${r + 1}px)`,
    emblemV: (y) => `radial-gradient(circle at 50% ${y}, ${dot} 0 ${r}px, transparent ${r + 1}px)`,
    corner: (cx, cy) => `radial-gradient(circle at ${cx} ${cy}, ${base} 0 100%)`,
  };
}

const PAINTS = {
  it: (rail) => tricolor('#cf2734', '#f4f4f4', '#1c8a3c', rail),
  fr: (rail) => tricolor('#d6253a', '#f4f4f4', '#1c3e94', rail),
  de: (rail) => tricolor('#111111', '#d2202a', '#f4c20d', rail),
  es: (rail) => ({
    h: (o) =>
      `linear-gradient(${o ? 180 : 0}deg,#c8102e ${rail * 0.28}px,#f6c324 ${rail * 0.28}px ${rail * 0.72}px,#c8102e ${rail * 0.72}px)`,
    v: (o) =>
      `linear-gradient(${o ? 90 : 270}deg,#c8102e ${rail * 0.28}px,#f6c324 ${rail * 0.28}px ${rail * 0.72}px,#c8102e ${rail * 0.72}px)`,
    corner: (cx, cy) => `radial-gradient(circle at ${cx} ${cy}, #f6c324 0 55%, #c8102e 55%)`,
  }),
  jp: () => solidEmblem('#f3f3f3', '#d62029', 8),
  cn: () => solidEmblem('#d2202a', '#f6c324', 6),
  pk: () => ({
    h: () => '#0c6d44',
    v: () => '#0c6d44',
    emblem: (x) => `radial-gradient(circle at ${x} 50%, #fff 0 6px, transparent 7px)`,
    emblemV: (y) => `radial-gradient(circle at 50% ${y}, #fff 0 6px, transparent 7px)`,
    corner: (cx, cy) => `radial-gradient(circle at ${cx} ${cy}, #0c6d44 0 100%)`,
  }),
  gb: (rail) => ({
    h: () =>
      `linear-gradient(180deg, transparent ${rail * 0.4}px, #f4f4f4 ${rail * 0.4}px ${rail * 0.6}px, transparent ${rail * 0.6}px), linear-gradient(180deg, transparent ${rail * 0.46}px, #c8102e ${rail * 0.46}px ${rail * 0.54}px, transparent ${rail * 0.54}px), #1c3e94`,
    v: () => '#1c3e94',
    corner: (cx, cy) => `radial-gradient(circle at ${cx} ${cy}, #1c3e94 0 100%)`,
  }),
  us: (rail) => ({
    h: () =>
      `repeating-linear-gradient(180deg,#c8102e 0 ${rail / 7}px,#f4f4f4 ${rail / 7}px ${(rail * 2) / 7}px)`,
    v: () => '#1c3e94',
    corner: (cx, cy) => `radial-gradient(circle at ${cx} ${cy}, #c8102e 0 100%)`,
  }),
};

export function flagRailPaint(iso, railPx) {
  if (!iso) return null;
  const base = PAINTS[iso.toLowerCase()];
  return base ? base(railPx) : null;
}

export function railBackground(paint, kind, side, which, emblems) {
  if (!paint) return null;
  const horiz = kind === 'h';
  const outerFirst = side === 'top' || side === 'left';

  if (kind === 'corner') {
    const cx = which.includes('l') ? '100%' : '0%';
    const cy = which.includes('t') ? '100%' : '0%';
    return paint.corner ? paint.corner(cx, cy) : paint.h(true);
  }

  let bg = horiz ? paint.h(outerFirst) : paint.v(outerFirst);
  if (paint.emblem && emblems?.length) {
    const dots = emblems
      .map((p) => (horiz ? paint.emblem(p) : paint.emblemV?.(p) ?? paint.emblem(p)))
      .join(',');
    bg = `${dots},${bg}`;
  }
  return bg;
}

export function emblemPositions(cityCount, run, layer, horiz) {
  if (!run?.length) return ['50%'];
  const rects = run.map((c) => c.el.getBoundingClientRect());
  if (horiz) {
    const l = Math.min(...rects.map((r) => r.left));
    const w = Math.max(...rects.map((r) => r.right)) - l;
    if (w <= 0) return ['50%'];
    return rects.map((r) => `${(((r.left + r.right) / 2 - l) / w) * 100}%`);
  }
  const t = Math.min(...rects.map((r) => r.top));
  const h = Math.max(...rects.map((r) => r.bottom)) - t;
  if (h <= 0) return ['50%'];
  return rects.map((r) => `${(((r.top + r.bottom) / 2 - t) / h) * 100}%`);
}
