/* MERIDIAN — общие компоненты UI: шапка, подвал, таб-бар, модалки, тосты, иконки. */

import { BRAND, ASSETS, ASSET_MAP, TYPE_LABELS, COIN_ICONS } from './seed.js';
import * as store from './store.js';
import * as market from './market.js';
import { fmtUSD, fmtPrice, fmtPct, badgeClass, esc, fmtQty } from './format.js';
import { ICONS, CURRENCY_GLYPH } from './icons.js';
import * as session from './core/session.js';

export { ICONS, CURRENCY_GLYPH };

/* ── DOM-хелперы ──────────────────────────────────────────────────────── */

/** Создаёт элемент из HTML-строки. */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Делегирование событий: on(root,'click','.sel',handler) */
export function on(root, evt, sel, fn) {
  root.addEventListener(evt, e => {
    const t = e.target.closest(sel);
    if (t && root.contains(t)) fn(e, t);
  });
}

/* ── Иконки ───────────────────────────────────────────────────────────── */

/* Иконки — Tabler Icons (MIT), инлайнены в js/icons.js генератором.
   Импортируются выше и ре-экспортируются, поэтому все вью продолжают
   обращаться к ним как ui.ICONS.<имя>. */

/* ── Иконка актива ────────────────────────────────────────────────────── */

/**
 * Кружок актива. Три уровня качества, по убыванию:
 *   1. настоящий логотип из cryptocurrency-icons (CC0) — для 26 активов;
 *   2. глиф валюты из Tabler на фирменном фоне — для TRY/AED/KZT/UAH/XAG;
 *   3. тикер текстом на фирменном фоне — для остальных (TON, ARB, OP, SUI…).
 */
export function coinIcon(id, cls = '') {
  const a = ASSET_MAP[id];
  const title = esc(a?.name || id);

  if (COIN_ICONS.has(id)) {
    return `<img class="coin coin-img ${cls}" src="assets/icons/coins/${id.toLowerCase()}.svg"
                 alt="${esc(id)}" title="${title}" loading="lazy" decoding="async">`;
  }

  const color = a?.color || '#6b7280';
  const glyph = CURRENCY_GLYPH[id];
  if (glyph) {
    return `<span class="coin coin-glyph ${cls}" style="background:${color}" title="${title}">${glyph}</span>`;
  }

  const label = id.length > 4 ? id.slice(0, 3) : id.slice(0, 4);
  return `<span class="coin ${cls}" style="background:${color}" title="${title}">${esc(label)}</span>`;
}

/* ── Тосты ────────────────────────────────────────────────────────────── */

export function toast({ title, msg = '', kind = 'ok', ttl = 4200 }) {
  const layer = qs('#toast-layer');
  if (!layer) return;
  const node = h(`<div class="toast ${kind}">
    <div class="t-title">${esc(title)}</div>
    ${msg ? `<div class="t-msg">${esc(msg)}</div>` : ''}
  </div>`);
  layer.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 260);
  }, ttl);
}

/* ── Модальные окна ───────────────────────────────────────────────────── */

let modalEsc = null;

export function modal({ title, body, footer = '', width = 460 }) {
  const layer = qs('#modal-layer');
  layer.innerHTML = '';
  const node = h(`<div class="modal" style="max-width:${width}px">
    <div class="modal-hd"><h4>${esc(title)}</h4><button class="x" aria-label="Закрыть">${ICONS.x}</button></div>
    <div class="modal-bd"></div>
    ${footer ? `<div class="modal-ft">${footer}</div>` : ''}
  </div>`);
  const bd = qs('.modal-bd', node);
  if (typeof body === 'string') bd.innerHTML = body; else bd.appendChild(body);

  layer.appendChild(node);
  layer.hidden = false;

  const close = () => {
    layer.hidden = true;
    layer.innerHTML = '';
    if (modalEsc) { document.removeEventListener('keydown', modalEsc); modalEsc = null; }
  };
  qs('.x', node).addEventListener('click', close);
  layer.addEventListener('click', e => { if (e.target === layer) close(); });
  modalEsc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', modalEsc);

  return { node, close };
}

