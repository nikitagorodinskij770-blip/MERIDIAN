-- ============================================================================
-- MERIDIAN — Row Level Security
--
-- Клиент ходит в базу напрямую с anon-ключом, поэтому «кто что видит» решает
-- не приложение, а сама база. Обойти политику через новый эндпоинт, забытую
-- проверку или ошибку в условии невозможно — политика применяется к каждому
-- запросу независимо от того, кто его отправил.
--
-- Общее правило: клиент видит только своё; сотрудник — то, на что ему выдано
-- полномочие; писать в денежные таблицы напрямую не может никто.
-- ============================================================================

-- Включаем RLS везде. Таблица без включённого RLS в Supabase доступна всем
-- на чтение и запись — это самая частая и самая дорогая ошибка.
ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_tx         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balances          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fills             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deposit_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.known_devices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_limits       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.networks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_networks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.markets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_prices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- Справочники: читают все, включая неавторизованных (витрина рынков)
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS ref_read ON public.assets;
CREATE POLICY ref_read ON public.assets FOR SELECT USING (true);

DROP POLICY IF EXISTS ref_read ON public.networks;
CREATE POLICY ref_read ON public.networks FOR SELECT USING (true);

DROP POLICY IF EXISTS ref_read ON public.asset_networks;
CREATE POLICY ref_read ON public.asset_networks FOR SELECT USING (true);

DROP POLICY IF EXISTS ref_read ON public.markets;
CREATE POLICY ref_read ON public.markets FOR SELECT USING (true);

DROP POLICY IF EXISTS ref_read ON public.asset_prices;
CREATE POLICY ref_read ON public.asset_prices FOR SELECT USING (true);

-- Котировки может обновить любой вошедший: данные всё равно публичные,
-- а фронтенд у каждого клиента уже держит поток с бирж
DROP POLICY IF EXISTS price_write ON public.asset_prices;
CREATE POLICY price_write ON public.asset_prices FOR ALL
    TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS settings_read ON public.platform_settings;
CREATE POLICY settings_read ON public.platform_settings FOR SELECT USING (true);

DROP POLICY IF EXISTS settings_write ON public.platform_settings;
CREATE POLICY settings_write ON public.platform_settings FOR ALL
    TO authenticated
    USING (public.has_permission('platform.settings'))
    WITH CHECK (public.has_permission('platform.settings'));

-- ─────────────────────────────────────────────────────────────────────────
-- Профили
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS profile_self_read ON public.profiles;
CREATE POLICY profile_self_read ON public.profiles FOR SELECT
    TO authenticated USING (id = auth.uid() OR public.has_permission('users.view'));

-- Клиент правит только имя и страну. Роль, статус и уровень KYC меняются
-- функциями администрирования — иначе любой поднял бы себе права запросом.
DROP POLICY IF EXISTS profile_self_update ON public.profiles;
CREATE POLICY profile_self_update ON public.profiles FOR UPDATE
    TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS staff_read ON public.staff_profiles;
CREATE POLICY staff_read ON public.staff_profiles FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('staff.manage'));

DROP POLICY IF EXISTS staff_manage ON public.staff_profiles;
CREATE POLICY staff_manage ON public.staff_profiles FOR ALL
    TO authenticated
    USING (public.has_permission('staff.manage'))
    WITH CHECK (public.has_permission('staff.manage'));

-- ─────────────────────────────────────────────────────────────────────────
-- Деньги: только чтение своего. Записи не создаёт никто напрямую —
-- проводки делают функции SECURITY DEFINER.
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS acc_read ON public.ledger_accounts;
CREATE POLICY acc_read ON public.ledger_accounts FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('users.view'));

DROP POLICY IF EXISTS bal_read ON public.balances;
CREATE POLICY bal_read ON public.balances FOR SELECT
    TO authenticated USING (
        EXISTS (SELECT 1 FROM public.ledger_accounts la
                WHERE la.id = account_id
                  AND (la.user_id = auth.uid() OR public.has_permission('users.view'))));

DROP POLICY IF EXISTS entry_read ON public.ledger_entries;
CREATE POLICY entry_read ON public.ledger_entries FOR SELECT
    TO authenticated USING (
        EXISTS (SELECT 1 FROM public.ledger_accounts la
                WHERE la.id = account_id
                  AND (la.user_id = auth.uid() OR public.has_permission('users.view'))));

DROP POLICY IF EXISTS ltx_read ON public.ledger_tx;
CREATE POLICY ltx_read ON public.ledger_tx FOR SELECT
    TO authenticated USING (public.has_permission('users.view'));

