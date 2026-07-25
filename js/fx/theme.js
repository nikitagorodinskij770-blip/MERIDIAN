/* MERIDIAN — переключение темы.

   Начальное значение выставляет js/theme-boot.js ещё до отрисовки; здесь
   только смена по требованию и слежение за системной настройкой.

   Пока человек не выбрал тему сам, площадка следует настройке системы:
   вечером у него темнеет весь рабочий стол — незачем светить единственным
   белым окном. После явного выбора системные переключения игнорируются. */

const KEY = 'meridian.theme';

export function current() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function apply(theme, { persist = true } = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#080b11' : '#ffffff');

  if (persist) { try { localStorage.setItem(KEY, next); } catch { /* приватный режим */ } }
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  return next;
}

export function toggle() {
  return apply(current() === 'dark' ? 'light' : 'dark');
}

/** Следим за системной темой, пока выбор не сделан вручную. */
export function watchSystem() {
  if (!window.matchMedia) return;
  let chosen = null;
  try { chosen = localStorage.getItem(KEY); } catch { /* нет доступа */ }
  if (chosen === 'light' || chosen === 'dark') return;

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = e => apply(e.matches ? 'dark' : 'light', { persist: false });
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/** Кнопка в шапке перерисовывается вместе с ней, поэтому слушаем документ. */
export function bind() {
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-theme-toggle]');
    if (btn) { e.preventDefault(); toggle(); }
  });
  watchSystem();
}

export default { current, apply, toggle, bind, watchSystem };
