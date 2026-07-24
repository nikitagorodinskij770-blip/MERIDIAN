"""MERIDIAN — самопроверка денежного контура.

Проверяем не «код не падает», а инварианты, нарушение которых означает
потерянные или созданные из воздуха деньги:

  * журнал сходится (сумма проводок по каждой операции равна нулю);
  * кэш балансов совпадает с журналом;
  * клиентский счёт не уходит в минус;
  * сумма всех клиентских остатков плюс комиссии равна заведённому извне;
  * повторный депозит с тем же хэшем не удваивает баланс;
  * подпись запроса проверяется, а повтор nonce отклоняется.

Запуск:  python -m server.selftest
"""

from __future__ import annotations

import os
import sys
import tempfile

# Отдельная база на каждый прогон, чтобы не трогать рабочую
_tmp = tempfile.mkdtemp(prefix="meridian_test_")
from . import db  # noqa: E402
db.DB_PATH = os.path.join(_tmp, "test.db")

from . import security, engine  # noqa: E402
from .db import LedgerError  # noqa: E402
from .engine import TradeError  # noqa: E402

PASS, FAIL = [], []


def check(name: str, cond: bool, detail: str = ""):
    (PASS if cond else FAIL).append(name)
    mark = "  ok  " if cond else " FAIL "
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not cond else ""))


def mk_user(email: str, role: str = "user") -> str:
    uid = db.gen_id("usr")
    db.run("""INSERT INTO users(id,email,email_norm,pw_hash,display_name,role,kyc_level)
              VALUES(?,?,?,?,?,?,2)""",
           (uid, email, email.lower(), security.hash_password("correct horse battery"),
            email.split("@")[0], role))
    return uid


def total_in_ledger(asset: str) -> int:
    """Сумма по клиентским и комиссионным счетам — то, что «внутри биржи»."""
    row = db.q1("""SELECT COALESCE(SUM(b.amount),0) AS s
                   FROM balances b JOIN ledger_accounts la ON la.id=b.account_id
                   WHERE la.asset_id=? AND la.kind IN ('user','locked','fee')""", (asset,))
    return row["s"]


