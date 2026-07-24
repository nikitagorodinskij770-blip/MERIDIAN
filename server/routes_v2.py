"""MERIDIAN — маршруты личного кабинета, поддержки, уведомлений и администрирования.

Вынесено из app.py, чтобы тот остался транспортом (разбор запроса, заголовки
безопасности, статика), а бизнес-эндпоинты жили отдельно и читались подряд.
"""

from __future__ import annotations

import json
import secrets

from . import db, security, engine, accounts
from .accounts import PERMISSIONS, ROLE_PRESETS


def register(route, ApiError):
    """Регистрирует маршруты. route и ApiError приходят из app.py,
    чтобы не создавать круговой импорт."""

    # ═══════════════════════ Личный кабинет ═══════════════════════

    @route("GET", "/v1/me/overview", auth=True)
    def me_overview(c):
        """Всё для главного экрана кабинета одним запросом.

        Собрано в один эндпоинт намеренно: пять параллельных запросов
        с фронта дали бы пять раз накладные расходы и мерцающий интерфейс.
        """
        uid = c.user["id"]
        summary = db.q1("SELECT * FROM v_user_summary WHERE user_id=?", (uid,))
        balances = db.balances_of(uid)

        # Оценка портфеля в USD по курсам активов на сервере
        total_usd = 0.0
        for b in balances:
            px = db.q1("SELECT last_price_usd FROM asset_prices WHERE asset_id=?", (b["asset"],))
            if px and px["last_price_usd"]:
                total_usd += float(b["available"]) * px["last_price_usd"]

        return {
            "user": {
                "id": uid, "email": c.user["email"], "name": c.user["display_name"],
                "status": c.user["status"], "kycLevel": c.user["kyc_level"],
                "role": c.user["role"], "twoFA": bool(c.user["twofa_secret"]),
                "antiPhishing": c.user["anti_phishing"],
                "createdAt": c.user["created_at"] * 1000,
                "lastSeen": (c.user["last_seen_at"] or 0) * 1000,
            },
            "balances": balances,
            "portfolioUsd": round(total_usd, 2),
            "counts": dict(summary) if summary else {},
            "unread": accounts.unread_count(uid),
            "limits": accounts.get_limits(uid),
        }

    @route("GET", "/v1/me/activity", auth=True)
    def me_activity(c):
        days = min(int((c.query.get("days") or ["30"])[0]), 365)
        return accounts.user_activity(c.user["id"], days)

    @route("GET", "/v1/me/logins", auth=True)
    def me_logins(c):
        return accounts.login_history(c.user["id"],
                                      min(int((c.query.get("limit") or ["50"])[0]), 200))

    @route("GET", "/v1/me/devices", auth=True)
    def me_devices(c):
        return accounts.devices(c.user["id"])

    @route("GET", "/v1/me/sessions", auth=True)
    def me_sessions(c):
        return accounts.active_sessions(c.user["id"])

    @route("POST", "/v1/me/sessions/revoke-all", auth=True)
    def me_revoke(c):
        auth = c.h.headers.get("Authorization", "")
        keep = security.session_token_hash(auth[7:]) if auth.startswith("Bearer ") else None
        n = accounts.revoke_all_sessions(c.user["id"], keep_token_hash=keep)
        accounts.record_login(c.user["id"], c.ip, c.h.headers.get("User-Agent", ""), "logout")
        accounts.notify(c.user["id"], "security", "Все сессии завершены",
                        f"Закрыто сессий: {n}. Текущая сохранена.", level="warning")
        return {"revoked": n}

    @route("POST", "/v1/me/profile", auth=True)
    def me_profile(c):
        name = (c.body.get("name") or "").strip()[:80]
        country = (c.body.get("country") or "").strip()[:60] or None
        db.run("UPDATE users SET display_name=?, country=?, updated_at=? WHERE id=?",
               (name, country, db.now(), c.user["id"]))
        db.audit("account.profile", actor_id=c.user["id"], actor_kind="user")
        return {"ok": True, "name": name, "country": country}

    @route("POST", "/v1/me/password", auth=True)
    def me_password(c):
        old = c.body.get("currentPassword") or ""
        new = c.body.get("newPassword") or ""
        if len(new) < 8:
            raise ApiError("WEAK_PASSWORD", "пароль короче 8 символов")
        if not security.verify_password(old, c.user["pw_hash"]):
            db.audit("account.password.fail", actor_id=c.user["id"], actor_kind="user",
                     ip=c.ip, level="warn")
            raise ApiError("INVALID_CREDENTIALS", "текущий пароль неверен", 401)

        db.run("UPDATE users SET pw_hash=?, updated_at=? WHERE id=?",
               (security.hash_password(new), db.now(), c.user["id"]))
        # Смена пароля обязана закрыть чужие сессии — иначе она бессмысленна
        auth = c.h.headers.get("Authorization", "")
        keep = security.session_token_hash(auth[7:]) if auth.startswith("Bearer ") else None
        accounts.revoke_all_sessions(c.user["id"], keep_token_hash=keep)
        accounts.record_login(c.user["id"], c.ip, c.h.headers.get("User-Agent", ""), "password_change")
        accounts.notify(c.user["id"], "security", "Пароль изменён",
                        "Остальные сессии завершены. Если это были не вы — обратитесь в поддержку.",
                        level="critical")
        return {"ok": True}

    @route("POST", "/v1/me/anti-phishing", auth=True)
    def me_antiphishing(c):
        code = (c.body.get("code") or "").strip()[:24]
        if len(code) < 4:
            raise ApiError("VALIDATION_ERROR", "код короче 4 символов")
        db.run("UPDATE users SET anti_phishing=? WHERE id=?", (code, c.user["id"]))
        accounts.notify(c.user["id"], "security", "Антифишинг-код обновлён",
                        f"Настоящие письма MERIDIAN содержат код {code}.")
        return {"ok": True, "code": code}

    @route("POST", "/v1/prices", auth=True)
    def push_prices(c):
        """Фронтенд отдаёт серверу последние котировки.

        У него уже есть живой поток с бирж, поэтому дублировать исходящие
        соединения с бэкенда незачем. Сервер хранит последнее значение и
        использует его для оценки портфеля и отчётов.
        """
        items = c.body.get("prices") or {}
        if not isinstance(items, dict) or len(items) > 200:
            raise ApiError("VALIDATION_ERROR", "ожидается объект до 200 записей")
        n = 0
        for asset, d in items.items():
            try:
                px = float(d.get("price") if isinstance(d, dict) else d)
            except (TypeError, ValueError):
                continue
            if px < 0 or not db.q1("SELECT 1 FROM assets WHERE id=?", (asset,)):
                continue
            chg = None
            if isinstance(d, dict):
                try:
                    chg = float(d.get("change24"))
                except (TypeError, ValueError):
                    chg = None
            db.run("""INSERT INTO asset_prices(asset_id,last_price_usd,change_24h,source,updated_at)
                      VALUES(?,?,?,?,unixepoch())
                      ON CONFLICT(asset_id) DO UPDATE SET
                        last_price_usd=excluded.last_price_usd,
                        change_24h=excluded.change_24h,
                        source=excluded.source, updated_at=unixepoch()""",
                   (asset, px, chg, (c.body.get("source") or "client")[:40]))
            n += 1
        return {"updated": n}

    # ═══════════════════════ Уведомления ═══════════════════════

    @route("GET", "/v1/notifications", auth=True)
    def notif_list(c):
        unread = (c.query.get("unread") or ["0"])[0] == "1"
        return {
            "items": accounts.notifications(c.user["id"], unread),
            "unread": accounts.unread_count(c.user["id"]),
        }

    @route("POST", "/v1/notifications/read", auth=True)
    def notif_read(c):
        n = accounts.mark_read(c.user["id"], c.body.get("id"))
        return {"marked": n, "unread": accounts.unread_count(c.user["id"])}

    # ═══════════════════════ Поддержка ═══════════════════════

    @route("GET", "/v1/support/tickets", auth=True)
    def sup_list(c):
        return accounts.list_tickets(c.user["id"])

    @route("POST", "/v1/support/tickets", auth=True)
    def sup_create(c):
        subject = (c.body.get("subject") or "").strip()
        body = (c.body.get("body") or "").strip()
        if len(subject) < 3:
            raise ApiError("VALIDATION_ERROR", "тема слишком короткая")
        if len(body) < 5:
            raise ApiError("VALIDATION_ERROR", "опишите вопрос подробнее")
        if not security.rate_limit(f"ticket:{c.user['id']}", 5, 3600):
            raise ApiError("RATE_LIMITED", "слишком много обращений за час", 429)
        return accounts.create_ticket(c.user["id"], subject, body,
                                      c.body.get("category", "general"),
                                      c.body.get("priority", "normal"))

    @route("GET", "/v1/support/tickets/{id}", auth=True)
    def sup_get(c):
        staff = _is_staff(c.user)
        try:
            return accounts.get_ticket(c.user["id"], c.params["id"], staff_view=staff)
        except ValueError as e:
            raise ApiError(str(e), "обращение недоступно", 404)

    @route("POST", "/v1/support/tickets/{id}/messages", auth=True)
    def sup_reply(c):
        body = (c.body.get("body") or "").strip()
        if not body:
            raise ApiError("VALIDATION_ERROR", "пустое сообщение")

        staff = _is_staff(c.user)
        internal = bool(c.body.get("internal")) and staff
        if not staff:
            t = db.q1("SELECT user_id FROM support_tickets WHERE id=?", (c.params["id"],))
            if not t or t["user_id"] != c.user["id"]:
                raise ApiError("FORBIDDEN", "обращение недоступно", 403)
        elif not accounts.has_permission(c.user, "support.reply"):
            raise ApiError("FORBIDDEN", "нет права отвечать в поддержке", 403)

        try:
            return accounts.post_message(c.params["id"], c.user["id"], body,
                                         "staff" if staff else "user", internal)
        except ValueError as e:
            raise ApiError(str(e), "не удалось отправить", 400)

    # ═══════════════════════ Администрирование ═══════════════════════

    def _is_staff(u):
        return u.get("role") in ("admin", "support")

    def _need(c, perm):
        if not accounts.has_permission(c.user, perm):
            raise ApiError("FORBIDDEN", f"нужно право «{PERMISSIONS.get(perm, perm)}»", 403)

    # 1. Расширенный список клиентов с фильтрами
    @route("GET", "/v1/admin/users/search", auth=True)
    def adm_search(c):
        _need(c, "users.view")
        q = (c.query.get("q") or [""])[0].strip().lower()
        status = (c.query.get("status") or ["all"])[0]
        sql = "SELECT * FROM v_user_summary WHERE 1=1"
        args: list = []
        if status != "all":
            sql += " AND status=?"; args.append(status)
        if q:
            sql += " AND (lower(email) LIKE ? OR lower(display_name) LIKE ? OR user_id LIKE ?)"
            args += [f"%{q}%", f"%{q}%", f"%{q}%"]
        sql += " ORDER BY created_at DESC LIMIT 200"
        return [dict(r) for r in db.q(sql, args)]

    # 2. Полная карточка клиента
    @route("GET", "/v1/admin/users/{id}/profile", auth=True)
    def adm_profile(c):
        _need(c, "users.view")
        uid = c.params["id"]
        u = db.q1("SELECT * FROM v_user_summary WHERE user_id=?", (uid,))
        if not u:
            raise ApiError("NOT_FOUND", "клиент не найден", 404)
        return {
            "summary": dict(u),
            "balances": db.balances_of(uid),
            "limits": accounts.get_limits(uid),
            "devices": accounts.devices(uid),
            "sessions": accounts.active_sessions(uid),
            "logins": accounts.login_history(uid, 25),
            "notes": accounts.notes(uid),
            "activity": accounts.user_activity(uid, 30),
            "tickets": accounts.list_tickets(uid),
        }

    # 3. Заметки оператора
    @route("POST", "/v1/admin/users/{id}/notes", auth=True)
    def adm_note(c):
        _need(c, "users.view")
        body = (c.body.get("body") or "").strip()
        if not body:
            raise ApiError("VALIDATION_ERROR", "пустая заметка")
        accounts.add_note(c.params["id"], c.user["id"], body, bool(c.body.get("pinned")))
        return {"ok": True}

    # 4. Лимиты и заморозка операций
    @route("POST", "/v1/admin/users/{id}/limits", auth=True)
    def adm_limits(c):
        _need(c, "users.limits")
        accounts.set_limits(c.params["id"], c.body, c.user["id"])
        return accounts.get_limits(c.params["id"])

    # 5. Уровень верификации
    @route("POST", "/v1/admin/users/{id}/kyc", auth=True)
    def adm_kyc(c):
        _need(c, "users.kyc")
        lvl = int(c.body.get("level", 0))
        if lvl not in (0, 1, 2, 3):
            raise ApiError("VALIDATION_ERROR", "уровень от 0 до 3")
        db.run("UPDATE users SET kyc_level=?, updated_at=? WHERE id=?",
               (lvl, db.now(), c.params["id"]))
        db.audit("admin.user.kyc", actor_id=c.user["id"], actor_kind="admin",
                 target=c.params["id"], payload={"level": lvl}, level="warn")
        accounts.notify(c.params["id"], "account", "Уровень верификации изменён",
                        f"Установлен уровень {lvl}.", level="success")
        return {"ok": True, "level": lvl}

    # 6. Принудительное завершение сессий
    @route("POST", "/v1/admin/users/{id}/revoke-sessions", auth=True)
    def adm_revoke(c):
        _need(c, "users.sessions")
        n = accounts.revoke_all_sessions(c.params["id"])
        db.audit("admin.user.revoke_sessions", actor_id=c.user["id"], actor_kind="admin",
                 target=c.params["id"], payload={"count": n}, level="warn")
        accounts.notify(c.params["id"], "security", "Сессии завершены администратором",
                        "Войдите заново. При вопросах обратитесь в поддержку.", level="warning")
        return {"revoked": n}

    # 7. Сброс двухфакторной защиты
    @route("POST", "/v1/admin/users/{id}/reset-2fa", auth=True)
    def adm_2fa(c):
        _need(c, "users.sessions")
        reason = (c.body.get("reason") or "").strip()
        if not reason:
            raise ApiError("REASON_REQUIRED", "сброс 2FA требует основания")
        db.run("UPDATE users SET twofa_secret=NULL WHERE id=?", (c.params["id"],))
        accounts.revoke_all_sessions(c.params["id"])
        db.audit("admin.user.reset_2fa", actor_id=c.user["id"], actor_kind="admin",
                 target=c.params["id"], payload={"reason": reason}, level="warn")
        accounts.notify(c.params["id"], "security", "Двухфакторная защита сброшена",
                        f"Основание: {reason}. Настройте 2FA заново.", level="critical")
        return {"ok": True}

    # 8. Корректировка баланса (двойной записью, с обязательным основанием)
    @route("POST", "/v1/admin/users/{id}/adjust", auth=True)
    def adm_adjust(c):
        _need(c, "users.balance")
        asset = (c.body.get("asset") or "").upper()
        reason = (c.body.get("reason") or "").strip()
        if not reason:
            raise ApiError("REASON_REQUIRED", "корректировка требует основания")
        try:
            amount = db.to_minor(asset, c.body.get("amount"))
        except Exception:
            raise ApiError("VALIDATION_ERROR", "некорректная сумма или актив")
        if amount == 0:
            raise ApiError("VALIDATION_ERROR", "нулевая корректировка бессмысленна")

        uid = c.params["id"]
        with db.tx() as conn:
            user_acc = db.account_id(uid, asset, "user", conn)
            treasury = db.account_id(None, asset, "treasury", conn)
            # Знак определяет направление: плюс — клиенту, минус — обратно
            entries = ([(treasury, asset, -amount), (user_acc, asset, amount)]
                       if amount > 0 else
                       [(user_acc, asset, amount), (treasury, asset, -amount)])
            try:
                ltx = db.post_tx("adjustment", entries, memo=f"корректировка: {reason}", conn=conn)
            except db.LedgerError as e:
                raise ApiError(e.code, str(e), 422)

        db.audit("admin.user.adjust", actor_id=c.user["id"], actor_kind="admin", target=uid,
                 payload={"asset": asset, "amount": amount, "reason": reason}, level="warn")
        accounts.notify(uid, "transaction", "Корректировка баланса",
                        f"{'+' if amount > 0 else ''}{db.to_human(asset, amount)} {asset}. "
                        f"Основание: {reason}", level="info")
        return {"ok": True, "ledgerTx": ltx, "amount": db.to_human(asset, amount)}

    # 9. Персональное уведомление клиенту
    @route("POST", "/v1/admin/users/{id}/notify", auth=True)
    def adm_notify(c):
        _need(c, "notify.send")
        title = (c.body.get("title") or "").strip()
        if not title:
            raise ApiError("VALIDATION_ERROR", "нужен заголовок")
        nid = accounts.notify(c.params["id"], "system", title,
                              (c.body.get("body") or "").strip(),
                              c.body.get("level", "info"), created_by=c.user["id"])
        db.audit("admin.notify", actor_id=c.user["id"], actor_kind="admin",
                 target=c.params["id"], payload={"title": title})
        return {"ok": True, "id": nid}

    # 10. Очередь поддержки
    @route("GET", "/v1/admin/support/queue", auth=True)
    def adm_queue(c):
        _need(c, "support.reply")
        return accounts.support_queue((c.query.get("status") or ["all"])[0])

    # 11. Статус и назначение обращения
    @route("POST", "/v1/admin/support/{id}/status", auth=True)
    def adm_ticket_status(c):
        _need(c, "support.manage")
        st = c.body.get("status")
        if st not in ("open", "pending", "answered", "resolved", "closed"):
            raise ApiError("VALIDATION_ERROR", "неизвестный статус")
        accounts.set_ticket_status(c.params["id"], st, c.user["id"])
        return {"ok": True, "status": st}

    @route("POST", "/v1/admin/support/{id}/assign", auth=True)
    def adm_ticket_assign(c):
        _need(c, "support.manage")
        accounts.assign_ticket(c.params["id"], c.body.get("assignee"), c.user["id"])
        return {"ok": True}

    # 12. Сотрудники: список, создание, изменение
    @route("GET", "/v1/admin/staff", auth=True)
    def adm_staff_list(c):
        _need(c, "staff.manage")
        return {"staff": accounts.staff_list(),
                "permissions": PERMISSIONS, "presets": ROLE_PRESETS}

    @route("POST", "/v1/admin/staff", auth=True)
    def adm_staff_create(c):
        _need(c, "staff.manage")
        email = (c.body.get("email") or "").strip()
        name = (c.body.get("name") or "").strip()
        password = c.body.get("password") or secrets.token_urlsafe(12)
        dept = c.body.get("department") or "support"
        perms = c.body.get("permissions") or ROLE_PRESETS.get(dept, [])

        if "@" not in email:
            raise ApiError("VALIDATION_ERROR", "некорректный адрес почты")
        if len(password) < 10:
            raise ApiError("WEAK_PASSWORD", "пароль сотрудника — минимум 10 символов")
        if dept not in ROLE_PRESETS:
            raise ApiError("VALIDATION_ERROR", "неизвестный отдел")

        try:
            res = accounts.create_staff(email, security.hash_password(password), name,
                                        dept, c.body.get("position") or "",
                                        perms, c.user["id"])
        except ValueError as e:
            raise ApiError(str(e), "не удалось создать сотрудника", 409)
        # Пароль возвращается один раз: сохранить его — задача создающего
        return {**res, "password": password,
                "note": "Пароль показан один раз. Передайте его сотруднику безопасным каналом."}

    @route("POST", "/v1/admin/staff/{id}", auth=True)
    def adm_staff_update(c):
        _need(c, "staff.manage")
        if c.params["id"] == c.user["id"] and c.body.get("disabled"):
            raise ApiError("SELF_LOCKOUT", "нельзя отключить собственную учётную запись")
        try:
            accounts.update_staff(c.params["id"],
                                  permissions=c.body.get("permissions"),
                                  position=c.body.get("position"),
                                  department=c.body.get("department"),
                                  disabled=c.body.get("disabled"),
                                  actor_id=c.user["id"])
        except ValueError as e:
            raise ApiError("VALIDATION_ERROR", str(e))
        return {"ok": True}

    # 13. Аналитика площадки
    @route("GET", "/v1/admin/analytics", auth=True)
    def adm_analytics(c):
        _need(c, "reports.view")
        days = min(int((c.query.get("days") or ["30"])[0]), 180)
        since = db.now() - days * 86400
        day = 86400

        def bucket(rows):
            out = [0] * days
            for r in rows:
                i = days - 1 - int((db.now() - r["created_at"]) // day)
                if 0 <= i < days:
                    out[i] += 1
            return out

        signups = bucket(db.q("SELECT created_at FROM users WHERE created_at > ?", (since,)))
        logins = bucket(db.q("SELECT created_at FROM login_history WHERE event='login' AND created_at > ?", (since,)))
        trades = bucket(db.q("SELECT created_at FROM fills WHERE created_at > ?", (since,)))
        tickets = bucket(db.q("SELECT created_at FROM support_tickets WHERE created_at > ?", (since,)))

        by_country = db.q("""SELECT COALESCE(country,'не указана') AS c, COUNT(*) n
                             FROM users GROUP BY c ORDER BY n DESC LIMIT 10""")
        by_device = db.q("""SELECT COALESCE(device_kind,'unknown') AS k, COUNT(*) n
                            FROM login_history WHERE created_at > ? GROUP BY k""", (since,))
        by_kyc = [db.q1("SELECT COUNT(*) n FROM users WHERE kyc_level=?", (i,))["n"] for i in range(4)]

        return {
            "days": days,
            "series": {"signups": signups, "logins": logins, "trades": trades, "tickets": tickets},
            "totals": {
                "users": db.q1("SELECT COUNT(*) n FROM users")["n"],
                "active": db.q1("SELECT COUNT(*) n FROM users WHERE status='active'")["n"],
                "blocked": db.q1("SELECT COUNT(*) n FROM users WHERE status='blocked'")["n"],
                "staff": db.q1("SELECT COUNT(*) n FROM staff_profiles WHERE disabled_at IS NULL")["n"],
                "openTickets": db.q1("SELECT COUNT(*) n FROM v_support_queue")["n"],
                "openOrders": db.q1("SELECT COUNT(*) n FROM v_open_orders")["n"],
                "fills": db.q1("SELECT COUNT(*) n FROM fills WHERE created_at > ?", (since,))["n"],
                "deposits": db.q1("SELECT COUNT(*) n FROM transactions WHERE kind='deposit' AND created_at > ?", (since,))["n"],
                "withdrawals": db.q1("SELECT COUNT(*) n FROM transactions WHERE kind='withdraw' AND created_at > ?", (since,))["n"],
            },
            "byCountry": [{"name": r["c"], "count": r["n"]} for r in by_country],
            "byDevice": [{"name": r["k"], "count": r["n"]} for r in by_device],
            "byKyc": by_kyc,
            "staffActivity": [dict(r) for r in db.q("SELECT * FROM v_staff_activity")],
            "integrity": db.check_integrity(),
        }

    # 14. Журнал действий с фильтрами
    @route("GET", "/v1/admin/audit/search", auth=True)
    def adm_audit(c):
        _need(c, "reports.view")
        level = (c.query.get("level") or ["all"])[0]
        actor = (c.query.get("actor") or [""])[0]
        sql = """SELECT a.*, u.email AS actor_email FROM audit_log a
                 LEFT JOIN users u ON u.id = a.actor_id WHERE 1=1"""
        args: list = []
        if level != "all":
            sql += " AND a.level=?"; args.append(level)
        if actor:
            sql += " AND a.actor_id=?"; args.append(actor)
        sql += " ORDER BY a.created_at DESC LIMIT 300"
        return [{
            "id": r["id"], "actor": r["actor_email"] or r["actor_kind"],
            "action": r["action"], "target": r["target"], "level": r["level"],
            "payload": json.loads(r["payload"]) if r["payload"] else None,
            "ip": r["ip"], "at": r["created_at"] * 1000,
        } for r in db.q(sql, args)]

    # 15. Выгрузка данных клиента (право на переносимость данных)
    @route("GET", "/v1/admin/users/{id}/export", auth=True)
    def adm_export(c):
        _need(c, "reports.view")
        uid = c.params["id"]
        return {
            "user": dict(db.q1("SELECT * FROM v_user_summary WHERE user_id=?", (uid,)) or {}),
            "balances": db.balances_of(uid),
            "transactions": [dict(r) for r in db.q(
                "SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC", (uid,))],
            "orders": [dict(r) for r in db.q(
                "SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC", (uid,))],
            "logins": accounts.login_history(uid, 500),
            "devices": accounts.devices(uid),
            "exportedAt": db.now() * 1000,
        }
