/* MERIDIAN — адаптер старого интерфейса API поверх Supabase.

   Четыре крупные вью (кабинет, уведомления, поддержка, админ-панель) были
   написаны под REST-эндпоинты Python-бэкенда: API.get('/me/logins') и т.п.
   Переписывать их целиком — большой и рискованный объём правок. Вместо этого
   адаптер повторяет тот же интерфейс, но каждый путь превращает в запрос к
   Supabase: чтение таблицы под RLS или вызов RPC-функции.

   Так вью остаются нетронутыми, а данные и проверки доступа идут через базу.

   Отдельно о границе клиента: часть административных действий (создание
   сотрудника, сброс 2FA и завершение сессий ДРУГОГО пользователя) требует
   service_role-ключа, который не должен попадать в браузер. Такие вызовы
   адаптер честно отклоняет с пометкой SERVER_REQUIRED — их место в серверной
   Edge Function, а не в клиенте. Это не пробел, а правильная граница. */

import * as sb from './supabase.js';
import * as session from '../core/session.js';

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/* ── Преобразования дат и сумм ─────────────────────────────────────────── */

const isoMs = v => (v ? new Date(v).getTime() : 0);
const isoSec = v => (v ? Math.floor(new Date(v).getTime() / 1000) : 0);

/** Человеческая сумма со знаком → минимальные единицы. */
function signedMinor(asset, human) {
  const s = String(human).trim();
  const neg = s.startsWith('-');
  const m = sb.toMinor(asset, s.replace(/^[-+]/, ''));
  return neg ? -m : m;
}

/* ── Разбор пути ──────────────────────────────────────────────────────── */

function parse(path) {
  const [p, qs = ''] = path.split('?');
  const parts = p.split('/').filter(Boolean);   // ['me','logins']
  const query = Object.fromEntries(new URLSearchParams(qs));
  return { parts, query, path: p };
}

function fail(e) {
  if (e instanceof ApiError) throw e;
  const code = e?.code || 'ERROR';
  // Ошибки RLS/функций Postgres приходят с осмысленным message
  throw new ApiError(code, e?.message || String(e), e?.status || 400);
}

/* ── GET ──────────────────────────────────────────────────────────────── */

