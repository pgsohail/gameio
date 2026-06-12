/** Shared SVG crests + theme keys for tiles and property modals. */

export function tileTheme(t) {
  if (t.type === 'air') {
    const v = t.airVariant ?? 0;
    return { kind: 'air', variant: v, key: `air-${v}`, tag: 'Airport', accent: '#5BA8FF' };
  }
  if (t.type === 'utl') {
    const k = t.utlKey || 'electric';
    const tags = { electric: 'Power Co.', water: 'Water Co.', gas: 'Gas Co.', fiber: 'Fiber Net' };
    const accents = { electric: '#FFD54F', water: '#64B5F6', gas: '#FF8A50', fiber: '#4DD0B8' };
    return { kind: 'utl', variant: k, key: `utl-${k}`, tag: tags[k] || 'Utility', accent: accents[k] || '#90CAF9' };
  }
  if (t.type === 'tax') {
    const premium = /premium/i.test(t.name);
    return {
      kind: 'tax',
      variant: premium ? 'premium' : 'earnings',
      key: premium ? 'tax-premium' : 'tax-earnings',
      tag: premium ? 'Luxury Tax' : 'Income Tax',
      accent: premium ? '#FFB74D' : '#EF5350',
    };
  }
  if (t.type === 'fortune') return { kind: 'surprise', variant: 0, key: 'surprise', tag: 'Surprise', accent: '#F48FB1' };
  if (t.type === 'treasury') return { kind: 'treasury', variant: 0, key: 'treasury', tag: 'Treasure', accent: '#FFD54F' };
  if (t.type === 'city') return { kind: 'city', variant: t.iso, key: 'city', tag: null, accent: null };
  if (t.type === 'go') return { kind: 'corner', variant: 'go', key: 'corner-go', tag: 'Collect $', accent: '#FFD54F' };
  if (t.type === 'jail') return { kind: 'corner', variant: 'jail', key: 'corner-jail', tag: 'Prison', accent: '#90CAF9' };
  if (t.type === 'fair') return { kind: 'corner', variant: 'fair', key: 'corner-fair', tag: 'Vacation', accent: '#FFAB40' };
  if (t.type === 'gotojail') return { kind: 'corner', variant: 'gtj', key: 'corner-gtj', tag: 'Arrest', accent: '#FF5252' };
  return { kind: 'corner', variant: 0, key: 'corner', tag: null, accent: null };
}

/** Bright landmark palette for the four board corners. */
export function cornerMeta(t) {
  const map = {
    go: {
      key: 'go',
      tag: 'Collect $',
      hint: 'Salary on pass',
      bg1: '#00A86B',
      bg2: '#00E676',
      accent: '#FFD740',
      rim: '#FFF59D',
      icon: '#FFFFFF',
      glow: 'rgba(255,235,120,.55)',
    },
    jail: {
      key: 'jail',
      tag: 'Prison',
      hint: 'Just visiting',
      bg1: '#3D5AFE',
      bg2: '#536DFE',
      accent: '#82B1FF',
      rim: '#B388FF',
      icon: '#FFFFFF',
      glow: 'rgba(130,177,255,.45)',
    },
    fair: {
      key: 'fair',
      tag: 'Vacation',
      hint: 'Free parking',
      bg1: '#2E7D6E',
      bg2: '#3FA896',
      accent: '#F5E6C8',
      rim: '#C8EDE0',
      icon: '#FFFFFF',
      glow: 'rgba(168,230,207,.35)',
    },
    gotojail: {
      key: 'gtj',
      tag: 'Arrest',
      hint: 'Sent to prison',
      bg1: '#FF1744',
      bg2: '#FF5252',
      accent: '#FFEA00',
      rim: '#FF8A80',
      icon: '#FFFFFF',
      glow: 'rgba(255,82,82,.5)',
    },
  };
  return map[t.type] || map.go;
}

