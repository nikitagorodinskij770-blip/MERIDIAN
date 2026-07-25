/* Центр уведомлений — события безопасности, операций и сообщений площадки. */

import { API } from '../api/adapter.js';
import * as session from '../core/session.js';
import { h, qs, qsa, on, toast, ICONS } from '../ui.js';
import { fmtDateTime, timeAgo, esc } from '../format.js';

const KIND = {
  security:    ['Безопасность', 'shieldLock'],
  transaction: ['Операции',     'wallet'],
  order:       ['Заявки',       'chart'],
  system:      ['Система',      'settings'],
  support:     ['Поддержка',    'support'],
  account:     ['Счёт',         'user'],
  promo:       ['Предложения',  'gift'],
};

const FILTERS = [
  ['all', 'Все'], ['unread', 'Непрочитанные'],
  ['security', 'Безопасность'], ['transaction', 'Операции'], ['support', 'Поддержка'],
];

export default {
  title: 'Уведомления',
  auth: true,
  authText: 'Войдите, чтобы видеть уведомления по счёту.',

  render({ params }) {
    let filter = FILTERS.some(f => f[0] === params[0]) ? params[0] : 'all';
    let items = [];

    const el = h(`<div class="container section-tight">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Центр уведомлений</span>
          <h1 style="margin-top:var(--sp-2)">Уведомления</h1>
          <p class="muted">События по счёту: входы с новых устройств, движение средств,
             ответы поддержки и сообщения площадки.</p>
        </div>
        <button class="btn btn-ghost" data-readall>${ICONS.check}Отметить все прочитанными</button>
      </div>

      <nav class="seg-nav" data-filters>
        ${FILTERS.map(([k, l]) => `<button class="seg-item${k === filter ? ' on' : ''}" data-f="${k}">
          <span>${l}</span></button>`).join('')}
      </nav>

      <div class="card" data-list>
        <div class="skel" style="height:200px;margin:var(--sp-4)"></div>
      </div>
    </div>`);

    async function load() {
      items = await API.get('/notifications');
      paint();
    }

    function paint() {
      const box = qs('[data-list]', el);
      let rows = items;
      if (filter === 'unread') rows = items.filter(n => !n.read);
      else if (filter !== 'all') rows = items.filter(n => n.kind === filter);

      if (!rows.length) {
        box.innerHTML = `<div class="empty" style="padding:var(--sp-16)">
          <div class="ic">${ICONS.bell}</div>
          <h3 style="margin-bottom:var(--sp-2)">Здесь пусто</h3>
          <p class="muted" style="margin:0">${filter === 'unread'
            ? 'Все уведомления прочитаны.' : 'Уведомлений в этой категории нет.'}</p></div>`;
        return;
      }

      box.innerHTML = rows.map(n => {
        const [label, icon] = KIND[n.kind] || ['Прочее', 'info'];
        return `<div class="notif-row${n.read ? '' : ' unread'}" data-n="${n.id}">
          <div class="ic ic-${n.level}">${ICONS[icon] || ICONS.info}</div>
          <div>
            <div class="t-main">${esc(n.title)}</div>
            ${n.body ? `<div class="t-sub" style="font-size:var(--fs-sm);color:var(--text);
              margin-top:var(--sp-1);line-height:var(--lh-snug)">${esc(n.body)}</div>` : ''}
            <div class="t-sub" style="margin-top:var(--sp-2)">
              ${label} · ${timeAgo(n.createdAt)}
              ${n.link ? ` · <a href="${esc(n.link)}">перейти</a>` : ''}</div>
          </div>
          <div style="text-align:right">
            <div class="muted" style="font-size:var(--fs-2xs)">${fmtDateTime(n.createdAt)}</div>
            ${n.read ? '' : `<button class="btn-link" style="font-size:var(--fs-xs);margin-top:var(--sp-2)"
              data-read="${n.id}">Прочитано</button>`}
          </div>
        </div>`;
      }).join('');
    }

    on(el, 'click', '[data-f]', (_e, t) => {
      filter = t.dataset.f;
      qsa('[data-f]', el).forEach(b => b.classList.toggle('on', b === t));
      history.replaceState(null, '', `#/notifications/${filter}`);
      paint();
    });

    on(el, 'click', '[data-read]', async (e, t) => {
      e.stopPropagation();
      await session.markRead(t.dataset.read);
      const n = items.find(x => x.id === t.dataset.read);
      if (n) n.read = true;
      paint();
    });

    on(el, 'click', '[data-readall]', async () => {
      const r = await session.markRead();
      items.forEach(n => n.read = true);
      paint();
      toast({ title: 'Отмечено прочитанными', msg: `Уведомлений: ${r.marked}`, kind: 'ok' });
    });

    // Клик по строке ведёт по ссылке уведомления и заодно отмечает прочитанным
    on(el, 'click', '[data-n]', async (e, t) => {
      if (e.target.closest('a, button')) return;
      const n = items.find(x => x.id === t.dataset.n);
      if (!n) return;
      if (!n.read) { await session.markRead(n.id); n.read = true; paint(); }
      if (n.link) location.hash = n.link.replace(/^#/, '');
    });

    el._mounted = load;
    return el;
  },
};
