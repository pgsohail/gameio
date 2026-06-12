/** Country flag cloth bands on the outer wooden rail + layout from city tiles. */

import { addClothBand, startClothFlags, stopClothFlags } from './clothFlagRails.js';

const SIDE_CW = ['bottom', 'left', 'top', 'right'];

/** One strip per board side — spans every city on that side. */
function countrySegments(cities) {
  const sorted = [...cities].sort((a, b) => a.idx - b.idx);
  const bySide = new Map();
  sorted.forEach((c) => {
    if (!bySide.has(c.side)) bySide.set(c.side, []);
    bySide.get(c.side).push(c);
  });
  const segs = [];
  const seen = new Set();
  sorted.forEach((c) => {
    if (seen.has(c.side)) return;
    seen.add(c.side);
    segs.push({ side: c.side, cities: bySide.get(c.side) });
  });
  return segs;
}

/** Pixel span of cities along the rail inside #countryLayer. */
function railSpan(run, layer) {
  const lr = layer.getBoundingClientRect();
  const rects = run.map((c) => c.el.getBoundingClientRect());
  const left = Math.min(...rects.map((r) => r.left)) - lr.left;
  const right = Math.max(...rects.map((r) => r.right)) - lr.left;
  const top = Math.min(...rects.map((r) => r.top)) - lr.top;
  const bottom = Math.max(...rects.map((r) => r.bottom)) - lr.top;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

export function renderCountryBrackets(tiles, groups) {
  const layer = document.getElementById('countryLayer');
  const board = document.getElementById('board');
  if (!layer || !board?.querySelector('.tile')) return;

  stopClothFlags();
  layer.replaceChildren();

  Object.keys(groups)
    .filter((g) => g.startsWith('g'))
    .sort((a, b) => +a.slice(1) - +b.slice(1))
    .forEach((gid) => {
      const group = groups[gid];
      const cities = tiles.filter((t) => t.type === 'city' && t.group === gid && t.el);
      if (!cities.length) return;

      const iso = group.iso;
      const fallback = group.color || '#666';

      countrySegments(cities).forEach((seg) => {
        const span = railSpan(seg.cities, layer);
        const horiz = seg.side === 'top' || seg.side === 'bottom';
        const from = horiz ? span.left : span.top;
        const len = horiz ? span.width : span.height;
        addClothBand(layer, seg.side, from, len, iso, fallback);
      });
    });

  startClothFlags();
}

let _railRaf = 0;

export function scheduleCountryBrackets(tiles, groups) {
  cancelAnimationFrame(_railRaf);
  _railRaf = requestAnimationFrame(() => {
    requestAnimationFrame(() => renderCountryBrackets(tiles, groups));
  });
}
