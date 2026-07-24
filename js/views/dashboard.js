/* Личный кабинет — портфель, аллокация, динамика, быстрые действия, активность. */

import { ASSET_MAP } from '../seed.js';
import * as market from '../market.js';
import * as store from '../store.js';
import { h, qs, qsa, on, coinIcon, ICONS, changeBadge, assetCell } from '../ui.js';
import { fmtUSD, fmtNum, fmtPct, fmtPrice, dirClass, timeAgo, esc } from '../format.js';
import { drawDonut, drawArea, drawSparkline } from '../charts.js';

const TX_META = {
  deposit:  { ic: ICONS.arrowDown, cls: 'tx-in',  label: 'Пополнение' },
  withdraw: { ic: ICONS.arrowUp,   cls: 'tx-out', label: 'Вывод' },
  convert:  { ic: ICONS.swap,      cls: 'tx-neu', label: 'Обмен' },
  trade:    { ic: ICONS.chart,     cls: 'tx-neu', label: 'Сделка' },
  buy:      { ic: ICONS.card,      cls: 'tx-in',  label: 'Покупка картой' },
  reward:   { ic: ICONS.gift,      cls: 'tx-in',  label: 'Начисление' },
  earn:     { ic: ICONS.layers,    cls: 'tx-neu', label: 'Размещение' },
};

