/* Главная — публичная витрина площадки.

   Единственная страница, которую видно до входа наравне с формой и правовыми
   документами. Её работа — не «продать», а показать, что площадка живая:
   котировки идут прямо здесь, цифры настоящие, устройство объяснено словами,
   а не обещаниями. Поэтому первым экраном идёт рынок, а не картинка.

   Порядок блоков подчинён вопросу читателя, который меняется по мере
   прокрутки: «что это» → «правда ли живое» → «что тут торгуется» →
   «что сейчас происходит» → «как устроено» → «можно ли верить» → «начать». */

import { ASSET_MAP, BRAND } from '../seed.js';
import * as market from '../market.js';
import * as session from '../core/session.js';
import { h, qs, qsa, coinIcon, ICONS, mark } from '../ui.js';
import { fmtPrice, fmtPct, fmtCompact, fmtNum, dirClass, priceDecimals, esc } from '../format.js';
import { drawSparkline, drawArea } from '../charts.js';

/* Лента: широкий набор, чтобы строка не выглядела короткой */
const TAPE = ['BTC', 'ETH', 'SOL', 'XRP', 'TON', 'BNB', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'XAU'];

/* Витрина рынка на главной */
const BOARD = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'TON', 'ADA', 'AVAX'];

const PILLARS = [
  ['shieldLock', 'Двойная запись',
   'Баланс — следствие журнала проводок, а не поле в таблице. Операция, которая не сходится, отклоняется до записи, а не после неё.'],
  ['bolt', 'Приоритет «цена — время»',
   'Сделка проходит по цене заявки, уже стоявшей в книге. Агрессор не получает цену лучше выставленной — очередь честная.'],
  ['trend', 'Сводная цена шести площадок',
   'Медиана, взвешенная по обороту, с отбраковкой выбросов. Одна биржа с тонкой ликвидностью не сдвинет ваш курс.'],
  ['lock', 'Доступ решает хранилище',
   'Права проверяются в базе, а не в интерфейсе. Увидеть чужой счёт нельзя даже с полным доступом к коду страницы.'],
];

