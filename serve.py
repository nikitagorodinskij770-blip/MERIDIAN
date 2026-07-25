#!/usr/bin/env python3
"""Локальный сервер разработки MERIDIAN.

Отличие от `python -m http.server` одно, но важное: каждый ответ помечается
`Cache-Control: no-store`. Штатный http.server отдаёт Last-Modified, браузер
кэширует ES-модули и продолжает исполнять старый код после правки файла —
отладка в этот момент превращается в охоту за призраками.

Запуск:
    python serve.py [порт]        по умолчанию 5174
"""

import sys
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 5174


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Отдаёт файлы без кэширования и с корректными MIME-типами."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".map": "application/json",
    }

    # Те же заголовки безопасности, что у боевого сервера (server/app.py).
    # Иначе статический режим оказался бы слабее защищённым, чем API-режим,
    # и проверять CSP пришлось бы дважды.
    CSP = (
        "default-src 'self'; script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "img-src 'self' data:; font-src 'self' https://fonts.gstatic.com data:; "
        "connect-src 'self' https://elokoleohntufgrkyvxm.supabase.co wss://elokoleohntufgrkyvxm.supabase.co https://api.binance.com wss://stream.binance.com:9443 "
        "https://api.coinbase.com https://api.exchange.coinbase.com "
        "https://api.coingecko.com https://www.okx.com https://api.bybit.com "
        "https://api.kraken.com https://www.bitstamp.net; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
    )

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Content-Security-Policy", self.CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Тихо для 200-х, шумно для ошибок — иначе консоль тонет в статике
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            sys.exit(f"Некорректный порт: {sys.argv[1]}")

    handler = partial(NoCacheHandler, directory=ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"MERIDIAN -> http://localhost:{port}/  (каталог: {ROOT})")
    print("Кэш отключён: правки в JS/CSS видны сразу после перезагрузки.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлен.")
        server.server_close()


if __name__ == "__main__":
    main()
