"""MERIDIAN — личные кабинеты: устройства, гео, уведомления, поддержка, персонал.

Здесь живёт всё, что делает кабинет личным: откуда и с чего человек заходил,
что ему написали, о чём он спросил поддержку и какие у него полномочия.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Optional

from . import db
from .db import gen_id, now

# ─────────────────────────────────────────────────────────────────────────
# Разбор User-Agent
#
# Полноценный парсер UA — отдельная библиотека с базой сигнатур, которой
# здесь нет. Задача скромнее: показать человеку узнаваемое «Windows · Chrome»
# в списке устройств. Порядок проверок важен — Edge содержит и Chrome,
# и Safari в своей строке, поэтому идёт первым.
# ─────────────────────────────────────────────────────────────────────────

def parse_user_agent(ua: str) -> dict:
    ua = ua or ""
    low = ua.lower()

    if "ipad" in low or ("android" in low and "mobile" not in low):
        kind = "tablet"
    elif any(k in low for k in ("mobi", "iphone", "android", "phone")):
        kind = "mobile"
    elif ua:
        kind = "desktop"
    else:
        kind = "unknown"

    os_name = "неизвестно"
    for needle, name in (
        ("windows nt 10", "Windows 10/11"), ("windows nt", "Windows"),
        ("mac os x", "macOS"), ("iphone os", "iOS"), ("ipad", "iPadOS"),
        ("android", "Android"), ("cros", "ChromeOS"),
        ("ubuntu", "Ubuntu"), ("linux", "Linux"),
    ):
        if needle in low:
            os_name = name
            break

    browser = "неизвестно"
    for needle, name in (
        ("edg/", "Edge"), ("opr/", "Opera"), ("yabrowser", "Yandex"),
        ("firefox/", "Firefox"), ("chrome/", "Chrome"),
        ("safari/", "Safari"), ("curl/", "curl"), ("python", "Python"),
    ):
        if needle in low:
            browser = name
            break

    return {"kind": kind, "os": os_name, "browser": browser}


def device_fingerprint(ua: str, extra: str = "") -> str:
    """Отпечаток устройства. Не идентификатор личности — лишь способ
    отличить «этот же браузер» от «нового», чтобы предупредить о входе."""
    parsed = parse_user_agent(ua)
    raw = f"{parsed['kind']}|{parsed['os']}|{parsed['browser']}|{extra}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


# ─────────────────────────────────────────────────────────────────────────
# Геолокация по IP
#
# Внешний сервис не вызываем: это отправило бы IP клиента третьей стороне
# без его согласия, что для биржи неприемлемо. Определяем то, что можно
# определить локально; при подключении собственной базы GeoIP эта функция
# станет единственным местом правки.
# ─────────────────────────────────────────────────────────────────────────

_PRIVATE = (
    (re.compile(r"^127\."), "локальная машина", "loopback"),
    (re.compile(r"^10\."), "внутренняя сеть", "private"),
    (re.compile(r"^192\.168\."), "внутренняя сеть", "private"),
    (re.compile(r"^172\.(1[6-9]|2\d|3[01])\."), "внутренняя сеть", "private"),
    (re.compile(r"^::1$"), "локальная машина", "loopback"),
)


def geo_lookup(ip: str) -> dict:
    ip = (ip or "").strip()
    for rx, city, country in _PRIVATE:
        if rx.match(ip):
            return {"city": city, "country": country, "resolved": False}
    return {"city": None, "country": None, "resolved": False}


# ─────────────────────────────────────────────────────────────────────────
# Вход: запись истории и распознавание нового устройства
# ─────────────────────────────────────────────────────────────────────────

def record_login(user_id: str, ip: str, ua: str, event: str = "login") -> dict:
    """Пишет событие входа и возвращает сведения об устройстве.

    Новое устройство — повод для уведомления безопасности: именно так
    клиент узнаёт о чужом доступе раньше, чем пропадут средства.
    """
    parsed = parse_user_agent(ua)
    geo = geo_lookup(ip)
    fp = device_fingerprint(ua)

    known = db.q1("SELECT * FROM known_devices WHERE user_id=? AND fingerprint=?", (user_id, fp))
    is_new = known is None and event == "login"

    if event == "login":
        if known:
            db.run("""UPDATE known_devices SET last_seen_at=?, last_ip=?, last_city=?
                      WHERE id=?""", (now(), ip, geo["city"], known["id"]))
        else:
            db.run("""INSERT INTO known_devices(id,user_id,fingerprint,label,device_kind,os,browser,
                      last_ip,last_city) VALUES(?,?,?,?,?,?,?,?,?)""",
                   (gen_id("dev"), user_id, fp,
                    f"{parsed['os']} · {parsed['browser']}",
                    parsed["kind"], parsed["os"], parsed["browser"], ip, geo["city"]))

    db.run("""INSERT INTO login_history(user_id,event,ip,country,city,device_kind,os,browser,
              user_agent,is_new_device) VALUES(?,?,?,?,?,?,?,?,?,?)""",
           (user_id, event, ip, geo["country"], geo["city"],
            parsed["kind"], parsed["os"], parsed["browser"], (ua or "")[:300], int(is_new)))

    if is_new:
        notify(user_id, "security", "Вход с нового устройства",
               f"{parsed['os']} · {parsed['browser']}, адрес {ip}. "
               "Если это были не вы — смените пароль и завершите все сессии.",
               level="warning", link="#/account/security")

    return {**parsed, **geo, "fingerprint": fp, "isNew": is_new}


def login_history(user_id: str, limit: int = 50) -> list[dict]:
    rows = db.q("""SELECT event,ip,city,country,device_kind,os,browser,is_new_device,created_at
                   FROM login_history WHERE user_id=? ORDER BY created_at DESC LIMIT ?""",
                (user_id, limit))
    return [{
        "event": r["event"], "ip": r["ip"], "city": r["city"], "country": r["country"],
        "device": r["device_kind"], "os": r["os"], "browser": r["browser"],
        "isNew": bool(r["is_new_device"]), "at": r["created_at"] * 1000,
    } for r in rows]


def devices(user_id: str) -> list[dict]:
    rows = db.q("""SELECT id,label,device_kind,os,browser,last_ip,last_city,trusted,
                          first_seen_at,last_seen_at
                   FROM known_devices WHERE user_id=? ORDER BY last_seen_at DESC""", (user_id,))
    return [{
        "id": r["id"], "label": r["label"], "kind": r["device_kind"],
        "os": r["os"], "browser": r["browser"], "ip": r["last_ip"], "city": r["last_city"],
        "trusted": bool(r["trusted"]),
        "firstSeen": r["first_seen_at"] * 1000, "lastSeen": r["last_seen_at"] * 1000,
    } for r in rows]


def active_sessions(user_id: str) -> list[dict]:
    rows = db.q("""SELECT id,ip,city,device_kind,os,browser,created_at,expires_at,last_active_at
                   FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at > ?
                   ORDER BY created_at DESC""", (user_id, now()))
    return [{
        "id": r["id"], "ip": r["ip"], "city": r["city"], "kind": r["device_kind"],
        "os": r["os"], "browser": r["browser"],
        "createdAt": r["created_at"] * 1000,
        "lastActive": (r["last_active_at"] or r["created_at"]) * 1000,
    } for r in rows]


def revoke_all_sessions(user_id: str, keep_token_hash: str | None = None) -> int:
    sql = "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL"
    args = [now(), user_id]
    if keep_token_hash:
        sql += " AND token_hash <> ?"
        args.append(keep_token_hash)
    return db.run(sql, args).rowcount


# ─────────────────────────────────────────────────────────────────────────
# Уведомления
# ─────────────────────────────────────────────────────────────────────────

def notify(user_id: str, kind: str, title: str, body: str = "",
           level: str = "info", link: str | None = None,
           created_by: str | None = None) -> str:
    nid = gen_id("ntf")
    db.run("""INSERT INTO notifications(id,user_id,kind,title,body,link,level,created_by)
              VALUES(?,?,?,?,?,?,?,?)""",
           (nid, user_id, kind, title, body, link, level, created_by))
    return nid


def notifications(user_id: str, only_unread: bool = False, limit: int = 60) -> list[dict]:
    sql = "SELECT * FROM notifications WHERE user_id=?"
    if only_unread:
        sql += " AND read_at IS NULL"
    sql += " ORDER BY created_at DESC LIMIT ?"
    rows = db.q(sql, (user_id, limit))
    return [{
        "id": r["id"], "kind": r["kind"], "title": r["title"], "body": r["body"],
        "link": r["link"], "level": r["level"], "read": r["read_at"] is not None,
        "createdAt": r["created_at"] * 1000,
    } for r in rows]


def unread_count(user_id: str) -> int:
    return db.q1("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL",
                 (user_id,))["n"]


def mark_read(user_id: str, notification_id: str | None = None) -> int:
    if notification_id:
        return db.run("UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL",
                      (now(), notification_id, user_id)).rowcount
    return db.run("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL",
                  (now(), user_id)).rowcount


# ─────────────────────────────────────────────────────────────────────────
# Поддержка
# ─────────────────────────────────────────────────────────────────────────

def create_ticket(user_id: str, subject: str, body: str,
                  category: str = "general", priority: str = "normal") -> dict:
    tid = gen_id("tkt")
    db.run("""INSERT INTO support_tickets(id,user_id,subject,category,priority)
              VALUES(?,?,?,?,?)""", (tid, user_id, subject.strip()[:200], category, priority))
    db.run("""INSERT INTO support_messages(id,ticket_id,author_id,author_kind,body)
              VALUES(?,?,?,'user',?)""", (gen_id("msg"), tid, user_id, body.strip()))
    db.audit("support.ticket.create", actor_id=user_id, actor_kind="user", target=tid,
             payload={"subject": subject[:80], "category": category})
    return get_ticket(user_id, tid)


def post_message(ticket_id: str, author_id: str, body: str,
                 author_kind: str = "user", internal: bool = False) -> dict:
    t = db.q1("SELECT * FROM support_tickets WHERE id=?", (ticket_id,))
    if not t:
        raise ValueError("TICKET_NOT_FOUND")
    if t["status"] == "closed":
        raise ValueError("TICKET_CLOSED")

    mid = gen_id("msg")
    db.run("""INSERT INTO support_messages(id,ticket_id,author_id,author_kind,body,is_internal)
              VALUES(?,?,?,?,?,?)""",
           (mid, ticket_id, author_id, author_kind, body.strip(), int(internal)))

    # Ответ оператора — повод уведомить клиента; внутренние заметки не тревожат
    if author_kind == "staff" and not internal:
        notify(t["user_id"], "support", "Ответ службы поддержки",
               f"По обращению «{t['subject']}» получен ответ.",
               link=f"#/support/{ticket_id}", created_by=author_id)
    return {"id": mid, "ticketId": ticket_id}


def get_ticket(user_id: str | None, ticket_id: str, staff_view: bool = False) -> dict:
    t = db.q1("SELECT * FROM support_tickets WHERE id=?", (ticket_id,))
    if not t:
        raise ValueError("TICKET_NOT_FOUND")
    if not staff_view and t["user_id"] != user_id:
        raise ValueError("FORBIDDEN")

    sql = "SELECT * FROM support_messages WHERE ticket_id=?"
    if not staff_view:
        sql += " AND is_internal=0"      # клиент внутренних заметок не видит
    sql += " ORDER BY created_at"
    msgs = db.q(sql, (ticket_id,))

    return {
        "id": t["id"], "subject": t["subject"], "category": t["category"],
        "status": t["status"], "priority": t["priority"],
        "createdAt": t["created_at"] * 1000, "updatedAt": t["updated_at"] * 1000,
        "messages": [{
            "id": m["id"], "authorKind": m["author_kind"], "body": m["body"],
            "internal": bool(m["is_internal"]), "createdAt": m["created_at"] * 1000,
        } for m in msgs],
    }


def list_tickets(user_id: str) -> list[dict]:
    rows = db.q("""SELECT t.*, (SELECT COUNT(*) FROM support_messages m
                                WHERE m.ticket_id=t.id AND m.is_internal=0) AS msgs
                   FROM support_tickets t WHERE t.user_id=? ORDER BY t.updated_at DESC""",
                (user_id,))
    return [{
        "id": r["id"], "subject": r["subject"], "category": r["category"],
        "status": r["status"], "priority": r["priority"], "messages": r["msgs"],
        "updatedAt": r["updated_at"] * 1000,
    } for r in rows]


def support_queue(status: str = "all", limit: int = 100) -> list[dict]:
    sql = "SELECT * FROM v_support_queue"
    args: list = []
    if status != "all":
        sql += " WHERE status=?"
        args.append(status)
    sql += " ORDER BY priority_rank, updated_at DESC LIMIT ?"
    args.append(limit)
    return [{
        "id": r["id"], "subject": r["subject"], "category": r["category"],
        "status": r["status"], "priority": r["priority"],
        "user": {"id": r["user_id"], "email": r["user_email"], "name": r["user_name"]},
        "messages": r["message_count"], "idleSeconds": r["idle_seconds"],
        "assignee": r["assignee_id"], "updatedAt": r["updated_at"] * 1000,
    } for r in db.q(sql, args)]


def set_ticket_status(ticket_id: str, status: str, actor_id: str) -> None:
    db.run("""UPDATE support_tickets SET status=?, updated_at=?,
              closed_at=CASE WHEN ? IN ('closed','resolved') THEN unixepoch() ELSE closed_at END
              WHERE id=?""", (status, now(), status, ticket_id))
    db.audit("support.ticket.status", actor_id=actor_id, actor_kind="staff",
             target=ticket_id, payload={"status": status})


def assign_ticket(ticket_id: str, assignee_id: str | None, actor_id: str) -> None:
    db.run("UPDATE support_tickets SET assignee_id=?, updated_at=? WHERE id=?",
           (assignee_id, now(), ticket_id))
    db.audit("support.ticket.assign", actor_id=actor_id, actor_kind="staff", target=ticket_id)


# ─────────────────────────────────────────────────────────────────────────
# Персонал и полномочия
# ─────────────────────────────────────────────────────────────────────────

PERMISSIONS = {
    "users.view":      "Просмотр карточек клиентов",
    "users.block":     "Блокировка и разблокировка",
    "users.kyc":       "Изменение уровня верификации",
    "users.limits":    "Настройка лимитов",
    "users.balance":   "Корректировка баланса",
    "users.sessions":  "Завершение сессий и сброс 2FA",
    "support.reply":   "Ответы в поддержке",
    "support.manage":  "Назначение и закрытие обращений",
    "notify.send":     "Отправка уведомлений",
    "staff.manage":    "Управление сотрудниками",
    "platform.settings": "Настройки площадки",
    "reports.view":    "Отчёты и выгрузки",
}

ROLE_PRESETS = {
    "support":    ["users.view", "support.reply", "notify.send"],
    "compliance": ["users.view", "users.block", "users.kyc", "users.limits",
                   "users.sessions", "support.reply", "reports.view"],
    "finance":    ["users.view", "users.balance", "users.limits", "reports.view"],
    "engineering": ["users.view", "platform.settings", "reports.view"],
    "management": list(PERMISSIONS.keys()),
}


def create_staff(email: str, password_hash: str, name: str, department: str,
                 position: str, permissions: list[str], created_by: str) -> dict:
    """Создаёт учётную запись сотрудника.

    Роль в users.role определяет базовый доступ, permissions — точный набор:
    два оператора поддержки могут иметь разные полномочия.
    """
    norm = email.strip().lower()
    if db.q1("SELECT 1 FROM users WHERE email_norm=?", (norm,)):
        raise ValueError("EMAIL_TAKEN")

    bad = set(permissions) - set(PERMISSIONS)
    if bad:
        raise ValueError(f"UNKNOWN_PERMISSIONS:{','.join(sorted(bad))}")

    role = "admin" if department == "management" else "support"
    uid = gen_id("stf")
    with db.tx() as c:
        c.execute("""INSERT INTO users(id,email,email_norm,pw_hash,display_name,status,role,kyc_level)
                     VALUES(?,?,?,?,?,'active',?,3)""",
                  (uid, email.strip(), norm, password_hash, name.strip()[:80], role))
        c.execute("""INSERT INTO staff_profiles(user_id,position,department,permissions,created_by)
                     VALUES(?,?,?,?,?)""",
                  (uid, position.strip()[:80], department, ",".join(permissions), created_by))

    db.audit("staff.create", actor_id=created_by, actor_kind="admin", target=uid,
             payload={"email": email, "department": department, "permissions": permissions},
             level="warn")
    notify(uid, "account", "Учётная запись сотрудника создана",
           f"Вам выданы полномочия: {', '.join(PERMISSIONS[p] for p in permissions) or '—'}.",
           level="info")
    return {"id": uid, "email": email, "department": department, "permissions": permissions}


def staff_list() -> list[dict]:
    rows = db.q("""SELECT sp.*, u.email, u.display_name, u.status, u.last_seen_at,
                          (SELECT COUNT(*) FROM support_messages m
                            WHERE m.author_id = sp.user_id AND m.author_kind='staff') AS replies,
                          (SELECT COUNT(*) FROM audit_log a
                            WHERE a.actor_id = sp.user_id AND a.created_at > unixepoch()-604800) AS actions7d
                   FROM staff_profiles sp JOIN users u ON u.id = sp.user_id
                   ORDER BY sp.created_at DESC""")
    return [{
        "id": r["user_id"], "email": r["email"], "name": r["display_name"],
        "position": r["position"], "department": r["department"],
        "permissions": [p for p in (r["permissions"] or "").split(",") if p],
        "status": r["status"], "disabled": r["disabled_at"] is not None,
        "replies": r["replies"], "actions7d": r["actions7d"],
        "lastSeen": (r["last_seen_at"] or 0) * 1000,
        "createdAt": r["created_at"] * 1000,
    } for r in rows]


def staff_permissions(user_id: str) -> list[str]:
    r = db.q1("SELECT permissions, disabled_at FROM staff_profiles WHERE user_id=?", (user_id,))
    if not r or r["disabled_at"]:
        return []
    return [p for p in (r["permissions"] or "").split(",") if p]


def is_root_admin(user: dict) -> bool:
    """Корневой администратор — учётная запись с ролью admin, у которой нет
    профиля сотрудника. Такая заводится при развёртывании площадки: ограничить
    её правами некому, потому что выдавать их ещё некому.
    Все последующие администраторы получают профиль и ограничены им."""
    return user.get("role") == "admin" and not db.q1(
        "SELECT 1 FROM staff_profiles WHERE user_id=?", (user["id"],))


def has_permission(user: dict, perm: str) -> bool:
    """Права выдаются явно: новый сотрудник по умолчанию не может ничего.
    Исключение — корневой администратор."""
    if user.get("role") not in ("admin", "support"):
        return False
    if is_root_admin(user):
        return True
    return perm in staff_permissions(user["id"])


def update_staff(user_id: str, *, permissions=None, position=None,
                 department=None, disabled=None, actor_id: str = "") -> None:
    sets, args = [], []
    if permissions is not None:
        bad = set(permissions) - set(PERMISSIONS)
        if bad:
            raise ValueError(f"UNKNOWN_PERMISSIONS:{','.join(sorted(bad))}")
        sets.append("permissions=?"); args.append(",".join(permissions))
    if position is not None:
        sets.append("position=?"); args.append(position[:80])
    if department is not None:
        sets.append("department=?"); args.append(department)
    if disabled is not None:
        sets.append("disabled_at=?"); args.append(now() if disabled else None)
    if not sets:
        return
    args.append(user_id)
    db.run(f"UPDATE staff_profiles SET {', '.join(sets)} WHERE user_id=?", args)
    if disabled:
        revoke_all_sessions(user_id)
    db.audit("staff.update", actor_id=actor_id, actor_kind="admin", target=user_id,
             payload={"permissions": permissions, "disabled": disabled}, level="warn")


# ─────────────────────────────────────────────────────────────────────────
# Лимиты и заметки
# ─────────────────────────────────────────────────────────────────────────

def get_limits(user_id: str) -> dict:
    r = db.q1("SELECT * FROM user_limits WHERE user_id=?", (user_id,))
    if not r:
        return {"withdrawDailyUsd": None, "tradeDailyUsd": None, "maxOrderUsd": None,
                "tradingFrozen": False, "withdrawFrozen": False, "note": None}
    return {
        "withdrawDailyUsd": r["withdraw_daily_usd"], "tradeDailyUsd": r["trade_daily_usd"],
        "maxOrderUsd": r["max_order_usd"], "tradingFrozen": bool(r["trading_frozen"]),
        "withdrawFrozen": bool(r["withdraw_frozen"]), "note": r["note"],
    }


def set_limits(user_id: str, patch: dict, actor_id: str) -> None:
    cur = db.q1("SELECT 1 FROM user_limits WHERE user_id=?", (user_id,))
    fields = {
        "withdraw_daily_usd": patch.get("withdrawDailyUsd"),
        "trade_daily_usd": patch.get("tradeDailyUsd"),
        "max_order_usd": patch.get("maxOrderUsd"),
        "trading_frozen": int(bool(patch.get("tradingFrozen"))),
        "withdraw_frozen": int(bool(patch.get("withdrawFrozen"))),
        "note": patch.get("note"),
    }
    if cur:
        db.run(f"""UPDATE user_limits SET {', '.join(f'{k}=?' for k in fields)},
                   updated_by=?, updated_at=? WHERE user_id=?""",
               [*fields.values(), actor_id, now(), user_id])
    else:
        db.run(f"""INSERT INTO user_limits(user_id,{','.join(fields)},updated_by)
                   VALUES(?,{','.join('?' * len(fields))},?)""",
               [user_id, *fields.values(), actor_id])

    db.audit("user.limits", actor_id=actor_id, actor_kind="admin", target=user_id,
             payload=patch, level="warn")
    if patch.get("tradingFrozen") or patch.get("withdrawFrozen"):
        notify(user_id, "account", "Ограничения по счёту изменены",
               "По вашему счёту установлены временные ограничения. "
               "Подробности — в службе поддержки.", level="warning")


def add_note(user_id: str, author_id: str, body: str, pinned: bool = False) -> None:
    db.run("INSERT INTO user_notes(user_id,author_id,body,pinned) VALUES(?,?,?,?)",
           (user_id, author_id, body.strip(), int(pinned)))


def notes(user_id: str) -> list[dict]:
    rows = db.q("""SELECT n.*, u.display_name AS author FROM user_notes n
                   LEFT JOIN users u ON u.id = n.author_id
                   WHERE n.user_id=? ORDER BY n.pinned DESC, n.created_at DESC""", (user_id,))
    return [{"id": r["id"], "body": r["body"], "author": r["author"],
             "pinned": bool(r["pinned"]), "createdAt": r["created_at"] * 1000} for r in rows]


# ─────────────────────────────────────────────────────────────────────────
# Статистика кабинета
# ─────────────────────────────────────────────────────────────────────────

def user_activity(user_id: str, days: int = 30) -> dict:
    """Ряды по дням: пополнения, выводы, сделки, входы.

    Суммы приводим к USD по текущим курсам активов — иначе складывать
    BTC с рублями бессмысленно. Курс берётся из таблицы assets, а не с биржи:
    серверу незачем ходить наружу ради экрана статистики.
    """
    since = now() - days * 86400
    day = 86400

    def series(sql, args):
        rows = db.q(sql, args)
        buckets = [0.0] * days
        for r in rows:
            idx = days - 1 - int((now() - r["created_at"]) // day)
            if 0 <= idx < days:
                buckets[idx] += r["v"]
        return buckets

    deposits = series(
        """SELECT t.created_at, CAST(t.amount AS REAL) / POWER(10, a.scale) AS v
           FROM transactions t JOIN assets a ON a.id = t.asset_id
           WHERE t.user_id=? AND t.kind='deposit' AND t.status='completed' AND t.created_at > ?""",
        (user_id, since))
    withdrawals = series(
        """SELECT t.created_at, CAST(t.amount AS REAL) / POWER(10, a.scale) AS v
           FROM transactions t JOIN assets a ON a.id = t.asset_id
           WHERE t.user_id=? AND t.kind='withdraw' AND t.created_at > ?""",
        (user_id, since))
    trades = series(
        """SELECT f.created_at, CAST(f.quantity AS REAL) / POWER(10, a.scale) AS v
           FROM fills f JOIN orders o ON o.id = f.order_id
           JOIN markets m ON m.symbol = f.market JOIN assets a ON a.id = m.base_id
           WHERE o.user_id=? AND f.created_at > ?""",
        (user_id, since))

    logins = [0] * days
    for r in db.q("""SELECT created_at FROM login_history
                     WHERE user_id=? AND event='login' AND created_at > ?""", (user_id, since)):
        idx = days - 1 - int((now() - r["created_at"]) // day)
        if 0 <= idx < days:
            logins[idx] += 1

    summary = db.q1("SELECT * FROM v_user_summary WHERE user_id=?", (user_id,))
    return {
        "days": days,
        "deposits": deposits, "withdrawals": withdrawals,
        "trades": trades, "logins": logins,
        "totals": {
            "deposits": round(sum(deposits), 8),
            "withdrawals": round(sum(withdrawals), 8),
            "trades": round(sum(trades), 8),
            "logins": sum(logins),
        },
        "counts": dict(summary) if summary else {},
    }
