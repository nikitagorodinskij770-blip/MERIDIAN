/* Сводная цена — сравнение котировок шести бирж и расчёт опорного курса.
   Показывает работу алгоритма из PLAN.md §6.2: взвешенная по обороту медиана
   с отбраковкой выбросов по MAD. Данные реальные и публичные. */

import * as oracle from '../api/oracle.js';
import { h, qs, qsa, on, coinIcon, ICONS } from '../ui.js';
import { fmtNum, fmtPrice, fmtPct, fmtCompact, dirClass, esc, fmtTime } from '../format.js';

export default {
  title: 'Сводная цена',
  auth: false,

  render({ params }) {
    let asset = (params[0] || 'BTC').toUpperCase();
    if (!oracle.COVERED.includes(asset)) asset = 'BTC';
    let busy = false;

    const el = h(`<div class="container section">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Прайс-оракул</span>
          <h1 style="margin-top:8px">Сводная цена по биржам</h1>
          <p class="muted">Опрашиваем шесть площадок одновременно и считаем опорный курс:
             медиана, взвешенная по обороту, с отбраковкой выбросов по MAD.
             Одна биржа с тонкой ликвидностью не сдвинет результат.</p>
        </div>
        <button class="btn btn-ghost" data-refresh>${ICONS.refresh}Обновить</button>
      </div>

      <div class="chips" style="margin-bottom:20px" data-assets>
        ${oracle.COVERED.map(a => `<button class="chip${a === asset ? ' on' : ''}" data-a="${a}">${a}</button>`).join('')}
      </div>

      <div data-result></div>

      <div class="card card-pad" style="margin-top:22px">
        <h4 style="margin-bottom:10px">Как считается</h4>
        <ol class="muted" style="padding-left:20px;margin:0;font-size:14px;line-height:1.9">
          <li>Параллельный запрос ко всем площадкам, каждая — через свой ограничитель частоты.</li>
          <li>Медиана цен: устойчива к одному сломавшемуся источнику, в отличие от среднего.</li>
          <li>MAD — медианное абсолютное отклонение. Отбраковываем всё, что дальше 3·MAD
              (но не ближе 0.25%, иначе отсеклись бы нормальные расхождения).</li>
          <li>По выжившим считаем медиану, взвешенную по суточному обороту:
              вес голоса площадки равен её ликвидности.</li>
        </ol>
        <p class="help" style="margin-top:12px">
          Coinbase котирует к USD, остальные — к USDT, поэтому его цена систематически
          немного ниже. Это не ошибка, а разница инструмента.</p>
      </div>
    </div>`);

    const box = qs('[data-result]', el);

    const skeleton = () => {
      box.innerHTML = `<div class="card card-pad">
        <div class="skel" style="height:22px;width:40%;margin-bottom:14px"></div>
        ${'<div class="skel" style="height:44px;margin-bottom:8px"></div>'.repeat(6)}
      </div>`;
    };

    async function load() {
      if (busy) return;
      busy = true;
      skeleton();
      let q;
      try { q = await oracle.crossQuote(asset); }
      catch (e) { q = { ok: false, reason: String(e).slice(0, 90), venues: [] }; }
      busy = false;

      if (!q.ok) {
        box.innerHTML = `<div class="card"><div class="empty">
          <div class="ic">${ICONS.alert}</div>
          <h4 style="margin-bottom:6px">Котировки недоступны</h4>
          <p class="muted" style="margin:0">${esc(q.reason || 'площадки не ответили')}</p>
        </div></div>`;
        return;
      }

      const rows = [...q.venues].sort((a, b) => (b.price || 0) - (a.price || 0));

      box.innerHTML = `
        <div class="g-main" style="margin-bottom:20px">
          <div class="card card-pad">
            <div class="row gap-3" style="margin-bottom:6px">
              ${coinIcon(asset, 'lg')}
              <div>
                <div class="muted" style="font-size:13px">Опорная цена ${esc(asset)}</div>
                <div class="mono" style="font-size:34px;font-weight:700;color:var(--ink);line-height:1.1">
                  ${fmtPrice(q.price)}</div>
              </div>
            </div>
            <div class="row gap-6 wrap" style="margin-top:14px">
              <div class="th-stat"><span class="k">Площадок учтено</span>
                <span class="v">${q.used} из ${q.responded}</span></div>
              <div class="th-stat"><span class="k">Разброс</span>
                <span class="v">${fmtPrice(q.spreadAbs)} · ${q.spreadPct.toFixed(3)}%</span></div>
              <div class="th-stat"><span class="k">Обновлено</span>
                <span class="v">${fmtTime(q.ts)}</span></div>
            </div>
          </div>

          <div class="card card-pad">
            <h4 style="margin-bottom:12px">Статистика выборки</h4>
            <div class="rate-line"><span>Простая медиана</span><b>${fmtPrice(q.median)}</b></div>
            <div class="rate-line"><span>Взвешенная по обороту</span><b>${fmtPrice(q.price)}</b></div>
            <div class="rate-line"><span>MAD</span><b>${fmtPrice(q.mad)}</b></div>
            <div class="rate-line"><span>Порог отбраковки</span><b>±${fmtPrice(q.threshold)}</b></div>
            <div class="rate-line"><span>Лучший бид / аск</span>
              <b>${q.bestBid ? fmtNum(q.bestBid, 2, 2) : '—'} / ${q.bestAsk ? fmtNum(q.bestAsk, 2, 2) : '—'}</b></div>
            ${q.rejected.length
              ? `<div class="risk-note" style="margin-top:12px">Отбраковано: ${q.rejected.map(esc).join(', ')}</div>`
              : `<p class="help" style="margin-top:12px">Выбросов нет — все площадки в согласии.</p>`}
          </div>
        </div>

        <div class="card table-wrap">
          <table class="tbl">
            <thead><tr>
              <th>Площадка</th><th class="num">Цена</th><th class="num">Отклонение</th>
              <th class="num hide-sm">Бид / Аск</th><th class="num hide-sm">Оборот 24ч</th>
              <th class="num hide-xs">Отклик</th><th></th>
            </tr></thead>
            <tbody>
              ${rows.map(v => v.ok ? `
                <tr${v.rejected ? ' style="opacity:.55"' : ''}>
                  <td><b style="color:var(--ink)">${esc(v.name)}</b>
                      <div class="sym">${esc(asset)}/${esc(v.quote)}</div></td>
                  <td class="num mono">${fmtNum(v.price, 2, 6)}</td>
                  <td class="num mono ${dirClass(v.deviation)}">${fmtPct(v.deviationPct, 3)}</td>
                  <td class="num mono hide-sm">${v.bid ? fmtNum(v.bid, 2, 2) : '—'} / ${v.ask ? fmtNum(v.ask, 2, 2) : '—'}</td>
                  <td class="num hide-sm">${v.vol ? fmtCompact(v.vol) : '—'}</td>
                  <td class="num hide-xs muted">${v.ms} мс</td>
                  <td class="num">${v.rejected
                    ? '<span class="badge badge-down">выброс</span>'
                    : '<span class="badge badge-up">учтена</span>'}</td>
                </tr>`
                : `<tr style="opacity:.5">
                  <td><b>${esc(v.name)}</b></td>
                  <td class="num muted" colspan="5">${esc(v.error || 'нет ответа')}</td>
                  <td class="num"><span class="badge badge-neutral">пропуск</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    on(el, 'click', '[data-a]', (_e, t) => {
      asset = t.dataset.a;
      qsa('[data-a]', el).forEach(b => b.classList.toggle('on', b === t));
      history.replaceState(null, '', `#/oracle/${asset}`);
      load();
    });
    on(el, 'click', '[data-refresh]', load);

    el._mounted = load;
    return el;
  },
};
