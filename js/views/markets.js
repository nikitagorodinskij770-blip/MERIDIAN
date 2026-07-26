/* Рынки — полный справочник инструментов: поиск, фильтры, сортировка, избранное. */

import { ASSETS, TYPE_LABELS } from '../seed.js';
import * as market from '../market.js';
import * as store from '../store.js';
import { h, qs, qsa, on, coinIcon, ICONS, changeBadge } from '../ui.js';
import { fmtPrice, fmtPct, fmtCompact, dirClass, esc, fmtNum } from '../format.js';
import { drawSparkline } from '../charts.js';

const TABS = [
  { id: 'all', label: 'Все' },
  { id: 'fav', label: 'Избранное' },
  { id: 'crypto', label: TYPE_LABELS.crypto },
  { id: 'stable', label: TYPE_LABELS.stable },
  { id: 'fiat', label: TYPE_LABELS.fiat },
  { id: 'metal', label: TYPE_LABELS.metal },
];

export default {
  title: 'Рынки',
  auth: false,

  render() {
    let tab = 'all';
    let query = '';
    // По умолчанию — капитализация, а не оборот. Оборот у нас синтетический,
    // и порядок по нему выносил наверх золото, USDT и серебро, оставляя
    // биткоин шестой строкой: витрина криптобиржи так выглядит сломанной.
    // Капитализация приходит из справочника и даёт ожидаемый порядок.
    let sortKey = 'mcap';
    let sortDir = -1;

    const el = h(`<div class="container section">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Котировки</span>
          <h1 style="margin-top:8px">Рынки</h1>
          <p class="muted">38 инструментов: криптовалюты, стейблкоины, фиат и драгоценные металлы.
             Котировки — агрегированные данные бирж.</p>
        </div>
        <div class="row gap-3">
          <div class="tile stat" style="padding:12px 18px">
            <span class="k">Активов в росте</span>
            <span class="v" style="font-size:20px" data-upcount>—</span>
          </div>
        </div>
      </div>

      <div class="market-toolbar">
        <div class="search-box">${ICONS.search}
          <input class="input" placeholder="Поиск: BTC, Ethereum, евро…" data-q>
        </div>
        <div class="chips" data-tabs>
          ${TABS.map(t => `<button class="chip${t.id === 'all' ? ' on' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
        </div>
      </div>

      <div class="card table-wrap">
        <table class="tbl">
          <thead><tr>
            <th style="width:38px"></th>
            <th data-sort="name">Актив</th>
            <th class="num" data-sort="price">Цена</th>
            <th class="num" data-sort="chg">24ч</th>
            <th class="num hide-sm" data-sort="vol">Объём 24ч</th>
            <th class="num hide-sm" data-sort="mcap">Капитализация</th>
            <th class="hide-xs">Динамика</th>
            <th></th>
          </tr></thead>
          <tbody data-rows></tbody>
        </table>
        <div class="empty" data-empty hidden>
          <div class="ic">${ICONS.search}</div>
          <p>Ничего не найдено. Измените запрос или фильтр.</p>
        </div>
      </div>

      <p class="help" style="margin-top:14px">
        Нажмите на строку, чтобы открыть терминал. Звёздочка добавляет актив в избранное —
        список сохраняется локально.
      </p>
    </div>`);

    const tbody = qs('[data-rows]', el);
    const emptyEl = qs('[data-empty]', el);

    /* ── Выборка и сортировка ── */
    const rows = () => {
      const st = store.getState();
      let list = ASSETS.filter(a => {
        if (tab === 'fav') return st.watchlist.includes(a.id);
        if (tab !== 'all') return a.type === tab;
        return true;
      });
      if (query) {
        const q = query.toLowerCase();
        list = list.filter(a => a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
      }
      const val = a => ({
        name: a.name, price: market.price(a.id), chg: market.change24(a.id),
        vol: market.volume24(a.id), mcap: a.mcap || 0,
      }[sortKey]);
      return list.sort((a, b) => {
        const va = val(a), vb = val(b);
        if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
        return (va - vb) * sortDir;
      });
    };

    /* ── Отрисовка таблицы ── */
    const paintTable = () => {
      const list = rows();
      emptyEl.hidden = list.length > 0;
      tbody.innerHTML = list.map(a => {
        const chg = market.change24(a.id);
        const fav = store.isWatched(a.id);
        const tradable = a.type !== 'fiat' || a.id === 'USD';
        return `<tr data-row="${a.id}">
          <td><button class="star${fav ? ' on' : ''}" data-fav="${a.id}" title="В избранное">${fav ? ICONS.starFilled : ICONS.star}</button></td>
          <td>
            <div class="asset-cell">${coinIcon(a.id)}
              <div><div class="name">${esc(a.id)}</div>
                   <div class="sym">${esc(a.name)}</div></div></div>
          </td>
          <td class="num" data-px="${a.id}">${fmtPrice(market.price(a.id))}</td>
          <td class="num" data-chg="${a.id}">${changeBadge(chg)}</td>
          <td class="num hide-sm" data-vol="${a.id}">${fmtCompact(market.volume24(a.id))}</td>
          <td class="num hide-sm">${a.mcap ? fmtCompact(a.mcap) : '—'}</td>
          <td class="hide-xs"><canvas class="spark" data-spark="${a.id}"></canvas></td>
          <td class="num">
            ${tradable
              ? `<a class="btn btn-soft btn-sm" href="#/trade/${a.id === 'USD' ? 'BTC-USD' : a.id + '-USDT'}">Торговать</a>`
              : `<a class="btn btn-ghost btn-sm" href="#/convert">Обменять</a>`}
          </td>
        </tr>`;
      }).join('');
      requestAnimationFrame(drawSparks);
    };

    const drawSparks = () => {
      qsa('[data-spark]', el).forEach(c => drawSparkline(c, market.sparkline(c.dataset.spark)));
    };

    /* ── Живое обновление цен без перестроения DOM ── */
    const paintLive = () => {
      qsa('[data-px]', el).forEach(td => td.textContent = fmtPrice(market.price(td.dataset.px)));
      qsa('[data-chg]', el).forEach(td => td.innerHTML = changeBadge(market.change24(td.dataset.chg)));
      qsa('[data-vol]', el).forEach(td => td.textContent = fmtCompact(market.volume24(td.dataset.vol)));
      qs('[data-upcount]', el).textContent =
        ASSETS.filter(a => market.change24(a.id) > 0).length + ' / ' + ASSETS.length;
      drawSparks();
    };

    /* ── События ── */
    qs('[data-q]', el).addEventListener('input', e => { query = e.target.value; paintTable(); });

    on(el, 'click', '[data-tab]', (_e, t) => {
      tab = t.dataset.tab;
      qsa('[data-tab]', el).forEach(b => b.classList.toggle('on', b === t));
      paintTable();
    });

    on(el, 'click', '[data-sort]', (_e, t) => {
      const k = t.dataset.sort;
      if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
      paintTable();
    });

    on(el, 'click', '[data-fav]', (e, t) => {
      e.stopPropagation();
      store.toggleWatch(t.dataset.fav);
      const now = store.isWatched(t.dataset.fav);
      t.classList.toggle('on', now);
      t.innerHTML = now ? ICONS.starFilled : ICONS.star;
      if (tab === 'fav') paintTable();
    });

    on(el, 'click', '[data-row]', (e, t) => {
      if (e.target.closest('a, button')) return;
      const id = t.dataset.row;
      const a = ASSETS.find(x => x.id === id);
      location.hash = (a.type === 'fiat' && id !== 'USD') ? '#/convert' : `#/trade/${id}-USDT`;
    });

    paintTable();
    paintLive();
    const off = market.onTick(paintLive);
    const onResize = () => drawSparks();
    window.addEventListener('resize', onResize);

    el._cleanup = () => { off(); window.removeEventListener('resize', onResize); };
    return el;
  },
};
