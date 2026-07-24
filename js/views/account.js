/* Настройки аккаунта — профиль, верификация, безопасность, API-ключи, песочница. */

import { KYC_LEVELS, FEE_TIERS, BRAND } from '../seed.js';
import * as store from '../store.js';
import { h, qs, qsa, on, modal, toast, ICONS, bindCopy, confirmModal } from '../ui.js';
import { esc, fmtDateTime, shortAddr, fmtUSD } from '../format.js';

const TABS = [
  { id: 'profile',  label: 'Профиль' },
  { id: 'kyc',      label: 'Верификация' },
  { id: 'security', label: 'Безопасность' },
  { id: 'api',      label: 'API-ключи' },
  { id: 'fees',     label: 'Тарифы' },
  { id: 'sandbox',  label: 'Песочница' },
];

export default {
  title: 'Настройки',
  auth: true,
  authText: 'Войдите, чтобы открыть настройки счёта.',

  render({ params }) {
    let tab = TABS.some(t => t.id === params[0]) ? params[0] : 'profile';

    const el = h(`<div class="container section">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Аккаунт</span>
          <h1 style="margin-top:8px">Настройки</h1>
          <p class="muted">Профиль, лимиты, безопасность и управление демо-данными.</p>
        </div>
        <button class="btn btn-ghost" data-signout>Выйти из счёта</button>
      </div>

      <div class="chips" style="margin-bottom:22px" data-tabs>
        ${TABS.map(t => `<button class="chip${t.id === tab ? ' on' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
      </div>

      <div data-panel></div>
    </div>`);

    const panel = qs('[data-panel]', el);
    const U = () => store.getState().user || {};

    /* ─────────────── Профиль ─────────────── */
    function viewProfile() {
      const u = U();
      panel.innerHTML = `
        <div class="g-2">
          <div class="card card-pad">
            <h4 style="margin-bottom:18px">Основные данные</h4>
            <div class="field"><label>Имя</label>
              <input class="input" value="${esc(u.name || '')}" data-uname></div>
            <div class="field"><label>E-mail</label>
              <input class="input" value="${esc(u.email || '')}" data-uemail></div>
            <div class="field"><label>Идентификатор счёта</label>
              <div class="addr-box"><code>${esc(u.id || '—')}</code>
                <button class="btn btn-ghost btn-sm" data-copy="${esc(u.id || '')}">${ICONS.copy}</button></div></div>
            <button class="btn btn-primary" data-save>Сохранить</button>
          </div>

          <div class="stack gap-4">
            <div class="card card-pad">
              <h4 style="margin-bottom:14px">Сводка счёта</h4>
              <div class="rate-line"><span>Счёт открыт</span><b>${fmtDateTime(u.createdAt || Date.now())}</b></div>
              <div class="rate-line"><span>Тарифный уровень</span><b>${esc(u.tier || 'VIP 0')}</b></div>
              <div class="rate-line"><span>Уровень верификации</span><b>${u.kyc ?? 0}</b></div>
              <div class="rate-line"><span>Оценка портфеля</span><b>${fmtUSD(store.portfolioValue())}</b></div>
              <div class="rate-line"><span>Операций</span><b>${store.transactions().length}</b></div>
            </div>

            <div class="card card-pad">
              <h4 style="margin-bottom:14px">Отображение</h4>
              <label class="balance-row" style="padding:10px 0;cursor:pointer">
                <div><div style="color:var(--ink);font-weight:600">Скрывать суммы</div>
                  <div class="muted" style="font-size:12px">Маскирует балансы в интерфейсе</div></div>
                <input type="checkbox" data-hide${store.getState().settings.hideBalances ? ' checked' : ''}>
              </label>
            </div>
          </div>
        </div>`;
    }

    /* ─────────────── Верификация ─────────────── */
    function viewKyc() {
      const lvl = U().kyc ?? 0;
      panel.innerHTML = `
        <div class="card card-pad" style="margin-bottom:20px">
          <div class="stepper" style="margin-bottom:24px">
            ${KYC_LEVELS.map(k => `<div class="s ${k.level < lvl ? 'done' : k.level === lvl ? 'active' : ''}">
              Уровень ${k.level}<br><span style="font-weight:400;font-size:12px">${esc(k.name)}</span></div>`).join('')}
          </div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Уровень</th><th>Требуется</th>
              <th class="num">Лимит пополнения</th><th class="num">Лимит вывода</th><th></th></tr></thead>
            <tbody>${KYC_LEVELS.map(k => `<tr>
              <td><b style="color:var(--ink)">${k.level} · ${esc(k.name)}</b></td>
              <td class="muted">${esc(k.need)}</td>
              <td class="num">${esc(k.deposit)}</td>
              <td class="num">${esc(k.withdraw)}</td>
              <td class="num">${k.level <= lvl
                ? '<span class="badge badge-up">пройден</span>'
                : `<button class="btn btn-soft btn-sm" data-kyc="${k.level}">Пройти</button>`}</td>
            </tr>`).join('')}</tbody></table></div>
        </div>

        <div class="card card-pad">
          <div class="row gap-3">
            <span style="color:var(--warn);flex:none">${ICONS.shield}</span>
            <p class="help" style="margin:0">
              <b style="color:var(--ink)">Как это работает в проде.</b> Верификация выполняется
              внешним KYC-провайдером: документ и селфи проходят liveness-проверку, данные
              шифруются и хранятся отдельно от торгового контура, результат приходит вебхуком.
              Здесь уровень меняется мгновенно и ни на что не влияет.</p>
          </div>
        </div>`;
    }

    /* ─────────────── Безопасность ─────────────── */
    function viewSecurity() {
      const u = U();
      panel.innerHTML = `
        <div class="g-2">
          <div class="card card-pad">
            <h4 style="margin-bottom:18px">Защита счёта</h4>

            <div class="balance-row" style="padding:14px 0">
              <div class="row gap-3"><span style="color:var(--brand);flex:none">${ICONS.mobile}</span><div><div style="color:var(--ink);font-weight:600">Двухфакторная аутентификация</div>
                <div class="muted" style="font-size:12px">TOTP-приложение (Google Authenticator, Aegis)</div></div></div>
              <button class="btn ${u.twoFA ? 'btn-ghost' : 'btn-primary'} btn-sm" data-2fa>
                ${u.twoFA ? 'Отключить' : 'Включить'}</button>
            </div>

            <div class="balance-row" style="padding:14px 0">
              <div class="row gap-3"><span style="color:var(--brand);flex:none">${ICONS.shieldLock}</span><div><div style="color:var(--ink);font-weight:600">Антифишинг-код</div>
                <div class="muted mono" style="font-size:12px">${esc(u.antiPhishing || '—')}</div></div></div>
              <button class="btn btn-ghost btn-sm" data-antiphish>Обновить</button>
            </div>

            <div class="balance-row" style="padding:14px 0">
              <div class="row gap-3"><span style="color:var(--brand);flex:none">${ICONS.lock}</span><div><div style="color:var(--ink);font-weight:600">Белый список адресов</div>
                <div class="muted" style="font-size:12px">Вывод только на подтверждённые адреса</div></div></div>
              <span class="badge badge-neutral">выключен</span>
            </div>

            <div class="balance-row" style="padding:14px 0;border-bottom:none">
              <div class="row gap-3"><span style="color:var(--brand);flex:none">${ICONS.key}</span><div><div style="color:var(--ink);font-weight:600">Пароль</div>
                <div class="muted" style="font-size:12px">В песочнице не используется</div></div></div>
              <button class="btn btn-ghost btn-sm" disabled>Сменить</button>
            </div>
          </div>

          <div class="card">
            <div class="card-hd"><h4>Журнал сессий</h4></div>
            <div>
              ${[
                ['Текущая сессия', 'Windows · Chrome', 'сейчас', true],
                ['Вход в кабинет', 'Windows · Chrome', '2 часа назад', false],
                ['Просмотр кошелька', 'Windows · Chrome', 'вчера', false],
              ].map(([t, d, w, cur]) => `
                <div class="tx-row">
                  <div class="ic ${cur ? 'tx-in' : 'tx-neu'}">${ICONS.lock}</div>
                  <div><div style="color:var(--ink);font-weight:600;font-size:13px">${t}</div>
                       <div class="muted" style="font-size:12px">${d} · 127.0.0.1</div></div>
                  <span class="muted" style="font-size:12px">${w}</span>
                </div>`).join('')}
            </div>
            <div class="card-pad" style="padding-top:0">
              <div class="risk-note" style="margin-top:12px">
                Журнал демонстрационный. В проде фиксируются IP, устройство, гео и любые
                изменения настроек безопасности, с уведомлением на e-mail.
              </div>
            </div>
          </div>
        </div>`;
    }

    /* ─────────────── API ─────────────── */
    function viewApi() {
      const keys = store.getState().apiKeys;
      panel.innerHTML = `
        <div class="card" style="margin-bottom:20px">
          <div class="card-hd"><h4>API-ключи</h4>
            <button class="btn btn-primary btn-sm" data-newkey>Создать ключ</button></div>
          ${keys.length ? `<div class="table-wrap"><table class="tbl">
            <thead><tr><th>Название</th><th>Ключ</th><th class="hide-sm">Права</th>
              <th class="hide-sm">Создан</th><th></th></tr></thead>
            <tbody>${keys.map(k => `<tr>
              <td><b style="color:var(--ink)">${esc(k.label)}</b></td>
              <td class="mono" style="font-size:12px">
                <span data-copy="${esc(k.key)}" style="cursor:pointer">${shortAddr(k.key, 10, 6)}</span></td>
              <td class="hide-sm"><span class="badge badge-neutral">${k.perms.join(', ')}</span></td>
              <td class="hide-sm muted" style="font-size:12px">${fmtDateTime(k.created)}</td>
              <td class="num"><button class="btn btn-ghost btn-sm" data-revoke="${k.id}">Отозвать</button></td>
            </tr>`).join('')}</tbody></table></div>`
          : `<div class="empty"><div class="ic">${ICONS.layers}</div>
               <p>Ключей нет. Создайте ключ для доступа к REST и WebSocket API.</p></div>`}
        </div>

        <div class="card card-pad">
          <h4 style="margin-bottom:12px">Пример запроса</h4>
          <pre class="mono" style="background:var(--surface);padding:16px;border-radius:var(--r-sm);overflow:auto;font-size:12px;margin:0;color:var(--ink)">curl -H "Authorization: Bearer &lt;token&gt;" \\
     https://api.${esc(BRAND.domain)}/v1/wallet/balances

{ "data": [ { "asset": "USDT", "available": 24500.0, "locked": 0 } ],
  "error": null }</pre>
          <p class="help" style="margin-top:12px">
            Полное описание эндпоинтов, WebSocket-каналов и кодов ошибок — в проектной
            документации (PLAN.md, раздел 4). В песочнице API не поднят.</p>
        </div>`;
    }

    /* ─────────────── Тарифы ─────────────── */
    function viewFees() {
      panel.innerHTML = `
        <div class="card table-wrap" style="margin-bottom:20px">
          <table class="tbl">
            <thead><tr><th>Уровень</th><th>Объём за 30 дней</th>
              <th class="num">Мейкер</th><th class="num">Тейкер</th><th></th></tr></thead>
            <tbody>${FEE_TIERS.map((t, i) => `<tr>
              <td><b style="color:var(--ink)">${esc(t.tier)}</b></td>
              <td class="muted">${esc(t.vol)}</td>
              <td class="num">${t.maker.toFixed(3)}%</td>
              <td class="num">${t.taker.toFixed(3)}%</td>
              <td class="num">${i === 0 ? '<span class="badge badge-brand">ваш уровень</span>' : ''}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="g-2">
          <div class="card card-pad">
            <h4 style="margin-bottom:12px">Прочие комиссии</h4>
            <div class="rate-line"><span>Мгновенный обмен</span><b>0.35%</b></div>
            <div class="rate-line"><span>Покупка картой</span><b>1.80%</b></div>
            <div class="rate-line"><span>Банковский перевод</span><b>0.40%</b></div>
            <div class="rate-line"><span>P2P</span><b>0.00%</b></div>
            <div class="rate-line"><span>Внутренний перевод</span><b>бесплатно</b></div>
          </div>
          <div class="card card-pad">
            <h4 style="margin-bottom:12px">Комиссии сетей за вывод</h4>
            <div class="rate-line"><span>Bitcoin</span><b>≈ $2.40</b></div>
            <div class="rate-line"><span>ERC20</span><b>≈ $3.80</b></div>
            <div class="rate-line"><span>TRC20</span><b>≈ $1.00</b></div>
            <div class="rate-line"><span>BEP20 / Polygon</span><b>≈ $0.35</b></div>
            <div class="rate-line"><span>Solana / TON</span><b>≈ $0.02</b></div>
            <p class="help" style="margin-top:10px">Комиссия сети плавающая и берётся по факту.</p>
          </div>
        </div>`;
    }

    /* ─────────────── Песочница ─────────────── */
    function viewSandbox() {
      panel.innerHTML = `
        <div class="g-2">
          <div class="card card-pad">
            <h4 style="margin-bottom:12px">Данные песочницы</h4>
            <p class="muted" style="font-size:13px">
              Всё состояние демо-счёта хранится в <code class="mono">localStorage</code>
              под ключом <code class="mono">meridian.sandbox.v1</code>.
              Ничего не отправляется на сервер.</p>
            <div class="row gap-2 wrap" style="margin-top:16px">
              <button class="btn btn-ghost" data-export>Выгрузить JSON</button>
              <button class="btn btn-ghost" data-import>Загрузить JSON</button>
              <button class="btn btn-down" data-reset>Сбросить всё</button>
            </div>
          </div>

          <div class="card card-pad">
            <h4 style="margin-bottom:12px">Что здесь эмулируется</h4>
            <ul style="color:var(--text);padding-left:18px;margin:0;font-size:14px">
              <li>Цены — локальное случайное блуждание с возвратом к якорю</li>
              <li>Свечи, стакан и лента сделок — синтетические</li>
              <li>Пополнения — подтверждаются через 2.5–5 секунд</li>
              <li>Вывод — заявка обрабатывается за 3–5 секунд</li>
              <li>Лимитные ордера — исполняются при пересечении цены</li>
              <li>Адреса и хэши — правдоподобные, но несуществующие</li>
            </ul>
            <p class="help" style="margin-top:14px">
              Реальные интеграции подключаются по дорожной карте проекта.</p>
          </div>
        </div>`;
    }

    /* ─────────────── Роутинг вкладок ─────────────── */
    const VIEWS = { profile: viewProfile, kyc: viewKyc, security: viewSecurity, api: viewApi, fees: viewFees, sandbox: viewSandbox };
    function paint() {
      qsa('[data-tab]', el).forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
      VIEWS[tab]();
    }

    /* ── События ── */
    on(el, 'click', '[data-tab]', (_e, t) => { tab = t.dataset.tab; paint(); });
    on(el, 'click', '[data-signout]', () => { store.signOut(); location.hash = '#/'; });

    on(el, 'click', '[data-save]', () => {
      store.updateUser({
        name: qs('[data-uname]', panel).value.trim() || 'Демо-пользователь',
        email: qs('[data-uemail]', panel).value.trim(),
      });
      toast({ title: 'Профиль сохранён', kind: 'ok' });
    });

    on(el, 'change', '[data-hide]', (_e, t) => store.updateSettings({ hideBalances: t.checked }));

    on(el, 'click', '[data-kyc]', (_e, t) => {
      store.updateUser({ kyc: Number(t.dataset.kyc) });
      toast({ title: 'Уровень повышен', msg: `Верификация ${t.dataset.kyc} (эмуляция)`, kind: 'ok' });
      paint();
    });

    on(el, 'click', '[data-2fa]', () => {
      const now = !U().twoFA;
      store.updateUser({ twoFA: now });
      toast({ title: now ? '2FA включена' : '2FA отключена', msg: 'Эмуляция настройки', kind: now ? 'ok' : 'warn' });
      paint();
    });

    on(el, 'click', '[data-antiphish]', () => {
      const code = 'MERIDIAN-' + Math.random().toString(36).slice(2, 7).toUpperCase();
      store.updateUser({ antiPhishing: code });
      toast({ title: 'Антифишинг-код обновлён', msg: code, kind: 'ok' });
      paint();
    });

    on(el, 'click', '[data-newkey]', () => {
      const body = h(`<div>
        <div class="field"><label>Название ключа</label>
          <input class="input" placeholder="Например: торговый бот" data-klabel value="Мой ключ"></div>
        <p class="help">Секрет показывается один раз. В проде права ключа настраиваются
          гранулярно (чтение / торговля / вывод) и привязываются к IP.</p>
      </div>`);
      const m = modal({
        title: 'Новый API-ключ', body,
        footer: `<button class="btn btn-ghost" data-c>Отмена</button>
                 <button class="btn btn-primary" data-o>Создать</button>`,
      });
      qs('[data-c]', m.node).addEventListener('click', m.close);
      qs('[data-o]', m.node).addEventListener('click', () => {
        const k = store.createApiKey(qs('[data-klabel]', body).value.trim() || 'Ключ');
        m.close();
        modal({
          title: 'Ключ создан',
          body: `<div class="field"><label>API Key</label>
                   <div class="addr-box"><code>${esc(k.key)}</code>
                     <button class="btn btn-ghost btn-sm" data-copy="${esc(k.key)}">${ICONS.copy}</button></div></div>
                 <div class="field"><label>Secret</label>
                   <div class="addr-box"><code>${esc(k.secret)}</code>
                     <button class="btn btn-ghost btn-sm" data-copy="${esc(k.secret)}">${ICONS.copy}</button></div></div>
                 <p class="help">Сохраните секрет — повторно он не отображается.</p>`,
        });
        paint();
      });
    });

    on(el, 'click', '[data-revoke]', async (_e, t) => {
      const ok = await confirmModal({ title: 'Отозвать ключ', text: 'Ключ перестанет работать немедленно.', okLabel: 'Отозвать', danger: true });
      if (ok) { store.revokeApiKey(t.dataset.revoke); paint(); }
    });

    on(el, 'click', '[data-export]', () => {
      const blob = new Blob([store.exportState()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `meridian-sandbox-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast({ title: 'Файл выгружен', kind: 'ok' });
    });

    on(el, 'click', '[data-import]', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'application/json';
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return;
        try { store.importState(await f.text()); paint(); }
        catch (e) { toast({ title: 'Импорт не удался', msg: e.message, kind: 'err' }); }
      };
      inp.click();
    });

    on(el, 'click', '[data-reset]', async () => {
      const ok = await confirmModal({
        title: 'Сбросить песочницу',
        text: 'Будут удалены балансы, ордера, история и настройки. Действие необратимо.',
        okLabel: 'Сбросить', danger: true,
      });
      if (ok) { store.resetDemo(); location.hash = '#/'; }
    });

    bindCopy(el);
    paint();

    const offStore = store.on('change', () => { /* профиль перерисуем только по действию */ });
    el._cleanup = () => offStore();
    return el;
  },
};
