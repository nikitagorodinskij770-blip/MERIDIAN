-- ============================================================================
-- MERIDIAN — схема базы данных (SQLite)
--
-- Два принципиальных решения, определяющих всё остальное:
--
-- 1. ДЕНЬГИ — ЦЕЛЫЕ ЧИСЛА. Ни одной суммы во float. Каждый актив хранится
--    в своих минимальных единицах (сатоши, вэй, копейки), масштаб задан в
--    assets.scale. 0.1 + 0.2 != 0.3 в двоичной плавающей точке, и биржа,
--    которая этого не учла, рано или поздно теряет доли центов на каждой
--    сделке — а потом не может свести баланс.
--
-- 2. ДВОЙНАЯ ЗАПИСЬ. Балансы не «поле, которое мы обновляем», а следствие
--    журнала проводок. Каждая операция создаёт минимум две записи в
--    ledger_entries, их сумма по операции обязана быть нулём. Это даёт
--    сходимость, аудируемость и возможность пересчитать любой баланс с нуля.
--    Поле balances.amount — лишь материализованный кэш, поддерживаемый
--    триггером; расхождение кэша с журналом ловится проверкой целостности.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────────────────
-- Справочники
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS assets (
    id          TEXT PRIMARY KEY,                 -- BTC, USDT, RUB
    name        TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('crypto','stable','fiat','metal')),
    scale       INTEGER NOT NULL CHECK (scale BETWEEN 0 AND 18),
                                                  -- 10^scale минимальных единиц в 1 активе
    display_dec INTEGER NOT NULL DEFAULT 8,       -- сколько знаков показывать в UI
    is_listed   INTEGER NOT NULL DEFAULT 1 CHECK (is_listed IN (0,1)),
    can_deposit INTEGER NOT NULL DEFAULT 1 CHECK (can_deposit IN (0,1)),
    can_withdraw INTEGER NOT NULL DEFAULT 1 CHECK (can_withdraw IN (0,1)),
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS networks (
    id            TEXT PRIMARY KEY,               -- TRC20, ERC20, Bitcoin
    name          TEXT    NOT NULL,
    addr_format   TEXT    NOT NULL CHECK (addr_format IN ('evm','base58','bech32','base58check','other')),
    confirmations INTEGER NOT NULL DEFAULT 12,
    is_enabled    INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1))
);

-- Какой актив в какой сети ходит и почём
CREATE TABLE IF NOT EXISTS asset_networks (
    asset_id     TEXT    NOT NULL REFERENCES assets(id)   ON DELETE CASCADE,
    network_id   TEXT    NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    withdraw_fee INTEGER NOT NULL DEFAULT 0 CHECK (withdraw_fee >= 0),  -- в минимальных единицах
    min_withdraw INTEGER NOT NULL DEFAULT 0 CHECK (min_withdraw >= 0),
    min_deposit  INTEGER NOT NULL DEFAULT 0 CHECK (min_deposit  >= 0),
    PRIMARY KEY (asset_id, network_id)
);

CREATE TABLE IF NOT EXISTS markets (
    symbol       TEXT PRIMARY KEY,                -- BTC-USDT
    base_id      TEXT    NOT NULL REFERENCES assets(id),
    quote_id     TEXT    NOT NULL REFERENCES assets(id),
    tick_size    INTEGER NOT NULL DEFAULT 1,      -- шаг цены, мин. единицы котируемого
    lot_size     INTEGER NOT NULL DEFAULT 1,      -- шаг количества, мин. единицы базового
    min_notional INTEGER NOT NULL DEFAULT 0,
    is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    CHECK (base_id <> quote_id)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Пользователи и доступ
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT    NOT NULL,
    email_norm     TEXT    NOT NULL UNIQUE,       -- lower(trim(email)), по нему и ищем
    pw_hash        TEXT    NOT NULL,              -- scrypt$n$r$p$salt$hash
    display_name   TEXT    NOT NULL DEFAULT '',
    country        TEXT,
    status         TEXT    NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','pending','blocked','closed')),
    kyc_level      INTEGER NOT NULL DEFAULT 0 CHECK (kyc_level BETWEEN 0 AND 3),
    role           TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user','support','admin')),
    twofa_secret   TEXT,                          -- NULL = 2FA выключена
    anti_phishing  TEXT,
    block_reason   TEXT,                          -- обязателен при status='blocked'
    failed_logins  INTEGER NOT NULL DEFAULT 0,
    locked_until   INTEGER,                       -- защита от перебора пароля
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at   INTEGER,
    -- Блокировка без основания недопустима: причина должна быть в данных,
    -- а не только в намерениях оператора.
    CHECK (status <> 'blocked' OR (block_reason IS NOT NULL AND length(block_reason) > 0))
);

