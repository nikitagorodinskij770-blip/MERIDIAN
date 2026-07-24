"""MERIDIAN — матчинг-движок и денежные операции.

Приоритет «цена, затем время»: среди заявок с одинаковой ценой первой
исполняется поданная раньше. Цена сделки — цена мейкера, то есть той заявки,
которая уже стояла в книге. Это стандарт, и он же защищает от того, чтобы
агрессивная заявка получала цену лучше выставленной.

Каждое исполнение немедленно порождает проводки двойной записи: средства
не «перекладываются полем», а движутся между счетами журнала.
"""

from __future__ import annotations

from . import db
from .db import LedgerError, account_id, post_tx, gen_id


class TradeError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def _fee_bps(role: str) -> int:
    return int(db.setting("maker_fee_bps" if role == "maker" else "taker_fee_bps", "15"))


def _market(symbol: str):
    m = db.q1("SELECT * FROM markets WHERE symbol=? AND is_active=1", (symbol,))
    if not m:
        raise TradeError("MARKET_NOT_FOUND", f"рынок {symbol} недоступен")
    return m


# ── Блокировка средств под заявку ────────────────────────────────────────

def _lock(conn, user_id: str, asset: str, amount: int, memo: str) -> str:
    """Переносит средства со свободного счёта на заблокированный."""
    free = account_id(user_id, asset, "user", conn)
    held = account_id(user_id, asset, "locked", conn)
    return post_tx("transfer", [(free, asset, -amount), (held, asset, amount)],
                   memo=memo, conn=conn)


def _unlock(conn, user_id: str, asset: str, amount: int, memo: str) -> str:
    free = account_id(user_id, asset, "user", conn)
    held = account_id(user_id, asset, "locked", conn)
    return post_tx("transfer", [(held, asset, -amount), (free, asset, amount)],
                   memo=memo, conn=conn)


# ── Размещение заявки ────────────────────────────────────────────────────

def place_order(user_id: str, symbol: str, side: str, otype: str,
                quantity: int, price: int | None = None,
                client_ref: str | None = None) -> dict:
    if db.setting("trading_enabled", "1") != "1":
        raise TradeError("TRADING_DISABLED", "торговля приостановлена")
    if side not in ("buy", "sell"):
        raise TradeError("BAD_SIDE")
    if otype not in ("market", "limit"):
        raise TradeError("BAD_TYPE")
    if quantity <= 0:
        raise TradeError("BAD_QUANTITY", "количество должно быть больше нуля")
    if otype == "limit" and (price is None or price <= 0):
        raise TradeError("BAD_PRICE", "лимитная заявка требует цену")

    m = _market(symbol)
    base, quote = m["base_id"], m["quote_id"]
    qscale = 10 ** db.scale_of(base)

    with db.tx() as c:
        if client_ref:
            dup = c.execute("SELECT id FROM orders WHERE user_id=? AND client_ref=?",
                            (user_id, client_ref)).fetchone()
            if dup:
                # Идемпотентность: повтор того же запроса не создаёт вторую заявку
                return get_order(dup["id"])

        # Сколько заблокировать. Для рыночной покупки цену берём с худшего
        # доступного уровня книги — иначе не от чего считать резерв.
        if side == "buy":
            ref_price = price or _worst_ask(c, symbol)
            if ref_price is None:
                raise TradeError("NO_LIQUIDITY", "в книге нет встречных заявок")
            need = (quantity * ref_price) // qscale
            lock_asset, lock_amount = quote, need
        else:
            lock_asset, lock_amount = base, quantity

        if lock_amount <= 0:
            raise TradeError("BAD_NOTIONAL", "сумма заявки слишком мала")

        try:
            _lock(c, user_id, lock_asset, lock_amount, f"резерв под заявку {symbol}")
        except LedgerError as e:
            raise TradeError(e.code, str(e)) from e

        oid = gen_id("ord")
        c.execute("""INSERT INTO orders(id,user_id,market,side,type,price,quantity,client_ref)
                     VALUES(?,?,?,?,?,?,?,?)""",
                  (oid, user_id, symbol, side, otype, price, quantity, client_ref))

        filled, spent_quote = _match(c, oid, user_id, symbol, side, otype, price, quantity)

        remaining = quantity - filled
        if otype == "market" or remaining == 0:
            # Рыночная заявка не остаётся в книге: неисполненный остаток снимаем
            if remaining > 0:
                c.execute("UPDATE orders SET status='canceled', updated_at=unixepoch() WHERE id=?", (oid,))
            else:
                c.execute("UPDATE orders SET status='filled', updated_at=unixepoch() WHERE id=?", (oid,))
            # Возвращаем неизрасходованный резерв
            if side == "buy":
                back = lock_amount - spent_quote
            else:
                back = remaining
            if back > 0:
                _unlock(c, user_id, lock_asset, back, f"возврат резерва {oid}")
        else:
            status = "partially_filled" if filled else "open"
            c.execute("UPDATE orders SET status=?, updated_at=unixepoch() WHERE id=?", (status, oid))
            if side == "buy" and price:
                # Резерв считался по худшей цене — лишнее возвращаем
                still_need = (remaining * price) // qscale
                back = lock_amount - spent_quote - still_need
                if back > 0:
                    _unlock(c, user_id, lock_asset, back, f"уточнение резерва {oid}")

    db.audit("order.place", actor_id=user_id, actor_kind="user", target=oid,
             payload={"market": symbol, "side": side, "type": otype,
                      "qty": quantity, "price": price})
    return get_order(oid)


