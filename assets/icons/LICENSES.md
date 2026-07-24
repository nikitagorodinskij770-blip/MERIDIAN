# Лицензии на иконки

В проект вендорены два сторонних набора. Оба свободны для коммерческого использования,
но условия разные — читайте перед заменой или удалением файлов.

---

## 1. Tabler Icons — интерфейсные иконки

- **Источник:** https://github.com/tabler/tabler-icons
- **Лицензия:** MIT
- **Правообладатель:** © 2020–2026 Paweł Kuna
- **Где в проекте:** инлайнены в [`js/icons.js`](../../js/icons.js) (60 иконок + 5 валютных глифов)
- **Что изменено:** удалён комментарий-шапка с тегами, толщина штриха нормализована
  с `2` до `1.75` под дизайн-систему MERIDIAN, проставлены фиксированные размеры.

MIT требует сохранять текст лицензии и уведомление об авторстве. Полный текст:

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. cryptocurrency-icons — логотипы монет и валют

- **Источник:** https://github.com/spothq/cryptocurrency-icons
- **Лицензия:** CC0 1.0 Universal (общественное достояние)
- **Где в проекте:** [`assets/icons/coins/`](coins/) — 26 файлов, вариант `svg/color`
- **Что изменено:** ничего; `gold.svg` переименован в `xau.svg` под наш тикер.

CC0 не требует указания авторства — упоминание здесь оставлено из вежливости.

> **Отдельно о товарных знаках.** CC0 распространяется на сами файлы, но логотипы
> Bitcoin, Ethereum, Tether и прочих остаются знаками своих проектов. Для песочницы
> это несущественно, а перед коммерческим запуском убедитесь, что использование
> логотипа не подразумевает несуществующего партнёрства с эмитентом.

---

## Обновление набора

`js/icons.js` генерируется скриптом, вручную его не правят. Пересборка:

```bash
python gen_icons.py <путь-к>/tabler-icons/icons <путь-к>/MERIDIAN/js/icons.js
```

Сам скрипт лежит в рабочей папке сессии (`scratchpad/gen_icons.py`). Список нужных
иконок и их размеров задаётся словарём `UI` внутри скрипта.
