-- ============================================================================
-- MERIDIAN — прикладные RPC для кабинета и админ-панели
--
-- Агрегация по дням и сборка карточки клиента вынесены в базу: считать это
-- на клиенте означало бы вытащить всю историю операций в браузер и сложить
-- там. Функция возвращает готовый ряд, а RLS внутри неё соблюдается за счёт
-- явной проверки — где нужно, вызывающий должен быть владельцем или иметь
-- полномочие.
-- ============================================================================

-- Ряды активности текущего пользователя за N дней (для раздела «Активность»).
-- Суммы приводятся к человеческому виду делением на масштаб актива.
CREATE OR REPLACE FUNCTION public.me_activity(p_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_user uuid := auth.uid();
    v_since timestamptz := now() - make_interval(days => p_days);
    v_dep numeric[]; v_wd numeric[]; v_tr numeric[]; v_lg int[];
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Каждый ряд: сумма за день, дополненная нулями до p_days позиций
    -- через LEFT JOIN generate_series (дни без операций дают 0, а не пропуск).
    SELECT array_agg(coalesce(s.val,0) ORDER BY d.dn) INTO v_dep
    FROM generate_series(0, p_days-1) AS d(dn)
    LEFT JOIN (
        SELECT (p_days - 1 - floor(extract(epoch FROM (now() - t.created_at))/86400)::int) AS bkt,
               sum(CAST(t.amount AS numeric)/power(10,a.scale)) AS val
        FROM transactions t JOIN assets a ON a.id=t.asset_id
        WHERE t.user_id=v_user AND t.kind='deposit' AND t.status='completed' AND t.created_at>v_since
        GROUP BY 1
    ) s ON s.bkt = d.dn;

    SELECT array_agg(coalesce(s.val,0) ORDER BY d.dn) INTO v_wd
    FROM generate_series(0, p_days-1) AS d(dn)
    LEFT JOIN (
        SELECT (p_days - 1 - floor(extract(epoch FROM (now() - t.created_at))/86400)::int) AS bkt,
               sum(CAST(t.amount AS numeric)/power(10,a.scale)) AS val
        FROM transactions t JOIN assets a ON a.id=t.asset_id
        WHERE t.user_id=v_user AND t.kind='withdraw' AND t.created_at>v_since
        GROUP BY 1
    ) s ON s.bkt = d.dn;

    SELECT array_agg(coalesce(s.val,0) ORDER BY d.dn) INTO v_tr
    FROM generate_series(0, p_days-1) AS d(dn)
    LEFT JOIN (
        SELECT (p_days - 1 - floor(extract(epoch FROM (now() - f.created_at))/86400)::int) AS bkt,
               sum(CAST(f.quantity AS numeric)/power(10,a.scale)) AS val
        FROM fills f JOIN orders o ON o.id=f.order_id
        JOIN markets m ON m.symbol=f.market JOIN assets a ON a.id=m.base_id
        WHERE o.user_id=v_user AND f.created_at>v_since
        GROUP BY 1
    ) s ON s.bkt = d.dn;

    SELECT array_agg(coalesce(s.cnt,0) ORDER BY d.dn) INTO v_lg
    FROM generate_series(0, p_days-1) AS d(dn)
    LEFT JOIN (
        SELECT (p_days - 1 - floor(extract(epoch FROM (now() - l.created_at))/86400)::int) AS bkt,
               count(*) AS cnt
        FROM login_history l
        WHERE l.user_id=v_user AND l.event='login' AND l.created_at>v_since
        GROUP BY 1
    ) s ON s.bkt = d.dn;

    RETURN jsonb_build_object(
        'days', p_days,
        'deposits', v_dep, 'withdrawals', v_wd, 'trades', v_tr, 'logins', v_lg,
        'totals', jsonb_build_object(
            'deposits', (SELECT coalesce(sum(x),0) FROM unnest(v_dep) x),
            'withdrawals', (SELECT coalesce(sum(x),0) FROM unnest(v_wd) x),
            'trades', (SELECT coalesce(sum(x),0) FROM unnest(v_tr) x),
            'logins', (SELECT coalesce(sum(x),0) FROM unnest(v_lg) x)));
END;
$fn$;

-- Сводка активности сотрудников: ответы в поддержке и действия за 7 дней.
-- Читается только из admin_analytics (SECURITY DEFINER), поэтому доступ
-- ограничивает сама функция, а не политики на этом представлении.
CREATE OR REPLACE VIEW public.v_staff_activity AS
SELECT
    s.user_id,
    p.display_name,
    s.department,
    (SELECT count(*) FROM public.support_messages m
       WHERE m.author_id = s.user_id AND m.author_kind = 'staff')        AS replies,
    (SELECT count(*) FROM public.audit_log a
       WHERE a.actor_id = s.user_id AND a.created_at > now() - interval '7 days') AS actions_7d
FROM public.staff_profiles s
JOIN public.profiles p ON p.id = s.user_id
WHERE s.disabled_at IS NULL
ORDER BY actions_7d DESC, replies DESC;

-- Аналитика площадки для операторов с правом на отчёты.
CREATE OR REPLACE FUNCTION public.admin_analytics(p_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
    v_since timestamptz := now() - make_interval(days => p_days);
    v_signups int[]; v_logins int[]; v_trades int[]; v_tickets int[];
BEGIN
    IF NOT has_permission('reports.view') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT array_agg(coalesce(s.c,0) ORDER BY d.dn) INTO v_signups
    FROM generate_series(0,p_days-1) d(dn) LEFT JOIN (
        SELECT (p_days-1-floor(extract(epoch FROM (now()-created_at))/86400)::int) AS bkt, count(*) c
        FROM profiles WHERE created_at>v_since GROUP BY 1) s ON s.bkt=d.dn;

    SELECT array_agg(coalesce(s.c,0) ORDER BY d.dn) INTO v_logins
    FROM generate_series(0,p_days-1) d(dn) LEFT JOIN (
        SELECT (p_days-1-floor(extract(epoch FROM (now()-created_at))/86400)::int) AS bkt, count(*) c
        FROM login_history WHERE event='login' AND created_at>v_since GROUP BY 1) s ON s.bkt=d.dn;

    SELECT array_agg(coalesce(s.c,0) ORDER BY d.dn) INTO v_trades
    FROM generate_series(0,p_days-1) d(dn) LEFT JOIN (
        SELECT (p_days-1-floor(extract(epoch FROM (now()-created_at))/86400)::int) AS bkt, count(*) c
        FROM fills WHERE created_at>v_since GROUP BY 1) s ON s.bkt=d.dn;

    SELECT array_agg(coalesce(s.c,0) ORDER BY d.dn) INTO v_tickets
    FROM generate_series(0,p_days-1) d(dn) LEFT JOIN (
        SELECT (p_days-1-floor(extract(epoch FROM (now()-created_at))/86400)::int) AS bkt, count(*) c
        FROM support_tickets WHERE created_at>v_since GROUP BY 1) s ON s.bkt=d.dn;

    RETURN jsonb_build_object(
        'days', p_days,
        'series', jsonb_build_object('signups',v_signups,'logins',v_logins,
                                     'trades',v_trades,'tickets',v_tickets),
        'totals', jsonb_build_object(
            'users',(SELECT count(*) FROM profiles),
            'active',(SELECT count(*) FROM profiles WHERE status='active'),
            'blocked',(SELECT count(*) FROM profiles WHERE status='blocked'),
            'staff',(SELECT count(*) FROM staff_profiles WHERE disabled_at IS NULL),
            'openTickets',(SELECT count(*) FROM v_support_queue),
            'openOrders',(SELECT count(*) FROM orders WHERE status IN ('open','partially_filled')),
            'fills',(SELECT count(*) FROM fills WHERE created_at>v_since),
            'deposits',(SELECT count(*) FROM transactions WHERE kind='deposit' AND created_at>v_since),
            'withdrawals',(SELECT count(*) FROM transactions WHERE kind='withdraw' AND created_at>v_since)),
        'byCountry',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c,'count',n) ORDER BY n DESC),'[]')
            FROM (SELECT coalesce(country,'не указана') c, count(*) n FROM profiles GROUP BY 1 ORDER BY n DESC LIMIT 10) q),
        'byDevice',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',k,'count',n)),'[]')
            FROM (SELECT coalesce(device_kind,'unknown') k, count(*) n FROM login_history WHERE created_at>v_since GROUP BY 1) q),
        'byKyc',(SELECT jsonb_agg(coalesce(c,0) ORDER BY lvl)
            FROM generate_series(0,3) lvl LEFT JOIN (SELECT kyc_level, count(*) c FROM profiles GROUP BY 1) x ON x.kyc_level=lvl),
        'staffActivity',(SELECT coalesce(jsonb_agg(row_to_json(v)),'[]') FROM v_staff_activity v),
        'integrity', check_ledger_integrity());
