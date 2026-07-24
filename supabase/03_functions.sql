-- ============================================================================
-- MERIDIAN — денежные и административные функции
--
-- Прямая запись в журнал клиенту запрещена политикой RLS. Единственный способ
-- изменить баланс — вызвать одну из этих функций. Каждая объявлена
-- SECURITY DEFINER: исполняется с правами владельца и потому может писать
-- в защищённые таблицы, но сама проверяет полномочия вызывающего.
--
-- Смысл контура: даже если фронтенд скомпрометирован целиком, злоумышленник
-- не проведёт проводку, нарушающую инварианты — их проверяет база.
-- ============================================================================

-- Счёт создаётся при первом обращении. Отдельная функция: фрагмент нужен
-- всем денежным операциям.
CREATE OR REPLACE FUNCTION public.get_account(
    p_user uuid, p_asset text, p_kind text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id bigint;
BEGIN
    IF p_user IS NULL THEN
        SELECT id INTO v_id FROM ledger_accounts
         WHERE user_id IS NULL AND asset_id = p_asset AND kind = p_kind;
    ELSE
        SELECT id INTO v_id FROM ledger_accounts
         WHERE user_id = p_user AND asset_id = p_asset AND kind = p_kind;
    END IF;

    IF v_id IS NULL THEN
        INSERT INTO ledger_accounts(user_id, asset_id, kind)
        VALUES (p_user, p_asset, p_kind) RETURNING id INTO v_id;
        INSERT INTO balances(account_id, amount) VALUES (v_id, 0) ON CONFLICT DO NOTHING;
    END IF;
    RETURN v_id;
END;
$fn$;

-- Проверка перед любой операцией: счёт активен и не заморожен
CREATE OR REPLACE FUNCTION public.assert_can_operate(p_kind text DEFAULT 'trade')
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_status text; v_frozen boolean;
BEGIN
    SELECT status INTO v_status FROM profiles WHERE id = auth.uid();
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_status <> 'active' THEN
        RAISE EXCEPTION 'ACCOUNT_NOT_ACTIVE' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_kind = 'trade' THEN
        SELECT trading_frozen INTO v_frozen FROM user_limits WHERE user_id = auth.uid();
    ELSIF p_kind = 'withdraw' THEN
        SELECT withdraw_frozen INTO v_frozen FROM user_limits WHERE user_id = auth.uid();
    END IF;
    IF COALESCE(v_frozen, false) THEN
        RAISE EXCEPTION 'OPERATION_FROZEN' USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Пополнение
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.deposit_funds(
    p_asset text, p_network text, p_amount bigint, p_tx_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid();
    v_tx bigint; v_txid bigint;
BEGIN
    PERFORM assert_can_operate('deposit');
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'BAD_AMOUNT' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM asset_networks
                   WHERE asset_id = p_asset AND network_id = p_network) THEN
        RAISE EXCEPTION 'NETWORK_NOT_SUPPORTED' USING ERRCODE = 'check_violation';
    END IF;
    -- Идемпотентность: тот же блокчейн-перевод не зачислится дважды
    IF p_tx_hash IS NOT NULL AND EXISTS (
        SELECT 1 FROM transactions WHERE network_id = p_network AND tx_hash = p_tx_hash) THEN
        RAISE EXCEPTION 'DUPLICATE_TX' USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO ledger_tx(kind, memo)
    VALUES ('deposit', format('пополнение %s через %s', p_asset, p_network))
    RETURNING id INTO v_tx;

    -- Двойная запись: средства приходят извне и попадают на счёт клиента
    INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
        (v_tx, get_account(NULL,   p_asset, 'external'), p_asset, -p_amount),
        (v_tx, get_account(v_user, p_asset, 'user'),     p_asset,  p_amount);

    INSERT INTO transactions(user_id, kind, asset_id, network_id, amount,
                             status, tx_hash, ledger_tx_id, confirmations)
    VALUES (v_user, 'deposit', p_asset, p_network, p_amount,
            'completed', p_tx_hash, v_tx, 1)
    RETURNING id INTO v_txid;

    INSERT INTO notifications(user_id, kind, title, body, level, link)
    VALUES (v_user, 'transaction', 'Средства зачислены',
            format('Пополнение %s принято сетью %s.', p_asset, p_network),
            'success', '#/wallet');

    RETURN jsonb_build_object('id', v_txid, 'ledgerTx', v_tx, 'status', 'completed');
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Вывод
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.withdraw_funds(
    p_asset text, p_network text, p_address text, p_amount bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid();
    v_fee bigint; v_min bigint; v_kyc smallint;
    v_tx bigint; v_txid bigint;
BEGIN
    PERFORM assert_can_operate('withdraw');
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'BAD_AMOUNT' USING ERRCODE = 'check_violation';
    END IF;
    IF p_address IS NULL OR length(trim(p_address)) < 8 THEN
        RAISE EXCEPTION 'BAD_ADDRESS' USING ERRCODE = 'check_violation';
    END IF;

    SELECT withdraw_fee, min_withdraw INTO v_fee, v_min
      FROM asset_networks WHERE asset_id = p_asset AND network_id = p_network;
    IF v_fee IS NULL THEN
        RAISE EXCEPTION 'NETWORK_NOT_SUPPORTED' USING ERRCODE = 'check_violation';
    END IF;
    IF p_amount < v_min THEN
        RAISE EXCEPTION 'BELOW_MIN' USING ERRCODE = 'check_violation';
    END IF;

    SELECT kyc_level INTO v_kyc FROM profiles WHERE id = v_user;
    IF v_kyc < 1 AND COALESCE(
        (SELECT value FROM platform_settings WHERE key = 'require_kyc_for_withdraw'), '1') = '1' THEN
        RAISE EXCEPTION 'KYC_REQUIRED' USING ERRCODE = 'insufficient_privilege';
    END IF;

    INSERT INTO ledger_tx(kind, memo)
    VALUES ('withdraw', format('вывод %s в %s', p_asset, p_network))
    RETURNING id INTO v_tx;

    -- Списываем сумму и комиссию; недостаток средств остановит триггер
    INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
        (v_tx, get_account(v_user, p_asset, 'user'),     p_asset, -(p_amount + v_fee)),
        (v_tx, get_account(NULL,   p_asset, 'external'), p_asset,  p_amount);
    IF v_fee > 0 THEN
        INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount)
        VALUES (v_tx, get_account(NULL, p_asset, 'fee'), p_asset, v_fee);
    END IF;

    INSERT INTO transactions(user_id, kind, asset_id, network_id, amount, fee,
                             address, status, ledger_tx_id)
    VALUES (v_user, 'withdraw', p_asset, p_network, p_amount, v_fee,
            p_address, 'pending', v_tx)
    RETURNING id INTO v_txid;

    INSERT INTO audit_log(actor_id, actor_kind, action, target, payload, level)
    VALUES (v_user, 'user', 'wallet.withdraw', v_txid::text,
            jsonb_build_object('asset', p_asset, 'amount', p_amount,
                               'network', p_network, 'address', left(p_address, 12) || '…'),
            'warn');

    RETURN jsonb_build_object('id', v_txid, 'ledgerTx', v_tx,
                              'status', 'pending', 'fee', v_fee);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Размещение заявки
--
-- Матчинг «цена — время»: среди заявок с одинаковой ценой первой исполняется
-- поданная раньше. Цена сделки — цена мейкера, то есть уже стоявшей в книге;
-- это не даёт агрессору получить цену лучше выставленной.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.place_order(
    p_market text, p_side text, p_type text,
    p_quantity bigint, p_price bigint DEFAULT NULL, p_client_ref text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid();
    v_base text; v_quote text; v_qscale bigint;
    v_order bigint; v_existing bigint;
    v_lock_asset text; v_lock_amount bigint; v_ref_price bigint;
    v_remaining bigint; v_filled bigint := 0; v_spent bigint := 0;
    v_maker record; v_take bigint; v_notional bigint;
    v_maker_fee bigint; v_taker_fee bigint;
    v_maker_bps int; v_taker_bps int;
    v_tx bigint; v_back bigint;
BEGIN
    PERFORM assert_can_operate('trade');

    IF COALESCE((SELECT value FROM platform_settings WHERE key='trading_enabled'),'1') <> '1' THEN
        RAISE EXCEPTION 'TRADING_DISABLED' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_side NOT IN ('buy','sell') OR p_type NOT IN ('market','limit') THEN
        RAISE EXCEPTION 'BAD_PARAMS' USING ERRCODE = 'check_violation';
    END IF;
    IF p_quantity <= 0 THEN
        RAISE EXCEPTION 'BAD_QUANTITY' USING ERRCODE = 'check_violation';
    END IF;
    IF p_type = 'limit' AND (p_price IS NULL OR p_price <= 0) THEN
        RAISE EXCEPTION 'BAD_PRICE' USING ERRCODE = 'check_violation';
    END IF;

    SELECT base_id, quote_id INTO v_base, v_quote
      FROM markets WHERE symbol = p_market AND is_active;
    IF v_base IS NULL THEN
        RAISE EXCEPTION 'MARKET_NOT_FOUND' USING ERRCODE = 'check_violation';
    END IF;

    -- Идемпотентность: повтор с тем же clientOrderId вернёт прежнюю заявку
    IF p_client_ref IS NOT NULL THEN
        SELECT id INTO v_existing FROM orders
         WHERE user_id = v_user AND client_ref = p_client_ref;
        IF v_existing IS NOT NULL THEN
            RETURN jsonb_build_object('id', v_existing, 'duplicate', true);
        END IF;
    END IF;

    SELECT power(10, scale)::bigint INTO v_qscale FROM assets WHERE id = v_base;
    SELECT COALESCE((SELECT value::int FROM platform_settings WHERE key='maker_fee_bps'),10),
           COALESCE((SELECT value::int FROM platform_settings WHERE key='taker_fee_bps'),15)
      INTO v_maker_bps, v_taker_bps;

    -- Резерв. Для рыночной покупки берём худшую цену в книге: иначе неизвестно,
    -- сколько потребуется. Излишек вернём после исполнения.
    IF p_side = 'buy' THEN
        v_ref_price := COALESCE(p_price, (SELECT max(price) FROM orders
            WHERE market = p_market AND side = 'sell'
              AND status IN ('open','partially_filled')));
        IF v_ref_price IS NULL THEN
            RAISE EXCEPTION 'NO_LIQUIDITY' USING ERRCODE = 'check_violation';
        END IF;
        v_lock_asset  := v_quote;
        v_lock_amount := (p_quantity * v_ref_price) / v_qscale;
    ELSE
        v_lock_asset  := v_base;
        v_lock_amount := p_quantity;
    END IF;

    IF v_lock_amount <= 0 THEN
        RAISE EXCEPTION 'BAD_NOTIONAL' USING ERRCODE = 'check_violation';
    END IF;

    -- Блокировка средств: перевод со свободного счёта на заблокированный
    INSERT INTO ledger_tx(kind, memo)
    VALUES ('transfer', format('резерв под заявку %s', p_market)) RETURNING id INTO v_tx;
    INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
        (v_tx, get_account(v_user, v_lock_asset, 'user'),   v_lock_asset, -v_lock_amount),
        (v_tx, get_account(v_user, v_lock_asset, 'locked'), v_lock_asset,  v_lock_amount);

    INSERT INTO orders(user_id, market, side, type, price, quantity, client_ref)
    VALUES (v_user, p_market, p_side, p_type, p_price, p_quantity, p_client_ref)
    RETURNING id INTO v_order;

    v_remaining := p_quantity;

    -- Обход книги в порядке «цена, затем время»
    FOR v_maker IN
        SELECT * FROM orders
         WHERE market = p_market
           AND side = CASE WHEN p_side = 'buy' THEN 'sell' ELSE 'buy' END
           AND status IN ('open','partially_filled')
           AND user_id <> v_user                       -- самосделки запрещены
           AND (p_price IS NULL
                OR (p_side = 'buy'  AND price <= p_price)
                OR (p_side = 'sell' AND price >= p_price))
         ORDER BY CASE WHEN p_side = 'buy'  THEN price END ASC,
                  CASE WHEN p_side = 'sell' THEN price END DESC,
                  created_at ASC
         FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := least(v_remaining, v_maker.quantity - v_maker.filled);
        CONTINUE WHEN v_take <= 0;

        v_notional := (v_take * v_maker.price) / v_qscale;   -- цена мейкера
        CONTINUE WHEN v_notional <= 0;

        v_taker_fee := v_notional * v_taker_bps / 10000;
        v_maker_fee := v_notional * v_maker_bps / 10000;

        INSERT INTO ledger_tx(kind, ref_id, memo)
        VALUES ('trade', p_market, format('сделка %s', p_market)) RETURNING id INTO v_tx;

        IF p_side = 'buy' THEN
            INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
              (v_tx, get_account(v_maker.user_id, v_base,  'locked'), v_base,  -v_take),
              (v_tx, get_account(v_user,          v_base,  'user'),   v_base,   v_take - (v_take * v_taker_bps / 10000)),
              (v_tx, get_account(NULL,            v_base,  'fee'),    v_base,   v_take * v_taker_bps / 10000),
              (v_tx, get_account(v_user,          v_quote, 'locked'), v_quote, -v_notional),
              (v_tx, get_account(v_maker.user_id, v_quote, 'user'),   v_quote,  v_notional - v_maker_fee),
              (v_tx, get_account(NULL,            v_quote, 'fee'),    v_quote,  v_maker_fee);
        ELSE
            INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
              (v_tx, get_account(v_user,          v_base,  'locked'), v_base,  -v_take),
              (v_tx, get_account(v_maker.user_id, v_base,  'user'),   v_base,   v_take - (v_take * v_maker_bps / 10000)),
              (v_tx, get_account(NULL,            v_base,  'fee'),    v_base,   v_take * v_maker_bps / 10000),
              (v_tx, get_account(v_maker.user_id, v_quote, 'locked'), v_quote, -v_notional),
              (v_tx, get_account(v_user,          v_quote, 'user'),   v_quote,  v_notional - v_taker_fee),
              (v_tx, get_account(NULL,            v_quote, 'fee'),    v_quote,  v_taker_fee);
        END IF;

        UPDATE orders SET filled = filled + v_take,
               status = CASE WHEN filled + v_take >= quantity THEN 'filled'
                             ELSE 'partially_filled' END,
               updated_at = now()
         WHERE id = v_maker.id;

        INSERT INTO fills(order_id, market, price, quantity, fee, fee_asset, role) VALUES
            (v_maker.id, p_market, v_maker.price, v_take, v_maker_fee, v_quote, 'maker'),
            (v_order,    p_market, v_maker.price, v_take, v_taker_fee, v_quote, 'taker');

        v_remaining := v_remaining - v_take;
        v_filled    := v_filled + v_take;
        v_spent     := v_spent + v_notional;
    END LOOP;

    UPDATE orders SET filled = v_filled, updated_at = now(),
           status = CASE
               WHEN v_filled >= p_quantity THEN 'filled'
               WHEN p_type = 'market'      THEN 'canceled'   -- остаток рыночной снимаем
               WHEN v_filled > 0           THEN 'partially_filled'
               ELSE 'open' END
     WHERE id = v_order;

    -- Возврат неизрасходованного резерва
    IF p_type = 'market' OR v_remaining = 0 THEN
        v_back := CASE WHEN p_side = 'buy' THEN v_lock_amount - v_spent ELSE v_remaining END;
    ELSIF p_side = 'buy' AND p_price IS NOT NULL THEN
        v_back := v_lock_amount - v_spent - (v_remaining * p_price) / v_qscale;
    ELSE
        v_back := 0;
    END IF;

    IF v_back > 0 THEN
        INSERT INTO ledger_tx(kind, memo)
        VALUES ('transfer', format('возврат резерва по заявке %s', v_order))
        RETURNING id INTO v_tx;
        INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
            (v_tx, get_account(v_user, v_lock_asset, 'locked'), v_lock_asset, -v_back),
            (v_tx, get_account(v_user, v_lock_asset, 'user'),   v_lock_asset,  v_back);
    END IF;

    RETURN jsonb_build_object('id', v_order, 'filled', v_filled,
        'status', (SELECT status FROM orders WHERE id = v_order));
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Отмена заявки
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_order(p_order bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid();
    v_o record; v_base text; v_quote text; v_qscale bigint;
    v_back bigint; v_asset text; v_tx bigint;
BEGIN
    SELECT * INTO v_o FROM orders WHERE id = p_order AND user_id = v_user FOR UPDATE;
    IF v_o IS NULL THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_o.status NOT IN ('open','partially_filled') THEN
        RAISE EXCEPTION 'ORDER_NOT_OPEN' USING ERRCODE = 'check_violation';
    END IF;

    SELECT base_id, quote_id INTO v_base, v_quote FROM markets WHERE symbol = v_o.market;
    SELECT power(10, scale)::bigint INTO v_qscale FROM assets WHERE id = v_base;

    IF v_o.side = 'buy' THEN
        v_asset := v_quote;
        v_back  := ((v_o.quantity - v_o.filled) * v_o.price) / v_qscale;
    ELSE
        v_asset := v_base;
        v_back  := v_o.quantity - v_o.filled;
    END IF;

    IF v_back > 0 THEN
        INSERT INTO ledger_tx(kind, memo)
        VALUES ('transfer', format('отмена заявки %s', p_order)) RETURNING id INTO v_tx;
        INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
            (v_tx, get_account(v_user, v_asset, 'locked'), v_asset, -v_back),
            (v_tx, get_account(v_user, v_asset, 'user'),   v_asset,  v_back);
    END IF;

    UPDATE orders SET status = 'canceled', updated_at = now() WHERE id = p_order;
    RETURN jsonb_build_object('id', p_order, 'status', 'canceled', 'refunded', v_back);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Административные функции
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_block_user(p_user uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
    IF NOT has_permission('users.block') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE profiles SET status='blocked', block_reason=p_reason, updated_at=now()
     WHERE id = p_user;
    INSERT INTO audit_log(actor_id, actor_kind, action, target, payload, level)
    VALUES (auth.uid(), 'admin', 'admin.user.block', p_user::text,
            jsonb_build_object('reason', p_reason), 'warn');
    RETURN jsonb_build_object('ok', true, 'status', 'blocked');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_unblock_user(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
    IF NOT has_permission('users.block') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE profiles SET status='active', block_reason=NULL, updated_at=now() WHERE id = p_user;
    INSERT INTO audit_log(actor_id, actor_kind, action, target, level)
    VALUES (auth.uid(), 'admin', 'admin.user.unblock', p_user::text, 'warn');
    RETURN jsonb_build_object('ok', true, 'status', 'active');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_set_kyc(p_user uuid, p_level smallint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
    IF NOT has_permission('users.kyc') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_level < 0 OR p_level > 3 THEN
        RAISE EXCEPTION 'BAD_LEVEL' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE profiles SET kyc_level = p_level, updated_at = now() WHERE id = p_user;
    INSERT INTO notifications(user_id, kind, title, body, level)
    VALUES (p_user, 'account', 'Уровень верификации изменён',
            format('Установлен уровень %s.', p_level), 'success');
    INSERT INTO audit_log(actor_id, actor_kind, action, target, payload, level)
    VALUES (auth.uid(), 'admin', 'admin.user.kyc', p_user::text,
            jsonb_build_object('level', p_level), 'warn');
    RETURN jsonb_build_object('ok', true, 'level', p_level);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_adjust_balance(
    p_user uuid, p_asset text, p_amount bigint, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_tx bigint;
BEGIN
    IF NOT has_permission('users.balance') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    IF p_amount = 0 THEN
        RAISE EXCEPTION 'ZERO_AMOUNT' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO ledger_tx(kind, memo)
    VALUES ('adjustment', format('корректировка: %s', p_reason)) RETURNING id INTO v_tx;
    INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
        (v_tx, get_account(NULL,   p_asset, 'treasury'), p_asset, -p_amount),
        (v_tx, get_account(p_user, p_asset, 'user'),     p_asset,  p_amount);

    INSERT INTO notifications(user_id, kind, title, body, level)
    VALUES (p_user, 'transaction', 'Корректировка баланса',
            format('Основание: %s', p_reason), 'info');
    INSERT INTO audit_log(actor_id, actor_kind, action, target, payload, level)
    VALUES (auth.uid(), 'admin', 'admin.user.adjust', p_user::text,
            jsonb_build_object('asset', p_asset, 'amount', p_amount, 'reason', p_reason), 'warn');

    RETURN jsonb_build_object('ok', true, 'ledgerTx', v_tx);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_grant_staff(
    p_user uuid, p_department text, p_position text, p_permissions text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_role text;
BEGIN
    IF NOT has_permission('staff.manage') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_role := CASE WHEN p_department = 'management' THEN 'admin' ELSE 'support' END;
    UPDATE profiles SET role = v_role, kyc_level = 3, updated_at = now() WHERE id = p_user;

    INSERT INTO staff_profiles(user_id, position, department, permissions, created_by)
    VALUES (p_user, COALESCE(p_position,''), p_department, COALESCE(p_permissions,'{}'), auth.uid())
    ON CONFLICT (user_id) DO UPDATE
        SET position = excluded.position, department = excluded.department,
            permissions = excluded.permissions, disabled_at = NULL;

    INSERT INTO notifications(user_id, kind, title, body, level)
    VALUES (p_user, 'account', 'Выданы полномочия сотрудника',
            format('Отдел: %s. Полномочий: %s.', p_department,
                   COALESCE(array_length(p_permissions,1),0)), 'info');
    INSERT INTO audit_log(actor_id, actor_kind, action, target, payload, level)
    VALUES (auth.uid(), 'admin', 'staff.grant', p_user::text,
            jsonb_build_object('department', p_department, 'permissions', p_permissions), 'warn');

    RETURN jsonb_build_object('ok', true, 'role', v_role);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.check_ledger_integrity()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_bad int; v_drift int;
BEGIN
    IF NOT has_permission('reports.view') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT count(*) INTO v_bad FROM v_ledger_imbalance;
    SELECT count(*) INTO v_drift FROM balances b
     WHERE b.amount <> COALESCE(
        (SELECT sum(amount) FROM ledger_entries e WHERE e.account_id = b.account_id), 0);
    RETURN jsonb_build_object('balanced', v_bad = 0, 'imbalanced', v_bad,
                              'drift', v_drift, 'ok', v_bad = 0 AND v_drift = 0);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Права на вызов: внутренняя get_account клиенту недоступна
-- ─────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.get_account(uuid,text,text) FROM public;

GRANT EXECUTE ON FUNCTION public.deposit_funds(text,text,bigint,text)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_funds(text,text,text,bigint)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.place_order(text,text,text,bigint,bigint,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_order(bigint)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_block_user(uuid,text)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unblock_user(uuid)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_kyc(uuid,smallint)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_balance(uuid,text,bigint,text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_staff(uuid,text,text,text[])       TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_ledger_integrity()                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(text)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff()                                     TO authenticated;