export function confirmModal({ title, text, okLabel = 'Подтвердить', danger = false }) {
  return new Promise(resolve => {
    const m = modal({
      title,
      body: `<p style="margin:0;color:var(--text)">${esc(text)}</p>`,
      footer: `<button class="btn btn-ghost" data-no>Отмена</button>
               <button class="btn ${danger ? 'btn-down' : 'btn-primary'}" data-yes>${esc(okLabel)}</button>`,
    });
    qs('[data-no]', m.node).addEventListener('click', () => { m.close(); resolve(false); });
    qs('[data-yes]', m.node).addEventListener('click', () => { m.close(); resolve(true); });
  });
}

/** Модалка выбора актива с поиском. */
export function assetPicker({ title = 'Выберите актив', filter = null, onPick }) {
  const list = ASSETS.filter(a => (filter ? filter(a) : true));
  const body = h(`<div>
    <div class="search-box" style="margin-bottom:12px">${ICONS.search}
      <input class="input" placeholder="Поиск по названию или тикеру" data-q autofocus>
    </div>
    <div class="picker-list" data-list></div>
  </div>`);

  const listEl = qs('[data-list]', body);
  const render = (q = '') => {
    const ql = q.trim().toLowerCase();
    const rows = list.filter(a =>
      !ql || a.id.toLowerCase().includes(ql) || a.name.toLowerCase().includes(ql));
    listEl.innerHTML = rows.length ? rows.map(a => `
      <div class="picker-item" data-id="${a.id}">
        ${coinIcon(a.id)}
        <div><div style="font-weight:600;color:var(--ink)">${esc(a.id)}</div>
             <div class="muted" style="font-size:12px">${esc(a.name)}</div></div>
        <div class="r"><div>${fmtPrice(market.price(a.id))}</div>
             <div class="muted" style="font-size:12px">${fmtQty(store.balance(a.id), a.dec)} в наличии</div></div>
      </div>`).join('')
      : `<div class="empty" style="padding:24px">Ничего не найдено</div>`;
  };
  render();

  const m = modal({ title, body });
  qs('[data-q]', body).addEventListener('input', e => render(e.target.value));
  on(body, 'click', '.picker-item', (_e, t) => { m.close(); onPick(t.dataset.id); });
  setTimeout(() => qs('[data-q]', body)?.focus(), 30);
  return m;
}

/* ── Знак ─────────────────────────────────────────────────────────────── */

/**
 * Логотип: глобус с меридианом и название антиквой.
 *
 * Меридиан — линия долготы, по которой сверяют время и координаты; отсюда и
 * имя площадки, и смысл знака: опорная линия. Круг — планета, эллипс —
 * меридиан в перспективе, засечки по краям — типографские приводные метки.
 *
 * Под основным контуром лежит его смещённая копия в цвете бренда: так в
 * типографии выглядит несовмещение красок. Приём делает знак печатным,
 * а не «нарисованным в редакторе».
 *
 * @param {'sm'|'md'|'lg'|'xl'} size
 * @param {{href?: string, label?: boolean}} opts
 */
export function mark(size = 'sm', { href = '#/', label = true } = {}) {
  const glyph = `
    <span class="mk-badge" aria-hidden="true">
      <svg class="mk-ghost" viewBox="0 0 100 100">
        <g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
          <circle cx="50" cy="50" r="33"></circle>
          <ellipse cx="50" cy="50" rx="12.5" ry="33" stroke-width="2.2"></ellipse>
          <line x1="50" y1="17" x2="50" y2="83" stroke-width="2.2"></line>
        </g>
        <circle cx="50" cy="50" r="4" fill="currentColor"></circle>
      </svg>
      <svg class="mk-main" viewBox="0 0 100 100">
        <g class="mk-tick" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square">
          <line x1="50" y1="2"  x2="50" y2="12"></line>
          <line x1="50" y1="88" x2="50" y2="98"></line>
          <line x1="2"  y1="50" x2="12" y2="50"></line>
          <line x1="88" y1="50" x2="98" y2="50"></line>
        </g>
        <circle class="mk-ring" cx="50" cy="50" r="33" pathLength="100" fill="none"
                stroke="currentColor" stroke-width="3.2" stroke-linecap="round"></circle>
        <ellipse class="mk-mer" cx="50" cy="50" rx="12.5" ry="33" pathLength="100" fill="none"
                 stroke="currentColor" stroke-width="2.4"></ellipse>
        <line class="mk-axis" x1="50" y1="17" x2="50" y2="83" pathLength="100"
              stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></line>
        <circle class="mk-dot" cx="50" cy="50" r="4.2" fill="currentColor"></circle>
      </svg>
    </span>`;

  const word = label ? '<span class="mk-word">MERIDIAN</span>' : '';
  const cls = `mark mark-${size}`;
  return href
    ? `<a href="${href}" class="${cls}" aria-label="MERIDIAN">${glyph}${word}</a>`
    : `<span class="${cls}">${glyph}${word}</span>`;
}

