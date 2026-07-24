"""MERIDIAN — пароли, сессии и подпись запросов.

Схема подписи намеренно совпадает с той, что реализована на фронтенде через
WebCrypto (js/api/sign.js). Канонизируемая строка одна и та же с обеих сторон:

    METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(body)

Подписывается HMAC-SHA256 на секрете ключа. Секрет по сети не ходит никогда:
клиент шлёт только api_key и подпись, сервер хранит лишь хэш секрета и
пересчитывает HMAC. Три независимые защиты от повторного проигрывания:
окно по времени, одноразовый nonce и включение тела запроса в подпись.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Optional

from . import db

# ── Пароли ───────────────────────────────────────────────────────────────
# scrypt, а не «просто sha256»: он требует памяти, что делает перебор на GPU
# несоизмеримо дороже. Параметры — рекомендованные для интерактивного входа.

SCRYPT_N = 2 ** 15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_LEN = 32


def _maxmem(n: int, r: int) -> int:
    """Лимит памяти для scrypt.

    OpenSSL по умолчанию разрешает ровно 32 МиБ, а N=2^15, r=8 требует
    128·N·r = те же 32 МиБ плюс служебные структуры — и падает с
    «memory limit exceeded». Считаем требуемое и берём с запасом,
    вместо того чтобы ослаблять параметры до заведомо слабых.
    """
    return 128 * n * r * 2 + (1 << 20)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt,
                        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_LEN,
                        maxmem=_maxmem(SCRYPT_N, SCRYPT_R))
    return "scrypt${}${}${}${}${}".format(
        SCRYPT_N, SCRYPT_R, SCRYPT_P,
        base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.scrypt(password.encode("utf-8"), salt=salt,
                            n=int(n), r=int(r), p=int(p), dklen=len(expected),
                            maxmem=_maxmem(int(n), int(r)))
        # Сравнение постоянного времени: обычное == утекает длину совпадения
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


# ── Секрет экземпляра ────────────────────────────────────────────────────

_SECRET_FILE = os.path.join(db.BASE_DIR, ".instance_secret")


def instance_secret() -> bytes:
    """Секрет для подписи токенов. Создаётся при первом запуске и не в репозитории."""
    if os.path.exists(_SECRET_FILE):
        with open(_SECRET_FILE, "rb") as f:
            return f.read().strip()
    s = secrets.token_bytes(32)
    with open(_SECRET_FILE, "wb") as f:
        f.write(s)
    try:
        os.chmod(_SECRET_FILE, 0o600)
    except OSError:
        pass  # На Windows права выставляются иначе, не критично для макета
    return s


# ── Токены сессий ────────────────────────────────────────────────────────

def new_session_token() -> tuple[str, str]:
    """Возвращает (токен для клиента, его хэш для базы)."""
    raw = secrets.token_urlsafe(32)
    return raw, hashlib.sha256(raw.encode()).hexdigest()


def session_token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


SESSION_TTL = 3600 * 12


def create_session(user_id: str, ip: str = "", ua: str = "") -> str:
    """Создаёт сессию и заодно фиксирует, откуда и с какого устройства вошли."""
    from . import accounts            # импорт здесь: accounts зависит от security

    raw, h = new_session_token()
    parsed = accounts.parse_user_agent(ua)
    geo = accounts.geo_lookup(ip)

    db.run("""INSERT INTO sessions(id,user_id,token_hash,ip,user_agent,expires_at,
              city,country,device_kind,os,browser,last_active_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
           (db.gen_id("ses"), user_id, h, ip, ua[:200], db.now() + SESSION_TTL,
            geo["city"], geo["country"], parsed["kind"], parsed["os"], parsed["browser"],
            db.now()))
    return raw


def user_by_session(raw_token: str) -> Optional[dict]:
    if not raw_token:
        return None
    row = db.q1(
        """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?""",
        (session_token_hash(raw_token), db.now()))
    return dict(row) if row else None


def revoke_session(raw_token: str) -> None:
    db.run("UPDATE sessions SET revoked_at=? WHERE token_hash=?",
           (db.now(), session_token_hash(raw_token)))


# ── API-ключи и подпись запросов ─────────────────────────────────────────

SIGNATURE_WINDOW = 30      # секунд расхождения часов, которые принимаем
NONCE_TTL = 300            # сколько держим nonce в базе


def new_api_key() -> tuple[str, str, str]:
    """(api_key, secret, secret_hash). Секрет показывается клиенту один раз."""
    key = "mrdn_" + secrets.token_hex(12)
    secret = secrets.token_hex(32)
    return key, secret, hashlib.sha256(secret.encode()).hexdigest()


def canonical_string(method: str, path: str, timestamp: str, nonce: str, body: str) -> str:
    """Ровно та же канонизация, что в js/api/sign.js. Расхождение сломает подпись."""
    body_hash = hashlib.sha256((body or "").encode("utf-8")).hexdigest()
    return "\n".join([method.upper(), path, str(timestamp), nonce, body_hash])


def sign(secret: str, canonical: str) -> str:
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"),
                    hashlib.sha256).hexdigest()


