import { authApi, getToken, setToken } from './api.js';

const AUTH_KEY = 'ma_user_v1';
const REMEMBER_KEY = 'ma_remember_v1';
const listeners = new Set();
let user = null;
let gsiReady = false;
let gsiError = null;

const GOOGLE_G_SVG = `<svg class="auth-gbtn__icon" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.56 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

export function getUser() {
  return user;
}

export function getProfile() {
  return user?.profile || null;
}

export function getRemember() {
  return localStorage.getItem(REMEMBER_KEY) !== '0';
}

export function setRemember(on) {
  localStorage.setItem(REMEMBER_KEY, on ? '1' : '0');
}

export function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (raw) user = JSON.parse(raw);
  } catch {
    user = null;
  }
  return user;
}

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach(fn => fn(user));
}

function persist(session) {
  user = { ...session.user, profile: session.profile || user?.profile || null };
  setToken(session.token);
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  emit();
  return user;
}

export async function restoreSession() {
  loadAuth();
  const token = getToken();
  if (!token) return null;
  try {
    const data = await authApi.me();
    user = { ...data.user, profile: data.profile };
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    emit();
    return user;
  } catch {
    signOut();
    return null;
  }
}

export async function continueAsGuest(displayName) {
  const remember = getRemember();
  try {
    const session = await authApi.guest(displayName || 'Guest', remember);
    return persist(session);
  } catch {
    const name = String(displayName || 'Guest').trim().slice(0, 18) || 'Guest';
    user = {
      id: `guest_local_${Date.now()}`,
      mode: 'guest',
      name,
      photo: null,
      profile: {
        id: `guest_local_${Date.now()}`,
        name,
        photo: null,
        mode: 'guest',
        coins: 0,
        karma: 0,
        gamesPlayed: 0,
        gamesWon: 0,
        joinedAt: Date.now(),
        inventory: [],
      },
    };
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    emit();
    return user;
  }
}

export async function signInWithGoogleCredential(credential) {
  const session = await authApi.google(credential, getRemember());
  return persist(session);
}

export async function updateDisplayName(name) {
  try {
    const data = await authApi.updateProfile({ name });
    user = { ...data.user, profile: data.profile };
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    emit();
    return user;
  } catch {
    if (user) {
      user.name = name;
      if (user.profile) user.profile.name = name;
      localStorage.setItem(AUTH_KEY, JSON.stringify(user));
      emit();
    }
    return user;
  }
}

export function signOut() {
  user = null;
  setToken(null);
  localStorage.removeItem(AUTH_KEY);
  if (window.google?.accounts?.id) {
    try { window.google.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
  }
  emit();
}

export function googleClientConfigured() {
  return !!String(import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();
}

export function getGoogleSignInError() {
  return gsiError;
}

function showGoogleHint(msg) {
  const el = document.getElementById('googleSignInHint');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}

function ensureCustomGoogleButton() {
  const btn = document.getElementById('googleSignInBtn');
  if (!btn || btn.dataset.ready) return btn;
  btn.dataset.ready = '1';
  btn.innerHTML = `${GOOGLE_G_SVG}<span>Continue with Google</span>`;
  btn.onclick = async () => {
    if (!googleClientConfigured()) {
      showGoogleHint('Add VITE_GOOGLE_CLIENT_ID to .env for Google sign-in.');
      return;
    }
    if (gsiReady && window.google?.accounts?.id) {
      window.google.accounts.id.prompt(n => {
        if (n.isNotDisplayed() || n.isSkippedMoment()) {
          const mount = document.getElementById('googleSignInMount');
          if (mount) mount.querySelector('div[role=button]')?.click();
          else showGoogleHint('Allow popups, or use the Google button below.');
        }
      });
      return;
    }
    showGoogleHint('Loading Google sign-in…');
  };
  return btn;
}

function mountGsiButton(clientId) {
  const mount = document.getElementById('googleSignInMount');
  const custom = document.getElementById('googleSignInBtn');
  if (!mount || !custom || !window.google?.accounts?.id) return;

  window.google.accounts.id.initialize({
    client_id: clientId,
    ux_mode: 'popup',
    callback: async (res) => {
      try {
        gsiError = null;
        document.getElementById('googleSignInHint')?.classList.add('hidden');
        await signInWithGoogleCredential(res.credential);
      } catch (e) {
        gsiError = e.message || 'Google sign-in failed';
        const msg = String(gsiError).toLowerCase().includes('invalid')
          ? 'Google client not found. In Cloud Console use a Web application OAuth client and add this site under Authorized JavaScript origins.'
          : gsiError;
        showGoogleHint(msg);
      }
    },
    auto_select: getRemember(),
    cancel_on_tap_outside: true,
    itp_support: true,
  });

  gsiReady = true;
  mount.innerHTML = '';
  mount.classList.remove('hidden');
  custom.classList.add('hidden');

  window.google.accounts.id.renderButton(mount, {
    type: 'standard',
    theme: 'outline',
    size: 'medium',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'left',
    width: 220,
  });
}

export function initGoogleSignIn() {
  ensureCustomGoogleButton();

  const clientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) {
    showGoogleHint('Google sign-in: set VITE_GOOGLE_CLIENT_ID in .env');
    return;
  }

  const boot = () => {
    try {
      mountGsiButton(clientId);
      document.getElementById('googleSignInHint')?.classList.add('hidden');
    } catch (e) {
      gsiError = e.message;
      showGoogleHint('Could not load Google sign-in.');
    }
  };

  if (window.google?.accounts?.id) {
    boot();
    return;
  }

  if (document.querySelector('script[src*="accounts.google.com/gsi/client"]')) {
    const t = setInterval(() => {
      if (window.google?.accounts?.id) { clearInterval(t); boot(); }
    }, 200);
    return;
  }

  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  script.onload = boot;
  script.onerror = () => showGoogleHint('Could not load Google sign-in script.');
  document.head.appendChild(script);
}