def _worst_ask(conn, symbol: str) -> int | None:
    row = conn.execute("""SELECT MAX(price) AS p FROM orders
                          WHERE market=? AND side='sell' AND status IN ('open','partially_filled')""",
                       (symbol,)).fetchone()
    return row["p"] if row and row["p"] else None


def _match(conn, oid, user_id, symbol, side, otype, price, quantity) -> tuple[int, int]:
    """Сводит заявку со встречными. Возвращает (исполнено, потрачено котируемого)."""
    m = _market(symbol)
    base, quote = m["base_id"], m["quote_id"]
    qscale = 10 ** db.scale_of(base)

    opposite = "sell" if side == "buy" else "buy"
    if side == "buy":
        cond = "AND (? IS NULL OR price <= ?)"
        order_by = "price ASC, created_at ASC"
    else:
        cond = "AND (? IS NULL OR price >= ?)"
        order_by = "price DESC, created_at ASC"

    rows = conn.execute(f"""SELECT * FROM orders
        WHERE market=? AND side=? AND status IN ('open','partially_filled')
          AND user_id <> ? {cond}
        ORDER BY {order_by}""",
        (symbol, opposite, user_id, price, price)).fetchall()

    remaining = quantity
    filled_total = 0
    spent_quote = 0

    for maker in rows:
        if remaining <= 0:
            break
        avail = maker["quantity"] - maker["filled"]
        if avail <= 0:
            continue

        take = min(remaining, avail)
        trade_price = maker["price"]                 # цена мейкера — не тейкера
        notional = (take * trade_price) // qscale
        if notional <= 0:
            continue

        taker_fee = notional * _fee_bps("taker") // 10_000
        maker_fee = notional * _fee_bps("maker") // 10_000

        if side == "buy":
            buyer, seller = user_id, maker["user_id"]
            buyer_fee_asset, buyer_fee = base, take * _fee_bps("taker") // 10_000
            seller_fee = maker_fee
        else:
            buyer, seller = maker["user_id"], user_id
            buyer_fee_asset, buyer_fee = base, take * _fee_bps("maker") // 10_000
            seller_fee = taker_fee

        _settle(conn, buyer, seller, base, quote, take, notional,
                buyer_fee, seller_fee, symbol)

        conn.execute("UPDATE orders SET filled = filled + ?, status = CASE "
                     "WHEN filled + ? >= quantity THEN 'filled' ELSE 'partially_filled' END, "
                     "updated_at = unixepoch() WHERE id=?",
                     (take, take, maker["id"]))
        conn.execute("""INSERT INTO fills(order_id,market,price,quantity,fee,fee_asset,role)
                        VALUES(?,?,?,?,?,?,'maker')""",
                     (maker["id"], symbol, trade_price, take, maker_fee, quote))
        conn.execute("""INSERT INTO fills(order_id,market,price,quantity,fee,fee_asset,role)
                        VALUES(?,?,?,?,?,?,'taker')""",
                     (oid, symbol, trade_price, take, taker_fee, quote))
        conn.execute("UPDATE orders SET filled = filled + ?, updated_at=unixepoch() WHERE id=?",
                     (take, oid))

        remaining -= take
        filled_total += take
        spent_quote += notional

    return filled_total, spent_quote