export default {
  title: 'Личный кабинет',
  auth: true,
  authText: 'Войдите, чтобы увидеть портфель и историю операций.',

  render() {
    const st = store.getState();

    const el = h(`<div class="container section">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Кабинет</span>
          <h1 style="margin-top:8px">Здравствуйте, ${esc((st.user?.name || 'клиент').split(' ')[0])}</h1>
          <p class="muted">Уровень верификации ${st.user?.kyc ?? 0} · тариф ${esc(st.user?.tier || 'VIP 0')}
             · счёт открыт ${new Date(st.user?.createdAt || Date.now()).toLocaleDateString('ru-RU')}</p>
        </div>
        <div class="row gap-2">
          <button class="btn btn-ghost btn-sm" data-hide>${st.settings.hideBalances ? 'Показать суммы' : 'Скрыть суммы'}</button>
          <a class="btn btn-ghost btn-sm" href="#/account">Настройки</a>
        </div>
      </div>

      <!-- ── Портфель ──────────────────────────────────────── -->
      <div class="portfolio-head" style="margin-bottom:24px">
        <div class="card card-pad">
          <div class="row between wrap gap-4" style="margin-bottom:18px">
            <div>
              <div class="muted" style="font-size:13px">Оценка портфеля</div>
              <div class="mono" style="font-size:34px;font-weight:700;color:var(--ink);line-height:1.1"
                   data-pv>—</div>
              <div class="row gap-2" style="margin-top:6px">
                <span data-pchg>—</span>
                <span class="muted" style="font-size:13px">за 24 часа</span>
              </div>
            </div>
            <div class="row gap-4">
              <div class="stat"><span class="k">Свободно</span><span class="v" style="font-size:18px" data-free>—</span></div>
              <div class="stat"><span class="k">В Earn</span><span class="v" style="font-size:18px" data-earn>—</span></div>
            </div>
          </div>
          <div class="chart-box" style="height:180px"><canvas data-area></canvas></div>
          <p class="help" style="margin:8px 0 0">Динамика построена по историческим ценам активов в портфеле.</p>
        </div>

        <div class="card card-pad">
          <h4 style="margin-bottom:16px">Распределение</h4>
          <div class="donut-wrap">
            <canvas data-donut style="width:170px;height:170px;flex:none"></canvas>
            <div class="legend" data-legend></div>
          </div>
        </div>
      </div>

      <!-- ── Быстрые действия ──────────────────────────────── -->
      <div class="quick-actions" style="margin-bottom:24px">
        <a class="qa" href="#/wallet"><span class="ic">${ICONS.arrowDown}</span>Пополнить</a>
        <a class="qa" href="#/wallet"><span class="ic">${ICONS.arrowUp}</span>Вывести</a>
        <a class="qa" href="#/convert"><span class="ic">${ICONS.swap}</span>Обменять</a>
        <a class="qa" href="#/buy"><span class="ic">${ICONS.card}</span>Купить картой</a>
      </div>

      <div class="g-main">

        <!-- ── Активы ──────────────────────────────────────── -->
        <div class="card">
          <div class="card-hd">
            <h4>Мои активы</h4>
            <a class="btn-link" href="#/wallet">Весь кошелёк →</a>
          </div>
          <div class="table-wrap" data-holdings></div>
        </div>

        <div class="stack gap-4">
          <!-- ── Открытые ордера ───────────────────────────── -->
          <div class="card">
            <div class="card-hd"><h4>Открытые ордера</h4>
              <span class="badge badge-neutral" data-ordn>0</span></div>
            <div data-orders></div>
          </div>

          <!-- ── Активность ────────────────────────────────── -->
          <div class="card">
            <div class="card-hd"><h4>Последняя активность</h4></div>
            <div data-activity></div>
          </div>
        </div>
      </div>
    </div>`);

    const hidden = () => store.getState().settings.hideBalances;
    const money = v => (hidden() ? '••••••' : fmtUSD(v));

    /* ── Сводка ── */
    function paintSummary() {
      const pv = store.portfolioValue();
      const chg = store.portfolioChange24();
      const earnUsd = store.earnPositions()
        .reduce((s, e) => s + market.toUSD(e.asset, e.amount), 0);

      qs('[data-pv]', el).textContent = money(pv);
      const c = qs('[data-pchg]', el);
      c.className = 'mono ' + dirClass(chg.pct);
      c.textContent = hidden() ? '••••' : `${fmtUSD(chg.abs, true)} (${fmtPct(chg.pct)})`;
      qs('[data-free]', el).textContent = money(pv);
      qs('[data-earn]', el).textContent = money(earnUsd);
    }

    /* ── Динамика портфеля из спарклайнов активов ── */
    function portfolioSeries() {
      const hs = store.holdings();
      if (!hs.length) return [];
      const len = market.sparkline(hs[0].id).length;
      const out = new Array(len).fill(0);
      hs.forEach(hh => {
        const sp = market.sparkline(hh.id);
        for (let i = 0; i < len; i++) out[i] += (sp[i] ?? sp[sp.length - 1] ?? 0) * hh.amount;
      });
      return out;
    }

    function paintCharts() {
      const series = portfolioSeries();
      const chg = store.portfolioChange24();
      drawArea(qs('[data-area]', el), series, {
        color: chg.pct >= 0 ? '#0ea75f' : '#e0323f',
      });

      const alloc = store.allocation(6);
      drawDonut(qs('[data-donut]', el), alloc, {
        centerTop: hidden() ? '••••' : fmtUSD(store.portfolioValue()),
        centerSub: `${store.holdings().length} актив(ов)`,
      });
      qs('[data-legend]', el).innerHTML = alloc.length
        ? alloc.map(s => `<div class="li">
            <span class="sw" style="background:${s.color}"></span>
            <b style="color:var(--ink);min-width:46px">${esc(s.id)}</b>
            <span class="muted mono">${s.pct.toFixed(1)}%</span>
          </div>`).join('')
        : '<span class="muted">Портфель пуст</span>';
    }

    /* ── Активы ── */
    function paintHoldings() {
      const hs = store.holdings();
      const box = qs('[data-holdings]', el);
      if (!hs.length) {
        box.innerHTML = `<div class="empty"><div class="ic">${ICONS.wallet}</div>
          <p>Активов нет. <a href="#/wallet">Пополните счёт</a>, чтобы начать.</p></div>`;
        return;
      }
      box.innerHTML = `<table class="tbl"><thead><tr>
          <th>Актив</th><th class="num">Количество</th>
          <th class="num">Цена</th><th class="num">24ч</th>
          <th class="num">Стоимость</th><th class="hide-sm">Динамика</th>
        </tr></thead><tbody>
        ${hs.map(hh => `<tr data-goto="#/trade/${hh.id}-USDT">
          <td>${assetCell(hh.id)}</td>
          <td class="num">${hidden() ? '••••' : fmtNum(hh.amount, 0, ASSET_MAP[hh.id]?.dec ?? 6)}</td>
          <td class="num" data-px="${hh.id}">${fmtPrice(market.price(hh.id))}</td>
          <td class="num" data-chg="${hh.id}">${changeBadge(market.change24(hh.id))}</td>
          <td class="num"><b style="color:var(--ink)">${money(hh.usd)}</b></td>
          <td class="hide-sm"><canvas class="spark" data-spark="${hh.id}"></canvas></td>
        </tr>`).join('')}
        </tbody></table>`;
      requestAnimationFrame(() =>
        qsa('[data-spark]', box).forEach(c => drawSparkline(c, market.sparkline(c.dataset.spark))));
    }

    /* ── Ордера ── */
    function paintOrders() {
      const list = store.openOrders();
      qs('[data-ordn]', el).textContent = list.length;
      const box = qs('[data-orders]', el);
      if (!list.length) {
        box.innerHTML = `<div class="empty" style="padding:26px">
          <p style="margin:0;font-size:13px">Нет активных заявок</p></div>`;
        return;
      }
      box.innerHTML = list.slice(0, 5).map(o => `
        <div class="balance-row">
          <div>
            <div style="color:var(--ink);font-weight:600">${esc(o.pair)}</div>
            <div class="${o.side === 'buy' ? 'up' : 'down'}" style="font-size:12px">
              ${o.side === 'buy' ? 'Покупка' : 'Продажа'} · ${fmtNum(o.qty, 0, 6)}</div>
          </div>
          <div style="text-align:right">
            <div class="mono">${fmtNum(o.price, 0, 6)}</div>
            <button class="btn-link" style="font-size:12px" data-cancel="${o.id}">Отменить</button>
          </div>
        </div>`).join('');
    }

    /* ── Активность ── */
    function paintActivity() {
      const list = store.transactions().slice(0, 6);
      const box = qs('[data-activity]', el);
      if (!list.length) {
        box.innerHTML = `<div class="empty" style="padding:26px">
          <p style="margin:0;font-size:13px">Операций пока нет</p></div>`;
        return;
      }
      box.innerHTML = list.map(t => {
        const m = TX_META[t.kind] || TX_META.trade;
        const pos = t.amount >= 0;
        return `<div class="tx-row">
          <div class="ic ${m.cls}">${m.ic}</div>
          <div>
            <div style="color:var(--ink);font-weight:600;font-size:13px">${m.label}</div>
            <div class="muted" style="font-size:12px">${timeAgo(t.ts)}</div>
          </div>
          <div style="text-align:right">
            <div class="mono ${pos ? 'up' : 'down'}" style="font-size:13px">
              ${pos ? '+' : '−'}${fmtNum(Math.abs(t.amount), 0, 6)} ${esc(t.asset)}</div>
            <span class="pill-status st-${t.status}">${
              t.status === 'completed' ? 'исполнено' : t.status === 'pending' ? 'в обработке' : 'ошибка'}</span>
          </div>
        </div>`;
      }).join('');
    }

    /* ── Живые цены в таблице активов ── */
    function paintLive() {
      qsa('[data-px]', el).forEach(td => td.textContent = fmtPrice(market.price(td.dataset.px)));
      qsa('[data-chg]', el).forEach(td => td.innerHTML = changeBadge(market.change24(td.dataset.chg)));
      paintSummary();
      paintCharts();
    }

    const paintAll = () => {
      paintSummary(); paintHoldings(); paintOrders(); paintActivity();
      requestAnimationFrame(paintCharts);
    };

    /* ── События ── */
    qs('[data-hide]', el).addEventListener('click', e => {
      store.updateSettings({ hideBalances: !hidden() });
      e.target.textContent = hidden() ? 'Показать суммы' : 'Скрыть суммы';
      paintAll();
    });
    on(el, 'click', '[data-cancel]', (_e, t) => store.cancelOrder(t.dataset.cancel));
    on(el, 'click', '[data-goto]', (e, t) => {
      if (e.target.closest('a,button')) return;
      location.hash = t.dataset.goto;
    });

    paintAll();
    const off = market.onTick(paintLive);
    const offStore = store.on('change', paintAll);
    const onResize = () => paintCharts();
    window.addEventListener('resize', onResize);

    el._cleanup = () => { off(); offStore(); window.removeEventListener('resize', onResize); };
    return el;
  },
};
