/* Обращения в поддержку — список слева, переписка справа.
   Двухпанельная раскладка, как в почтовом клиенте: контекст не теряется
   при переходе между обращениями. */

import { API } from '../api/adapter.js';
import * as session from '../core/session.js';
import { h, qs, qsa, on, modal, toast, ICONS } from '../ui.js';
import { fmtDateTime, timeAgo, esc } from '../format.js';

const CATEGORIES = {
  general: 'Общий вопрос', deposit: 'Пополнение', withdraw: 'Вывод',
  trading: 'Торговля', kyc: 'Верификация', security: 'Безопасность',
  api: 'API', billing: 'Комиссии',
};

const STATUS = {
  open: ['Открыто', 'badge-brand'], pending: ['Ждёт ответа', 'badge-gold'],
  answered: ['Есть ответ', 'badge-up'], resolved: ['Решено', 'badge-neutral'],
  closed: ['Закрыто', 'badge-neutral'],
};

const PRIORITY = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };

export default {
  title: 'Поддержка',
  auth: true,
  authText: 'Войдите, чтобы обратиться в службу поддержки.',

  render({ params }) {
    let active = params[0] || null;
    let list = [];
    let poll = null;

    const el = h(`<div class="container section-tight">
      <div class="cover cover-support cover-pad" style="margin-bottom:var(--sp-6)">
        <span class="eyebrow">Служба поддержки</span>
        <h1 style="margin:var(--sp-3) 0 var(--sp-2)">Обращения</h1>
        <p style="margin:0;max-width:56ch">Переписка с оператором по вашему счёту.
           Среднее время первого ответа — до одного часа в рабочие часы.</p>
      </div>

      <div class="chat-layout">
        <aside class="chat-list card">
          <div class="card-hd">
            <h3>Мои обращения</h3>
            <button class="btn btn-primary btn-sm" data-new>${ICONS.plus}Создать</button>
          </div>
          <div data-list><div class="skel" style="height:120px;margin:var(--sp-4)"></div></div>
        </aside>

        <section class="chat-thread card" data-thread>
          <div class="empty" style="padding:var(--sp-16)">
            <div class="ic">${ICONS.support}</div>
            <h3 style="margin-bottom:var(--sp-2)">Выберите обращение</h3>
            <p class="muted" style="margin:0">Или создайте новое, если вопрос ещё не задан.</p>
          </div>
        </section>
      </div>
    </div>`);

    /* ── Список обращений ── */
    async function loadList() {
      list = await API.get('/support/tickets');
      const box = qs('[data-list]', el);
      if (!list.length) {
        box.innerHTML = `<div class="empty" style="padding:var(--sp-8)">
          <p class="muted" style="margin:0">Обращений пока нет</p></div>`;
        return;
      }
      box.innerHTML = list.map(t => {
        const [label, cls] = STATUS[t.status] || ['—', 'badge-neutral'];
        return `<button class="ticket-item${t.id === active ? ' on' : ''}" data-open="${t.id}">
          <div class="row between" style="gap:var(--sp-2)">
            <span class="t-main">${esc(t.subject)}</span>
            <span class="badge ${cls}">${label}</span>
          </div>
          <div class="t-sub">${esc(CATEGORIES[t.category] || t.category)} ·
            ${t.messages} сообщ. · ${timeAgo(t.updatedAt)}</div>
        </button>`;
      }).join('');
    }

    /* ── Переписка ── */
    async function loadThread(id) {
      active = id;
      qsa('[data-open]', el).forEach(b => b.classList.toggle('on', b.dataset.open === id));
      history.replaceState(null, '', `#/tickets/${id}`);

      const box = qs('[data-thread]', el);
      const t = await API.get(`/support/tickets/${id}`);
      const [label, cls] = STATUS[t.status] || ['—', 'badge-neutral'];
      const closed = ['closed', 'resolved'].includes(t.status);

      box.innerHTML = `
        <div class="card-hd chat-head">
          <div>
            <h3>${esc(t.subject)}</h3>
            <div class="t-sub">${esc(CATEGORIES[t.category] || t.category)} ·
              приоритет ${esc(PRIORITY[t.priority] || t.priority)} ·
              создано ${fmtDateTime(t.createdAt)}</div>
          </div>
          <span class="badge ${cls}">${label}</span>
        </div>

        <div class="chat-body" data-msgs>
          ${t.messages.map(m => `
            <div class="msg ${m.authorKind === 'user' ? 'mine' : 'theirs'}${m.internal ? ' internal' : ''}">
              <div class="msg-meta">${
                m.authorKind === 'user' ? 'Вы' :
                m.authorKind === 'staff' ? 'Служба поддержки' : 'Система'}
                · ${fmtDateTime(m.createdAt)}${m.internal ? ' · внутренняя заметка' : ''}</div>
              <div class="msg-body">${esc(m.body).replace(/\n/g, '<br>')}</div>
            </div>`).join('')}
        </div>

        ${closed ? `
          <div class="chat-compose closed">
            <p class="muted" style="margin:0">Обращение ${label.toLowerCase()}.
               Если вопрос остался — создайте новое.</p>
          </div>` : `
          <div class="chat-compose">
            <textarea class="input" rows="3" data-reply
              placeholder="Опишите ситуацию или задайте уточняющий вопрос"></textarea>
            <button class="btn btn-primary" data-send>${ICONS.arrowUp}Отправить</button>
          </div>`}`;

      const body = qs('[data-msgs]', box);
      body.scrollTop = body.scrollHeight;
    }

    /* ── Новое обращение ── */
    function compose() {
      const body = h(`<div>
        <div class="field"><label>Тема</label>
          <input class="input" data-subj placeholder="Коротко о сути вопроса"></div>
        <div class="field"><label>Категория</label>
          <select class="select" data-cat>
            ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select></div>
        <div class="field"><label>Приоритет</label>
          <select class="select" data-pri>
            ${Object.entries(PRIORITY).map(([k, v]) =>
              `<option value="${k}"${k === 'normal' ? ' selected' : ''}>${v}</option>`).join('')}
          </select></div>
        <div class="field"><label>Сообщение</label>
          <textarea class="input" rows="6" data-body
            placeholder="Укажите идентификаторы операций, суммы и сети — это ускорит разбор"></textarea></div>
      </div>`);

      const m = modal({
        title: 'Новое обращение', body, width: 560,
        footer: `<button class="btn btn-ghost" data-c>Отмена</button>
                 <button class="btn btn-primary" data-o>Отправить</button>`,
      });
      qs('[data-c]', m.node).addEventListener('click', m.close);
      qs('[data-o]', m.node).addEventListener('click', async () => {
        const subject = qs('[data-subj]', body).value.trim();
        const text = qs('[data-body]', body).value.trim();
        if (subject.length < 3) { toast({ title: 'Укажите тему', kind: 'err' }); return; }
        if (text.length < 5) { toast({ title: 'Опишите вопрос подробнее', kind: 'err' }); return; }
        try {
          const t = await API.post('/support/tickets', {
            subject, body: text,
            category: qs('[data-cat]', body).value,
            priority: qs('[data-pri]', body).value,
          });
          m.close();
          toast({ title: 'Обращение создано', msg: 'Оператор ответит в ближайшее время', kind: 'ok' });
          await loadList();
          await loadThread(t.id);
        } catch (e) { toast({ title: 'Не удалось создать', msg: e.message, kind: 'err' }); }
      });
    }

    /* ── События ── */
    on(el, 'click', '[data-new]', compose);
    on(el, 'click', '[data-open]', (_e, t) => loadThread(t.dataset.open));

    on(el, 'click', '[data-send]', async () => {
      const ta = qs('[data-reply]', el);
      const text = ta.value.trim();
      if (!text) return;
      ta.disabled = true;
      try {
        await API.post(`/support/tickets/${active}/messages`, { body: text });
        ta.value = '';
        await loadThread(active);
        await loadList();
      } catch (e) {
        toast({ title: 'Не отправлено', msg: e.message, kind: 'err' });
      } finally { ta.disabled = false; }
    });

    // Ctrl+Enter отправляет — привычно для чатов
    on(el, 'keydown', '[data-reply]', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') qs('[data-send]', el)?.click();
    });

    el._mounted = async () => {
      await loadList();
      if (active) { try { await loadThread(active); } catch { active = null; } }
      // Обновляем открытую переписку: ответ оператора появится сам
      poll = setInterval(async () => {
        if (!active || document.hidden) return;
        try { await loadThread(active); await loadList(); } catch { /* сеть */ }
      }, 20_000);
    };

    el._cleanup = () => clearInterval(poll);
    return el;
  },
};