def _settle(conn, buyer, seller, base, quote, qty, notional,
            buyer_fee, seller_fee, symbol):
    """Расчёт по сделке: база покупателю, котируемое продавцу, комиссии бирже."""
    b_free = account_id(buyer, base, "user", conn)
    b_lock = account_id(buyer, quote, "locked", conn)
    s_free = account_id(seller, quote, "user", conn)
    s_lock = account_id(seller, base, "locked", conn)
    fee_base = account_id(None, base, "fee", conn)
    fee_quote = account_id(None, quote, "fee", conn)

    entries = [
        # Базовый актив: со заблокированного счёта продавца покупателю
        (s_lock, base, -qty),
        (b_free, base, qty - buyer_fee),
        # Котируемый: с заблокированного счёта покупателя продавцу
        (b_lock, quote, -notional),
        (s_free, quote, notional - seller_fee),
    ]
    if buyer_fee:
        entries.append((fee_base, base, buyer_fee))
    if seller_fee:
        entries.append((fee_quote, quote, seller_fee))

    post_tx("trade", entries, ref_id=symbol,
            memo=f"сделка {symbol} {qty}@{notional}", conn=conn)


def cancel_order(user_id: str, order_id: str) -> dict:
    with db.tx() as c:
        o = c.execute("SELECT * FROM orders WHERE id=? AND user_id=?",
                      (order_id, user_id)).fetchone()
        if not o:
            raise TradeError("ORDER_NOT_FOUND")
        if o["status"] not in ("open", "partially_filled"):
            raise TradeError("ORDER_NOT_OPEN", f"заявка в статусе {o['status']}")

        m = _market(o["market"])
        base, quote = m["base_id"], m["quote_id"]
        qscale = 10 ** db.scale_of(base)
        remaining = o["quantity"] - o["filled"]

        if o["side"] == "buy":
            back = (remaining * o["price"]) // qscale if o["price"] else 0
            asset = quote
        else:
            back, asset = remaining, base

        if back > 0:
            _unlock(c, user_id, asset, back, f"отмена заявки {order_id}")
        c.execute("UPDATE orders SET status='canceled', updated_at=unixepoch() WHERE id=?",
                  (order_id,))

    db.audit("order.cancel", actor_id=user_id, actor_kind="user", target=order_id)
    return get_order(order_id)


def get_order(order_id: str) -> dict:
    o = db.q1("SELECT * FROM orders WHERE id=?", (order_id,))
    if not o:
        raise TradeError("ORDER_NOT_FOUND")
    m = db.q1("SELECT base_id, quote_id FROM markets WHERE symbol=?", (o["market"],))
    return {
        "id": o["id"], "market": o["market"], "side": o["side"], "type": o["type"],
        "price": db.to_human(m["quote_id"], o["price"]) if o["price"] else None,
        "quantity": db.to_human(m["base_id"], o["quantity"]),
        "filled": db.to_human(m["base_id"], o["filled"]),
        "status": o["status"], "createdAt": o["created_at"] * 1000,
    }


def order_book(symbol: str, depth: int = 20) -> dict:
    m = _market(symbol)
    base, quote = m["base_id"], m["quote_id"]

    def side(s, order):
        rows = db.q(f"""SELECT price, SUM(quantity - filled) AS qty FROM orders
                        WHERE market=? AND side=? AND status IN ('open','partially_filled')
                        GROUP BY price ORDER BY price {order} LIMIT ?""",
                    (symbol, s, depth))
        return [{"price": db.to_human(quote, r["price"]),
                 "qty": db.to_human(base, r["qty"])} for r in rows if r["qty"]]

    return {"symbol": symbol, "bids": side("buy", "DESC"), "asks": side("sell", "ASC")}


