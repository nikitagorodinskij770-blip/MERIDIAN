/* MERIDIAN — точка входа.

   Порядок важен: сначала проверка домена, затем восстановление сессии,
   и только потом роутер. Иначе защищённая страница на первой загрузке
   мигнёт формой входа уже вошедшему человеку. */

import * as market from './market.js';
import * as feed from './api/feed.js';
import * as session from './core/session.js';
import { renderHeader, renderFooter, renderTabbar, renderFeedStatus, toast, qs } from './ui.js';
import { guardOrigin } from './util/origin-guard.js';
import router from './router.js';

async function boot() {
  // 1. Проверка домена — раньше всего: если страница открыта на подменённом
  //    адресе, человек должен узнать об этом до того, как увидит форму входа.
  guardOrigin();

  // 2. Рыночный движок: держит активы без биржевого источника и служит
  //    запасным вариантом, если сеть недоступна.
  market.start();

  // 3. Каркас
  renderFooter();
  renderTabbar();

  // 4. Сессия. Восстановление до старта роутера.
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

  // 7. Котировки уходят на сервер: у фронтенда уже есть живой поток, поэтому
  //    бэкенду незачем открывать собственные соединения к биржам.
  session.startPriceSync(market);

  // 8. Пересчёт оценки портфеля по мере движения рынка. Раз в 15 секунд:
  //    чаще — лишняя нагрузка, реже — цифра заметно отстаёт от графика.
  let last = 0;
  market.onTick(() => {
    if (!session.isSignedIn()) return;
    const now = Date.now();
    if (now - last < 15_000) return;
    last = now;
    const chip = qs('#site-header .acct-chip .bal');
    if (!chip) return;
    const usd = session.balanceList().reduce(
      (sum, b) => sum + parseFloat(b.available) * market.price(b.asset), 0);
    chip.textContent = '$' + usd.toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, ' ');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
