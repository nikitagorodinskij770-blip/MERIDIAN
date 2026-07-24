/* Главная — витрина: герой, живой тикер, рынки, преимущества, шаги, CTA. */

import { BRAND, ASSET_MAP } from '../seed.js';
import * as market from '../market.js';
import * as store from '../store.js';
import { h, qs, qsa, coinIcon, ICONS, changeBadge, assetCell } from '../ui.js';
import { fmtPrice, fmtPct, fmtCompact, dirClass, esc, fmtNum } from '../format.js';
import { drawSparkline } from '../charts.js';

const FEATURES = [
  { ic: 'bolt',   t: 'Исполнение за 12 мс',      d: 'Матчинг-движок с приоритетом «цена-время». Стакан обновляется в реальном времени, проскальзывание под контролем.' },
  { ic: 'shield', t: 'Кастоди и сегрегация',     d: 'MPC-хранение, 95% активов в холодном контуре, посуточная сверка резервов и публичный proof-of-reserves.' },
  { ic: 'globe',  t: '38 инструментов',           d: 'Криптовалюты, стейблкоины, 10 фиатных валют и драгоценные металлы — в одном счёте, без внешних переводов.' },
  { ic: 'trend',  t: 'Профессиональные графики',  d: 'Свечи, объёмы, стакан и лента сделок. Лимитные и рыночные ордера, история исполнений.' },
  { ic: 'lock',   t: 'Безопасность по умолчанию', d: '2FA, белые списки адресов, антифишинг-код, журнал сессий и подтверждение каждого вывода.' },
  { ic: 'layers', t: 'API для интеграций',        d: 'REST и WebSocket, ключи с гранулярными правами, лимиты и идемпотентность запросов.' },
];

const STEPS = [
  { t: 'Создайте счёт', d: 'Регистрация занимает минуту. Базовые операции доступны сразу, верификация — по мере роста лимитов.' },
  { t: 'Пополните баланс', d: 'Криптовалютой в 20+ сетях, картой или банковским переводом в десяти валютах.' },
  { t: 'Торгуйте и обменивайте', d: 'Мгновенный обмен в один клик или спот-терминал с полным стаканом заявок.' },
];

