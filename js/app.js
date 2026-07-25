/* MERIDIAN — точка входа.

   Порядок важен: проверка домена, затем сессия, и только потом роутер.
   Роутер не начнёт работу, пока не станет известно, вошёл человек или нет —
   иначе защищённая страница мигнёт формой входа уже вошедшему. */

import * as market from './market.js';
import * as feed from './api/feed.js';
import * as session from './core/session.js';
import { renderHeader, renderFooter, renderTabbar, renderFeedStatus, toast, qs } from './ui.js';
import { guardOrigin } from './util/origin-guard.js';
import * as theme from './fx/theme.js';
import { startDepth } from './fx/depth.js';
import router from './router.js';

async function boot() {
  // 1. Подменённый домен: человек должен узнать об этом до формы входа
  guardOrigin();

  // 2. Тема и глубина фона — до первой отрисовки содержимого
  theme.bind();
  startDepth();

  // 3. Рыночный движок — нужен и на первом экране для живой ленты котировок
  market.start();

  // 4. Каркас
  renderFooter();
  renderTabbar();

  // 4. Сессия. До её проверки роутер ничего не рисует.
  await session.restore();
  session.on('change', renderHeader);
  renderHeader();

  // 5. Роутер
  router.start();

  // 6. Биржевые котировки
  feed.onStatus(renderFeedStatus);
  feed.start('live').then(st => {
    renderFeedStatus(st);
    if (st.mode === 'live' && st.liveCount === 0) {
      toast({ title: 'Биржевые данные недоступны',
              msg: 'Котировки временно берутся из локального источника.', kind: 'warn' });
    }
  });

  // 7. Котировки уходят в базу: у фронтенда уже есть поток с бирж,
  //    поэтому серверу незачем открывать собственные соединения.
  session.startPriceSync(market);

  // 8. Оценка портфеля в шапке. Раз в 15 секунд: чаще — лишняя работа,
  //    реже — цифра заметно отстаёт от графика.
  let last = 0;
  market.onTick(() => {
    if (!session.isSignedIn()) return;
    const now = Date.now();
    if (now - last < 15_000) return;
    last = now;
    const chip = qs('#site-header .acct-chip .bal');
    if (!chip) return;
    const usd = session.balanceList().reduce(
      (sum, b) => sum + b.available * market.price(b.asset), 0);
    chip.textContent = '$' + usd.toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, ' ');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
