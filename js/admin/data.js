/* MERIDIAN — данные административной панели.
   Отдельное хранилище (ключ meridian.admin.v1), чтобы не смешивать
   операционные данные площадки с песочницей клиента.

   ВАЖНО: пользователи сгенерированы синтетически. Ни одного реального
   человека, адреса или письма здесь нет, и рассылка ничего не отправляет —
   она лишь меняет статус записи. Это макет административного контура. */

const KEY = 'meridian.admin.v1';

/* ── Детерминированный генератор ──────────────────────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Артём', 'Мария', 'Дмитрий', 'Анна', 'Сергей', 'Елена', 'Игорь', 'Ольга',
  'Павел', 'Наталья', 'Роман', 'Ксения', 'Виктор', 'Ирина', 'Максим', 'Юлия',
  'Lukas', 'Emma', 'Mehmet', 'Aylin', 'Rashid', 'Fatima', 'Chen', 'Mei',
  'Tomás', 'Sofia', 'Jan', 'Marta', 'Kwame', 'Amina'];
const LAST = ['Ковалёв', 'Соколова', 'Морозов', 'Лебедева', '新', 'Волкова', 'Зайцев',
  'Медведева', 'Орлов', 'Титова', 'Шевченко', 'Крылова', 'Гусев', 'Панова',
  'Weber', 'Novak', 'Yılmaz', 'Demir', 'Al-Rashid', 'Haddad', 'Wang', 'Li',
  'Silva', 'Costa', 'Kowalski', 'Nowak', 'Mensah', 'Diallo'];
const COUNTRIES = [
  ['EE', 'Эстония'], ['DE', 'Германия'], ['AE', 'ОАЭ'], ['TR', 'Турция'],
  ['KZ', 'Казахстан'], ['GB', 'Великобритания'], ['PL', 'Польша'], ['NL', 'Нидерланды'],
  ['ES', 'Испания'], ['SG', 'Сингапур'], ['BR', 'Бразилия'], ['ZA', 'ЮАР'],
];
const DOMAINS = ['example.com', 'mail.test', 'demo.local', 'sandbox.invalid'];

const genId = p => `${p}_${Math.random().toString(36).slice(2, 10)}`;

/** Синтетическая база пользователей. Стабильна между перезагрузками. */
function generateUsers(n = 64) {
  const rnd = mulberry32(20260724);
  const now = Date.now();
  const out = [];

  for (let i = 0; i < n; i++) {
    const first = FIRST[Math.floor(rnd() * FIRST.length)];
    const last = LAST[Math.floor(rnd() * LAST.length)];
    const [cc, country] = COUNTRIES[Math.floor(rnd() * COUNTRIES.length)];

    const joined = now - Math.floor(rnd() * 720) * 86_400_000;
    const lastSeen = now - Math.floor(rnd() * 30) * 86_400_000 - Math.floor(rnd() * 86_400_000);

    // Распределение с длинным хвостом: много мелких счетов, мало крупных
    const magnitude = rnd() ** 3;
    const balanceUsd = Math.round(40 + magnitude * 480_000);
    const volume30d = Math.round(balanceUsd * (0.2 + rnd() * 6));

    const r = rnd();
    const status = r > 0.94 ? 'blocked' : r > 0.86 ? 'pending' : 'active';
    const kyc = status === 'pending' ? 0 : rnd() > 0.75 ? 3 : rnd() > 0.4 ? 2 : 1;

    // Риск-скоринг: чем крупнее оборот и ниже верификация, тем выше
    let risk = Math.round(rnd() * 40 + (kyc === 1 ? 20 : 0) + (volume30d > 200_000 ? 25 : 0));
    if (status === 'blocked') risk = Math.max(risk, 78);
    risk = Math.min(99, risk);

    out.push({
      id: `usr_${(100000 + i).toString(36)}`,
      name: `${first} ${last}`,
      email: `${translit(first)}.${translit(last)}${i}@${DOMAINS[i % DOMAINS.length]}`.toLowerCase(),
      cc, country,
      status, kyc, risk,
      balanceUsd, volume30d,
      txCount: Math.floor(rnd() * 400) + 1,
      tier: volume30d > 2_500_000 ? 'VIP 3' : volume30d > 500_000 ? 'VIP 2' : volume30d > 50_000 ? 'VIP 1' : 'VIP 0',
      twoFA: rnd() > 0.35,
      joined, lastSeen,
      blockedReason: status === 'blocked' ? pick(rnd, [
        'Санкционный скрининг: совпадение по списку',
        'Подозрительная схема пополнений',
        'Не пройдена повторная верификация',
        'Запрос уполномоченного органа',
      ]) : null,
      note: '',
    });
  }
  return out;
}

function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

/** Грубая транслитерация для генерации почтовых адресов. */
function translit(s) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',
    ь:'',э:'e',ю:'yu',я:'ya' };
  return [...s.toLowerCase()].map(c => map[c] ?? c).join('').replace(/[^a-z0-9]/g, '');
}

