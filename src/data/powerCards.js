/** Rare reward cards — optional house rule; not in every game. */
export const POWER_CARDS = [
  {
    id: 'demolition',
    name: 'Demolition Crew',
    emoji: '💥',
    rarity: 'legendary',
    desc: 'Destroy one building on an opponent\'s city. Hotels downgrade to four houses.',
  },
  {
    id: 'rent_surge',
    name: 'Rent Surge',
    emoji: '⚡',
    rarity: 'epic',
    desc: 'Double all rent you collect until your next turn begins.',
  },
  {
    id: 'summon',
    name: 'Summoning Gate',
    emoji: '🌀',
    rarity: 'legendary',
    desc: 'Teleport instantly to any city on the board. You still resolve that tile.',
  },
  {
    id: 'phantom_build',
    name: 'Phantom Build',
    emoji: '✨',
    rarity: 'epic',
    desc: 'Place one free house on a city you own in a complete country set.',
  },
  {
    id: 'heist',
    name: 'Treasury Heist',
    emoji: '💎',
    rarity: 'rare',
    desc: 'Swipe $200 straight from the bank into your pocket.',
  },
  {
    id: 'shake_down',
    name: 'Market Shake-down',
    emoji: '📉',
    rarity: 'rare',
    desc: 'Every other traveler pays you $35.',
  },
  {
    id: 'tax_shield',
    name: 'Tax Shield',
    emoji: '🛡️',
    rarity: 'epic',
    desc: 'Ignore your next tax, fee, or card penalty paid to the bank.',
  },
  {
    id: 'vacation_pull',
    name: 'Vacation Pull',
    emoji: '🏖️',
    rarity: 'legendary',
    desc: 'Drain half the Vacation pot (or $100 minimum if the pot is empty).',
  },
];

export const POWER_DRAW_CHANCE = 0.14;

export function powerCardById(id) {
  return POWER_CARDS.find(c => c.id === id);
}

export function pickRandomPowerCard() {
  return POWER_CARDS[Math.floor(Math.random() * POWER_CARDS.length)];
}
