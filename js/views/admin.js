/* Панель оператора — клиенты, поддержка, сотрудники, аналитика, журнал.
   Работает на серверных данных с разграничением прав: сотрудник видит
   ровно то, на что ему выданы полномочия. */

import { API } from '../api/sign.js';
import * as session from '../core/session.js';
import { h, qs, qsa, on, modal, toast, ICONS, confirmModal, bindCopy, coinIcon } from '../ui.js';
import { fmtUSD, fmtNum, fmtPct, fmtDateTime, timeAgo, esc, dirClass } from '../format.js';
import { drawBars, drawDonut, drawArea } from '../charts.js';

const TABS = [
  { id: 'analytics', label: 'Аналитика',   ic: 'chart' },
  { id: 'users',     label: 'Клиенты',     ic: 'user' },
  { id: 'support',   label: 'Поддержка',   ic: 'support' },
  { id: 'staff',     label: 'Сотрудники',  ic: 'userCheck' },
  { id: 'audit',     label: 'Журнал',      ic: 'book' },
];

const STATUS_UI = {
  active:  ['активен', 'st-completed'], blocked: ['заблокирован', 'st-failed'],
  pending: ['ожидает', 'st-pending'],   closed:  ['закрыт', 'st-failed'],
};
const DEPARTMENTS = {
  support: 'Поддержка', compliance: 'Комплаенс', finance: 'Финансы',
  engineering: 'Инженерия', management: 'Руководство',
};
const TICKET_STATUS = {
  open: 'Открыто', pending: 'Ждёт ответа', answered: 'Есть ответ',
  resolved: 'Решено', closed: 'Закрыто',
};

