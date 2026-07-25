-- ============================================================================
-- MERIDIAN — торговые операции поверх журнала
--
-- Обмен, покупка картой, рыночная сделка и продукты доходности. Все они —
-- проводки двойной записи, где контрагентом выступает системный счёт treasury:
-- ему разрешён отрицательный остаток (это обязательство площадки), поэтому он
-- работает как маркет-мейкер с бесконечной ликвидностью. Так мгновенное
-- исполнение остаётся честной проводкой, а не подрисованным балансом.
--
-- Цена берётся из asset_prices (свод шести площадок), а не от клиента —
-- фронтенд не может назначить себе выгодный курс.
-- ============================================================================

-- Обмен и покупка тоже должны попадать в историю кошелька.
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_kind_check
    CHECK (kind IN ('deposit','withdraw','convert','buy'));

-- Комиссия онрампа картой (базисные пункты). Остальные ставки уже в настройках.
INSERT INTO public.platform_settings(key, value) VALUES ('buy_card_fee_bps', '180')
    ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Позиции доходности
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.earn_positions (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    asset_id   text NOT NULL REFERENCES public.assets(id),
    amount     bigint NOT NULL CHECK (amount > 0),   -- тело вклада, минимальные единицы
    apy        numeric(6,2) NOT NULL CHECK (apy >= 0),
    product    text NOT NULL,                        -- «Сберегательный» / «Стейкинг» / «Фиксированный»
    term       text NOT NULL,
    status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed')),
    opened_at  timestamptz NOT NULL DEFAULT now(),
    closed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_earn_user ON public.earn_positions(user_id, status);

ALTER TABLE public.earn_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS earn_read ON public.earn_positions;
CREATE POLICY earn_read ON public.earn_positions FOR SELECT
    USING (user_id = auth.uid() OR public.has_permission('users.view'));
-- Запись — только через RPC (SECURITY DEFINER). Прямых INSERT/UPDATE клиенту нет.

-- ─────────────────────────────────────────────────────────────────────────
-- Общий помощник: курс в единицах quote за одну единицу base, как numeric.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.oracle_rate(p_base text, p_quote text)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_b numeric; v_q numeric;
BEGIN
    SELECT last_price_usd INTO v_b FROM asset_prices WHERE asset_id = p_base;
    SELECT last_price_usd INTO v_q FROM asset_prices WHERE asset_id = p_quote;
    IF v_b IS NULL OR v_q IS NULL OR v_q = 0 THEN
        RAISE EXCEPTION 'NO_PRICE' USING ERRCODE = 'check_violation';
    END IF;
    RETURN v_b / v_q;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Мгновенный обмен from → to по своду цен
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.convert_funds(
    p_from text, p_to text, p_amount bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid();
    v_rate numeric; v_from_scale int; v_to_scale int;
    v_gross bigint; v_fee bigint; v_net bigint; v_bps int;
    v_tx bigint; v_txid bigint;
BEGIN
    PERFORM assert_can_operate('trade');
    IF p_from = p_to THEN RAISE EXCEPTION 'SAME_ASSET' USING ERRCODE='check_violation'; END IF;
    IF p_amount <= 0 THEN RAISE EXCEPTION 'BAD_AMOUNT' USING ERRCODE='check_violation'; END IF;

    v_rate := oracle_rate(p_from, p_to);
    SELECT scale INTO v_from_scale FROM assets WHERE id = p_from;
    SELECT scale INTO v_to_scale   FROM assets WHERE id = p_to;
    v_bps := COALESCE((SELECT value::int FROM platform_settings WHERE key='convert_fee_bps'), 35);

    -- gross (в единицах to) = amount * rate, с приведением масштабов
    v_gross := floor( (p_amount::numeric / power(10, v_from_scale)) * v_rate * power(10, v_to_scale) )::bigint;
    v_fee   := v_gross * v_bps / 10000;
    v_net   := v_gross - v_fee;
    IF v_net <= 0 THEN RAISE EXCEPTION 'DUST_AMOUNT' USING ERRCODE='check_violation'; END IF;

    INSERT INTO ledger_tx(kind, memo)
    VALUES ('convert', format('обмен %s → %s', p_from, p_to)) RETURNING id INTO v_tx;

    INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
        (v_tx, get_account(v_user, p_from, 'user'),   p_from, -p_amount),
        (v_tx, get_account(NULL,   p_from, 'treasury'),p_from,  p_amount),
        (v_tx, get_account(NULL,   p_to,   'treasury'),p_to,   -v_gross),
        (v_tx, get_account(v_user, p_to,   'user'),   p_to,    v_net);
    IF v_fee > 0 THEN
        INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount)
        VALUES (v_tx, get_account(NULL, p_to, 'fee'), p_to, v_fee);
    END IF;

    INSERT INTO transactions(user_id, kind, asset_id, amount, fee, status, ledger_tx_id, note)
    VALUES (v_user, 'convert', p_to, v_net, v_fee, 'completed', v_tx,
            format('Обмен %s → %s', p_from, p_to))
    RETURNING id INTO v_txid;

    RETURN jsonb_build_object('id', v_txid, 'received', v_net, 'fee', v_fee,
                              'gross', v_gross, 'rate', v_rate);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Покупка криптовалюты за фиат картой (онрамп)
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.buy_with_card(
    p_fiat text, p_asset text, p_fiat_amount bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid();
    v_rate numeric; v_fiat_scale int; v_asset_scale int;
    v_bps int; v_net_fiat numeric; v_received bigint;
    v_tx bigint; v_txid bigint;
BEGIN
    PERFORM assert_can_operate('trade');
    IF p_fiat_amount <= 0 THEN RAISE EXCEPTION 'BAD_AMOUNT' USING ERRCODE='check_violation'; END IF;

    v_rate := oracle_rate(p_fiat, p_asset);
    SELECT scale INTO v_fiat_scale  FROM assets WHERE id = p_fiat;
    SELECT scale INTO v_asset_scale FROM assets WHERE id = p_asset;
    v_bps := COALESCE((SELECT value::int FROM platform_settings WHERE key='buy_card_fee_bps'), 180);

    -- Комиссия удерживается с суммы в фиате (списывается картой снаружи)
    v_net_fiat := p_fiat_amount::numeric * (1 - v_bps::numeric / 10000);
    v_received := floor( (v_net_fiat / power(10, v_fiat_scale)) * v_rate * power(10, v_asset_scale) )::bigint;
    IF v_received <= 0 THEN RAISE EXCEPTION 'DUST_AMOUNT' USING ERRCODE='check_violation'; END IF;

    -- Средства приходят с карты (внешний источник) и зачисляются в активе
    INSERT INTO ledger_tx(kind, memo)
    VALUES ('deposit', format('покупка %s за %s картой', p_asset, p_fiat)) RETURNING id INTO v_tx;
    INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
        (v_tx, get_account(NULL,   p_asset, 'treasury'), p_asset, -v_received),
        (v_tx, get_account(v_user, p_asset, 'user'),     p_asset,  v_received);

    INSERT INTO transactions(user_id, kind, asset_id, amount, status, ledger_tx_id, note)
    VALUES (v_user, 'buy', p_asset, v_received, 'completed', v_tx,
            format('Покупка за %s %s картой',
                   round((p_fiat_amount::numeric / power(10, v_fiat_scale)::numeric), 2), p_fiat))
    RETURNING id INTO v_txid;

    RETURN jsonb_build_object('id', v_txid, 'received', v_received);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Рыночная сделка: мгновенное исполнение против treasury по своду цен.
-- Лимитные заявки идут прежним путём place_order и ждут встречной цены в книге.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.market_swap(
    p_base text, p_quote text, p_side text, p_base_qty bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid();
    v_rate numeric; v_base_scale int; v_quote_scale int;
    v_notional bigint; v_bps int; v_fee bigint;
    v_tx bigint;
BEGIN
    PERFORM assert_can_operate('trade');
    IF COALESCE((SELECT value FROM platform_settings WHERE key='trading_enabled'),'1') <> '1' THEN
        RAISE EXCEPTION 'TRADING_DISABLED' USING ERRCODE='insufficient_privilege';
    END IF;
    IF p_side NOT IN ('buy','sell') THEN RAISE EXCEPTION 'BAD_PARAMS' USING ERRCODE='check_violation'; END IF;
    IF p_base_qty <= 0 THEN RAISE EXCEPTION 'BAD_QUANTITY' USING ERRCODE='check_violation'; END IF;

    v_rate := oracle_rate(p_base, p_quote);
    SELECT scale INTO v_base_scale  FROM assets WHERE id = p_base;
    SELECT scale INTO v_quote_scale FROM assets WHERE id = p_quote;
    v_bps := COALESCE((SELECT value::int FROM platform_settings WHERE key='taker_fee_bps'), 15);

    v_notional := floor( (p_base_qty::numeric / power(10, v_base_scale)) * v_rate * power(10, v_quote_scale) )::bigint;
    IF v_notional <= 0 THEN RAISE EXCEPTION 'DUST_AMOUNT' USING ERRCODE='check_violation'; END IF;

    INSERT INTO ledger_tx(kind, ref_id, memo)
    VALUES ('trade', p_base||'-'||p_quote, format('рыночная сделка %s %s', p_side, p_base||'-'||p_quote))
    RETURNING id INTO v_tx;

    IF p_side = 'buy' THEN
        v_fee := p_base_qty * v_bps / 10000;                      -- комиссия в base
        INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
            (v_tx, get_account(v_user, p_quote, 'user'),    p_quote, -v_notional),
            (v_tx, get_account(NULL,   p_quote, 'treasury'),p_quote,  v_notional),
            (v_tx, get_account(NULL,   p_base,  'treasury'),p_base,  -p_base_qty),
            (v_tx, get_account(v_user, p_base,  'user'),    p_base,   p_base_qty - v_fee);
        IF v_fee > 0 THEN
            INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount)
            VALUES (v_tx, get_account(NULL, p_base, 'fee'), p_base, v_fee);
        END IF;
    ELSE
        v_fee := v_notional * v_bps / 10000;                      -- комиссия в quote
        INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
            (v_tx, get_account(v_user, p_base,  'user'),    p_base,  -p_base_qty),
            (v_tx, get_account(NULL,   p_base,  'treasury'),p_base,   p_base_qty),
            (v_tx, get_account(NULL,   p_quote, 'treasury'),p_quote, -v_notional),
            (v_tx, get_account(v_user, p_quote, 'user'),    p_quote,  v_notional - v_fee);
        IF v_fee > 0 THEN
            INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount)
            VALUES (v_tx, get_account(NULL, p_quote, 'fee'), p_quote, v_fee);
        END IF;
    END IF;

    RETURN jsonb_build_object('filled', p_base_qty, 'notional', v_notional,
                              'fee', v_fee, 'rate', v_rate, 'status', 'filled');
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Продукты доходности
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.earn_subscribe(
    p_asset text, p_amount bigint, p_apy numeric, p_product text, p_term text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_user uuid := auth.uid(); v_id bigint; v_tx bigint;
BEGIN
    PERFORM assert_can_operate('trade');
    IF p_amount <= 0 THEN RAISE EXCEPTION 'BAD_AMOUNT' USING ERRCODE='check_violation'; END IF;

    -- Тело вклада уходит со свободного счёта в распоряжение площадки
    INSERT INTO ledger_tx(kind, memo)
    VALUES ('transfer', format('размещение в доходность %s', p_asset)) RETURNING id INTO v_tx;
    INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
        (v_tx, get_account(v_user, p_asset, 'user'),     p_asset, -p_amount),
        (v_tx, get_account(NULL,   p_asset, 'treasury'), p_asset,  p_amount);

    INSERT INTO earn_positions(user_id, asset_id, amount, apy, product, term)
    VALUES (v_user, p_asset, p_amount, p_apy, p_product, p_term) RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'amount', p_amount);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.earn_redeem(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid(); v_p record;
    v_days numeric; v_interest bigint; v_total bigint; v_tx bigint;
BEGIN
    SELECT * INTO v_p FROM earn_positions
     WHERE id = p_id AND user_id = v_user AND status = 'active' FOR UPDATE;
    IF v_p IS NULL THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='no_data_found'; END IF;

    v_days := extract(epoch FROM (now() - v_p.opened_at)) / 86400;
    v_interest := floor(v_p.amount::numeric * (v_p.apy/100) * (v_days/365))::bigint;
    v_total := v_p.amount + v_interest;

    -- Тело и начисленный доход возвращаются клиенту из распоряжения площадки
    INSERT INTO ledger_tx(kind, memo)
    VALUES ('reward', format('возврат из доходности %s', v_p.asset_id)) RETURNING id INTO v_tx;
    INSERT INTO ledger_entries(tx_id, account_id, asset_id, amount) VALUES
        (v_tx, get_account(NULL,   v_p.asset_id, 'treasury'), v_p.asset_id, -v_total),
        (v_tx, get_account(v_user, v_p.asset_id, 'user'),     v_p.asset_id,  v_total);

    UPDATE earn_positions SET status='redeemed', closed_at=now() WHERE id = p_id;
    RETURN jsonb_build_object('id', p_id, 'principal', v_p.amount,
                              'interest', v_interest, 'total', v_total);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────
-- Права на вызов
-- ─────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.oracle_rate(text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.convert_funds(text,text,bigint)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.buy_with_card(text,text,bigint)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.market_swap(text,text,text,bigint)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.earn_subscribe(text,bigint,numeric,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.earn_redeem(bigint)                     TO authenticated;
