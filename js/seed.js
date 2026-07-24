/* MERIDIAN — справочник активов, конфигурация бренда, реквизиты.
   Цены — стартовые опорные значения для песочницы (движок далее блуждает от них).
   В проде этот справочник приходит из GET /v1/assets, а цены — из WS-стрима. */

export const BRAND = {
  name: 'MERIDIAN',
  legalName: 'Meridian Digital Assets OÜ',
  tagline: 'Опорная линия цифровых рынков',
  taglineEn: 'Trade at the meridian of markets',
  domain: 'meridian.exchange',
  regNo: 'РЕГ. № 16482911 (демо)',
  vasp: 'VASP-лицензия FVT000412 (демо)',
  founded: 2021,
  addresses: [
    { label: 'Головной офис', lines: ['Harju maakond, Tallinn', 'Narva mnt 5, 10117', 'Эстония'] },
    { label: 'Операционный центр', lines: ['Dubai Silicon Oasis, DDP', 'Building A2, Дубай', 'ОАЭ'] },
    { label: 'Support-хаб', lines: ['1 Finsbury Avenue', 'London EC2M 2PF', 'Великобритания'] },
  ],
  contacts: {
    support: 'support@meridian.exchange',
    compliance: 'compliance@meridian.exchange',
    legal: 'legal@meridian.exchange',
    press: 'press@meridian.exchange',
    phone: '+372 605 0114',
  },
  stats: {
    volume24h: 4_180_000_000,
    users: 3_240_000,
    assets: 36,
    countries: 118,
    uptime: 99.98,
  },
};

/* Конфигурация песочницы и торговых правил */
export const CONFIG = {
  storageKey: 'meridian.sandbox.v1',
  baseCurrency: 'USD',           // все цены хранятся в USD за 1 единицу
  tickMs: 1600,                  // частота обновления цен
  convertFeeRate: 0.0035,        // 0.35% комиссия обмена
  makerFee: 0.0010,              // 0.10%
  takerFee: 0.0015,              // 0.15%
  buyCardFeeRate: 0.0180,        // 1.80% онрамп картой
  candleCount: 120,              // сколько свечей держим в истории
  demoBalances: {                // стартовый демо-портфель
    USDT: 24500, USD: 3200, BTC: 0.4120, ETH: 5.80,
    SOL: 62, EUR: 1500, USDC: 5000, TON: 340,
  },
};

/* Интервалы графика: код → мс на свечу */
export const INTERVALS = {
  '1м': 60_000, '5м': 300_000, '15м': 900_000,
  '1ч': 3_600_000, '4ч': 14_400_000, '1д': 86_400_000,
};

/*  Активы. price — стартовая цена в USD за 1 единицу.
    vol — суточная волатильность (сигма) для генератора.
    dec — знаков после запятой при выводе количества.  */