/* ── Шапка ────────────────────────────────────────────────────────────── */

const NAV = [
  { href: '#/markets', label: 'Рынки' },
  { href: '#/trade/BTC-USDT', label: 'Торговля' },
  { href: '#/convert', label: 'Обмен' },
  { href: '#/buy', label: 'Купить' },
  { href: '#/earn', label: 'Доход' },
];

export function renderHeader() {
  const el = qs('#site-header');
  const s = session.get();
  const signed = !!s.user;
  const initial = signed ? (s.user.name || s.user.email || 'К').trim()[0].toUpperCase() : '';
  const staff = ['admin', 'support'].includes(s.user?.role);

  el.innerHTML = `
    <div class="container header-inner">
      ${mark('sm', { href: '#/' })}
      <nav class="nav">
        ${NAV.map(n => `<a href="${n.href}"><span>${n.label}</span></a>`).join('')}
      </nav>
      <div class="header-spacer"></div>
      <div class="header-actions">
        <button id="feed-status" class="badge badge-neutral feed-chip" type="button">
          <span class="feed-dot"></span>…</button>
        <button class="btn btn-ghost btn-icon theme-toggle" data-theme-toggle
                title="Сменить тему" aria-label="Сменить тему">
          <span class="ic-sun">${ICONS.sun || ''}</span><span class="ic-moon">${ICONS.moon || ''}</span>
        </button>
        ${signed ? `
          <a class="btn btn-ghost btn-icon bell" href="#/notifications" title="Уведомления">
            ${ICONS.bell}${s.unread ? `<span class="bell-dot">${s.unread > 99 ? '99+' : s.unread}</span>` : ''}
          </a>
          <a class="btn btn-ghost btn-icon hide-sm" href="#/tickets" title="Поддержка">${ICONS.support}</a>
          ${staff ? `<a class="btn btn-ghost btn-sm hide-sm" href="#/admin">Панель</a>` : ''}
          <a class="acct-chip" href="#/cabinet" title="Личный кабинет">
            <span class="ava">${esc(initial)}</span>
            <span class="bal mono">${fmtUSD(s.portfolioUsd)}</span>
          </a>` : ''}
        <button class="menu-toggle" data-menu aria-label="Меню">${ICONS.menu}</button>
      </div>
    </div>`;

  qs('[data-menu]', el)?.addEventListener('click', openDrawer);
  markActiveNav();
  if (lastFeedStatus) renderFeedStatus(lastFeedStatus);
}

/** Подсветка активного пункта навигации. */
export function markActiveNav() {
  const hash = location.hash || '#/';
  qsa('#site-header .nav a').forEach(a => {
    const base = a.getAttribute('href').split('/')[1];
    a.classList.toggle('active', hash.split('/')[1] === base);
  });
  qsa('#mobile-tabbar .mt').forEach(a => {
    const base = a.getAttribute('href').split('/')[1] || '';
    a.classList.toggle('active', (hash.split('/')[1] || '') === base);
  });
}

/* ── Индикатор источника котировок ────────────────────────────────────── */

/**
 * Плашка в шапке: откуда сейчас берутся цены. Кликом открывает разбор
 * по провайдерам — какой ответил, какой отвалился.
 */
let lastFeedStatus = null;