export default {
  title: 'Опорный курс цифровых активов',
  auth: false,
  public: true,

  render() {
    const signed = session.isSignedIn();
    const cta = signed
      ? { href: '#/markets', label: 'В терминал' }
      : { href: '#/enter/signup', label: 'Открыть счёт' };

    const el = h(`<div class="home">

      <!-- ═══ Первый экран ═══════════════════════════════════════ -->
      <section class="hm-hero">
        <div class="container hm-hero-in">

          <div class="hm-hero-copy">
            <span class="eyebrow">${esc(BRAND.legalName)} · Таллин</span>
            <h1>Опорный курс<br>цифровых активов</h1>
            <p class="lead">Спот-терминал, мгновенный обмен и фиатные шлюзы в одном счёте.
               Котировки сводятся с шести площадок, средства учитываются двойной записью.</p>

            <div class="hm-cta">
              <a class="btn btn-primary btn-lg" href="${cta.href}">
                ${cta.label}${ICONS.chevronRight}</a>
              <a class="btn btn-ghost btn-lg" href="#/markets">Смотреть рынки</a>
            </div>

            <ul class="hm-trust">
              <li>${ICONS.check}Ввод средств без комиссии</li>
              <li>${ICONS.check}Вывод в восьми сетях</li>
              <li>${ICONS.check}Журнал операций с аудитом</li>
            </ul>
          </div>

          <!-- Живой пульс: настоящий график и настоящая цена -->
          <figure class="hm-pulse card" data-pulse>
            <figcaption class="hm-pulse-head">
              <span class="hm-pulse-sym">${coinIcon('BTC', 'sm')}<b>BTC / USDT</b></span>
              <span class="hm-live"><span class="feed-dot"></span>живые котировки</span>
            </figcaption>
            <div class="hm-pulse-px">
              <span class="v mono" data-px>—</span>
              <span class="c mono" data-ch>—</span>
            </div>
            <div class="hm-pulse-chart"><canvas data-area></canvas></div>
            <div class="hm-pulse-foot">
              <div><span>Максимум 24ч</span><b class="mono" data-hi>—</b></div>
              <div><span>Минимум 24ч</span><b class="mono" data-lo>—</b></div>
              <div><span>Оборот 24ч</span><b class="mono" data-vol>—</b></div>
            </div>
          </figure>
        </div>

        <!-- Бегущая строка котировок -->
        <div class="hm-tape" data-tape>
          <div class="hm-tape-row" data-taperow></div>
        </div>
      </section>

      <!-- ═══ Витрина рынка ══════════════════════════════════════ -->
      <section class="container hm-sec">
        <header class="hm-sec-head">
          <div>
            <span class="eyebrow">Рынки</span>
            <h2>Что торгуется прямо сейчас</h2>
          </div>
          <a class="btn btn-ghost btn-sm" href="#/markets">Все инструменты${ICONS.chevronRight}</a>
        </header>
        <div class="hm-board" data-board></div>
      </section>

      <!-- ═══ Сводка рынка ═══════════════════════════════════════ -->
      <section class="container hm-sec">
        <header class="hm-sec-head">
          <div>
            <span class="eyebrow">Сводка</span>
            <h2>Что происходит на рынке</h2>
            <p class="hm-sec-note">Считается из живых котировок площадки и обновляется вместе с ними.</p>
          </div>
        </header>
        <div class="hm-wire" data-wire></div>
      </section>

      <!-- ═══ Устройство ═════════════════════════════════════════ -->
      <section class="hm-band">
        <div class="container hm-sec">
          <header class="hm-sec-head">
            <div>
              <span class="eyebrow">Устройство</span>
              <h2>Почему этому можно верить</h2>
              <p class="hm-sec-note">Четыре решения приняты в основании — и потому не зависят
                 от добросовестности интерфейса.</p>
            </div>
          </header>
          <div class="hm-pillars">
            ${PILLARS.map(([ic, t, d], i) => `
              <article class="hm-pillar">
                <span class="hm-pillar-n mono">${String(i + 1).padStart(2, '0')}</span>
                <span class="hm-pillar-ic">${ICONS[ic] || ''}</span>
                <h3>${esc(t)}</h3>
                <p>${esc(d)}</p>
              </article>`).join('')}
          </div>
        </div>
      </section>

      <!-- ═══ Показатели ═════════════════════════════════════════ -->
      <section class="container hm-sec">
        <div class="hm-stats">
          <div class="hm-stat"><b>38</b><span>инструментов</span></div>
          <div class="hm-stat"><b>6</b><span>бирж в оракуле</span></div>
          <div class="hm-stat"><b>0.10%</b><span>комиссия мейкера</span></div>
          <div class="hm-stat"><b>8</b><span>сетей для вывода</span></div>
        </div>
      </section>

      <!-- ═══ Призыв ═════════════════════════════════════════════ -->
      <section class="container hm-sec">
        <div class="hm-final">
          <div class="hm-final-mark">${mark('lg', { href: null })}</div>
          <h2>Счёт открывается за минуту</h2>
          <p>Почта и пароль — и терминал доступен. Верификация нужна только для вывода средств.</p>
          <div class="hm-cta">
            <a class="btn btn-primary btn-lg" href="${cta.href}">${cta.label}</a>
            <a class="btn btn-ghost btn-lg" href="#/legal/terms">Условия обслуживания</a>
          </div>
        </div>
      </section>
    </div>`);

    /* ── Бегущая строка ──
       Содержимое дублируется: вторая копия въезжает следом за первой,
       поэтому шов не виден и лента выглядит бесконечной. */
    function buildTape() {
      const cell = id => {
        const chg = market.change24(id);
        return `<span class="hm-tape-cell">
          <b>${id}</b>
          <span class="mono px">${fmtPrice(market.price(id))}</span>
          <span class="mono ch ${dirClass(chg)}">${fmtPct(chg)}</span>
        </span>`;
      };
      const once = TAPE.map(cell).join('');
      qs('[data-taperow]', el).innerHTML = once + once;
    }

    /* ── Пульс ── */
    const areaCanvas = qs('[data-area]', el);

    function paintPulse() {
      const p = market.price('BTC');
      const chg = market.change24('BTC');
      const dec = priceDecimals(p);
      qs('[data-px]', el).textContent = fmtNum(p, dec, dec);
      const c = qs('[data-ch]', el);
      c.textContent = fmtPct(chg);
      c.className = 'c mono ' + dirClass(chg);
      qs('[data-hi]', el).textContent = fmtPrice(market.high24('BTC'));
      qs('[data-lo]', el).textContent = fmtPrice(market.low24('BTC'));
      qs('[data-vol]', el).textContent = '$' + fmtCompact(market.volume24('BTC'));

      // Закрытия свечей, а не спарклайн: спарклайн копится с момента загрузки
      // страницы и за минуту набирает разброс в сотую долю процента — такая
      // линия рисует шум округления, а не движение цены. Свечи покрывают
      // сутки с лишним, и на них видно, что рынок действительно делал.
      const series = market.candles('BTC-USDT', 900_000).map(c => c.c).filter(Number.isFinite);
      if (series.length > 1) {
        const css = getComputedStyle(document.documentElement);
        const col = css.getPropertyValue(chg >= 0 ? '--up' : '--down').trim();
        drawArea(areaCanvas, series, { color: col });
      }
    }

    /* ── Витрина ── */
    function paintBoard() {
      qs('[data-board]', el).innerHTML = BOARD.map(id => {
        const a = ASSET_MAP[id];
        const chg = market.change24(id);
        return `<a class="hm-row" href="#/trade/${id}-USDT">
          <span class="hm-row-a">${coinIcon(id, 'sm')}
            <span class="hm-row-name"><b>${id}</b><i>${esc(a?.name || '')}</i></span></span>
          <span class="hm-row-spark"><canvas data-spark="${id}"></canvas></span>
          <span class="hm-row-px mono">${fmtPrice(market.price(id))}</span>
          <span class="hm-row-ch mono ${dirClass(chg)}">${fmtPct(chg)}</span>
        </a>`;
      }).join('');
      paintSparks();
    }

    function paintSparks() {
      const css = getComputedStyle(document.documentElement);
      const up = css.getPropertyValue('--up').trim();
      const down = css.getPropertyValue('--down').trim();
      qsa('[data-spark]', el).forEach(cv => {
        const id = cv.dataset.spark;
        const data = market.sparkline(id);
        if (data.length > 1) drawSparkline(cv, data, market.change24(id) >= 0 ? up : down);
      });
    }

    /* ── Сводка ──
       Это не новости: здесь нет ни одного утверждения, которого нет в самих
       котировках. Каждая строка — вычисленный факт, и рядом сказано, из чего
       он посчитан. Придуманных поводов и заголовков тут быть не должно. */
    function paintWire() {
      const ids = Object.keys(ASSET_MAP).filter(id =>
        ASSET_MAP[id]?.type === 'crypto' && market.price(id) > 0);
      if (!ids.length) return;

      const byChg = [...ids].sort((a, b) => market.change24(b) - market.change24(a));
      const top = byChg[0];
      const bottom = byChg[byChg.length - 1];

      const nearHigh = ids.map(id => {
        const hi = market.high24(id), lo = market.low24(id), p = market.price(id);
        return { id, pos: hi > lo ? (p - lo) / (hi - lo) : 0 };
      }).sort((a, b) => b.pos - a.pos)[0];

      const widest = ids.map(id => {
        const hi = market.high24(id), lo = market.low24(id);
        return { id, span: lo > 0 ? (hi - lo) / lo * 100 : 0 };
      }).sort((a, b) => b.span - a.span)[0];

      const rising = ids.filter(id => market.change24(id) > 0).length;
      const share = Math.round(rising / ids.length * 100);

      const items = [
        {
          tag: 'Лидер роста', ic: 'trend', dir: 'up',
          title: `${top} прибавляет ${fmtPct(market.change24(top))} за сутки`,
          body: `${ASSET_MAP[top]?.name || top} торгуется по ${fmtPrice(market.price(top))}. ` +
                `Лучшая динамика среди ${ids.length} инструментов витрины.`,
          href: `#/trade/${top}-USDT`,
        },
        market.change24(bottom) < 0 && {
          tag: 'Под давлением', ic: 'trendDown', dir: 'down',
          // Величину берём по модулю и без знака: направление уже сказано
          // словом «теряет», а «теряет +5.30%» или «теряет -5.30%» читается
          // как ошибка — в первом случае противоречие, во втором двойное
          // отрицание. Форматтер процентов всегда ставит знак, поэтому здесь
          // число собирается вручную.
          title: `${bottom} теряет ${Math.abs(market.change24(bottom)).toFixed(2)}%`,
          body: `${ASSET_MAP[bottom]?.name || bottom} по ${fmtPrice(market.price(bottom))} — ` +
                `слабейший результат за сутки.`,
          href: `#/trade/${bottom}-USDT`,
        },
        {
          tag: 'Ширина рынка', ic: 'chart', dir: share >= 50 ? 'up' : 'down',
          title: `${share}% инструментов в плюсе`,
          body: `Растут ${rising} из ${ids.length}. Считается по тем же котировкам, ` +
                `что идут в терминал, и обновляется на каждом тике.`,
          href: '#/markets',
        },
        widest && widest.span > 0 && {
          tag: 'Волатильность', ic: 'bolt', dir: 'neutral',
          title: `Самый широкий диапазон у ${widest.id}`,
          body: `Между суточным минимумом и максимумом — ${widest.span.toFixed(1)}%. ` +
                `Для лимитной заявки это более далёкие уровни исполнения.`,
          href: `#/trade/${widest.id}-USDT`,
        },
        nearHigh && {
          tag: 'У максимума', ic: 'layers', dir: 'up',
          title: `${nearHigh.id} держится у верхней границы суток`,
          body: `Цена в ${Math.round(nearHigh.pos * 100)}% суточного диапазона, считая от ` +
                `минимума — ближе к максимуму, чем остальные.`,
          href: `#/trade/${nearHigh.id}-USDT`,
        },
      ].filter(Boolean);

      qs('[data-wire]', el).innerHTML = items.map(w => `
        <a class="hm-wire-item" href="${w.href}">
          <span class="hm-wire-ic ${w.dir}">${ICONS[w.ic] || ICONS.chart}</span>
          <span class="hm-wire-body">
            <span class="hm-wire-tag">${esc(w.tag)}</span>
            <b>${esc(w.title)}</b>
            <span class="hm-wire-text">${esc(w.body)}</span>
          </span>
        </a>`).join('');
    }

    /* ── Появление по мере прокрутки ──
       Не украшение: движение подсказывает, что ниже есть ещё содержимое.
       При отключённых анимациях всё видно сразу. */
    function observeReveal() {
      const targets = qsa('.hm-sec, .hm-pillar, .hm-row, .hm-wire-item', el);
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !window.IntersectionObserver) {
        targets.forEach(t => t.classList.add('in'));
        return null;
      }
      targets.forEach(t => t.classList.add('reveal'));
      const io = new IntersectionObserver((entries, obs) => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          e.target.classList.add('in');
          obs.unobserve(e.target);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: .08 });
      targets.forEach(t => io.observe(t));
      return io;
    }

    /* Полная перерисовка — только при монтировании и смене темы.
       На тике обновляем числа: перерисовка витрины сбрасывала бы наведение
       и заставляла браузер заново раскладывать страницу. */
    function paintNumbers() {
      buildTape();
      paintPulse();
      BOARD.forEach(id => {
        const row = qs(`[data-spark="${id}"]`, el)?.closest('.hm-row');
        if (!row) return;
        const chg = market.change24(id);
        qs('.hm-row-px', row).textContent = fmtPrice(market.price(id));
        const c = qs('.hm-row-ch', row);
        c.textContent = fmtPct(chg);
        c.className = 'hm-row-ch mono ' + dirClass(chg);
      });
      paintSparks();
      paintWire();
    }

    let io = null;
    el._mounted = () => {
      buildTape(); paintPulse(); paintBoard(); paintWire();
      requestAnimationFrame(() => { paintPulse(); paintSparks(); });
      io = observeReveal();
    };

    const offTick = market.onTick(paintNumbers);
    const onResize = () => { paintPulse(); paintSparks(); };
    const onTheme = () => { paintPulse(); paintSparks(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('themechange', onTheme);

    el._cleanup = () => {
      offTick();
      io?.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('themechange', onTheme);
    };

    return el;
  },
};
