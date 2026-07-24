/* MERIDIAN — сессия пользователя поверх серверных аккаунтов.

   Заменяет прежнее локальное состояние: учётная запись, балансы, операции
   и история живут на сервере, здесь — только токен сессии и кэш последнего
   ответа, чтобы интерфейс не мигал между запросами.

   Токен хранится в sessionStorage, а не в localStorage: он умирает вместе
   с вкладкой, что сокращает окно для кражи через XSS и не оставляет доступ
   на общем компьютере. */

import { API, ApiError, setSessionToken, getSessionToken } from '../api/sign.js';

const TOKEN_KEY = 'meridian.session';

const bus = new EventTarget();
export function on(evt, fn) {
  bus.addEventListener(evt, fn);
  return () => bus.removeEventListener(evt, fn);
}
function emit(evt, detail) { bus.dispatchEvent(new CustomEvent(evt, { detail })); }

/* ── Состояние ────────────────────────────────────────────────────────── */

const state = {
  user: null,
  balances: [],
  portfolioUsd: 0,
  counts: {},
  limits: {},
  unread: 0,
  online: false,          // доступен ли бэкенд
  loading: false,
};

export function get() { return state; }
export function isSignedIn() { return !!state.user; }
export function isStaff() { return ['admin', 'support'].includes(state.user?.role); }
export function unread() { return state.unread; }

/* ── Восстановление сессии ────────────────────────────────────────────── */

export async function restore() {
  const saved = sessionStorage.getItem(TOKEN_KEY);
  if (saved) setSessionToken(saved);

  try {
    await API.get('/health');
    state.online = true;
  } catch {
    state.online = false;
    emit('change');
    return false;
  }

  if (!saved) { emit('change'); return false; }

  try {
    await refresh();
    return true;
  } catch (e) {
    // Токен просрочен или отозван — тихо забываем его
    if (e instanceof ApiError && [401, 403].includes(e.status)) signOutLocal();
    emit('change');
    return false;
  }
}

/** Перечитывает обзор кабинета: балансы, счётчики, лимиты. */
export async function refresh() {
  if (!getSessionToken()) return null;
  state.loading = true;
  try {
    const d = await API.get('/me/overview');
    state.user = d.user;
    state.balances = d.balances;
    state.portfolioUsd = d.portfolioUsd;
    state.counts = d.counts;
    state.limits = d.limits;
    state.unread = d.unread;
    state.online = true;
    return d;
  } finally {
    state.loading = false;
    emit('change');
  }
}

/* ── Вход и регистрация ───────────────────────────────────────────────── */

export async function signIn(email, password) {
  const d = await API.post('/auth/login', { email, password });
  setSessionToken(d.token);
  sessionStorage.setItem(TOKEN_KEY, d.token);
  await refresh();
  emit('signin', d);
  return d;
}

export async function signUp({ email, password, name, country }) {
  const d = await API.post('/auth/register', { email, password, name, country });
  setSessionToken(d.token);
  sessionStorage.setItem(TOKEN_KEY, d.token);
  await refresh();
  emit('signin', d);
  return d;
}

function signOutLocal() {
  setSessionToken(null);
  sessionStorage.removeItem(TOKEN_KEY);
  Object.assign(state, { user: null, balances: [], portfolioUsd: 0, counts: {}, unread: 0 });
}

export async function signOut() {
  try { await API.post('/auth/logout'); } catch { /* сервер мог уже забыть сессию */ }
  signOutLocal();
  emit('change');
  emit('signout');
}

/* ── Балансы ──────────────────────────────────────────────────────────── */

export function balance(asset) {
  const b = state.balances.find(x => x.asset === asset);
  return b ? parseFloat(b.available) : 0;
}

export function balanceList() { return state.balances; }

/* ── Уведомления ──────────────────────────────────────────────────────── */

export async function loadNotifications(onlyUnread = false) {
  const d = await API.get('/notifications' + (onlyUnread ? '?unread=1' : ''));
  state.unread = d.unread;
  emit('change');
  return d.items;
}

export async function markRead(id = null) {
  const d = await API.post('/notifications/read', id ? { id } : {});
  state.unread = d.unread;
  emit('change');
  return d;
}

/* ── Синхронизация котировок с сервером ───────────────────────────────── */

let priceTimer = null;

/**
 * Отдаёт серверу последние котировки: у фронтенда уже есть живой поток,
 * поэтому дублировать исходящие соединения с бэкенда незачем.
 * Сервер использует их для оценки портфеля и отчётов.
 */
export function startPriceSync(marketModule, intervalMs = 60_000) {
  const push = async () => {
    if (!state.online || !getSessionToken()) return;
    const prices = {};
    for (const b of state.balances) {
      const p = marketModule.price(b.asset);
      if (p > 0) prices[b.asset] = { price: p, change24: marketModule.change24(b.asset) };
    }
    if (!Object.keys(prices).length) return;
    try { await API.post('/prices', { prices, source: 'browser-feed' }); }
    catch { /* не критично: сервер обойдётся прошлым снимком */ }
  };
  clearInterval(priceTimer);
  priceTimer = setInterval(push, intervalMs);
  push();
}

export default {
  get, isSignedIn, isStaff, unread, restore, refresh,
  signIn, signUp, signOut, balance, balanceList,
  loadNotifications, markRead, startPriceSync, on,
};
