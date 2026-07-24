"""MERIDIAN — слой доступа к базе.

Ключевая функция здесь — post_tx(): единственный способ изменить баланс.
Прямых UPDATE по balances нет и быть не должно: остаток обязан оставаться
следствием журнала проводок, иначе теряется сходимость и аудируемость.
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Iterable, Optional

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "meridian.db")
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.sql")

_conn: Optional[sqlite3.Connection] = None


# ── Подключение ──────────────────────────────────────────────────────────

def connect() -> sqlite3.Connection:
    """Одно соединение на процесс. WAL — чтобы чтение не блокировало запись."""
    global _conn
    if _conn is not None:
        return _conn

    conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA synchronous = NORMAL")
    _conn = conn
    return conn


@contextmanager
def tx():
    """Транзакция. Откатывается целиком при любом исключении."""
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def q(sql: str, params: Iterable = ()) -> list[sqlite3.Row]:
    return connect().execute(sql, tuple(params)).fetchall()


def q1(sql: str, params: Iterable = ()) -> Optional[sqlite3.Row]:
    return connect().execute(sql, tuple(params)).fetchone()


def run(sql: str, params: Iterable = ()) -> sqlite3.Cursor:
    return connect().execute(sql, tuple(params))


def now() -> int:
    return int(time.time())


def gen_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


# ── Инициализация ────────────────────────────────────────────────────────

SCHEMA_V2_PATH = os.path.join(BASE_DIR, "schema_v2.sql")


def init_schema() -> None:
    conn = connect()
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        conn.executescript(f.read())

    # Расширение схемы. ALTER TABLE ADD COLUMN в SQLite не поддерживает
    # IF NOT EXISTS, поэтому выполняем по одному оператору и пропускаем
    # ровно ту ошибку, которая означает «колонка уже есть».
    if os.path.exists(SCHEMA_V2_PATH):
        with open(SCHEMA_V2_PATH, encoding="utf-8") as f:
            script = f.read()
        for stmt in _split_sql(script):
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError as e:
                if "duplicate column name" in str(e).lower():
                    continue
                raise


def _split_sql(script: str) -> list[str]:
    """Делит скрипт на операторы, не разрывая тела триггеров.

    Наивный split(';') сломал бы CREATE TRIGGER ... BEGIN ... END;
    поэтому внутри BEGIN…END точки с запятой не считаются границей.
    """
    out, buf, depth = [], [], 0
    for line in script.splitlines():
        stripped = line.strip()
        if stripped.startswith("--") or not stripped:
            continue
        upper = stripped.upper()
        buf.append(line)
        if upper.startswith("CREATE TRIGGER"):
            depth = 1
        if depth and upper.startswith("END;"):
            depth = 0
            out.append("\n".join(buf)); buf = []
            continue
        if not depth and stripped.endswith(";"):
            out.append("\n".join(buf)); buf = []
    if buf:
        out.append("\n".join(buf))
    return [s for s in out if s.strip()]


ASSET_SEED = [
    # (id, name, kind, scale, display_dec)
    ("BTC",   "Bitcoin",          "crypto", 8, 8),
    ("ETH",   "Ethereum",         "crypto", 8, 6),
    ("BNB",   "BNB",              "crypto", 8, 4),
    ("SOL",   "Solana",           "crypto", 8, 4),
    ("XRP",   "XRP",              "crypto", 6, 2),
    ("TON",   "Toncoin",          "crypto", 8, 3),
    ("ADA",   "Cardano",          "crypto", 6, 2),
    ("DOGE",  "Dogecoin",         "crypto", 8, 1),
    ("TRX",   "TRON",             "crypto", 6, 2),
    ("AVAX",  "Avalanche",        "crypto", 8, 4),
    ("DOT",   "Polkadot",         "crypto", 8, 3),
    ("LINK",  "Chainlink",        "crypto", 8, 4),
    ("MATIC", "Polygon",          "crypto", 8, 2),
    ("LTC",   "Litecoin",         "crypto", 8, 5),
    ("BCH",   "Bitcoin Cash",     "crypto", 8, 5),
    ("ATOM",  "Cosmos",           "crypto", 6, 3),
    ("XMR",   "Monero",           "crypto", 8, 5),
    ("NEAR",  "NEAR Protocol",    "crypto", 8, 3),
    ("USDT",  "Tether USD",       "stable", 6, 2),
    ("USDC",  "USD Coin",         "stable", 6, 2),
    ("DAI",   "Dai",              "stable", 8, 2),
    ("USD",   "Доллар США",       "fiat",   2, 2),
    ("EUR",   "Евро",             "fiat",   2, 2),
    ("GBP",   "Фунт стерлингов",  "fiat",   2, 2),
    ("RUB",   "Российский рубль", "fiat",   2, 2),
    ("AED",   "Дирхам ОАЭ",       "fiat",   2, 2),
    ("TRY",   "Турецкая лира",    "fiat",   2, 2),
    ("KZT",   "Тенге",            "fiat",   2, 2),
    ("XAU",   "Золото (унция)",   "metal",  6, 4),
    ("XAG",   "Серебро (унция)",  "metal",  6, 3),
]

NETWORK_SEED = [
    ("Bitcoin", "Bitcoin",  "bech32",      2),
    ("ERC20",   "Ethereum", "evm",        12),
    ("TRC20",   "TRON",     "base58check", 1),
    ("BEP20",   "BNB Chain","evm",        15),
    ("Solana",  "Solana",   "base58",     32),
    ("Polygon", "Polygon",  "evm",       128),
    ("TON",     "TON",      "other",       1),
    ("SEPA",    "SEPA",     "other",       0),
]

# (asset, network, комиссия вывода в USD-эквиваленте, минимум вывода)
ASSET_NETWORK_SEED = [
    ("BTC", "Bitcoin", 0.00004, 0.0005), ("BTC", "BEP20", 0.000005, 0.0002),
    ("ETH", "ERC20", 0.0012, 0.005),     ("ETH", "BEP20", 0.0001, 0.002),
    ("USDT", "TRC20", 1.0, 10.0),        ("USDT", "ERC20", 3.8, 20.0),
    ("USDT", "BEP20", 0.35, 10.0),       ("USDT", "Solana", 0.02, 5.0),
    ("USDC", "ERC20", 3.8, 20.0),        ("USDC", "Solana", 0.02, 5.0),
    ("SOL", "Solana", 0.001, 0.02),      ("TRX", "TRC20", 1.0, 5.0),
    ("MATIC", "Polygon", 0.01, 1.0),     ("TON", "TON", 0.01, 0.5),
    ("EUR", "SEPA", 0.5, 10.0),          ("USD", "SEPA", 1.0, 10.0),
]

MARKET_SEED = [
    "BTC-USDT", "ETH-USDT", "BNB-USDT", "SOL-USDT", "XRP-USDT", "ADA-USDT",
    "DOGE-USDT", "TRX-USDT", "AVAX-USDT", "DOT-USDT", "LINK-USDT", "LTC-USDT",
    "BCH-USDT", "ATOM-USDT", "TON-USDT", "MATIC-USDT", "XMR-USDT", "NEAR-USDT",
    "BTC-USD", "ETH-USD", "BTC-EUR", "ETH-BTC", "SOL-BTC",
]

DEFAULT_SETTINGS = {
    "maker_fee_bps": "10",        # 0.10%
    "taker_fee_bps": "15",        # 0.15%
    "convert_fee_bps": "35",      # 0.35%
    "trading_enabled": "1",
    "withdrawals_enabled": "1",
    "registrations_open": "1",
    "maintenance": "0",
    "require_kyc_for_withdraw": "1",
    "withdraw_daily_limit_usd": "50000",
}


def seed_reference_data() -> None:
    """Справочники. Идемпотентно: повторный вызов ничего не ломает."""
    with tx() as c:
        for aid, name, kind, scale, dec in ASSET_SEED:
            c.execute(
                """INSERT INTO assets(id,name,kind,scale,display_dec) VALUES(?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind""",
                (aid, name, kind, scale, dec))

        for nid, name, fmt, conf in NETWORK_SEED:
            c.execute(
                """INSERT INTO networks(id,name,addr_format,confirmations) VALUES(?,?,?,?)
                   ON CONFLICT(id) DO NOTHING""",
                (nid, name, fmt, conf))

        for aid, nid, fee, mn in ASSET_NETWORK_SEED:
            scale = c.execute("SELECT scale FROM assets WHERE id=?", (aid,)).fetchone()
            if not scale:
                continue
            f = 10 ** scale["scale"]
            c.execute(
                """INSERT INTO asset_networks(asset_id,network_id,withdraw_fee,min_withdraw,min_deposit)
                   VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING""",
                (aid, nid, round(fee * f), round(mn * f), round(mn * f)))

        for sym in MARKET_SEED:
            base, quote = sym.split("-")
            if not c.execute("SELECT 1 FROM assets WHERE id=?", (base,)).fetchone():
                continue
            if not c.execute("SELECT 1 FROM assets WHERE id=?", (quote,)).fetchone():
                continue
            c.execute(
                """INSERT INTO markets(symbol,base_id,quote_id) VALUES(?,?,?)
                   ON CONFLICT(symbol) DO NOTHING""",
                (sym, base, quote))

        for k, v in DEFAULT_SETTINGS.items():
            c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING", (k, v))


# ── Работа с суммами ─────────────────────────────────────────────────────

_scale_cache: dict[str, int] = {}


def scale_of(asset_id: str) -> int:
    if asset_id not in _scale_cache:
        row = q1("SELECT scale FROM assets WHERE id=?", (asset_id,))
        if row is None:
            raise ValueError(f"UNKNOWN_ASSET:{asset_id}")
        _scale_cache[asset_id] = row["scale"]
    return _scale_cache[asset_id]


def to_minor(asset_id: str, human) -> int:
    """0.5 BTC → 50000000. Через строку и Decimal, чтобы не поймать 0.1+0.2."""
    from decimal import Decimal, ROUND_DOWN
    f = Decimal(10) ** scale_of(asset_id)
    return int((Decimal(str(human)) * f).quantize(Decimal(1), rounding=ROUND_DOWN))


def to_human(asset_id: str, minor: int) -> str:
    """50000000 сатоши → '0.5'.

    format(..., 'f') обязателен: normalize() сам по себе превращает 50000
    в '5E+4', а научная запись в финансовом API — источник ошибок разбора
    на стороне клиента.
    """
    from decimal import Decimal
    f = Decimal(10) ** scale_of(asset_id)
    return format((Decimal(minor) / f).normalize(), "f")


# ── План счетов ──────────────────────────────────────────────────────────

def account_id(user_id: Optional[str], asset_id: str, kind: str, conn=None) -> str:
    """Возвращает id счёта, создавая его при первом обращении."""
    c = conn or connect()
    row = c.execute(
        """SELECT id FROM ledger_accounts
           WHERE asset_id=? AND kind=? AND user_id IS ?""",
        (asset_id, kind, user_id)).fetchone()
    if row:
        return row["id"]
    aid = gen_id("acc")
    c.execute("INSERT INTO ledger_accounts(id,user_id,asset_id,kind) VALUES(?,?,?,?)",
              (aid, user_id, asset_id, kind))
    c.execute("INSERT INTO balances(account_id,amount) VALUES(?,0) ON CONFLICT DO NOTHING", (aid,))
    return aid


# ── Проведение операции ──────────────────────────────────────────────────

class LedgerError(Exception):
    """Ошибка проводки. code попадает в HTTP-ответ."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def post_tx(kind: str, entries: list[tuple[str, str, int]], *,
            ref_id: str | None = None, memo: str | None = None, conn=None) -> str:
    """Проводит сбалансированную операцию.

    entries — список (account_id, asset_id, amount). Дебет положителен,
    кредит отрицателен. Сумма по каждому активу обязана быть нулём —
    иначе операция отклоняется до записи, а не «чинится» потом.
    """
    if not entries:
        raise LedgerError("EMPTY_TX", "проводка без записей")

    by_asset: dict[str, int] = {}
    for _, asset, amount in entries:
        if amount == 0:
            raise LedgerError("ZERO_AMOUNT", "нулевая проводка бессмысленна")
        by_asset[asset] = by_asset.get(asset, 0) + amount

    for asset, delta in by_asset.items():
        if delta != 0:
            raise LedgerError("UNBALANCED_TX", f"{asset}: дисбаланс {delta}")

    own = conn is None
    c = conn or connect()
    if own:
        c.execute("BEGIN IMMEDIATE")
    try:
        tx_id = gen_id("ltx")
        c.execute("INSERT INTO ledger_tx(id,kind,ref_id,memo) VALUES(?,?,?,?)",
                  (tx_id, kind, ref_id, memo))
        for acc, asset, amount in entries:
            c.execute(
                "INSERT INTO ledger_entries(tx_id,account_id,asset_id,amount) VALUES(?,?,?,?)",
                (tx_id, acc, asset, amount))
        if own:
            c.execute("COMMIT")
        return tx_id
    except sqlite3.IntegrityError as e:
        if own:
            c.execute("ROLLBACK")
        # Триггер запрета отрицательного остатка сообщает именно так
        if "INSUFFICIENT_BALANCE" in str(e):
            raise LedgerError("INSUFFICIENT_BALANCE", "недостаточно средств") from e
        raise
    except Exception:
        if own:
            c.execute("ROLLBACK")
        raise


