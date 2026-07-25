/* MERIDIAN — торговое состояние поверх Supabase.

   Раньше здесь жила песочница в localStorage. Теперь балансы, заявки, история
   и продукты доходности приходят из базы через RLS и денежные RPC-функции —
   единственный способ изменить баланс. Публичный API модуля сохранён прежним,
   поэтому представления не меняются: они по-прежнему читают синхронный кэш S,
   а мутации обновляют его оптимистично и тут же сверяются с базой.

   Клиентские предпочтения (избранное, отображение, демо-ключи API) остаются
   в localStorage — это не деньги, серверу они не нужны. */

import { CONFIG, ASSET_MAP } from './seed.js';
import * as market from './market.js';
import * as sb from './api/supabase.js';
import * as session from './core/session.js';

/* ── Мини-эмиттер ─────────────────────────────────────────────────────── */
const bus = {};
export function on(evt, fn) {
  (bus[evt] ||= new Set()).add(fn);
  return () => bus[evt].delete(fn);
}
function emit(evt, payload) {
  (bus[evt] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
}
function notify(title, msg, kind = 'ok') { emit('notify', { title, msg, kind }); }

/* ── Генераторы адресов и хэшей (правдоподобные, для отображения) ──────── */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const HEX = '0123456789abcdef';
const pick = (alphabet, n) =>
  Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

export function genAddress(network) {
  switch (network) {
    case 'Bitcoin':        return 'bc1q' + pick(B32, 38);
    case 'Lightning':      return 'lnbc1' + pick(B32, 42);
    case 'Litecoin':       return 'ltc1q' + pick(B32, 38);
    case 'Bitcoin Cash':   return 'bitcoincash:q' + pick(B32, 41);
    case 'TRC20':          return 'T' + pick(B58, 33);
    case 'Solana':         return pick(B58, 44);
    case 'TON':            return 'UQ' + pick(B58, 46);
    case 'Cardano':        return 'addr1q' + pick(B32, 52);
    case 'XRP Ledger':     return 'r' + pick(B58, 32);
    case 'Monero':         return '4' + pick(B58, 94);
    case 'Cosmos':         return 'cosmos1' + pick(B32, 38);
    case 'Dogecoin':       return 'D' + pick(B58, 33);
    case 'NEAR':           return pick('0123456789abcdef', 64);
    case 'Sui':
    case 'Aptos':          return '0x' + pick(HEX, 64);
    case 'SEPA':           return 'EE' + pick('0123456789', 18);
    default:               return '0x' + pick(HEX, 40);
  }
}
export function genTxHash(network) {
  if (network === 'Solana' || network === 'TON') return pick(B58, 64);
  if (['Bitcoin', 'Lightning', 'Litecoin', 'Bitcoin Cash', 'Dogecoin', 'Monero',
       'TRC20', 'Cardano', 'XRP Ledger', 'Cosmos', 'NEAR', 'SEPA'].includes(network)) {
    return pick(HEX, 64);
  }
  return '0x' + pick(HEX, 64);
}
const genId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ── Состояние ────────────────────────────────────────────────────────── */
function blankPrefs() {
  return {
    watchlist: ['BTC', 'ETH', 'SOL', 'TON'],
    settings: { hideBalances: false, display: 'USD', tickerSound: false },
    apiKeys: [],
    depositAddrs: {},   // `${asset}|${network}` → адрес (стабилен между визитами)
  };
}

const S = {
  avail: {},          // свободный остаток (человеческие единицы)
  locked: {},         // заблокировано под заявки
  transactions: [],   // депозиты, выводы, обмены, покупки
  orders: [],         // открытые заявки
  earn: [],           // позиции доходности
  user: null,         // профиль из session
  ...blankPrefs(),
};

const PREFS_KEY = 'meridian.prefs.v1';
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) Object.assign(S, blankPrefs(), JSON.parse(raw));
  } catch { /* приватный режим */ }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      watchlist: S.watchlist, settings: S.settings,
      apiKeys: S.apiKeys, depositAddrs: S.depositAddrs,
    }));
  } catch { /* переживём */ }
}
loadPrefs();

