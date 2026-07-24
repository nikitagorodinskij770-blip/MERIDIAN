/* Вход и регистрация — настоящие учётные записи на сервере. */

import * as session from '../core/session.js';
import { h, qs, toast, ICONS } from '../ui.js';
import { esc } from '../format.js';

export default {
  title: 'Вход',
  auth: false,

  render({ seg }) {
    const isSignup = seg === 'signup';

    const el = h(`<div class="container">
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="center" style="margin-bottom:var(--sp-6)">
            <h2>${isSignup ? 'Открытие счёта' : 'Вход в кабинет'}</h2>
            <p class="muted" style="margin-top:var(--sp-2)">
              ${isSignup
                ? 'Регистрация занимает минуту. Верификацию можно пройти позже.'
                : 'Введите данные учётной записи.'}</p>
          </div>

          <form data-form>
            ${isSignup ? `
              <div class="field">
                <label>Имя</label>
                <input class="input" data-name placeholder="Как к вам обращаться" autocomplete="name">
              </div>
              <div class="field">
                <label>Страна</label>
                <input class="input" data-country placeholder="Например: Эстония" autocomplete="country-name">
              </div>` : ''}

            <div class="field">
              <label>Электронная почта</label>
              <input class="input" type="email" data-email required
                     placeholder="you@example.com" autocomplete="email">
            </div>

            <div class="field">
              <label>Пароль</label>
              <input class="input" type="password" data-pass required
                     placeholder="Не короче 8 символов"
                     autocomplete="${isSignup ? 'new-password' : 'current-password'}">
              ${isSignup ? '<span class="help">Минимум 8 символов. Храните пароль в менеджере паролей.</span>' : ''}
            </div>

            ${isSignup ? `
              <label class="row gap-2" style="margin-bottom:var(--sp-4);font-size:var(--fs-sm)">
                <input type="checkbox" data-agree checked>
                <span>Принимаю <a href="#/legal/terms">условия</a>,
                  <a href="#/legal/privacy">политику конфиденциальности</a> и
                  <a href="#/legal/risk">раскрытие рисков</a></span>
              </label>` : `
              <div class="row between" style="margin-bottom:var(--sp-4);font-size:var(--fs-sm)">
                <span></span><a href="#/tickets">Не удаётся войти?</a>
              </div>`}

            <button class="btn btn-primary btn-block btn-lg" type="submit" data-submit>
              ${isSignup ? 'Открыть счёт' : 'Войти'}</button>
          </form>

          <div class="auth-alt">
            ${isSignup
              ? 'Уже есть счёт? <a href="#/signin">Войти</a>'
              : 'Нет счёта? <a href="#/signup">Открыть</a>'}
          </div>
        </div>

        <div class="note note-info" style="margin-top:var(--sp-4)">
          ${ICONS.shieldLock}
          <div>Пароль хранится в виде scrypt-хэша и не может быть восстановлен даже
             администратором. Вход с нового устройства сопровождается уведомлением.</div>
        </div>
      </div>
    </div>`);

    qs('[data-form]', el).addEventListener('submit', async e => {
      e.preventDefault();
      const btn = qs('[data-submit]', el);
      const email = qs('[data-email]', el).value.trim();
      const password = qs('[data-pass]', el).value;

      if (isSignup && !qs('[data-agree]', el).checked) {
        toast({ title: 'Примите условия', msg: 'Без согласия счёт не открывается', kind: 'err' });
        return;
      }

      btn.disabled = true;
      btn.textContent = isSignup ? 'Открываем счёт…' : 'Проверяем…';
      try {
        if (isSignup) {
          await session.signUp({
            email, password,
            name: qs('[data-name]', el).value.trim(),
            country: qs('[data-country]', el).value.trim(),
          });
          toast({ title: 'Счёт открыт', msg: 'Добро пожаловать в MERIDIAN', kind: 'ok' });
        } else {
          await session.signIn(email, password);
          toast({ title: 'Вход выполнен', kind: 'ok' });
        }
        location.hash = '#/cabinet';
      } catch (err) {
        const msg = {
          INVALID_CREDENTIALS: 'Неверная пара адрес и пароль',
          ACCOUNT_BLOCKED: 'Счёт заблокирован — обратитесь в поддержку',
          REGISTRATION_FAILED: 'Не удалось открыть счёт с этим адресом',
          WEAK_PASSWORD: 'Пароль короче 8 символов',
          RATE_LIMITED: 'Слишком много попыток, повторите позже',
          NETWORK: 'Сервер недоступен',
        }[err.code] || err.message;
        toast({ title: 'Не удалось', msg, kind: 'err' });
      } finally {
        btn.disabled = false;
        btn.textContent = isSignup ? 'Открыть счёт' : 'Войти';
      }
    });

    return el;
  },
};
