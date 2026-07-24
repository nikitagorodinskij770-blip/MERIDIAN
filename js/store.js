/* MERIDIAN — состояние песочницы.
   Всё живёт в localStorage. Никакого сервера, никаких реальных средств.
   → PROD: заменяется на REST + WS (см. PLAN.md §4) с серверными балансами. */

import { CONFIG, ASSET_MAP, ASSETS } from './seed.js';
import * as market from './market.js';

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

/* ── Генераторы адресов и хэшей (правдоподобные, но фиктивные) ─────────── */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const HEX = '0123456789abcdef';
const pick = (alphabet, n) =>
  Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

/** Депозит-адрес нужного формата под сеть. → PROD: HD-деривация (PLAN.md §6.5). */
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
    default:               return '0x' + pick(HEX, 40); // ERC20/BEP20/Polygon/Arbitrum/Optimism
  }
}
export function genTxHash(network) {
  // Base58-хэши
  if (network === 'Solana' || network === 'TON') return pick(B58, 64);
  // Голый hex без префикса (UTXO-сети и TRON)
  if (['Bitcoin', 'Lightning', 'Litecoin', 'Bitcoin Cash', 'Dogecoin', 'Monero',
       'TRC20', 'Cardano', 'XRP Ledger', 'Cosmos', 'NEAR'].includes(network)) {
    return pick(HEX, 64);
  }
  // EVM-совместимые сети
  return '0x' + pick(HEX, 64);
}
const genId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ── Начальное состояние ──────────────────────────────────────────────── */
function blank() {
  return {
    v: 1,
    signedIn: false,
    user: null,
    balances: {},
    locked: {},
    transactions: [],
    orders: [],
    earn: [],
    apiKeys: [],
    watchlist: ['BTC', 'ETH', 'SOL', 'TON'],
    settings: { hideBalances: false, display: 'USD', tickerSound: false },
    depositAddrs: {},   // `${asset}|${network}` → адрес (стабилен между визитами)
  };
}

let S = blank();

/* ── Персистентность ──────────────────────────────────────────────────── */
function save() {
  try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(S)); }
  catch (e) { console.warn('localStorage недоступен', e); }
}
function load() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1) S = { ...blank(), ...parsed };
    }
  } catch (e) { console.warn('Не удалось прочитать состояние', e); }
}
function commit() { save(); emit('change', S); }

export function getState() { return S; }
export function isSignedIn() { return !!S.signedIn; }

/* ── Аккаунт ──────────────────────────────────────────────────────────── */