export function renderFeedStatus(st) {
  if (st) lastFeedStatus = st;
  const host = qs('#feed-status');
  if (!host || !st) return;

  const live = st.mode === 'live' && st.liveCount > 0;
  const streaming = live && st.connected;
  const cls = !live ? 'badge-neutral' : streaming ? 'badge-up' : 'badge-gold';
  const label = !live ? 'Симулятор'
    : streaming ? `LIVE · ${st.liveCount}`
    : `Котировки · ${st.liveCount}`;

  host.className = `badge ${cls} feed-chip`;
  host.innerHTML = `<span class="feed-dot${streaming ? ' pulse' : ''}"></span>${esc(label)}`;
  host.title = 'Источник рыночных данных — нажмите для подробностей';

  host.onclick = () => {
    const rows = Object.entries(st.providers);
    modal({
      title: 'Источник рыночных данных',
      body: `
        <div class="rate-line"><span>Режим</span>
          <b>${st.mode === 'live' ? 'Биржевые данные' : 'Локальный симулятор'}</b></div>
        <div class="rate-line"><span>Поток WebSocket</span>
          <b class="${st.connected ? 'up' : 'muted'}">${st.connected ? 'подключён' : 'нет'}</b></div>
        <div class="rate-line"><span>Активов на реальных котировках</span>
          <b>${st.liveCount} из ${st.totalCount}</b></div>
        <div class="rate-line"><span>Последнее обновление</span>
          <b>${st.lastTick ? new Date(st.lastTick).toLocaleTimeString('ru-RU') : '—'}</b></div>

        <h4 style="margin:18px 0 8px;font-size:14px">Провайдеры</h4>
        ${rows.length ? rows.map(([n, s]) => `
          <div class="rate-line"><span>${esc(n)}</span>
            <b class="${s === 'ok' ? 'up' : 'down'}">${s === 'ok' ? 'отвечает' : 'недоступен'}</b></div>`).join('')
          : '<p class="help" style="margin:0">Внешние источники не опрашивались.</p>'}

        ${st.errors?.length ? `<div class="risk-note" style="margin-top:14px">
          ${st.errors.map(e => esc(e)).join('<br>')}</div>` : ''}

        <p class="help" style="margin-top:16px">
          Котировки агрегируются с публичных эндпоинтов Binance, Coinbase и CoinGecko.
          Ключи доступа не используются, сведения о вас третьим сторонам не передаются.
          По драгоценным металлам применяется расчётная котировка.
        </p>
        `,
    });
  };
}

/* ── Мобильный drawer ─────────────────────────────────────────────────── */

function openDrawer() {
  const s = session.get();
  const signed = !!s.user;
  const staff = ['admin', 'support'].includes(s.user?.role);
  const links = [
    ...NAV,
    ...(signed ? [
      { href: '#/cabinet', label: 'Личный кабинет' },
      { href: '#/wallet', label: 'Кошелёк' },
      { href: '#/notifications', label: `Уведомления${s.unread ? ` (${s.unread})` : ''}` },
      { href: '#/tickets', label: 'Поддержка' },
      ...(staff ? [{ href: '#/admin', label: 'Панель оператора' }] : []),
    ] : []),
    { href: '#/legal', label: 'Документы' },
  ];
  const d = h(`<div class="drawer open">
    <div class="scrim"></div>
    <div class="panel">
      <div class="row between" style="margin-bottom:16px">
        <b style="letter-spacing:.14em">МЕНЮ</b>
        <button class="x btn-link">${ICONS.x}</button>
      </div>
      ${links.map(l => `<a href="${l.href}">${l.label}</a>`).join('')}
      <div style="margin-top:20px">
        ${signed ? `<a class="btn btn-ghost btn-block" href="#/cabinet/profile">Настройки счёта</a>` : ''}
      </div>
    </div>
  </div>`);
  document.body.appendChild(d);
  const close = () => d.remove();
  qs('.scrim', d).addEventListener('click', close);
  qs('.x', d).addEventListener('click', close);
  qsa('a', d).forEach(a => a.addEventListener('click', close));
  qs('[data-out]', d)?.addEventListener('click', async () => {
    await session.signOut(); close(); location.hash = '#/';
  });
}

/* ── Нижняя мобильная навигация ───────────────────────────────────────── */

export function renderTabbar() {
  const el = qs('#mobile-tabbar');
  const tabs = [
    { href: '#/', label: 'Главная', icon: ICONS.home },
    { href: '#/markets', label: 'Рынки', icon: ICONS.chart },
    { href: '#/convert', label: 'Обмен', icon: ICONS.swap },
    { href: '#/wallet', label: 'Кошелёк', icon: ICONS.wallet },
    { href: '#/cabinet', label: 'Кабинет', icon: ICONS.user },
  ];
  el.innerHTML = tabs.map(t => `<a class="mt" href="${t.href}">${t.icon}<span>${t.label}</span></a>`).join('');
}

/* ── Подвал ───────────────────────────────────────────────────────────── */