export function getState() { return S; }
export function isSignedIn() { return session.isSignedIn(); }

/* ── Гидратация из базы ───────────────────────────────────────────────── */

function splitPair(sym) {
  const [base, quote] = sym.split('-');
  return { base, quote };
}

let hydrating = null;

/** Перечитывает балансы, заявки, историю и доходность из базы. */
export async function hydrate() {
  if (!session.isSignedIn()) { clearAccount(); emit('change', S); return; }
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      await session.refresh();                       // авторитетные балансы + профиль + шапка
      const st = session.get();
      const uid = sb.currentUser()?.id;

      S.avail = {}; S.locked = {};
      (st.balances || []).forEach(b => {
        S.avail[b.asset] = b.available;
        S.locked[b.asset] = b.locked;
      });

      const p = st.user || {};
      S.user = {
        id: uid, name: p.name || p.display_name || p.email, email: p.email,
        kyc: p.kycLevel ?? p.kyc_level ?? 0, twoFA: !!p.twoFA,
        tier: 'VIP 0', antiPhishing: p.antiPhishing || p.anti_phishing || '',
        createdAt: p.createdAt || 0,
      };

      const [orders, txs, earn] = await Promise.all([
        sb.select('orders', {
          columns: 'id,market,side,type,price,quantity,filled,status,created_at',
          filters: { user_id: `eq.${uid}`, status: 'in.(open,partially_filled)' },
          order: 'created_at.desc',
        }),
        sb.select('transactions', {
          columns: 'id,kind,asset_id,network_id,amount,fee,address,tx_hash,status,note,created_at',
          filters: { user_id: `eq.${uid}` }, order: 'created_at.desc', limit: 100,
        }),
        sb.select('earn_positions', {
          columns: 'id,asset_id,amount,apy,product,term,opened_at',
          filters: { user_id: `eq.${uid}`, status: 'eq.active' }, order: 'opened_at.desc',
        }),
      ]);

      S.orders = orders.map(o => {
        const { base, quote } = splitPair(o.market);
        return {
          id: o.id, pair: o.market, side: o.side, type: o.type,
          price: sb.toNumber(quote, o.price), qty: sb.toNumber(base, o.quantity),
          filled: sb.toNumber(base, o.filled), status: o.status,
          ts: new Date(o.created_at).getTime(),
        };
      });

      S.transactions = txs.map(t => ({
        id: t.id, kind: t.kind, asset: t.asset_id, network: t.network_id,
        amount: sb.toNumber(t.asset_id, t.amount), fee: sb.toNumber(t.asset_id, t.fee),
        address: t.address, txHash: t.tx_hash, status: t.status, note: t.note,
        ts: new Date(t.created_at).getTime(),
      }));

      S.earn = earn.map(e => ({
        id: e.id, asset: e.asset_id, amount: sb.toNumber(e.asset_id, e.amount),
        apy: Number(e.apy), kind: e.product, term: e.term,
        since: new Date(e.opened_at).getTime(),
      }));

      emit('change', S);
    } catch (e) {
      console.warn('hydrate failed', e);
    } finally {
      hydrating = null;
    }
  })();
  return hydrating;
}

function clearAccount() {
  S.avail = {}; S.locked = {}; S.transactions = []; S.orders = []; S.earn = []; S.user = null;
}

/* Автогидратация при входе/выходе: следим за сменой пользователя в сессии. */
let boundUid = null;
session.on('change', () => {
  const uid = session.get().user?.id || null;
  if (uid && uid !== boundUid) { boundUid = uid; hydrate(); }
  else if (!uid && boundUid) { boundUid = null; clearAccount(); emit('change', S); }
});

/* ── Балансы ──────────────────────────────────────────────────────────── */

export function balance(asset) { return (S.avail[asset] || 0) + (S.locked[asset] || 0); }
export function lockedOf(asset) { return S.locked[asset] || 0; }
export function available(asset) { return S.avail[asset] || 0; }

