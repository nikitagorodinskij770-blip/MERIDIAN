/* MERIDIAN — сессия пользователя поверх Supabase Auth.

   Кабинет, балансы и операции читаются прямо из базы: доступ ограничивает
   Row Level Security, поэтому промежуточный сервер здесь не нужен и лишь
   добавил бы точку отказа. Денежные операции идут через RPC-функции —
   единственный путь изменить баланс. */

import * as sb from '../api/supabase.js';

const bus = new EventTarget();
export function on(evt, fn) {
  bus.addEventListener(evt, fn);
  return () => bus.removeEventListener(evt, fn);
}
function emit(evt, detail) { bus.dispatchEvent(new CustomEvent(evt, { detail })); }

/* ── Состояние ────────────────────────────────────────────────────────── */

const state = {
  ready: false,      // проверка сессии завершена — до неё роутер ждёт
  user: null,        // профиль из public.profiles
  auth: null,        // учётная запись из auth.users
  balances: [],
  portfolioUsd: 0,
  counts: {},
  limits: {},
  unread: 0,
  online: true,
};

export function get() { return state; }
export function isReady() { return state.ready; }
export function isSignedIn() { return !!state.user; }
export function isStaff() { return ['admin', 'support'].includes(state.user?.role); }
export function unread() { return state.unread; }

/* ── Восстановление ───────────────────────────────────────────────────── */

export async function restore() {
  try {
    // Справочник активов нужен для пересчёта минимальных единиц в человеческие
    const assets = await sb.select('assets', { columns: 'id,scale,display_dec,name,kind' });
    sb.cacheScales(assets);
    state.assets = assets;
    state.online = true;
  } catch {
    state.online = false;
  }

  if (!sb.isSignedIn()) {
    state.ready = true;
    emit('change');
    return false;
  }

  try {
    await refresh();
    state.ready = true;
    emit('change');
    return true;
  } catch (e) {
    // Токен просрочен или отозван — тихо забываем
    await sb.signOut();
    state.user = null;
    state.ready = true;
    emit('change');
    return false;
  }
}

/** Перечитывает профиль, балансы и счётчики. */
export async function refresh() {
  if (!sb.isSignedIn()) return null;

  const [profile, balances, summary, prices] = await Promise.all([
    sb.select('profiles', { columns: '*', single: true }),
    sb.select('v_user_balances', { columns: 'asset_id,available,locked,total' }),
    sb.select('v_user_summary', { columns: '*', single: true }),
    sb.select('asset_prices', { columns: 'asset_id,last_price_usd' }),
  ]);

  if (!profile) throw new sb.SupabaseError('NO_PROFILE', 'профиль недоступен', 403);

  const px = Object.fromEntries(prices.map(p => [p.asset_id, Number(p.last_price_usd)]));

  state.auth = sb.currentUser();
  state.user = profile;
  state.balances = balances.map(b => ({
    asset: b.asset_id,
    available: sb.toNumber(b.asset_id, b.available),
    locked: sb.toNumber(b.asset_id, b.locked),
    availableMinor: b.available,
  }));
  state.portfolioUsd = state.balances.reduce(
    (s, b) => s + b.available * (px[b.asset] || 0), 0);
  state.counts = summary || {};
  state.unread = summary?.unread_notifications || 0;

  try {
    state.limits = await sb.select('user_limits', { columns: '*', single: true }) || {};
  } catch { state.limits = {}; }

  emit('change');
  return state;
}

/* ── Вход и регистрация ───────────────────────────────────────────────── */

export async function signIn(email, password) {
  const d = await sb.signIn(email, password);
  await refresh();
  await recordLogin('login');
  emit('signin', d);
  return d;
}

export async function signUp({ email, password, name, country }) {
  const d = await sb.signUp({ email, password, name, country });

  // Подтверждение почты отключено, поэтому токен приходит сразу.
  // Если его нет — почта всё же требует подтверждения, сообщаем честно.
  if (!d.access_token) {
    return { ...d, needsConfirmation: true };
  }
  await refresh();
  await recordLogin('login');
  emit('signin', d);
  return d;
}

export async function signOut() {
  await sb.signOut();
  Object.assign(state, {
    user: null, auth: null, balances: [], portfolioUsd: 0, counts: {}, unread: 0, limits: {},
  });
  emit('change');
  emit('signout');
}

export async function resetPassword(email) { return sb.resetPassword(email); }
export async function updatePassword(pw) { return sb.updatePassword(pw); }

/* ── Устройства и журнал входов ───────────────────────────────────────── */

