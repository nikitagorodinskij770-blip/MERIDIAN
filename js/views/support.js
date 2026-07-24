/* Поддержка — контакты, адреса, FAQ, статус систем, форма обращения. */

import { BRAND, FAQ } from '../seed.js';
import { h, qs, on, toast, ICONS, bindCopy } from '../ui.js';
import { esc } from '../format.js';

const STATUS = [
  ['Торговый движок', 'ok', '99.99%'],
  ['Приём депозитов', 'ok', '100%'],
  ['Обработка выводов', 'ok', '99.97%'],
  ['Фиатные шлюзы', 'warn', 'плановые работы'],
  ['REST / WebSocket API', 'ok', '99.98%'],
];

export default {
  title: 'Поддержка',
  auth: false,

  render() {
    const el = h(`<div class="container section">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Помощь</span>
          <h1 style="margin-top:8px">Поддержка и контакты</h1>
          <p class="muted">Служба поддержки работает круглосуточно. Среднее время первого
             ответа в чате — 3 минуты.</p>
        </div>
      </div>

      <div class="g-side">

        <div class="stack gap-6">
          <!-- FAQ -->
          <div class="card">
            <div class="card-hd"><h4>Частые вопросы</h4></div>
            <div>
              ${FAQ.map((f, i) => `
                <div style="border-bottom:1px solid var(--line)">
                  <button class="row between" data-faq="${i}"
                          style="width:100%;background:none;border:none;padding:16px 24px;text-align:left;gap:16px">
                    <span style="color:var(--ink);font-weight:600">${esc(f.q)}</span>
                    <span class="muted" data-sign="${i}" style="flex:none">${ICONS.plus}</span>
                  </button>
                  <div data-ans="${i}" hidden style="padding:0 24px 18px">
                    <p class="muted" style="margin:0">${esc(f.a)}</p>
                  </div>
                </div>`).join('')}
            </div>
          </div>

          <!-- Форма обращения -->
          <div class="card card-pad">
            <h4 style="margin-bottom:6px">Написать в поддержку</h4>
            <p class="muted" style="font-size:13px">В песочнице форма не отправляет данные —
               обращение только показывается на экране.</p>
            <form data-form style="margin-top:16px">
              <div class="g-2" style="gap:0 16px">
                <div class="field"><label>Имя</label>
                  <input class="input" placeholder="Как к вам обращаться" data-fname></div>
                <div class="field"><label>E-mail для ответа</label>
                  <input class="input" type="email" placeholder="you@example.com" data-femail></div>
              </div>
              <div class="field"><label>Тема</label>
                <select class="select" data-ftopic>
                  <option>Вопрос по операции</option>
                  <option>Верификация и лимиты</option>
                  <option>Технический сбой</option>
                  <option>Партнёрство и API</option>
                  <option>Юридический запрос</option>
                </select></div>
              <div class="field"><label>Сообщение</label>
                <textarea class="input" rows="5" placeholder="Опишите ситуацию и приложите
идентификатор операции, если он есть" data-fmsg></textarea></div>
              <button class="btn btn-primary btn-lg" type="submit">Отправить обращение</button>
            </form>
          </div>

          <!-- Статус -->
          <div class="card">
            <div class="card-hd"><h4>Статус систем</h4>
              <span class="badge badge-up">все ключевые сервисы работают</span></div>
            <div>
              ${STATUS.map(([name, st, val]) => `
                <div class="balance-row">
                  <div class="row gap-3">
                    <span style="width:9px;height:9px;border-radius:50%;flex:none;
                      background:var(--${st === 'ok' ? 'up' : 'warn'})"></span>
                    <span style="color:var(--ink);font-weight:600">${esc(name)}</span>
                  </div>
                  <span class="muted mono" style="font-size:13px">${esc(val)}</span>
                </div>`).join('')}
            </div>
          </div>
        </div>

        <!-- Контакты -->
        <div class="stack gap-4">
          <div class="card card-pad">
            <h4 style="margin-bottom:14px">Каналы связи</h4>
            ${[
              ['Поддержка клиентов', BRAND.contacts.support, ICONS.support],
              ['Комплаенс и верификация', BRAND.contacts.compliance, ICONS.userCheck],
              ['Юридические запросы', BRAND.contacts.legal, ICONS.fileDoc],
              ['Пресса и партнёрство', BRAND.contacts.press, ICONS.mail],
            ].map(([label, mail, ic]) => `
              <div class="balance-row" style="padding:12px 0">
                <div class="row gap-3">
                  <span style="color:var(--brand);flex:none">${ic}</span>
                  <div><div style="color:var(--ink);font-weight:600;font-size:13px">${esc(label)}</div>
                       <div class="muted mono" style="font-size:12px">${esc(mail)}</div></div>
                </div>
                <button class="btn btn-ghost btn-sm" data-copy="${esc(mail)}">${ICONS.copy}</button>
              </div>`).join('')}
            <div class="rate-line" style="margin-top:8px"><span class="row gap-2">${ICONS.phone}Телефон</span>
              <b class="mono">${esc(BRAND.contacts.phone)}</b></div>
          </div>

          <div class="card card-pad">
            <h4 style="margin-bottom:14px">Офисы</h4>
            ${BRAND.addresses.map(a => `
              <div style="margin-bottom:16px">
                <div class="row gap-2" style="color:var(--ink);font-weight:600;font-size:13px">${ICONS.pin}${esc(a.label)}</div>
                <div class="muted" style="font-size:13px">${a.lines.map(esc).join('<br>')}</div>
              </div>`).join('')}
            <div class="risk-note" style="margin-top:4px">
              Адреса и контакты вымышлены и приведены для демонстрации структуры раздела.
            </div>
          </div>

          <div class="card card-pad">
            <h4 style="margin-bottom:10px">Документы</h4>
            <a class="btn btn-ghost btn-block" href="#/legal" style="margin-bottom:8px">Правовой центр</a>
            <a class="btn btn-ghost btn-block" href="#/legal/fees">Комиссии и лимиты</a>
          </div>
        </div>
      </div>
    </div>`);

    /* ── FAQ-аккордеон ── */
    on(el, 'click', '[data-faq]', (_e, t) => {
      const i = t.dataset.faq;
      const ans = qs(`[data-ans="${i}"]`, el);
      const sign = qs(`[data-sign="${i}"]`, el);
      ans.hidden = !ans.hidden;
      sign.innerHTML = ans.hidden ? ICONS.plus : ICONS.minus;
    });

    /* ── Форма ── */
    qs('[data-form]', el).addEventListener('submit', e => {
      e.preventDefault();
      const msg = qs('[data-fmsg]', el).value.trim();
      const topic = qs('[data-ftopic]', el).value;
      if (!msg) { toast({ title: 'Опишите вопрос', kind: 'err' }); return; }
      toast({
        title: 'Обращение зарегистрировано',
        msg: `Тема «${topic}». В песочнице данные никуда не отправляются.`,
        kind: 'ok',
      });
      qs('[data-fmsg]', el).value = '';
    });

    bindCopy(el);
    return el;
  },
};