END;
$fn$;

-- Полная карточка клиента для оператора.
CREATE OR REPLACE FUNCTION public.admin_user_profile(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_sum jsonb;
BEGIN
    IF NOT has_permission('users.view') THEN
        RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT to_jsonb(s) INTO v_sum FROM v_user_summary s WHERE s.user_id = p_user;
    IF v_sum IS NULL THEN
        RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    RETURN jsonb_build_object(
        'summary', v_sum,
        'balances',(SELECT coalesce(jsonb_agg(jsonb_build_object(
            'asset',asset_id,'available',available::text,'locked',locked::text)),'[]')
            FROM v_user_balances WHERE user_id=p_user AND total<>0),
        'limits',(SELECT to_jsonb(l) FROM user_limits l WHERE user_id=p_user),
        'devices',(SELECT coalesce(jsonb_agg(jsonb_build_object(
            'label',label,'ip',last_ip,'city',last_city,
            'lastSeen',extract(epoch FROM last_seen_at)*1000)),'[]')
            FROM known_devices WHERE user_id=p_user),
        'logins',(SELECT coalesce(jsonb_agg(jsonb_build_object(
            'event',event,'os',os,'browser',browser,'ip',ip,
            'at',extract(epoch FROM created_at)*1000) ORDER BY created_at DESC),'[]')
            FROM (SELECT * FROM login_history WHERE user_id=p_user ORDER BY created_at DESC LIMIT 25) q),
        'notes',(SELECT coalesce(jsonb_agg(jsonb_build_object(
            'body',n.body,'author',p.display_name,'pinned',n.pinned,
            'createdAt',extract(epoch FROM n.created_at)*1000) ORDER BY n.pinned DESC, n.created_at DESC),'[]')
            FROM user_notes n LEFT JOIN profiles p ON p.id=n.author_id WHERE n.user_id=p_user),
        'tickets',(SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id',id,'subject',subject,'status',status,'priority',priority)),'[]')
            FROM support_tickets WHERE user_id=p_user),
        -- Ряд входов ИМЕННО этого клиента (me_activity брала бы auth.uid() —
        -- то есть самого оператора; карточке нужен профиль просматриваемого).
        'activity', jsonb_build_object('logins',
            (SELECT array_agg(coalesce(s.c,0) ORDER BY d.dn)
             FROM generate_series(0,29) d(dn) LEFT JOIN (
                SELECT (29-floor(extract(epoch FROM (now()-created_at))/86400)::int) AS bkt, count(*) c
                FROM login_history WHERE user_id=p_user AND event='login'
                  AND created_at>now()-interval '30 days' GROUP BY 1) s ON s.bkt=d.dn)));
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.me_activity(int)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_analytics(int)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_profile(uuid) TO authenticated;
