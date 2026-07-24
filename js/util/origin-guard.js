/* MERIDIAN — защита от фишинговых копий сайта.

   Идея заимствована у DNS-блоклистов, но перенесена туда, где она применима
   к веб-приложению. Блоклист режет известные домены на уровне резолвера —
   у фронтенда такой возможности нет, и списка «плохих» доменов у него тоже нет.
   Зато есть обратная, более сильная проверка: приложение знает, на каком
   домене оно легитимно, и может заявить о подмене само.

   Так ловится типичная схема: клон сайта на meridian-exchange.com или
   meridiaп.exchange (с кириллической «п»), куда жертву приводят из письма
   или рекламы. Копия кода унесёт с собой и эту проверку. */

const CANONICAL = ['meridian.exchange', 'www.meridian.exchange'];

/** Локальная разработка — это не подмена. */
const DEV_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', ''];

/**
 * Не-ASCII в домене — почти всегда омограф-атака: «а» кириллическая
 * неотличима от латинской, но ведёт на другой сайт.
 */
function hasNonAscii(host) {
  return /[^\x00-\x7F]/.test(host) || host.startsWith('xn--') || host.includes('.xn--');
}

export function inspectOrigin() {
  const host = location.hostname;
  const isDev = DEV_HOSTS.includes(host) || host.endsWith('.local');
  const isCanonical = CANONICAL.includes(host);

  return {
    host,
    isDev,
    isCanonical,
    punycode: hasNonAscii(host),
    insecure: location.protocol !== 'https:' && !isDev,
    suspicious: !isDev && !isCanonical,
  };
}

/**
 * Показывает предупреждение, если сайт открыт не на своём домене.
 * Полоса намеренно неубираемая: если это действительно фишинг, кнопка
 * «скрыть» сыграла бы на стороне атакующего.
 */
export function guardOrigin() {
  const o = inspectOrigin();
  if (!o.suspicious && !o.punycode && !o.insecure) return o;

  const reasons = [];
  if (o.punycode) {
    reasons.push('домен содержит не-латинские символы — типичный признак подделки под известный адрес');
  } else if (o.suspicious) {
    reasons.push(`ожидался <code>${CANONICAL[0]}</code>, а страница открыта на <code>${escapeHtml(o.host)}</code>`);
  }
  if (o.insecure) {
    reasons.push('соединение без HTTPS: данные передаются в открытом виде');
  }

  const bar = document.createElement('div');
  bar.className = 'phish-bar';
  bar.setAttribute('role', 'alert');
  bar.innerHTML =
    `<b>Внимание: адрес сайта не совпадает с официальным.</b> ${reasons.join('. ')}. ` +
    'Не вводите пароль и не подтверждайте операции. Наберите адрес вручную.';

  document.body.prepend(bar);
  console.warn('[origin-guard] подозрительный источник', o);
  return o;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Антифишинг-код: строка, которую площадка показывает вошедшему клиенту.
 * Письма без неё — подделка. Настоящее письмо злоумышленник подделать сможет,
 * а этот код — нет, потому что он не покидает аккаунт.
 */
export function antiPhishingHint(code) {
  return code
    ? `Настоящие письма от MERIDIAN содержат ваш код ${code}. Письмо без него — подделка.`
    : 'Задайте антифишинг-код в настройках безопасности, чтобы отличать наши письма от поддельных.';
}

export default { inspectOrigin, guardOrigin, antiPhishingHint };
