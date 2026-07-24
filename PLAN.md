# MERIDIAN — Digital Asset Exchange

**Кодовое имя бренда:** MERIDIAN (`meridian.exchange`)
**Слоган:** «Trade at the meridian of markets.» / «Опорная линия цифровых рынков.»
**Стадия:** Sandbox / макет (эмулированные переводы и пополнения). Лицо, безопасность и
реальная функциональность подключаются поэтапно по этому плану.

---

## 0. Что такое эта версия (важно)

Это **интерфейсный макет-песочница**. Он полностью функционален визуально и по UX, но:

- **Цены** — реалистичные, но генерируются локальным движком случайного блуждания
  (`js/market.js`), а не реальной биржей.
- **Балансы, переводы, обмены, пополнения, вывод** — эмулируются и хранятся в
  `localStorage` браузера (`js/store.js`). Никаких реальных денег, блокчейна или API.
- **Аутентификация** — демо-вход без реального сервера. Любой e-mail/пароль или кнопка
  «Войти в демо-счёт» создаёт локальный демо-аккаунт с тестовыми балансами.
- **Юр. документы** — рыбные тексты-заготовки в правильной структуре. Перед продом их
  заменяет юрист под конкретную юрисдикцию и лицензию.

Каждое место, где эмуляция заменяется на реальную интеграцию, помечено ниже маркером
**`→ PROD`**.

---

## 1. Продуктовый скоуп

| Раздел | Макет (сейчас) | Прод (потом) |
|---|---|---|
| Лендинг | ✅ живой тикер, витрина рынков | тот же UI + реальные метрики |
| Рынки (Markets) | ✅ все активы, поиск, сортировка, спарклайны | реальный прайс-фид (WS) |
| Спот-торговля (Trade) | ✅ график, стакан, лента сделок, ордера | матчинг-движок + WS |
| Обмен (Convert) | ✅ мгновенный своп любой→любой | котировщик + исполнение |
| Купить крипту (Buy) | ✅ фиат-онрамп (карта→крипто) | эквайринг + KYC |
| Earn / Стейкинг | ✅ продукты доходности | кастодиальный стейкинг |
| Кабинет (Dashboard) | ✅ портфель, аллокация, P&L | агрегатор реальных балансов |
| Кошелёк (Wallet) | ✅ депозит/вывод, история | HD-адреса + вывод-воркер |
| Аккаунт/Настройки | ✅ профиль, KYC, 2FA, API-ключи | реальные провайдеры |
| Юр. раздел | ✅ ToS, Privacy, AML/KYC, Risk, Cookie, Fees | версии от юриста |
| Поддержка/Контакты | ✅ форма, FAQ | тикет-система |

**Активы (в макете):**

- Крипто: BTC, ETH, USDT, USDC, BNB, SOL, XRP, ADA, DOGE, TRX, TON, DOT, MATIC, LTC,
  AVAX, LINK, ATOM, XMR, BCH, NEAR, ARB, OP, SUI, APT.
- Стейблкоины: USDT, USDC, DAI, FDUSD.
- Фиат (не-крипто): USD, EUR, GBP, RUB, AED, TRY, KZT, UAH, JPY, CNY.
- Металлы (не-крипто): XAU (золото), XAG (серебро).

---

## 2. Технологический стек

### 2.1 Сейчас (макет — сознательно без сборки)

- **Чистый статический фронт:** HTML + ES-модули + ручной CSS (CSS-переменные).
- **Ноль зависимостей / офлайн:** графики нарисованы вручную на `<canvas>` (`js/charts.js`),
  свой хеш-роутер, своё состояние. Причина — на машине нет Node/сборки, а песочнице внешние
  библиотеки не нужны.
- **Хранилище:** `localStorage` (ключ `meridian.sandbox.v1`).
- **Запуск:** локальный http-origin (нужен для модулей и корректной работы `localStorage`
  между вкладками):

  ```bash
  python -m http.server 5173
  # затем http://localhost:5173/
  ```

### 2.2 Прод (целевая архитектура) `→ PROD`