export const CRESTS = {
  'air-0': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <path fill="currentColor" d="M62 36L18 24l5 12-10 4 3 9 12-3 9 16 5-5-9-15 12-3-3-9z"/>
    <ellipse cx="40" cy="62" rx="28" ry="4" fill="currentColor" opacity=".18"/>
    <path stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M14 58h52" opacity=".35"/>
  </svg>`,
  'air-1': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <path fill="currentColor" d="M58 38H34L22 52l-6-6 9-9-12-4 4-11 18 5 20-11 5 6z"/>
    <circle cx="40" cy="62" r="5" fill="currentColor" opacity=".3"/>
    <path stroke="currentColor" stroke-width="2.5" d="M12 62h56" opacity=".3"/>
  </svg>`,
  'air-2': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <circle cx="40" cy="36" r="22" fill="none" stroke="currentColor" stroke-width="3"/>
    <path fill="currentColor" d="M18 36h44M40 14v44"/>
    <path fill="currentColor" d="M40 14c-5 7-5 30 0 38 5-8 5-31 0-38z" opacity=".85"/>
    <path stroke="currentColor" stroke-width="2.5" d="M10 62h60" opacity=".3"/>
  </svg>`,
  'air-3': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <path fill="currentColor" d="M38 12h4v14h-4zm-12 18v28h24V30zm-6 28h36v8H20z"/>
    <rect x="34" y="36" width="12" height="10" rx="2" fill="currentColor" opacity=".45"/>
    <path stroke="currentColor" stroke-width="2.5" d="M10 64h60" opacity=".3"/>
  </svg>`,
  'utl-electric': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <path fill="currentColor" d="M46 10L24 46h18l-8 24 26-34H48z"/>
    <circle cx="40" cy="40" r="30" fill="none" stroke="currentColor" stroke-width="2" opacity=".2"/>
  </svg>`,
  'utl-water': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <path fill="currentColor" d="M40 12C28 32 16 42 16 54a24 24 0 1048 0c0-12-12-22-24-42z"/>
    <path fill="none" stroke="currentColor" stroke-width="2.5" opacity=".35" d="M28 52c4 6 10 6 12 0s8-6 12 0"/>
  </svg>`,
  'utl-gas': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <path fill="currentColor" d="M40 14c-11 13-20 22-20 36a20 20 0 1040 0c0-14-9-23-20-36z"/>
    <path fill="currentColor" d="M40 30l8 14h-6l3 12-14-20h6z" opacity=".9"/>
  </svg>`,
  'utl-fiber': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <circle cx="40" cy="40" r="10" fill="currentColor"/>
    <path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
      d="M40 16v10M40 54v10M16 40h10M54 40h10M24 24l7 7M49 49l7 7M56 24l-7 7M31 49l-7 7"/>
    <circle cx="40" cy="40" r="26" fill="none" stroke="currentColor" stroke-width="2" opacity=".25"/>
  </svg>`,
  'tax-earnings': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <rect x="20" y="14" width="40" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="3"/>
    <path stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M30 30h20M30 42h14M30 54h10"/>
    <circle cx="54" cy="54" r="10" fill="currentColor" opacity=".85"/>
    <path stroke="#1a1020" stroke-width="2.5" stroke-linecap="round" d="M50 54h8M54 50v8"/>
  </svg>`,
  'tax-premium': `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <path fill="currentColor" d="M40 12l7 16 17 2-12 12 3 17-15-8-15 8 3-17-12-12 17-2z"/>
    <circle cx="40" cy="40" r="26" fill="none" stroke="currentColor" stroke-width="2" opacity=".22"/>
  </svg>`,
  surprise: `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <rect x="12" y="18" width="56" height="44" rx="10" fill="none" stroke="currentColor" stroke-width="3"/>
    <text x="40" y="52" text-anchor="middle" fill="currentColor" font-size="34" font-weight="900" font-family="system-ui,sans-serif">?</text>
  </svg>`,
  treasury: `<svg viewBox="0 0 80 80" class="art-svg" aria-hidden="true">
    <path fill="currentColor" d="M18 38h44v26a6 6 0 01-6 6H24a6 6 0 01-6-6V38z"/>
    <path fill="none" stroke="currentColor" stroke-width="3" d="M18 38l10-16h24l10 16"/>
    <circle cx="32" cy="52" r="5" fill="currentColor" opacity=".8"/>
    <circle cx="48" cy="52" r="5" fill="currentColor" opacity=".8"/>
    <rect x="36" y="44" width="8" height="6" rx="1" fill="currentColor" opacity=".55"/>
  </svg>`,
  'corner-go': `<svg viewBox="0 0 80 80" class="art-svg corner-svg" aria-hidden="true">
    <circle cx="40" cy="40" r="28" fill="currentColor" opacity=".18"/>
    <circle cx="40" cy="40" r="28" fill="none" stroke="currentColor" stroke-width="2.5" opacity=".55"/>
    <path fill="currentColor" d="M40 18l4.5 12.5H58l-10 8 4 12.5L40 44.5 28 51l4-12.5-10-8h13.5z"/>
    <circle cx="40" cy="58" r="9" fill="currentColor"/>
    <text x="40" y="62" text-anchor="middle" fill="#1B5E20" font-size="11" font-weight="900" font-family="system-ui,sans-serif">$</text>
  </svg>`,
  'corner-jail': `<svg viewBox="0 0 80 80" class="art-svg corner-svg" aria-hidden="true">
    <rect x="16" y="18" width="48" height="44" rx="6" fill="currentColor" opacity=".22"/>
    <rect x="16" y="18" width="48" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="3"/>
    <path stroke="currentColor" stroke-width="4" stroke-linecap="round" d="M28 18v44M40 18v44M52 18v44"/>
    <circle cx="40" cy="34" r="8" fill="none" stroke="currentColor" stroke-width="3"/>
    <path fill="currentColor" d="M22 56h36v8H22z" opacity=".9"/>
    <rect x="34" y="46" width="12" height="10" rx="2" fill="currentColor" opacity=".65"/>
  </svg>`,
  'corner-fair': `<svg viewBox="0 0 80 80" class="art-svg corner-svg" aria-hidden="true">
    <circle cx="58" cy="20" r="13" fill="currentColor"/>
    <path stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M58 33v6"/>
    <path fill="currentColor" d="M14 56c12-14 28-20 44-16 10 3 17 8 22 14-12 6-24 9-36 8-12-1-22-4-30-6z"/>
    <path fill="currentColor" opacity=".5" d="M30 42c0-8 5-14 12-14s12 6 12 14"/>
    <path stroke="currentColor" stroke-width="3.5" stroke-linecap="round" d="M48 34l8-14M56 34l-8-14"/>
    <path stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M16 56h48"/>
  </svg>`,
  'corner-gtj': `<svg viewBox="0 0 80 80" class="art-svg corner-svg" aria-hidden="true">
    <circle cx="40" cy="40" r="30" fill="currentColor" opacity=".15"/>
    <path fill="currentColor" d="M40 14l6 18h19l-15 11 6 19-16-12-16 12 6-19-15-11h19z" opacity=".35"/>
    <circle cx="40" cy="36" r="14" fill="none" stroke="currentColor" stroke-width="3.5"/>
    <path fill="currentColor" d="M28 54h24l-6-14H34z"/>
    <rect x="33" y="28" width="14" height="16" rx="3" fill="currentColor"/>
    <path stroke="currentColor" stroke-width="3.5" stroke-linecap="round" d="M30 24h20"/>
    <circle cx="40" cy="36" r="4" fill="#B71C1C"/>
  </svg>`,
};

export function crestFor(t) {
  const th = tileTheme(t);
  if (th.kind === 'city') return null;
  return CRESTS[th.key] || null;
}

export function modalSubtitle(t, groups) {
  if (t.type === 'city') return groups[t.group]?.name || 'Premium City';
  if (t.type === 'air') return 'International Airport · Rent from all travelers';
  if (t.type === 'utl') return 'Utility Company · Rent scales with dice roll';
  if (t.type === 'tax') return 'Mandatory Levy · Pay when you land here';
  if (t.type === 'fortune') return 'Draw a card · Fortune or misfortune awaits';
  if (t.type === 'treasury') return 'Community Chest · Collect a bonus';
  return 'Board Space';
}
