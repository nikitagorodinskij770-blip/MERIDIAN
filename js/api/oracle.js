/* MERIDIAN — прайс-оракул: агрегация котировок нескольких бирж.
   Реализует алгоритм из PLAN.md §6.2: взвешенная по обороту медиана
   с отбраковкой выбросов по MAD.

   Почему медиана, а не среднее: одна биржа со сломанным стаканом или тонкой
   ликвидностью сдвигает среднее и не сдвигает медиану. Отбраковка по MAD
   (медианное абсолютное отклонение) устойчива к выбросам — в отличие от
   сигмы, которую сам выброс и раздувает.

   Опрошены только площадки, реально отдающие CORS-заголовки браузеру.
   Схема запросов сверена с определениями CCXT (MIT). */

import { limitedFetch } from './ratelimit.js';

const TIMEOUT = 8000;
const sig = () => (AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT) : undefined);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/* ── Площадки ─────────────────────────────────────────────────────────── */

export const VENUES = [
  {
    id: 'binance', name: 'Binance', quote: 'USDT',
    url: b => `https://api.binance.com/api/v3/ticker/24hr?symbol=${b}USDT`,
    parse: j => ({ price: num(j.lastPrice), vol: num(j.quoteVolume), bid: num(j.bidPrice), ask: num(j.askPrice) }),
  },
  {
    id: 'okx', name: 'OKX', quote: 'USDT',
    url: b => `https://www.okx.com/api/v5/market/ticker?instId=${b}-USDT`,
    parse: j => { const d = j.data?.[0]; return d && { price: num(d.last), vol: num(d.volCcy24h), bid: num(d.bidPx), ask: num(d.askPx) }; },
  },
  {
    id: 'bybit', name: 'Bybit', quote: 'USDT',
    url: b => `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${b}USDT`,
    parse: j => { const d = j.result?.list?.[0]; return d && { price: num(d.lastPrice), vol: num(d.turnover24h), bid: num(d.bid1Price), ask: num(d.ask1Price) }; },
  },
  {
    id: 'kraken', name: 'Kraken', quote: 'USDT',
    // У Kraken свои тикеры: биткойн — XBT
    url: b => `https://api.kraken.com/0/public/Ticker?pair=${b === 'BTC' ? 'XBT' : b}USDT`,
    parse: j => {
      const d = Object.values(j.result || {})[0];
      if (!d) return null;
      const price = num(d.c?.[0]);
      return { price, vol: num(d.v?.[1]) * (price || 0), bid: num(d.b?.[0]), ask: num(d.a?.[0]) };
    },
  },
  {
    id: 'bitstamp', name: 'Bitstamp', quote: 'USDT',
    url: b => `https://www.bitstamp.net/api/v2/ticker/${b.toLowerCase()}usdt/`,
    parse: j => ({ price: num(j.last), vol: num(j.volume) * num(j.last), bid: num(j.bid), ask: num(j.ask) }),
  },
  {
    id: 'coinbase', name: 'Coinbase', quote: 'USD',
    url: b => `https://api.exchange.coinbase.com/products/${b}-USD/ticker`,
    parse: j => ({ price: num(j.price), vol: num(j.volume) * num(j.price), bid: num(j.bid), ask: num(j.ask) }),
  },
];

/** Активы, у которых пары есть на большинстве площадок. */
export const COVERED = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC', 'LINK', 'DOT', 'AVAX', 'BCH', 'ATOM'];

/* ── Статистика ───────────────────────────────────────────────────────── */

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Медианное абсолютное отклонение — устойчивая мера разброса. */
export function mad(xs, med = median(xs)) {
  if (!xs.length) return 0;
  return median(xs.map(x => Math.abs(x - med)));
}

/** Медиана, взвешенная по обороту: точка, где накопленный вес переходит половину. */
export function weightedMedian(items) {
  const valid = items.filter(i => Number.isFinite(i.value) && i.weight > 0);
  if (!valid.length) return median(items.map(i => i.value));

  const sorted = [...valid].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  let acc = 0;
  for (const i of sorted) {
    acc += i.weight;
    if (acc >= total / 2) return i.value;
  }
  return sorted[sorted.length - 1].value;
}

/* ── Опрос площадок ───────────────────────────────────────────────────── */

async function ask(venue, base) {
  const t0 = performance.now();
  try {
    const r = await limitedFetch(venue.id, venue.url(base), { signal: sig() });
    if (!r.ok) return { id: venue.id, name: venue.name, ok: false, error: `HTTP ${r.status}` };
    const parsed = venue.parse(await r.json());
    if (!parsed || !parsed.price) return { id: venue.id, name: venue.name, ok: false, error: 'нет котировки' };
    return {
      id: venue.id, name: venue.name, ok: true,
      ...parsed,
      spread: parsed.ask && parsed.bid ? parsed.ask - parsed.bid : null,
      ms: Math.round(performance.now() - t0),
      quote: venue.quote,
    };
  } catch (e) {
    return { id: venue.id, name: venue.name, ok: false, error: String(e).replace(/^\w+:\s*/, '').slice(0, 50) };
  }
}

/**
 * Сводная котировка по активу.
 * Возвращает и итог, и полный расклад по площадкам — чтобы UI мог показать,
 * откуда взялась цена и кого отбраковали.
 */
export async function crossQuote(base, { k = 3 } = {}) {
  const results = await Promise.all(VENUES.map(v => ask(v, base)));
  const live = results.filter(r => r.ok);

  if (!live.length) {
    return { base, ok: false, venues: results, price: null, reason: 'ни одна площадка не ответила' };
  }

  const prices = live.map(r => r.price);
  const med = median(prices);
  const dev = mad(prices, med);

  // Порог отбраковки. Когда MAD близок к нулю (площадки согласны),
  // берём страховочные 0.25% — иначе отсеклись бы нормальные расхождения.
  const threshold = Math.max(k * dev, med * 0.0025);

  live.forEach(r => {
    r.deviation = r.price - med;
    r.deviationPct = ((r.price / med) - 1) * 100;
    r.rejected = Math.abs(r.deviation) > threshold;
  });

  const kept = live.filter(r => !r.rejected);
  const pool = kept.length ? kept : live;      // если отсеклись все — берём как есть

  const price = weightedMedian(pool.map(r => ({ value: r.price, weight: r.vol || 1 })));
  const spreadAbs = Math.max(...pool.map(r => r.price)) - Math.min(...pool.map(r => r.price));

  return {
    base, ok: true, price,
    median: med, mad: dev, threshold,
    venues: results,
    used: pool.length,
    responded: live.length,
    total: VENUES.length,
    rejected: live.filter(r => r.rejected).map(r => r.id),
    spreadAbs,
    spreadPct: (spreadAbs / med) * 100,
    bestBid: Math.max(...pool.filter(r => r.bid).map(r => r.bid), 0) || null,
    bestAsk: Math.min(...pool.filter(r => r.ask).map(r => r.ask), Infinity) || null,
    ts: Date.now(),
  };
}

/** Сводные котировки сразу по нескольким активам. */
export async function crossQuotes(bases = COVERED.slice(0, 6)) {
  const out = {};
  const list = await Promise.all(bases.map(b => crossQuote(b)));
  list.forEach(q => { out[q.base] = q; });
  return out;
}

export default { VENUES, COVERED, crossQuote, crossQuotes, median, mad, weightedMedian };