async function get(path) {
  const { parts, query } = parse(path);
  try {
    // ── Кабинет ──
    if (parts[0] === 'me') {
      if (parts[1] === 'activity') {
        return await sb.rpc('me_activity', { p_days: +(query.days || 30) });
      }
      if (parts[1] === 'logins') {
        const rows = await sb.select('login_history', {
          columns: 'event,os,browser,city,ip,is_new_device,created_at',
          order: 'created_at.desc', limit: +(query.limit || 50),
        });
        return rows.map(r => ({
          event: r.event, os: r.os, browser: r.browser, city: r.city, ip: r.ip,
          isNew: r.is_new_device, at: isoMs(r.created_at),
        }));
      }
      if (parts[1] === 'devices') {
        const rows = await sb.select('known_devices', {
          columns: '*', order: 'last_seen_at.desc',
        });
        return rows.map(r => ({
          id: r.id, label: r.label, kind: r.device_kind, os: r.os, browser: r.browser,
          ip: r.last_ip, city: r.last_city,
          firstSeen: isoMs(r.first_seen_at), lastSeen: isoMs(r.last_seen_at),
        }));
      }
      if (parts[1] === 'sessions') {
        // Supabase не отдаёт клиенту список чужих сессий. Показываем текущую —
        // единственную, о которой браузер может судить достоверно.
        const d = session.get();
        const ua = navigator.userAgent.toLowerCase();
        const os = /windows/.test(ua) ? 'Windows' : /mac/.test(ua) ? 'macOS'
          : /android/.test(ua) ? 'Android' : /iphone|ipad/.test(ua) ? 'iOS' : 'система';
        const browser = /edg\//.test(ua) ? 'Edge' : /firefox/.test(ua) ? 'Firefox'
          : /chrome/.test(ua) ? 'Chrome' : /safari/.test(ua) ? 'Safari' : 'браузер';
        return [{ id: 'current', os, browser, ip: '—',
                  city: 'текущее устройство', lastActive: Date.now() }];
      }
    }

    // ── Уведомления ──
    if (path === '/notifications') {
      const rows = await sb.select('notifications', {
        columns: '*', order: 'created_at.desc', limit: 60,
      });
      return rows.map(n => ({
        id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link,
        level: n.level, read: !!n.read_at, createdAt: isoMs(n.created_at),
      }));
    }

    // ── Кошелёк: история операций ──
    if (parts[0] === 'wallet' && parts[1] === 'transactions') {
      const rows = await sb.select('transactions', {
        columns: 'kind,asset_id,network_id,amount,fee,status,created_at,tx_hash,address',
        order: 'created_at.desc', limit: +(query.limit || 50),
      });
      return rows.map(t => ({
        id: t.id, kind: t.kind, asset: t.asset_id, network: t.network_id,
        amount: sb.toHuman(t.asset_id, t.amount), fee: sb.toHuman(t.asset_id, t.fee),
        status: t.status, txHash: t.tx_hash, address: t.address,
        createdAt: isoMs(t.created_at),
      }));
    }

    // ── Поддержка ──
    if (parts[0] === 'support' && parts[1] === 'tickets') {
      if (parts[2]) {
        // Конкретное обращение с перепиской (RLS скрывает внутренние заметки)
        const rows = await sb.select('support_tickets', {
          columns: '*,support_messages(*)',
          filters: { id: `eq.${parts[2]}` }, single: true,
        });
        if (!rows) throw new ApiError('TICKET_NOT_FOUND', 'обращение недоступно', 404);
        const msgs = (rows.support_messages || [])
          .sort((a, b) => isoMs(a.created_at) - isoMs(b.created_at))
          .map(m => ({
            id: m.id, authorKind: m.author_kind, body: m.body,
            internal: m.is_internal, createdAt: isoMs(m.created_at),
          }));
        return {
          id: rows.id, subject: rows.subject, category: rows.category,
          status: rows.status, priority: rows.priority,
          createdAt: isoMs(rows.created_at), updatedAt: isoMs(rows.updated_at),
          messages: msgs,
        };
      }
      // Список обращений с числом сообщений через встроенный count PostgREST
      const rows = await sb.select('support_tickets', {
        columns: 'id,subject,category,status,priority,updated_at,support_messages(count)',
        order: 'updated_at.desc',
      });
      return rows.map(t => ({
        id: t.id, subject: t.subject, category: t.category,
        status: t.status, priority: t.priority,
        messages: t.support_messages?.[0]?.count ?? 0,
        updatedAt: isoMs(t.updated_at),
      }));
    }

    // ── Администрирование ──
    if (parts[0] === 'admin') {
      if (parts[1] === 'analytics') {
        return await sb.rpc('admin_analytics', { p_days: +(query.days || 30) });
      }
      if (parts[1] === 'users' && parts[2] === 'search') {
        const filters = {};
        if (query.status && query.status !== 'all') filters.status = `eq.${query.status}`;
        if (query.q) filters.or = `(email.ilike.*${query.q}*,display_name.ilike.*${query.q}*)`;
        const rows = await sb.select('v_user_summary', {
          columns: '*', filters, order: 'created_at.desc', limit: 200,
        });
        return rows.map(u => ({
          ...u,
          created_at: isoSec(u.created_at),
          last_seen_at: isoSec(u.last_seen_at),
        }));
      }
      if (parts[1] === 'users' && parts[3] === 'profile') {
        const p = await sb.rpc('admin_user_profile', { p_user: parts[2] });
        // Приводим формы под ожидания вью: секунды у дат, человеческие суммы
        if (p.summary) {
          p.summary.created_at = isoSec(p.summary.created_at);
          p.summary.last_seen_at = isoSec(p.summary.last_seen_at);
        }
        p.balances = (p.balances || []).map(b => ({
          asset: b.asset,
          available: sb.toHuman(b.asset, +b.available),
          locked: sb.toHuman(b.asset, +b.locked),
        }));
        p.limits = p.limits ? {
          withdrawDailyUsd: p.limits.withdraw_daily_usd,
          maxOrderUsd: p.limits.max_order_usd,
          tradingFrozen: p.limits.trading_frozen,
          withdrawFrozen: p.limits.withdraw_frozen,
          note: p.limits.note,
        } : {};
        return p;
      }
      if (parts[1] === 'users' && parts[3] === 'export') {
        // Выгрузка: собираем то, к чему у оператора есть доступ по RLS
        const uid = parts[2];
        const [summary, tx, orders] = await Promise.all([
          sb.select('v_user_summary', { filters: { user_id: `eq.${uid}` }, single: true }),
          sb.select('transactions', { filters: { user_id: `eq.${uid}` }, order: 'created_at.desc' }),
          sb.select('orders', { filters: { user_id: `eq.${uid}` }, order: 'created_at.desc' }),
        ]);
        return { user: summary || {}, transactions: tx, orders, exportedAt: Date.now() };
      }
      if (parts[1] === 'support' && parts[2] === 'queue') {
        const rows = await sb.select('v_support_queue', {
          columns: '*', order: 'priority_rank.asc,updated_at.desc', limit: 100,
        });
        return rows.map(t => ({
          id: t.id, subject: t.subject, category: t.category,
          status: t.status, priority: t.priority,
          user: { id: t.user_id, email: t.user_email, name: t.user_name },
          messages: t.message_count, idleSeconds: t.idle_seconds,
          assignee: t.assignee_id, updatedAt: isoMs(t.updated_at),
        }));
      }
      if (parts[1] === 'audit' && parts[2] === 'search') {
        const filters = {};
        if (query.level && query.level !== 'all') filters.level = `eq.${query.level}`;
        const rows = await sb.select('audit_log', {
          columns: 'id,actor_id,actor_kind,action,target,level,payload,ip,created_at',
          filters, order: 'created_at.desc', limit: 300,
        });
        return rows.map(a => ({
          id: a.id, actor: a.actor_kind, action: a.action, target: a.target,
          level: a.level, payload: a.payload, ip: a.ip, at: isoMs(a.created_at),
        }));
      }
      if (parts[1] === 'staff') {
        const rows = await sb.select('staff_profiles', {
          columns: 'user_id,position,department,permissions,disabled_at,created_at,profiles(email,display_name,status,last_seen_at)',
        });
        return {
          staff: rows.map(s => ({
            id: s.user_id, email: s.profiles?.email, name: s.profiles?.display_name,
            position: s.position, department: s.department,
            permissions: s.permissions || [], status: s.profiles?.status,
            disabled: !!s.disabled_at, replies: 0, actions7d: 0,
            lastSeen: isoMs(s.profiles?.last_seen_at), createdAt: isoMs(s.created_at),
          })),
          permissions: PERMISSIONS, presets: ROLE_PRESETS,
        };
      }
    }

    throw new ApiError('NOT_MAPPED', `GET ${path} не реализован в адаптере`, 404);
  } catch (e) { fail(e); }
}

