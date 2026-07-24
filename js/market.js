/* MERIDIAN — движок рынка (эмуляция).
   Геометрическое случайное блуждание с мягким возвратом к якорной цене.
   → PROD: заменяется на WS-стрим агрегированного прайс-оракула (см. PLAN.md §6.2). */

import { ASSETS, ASSET_MAP, CONFIG } from './seed.js';

/* ── Генераторы случайности ───────────────────────────────────────────── */

/** Детерминированный PRNG (mulberry32) — чтобы история графиков не «прыгала». */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** Нормальное распределение (Box–Muller). */
function gauss(rnd = Math.random) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const DAY = 86_400_000;
/** Один тик песочницы ≈ одна минута рыночного времени (чтобы движение было заметным). */
const TICKS_PER_DAY = 1440;
const SPARK_POINTS = 42;

/* ── Состояние ────────────────────────────────────────────────────────── */

const state = {
  price: {},      // id → текущая цена в USD
  prev: {},       // id → предыдущая цена (для подсветки тика)
  anchor: {},     // id → якорь для мягкого возврата
  open24: {},     // id → цена 24ч назад
  high24: {}, low24: {}, vol24: {},
  spark: {},      // id → массив последних цен
  candles: new Map(),   // `${pair}|${iv}` → [{t,o,h,l,c,v}]
  books: new Map(),     // pair → {bids:[], asks:[]}
  trades: new Map(),    // pair → [{ts,price,qty,side}]

  /* Активы, цену которых даёт внешняя биржа. Их не трогает генератор:
     иначе реальная котировка «уплывала» бы от случайного блуждания. */
  live: new Set(),
  realBooks: new Map(),   // pair → реальный стакан с биржи
  realTrades: new Map(),  // pair → реальная лента
};

const listeners = new Set();
let timer = null;
let started = false;

/* ── Инициализация ────────────────────────────────────────────────────── */

function initAsset(a) {
  const rnd = mulberry32(hashStr(a.id));
  state.price[a.id] = a.price;
  state.prev[a.id] = a.price;
  state.anchor[a.id] = a.price;

  // Стартовое суточное изменение: ±(0..1.6)·волатильность
  const chg = a.vol === 0 ? 0 : (rnd() * 2 - 1) * a.vol * 1.6;
  state.open24[a.id] = a.price / (1 + chg);
  state.high24[a.id] = Math.max(a.price, state.open24[a.id]) * (1 + a.vol * 0.35);
  state.low24[a.id] = Math.min(a.price, state.open24[a.id]) * (1 - a.vol * 0.35);

  // Оборот за 24ч — правдоподобная доля капитализации
  const base = a.mcap || a.price * 2e9;
  state.vol24[a.id] = base * (0.02 + rnd() * 0.09);

  // Спарклайн: блуждание назад от текущей цены
  const arr = new Array(SPARK_POINTS);
  let p = a.price;
  const sigma = (a.vol || 0.002) / Math.sqrt(SPARK_POINTS) * 1.9;
  arr[SPARK_POINTS - 1] = p;
  for (let i = SPARK_POINTS - 2; i >= 0; i--) {
    p = p / Math.exp(sigma * gauss(rnd));
    arr[i] = p;
  }
  state.spark[a.id] = arr;
}

/* ── Тик ──────────────────────────────────────────────────────────────── */

function tickAsset(a) {
  if (a.vol === 0) return;                        // USD — базовая единица, не движется
  if (state.live.has(a.id)) return;               // цену даёт биржа — не выдумываем свою
  const p = state.price[a.id];
  const sigma = a.vol / Math.sqrt(TICKS_PER_DAY); // сигма на тик
  const shock = Math.exp(sigma * gauss());
  const pull = 1 + (state.anchor[a.id] / p - 1) * 0.0012;  // мягкий возврат к якорю
  const next = Math.max(p * shock * pull, 1e-9);

  state.prev[a.id] = p;
  state.price[a.id] = next;

  if (next > state.high24[a.id]) state.high24[a.id] = next;
  if (next < state.low24[a.id]) state.low24[a.id] = next;

  // Оборот медленно дышит
  state.vol24[a.id] *= 1 + (Math.random() - 0.5) * 0.004;

  const sp = state.spark[a.id];
  sp.push(next);
  if (sp.length > SPARK_POINTS) sp.shift();
}

