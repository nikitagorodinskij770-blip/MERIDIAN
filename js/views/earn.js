/* Earn — доходные продукты: сбережения и стейкинг. */

import { EARN_PRODUCTS, ASSET_MAP } from '../seed.js';
import * as market from '../market.js';
import * as store from '../store.js';
import { h, qs, qsa, on, coinIcon, modal, toast, ICONS, confirmModal } from '../ui.js';
import { fmtNum, fmtUSD, parseAmount, esc, fmtDate } from '../format.js';

export default {
  title: 'Доходные продукты',
  auth: false,

  render() {
    let filter = 'all';

    const el = h(`<div class="container section">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Earn</span>
          <h1 style="margin-top:8px">Доход на остатки</h1>
          <p class="muted">Сберегательные продукты и стейкинг. Начисление ежедневное,
             гибкие продукты можно закрыть в любой момент.</p>
        </div>
        <div class="row gap-3">
          <div class="tile stat" style="padding:12px 18px">
            <span class="k">В продуктах</span>
            <span class="v" style="font-size:20px" data-staked>—</span>
          </div>
          <div class="tile stat" style="padding:12px 18px">
            <span class="k">Начислено</span>
            <span class="v up" style="font-size:20px" data-accrued>—</span>
          </div>
        </div>
      </div>

      <!-- Мои позиции -->
      <div class="card" style="margin-bottom:26px" data-mybox>
        <div class="card-hd"><h4>Мои размещения</h4></div>
        <div data-positions></div>
      </div>

      <!-- Каталог -->
      <div class="sec-head">
        <div><h3>Доступные продукты</h3></div>
        <div class="chips" data-filters>
          ${['all', 'Сберегательный', 'Фиксированный', 'Стейкинг'].map(f =>
            `<button class="chip${f === 'all' ? ' on' : ''}" data-f="${esc(f)}">${f === 'all' ? 'Все' : f}</button>`).join('')}
        </div>
      </div>

      <div class="card table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Актив</th><th>Продукт</th><th class="num">Ставка</th>
            <th class="hide-sm">Срок</th><th class="num hide-sm">Минимум</th>
            <th class="hide-xs">Риск</th><th></th>
          </tr></thead>
          <tbody data-products></tbody>
        </table>
      </div>

      <div class="risk-note" style="margin-top:18px">
        Доходность не гарантирована и зависит от рыночных условий и работы сетей.
        Стейкинг предполагает риск слэшинга и период разблокировки.
      </div>
    </div>`);

    /* ── Каталог ── */
    function paintProducts() {
      const list = EARN_PRODUCTS.filter(p => filter === 'all' || p.kind === filter);
      qs('[data-products]', el).innerHTML = list.map((p, i) => `
        <tr>
          <td><div class="asset-cell">${coinIcon(p.asset)}
            <div><div class="name">${esc(p.asset)}</div>
                 <div class="sym">${esc(ASSET_MAP[p.asset]?.name || '')}</div></div></div></td>
          <td><span class="badge badge-neutral">${esc(p.kind)}</span></td>
          <td class="num"><b class="up" style="font-size:16px">${p.apy.toFixed(2)}%</b>
            <div class="muted" style="font-size:11px">годовых</div></td>
          <td class="hide-sm">${esc(p.term)}</td>
          <td class="num hide-sm">${fmtNum(p.min, 0, 4)} ${esc(p.asset)}</td>
          <td class="hide-xs"><span class="badge ${
            p.risk === 'Низкий' ? 'badge-up' : p.risk === 'Высокий' ? 'badge-down' : 'badge-neutral'}">${esc(p.risk)}</span></td>
          <td class="num"><button class="btn btn-soft btn-sm" data-sub="${i}">Разместить</button></td>
        </tr>`).join('');
    }

    /* ── Мои позиции ── */
    function paintPositions() {
      const list = store.earnPositions();
      const box = qs('[data-positions]', el);

      if (!store.isSignedIn()) {
        box.innerHTML = `<div class="empty" style="padding:30px">
          <div class="ic">${ICONS.lock}</div>
          <p>Войдите, чтобы размещать средства.</p>
          <a class="btn btn-primary" href="#/signin">Войти</a></div>`;
        return;
      }
      if (!list.length) {
        box.innerHTML = `<div class="empty" style="padding:30px">
          <div class="ic">${ICONS.layers}</div>
          <p style="margin:0">Активных размещений нет. Выберите продукт ниже.</p></div>`;
        return;
      }

      box.innerHTML = `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>Актив</th><th>Продукт</th><th class="num">Размещено</th>
          <th class="num">Начислено</th><th class="num hide-sm">Ставка</th>
          <th class="hide-sm">С даты</th><th></th></tr></thead>
        <tbody>${list.map(e => {
          const days = (Date.now() - e.since) / 86_400_000;
          const interest = e.amount * (e.apy / 100) * (days / 365);
          return `<tr>
            <td><div class="row gap-2">${coinIcon(e.asset, 'sm')} <b>${esc(e.asset)}</b></div></td>
            <td class="muted">${esc(e.kind)} · ${esc(e.term)}</td>
            <td class="num">${fmtNum(e.amount, 0, 6)}</td>
            <td class="num up">+${fmtNum(interest, 0, 8)}</td>
            <td class="num hide-sm">${e.apy.toFixed(2)}%</td>
            <td class="hide-sm muted" style="font-size:13px">${fmtDate(e.since)}</td>
            <td class="num"><button class="btn btn-ghost btn-sm" data-red="${e.id}">Забрать</button></td>
          </tr>`;
        }).join('')}</tbody></table></div>`;
    }

    function paintTotals() {
      const staked = store.earnPositions().reduce((s, e) => s + market.toUSD(e.asset, e.amount), 0);
      qs('[data-staked]', el).textContent = fmtUSD(staked);
      qs('[data-accrued]', el).textContent = fmtUSD(store.earnAccrued());
    }

    /* ── Размещение ── */
    function openSubscribe(p) {
      if (!store.isSignedIn()) {
        toast({ title: 'Нужен вход', msg: 'Войдите, чтобы продолжить.', kind: 'warn' });
        location.hash = '#/signin';
        return;
      }
      const avail = store.available(p.asset);
      const body = h(`<div>
        <div class="row gap-3" style="margin-bottom:18px">
          ${coinIcon(p.asset, 'lg')}
          <div><div style="color:var(--ink);font-weight:600">${esc(p.kind)} · ${esc(p.asset)}</div>
               <div class="muted" style="font-size:13px">${esc(p.term)} · риск ${esc(p.risk)}</div></div>
          <div style="margin-left:auto;text-align:right">
            <div class="up" style="font-size:22px;font-weight:700">${p.apy.toFixed(2)}%</div>
            <div class="muted" style="font-size:11px">годовых</div></div>
        </div>
        <div class="field">
          <div class="row between"><label>Сумма</label>
            <span class="help">Доступно: ${fmtNum(avail, 0, 6)} ${esc(p.asset)}</span></div>
          <div class="amount-input">
            <input type="text" inputmode="decimal" placeholder="0.00" data-eamt>
            <span class="suffix"><button class="btn-link" style="font-size:12px" data-emax>MAX</button> ${esc(p.asset)}</span>
          </div>
          <span class="help">Минимум ${fmtNum(p.min, 0, 4)} ${esc(p.asset)}</span>
        </div>
        <div class="rate-line"><span>Ожидаемый доход за год</span><b data-eyear>—</b></div>
        <div class="rate-line"><span>За 30 дней</span><b data-emonth>—</b></div>
      </div>`);

      const m = modal({
        title: 'Разместить средства',
        body,
        footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
                 <button class="btn btn-primary" data-ok>Разместить</button>`,
      });

      const inp = qs('[data-eamt]', body);
      const calc = () => {
        const v = parseAmount(inp.value);
        qs('[data-eyear]', body).textContent = v ? `${fmtNum(v * p.apy / 100, 0, 8)} ${p.asset}` : '—';
        qs('[data-emonth]', body).textContent = v ? `${fmtNum(v * p.apy / 100 * 30 / 365, 0, 8)} ${p.asset}` : '—';
      };
      inp.addEventListener('input', calc);
      qs('[data-emax]', body).addEventListener('click', () => {
        inp.value = fmtNum(avail, 0, 8).replace(/\s/g, ''); calc();
      });
      qs('[data-cancel]', m.node).addEventListener('click', m.close);
      qs('[data-ok]', m.node).addEventListener('click', () => {
        const v = parseAmount(inp.value);
        if (!v) { toast({ title: 'Введите сумму', kind: 'err' }); return; }
        if (v < p.min) { toast({ title: 'Сумма ниже минимума', msg: `Минимум ${p.min} ${p.asset}`, kind: 'err' }); return; }
        try {
          store.earnSubscribe(p, v);
          m.close();
          paintAll();
        } catch (e) {
          toast({ title: 'Не удалось разместить', msg: e.message, kind: 'err' });
        }
      });
    }

    /* ── События ── */
    on(el, 'click', '[data-f]', (_e, t) => {
      filter = t.dataset.f;
      qsa('[data-f]', el).forEach(b => b.classList.toggle('on', b === t));
      paintProducts();
    });
    on(el, 'click', '[data-sub]', (_e, t) => openSubscribe(EARN_PRODUCTS.filter(p =>
      filter === 'all' || p.kind === filter)[Number(t.dataset.sub)]));
    on(el, 'click', '[data-red]', async (_e, t) => {
      const ok = await confirmModal({
        title: 'Забрать средства',
        text: 'Позиция будет закрыта, начисленный доход зачислится на баланс.',
        okLabel: 'Забрать',
      });
      if (ok) { store.earnRedeem(t.dataset.red); paintAll(); }
    });
    on(el, 'click', '[data-demo]', () => { store.signIn(); paintAll(); });

    const paintAll = () => { paintProducts(); paintPositions(); paintTotals(); };
    paintAll();

    const off = market.onTick(paintTotals);
    const offStore = store.on('change', paintAll);
    el._cleanup = () => { off(); offStore(); };
    return el;
  },
};
