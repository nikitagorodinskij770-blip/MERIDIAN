/* MERIDIAN — слой реальных рыночных данных.
   Публичные эндпоинты трёх бирж, без ключей и без отправки чего-либо о пользователе.
   Любой сбой откатывает актив на локальный симулятор — сайт не ломается офлайн. */

import { ASSETS } from '../seed.js';
import * as market from '../market.js';
import { limitedFetch, allGateStatus } from './ratelimit.js';

/* ── Карты символов ───────────────────────────────────────────────────── */

/** Наш тикер → символ спота Binance (котировка USDT). */
export const BINANCE = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', BNB: 'BNBUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT',
  ADA: 'ADAUSDT', DOGE: 'DOGEUSDT', TRX: 'TRXUSDT', AVAX: 'AVAXUSDT', DOT: 'DOTUSDT',
  LINK: 'LINKUSDT', LTC: 'LTCUSDT', BCH: 'BCHUSDT', ATOM: 'ATOMUSDT', NEAR: 'NEARUSDT',
  ARB: 'ARBUSDT', OP: 'OPUSDT', SUI: 'SUIUSDT', APT: 'APTUSDT',
  USDC: 'USDCUSDT', FDUSD: 'FDUSDUSDT',
  MATIC: 'POLUSDT',   // MATIC переименован в POL — торгуется под новым тикером
  EUR: 'EURUSDT',
};

/** Забираем из Coinbase (одним запросом курсов к USD). */
const COINBASE = ['EUR', 'GBP', 'RUB', 'AED', 'TRY', 'KZT', 'UAH', 'JPY', 'CNY', 'TON', 'DAI', 'USDT'];

/** Добираем из CoinGecko то, чего нет у первых двух. */
const GECKO = { XMR: 'monero' };

/** Остаются на симуляторе: биржевого источника без ключа не нашлось. */
export const SIMULATED = ['XAU', 'XAG'];

const REST = 'https://api.binance.com/api/v3';
const WS_BASE = 'wss://stream.binance.com:9443/stream?streams=';

/* ── Состояние слоя ───────────────────────────────────────────────────── */

const state = {
  mode: 'live',            // 'live' | 'sandbox'
  connected: false,
  usdtUsd: 1,              // курс USDT→USD, чтобы приводить котировки Binance к USD
  lastSnapshot: 0,
  lastTick: 0,
  providers: {},           // имя → 'ok' | 'fail' | 'off'
  liveIds: new Set(),
  errors: [],
};

const listeners = new Set();
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach(fn => { try { fn(status()); } catch (e) { console.error(e); } }); }

export function status() {
  return {
    mode: state.mode,
    connected: state.connected,
    providers: { ...state.providers },
    liveCount: state.liveIds.size,
    totalCount: ASSETS.length,
    lastTick: state.lastTick,
    lastSnapshot: state.lastSnapshot,
    gates: allGateStatus(),
    errors: state.errors.slice(-3),
  };
}
export function isLive(id) { return state.liveIds.has(id); }

function note(provider, ok, err) {
  state.providers[provider] = ok ? 'ok' : 'fail';
  if (!ok && err) state.errors.push(`${provider}: ${String(err).slice(0, 80)}`);
}

const timeout = (ms = 9000) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

/* ── Провайдеры ───────────────────────────────────────────────────────── */

/** Binance: 24-часовые тикеры пачкой одним запросом. */
async function fetchBinance() {
  const syms = Object.values(BINANCE);
  const url = `${REST}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`;
  const r = await limitedFetch('binance', url, { signal: timeout() }, 4);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const arr = await r.json();

  const bySym = Object.fromEntries(arr.map(t => [t.symbol, t]));
  const out = {};
  for (const [id, sym] of Object.entries(BINANCE)) {
    const t = bySym[sym];
    if (!t) continue;
    out[id] = {
      price: parseFloat(t.lastPrice),
      change24: parseFloat(t.priceChangePercent),
      high24: parseFloat(t.highPrice),
      low24: parseFloat(t.lowPrice),
      vol24: parseFloat(t.quoteVolume),
      quote: 'USDT',
    };
  }
  return out;
}