export function holdings() {
  const ids = new Set([...Object.keys(S.avail), ...Object.keys(S.locked)]);
  return [...ids]
    .map(id => ({ id, amount: balance(id) }))
    .filter(h => h.amount > 1e-10)
    .map(h => ({ id: h.id, amount: h.amount, asset: ASSET_MAP[h.id], usd: market.toUSD(h.id, h.amount) }))
    .sort((a, b) => b.usd - a.usd);
}

export function portfolioValue() {
  return holdings().reduce((s, h) => s + h.usd, 0);
}

export function portfolioChange24() {
  let now = 0, then = 0;
  holdings().forEach(h => {
    const p = market.price(h.id);
    const chg = market.change24(h.id) / 100;
    now += p * h.amount;
    then += (p / (1 + chg)) * h.amount;
  });
  return { abs: now - then, pct: then ? (now / then - 1) * 100 : 0 };
}

export function allocation(maxSlices = 6) {
  const h = holdings();
  const total = h.reduce((s, x) => s + x.usd, 0) || 1;
  const top = h.slice(0, maxSlices).map(x => ({
    id: x.id, usd: x.usd, pct: (x.usd / total) * 100,
    color: x.asset?.color || '#9aa3af',
  }));
  const rest = h.slice(maxSlices).reduce((s, x) => s + x.usd, 0);
  if (rest > 0) top.push({ id: 'Прочее', usd: rest, pct: (rest / total) * 100, color: '#c8ccd4' });
  return top;
}

/* ── История ──────────────────────────────────────────────────────────── */

export function transactions(filter = 'all') {
  return filter === 'all' ? S.transactions : S.transactions.filter(t => t.kind === filter);
}

export function depositAddress(asset, network) {
  const key = `${asset}|${network}`;
  if (!S.depositAddrs[key]) { S.depositAddrs[key] = genAddress(network); savePrefs(); }
  return S.depositAddrs[key];
}

/* ── Ошибки RPC → человеческий текст ──────────────────────────────────── */
function mapErr(e) {
  const m = {
    INSUFFICIENT_BALANCE: 'Недостаточно средств',
    NETWORK_NOT_SUPPORTED: 'Сеть недоступна для этого актива',
    BELOW_MIN: 'Сумма меньше минимальной',
    KYC_REQUIRED: 'Требуется верификация',
    NO_PRICE: 'Нет котировки для пары',
    NO_LIQUIDITY: 'В книге нет встречных заявок',
    TRADING_DISABLED: 'Торговля временно приостановлена',
    OPERATION_FROZEN: 'Операции по счёту приостановлены',
    DUST_AMOUNT: 'Слишком маленькая сумма',
  };
  return m[e?.code] || e?.message || 'Повторите попытку';
}

/* ── Операции. Оптимистично меняем кэш, затем сверяемся с базой. ───────── */

function optDebit(asset, amt) { S.avail[asset] = (S.avail[asset] || 0) - amt; }
function optCredit(asset, amt) { S.avail[asset] = (S.avail[asset] || 0) + amt; }
function ensureFunds(asset, amt) {
  if (available(asset) + 1e-9 < amt) {
    const e = new Error(`Недостаточно ${asset}`); e.code = 'INSUFFICIENT_BALANCE'; throw e;
  }
}

/** Пополнение. deposit_funds зачисляет мгновенно; показываем как подтверждённое. */
export function deposit(asset, network, amount) {
  if (amount <= 0) throw new Error('Некорректная сумма');
  const tx = {
    id: genId('tx'), kind: 'deposit', asset, amount, fee: 0, network,
    address: depositAddress(asset, network), txHash: genTxHash(network),
    status: 'pending', note: 'Ожидание подтверждений сети', ts: Date.now(),
  };
  S.transactions.unshift(tx);
  emit('change', S);
  notify('Пополнение принято', `${amount} ${asset} · сеть ${network}`, 'warn');

  sb.rpc('deposit_funds', {
    p_asset: asset, p_network: network, p_amount: sb.toMinor(asset, amount), p_tx_hash: tx.txHash,
  }).then(() => { hydrate(); notify('Средства зачислены', `+${amount} ${asset}`, 'ok'); })
    .catch(e => { hydrate(); notify('Пополнение отклонено', mapErr(e), 'err'); });
  return tx;
}