export function renderFooter() {
  const el = qs('#site-footer');
  const cols = [
    { h: 'Продукты', links: [
      ['#/markets', 'Рынки'], ['#/trade/BTC-USDT', 'Спот-торговля'], ['#/convert', 'Мгновенный обмен'],
      ['#/buy', 'Купить за фиат'], ['#/earn', 'Доходные продукты'],
      ['#/oracle', 'Сводная цена по биржам'],
    ]},
    { h: 'Кабинет', links: [
      ['#/dashboard', 'Портфель'], ['#/wallet', 'Кошелёк'], ['#/account', 'Настройки'],
      ['#/account', 'Верификация'], ['#/account', 'API-ключи'],
    ]},
    { h: 'Документы', links: [
      ['#/legal/terms', 'Пользовательское соглашение'], ['#/legal/privacy', 'Политика конфиденциальности'],
      ['#/legal/aml', 'AML/KYC-политика'], ['#/legal/risk', 'Раскрытие рисков'],
      ['#/legal/fees', 'Комиссии и лимиты'], ['#/legal/licenses', 'Лицензии'],
    ]},
    { h: 'Компания', links: [
      ['#/support', 'Поддержка'], ['#/support', 'Контакты'], ['#/legal', 'Правовой центр'],
      ['#/legal/cookie', 'Cookie'], ['#/support', 'Статус системы'],
      ['#/admin', 'Панель оператора'],
    ]},
  ];

  el.innerHTML = `
    <div class="container">
      <div class="footer-inner">
        <div class="footer-col footer-brand">
          ${mark('md', { href: '#/' })}
          <p>${esc(BRAND.tagline)}. Обменник цифровых активов институционального уровня.</p>
          <p class="mono" style="font-size:12px;color:var(--faint);margin-top:12px">
            ${esc(BRAND.legalName)}<br>
            ${esc(BRAND.addresses[0].lines.join(', '))}<br>
            ${esc(BRAND.contacts.support)}
          </p>
        </div>
        ${cols.map(c => `
          <div class="footer-col">
            <h5>${c.h}</h5>
            ${c.links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
          </div>`).join('')}
      </div>
      <div class="risk-note">
        <b>Предупреждение о рисках.</b> Торговля цифровыми активами сопряжена с высоким
        риском и может привести к потере вложенных средств. Оценивайте допустимый уровень
        риска до совершения операций.
      </div>
      <div class="footer-bottom">
        <span>© ${new Date().getFullYear()} ${esc(BRAND.legalName)}. ${esc(BRAND.regNo)} · ${esc(BRAND.vasp)}</span>
        <span class="row gap-4">
          <a href="#/legal/terms">Условия</a>
          <a href="#/legal/privacy">Конфиденциальность</a>
          <a href="#/legal/cookie">Cookie</a>
        </span>
      </div>
    </div>`;
}

/* ── Заглушка «нужен вход» ────────────────────────────────────────────── */

export function authGate(text = 'Войдите, чтобы открыть этот раздел.') {
  return h(`<div class="container section">
    <div class="card card-pad center" style="max-width:460px;margin-inline:auto">
      <div class="empty" style="padding:8px 0 20px">
        <div class="ic">${ICONS.lock}</div>
        <h3 style="margin-bottom:8px">Требуется вход</h3>
        <p class="muted" style="margin:0">${esc(text)}</p>
      </div>
      <a class="btn btn-primary btn-block btn-lg" href="#/signin">Войти</a>
      <a class="btn btn-ghost btn-block" href="#/signup" style="margin-top:10px">Открыть счёт</a>
    </div>
  </div>`);
}

/* ── Небольшие переиспользуемые куски ─────────────────────────────────── */

/** Бейдж изменения цены. */
export function changeBadge(pct) {
  return `<span class="badge ${badgeClass(pct)}">${fmtPct(pct)}</span>`;
}

/** Строка «актив + название». */
export function assetCell(id, extra = '') {
  const a = ASSET_MAP[id];
  return `<div class="asset-cell">${coinIcon(id)}
    <div><div class="name">${esc(id)}</div>
    <div class="sym">${esc(a?.name || '')}${extra}</div></div></div>`;
}

/** Кнопка копирования в буфер. */
export function bindCopy(root) {
  on(root, 'click', '[data-copy]', async (_e, t) => {
    const val = t.dataset.copy;
    try {
      await navigator.clipboard.writeText(val);
      toast({ title: 'Скопировано', msg: val.length > 40 ? val.slice(0, 40) + '…' : val, kind: 'ok', ttl: 2000 });
    } catch {
      toast({ title: 'Не удалось скопировать', msg: 'Разрешите доступ к буферу обмена', kind: 'err' });
    }
  });
}

export { TYPE_LABELS };
