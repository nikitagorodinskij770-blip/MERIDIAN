/* Личный кабинет — профиль, безопасность, устройства, активность, история.
   Работает на серверных данных: балансы, входы и статистика приходят из API. */

import { API, ApiError } from '../api/adapter.js';
import * as session from '../core/session.js';
import * as market from '../market.js';
import { h, qs, qsa, on, coinIcon, modal, toast, ICONS, confirmModal, bindCopy } from '../ui.js';
import { fmtUSD, fmtNum, fmtPct, fmtDateTime, timeAgo, esc, dirClass } from '../format.js';
import { drawBars, drawArea, drawDonut } from '../charts.js';

const TABS = [
  { id: 'overview', label: 'Обзор',        ic: 'chart' },
  { id: 'activity', label: 'Активность',   ic: 'trend' },
  { id: 'security', label: 'Безопасность', ic: 'shieldLock' },
  { id: 'devices',  label: 'Устройства',   ic: 'mobile' },
  { id: 'profile',  label: 'Профиль',      ic: 'user' },
];

const DEVICE_ICON = { desktop: 'chart', mobile: 'mobile', tablet: 'mobile', unknown: 'globe' };
const EVENT_LABEL = {
  login: 'Вход', logout: 'Выход', failed: 'Неудачная попытка',
  locked: 'Блокировка', password_change: 'Смена пароля', '2fa_change': 'Изменение 2FA',
};
const KYC_NAME = ['Не пройдена', 'Базовая', 'Стандартная', 'Расширенная'];