/** Стартовый журнал операций площадки. */
function generateAudit() {
  const now = Date.now();
  return [
    { id: genId('log'), ts: now - 3600_000 * 2, actor: 'system', action: 'feed.reconnect', target: 'binance-ws', level: 'info' },
    { id: genId('log'), ts: now - 3600_000 * 9, actor: 'admin@meridian.exchange', action: 'user.block', target: 'usr_2s4', level: 'warn' },
    { id: genId('log'), ts: now - 86400_000, actor: 'system', action: 'aml.screening', target: '412 адресов', level: 'info' },
    { id: genId('log'), ts: now - 86400_000 * 2, actor: 'admin@meridian.exchange', action: 'settings.fees', target: 'taker 0.15%', level: 'warn' },
    { id: genId('log'), ts: now - 86400_000 * 3, actor: 'system', action: 'backup.completed', target: 'snapshot-daily', level: 'info' },
  ];
}

function blank() {
  return {
    v: 1,
    users: generateUsers(),
    broadcasts: [
      { id: genId('bc'), subject: 'Плановые работы 28 июля', audience: 'all', status: 'sent',
        body: 'Уважаемые клиенты, 28 июля с 02:00 до 04:00 UTC пройдут плановые работы. Торговля будет недоступна.',
        createdAt: Date.now() - 86400_000 * 5, sentAt: Date.now() - 86400_000 * 5,
        recipients: 3184, opens: 2211, clicks: 604 },
      { id: genId('bc'), subject: 'Новые торговые пары: SUI и APT', audience: 'active', status: 'sent',
        body: 'Добавлены пары SUI/USDT и APT/USDT. Комиссии стандартные.',
        createdAt: Date.now() - 86400_000 * 12, sentAt: Date.now() - 86400_000 * 12,
        recipients: 2740, opens: 1602, clicks: 388 },
    ],
    audit: generateAudit(),
    settings: {
      maintenance: false,
      tradingEnabled: true,
      withdrawalsEnabled: true,
      registrationsOpen: true,
      makerFee: 0.10,
      takerFee: 0.15,
      convertFee: 0.35,
      withdrawDailyLimit: 50000,
      requireKycForWithdraw: true,
    },
    session: { authed: false, at: 0 },
  };
}

/* ── Персистентность ──────────────────────────────────────────────────── */

let S = blank();
const bus = new Set();

export function onChange(fn) { bus.add(fn); return () => bus.delete(fn); }
function commit() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { console.warn(e); }
  bus.forEach(fn => { try { fn(S); } catch (e) { console.error(e); } });
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.v === 1) S = { ...blank(), ...p };
    }
  } catch (e) { console.warn('admin state', e); }
}
load();

export function state() { return S; }

/* ── Доступ ───────────────────────────────────────────────────────────── */

/* Демо-код доступа. Это НЕ аутентификация: код лежит в открытом коде фронта
   и виден любому. В проде проверка уходит на сервер, а сюда приходит только
   решение и роль. Здесь он существует лишь как элемент интерфейса. */
export const DEMO_CODE = 'meridian-admin';

export function isAuthed() { return !!S.session.authed; }
export function login(code) {
  const ok = code.trim() === DEMO_CODE;
  if (ok) { S.session = { authed: true, at: Date.now() }; log('admin.login', 'демо-вход', 'warn'); commit(); }
  return ok;
}
export function logout() { S.session = { authed: false, at: 0 }; commit(); }

/* ── Журнал ───────────────────────────────────────────────────────────── */

export function log(action, target = '', level = 'info') {
  S.audit.unshift({ id: genId('log'), ts: Date.now(), actor: 'admin@meridian.exchange', action, target, level });
  if (S.audit.length > 300) S.audit.pop();
}
export function audit() { return S.audit; }

/* ── Пользователи ─────────────────────────────────────────────────────── */

export function users() { return S.users; }
export function findUser(id) { return S.users.find(u => u.id === id); }

export function blockUser(id, reason) {
  const u = findUser(id);
  if (!u) return;
  u.status = 'blocked';
  u.blockedReason = reason || 'Заблокирован администратором';
  log('user.block', `${u.email} — ${u.blockedReason}`, 'warn');
  commit();
}

export function unblockUser(id) {
  const u = findUser(id);
  if (!u) return;
  u.status = 'active';
  u.blockedReason = null;
  log('user.unblock', u.email, 'warn');
  commit();
}

export function setKyc(id, level) {
  const u = findUser(id);
  if (!u) return;
  u.kyc = level;
  if (level > 0 && u.status === 'pending') u.status = 'active';
  log('user.kyc', `${u.email} → уровень ${level}`);
  commit();
}

export function setNote(id, note) {
  const u = findUser(id);
  if (!u) return;
  u.note = note;
  log('user.note', u.email);
  commit();
}

/** Массовое действие над выборкой. */
export function bulk(ids, action, reason) {
  ids.forEach(id => {
    if (action === 'block') blockUser(id, reason);
    else if (action === 'unblock') unblockUser(id);
  });
  log('user.bulk', `${action}: ${ids.length} записей`, 'warn');
  commit();
}