export const ASSETS = [
  // ─── Крипто ───────────────────────────────────────────────────────────
  { id:'BTC',  name:'Bitcoin',      type:'crypto', price:67240,   vol:.030, dec:8, color:'#f7931a', mcap:1_326_000_000_000, supply:19_720_000,   nets:['Bitcoin','BEP20','Lightning'] },
  { id:'ETH',  name:'Ethereum',     type:'crypto', price:3482,    vol:.036, dec:6, color:'#627eea', mcap:418_400_000_000,   supply:120_200_000,  nets:['ERC20','Arbitrum','Optimism','BEP20'] },
  { id:'BNB',  name:'BNB',          type:'crypto', price:592.4,   vol:.034, dec:4, color:'#f0b90b', mcap:87_300_000_000,    supply:147_400_000,  nets:['BEP20','BEP2'] },
  { id:'SOL',  name:'Solana',       type:'crypto', price:168.20,  vol:.052, dec:4, color:'#14f195', mcap:78_600_000_000,    supply:467_000_000,  nets:['Solana'] },
  { id:'XRP',  name:'XRP',          type:'crypto', price:0.6215,  vol:.045, dec:2, color:'#23292f', mcap:34_800_000_000,    supply:56_000_000_000, nets:['XRP Ledger'] },
  { id:'TON',  name:'Toncoin',      type:'crypto', price:6.842,   vol:.048, dec:3, color:'#0098ea', mcap:23_900_000_000,    supply:3_490_000_000, nets:['TON'] },
  { id:'ADA',  name:'Cardano',      type:'crypto', price:0.4812,  vol:.047, dec:2, color:'#0033ad', mcap:17_100_000_000,    supply:35_500_000_000, nets:['Cardano','BEP20'] },
  { id:'DOGE', name:'Dogecoin',     type:'crypto', price:0.1452,  vol:.062, dec:1, color:'#c2a633', mcap:21_200_000_000,    supply:146_000_000_000, nets:['Dogecoin','BEP20'] },
  { id:'TRX',  name:'TRON',         type:'crypto', price:0.1284,  vol:.038, dec:2, color:'#eb0029', mcap:11_200_000_000,    supply:87_200_000_000, nets:['TRC20'] },
  { id:'AVAX', name:'Avalanche',    type:'crypto', price:34.18,   vol:.055, dec:4, color:'#e84142', mcap:13_400_000_000,    supply:392_000_000,  nets:['C-Chain','ERC20'] },
  { id:'DOT',  name:'Polkadot',     type:'crypto', price:6.418,   vol:.050, dec:3, color:'#e6007a', mcap:9_200_000_000,     supply:1_430_000_000, nets:['Polkadot'] },
  { id:'LINK', name:'Chainlink',    type:'crypto', price:16.84,   vol:.051, dec:4, color:'#2a5ada', mcap:9_900_000_000,     supply:587_000_000,  nets:['ERC20','BEP20'] },
  { id:'MATIC',name:'Polygon',      type:'crypto', price:0.7245,  vol:.054, dec:2, color:'#8247e5', mcap:7_100_000_000,     supply:9_800_000_000, nets:['Polygon','ERC20'] },
  { id:'LTC',  name:'Litecoin',     type:'crypto', price:84.52,   vol:.040, dec:5, color:'#345d9d', mcap:6_300_000_000,     supply:74_600_000,   nets:['Litecoin','BEP20'] },
  { id:'BCH',  name:'Bitcoin Cash', type:'crypto', price:452.10,  vol:.044, dec:5, color:'#8dc351', mcap:8_900_000_000,     supply:19_700_000,   nets:['Bitcoin Cash'] },
  { id:'ATOM', name:'Cosmos',       type:'crypto', price:8.912,   vol:.049, dec:3, color:'#2e3148', mcap:3_480_000_000,     supply:390_000_000,  nets:['Cosmos'] },
  { id:'XMR',  name:'Monero',       type:'crypto', price:168.40,  vol:.038, dec:5, color:'#ff6600', mcap:3_100_000_000,     supply:18_400_000,   nets:['Monero'] },
  { id:'NEAR', name:'NEAR Protocol',type:'crypto', price:6.124,   vol:.057, dec:3, color:'#111111', mcap:6_700_000_000,     supply:1_090_000_000, nets:['NEAR','ERC20'] },
  { id:'ARB',  name:'Arbitrum',     type:'crypto', price:1.024,   vol:.060, dec:2, color:'#28a0f0', mcap:3_200_000_000,     supply:3_130_000_000, nets:['Arbitrum','ERC20'] },
  { id:'OP',   name:'Optimism',     type:'crypto', price:2.246,   vol:.061, dec:3, color:'#ff0420', mcap:2_400_000_000,     supply:1_070_000_000, nets:['Optimism','ERC20'] },
  { id:'SUI',  name:'Sui',          type:'crypto', price:1.418,   vol:.064, dec:3, color:'#4da2ff', mcap:3_900_000_000,     supply:2_750_000_000, nets:['Sui'] },
  { id:'APT',  name:'Aptos',        type:'crypto', price:8.412,   vol:.058, dec:3, color:'#1a1a1a', mcap:4_100_000_000,     supply:487_000_000,  nets:['Aptos'] },

  // ─── Стейблкоины ──────────────────────────────────────────────────────
  { id:'USDT', name:'Tether USD',   type:'stable', price:1.0002,  vol:.0006, dec:2, color:'#26a17b', mcap:112_000_000_000, supply:112_000_000_000, nets:['TRC20','ERC20','BEP20','Solana','Polygon'] },
  { id:'USDC', name:'USD Coin',     type:'stable', price:0.9999,  vol:.0006, dec:2, color:'#2775ca', mcap:34_000_000_000,  supply:34_000_000_000,  nets:['ERC20','Solana','BEP20','Arbitrum'] },
  { id:'DAI',  name:'Dai',          type:'stable', price:1.0001,  vol:.0008, dec:2, color:'#f5ac37', mcap:5_300_000_000,   supply:5_300_000_000,   nets:['ERC20','Polygon'] },
  { id:'FDUSD',name:'First Digital USD', type:'stable', price:0.9998, vol:.0008, dec:2, color:'#0b6cff', mcap:2_600_000_000, supply:2_600_000_000, nets:['ERC20','BEP20'] },

  // ─── Фиат (не-крипто) ─────────────────────────────────────────────────
  { id:'USD', name:'Доллар США',    type:'fiat', price:1,        vol:.0000, dec:2, color:'#2e7d32', rails:['SWIFT','Карта'] },
  { id:'EUR', name:'Евро',          type:'fiat', price:1.0824,   vol:.0035, dec:2, color:'#1565c0', rails:['SEPA','Карта'] },
  { id:'GBP', name:'Фунт стерлингов', type:'fiat', price:1.2684, vol:.0038, dec:2, color:'#6a1b9a', rails:['Faster Payments'] },
  { id:'RUB', name:'Российский рубль', type:'fiat', price:0.01064, vol:.0060, dec:2, color:'#c62828', rails:['СБП','Карта'] },
  { id:'AED', name:'Дирхам ОАЭ',    type:'fiat', price:0.27226,  vol:.0004, dec:2, color:'#00695c', rails:['Local transfer'] },
  { id:'TRY', name:'Турецкая лира', type:'fiat', price:0.03052,  vol:.0110, dec:2, color:'#ad1457', rails:['FAST'] },
  { id:'KZT', name:'Казахстанский тенге', type:'fiat', price:0.002218, vol:.0055, dec:2, color:'#0277bd', rails:['Local transfer'] },
  { id:'UAH', name:'Гривна',        type:'fiat', price:0.02462,  vol:.0070, dec:2, color:'#f9a825', rails:['Карта'] },
  { id:'JPY', name:'Японская иена', type:'fiat', price:0.006554, vol:.0040, dec:0, color:'#b71c1c', rails:['SWIFT'] },
  { id:'CNY', name:'Юань',          type:'fiat', price:0.13824,  vol:.0025, dec:2, color:'#d84315', rails:['SWIFT'] },

  // ─── Металлы (не-крипто) ──────────────────────────────────────────────
  { id:'XAU', name:'Золото (унция)',  type:'metal', price:2384.60, vol:.0110, dec:4, color:'#b8862b', rails:['Кастоди-сертификат'] },
  { id:'XAG', name:'Серебро (унция)', type:'metal', price:28.42,   vol:.0180, dec:3, color:'#9aa3af', rails:['Кастоди-сертификат'] },
];

