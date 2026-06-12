/** SVG circle flags — crisp at any size, fully fill the badge circle. */
const CDN = 'https://hatscripts.github.io/circle-flags/flags';

export function flagSrc(iso) {
  return iso ? `${CDN}/${iso.toLowerCase()}.svg` : null;
}

/** Rectangular flag for country bands on the board edge — crisp SVG 3:2. */
export function flagBandSrc(iso) {
  return iso ? `https://purecatamphetamine.github.io/country-flag-icons/3x2/${iso.toUpperCase()}.svg` : null;
}

export function flagBadgeHTML(iso, size = 40) {
  const src = flagSrc(iso);
  if (!src) return `<span class="flag-badge flag-badge--fallback" aria-hidden="true">🌐</span>`;
  return `<span class="flag-badge" aria-hidden="true">
    <img class="flag-svg" src="${src}" width="${size}" height="${size}" alt="" draggable="false" decoding="async">
  </span>`;
}

/** Small flag for tile strip or compact UI */
export function flagTileHTML(iso, size = 22) {
  const src = flagSrc(iso);
  if (!src) return `<span class="flag-tile flag-tile--fallback">🌐</span>`;
  return `<img class="flag-tile" src="${src}" width="${size}" height="${size}" alt="" draggable="false">`;
}

/** Property modal header flag */
export function flagModalHTML(iso) {
  const src = flagSrc(iso);
  if (!src) return `<span class="prop-flag-sm prop-flag-sm--fallback">🌐</span>`;
  return `<img class="prop-flag-sm" src="${src}" alt="" draggable="false">`;
}

export function flagInlineHTML(iso, size = 22) {
  const src = flagSrc(iso);
  if (!src) return '🌐';
  return `<img class="flag-inline" src="${src}" width="${size}" height="${size}" alt="" draggable="false">`;
}
