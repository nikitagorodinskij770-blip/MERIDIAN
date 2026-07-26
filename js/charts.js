/* MERIDIAN — графики на canvas. Без внешних библиотек: работает офлайн.
   → PROD: этот слой можно заменить на TradingView Lightweight Charts. */

import { priceDecimals, fmtNum, fmtCompact } from './format.js';

const CSS = {
  grid: '#eef0f4', axis: '#9aa3af', text: '#6b7280', ink: '#0b1220',
  up: '#0ea75f', down: '#e0323f', brand: '#1e59ff', brandFill: 'rgba(30,89,255,.10)',
};

/*  Защита от отрисовки «в ноль».
    Если вью отрисована, но браузер ещё не посчитал layout, clientWidth/Height равны 0
    и график ушёл бы в дефолтный буфер 300×150. Вместо этого вешаем одноразовый
    ResizeObserver и перерисовываем, как только размер станет реальным.  */
const pendingResize = new WeakMap();

function ensureSized(canvas, redraw) {
  if (canvas.clientWidth > 1 && canvas.clientHeight > 1) return true;
  if (pendingResize.has(canvas)) return false;

  let done = false;
  const finish = () => {
    if (done) return;
    if (!canvas.isConnected) { cleanup(); return; }   // узел выбросили — ждать нечего
    if (canvas.clientWidth > 1 && canvas.clientHeight > 1) { cleanup(); redraw(); }
  };
  const cleanup = () => {
    done = true;
    ro.disconnect();
    pendingResize.delete(canvas);
  };

  const ro = new ResizeObserver(finish);
  ro.observe(canvas);
  pendingResize.set(canvas, ro);

  /* Три независимых способа дождаться размера. Избыточно намеренно:
     ResizeObserver молчит, если элемент вставлен уже с готовой геометрией;
     кадр анимации может прийти раньше вставки в документ; таймеры добивают
     остальные случаи. Первый сработавший отменяет остальные. */
  requestAnimationFrame(() => requestAnimationFrame(finish));
  [50, 160, 400].forEach(ms => setTimeout(finish, ms));
  return false;
}

/** Подгоняет буфер canvas под CSS-размер и DPR. Возвращает ctx + логический размер. */
function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 300;
  const h = canvas.clientHeight || 150;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/* ── Спарклайн ────────────────────────────────────────────────────────── */

export function drawSparkline(canvas, data, color) {
  if (!canvas || !data || data.length < 2) return;
  if (!ensureSized(canvas, () => drawSparkline(canvas, data, color))) return;
  const { ctx, w, h } = setup(canvas);
  const min = Math.min(...data), max = Math.max(...data);

  // Спарклайн нормируется по собственному минимуму и максимуму, и без нижней
  // границы масштаба это врёт: стейблкоин, качнувшийся на сотую долю процента,
  // рисуется той же амплитудой, что биткоин на пяти процентах, — и выглядит
  // волатильнее него. Пол в один процент от цены возвращает масштабу смысл:
  // спокойный инструмент остаётся спокойной линией, а сравнение строк
  // взглядом снова работает.
  const MIN_REL_SPAN = 0.01;
  const mid = (max + min) / 2;
  const span = Math.max(max - min, Math.abs(mid) * MIN_REL_SPAN) || 1;
  const lo = mid - span / 2;

  const pad = 3;
  const x = i => (i / (data.length - 1)) * w;
  const y = v => h - pad - ((v - lo) / span) * (h - pad * 2);

  const rising = data[data.length - 1] >= data[0];
  const stroke = color || (rising ? CSS.up : CSS.down);

  // Заливка под линией
  ctx.beginPath();
  ctx.moveTo(0, y(data[0]));
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, stroke + '2e');
  g.addColorStop(1, stroke + '00');
  ctx.fillStyle = g; ctx.fill();

  // Линия
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/* ── Area-график (портфель, простой режим) ────────────────────────────── */

export function drawArea(canvas, data, opts = {}) {
  const { color = CSS.brand, labels = true } = opts;
  if (!canvas || !data || data.length < 2) return;
  if (!ensureSized(canvas, () => drawArea(canvas, data, opts))) return;
  const { ctx, w, h } = setup(canvas);
  const padL = 6, padR = labels ? 62 : 6, padT = 12, padB = labels ? 22 : 6;
  const iw = w - padL - padR, ih = h - padT - padB;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || max * 0.001 || 1;
  const x = i => padL + (i / (data.length - 1)) * iw;
  const y = v => padT + ih - ((v - min) / span) * ih;

  // Сетка
  ctx.strokeStyle = CSS.grid; ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = CSS.text; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const yy = Math.round(padT + (ih / 4) * i) + .5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke();
    if (labels) {
      const val = max - (span / 4) * i;
      ctx.fillText('$' + fmtNum(val, 0, val < 10 ? 4 : 0), padL + iw + 8, yy);
    }
  }

  ctx.beginPath();
  ctx.moveTo(x(0), y(data[0]));
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(data.length - 1), padT + ih); ctx.lineTo(x(0), padT + ih); ctx.closePath();
  const g = ctx.createLinearGradient(0, padT, 0, padT + ih);
  g.addColorStop(0, color + '33'); g.addColorStop(1, color + '00');
  ctx.fillStyle = g; ctx.fill();

  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}

