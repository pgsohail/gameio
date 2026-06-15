import { flagModalHTML } from '../lib/flags.js';
import { brandModalHTML } from '../lib/brandLogos.js';
import { crestFor, modalSubtitle, tileTheme } from './specialArt.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

export function buildPropSheet(t, groups, bodyHTML, actionsHTML, opts = {}) {
  const th = tileTheme(t);
  const crest = crestFor(t);
  const isCity = t.type === 'city';
  const mortgaged = !!t.mortgaged;
  const ownerStyle = opts.ownerColor ? ` style="--prop-own:${opts.ownerColor}"` : '';
  const extraCls = `${opts.ownerColor ? ' prop-sheet--owned' : ''}${mortgaged ? ' prop-sheet--mortgaged' : ''}`;

  let heroInner = '';
  if (isCity) {
    heroInner = `
      <div class="ps-hero__flag">${flagModalHTML(t.iso)}</div>
      <div class="ps-hero__orb"></div>`;
  } else if (t.type === 'utl' && t.utlKey) {
    heroInner = `
      <div class="ps-hero__brand">${brandModalHTML(t.utlKey)}</div>
      <div class="ps-hero__orb"></div>
      <div class="ps-hero__spark ps-hero__spark--a"></div>
      <div class="ps-hero__spark ps-hero__spark--b"></div>`;
  } else if (crest) {
    heroInner = `
      <div class="ps-hero__crest">${crest}</div>
      <div class="ps-hero__orb"></div>
      <div class="ps-hero__spark ps-hero__spark--a"></div>
      <div class="ps-hero__spark ps-hero__spark--b"></div>`;
  } else {
    heroInner = `<div class="ps-hero__emoji">${t.flag || '🌐'}</div>`;
  }

  return `<div class="prop-sheet prop-sheet--${th.kind} prop-sheet--${th.key}${extraCls}"${ownerStyle}>
    <div class="ps-hero">
      ${heroInner}
      ${th.tag ? `<div class="ps-hero__tag">${esc(th.tag)}</div>` : ''}
      <h2 class="ps-hero__title">${esc(t.name)}</h2>
      <p class="ps-hero__sub">${esc(modalSubtitle(t, groups))}</p>
    </div>
    <div class="ps-body">${bodyHTML}</div>
    ${actionsHTML}
  </div>`;
}

export function propBodyHTML(rentHTML, ownerHTML, footHTML) {
  return `${rentHTML ? `<div class="prop-rents">${rentHTML}</div>` : ''}${ownerHTML}${footHTML}`;
}