def main() -> int:
    db.bootstrap()
    print(f"\nбаза: {db.DB_PATH}\n" + "─" * 62)

    alice = mk_user("alice@test.local")
    bob = mk_user("bob@test.local")

    # ── 1. Пополнение ────────────────────────────────────────────────
    engine.credit_deposit(alice, "USDT", db.to_minor("USDT", "100000"), "TRC20", "hash_a1")
    engine.credit_deposit(bob, "BTC", db.to_minor("BTC", "2"), "Bitcoin", "hash_b1")

    check("пополнение зачислено (Alice USDT)",
          db.available_of(alice, "USDT") == db.to_minor("USDT", "100000"))
    check("пополнение зачислено (Bob BTC)",
          db.available_of(bob, "BTC") == db.to_minor("BTC", "2"))

    # ── 2. Идемпотентность депозита ──────────────────────────────────
    try:
        engine.credit_deposit(alice, "USDT", db.to_minor("USDT", "100000"), "TRC20", "hash_a1")
        check("повторный депозит с тем же хэшем отклонён", False, "прошёл дважды")
    except TradeError as e:
        check("повторный депозит с тем же хэшем отклонён", e.code == "DUPLICATE_TX")

    # ── 3. Запрет ухода в минус ──────────────────────────────────────
    try:
        engine.request_withdrawal(alice, "USDT", "TRC20", "T" + "x" * 33,
                                  db.to_minor("USDT", "999999"))
        check("вывод сверх остатка отклонён", False, "разрешён перерасход")
    except TradeError as e:
        check("вывод сверх остатка отклонён", e.code == "INSUFFICIENT_BALANCE", e.code)

    # ── 4. Сведение сделки ───────────────────────────────────────────
    # Bob продаёт 1 BTC по 60000, Alice покупает по рынку
    sell = engine.place_order(bob, "BTC-USDT", "sell", "limit",
                              db.to_minor("BTC", "1"), db.to_minor("USDT", "60000"))
    check("лимитная заявка встала в книгу", sell["status"] == "open", sell["status"])
    check("средства продавца заблокированы",
          db.available_of(bob, "BTC") == db.to_minor("BTC", "1"))

    book = engine.order_book("BTC-USDT")
    check("заявка видна в стакане", len(book["asks"]) == 1, str(book))

    buy = engine.place_order(alice, "BTC-USDT", "buy", "limit",
                             db.to_minor("BTC", "1"), db.to_minor("USDT", "60000"))
    check("встречная заявка исполнилась", buy["status"] == "filled", buy["status"])

    alice_btc = db.available_of(alice, "BTC")
    expected = db.to_minor("BTC", "1")
    fee = expected * int(db.setting("taker_fee_bps")) // 10_000
    check("покупатель получил базовый актив за вычетом комиссии",
          alice_btc == expected - fee, f"{alice_btc} != {expected - fee}")

    bob_usdt = db.available_of(bob, "USDT")
    gross = db.to_minor("USDT", "60000")
    mfee = gross * int(db.setting("maker_fee_bps")) // 10_000
    check("продавец получил котируемый за вычетом комиссии мейкера",
          bob_usdt == gross - mfee, f"{bob_usdt} != {gross - mfee}")

    check("цена сделки — цена мейкера",
          db.q1("SELECT price FROM fills WHERE role='taker'")["price"] == db.to_minor("USDT", "60000"))

    # ── 5. Сохранение суммы ──────────────────────────────────────────
    check("BTC внутри системы сохранился",
          total_in_ledger("BTC") == db.to_minor("BTC", "2"),
          f"{total_in_ledger('BTC')} != {db.to_minor('BTC','2')}")
    check("USDT внутри системы сохранился",
          total_in_ledger("USDT") == db.to_minor("USDT", "100000"),
          f"{total_in_ledger('USDT')} != {db.to_minor('USDT','100000')}")

    # ── 6. Отмена возвращает резерв ──────────────────────────────────
    before = db.available_of(alice, "USDT")
    o = engine.place_order(alice, "BTC-USDT", "buy", "limit",
                           db.to_minor("BTC", "0.5"), db.to_minor("USDT", "10000"))
    locked = db.available_of(alice, "USDT")
    check("резерв под лимитную заявку списан со свободного", locked < before)
    engine.cancel_order(alice, o["id"])
    check("отмена вернула резерв полностью",
          db.available_of(alice, "USDT") == before,
          f"{db.available_of(alice,'USDT')} != {before}")

    # ── 7. Идемпотентность по clientOrderId ──────────────────────────
    a = engine.place_order(alice, "BTC-USDT", "buy", "limit",
                           db.to_minor("BTC", "0.1"), db.to_minor("USDT", "1000"),
                           client_ref="my-ref-1")
    b = engine.place_order(alice, "BTC-USDT", "buy", "limit",
                           db.to_minor("BTC", "0.1"), db.to_minor("USDT", "1000"),
                           client_ref="my-ref-1")
    check("повтор с тем же clientOrderId не создаёт вторую заявку", a["id"] == b["id"])
    engine.cancel_order(alice, a["id"])

    # ── 8. Целостность журнала ───────────────────────────────────────
    integ = db.check_integrity()
    check("журнал сходится (сумма проводок = 0)", integ["balanced"], str(integ["imbalanced_tx"])[:120])
    check("кэш балансов совпадает с журналом", not integ["balance_drift"],
          str(integ["balance_drift"])[:120])

    # ── 9. Пароли ────────────────────────────────────────────────────
    h = security.hash_password("s3cret-pass")
    check("верный пароль принимается", security.verify_password("s3cret-pass", h))
    check("неверный пароль отвергается", not security.verify_password("s3cret-pas", h))
    check("хэш соли уникален", security.hash_password("x") != security.hash_password("x"))

    # ── 10. Подпись запросов ─────────────────────────────────────────
    key, secret, _ = security.new_api_key()
    db.run("""INSERT INTO api_keys(id,user_id,label,api_key,secret_hash,perms)
              VALUES(?,?,?,?,?,?)""",
           (db.gen_id("key"), alice, "test", key,
            security.encrypt_secret(secret), "read,trade"))

    body = '{"market":"BTC-USDT"}'
    ts = str(db.now())
    nonce = "nonce-" + os.urandom(8).hex()
    canon = security.canonical_string("POST", "/v1/orders", ts, nonce, body)
    sig = security.sign(secret, canon)
    hdrs = {"x-api-key": key, "x-timestamp": ts, "x-nonce": nonce, "x-signature": sig}

    try:
        info = security.verify_signed_request(dict(hdrs), "POST", "/v1/orders", body)
        check("корректная подпись принимается", info["user_id"] == alice)
    except Exception as e:
        check("корректная подпись принимается", False, str(e))

    try:
        security.verify_signed_request(dict(hdrs), "POST", "/v1/orders", body)
        check("повтор nonce отклонён", False, "повтор прошёл")
    except Exception as e:
        check("повтор nonce отклонён", getattr(e, "code", "") == "NONCE_REUSED", str(e))

    bad = dict(hdrs, **{"x-nonce": "fresh-" + os.urandom(8).hex(),
                        "x-signature": sig})
    try:
        security.verify_signed_request(bad, "POST", "/v1/orders", body)
        check("подпись, не покрывающая новый nonce, отклонена", False, "прошла")
    except Exception as e:
        check("подпись, не покрывающая новый nonce, отклонена",
              getattr(e, "code", "") == "BAD_SIGNATURE", str(e))

    old = dict(hdrs, **{"x-timestamp": str(db.now() - 600),
                        "x-nonce": "old-" + os.urandom(8).hex()})
    try:
        security.verify_signed_request(old, "POST", "/v1/orders", body)
        check("просроченный запрос отклонён", False, "прошёл")
    except Exception as e:
        check("просроченный запрос отклонён",
              getattr(e, "code", "") == "TIMESTAMP_OUT_OF_WINDOW", str(e))

    # ── 11. Блокировка требует основания ─────────────────────────────
    try:
        db.run("UPDATE users SET status='blocked' WHERE id=?", (bob,))
        check("блокировка без основания отклонена схемой", False, "прошла")
    except Exception:
        check("блокировка без основания отклонена схемой", True)

    print("─" * 62)
    print(f"пройдено: {len(PASS)}   провалено: {len(FAIL)}")
    if FAIL:
        print("не прошли: " + ", ".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