/* ── POST ─────────────────────────────────────────────────────────────── */

async function post(path, body = {}) {
  const { parts } = parse(path);
  const uid = sb.currentUser()?.id;
  try {
    // ── Кабинет ──
    if (parts[0] === 'me') {
      if (parts[1] === 'profile') {
        await sb.update('profiles', { id: `eq.${uid}` },
          { display_name: body.name || '', country: body.country || null,
            updated_at: new Date().toISOString() });
        return { ok: true };
      }
      if (parts[1] === 'password') {
        await sb.updatePassword(body.newPassword);
        await sb.signOutOthers();     // смена пароля закрывает прочие сессии
        return { ok: true };
      }
      if (parts[1] === 'anti-phishing') {
        await sb.update('profiles', { id: `eq.${uid}` }, { anti_phishing: body.code });
        return { ok: true, code: body.code };
      }
      if (parts[1] === 'sessions' && parts[2] === 'revoke-all') {
        await sb.signOutOthers();
        return { revoked: 'прочие устройства' };
      }
    }

    // ── Уведомления ──
    if (path === '/notifications/read') {
      const now = new Date().toISOString();
      if (body.id) await sb.update('notifications', { id: `eq.${body.id}` }, { read_at: now });
      else await sb.update('notifications', { read_at: 'is.null' }, { read_at: now });
      const left = await sb.select('notifications', { columns: 'id', filters: { read_at: 'is.null' } });
      return { marked: 1, unread: left.length };
    }

    // ── Поддержка ──
    if (parts[0] === 'support' && parts[1] === 'tickets') {
      if (parts[2] === undefined || parts[2] === '') {
        const [ticket] = await sb.insert('support_tickets', [{
          user_id: uid, subject: body.subject, category: body.category || 'general',
          priority: body.priority || 'normal',
        }]);
        await sb.insert('support_messages', [{
          ticket_id: ticket.id, author_id: uid, author_kind: 'user', body: body.body,
        }], { returning: false });
        return { id: ticket.id };
      }
      if (parts[3] === 'messages') {
        const staff = session.isStaff();
        await sb.insert('support_messages', [{
          ticket_id: parts[2], author_id: uid,
          author_kind: staff ? 'staff' : 'user',
          body: body.body, is_internal: !!body.internal && staff,
        }], { returning: false });
        return { id: 'ok', ticketId: parts[2] };
      }
    }

    // ── Администрирование через SECURITY DEFINER RPC ──
    if (parts[0] === 'admin' && parts[1] === 'users') {
      const target = parts[2];
      if (parts[3] === 'block')   return await sb.rpc('admin_block_user', { p_user: target, p_reason: body.reason });
      if (parts[3] === 'unblock') return await sb.rpc('admin_unblock_user', { p_user: target });
      if (parts[3] === 'kyc')     return await sb.rpc('admin_set_kyc', { p_user: target, p_level: body.level });
      if (parts[3] === 'adjust') {
        const asset = (body.asset || '').toUpperCase();
        return await sb.rpc('admin_adjust_balance',
          { p_user: target, p_asset: asset, p_amount: signedMinor(asset, body.amount), p_reason: body.reason });
      }
      if (parts[3] === 'limits') {
        await sb.insert('user_limits', [{
          user_id: target,
          withdraw_daily_usd: body.withdrawDailyUsd || null,
          max_order_usd: body.maxOrderUsd || null,
          trading_frozen: !!body.tradingFrozen,
          withdraw_frozen: !!body.withdrawFrozen,
          note: body.note || null,
          updated_by: uid, updated_at: new Date().toISOString(),
        }], { returning: false }).catch(async () => {
          // запись уже есть — обновляем
          await sb.update('user_limits', { user_id: `eq.${target}` }, {
            withdraw_daily_usd: body.withdrawDailyUsd || null,
            max_order_usd: body.maxOrderUsd || null,
            trading_frozen: !!body.tradingFrozen,
            withdraw_frozen: !!body.withdrawFrozen,
            note: body.note || null,
            updated_by: uid, updated_at: new Date().toISOString(),
          });
        });
        return { ok: true };
      }
      if (parts[3] === 'notes') {
        await sb.insert('user_notes', [{
          user_id: target, author_id: uid, body: body.body, pinned: !!body.pinned,
        }], { returning: false });
        return { ok: true };
      }
      if (parts[3] === 'notify') {
        await sb.insert('notifications', [{
          user_id: target, kind: 'system', title: body.title,
          body: body.body || '', level: body.level || 'info', created_by: uid,
        }], { returning: false });
        return { ok: true };
      }
      // Требуют service_role — не выполнимы из браузера по замыслу
      if (parts[3] === 'reset-2fa' || parts[3] === 'revoke-sessions') {
        throw new ApiError('SERVER_REQUIRED',
          'Действие затрагивает учётные данные другого пользователя и выполняется '
          + 'только серверной функцией с service-ключом — из браузера оно недоступно '
          + 'по требованиям безопасности.', 403);
      }
    }

    if (parts[0] === 'admin' && parts[1] === 'staff') {
      throw new ApiError('SERVER_REQUIRED',
        'Создание и изменение учётных записей сотрудников требует service-ключа '
        + 'и выполняется серверной функцией, а не из браузера.', 403);
    }

    throw new ApiError('NOT_MAPPED', `POST ${path} не реализован в адаптере`, 404);
  } catch (e) { fail(e); }
}

