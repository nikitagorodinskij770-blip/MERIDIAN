# Генератор js/icons.js из Tabler Icons (MIT).
# Инлайним SVG в JS-модуль: ноль сетевых запросов, currentColor работает,
# толщина штриха нормализована под дизайн-систему MERIDIAN (1.75 вместо 2).
import re, pathlib, sys

SRC = pathlib.Path(sys.argv[1])          # .../tabler-icons/icons
OUT = pathlib.Path(sys.argv[2])          # .../MERIDIAN/js/icons.js
STROKE = "1.75"

# ключ -> (имя файла tabler, размер в px)
UI = {
    # навигация и разделы
    "home": ("home", 20), "chart": ("chart-bar", 20), "candle": ("chart-candle", 20),
    "swap": ("arrows-exchange", 20), "exchange": ("arrows-left-right", 20),
    "wallet": ("wallet", 20), "user": ("user", 20), "userCheck": ("user-check", 22),
    "menu": ("menu-2", 20), "card": ("credit-card", 20), "gift": ("gift", 20),
    "settings": ("settings", 20), "logout": ("logout", 20), "bell": ("bell", 20),
    "bank": ("building-bank", 22), "coin": ("coin", 20), "coins": ("coins", 22),
    "mobile": ("device-mobile", 20), "qr": ("qrcode", 20), "key": ("key", 20),
    "clock": ("clock", 20), "mail": ("mail", 20), "phone": ("phone", 20),
    "pin": ("map-pin", 20), "filter": ("filter", 20), "refresh": ("refresh", 20),
    "download": ("download", 20), "upload": ("upload", 20),
    "eye": ("eye", 20), "eyeOff": ("eye-off", 20),
    # мелкие управляющие
    "search": ("search", 18), "arrowDown": ("arrow-down", 18), "arrowUp": ("arrow-up", 18),
    "plus": ("plus", 18), "minus": ("minus", 18),
    "chevronDown": ("chevron-down", 18), "chevronRight": ("chevron-right", 18),
    "external": ("external-link", 18), "star": ("star", 18),
    "copy": ("copy", 16), "check": ("check", 16), "circleCheck": ("circle-check", 16),
    "x": ("x", 16),
    # крупные, для карточек-преимуществ
    "shield": ("shield-check", 22), "shieldLock": ("shield-lock", 22),
    "bolt": ("bolt", 22), "globe": ("world", 22), "lock": ("lock", 22),
    "lockOpen": ("lock-open", 22), "book": ("book", 22), "support": ("help-circle", 22),
    "trend": ("trending-up", 22), "trendDown": ("trending-down", 22),
    "layers": ("stack-2", 22), "alert": ("alert-triangle", 22),
    "info": ("info-circle", 22), "certificate": ("certificate", 22),
    "receipt": ("receipt", 22), "fileDoc": ("file-description", 22),
}

# Глифы валют для активов, которых нет в наборе логотипов.
# Без width/height — размер задаётся CSS внутри кружка .coin.
CURRENCY = {
    "TRY": "currency-lira", "AED": "currency-dirham",
    "KZT": "currency-tenge", "UAH": "currency-hryvnia",
    "XAG": "coin",
}


def body(path: pathlib.Path) -> str:
    """Внутренности <svg>…</svg> без комментария-шапки и лишних переносов."""
    t = path.read_text(encoding="utf-8")
    t = re.sub(r"<!--.*?-->", "", t, flags=re.S)          # шапка с тегами
    inner = re.search(r"<svg[^>]*>(.*)</svg>", t, flags=re.S).group(1)
    inner = re.sub(r"\s+", " ", inner).strip()
    inner = inner.replace('stroke-width="2"', f'stroke-width="{STROKE}"')
    # Tabler кладёт пустой path-заглушку — она не нужна
    inner = inner.replace('<path stroke="none" d="M0 0h24v24H0z" fill="none" />', "")
    inner = inner.replace('<path stroke="none" d="M0 0h24v24H0z" fill="none"/>', "")
    return inner.strip()


def outline(name: str, size: int | None) -> str:
    inner = body(SRC / "outline" / f"{name}.svg")
    dim = f' width="{size}" height="{size}"' if size else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg"{dim} viewBox="0 0 24 24" fill="none" '
            f'stroke="currentColor" stroke-width="{STROKE}" stroke-linecap="round" '
            f'stroke-linejoin="round">{inner}</svg>')


def filled(name: str, size: int) -> str:
    inner = body(SRC / "filled" / f"{name}.svg")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 24 24" fill="currentColor" stroke="none">{inner}</svg>')


lines = [
    "/* AUTO-GENERATED — не редактировать вручную.",
    "   Источник: Tabler Icons (https://github.com/tabler/tabler-icons), лицензия MIT,",
    "   © 2020-2026 Paweł Kuna. Штрих нормализован до " + STROKE + " под дизайн-систему MERIDIAN.",
    "   Пересборка: scratchpad/gen_icons.py */",
    "",
    "export const ICONS = {",
]

missing = []
for key, (fname, size) in UI.items():
    p = SRC / "outline" / f"{fname}.svg"
    if not p.exists():
        missing.append(fname)
        continue
    lines.append(f"  {key}: `{outline(fname, size)}`,")

# звезда-заливка живёт в filled/
lines.append(f"  starFilled: `{filled('star', 18)}`,")

# фирменный знак MERIDIAN оставляем свой — он часть бренда, не иконка из набора
lines.append("""  logo: `<svg class="logo" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="8" fill="#0b1220"/>
    <path d="M7 23V9l5 7 4-5.5L20 16l5-7v14" stroke="#1e59ff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="16" cy="24.5" r="1.6" fill="#b8862b"/>
  </svg>`,""")

lines += ["};", "", "/* Глифы валют для активов без готового логотипа. Размер задаёт CSS. */",
          "export const CURRENCY_GLYPH = {"]
for code, fname in CURRENCY.items():
    p = SRC / "outline" / f"{fname}.svg"
    if not p.exists():
        missing.append(fname)
        continue
    lines.append(f"  {code}: `{outline(fname, None)}`,")
lines += ["};", "", "export default ICONS;", ""]

OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"написано: {OUT}")
print(f"иконок UI: {len(UI) + 1}, глифов валют: {len(CURRENCY)}")
if missing:
    print("НЕ НАЙДЕНЫ:", ", ".join(missing))
