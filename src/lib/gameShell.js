import { $ } from './format.js';

export function setGameBrandVisible(on) {
  const el = $('gameBrand');
  if (!el) return;
  el.classList.toggle('hidden', !on);
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
}
