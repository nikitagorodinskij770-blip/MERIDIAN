/* MERIDIAN — глубина фона.

   Задача — не украсить страницу, а дать ей третье измерение: фон должен
   читаться как пространство за стеклом, а не как заливка позади блоков.

   Глубина здесь сделана параллаксом. Мозг определяет расстояние по тому,
   насколько сильно предмет смещается при движении наблюдателя: близкое
   уезжает быстро, далёкое почти стоит. Слои фона двигаются на разную долю
   от смещения курсора — и расстояние между ними появляется само, без
   перспективы и без единого нарисованного предмета.

   Модуль ничего не рисует и не трогает разметку: он только пишет две
   величины в CSS-переменные, а раскладку слоёв делает CSS. Поэтому
   отключение анимаций гасит эффект целиком, не ломая внешний вид.

   Курсор опрашивается не чаще кадра (requestAnimationFrame), а значение
   догоняет цель постепенно (интерполяция): рывок мыши превращается
   в плавный доворот, как у тяжёлой камеры. */

const EASE = 0.075;          // доля пути за кадр — меньше значение, тяжелее ход
const RANGE = 1;             // амплитуда в условных единицах, масштабирует CSS

let raf = 0;
let started = false;

const target = { x: 0, y: 0 };
const value = { x: 0, y: 0 };

function frame() {
  value.x += (target.x - value.x) * EASE;
  value.y += (target.y - value.y) * EASE;

  const root = document.documentElement;
  root.style.setProperty('--px', value.x.toFixed(4));
  root.style.setProperty('--py', value.y.toFixed(4));

  // Останавливаемся, когда движение стало неразличимым: незачем крутить
  // цикл ради смещения в тысячную пикселя.
  if (Math.abs(target.x - value.x) > 0.0005 || Math.abs(target.y - value.y) > 0.0005) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;
  }
}

function wake() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function onPointer(e) {
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  // Нормируем в -1…1 от центра экрана
  target.x = ((e.clientX / w) * 2 - 1) * RANGE;
  target.y = ((e.clientY / h) * 2 - 1) * RANGE;
  wake();
}

function onScroll() {
  // Глубина при прокрутке: дальние слои чуть «проваливаются» вниз медленнее
  const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const p = Math.min(1, Math.max(0, window.scrollY / max));
  document.documentElement.style.setProperty('--pscroll', p.toFixed(4));
}

/**
 * Запускает слежение. Ничего не делает при отключённых анимациях
 * и на сенсорных экранах, где курсора нет и параллакс некому вести.
 */
export function startDepth() {
  if (started) return;
  started = true;

  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  if (reduced || coarse) return;

  window.addEventListener('pointermove', onPointer, { passive: true });

  // Уводя курсор за пределы окна, возвращаем сцену в исходное положение,
  // иначе фон замирает перекошенным.
  window.addEventListener('pointerleave', () => { target.x = 0; target.y = 0; wake(); });
}

export default { startDepth };