# ── Ввод и вывод ─────────────────────────────────────────────────────────

def credit_deposit(user_id: str, asset: str, amount: int, network: str,
                   tx_hash: str | None = None) -> dict:
    """Зачисление. Идемпотентно по (сеть, хэш): повтор не удвоит баланс."""
    if amount <= 0:
        raise TradeError("BAD_AMOUNT")

    with db.tx() as c:
        if tx_hash:
            dup = c.execute("SELECT id FROM transactions WHERE network_id=? AND tx_hash=?",
                            (network, tx_hash)).fetchone()
            if dup:
                raise TradeError("DUPLICATE_TX", "этот перевод уже зачислен")

        user_acc = account_id(user_id, asset, "user", c)
        ext_acc = account_id(None, asset, "external", c)
        ltx = post_tx("deposit", [(ext_acc, asset, -amount), (user_acc, asset, amount)],
                      memo=f"пополнение {asset} через {network}", conn=c)

        tid = gen_id("tx")
        c.execute("""INSERT INTO transactions(id,user_id,kind,asset_id,network_id,amount,
                     status,tx_hash,ledger_tx_id,confirmations)
                     VALUES(?,?,'deposit',?,?,?,'completed',?,?,1)""",
                  (tid, user_id, asset, network, amount, tx_hash, ltx))

    db.audit("wallet.deposit", actor_id=user_id, actor_kind="user", target=tid,
             payload={"asset": asset, "amount": amount, "network": network})
    return {"id": tid, "status": "completed", "asset": asset,
            "amount": db.to_human(asset, amount)}


def request_withdrawal(user_id: str, asset: str, network: str,
                       address: str, amount: int) -> dict:
    if db.setting("withdrawals_enabled", "1") != "1":
        raise TradeError("WITHDRAWALS_DISABLED", "вывод временно приостановлен")
    if amount <= 0:
        raise TradeError("BAD_AMOUNT")

    an = db.q1("SELECT * FROM asset_networks WHERE asset_id=? AND network_id=?",
               (asset, network))
    if not an:
        raise TradeError("NETWORK_NOT_SUPPORTED", f"{asset} не выводится через {network}")
    if amount < an["min_withdraw"]:
        raise TradeError("BELOW_MIN", f"минимум {db.to_human(asset, an['min_withdraw'])} {asset}")

    user = db.q1("SELECT kyc_level, status FROM users WHERE id=?", (user_id,))
    if user["status"] != "active":
        raise TradeError("ACCOUNT_NOT_ACTIVE", "операции по счёту ограничены")
    if db.setting("require_kyc_for_withdraw", "1") == "1" and user["kyc_level"] < 1:
        raise TradeError("KYC_REQUIRED", "для вывода нужна верификация")

    fee = an["withdraw_fee"]
    total = amount + fee

    with db.tx() as c:
        user_acc = account_id(user_id, asset, "user", c)
        ext_acc = account_id(None, asset, "external", c)
        fee_acc = account_id(None, asset, "fee", c)
        entries = [(user_acc, asset, -total), (ext_acc, asset, amount)]
        if fee:
            entries.append((fee_acc, asset, fee))
        try:
            ltx = post_tx("withdraw", entries,
                          memo=f"вывод {asset} в {network}", conn=c)
        except LedgerError as e:
            raise TradeError(e.code, str(e)) from e

        tid = gen_id("tx")
        c.execute("""INSERT INTO transactions(id,user_id,kind,asset_id,network_id,amount,fee,
                     address,status,ledger_tx_id)
                     VALUES(?,?,'withdraw',?,?,?,?,?,'pending',?)""",
                  (tid, user_id, asset, network, amount, fee, address, ltx))

    db.audit("wallet.withdraw", actor_id=user_id, actor_kind="user", target=tid,
             payload={"asset": asset, "amount": amount, "network": network,
                      "address": address[:12] + "…"}, level="warn")
    return {"id": tid, "status": "pending", "asset": asset,
            "amount": db.to_human(asset, amount), "fee": db.to_human(asset, fee)}