**Фронтенд**
- Next.js 14 (App Router) + TypeScript + React.
- Tailwind + shadcn/ui для системных компонентов; те же дизайн-токены, что в макете.
- TanStack Query (кэш REST), нативный WebSocket-клиент для стриминга.
- Графики: TradingView Lightweight Charts / прод-реализация нашего canvas-слоя.
- Zustand/Redux для клиентского состояния, i18n (RU/EN и далее).

**Бэкенд**
- API-gateway: Node.js (NestJS) или Go (высоконагруженные пути — Go).
- Матчинг-движок: отдельный сервис на Go/Rust, in-memory order book, детерминированный,
  событийный (см. §6).
- gRPC между внутренними сервисами, REST + WebSocket наружу.
- Очереди: Kafka/NATS (события ордеров, сделок, депозитов, вывода).

**Данные**
- PostgreSQL — аккаунты, KYC, ордера-снапшоты, транзакции, аудит (партиционирование).
- Redis — сессии, rate-limit, кэш котировок, hot-балансы, идемпотентность.
- ClickHouse — свечи/тики/аналитика, объёмы.
- S3-совместимое хранилище — KYC-документы (шифрование на стороне сервера).

**Блокчейн / кастоди**
- Собственные ноды или провайдеры (Blockdaemon/QuickNode) на BTC, ETH+EVM (ERC-20),
  TRON (TRC-20), Solana и т.д.
- Кошелёк: MPC-кастоди (Fireblocks / собственный TSS), горячий/тёплый/холодный контуры.
- Деривация депозит-адресов — HD (BIP-32/44) на пользователя и сеть.

**Платёжные рельсы (фиат)**
- Card on-ramp: эквайер / провайдеры (Stripe, где применимо; крипто-онрампы —
  MoonPay/Banxa/Transak как fallback).
- SEPA/SWIFT через банк-партнёра или EMI; выплаты через того же оператора.

**Инфраструктура**
- Kubernetes, IaC (Terraform), CI/CD (GitHub Actions), реестр образов.
- Наблюдаемость: OpenTelemetry → Grafana/Prometheus/Loki, алерты.
- WAF + anti-DDoS (Cloudflare), секреты в Vault, mTLS внутри кластера.

---

## 3. Карта страниц (роутинг)

Макет использует hash-роутер (`#/...`), прод — обычные пути.

```
#/                     Лендинг
#/markets              Рынки (все активы)
#/trade/:pair          Спот-торговля (по умолчанию BTC-USDT)
#/convert              Мгновенный обмен
#/buy                  Купить крипту за фиат
#/earn                 Доходность / стейкинг
#/dashboard            Кабинет (портфель)          [нужен вход]
#/wallet               Кошелёк / депозит / вывод   [нужен вход]
#/account              Настройки, KYC, 2FA, API    [нужен вход]
#/signin  #/signup     Вход / регистрация (демо)
#/legal                Юр. хаб
#/legal/:doc           Документ (terms|privacy|aml|risk|cookie|fees|licenses)
#/support              Поддержка / контакты / FAQ
#/*                    404
```

---

## 4. API-контракт (целевой) `→ PROD`

Базовый URL: `https://api.meridian.exchange/v1`. Все ответы — JSON, конверт
`{ "data": ..., "error": null, "meta": {...} }`. Ошибки — `{ "data": null, "error": { "code", "message", "details" } }`.
Аутентификация — Bearer JWT (access 15 мин) + refresh-cookie (HttpOnly, Secure, SameSite=Strict).