/* ── Рассылки ─────────────────────────────────────────────────────────── */

export const AUDIENCES = {
  all: 'Все пользователи',
  active: 'Только активные',
  pending: 'Ожидают верификации',
  blocked: 'Заблокированные',
  vip: 'VIP 1 и выше',
  dormant: 'Неактивны более 14 дней',
};

/** Сколько адресатов попадёт под выбранный сегмент. */
export function audienceSize(key) {
  const now = Date.now();
  const f = {
    all: () => true,
    active: u => u.status === 'active',
    pending: u => u.status === 'pending',
    blocked: u => u.status === 'blocked',
    vip: u => u.tier !== 'VIP 0',
    dormant: u => now - u.lastSeen > 14 * 86_400_000,
  }[key] || (() => true);
  return S.users.filter(f).length;
}

export function broadcasts() { return S.broadcasts; }

export function saveBroadcast({ id, subject, body, audience }) {
  if (id) {
    const b = S.broadcasts.find(x => x.id === id);
    if (b && b.status === 'draft') Object.assign(b, { subject, body, audience });
  } else {
    S.broadcasts.unshift({
      id: genId('bc'), subject, body, audience,
      status: 'draft', createdAt: Date.now(), sentAt: null,
      recipients: 0, opens: 0, clicks: 0,
    });
  }
  log('broadcast.save', subject);
  commit();
}

/**
 * «Отправка» рассылки. Никакой почты не уходит: меняется статус записи
 * и подставляются правдоподобные метрики доставки.
 */
export function sendBroadcast(id) {
  const b = S.broadcasts.find(x => x.id === id);
  if (!b || b.status === 'sent') return null;
  const n = audienceSize(b.audience);
  b.status = 'sent';
  b.sentAt = Date.now();
  b.recipients = n;
  b.opens = Math.round(n * (0.45 + Math.random() * 0.3));
  b.clicks = Math.round(b.opens * (0.15 + Math.random() * 0.25));
  log('broadcast.send', `${b.subject} → ${n} адресатов`, 'warn');
  commit();
  return b;
}

export function deleteBroadcast(id) {
  S.broadcasts = S.broadcasts.filter(b => b.id !== id);
  log('broadcast.delete', id, 'warn');
  commit();
}

/* ── Настройки площадки ───────────────────────────────────────────────── */

export function settings() { return S.settings; }
export function updateSettings(patch) {
  Object.assign(S.settings, patch);
  log('settings.update', Object.keys(patch).join(', '), 'warn');
  commit();
}

/* ── Сводная статистика ───────────────────────────────────────────────── */

export function stats() {
  const u = S.users;
  const now = Date.now();
  const day = 86_400_000;

  const active = u.filter(x => x.status === 'active').length;
  const blocked = u.filter(x => x.status === 'blocked').length;
  const pending = u.filter(x => x.status === 'pending').length;
  const tvl = u.reduce((s, x) => s + x.balanceUsd, 0);
  const vol30 = u.reduce((s, x) => s + x.volume30d, 0);

  // Регистрации по дням за 30 суток
  const signups = new Array(30).fill(0);
  u.forEach(x => {
    const d = Math.floor((now - x.joined) / day);
    if (d >= 0 && d < 30) signups[29 - d]++;
  });

  // Оборот по дням — синтетический ряд вокруг среднего
  const rnd = mulberry32(777);
  const volSeries = new Array(30).fill(0).map((_, i) =>
    (vol30 / 30) * (0.55 + rnd() * 0.9) * (1 + i * 0.012));

  const byCountry = {};
  u.forEach(x => { byCountry[x.country] = (byCountry[x.country] || 0) + 1; });

  const byKyc = [0, 1, 2, 3].map(l => u.filter(x => x.kyc === l).length);

  return {
    total: u.length, active, blocked, pending,
    tvl, vol30,
    avgBalance: tvl / (u.length || 1),
    dau: u.filter(x => now - x.lastSeen < day).length,
    wau: u.filter(x => now - x.lastSeen < 7 * day).length,
    newThisWeek: u.filter(x => now - x.joined < 7 * day).length,
    highRisk: u.filter(x => x.risk >= 70).length,
    twoFaShare: u.filter(x => x.twoFA).length / (u.length || 1) * 100,
    signups, volSeries,
    byCountry: Object.entries(byCountry).sort((a, b) => b[1] - a[1]),
    byKyc,
  };
}

/* ── Сброс ────────────────────────────────────────────────────────────── */

export function reset() {
  S = blank();
  commit();
}

export default {
  state, onChange, isAuthed, login, logout, DEMO_CODE,
  users, findUser, blockUser, unblockUser, setKyc, setNote, bulk,
  broadcasts, saveBroadcast, sendBroadcast, deleteBroadcast, AUDIENCES, audienceSize,
  settings, updateSettings, stats, audit, log, reset,
};