def balances_of(user_id: str) -> list[dict]:
    rows = q("""SELECT asset_id, scale, available, locked, total
                FROM v_user_balances WHERE user_id=? AND total <> 0
                ORDER BY asset_id""", (user_id,))
    return [{
        "asset": r["asset_id"],
        "available": to_human(r["asset_id"], r["available"]),
        "locked": to_human(r["asset_id"], r["locked"]),
        "total": to_human(r["asset_id"], r["total"]),
        "availableMinor": r["available"],
    } for r in rows]


def available_of(user_id: str, asset_id: str) -> int:
    row = q1("SELECT available FROM v_user_balances WHERE user_id=? AND asset_id=?",
             (user_id, asset_id))
    return row["available"] if row else 0


def check_integrity() -> dict:
    """Сходимость журнала и совпадение кэша балансов с проводками."""
    imbalance = q("SELECT * FROM v_ledger_imbalance")
    drift = q("""SELECT b.account_id, b.amount AS cached,
                        COALESCE((SELECT SUM(amount) FROM ledger_entries e
                                  WHERE e.account_id = b.account_id), 0) AS actual
                 FROM balances b""")
    bad = [dict(r) for r in drift if r["cached"] != r["actual"]]
    return {
        "balanced": len(imbalance) == 0,
        "imbalanced_tx": [dict(r) for r in imbalance],
        "balance_drift": bad,
        "ok": len(imbalance) == 0 and len(bad) == 0,
    }


# ── Настройки и журнал ───────────────────────────────────────────────────

def setting(key: str, default: str = "") -> str:
    row = q1("SELECT value FROM settings WHERE key=?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    run("""INSERT INTO settings(key,value,updated_at) VALUES(?,?,unixepoch())
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()""",
        (key, str(value)))


def audit(action: str, *, actor_id=None, actor_kind="system", target=None,
          payload=None, ip=None, level="info") -> None:
    run("""INSERT INTO audit_log(actor_id,actor_kind,action,target,payload,ip,level)
           VALUES(?,?,?,?,?,?,?)""",
        (actor_id, actor_kind, action, target,
         json.dumps(payload, ensure_ascii=False) if payload else None, ip, level))


def bootstrap() -> None:
    init_schema()
    seed_reference_data()
