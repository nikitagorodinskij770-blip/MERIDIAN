"""MERIDIAN — HTTP-сервер: REST API + отдача фронтенда.

Один процесс отдаёт и статику, и /v1/*. Так CSP задаётся в одном месте и
не расходится между сервером API и сервером страниц.

Запуск из корня проекта:
    python -m server.app [порт]
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from . import db, security, engine, accounts, routes_v2
from .db import LedgerError
from .engine import TradeError
from .security import SignatureError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PORT = 8787

# Источники, к которым фронтенду разрешено ходить за котировками.
# Список закрытый: всё, чего здесь нет, браузер заблокирует сам.
QUOTE_ORIGINS = " ".join([
    "https://api.binance.com", "wss://stream.binance.com:9443",
    "https://api.coinbase.com", "https://api.exchange.coinbase.com",
    "https://api.coingecko.com", "https://www.okx.com",
    "https://api.bybit.com", "https://api.kraken.com",
    "https://www.bitstamp.net",
])

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",      # инлайновые style= в разметке
    "img-src 'self' data:",
    "font-src 'self'",
    f"connect-src 'self' {QUOTE_ORIGINS}",
    "frame-ancestors 'none'",                 # запрет встраивания: анти-кликджекинг
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
])


# ── Роутер ───────────────────────────────────────────────────────────────

ROUTES: list[tuple[str, str, object, bool]] = []   # method, pattern, handler, auth_required


def route(method: str, pattern: str, auth: bool = False):
    rx = re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", pattern) + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn, auth))
        return fn
    return deco


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# ── Контекст запроса ─────────────────────────────────────────────────────

class Ctx:
    def __init__(self, handler, params, body, query):
        self.h = handler
        self.params = params
        self.body = body
        self.query = query
        self.user = None
        self.perms = ["read"]

    @property
    def ip(self):
        return self.h.client_address[0]

    def require_perm(self, perm: str):
        if perm not in self.perms and "*" not in self.perms:
            raise ApiError("FORBIDDEN", f"ключу не выдано право «{perm}»", 403)

    def require_admin(self):
        if not self.user or self.user.get("role") != "admin":
            raise ApiError("FORBIDDEN", "нужны права администратора", 403)


# ── Публичные эндпоинты ──────────────────────────────────────────────────

@route("GET", "/v1/health")
def health(c):
    integrity = db.check_integrity()
    return {
        "status": "ok",
        "time": db.now(),
        "ledgerBalanced": integrity["ok"],
        "users": db.q1("SELECT COUNT(*) n FROM users")["n"],
        "orders": db.q1("SELECT COUNT(*) n FROM orders WHERE status IN ('open','partially_filled')")["n"],
    }


@route("GET", "/v1/assets")
def list_assets(c):
    rows = db.q("SELECT id,name,kind,scale,display_dec,is_listed FROM assets ORDER BY id")
    return [dict(r) for r in rows]


@route("GET", "/v1/markets")
def list_markets(c):
    rows = db.q("SELECT symbol,base_id,quote_id,is_active FROM markets ORDER BY symbol")
    return [dict(r) for r in rows]


@route("GET", "/v1/markets/{symbol}/orderbook")
def get_book(c):
    depth = int(c.query.get("depth", ["20"])[0])
    return engine.order_book(c.params["symbol"], min(depth, 100))


# ── Аутентификация ───────────────────────────────────────────────────────

@route("POST", "/v1/auth/register")
def register(c):
    if db.setting("registrations_open", "1") != "1":
        raise ApiError("REGISTRATIONS_CLOSED", "регистрация временно закрыта", 403)
    if not security.rate_limit(f"reg:{c.ip}", 5, 3600):
        raise ApiError("RATE_LIMITED", "слишком много регистраций с этого адреса", 429)

    email = (c.body.get("email") or "").strip()
    password = c.body.get("password") or ""
    if "@" not in email or len(email) > 200:
        raise ApiError("VALIDATION_ERROR", "некорректный адрес почты")
    if len(password) < 8:
        raise ApiError("WEAK_PASSWORD", "пароль короче 8 символов")

    norm = email.lower()
    if db.q1("SELECT 1 FROM users WHERE email_norm=?", (norm,)):
        # Не подтверждаем существование чужого адреса — это утечка
        raise ApiError("REGISTRATION_FAILED", "не удалось создать счёт")

    uid = db.gen_id("usr")
    db.run("""INSERT INTO users(id,email,email_norm,pw_hash,display_name,country,anti_phishing)
              VALUES(?,?,?,?,?,?,?)""",
           (uid, email, norm, security.hash_password(password),
            (c.body.get("name") or "").strip()[:80], c.body.get("country"),
            "MERIDIAN-" + secrets.token_hex(3).upper()))
    db.audit("auth.register", actor_id=uid, actor_kind="user", ip=c.ip)

    ua = c.h.headers.get("User-Agent", "")
    accounts.record_login(uid, c.ip, ua, "login")
    accounts.notify(uid, "account", "Добро пожаловать в MERIDIAN",
                    "Счёт открыт. Пройдите верификацию, чтобы снять лимиты на вывод, "
                    "и включите двухфакторную защиту в настройках безопасности.",
                    level="success", link="#/account/security")
    token = security.create_session(uid, c.ip, ua)
    return {"userId": uid, "token": token}


@route("POST", "/v1/auth/login")
def login(c):
    if not security.rate_limit(f"login:{c.ip}", 10, 300):
        raise ApiError("RATE_LIMITED", "слишком много попыток входа", 429)

    email = (c.body.get("email") or "").strip().lower()
    password = c.body.get("password") or ""
    u = db.q1("SELECT * FROM users WHERE email_norm=?", (email,))

    # Одинаковый ответ на неизвестный адрес и неверный пароль
    if not u or not security.verify_password(password, u["pw_hash"]):
        if u:
            db.run("UPDATE users SET failed_logins=failed_logins+1 WHERE id=?", (u["id"],))
            db.audit("auth.fail", actor_id=u["id"], actor_kind="user", ip=c.ip, level="warn")
            accounts.record_login(u["id"], c.ip, c.h.headers.get("User-Agent", ""), "failed")
        raise ApiError("INVALID_CREDENTIALS", "неверная пара адрес/пароль", 401)

    if u["locked_until"] and u["locked_until"] > db.now():
        raise ApiError("ACCOUNT_LOCKED", "вход временно заблокирован", 423)
    if u["status"] == "blocked":
        raise ApiError("ACCOUNT_BLOCKED", u["block_reason"] or "счёт заблокирован", 403)

    db.run("UPDATE users SET failed_logins=0, last_seen_at=? WHERE id=?", (db.now(), u["id"]))
    db.audit("auth.login", actor_id=u["id"], actor_kind="user", ip=c.ip)
    ua = c.h.headers.get("User-Agent", "")
    device = accounts.record_login(u["id"], c.ip, ua, "login")
    token = security.create_session(u["id"], c.ip, ua)
    return {"userId": u["id"], "token": token, "role": u["role"], "device": device}


@route("POST", "/v1/auth/logout", auth=True)
def logout(c):
    auth = c.h.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        security.revoke_session(auth[7:])
    return {"ok": True}


@route("GET", "/v1/account", auth=True)
def account(c):
    u = c.user
    return {
        "id": u["id"], "email": u["email"], "name": u["display_name"],
        "status": u["status"], "kycLevel": u["kyc_level"], "role": u["role"],
        "twoFA": bool(u["twofa_secret"]), "antiPhishing": u["anti_phishing"],
        "createdAt": u["created_at"] * 1000,
    }


# ── Кошелёк ──────────────────────────────────────────────────────────────

@route("GET", "/v1/wallet/balances", auth=True)
def balances(c):
    c.require_perm("read")
    return db.balances_of(c.user["id"])


@route("GET", "/v1/wallet/{asset}/deposit-address", auth=True)
def deposit_address(c):
    c.require_perm("read")
    asset = c.params["asset"].upper()
    network = (c.query.get("network") or [""])[0]
    if not db.q1("SELECT 1 FROM asset_networks WHERE asset_id=? AND network_id=?", (asset, network)):
        raise ApiError("NETWORK_NOT_SUPPORTED", f"{asset} не принимается в сети {network}")

    row = db.q1("""SELECT address, memo FROM deposit_addresses
                   WHERE user_id=? AND asset_id=? AND network_id=?""",
                (c.user["id"], asset, network))
    if row:
        addr = row["address"]
    else:
        addr = _derive_address(network)
        db.run("""INSERT INTO deposit_addresses(id,user_id,asset_id,network_id,address)
                  VALUES(?,?,?,?,?)""",
               (db.gen_id("adr"), c.user["id"], asset, network, addr))

    an = db.q1("SELECT min_deposit FROM asset_networks WHERE asset_id=? AND network_id=?",
               (asset, network))
    net = db.q1("SELECT confirmations FROM networks WHERE id=?", (network,))
    return {"asset": asset, "network": network, "address": addr,
            "minDeposit": db.to_human(asset, an["min_deposit"]),
            "confirmations": net["confirmations"]}


def _derive_address(network: str) -> str:
    """Заглушка деривации. В проде — HD-вывод из xpub (PLAN.md §6.5)."""
    fmt = db.q1("SELECT addr_format FROM networks WHERE id=?", (network,))
    f = fmt["addr_format"] if fmt else "evm"
    if f == "evm":
        return "0x" + secrets.token_hex(20)
    if f == "bech32":
        return "bc1q" + secrets.token_hex(19)[:38]
    if f == "base58check":
        return "T" + secrets.token_hex(17)[:33]
    return secrets.token_hex(22)


@route("POST", "/v1/wallet/{asset}/withdraw", auth=True)
def withdraw(c):
    c.require_perm("withdraw")
    asset = c.params["asset"].upper()
    network = c.body.get("network") or ""
    address = (c.body.get("address") or "").strip()
    if not address:
        raise ApiError("VALIDATION_ERROR", "не указан адрес получателя")

    try:
        amount = db.to_minor(asset, c.body.get("amount"))
    except Exception:
        raise ApiError("VALIDATION_ERROR", "некорректная сумма")

    return engine.request_withdrawal(c.user["id"], asset, network, address, amount)


@route("POST", "/v1/wallet/{asset}/deposit", auth=True)
def simulate_deposit(c):
    """Эмуляция зачисления. В проде сюда приходит вебхук блокчейн-воркера."""
    c.require_perm("trade")
    asset = c.params["asset"].upper()
    network = c.body.get("network") or ""
    amount = db.to_minor(asset, c.body.get("amount"))
    return engine.credit_deposit(c.user["id"], asset, amount, network,
                                 c.body.get("txHash") or secrets.token_hex(32))


@route("GET", "/v1/wallet/transactions", auth=True)
def transactions(c):
    c.require_perm("read")
    limit = min(int((c.query.get("limit") or ["50"])[0]), 200)
    rows = db.q("""SELECT id,kind,asset_id,network_id,amount,fee,address,tx_hash,status,created_at
                   FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?""",
                (c.user["id"], limit))
    return [{
        "id": r["id"], "kind": r["kind"], "asset": r["asset_id"],
        "network": r["network_id"], "amount": db.to_human(r["asset_id"], r["amount"]),
        "fee": db.to_human(r["asset_id"], r["fee"]), "address": r["address"],
        "txHash": r["tx_hash"], "status": r["status"], "createdAt": r["created_at"] * 1000,
    } for r in rows]


# ── Торговля ─────────────────────────────────────────────────────────────

@route("POST", "/v1/orders", auth=True)
def create_order(c):
    c.require_perm("trade")
    symbol = c.body.get("market") or c.body.get("pair") or ""
    m = db.q1("SELECT base_id, quote_id FROM markets WHERE symbol=?", (symbol,))
    if not m:
        raise ApiError("MARKET_NOT_FOUND", f"рынок {symbol} не найден", 404)

    try:
        qty = db.to_minor(m["base_id"], c.body.get("quantity"))
        price = db.to_minor(m["quote_id"], c.body["price"]) if c.body.get("price") else None
    except Exception:
        raise ApiError("VALIDATION_ERROR", "некорректная цена или количество")

    return engine.place_order(c.user["id"], symbol, c.body.get("side"),
                              c.body.get("type", "limit"), qty, price,
                              c.body.get("clientOrderId"))


@route("GET", "/v1/orders", auth=True)
def list_orders(c):
    c.require_perm("read")
    status = (c.query.get("status") or ["all"])[0]
    sql = "SELECT id FROM orders WHERE user_id=?"
    args = [c.user["id"]]
    if status == "open":
        sql += " AND status IN ('open','partially_filled')"
    sql += " ORDER BY created_at DESC LIMIT 100"
    return [engine.get_order(r["id"]) for r in db.q(sql, args)]


@route("DELETE", "/v1/orders/{id}", auth=True)
def kill_order(c):
    c.require_perm("trade")
    return engine.cancel_order(c.user["id"], c.params["id"])


# ── API-ключи ────────────────────────────────────────────────────────────

@route("POST", "/v1/apikeys", auth=True)
def create_key(c):
    label = (c.body.get("label") or "ключ").strip()[:60]
    perms = c.body.get("perms") or ["read"]
    allowed = {"read", "trade", "withdraw"}
    if not set(perms) <= allowed:
        raise ApiError("VALIDATION_ERROR", f"права только из набора {sorted(allowed)}")

    key, secret, _ = security.new_api_key()
    db.run("""INSERT INTO api_keys(id,user_id,label,api_key,secret_hash,perms)
              VALUES(?,?,?,?,?,?)""",
           (db.gen_id("key"), c.user["id"], label, key,
            security.encrypt_secret(secret), ",".join(perms)))
    db.audit("apikey.create", actor_id=c.user["id"], actor_kind="user",
             target=key, payload={"perms": perms}, level="warn")
    # Секрет отдаётся ровно один раз и больше нигде не появляется
    return {"apiKey": key, "secret": secret, "perms": perms,
            "note": "Секрет показан один раз. Сохраните его сейчас."}


@route("GET", "/v1/apikeys", auth=True)
def list_keys(c):
    rows = db.q("""SELECT id,label,api_key,perms,created_at,last_used_at
                   FROM api_keys WHERE user_id=? AND revoked_at IS NULL""", (c.user["id"],))
    return [dict(r) for r in rows]


@route("DELETE", "/v1/apikeys/{id}", auth=True)
def revoke_key(c):
    db.run("UPDATE api_keys SET revoked_at=? WHERE id=? AND user_id=?",
           (db.now(), c.params["id"], c.user["id"]))
    db.audit("apikey.revoke", actor_id=c.user["id"], actor_kind="user",
             target=c.params["id"], level="warn")
    return {"ok": True}


# ── Администрирование ────────────────────────────────────────────────────

@route("GET", "/v1/admin/stats", auth=True)
def admin_stats(c):
    c.require_admin()
    return {
        "users": db.q1("SELECT COUNT(*) n FROM users")["n"],
        "active": db.q1("SELECT COUNT(*) n FROM users WHERE status='active'")["n"],
        "blocked": db.q1("SELECT COUNT(*) n FROM users WHERE status='blocked'")["n"],
        "openOrders": db.q1("SELECT COUNT(*) n FROM v_open_orders")["n"],
        "fills24h": db.q1("SELECT COUNT(*) n FROM fills WHERE created_at > ?",
                          (db.now() - 86400,))["n"],
        "integrity": db.check_integrity(),
    }


@route("GET", "/v1/admin/users", auth=True)
def admin_users(c):
    c.require_admin()
    rows = db.q("""SELECT id,email,display_name,country,status,kyc_level,role,created_at,last_seen_at
                   FROM users ORDER BY created_at DESC LIMIT 200""")
    return [dict(r) for r in rows]


@route("POST", "/v1/admin/users/{id}/block", auth=True)
def admin_block(c):
    c.require_admin()
    reason = (c.body.get("reason") or "").strip()
    if not reason:
        # Схема БД тоже это запретит, но лучше вернуть внятную ошибку
        raise ApiError("REASON_REQUIRED", "блокировка требует указания основания")
    db.run("UPDATE users SET status='blocked', block_reason=?, updated_at=? WHERE id=?",
           (reason, db.now(), c.params["id"]))
    db.run("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
           (db.now(), c.params["id"]))
    db.audit("admin.user.block", actor_id=c.user["id"], actor_kind="admin",
             target=c.params["id"], payload={"reason": reason}, level="warn")
    return {"ok": True, "status": "blocked", "reason": reason}


@route("POST", "/v1/admin/users/{id}/unblock", auth=True)
def admin_unblock(c):
    c.require_admin()
    db.run("UPDATE users SET status='active', block_reason=NULL, updated_at=? WHERE id=?",
           (db.now(), c.params["id"]))
    db.audit("admin.user.unblock", actor_id=c.user["id"], actor_kind="admin",
             target=c.params["id"], level="warn")
    return {"ok": True, "status": "active"}


@route("GET", "/v1/admin/integrity", auth=True)
def admin_integrity(c):
    c.require_admin()
    return db.check_integrity()


@route("GET", "/v1/admin/audit", auth=True)
def admin_audit(c):
    c.require_admin()
    rows = db.q("""SELECT id,actor_id,actor_kind,action,target,level,created_at
                   FROM audit_log ORDER BY created_at DESC LIMIT 200""")
    return [dict(r) for r in rows]


# ── HTTP-обработчик ──────────────────────────────────────────────────────

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "MERIDIAN/1.0"
    protocol_version = "HTTP/1.1"

    # ── Ответы ──
    def _security_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        self.send_header("Cache-Control", "no-store")

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _ok(self, data):
        self._json({"data": data, "error": None})

    def _err(self, code, message, status=400):
        self._json({"data": None, "error": {"code": code, "message": message}}, status)

    # ── Методы ──
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type,Authorization,X-Api-Key,X-Timestamp,X-Nonce,X-Signature")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if not path.startswith("/v1/"):
            return self._serve_static(path) if method == "GET" else self._err(
                "NOT_FOUND", "неизвестный путь", 404)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._err("VALIDATION_ERROR", "некорректный Content-Length")
        if length > 1_000_000:
            return self._err("PAYLOAD_TOO_LARGE", "тело запроса больше 1 МБ", 413)

        # Тело читаем всегда целиком, даже если оно негодное: иначе непрочитанные
        # байты останутся в сокете и «съедут» на следующий запрос в keep-alive.
        raw_bytes = self.rfile.read(length) if length else b""
        try:
            raw = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            # Кривая кодировка — это ошибка клиента, а не повод ронять соединение
            return self._err("VALIDATION_ERROR", "тело запроса не в кодировке UTF-8")

        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return self._err("VALIDATION_ERROR", "тело запроса не является JSON")
        if not isinstance(body, dict):
            return self._err("VALIDATION_ERROR", "ожидается JSON-объект")

        for m, rx, fn, need_auth in ROUTES:
            if m != method:
                continue
            match = rx.match(path)
            if not match:
                continue

            ctx = Ctx(self, match.groupdict(), body, parse_qs(parsed.query))
            try:
                if need_auth:
                    self._authenticate(ctx, method, path, raw)
                return self._ok(fn(ctx))
            except ApiError as e:
                return self._err(e.code, e.message, e.status)
            except SignatureError as e:
                return self._err(e.code, str(e), 401)
            except (TradeError, LedgerError) as e:
                status = 403 if e.code in ("TRADING_DISABLED", "KYC_REQUIRED") else 422
                return self._err(e.code, str(e), status)
            except Exception as e:
                traceback.print_exc()
                return self._err("INTERNAL", "внутренняя ошибка", 500)

        self._err("NOT_FOUND", f"нет обработчика для {method} {path}", 404)

    def _authenticate(self, ctx, method, path, raw_body):
        """Два способа: сессионный Bearer-токен либо подписанный запрос."""
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            user = security.user_by_session(auth[7:])
            if not user:
                raise ApiError("UNAUTHORIZED", "сессия недействительна", 401)
            if user["status"] == "blocked":
                raise ApiError("ACCOUNT_BLOCKED", user["block_reason"] or "счёт заблокирован", 403)
            ctx.user = user
            ctx.perms = ["*"]                       # у владельца сессии полные права
            db.run("UPDATE sessions SET last_active_at=? WHERE token_hash=?",
                   (db.now(), security.session_token_hash(auth[7:])))
            return

        if self.headers.get("X-Api-Key"):
            hdrs = {k.lower(): v for k, v in self.headers.items()}
            info = security.verify_signed_request(hdrs, method, path, raw_body)
            ctx.user = dict(db.q1("SELECT * FROM users WHERE id=?", (info["user_id"],)))
            ctx.perms = info["perms"]
            return

        raise ApiError("UNAUTHORIZED", "нужен Bearer-токен или подписанный запрос", 401)

    # ── Статика ──
    def _serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(ROOT, rel))
        # Защита от выхода за пределы каталога проекта
        if not full.startswith(ROOT) or os.path.isdir(full):
            full = os.path.join(ROOT, "index.html")
        if not os.path.exists(full):
            full = os.path.join(ROOT, "index.html")

        ext = os.path.splitext(full)[1]
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            return self._err("NOT_FOUND", "файл не найден", 404)

        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else ""
        if code.startswith(("4", "5")):
            sys.stderr.write(f"{self.address_string()} {fmt % args}\n")


# Маршруты личного кабинета, поддержки и администрирования
routes_v2.register(route, ApiError)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    db.bootstrap()
    security.purge_nonces()
    print(f"MERIDIAN API + фронтенд → http://127.0.0.1:{port}/")
    print(f"База: {db.DB_PATH}")
    print(f"Проверка сходимости журнала: {db.check_integrity()['ok']}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