function tick() {
  ASSETS.forEach(tickAsset);
  state.candles.forEach((arr, key) => updateCandles(key, arr));
  state.books.forEach((_, pair) => jitterBook(pair));
  state.trades.forEach((_, pair) => pushTrade(pair));
  listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
}

/* ── Приём внешних данных ─────────────────────────────────────────────── */

/**
 * Заливает котировки с биржи. Формат: { BTC: {price, change24?, high24?, low24?, vol24?} }.
 * Помеченные активы исключаются из генератора и живут только на реальных данных.
 */
export function ingest(map) {
  let changed = false;
  for (const [id, d] of Object.entries(map)) {
    const a = ASSET_MAP[id];
    if (!a || !Number.isFinite(d.price) || d.price <= 0) continue;

    state.prev[id] = state.price[id] ?? d.price;
    state.price[id] = d.price;
    state.live.add(id);
    changed = true;

    // open24 выводим из процента: так «изменение за 24ч» совпадает с биржевым
    if (Number.isFinite(d.change24)) {
      state.open24[id] = d.price / (1 + d.change24 / 100);
    } else if (!state.open24[id]) {
      state.open24[id] = d.price;
    }
    if (Number.isFinite(d.high24)) state.high24[id] = d.high24;
    if (Number.isFinite(d.low24)) state.low24[id] = d.low24;
    if (Number.isFinite(d.vol24)) state.vol24[id] = d.vol24;

    const sp = state.spark[id];
    if (sp) {
      // При первом реальном значении сдвигаем всю историю: синтетическая была
      // построена от другой цены, иначе спарклайн покажет фальшивый обрыв.
      const last = sp[sp.length - 1];
      if (last && Math.abs(d.price / last - 1) > 0.25) {
        const k = d.price / last;
        for (let i = 0; i < sp.length; i++) sp[i] *= k;
      }
      sp.push(d.price);
      if (sp.length > SPARK_POINTS) sp.shift();
    }
  }
  if (changed) listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
}

/** Явно задать множество «живых» активов (используется при выходе из live-режима). */
export function setLiveIds(set) { state.live = set instanceof Set ? set : new Set(set); }
export function isLive(id) { return state.live.has(id); }
export function liveCount() { return state.live.size; }

/** Подменить свечи реальными с биржи. */
export function replaceCandles(pair, iv, arr) {
  if (!Array.isArray(arr) || !arr.length) return;
  state.candles.set(`${pair}|${iv}`, arr.slice(-CONFIG.candleCount));
}

/** Реальный стакан / лента: если заданы, геттеры отдают их вместо синтетики. */
export function setRealBook(pair, book) {
  if (book) state.realBooks.set(pair, book); else state.realBooks.delete(pair);
}
export function setRealTrades(pair, list) {
  if (list) state.realTrades.set(pair, list); else state.realTrades.delete(pair);
}

/* ── Публичные геттеры ────────────────────────────────────────────────── */

export function price(id) { return state.price[id] ?? 0; }
export function prevPrice(id) { return state.prev[id] ?? 0; }

/** Изменение за 24 часа, в процентах. */
export function change24(id) {
  const o = state.open24[id];
  if (!o) return 0;
  return (state.price[id] / o - 1) * 100;
}
export function high24(id) { return state.high24[id] ?? 0; }
export function low24(id) { return state.low24[id] ?? 0; }
export function volume24(id) { return state.vol24[id] ?? 0; }
export function sparkline(id) { return state.spark[id] ?? []; }

/** Стоимость `amount` актива в USD. */
export function toUSD(id, amount) { return (state.price[id] ?? 0) * amount; }

/** Курс обмена from → to (сколько `to` за 1 `from`). */
export function rate(from, to) {
  const pf = state.price[from], pt = state.price[to];
  if (!pf || !pt) return 0;
  return pf / pt;
}