/* ── Свечной график ───────────────────────────────────────────────────── */

/**
 * @param canvas   целевой canvas
 * @param candles  [{t,o,h,l,c,v}]
 * @param opts     { showVolume, crosshair:{x,y}|null }
 */
export function drawCandles(canvas, candles, opts = {}) {
  if (!canvas || !candles || candles.length < 2) return;
  const { showVolume = true, crosshair = null } = opts;
  if (!ensureSized(canvas, () => drawCandles(canvas, candles, opts))) return;
  const { ctx, w, h } = setup(canvas);

  const padL = 8, padR = 66, padT = 12, padB = 24;
  const volH = showVolume ? Math.round((h - padT - padB) * 0.18) : 0;
  const iw = w - padL - padR;
  const ih = h - padT - padB - volH - (showVolume ? 8 : 0);
  if (iw <= 0 || ih <= 0) return;

  let min = Infinity, max = -Infinity, maxV = 0;
  candles.forEach(c => {
    if (c.l < min) min = c.l;
    if (c.h > max) max = c.h;
    if (c.v > maxV) maxV = c.v;
  });
  const pad = (max - min) * 0.06 || max * 0.002;
  min -= pad; max += pad;
  const span = max - min || 1;

  const n = candles.length;
  const step = iw / n;
  const bodyW = Math.max(1.5, Math.min(11, step * 0.64));
  const x = i => padL + step * (i + 0.5);
  const y = v => padT + ih - ((v - min) / span) * ih;

  const dec = priceDecimals(candles[n - 1].c);

  // ── Сетка + ценовая ось справа
  ctx.strokeStyle = CSS.grid; ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, "SF Mono", monospace';
  ctx.fillStyle = CSS.text; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const rows = 5;
  for (let i = 0; i <= rows; i++) {
    const yy = Math.round(padT + (ih / rows) * i) + .5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke();
    ctx.fillText(fmtNum(max - (span / rows) * i, dec, dec), padL + iw + 8, yy);
  }

  // ── Ось времени
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const tickEvery = Math.ceil(n / 6);
  for (let i = 0; i < n; i += tickEvery) {
    const d = new Date(candles[i].t);
    const label = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    ctx.fillStyle = CSS.text;
    ctx.fillText(label, x(i), h - padB + 6);
  }

  // ── Объёмы
  if (showVolume && maxV > 0) {
    const vTop = padT + ih + 8;
    candles.forEach((c, i) => {
      const bh = (c.v / maxV) * volH;
      ctx.fillStyle = (c.c >= c.o ? CSS.up : CSS.down) + '2b';
      ctx.fillRect(x(i) - bodyW / 2, vTop + volH - bh, bodyW, bh);
    });
  }

  // ── Свечи
  candles.forEach((c, i) => {
    const up = c.c >= c.o;
    const col = up ? CSS.up : CSS.down;
    const cx = x(i);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;

    // Фитиль
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + .5, y(c.h));
    ctx.lineTo(Math.round(cx) + .5, y(c.l));
    ctx.stroke();

    // Тело
    const yo = y(c.o), yc = y(c.c);
    const top = Math.min(yo, yc);
    const bh = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);
  });

  // ── Линия последней цены
  const last = candles[n - 1];
  const ly = y(last.c);
  const lastUp = last.c >= last.o;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = lastUp ? CSS.up : CSS.down;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(padL + iw, ly); ctx.stroke();
  ctx.setLineDash([]);

  // Плашка с ценой
  const label = fmtNum(last.c, dec, dec);
  ctx.font = '11px ui-monospace, monospace';
  const tw = ctx.measureText(label).width + 12;
  ctx.fillStyle = lastUp ? CSS.up : CSS.down;
  ctx.fillRect(padL + iw + 3, ly - 9, Math.min(tw, padR - 6), 18);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(label, padL + iw + 9, ly);

  // ── Перекрестие
  if (crosshair && crosshair.x >= padL && crosshair.x <= padL + iw) {
    const idx = Math.max(0, Math.min(n - 1, Math.floor((crosshair.x - padL) / step)));
    const c = candles[idx];
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = CSS.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(idx), padT); ctx.lineTo(x(idx), padT + ih); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, crosshair.y); ctx.lineTo(padL + iw, crosshair.y); ctx.stroke();
    ctx.setLineDash([]);

    // Тултип OHLC
    const lines = [
      `O ${fmtNum(c.o, dec, dec)}   H ${fmtNum(c.h, dec, dec)}`,
      `L ${fmtNum(c.l, dec, dec)}   C ${fmtNum(c.c, dec, dec)}`,
      `Объём ${fmtCompact(c.v, '')}`,
    ];
    ctx.font = '11px ui-monospace, monospace';
    const bw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16;
    const bx = Math.min(x(idx) + 12, padL + iw - bw);
    const by = padT + 6;
    ctx.fillStyle = 'rgba(255,255,255,.96)';
    ctx.strokeStyle = CSS.grid;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, 56, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = CSS.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 8 + i * 15));
  }
}

