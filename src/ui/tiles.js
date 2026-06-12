import { flagBadgeHTML, flagInlineHTML } from '../lib/flags.js';
import { fmt } from '../lib/format.js';
import { cornerMeta, crestFor, tileTheme } from './specialArt.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function nameLines(name) {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
  }
  if (name.length > 10) {
    const half = Math.ceil(name.length / 2);
    const split = name.lastIndexOf(' ', half);
    if (split > 3) return [name.slice(0, split), name.slice(split + 1)];
    return [name.slice(0, half), name.slice(half)];
  }
  return [name];
}

function engraveHTML(lines, extraClass = '') {
  const cls = `tile-engrave${extraClass ? ` ${extraClass}` : ''}`;
  return `<div class="${cls}">${lines.map((l) => `<span>${esc(l)}</span>`).join('')}</div>`;
}

function specialTileHTML(t, price) {
  const th = tileTheme(t);
  const crest = crestFor(t) || '';
  const lines = t.type === 'fortune' ? ['Surprise'] : t.type === 'treasury' ? ['Treasure'] : nameLines(t.name);
  const priceHTML = price != null ? `<span class="tile-prem__price">${price}</span>` : '';
  const accent = th.accent ? ` style="--prem-accent:${th.accent}"` : '';
  return `<div class="tile-card tile-prem tile-prem--${th.kind} tile-prem--${th.key}"${accent}>
    <div class="tile-prem__frame"></div>
    <div class="tile-prem__plate">
      <div class="tile-prem__ribbon">${th.tag}</div>
      <div class="tile-prem__crest">${crest}</div>
      ${engraveHTML(lines, 'tile-engrave--prem')}
      ${priceHTML}
    </div>
  </div>`;
}

export function buildTileParts(t) {
  if (t.type === 'city') {
    return {
      inner: `<div class="tile-card tile-card--city" data-build="0">
        <div class="tile-city-gap"></div>
        ${engraveHTML(nameLines(t.name), 'tile-engrave--city')}
        <div class="tile-estate tile-estate--empty" aria-hidden="true"><div class="estate-skyline"></div></div>
        <span class="tile-price">${fmt(t.price)}</span>
      </div>`,
      outer: flagBadgeHTML(t.iso, 36),
    };
  }
  if (t.type === 'air') {
    return { inner: specialTileHTML(t, fmt(t.price)), outer: '' };
  }
  if (t.type === 'utl') {
    return { inner: specialTileHTML(t, fmt(t.price)), outer: '' };
  }
  if (t.type === 'tax') {
    return { inner: specialTileHTML(t, fmt(t.amount)), outer: '' };
  }
  if (t.type === 'fortune' || t.type === 'treasury') {
    return { inner: specialTileHTML(t, null), outer: '' };
  }
  if (t.type === 'go' || t.type === 'jail' || t.type === 'fair' || t.type === 'gotojail') {
    return { inner: cornerTileHTML(t), outer: '' };
  }
  return {
    inner: `<div class="tile-card tile-card--corner">
      <span class="tile-icon" aria-hidden="true">${t.flag}</span>
      ${engraveHTML(nameLines(t.name), 'tile-engrave--corner')}
    </div>`,
    outer: '',
  };
}

function cornerTileHTML(t) {
  const m = cornerMeta(t);
  const crest = crestFor(t) || '';
  const body = t.type === 'fair'
    ? `<div class="corner-card__body corner-card__body--fair">
      <div class="corner-card__title"><span class="corner-name">${esc(t.name)}</span></div>
      <div class="corner-card__art">${crest}</div>
      <div class="corner-card__hint corner-card__hint--fair">${esc(m.hint)}</div>
    </div>`
    : `<div class="corner-card__body">
      <div class="corner-card__title"><span class="corner-name">${esc(t.name)}</span></div>
      <div class="corner-card__art">${crest}</div>
      <div class="corner-card__badge"><span>${esc(m.tag)}</span></div>
      <div class="corner-card__hint">${esc(m.hint)}</div>
    </div>`;
  return `<div class="corner-card corner-card--${m.key}" style="--cc-bg1:${m.bg1};--cc-bg2:${m.bg2};--cc-accent:${m.accent};--cc-rim:${m.rim};--cc-icon:${m.icon};--cc-glow:${m.glow}">
    <div class="corner-card__pattern" aria-hidden="true"></div>
    <div class="corner-card__shine" aria-hidden="true"></div>
    ${body}
    <div class="corner-card__rim" aria-hidden="true"></div>
  </div>`;
}

export function tileIcon(t) {
  if (t.type === 'air') return '✈️';
  if (t.type === 'utl') return t.flag || '⚡';
  if (t.iso) return flagInlineHTML(t.iso, 18);
  return t.flag || '🌐';
}
