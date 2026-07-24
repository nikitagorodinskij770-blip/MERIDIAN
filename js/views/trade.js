/* Спот-терминал: график свечей, стакан, лента сделок, панель ордеров, открытые заявки. */

import { PAIRS, ASSET_MAP, INTERVALS, CONFIG } from '../seed.js';
import * as market from '../market.js';
import * as store from '../store.js';
import { h, qs, qsa, on, coinIcon, modal, toast, ICONS } from '../ui.js';
import { fmtPrice, fmtPct, fmtCompact, fmtNum, fmtQty, dirClass, priceDecimals, parseAmount, fmtTime, esc } from '../format.js';
import { drawCandles } from '../charts.js';

export default {
  title: 'Торговля',
  auth: false,

  render({ params }) {
    let pair = (params[0] || 'BTC-USDT').toUpperCase();
    if (!PAIRS.includes(pair)) pair = 'BTC-USDT';

    let { base, quote } = market.splitPair(pair);
    let ivLabel = '15м';
    let side = 'buy';
    let type = 'limit';
    let crosshair = null;

    const el = h(`<div class="container section-tight">
      <div class="trade-grid">

        <!-- ── Шапка пары ────────────────────────────────── -->
        <div class="trade-cell trade-head">
          <button class="asset-pick" data-pairpick>
            ${coinIcon(base, 'sm')}
            <span class="pair-name" data-pairname>${esc(pair.replace('-', ' / '))}</span>
            <span style="color:var(--muted)">${ICONS.chevronDown}</span>
          </button>
          <div>
            <div class="last" data-last>—</div>
            <div class="mono" style="font-size:12px" data-lastusd>—</div>
          </div>
          <div class="th-stat"><span class="k">Изм. 24ч</span><span class="v" data-chg>—</span></div>
          <div class="th-stat hide-sm"><span class="k">Максимум 24ч</span><span class="v" data-hi>—</span></div>
          <div class="th-stat hide-sm"><span class="k">Минимум 24ч</span><span class="v" data-lo>—</span></div>
          <div class="th-stat hide-sm"><span class="k">Объём 24ч</span><span class="v" data-vol>—</span></div>
          <div style="flex:1"></div>
          <button class="btn btn-ghost btn-sm" data-fav></button>
        </div>

        <!-- ── График ────────────────────────────────────── -->
        <div class="trade-cell chart-cell">
          <div class="chart-toolbar">
            <div class="segment" data-ivs>
              ${Object.keys(INTERVALS).map(k =>
                `<button data-iv="${k}"${k === ivLabel ? ' class="on"' : ''}>${k}</button>`).join('')}
            </div>
            <div style="flex:1"></div>
            <span class="badge badge-neutral hide-sm">Свечи · объём</span>
          </div>
          <div class="chart-canvas-wrap"><canvas data-chart></canvas></div>
        </div>

        <!-- ── Стакан ────────────────────────────────────── -->
        <div class="trade-cell orderbook">
          <div class="row between" style="margin-bottom:6px">
            <b style="color:var(--ink);font-size:13px">Стакан заявок</b>
            <span class="muted" style="font-size:11px">спред <span data-spread>—</span></span>
          </div>
          <div class="ob-head">
            <span>Цена</span><span class="num" style="text-align:right">Кол-во</span>
            <span class="num" style="text-align:right">Сумма</span>
          </div>
          <div data-asks></div>
          <div class="ob-mid" data-obmid>—</div>
          <div data-bids></div>
        </div>

        <!-- ── Панель ордера ─────────────────────────────── -->
        <div class="trade-cell trade-panel">
          <div class="segment up-down full" data-side>
            <button class="buy on" data-s="buy">Купить</button>
            <button data-s="sell">Продать</button>
          </div>
          <div class="segment full" data-type>
            <button data-t="limit" class="on">Лимитный</button>
            <button data-t="market">Рыночный</button>
          </div>

          <div class="field" data-pricefield>
            <label>Цена <span class="muted" data-qlabel>${esc(quote)}</span></label>
            <div class="amount-input">
              <input type="text" inputmode="decimal" data-price>
              <span class="suffix" data-qsuffix>${esc(quote)}</span>
            </div>
          </div>

          <div class="field">
            <label>Количество <span class="muted" data-blabel>${esc(base)}</span></label>
            <div class="amount-input">
              <input type="text" inputmode="decimal" placeholder="0.00" data-qty>
              <span class="suffix" data-bsuffix>${esc(base)}</span>
            </div>
          </div>

          <div class="slider-pct">
            ${[25, 50, 75, 100].map(p => `<button data-pct="${p}">${p}%</button>`).join('')}
          </div>

          <div class="rate-line"><span>Итого</span><b data-total>—</b></div>
          <div class="rate-line"><span>Комиссия</span><b data-fee>—</b></div>
          <div class="rate-line"><span>Доступно</span><b data-avail>—</b></div>

          <button class="btn btn-up btn-block btn-lg" data-submit>Купить ${esc(base)}</button>
          <p class="help center" style="margin:0">Мейкер ${(CONFIG.makerFee * 100).toFixed(2)}% ·
             тейкер ${(CONFIG.takerFee * 100).toFixed(2)}%</p>
        </div>

        <!-- ── Лента сделок ──────────────────────────────── -->
        <div class="trade-cell recent-trades">
          <div class="row between" style="margin-bottom:8px">
            <b style="color:var(--ink);font-size:13px">Последние сделки</b>
          </div>
          <div class="ob-head"><span>Цена</span>
            <span class="num" style="text-align:right">Кол-во</span>
            <span class="num" style="text-align:right">Время</span></div>
          <div data-trades></div>
        </div>

        <!-- ── Открытые ордера ───────────────────────────── -->
        <div class="trade-cell orders-cell">
          <div class="row between" style="margin-bottom:12px">
            <b style="color:var(--ink)">Мои ордера</b>
            <span class="badge badge-neutral" data-ordcount>0 открытых</span>
          </div>
          <div class="table-wrap" data-orders></div>
        </div>
      </div>
    </div>`);

    /* ── Ссылки на узлы ── */
    const canvas = qs('[data-chart]', el);
    const priceInp = qs('[data-price]', el);
    const qtyInp = qs('[data-qty]', el);
    const submitBtn = qs('[data-submit]', el);

    /* ── Пересчёт панели ордера ── */
    const currentPrice = () => type === 'market'
      ? market.pairPrice(pair)
      : (parseAmount(priceInp.value) || market.pairPrice(pair));

    const availAsset = () => (side === 'buy' ? quote : base);

    function refreshPanel() {
      const px = currentPrice();
      const qty = parseAmount(qtyInp.value);
      const total = px * qty;
      const feeRate = type === 'market' ? CONFIG.takerFee : CONFIG.makerFee;
      const dec = ASSET_MAP[base]?.dec ?? 6;

      qs('[data-total]', el).textContent = total > 0
        ? `${fmtNum(total, 2, 8)} ${quote}` : '—';
      qs('[data-fee]', el).textContent = qty > 0
        ? (side === 'buy'
            ? `${fmtNum(qty * feeRate, 0, dec)} ${base}`
            : `${fmtNum(total * feeRate, 2, 6)} ${quote}`)
        : '—';

      const av = availAsset();
      qs('[data-avail]', el).textContent =
        `${fmtNum(store.available(av), 0, ASSET_MAP[av]?.dec ?? 4)} ${av}`;

      submitBtn.className = `btn btn-block btn-lg ${side === 'buy' ? 'btn-up' : 'btn-down'}`;
      submitBtn.textContent = `${side === 'buy' ? 'Купить' : 'Продать'} ${base}`;
      qs('[data-pricefield]', el).style.display = type === 'market' ? 'none' : '';
    }

    /* ── График ── */
    function paintChart() {
      const iv = INTERVALS[ivLabel];
      drawCandles(canvas, market.candles(pair, iv), { showVolume: true, crosshair });
    }

    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      crosshair = { x: e.clientX - r.left, y: e.clientY - r.top };
      paintChart();
    });
    canvas.addEventListener('mouseleave', () => { crosshair = null; paintChart(); });

    /* ── Шапка пары ── */
    function paintHead() {
      const p = market.pairPrice(pair);
      const chg = market.pairChange(pair);
      const dec = priceDecimals(p);
      const lastEl = qs('[data-last]', el);
      lastEl.textContent = fmtNum(p, dec, dec);
      lastEl.className = 'last ' + dirClass(chg);
      qs('[data-lastusd]', el).textContent = '≈ ' + fmtPrice(market.price(base));
      const c = qs('[data-chg]', el);
      c.textContent = fmtPct(chg);
      c.className = 'v ' + dirClass(chg);
      qs('[data-hi]', el).textContent = fmtNum(market.high24(base) / (market.price(quote) || 1), dec, dec);
      qs('[data-lo]', el).textContent = fmtNum(market.low24(base) / (market.price(quote) || 1), dec, dec);
      qs('[data-vol]', el).textContent = fmtCompact(market.volume24(base));
    }

    /* ── Стакан ── */
    function paintBook() {
      const book = market.orderbook(pair, 11);
      const dec = priceDecimals(book.mid);
      const qdec = base === 'BTC' ? 4 : 2;

      const rowHtml = (r, kind) => `
        <div class="ob-row ${kind}" data-obpx="${r.price}">
          <div class="depth" style="width:${(r.pctDepth * 100).toFixed(1)}%"></div>
          <span class="price">${fmtNum(r.price, dec, dec)}</span>
          <span class="num">${fmtNum(r.qty, qdec, qdec)}</span>
          <span class="num">${fmtNum(r.total, 0, 1)}</span>
        </div>`;

      qs('[data-asks]', el).innerHTML = book.asks.map(r => rowHtml(r, 'ask')).join('');
      qs('[data-bids]', el).innerHTML = book.bids.map(r => rowHtml(r, 'bid')).join('');

      const chg = market.pairChange(pair);
      const mid = qs('[data-obmid]', el);
      mid.textContent = fmtNum(book.mid, dec, dec);
      mid.className = 'ob-mid ' + dirClass(chg);
      qs('[data-spread]', el).textContent = fmtNum(book.spread, dec, dec);
    }

    /* ── Лента ── */
    function paintTrades() {
      const list = market.recentTrades(pair);
      const dec = priceDecimals(market.pairPrice(pair));
      qs('[data-trades]', el).innerHTML = list.map(t => `
        <div class="rt-row">
          <span class="${t.side === 'buy' ? 'up' : 'down'}">${fmtNum(t.price, dec, dec)}</span>
          <span class="num">${fmtNum(t.qty, 4, 4)}</span>
          <span class="num muted">${fmtTime(t.ts)}</span>
        </div>`).join('');
    }

    /* ── Мои ордера ── */
    function paintOrders() {
      const list = store.openOrders();
      qs('[data-ordcount]', el).textContent = `${list.length} открытых`;
      const box = qs('[data-orders]', el);
      if (!list.length) {
        box.innerHTML = `<div class="empty" style="padding:28px">
          <div class="ic">${ICONS.book}</div>
          <p style="margin:0">Открытых ордеров нет. Разместите лимитную заявку — она исполнится,
             когда рынок дойдёт до вашей цены.</p></div>`;
        return;
      }
      box.innerHTML = `<table class="tbl"><thead><tr>
          <th>Пара</th><th>Сторона</th><th>Тип</th>
          <th class="num">Цена</th><th class="num">Кол-во</th>
          <th class="num hide-sm">Сумма</th><th class="num hide-sm">Создан</th><th></th>
        </tr></thead><tbody>
        ${list.map(o => `<tr>
          <td><b>${esc(o.pair)}</b></td>
          <td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Покупка' : 'Продажа'}</td>
          <td class="muted">${o.type === 'limit' ? 'Лимит' : 'Рынок'}</td>
          <td class="num">${fmtNum(o.price, 0, 8)}</td>
          <td class="num">${fmtNum(o.qty, 0, 8)}</td>
          <td class="num hide-sm">${fmtNum(o.price * o.qty, 2, 2)}</td>
          <td class="num hide-sm muted">${fmtTime(o.ts)}</td>
          <td class="num"><button class="btn btn-ghost btn-sm" data-cancel="${o.id}">Отменить</button></td>
        </tr>`).join('')}
        </tbody></table>`;
    }

    /* ── Смена пары ── */
    function setPair(p) {
      pair = p;
      ({ base, quote } = market.splitPair(pair));
      history.replaceState(null, '', `#/trade/${pair}`);
      qs('[data-pairname]', el).textContent = pair.replace('-', ' / ');
      qsa('[data-blabel],[data-bsuffix]', el).forEach(n => n.textContent = base);
      qsa('[data-qlabel],[data-qsuffix]', el).forEach(n => n.textContent = quote);
      priceInp.value = market.pairPrice(pair).toFixed(priceDecimals(market.pairPrice(pair)));
      crosshair = null;
      updateFavBtn();
      paintAll();
    }

    function updateFavBtn() {
      const b = qs('[data-fav]', el);
      const on = store.isWatched(base);
      b.innerHTML = (on ? ICONS.starFilled : ICONS.star) +
        `<span>${on ? 'В избранном' : 'В избранное'}</span>`;
      b.classList.toggle('is-fav', on);
    }

    /* ── Общая перерисовка ── */
    const paintAll = () => { paintHead(); paintBook(); paintTrades(); paintOrders(); refreshPanel(); paintChart(); };
    const paintLive = () => { paintHead(); paintBook(); paintTrades(); paintChart(); refreshPanel(); };

    /* ── События ── */
    on(el, 'click', '[data-iv]', (_e, t) => {
      ivLabel = t.dataset.iv;
      qsa('[data-iv]', el).forEach(b => b.classList.toggle('on', b === t));
      paintChart();
    });

    on(el, 'click', '[data-s]', (_e, t) => {
      side = t.dataset.s;
      qsa('[data-s]', el).forEach(b => {
        const isOn = b === t;
        b.classList.toggle('on', isOn);
        b.classList.toggle('buy', isOn && side === 'buy');
        b.classList.toggle('sell', isOn && side === 'sell');
      });
      refreshPanel();
    });

    on(el, 'click', '[data-t]', (_e, t) => {
      type = t.dataset.t;
      qsa('[data-t]', el).forEach(b => b.classList.toggle('on', b === t));
      refreshPanel();
    });

    on(el, 'click', '[data-pct]', (_e, t) => {
      const pct = Number(t.dataset.pct) / 100;
      const px = currentPrice();
      if (!px) return;
      const q = side === 'buy'
        ? (store.available(quote) * pct) / px
        : store.available(base) * pct;
      qtyInp.value = q > 0 ? q.toFixed(ASSET_MAP[base]?.dec ?? 6).replace(/\.?0+$/, '') : '';
      refreshPanel();
    });

    on(el, 'click', '[data-obpx]', (_e, t) => {
      priceInp.value = Number(t.dataset.obpx).toFixed(priceDecimals(Number(t.dataset.obpx)));
      refreshPanel();
    });

    on(el, 'click', '[data-cancel]', (_e, t) => { store.cancelOrder(t.dataset.cancel); paintOrders(); });

    qs('[data-fav]', el).addEventListener('click', () => { store.toggleWatch(base); updateFavBtn(); });

    qs('[data-pairpick]', el).addEventListener('click', () => {
      const body = h(`<div>
        <div class="search-box" style="margin-bottom:12px">${ICONS.search}
          <input class="input" placeholder="Поиск пары" data-pq></div>
        <div class="picker-list" data-plist></div>
      </div>`);
      const listEl = qs('[data-plist]', body);
      const draw = (q = '') => {
        const rows = PAIRS.filter(p => p.toLowerCase().includes(q.toLowerCase()));
        listEl.innerHTML = rows.map(p => {
          const b = p.split('-')[0];
          const chg = market.pairChange(p);
          return `<div class="picker-item" data-p="${p}">
            ${coinIcon(b, 'sm')}
            <div><div style="font-weight:600;color:var(--ink)">${p.replace('-', ' / ')}</div>
                 <div class="muted" style="font-size:12px">${esc(ASSET_MAP[b]?.name || '')}</div></div>
            <div class="r"><div>${fmtNum(market.pairPrice(p), 0, 6)}</div>
                 <div class="${dirClass(chg)}" style="font-size:12px">${fmtPct(chg)}</div></div>
          </div>`;
        }).join('') || '<div class="empty">Пара не найдена</div>';
      };
      draw();
      const m = modal({ title: 'Выбор торговой пары', body });
      qs('[data-pq]', body).addEventListener('input', e => draw(e.target.value));
      on(body, 'click', '[data-p]', (_e, t) => { m.close(); setPair(t.dataset.p); });
    });

    /* ── Отправка ордера ── */
    submitBtn.addEventListener('click', () => {
      if (!store.isSignedIn()) {
        toast({ title: 'Нужен вход', msg: 'Войдите, чтобы торговать.', kind: 'warn' });
        location.hash = '#/signin';
        return;
      }
      const qty = parseAmount(qtyInp.value);
      const px = type === 'limit' ? parseAmount(priceInp.value) : market.pairPrice(pair);
      if (!qty) { toast({ title: 'Укажите количество', kind: 'err' }); return; }
      if (type === 'limit' && !px) { toast({ title: 'Укажите цену', kind: 'err' }); return; }

      try {
        store.placeOrder({ pair, side, type, price: px, qty });
        qtyInp.value = '';
        paintOrders();
        refreshPanel();
      } catch (e) {
        toast({ title: 'Ордер отклонён', msg: e.message, kind: 'err' });
      }
    });

    [priceInp, qtyInp].forEach(i => i.addEventListener('input', refreshPanel));

    /* ── Старт ── */
    priceInp.value = market.pairPrice(pair).toFixed(priceDecimals(market.pairPrice(pair)));
    updateFavBtn();
    paintAll();
    requestAnimationFrame(paintChart);

    const off = market.onTick(paintLive);
    const offStore = store.on('change', paintOrders);
    const onResize = () => paintChart();
    window.addEventListener('resize', onResize);

    el._cleanup = () => { off(); offStore(); window.removeEventListener('resize', onResize); };
    return el;
  },
};