/* ── Пары ─────────────────────────────────────────────────────────────── */

export function splitPair(pair) {
  const [base, quote] = pair.split('-');
  return { base, quote };
}
export function pairPrice(pair) {
  const { base, quote } = splitPair(pair);
  return rate(base, quote);
}
export function pairChange(pair) {
  const { base, quote } = splitPair(pair);
  const now = rate(base, quote);
  const then = (state.open24[base] || 1) / (state.open24[quote] || 1);
  return then ? (now / then - 1) * 100 : 0;
}
export function pairVol(pair) {
  const { base, quote } = splitPair(pair);
  const vb = ASSET_MAP[base]?.vol ?? 0.03;
  const vq = ASSET_MAP[quote]?.vol ?? 0;
  return Math.sqrt(vb * vb + vq * vq) || 0.03;
}

/* ── Свечи ────────────────────────────────────────────────────────────── */

function buildCandles(pair, iv, count) {
  const rnd = mulberry32(hashStr(pair + ':' + iv));
  const last = pairPrice(pair);
  const sigma = pairVol(pair) * Math.sqrt(iv / DAY);
  const nowSlot = Math.floor(Date.now() / iv) * iv;

  // Блуждание назад от текущей цены → массив закрытий
  const closes = new Array(count);
  let p = last;
  closes[count - 1] = p;
  for (let i = count - 2; i >= 0; i--) {
    p = p / Math.exp(sigma * gauss(rnd));
    closes[i] = p;
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    const c = closes[i];
    const o = i === 0 ? c / Math.exp(sigma * gauss(rnd) * 0.5) : closes[i - 1];
    const wick = sigma * (0.4 + rnd() * 0.9);
    const h = Math.max(o, c) * (1 + wick * rnd());
    const l = Math.min(o, c) * (1 - wick * rnd());
    out.push({
      t: nowSlot - (count - 1 - i) * iv,
      o, h, l, c,
      v: (0.4 + rnd() * 1.6) * (state.vol24[splitPair(pair).base] || 1e6) / (DAY / iv),
    });
  }
  return out;
}

function updateCandles(key, arr) {
  const [pair, ivStr] = key.split('|');
  const iv = Number(ivStr);
  const p = pairPrice(pair);
  const slot = Math.floor(Date.now() / iv) * iv;
  const last = arr[arr.length - 1];

  if (!last) return;
  if (slot > last.t) {
    arr.push({ t: slot, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p, v: 0 });
    while (arr.length > CONFIG.candleCount) arr.shift();
  } else {
    last.c = p;
    if (p > last.h) last.h = p;
    if (p < last.l) last.l = p;
    last.v += Math.random() * 3;
  }
}

/** Свечи по паре и интервалу (мс). Кэшируются и обновляются на каждом тике. */
export function candles(pair, iv) {
  const key = `${pair}|${iv}`;
  if (!state.candles.has(key)) state.candles.set(key, buildCandles(pair, iv, CONFIG.candleCount));
  return state.candles.get(key);
}

/* ── Стакан ───────────────────────────────────────────────────────────── */

function buildBook(pair) {
  const rnd = mulberry32(hashStr('book' + pair));
  const mk = () => Array.from({ length: 14 }, () => 0.35 + rnd() * 3.4);
  return { bids: mk(), asks: mk() };
}
function jitterBook(pair) {
  const b = state.books.get(pair);
  if (!b) return;
  const j = arr => arr.forEach((v, i) => {
    arr[i] = Math.max(0.05, v * (1 + (Math.random() - 0.5) * 0.22));
  });
  j(b.bids); j(b.asks);
}

/**
 * Стакан заявок вокруг текущей цены.
 * Шаг цены — доля от цены, чтобы работать на любом порядке (BTC и DOGE).
 */
