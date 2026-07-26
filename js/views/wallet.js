/* Кошелёк — балансы, пополнение, вывод, история операций. */

import { ASSETS, ASSET_MAP } from '../seed.js';
import * as market from '../market.js';
import * as store from '../store.js';
import { h, qs, qsa, on, coinIcon, assetPicker, toast, ICONS, bindCopy, confirmModal, confirmAction } from '../ui.js';
import { fmtUSD, fmtNum, fmtPrice, fmtPct, dirClass, shortAddr, fmtDateTime, parseAmount, esc, timeAgo } from '../format.js';
import { validateAddress } from '../util/address.js';

const TABS = [
  { id: 'balances', label: 'Балансы' },
  { id: 'deposit',  label: 'Пополнить' },
  { id: 'withdraw', label: 'Вывести' },
  { id: 'history',  label: 'История' },
];

const TX_LABEL = {
  deposit: 'Пополнение', withdraw: 'Вывод', convert: 'Обмен',
  trade: 'Сделка', buy: 'Покупка картой', reward: 'Начисление', earn: 'Earn',
};

/** Псевдо-QR: детерминированный узор из адреса. Только для макета. */
function drawFakeQR(canvas, text) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const size = 150, cells = 25, cell = size / cells;
  canvas.width = size * dpr; canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#0b1220';

  let hsh = 2166136261;
  for (let i = 0; i < text.length; i++) { hsh ^= text.charCodeAt(i); hsh = Math.imul(hsh, 16777619); }
  let s = hsh >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;

  for (let y = 0; y < cells; y++)
    for (let x = 0; x < cells; x++)
      if (rnd() > 0.52) ctx.fillRect(x * cell, y * cell, cell, cell);

  // Реперные квадраты по углам
  const eye = (ox, oy) => {
    ctx.fillStyle = '#fff'; ctx.fillRect(ox * cell, oy * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#0b1220'; ctx.fillRect(ox * cell, oy * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#fff'; ctx.fillRect((ox + 1) * cell, (oy + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#0b1220'; ctx.fillRect((ox + 2) * cell, (oy + 2) * cell, 3 * cell, 3 * cell);
  };
  eye(0, 0); eye(cells - 7, 0); eye(0, cells - 7);
}