export default {
  title: 'Личный кабинет',
  auth: true,
  authText: 'Войдите, чтобы открыть личный кабинет.',

  render({ params }) {
    let tab = TABS.some(t => t.id === params[0]) ? params[0] : 'overview';
    let repaint = null;

    const el = h(`<div class="container section-tight">
      <!-- Обложка раздела -->
      <div class="cover cover-account cover-pad" style="margin-bottom:var(--sp-6)">
        <span class="eyebrow">Личный кабинет</span>
        <h1 style="margin:var(--sp-3) 0 var(--sp-2)" data-greeting>—</h1>
        <p style="margin:0;max-width:56ch" data-subline>—</p>
        <div class="cover-stats" data-coverstats></div>
      </div>

      <nav class="seg-nav" data-tabs>
        ${TABS.map(t => `<button class="seg-item${t.id === tab ? ' on' : ''}" data-tab="${t.id}">
          ${ICONS[t.ic]}<span>${t.label}</span></button>`).join('')}
      </nav>

      <div data-panel></div>
    </div>`);

    const panel = qs('[data-panel]', el);

    /* ── Шапка ── */
    function paintCover() {
      const s = session.get();
      const u = s.user || {};
      qs('[data-greeting]', el).textContent =
        `Здравствуйте, ${(u.name || u.email || '').split(' ')[0] || 'клиент'}`;
      qs('[data-subline]', el).textContent =
        `Верификация: ${KYC_NAME[u.kycLevel ?? 0]} · счёт открыт ${
          u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU') : '—'}`;
      qs('[data-coverstats]', el).innerHTML = `
        <div class="cs"><span class="k">Оценка портфеля</span>
          <span class="v">${fmtUSD(s.portfolioUsd)}</span></div>
        <div class="cs"><span class="k">Активов</span>
          <span class="v">${s.balances.length}</span></div>
        <div class="cs"><span class="k">Входов</span>
          <span class="v">${s.counts.login_count ?? 0}</span></div>
        <div class="cs"><span class="k">Устройств</span>
          <span class="v">${s.counts.device_count ?? 0}</span></div>`;
    }

    /* ═══════════════ Обзор ═══════════════ */
    async function viewOverview() {
      const s = session.get();
      panel.innerHTML = `
        <div class="g-main">
          <div class="stack gap-5">
            <div class="card">
              <div class="card-hd"><h3>Активы</h3>
                <a class="btn btn-ghost btn-sm" href="#/wallet">Кошелёк</a></div>
              <div data-assets><div class="skel" style="height:120px;margin:var(--sp-4)"></div></div>
            </div>

            <div class="card">
              <div class="card-hd"><h3>Последние операции</h3>
                <a class="btn-link" href="#/wallet/history">Вся история →</a></div>
              <div data-tx><div class="skel" style="height:90px;margin:var(--sp-4)"></div></div>
            </div>
          </div>

          <div class="stack gap-5">
            <div class="card card-pad">
              <h3 style="margin-bottom:var(--sp-4)">Распределение</h3>
              <div class="donut-wrap">
                <canvas data-donut style="width:158px;height:158px;flex:none"></canvas>
                <div class="legend" data-legend></div>
              </div>
            </div>

            <div class="card card-pad">
              <h3 style="margin-bottom:var(--sp-4)">Состояние счёта</h3>
              <div class="kv-list">
                <div class="kv"><span>Статус</span>
                  <b class="${s.user?.status === 'active' ? 'up' : 'warn'}">
                    ${s.user?.status === 'active' ? 'Активен' : esc(s.user?.status || '—')}</b></div>
                <div class="kv"><span>Верификация</span><b>${KYC_NAME[s.user?.kycLevel ?? 0]}</b></div>
                <div class="kv"><span>Двухфакторная защита</span>
                  <b class="${s.user?.twoFA ? 'up' : 'down'}">${s.user?.twoFA ? 'Включена' : 'Выключена'}</b></div>
                <div class="kv"><span>Открытых заявок</span><b>${s.counts.open_orders ?? 0}</b></div>
                <div class="kv"><span>Обращений в поддержку</span><b>${s.counts.open_tickets ?? 0}</b></div>
                <div class="kv"><span>Лимит вывода в сутки</span>
                  <b>${s.limits?.withdrawDailyUsd ? fmtUSD(s.limits.withdrawDailyUsd) : 'по уровню KYC'}</b></div>
              </div>
              ${s.limits?.withdrawFrozen || s.limits?.tradingFrozen ? `
                <div class="note note-warn" style="margin-top:var(--sp-4)">
                  ${ICONS.alert}<div>По счёту действуют ограничения${
                    s.limits.tradingFrozen ? ': торговля приостановлена' : ''}${
                    s.limits.withdrawFrozen ? '; вывод приостановлен' : ''}.
                    <a href="#/tickets">Обратиться в поддержку</a></div></div>` : ''}
            </div>

            <div class="quick-actions">
              <a class="qa" href="#/wallet"><span class="ic">${ICONS.arrowDown}</span>Пополнить</a>
              <a class="qa" href="#/convert"><span class="ic">${ICONS.swap}</span>Обменять</a>
              <a class="qa" href="#/trade/BTC-USDT"><span class="ic">${ICONS.chart}</span>Торговать</a>
              <a class="qa" href="#/tickets"><span class="ic">${ICONS.support}</span>Поддержка</a>
            </div>
          </div>
        </div>`;

      // Активы
      const box = qs('[data-assets]', panel);
      if (!s.balances.length) {
        box.innerHTML = `<div class="empty"><div class="ic">${ICONS.wallet}</div>
          <p>Активов пока нет.</p><a class="btn btn-primary" href="#/wallet">Пополнить счёт</a></div>`;
      } else {
        box.innerHTML = `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>Актив</th><th class="num">Доступно</th>
            <th class="num hide-sm">Цена</th><th class="num hide-sm">24ч</th>
            <th class="num">Стоимость</th></tr></thead><tbody>
          ${s.balances.map(b => {
            const px = market.price(b.asset);
            const chg = market.change24(b.asset);
            return `<tr>
              <td><div class="asset-cell">${coinIcon(b.asset)}
                <div><div class="name">${esc(b.asset)}</div>
                <div class="sym">${esc(market.assetName?.(b.asset) || '')}</div></div></div></td>
              <td class="num mono">${fmtNum(parseFloat(b.available), 0, 8)}</td>
              <td class="num mono hide-sm">${px ? fmtUSD(px) : '—'}</td>
              <td class="num hide-sm ${dirClass(chg)}">${chg ? fmtPct(chg) : '—'}</td>
              <td class="num"><b>${fmtUSD(parseFloat(b.available) * px)}</b></td>
            </tr>`;
          }).join('')}</tbody></table></div>`;
      }

      // Донат распределения
      const alloc = s.balances
        .map(b => ({ id: b.asset, usd: parseFloat(b.available) * market.price(b.asset) }))
        .filter(x => x.usd > 0.01)
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 6);
      const total = alloc.reduce((t, x) => t + x.usd, 0) || 1;
      const palette = ['#1e59ff', '#087f43', '#a8791f', '#c8102e', '#5b6472', '#7fa0ff'];
      alloc.forEach((a, i) => { a.pct = a.usd / total * 100; a.color = palette[i % palette.length]; });

      qs('[data-legend]', panel).innerHTML = alloc.length
        ? alloc.map(a => `<div class="li"><span class="sw" style="background:${a.color}"></span>
            <b style="min-width:52px">${esc(a.id)}</b>
            <span class="muted mono">${a.pct.toFixed(1)}%</span></div>`).join('')
        : '<span class="muted">Портфель пуст</span>';

      repaint = () => {
        const c = qs('[data-donut]', panel);
        if (c) drawDonut(c, alloc, { centerTop: fmtUSD(s.portfolioUsd), centerSub: 'портфель' });
      };
      repaint();

      // Операции
      try {
        const tx = await API.get('/wallet/transactions?limit=6');
        const tb = qs('[data-tx]', panel);
        tb.innerHTML = tx.length ? tx.map(t => `
          <div class="tx-row">
            <div class="ic ${t.kind === 'deposit' ? 'tx-in' : 'tx-out'}">
              ${t.kind === 'deposit' ? ICONS.arrowDown : ICONS.arrowUp}</div>
            <div><div class="t-main">${t.kind === 'deposit' ? 'Пополнение' : 'Вывод'} ${esc(t.asset)}</div>
                 <div class="t-sub">${esc(t.network || '')} · ${timeAgo(t.createdAt)}</div></div>
            <div style="text-align:right">
              <div class="mono ${t.kind === 'deposit' ? 'up' : 'down'}">
                ${t.kind === 'deposit' ? '+' : '−'}${fmtNum(parseFloat(t.amount), 0, 8)}</div>
              <span class="pill-status st-${t.status}">${
                t.status === 'completed' ? 'исполнено' : t.status === 'pending' ? 'в обработке' : esc(t.status)}</span>
            </div>
          </div>`).join('')
          : `<div class="empty" style="padding:var(--sp-8)"><p style="margin:0">Операций пока нет</p></div>`;
      } catch { /* сеть отвалилась — блок останется скелетоном */ }
    }

    /* ═══════════════ Активность ═══════════════ */
    async function viewActivity() {
      panel.innerHTML = `<div class="grid-auto">
        ${['Пополнения', 'Выводы', 'Сделки', 'Входы'].map((t, i) => `
          <div class="card card-pad stat-card">
            <span class="k">${t} за 30 дней</span>
            <span class="v" data-total="${i}">—</span>
            <div class="chart-box" style="height:64px"><canvas data-mini="${i}"></canvas></div>
          </div>`).join('')}
      </div>
      <div class="card card-pad" style="margin-top:var(--sp-5)">
        <div class="row between" style="margin-bottom:var(--sp-4)">
          <h3>Динамика по дням</h3>
          <div class="segment" data-series>
            ${['deposits:Пополнения', 'withdrawals:Выводы', 'trades:Сделки', 'logins:Входы']
              .map((s, i) => { const [k, l] = s.split(':');
                return `<button data-s="${k}"${i === 0 ? ' class="on"' : ''}>${l}</button>`; }).join('')}
          </div>
        </div>
        <div class="chart-box" style="height:240px"><canvas data-big></canvas></div>
      </div>
      <div class="card" style="margin-top:var(--sp-5)">
        <div class="card-hd"><h3>Журнал входов</h3></div>
        <div class="table-wrap" data-logins>
          <div class="skel" style="height:140px;margin:var(--sp-4)"></div></div>
      </div>`;

      let data = null, series = 'deposits';
      try {
        data = await API.get('/me/activity?days=30');
      } catch { toast({ title: 'Не удалось загрузить статистику', kind: 'err' }); return; }

      const totals = [data.totals.deposits, data.totals.withdrawals,
                      data.totals.trades, data.totals.logins];
      const keys = ['deposits', 'withdrawals', 'trades', 'logins'];
      const colors = ['#087f43', '#c8102e', '#1e59ff', '#a8791f'];
      qsa('[data-total]', panel).forEach((n, i) => {
        n.textContent = i === 3 ? totals[i] : fmtNum(totals[i], 0, 4);
      });

      repaint = () => {
        keys.forEach((k, i) => {
          const c = qs(`[data-mini="${i}"]`, panel);
          if (c) drawBars(c, data[k], { color: colors[i], labels: null });
        });
        const big = qs('[data-big]', panel);
        if (big) drawBars(big, data[series], {
          color: colors[keys.indexOf(series)],
          labels: i => `−${data.days - 1 - i}д`,
        });
      };
      repaint();

      on(panel, 'click', '[data-s]', (_e, t) => {
        series = t.dataset.s;
        qsa('[data-s]', panel).forEach(b => b.classList.toggle('on', b === t));
        repaint();
      });

      const logins = await API.get('/me/logins?limit=40');
      qs('[data-logins]', panel).innerHTML = `<table class="tbl">
        <thead><tr><th>Событие</th><th>Устройство</th><th class="hide-sm">Расположение</th>
          <th class="hide-sm">IP</th><th class="num">Когда</th></tr></thead><tbody>
        ${logins.map(l => `<tr>
          <td><span class="badge ${l.event === 'login' ? 'badge-up' : l.event === 'failed' ? 'badge-down' : 'badge-neutral'}">
            ${EVENT_LABEL[l.event] || esc(l.event)}</span>
            ${l.isNew ? '<span class="badge badge-gold" style="margin-left:6px">новое</span>' : ''}</td>
          <td>${esc(l.os || '—')} · ${esc(l.browser || '—')}</td>
          <td class="hide-sm muted">${esc(l.city || 'не определено')}</td>
          <td class="hide-sm mono muted">${esc(l.ip || '—')}</td>
          <td class="num muted">${fmtDateTime(l.at)}</td>
        </tr>`).join('')}</tbody></table>`;
    }

    /* ═══════════════ Безопасность ═══════════════ */
    async function viewSecurity() {
      const u = session.get().user || {};
      panel.innerHTML = `
        <div class="cover cover-security cover-pad" style="margin-bottom:var(--sp-5)">
          <span class="eyebrow">Защита счёта</span>
          <h2 style="margin:var(--sp-2) 0">Безопасность</h2>
          <p style="margin:0;max-width:52ch">Двухфакторная защита, антифишинг-код и контроль
             активных сессий — три меры, которые закрывают большую часть сценариев кражи доступа.</p>
        </div>

        <div class="g-2">
          <div class="card card-pad">
            <h3 style="margin-bottom:var(--sp-4)">Смена пароля</h3>
            <div class="field"><label>Текущий пароль</label>
              <input class="input" type="password" data-oldpw autocomplete="current-password"></div>
            <div class="field"><label>Новый пароль</label>
              <input class="input" type="password" data-newpw autocomplete="new-password">
              <span class="help">Минимум 8 символов. Смена закроет все прочие сессии.</span></div>
            <button class="btn btn-primary" data-chpw>Сменить пароль</button>
          </div>

          <div class="stack gap-5">
            <div class="card card-pad">
              <h3 style="margin-bottom:var(--sp-4)">Антифишинг-код</h3>
              <p class="muted" style="font-size:var(--fs-sm)">Настоящие письма MERIDIAN содержат
                 этот код. Письмо без него — подделка.</p>
              <div class="field"><div class="amount-input">
                <input class="mono" data-apcode value="${esc(u.antiPhishing || '')}" maxlength="24">
                <span class="suffix"><button class="btn-link" data-apsave>Сохранить</button></span>
              </div></div>
            </div>

            <div class="card card-pad">
              <div class="row between" style="margin-bottom:var(--sp-3)">
                <h3>Активные сессии</h3>
                <button class="btn btn-ghost btn-sm" data-revoke>Завершить прочие</button>
              </div>
              <div data-sessions><div class="skel" style="height:80px"></div></div>
            </div>
          </div>
        </div>`;

      const ses = await API.get('/me/sessions');
      qs('[data-sessions]', panel).innerHTML = ses.map((s, i) => `
        <div class="dev-row">
          <div class="ic">${ICONS[DEVICE_ICON[s.kind] || 'globe']}</div>
          <div><div class="t-main">${esc(s.os || '—')} · ${esc(s.browser || '—')}
            ${i === 0 ? '<span class="badge badge-up" style="margin-left:6px">текущая</span>' : ''}</div>
            <div class="t-sub mono">${esc(s.ip || '—')} · ${esc(s.city || 'расположение не определено')}</div></div>
          <div class="muted" style="font-size:var(--fs-xs);text-align:right">${timeAgo(s.lastActive)}</div>
        </div>`).join('');
    }

    /* ═══════════════ Устройства ═══════════════ */
    async function viewDevices() {
      panel.innerHTML = `<div class="card">
        <div class="card-hd"><h3>Известные устройства</h3></div>
        <div data-devs><div class="skel" style="height:160px;margin:var(--sp-4)"></div></div>
      </div>
      <div class="note note-info" style="margin-top:var(--sp-4)">${ICONS.info}
        <div>Отпечаток устройства складывается из типа, операционной системы и браузера.
        Это не идентификация личности — лишь способ отличить привычный вход от нового
        и вовремя предупредить вас.</div></div>`;

      const devs = await API.get('/me/devices');
      qs('[data-devs]', panel).innerHTML = devs.length ? devs.map(d => `
        <div class="dev-row">
          <div class="ic">${ICONS[DEVICE_ICON[d.kind] || 'globe']}</div>
          <div>
            <div class="t-main">${esc(d.label || '—')}</div>
            <div class="t-sub mono">${esc(d.ip || '—')} · ${esc(d.city || 'не определено')}</div>
          </div>
          <div style="text-align:right">
            <div class="muted" style="font-size:var(--fs-xs)">Впервые ${fmtDateTime(d.firstSeen)}</div>
            <div class="muted" style="font-size:var(--fs-xs)">Последний вход ${timeAgo(d.lastSeen)}</div>
          </div>
        </div>`).join('')
        : `<div class="empty"><p style="margin:0">Устройств пока не зафиксировано</p></div>`;
    }

    /* ═══════════════ Профиль ═══════════════ */
    function viewProfile() {
      const u = session.get().user || {};
      panel.innerHTML = `<div class="g-2">
        <div class="card card-pad">
          <h3 style="margin-bottom:var(--sp-4)">Основные данные</h3>
          <div class="field"><label>Имя</label>
            <input class="input" data-name value="${esc(u.name || '')}"></div>
          <div class="field"><label>Страна</label>
            <input class="input" data-country value="${esc(u.country || '')}"></div>
          <div class="field"><label>Электронная почта</label>
            <input class="input" value="${esc(u.email || '')}" disabled>
            <span class="help">Смена адреса — через поддержку, с подтверждением личности.</span></div>
          <button class="btn btn-primary" data-savep>Сохранить</button>
        </div>

        <div class="card card-pad">
          <h3 style="margin-bottom:var(--sp-4)">Реквизиты счёта</h3>
          <div class="kv-list">
            <div class="kv"><span>Идентификатор</span>
              <b class="mono" style="font-size:var(--fs-xs)">${esc(u.id || '—')}
                <button class="btn-link" data-copy="${esc(u.id || '')}">${ICONS.copy}</button></b></div>
            <div class="kv"><span>Открыт</span><b>${u.createdAt ? fmtDateTime(u.createdAt) : '—'}</b></div>
            <div class="kv"><span>Последний вход</span><b>${u.lastSeen ? timeAgo(u.lastSeen) : '—'}</b></div>
            <div class="kv"><span>Роль</span><b>${u.role === 'admin' ? 'Администратор'
              : u.role === 'support' ? 'Сотрудник поддержки' : 'Клиент'}</b></div>
          </div>

          <div style="margin-top:var(--sp-8);padding-top:var(--sp-6);
                      border-top:1px solid var(--line)">
            <h3 style="margin-bottom:var(--sp-2);font-size:var(--fs-base)">Завершение работы</h3>
            <p class="muted" style="font-size:var(--fs-sm);margin-bottom:var(--sp-4)">
              Выход завершит текущую сессию на этом устройстве.
              Остальные сессии продолжат работу — закрыть их можно в разделе
              «Безопасность».</p>
            <button class="btn btn-ghost" data-signout>${ICONS.logout}Выйти из счёта</button>
          </div>
        </div>
      </div>`;
    }

    /* ── Роутинг вкладок ── */
    const VIEWS = { overview: viewOverview, activity: viewActivity,
                    security: viewSecurity, devices: viewDevices, profile: viewProfile };

    async function paint() {
      qsa('[data-tab]', el).forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
      history.replaceState(null, '', `#/cabinet/${tab}`);
      repaint = null;
      paintCover();
      panel.innerHTML = '<div class="skel" style="height:280px"></div>';
      try { await VIEWS[tab](); }
      catch (e) {
        panel.innerHTML = `<div class="card"><div class="empty">
          <div class="ic">${ICONS.alert}</div>
          <h3 style="margin-bottom:var(--sp-2)">Не удалось загрузить раздел</h3>
          <p class="muted" style="margin:0">${esc(e.message || 'ошибка сети')}</p></div></div>`;
      }
    }

    /* ── События ── */
    on(el, 'click', '[data-tab]', (_e, t) => { tab = t.dataset.tab; paint(); });

    on(el, 'click', '[data-chpw]', async () => {
      const cur = qs('[data-oldpw]', panel).value;
      const nw = qs('[data-newpw]', panel).value;
      if (nw.length < 8) { toast({ title: 'Пароль короче 8 символов', kind: 'err' }); return; }
      try {
        await API.post('/me/password', { currentPassword: cur, newPassword: nw });
        toast({ title: 'Пароль изменён', msg: 'Прочие сессии завершены', kind: 'ok' });
        paint();
      } catch (e) { toast({ title: 'Не удалось сменить пароль', msg: e.message, kind: 'err' }); }
    });

    on(el, 'click', '[data-apsave]', async () => {
      const code = qs('[data-apcode]', panel).value.trim();
      try {
        await API.post('/me/anti-phishing', { code });
        await session.refresh();
        toast({ title: 'Антифишинг-код сохранён', kind: 'ok' });
      } catch (e) { toast({ title: 'Ошибка', msg: e.message, kind: 'err' }); }
    });

    on(el, 'click', '[data-revoke]', async () => {
      const ok = await confirmModal({
        title: 'Завершить прочие сессии',
        text: 'Все входы, кроме текущего, будут закрыты. На других устройствах потребуется войти заново.',
        okLabel: 'Завершить',
      });
      if (!ok) return;
      const r = await API.post('/me/sessions/revoke-all');
      toast({ title: 'Сессии завершены', msg: `Закрыто: ${r.revoked}`, kind: 'ok' });
      paint();
    });

    on(el, 'click', '[data-savep]', async () => {
      try {
        await API.post('/me/profile', {
          name: qs('[data-name]', panel).value,
          country: qs('[data-country]', panel).value,
        });
        await session.refresh();
        paintCover();
        toast({ title: 'Профиль сохранён', kind: 'ok' });
      } catch (e) { toast({ title: 'Ошибка', msg: e.message, kind: 'err' }); }
    });


    on(el, 'click', '[data-signout]', async () => {
      const ok = await confirmModal({
        title: 'Выйти из счёта',
        text: 'Сессия на этом устройстве будет завершена. Для возврата потребуется войти заново.',
        okLabel: 'Выйти',
      });
      if (!ok) return;
      await session.signOut();
      toast({ title: 'Вы вышли из счёта', kind: 'ok' });
    });

    bindCopy(el);
    el._mounted = () => { paint(); };

    const onResize = () => repaint?.();
    window.addEventListener('resize', onResize);
    el._cleanup = () => window.removeEventListener('resize', onResize);
    return el;
  },
};