export function orderbook(pair, depth = 12) {
  // Реальный стакан с биржи, если он загружен для этой пары
  const real = state.realBooks.get(pair);
  if (real && real.bids.length && real.asks.length) {
    const mid = (real.bids[0].price + real.asks[0].price) / 2;
    const take = (rows, dir) => {
      let acc = 0;
      return rows.slice(0, depth).map(r => {
        acc += r.qty;
        return { price: r.price, qty: r.qty, total: acc };
      });
    };
    const bids = take(real.bids);
    const asks = take(real.asks);
    const maxTotal = Math.max(bids.at(-1)?.total || 1, asks.at(-1)?.total || 1);
    bids.forEach(r => r.pctDepth = r.total / maxTotal);
    asks.forEach(r => r.pctDepth = r.total / maxTotal);
    return { asks: asks.reverse(), bids, mid, spread: real.asks[0].price - real.bids[0].price, real: true };
  }

  if (!state.books.has(pair)) state.books.set(pair, buildBook(pair));
  const sizes = state.books.get(pair);
  const mid = pairPrice(pair);
  const step = mid * 0.00035;
  const base = splitPair(pair).base;
  const scale = base === 'BTC' ? 0.6 : base === 'ETH' ? 6 : 1000 / Math.max(mid, 0.01);

  const asks = [], bids = [];
  let ca = 0, cb = 0;
  for (let i = 0; i < depth; i++) {
    const qa = sizes.asks[i % sizes.asks.length] * scale;
    const qb = sizes.bids[i % sizes.bids.length] * scale;
    ca += qa; cb += qb;
    asks.push({ price: mid + step * (i + 1), qty: qa, total: ca });
    bids.push({ price: mid - step * (i + 1), qty: qb, total: cb });
  }
  const maxTotal = Math.max(ca, cb);
  asks.forEach(r => r.pctDepth = r.total / maxTotal);
  bids.forEach(r => r.pctDepth = r.total / maxTotal);
  return { asks: asks.reverse(), bids, mid, spread: step * 2 };
}

/* ── Лента сделок ─────────────────────────────────────────────────────── */

function pushTrade(pair) {
  const arr = state.trades.get(pair);
  if (!arr) return;
  const mid = pairPrice(pair);
  const base = splitPair(pair).base;
  const scale = base === 'BTC' ? 0.4 : base === 'ETH' ? 4 : 600 / Math.max(mid, 0.01);
  arr.unshift({
    ts: Date.now(),
    price: mid * (1 + (Math.random() - 0.5) * 0.0006),
    qty: (0.02 + Math.random() * 1.4) * scale,
    side: Math.random() > 0.5 ? 'buy' : 'sell',
  });
  if (arr.length > 28) arr.pop();
}

export function recentTrades(pair) {
  const real = state.realTrades.get(pair);
  if (real && real.length) return real;

  if (!state.trades.has(pair)) {
    state.trades.set(pair, []);
    for (let i = 0; i < 22; i++) pushTrade(pair);
  }
  return state.trades.get(pair);
}

/* ── Подписка / запуск ────────────────────────────────────────────────── */

export function onTick(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function start() {
  if (started) return;
  started = true;
  ASSETS.forEach(initAsset);
  timer = setInterval(tick, CONFIG.tickMs);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(timer); timer = null; }
    else if (!timer) timer = setInterval(tick, CONFIG.tickMs);
  });
}

/** Топ активов по обороту — для витрин. */
export function topAssets(n = 8, type = 'crypto') {
  return ASSETS
    .filter(a => (type === 'all' ? true : a.type === type))
    .sort((a, b) => volume24(b.id) - volume24(a.id))
    .slice(0, n);
}

/** Лидеры роста / падения. */
export function movers(n = 5) {
  const list = ASSETS.filter(a => a.type === 'crypto');
  const sorted = [...list].sort((a, b) => change24(b.id) - change24(a.id));
  return { gainers: sorted.slice(0, n), losers: sorted.slice(-n).reverse() };
}

export const market = {
  start, price, prevPrice, change24, high24, low24, volume24, sparkline,
  toUSD, rate, pairPrice, pairChange, pairVol, splitPair,
  candles, orderbook, recentTrades, onTick, topAssets, movers,
  ingest, setLiveIds, isLive, liveCount, replaceCandles, setRealBook, setRealTrades,
};
export default market;