export function signIn({ email = 'demo@meridian.exchange', name = 'Демо-пользователь' } = {}) {
  const fresh = !S.user;
  S.signedIn = true;
  S.user = S.user || {
    id: genId('usr'),
    name, email,
    createdAt: Date.now(),
    kyc: 1,
    twoFA: false,
    tier: 'VIP 0',
    antiPhishing: 'MERIDIAN-' + pick('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5),
  };
  if (fresh) seedDemoPortfolio();
  commit();
  notify('Вход выполнен', 'Демо-счёт активен. Средства эмулированы.', 'ok');
}

export function signOut() {
  S.signedIn = false;
  commit();
  notify('Выход выполнен', 'Данные песочницы сохранены локально.', 'ok');
}

export function resetDemo() {
  S = blank();
  save();
  emit('change', S);
  notify('Песочница сброшена', 'Все демо-данные удалены.', 'warn');
}

/** Стартовый портфель + правдоподобная история. */
function seedDemoPortfolio() {
  S.balances = { ...CONFIG.demoBalances };
  const now = Date.now();
  const hist = [
    { kind: 'deposit', asset: 'USDT', amount: 20000, network: 'TRC20', ago: 32 },
    { kind: 'trade',   asset: 'BTC',  amount: 0.25,  ago: 28, note: 'Куплено за USDT' },
    { kind: 'deposit', asset: 'ETH',  amount: 4.0,   network: 'ERC20', ago: 21 },
    { kind: 'convert', asset: 'SOL',  amount: 40,    ago: 14, note: 'Обмен из USDT' },
    { kind: 'trade',   asset: 'BTC',  amount: 0.162, ago: 9,  note: 'Куплено за USDT' },
    { kind: 'withdraw',asset: 'USDT', amount: 3500,  network: 'TRC20', ago: 4 },
    { kind: 'reward',  asset: 'USDT', amount: 42.18, ago: 1,  note: 'Начисление Earn' },
  ];
  S.transactions = hist.map(h => ({
    id: genId('tx'),
    kind: h.kind,
    asset: h.asset,
    amount: h.amount,
    fee: 0,
    network: h.network || null,
    address: h.network ? genAddress(h.network) : null,
    txHash: h.network ? genTxHash(h.network) : null,
    status: 'completed',
    note: h.note || null,
    ts: now - h.ago * 86_400_000,
  }));
  S.earn = [
    { id: genId('ern'), asset: 'USDT', amount: 5000, apy: 7.2, kind: 'Сберегательный', term: 'Гибкий', since: now - 30 * 86_400_000 },
  ];
}

/* ── Балансы ──────────────────────────────────────────────────────────── */

export function balance(asset) { return S.balances[asset] || 0; }
export function lockedOf(asset) { return S.locked[asset] || 0; }
export function available(asset) { return balance(asset) - lockedOf(asset); }

function credit(asset, amt) {
  S.balances[asset] = (S.balances[asset] || 0) + amt;
}
function debit(asset, amt) {
  if (available(asset) + 1e-12 < amt) {
    const e = new Error(`Недостаточно ${asset}`);
    e.code = 'INSUFFICIENT_BALANCE';
    throw e;
  }
  S.balances[asset] = (S.balances[asset] || 0) - amt;
}

/** Все ненулевые балансы, отсортированные по стоимости в USD. */
export function holdings() {
  return Object.entries(S.balances)
    .filter(([, amt]) => amt > 1e-10)
    .map(([id, amt]) => ({
      id, amount: amt,
      asset: ASSET_MAP[id],
      usd: market.toUSD(id, amt),
    }))
    .sort((a, b) => b.usd - a.usd);
}

/** Итоговая стоимость портфеля в USD. */
export function portfolioValue() {
  return holdings().reduce((s, h) => s + h.usd, 0);
}

/** Изменение стоимости портфеля за 24ч (USD и %). */
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

/** Аллокация портфеля для доната. */
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

/* ── Транзакции ───────────────────────────────────────────────────────── */

function addTx(tx) {
  const rec = { id: genId('tx'), ts: Date.now(), fee: 0, status: 'completed', ...tx };
  S.transactions.unshift(rec);
  if (S.transactions.length > 200) S.transactions.pop();
  return rec;
}
export function transactions(filter = 'all') {
  return filter === 'all' ? S.transactions : S.transactions.filter(t => t.kind === filter);
}

/** Стабильный депозит-адрес для пары актив/сеть. */
export function depositAddress(asset, network) {
  const key = `${asset}|${network}`;
  if (!S.depositAddrs[key]) { S.depositAddrs[key] = genAddress(network); commit(); }
  return S.depositAddrs[key];
}

/* ── Операции (эмулированные) ─────────────────────────────────────────── */

/** Пополнение: транзакция в статусе pending, затем «подтверждение сети». */
export function deposit(asset, network, amount) {
  if (amount <= 0) throw new Error('Некорректная сумма');
  const tx = addTx({
    kind: 'deposit', asset, amount, network,
    address: depositAddress(asset, network),
    txHash: genTxHash(network),
    status: 'pending',
    note: 'Ожидание подтверждений сети',
  });
  commit();
  notify('Пополнение принято', `${amount} ${asset} · ожидание подтверждений`, 'warn');

  // Эмуляция подтверждений сети: 2.5–5 c
  setTimeout(() => {
    const rec = S.transactions.find(t => t.id === tx.id);
    if (!rec) return;
    rec.status = 'completed';
    rec.note = 'Подтверждено сетью';
    credit(asset, amount);
    commit();
    notify('Средства зачислены', `+${amount} ${asset}`, 'ok');
  }, 2500 + Math.random() * 2500);

  return tx;
}

/** Вывод: списание сразу, затем «обработка». */
export function withdraw(asset, network, address, amount) {
  const a = ASSET_MAP[asset];
  const fee = withdrawFee(asset, network);
  const total = amount + fee;
  debit(asset, total);

  const tx = addTx({
    kind: 'withdraw', asset, amount, fee, network, address,
    txHash: genTxHash(network),
    status: 'pending',
    note: 'Обработка заявки',
  });
  commit();
  notify('Заявка на вывод создана', `${amount} ${a?.id} → ${network}`, 'warn');

  setTimeout(() => {
    const rec = S.transactions.find(t => t.id === tx.id);
    if (!rec) return;
    rec.status = 'completed';
    rec.note = 'Отправлено в сеть';
    commit();
    notify('Вывод отправлен', `${amount} ${asset} · ${network}`, 'ok');
  }, 3000 + Math.random() * 2500);

  return tx;
}

/** Комиссия сети за вывод (в единицах актива). */
export function withdrawFee(asset, network) {
  const p = market.price(asset) || 1;
  const usdFee = { Bitcoin: 2.4, Lightning: 0.02, ERC20: 3.8, TRC20: 1.0, BEP20: 0.35,
    Solana: 0.02, TON: 0.05, Polygon: 0.02, Arbitrum: 0.3, Optimism: 0.3,
    Litecoin: 0.05, 'Bitcoin Cash': 0.08, Monero: 0.12, Cardano: 0.25,
    'XRP Ledger': 0.02, Dogecoin: 0.5, Cosmos: 0.05, NEAR: 0.02, Sui: 0.02, Aptos: 0.02,
  }[network] ?? 1.5;
  return usdFee / p;
}

/** Мгновенный обмен from → to по рыночному курсу с комиссией. */
export function convert(from, to, amount) {
  if (from === to) throw new Error('Выберите разные активы');
  if (amount <= 0) throw new Error('Некорректная сумма');
  const q = quoteConvert(from, to, amount);
  debit(from, amount);
  credit(to, q.net);

  addTx({
    kind: 'convert', asset: to, amount: q.net,
    fee: q.fee, feeAsset: to,
    note: `Обмен ${fmtShort(amount)} ${from} → ${to} по курсу ${q.rate.toPrecision(6)}`,
    meta: { from, to, sent: amount, received: q.net },
  });
  commit();
  notify('Обмен выполнен', `${fmtShort(amount)} ${from} → ${fmtShort(q.net)} ${to}`, 'ok');
  return q;
}

/** Котировка обмена (см. PLAN.md §6.3). */
export function quoteConvert(from, to, amount) {
  const r = market.rate(from, to);
  const gross = amount * r;
  const fee = gross * CONFIG.convertFeeRate;
  const net = gross - fee;
  return { rate: r, gross, fee, net, feeRate: CONFIG.convertFeeRate };
}

/** Покупка крипты за фиат картой (эмуляция онрампа). */
export function buyWithCard(fiat, asset, fiatAmount) {
  if (fiatAmount <= 0) throw new Error('Некорректная сумма');
  const fee = fiatAmount * CONFIG.buyCardFeeRate;
  const net = fiatAmount - fee;
  const received = net * market.rate(fiat, asset);

  credit(asset, received);
  addTx({
    kind: 'buy', asset, amount: received,
    fee, feeAsset: fiat,
    status: 'completed',
    note: `Покупка за ${fmtShort(fiatAmount)} ${fiat} · карта ****4417`,
    meta: { fiat, fiatAmount, received },
  });
  commit();
  notify('Покупка выполнена', `+${fmtShort(received)} ${asset}`, 'ok');
  return { received, fee };
}

/* ── Спотовые ордера ──────────────────────────────────────────────────── */

/**
 * Разместить ордер.
 * market — исполняется сразу по текущей цене (тейкер).
 * limit  — встаёт в книгу, средства блокируются, исполнение при пересечении цены.
 */
export function placeOrder({ pair, side, type, price, qty }) {
  const { base, quote } = market.splitPair(pair);
  const px = type === 'market' ? market.pairPrice(pair) : price;
  if (!qty || qty <= 0) throw new Error('Укажите количество');
  if (type === 'limit' && (!px || px <= 0)) throw new Error('Укажите цену');

  const notional = qty * px;

  if (side === 'buy') debit(quote, notional);
  else debit(base, qty);

  const order = {
    id: genId('ord'), pair, side, type,
    price: px, qty, filled: 0,
    status: type === 'market' ? 'filled' : 'open',
    fee: 0, feeAsset: side === 'buy' ? base : quote,
    ts: Date.now(),
  };

  if (type === 'market') {
    settleFill(order, qty, px, CONFIG.takerFee);
    notify('Ордер исполнен', `${side === 'buy' ? 'Куплено' : 'Продано'} ${fmtShort(qty)} ${base}`, 'ok');
  } else {
    S.orders.unshift(order);
    notify('Лимитный ордер размещён', `${side === 'buy' ? 'Покупка' : 'Продажа'} ${fmtShort(qty)} ${base} @ ${px.toPrecision(6)}`, 'ok');
  }
  commit();
  return order;
}

/** Начисление по факту исполнения + запись сделки. */
function settleFill(order, qty, px, feeRate) {
  const { base, quote } = market.splitPair(order.pair);
  const notional = qty * px;
  let fee;
  if (order.side === 'buy') {
    fee = qty * feeRate;
    credit(base, qty - fee);
  } else {
    fee = notional * feeRate;
    credit(quote, notional - fee);
  }
  order.filled = qty;
  order.fee = fee;
  order.status = 'filled';

  addTx({
    kind: 'trade', asset: base,
    amount: order.side === 'buy' ? qty - fee : -qty,
    fee, feeAsset: order.feeAsset,
    note: `${order.side === 'buy' ? 'Покупка' : 'Продажа'} ${base} @ ${px.toPrecision(6)} ${quote}`,
    meta: { pair: order.pair, side: order.side, price: px, qty },
  });
}

export function cancelOrder(id) {
  const i = S.orders.findIndex(o => o.id === id);
  if (i < 0) return;
  const o = S.orders[i];
  const { base, quote } = market.splitPair(o.pair);
  // Возврат заблокированных средств
  if (o.side === 'buy') credit(quote, o.qty * o.price);
  else credit(base, o.qty);
  o.status = 'canceled';
  S.orders.splice(i, 1);
  commit();
  notify('Ордер отменён', `${o.pair} · средства возвращены`, 'warn');
}

export function openOrders() { return S.orders.filter(o => o.status === 'open'); }

/** Проверка лимитных ордеров на каждом тике рынка. */
export function matchLimitOrders() {
  if (!S.orders.length) return;
  let changed = false;
  for (let i = S.orders.length - 1; i >= 0; i--) {
    const o = S.orders[i];
    if (o.status !== 'open') continue;
    const p = market.pairPrice(o.pair);
    const crosses = o.side === 'buy' ? p <= o.price : p >= o.price;
    if (!crosses) continue;
    settleFill(o, o.qty, o.price, CONFIG.makerFee);
    S.orders.splice(i, 1);
    changed = true;
    notify('Лимитный ордер исполнен', `${o.pair} @ ${o.price.toPrecision(6)}`, 'ok');
  }
  if (changed) commit();
}

/* ── Earn ─────────────────────────────────────────────────────────────── */

export function earnSubscribe(product, amount) {
  debit(product.asset, amount);
  S.earn.unshift({
    id: genId('ern'), asset: product.asset, amount,
    apy: product.apy, kind: product.kind, term: product.term, since: Date.now(),
  });
  addTx({ kind: 'earn', asset: product.asset, amount: -amount, note: `Размещено в «${product.kind}» ${product.apy}% годовых` });
  commit();
  notify('Средства размещены', `${fmtShort(amount)} ${product.asset} · ${product.apy}% годовых`, 'ok');
}

export function earnRedeem(id) {
  const i = S.earn.findIndex(e => e.id === id);
  if (i < 0) return;
  const e = S.earn[i];
  const days = (Date.now() - e.since) / 86_400_000;
  const interest = e.amount * (e.apy / 100) * (days / 365);
  credit(e.asset, e.amount + interest);
  S.earn.splice(i, 1);
  addTx({ kind: 'reward', asset: e.asset, amount: e.amount + interest, note: `Возврат из «${e.kind}» + доход ${fmtShort(interest)}` });
  commit();
  notify('Средства возвращены', `+${fmtShort(e.amount + interest)} ${e.asset}`, 'ok');
}

export function earnPositions() { return S.earn; }

/** Накопленный доход по всем позициям Earn. */
export function earnAccrued() {
  return S.earn.reduce((s, e) => {
    const days = (Date.now() - e.since) / 86_400_000;
    return s + market.toUSD(e.asset, e.amount * (e.apy / 100) * (days / 365));
  }, 0);
}

/* ── Прочее ───────────────────────────────────────────────────────────── */

export function toggleWatch(id) {
  const i = S.watchlist.indexOf(id);
  if (i >= 0) S.watchlist.splice(i, 1); else S.watchlist.push(id);
  commit();
}
export function isWatched(id) { return S.watchlist.includes(id); }

export function updateSettings(patch) { Object.assign(S.settings, patch); commit(); }
export function updateUser(patch) { Object.assign(S.user, patch); commit(); }

export function createApiKey(label) {
  const key = { id: genId('key'), label, key: pick(HEX, 32), secret: pick(HEX, 48), created: Date.now(), perms: ['read'] };
  S.apiKeys.unshift(key);
  commit();
  notify('API-ключ создан', 'Секрет показывается один раз (демо).', 'ok');
  return key;
}
export function revokeApiKey(id) {
  S.apiKeys = S.apiKeys.filter(k => k.id !== id);
  commit();
  notify('Ключ отозван', '', 'warn');
}

/** Экспорт/импорт состояния песочницы. */
export function exportState() { return JSON.stringify(S, null, 2); }
export function importState(json) {
  const parsed = JSON.parse(json);
  if (!parsed || parsed.v !== 1) throw new Error('Неподдерживаемый формат');
  S = { ...blank(), ...parsed };
  commit();
  notify('Состояние импортировано', '', 'ok');
}

function fmtShort(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(4).replace(/\.?0+$/, '');
  return n.toPrecision(4);
}

/* ── Инициализация ────────────────────────────────────────────────────── */
load();
export const store = {
  on, getState, isSignedIn, signIn, signOut, resetDemo,
  balance, available, holdings, portfolioValue, portfolioChange24, allocation,
  transactions, depositAddress, deposit, withdraw, withdrawFee,
  convert, quoteConvert, buyWithCard,
  placeOrder, cancelOrder, openOrders, matchLimitOrders,
  earnSubscribe, earnRedeem, earnPositions, earnAccrued,
  toggleWatch, isWatched, updateSettings, updateUser,
  createApiKey, revokeApiKey, exportState, importState,
  genAddress, genTxHash,
};
export default store;
