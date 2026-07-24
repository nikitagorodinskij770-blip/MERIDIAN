/* MERIDIAN — ограничитель частоты запросов.
   Портирован по образцу RateLimitGate из CryptoExchange.Net (MIT, JKorf):
   скользящее окно + отдельный guard на Retry-After.

   Зачем: у публичных API биржи есть весовые лимиты (Binance — 1200 единиц веса
   в минуту на IP). Без ограничителя быстрое переключение пар в терминале
   выстреливает пачкой запросов и приводит к 429, а затем к временному бану IP. */

/** Скользящее окно: не более `limit` обращений за `windowMs`. */
class SlidingWindowGuard {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];          // отметки времени, каждая со своим весом
  }

  /** Сколько миллисекунд ждать, чтобы запрос веса `weight` уложился в лимит. */
  delayFor(weight = 1) {
    const now = Date.now();
    this.hits = this.hits.filter(h => now - h.t < this.windowMs);
    const used = this.hits.reduce((s, h) => s + h.w, 0);
    if (used + weight <= this.limit) return 0;

    // Ждём, пока из окна выпадет достаточно веса
    let freed = 0;
    for (const h of this.hits) {
      freed += h.w;
      if (used + weight - freed <= this.limit) {
        return Math.max(0, h.t + this.windowMs - now) + 5;
      }
    }
    return this.windowMs;
  }

  register(weight = 1) { this.hits.push({ t: Date.now(), w: weight }); }

  get used() {
    const now = Date.now();
    this.hits = this.hits.filter(h => now - h.t < this.windowMs);
    return this.hits.reduce((s, h) => s + h.w, 0);
  }
}

/**
 * Шлюз лимитов для одного хоста.
 * Запросы выстраиваются в очередь; ответ 429/418 с Retry-After блокирует шлюз целиком.
 */
export class RateLimitGate {
  constructor(name, { limit = 1000, windowMs = 60_000, minGapMs = 0 } = {}) {
    this.name = name;
    this.guard = new SlidingWindowGuard(limit, windowMs);
    this.minGapMs = minGapMs;
    this.retryAfter = 0;      // до какого момента шлюз закрыт
    this.lastCall = 0;
    this.chain = Promise.resolve();
    this.stats = { total: 0, throttled: 0, rejected: 0 };
  }

  /** Ставит задачу в очередь с соблюдением лимитов. */
  schedule(fn, weight = 1) {
    const run = async () => {
      const now = Date.now();

      // Guard на Retry-After: биржа явно попросила подождать
      if (this.retryAfter > now) {
        const wait = this.retryAfter - now;
        this.stats.throttled++;
        await sleep(wait);
      }

      // Минимальный зазор между запросами
      const gap = this.minGapMs - (Date.now() - this.lastCall);
      if (gap > 0) await sleep(gap);

      // Скользящее окно
      const delay = this.guard.delayFor(weight);
      if (delay > 0) { this.stats.throttled++; await sleep(delay); }

      this.guard.register(weight);
      this.lastCall = Date.now();
      this.stats.total++;

      const res = await fn();

      // Разбор ответа: 429 (лимит) и 418 (бан) от Binance
      if (res && typeof res.status === 'number' && (res.status === 429 || res.status === 418)) {
        const ra = parseInt(res.headers?.get?.('Retry-After') || '', 10);
        const waitMs = Number.isFinite(ra) ? ra * 1000 : 60_000;
        this.retryAfter = Date.now() + waitMs;
        this.stats.rejected++;
        console.warn(`[ratelimit:${this.name}] ${res.status}, пауза ${Math.round(waitMs / 1000)} с`);
      }
      return res;
    };

    // Последовательная цепочка: порядок сохраняется, лимит не обходится гонкой
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  status() {
    return {
      name: this.name,
      used: this.guard.used,
      limit: this.guard.limit,
      blockedFor: Math.max(0, this.retryAfter - Date.now()),
      ...this.stats,
    };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Шлюзы по биржам ──────────────────────────────────────────────────── */
/* Лимиты взяты с запасом — мы используем малую долю публичной квоты. */

export const GATES = {
  binance:   new RateLimitGate('binance',   { limit: 600, windowMs: 60_000, minGapMs: 60 }),
  coinbase:  new RateLimitGate('coinbase',  { limit: 100, windowMs: 60_000, minGapMs: 120 }),
  coingecko: new RateLimitGate('coingecko', { limit: 25,  windowMs: 60_000, minGapMs: 1200 }),
  okx:       new RateLimitGate('okx',       { limit: 120, windowMs: 60_000, minGapMs: 120 }),
  bybit:     new RateLimitGate('bybit',     { limit: 120, windowMs: 60_000, minGapMs: 120 }),
  kraken:    new RateLimitGate('kraken',    { limit: 60,  windowMs: 60_000, minGapMs: 350 }),
  bitstamp:  new RateLimitGate('bitstamp',  { limit: 60,  windowMs: 60_000, minGapMs: 350 }),
};

/** fetch через шлюз конкретной биржи. */
export function limitedFetch(gateName, url, opts = {}, weight = 1) {
  const gate = GATES[gateName];
  if (!gate) return fetch(url, opts);
  return gate.schedule(() => fetch(url, opts), weight);
}

export function allGateStatus() {
  return Object.values(GATES).map(g => g.status());
}

export default { RateLimitGate, GATES, limitedFetch, allGateStatus };