### 4.1 Публичные / рыночные

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/assets` | справочник активов |
| GET | `/markets` | список пар + тикеры 24ч |
| GET | `/markets/{pair}/ticker` | тикер по паре |
| GET | `/markets/{pair}/orderbook?depth=50` | стакан |
| GET | `/markets/{pair}/trades?limit=50` | последние сделки |
| GET | `/markets/{pair}/candles?interval=1m&limit=500` | свечи OHLCV |
| GET | `/convert/quote?from=BTC&to=USDT&amount=0.1` | котировка обмена |

**Пример: `GET /markets/BTC-USDT/ticker`**

```json
{
  "data": {
    "pair": "BTC-USDT",
    "last": 67421.35,
    "bid": 67418.90,
    "ask": 67423.10,
    "high24h": 68120.00,
    "low24h": 66210.55,
    "volume24h": 18423.77,
    "quoteVolume24h": 1243889120.55,
    "changePct24h": 1.82,
    "ts": 1753248000123
  },
  "error": null
}
```

**Пример: `GET /markets/BTC-USDT/candles?interval=1m&limit=2`**

```json
{
  "data": [
    { "t": 1753247880000, "o": 67380.1, "h": 67410.0, "l": 67365.2, "c": 67402.7, "v": 12.44 },
    { "t": 1753247940000, "o": 67402.7, "h": 67450.9, "l": 67399.0, "c": 67421.3, "v": 9.81 }
  ],
  "error": null
}
```

### 4.2 Аккаунт / кошелёк (auth)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/auth/register` | регистрация |
| POST | `/auth/login` | вход (пароль + 2FA) |
| POST | `/auth/refresh` | обновить токен |
| POST | `/auth/logout` | выход |
| GET | `/account` | профиль + статус KYC |
| GET | `/wallet/balances` | балансы |
| GET | `/wallet/{asset}/deposit-address?network=TRC20` | адрес пополнения |
| POST | `/wallet/{asset}/withdraw` | заявка на вывод |
| GET | `/wallet/transactions?type=all&limit=50` | история операций |

**Пример: `GET /wallet/USDT/deposit-address?network=TRC20`**

```json
{
  "data": {
    "asset": "USDT",
    "network": "TRC20",
    "address": "TJ8xQ4m2P7...9dRkVn",
    "memo": null,
    "minDeposit": 1,
    "confirmations": 1,
    "expiresAt": null
  },
  "error": null
}
```

**Пример: `POST /wallet/USDT/withdraw`**

```json
// запрос
{ "network": "TRC20", "address": "T...", "amount": 250.0, "twoFactorCode": "123456" }

// ответ
{
  "data": {
    "id": "wd_8f2c...",
    "status": "pending",       // pending → processing → completed | failed
    "asset": "USDT", "network": "TRC20",
    "amount": 250.0, "fee": 1.0, "net": 249.0,
    "createdAt": 1753248100000
  },
  "error": null
}
```

### 4.3 Торговля (auth)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/orders` | создать ордер (market/limit) |
| GET | `/orders?status=open` | список ордеров |
| DELETE | `/orders/{id}` | отменить ордер |
| GET | `/fills?pair=BTC-USDT` | исполнения |
| POST | `/convert` | исполнить обмен по котировке |

**Пример: `POST /orders`**

```json
// запрос
{ "pair": "BTC-USDT", "side": "buy", "type": "limit",
  "price": 67000, "quantity": 0.05, "tif": "GTC",
  "clientOrderId": "c-abc-123" }

// ответ
{
  "data": {
    "id": "ord_5a9...",
    "status": "open",          // open → partially_filled → filled | canceled | rejected
    "pair": "BTC-USDT", "side": "buy", "type": "limit",
    "price": 67000, "quantity": 0.05, "filled": 0,
    "avgPrice": 0, "fee": 0, "createdAt": 1753248200000
  },
  "error": null
}
```

### 4.4 WebSocket-стрим `→ PROD`

`wss://stream.meridian.exchange/v1`. Подписка сообщением:

```json
{ "op": "subscribe", "args": ["ticker:BTC-USDT", "orderbook:BTC-USDT:50", "trades:BTC-USDT", "candles:BTC-USDT:1m"] }
```

Приватные каналы (после `{ "op": "auth", "token": "..." }`): `orders`, `balances`, `fills`.
Формат пуша: `{ "channel": "ticker:BTC-USDT", "ts": ..., "data": {...} }`.

### 4.5 Коды ошибок (единый словарь)

| code | HTTP | Значение |
|---|---|---|
| `UNAUTHORIZED` | 401 | нет/просрочен токен |
| `FORBIDDEN` | 403 | KYC/лимиты не пройдены |
| `INSUFFICIENT_BALANCE` | 422 | недостаточно средств |
| `MIN_AMOUNT` | 422 | сумма ниже минимума |
| `RATE_LIMITED` | 429 | превышен лимит запросов |
| `MARKET_HALTED` | 409 | торги приостановлены |
| `VALIDATION_ERROR` | 400 | некорректный ввод |
| `INTERNAL` | 500 | внутренняя ошибка |

