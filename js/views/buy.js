/* Купить криптовалюту за фиат — фиатный шлюз.
   Реквизиты карты не проходят через площадку: оплата на стороне эквайера. */

import { ASSETS, ASSET_MAP, CONFIG } from '../seed.js';
import * as market from '../market.js';
import * as store from '../store.js';
import { h, qs, qsa, on, coinIcon, assetPicker, toast, ICONS, confirmAction } from '../ui.js';
import { fmtNum, fmtUSD, fmtPrice, parseAmount, esc, timeAgo } from '../format.js';

const METHODS = [
  { id: 'card', label: 'Банковская карта', fee: CONFIG.buyCardFeeRate, time: 'мгновенно', note: 'Visa / Mastercard / Мир', ic: 'card' },
  { id: 'sepa', label: 'Банковский перевод', fee: 0.004, time: '1–2 дня', note: 'SEPA / SWIFT / СБП', ic: 'bank' },
  { id: 'p2p',  label: 'P2P-площадка', fee: 0.000, time: '5–20 минут', note: 'Прямые сделки между клиентами', ic: 'exchange' },
];

const FIATS = ['USD', 'EUR', 'RUB', 'GBP', 'TRY', 'KZT', 'AED', 'UAH'];

export default {
  title: 'Купить криптовалюту',
  auth: false,

  render() {
    let fiat = 'USD';
    let asset = 'BTC';
    let method = 'card';

    const el = h(`<div class="container section">
      <div class="sec-head" style="justify-content:center;text-align:center">
        <div>
          <span class="eyebrow">Онрамп</span>
          <h1 style="margin-top:8px">Купить криптовалюту</h1>
          <p class="muted" style="margin-inline:auto">Оплата картой или банковским переводом
             в десяти валютах. Зачисление на биржевой счёт сразу после подтверждения платежа.</p>
        </div>
      </div>

      <div class="g-side" style="max-width:960px;margin-inline:auto">

        <!-- ── Форма покупки ─────────────────────────────── -->
        <div class="card card-pad">
          <div class="field">
            <div class="row between"><label>Вы платите</label>
              <span class="help">Мин. 10 · макс. 50 000</span></div>
            <div class="amount-input">
              <input type="text" inputmode="decimal" value="500" data-famt>
              <span class="suffix">
                <select class="select" data-fiat style="border:none;padding:0;width:auto;background:none">
                  ${FIATS.map(f => `<option value="${f}"${f === fiat ? ' selected' : ''}>${f}</option>`).join('')}
                </select>
              </span>
            </div>
            <div class="chips" style="margin-top:10px">
              ${[100, 500, 1000, 5000].map(v => `<button class="chip" data-quick="${v}">${v}</button>`).join('')}
            </div>
          </div>

          <div class="field">
            <label>Вы получаете</label>
            <div class="amount-input">
              <input type="text" data-recv readonly style="color:var(--ink)">
              <button class="asset-pick" data-pick>
                <span data-aicon>${coinIcon(asset, 'sm')}</span>
                <span data-aid>${asset}</span>${ICONS.chevronDown}
              </button>
            </div>
          </div>

          <div class="field">
            <label>Способ оплаты</label>
            <div class="stack gap-2">
              ${METHODS.map(m => `
                <label class="balance-row" style="border:1px solid var(--line);border-radius:var(--r-sm);cursor:pointer;padding:12px 14px">
                  <div class="row gap-3">
                    <input type="radio" name="pm" value="${m.id}"${m.id === method ? ' checked' : ''} data-m>
                    <span style="color:var(--brand);flex:none">${ICONS[m.ic]}</span>
                    <div>
                      <div style="color:var(--ink);font-weight:600">${esc(m.label)}</div>
                      <div class="muted" style="font-size:12px">${esc(m.note)} · ${esc(m.time)}</div>
                    </div>
                  </div>
                  <span class="badge badge-neutral">${(m.fee * 100).toFixed(2)}%</span>
                </label>`).join('')}
            </div>
          </div>

          <!-- Платёжный инструмент: реквизиты хранятся у эквайера, не у нас -->
          <div class="field" data-cardbox>
            <label>Платёжный инструмент</label>
            <div class="tile row between" style="padding:14px 16px">
              <div class="row gap-3">
                <span class="ic" style="width:38px;height:26px;border-radius:4px;background:linear-gradient(120deg,#0b1220,#2c3e63);display:grid;place-items:center;color:#fff">${ICONS.card}</span>
                <div>
                  <div class="mono" style="color:var(--ink);font-weight:600">•••• •••• •••• 4417</div>
                  <div class="muted" style="font-size:12px">Основной платёжный инструмент</div>
                </div>
              </div>
              <span class="badge badge-brand">Основная</span>
            </div>
            <span class="help">Реквизиты карты не хранятся на площадке: оплата проходит на защищённой
              странице эквайера с подтверждением 3-D Secure.</span>
          </div>

          <button class="btn btn-primary btn-block btn-lg" data-buy style="margin-top:8px">
            Купить <span data-blabel>BTC</span></button>
          <p class="help center" style="margin-top:10px">
            Нажимая кнопку, вы принимаете <a href="#/legal/terms">условия</a> и
            <a href="#/legal/risk">раскрытие рисков</a>.</p>
        </div>

        <!-- ── Сводка ────────────────────────────────────── -->
        <div class="stack gap-4">
          <div class="card card-pad">
            <h4 style="margin-bottom:14px">Детали заказа</h4>
            <div class="rate-line"><span>Курс</span><b data-rate>—</b></div>
            <div class="rate-line"><span>Сумма платежа</span><b data-sum>—</b></div>
            <div class="rate-line"><span>Комиссия сервиса</span><b data-fee>—</b></div>
            <div class="rate-line" style="border-top:1px solid var(--line);margin-top:8px;padding-top:12px">
              <span style="color:var(--ink);font-weight:600">К зачислению</span>
              <b style="font-size:16px" data-net>—</b></div>
            <div class="rate-line"><span>Срок</span><b data-time>мгновенно</b></div>
          </div>

          <div class="card card-pad">
            <h4 style="margin-bottom:12px">Лимиты покупки</h4>
            <div class="rate-line"><span>Разовая операция</span><b>50 000 USD</b></div>
            <div class="rate-line"><span>За сутки</span><b>100 000 USD</b></div>
            <div class="rate-line"><span>За месяц</span><b>500 000 USD</b></div>
            <p class="help" style="margin-top:10px">Лимиты зависят от уровня верификации.
              <a href="#/account">Повысить уровень</a></p>
          </div>

          <div class="card">
            <div class="card-hd"><h4>Последние покупки</h4></div>
            <div data-hist></div>
          </div>
        </div>
      </div>
    </div>`);

    const famt = qs('[data-famt]', el);

    function currentMethod() { return METHODS.find(m => m.id === method); }

    function recalc() {
      const v = parseAmount(famt.value);
      const m = currentMethod();
      const fee = v * m.fee;
      const net = v - fee;
      const received = net * market.rate(fiat, asset);
      const dec = ASSET_MAP[asset]?.dec ?? 6;

      qs('[data-recv]', el).value = v > 0 ? fmtNum(received, 0, dec) : '';
      qs('[data-rate]', el).textContent = `1 ${asset} = ${fmtNum(market.rate(asset, fiat), 0, 2)} ${fiat}`;
      qs('[data-sum]', el).textContent = v > 0 ? `${fmtNum(v, 2, 2)} ${fiat}` : '—';
      qs('[data-fee]', el).textContent = v > 0 ? `${fmtNum(fee, 2, 2)} ${fiat}` : '—';
      qs('[data-net]', el).textContent = v > 0 ? `${fmtNum(received, 0, dec)} ${asset}` : '—';
      qs('[data-time]', el).textContent = m.time;
      qs('[data-blabel]', el).textContent = asset;
      qs('[data-cardbox]', el).style.display = method === 'card' ? '' : 'none';
    }

    function paintHist() {
      const list = store.transactions('buy').slice(0, 5);
      const box = qs('[data-hist]', el);
      box.innerHTML = list.length ? list.map(t => `
        <div class="tx-row">
          <div class="ic tx-in">${ICONS.card}</div>
          <div><div style="color:var(--ink);font-weight:600;font-size:13px">
                 +${fmtNum(t.amount, 0, 6)} ${esc(t.asset)}</div>
               <div class="muted" style="font-size:12px">${timeAgo(t.ts)}</div></div>
          <span class="pill-status st-completed">оплачено</span>
        </div>`).join('')
        : `<div class="empty" style="padding:24px"><p style="margin:0;font-size:13px">Покупок пока нет</p></div>`;
    }

    /* ── События ── */
    famt.addEventListener('input', recalc);
    qs('[data-fiat]', el).addEventListener('change', e => { fiat = e.target.value; recalc(); });
    on(el, 'click', '[data-quick]', (_e, t) => { famt.value = t.dataset.quick; recalc(); });
    on(el, 'change', '[data-m]', (_e, t) => { method = t.value; recalc(); });
    qs('[data-pick]', el).addEventListener('click', () => assetPicker({
      title: 'Что купить',
      filter: a => a.type === 'crypto' || a.type === 'stable',
      onPick: id => {
        asset = id;
        qs('[data-aicon]', el).innerHTML = coinIcon(id, 'sm');
        qs('[data-aid]', el).textContent = id;
        recalc();
      },
    }));

    qs('[data-buy]', el).addEventListener('click', async () => {
      if (!store.isSignedIn()) {
        toast({ title: 'Нужен вход', msg: 'Войдите, чтобы купить.', kind: 'warn' });
        location.hash = '#/enter';
        return;
      }
      const v = parseAmount(famt.value);
      if (!v) { toast({ title: 'Введите сумму', kind: 'err' }); return; }
      if (v < 10) { toast({ title: 'Минимум 10', msg: `Сумма меньше минимальной для ${fiat}`, kind: 'err' }); return; }

      const feeAmt = v * CONFIG.buyCardFeeRate;
      const received = (v - feeAmt) * market.rate(fiat, asset);
      const ok = await confirmAction({
        title: 'Подтвердите покупку',
        intro: 'С карты спишется указанная сумма, актив зачислится на счёт по текущему курсу.',
        rows: [
          ['Списывается с карты', `${fmtNum(v, 2, 2)} ${fiat}`, 'out'],
          ['Комиссия сервиса', `${fmtNum(feeAmt, 2, 2)} ${fiat} · ${(CONFIG.buyCardFeeRate * 100).toFixed(2)}%`],
          ['Курс', `1 ${asset} = ${fmtNum(market.rate(asset, fiat), 2, 2)} ${fiat}`],
          ['Зачисляется', `${fmtNum(received, 0, 8)} ${asset}`, 'total in'],
        ],
        okLabel: `Купить ${asset}`,
      });
      if (!ok) return;

      const btn = qs('[data-buy]', el);
      btn.disabled = true;
      btn.textContent = 'Обработка платежа…';

      // Эмуляция редиректа на эквайер + 3-D Secure
      setTimeout(() => {
        try {
          store.buyWithCard(fiat, asset, v);
          paintHist();
        } catch (e) {
          toast({ title: 'Платёж отклонён', msg: e.message, kind: 'err' });
        }
        btn.disabled = false;
        btn.innerHTML = 'Купить <span data-blabel>' + esc(asset) + '</span>';
      }, 1400);
    });

    recalc();
    paintHist();
    const off = market.onTick(recalc);
    el._cleanup = () => off();
    return el;
  },
};
