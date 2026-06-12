const API_BASE = import.meta.env.VITE_API_URL || '';

function wsUrl() {
  const base = import.meta.env.VITE_API_URL || `${location.protocol}//${location.host}`;
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  return url.toString();
}

export function getToken() {
  return localStorage.getItem('ma_token');
}

export function setToken(token) {
  if (token) localStorage.setItem('ma_token', token);
  else localStorage.removeItem('ma_token');
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const authApi = {
  guest: (name, remember = true) => api('/api/auth/guest', {
    method: 'POST', body: JSON.stringify({ name, remember }),
  }),
  google: (credential, remember = true) => api('/api/auth/google', {
    method: 'POST', body: JSON.stringify({ credential, remember }),
  }),
  me: () => api('/api/auth/me'),
  updateProfile: body => api('/api/profile', { method: 'PATCH', body: JSON.stringify(body) }),
};

export const storeApi = {
  catalog: () => api('/api/store'),
};

export const roomsApi = {
  list: () => api('/api/rooms'),
  get: id => api(`/api/rooms/${id}`),
  create: body => api('/api/rooms', { method: 'POST', body: JSON.stringify(body) }),
  join: (id, body = {}) => api(`/api/rooms/${id}/join`, { method: 'POST', body: JSON.stringify(body) }),
  launch: id => api(`/api/rooms/${id}/launch`, { method: 'POST' }),
  leave: id => api(`/api/rooms/${id}/leave`, { method: 'POST' }),
  markAbsent: id => api(`/api/rooms/${id}/absent`, { method: 'POST' }),
  rejoin: id => api(`/api/rooms/${id}/rejoin`, { method: 'POST' }),
  update: (id, body) => api(`/api/rooms/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
};

export function markAbsentKeepalive(id) {
  const token = getToken();
  if (!token || !id) return;
  fetch(`${API_BASE}/api/rooms/${id}/absent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    keepalive: true,
  }).catch(() => {});
}

export function connectRoomSocket(onMessage) {
  const token = getToken();
  if (!token) return null;
  const ws = new WebSocket(`${wsUrl()}?token=${encodeURIComponent(token)}`);
  ws.onmessage = ev => {
    try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ }
  };
  ws.onerror = () => { /* reconnect handled by caller */ };
  return ws;
}

export function subscribeWhenOpen(ws, data) {
  if (!ws) return;
  const send = () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };
  if (ws.readyState === WebSocket.OPEN) send();
  else ws.addEventListener('open', send, { once: true });
}

export function roomLink(id) {
  const url = new URL(location.href);
  url.searchParams.set('room', id);
  return url.toString();
}
