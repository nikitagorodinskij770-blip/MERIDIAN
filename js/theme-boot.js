/* MERIDIAN — выбор темы до первой отрисовки.

   Отдельный блокирующий скрипт в <head>, а не модуль: модули выполняются
   после разбора документа, и тёмная страница успевала бы мигнуть светлой.
   Здесь только чтение настройки и один атрибут — всё остальное решает CSS. */

(function () {
  var KEY = 'meridian.theme';
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* приватный режим */ }

  // Явный выбор человека важнее системного: он его уже сделал осознанно.
  var theme = (saved === 'light' || saved === 'dark') ? saved
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  document.documentElement.setAttribute('data-theme', theme);

  // Строка адреса и системные элементы браузера под цвет полотна
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#080b12' : '#ffffff');
})();