/** Вывод: списываем сразу, затем подтверждаем в базе. */
export function withdraw(asset, network, address, amount) {
  const fee = withdrawFee(asset, network);
  ensureFunds(asset, amount + fee);
  optDebit(asset, amount + fee);
  const tx = {
    id: genId('tx'), kind: 'withdraw', asset, amount, fee, network, address,
    txHash: genTxHash(network), status: 'pending', note: 'Обработка заявки', ts: Date.now(),
  };
  S.transactions.unshift(tx);
  emit('change', S);
  notify('Заявка на вывод создана', `${amount} ${asset} → ${network}`, 'warn');

  sb.rpc('withdraw_funds', {
    p_asset: asset, p_network: network, p_address: address, p_amount: sb.toMinor(asset, amount),
  }).then(() => { hydrate(); notify('Вывод отправлен', `${amount} ${asset} · ${network}`, 'ok'); })
    .catch(e => { hydrate(); notify('Вывод отклонён', mapErr(e), 'err'); });
  return tx;
}

/** Комиссия сети за вывод (оценка для отображения; окончательную берёт база). */
export function withdrawFee(asset, network) {
  const p = market.price(asset) || 1;
  const usdFee = { Bitcoin: 2.4, Lightning: 0.02, ERC20: 3.8, TRC20: 1.0, BEP20: 0.35,
    Solana: 0.02, TON: 0.05, Polygon: 0.02, Arbitrum: 0.3, Optimism: 0.3, SEPA: 0.5,
    Litecoin: 0.05, 'Bitcoin Cash': 0.08, Monero: 0.12, Cardano: 0.25,
    'XRP Ledger': 0.02, Dogecoin: 0.5, Cosmos: 0.05, NEAR: 0.02, Sui: 0.02, Aptos: 0.02,
  }[network] ?? 1.5;
  return usdFee / p;
}

/** Мгновенный обмен from → to по своду цен. */
export function convert(from, to, amount) {
  if (from === to) throw new Error('Выберите разные активы');
  if (amount <= 0) throw new Error('Некорректная сумма');
  ensureFunds(from, amount);
  const q = quoteConvert(from, to, amount);
  optDebit(from, amount); optCredit(to, q.net);
  S.transactions.unshift({
    id: genId('tx'), kind: 'convert', asset: to, amount: q.net, fee: q.fee,
    status: 'completed', note: `Обмен ${from} → ${to}`, ts: Date.now(),
  });
  emit('change', S);
  notify('Обмен выполнен', `${from} → ${to}`, 'ok');

  sb.rpc('convert_funds', { p_from: from, p_to: to, p_amount: sb.toMinor(from, amount) })
    .then(() => hydrate())
    .catch(e => { hydrate(); notify('Обмен не выполнен', mapErr(e), 'err'); });
  return q;
}

/** Клиентская оценка обмена (для предпросмотра). */
export function quoteConvert(from, to, amount) {
  const r = market.rate(from, to);
  const gross = amount * r;
  const fee = gross * CONFIG.convertFeeRate;
  return { rate: r, gross, fee, net: gross - fee, feeRate: CONFIG.convertFeeRate };
}

/** Покупка криптовалюты за фиат картой. */
export function buyWithCard(fiat, asset, fiatAmount) {
  if (fiatAmount <= 0) throw new Error('Некорректная сумма');
  const fee = fiatAmount * CONFIG.buyCardFeeRate;
  const received = (fiatAmount - fee) * market.rate(fiat, asset);
  optCredit(asset, received);
  S.transactions.unshift({
    id: genId('tx'), kind: 'buy', asset, amount: received, fee: 0,
    status: 'completed', note: `Покупка за ${fiatAmount} ${fiat} картой`, ts: Date.now(),
  });
  emit('change', S);
  notify('Покупка выполнена', `+${asset}`, 'ok');

  sb.rpc('buy_with_card', { p_fiat: fiat, p_asset: asset, p_fiat_amount: sb.toMinor(fiat, fiatAmount) })
    .then(() => hydrate())
    .catch(e => { hydrate(); notify('Покупка отклонена', mapErr(e), 'err'); });
  return { received, fee };
}