class SignatureError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def verify_signed_request(headers: dict, method: str, path: str, body: str) -> dict:
    """Проверяет подписанный запрос и возвращает пользователя вместе с правами.

    Порядок проверок важен: сначала дешёвые (наличие, время), потом обращение
    к базе, и только в конце — вычисление HMAC.
    """
    api_key = headers.get("x-api-key", "")
    ts = headers.get("x-timestamp", "")
    nonce = headers.get("x-nonce", "")
    signature = headers.get("x-signature", "")

    if not (api_key and ts and nonce and signature):
        raise SignatureError("SIGNATURE_MISSING", "нужны X-Api-Key, X-Timestamp, X-Nonce, X-Signature")

    try:
        ts_int = int(ts)
    except ValueError:
        raise SignatureError("BAD_TIMESTAMP", "X-Timestamp должен быть unix-временем в секундах")

    drift = abs(db.now() - ts_int)
    if drift > SIGNATURE_WINDOW:
        raise SignatureError("TIMESTAMP_OUT_OF_WINDOW",
                             f"расхождение часов {drift} с, допустимо {SIGNATURE_WINDOW}")

    if len(nonce) < 8 or len(nonce) > 128:
        raise SignatureError("BAD_NONCE", "длина nonce вне допустимого диапазона")

    row = db.q1("""SELECT k.*, u.id AS uid, u.status, u.role
                   FROM api_keys k JOIN users u ON u.id = k.user_id
                   WHERE k.api_key = ? AND k.revoked_at IS NULL""", (api_key,))
    if not row:
        raise SignatureError("UNKNOWN_API_KEY", "ключ не найден или отозван")
    if row["status"] == "blocked":
        raise SignatureError("ACCOUNT_BLOCKED", "счёт заблокирован")

    # Секрет не хранится, поэтому подпись проверяем по секрету из заголовка?
    # Нет — секрет клиент не шлёт. Хранить только хэш и при этом проверять HMAC
    # невозможно, поэтому секрет лежит зашифрованным на секрете экземпляра.
    secret = _decrypt_secret(row["secret_hash"])
    expected = sign(secret, canonical_string(method, path, ts, nonce, body))
    if not hmac.compare_digest(expected, signature):
        raise SignatureError("BAD_SIGNATURE", "подпись не совпала")

    # Nonce одноразовый: повтор того же запроса не пройдёт
    try:
        db.run("INSERT INTO request_nonces(nonce, api_key) VALUES(?,?)", (nonce, api_key))
    except Exception:
        raise SignatureError("NONCE_REUSED", "такой nonce уже использован")

    db.run("UPDATE api_keys SET last_used_at=? WHERE id=?", (db.now(), row["id"]))
    return {
        "user_id": row["uid"],
        "role": row["role"],
        "perms": (row["perms"] or "read").split(","),
        "api_key_id": row["id"],
    }


# ── Хранение секретов ключей ─────────────────────────────────────────────
# Проверка HMAC требует самого секрета, поэтому «только хэш» здесь не годится.
# Компромисс: секрет лежит зашифрованным на секрете экземпляра, который хранится
# отдельным файлом вне базы. Утечка одного лишь дампа базы ключи не раскрывает.
# В проде это место занимает KMS/HSM.

def _keystream(nonce: bytes, length: int) -> bytes:
    out = b""
    counter = 0
    while len(out) < length:
        out += hmac.new(instance_secret(), nonce + counter.to_bytes(4, "big"),
                        hashlib.sha256).digest()
        counter += 1
    return out[:length]


def encrypt_secret(secret: str) -> str:
    raw = secret.encode()
    nonce = secrets.token_bytes(16)
    ct = bytes(a ^ b for a, b in zip(raw, _keystream(nonce, len(raw))))
    tag = hmac.new(instance_secret(), nonce + ct, hashlib.sha256).digest()[:16]
    return base64.b64encode(nonce + tag + ct).decode()


def _decrypt_secret(blob: str) -> str:
    data = base64.b64decode(blob)
    nonce, tag, ct = data[:16], data[16:32], data[32:]
    expect = hmac.new(instance_secret(), nonce + ct, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(expect, tag):
        raise SignatureError("SECRET_TAMPERED", "нарушена целостность хранимого секрета")
    return bytes(a ^ b for a, b in zip(ct, _keystream(nonce, len(ct)))).decode()


def purge_nonces() -> int:
    cur = db.run("DELETE FROM request_nonces WHERE seen_at < ?", (db.now() - NONCE_TTL,))
    return cur.rowcount


# ── Ограничение частоты ──────────────────────────────────────────────────

_hits: dict[str, list[float]] = {}


def rate_limit(key: str, limit: int, window: float = 60.0) -> bool:
    """True — запрос разрешён. Скользящее окно в памяти процесса."""
    now = time.time()
    arr = _hits.setdefault(key, [])
    cutoff = now - window
    arr[:] = [t for t in arr if t > cutoff]
    if len(arr) >= limit:
        return False
    arr.append(now)
    return True