/** Coinbase: курсы USD→всё. Даёт фиат, TON, DAI и сам USDT. */
async function fetchCoinbase() {
  const r = await limitedFetch('coinbase', 'https://api.coinbase.com/v2/exchange-rates?currency=USD', { signal: timeout() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { data } = await r.json();
  const out = {};
  for (const id of COINBASE) {
    const rate = parseFloat(data.rates[id]);
    if (!Number.isFinite(rate) || rate === 0) continue;
    out[id] = { price: 1 / rate, quote: 'USD' };   // rates[X] = сколько X за 1 USD
  }
  return out;
}

/** CoinGecko: остатки, которых нет у первых двух. */
async function fetchGecko() {
  const ids = Object.values(GECKO).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}` +
              `&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
  const r = await limitedFetch('coingecko', url, { signal: timeout() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const [id, gid] of Object.entries(GECKO)) {
    const d = j[gid];
    if (!d) continue;
    out[id] = {
      price: d.usd,
      change24: d.usd_24h_change,
      vol24: d.usd_24h_vol,
      quote: 'USD',
    };
  }
  return out;
}

/* ── Снимок рынка ─────────────────────────────────────────────────────── */

/**
 * Тянет полный срез со всех источников и заливает его в движок.
 * Частичный отказ допустим: что не пришло — остаётся на симуляторе.
 */
export async function snapshot() {
  if (state.mode !== 'live') return status();

  const [cb, bn, cg] = await Promise.allSettled([fetchCoinbase(), fetchBinance(), fetchGecko()]);

  // Coinbase идёт первым: из него берём USDT→USD для приведения котировок Binance
  const merged = {};
  if (cb.status === 'fulfilled') {
    note('coinbase', true);
    Object.assign(merged, cb.value);
    if (cb.value.USDT?.price) state.usdtUsd = cb.value.USDT.price;
  } else note('coinbase', false, cb.reason);

  if (bn.status === 'fulfilled') {
    note('binance', true);
    for (const [id, d] of Object.entries(bn.value)) {
      merged[id] = { ...d, price: d.price * state.usdtUsd, quote: 'USD' };
    }
  } else note('binance', false, bn.reason);

  if (cg.status === 'fulfilled') {
    note('coingecko', true);
    for (const [id, d] of Object.entries(cg.value)) if (!merged[id]) merged[id] = d;
  } else note('coingecko', false, cg.reason);

  // USDT и USD трогать не нужно: USD — база, USDT приходит из Coinbase
  merged.USD = { price: 1, change24: 0, quote: 'USD' };

  state.liveIds = new Set(Object.keys(merged));
  market.ingest(merged);
  state.lastSnapshot = Date.now();
  state.lastTick = Date.now();
  emit();
  return status();
}

/* ── Живой поток ──────────────────────────────────────────────────────── */

let ws = null;
let wsRetry = 0;
let fiatTimer = null;

/** Подключает combined-stream Binance: тикеры по всем сопоставленным символам. */
export function connect() {
  if (state.mode !== 'live' || ws) return;
  const streams = Object.values(BINANCE).map(s => `${s.toLowerCase()}@ticker`).join('/');

  try {
    ws = new WebSocket(WS_BASE + streams);
  } catch (e) {
    note('websocket', false, e);
    emit();
    return;
  }

  ws.onopen = () => {
    state.connected = true;
    wsRetry = 0;
    note('websocket', true);
    emit();
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const d = msg?.data;
    if (!d || !d.s) return;

    const id = Object.keys(BINANCE).find(k => BINANCE[k] === d.s);
    if (!id) return;

    market.ingest({
      [id]: {
        price: parseFloat(d.c) * state.usdtUsd,
        change24: parseFloat(d.P),
        high24: parseFloat(d.h) * state.usdtUsd,
        low24: parseFloat(d.l) * state.usdtUsd,
        vol24: parseFloat(d.q),
        quote: 'USD',
      },
    });
    state.lastTick = Date.now();
  };

  ws.onclose = () => {
    state.connected = false;
    ws = null;
    emit();
    // Переподключение с возрастающей паузой, но только в live-режиме
    if (state.mode === 'live' && wsRetry < 6) {
      const delay = Math.min(30000, 2000 * 2 ** wsRetry++);
      setTimeout(connect, delay);
    }
  };

  ws.onerror = () => { note('websocket', false, 'соединение потеряно'); emit(); };

  // Фиат по WS не приходит — освежаем раз в минуту
  clearInterval(fiatTimer);
  fiatTimer = setInterval(async () => {
    if (state.mode !== 'live') return;
    try {
      const cb = await fetchCoinbase();
      if (cb.USDT?.price) state.usdtUsd = cb.USDT.price;
      market.ingest(cb);
      note('coinbase', true);
    } catch (e) { note('coinbase', false, e); }
    emit();
  }, 60_000);
}

export function disconnect() {
  clearInterval(fiatTimer);
  fiatTimer = null;
  wsRetry = 99;                  // блокируем авто-переподключение
  if (ws) { try { ws.close(); } catch { /* уже закрыт */ } ws = null; }
  state.connected = false;
  emit();
}

/* ── Свечи ────────────────────────────────────────────────────────────── */

const IV_TO_BINANCE = {
  60_000: '1m', 300_000: '5m', 900_000: '15m',
  3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d',
};

/** Наша пара → символ Binance. Пары к USD считаем эквивалентом USDT. */
export function pairToSymbol(pair) {
  const [base, quote] = pair.split('-');
  if (SIMULATED.includes(base)) return null;

  if (quote === 'USDT' || quote === 'USD') return BINANCE[base] || null;
  if (quote === 'BTC') return BINANCE[base] ? `${base}BTC` : null;
  if (quote === 'EUR') return BINANCE[base] ? `${base}EUR` : null;
  return null;
}

/**
 * Реальные свечи с Binance. Возвращает null, если пары нет или запрос не прошёл —
 * вызывающий тогда оставляет синтетические.
 */
export async function klines(pair, intervalMs, limit = 120) {
  if (state.mode !== 'live') return null;
  const symbol = pairToSymbol(pair);
  const iv = IV_TO_BINANCE[intervalMs];
  if (!symbol || !iv) return null;

  try {
    const r = await limitedFetch('binance', `${REST}/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`, { signal: timeout() }, 2);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    note('klines', true);
    return raw.map(k => ({
      t: k[0],
      o: parseFloat(k[1]), h: parseFloat(k[2]),
      l: parseFloat(k[3]), c: parseFloat(k[4]),
      v: parseFloat(k[5]),
    }));
  } catch (e) {
    note('klines', false, e);
    return null;
  }
}

/** Реальный стакан заявок. */
export async function depth(pair, limit = 20) {
  if (state.mode !== 'live') return null;
  const symbol = pairToSymbol(pair);
  if (!symbol) return null;
  try {
    const r = await limitedFetch('binance', `${REST}/depth?symbol=${symbol}&limit=${limit}`, { signal: timeout() }, 2);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const conv = rows => rows.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    return { bids: conv(j.bids), asks: conv(j.asks) };
  } catch { return null; }
}

/** Реальная лента сделок. */
export async function trades(pair, limit = 24) {
  if (state.mode !== 'live') return null;
  const symbol = pairToSymbol(pair);
  if (!symbol) return null;
  try {
    const r = await limitedFetch('binance', `${REST}/trades?symbol=${symbol}&limit=${limit}`, { signal: timeout() }, 2);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return j.map(t => ({
      ts: t.time,
      price: parseFloat(t.price),
      qty: parseFloat(t.qty),
      side: t.isBuyerMaker ? 'sell' : 'buy',
    })).reverse();
  } catch { return null; }
}

/* ── Управление режимом ───────────────────────────────────────────────── */

export function getMode() { return state.mode; }

export async function setMode(mode) {
  if (mode === state.mode) return status();
  state.mode = mode;

  if (mode === 'sandbox') {
    disconnect();
    state.liveIds.clear();
    market.setLiveIds(new Set());
    state.providers = {};
    emit();
  } else {
    wsRetry = 0;
    await snapshot();
    connect();
  }
  return status();
}

/**
 * Запуск слоя. Режим берётся из настроек; ошибка снимка не считается фатальной —
 * симулятор уже крутится и просто продолжает работать.
 */
export async function start(mode = 'live') {
  state.mode = mode;
  if (mode !== 'live') return status();
  try {
    await snapshot();
    connect();
  } catch (e) {
    note('snapshot', false, e);
    emit();
  }
  return status();
}

export default { start, snapshot, connect, disconnect, setMode, getMode, status, onStatus, isLive, klines, depth, trades, pairToSymbol, BINANCE, SIMULATED };
