-- ============================================================================
-- MERIDIAN — схема для Supabase (PostgreSQL 17)
--
-- Отличия от SQLite-версии, продиктованные средой:
--
--  1. Аутентификация в auth.users (Supabase Auth). Наша public.profiles
--     связана с ней один-к-одному и создаётся триггером при регистрации.
--
--  2. Row Level Security на каждой таблице. Клиент ходит в базу напрямую
--     с anon-ключом, поэтому «кто что видит» решает не приложение, а сама
--     база: обойти политику через новый эндпоинт или забытую проверку нельзя.
--
--  3. Денежные операции — функции SECURITY DEFINER. Прямая запись в журнал
--     клиенту запрещена политикой; провести проводку можно только вызовом
--     функции, которая сама проверяет баланс, лимиты и сходимость.
--
--  4. Деньги по-прежнему целые числа в минимальных единицах актива.
--     BIGINT вмещает 9.2·10^18 — достаточно для любых разумных сумм
--     даже при scale = 18.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- Справочники
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.assets (
    id           text PRIMARY KEY,
    name         text NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('crypto','stable','fiat','metal')),
    scale        smallint NOT NULL CHECK (scale BETWEEN 0 AND 18),
    display_dec  smallint NOT NULL DEFAULT 8,
    is_listed    boolean NOT NULL DEFAULT true,
    can_deposit  boolean NOT NULL DEFAULT true,
    can_withdraw boolean NOT NULL DEFAULT true,
    sort_order   int NOT NULL DEFAULT 100,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.networks (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    addr_format   text NOT NULL CHECK (addr_format IN ('evm','base58','bech32','base58check','other')),
    confirmations int  NOT NULL DEFAULT 12,
    is_enabled    boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.asset_networks (
    asset_id     text NOT NULL REFERENCES public.assets(id)   ON DELETE CASCADE,
    network_id   text NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
    withdraw_fee bigint NOT NULL DEFAULT 0 CHECK (withdraw_fee >= 0),
    min_withdraw bigint NOT NULL DEFAULT 0 CHECK (min_withdraw >= 0),
    min_deposit  bigint NOT NULL DEFAULT 0 CHECK (min_deposit  >= 0),
    PRIMARY KEY (asset_id, network_id)
);

CREATE TABLE IF NOT EXISTS public.markets (
    symbol       text PRIMARY KEY,
    base_id      text NOT NULL REFERENCES public.assets(id),
    quote_id     text NOT NULL REFERENCES public.assets(id),
    tick_size    bigint NOT NULL DEFAULT 1,
    lot_size     bigint NOT NULL DEFAULT 1,
    min_notional bigint NOT NULL DEFAULT 0,
    is_active    boolean NOT NULL DEFAULT true,
    CHECK (base_id <> quote_id)
);

CREATE TABLE IF NOT EXISTS public.asset_prices (
    asset_id       text PRIMARY KEY REFERENCES public.assets(id) ON DELETE CASCADE,
    last_price_usd numeric NOT NULL CHECK (last_price_usd >= 0),
    change_24h     numeric,
    source         text,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Профили: наша часть учётной записи поверх auth.users
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
    id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email         text NOT NULL,
    display_name  text NOT NULL DEFAULT '',
    country       text,
    status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','pending','blocked','closed')),
    kyc_level     smallint NOT NULL DEFAULT 0 CHECK (kyc_level BETWEEN 0 AND 3),
    role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user','support','admin')),
    anti_phishing text,
    block_reason  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz,
    -- Блокировка без основания недопустима: причина должна быть в данных,
    -- а не только в намерениях оператора
    CONSTRAINT block_needs_reason
        CHECK (status <> 'blocked' OR (block_reason IS NOT NULL AND length(block_reason) > 0))
);

CREATE INDEX IF NOT EXISTS idx_profiles_status  ON public.profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_role    ON public.profiles(role) WHERE role <> 'user';
CREATE INDEX IF NOT EXISTS idx_profiles_created ON public.profiles(created_at DESC);

-- Профиль создаётся автоматически при регистрации в auth.users.
-- Триггер, а не вызов из приложения: клиент мог бы «забыть» его сделать,
-- и учётная запись осталась бы без профиля.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name, country, anti_phishing)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
        NEW.raw_user_meta_data->>'country',
        'MERIDIAN-' || upper(substr(md5(NEW.id::text), 1, 6))
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.notifications (user_id, kind, title, body, level, link)
    VALUES (
        NEW.id, 'account', 'Добро пожаловать в MERIDIAN',
        'Счёт открыт. Пройдите верификацию, чтобы снять лимиты на вывод, '
        || 'и включите двухфакторную защиту в разделе безопасности.',
        'success', '#/cabinet/security'
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────
-- Персонал и полномочия
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_profiles (
    user_id     uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    position    text NOT NULL DEFAULT '',
    department  text NOT NULL DEFAULT 'support'
                CHECK (department IN ('support','compliance','finance','engineering','management')),
    permissions text[] NOT NULL DEFAULT '{}',
    created_by  uuid REFERENCES public.profiles(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz
);

-- Проверка прав вынесена в функцию: она вызывается из десятка политик RLS,
-- и дублировать логику в каждой означало бы гарантированное расхождение.
CREATE OR REPLACE FUNCTION public.has_permission(perm text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles p
        LEFT JOIN public.staff_profiles s ON s.user_id = p.id
        WHERE p.id = auth.uid()
          AND p.status = 'active'
          AND (
            -- Корневой администратор: роль admin без профиля сотрудника.
            -- Заводится при развёртывании, когда выдавать права ещё некому.
            (p.role = 'admin' AND s.user_id IS NULL)
            OR (s.disabled_at IS NULL AND perm = ANY(s.permissions))
          )
    );
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role IN ('admin','support') AND status = 'active'
    );
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Двойная запись
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ledger_accounts (
    id       bigserial PRIMARY KEY,
    user_id  uuid REFERENCES public.profiles(id) ON DELETE CASCADE,  -- NULL = системный
    asset_id text NOT NULL REFERENCES public.assets(id),
    kind     text NOT NULL CHECK (kind IN ('user','locked','fee','hot_wallet','external','treasury'))
);

-- Частичные уникальные индексы: NULL в user_id не участвует в обычном UNIQUE,
-- поэтому системные счета пришлось бы разделять вручную
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_user
    ON public.ledger_accounts(user_id, asset_id, kind) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_system
    ON public.ledger_accounts(asset_id, kind) WHERE user_id IS NULL;

CREATE TABLE IF NOT EXISTS public.ledger_tx (
    id         bigserial PRIMARY KEY,
    kind       text NOT NULL CHECK (kind IN
               ('deposit','withdraw','trade','convert','fee','reward','adjustment','transfer')),
    ref_id     text,
    memo       text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ledger_entries (
    id         bigserial PRIMARY KEY,
    tx_id      bigint NOT NULL REFERENCES public.ledger_tx(id) ON DELETE CASCADE,
    account_id bigint NOT NULL REFERENCES public.ledger_accounts(id),
    asset_id   text   NOT NULL REFERENCES public.assets(id),
    amount     bigint NOT NULL CHECK (amount <> 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entries_tx  ON public.ledger_entries(tx_id);
CREATE INDEX IF NOT EXISTS idx_entries_acc ON public.ledger_entries(account_id, id DESC);

CREATE TABLE IF NOT EXISTS public.balances (
    account_id bigint PRIMARY KEY REFERENCES public.ledger_accounts(id) ON DELETE CASCADE,
    amount     bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Материализация остатка + запрет отрицательного баланса одним триггером.
-- Проверка на уровне базы, а не приложения: прикладной код можно обойти
-- новым эндпоинтом или ошибкой в условии, триггер срабатывает всегда.
CREATE OR REPLACE FUNCTION public.apply_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    new_amount bigint;
    acc_kind   text;
BEGIN
    INSERT INTO public.balances(account_id, amount, updated_at)
    VALUES (NEW.account_id, NEW.amount, now())
    ON CONFLICT (account_id) DO UPDATE
        SET amount = public.balances.amount + NEW.amount, updated_at = now()
    RETURNING amount INTO new_amount;

    SELECT kind INTO acc_kind FROM public.ledger_accounts WHERE id = NEW.account_id;

    -- Клиентские счета в минус не уходят. Системные (external, hot_wallet,
    -- treasury) могут: для них отрицательный остаток означает обязательство.
    IF new_amount < 0 AND acc_kind IN ('user','locked') THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE'
            USING ERRCODE = 'check_violation',
                  DETAIL  = format('счёт %s: остаток %s', NEW.account_id, new_amount);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_entry ON public.ledger_entries;
CREATE TRIGGER trg_apply_entry
    AFTER INSERT ON public.ledger_entries
    FOR EACH ROW EXECUTE FUNCTION public.apply_ledger_entry();

-- ─────────────────────────────────────────────────────────────────────────
-- Торговля
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.orders (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    market     text NOT NULL REFERENCES public.markets(symbol),
    side       text NOT NULL CHECK (side IN ('buy','sell')),
    type       text NOT NULL CHECK (type IN ('market','limit')),
    price      bigint CHECK (price IS NULL OR price > 0),
    quantity   bigint NOT NULL CHECK (quantity > 0),
    filled     bigint NOT NULL DEFAULT 0 CHECK (filled >= 0),
    status     text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','partially_filled','filled','canceled','rejected')),
    client_ref text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (filled <= quantity),
    CHECK (type <> 'limit' OR price IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_client_ref
    ON public.orders(user_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_book
    ON public.orders(market, side, price, created_at)
    WHERE status IN ('open','partially_filled');
CREATE INDEX IF NOT EXISTS idx_orders_user ON public.orders(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.fills (
    id         bigserial PRIMARY KEY,
    order_id   bigint NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    market     text   NOT NULL REFERENCES public.markets(symbol),
    price      bigint NOT NULL CHECK (price > 0),
    quantity   bigint NOT NULL CHECK (quantity > 0),
    fee        bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
    fee_asset  text REFERENCES public.assets(id),
    role       text NOT NULL CHECK (role IN ('maker','taker')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fills_order  ON public.fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_market ON public.fills(market, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Ввод и вывод
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deposit_addresses (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    asset_id   text NOT NULL REFERENCES public.assets(id),
    network_id text NOT NULL REFERENCES public.networks(id),
    address    text NOT NULL,
    memo       text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, asset_id, network_id),
    UNIQUE (network_id, address)
);

CREATE TABLE IF NOT EXISTS public.transactions (
    id            bigserial PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('deposit','withdraw')),
    asset_id      text NOT NULL REFERENCES public.assets(id),
    network_id    text REFERENCES public.networks(id),
    amount        bigint NOT NULL CHECK (amount > 0),
    fee           bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
    address       text,
    tx_hash       text,
    confirmations int  NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','failed','canceled')),
    ledger_tx_id  bigint REFERENCES public.ledger_tx(id),
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tx_user ON public.transactions(user_id, created_at DESC);
-- Один блокчейн-перевод не должен зачислиться дважды
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_hash
    ON public.transactions(network_id, tx_hash) WHERE tx_hash IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Кабинет: устройства, входы, уведомления
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.login_history (
    id            bigserial PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    event         text NOT NULL CHECK (event IN
                  ('login','logout','failed','locked','password_change','2fa_change')),
    ip            text,
    country       text,
    city          text,
    device_kind   text,
    os            text,
    browser       text,
    user_agent    text,
    is_new_device boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_user ON public.login_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.known_devices (
    id            bigserial PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    fingerprint   text NOT NULL,
    label         text NOT NULL DEFAULT '',
    device_kind   text, os text, browser text,
    last_ip       text, last_city text,
    trusted       boolean NOT NULL DEFAULT false,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS public.notifications (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN
               ('security','transaction','order','system','support','promo','account')),
    title      text NOT NULL,
    body       text NOT NULL DEFAULT '',
    link       text,
    level      text NOT NULL DEFAULT 'info'
               CHECK (level IN ('info','success','warning','critical')),
    read_at    timestamptz,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON public.notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread
    ON public.notifications(user_id) WHERE read_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Поддержка
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.support_tickets (
    id             bigserial PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    subject        text NOT NULL,
    category       text NOT NULL DEFAULT 'general'
                   CHECK (category IN ('general','deposit','withdraw','trading','kyc','security','api','billing')),
    status         text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','pending','answered','resolved','closed')),
    priority       text NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('low','normal','high','urgent')),
    assignee_id    uuid REFERENCES public.profiles(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    closed_at      timestamptz,
    first_reply_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_tickets_user   ON public.support_tickets(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON public.support_tickets(status, priority, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.support_messages (
    id          bigserial PRIMARY KEY,
    ticket_id   bigint NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
    author_id   uuid REFERENCES public.profiles(id),
    author_kind text NOT NULL CHECK (author_kind IN ('user','staff','system')),
    body        text NOT NULL,
    is_internal boolean NOT NULL DEFAULT false,
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msgs_ticket ON public.support_messages(ticket_id, created_at);

-- Статус тикета ведёт себя сам: ответ оператора помечает «отвечено»,
-- сообщение клиента возвращает в «ждёт ответа»
CREATE OR REPLACE FUNCTION public.touch_ticket()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.support_tickets
       SET updated_at = now(),
           status = CASE
               WHEN NEW.author_kind = 'staff' AND NOT NEW.is_internal THEN 'answered'
               WHEN NEW.author_kind = 'user' THEN 'pending'
               ELSE status END,
           first_reply_at = CASE
               WHEN first_reply_at IS NULL AND NEW.author_kind = 'staff' AND NOT NEW.is_internal
               THEN now() ELSE first_reply_at END
     WHERE id = NEW.ticket_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_touch ON public.support_messages;
CREATE TRIGGER trg_ticket_touch
    AFTER INSERT ON public.support_messages
    FOR EACH ROW EXECUTE FUNCTION public.touch_ticket();

-- ─────────────────────────────────────────────────────────────────────────
-- Операционное
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_limits (
    user_id            uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    withdraw_daily_usd bigint,
    trade_daily_usd    bigint,
    max_order_usd      bigint,
    trading_frozen     boolean NOT NULL DEFAULT false,
    withdraw_frozen    boolean NOT NULL DEFAULT false,
    note               text,
    updated_by         uuid REFERENCES public.profiles(id),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_notes (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    author_id  uuid REFERENCES public.profiles(id),
    body       text NOT NULL,
    pinned     boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_log (
    id         bigserial PRIMARY KEY,
    actor_id   uuid REFERENCES public.profiles(id),
    actor_kind text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','admin','system')),
    action     text NOT NULL,
    target     text,
    payload    jsonb,
    ip         text,
    level      text NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON public.audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS public.platform_settings (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Представления
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_user_balances AS
SELECT
    la.user_id,
    la.asset_id,
    a.scale,
    COALESCE(SUM(CASE WHEN la.kind = 'user'   THEN b.amount ELSE 0 END), 0) AS available,
    COALESCE(SUM(CASE WHEN la.kind = 'locked' THEN b.amount ELSE 0 END), 0) AS locked,
    COALESCE(SUM(b.amount), 0)                                              AS total
FROM public.ledger_accounts la
JOIN public.assets a ON a.id = la.asset_id
LEFT JOIN public.balances b ON b.account_id = la.id
WHERE la.user_id IS NOT NULL AND la.kind IN ('user','locked')
GROUP BY la.user_id, la.asset_id, a.scale;

-- Должно быть пустым. Непустой результат означает повреждение журнала
-- и требует остановки операций.
CREATE OR REPLACE VIEW public.v_ledger_imbalance AS
SELECT tx_id, asset_id, SUM(amount) AS delta
FROM public.ledger_entries
GROUP BY tx_id, asset_id
HAVING SUM(amount) <> 0;

CREATE OR REPLACE VIEW public.v_user_summary AS
SELECT
    p.id AS user_id, p.email, p.display_name, p.status, p.kyc_level, p.role,
    p.country, p.created_at, p.last_seen_at,
    (SELECT count(*) FROM public.transactions t
      WHERE t.user_id = p.id AND t.kind='deposit'  AND t.status='completed') AS deposit_count,
    (SELECT count(*) FROM public.transactions t
      WHERE t.user_id = p.id AND t.kind='withdraw' AND t.status='completed') AS withdraw_count,
    (SELECT count(*) FROM public.orders o WHERE o.user_id = p.id)            AS order_count,
    (SELECT count(*) FROM public.orders o
      WHERE o.user_id = p.id AND o.status IN ('open','partially_filled'))    AS open_orders,
    (SELECT count(*) FROM public.login_history l
      WHERE l.user_id = p.id AND l.event='login')                            AS login_count,
    (SELECT count(*) FROM public.support_tickets s
      WHERE s.user_id = p.id AND s.status NOT IN ('closed','resolved'))      AS open_tickets,
    (SELECT count(*) FROM public.notifications n
      WHERE n.user_id = p.id AND n.read_at IS NULL)                          AS unread_notifications,
    (SELECT count(*) FROM public.known_devices d WHERE d.user_id = p.id)     AS device_count
FROM public.profiles p;

CREATE OR REPLACE VIEW public.v_support_queue AS
SELECT t.*, p.email AS user_email, p.display_name AS user_name,
       (SELECT count(*) FROM public.support_messages m WHERE m.ticket_id = t.id) AS message_count,
       EXTRACT(EPOCH FROM (now() - t.updated_at))::bigint AS idle_seconds,
       CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                       WHEN 'normal' THEN 2 ELSE 3 END AS priority_rank
FROM public.support_tickets t
JOIN public.profiles p ON p.id = t.user_id
WHERE t.status NOT IN ('closed','resolved');

-- ─────────────────────────────────────────────────────────────────────────
-- ВАЖНО: представления обязаны исполняться с правами вызывающего.
--
-- По умолчанию view в Postgres работает от имени владельца и потому обходит
-- RLS базовых таблиц. Проверка на живом сервере показала: без этой строки
-- любой вошедший видел балансы всех клиентов через v_user_balances.
-- security_invoker = on возвращает применение политик к тому, кто спрашивает.
-- ─────────────────────────────────────────────────────────────────────────

ALTER VIEW public.v_user_balances    SET (security_invoker = on);
ALTER VIEW public.v_user_summary     SET (security_invoker = on);
ALTER VIEW public.v_support_queue    SET (security_invoker = on);
ALTER VIEW public.v_ledger_imbalance SET (security_invoker = on);