export default {
  title: 'Кошелёк',
  auth: true,
  authText: 'Войдите, чтобы управлять средствами.',

  render({ params }) {
    let tab = TABS.some(t => t.id === params[0]) ? params[0] : 'balances';
    let dAsset = 'USDT', dNet = 'TRC20';
    let wAsset = 'USDT', wNet = 'TRC20';
    let histFilter = 'all';

    const el = h(`<div class="container section">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Средства</span>
          <h1 style="margin-top:8px">Кошелёк</h1>
          <p class="muted">Пополнение и вывод по всем поддерживаемым сетям. Адрес формируется
             индивидуально для вашего счёта.</p>
        </div>
        <div class="tile stat" style="padding:14px 20px">
          <span class="k">Итого</span>
          <span class="v" style="font-size:22px" data-total>—</span>
        </div>
      </div>

      <div class="chips" style="margin-bottom:22px" data-tabs>
        ${TABS.map(t => `<button class="chip${t.id === tab ? ' on' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
      </div>

      <div data-panel></div>
    </div>`);

    const panel = qs('[data-panel]', el);

    /* ───────────────────── Балансы ───────────────────── */
    function viewBalances() {
      const hs = store.holdings();
      panel.innerHTML = `
        <div class="card">
          <div class="card-hd">
            <h4>Активы на счёте</h4>
            <div class="row gap-2">
              <button class="btn btn-soft btn-sm" data-go="deposit">Пополнить</button>
              <button class="btn btn-ghost btn-sm" data-go="withdraw">Вывести</button>
            </div>
          </div>
          ${hs.length ? `<div class="table-wrap"><table class="tbl">
            <thead><tr><th>Актив</th><th class="num">Доступно</th>
              <th class="num hide-sm">Цена</th><th class="num hide-sm">24ч</th>
              <th class="num">Стоимость</th><th></th></tr></thead>
            <tbody>${hs.map(hh => `<tr>
              <td><div class="asset-cell">${coinIcon(hh.id)}
                <div><div class="name">${esc(hh.id)}</div>
                     <div class="sym">${esc(ASSET_MAP[hh.id]?.name || '')}</div></div></div></td>
              <td class="num">${fmtNum(hh.amount, 0, ASSET_MAP[hh.id]?.dec ?? 6)}</td>
              <td class="num hide-sm" data-px="${hh.id}">${fmtPrice(market.price(hh.id))}</td>
              <td class="num hide-sm ${dirClass(market.change24(hh.id))}" data-chg="${hh.id}">${fmtPct(market.change24(hh.id))}</td>
              <td class="num"><b style="color:var(--ink)">${fmtUSD(hh.usd)}</b></td>
              <td class="num"><a class="btn btn-ghost btn-sm" href="#/convert">Обменять</a></td>
            </tr>`).join('')}</tbody></table></div>`
          : `<div class="empty"><div class="ic">${ICONS.wallet}</div>
               <p>Кошелёк пуст. Начните с пополнения.</p>
               <button class="btn btn-primary" data-go="deposit">Пополнить счёт</button></div>`}
        </div>`;
    }

    /* ───────────────────── Пополнение ───────────────────── */
    function viewDeposit() {
      const a = ASSET_MAP[dAsset];
      const nets = a.nets || a.rails || ['Внутренний перевод'];
      if (!nets.includes(dNet)) dNet = nets[0];
      const isCrypto = !!a.nets;
      const addr = isCrypto ? store.depositAddress(dAsset, dNet) : null;

      panel.innerHTML = `
        <div class="g-2">
          <div class="card card-pad">
            <h4 style="margin-bottom:18px">Пополнение счёта</h4>

            <div class="field">
              <label>Актив</label>
              <button class="asset-pick" data-pick style="width:100%;justify-content:space-between">
                <span class="row gap-2">${coinIcon(dAsset, 'sm')} <b>${esc(dAsset)}</b>
                  <span class="muted" style="font-weight:400">${esc(a.name)}</span></span>
                <span class="muted">${ICONS.chevronDown}</span>
              </button>
            </div>

            <div class="field">
              <label>${isCrypto ? 'Сеть' : 'Способ'}</label>
              <div class="chips">
                ${nets.map(n => `<button class="chip${n === dNet ? ' on' : ''}" data-net="${esc(n)}">${esc(n)}</button>`).join('')}
              </div>
              ${isCrypto ? `<span class="help">Отправляйте только ${esc(dAsset)} в сети ${esc(dNet)}.
                Средства в другой сети будут утеряны.</span>` : ''}
            </div>

            ${isCrypto ? `
              <canvas class="qr-fake" data-qr style="margin:18px auto"></canvas>
              <div class="field">
                <label>Адрес пополнения</label>
                <div class="addr-box">
                  <code>${esc(addr)}</code>
                  <button class="btn btn-ghost btn-sm" data-copy="${esc(addr)}">${ICONS.copy}</button>
                </div>
              </div>
              <div class="rate-line"><span>Минимальная сумма</span><b>${a.type === 'stable' ? '1' : '0.0001'} ${esc(dAsset)}</b></div>
              <div class="rate-line"><span>Подтверждений сети</span><b>${dNet === 'Bitcoin' ? '2' : '12'}</b></div>
            ` : `
              <div class="field">
                <label>Реквизиты</label>
                <div class="addr-box"><code>IBAN EE47 1000 0011 0233 5871 · ${esc(dAsset)}<br>
                  Получатель: Meridian Digital Assets OÜ<br>
                  Назначение: пополнение счёта ${esc(store.getState().user?.id || '')}</code></div>
              </div>
              <div class="rate-line"><span>Срок зачисления</span><b>1–2 рабочих дня</b></div>
            `}
          </div>

          <div class="card card-pad">
            <h4 style="margin-bottom:8px">Зачисление средств</h4>
            <p class="muted" style="font-size:13px">
              Укажите сумму перевода. Транзакция будет создана в статусе «в обработке»
              и зачислена после подтверждений сети.</p>

            <div class="field">
              <label>Сумма</label>
              <div class="amount-input">
                <input type="text" inputmode="decimal" placeholder="0.00" data-damt value="1000">
                <span class="suffix">${coinIcon(dAsset, 'sm')} ${esc(dAsset)}</span>
              </div>
              <span class="help" data-dusd>≈ —</span>
            </div>

            <div class="chips" style="margin-bottom:16px">
              ${['100', '1000', '5000'].map(v => `<button class="chip" data-quick="${v}">${v}</button>`).join('')}
            </div>

            <button class="btn btn-primary btn-block btn-lg" data-dodep>Подтвердить зачисление</button>

            <div style="margin-top:24px">
              <h5 class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.1em">
                Последние пополнения</h5>
              <div data-deps></div>
            </div>
          </div>
        </div>`;

      if (isCrypto) drawFakeQR(qs('[data-qr]', panel), addr);
      updateDepositUsd();
      paintDeps();
    }

    function updateDepositUsd() {
      const inp = qs('[data-damt]', panel);
      if (!inp) return;
      const v = parseAmount(inp.value);
      qs('[data-dusd]', panel).textContent = '≈ ' + fmtUSD(market.toUSD(dAsset, v));
    }

    function paintDeps() {
      const box = qs('[data-deps]', panel);
      if (!box) return;
      const list = store.transactions('deposit').slice(0, 4);
      box.innerHTML = list.length ? list.map(t => `
        <div class="tx-row" style="padding:10px 0">
          <div class="ic ${t.status === 'pending' ? 'tx-neu' : 'tx-in'}">${ICONS.arrowDown}</div>
          <div><div style="color:var(--ink);font-weight:600;font-size:13px">
                 +${fmtNum(t.amount, 0, 6)} ${esc(t.asset)}</div>
               <div class="muted" style="font-size:12px">${esc(t.network || '')} · ${timeAgo(t.ts)}</div></div>
          <span class="pill-status st-${t.status}">${t.status === 'completed' ? 'зачислено' : 'в сети'}</span>
        </div>`).join('')
        : '<p class="muted" style="font-size:13px;margin:8px 0 0">Пополнений пока не было.</p>';
    }

    /* ───────────────────── Вывод ───────────────────── */
    function viewWithdraw() {
      const a = ASSET_MAP[wAsset];
      const nets = a.nets || a.rails || ['Внутренний перевод'];
      if (!nets.includes(wNet)) wNet = nets[0];
      const fee = store.withdrawFee(wAsset, wNet);
      const avail = store.available(wAsset);

      panel.innerHTML = `
        <div class="g-2">
          <div class="card card-pad">
            <h4 style="margin-bottom:18px">Вывод средств</h4>

            <div class="field">
              <label>Актив</label>
              <button class="asset-pick" data-wpick style="width:100%;justify-content:space-between">
                <span class="row gap-2">${coinIcon(wAsset, 'sm')} <b>${esc(wAsset)}</b>
                  <span class="muted" style="font-weight:400">доступно ${fmtNum(avail, 0, 6)}</span></span>
                <span class="muted">${ICONS.chevronDown}</span>
              </button>
            </div>

            <div class="field">
              <label>Сеть</label>
              <div class="chips">
                ${nets.map(n => `<button class="chip${n === wNet ? ' on' : ''}" data-wnet="${esc(n)}">${esc(n)}</button>`).join('')}
              </div>
            </div>

            <div class="field">
              <label>Адрес получателя</label>
              <input class="input mono" placeholder="Вставьте адрес ${esc(wNet)}" data-waddr autocomplete="off" spellcheck="false">
              <div class="addr-verdict" data-averdict hidden></div>
              <span class="help">Контрольная сумма проверяется на лету — транзакции необратимы.
                <button class="btn-link" style="font-size:12px" data-genaddr>подставить тестовый</button></span>
            </div>

            <div class="field">
              <label>Сумма</label>
              <div class="amount-input">
                <input type="text" inputmode="decimal" placeholder="0.00" data-wamt>
                <span class="suffix">
                  <button class="btn-link" style="font-size:12px" data-wmax>MAX</button>
                  ${esc(wAsset)}</span>
              </div>
            </div>

            <div class="rate-line"><span>Комиссия сети</span><b>${fmtNum(fee, 0, 8)} ${esc(wAsset)}</b></div>
            <div class="rate-line"><span>К получению</span><b data-wnet-amt>—</b></div>
            <div class="rate-line"><span>Спишется со счёта</span><b data-wtotal>—</b></div>

            <button class="btn btn-primary btn-block btn-lg" style="margin-top:16px" data-dowd>
              Отправить заявку</button>
          </div>

          <div class="stack gap-4">
            <div class="card card-pad">
              <h4 style="margin-bottom:12px">Лимиты и безопасность</h4>
              <div class="rate-line"><span>Уровень верификации</span><b>${store.getState().user?.kyc ?? 0} · Базовый</b></div>
              <div class="rate-line"><span>Суточный лимит</span><b>$50 000</b></div>
              <div class="rate-line"><span>Использовано сегодня</span><b>$0.00</b></div>
              <div class="rate-line"><span>Двухфакторная защита</span>
                <b class="${store.getState().user?.twoFA ? 'up' : 'down'}">
                  ${store.getState().user?.twoFA ? 'включена' : 'выключена'}</b></div>
              <div class="risk-note" style="margin-top:14px">
                Вывод на новый адрес подтверждается по 2FA и электронной почте.
                Адреса, добавленные впервые, проходят суточную выдержку.
              </div>
            </div>

            <div class="card">
              <div class="card-hd"><h4>Последние выводы</h4></div>
              <div data-wds></div>
            </div>
          </div>
        </div>`;

      updateWithdrawCalc();
      paintWds();
    }

    function updateWithdrawCalc() {
      const inp = qs('[data-wamt]', panel);
      if (!inp) return;
      const v = parseAmount(inp.value);
      const fee = store.withdrawFee(wAsset, wNet);
      qs('[data-wnet-amt]', panel).textContent = v ? `${fmtNum(v, 0, 8)} ${wAsset}` : '—';
      qs('[data-wtotal]', panel).textContent = v ? `${fmtNum(v + fee, 0, 8)} ${wAsset}` : '—';
    }

    function paintWds() {
      const box = qs('[data-wds]', panel);
      if (!box) return;
      const list = store.transactions('withdraw').slice(0, 5);
      box.innerHTML = list.length ? list.map(t => `
        <div class="tx-row">
          <div class="ic tx-out">${ICONS.arrowUp}</div>
          <div><div style="color:var(--ink);font-weight:600;font-size:13px">
                 −${fmtNum(t.amount, 0, 6)} ${esc(t.asset)}</div>
               <div class="muted mono" style="font-size:12px">${shortAddr(t.address)} · ${esc(t.network || '')}</div></div>
          <span class="pill-status st-${t.status}">${t.status === 'completed' ? 'отправлено' : 'обработка'}</span>
        </div>`).join('')
        : `<div class="empty" style="padding:24px"><p style="margin:0;font-size:13px">Выводов не было</p></div>`;
    }

    /* ───────────────────── История ───────────────────── */
    function viewHistory() {
      const kinds = ['all', 'deposit', 'withdraw', 'trade', 'convert', 'buy', 'reward'];
      const list = store.transactions(histFilter === 'all' ? 'all' : histFilter);

      panel.innerHTML = `
        <div class="card">
          <div class="card-hd" style="flex-wrap:wrap;gap:12px">
            <h4>История операций</h4>
            <div class="chips">
              ${kinds.map(k => `<button class="chip${k === histFilter ? ' on' : ''}" data-hf="${k}">
                ${k === 'all' ? 'Все' : TX_LABEL[k]}</button>`).join('')}
            </div>
          </div>
          ${list.length ? `<div class="table-wrap"><table class="tbl">
            <thead><tr><th>Тип</th><th>Актив</th><th class="num">Сумма</th>
              <th class="hide-sm">Сеть / детали</th><th class="hide-sm">Хэш</th>
              <th class="num hide-xs">Дата</th><th class="num">Статус</th></tr></thead>
            <tbody>${list.map(t => `<tr>
              <td><b style="color:var(--ink)">${TX_LABEL[t.kind] || t.kind}</b></td>
              <td><div class="row gap-2">${coinIcon(t.asset, 'sm')} ${esc(t.asset)}</div></td>
              <td class="num ${t.amount >= 0 ? 'up' : 'down'}">
                ${t.amount >= 0 ? '+' : '−'}${fmtNum(Math.abs(t.amount), 0, 8)}</td>
              <td class="hide-sm muted" style="font-size:13px">${esc(t.network || t.note || '—')}</td>
              <td class="hide-sm mono" style="font-size:12px">
                ${t.txHash ? `<span data-copy="${esc(t.txHash)}" style="cursor:pointer" title="Скопировать">${shortAddr(t.txHash, 8, 6)}</span>` : '—'}</td>
              <td class="num hide-xs muted" style="font-size:12px">${fmtDateTime(t.ts)}</td>
              <td class="num"><span class="pill-status st-${t.status}">${
                t.status === 'completed' ? 'исполнено' : t.status === 'pending' ? 'в обработке' : 'ошибка'}</span></td>
            </tr>`).join('')}</tbody></table></div>`
          : `<div class="empty"><div class="ic">${ICONS.book}</div>
               <p>Операций с таким фильтром нет.</p></div>`}
        </div>`;
    }

    /* ───────────────────── Роутинг вкладок ───────────────────── */
    function paint() {
      qsa('[data-tab]', el).forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
      ({ balances: viewBalances, deposit: viewDeposit, withdraw: viewWithdraw, history: viewHistory }[tab])();
      qs('[data-total]', el).textContent = fmtUSD(store.portfolioValue());
    }

    /* ── События ── */
    on(el, 'click', '[data-tab]', (_e, t) => { tab = t.dataset.tab; paint(); });
    on(el, 'click', '[data-go]', (_e, t) => { tab = t.dataset.go; paint(); });

    // Пополнение
    on(el, 'click', '[data-pick]', () => assetPicker({
      title: 'Актив для пополнения',
      onPick: id => { dAsset = id; paint(); },
    }));
    on(el, 'click', '[data-net]', (_e, t) => { dNet = t.dataset.net; paint(); });
    on(el, 'input', '[data-damt]', updateDepositUsd);
    on(el, 'click', '[data-quick]', (_e, t) => {
      qs('[data-damt]', panel).value = t.dataset.quick;
      updateDepositUsd();
    });
    on(el, 'click', '[data-dodep]', () => {
      const v = parseAmount(qs('[data-damt]', panel).value);
      if (!v) { toast({ title: 'Введите сумму', kind: 'err' }); return; }
      store.deposit(dAsset, dNet, v);
      paintDeps();
    });

    // Вывод
    on(el, 'click', '[data-wpick]', () => assetPicker({
      title: 'Актив для вывода',
      filter: a => store.balance(a.id) > 0,
      onPick: id => { wAsset = id; paint(); },
    }));
    on(el, 'click', '[data-wnet]', (_e, t) => { wNet = t.dataset.wnet; paint(); });
    on(el, 'input', '[data-wamt]', updateWithdrawCalc);
    on(el, 'click', '[data-wmax]', () => {
      const max = Math.max(0, store.available(wAsset) - store.withdrawFee(wAsset, wNet));
      qs('[data-wamt]', panel).value = max > 0 ? fmtNum(max, 0, 8).replace(/\s/g, '') : '0';
      updateWithdrawCalc();
    });
    on(el, 'click', '[data-genaddr]', () => {
      qs('[data-waddr]', panel).value = store.genAddress(wNet);
      checkAddress();
    });

    /* Проверка контрольной суммы адреса прямо во время ввода.
       Асинхронная (Base58Check требует SHA-256 из WebCrypto), поэтому
       результат устаревших запусков отбрасываем по номеру поколения. */
    let addrGen = 0;
    let addrOk = false;

    async function checkAddress() {
      const inp = qs('[data-waddr]', panel);
      const box = qs('[data-averdict]', panel);
      if (!inp || !box) return;

      const value = inp.value.trim();
      const gen = ++addrGen;

      if (!value) {
        box.hidden = true;
        inp.classList.remove('input-bad', 'input-good');
        addrOk = false;
        return;
      }

      const v = await validateAddress(value, wNet);
      if (gen !== addrGen) return;          // пользователь успел напечатать ещё

      addrOk = v.valid;
      box.hidden = false;
      inp.classList.toggle('input-bad', !v.valid);
      inp.classList.toggle('input-good', v.valid);

      if (!v.valid) {
        box.className = 'addr-verdict bad';
        box.innerHTML = `${ICONS.alert}<span>${esc(v.reason || 'адрес некорректен')}</span>`;
      } else if (v.warning) {
        box.className = 'addr-verdict warn';
        box.innerHTML = `${ICONS.info}<span>${esc(v.warning)}</span>`;
      } else {
        box.className = 'addr-verdict good';
        const extra = v.checksum ? 'контрольная сумма сходится' : 'формат распознан';
        box.innerHTML = `${ICONS.circleCheck}<span>Адрес корректен — ${extra}</span>`;
      }
    }

    on(el, 'input', '[data-waddr]', checkAddress);
    on(el, 'click', '[data-dowd]', async () => {
      const addr = qs('[data-waddr]', panel).value.trim();
      const v = parseAmount(qs('[data-wamt]', panel).value);
      if (!addr) { toast({ title: 'Укажите адрес получателя', kind: 'err' }); return; }
      if (!v) { toast({ title: 'Введите сумму', kind: 'err' }); return; }

      // Повторная проверка перед отправкой: поле могли вставить программно
      const verdict = await validateAddress(addr, wNet);
      if (!verdict.valid) {
        toast({ title: 'Адрес не прошёл проверку', msg: verdict.reason, kind: 'err' });
        checkAddress();
        return;
      }

      // Перевод в чужую сеть необратим: ошибку в адресе не отменить и деньги
      // не вернуть. Поэтому здесь самое сильное трение в приложении — адрес
      // показывается целиком, а его конец надо набрать вручную. Это ловит
      // ровно ту атаку, ради которой воруют буфер обмена: подменённый адрес
      // выглядит похожим, но переписать его конец с экрана человек не сможет,
      // не заметив расхождения.
      const fee = store.withdrawFee(wAsset, wNet);
      const tail = addr.slice(-6);
      const ok = await confirmAction({
        title: 'Подтвердите вывод',
        intro: `Средства уйдут в сеть ${wNet}. Перевод необратим: отозвать его или изменить адрес после отправки невозможно.`,
        rows: [
          ['Актив', wAsset],
          ['Сеть', wNet],
          ['Адрес получателя', addr],
          ['Сумма', `${fmtNum(v, 0, 8)} ${wAsset}`],
          ['Комиссия сети', `${fmtNum(fee, 0, 8)} ${wAsset}`],
          ['Спишется со счёта', `${fmtNum(v + fee, 0, 8)} ${wAsset}`, 'total out'],
        ],
        warn: 'Сверьте адрес символ в символ. Вредоносные программы подменяют адрес в буфере обмена на похожий.',
        okLabel: 'Вывести средства',
        level: 'critical',
        confirmText: tail,
        confirmHint: `Введите последние 6 символов адреса (${tail}), чтобы подтвердить, что он верен`,
      });
      if (!ok) return;

      try {
        store.withdraw(wAsset, wNet, addr, v);
        qs('[data-wamt]', panel).value = '';
        paint();
      } catch (e) {
        toast({ title: 'Вывод отклонён', msg: e.message, kind: 'err' });
      }
    });

    // История
    on(el, 'click', '[data-hf]', (_e, t) => { histFilter = t.dataset.hf; paint(); });

    bindCopy(el);

    /* ── Живое обновление ── */
    const paintLive = () => {
      qs('[data-total]', el).textContent = fmtUSD(store.portfolioValue());
      qsa('[data-px]', el).forEach(td => td.textContent = fmtPrice(market.price(td.dataset.px)));
      qsa('[data-chg]', el).forEach(td => {
        const v = market.change24(td.dataset.chg);
        td.textContent = fmtPct(v);
        td.className = 'num hide-sm ' + dirClass(v);
      });
    };

    paint();
    const off = market.onTick(paintLive);
    const offStore = store.on('change', () => {
      if (tab === 'deposit') paintDeps();
      else if (tab === 'withdraw') paintWds();
      else paint();
    });

    el._cleanup = () => { off(); offStore(); };
    return el;
  },
};
