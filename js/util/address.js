/* MERIDIAN — проверка адресов получателя.

   Зачем это в обменнике: транзакция в блокчейне необратима. Опечатка в одном
   символе адреса означает безвозвратную потерю средств, и единственный момент,
   когда её ещё можно поймать, — до отправки. Поэтому адрес проверяется не
   регуляркой «похоже на адрес», а настоящей контрольной суммой.

   Реализовано:
     * EIP-55 для EVM-сетей — регистр букв кодирует keccak-256 адреса;
     * Base58Check для Bitcoin (legacy) и TRON — двойной SHA-256;
     * Bech32/Bech32m для bc1… — полином над GF(32).

   keccak-256 написан здесь вручную: WebCrypto даёт семейство SHA-2 и SHA-3,
   но НЕ keccak-256 — Ethereum использует оригинальный Keccak с другим
   дополнением (0x01 вместо 0x06), и подменить его на SHA3-256 нельзя. */

/* ── Keccak-256 ───────────────────────────────────────────────────────── */

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
  41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;

function keccakF(A) {
  const B = new Array(25).fill(0n);
  const C = new Array(5).fill(0n);
  const D = new Array(5).fill(0n);

  for (let round = 0; round < 24; round++) {
    // θ — выравнивание по столбцам
    for (let x = 0; x < 5; x++) {
      C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) A[i] ^= D[i % 5];

    // ρ и π — вращение дорожек и их перестановка
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
      }
    }

    // χ — нелинейный слой
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        A[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & M64) & B[(x + 2) % 5 + 5 * y]);
      }
    }

    // ι — внесение константы раунда
    A[0] ^= RC[round];
  }
  return A;
}

/**
 * keccak-256. Принимает строку или Uint8Array, возвращает hex без префикса.
 * Дополнение 0x01 — оригинальный Keccak, как в Ethereum (у SHA3-256 было бы 0x06).
 */
export function keccak256(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const RATE = 136;                       // 1088 бит для 256-битного выхода

  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] = 0x01;            // начало дополнения
  padded[padded.length - 1] |= 0x80;      // конец дополнения

  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }

  let out = '';
  for (let i = 0; i < 4; i++) {           // 4 дорожки = 32 байта
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out += Number(lane & 0xffn).toString(16).padStart(2, '0');
      lane >>= 8n;
    }
  }
  return out;
}

/* ── EIP-55 ───────────────────────────────────────────────────────────── */

/**
 * Приводит EVM-адрес к виду с контрольной суммой в регистре букв.
 * Идея EIP-55: регистр каждой буквы задаётся битом keccak-256 от строчного
 * адреса. Опечатка меняет хэш целиком, и регистр перестаёт сходиться.
 */
export function toChecksumAddress(address) {
  const addr = address.toLowerCase().replace(/^0x/, '');
  const hash = keccak256(addr);
  let out = '0x';
  for (let i = 0; i < addr.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return out;
}

/**
 * Проверка EVM-адреса.
 * Адрес целиком в одном регистре — валиден, но без контрольной суммы:
 * это законный формат, просто он не защищает от опечаток.
 */
export function validateEvm(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { valid: false, reason: 'ожидается 0x и 40 шестнадцатеричных символов' };
  }
  const body = address.slice(2);
  const allSame = body === body.toLowerCase() || body === body.toUpperCase();
  if (allSame) {
    return {
      valid: true, checksum: false,
      normalized: toChecksumAddress(address),
      warning: 'адрес без контрольной суммы EIP-55 — опечатку поймать нельзя',
    };
  }
  const expected = toChecksumAddress(address);
  return expected === address
    ? { valid: true, checksum: true, normalized: expected }
    : { valid: false, checksum: false, normalized: expected,
        reason: 'контрольная сумма EIP-55 не сходится — вероятна опечатка' };
}

