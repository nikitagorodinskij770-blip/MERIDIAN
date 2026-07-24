-- ============================================================================
-- MERIDIAN — расширение схемы: личные кабинеты, поддержка, уведомления, персонал
--
-- Применяется поверх schema.sql. Всё через IF NOT EXISTS — миграция идемпотентна
-- и безопасна на живой базе.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────────────────
-- Журнал входов и устройств
--
-- Отдельно от sessions: сессия живёт до истечения и удаляется, а история
-- входов нужна навсегда — это основной инструмент расследования, когда
-- клиент заявляет о несанкционированном доступе.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS login_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event       TEXT    NOT NULL CHECK (event IN ('login','logout','failed','locked','password_change','2fa_change')),
    ip          TEXT,
    country     TEXT,
    city        TEXT,
    device_kind TEXT,          -- desktop / mobile / tablet / unknown
    os          TEXT,
    browser     TEXT,
    user_agent  TEXT,
    is_new_device INTEGER NOT NULL DEFAULT 0 CHECK (is_new_device IN (0,1)),
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_login_hist_user ON login_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_hist_ip   ON login_history(ip, created_at DESC);

-- Известные устройства: чтобы отличать «вход с нового устройства»
CREATE TABLE IF NOT EXISTS known_devices (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fingerprint   TEXT NOT NULL,           -- хэш от UA + платформы
    label         TEXT NOT NULL DEFAULT '',
    device_kind   TEXT,
    os            TEXT,
    browser       TEXT,
    last_ip       TEXT,
    last_city     TEXT,
    trusted       INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0,1)),
    first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON known_devices(user_id, last_seen_at DESC);

-- Обогащаем сессии геоданными
ALTER TABLE sessions ADD COLUMN city TEXT;
ALTER TABLE sessions ADD COLUMN country TEXT;
ALTER TABLE sessions ADD COLUMN device_kind TEXT;
ALTER TABLE sessions ADD COLUMN os TEXT;
ALTER TABLE sessions ADD COLUMN browser TEXT;
ALTER TABLE sessions ADD COLUMN last_active_at INTEGER;

-- ─────────────────────────────────────────────────────────────────────────
-- Уведомления
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL CHECK (kind IN
               ('security','transaction','order','system','support','promo','account')),
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    link       TEXT,
    level      TEXT    NOT NULL DEFAULT 'info' CHECK (level IN ('info','success','warning','critical')),
    read_at    INTEGER,
    created_by TEXT REFERENCES users(id),    -- NULL = система
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notif_user   ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id) WHERE read_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Поддержка: тикеты и переписка
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS support_tickets (
    id          TEXT PRIMARY KEY,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject     TEXT    NOT NULL,
    category    TEXT    NOT NULL DEFAULT 'general'
                CHECK (category IN ('general','deposit','withdraw','trading','kyc','security','api','billing')),
    status      TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','pending','answered','resolved','closed')),
    priority    TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    assignee_id TEXT REFERENCES users(id),
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    closed_at   INTEGER,
    -- Метрика скорости ответа: заполняется при первом ответе оператора
    first_reply_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tickets_user   ON support_tickets(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status, priority, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
    id         TEXT PRIMARY KEY,
    ticket_id  TEXT    NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_id  TEXT REFERENCES users(id),
    author_kind TEXT   NOT NULL CHECK (author_kind IN ('user','staff','system')),
    body       TEXT    NOT NULL,
    is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0,1)),  -- заметка для персонала
    read_at    INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_msgs_ticket ON support_messages(ticket_id, created_at);

-- Обновляем updated_at тикета при каждом сообщении: сортировка по активности
CREATE TRIGGER IF NOT EXISTS trg_ticket_touch
AFTER INSERT ON support_messages
BEGIN
    UPDATE support_tickets
       SET updated_at = unixepoch(),
           status = CASE
               WHEN NEW.author_kind = 'staff' AND NEW.is_internal = 0 THEN 'answered'
               WHEN NEW.author_kind = 'user' THEN 'pending'
               ELSE status END,
           first_reply_at = CASE
               WHEN first_reply_at IS NULL AND NEW.author_kind = 'staff' AND NEW.is_internal = 0
               THEN unixepoch() ELSE first_reply_at END
     WHERE id = NEW.ticket_id;
END;

-- ─────────────────────────────────────────────────────────────────────────
-- Персонал и права
--
-- Роль лежит в users.role, но набор прав — отдельно: у двух операторов
-- поддержки могут быть разные полномочия при одной роли.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS staff_profiles (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    position     TEXT NOT NULL DEFAULT '',
    department   TEXT NOT NULL DEFAULT 'support'
                 CHECK (department IN ('support','compliance','finance','engineering','management')),
    permissions  TEXT NOT NULL DEFAULT '',      -- CSV из PERMISSIONS
    created_by   TEXT REFERENCES users(id),
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    disabled_at  INTEGER
);