export default {
  title: 'Панель оператора',
  auth: true,
  authText: 'Раздел доступен сотрудникам площадки.',

  render({ params }) {
    const me = session.get().user || {};
    if (!['admin', 'support'].includes(me.role)) {
      return h(`<div class="container section">
        <div class="card card-pad center" style="max-width:520px;margin-inline:auto">
          <div class="empty"><div class="ic">${ICONS.lock}</div>
            <h3 style="margin-bottom:var(--sp-2)">Доступ ограничен</h3>
            <p class="muted" style="margin:0">Раздел предназначен для сотрудников площадки.
               Если вам нужен доступ — обратитесь к администратору.</p></div>
          <a class="btn btn-primary" href="#/cabinet">В личный кабинет</a>
        </div></div>`);
    }

    let tab = TABS.some(t => t.id === params[0]) ? params[0] : 'analytics';
    let repaint = null;
    let permissions = {}, presets = {};

    const el = h(`<div class="container-wide section-tight">
      <div class="cover cover-admin cover-pad" style="margin-bottom:var(--sp-6)">
        <span class="eyebrow">Операционный контур</span>
        <h1 style="margin:var(--sp-3) 0 var(--sp-2)">Панель оператора</h1>
        <p style="margin:0;max-width:58ch">Управление клиентами, обращениями и сотрудниками.
           Каждое действие попадает в журнал аудита с указанием исполнителя и основания.</p>
        <div class="cover-stats" data-coverstats></div>
      </div>

      <nav class="seg-nav" data-tabs>
        ${TABS.map(t => `<button class="seg-item${t.id === tab ? ' on' : ''}" data-tab="${t.id}">
          ${ICONS[t.ic]}<span>${t.label}</span></button>`).join('')}
      </nav>

      <div data-panel></div>
    </div>`);

    const panel = qs('[data-panel]', el);

    /* ═══════════════ Аналитика ═══════════════ */
    async function viewAnalytics() {
      const a = await API.get('/admin/analytics?days=30');

      qs('[data-coverstats]', el).innerHTML = `
        <div class="cs"><span class="k">Клиентов</span><span class="v">${a.totals.users}</span></div>
        <div class="cs"><span class="k">Активных</span><span class="v">${a.totals.active}</span></div>
        <div class="cs"><span class="k">Обращений</span><span class="v">${a.totals.openTickets}</span></div>
        <div class="cs"><span class="k">Сотрудников</span><span class="v">${a.totals.staff}</span></div>`;

      panel.innerHTML = `
        <div class="grid-auto" style="margin-bottom:var(--sp-5)">
          ${[['Регистрации', 'signups', '#1e59ff'], ['Входы', 'logins', '#087f43'],
             ['Сделки', 'trades', '#a8791f'], ['Обращения', 'tickets', '#c8102e']]
            .map(([label, key, color], i) => `
            <div class="card card-pad stat-card">
              <span class="k">${label} за 30 дней</span>
              <span class="v">${a.series[key].reduce((s, x) => s + x, 0)}</span>
              <div class="chart-box" style="height:56px"><canvas data-mini="${i}"></canvas></div>
            </div>`).join('')}
        </div>

        <div class="g-main" style="margin-bottom:var(--sp-5)">
          <div class="card card-pad">
            <div class="row between" style="margin-bottom:var(--sp-4)">
              <h3>Динамика площадки</h3>
              <div class="segment" data-series>
                ${[['signups', 'Регистрации'], ['logins', 'Входы'],
                   ['trades', 'Сделки'], ['tickets', 'Обращения']]
                  .map(([k, l], i) => `<button data-s="${k}"${i === 0 ? ' class="on"' : ''}>${l}</button>`).join('')}
              </div>
            </div>
            <div class="chart-box" style="height:250px"><canvas data-big></canvas></div>
          </div>

          <div class="card card-pad">
            <h3 style="margin-bottom:var(--sp-4)">Уровни верификации</h3>
            <div class="donut-wrap">
              <canvas data-kyc style="width:150px;height:150px;flex:none"></canvas>
              <div class="legend">
                ${a.byKyc.map((n, i) => `<div class="li">
                  <span class="sw" style="background:${['#c8ccd4','#a8791f','#1e59ff','#087f43'][i]}"></span>
                  <b style="min-width:76px">Уровень ${i}</b>
                  <span class="muted mono">${n}</span></div>`).join('')}
              </div>
            </div>
          </div>
        </div>

        <div class="g-2">
          <div class="card">
            <div class="card-hd"><h3>География и устройства</h3></div>
            <div class="card-pad">
              <h4 style="font-size:var(--fs-sm);color:var(--muted);margin-bottom:var(--sp-3)">Страны</h4>
              ${a.byCountry.length ? a.byCountry.map(c => `
                <div class="kv"><span>${esc(c.name)}</span>
                  <span class="row gap-3" style="flex:1;justify-content:flex-end">
                    <span class="bar-mini"><i style="width:${(c.count / a.byCountry[0].count * 100).toFixed(0)}%"></i></span>
                    <b style="min-width:30px;text-align:right">${c.count}</b></span></div>`).join('')
                : '<p class="muted">Нет данных</p>'}
              <h4 style="font-size:var(--fs-sm);color:var(--muted);margin:var(--sp-5) 0 var(--sp-3)">Устройства</h4>
              ${a.byDevice.map(d => `<div class="kv"><span>${esc(d.name)}</span><b>${d.count}</b></div>`).join('')}
            </div>
          </div>

          <div class="card">
            <div class="card-hd"><h3>Состояние системы</h3></div>
            <div class="card-pad">
              <div class="kv"><span>Открытых заявок</span><b>${a.totals.openOrders}</b></div>
              <div class="kv"><span>Исполнений за период</span><b>${a.totals.fills}</b></div>
              <div class="kv"><span>Пополнений</span><b>${a.totals.deposits}</b></div>
              <div class="kv"><span>Выводов</span><b>${a.totals.withdrawals}</b></div>
              <div class="kv"><span>Заблокировано счетов</span>
                <b class="${a.totals.blocked ? 'down' : ''}">${a.totals.blocked}</b></div>
              <div class="kv"><span>Сходимость журнала</span>
                <b class="${a.integrity.ok ? 'up' : 'down'}">
                  ${a.integrity.ok ? 'подтверждена' : 'НАРУШЕНА'}</b></div>
              ${a.integrity.ok ? '' : `<div class="note note-bad" style="margin-top:var(--sp-4)">
                ${ICONS.alert}<div>Журнал не сходится. Операции следует приостановить
                до выяснения причины.</div></div>`}

              ${a.staffActivity.length ? `
                <h4 style="font-size:var(--fs-sm);color:var(--muted);margin:var(--sp-5) 0 var(--sp-3)">
                  Активность сотрудников</h4>
                ${a.staffActivity.map(s => `<div class="kv">
                  <span>${esc(s.display_name || '—')}
                    <span class="muted">· ${esc(DEPARTMENTS[s.department] || s.department)}</span></span>
                  <b>${s.replies} ответов · ${s.actions_7d} действий</b></div>`).join('')}` : ''}
            </div>
          </div>
        </div>`;

      let series = 'signups';
      const keys = ['signups', 'logins', 'trades', 'tickets'];
      const colors = ['#1e59ff', '#087f43', '#a8791f', '#c8102e'];

      repaint = () => {
        keys.forEach((k, i) => {
          const c = qs(`[data-mini="${i}"]`, panel);
          if (c) drawBars(c, a.series[k], { color: colors[i], labels: null });
        });
        const big = qs('[data-big]', panel);
        if (big) drawBars(big, a.series[series], {
          color: colors[keys.indexOf(series)], labels: i => `−${a.days - 1 - i}д` });
        const kyc = qs('[data-kyc]', panel);
        if (kyc) drawDonut(kyc, a.byKyc.map((n, i) => ({
          id: `L${i}`, pct: n, color: ['#c8ccd4','#a8791f','#1e59ff','#087f43'][i] })),
          { centerTop: String(a.totals.users), centerSub: 'клиентов' });
      };
      repaint();

      on(panel, 'click', '[data-s]', (_e, t) => {
        series = t.dataset.s;
        qsa('[data-s]', panel).forEach(b => b.classList.toggle('on', b === t));
        repaint();
      });
    }

    /* ═══════════════ Клиенты ═══════════════ */
    let uQuery = '', uStatus = 'all';

    async function viewUsers() {
      panel.innerHTML = `
        <div class="market-toolbar">
          <div class="search-box">${ICONS.search}
            <input class="input" placeholder="Поиск: имя, почта, идентификатор" data-q value="${esc(uQuery)}">
          </div>
          <div class="chips">
            ${[['all','Все'],['active','Активные'],['pending','Ожидают'],['blocked','Заблокированные']]
              .map(([k,l]) => `<button class="chip${uStatus===k?' on':''}" data-st="${k}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="card table-wrap" data-rows>
          <div class="skel" style="height:200px;margin:var(--sp-4)"></div></div>`;

      await loadUsers();
    }

    async function loadUsers() {
      const rows = await API.get(
        `/admin/users/search?q=${encodeURIComponent(uQuery)}&status=${uStatus}`);
      const box = qs('[data-rows]', panel);
      if (!rows.length) {
        box.innerHTML = `<div class="empty"><div class="ic">${ICONS.search}</div>
          <p>Под условия никто не подходит</p></div>`;
        return;
      }
      box.innerHTML = `<table class="tbl">
        <thead><tr><th>Клиент</th><th class="hide-sm">Страна</th><th>KYC</th>
          <th class="num hide-sm">Операций</th><th class="num hide-sm">Входов</th>
          <th>Статус</th><th class="num hide-xs">Регистрация</th><th></th></tr></thead>
        <tbody>${rows.map(u => {
          const [label, cls] = STATUS_UI[u.status] || ['—', 'st-pending'];
          return `<tr data-u="${u.user_id}">
            <td><div class="asset-cell">
              <span class="coin" style="background:${u.status==='blocked'?'#c8102e':'#1e59ff'}">
                ${esc((u.display_name || u.email || '?').trim()[0].toUpperCase())}</span>
              <div><div class="name">${esc(u.display_name || '—')}</div>
                   <div class="sym mono">${esc(u.email)}</div></div></div></td>
            <td class="hide-sm muted">${esc(u.country || '—')}</td>
            <td><span class="badge ${u.kyc_level>=2?'badge-up':u.kyc_level===1?'badge-neutral':'badge-down'}">
              L${u.kyc_level}</span></td>
            <td class="num hide-sm">${u.deposit_count + u.withdraw_count}</td>
            <td class="num hide-sm">${u.login_count}</td>
            <td><span class="pill-status ${cls}">${label}</span></td>
            <td class="num hide-xs muted" style="font-size:var(--fs-xs)">
              ${new Date(u.created_at*1000).toLocaleDateString('ru-RU')}</td>
            <td class="num"><button class="btn btn-ghost btn-sm" data-open="${u.user_id}">Открыть</button></td>
          </tr>`;
        }).join('')}</tbody></table>`;
    }

    /* Карточка клиента: всё, что о нём известно */
    async function openUser(uid) {
      const m = modal({ title: 'Карточка клиента', width: 780,
                        body: '<div class="skel" style="height:300px"></div>' });
      const box = qs('.modal-bd', m.node);
      let p;
      try { p = await API.get(`/admin/users/${uid}/profile`); }
      catch (e) { box.innerHTML = `<div class="note note-bad">${ICONS.alert}<div>${esc(e.message)}</div></div>`; return; }

      const s = p.summary;
      const [label, cls] = STATUS_UI[s.status] || ['—', 'st-pending'];

      box.innerHTML = `
        <div class="row gap-4" style="margin-bottom:var(--sp-5);align-items:flex-start">
          <span class="coin lg" style="background:${s.status==='blocked'?'#c8102e':'#1e59ff'}">
            ${esc((s.display_name || s.email || '?').trim()[0].toUpperCase())}</span>
          <div style="flex:1">
            <div style="color:var(--ink);font-weight:var(--fw-bold);font-size:var(--fs-lg)">
              ${esc(s.display_name || '—')}</div>
            <div class="muted mono" style="font-size:var(--fs-xs)">${esc(s.email)} · ${esc(s.user_id)}</div>
          </div>
          <span class="pill-status ${cls}">${label}</span>
        </div>

        <nav class="seg-nav" data-utabs style="margin-bottom:var(--sp-4)">
          ${[['info','Сводка'],['money','Средства'],['sec','Доступ'],['notes','Заметки'],['act','Действия']]
            .map(([k,l],i) => `<button class="seg-item${i===0?' on':''}" data-ut="${k}"><span>${l}</span></button>`).join('')}
        </nav>
        <div data-upanel></div>`;

      const up = qs('[data-upanel]', box);

      const RENDER = {
        info: () => `
          <div class="kv-list">
            <div class="kv"><span>Верификация</span><b>Уровень ${s.kyc_level}</b></div>
            <div class="kv"><span>Роль</span><b>${s.role === 'admin' ? 'Администратор'
              : s.role === 'support' ? 'Сотрудник' : 'Клиент'}</b></div>
            <div class="kv"><span>Регистрация</span><b>${fmtDateTime(s.created_at*1000)}</b></div>
            <div class="kv"><span>Последняя активность</span>
              <b>${s.last_seen_at ? timeAgo(s.last_seen_at*1000) : 'нет данных'}</b></div>
            <div class="kv"><span>Пополнений / выводов</span>
              <b>${s.deposit_count} / ${s.withdraw_count}</b></div>
            <div class="kv"><span>Заявок · открытых</span><b>${s.order_count} · ${s.open_orders}</b></div>
            <div class="kv"><span>Входов</span><b>${s.login_count}</b></div>
            <div class="kv"><span>Устройств</span><b>${s.device_count}</b></div>
            <div class="kv"><span>Обращений открыто</span><b>${s.open_tickets}</b></div>
          </div>
          <h4 style="margin:var(--sp-5) 0 var(--sp-3)">Активность за 30 дней</h4>
          <div class="chart-box" style="height:120px"><canvas data-uact></canvas></div>`,

        money: () => `
          ${p.balances.length ? `<table class="tbl"><thead><tr>
            <th>Актив</th><th class="num">Доступно</th><th class="num">Заблокировано</th></tr></thead>
            <tbody>${p.balances.map(b => `<tr>
              <td><div class="row gap-2">${coinIcon(b.asset,'sm')}<b>${esc(b.asset)}</b></div></td>
              <td class="num mono">${fmtNum(parseFloat(b.available),0,8)}</td>
              <td class="num mono muted">${fmtNum(parseFloat(b.locked),0,8)}</td>
            </tr>`).join('')}</tbody></table>`
            : '<p class="muted">Средств на счёте нет</p>'}

          <h4 style="margin:var(--sp-5) 0 var(--sp-3)">Лимиты</h4>
          <div class="kv"><span>Суточный вывод</span>
            <b>${p.limits.withdrawDailyUsd ? fmtUSD(p.limits.withdrawDailyUsd) : 'по уровню KYC'}</b></div>
          <div class="kv"><span>Торговля</span>
            <b class="${p.limits.tradingFrozen?'down':'up'}">
              ${p.limits.tradingFrozen ? 'приостановлена' : 'разрешена'}</b></div>
          <div class="kv"><span>Вывод</span>
            <b class="${p.limits.withdrawFrozen?'down':'up'}">
              ${p.limits.withdrawFrozen ? 'приостановлен' : 'разрешён'}</b></div>

          <div class="row gap-2 wrap" style="margin-top:var(--sp-5)">
            <button class="btn btn-ghost btn-sm" data-act="limits">Изменить лимиты</button>
            <button class="btn btn-ghost btn-sm" data-act="adjust">Корректировать баланс</button>
          </div>`,

        sec: () => `
          <h4 style="margin-bottom:var(--sp-3)">Устройства</h4>
          ${p.devices.length ? p.devices.map(d => `<div class="dev-row">
            <div class="ic">${ICONS.mobile}</div>
            <div><div class="t-main">${esc(d.label)}</div>
              <div class="t-sub mono">${esc(d.ip||'—')} · ${esc(d.city||'не определено')}</div></div>
            <div class="muted" style="font-size:var(--fs-xs)">${timeAgo(d.lastSeen)}</div>
          </div>`).join('') : '<p class="muted">Устройств не зафиксировано</p>'}

          <h4 style="margin:var(--sp-5) 0 var(--sp-3)">Последние входы</h4>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Событие</th><th>Устройство</th><th class="hide-sm">IP</th><th class="num">Когда</th></tr></thead>
            <tbody>${p.logins.slice(0,12).map(l => `<tr>
              <td><span class="badge ${l.event==='login'?'badge-up':l.event==='failed'?'badge-down':'badge-neutral'}">
                ${esc(l.event)}</span></td>
              <td>${esc(l.os||'—')} · ${esc(l.browser||'—')}</td>
              <td class="hide-sm mono muted">${esc(l.ip||'—')}</td>
              <td class="num muted" style="font-size:var(--fs-xs)">${fmtDateTime(l.at)}</td>
            </tr>`).join('')}</tbody></table></div>

          <div class="row gap-2 wrap" style="margin-top:var(--sp-5)">
            <button class="btn btn-ghost btn-sm" data-act="revoke">Завершить сессии</button>
            <button class="btn btn-ghost btn-sm" data-act="reset2fa">Сбросить 2FA</button>
            <button class="btn btn-ghost btn-sm" data-act="kyc">Изменить KYC</button>
          </div>`,

        notes: () => `
          <div class="field">
            <label>Новая заметка</label>
            <textarea class="input" rows="3" data-note
              placeholder="Внутренний комментарий — клиенту не виден"></textarea>
          </div>
          <button class="btn btn-primary btn-sm" data-act="note">Добавить</button>
          <div style="margin-top:var(--sp-5)">
            ${p.notes.length ? p.notes.map(n => `
              <div class="note note-info" style="margin-bottom:var(--sp-3)">
                ${n.pinned ? ICONS.starFilled : ICONS.info}
                <div><div>${esc(n.body)}</div>
                  <div class="t-sub" style="margin-top:var(--sp-2)">
                    ${esc(n.author||'—')} · ${fmtDateTime(n.createdAt)}</div></div></div>`).join('')
              : '<p class="muted">Заметок нет</p>'}
          </div>`,

        act: () => `
          <div class="grid-auto">
            <button class="qa" data-act="notify"><span class="ic">${ICONS.bell}</span>Отправить уведомление</button>
            <button class="qa" data-act="export"><span class="ic">${ICONS.download}</span>Выгрузить данные</button>
            ${s.status === 'blocked'
              ? `<button class="qa" data-act="unblock"><span class="ic">${ICONS.lockOpen}</span>Разблокировать</button>`
              : `<button class="qa" data-act="block"><span class="ic">${ICONS.lock}</span>Заблокировать</button>`}
            <button class="qa" data-act="limits"><span class="ic">${ICONS.settings}</span>Лимиты</button>
          </div>
          <div class="note note-warn" style="margin-top:var(--sp-5)">${ICONS.alert}
            <div>Блокировка, сброс 2FA и корректировка баланса требуют указания основания.
            Оно попадает в журнал аудита и доступно при проверке.</div></div>`,
      };

      const paintU = (k) => {
        up.innerHTML = RENDER[k]();
        if (k === 'info') {
          requestAnimationFrame(() => {
            const c = qs('[data-uact]', up);
            if (c) drawBars(c, p.activity.logins, { color: '#1e59ff', labels: null });
          });
        }
      };
      paintU('info');

      on(box, 'click', '[data-ut]', (_e, t) => {
        qsa('[data-ut]', box).forEach(b => b.classList.toggle('on', b === t));
        paintU(t.dataset.ut);
      });

      on(box, 'click', '[data-act]', async (_e, t) => {
        const act = t.dataset.act;
        try {
          if (act === 'block') {
            const reason = await askReason(s.display_name || s.email);
            if (!reason) return;
            await API.post(`/admin/users/${uid}/block`, { reason });
            toast({ title: 'Клиент заблокирован', kind: 'warn' }); m.close(); loadUsers();
          } else if (act === 'unblock') {
            if (!await confirmModal({ title: 'Снять блокировку',
                text: 'Клиент снова получит доступ к торговле и выводу.', okLabel: 'Разблокировать' })) return;
            await API.post(`/admin/users/${uid}/unblock`, {});
            toast({ title: 'Блокировка снята', kind: 'ok' }); m.close(); loadUsers();
          } else if (act === 'revoke') {
            const r = await API.post(`/admin/users/${uid}/revoke-sessions`, {});
            toast({ title: 'Сессии завершены', msg: `Закрыто: ${r.revoked}`, kind: 'ok' });
          } else if (act === 'reset2fa') {
            const reason = await askReason(s.email, 'Сброс двухфакторной защиты');
            if (!reason) return;
            await API.post(`/admin/users/${uid}/reset-2fa`, { reason });
            toast({ title: '2FA сброшена', kind: 'warn' });
          } else if (act === 'kyc') {
            kycDialog(uid);
          } else if (act === 'limits') {
            limitsDialog(uid, p.limits);
          } else if (act === 'adjust') {
            adjustDialog(uid, p.balances);
          } else if (act === 'notify') {
            notifyDialog(uid);
          } else if (act === 'note') {
            const body = qs('[data-note]', up).value.trim();
            if (!body) { toast({ title: 'Пустая заметка', kind: 'err' }); return; }
            await API.post(`/admin/users/${uid}/notes`, { body });
            toast({ title: 'Заметка добавлена', kind: 'ok' });
            m.close(); openUser(uid);
          } else if (act === 'export') {
            const d = await API.get(`/admin/users/${uid}/export`);
            const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `meridian-user-${uid}.json`;
            a.click(); URL.revokeObjectURL(a.href);
            toast({ title: 'Данные выгружены', kind: 'ok' });
          }
        } catch (e) { toast({ title: 'Не выполнено', msg: e.message, kind: 'err' }); }
      });
    }

    /* ── Диалоги действий ── */
    function askReason(who, title = 'Блокировка счёта') {
      return new Promise(resolve => {
        const REASONS = ['Санкционный скрининг: совпадение по списку',
          'Подозрительная схема операций', 'Не пройдена повторная верификация',
          'Запрос уполномоченного органа', 'Нарушение пользовательского соглашения'];
        const body = h(`<div>
          <p class="muted" style="margin-top:0">Действие затронет ${esc(who)}.
             Основание попадёт в журнал аудита.</p>
          <div class="field"><label>Основание</label>
            <select class="select" data-r>
              ${REASONS.map(r => `<option>${esc(r)}</option>`).join('')}
              <option value="__c">Другое (указать)</option></select></div>
          <div class="field" data-cw hidden><label>Своё основание</label>
            <input class="input" data-c placeholder="Опишите причину"></div>
        </div>`);
        const m = modal({ title, body,
          footer: `<button class="btn btn-ghost" data-no>Отмена</button>
                   <button class="btn btn-down" data-ok>Подтвердить</button>` });
        qs('[data-r]', body).addEventListener('change', e => {
          qs('[data-cw]', body).hidden = e.target.value !== '__c'; });
        qs('[data-no]', m.node).addEventListener('click', () => { m.close(); resolve(null); });
        qs('[data-ok]', m.node).addEventListener('click', () => {
          const sel = qs('[data-r]', body).value;
          const reason = sel === '__c' ? qs('[data-c]', body).value.trim() : sel;
          if (!reason) { toast({ title: 'Укажите основание', kind: 'err' }); return; }
          m.close(); resolve(reason);
        });
      });
    }

    function kycDialog(uid) {
      const body = h(`<div><div class="field"><label>Уровень верификации</label>
        <select class="select" data-l>
          ${[0,1,2,3].map(i => `<option value="${i}">Уровень ${i}</option>`).join('')}
        </select></div>
        <p class="help">Уровень определяет лимиты пополнения и вывода.</p></div>`);
      const m = modal({ title: 'Верификация', body,
        footer: `<button class="btn btn-ghost" data-n>Отмена</button>
                 <button class="btn btn-primary" data-y>Применить</button>` });
      qs('[data-n]', m.node).addEventListener('click', m.close);
      qs('[data-y]', m.node).addEventListener('click', async () => {
        await API.post(`/admin/users/${uid}/kyc`, { level: +qs('[data-l]', body).value });
        m.close(); toast({ title: 'Уровень изменён', kind: 'ok' });
      });
    }

    function limitsDialog(uid, cur) {
      const body = h(`<div>
        <div class="field"><label>Суточный лимит вывода, USD</label>
          <input class="input mono" type="number" data-wd value="${cur.withdrawDailyUsd ?? ''}"
            placeholder="пусто — по уровню KYC"></div>
        <div class="field"><label>Максимум одной заявки, USD</label>
          <input class="input mono" type="number" data-mo value="${cur.maxOrderUsd ?? ''}"></div>
        <label class="perm-item"><input type="checkbox" data-tf${cur.tradingFrozen?' checked':''}>
          <span>Приостановить торговлю</span></label>
        <label class="perm-item" style="margin-top:var(--sp-2)">
          <input type="checkbox" data-wf${cur.withdrawFrozen?' checked':''}>
          <span>Приостановить вывод</span></label>
        <div class="field" style="margin-top:var(--sp-4)"><label>Комментарий</label>
          <input class="input" data-nt value="${esc(cur.note || '')}"></div>
      </div>`);
      const m = modal({ title: 'Лимиты клиента', body, width: 520,
        footer: `<button class="btn btn-ghost" data-n>Отмена</button>
                 <button class="btn btn-primary" data-y>Сохранить</button>` });
      qs('[data-n]', m.node).addEventListener('click', m.close);
      qs('[data-y]', m.node).addEventListener('click', async () => {
        await API.post(`/admin/users/${uid}/limits`, {
          withdrawDailyUsd: +qs('[data-wd]', body).value || null,
          maxOrderUsd: +qs('[data-mo]', body).value || null,
          tradingFrozen: qs('[data-tf]', body).checked,
          withdrawFrozen: qs('[data-wf]', body).checked,
          note: qs('[data-nt]', body).value.trim() || null,
        });
        m.close(); toast({ title: 'Лимиты сохранены', kind: 'ok' });
      });
    }

    function adjustDialog(uid, balances) {
      const body = h(`<div>
        <div class="note note-warn" style="margin-bottom:var(--sp-4)">${ICONS.alert}
          <div>Корректировка проводится двойной записью через казначейский счёт.
          Отрицательная сумма списывает средства.</div></div>
        <div class="field"><label>Актив</label>
          <input class="input mono" data-a placeholder="USDT" value="${balances[0]?.asset || 'USDT'}"></div>
        <div class="field"><label>Сумма (со знаком)</label>
          <input class="input mono" data-am placeholder="например 250 или -50"></div>
        <div class="field"><label>Основание</label>
          <input class="input" data-r placeholder="Компенсация комиссии по обращению tkt_…"></div>
      </div>`);
      const m = modal({ title: 'Корректировка баланса', body,
        footer: `<button class="btn btn-ghost" data-n>Отмена</button>
                 <button class="btn btn-primary" data-y>Провести</button>` });
      qs('[data-n]', m.node).addEventListener('click', m.close);
      qs('[data-y]', m.node).addEventListener('click', async () => {
        const reason = qs('[data-r]', body).value.trim();
        if (!reason) { toast({ title: 'Укажите основание', kind: 'err' }); return; }
        try {
          const r = await API.post(`/admin/users/${uid}/adjust`, {
            asset: qs('[data-a]', body).value.trim().toUpperCase(),
            amount: qs('[data-am]', body).value.trim(), reason });
          m.close(); toast({ title: 'Корректировка проведена', msg: r.amount, kind: 'ok' });
        } catch (e) { toast({ title: 'Отклонено', msg: e.message, kind: 'err' }); }
      });
    }

    function notifyDialog(uid) {
      const body = h(`<div>
        <div class="field"><label>Заголовок</label><input class="input" data-t></div>
        <div class="field"><label>Текст</label><textarea class="input" rows="4" data-b></textarea></div>
        <div class="field"><label>Важность</label>
          <select class="select" data-l>
            <option value="info">Информация</option><option value="success">Успех</option>
            <option value="warning">Предупреждение</option><option value="critical">Критично</option>
          </select></div>
      </div>`);
      const m = modal({ title: 'Уведомление клиенту', body,
        footer: `<button class="btn btn-ghost" data-n>Отмена</button>
                 <button class="btn btn-primary" data-y>Отправить</button>` });
      qs('[data-n]', m.node).addEventListener('click', m.close);
      qs('[data-y]', m.node).addEventListener('click', async () => {
        const title = qs('[data-t]', body).value.trim();
        if (!title) { toast({ title: 'Нужен заголовок', kind: 'err' }); return; }
        await API.post(`/admin/users/${uid}/notify`, {
          title, body: qs('[data-b]', body).value.trim(), level: qs('[data-l]', body).value });
        m.close(); toast({ title: 'Уведомление отправлено', kind: 'ok' });
      });
    }

    /* ═══════════════ Поддержка ═══════════════ */
    async function viewSupport() {
      panel.innerHTML = `<div class="card table-wrap" data-q>
        <div class="skel" style="height:200px;margin:var(--sp-4)"></div></div>`;
      const rows = await API.get('/admin/support/queue');
      const box = qs('[data-q]', panel);
      if (!rows.length) {
        box.innerHTML = `<div class="empty"><div class="ic">${ICONS.circleCheck}</div>
          <h3 style="margin-bottom:var(--sp-2)">Очередь пуста</h3>
          <p class="muted" style="margin:0">Открытых обращений нет.</p></div>`;
        return;
      }
      box.innerHTML = `<table class="tbl">
        <thead><tr><th>Тема</th><th>Клиент</th><th class="hide-sm">Категория</th>
          <th>Приоритет</th><th>Статус</th><th class="num">Ожидает</th><th></th></tr></thead>
        <tbody>${rows.map(t => `<tr>
          <td><b style="color:var(--ink)">${esc(t.subject)}</b>
            <div class="sym">${t.messages} сообщ.</div></td>
          <td><div class="mono" style="font-size:var(--fs-xs)">${esc(t.user.email)}</div></td>
          <td class="hide-sm muted">${esc(t.category)}</td>
          <td><span class="badge ${t.priority==='urgent'?'badge-down':t.priority==='high'?'badge-gold':'badge-neutral'}">
            ${esc(t.priority)}</span></td>
          <td><span class="badge badge-brand">${esc(TICKET_STATUS[t.status]||t.status)}</span></td>
          <td class="num muted">${Math.floor(t.idleSeconds/3600)} ч</td>
          <td class="num"><a class="btn btn-soft btn-sm" href="#/tickets/${t.id}">Открыть</a></td>
        </tr>`).join('')}</tbody></table>`;
    }

    /* ═══════════════ Сотрудники ═══════════════ */
    async function viewStaff() {
      panel.innerHTML = `<div class="skel" style="height:220px"></div>`;
      const d = await API.get('/admin/staff');
      permissions = d.permissions; presets = d.presets;

      panel.innerHTML = `
        <div class="sec-head">
          <div><h3>Учётные записи сотрудников</h3>
            <p class="muted">Права выдаются явно: новый сотрудник по умолчанию не может ничего.</p></div>
          <button class="btn btn-primary" data-newstaff>${ICONS.plus}Создать сотрудника</button>
        </div>

        <div class="card table-wrap">
          ${d.staff.length ? `<table class="tbl">
            <thead><tr><th>Сотрудник</th><th>Отдел</th><th class="hide-sm">Должность</th>
              <th class="num hide-sm">Ответов</th><th class="num hide-sm">Действий за 7д</th>
              <th>Права</th><th></th></tr></thead>
            <tbody>${d.staff.map(s => `<tr>
              <td><div class="asset-cell">
                <span class="coin" style="background:${s.disabled?'#5b6472':'#087f43'}">
                  ${esc((s.name||s.email)[0].toUpperCase())}</span>
                <div><div class="name">${esc(s.name||'—')}</div>
                     <div class="sym mono">${esc(s.email)}</div></div></div></td>
              <td>${esc(DEPARTMENTS[s.department]||s.department)}</td>
              <td class="hide-sm muted">${esc(s.position||'—')}</td>
              <td class="num hide-sm">${s.replies}</td>
              <td class="num hide-sm">${s.actions7d}</td>
              <td><span class="badge badge-neutral">${s.permissions.length}</span></td>
              <td class="num">
                <button class="btn btn-ghost btn-sm" data-editstaff="${s.id}">Права</button>
              </td>
            </tr>`).join('')}</tbody></table>`
            : `<div class="empty"><div class="ic">${ICONS.userCheck}</div>
                <h3 style="margin-bottom:var(--sp-2)">Сотрудников ещё нет</h3>
                <p class="muted">Создайте первую учётную запись оператора.</p></div>`}
        </div>

        <div class="note note-info" style="margin-top:var(--sp-4)">${ICONS.shieldLock}
          <div>Пароль сотрудника показывается один раз при создании и не хранится в
          восстановимом виде. Передавайте его защищённым каналом.</div></div>`;

      window.__staffCache = d.staff;
    }

    function staffDialog(existing = null) {
      const cur = existing ? existing.permissions : presets.support || [];
      const body = h(`<div>
        ${existing ? '' : `
          <div class="g-2">
            <div class="field"><label>Имя</label><input class="input" data-n placeholder="Пётр Оператор"></div>
            <div class="field"><label>Электронная почта</label>
              <input class="input" data-e placeholder="operator@meridian.exchange"></div>
          </div>
          <div class="g-2">
            <div class="field"><label>Пароль</label>
              <input class="input mono" data-p placeholder="минимум 10 символов"></div>
            <div class="field"><label>Должность</label>
              <input class="input" data-pos placeholder="Специалист 1-й линии"></div>
          </div>`}
        <div class="field"><label>Отдел</label>
          <select class="select" data-d>
            ${Object.entries(DEPARTMENTS).map(([k,v]) =>
              `<option value="${k}"${existing?.department===k?' selected':''}>${v}</option>`).join('')}
          </select>
          <span class="help">Смена отдела подставит типовой набор прав — его можно уточнить ниже.</span>
        </div>
        <div class="field">
          <label>Полномочия</label>
          <div class="perm-grid" data-perms>
            ${Object.entries(permissions).map(([k,v]) => `
              <label class="perm-item">
                <input type="checkbox" value="${k}"${cur.includes(k)?' checked':''}>
                <span>${esc(v)}<code>${k}</code></span></label>`).join('')}
          </div>
        </div>
        ${existing ? `<label class="perm-item"><input type="checkbox" data-dis${existing.disabled?' checked':''}>
          <span>Отключить учётную запись<code>сессии будут завершены</code></span></label>` : ''}
      </div>`);

      const m = modal({ title: existing ? `Права: ${existing.name || existing.email}` : 'Новый сотрудник',
        body, width: 640,
        footer: `<button class="btn btn-ghost" data-n2>Отмена</button>
                 <button class="btn btn-primary" data-y>${existing ? 'Сохранить' : 'Создать'}</button>` });

      // Смена отдела подставляет типовой набор
      qs('[data-d]', body).addEventListener('change', e => {
        const set = presets[e.target.value] || [];
        qsa('[data-perms] input', body).forEach(c => c.checked = set.includes(c.value));
      });

      qs('[data-n2]', m.node).addEventListener('click', m.close);
      qs('[data-y]', m.node).addEventListener('click', async () => {
        const perms = qsa('[data-perms] input:checked', body).map(c => c.value);
        try {
          if (existing) {
            await API.post(`/admin/staff/${existing.id}`, {
              permissions: perms, department: qs('[data-d]', body).value,
              disabled: qs('[data-dis]', body)?.checked });
            m.close(); toast({ title: 'Права обновлены', kind: 'ok' }); viewStaff();
          } else {
            const r = await API.post('/admin/staff', {
              name: qs('[data-n]', body).value.trim(),
              email: qs('[data-e]', body).value.trim(),
              password: qs('[data-p]', body).value,
              position: qs('[data-pos]', body).value.trim(),
              department: qs('[data-d]', body).value,
              permissions: perms });
            m.close();
            modal({ title: 'Сотрудник создан', body: `
              <div class="note note-good" style="margin-bottom:var(--sp-4)">${ICONS.circleCheck}
                <div>Учётная запись ${esc(r.email)} создана.</div></div>
              <div class="field"><label>Пароль (показан один раз)</label>
                <div class="addr-box"><code>${esc(r.password)}</code>
                  <button class="btn btn-ghost btn-sm" data-copy="${esc(r.password)}">${ICONS.copy}</button>
                </div></div>
              <p class="help">${esc(r.note)}</p>` });
            bindCopy(document.querySelector('#modal-layer'));
            viewStaff();
          }
        } catch (e) { toast({ title: 'Не выполнено', msg: e.message, kind: 'err' }); }
      });
    }

    /* ═══════════════ Журнал ═══════════════ */
    async function viewAudit() {
      panel.innerHTML = `
        <div class="market-toolbar">
          <div class="chips">
            ${[['all','Все'],['info','Информация'],['warn','Важные'],['error','Ошибки']]
              .map(([k,l],i) => `<button class="chip${i===0?' on':''}" data-lv="${k}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="card table-wrap" data-log><div class="skel" style="height:220px;margin:var(--sp-4)"></div></div>`;
      await loadAudit('all');
    }

    async function loadAudit(level) {
      const rows = await API.get(`/admin/audit/search?level=${level}`);
      qs('[data-log]', panel).innerHTML = rows.length ? `<table class="tbl">
        <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th class="hide-sm">Объект</th>
          <th class="hide-sm">Детали</th><th class="num">Уровень</th></tr></thead>
        <tbody>${rows.map(a => `<tr>
          <td class="mono muted" style="font-size:var(--fs-xs)">${fmtDateTime(a.at)}</td>
          <td class="mono" style="font-size:var(--fs-xs)">${esc(a.actor||'система')}</td>
          <td><b style="color:var(--ink)">${esc(a.action)}</b></td>
          <td class="hide-sm mono muted" style="font-size:var(--fs-xs)">${esc(a.target||'—')}</td>
          <td class="hide-sm muted" style="font-size:var(--fs-xs);max-width:280px;overflow:hidden;
              text-overflow:ellipsis;white-space:nowrap">
            ${a.payload ? esc(JSON.stringify(a.payload)) : '—'}</td>
          <td class="num"><span class="badge ${a.level==='warn'?'badge-gold':a.level==='error'?'badge-down':'badge-neutral'}">
            ${esc(a.level)}</span></td>
        </tr>`).join('')}</tbody></table>`
        : `<div class="empty"><p style="margin:0">Записей нет</p></div>`;
    }

    /* ── Роутинг ── */
    const VIEWS = { analytics: viewAnalytics, users: viewUsers,
                    support: viewSupport, staff: viewStaff, audit: viewAudit };

    async function paint() {
      qsa('[data-tab]', el).forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
      history.replaceState(null, '', `#/admin/${tab}`);
      repaint = null;
      panel.innerHTML = '<div class="skel" style="height:280px"></div>';
      try { await VIEWS[tab](); }
      catch (e) {
        panel.innerHTML = `<div class="card"><div class="empty">
          <div class="ic">${ICONS.alert}</div>
          <h3 style="margin-bottom:var(--sp-2)">Раздел недоступен</h3>
          <p class="muted" style="margin:0">${esc(e.message || 'ошибка')}</p></div></div>`;
      }
    }

    on(el, 'click', '[data-tab]', (_e, t) => { tab = t.dataset.tab; paint(); });
    on(el, 'click', '[data-open]', (_e, t) => openUser(t.dataset.open));
    on(el, 'input', '[data-q]', (_e, t) => { uQuery = t.value; loadUsers(); });
    on(el, 'click', '[data-st]', (_e, t) => {
      uStatus = t.dataset.st;
      qsa('[data-st]', panel).forEach(b => b.classList.toggle('on', b === t));
      loadUsers();
    });
    on(el, 'click', '[data-lv]', (_e, t) => {
      qsa('[data-lv]', panel).forEach(b => b.classList.toggle('on', b === t));
      loadAudit(t.dataset.lv);
    });
    on(el, 'click', '[data-newstaff]', () => staffDialog());
    on(el, 'click', '[data-editstaff]', (_e, t) => {
      const s = (window.__staffCache || []).find(x => x.id === t.dataset.editstaff);
      if (s) staffDialog(s);
    });

    bindCopy(el);
    el._mounted = paint;
    const onResize = () => repaint?.();
    window.addEventListener('resize', onResize);
    el._cleanup = () => window.removeEventListener('resize', onResize);
    return el;
  },
};