---

## 5. Модель данных (прод, PostgreSQL) `→ PROD`

```
users(id, email, pw_hash, status, created_at, ...)
kyc(user_id, level, status, provider_ref, verified_at, ...)
wallets(id, user_id, asset, network, address, hd_index, ...)
balances(user_id, asset, available, locked)          -- инвариант: available,locked >= 0
orders(id, user_id, pair, side, type, price, qty, filled, status, ...)
fills(id, order_id, price, qty, fee, ts)
transactions(id, user_id, kind, asset, amount, fee, status, tx_hash, ...)
                                     -- kind: deposit|withdraw|convert|trade|fee|reward
audit_log(id, actor, action, payload, ip, ts)         -- append-only
```

В макете этому соответствует объект в `localStorage` (см. `js/store.js`):
`account.balances`, `account.orders`, `account.transactions`.

---

## 6. Ключевые алгоритмы

### 6.1 Матчинг-движок (price-time priority) `→ PROD`

Классический лимитный стакан, приоритет «цена, затем время»:

```
on NEW limit order O(side, price, qty):
  book = side == buy ? asks : bids
  while qty > 0 and best(book) crosses O.price:
     lvl = best(book)                      # мин. ask для buy / макс. bid для sell
     take = min(qty, lvl.qty)
     emit Fill(price=lvl.price, qty=take)  # цена мейкера
     qty -= take; reduce(lvl, take)
  if qty > 0:
     insert remainder into own side (maker)   # для market-ордера — отменить остаток
```

Свойства: детерминированность, единый лог событий (event sourcing), реплей для аудита,
идемпотентность по `clientOrderId`. В **макете** это упрощено в `store.placeOrder()`:
market исполняется сразу по mid±спред, limit «встаёт» и добивается движком цен.

### 6.2 Прайс-оракул (агрегация) `→ PROD`

Реальная цена = устойчивая агрегация нескольких источников:

```
sources = [binance_ws, coinbase_ws, kraken_ws, ...]
mid_i   = (bid_i + ask_i) / 2
price   = weighted_median(mid_i, weight=volume_i)   # медиана устойчива к выбросам
reject source if |mid_i - price| > k * MAD          # отсечка аномалий
```

В **макете** цена рождается движком случайного блуждания с волатильностью на актив
(геометрическое блуждание + микрошум), плюс синтетические свечи/стакан/лента.

### 6.3 Котировка обмена (Convert)

```
quote(from, to, amount):
  usd   = amount * price_usd(from)
  gross = usd / price_usd(to)
  fee   = gross * FEE_RATE(spread + маржа)         # напр. 0.35%
  net   = gross - fee
  rate  = net / amount
  return { rate, fee, net, expiresInSec }          # прод: котировка «замораживается» на N сек
```

### 6.4 Расчёт комиссий

```
maker/taker (spot):  fee = notional * tier_rate     # тир зависит от 30д-объёма/стейка токена
convert:             fee = gross * convert_rate
withdraw:            fee = network_fee(asset, network) (флот) + сервисная (опц.)
```

### 6.5 Деривация депозит-адреса `→ PROD`

```
для (user_id, network): index = next_hd_index(network)
addr = HD.derive(xpub[network], index)              # BIP-32/44, безопасный только-паблик xpub
watch(addr); on N confirmations → credit balances (idемпотентно по tx_hash)
```

В **макете** адрес — правдоподобная псевдослучайная строка нужного формата, «пополнение»
кредитуется по кнопке с эмуляцией подтверждений сети.

### 6.6 Риск / комплаенс `→ PROD`

- Лимиты вывода по уровню KYC; travel rule для крупных сумм.
- Скоринг адресов (Chainalysis/TRM), заморозка при флагах.
- Anti-fraud на онрампе (3DS, velocity-правила), sanction-скрининг (OFAC и др.).

---

## 7. Дизайн-система (белая, строгая)