export default {
  title: 'Обменник цифровых активов',
  auth: false,

  render() {
    const top = market.topAssets(8, 'crypto');
    const { gainers, losers } = market.movers(4);
    const tickerAssets = market.topAssets(14, 'crypto');

    const el = h(`<div>

      <!-- ── Герой ─────────────────────────────────────────────── -->
      <section class="hero">
        <div class="container hero-grid">
          <div>
            <span class="eyebrow">Лицензированная площадка · ${esc(BRAND.stats.countries)} стран</span>
            <h1 style="margin-top:14px">Обменивайте цифровые активы<br><span class="accent">по опорному курсу</span></h1>
            <p class="lead">${esc(BRAND.name)} — обменник институционального уровня: спот-терминал, мгновенный
              обмен, фиатные шлюзы и доходные продукты в едином счёте.</p>
            <div class="cta-row">
              <a class="btn btn-primary btn-lg" href="#/signup">Открыть счёт</a>
              <a class="btn btn-ghost btn-lg" href="#/markets">Смотреть рынки</a>
            </div>
            <div class="trust-row">
              <span>${ICONS.shield} <b>Proof of Reserves</b></span>
              <span>Аптайм <b>${BRAND.stats.uptime}%</b></span>
              <span>Оборот 24ч <b>${fmtCompact(BRAND.stats.volume24h)}</b></span>
              <span><b>${fmtNum(BRAND.stats.users / 1e6, 2)} млн</b> клиентов</span>
            </div>
          </div>

          <!-- Мини-виджет обмена -->
          <div class="hero-panel">
            <div class="row between" style="margin-bottom:16px">
              <b style="color:var(--ink)">Быстрый обмен</b>
              <span class="badge badge-brand">курс live</span>
            </div>
            <div class="field">
              <label>Отдаёте</label>
              <div class="amount-input">
                <input type="text" inputmode="decimal" value="1000" data-from-amt>
                <span class="suffix">${coinIcon('USDT','sm')} USDT</span>
              </div>
            </div>
            <div class="field">
              <label>Получаете</label>
              <div class="amount-input">
                <input type="text" data-to-amt readonly style="color:var(--ink)">
                <span class="suffix">${coinIcon('BTC','sm')} BTC</span>
              </div>
            </div>
            <div class="rate-line"><span>Курс</span><b data-rate>—</b></div>
            <div class="rate-line"><span>Комиссия 0.35%</span><b data-fee>—</b></div>
            <a class="btn btn-primary btn-block btn-lg" href="#/convert" style="margin-top:12px">Перейти к обмену</a>
            <p class="help center" style="margin-top:10px">Предварительный расчёт. Средства спишутся после подтверждения.</p>
          </div>
        </div>
      </section>

      <!-- ── Бегущая строка ────────────────────────────────────── -->
      <div class="ticker">
        <div class="ticker-track" data-ticker></div>
      </div>

      <!-- ── Показатели ────────────────────────────────────────── -->
      <section class="section-tight">
        <div class="container stat-band">
          <div class="tile stat"><span class="k">Оборот за 24 часа</span><span class="v">${fmtCompact(BRAND.stats.volume24h)}</span></div>
          <div class="tile stat"><span class="k">Клиентов</span><span class="v">${fmtNum(BRAND.stats.users / 1e6, 2)}M</span></div>
          <div class="tile stat"><span class="k">Инструментов</span><span class="v">38</span></div>
          <div class="tile stat"><span class="k">Аптайм за год</span><span class="v">${BRAND.stats.uptime}%</span></div>
        </div>
      </section>

      <!-- ── Рынки ─────────────────────────────────────────────── -->
      <section class="section">
        <div class="container">
          <div class="sec-head">
            <div>
              <h2>Рынки в реальном времени</h2>
              <p class="muted">Топ инструментов по обороту. Цены обновляются каждые полторы секунды.</p>
            </div>
            <a class="btn btn-ghost" href="#/markets">Все 38 активов</a>
          </div>
          <div class="card table-wrap">
            <table class="tbl">
              <thead><tr>
                <th>Актив</th><th class="num">Цена</th><th class="num">24ч</th>
                <th class="num hide-sm">Объём 24ч</th><th class="num hide-sm">Капитализация</th>
                <th class="hide-xs">7 дней</th><th></th>
              </tr></thead>
              <tbody data-mkt>
                ${top.map(a => `
                  <tr data-goto="#/trade/${a.id}-USDT">
                    <td>${assetCell(a.id)}</td>
                    <td class="num" data-px="${a.id}">${fmtPrice(market.price(a.id))}</td>
                    <td class="num" data-chg="${a.id}">${changeBadge(market.change24(a.id))}</td>
                    <td class="num hide-sm" data-vol="${a.id}">${fmtCompact(market.volume24(a.id))}</td>
                    <td class="num hide-sm">${fmtCompact(a.mcap)}</td>
                    <td class="hide-xs"><canvas class="spark" data-spark="${a.id}"></canvas></td>
                    <td class="num"><a class="btn btn-soft btn-sm" href="#/trade/${a.id}-USDT">Торговать</a></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ── Лидеры движения ───────────────────────────────────── -->
      <section class="section-tight">
        <div class="container g-2">
          ${moverCard('Лидеры роста', gainers, 'up')}
          ${moverCard('Лидеры падения', losers, 'down')}
        </div>
      </section>

      <!-- ── Преимущества ──────────────────────────────────────── -->
      <section class="section">
        <div class="container">
          <div class="sec-head"><div>
            <span class="eyebrow">Платформа</span>
            <h2 style="margin-top:8px">Инфраструктура, а не витрина</h2>
            <p class="muted">Всё, что нужно и частному клиенту, и торговому столу.</p>
          </div></div>
          <div class="feature-grid">
            ${FEATURES.map(f => `
              <div class="feature">
                <div class="ic">${ICONS[f.ic]}</div>
                <h4>${esc(f.t)}</h4>
                <p>${esc(f.d)}</p>
              </div>`).join('')}
          </div>
        </div>
      </section>

      <!-- ── Как начать ────────────────────────────────────────── -->
      <section class="section-tight">
        <div class="container">
          <div class="sec-head"><div><h2>Три шага до первой сделки</h2></div></div>
          <div class="steps">
            ${STEPS.map(s => `<div class="step"><h4>${esc(s.t)}</h4><p class="muted">${esc(s.d)}</p></div>`).join('')}
          </div>
        </div>
      </section>

      <!-- ── CTA ───────────────────────────────────────────────── -->
      <section class="section">
        <div class="container">
          <div class="cta-band">
            <h2>Начните работу с MERIDIAN</h2>
            <p>Открытие счёта занимает минуту. Спот-терминал, мгновенный обмен и фиатные
               шлюзы доступны сразу после регистрации.</p>
            <div class="row gap-3" style="justify-content:center;margin-top:24px;flex-wrap:wrap">
              <a class="btn btn-primary btn-lg" href="#/signup">Открыть счёт</a>
              <a class="btn btn-ghost btn-lg" href="#/legal">Правовой центр</a>
            </div>
          </div>
        </div>
      </section>
    </div>`);

    /* ── Тикер ── */
    const track = qs('[data-ticker]', el);
    const tickerHtml = tickerAssets.map(a => `
      <span class="ticker-item" data-tick="${a.id}">
        ${coinIcon(a.id, 'sm')}
        <span class="sym">${a.id}</span>
        <span class="px">${fmtPrice(market.price(a.id))}</span>
        <span class="pct ${dirClass(market.change24(a.id))}">${fmtPct(market.change24(a.id))}</span>
      </span>`).join('');
    track.innerHTML = tickerHtml + tickerHtml;   // дублируем для бесшовной прокрутки

    /* ── Мини-конвертер ── */
    const fromInp = qs('[data-from-amt]', el);
    const toInp = qs('[data-to-amt]', el);
    const rateEl = qs('[data-rate]', el);
    const feeEl = qs('[data-fee]', el);

    const recalc = () => {
      const amt = parseFloat(String(fromInp.value).replace(',', '.')) || 0;
      const q = store.quoteConvert('USDT', 'BTC', amt);
      toInp.value = amt > 0 ? q.net.toFixed(8) : '';
      rateEl.textContent = '1 BTC = ' + fmtPrice(market.rate('BTC', 'USDT'), '') + ' USDT';
      feeEl.textContent = amt > 0 ? q.fee.toFixed(8) + ' BTC' : '—';
    };
    fromInp.addEventListener('input', recalc);
    recalc();

    /* ── Живое обновление ── */
    const paint = () => {
      qsa('[data-px]', el).forEach(td => {
        td.textContent = fmtPrice(market.price(td.dataset.px));
      });
      qsa('[data-chg]', el).forEach(td => {
        td.innerHTML = changeBadge(market.change24(td.dataset.chg));
      });
      qsa('[data-vol]', el).forEach(td => {
        td.textContent = fmtCompact(market.volume24(td.dataset.vol));
      });
      qsa('[data-tick]', el).forEach(sp => {
        const id = sp.dataset.tick;
        qs('.px', sp).textContent = fmtPrice(market.price(id));
        const p = qs('.pct', sp);
        p.textContent = fmtPct(market.change24(id));
        p.className = 'pct ' + dirClass(market.change24(id));
      });
      qsa('[data-mv]', el).forEach(n => {
        const id = n.dataset.mv;
        qs('.px', n).textContent = fmtPrice(market.price(id));
        const p = qs('.pct', n);
        p.textContent = fmtPct(market.change24(id));
        p.className = 'pct ' + dirClass(market.change24(id));
      });
      recalc();
      drawSparks();
    };

    const drawSparks = () => {
      qsa('[data-spark]', el).forEach(c => {
        const id = c.dataset.spark;
        drawSparkline(c, market.sparkline(id));
      });
    };

    requestAnimationFrame(drawSparks);
    const off = market.onTick(paint);

    /* ── Действия ── */
    qsa('[data-start]', el).forEach(b => b.addEventListener('click', () => {
      store.signIn();
      location.hash = '#/dashboard';
    }));
    qsa('[data-goto]', el).forEach(tr => tr.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      location.hash = tr.dataset.goto;
    }));

    const onResize = () => drawSparks();
    window.addEventListener('resize', onResize);

    el._cleanup = () => { off(); window.removeEventListener('resize', onResize); };
    return el;
  },
};

/* Карточка лидеров роста/падения */
function moverCard(title, list, kind) {
  return `<div class="card">
    <div class="card-hd"><h4>${title}</h4>
      <span class="badge ${kind === 'up' ? 'badge-up' : 'badge-down'}">24 часа</span></div>
    <div>
      ${list.map(a => `
        <div class="balance-row" data-mv="${a.id}" style="cursor:pointer"
             onclick="location.hash='#/trade/${a.id}-USDT'">
          <div class="asset-cell">${coinIcon(a.id)}
            <div><div class="name">${a.id}</div>
                 <div class="sym">${esc(ASSET_MAP[a.id].name)}</div></div></div>
          <div style="text-align:right">
            <div class="mono px">${fmtPrice(market.price(a.id))}</div>
            <div class="pct ${dirClass(market.change24(a.id))}">${fmtPct(market.change24(a.id))}</div>
          </div>
        </div>`).join('')}
    </div>
  </div>`;
}
