/** Brand logos + airplane watermarks for company/airport tiles. */

const BRANDS = {
  apple: {
    name: 'Apple',
    accent: '#A2AAAD',
    plate: 'linear-gradient(165deg,rgba(180,185,190,.5),rgba(80,85,90,.35))',
    src: '/brands/apple.svg',
  },
  google: {
    name: 'Google',
    accent: '#4285F4',
    plate: 'linear-gradient(165deg,rgba(66,133,244,.48),rgba(30,70,150,.32))',
    src: '/brands/google.svg',
  },
  meta: {
    name: 'Meta',
    accent: '#0668E1',
    plate: 'linear-gradient(165deg,rgba(6,104,225,.46),rgba(4,55,120,.32))',
    src: '/brands/meta.svg',
  },
  nvidia: {
    name: 'NVIDIA',
    accent: '#76B900',
    plate: 'linear-gradient(165deg,rgba(118,185,0,.46),rgba(50,90,0,.32))',
    src: '/brands/nvidia.svg',
  },
  tesla: {
    name: 'Tesla',
    accent: '#CC0000',
    plate: 'linear-gradient(165deg,rgba(204,0,0,.44),rgba(100,10,10,.3))',
    src: '/brands/tesla.svg',
  },
};

const AIRPLANE_SVGS = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"><path fill="#fff" d="M8 46h62l10-14 8 14h78l-8-12 22-10-22-10 8-12H88l-8 14-10-14H8l12 10-12 10z"/><ellipse cx="120" cy="78" rx="88" ry="7" fill="#fff" opacity=".28"/><path fill="#fff" opacity=".55" d="M108 34h24v8h-24z"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"><path fill="#fff" d="M220 42H118L92 18 74 28l14 14H18l10 14 58 6-10 24 16 10 24-38h90l-10-16z"/><path stroke="#fff" stroke-width="5" opacity=".25" d="M12 78h216"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"><path fill="#fff" d="M120 12c-34 28-54 48-54 72a54 54 0 10108 0c0-24-20-44-54-72z"/><path fill="#fff" opacity=".9" d="M120 34c-10 12-10 44 0 56 10-12 10-44 0-56z"/><circle cx="120" cy="52" r="6" fill="#fff" opacity=".5"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"><path fill="#fff" d="M112 10h16v24h-16zM76 38v36h88V38zm-18 36h124v14H58z"/><rect x="98" y="46" width="44" height="20" rx="4" fill="#fff" opacity=".5"/><path stroke="#fff" stroke-width="4" opacity=".3" d="M20 82h200"/></svg>`,
];

function svgDataUrl(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function brandFor(key) {
  return BRANDS[key] || null;
}

export function brandLogoSrc(key) {
  return BRANDS[key]?.src || null;
}

export function brandWatermarkStyle(key) {
  const src = brandLogoSrc(key);
  return src ? `url("${src}")` : 'none';
}

export function brandBadgeHTML(key, size = 36) {
  const b = BRANDS[key];
  if (!b) return `<span class="brand-badge brand-badge--fallback" aria-hidden="true">🏢</span>`;
  return `<span class="brand-badge" aria-hidden="true">
    <img class="brand-badge__img" src="${b.src}" width="${size}" height="${size}" alt="" draggable="false" decoding="async">
  </span>`;
}

export function brandModalHTML(key) {
  const b = BRANDS[key];
  if (!b) return `<span class="prop-brand-sm prop-brand-sm--fallback">🏢</span>`;
  return `<img class="prop-brand-sm" src="${b.src}" alt="" draggable="false">`;
}

export function brandInlineHTML(key, size = 22) {
  const src = brandLogoSrc(key);
  if (!src) return '🏢';
  return `<img class="brand-inline" src="${src}" width="${size}" height="${size}" alt="" draggable="false">`;
}

export function airplaneWatermarkSrc(variant = 0) {
  const svg = AIRPLANE_SVGS[((variant % AIRPLANE_SVGS.length) + AIRPLANE_SVGS.length) % AIRPLANE_SVGS.length];
  return svgDataUrl(svg);
}
