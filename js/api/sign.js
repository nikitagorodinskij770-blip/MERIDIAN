/* MERIDIAN — подпись запросов к API через WebCrypto (HMAC-SHA256).

   Канонизируемая строка обязана совпадать с серверной (server/security.py,
   функция canonical_string) до последнего байта:

       METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(body)

   Секрет ключа по сети не уходит никогда: он импортируется в CryptoKey с
   extractable=false, то есть даже сам JS не может достать его обратно из
   объекта ключа. Наружу отправляются только api_key и подпись.

   Три независимые преграды для повторного проигрывания запроса:
     1. окно по времени (сервер отвергает расхождение больше 30 с);
     2. одноразовый nonce (повтор отклоняется базой);
     3. тело запроса входит в подпись (подменить payload нельзя). */

const enc = new TextEncoder();

/** Байты → hex-строка нижним регистром. */
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 в hex — тем же способом, что hashlib.sha256().hexdigest() на сервере. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text || ''));
  return toHex(digest);
}

/**
 * Импортирует секрет как неизвлекаемый ключ HMAC.
 * extractable=false — принципиально: скомпрометированный код страницы сможет
 * попросить подпись, но не сможет украсть сам секрет.
 */
async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Та же канонизация, что на сервере. Любое расхождение ломает подпись. */
export async function canonicalString(method, path, timestamp, nonce, body) {
  const bodyHash = await sha256Hex(body);
  return [method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n');
}

/** Криптостойкий одноразовый идентификатор запроса. */
export function makeNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Подписывает запрос и возвращает готовые заголовки.
 * @returns {Promise<Object>} X-Api-Key, X-Timestamp, X-Nonce, X-Signature
 */
export async function signRequest({ apiKey, secret, method, path, body = '' }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = makeNonce();
  const canonical = await canonicalString(method, path, timestamp, nonce, body);

  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(canonical));

  return {
    'X-Api-Key': apiKey,
    'X-Timestamp': String(timestamp),
    'X-Nonce': nonce,
    'X-Signature': toHex(sig),
  };
}

/* ── Клиент API ───────────────────────────────────────────────────────── */

const BASE = '/v1';

/** Ключи хранятся в памяти вкладки, а не в localStorage: XSS их не вычитает. */
let creds = null;

export function setApiCredentials(apiKey, secret) { creds = { apiKey, secret }; }
export function clearApiCredentials() { creds = null; }
export function hasApiCredentials() { return !!creds; }

/** Сессионный токен — для обычной работы интерфейса. */
let sessionToken = null;
export function setSessionToken(t) { sessionToken = t; }
export function getSessionToken() { return sessionToken; }

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Запрос к API. Подписывает, если заданы ключи; иначе идёт по сессии.
 * Разворачивает конверт { data, error } и бросает ApiError на ошибке.
 */
export async function api(method, path, body = null, { signed = false } = {}) {
  const url = BASE + path;
  const payload = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json' };

  if (signed && creds) {
    Object.assign(headers, await signRequest({
      apiKey: creds.apiKey, secret: creds.secret,
      method, path: url, body: payload,
    }));
  } else if (sessionToken) {
    headers.Authorization = `Bearer ${sessionToken}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method, headers,
      body: payload || undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
  } catch (e) {
    throw new ApiError('NETWORK', 'сервер недоступен: ' + String(e).slice(0, 60), 0);
  }

  let json;
  try { json = await res.json(); }
  catch { throw new ApiError('BAD_RESPONSE', 'сервер вернул не JSON', res.status); }

  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new ApiError(e.code || 'HTTP_' + res.status, e.message || res.statusText, res.status);
  }
  return json.data;
}

export const API = {
  get: (p, o) => api('GET', p, null, o),
  post: (p, b, o) => api('POST', p, b, o),
  del: (p, o) => api('DELETE', p, null, o),
};

/** Доступен ли бэкенд. Интерфейс работает и без него — на песочнице. */
export async function backendAvailable() {
  try {
    const d = await api('GET', '/health');
    return { ok: true, ...d };
  } catch {
    return { ok: false };
  }
}

export default { signRequest, canonicalString, sha256Hex, makeNonce, API, api,
                 setApiCredentials, clearApiCredentials, hasApiCredentials,
                 setSessionToken, getSessionToken, backendAvailable, ApiError };
