/* MERIDIAN — хеш-роутер с обязательной авторизацией.

   Правило доступа: закрыто всё, кроме первого экрана и юридических
   документов. Последние остаются публичными не по недосмотру — форма
   согласия при регистрации на них ссылается, и человек обязан иметь
   возможность прочитать условия до того, как их примет.

   Проверка выполняется на каждом переходе, а не один раз при загрузке:
   сессия может истечь или быть отозвана администратором посреди работы. */

import { qs, markActiveNav } from './ui.js';
import * as session from './core/session.js';

/** Первый сегмент пути → модуль вью. */
const ROUTES = {
  '':              './views/gate.js',
  'enter':         './views/gate.js',
  'markets':       './views/markets.js',
  'trade':         './views/trade.js',
  'convert':       './views/convert.js',
  'buy':           './views/buy.js',
  'earn':          './views/earn.js',
  'cabinet':       './views/cabinet.js',
  'wallet':        './views/wallet.js',
  'tickets':       './views/tickets.js',
  'notifications': './views/notifications.js',
  'admin':         './views/admin.js',
  'oracle':        './views/oracle.js',
  'legal':         './views/legal.js',
};

/** Разделы, открытые без входа. Всё, чего здесь нет, требует авторизации. */
const PUBLIC = new Set(['', 'enter', 'legal']);

/** Куда вести после успешного входа, если пользователь пришёл по ссылке. */
let intended = null;

let currentCleanup = null;
let navToken = 0;

function parse() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  return { seg: parts[0] || '', params: parts.slice(1), full: raw };
}

async function resolve() {
  const token = ++navToken;
  const { seg, params, full } = parse();
  const app = qs('#app');

  // Ждём проверки сессии: иначе защищённая страница мигнёт формой входа
  // тому, кто уже вошёл.
  if (!session.isReady()) return;

  if (currentCleanup) {
    try { currentCleanup(); } catch (e) { console.error(e); }
    currentCleanup = null;
  }

  const signedIn = session.isSignedIn();
  const isPublic = PUBLIC.has(seg);

  // Вошедшего с первого экрана уводим внутрь: показывать форму входа
  // тому, кто уже вошёл, бессмысленно.
  if (signedIn && (seg === '' || seg === 'enter')) {
    const target = intended || '#/markets';
    intended = null;
    location.hash = target;
    return;
  }

  // Не вошедшего заворачиваем на первый экран, запомнив, куда он шёл
  if (!signedIn && !isPublic) {
    intended = '#/' + full;
    location.hash = '#/enter';
    return;
  }

  const path = ROUTES[seg] ?? './views/notfound.js';

  let mod;
  try {
    mod = await import(path);
  } catch (e) {
    console.error('не удалось загрузить вью', path, e);
    mod = await import('./views/notfound.js');
  }
  if (token !== navToken) return;

  const view = mod.default || mod;
  document.title = view.title ? `${view.title} · MERIDIAN` : 'MERIDIAN — Digital Asset Exchange';

  app.innerHTML = '';

  let el;
  try {
    el = view.render({ params, seg });
  } catch (e) {
    console.error('ошибка рендера', seg, e);
    const fallback = await import('./views/notfound.js');
    el = fallback.default.render({ params: [], seg, error: e });
  }
  if (token !== navToken) return;

  app.appendChild(el);

  // Вью строится до вставки в документ, поэтому у элементов ещё нет размеров.
  // Хук вызывается после appendChild — здесь безопасно измерять и рисовать canvas.
  if (typeof el?._mounted === 'function') {
    try { el._mounted(); } catch (e) { console.error('ошибка _mounted', e); }
  }
  currentCleanup = el?._cleanup || null;

  markActiveNav();
  window.scrollTo(0, 0);

  // Каркас скрыт на первом экране: он часть презентации, а не приложения
  document.body.classList.toggle('is-gate', seg === '' || seg === 'enter');
}

export function go(hash) {
  if (location.hash === hash) resolve();
  else location.hash = hash;
}

export function start() {
  window.addEventListener('hashchange', resolve);

  // Выход возвращает на первый экран независимо от того, где человек был
  session.on('signout', () => { intended = null; location.hash = '#/enter'; });
  session.on('signin', resolve);

  if (!location.hash) location.hash = '#/';
  else resolve();
}

export default { start, go };
