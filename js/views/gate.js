/* Первый экран: презентация слева, вход и регистрация справа.

   Единственная публичная страница приложения, если не считать юридических
   документов. Разделение продиктовано не только требованием закрыть доступ:
   форма согласия при регистрации ссылается на условия и политику
   конфиденциальности, поэтому они обязаны открываться до создания счёта. */

import * as session from '../core/session.js';
import * as market from '../market.js';
import { h, qs, qsa, on, toast, ICONS } from '../ui.js';
import { fmtPrice, fmtPct, dirClass, esc } from '../format.js';

const FACTS = [
  ['38', 'инструментов'],
  ['6', 'бирж в оракуле'],
  ['0.10%', 'комиссия мейкера'],
];

const POINTS = [
  ['bolt', 'Исполнение по приоритету «цена — время»',
   'Сделка проходит по цене заявки, уже стоявшей в книге. Агрессор не получает цену лучше выставленной.'],
  ['shieldLock', 'Средства считаются двойной записью',
   'Баланс — следствие журнала проводок, а не поле в таблице. Несведённая операция отклоняется до записи.'],
  ['trend', 'Сводная цена шести площадок',
   'Медиана, взвешенная по обороту, с отбраковкой выбросов. Одна биржа с тонкой ликвидностью не сдвинет курс.'],
];

const TICKER = ['BTC', 'ETH', 'SOL', 'XRP', 'TON'];