/* ── Спотовые заявки ──────────────────────────────────────────────────── */

/**
 * Рыночная заявка исполняется сразу против площадки по своду цен.
 * Лимитная встаёт в книгу и ждёт встречной цены.
 */
export function placeOrder({ pair, side, type, price, qty }) {
  const { base, quote } = splitPair(pair);
  const px = type === 'market' ? market.pairPrice(pair) : price;
  if (!qty || qty <= 0) throw new Error('Укажите количество');
  if (type === 'limit' && (!px || px <= 0)) throw new Error('Укажите цену');

  const notional = qty * px;
  if (side === 'buy') ensureFunds(quote, notional); else ensureFunds(base, qty);

  // Оптимистичный резерв/исполнение
  if (type === 'market') {
    if (side === 'buy') { optDebit(quote, notional); optCredit(base, qty * (1 - CONFIG.takerFee)); }
    else { optDebit(base, qty); optCredit(quote, notional * (1 - CONFIG.takerFee)); }
  } else {
    if (side === 'buy') optDebit(quote, notional); else optDebit(base, qty);
  }
  emit('change', S);

  if (type === 'market') {
    sb.rpc('market_swap', { p_base: base, p_quote: quote, p_side: side, p_base_qty: sb.toMinor(base, qty) })
      .then(() => { hydrate(); notify('Ордер исполнен', `${side === 'buy' ? 'Куплено' : 'Продано'} ${base}`, 'ok'); })
      .catch(e => { hydrate(); notify('Ордер отклонён', mapErr(e), 'err'); });
  } else {
    sb.rpc('place_order', {
      p_market: pair, p_side: side, p_type: 'limit',
      p_quantity: sb.toMinor(base, qty), p_price: sb.toMinor(quote, px),
    }).then(() => { hydrate(); notify('Лимитный ордер размещён', `${pair} @ ${px}`, 'ok'); })
      .catch(e => { hydrate(); notify('Ордер отклонён', mapErr(e), 'err'); });
  }
  return { id: genId('ord'), pair, side, type, price: px, qty, status: type === 'market' ? 'filled' : 'open' };
}

export function cancelOrder(id) {
  const o = S.orders.find(x => x.id === id || String(x.id) === String(id));
  if (!o) return;
  S.orders = S.orders.filter(x => x !== o);        // оптимистично убираем
  emit('change', S);
  sb.rpc('cancel_order', { p_order: Number(id) })
    .then(() => { hydrate(); notify('Ордер отменён', `${o.pair} · средства возвращены`, 'warn'); })
    .catch(e => { hydrate(); notify('Не удалось отменить', mapErr(e), 'err'); });
}

export function openOrders() { return S.orders.filter(o => o.status === 'open' || o.status === 'partially_filled'); }

/** Совмещение лимитных заявок происходит на сервере при размещении. */
export function matchLimitOrders() { /* серверный матчинг, клиенту делать нечего */ }

/* ── Доходность ───────────────────────────────────────────────────────── */

export function earnSubscribe(product, amount) {
  ensureFunds(product.asset, amount);
  optDebit(product.asset, amount);
  S.earn.unshift({
    id: genId('ern'), asset: product.asset, amount, apy: product.apy,
    kind: product.kind, term: product.term, since: Date.now(),
  });
  emit('change', S);
  notify('Средства размещены', `${amount} ${product.asset} · ${product.apy}% годовых`, 'ok');

  sb.rpc('earn_subscribe', {
    p_asset: product.asset, p_amount: sb.toMinor(product.asset, amount),
    p_apy: product.apy, p_product: product.kind, p_term: product.term,
  }).then(() => hydrate())
    .catch(e => { hydrate(); notify('Не удалось разместить', mapErr(e), 'err'); });
}