export const ASSET_MAP = Object.fromEntries(ASSETS.map(a => [a.id, a]));

/* Активы, для которых в assets/icons/coins/ лежит настоящий логотип
   (cryptocurrency-icons, CC0). Для TRY/AED/KZT/UAH/XAG подставляется валютный
   глиф Tabler, для остальных (TON, NEAR, ARB, OP, SUI, APT, FDUSD) — тикер
   текстом: этих монет в наборе нет, он собран до их появления. */
export const COIN_ICONS = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TRX', 'AVAX', 'DOT',
  'LINK', 'MATIC', 'LTC', 'BCH', 'ATOM', 'XMR', 'USDT', 'USDC', 'DAI',
  'USD', 'EUR', 'GBP', 'RUB', 'JPY', 'CNY', 'XAU',
]);

export const TYPE_LABELS = {
  crypto: 'Криптовалюты', stable: 'Стейблкоины', fiat: 'Фиат', metal: 'Металлы',
};

/* Котируемые валюты для спот-пар */
export const QUOTES = ['USDT', 'USD', 'BTC', 'EUR'];

/* Торговые пары: base-quote. Строим базовый набор автоматически + вручную. */
export const PAIRS = (() => {
  const list = [];
  const cryptos = ASSETS.filter(a => a.type === 'crypto').map(a => a.id);
  cryptos.forEach(b => list.push(`${b}-USDT`));
  ['BTC','ETH','SOL','XRP','TON'].forEach(b => list.push(`${b}-USD`));
  ['ETH','SOL','XRP','ADA','LINK','AVAX'].forEach(b => list.push(`${b}-BTC`));
  ['BTC','ETH'].forEach(b => list.push(`${b}-EUR`));
  ['XAU','XAG'].forEach(b => list.push(`${b}-USD`));
  return [...new Set(list)];
})();

