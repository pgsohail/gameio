/** Board size presets — `per` = tiles per side; total tiles = per × 4 */
export const BOARD_PRESETS = {
  10: { name: 'Death Valley', tagline: 'Scorched desert showdown' },
  12: { name: 'Neon Harbor', tagline: 'Coastal city lights' },
  14: { name: 'Crystal Peaks', tagline: 'Alpine empire climb' },
  18: { name: 'Eclipse Bay', tagline: 'Maximum board chaos' },
};

export function boardName(per) {
  return BOARD_PRESETS[per]?.name || 'Custom';
}

export function boardTagline(per) {
  return BOARD_PRESETS[per]?.tagline || '';
}

export function boardTileCount(per) {
  return per * 4;
}
