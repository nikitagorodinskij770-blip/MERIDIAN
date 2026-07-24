/* Мгновенный обмен — своп любого актива в любой по live-курсу. */

import { ASSET_MAP, CONFIG } from '../seed.js';
import * as market from '../market.js';
import * as store from '../store.js';
import { h, qs, qsa, on, coinIcon, assetPicker, toast, ICONS } from '../ui.js';
import { fmtNum, fmtPrice, fmtUSD, parseAmount, esc, timeAgo, fmtQty } from '../format.js';

const POPULAR = [
  ['USDT', 'BTC'], ['USDT', 'ETH'], ['BTC', 'USDT'],
  ['USD', 'USDT'], ['EUR', 'BTC'], ['ETH', 'SOL'],
];

export default {
  title: 'Мгновенный обмен',
  auth: false,

  render() {
    let from = 'USDT';
    let to = 'BTC';

    const el = h(`<div class="container section">
      <div class="sec-head" style="justify-content:center;text-align:center">
        <div>
          <span class="eyebrow">Обмен</span>
          <h1 style="margin-top:8px">Мгновенный обмен</h1>
          <p class="muted" style="margin-inline:auto">Любой актив в любой по рыночному курсу.
             Без стакана и лимитных заявок — фиксированная комиссия ${(CONFIG.convertFeeRate * 100).toFixed(2)}%.</p>
        </div>
      </div>

      <div class="card card-pad convert-card">
        <div class="swap-row">
          <div class="field" style="margin-bottom:8px">
            <div class="row between">
              <label>Отдаёте</label>
              <span class="help">Доступно: <b data-availfrom>—</b></span>
            </div>
            <div class="amount-input">
              <input type="text" inputmode="decimal" placeholder="0.00" data-amt>
              <button class="asset-pick" data-pickfrom>
                <span data-fromicon>${coinIcon(from, 'sm')}</span>
                <span data-fromid>${from}</span>${ICONS.chevronDown}
              </button>
            </div>
            <div class="row between" style="margin-top:6px">
              <span class="help" data-fromusd>≈ $0.00</span>
              <div class="row gap-2">
                ${[25, 50, 100].map(p => `<button class="btn-link" style="font-size:12px" data-pct="${p}">${p === 100 ? 'Всё' : p + '%'}</button>`).join('')}
              </div>
            </div>
          </div>

          <button class="swap-btn" data-swap title="Поменять местами">${ICONS.swap}</button>
        </div>

        <div class="field" style="margin-top:20px">
          <div class="row between">
            <label>Получаете</label>
            <span class="help">Баланс: <b data-availto>—</b></span>
          </div>
          <div class="amount-input">
            <input type="text" data-got readonly placeholder="0.00" style="color:var(--ink)">
            <button class="asset-pick" data-pickto>
              <span data-toicon>${coinIcon(to, 'sm')}</span>
              <span data-toid>${to}</span>${ICONS.chevronDown}
            </button>
          </div>
          <span class="help" style="margin-top:6px" data-tousd>≈ $0.00</span>
        </div>

        <div style="border-top:1px solid var(--line);margin:18px 0 12px;padding-top:14px">
          <div class="rate-line"><span>Курс</span><b data-rate>—</b></div>
          <div class="rate-line"><span>Комиссия сервиса</span><b data-fee>—</b></div>
          <div class="rate-line"><span>Вы получите</span><b data-net>—</b></div>
        </div>

        <button class="btn btn-primary btn-block btn-lg" data-do>Обменять</button>
        <p class="help center" style="margin-top:10px">
          Курс пересчитывается в реальном времени и фиксируется в момент подтверждения.</p>
      </div>

      <!-- Популярные направления -->
      <div style="max-width:500px;margin:32px auto 0">
        <h4 style="margin-bottom:12px">Популярные направления</h4>
        <div class="chips">
          ${POPULAR.map(([f, t]) => `<button class="chip" data-pair="${f}:${t}">${f} → ${t}</button>`).join('')}
        </div>
      </div>

      <!-- История обменов -->
      <div class="card" style="max-width:500px;margin:32px auto 0">
        <div class="card-hd"><h4>Последние обмены</h4></div>
        <div data-hist></div>
      </div>
    </div>`);

    const amtInp = qs('[data-amt]', el);
    const gotInp = qs('[data-got]', el);

    /* ── Пересчёт ── */
    function recalc() {
      const amt = parseAmount(amtInp.value);
      const q = store.quoteConvert(from, to, amt || 1);
      const dTo = ASSET_MAP[to]?.dec ?? 6;
      const dFrom = ASSET_MAP[from]?.dec ?? 6;

      qs('[data-rate]', el).textContent =
        `1 ${from} = ${fmtNum(market.rate(from, to), 0, 8)} ${to}`;

      if (amt > 0) {
        const real = store.quoteConvert(from, to, amt);
        gotInp.value = fmtNum(real.net, 0, dTo);
        qs('[data-fee]', el).textContent = `${fmtNum(real.fee, 0, dTo)} ${to}`;
        qs('[data-net]', el).textContent = `${fmtNum(real.net, 0, dTo)} ${to}`;
        qs('[data-fromusd]', el).textContent = '≈ ' + fmtUSD(market.toUSD(from, amt));
        qs('[data-tousd]', el).textContent = '≈ ' + fmtUSD(market.toUSD(to, real.net));
      } else {
        gotInp.value = '';
        qs('[data-fee]', el).textContent = '—';
        qs('[data-net]', el).textContent = '—';
        qs('[data-fromusd]', el).textContent = '≈ $0.00';
        qs('[data-tousd]', el).textContent = '≈ $0.00';
      }

      qs('[data-availfrom]', el).textContent = `${fmtNum(store.available(from), 0, dFrom)} ${from}`;
      qs('[data-availto]', el).textContent = `${fmtNum(store.balance(to), 0, dTo)} ${to}`;
    }

    /* ── Смена активов ── */
    function setFrom(id) {
      if (id === to) { to = from; }
      from = id;
      syncPickers();
    }
    function setTo(id) {
      if (id === from) { from = to; }
      to = id;
      syncPickers();
    }
    function syncPickers() {
      qs('[data-fromicon]', el).innerHTML = coinIcon(from, 'sm');
      qs('[data-fromid]', el).textContent = from;
      qs('[data-toicon]', el).innerHTML = coinIcon(to, 'sm');
      qs('[data-toid]', el).textContent = to;
      recalc();
    }

    /* ── История ── */
    function paintHist() {
      const list = store.transactions('convert').slice(0, 6);
      const box = qs('[data-hist]', el);
      if (!list.length) {
        box.innerHTML = `<div class="empty" style="padding:28px">
          <div class="ic">${ICONS.swap}</div>
          <p style="margin:0">Обменов пока нет.</p></div>`;
        return;
      }
      box.innerHTML = list.map(t => {
        const m = t.meta || {};
        return `<div class="tx-row">
          <div class="ic tx-neu">${ICONS.swap}</div>
          <div>
            <div style="color:var(--ink);font-weight:600">${esc(m.from || '?')} → ${esc(m.to || t.asset)}</div>
            <div class="muted" style="font-size:12px">${timeAgo(t.ts)}</div>
          </div>
          <div style="text-align:right">
            <div class="mono up">+${fmtNum(t.amount, 0, 8)} ${esc(t.asset)}</div>
            <div class="muted mono" style="font-size:12px">−${fmtNum(m.sent || 0, 0, 8)} ${esc(m.from || '')}</div>
          </div>
        </div>`;
      }).join('');
    }

    /* ── События ── */
    amtInp.addEventListener('input', recalc);

    qs('[data-pickfrom]', el).addEventListener('click', () =>
      assetPicker({ title: 'Актив для обмена', onPick: setFrom }));
    qs('[data-pickto]', el).addEventListener('click', () =>
      assetPicker({ title: 'Актив для получения', onPick: setTo }));

    qs('[data-swap]', el).addEventListener('click', () => {
      [from, to] = [to, from];
      syncPickers();
    });

    on(el, 'click', '[data-pct]', (_e, t) => {
      const pct = Number(t.dataset.pct) / 100;
      const v = store.available(from) * pct;
      amtInp.value = v > 0 ? fmtNum(v, 0, ASSET_MAP[from]?.dec ?? 6).replace(/\s/g, '') : '';
      recalc();
    });

    on(el, 'click', '[data-pair]', (_e, t) => {
      const [f, tt] = t.dataset.pair.split(':');
      from = f; to = tt;
      syncPickers();
    });

    qs('[data-do]', el).addEventListener('click', () => {
      if (!store.isSignedIn()) {
        toast({ title: 'Нужен вход', msg: 'Войдите, чтобы обменивать.', kind: 'warn' });
        location.hash = '#/signin';
        return;
      }
      const amt = parseAmount(amtInp.value);
      if (!amt) { toast({ title: 'Введите сумму', kind: 'err' }); return; }
      try {
        store.convert(from, to, amt);
        amtInp.value = '';
        recalc();
        paintHist();
      } catch (e) {
        toast({ title: 'Обмен не выполнен', msg: e.message, kind: 'err' });
      }
    });

    syncPickers();
    paintHist();
    const off = market.onTick(recalc);
    el._cleanup = () => off();
    return el;
  },
};