/* ── Base58Check ──────────────────────────────────────────────────────── */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;                       // символа нет в алфавите
    num = num * 58n + BigInt(v);
  }
  const bytes = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  for (const ch of str) { if (ch === '1') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Base58Check: последние 4 байта — начало двойного SHA-256 от остального. */
export async function validateBase58Check(address, { expectedVersions = null } = {}) {
  const raw = base58Decode(address);
  if (!raw || raw.length < 5) {
    return { valid: false, reason: 'строка не является корректным Base58' };
  }
  const payload = raw.slice(0, -4);
  const checksum = raw.slice(-4);
  const digest = await sha256(await sha256(payload));

  for (let i = 0; i < 4; i++) {
    if (digest[i] !== checksum[i]) {
      return { valid: false, reason: 'контрольная сумма не сходится — вероятна опечатка' };
    }
  }
  if (expectedVersions && !expectedVersions.includes(payload[0])) {
    return { valid: false, reason: `байт версии ${payload[0]} не соответствует сети` };
  }
  return { valid: true, checksum: true, version: payload[0] };
}

/* ── Bech32 / Bech32m ─────────────────────────────────────────────────── */

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** Bech32 (v0, константа 1) и Bech32m (v1+, константа 0x2bc830a3). */
export function validateBech32(address) {
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) {
    return { valid: false, reason: 'смешанный регистр недопустим в bech32' };
  }
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length || lower.length > 90) {
    return { valid: false, reason: 'некорректная структура bech32' };
  }
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) {
    const v = B32.indexOf(ch);
    if (v < 0) return { valid: false, reason: `недопустимый символ «${ch}»` };
    data.push(v);
  }
  const chk = polymod([...hrpExpand(hrp), ...data]);
  if (chk === 1) return { valid: true, checksum: true, encoding: 'bech32', hrp };
  if (chk === 0x2bc830a3) return { valid: true, checksum: true, encoding: 'bech32m', hrp };
  return { valid: false, reason: 'контрольная сумма не сходится — вероятна опечатка' };
}

/* ── Единая точка входа ───────────────────────────────────────────────── */

const EVM_NETWORKS = ['ERC20', 'BEP20', 'Polygon', 'Arbitrum', 'Optimism', 'C-Chain', 'ERC-20'];

/**
 * Проверяет адрес под конкретную сеть.
 * Возвращает { valid, checksum, reason?, warning?, normalized? }.
 */
export async function validateAddress(address, network) {
  const a = (address || '').trim();
  if (!a) return { valid: false, reason: 'адрес не указан' };

  if (EVM_NETWORKS.includes(network)) return validateEvm(a);

  if (network === 'Bitcoin') {
    if (/^(bc1|tb1)/i.test(a)) return validateBech32(a);
    if (/^[13]/.test(a)) return validateBase58Check(a, { expectedVersions: [0x00, 0x05] });
    return { valid: false, reason: 'не похоже на адрес Bitcoin' };
  }

  if (network === 'Litecoin') {
    if (/^ltc1/i.test(a)) return validateBech32(a);
    return validateBase58Check(a, { expectedVersions: [0x30, 0x32, 0x05] });
  }

  if (network === 'TRC20') {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) {
      return { valid: false, reason: 'адрес TRON начинается с T и содержит 34 символа' };
    }
    return validateBase58Check(a, { expectedVersions: [0x41] });
  }

  if (network === 'Solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
      return { valid: false, reason: 'ожидается 32–44 символа Base58' };
    }
    const raw = base58Decode(a);
    return raw && raw.length === 32
      ? { valid: true, checksum: false, warning: 'у Solana нет контрольной суммы — проверьте адрес глазами' }
      : { valid: false, reason: 'длина ключа не равна 32 байтам' };
  }

  if (network === 'TON') {
    return /^[EU]Q[A-Za-z0-9_-]{46}$/.test(a)
      ? { valid: true, checksum: false, warning: 'формат распознан, контрольная сумма не проверялась' }
      : { valid: false, reason: 'не похоже на адрес TON' };
  }

  return { valid: true, checksum: false, warning: 'для этой сети проверка не реализована' };
}

export default { keccak256, toChecksumAddress, validateEvm, validateBase58Check,
                 validateBech32, validateAddress };