function parseUA() {
  const ua = navigator.userAgent || '';
  const low = ua.toLowerCase();
  const kind = /ipad|tablet/.test(low) ? 'tablet'
    : /mobi|iphone|android/.test(low) ? 'mobile' : 'desktop';
  const os = /windows nt 10/.test(low) ? 'Windows 10/11'
    : /windows/.test(low) ? 'Windows' : /mac os x/.test(low) ? 'macOS'
    : /iphone|ipad/.test(low) ? 'iOS' : /android/.test(low) ? 'Android'
    : /linux/.test(low) ? 'Linux' : 'неизвестно';
  const browser = /edg\//.test(low) ? 'Edge' : /opr\//.test(low) ? 'Opera'
    : /yabrowser/.test(low) ? 'Yandex' : /firefox\//.test(low) ? 'Firefox'
    : /chrome\//.test(low) ? 'Chrome' : /safari\//.test(low) ? 'Safari' : 'неизвестно';
  return { kind, os, browser, ua };
}

async function fingerprint(d) {
  const raw = `${d.kind}|${d.os}|${d.browser}|${screen.width}x${screen.height}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * Фиксирует вход. Новое устройство — повод для уведомления безопасности:
 * так клиент узнаёт о чужом доступе раньше, чем пропадут средства.
 */
export async function recordLogin(event = 'login') {
  if (!sb.isSignedIn()) return;
  const d = parseUA();
  const fp = await fingerprint(d);
  const uid = sb.currentUser()?.id;
  if (!uid) return;

  let isNew = false;
  try {
    const known = await sb.select('known_devices', {
      columns: 'id', filters: { fingerprint: `eq.${fp}` }, single: true,
    });
    if (known) {
      await sb.update('known_devices', { id: `eq.${known.id}` },
        { last_seen_at: new Date().toISOString() });
    } else if (event === 'login') {
      isNew = true;
      await sb.insert('known_devices', [{
        user_id: uid, fingerprint: fp,
        label: `${d.os} · ${d.browser}`,
        device_kind: d.kind, os: d.os, browser: d.browser,
      }], { returning: false });
    }

    await sb.insert('login_history', [{
      user_id: uid, event,
      device_kind: d.kind, os: d.os, browser: d.browser,
      user_agent: d.ua.slice(0, 300), is_new_device: isNew,
    }], { returning: false });
  } catch { /* журнал не критичен для входа */ }
}

/* ── Уведомления ──────────────────────────────────────────────────────── */

export async function loadNotifications(onlyUnread = false) {
  const filters = onlyUnread ? { read_at: 'is.null' } : {};
  const rows = await sb.select('notifications', {
    columns: '*', filters, order: 'created_at.desc', limit: 60,
  });
  state.unread = rows.filter(n => !n.read_at).length;
  emit('change');
  return rows;
}

export async function markRead(id = null) {
  const now = new Date().toISOString();
  if (id) await sb.update('notifications', { id: `eq.${id}` }, { read_at: now });
  else await sb.update('notifications', { read_at: 'is.null' }, { read_at: now });
  const left = await sb.select('notifications', {
    columns: 'id', filters: { read_at: 'is.null' },
  });
  state.unread = left.length;
  emit('change');
  return { unread: state.unread };
}

/* ── Балансы ──────────────────────────────────────────────────────────── */

export function balance(asset) {
  return state.balances.find(b => b.asset === asset)?.available || 0;
}
export function balanceList() { return state.balances; }

/* ── Синхронизация котировок ──────────────────────────────────────────── */

let priceTimer = null;

/**
 * Отдаёт базе последние котировки: у фронтенда уже есть живой поток с бирж,
 * поэтому серверу незачем открывать собственные соединения.
 */
export function startPriceSync(market, intervalMs = 60_000) {
  const push = async () => {
    if (!sb.isSignedIn() || document.hidden) return;
    const rows = (state.assets || [])
      .map(a => ({ asset_id: a.id, price: market.price(a.id), chg: market.change24(a.id) }))
      .filter(r => r.price > 0)
      .map(r => ({
        asset_id: r.asset_id,
        last_price_usd: r.price,
        change_24h: Number.isFinite(r.chg) ? r.chg : null,
        source: 'browser-feed',
        updated_at: new Date().toISOString(),
      }));
    if (!rows.length) return;
    try {
      await sb.insert('asset_prices', rows, { returning: false });
    } catch { /* не критично: база обойдётся прошлым снимком */ }
  };
  clearInterval(priceTimer);
  priceTimer = setInterval(push, intervalMs);
  setTimeout(push, 3000);
}

export default {
  get, isReady, isSignedIn, isStaff, unread, restore, refresh,
  signIn, signUp, signOut, resetPassword, updatePassword,
  balance, balanceList, loadNotifications, markRead,
  recordLogin, startPriceSync, on,
};
