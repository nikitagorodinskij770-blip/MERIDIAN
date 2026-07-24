/* MERIDIAN — форматирование чисел, валют, дат, адресов. */

const NBSP = ' ';

/** Разряды через неразрывный пробел, точка как десятичный разделитель. */
export function fmtNum(n, dec = 2, maxDec = dec) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = Number(n).toLocaleString('en-US', {
    minimumFractionDigits: dec, maximumFractionDigits: maxDec,
  });
  return s.replace(/,/g, NBSP);
}

/** Умное число знаков в зависимости от порядка цены. */
export function priceDecimals(p) {
  const a = Math.abs(p);
  if (a >= 1000) return 2;
  if (a >= 100) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  return 8;
}

/** Цена в USD, знаки подбираются автоматически. */
export function fmtPrice(p, cur = '$') {
  if (p === null || p === undefined || Number.isNaN(p)) return '—';
  const d = priceDecimals(p);
  return cur + fmtNum(p, d, d);
}

/** Денежная сумма (портфель, объёмы) — всегда 2 знака. */
export function fmtUSD(n, sign = false) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = (sign && n > 0 ? '+' : n < 0 ? '−' : '') + '$' + fmtNum(Math.abs(n), 2, 2);
  return s;
}

/** Количество актива с учётом его точности, хвостовые нули срезаются. */
export function fmtQty(n, dec = 6) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = fmtNum(n, 0, dec);
  return s;
}

/** Компактная запись: 1.2K / 3.4M / 5.6B / 1.2T */
export function fmtCompact(n, prefix = '$') {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [div, suf] of units) {
    if (a >= div) return prefix + (n / div).toFixed(a / div >= 100 ? 0 : 2) + suf;
  }
  return prefix + fmtNum(n, 0, 2);
}

/** Процент со знаком. */
export function fmtPct(p, dec = 2) {
  if (p === null || p === undefined || Number.isNaN(p)) return '—';
  const sign = p > 0 ? '+' : p < 0 ? '−' : '';
  return sign + Math.abs(p).toFixed(dec) + '%';
}

/** CSS-класс направления. */
export function dirClass(v) { return v > 0 ? 'up' : v < 0 ? 'down' : 'muted'; }
export function badgeClass(v) { return v > 0 ? 'badge-up' : v < 0 ? 'badge-down' : 'badge-neutral'; }

/** Сокращение блокчейн-адреса: T9yD…4kPq */
export function shortAddr(a, head = 6, tail = 4) {
  if (!a) return '—';
  return a.length <= head + tail + 2 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** Дата-время для истории операций. */
export function fmtDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

/** «3 мин назад» */
export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60); if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24); if (d < 30) return `${d} дн назад`;
  return fmtDateTime(ts);
}

/** Безопасное число из поля ввода. */
export function parseAmount(v) {
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Экранирование для вставки в innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
