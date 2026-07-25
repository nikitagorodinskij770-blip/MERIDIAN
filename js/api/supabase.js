/* MERIDIAN — клиент Supabase.

   Написан вручную поверх fetch вместо supabase-js: библиотека тянется с CDN,
   а наша CSP запрещает сторонние источники скриптов. Нужен нам узкий срез —
   авторизация, чтение таблиц и вызов RPC, — и он умещается в один файл
   без цепочки зависимостей.

   В браузер уходит только anon-ключ. Это не упущение: доступ ограничивает
   Row Level Security на стороне базы, а не секретность ключа. Ключ говорит
   «я клиент этого проекта», а что именно клиенту видно — решает политика. */

const URL_BASE = 'https://elokoleohntufgrkyvxm.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVsb2tvbGVvaG50dWZncmt5dnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4NzYyMDMsImV4cCI6MjEwMDQ1MjIwM30.qrMQEeEpKcAXlRu0NWqj6JGocGf66kEEiMSVM40vLfU';

const SESSION_KEY = 'meridian.auth';

export class SupabaseError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/* ── Хранение сессии ──────────────────────────────────────────────────────
   localStorage, а не sessionStorage: у Supabase access-токен живёт час,
   а refresh-токен позволяет продлевать сессию. Терять вход при закрытии
   вкладки для торговой платформы неудобно, а refresh-токен отзывается
   на сервере при выходе. */

let session = null;

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    session = raw ? JSON.parse(raw) : null;
  } catch { session = null; }
  return session;
}

function saveSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* приватный режим — переживём без сохранения */ }
}

loadSession();

export function getSession() { return session; }
export function accessToken() { return session?.access_token || null; }
export function currentUser() { return session?.user || null; }
export function isSignedIn() { return !!session?.access_token; }

/* ── Базовый запрос ───────────────────────────────────────────────────── */

async function request(path, { method = 'GET', body, headers = {}, auth = true, raw = false } = {}) {
  const h = {
    apikey: ANON_KEY,
    'Content-Type': 'application/json',
    ...headers,
  };
  if (auth) h.Authorization = `Bearer ${accessToken() || ANON_KEY}`;

  let res;
  try {
    res = await fetch(URL_BASE + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    });
  } catch (e) {
    throw new SupabaseError('NETWORK', 'сервер недоступен', 0);
  }

  // Просроченный access-токен: обновляем и повторяем ровно один раз
  if (res.status === 401 && session?.refresh_token && auth && !path.startsWith('/auth/')) {
    const ok = await refreshSession();
    if (ok) return request(path, { method, body, headers, auth, raw });
  }

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok) {
    const msg = data?.message || data?.msg || data?.error_description || data?.error || res.statusText;
    const code = data?.error_code || data?.code || `HTTP_${res.status}`;
    throw new SupabaseError(code, msg, res.status);
  }
  return raw ? { data, res } : data;
}

/* ── Авторизация ──────────────────────────────────────────────────────── */

export async function signUp({ email, password, name, country }) {
  const d = await request('/auth/v1/signup', {
    method: 'POST', auth: false,
    body: { email, password, data: { display_name: name || '', country: country || null } },
  });
  // При отключённом подтверждении почты токен приходит сразу
  if (d.access_token) saveSession(d);
  return d;
}

export async function signIn(email, password) {
  const d = await request('/auth/v1/token?grant_type=password', {
    method: 'POST', auth: false, body: { email, password },
  });
  saveSession(d);
  return d;
}

export async function signOut() {
  try {
    if (accessToken()) await request('/auth/v1/logout', { method: 'POST' });
  } catch { /* сервер мог уже забыть сессию — локально всё равно выходим */ }
  saveSession(null);
}

/** Завершает все прочие сессии, кроме текущей (смена пароля, «выйти везде»). */
export async function signOutOthers() {
  return request('/auth/v1/logout?scope=others', { method: 'POST' });
}

export async function refreshSession() {
  if (!session?.refresh_token) return false;
  try {
    const d = await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', auth: false, body: { refresh_token: session.refresh_token },
    });
    saveSession(d);
    return true;
  } catch {
    saveSession(null);
    return false;
  }
}

export async function resetPassword(email) {
  return request('/auth/v1/recover', { method: 'POST', auth: false, body: { email } });
}

export async function updatePassword(newPassword) {
  const d = await request('/auth/v1/user', { method: 'PUT', body: { password: newPassword } });
  return d;
}

/* ── Чтение таблиц (PostgREST) ────────────────────────────────────────── */

/**
 * Выборка. Фильтры в синтаксисе PostgREST: { status: 'eq.active' }.
 * Политики RLS применяются автоматически — здесь нет и не должно быть
 * проверок «а этому пользователю можно?»: их делает база.
 */
export async function select(table, {
  columns = '*', filters = {}, order, limit, single = false,
} = {}) {
  const q = new URLSearchParams();
  q.set('select', columns);
  for (const [k, v] of Object.entries(filters)) q.set(k, v);
  if (order) q.set('order', order);
  if (limit) q.set('limit', String(limit));

  const rows = await request(`/rest/v1/${table}?${q}`);
  return single ? (Array.isArray(rows) ? rows[0] || null : rows) : rows;
}

export async function insert(table, rows, { returning = true } = {}) {
  return request(`/rest/v1/${table}`, {
    method: 'POST',
    headers: { Prefer: returning ? 'return=representation' : 'return=minimal' },
    body: rows,
  });
}

export async function update(table, filters, patch) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) q.set(k, v);
  return request(`/rest/v1/${table}?${q}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: patch,
  });
}

export async function remove(table, filters) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) q.set(k, v);
  return request(`/rest/v1/${table}?${q}`, { method: 'DELETE' });
}

/** Вызов функции базы. Все денежные операции идут только так. */
export async function rpc(fn, args = {}) {
  return request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
}

/* ── Работа с суммами ─────────────────────────────────────────────────── */

const scaleCache = new Map();

export function cacheScales(assets) {
  assets.forEach(a => scaleCache.set(a.id, a.scale));
}

export function scaleOf(asset) { return scaleCache.get(asset) ?? 8; }

/** «0.5» BTC → 50000000. Через строку, чтобы не поймать 0.1 + 0.2. */
export function toMinor(asset, human) {
  const scale = scaleOf(asset);
  const s = String(human).trim().replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return 0;
  const [int = '0', frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  return Number(BigInt(int || '0') * BigInt(10 ** scale) + BigInt(padded || '0'));
}

/** 50000000 → «0.5». Без научной записи. */
export function toHuman(asset, minor) {
  const scale = scaleOf(asset);
  const neg = minor < 0;
  const s = String(Math.abs(Math.trunc(minor))).padStart(scale + 1, '0');
  const int = s.slice(0, s.length - scale) || '0';
  const frac = scale ? s.slice(s.length - scale).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

export function toNumber(asset, minor) {
  return parseFloat(toHuman(asset, minor)) || 0;
}

export default {
  signUp, signIn, signOut, signOutOthers, refreshSession, resetPassword, updatePassword,
  getSession, accessToken, currentUser, isSignedIn,
  select, insert, update, remove, rpc,
  toMinor, toHuman, toNumber, scaleOf, cacheScales,
  SupabaseError, URL_BASE, ANON_KEY,
};