/* ── DELETE ───────────────────────────────────────────────────────────── */

async function del(path) {
  const { parts } = parse(path);
  try {
    if (parts[0] === 'orders' && parts[1]) {
      return await sb.rpc('cancel_order', { p_order: +parts[1] });
    }
    throw new ApiError('NOT_MAPPED', `DELETE ${path} не реализован`, 404);
  } catch (e) { fail(e); }
}

/* Справочники прав — те же, что в старом бэкенде, чтобы формы совпадали */
export const PERMISSIONS = {
  'users.view': 'Просмотр карточек клиентов',
  'users.block': 'Блокировка и разблокировка',
  'users.kyc': 'Изменение уровня верификации',
  'users.limits': 'Настройка лимитов',
  'users.balance': 'Корректировка баланса',
  'users.sessions': 'Завершение сессий и сброс 2FA',
  'support.reply': 'Ответы в поддержке',
  'support.manage': 'Назначение и закрытие обращений',
  'notify.send': 'Отправка уведомлений',
  'staff.manage': 'Управление сотрудниками',
  'platform.settings': 'Настройки площадки',
  'reports.view': 'Отчёты и выгрузки',
};

export const ROLE_PRESETS = {
  support: ['users.view', 'support.reply', 'notify.send'],
  compliance: ['users.view', 'users.block', 'users.kyc', 'users.limits', 'users.sessions', 'support.reply', 'reports.view'],
  finance: ['users.view', 'users.balance', 'users.limits', 'reports.view'],
  engineering: ['users.view', 'platform.settings', 'reports.view'],
  management: Object.keys(PERMISSIONS),
};

export const API = { get, post, del };
export default { API, ApiError };