-- ─────────────────────────────────────────────────────────────────────────
-- Торговля
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS order_read ON public.orders;
CREATE POLICY order_read ON public.orders FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('users.view'));

DROP POLICY IF EXISTS fill_read ON public.fills;
CREATE POLICY fill_read ON public.fills FOR SELECT
    TO authenticated USING (
        EXISTS (SELECT 1 FROM public.orders o
                WHERE o.id = order_id
                  AND (o.user_id = auth.uid() OR public.has_permission('users.view'))));

DROP POLICY IF EXISTS tx_read ON public.transactions;
CREATE POLICY tx_read ON public.transactions FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('users.view'));

DROP POLICY IF EXISTS addr_read ON public.deposit_addresses;
CREATE POLICY addr_read ON public.deposit_addresses FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('users.view'));

-- ─────────────────────────────────────────────────────────────────────────
-- Кабинет
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS notif_read ON public.notifications;
CREATE POLICY notif_read ON public.notifications FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('users.view'));

-- Клиент может только пометить прочитанным. Создать себе уведомление
-- от имени площадки — нет.
DROP POLICY IF EXISTS notif_mark ON public.notifications;
CREATE POLICY notif_mark ON public.notifications FOR UPDATE
    TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS notif_send ON public.notifications;
CREATE POLICY notif_send ON public.notifications FOR INSERT
    TO authenticated WITH CHECK (public.has_permission('notify.send'));

DROP POLICY IF EXISTS login_read ON public.login_history;
CREATE POLICY login_read ON public.login_history FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('users.view'));

DROP POLICY IF EXISTS login_write ON public.login_history;
CREATE POLICY login_write ON public.login_history FOR INSERT
    TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS dev_read ON public.known_devices;
CREATE POLICY dev_read ON public.known_devices FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('users.view'));

DROP POLICY IF EXISTS dev_write ON public.known_devices;
CREATE POLICY dev_write ON public.known_devices FOR ALL
    TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS limits_read ON public.user_limits;
CREATE POLICY limits_read ON public.user_limits FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('users.view'));

DROP POLICY IF EXISTS limits_write ON public.user_limits;
CREATE POLICY limits_write ON public.user_limits FOR ALL
    TO authenticated
    USING (public.has_permission('users.limits'))
    WITH CHECK (public.has_permission('users.limits'));

-- Внутренние заметки клиенту не видны вообще
DROP POLICY IF EXISTS notes_staff ON public.user_notes;
CREATE POLICY notes_staff ON public.user_notes FOR ALL
    TO authenticated
    USING (public.has_permission('users.view'))
    WITH CHECK (public.has_permission('users.view'));

DROP POLICY IF EXISTS audit_read ON public.audit_log;
CREATE POLICY audit_read ON public.audit_log FOR SELECT
    TO authenticated USING (public.has_permission('reports.view'));

-- ─────────────────────────────────────────────────────────────────────────
-- Поддержка
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS ticket_read ON public.support_tickets;
CREATE POLICY ticket_read ON public.support_tickets FOR SELECT
    TO authenticated USING (user_id = auth.uid() OR public.has_permission('support.reply'));

DROP POLICY IF EXISTS ticket_create ON public.support_tickets;
CREATE POLICY ticket_create ON public.support_tickets FOR INSERT
    TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ticket_manage ON public.support_tickets;
CREATE POLICY ticket_manage ON public.support_tickets FOR UPDATE
    TO authenticated
    USING (public.has_permission('support.manage'))
    WITH CHECK (public.has_permission('support.manage'));

-- Внутренние заметки оператора клиенту не видны: условие is_internal = false
-- для владельца тикета и снятие ограничения для сотрудника
DROP POLICY IF EXISTS msg_read ON public.support_messages;
CREATE POLICY msg_read ON public.support_messages FOR SELECT
    TO authenticated USING (
        public.has_permission('support.reply')
        OR (NOT is_internal AND EXISTS (
              SELECT 1 FROM public.support_tickets t
              WHERE t.id = ticket_id AND t.user_id = auth.uid())));

DROP POLICY IF EXISTS msg_write ON public.support_messages;
CREATE POLICY msg_write ON public.support_messages FOR INSERT
    TO authenticated WITH CHECK (
        (author_kind = 'user' AND author_id = auth.uid() AND NOT is_internal
         AND EXISTS (SELECT 1 FROM public.support_tickets t
                     WHERE t.id = ticket_id AND t.user_id = auth.uid()))
        OR (author_kind = 'staff' AND author_id = auth.uid()
            AND public.has_permission('support.reply')));