export default {
  title: 'Вход',
  auth: false,
  public: true,

  render({ params }) {
    let mode = params[0] === 'signup' ? 'signup' : 'signin';
    let busy = false;

    const el = h(`<div class="gate">

      <!-- ── Презентация ─────────────────────────────────── -->
      <section class="gate-pitch">
        <span class="mark mark-lg mark-intro">
          <span class="mk-badge" aria-hidden="true">
            <svg class="mk-ghost" viewBox="0 0 100 100">
              <g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                <circle cx="50" cy="50" r="33"></circle>
                <ellipse cx="50" cy="50" rx="12.5" ry="33" stroke-width="2.2"></ellipse>
                <line x1="50" y1="17" x2="50" y2="83" stroke-width="2.2"></line>
              </g>
              <circle cx="50" cy="50" r="4" fill="currentColor"></circle>
            </svg>
            <svg class="mk-main" viewBox="0 0 100 100" role="img" aria-label="MERIDIAN">
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
          </span>
          <span class="mk-word">MERIDIAN</span>
        </span>

        <h1>Опорный курс<br>цифровых активов</h1>

        <p class="lead">Спот-терминал, мгновенный обмен и фиатные шлюзы
           в едином счёте. Котировки агрегируются с шести площадок,
           средства учитываются двойной записью.</p>

        <div class="gate-facts">
          ${FACTS.map(([v, k]) => `
            <div class="f"><span class="fv">${esc(v)}</span><span class="fk">${esc(k)}</span></div>`).join('')}
        </div>

        <div class="gate-ticker" data-ticker>
          ${TICKER.map(a => `
            <div class="row" data-t="${a}">
              <span class="sym">${a} / USDT</span>
              <span class="px">—</span>
              <span class="ch">—</span>
            </div>`).join('')}
        </div>
      </section>

      <!-- ── Вход ────────────────────────────────────────── -->
      <section>
        <div class="gate-card">
          <div class="gate-tabs" data-tabs>
            <button data-mode="signin"${mode === 'signin' ? ' class="on"' : ''}>Вход</button>
            <button data-mode="signup"${mode === 'signup' ? ' class="on"' : ''}>Открыть счёт</button>
          </div>

          <form data-form novalidate>
            <div data-signup-only${mode === 'signin' ? ' hidden' : ''}>
              <div class="field">
                <label for="g-name">Имя</label>
                <input class="input" id="g-name" data-name autocomplete="name"
                       placeholder="Как к вам обращаться">
              </div>
            </div>

            <div class="field">
              <label for="g-email">Электронная почта</label>
              <input class="input" id="g-email" type="email" data-email required
                     autocomplete="email" placeholder="you@company.com">
            </div>

            <div class="field">
              <label for="g-pass">Пароль</label>
              <input class="input" id="g-pass" type="password" data-pass required
                     placeholder="Не короче 8 символов">
              <span class="help" data-passhint${mode === 'signin' ? ' hidden' : ''}>
                Минимум 8 символов. Пароль хранится как scrypt-хэш и не может
                быть восстановлен — сохраните его в менеджере паролей.</span>
            </div>

            <div data-signup-only${mode === 'signin' ? ' hidden' : ''}>
              <label class="row gap-2" style="margin-bottom:var(--sp-4);font-size:var(--fs-sm);
                     align-items:flex-start;line-height:var(--lh-snug)">
                <input type="checkbox" data-agree checked style="margin-top:3px">
                <span>Принимаю <a href="#/legal/terms">условия обслуживания</a>,
                  <a href="#/legal/privacy">политику конфиденциальности</a> и
                  <a href="#/legal/risk">раскрытие рисков</a></span>
              </label>
            </div>

            <button class="btn btn-primary btn-block btn-lg" type="submit" data-submit>
              ${mode === 'signin' ? 'Войти' : 'Открыть счёт'}</button>
          </form>

          <div data-signin-only${mode === 'signup' ? ' hidden' : ''}
               style="text-align:center;margin-top:var(--sp-4)">
            <button class="btn-link" style="font-size:var(--fs-sm)" data-forgot>
              Не удаётся войти?</button>
          </div>

          <!-- Счёт создан, но требуется подтверждение почты -->
          <div class="gate-sent" data-sent hidden>
            <span class="gate-sent-ic">${ICONS.mail}</span>
            <h3>Проверьте почту</h3>
            <p>Счёт создан на адрес <b data-sentmail></b>. Мы отправили письмо
               со ссылкой активации — откройте её, и вход заработает.</p>
            <p class="help">Письма нет через пару минут? Загляните в спам.
               Ссылка действует ограниченное время.</p>
            <button class="btn btn-ghost btn-block" data-backtologin>Вернуться ко входу</button>
          </div>

          <div class="note note-info" style="margin-top:var(--sp-6)">
            ${ICONS.shieldLock}
            <div>Вход с нового устройства сопровождается уведомлением.
                 Доступ к данным ограничен на уровне базы: увидеть чужой счёт
                 невозможно даже при полном доступе к коду страницы.</div>
          </div>
        </div>

        <div class="gate-points">
          ${POINTS.map(([ic, t, d]) => `
            <div class="gp">
              <span class="gp-ic">${ICONS[ic]}</span>
              <div><b>${esc(t)}</b><span>${esc(d)}</span></div>
            </div>`).join('')}
        </div>
      </section>
    </div>`);

    /* ── Переключение режима ── */
    function setMode(next) {
      mode = next;
      qsa('[data-mode]', el).forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
      qsa('[data-signup-only]', el).forEach(n => n.hidden = mode !== 'signup');
      qsa('[data-signin-only]', el).forEach(n => n.hidden = mode !== 'signin');
      qs('[data-passhint]', el).hidden = mode !== 'signup';
      qs('[data-submit]', el).textContent = mode === 'signin' ? 'Войти' : 'Открыть счёт';
      qs('[data-pass]', el).autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
      history.replaceState(null, '', `#/enter/${mode}`);
    }

    on(el, 'click', '[data-mode]', (_e, t) => setMode(t.dataset.mode));

    on(el, 'click', '[data-backtologin]', () => {
      qs('[data-sent]', el).hidden = true;
      qs('[data-form]', el).hidden = false;
      setMode('signin');
    });

    /* ── Отправка ── */
    qs('[data-form]', el).addEventListener('submit', async e => {
      e.preventDefault();
      if (busy) return;

      const email = qs('[data-email]', el).value.trim();
      const password = qs('[data-pass]', el).value;
      const name = qs('[data-name]', el)?.value.trim() || '';

      if (!email.includes('@')) {
        toast({ title: 'Проверьте адрес почты', kind: 'err' });
        return;
      }
      if (mode === 'signup') {
        if (password.length < 8) {
          toast({ title: 'Пароль короче 8 символов', kind: 'err' });
          return;
        }
        if (!qs('[data-agree]', el).checked) {
          toast({ title: 'Примите условия', msg: 'Без согласия счёт не открывается', kind: 'err' });
          return;
        }
      }

      const btn = qs('[data-submit]', el);
      busy = true;
      btn.disabled = true;
      btn.textContent = mode === 'signin' ? 'Проверяем…' : 'Открываем счёт…';

      try {
        if (mode === 'signup') {
          const r = await session.signUp({ email, password, name });
          if (r.needsConfirmation) {
            // Счёт создан, но вход закрыт до подтверждения почты. Исчезающее
            // уведомление здесь не годится: человек уходит в почтовый ящик и
            // возвращается на страницу, где о его счёте уже ничто не
            // напоминает — выглядит так, будто регистрация не сработала.
            // Поэтому состояние остаётся на экране, пока его не закроют.
            qs('[data-form]', el).hidden = true;
            qs('[data-signin-only]', el).hidden = true;
            qs('[data-sent]', el).hidden = false;
            qs('[data-sentmail]', el).textContent = email;
            return;
          }
          toast({ title: 'Счёт открыт', msg: 'Добро пожаловать в MERIDIAN', kind: 'ok' });
        } else {
          await session.signIn(email, password);
          toast({ title: 'Вход выполнен', kind: 'ok' });
        }
        location.hash = '#/markets';
      } catch (err) {
        const known = {
          invalid_credentials: 'Неверная пара адрес и пароль',
          invalid_grant: 'Неверная пара адрес и пароль',
          email_exists: 'Счёт с этим адресом уже открыт',
          user_already_exists: 'Счёт с этим адресом уже открыт',
          weak_password: 'Пароль слишком простой',
          email_address_invalid: 'Этот адрес почты не принимается',
          over_email_send_rate_limit: 'Слишком много попыток, повторите позже',
          email_not_confirmed: 'Подтвердите адрес почты по ссылке из письма',
          NETWORK: 'Сервер недоступен, проверьте соединение',
        };
        toast({ title: 'Не удалось',
                msg: known[err.code] || err.message || 'Повторите попытку', kind: 'err' });
      } finally {
        busy = false;
        btn.disabled = false;
        btn.textContent = mode === 'signin' ? 'Войти' : 'Открыть счёт';
      }
    });

    on(el, 'click', '[data-forgot]', async () => {
      const email = qs('[data-email]', el).value.trim();
      if (!email.includes('@')) {
        toast({ title: 'Укажите почту', msg: 'Введите адрес — вышлем ссылку восстановления', kind: 'warn' });
        qs('[data-email]', el).focus();
        return;
      }
      try {
        await session.resetPassword(email);
        toast({ title: 'Письмо отправлено',
                msg: 'Проверьте почту — там ссылка для смены пароля', kind: 'ok' });
      } catch (e) {
        toast({ title: 'Не удалось отправить', msg: e.message, kind: 'err' });
      }
    });

    /* ── Живые котировки ── */
    const paintTicker = () => {
      qsa('[data-t]', el).forEach(row => {
        const id = row.dataset.t;
        const p = market.price(id);
        if (!p) return;
        const chg = market.change24(id);
        qs('.px', row).textContent = fmtPrice(p);
        const c = qs('.ch', row);
        c.textContent = fmtPct(chg);
        c.className = 'ch ' + dirClass(chg);
      });
    };
    paintTicker();
    const off = market.onTick(paintTicker);

    el._mounted = () => qs('[data-email]', el)?.focus();
    el._cleanup = () => off();
    return el;
  },
};
