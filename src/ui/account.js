import { $ } from '../lib/format.js';
import {
  getProfile, getUser, onAuthChange, signOut, updateDisplayName,
} from '../lib/auth.js';
import { storeApi } from '../lib/api.js';

let menuOpen = false;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function avatarHtml(u, size = 28) {
  if (!u) return '👤';
  if (u.photo) return `<img src="${esc(u.photo)}" alt="" width="${size}" height="${size}">`;
  return u.mode === 'google' ? 'G' : '👤';
}

function formatJoined(ts) {
  if (!ts) return 'Recently';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return 'Today';
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.floor(months / 12)} year${Math.floor(months / 12) === 1 ? '' : 's'} ago`;
}

function winRate(p) {
  if (!p?.gamesPlayed) return '0%';
  return `${Math.round((p.gamesWon / p.gamesPlayed) * 100)}%`;
}

export function renderHub() {
  const u = getUser();
  const p = getProfile();
  const signed = !!u;

  $('hubTop')?.classList.toggle('hub-top--signed', signed);

  const hubAv = $('hubAvatar');
  if (hubAv) hubAv.innerHTML = avatarHtml(u, 26);

  const coins = $('hubCoins');
  if (coins) coins.textContent = signed ? String(p?.coins ?? 0) : '—';

  const menuAv = $('hubMenuAvatar');
  if (menuAv) menuAv.innerHTML = avatarHtml(u, 40);

  const menuName = $('hubMenuName');
  if (menuName) menuName.textContent = u?.name || 'Guest';

  const menuKarma = $('hubMenuKarma');
  if (menuKarma) menuKarma.textContent = `${p?.karma ?? 0} Karma points`;

  $('hubMenuSigned')?.classList.toggle('hidden', !signed);
  $('hubMenuGuest')?.classList.toggle('hidden', signed);
}

export function renderProfilePage() {
  const u = getUser();
  const p = getProfile();
  if (!u) return;

  const av = $('profileAvatar');
  if (av) av.innerHTML = avatarHtml(u, 72);

  const nameEl = $('profileName');
  if (nameEl) nameEl.textContent = u.name;

  const editBtn = $('profileEditName');
  if (editBtn) editBtn.classList.toggle('hidden', u.mode === 'google');

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('profileKarma', `${p?.karma ?? 0} / 30`);
  set('profileWinRate', winRate(p));
  set('profileGamesPlayed', String(p?.gamesPlayed ?? 0));
  set('profileGamesWon', String(p?.gamesWon ?? 0));
  set('profileJoined', formatJoined(p?.joinedAt));
  set('profileCoins', String(p?.coins ?? 0));

  const emailEl = $('profileEmail');
  if (emailEl) {
    emailEl.textContent = u.email || (u.mode === 'guest' ? 'Guest account' : '');
    emailEl.classList.toggle('hidden', !emailEl.textContent);
  }
}

export async function renderStorePage() {
  const grid = $('storeGrid');
  const cats = $('storeCategories');
  if (!grid || !cats) return;

  const p = getProfile();
  const storeCoins = $('storeCoins');
  if (storeCoins) storeCoins.textContent = String(p?.coins ?? 0);

  try {
    const { categories } = await storeApi.catalog();
    cats.innerHTML = (categories || []).map((c, i) => `
      <button type="button" class="store-cat${i === 0 ? ' on' : ''}" data-cat="${esc(c.id)}">${esc(c.label)}</button>
    `).join('');
    cats.querySelectorAll('.store-cat').forEach(btn => {
      btn.onclick = () => {
        cats.querySelectorAll('.store-cat').forEach(x => x.classList.remove('on'));
        btn.classList.add('on');
      };
    });
  } catch {
    cats.innerHTML = '<span class="store-cat on">All</span>';
  }

  const placeholders = [
    { emoji: '🚂', name: 'Classic train', price: '—' },
    { emoji: '✈️', name: 'Jet token', price: '—' },
    { emoji: '🎩', name: 'Top hat', price: '—' },
    { emoji: '🃏', name: 'Power deck', price: '—' },
    { emoji: '🗺️', name: 'Grand map', price: '—' },
    { emoji: '⬆️', name: 'Rent boost', price: '—' },
  ];

  grid.innerHTML = `
    <div class="store-soon-banner">
      <span class="store-soon-banner__ico">✨</span>
      <div>
        <b>Store coming soon</b>
        <p>Coins, upgrades, and cosmetics are on the way.</p>
      </div>
    </div>
    ${placeholders.map(item => `
      <div class="store-item store-item--locked">
        <span class="store-item__emoji">${item.emoji}</span>
        <span class="store-item__name">${esc(item.name)}</span>
        <span class="store-item__price"><span class="store-item__coin">🪙</span> ${item.price}</span>
        <span class="store-item__soon">Soon</span>
      </div>
    `).join('')}
  `;
}

function closeMenu() {
  menuOpen = false;
  $('hubProfileMenu')?.classList.add('hidden');
  $('hubProfileBtn')?.setAttribute('aria-expanded', 'false');
}

function toggleMenu() {
  menuOpen = !menuOpen;
  $('hubProfileMenu')?.classList.toggle('hidden', !menuOpen);
  $('hubProfileBtn')?.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
}

export function initAccount({ navigate }) {
  renderHub();

  onAuthChange(() => {
    renderHub();
    renderProfilePage();
    closeMenu();
  });

  $('hubProfileBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    toggleMenu();
  });

  $('hubMenuProfile')?.addEventListener('click', () => {
    closeMenu();
    navigate('profile');
  });

  $('hubStoreBtn')?.addEventListener('click', () => {
    closeMenu();
    navigate('store');
    renderStorePage();
  });

  $('hubMenuStore')?.addEventListener('click', () => {
    closeMenu();
    navigate('store');
    renderStorePage();
  });

  $('hubMenuSignOut')?.addEventListener('click', () => {
    closeMenu();
    signOut();
    navigate('home');
  });

  $('profileBack')?.addEventListener('click', () => navigate('home'));
  $('storeBack')?.addEventListener('click', () => navigate('home'));

  $('profileEditName')?.addEventListener('click', async () => {
    const u = getUser();
    if (!u || u.mode === 'google') return;
    const name = prompt('Display name:', u.name);
    if (name === null) return;
    const trimmed = name.trim().slice(0, 18);
    if (!trimmed) return;
    await updateDisplayName(trimmed);
    renderProfilePage();
    renderHub();
  });

  document.addEventListener('click', () => {
    if (menuOpen) closeMenu();
  });
  $('hubProfileMenu')?.addEventListener('click', e => e.stopPropagation());
}
