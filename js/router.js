/* MERIDIAN — хеш-роутер с ленивой загрузкой вью и жизненным циклом.
   → PROD: заменяется на файловый роутинг Next.js (App Router). */

import { qs, markActiveNav, authGate } from './ui.js';
import * as session from './core/session.js';

/** Первый сегмент пути → модуль вью. */
const ROUTES = {
  '':          './views/home.js',
  'markets':   './views/markets.js',
  'trade':     './views/trade.js',
  'convert':   './views/convert.js',
  'buy':       './views/buy.js',
  'earn':      './views/earn.js',
  'dashboard': './views/cabinet.js',
  'wallet':    './views/wallet.js',
  'account':   './views/cabinet.js',
  'signin':    './views/auth.js',
  'signup':    './views/auth.js',
  'legal':     './views/legal.js',
  'admin':     './views/admin.js',
  'cabinet':   './views/cabinet.js',
  'tickets':   './views/tickets.js',
  'notifications': './views/notifications.js',
  'oracle':    './views/oracle.js',
  'support':   './views/tickets.js',
};

let currentCleanup = null;
let navToken = 0;

/** '#/trade/BTC-USDT' → { seg:'trade', params:['BTC-USDT'] } */
function parse() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  return { seg: parts[0] || '', params: parts.slice(1), full: raw };
}

async function resolve() {
  const token = ++navToken;
  const { seg, params } = parse();
  const app = qs('#app');

  // Снимаем предыдущую вью
  if (currentCleanup) { try { currentCleanup(); } catch (e) { console.error(e); } currentCleanup = null; }

  const path = ROUTES[seg] ?? './views/notfound.js';

  let mod;
  try {
    mod = await import(path);
  } catch (e) {
    console.error('Не удалось загрузить вью', path, e);
    mod = await import('./views/notfound.js');
  }
  if (token !== navToken) return;   // навигация устарела — отменяем

  const view = mod.default || mod;
  document.title = view.title ? `${view.title} · MERIDIAN` : 'MERIDIAN — Digital Asset Exchange';

  app.innerHTML = '';

  // Гейт авторизации
  if (view.auth && !session.isSignedIn()) {
    app.appendChild(authGate(view.authText));
    markActiveNav();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    return;
  }

  let el;
  try {
    el = view.render({ params, seg });
  } catch (e) {
    console.error('Ошибка рендера вью', seg, e);
    const fallback = await import('./views/notfound.js');
    el = fallback.default.render({ params: [], seg, error: e });
  }
  if (token !== navToken) return;

  app.appendChild(el);

  // Вью отрисована до вставки в документ, поэтому размеров у элементов ещё нет.
  // Хук вызывается уже после вставки — здесь безопасно измерять и рисовать canvas.
  if (typeof el?._mounted === 'function') {
    try { el._mounted(); } catch (e) { console.error('ошибка _mounted', e); }
  }
  currentCleanup = el?._cleanup || null;

  markActiveNav();
  window.scrollTo(0, 0);
}

/** Программная навигация. */
export function go(hash) {
  if (location.hash === hash) resolve();
  else location.hash = hash;
}

export function start() {
  window.addEventListener('hashchange', resolve);
  if (!location.hash) location.hash = '#/';
  else resolve();
}

export default { start, go };