- **Фон:** `#ffffff`; поверхности `#f7f8fa` / `#f1f3f6`; линии `#e5e7eb`.
- **Текст:** `#0b1220` (заголовки), `#374151` (тело), `#6b7280` (приглушённый).
- **Акцент (бренд):** `#1e59ff` (синий), hover `#1546d6`.
- **Рынок:** рост `#0ea75f`, падение `#e0323f` (в этом проекте красный допустим как
  биржевой семантический сигнал — это не AXON).
- **Металл-акцент (лого/премиум):** `#b8862b` использовать точечно.
- **Шрифты:** системный UI-стек (Segoe UI/Inter-подобный) для интерфейса; моно
  (`ui-monospace`) для чисел/цен/адресов.
- **Тон:** институциональный, спокойный, плотная сетка, тонкие тени, много воздуха.
- **Адаптив:** desktop / tablet / mobile; на мобиле — нижняя таб-навигация, схлопнутые
  таблицы в карточки, свайп-панели.

Токены — в `css/tokens.css`, компоненты/раскладка/страницы — `css/app.css`.

---

## 8. Безопасность (роадмап к проду) `→ PROD`

- Пароли: Argon2id; 2FA (TOTP/WebAuthn); anti-phishing code.
- Сессии: короткий JWT + ротация refresh, привязка к устройству, журнал сессий.
- Вывод: whitelist-адреса, задержка на новые адреса, e-mail/2FA-подтверждение.
- Кастоди: MPC/мультисиг, лимиты горячего кошелька, ручной релиз крупных сумм.
- Инфра: WAF, rate-limit, mTLS, Vault для секретов, принцип наименьших привилегий.
- Аудит: внешний пентест, bug bounty, SOC2/ISO 27001 трек.
- **Дисклеймер по макету:** демо-вход в песочнице — не аутентификация. Реальную
  проверку выносим на сервер.

---

## 9. Юридический контур `→ PROD`

Документы-заготовки (в макете — структура + рыба, в проде — под юрисдикцию/лицензию):

- Terms of Service, Privacy Policy, Cookie Policy.
- AML/KYC Policy, Risk Disclosure, Fees & Limits.
- Licenses & Regulatory (номера лицензий, регистр операторов).
- Complaints / Support, Legal Contact, оператор/юрлицо, адрес, реквизиты.

Регуляторика зависит от юрисдикции запуска (EU MiCA / VASP-регистрация / лицензии в
конкретных странах). Это решается юристом до продакшена.

---

## 10. Дорожная карта запуска

| Фаза | Содержание |
|---|---|
| 0. Макет (сейчас) | UI/UX, песочница, эмуляция, план — **готово этим репо** |
| 1. Бэкенд-ядро | API-gateway, БД, аутентификация, матчинг-движок, WS-стрим |
| 2. Кастоди/фиат | ноды, HD-адреса, вывод-воркеры, онрамп, KYC-провайдер |
| 3. Комплаенс | AML-скрининг, лимиты, юр. документы, лицензирование |
| 4. Харденинг | пентест, bug bounty, нагрузочные, DR/бэкапы |
| 5. Прод | поэтапный вывод, мониторинг, поддержка 24/7 |

---

## 11. Структура репозитория (макет)

```
index.html            оболочка (шрифты-стек, подключение модулей, контейнеры)
PLAN.md               этот документ
README.md             как запускать
css/tokens.css        дизайн-токены (цвета, типографика, тени, отступы)
css/app.css           база, раскладка, компоненты, страницы, адаптив
assets/logo.svg       логотип; assets/favicon.svg
js/seed.js            справочник активов, конфиг, тексты юр. документов
js/format.js          форматирование чисел/валют/процентов/адресов
js/store.js           состояние песочницы (localStorage): аккаунт, балансы, ордера
js/market.js          движок рынка: цены, свечи, стакан, лента сделок (эмуляция)
js/charts.js          canvas-графики: свечи, линия/область, спарклайн, донат
js/ui.js              общие компоненты: шапка, подвал, тосты, модалки, таблицы
js/router.js          hash-роутер + жизненный цикл вью
js/app.js             бутстрап приложения
js/views/*.js         страницы (home, markets, trade, convert, buy, earn,
                      dashboard, wallet, account, auth, legal, support, notfound)
```