export function earnRedeem(id) {
  const e = S.earn.find(x => x.id === id || String(x.id) === String(id));
  if (!e) return;
  S.earn = S.earn.filter(x => x !== e);
  const days = (Date.now() - e.since) / 86_400_000;
  const interest = e.amount * (e.apy / 100) * (days / 365);
  optCredit(e.asset, e.amount + interest);
  emit('change', S);
  notify('Средства возвращены', `+${e.asset}`, 'ok');

  sb.rpc('earn_redeem', { p_id: Number(id) })
    .then(() => hydrate())
    .catch(err => { hydrate(); notify('Не удалось вернуть', mapErr(err), 'err'); });
}

export function earnPositions() { return S.earn; }

export function earnAccrued() {
  return S.earn.reduce((s, e) => {
    const days = (Date.now() - e.since) / 86_400_000;
    return s + market.toUSD(e.asset, e.amount * (e.apy / 100) * (days / 365));
  }, 0);
}

/* ── Избранное и настройки (клиентские предпочтения) ──────────────────── */

export function toggleWatch(id) {
  const i = S.watchlist.indexOf(id);
  if (i >= 0) S.watchlist.splice(i, 1); else S.watchlist.push(id);
  savePrefs(); emit('change', S);
}
export function isWatched(id) { return S.watchlist.includes(id); }

export function updateSettings(patch) { Object.assign(S.settings, patch); savePrefs(); emit('change', S); }

/** Правка профиля: имя и антифишинг-код уходят в базу, прочее локально. */
export function updateUser(patch) {
  Object.assign(S.user, patch);
  emit('change', S);
  const uid = sb.currentUser()?.id;
  if (!uid) return;
  const db = {};
  if ('name' in patch) db.display_name = patch.name;
  if ('antiPhishing' in patch) db.anti_phishing = patch.antiPhishing;
  if (Object.keys(db).length) {
    sb.update('profiles', { id: `eq.${uid}` }, db).then(() => session.refresh()).catch(() => {});
  }
}

/* ── Ключи API (демонстрационные, только в браузере) ──────────────────── */

export function createApiKey(label) {
  const key = { id: genId('key'), label, key: pick(HEX, 32), secret: pick(HEX, 48), created: Date.now(), perms: ['read'] };
  S.apiKeys.unshift(key); savePrefs(); emit('change', S);
  notify('API-ключ создан', 'Секрет показывается один раз.', 'ok');
  return key;
}
export function revokeApiKey(id) {
  S.apiKeys = S.apiKeys.filter(k => k.id !== id); savePrefs(); emit('change', S);
  notify('Ключ отозван', '', 'warn');
}

/* ── Вход/выход (управление — на стороне гейта и сессии) ───────────────── */

export function signIn() { location.hash = '#/enter'; }
export async function signOut() {
  try { await session.signOut(); } finally { location.hash = '#/enter'; }
}

/** Сбрасывает клиентские предпочтения (баланс живёт в базе — его не трогаем). */
export function resetDemo() {
  Object.assign(S, blankPrefs());
  savePrefs(); emit('change', S);
  notify('Настройки сброшены', 'Локальные предпочтения очищены.', 'warn');
}

export function exportState() {
  return JSON.stringify({
    balances: S.avail, locked: S.locked, orders: S.orders,
    transactions: S.transactions, earn: S.earn, prefs: {
      watchlist: S.watchlist, settings: S.settings,
    },
  }, null, 2);
}
export function importState() {
  notify('Импорт недоступен', 'Данные счёта хранятся на сервере.', 'warn');
}

/* ── Инициализация ────────────────────────────────────────────────────── */
if (session.isSignedIn()) { boundUid = sb.currentUser()?.id || null; hydrate(); }

export const store = {
  on, getState, isSignedIn, signIn, signOut, resetDemo, hydrate,
  balance, lockedOf, available, holdings, portfolioValue, portfolioChange24, allocation,
  transactions, depositAddress, deposit, withdraw, withdrawFee,
  convert, quoteConvert, buyWithCard,
  placeOrder, cancelOrder, openOrders, matchLimitOrders,
  earnSubscribe, earnRedeem, earnPositions, earnAccrued,
  toggleWatch, isWatched, updateSettings, updateUser,
  createApiKey, revokeApiKey, exportState, importState,
  genAddress, genTxHash,
};
export default store;