/* ── Столбчатый график ────────────────────────────────────────────────── */

/**
 * Столбцы по дням — регистрации, активность и прочие счётчики.
 * @param labels функция i → подпись под столбцом (не обязательна)
 */
export function drawBars(canvas, data, opts = {}) {
  const { color = CSS.brand, labels = null } = opts;
  if (!canvas || !data || !data.length) return;
  if (!ensureSized(canvas, () => drawBars(canvas, data, opts))) return;
  const { ctx, w, h } = setup(canvas);

  const padL = 6, padR = 44, padT = 10, padB = labels ? 20 : 6;
  const iw = w - padL - padR, ih = h - padT - padB;
  const max = Math.max(...data, 1);
  const step = iw / data.length;
  const bw = Math.max(2, step * 0.62);

  // Сетка и шкала
  ctx.strokeStyle = CSS.grid; ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = CSS.text; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (let i = 0; i <= 3; i++) {
    const y = Math.round(padT + (ih / 3) * i) + .5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
    ctx.fillText(String(Math.round(max - (max / 3) * i)), padL + iw + 8, y);
  }

  data.forEach((v, i) => {
    const bh = (v / max) * ih;
    const x = padL + step * i + (step - bw) / 2;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25 + 0.75 * (v / max);
    ctx.beginPath();
    ctx.roundRect(x, padT + ih - bh, bw, Math.max(1, bh), [3, 3, 0, 0]);
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  if (labels) {
    ctx.fillStyle = CSS.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const every = Math.ceil(data.length / 6);
    for (let i = 0; i < data.length; i += every) {
      ctx.fillText(labels(i), padL + step * i + step / 2, h - padB + 4);
    }
  }
}

/* ── Донат аллокации ──────────────────────────────────────────────────── */

export function drawDonut(canvas, slices, opts = {}) {
  const { centerTop = '', centerSub = '' } = opts;
  if (!canvas) return;
  if (!ensureSized(canvas, () => drawDonut(canvas, slices, opts))) return;
  const { ctx, w, h } = setup(canvas);
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 6;
  const thick = Math.max(14, r * 0.36);

  const total = slices.reduce((s, x) => s + x.pct, 0) || 1;
  let a0 = -Math.PI / 2;

  if (!slices.length) {
    ctx.beginPath();
    ctx.arc(cx, cy, r - thick / 2, 0, Math.PI * 2);
    ctx.strokeStyle = '#eef0f4'; ctx.lineWidth = thick; ctx.stroke();
  }

  slices.forEach(s => {
    const a1 = a0 + (s.pct / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r - thick / 2, a0, a1);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = thick;
    ctx.lineCap = 'butt';
    ctx.stroke();
    a0 = a1;
  });

  if (centerTop) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = CSS.ink;
    ctx.font = '600 15px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillText(centerTop, cx, cy - (centerSub ? 8 : 0));
    if (centerSub) {
      ctx.fillStyle = CSS.text;
      ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillText(centerSub, cx, cy + 11);
    }
  }
}

/* ── Глубина рынка ────────────────────────────────────────────────────── */

export function drawDepth(canvas, book) {
  if (!canvas || !book) return;
  if (!ensureSized(canvas, () => drawDepth(canvas, book))) return;
  const { ctx, w, h } = setup(canvas);
  const bids = [...book.bids], asks = [...book.asks].reverse();
  if (!bids.length || !asks.length) return;

  const maxTotal = Math.max(bids[bids.length - 1].total, asks[asks.length - 1].total);
  const lo = bids[bids.length - 1].price, hi = asks[asks.length - 1].price;
  const spanX = hi - lo || 1;
  const x = p => ((p - lo) / spanX) * w;
  const y = t => h - (t / maxTotal) * (h - 6);

  const drawSide = (rows, color) => {
    ctx.beginPath();
    ctx.moveTo(x(rows[0].price), h);
    rows.forEach(r => ctx.lineTo(x(r.price), y(r.total)));
    ctx.lineTo(x(rows[rows.length - 1].price), h);
    ctx.closePath();
    ctx.fillStyle = color + '22'; ctx.fill();
    ctx.beginPath();
    rows.forEach((r, i) => (i ? ctx.lineTo(x(r.price), y(r.total)) : ctx.moveTo(x(r.price), y(r.total))));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  };
  drawSide(bids, CSS.up);
  drawSide(asks, CSS.down);
}

export default { drawSparkline, drawArea, drawCandles, drawDonut, drawDepth };