CREATE INDEX IF NOT EXISTS idx_users_status  ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL UNIQUE,         -- храним только хэш токена
    ip           TEXT,
    user_agent   TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at   INTEGER NOT NULL,
    revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT    NOT NULL DEFAULT '',
    api_key     TEXT    NOT NULL UNIQUE,
    secret_hash TEXT    NOT NULL,                 -- сам секрет не хранится
    perms       TEXT    NOT NULL DEFAULT 'read',  -- CSV: read,trade,withdraw
    ip_allow    TEXT,                             -- CSV, NULL = без ограничения
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_used_at INTEGER,
    revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);

-- Защита от повторного проигрывания подписанных запросов.
-- Каждый nonce принимается один раз; строки старше окна чистятся по расписанию.
CREATE TABLE IF NOT EXISTS request_nonces (
    nonce      TEXT PRIMARY KEY,
    api_key    TEXT    NOT NULL,
    seen_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_nonces_seen ON request_nonces(seen_at);

-- ─────────────────────────────────────────────────────────────────────────
-- Двойная запись
-- ─────────────────────────────────────────────────────────────────────────

-- Счета плана: клиентские, а также системные (комиссии, горячий кошелёк,
-- внешний мир). Проводка всегда идёт между двумя счетами.
CREATE TABLE IF NOT EXISTS ledger_accounts (
    id        TEXT PRIMARY KEY,
    user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL = системный
    asset_id  TEXT NOT NULL REFERENCES assets(id),
    kind      TEXT NOT NULL CHECK (kind IN ('user','locked','fee','hot_wallet','external','treasury')),
    UNIQUE (user_id, asset_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_ledger_acc_user ON ledger_accounts(user_id, asset_id);

-- Журнал операций: шапка. Одна запись = одно бизнес-событие.
CREATE TABLE IF NOT EXISTS ledger_tx (
    id          TEXT PRIMARY KEY,
    kind        TEXT    NOT NULL CHECK (kind IN
                ('deposit','withdraw','trade','convert','fee','reward','adjustment','transfer')),
    ref_id      TEXT,                              -- ссылка на order/transaction
    memo        TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ledger_tx_created ON ledger_tx(created_at DESC);

-- Проводки. amount > 0 — дебет счёта, amount < 0 — кредит.
-- Сумма всех amount в пределах одного tx_id обязана равняться нулю.
CREATE TABLE IF NOT EXISTS ledger_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id      TEXT    NOT NULL REFERENCES ledger_tx(id) ON DELETE CASCADE,
    account_id TEXT    NOT NULL REFERENCES ledger_accounts(id),
    asset_id   TEXT    NOT NULL REFERENCES assets(id),
    amount     INTEGER NOT NULL CHECK (amount <> 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_entries_tx      ON ledger_entries(tx_id);
CREATE INDEX IF NOT EXISTS idx_entries_account ON ledger_entries(account_id, id DESC);

-- Материализованный баланс. Обновляется триггером, чтобы не считать
-- сумму по всему журналу на каждый запрос.
CREATE TABLE IF NOT EXISTS balances (
    account_id TEXT PRIMARY KEY REFERENCES ledger_accounts(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TRIGGER IF NOT EXISTS trg_entry_balance
AFTER INSERT ON ledger_entries
BEGIN
    INSERT INTO balances(account_id, amount, updated_at)
    VALUES (NEW.account_id, NEW.amount, unixepoch())
    ON CONFLICT(account_id) DO UPDATE
        SET amount = amount + NEW.amount,
            updated_at = unixepoch();
END;

-- Клиентский счёт не может уйти в минус. Системные (hot_wallet, external)
-- могут: для них отрицательный остаток осмыслен.
CREATE TRIGGER IF NOT EXISTS trg_no_negative_user_balance
AFTER UPDATE ON balances
WHEN NEW.amount < 0
 AND (SELECT kind FROM ledger_accounts WHERE id = NEW.account_id) IN ('user','locked')
BEGIN
    SELECT RAISE(ABORT, 'INSUFFICIENT_BALANCE');
END;

-- ─────────────────────────────────────────────────────────────────────────
-- Торговля
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    market        TEXT    NOT NULL REFERENCES markets(symbol),
    side          TEXT    NOT NULL CHECK (side IN ('buy','sell')),
    type          TEXT    NOT NULL CHECK (type IN ('market','limit')),
    price         INTEGER CHECK (price IS NULL OR price > 0),   -- NULL для рыночных
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    filled        INTEGER NOT NULL DEFAULT 0 CHECK (filled >= 0),
    status        TEXT    NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','partially_filled','filled','canceled','rejected')),
    client_ref    TEXT,                            -- идемпотентность на стороне клиента
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (filled <= quantity),
    CHECK (type <> 'limit' OR price IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_ref
    ON orders(user_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_book
    ON orders(market, side, price, created_at) WHERE status IN ('open','partially_filled');
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fills (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    market     TEXT    NOT NULL REFERENCES markets(symbol),
    price      INTEGER NOT NULL CHECK (price > 0),
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    fee        INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
    fee_asset  TEXT    REFERENCES assets(id),
    role       TEXT    NOT NULL CHECK (role IN ('maker','taker')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_fills_order  ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_market ON fills(market, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Ввод и вывод
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deposit_addresses (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id   TEXT NOT NULL REFERENCES assets(id),
    network_id TEXT NOT NULL REFERENCES networks(id),
    address    TEXT NOT NULL,
    memo       TEXT,
    hd_index   INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, asset_id, network_id),
    UNIQUE (network_id, address)
);

CREATE TABLE IF NOT EXISTS transactions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK (kind IN ('deposit','withdraw')),
    asset_id      TEXT    NOT NULL REFERENCES assets(id),
    network_id    TEXT    REFERENCES networks(id),
    amount        INTEGER NOT NULL CHECK (amount > 0),
    fee           INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
    address       TEXT,
    tx_hash       TEXT,
    confirmations INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','failed','canceled')),
    ledger_tx_id  TEXT    REFERENCES ledger_tx(id),
    note          TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status) WHERE status IN ('pending','processing');
-- Один и тот же блокчейн-перевод не должен зачислиться дважды
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_hash_unique
    ON transactions(network_id, tx_hash) WHERE tx_hash IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Операционное
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   TEXT REFERENCES users(id),
    actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','admin','system')),
    action     TEXT NOT NULL,
    target     TEXT,
    payload    TEXT,                               -- JSON
    ip         TEXT,
    level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS broadcasts (
    id          TEXT PRIMARY KEY,
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    audience    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed')),
    recipients  INTEGER NOT NULL DEFAULT 0,
    opens       INTEGER NOT NULL DEFAULT 0,
    clicks      INTEGER NOT NULL DEFAULT 0,
    created_by  TEXT REFERENCES users(id),
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    sent_at     INTEGER
);

-- ─────────────────────────────────────────────────────────────────────────
-- Представления
-- ─────────────────────────────────────────────────────────────────────────

-- Доступный остаток = свободный минус заблокированный под ордера
CREATE VIEW IF NOT EXISTS v_user_balances AS
SELECT
    la.user_id,
    la.asset_id,
    a.scale,
    COALESCE(SUM(CASE WHEN la.kind = 'user'   THEN b.amount ELSE 0 END), 0) AS available,
    COALESCE(SUM(CASE WHEN la.kind = 'locked' THEN b.amount ELSE 0 END), 0) AS locked,
    COALESCE(SUM(b.amount), 0)                                              AS total
FROM ledger_accounts la
JOIN assets a  ON a.id = la.asset_id
LEFT JOIN balances b ON b.account_id = la.id
WHERE la.user_id IS NOT NULL AND la.kind IN ('user','locked')
GROUP BY la.user_id, la.asset_id;

-- Проверка сходимости: по каждой операции сумма проводок должна быть нулём.
-- Непустой результат — сигнал повреждения журнала.
CREATE VIEW IF NOT EXISTS v_ledger_imbalance AS
SELECT tx_id, asset_id, SUM(amount) AS delta
FROM ledger_entries
GROUP BY tx_id, asset_id
HAVING SUM(amount) <> 0;

-- Открытый стакан по рынкам
CREATE VIEW IF NOT EXISTS v_open_orders AS
SELECT id, user_id, market, side, type, price, quantity, filled,
       quantity - filled AS remaining, status, created_at
FROM orders
WHERE status IN ('open','partially_filled');
