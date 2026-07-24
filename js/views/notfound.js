/* 404 — страница не найдена. */

import { h, ICONS } from '../ui.js';
import { esc } from '../format.js';

export default {
  title: 'Страница не найдена',
  auth: false,

  render({ error } = {}) {
    return h(`<div class="container section">
      <div class="card card-pad center" style="max-width:520px;margin:40px auto">
        <div class="empty" style="padding:12px 0">
          <div class="ic">${ICONS.search}</div>
          <div class="mono" style="font-size:52px;font-weight:700;color:var(--ink);line-height:1">404</div>
          <h3 style="margin:12px 0 8px">Страница не найдена</h3>
          <p class="muted" style="margin:0">
            Адрес <code class="mono">${esc(location.hash || '#/')}</code> не существует
            или раздел был перемещён.</p>
          ${error ? `<p class="help" style="margin-top:12px;color:var(--down)">
            Техническая причина: ${esc(error.message || String(error))}</p>` : ''}
        </div>
        <div class="row gap-3" style="justify-content:center;flex-wrap:wrap">
          <a class="btn btn-primary" href="#/">На главную</a>
          <a class="btn btn-ghost" href="#/markets">Рынки</a>
          <a class="btn btn-ghost" href="#/support">Поддержка</a>
        </div>
      </div>
    </div>`);
  },
};
