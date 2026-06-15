/** Core countries — always on every board. */
export const CORE_COUNTRIES = [
  { name: 'United States', flag: '🇺🇸', iso: 'us', cities: ['New York', 'Los Angeles', 'Miami'] },
  { name: 'United Kingdom', flag: '🇬🇧', iso: 'gb', cities: ['London', 'Edinburgh', 'Manchester'] },
  { name: 'France', flag: '🇫🇷', iso: 'fr', cities: ['Paris', 'Nice', 'Lyon'] },
  { name: 'Germany', flag: '🇩🇪', iso: 'de', cities: ['Berlin', 'Munich', 'Hamburg'] },
  { name: 'Italy', flag: '🇮🇹', iso: 'it', cities: ['Rome', 'Milan', 'Venice'] },
  { name: 'Spain', flag: '🇪🇸', iso: 'es', cities: ['Barcelona', 'Madrid', 'Marbella'] },
  { name: 'Japan', flag: '🇯🇵', iso: 'jp', cities: ['Tokyo', 'Osaka', 'Kyoto'] },
  { name: 'China', flag: '🇨🇳', iso: 'cn', cities: ['Shanghai', 'Beijing', 'Hong Kong'] },
  { name: 'Pakistan', flag: '🇵🇰', iso: 'pk', cities: ['Karachi', 'Lahore', 'Islamabad'] },
];

/** Extra destinations — fill larger boards alongside the core nine. */
export const EXTRA_COUNTRIES = [
  { name: 'Australia', flag: '🇦🇺', iso: 'au', cities: ['Sydney', 'Melbourne', 'Brisbane'] },
  { name: 'UAE', flag: '🇦🇪', iso: 'ae', cities: ['Dubai', 'Abu Dhabi', 'Sharjah'] },
  { name: 'Turkey', flag: '🇹🇷', iso: 'tr', cities: ['Istanbul', 'Antalya', 'Cappadocia'] },
  { name: 'Thailand', flag: '🇹🇭', iso: 'th', cities: ['Bangkok', 'Phuket', 'Chiang Mai'] },
  { name: 'India', flag: '🇮🇳', iso: 'in', cities: ['Mumbai', 'Delhi', 'Goa'] },
  { name: 'Brazil', flag: '🇧🇷', iso: 'br', cities: ['Rio de Janeiro', 'São Paulo', 'Salvador'] },
  { name: 'Canada', flag: '🇨🇦', iso: 'ca', cities: ['Toronto', 'Vancouver', 'Montreal'] },
  { name: 'Mexico', flag: '🇲🇽', iso: 'mx', cities: ['Cancún', 'Mexico City', 'Tulum'] },
  { name: 'South Korea', flag: '🇰🇷', iso: 'kr', cities: ['Seoul', 'Busan', 'Jeju'] },
  { name: 'Netherlands', flag: '🇳🇱', iso: 'nl', cities: ['Amsterdam', 'Rotterdam', 'Utrecht'] },
  { name: 'Switzerland', flag: '🇨🇭', iso: 'ch', cities: ['Zurich', 'Geneva', 'Lucerne'] },
  { name: 'Greece', flag: '🇬🇷', iso: 'gr', cities: ['Athens', 'Santorini', 'Mykonos'] },
  { name: 'Portugal', flag: '🇵🇹', iso: 'pt', cities: ['Lisbon', 'Porto', 'Faro'] },
  { name: 'Singapore', flag: '🇸🇬', iso: 'sg', cities: ['Singapore', 'Sentosa', 'Marina Bay'] },
  { name: 'Egypt', flag: '🇪🇬', iso: 'eg', cities: ['Cairo', 'Luxor', 'Sharm El Sheikh'] },
];

/** All countries for lookups — core first, then extras. */
export const COUNTRIES = [...CORE_COUNTRIES, ...EXTRA_COUNTRIES];

/** Pick countries for a board: always all core, then extras as needed. */
export function countriesForBoard(numGroups) {
  const pool = [...CORE_COUNTRIES];
  let i = 0;
  while (pool.length < numGroups) {
    pool.push(EXTRA_COUNTRIES[i % EXTRA_COUNTRIES.length]);
    i += 1;
  }
  return pool.slice(0, numGroups);
}

export const AIRPORTS = [
  'JFK Intl', 'Heathrow', 'Charles de Gaulle', 'Frankfurt Intl',
  'Haneda', 'Beijing Capital', 'Dubai Intl', 'Singapore Changi',
  'Sydney Kingsford', 'Istanbul Airport', 'Toronto Pearson', 'São Paulo GRU',
  'Amsterdam Schiphol', 'Bangkok Suvarnabhumi', 'Cairo Intl', 'Zurich Airport',
];

export const UTILITIES = [
  { name: 'Apple Inc.', flag: '🍎', key: 'apple' },
  { name: 'Alphabet (Google)', flag: '🔍', key: 'google' },
  { name: 'Meta Platforms', flag: '♾️', key: 'meta' },
  { name: 'NVIDIA Corp.', flag: '💚', key: 'nvidia' },
  { name: 'Tesla Inc.', flag: '⚡', key: 'tesla' },
];

export const GROUP_PALETTE = [
  '#C62828', '#1E56B0', '#5E35B1', '#2E7D32', '#00838F',
  '#D84315', '#AD1457', '#F4511E', '#3949AB', '#6D4C41',
  '#7CB342', '#5C6BC0', '#00897B', '#8E24AA', '#C9A227',
  '#0E7C7B', '#B5651D', '#C2185B', '#8A6F4D', '#1E56B0',
  '#00695C', '#5D4037', '#283593', '#558B2F', '#AD1457',
];