/* Продукты доходности (Earn) */
export const EARN_PRODUCTS = [
  { asset:'USDT', apy: 7.20, term:'Гибкий',   min:50,   risk:'Низкий',  kind:'Сберегательный' },
  { asset:'USDC', apy: 6.85, term:'Гибкий',   min:50,   risk:'Низкий',  kind:'Сберегательный' },
  { asset:'USDT', apy:11.40, term:'90 дней',  min:500,  risk:'Средний', kind:'Фиксированный' },
  { asset:'ETH',  apy: 3.85, term:'Гибкий',   min:0.05, risk:'Средний', kind:'Стейкинг' },
  { asset:'SOL',  apy: 6.40, term:'Гибкий',   min:1,    risk:'Средний', kind:'Стейкинг' },
  { asset:'DOT',  apy:12.10, term:'28 дней',  min:5,    risk:'Средний', kind:'Стейкинг' },
  { asset:'ATOM', apy:14.60, term:'21 день',  min:5,    risk:'Высокий', kind:'Стейкинг' },
  { asset:'BTC',  apy: 1.95, term:'Гибкий',   min:0.001,risk:'Низкий',  kind:'Сберегательный' },
];

/* Уровни комиссий по 30-дневному объёму */
export const FEE_TIERS = [
  { tier:'VIP 0', vol:'< $50 000',      maker:0.100, taker:0.150 },
  { tier:'VIP 1', vol:'$50 000+',       maker:0.080, taker:0.130 },
  { tier:'VIP 2', vol:'$500 000+',      maker:0.060, taker:0.110 },
  { tier:'VIP 3', vol:'$2 500 000+',    maker:0.040, taker:0.090 },
  { tier:'VIP 4', vol:'$10 000 000+',   maker:0.020, taker:0.070 },
  { tier:'VIP 5', vol:'$50 000 000+',   maker:0.000, taker:0.050 },
];

/* Лимиты по уровням KYC */
export const KYC_LEVELS = [
  { level:0, name:'Не верифицирован', deposit:'—',        withdraw:'—',            need:'Регистрация' },
  { level:1, name:'Базовый',          deposit:'$10 000',  withdraw:'$2 000 / сутки', need:'Имя, страна, дата рождения' },
  { level:2, name:'Стандартный',      deposit:'$200 000', withdraw:'$50 000 / сутки',need:'Документ + селфи' },
  { level:3, name:'Расширенный',      deposit:'Без лимита',withdraw:'$1 000 000 / сутки', need:'Подтверждение адреса + источник средств' },
];

export const FAQ = [
  { q:'Это реальная биржа?', a:'Нет. Это демонстрационный макет-песочница: интерфейс и логика настоящие, но цены генерируются локально, а все переводы, пополнения и балансы эмулируются в браузере. Реальных денег и блокчейна здесь нет.' },
  { q:'Как начать?', a:'Нажмите «Войти в демо-счёт» — создастся локальный аккаунт с тестовым портфелем. Все операции доступны сразу, без верификации.' },
  { q:'Где хранятся мои данные?', a:'В песочнице — только в localStorage вашего браузера. Ничего не отправляется на сервер. Сбросить можно в Настройках.' },
  { q:'Какие комиссии?', a:'В макете: 0.10% мейкер / 0.15% тейкер на споте, 0.35% на мгновенном обмене, 1.80% на покупке картой. Реальная сетка — в разделе «Комиссии».' },
  { q:'Какие активы поддерживаются?', a:'22 криптовалюты, 4 стейблкоина, 10 фиатных валют и 2 драгоценных металла — всего 38 инструментов.' },
  { q:'Когда будет реальная торговля?', a:'После подключения бэкенда, кастоди, KYC-провайдера и лицензирования — этапы описаны в дорожной карте проекта.' },
];