-- Лимиты по пользователю: переопределяют общие настройки площадки
CREATE TABLE IF NOT EXISTS user_limits (
    user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    withdraw_daily_usd INTEGER,      -- NULL = берём общий лимит
    trade_daily_usd    INTEGER,
    max_order_usd      INTEGER,
    trading_frozen     INTEGER NOT NULL DEFAULT 0 CHECK (trading_frozen IN (0,1)),
    withdraw_frozen    INTEGER NOT NULL DEFAULT 0 CHECK (withdraw_frozen IN (0,1)),
    note               TEXT,
    updated_by         TEXT REFERENCES users(id),
    updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Заметки операторов о клиенте (внутренние, клиенту не видны)
CREATE TABLE IF NOT EXISTS user_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id  TEXT REFERENCES users(id),
    body       TEXT NOT NULL,
    pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notes_user ON user_notes(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Курсы активов
--
-- Сервер не ходит на биржи ради экрана статистики: цены складывает сюда
-- фронтенд (у него уже есть живой поток), а сервер лишь пользуется последним
-- известным значением. Так оценка портфеля не зависит от доступности биржи
-- в момент запроса и не плодит исходящих соединений с бэкенда.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS asset_prices (
    asset_id       TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    last_price_usd REAL NOT NULL CHECK (last_price_usd >= 0),
    change_24h     REAL,
    source         TEXT,
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─────────────────────────────────────────────────────────────────────────
-- Представления для статистики кабинета
-- ─────────────────────────────────────────────────────────────────────────

-- Сводка по пользователю: обороты ввода-вывода и активность
CREATE VIEW IF NOT EXISTS v_user_summary AS
SELECT
    u.id                       AS user_id,
    u.email,
    u.display_name,
    u.status,
    u.kyc_level,
    u.role,
    u.created_at,
    u.last_seen_at,
    (SELECT COUNT(*) FROM transactions t
      WHERE t.user_id = u.id AND t.kind = 'deposit'  AND t.status = 'completed')  AS deposit_count,
    (SELECT COUNT(*) FROM transactions t
      WHERE t.user_id = u.id AND t.kind = 'withdraw' AND t.status = 'completed')  AS withdraw_count,
    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id)                        AS order_count,
    (SELECT COUNT(*) FROM orders o
      WHERE o.user_id = u.id AND o.status IN ('open','partially_filled'))         AS open_orders,
    (SELECT COUNT(*) FROM login_history l
      WHERE l.user_id = u.id AND l.event = 'login')                               AS login_count,
    (SELECT COUNT(*) FROM support_tickets s
      WHERE s.user_id = u.id AND s.status NOT IN ('closed','resolved'))           AS open_tickets,
    (SELECT COUNT(*) FROM notifications n
      WHERE n.user_id = u.id AND n.read_at IS NULL)                               AS unread_notifications,
    (SELECT COUNT(*) FROM known_devices d WHERE d.user_id = u.id)                 AS device_count
FROM users u;

-- Активность оператора поддержки: сколько ответов и как быстро
CREATE VIEW IF NOT EXISTS v_staff_activity AS
SELECT
    sp.user_id,
    u.display_name,
    sp.department,
    sp.position,
    (SELECT COUNT(*) FROM support_messages m
      WHERE m.author_id = sp.user_id AND m.author_kind = 'staff')          AS replies,
    (SELECT COUNT(*) FROM support_tickets t WHERE t.assignee_id = sp.user_id) AS assigned,
    (SELECT COUNT(*) FROM support_tickets t
      WHERE t.assignee_id = sp.user_id AND t.status IN ('resolved','closed')) AS resolved,
    (SELECT COUNT(*) FROM audit_log a
      WHERE a.actor_id = sp.user_id AND a.created_at > unixepoch() - 604800) AS actions_7d
FROM staff_profiles sp
JOIN users u ON u.id = sp.user_id
WHERE sp.disabled_at IS NULL;

-- Очередь поддержки с возрастом обращения
CREATE VIEW IF NOT EXISTS v_support_queue AS
SELECT
    t.*,
    u.email        AS user_email,
    u.display_name AS user_name,
    (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count,
    (unixepoch() - t.updated_at)                                        AS idle_seconds,
    CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                    WHEN 'normal' THEN 2 ELSE 3 END                     AS priority_rank
FROM support_tickets t
JOIN users u ON u.id = t.user_id
WHERE t.status NOT IN ('closed','resolved');
