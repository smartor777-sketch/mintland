# Deskland на Linux Mint (Cinnamon/X11) — рабочий прототип

Проект: порт Windows-программы [Deskland](https://github.com/BLEZZ0102/Deskland)
(адаптивные обои, сцена реагирует на позиции иконок рабочего стола) под
Linux Mint (Cinnamon / X11). Основан на анализе из `deskland-linux-port.md`.

**Статус:** рабочий прототип v0.1 (пляж под иконками, ~12–20% CPU, авто-пауза).

---

## Что работает

- Сцена `flat.html` (пляж) рисуется **под иконками** рабочего стола Nemo.
- Иконки остаются видимыми и кликабельными (nemo-desktop поверх слоя).
- Позиции иконок читаются из gvfs-метаданных (`gio`) + `desktop-metadata`
  (Компьютер, Корзина, тома) — сцена обтекает их.
- Авто-пауза при развёрнутом/полноэкранном окне (EWMH) → CPU ~0.
- Трей/ярлыки: вкл / выкл / статус (notify-send).
- Апплет Dark Mode не затрагивается (никаких gsettings/dconf).

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│ root window (X11)                                           │
│  ├─ csd-background: обои                                   │
│  ├─ deskwall (контейнер): DESKTOP, пониженный при создании  │
│  │     └─ WebKit (themehost.py): flat.html?wallpaper=1      │
│  └─ nemo-desktop: иконки (ВСЕГДА выше)                      │
└─────────────────────────────────────────────────────────────┘
```

- `deskwall.c` → `bin/deskwall`: создаёт окно-контейнер (тип DESKTOP, XLowerWindow
  в той же пачке, что и XMapWindow — Muffin ставит его ниже nemo-desktop).
  Режимы: `--` (форк команды с подстановкой WID), `--create` (создать контейнер
  и ждать stdin), `-r 0xWINID` (restack окна ниже nemo).
- `themehost.py`: GTK3 + WebKit2 4.1. WebKit-виджет reparent-ится в контейнер
  deskwall. Протокол Deskland: `{t:'icons', vis, r:[[l,t,r,b],...]}` / `ready` /
  `settings` / `reset` / `pause`.
- `iconsource.py`: прямоугольники иконок из `gio metadata::nemo-icon-position`
  + виртуальные иконки из `~/.config/nemo/desktop-metadata`, сетка `desktop-grid-adjust`.
- `experiment.sh`: запуск хоста (софтверный GL для стабильности WebGL2).
- `wall-on.sh` / `wall-off.sh` / `wall-status.sh`: обвязка с защитой от дубля
  и очисткой осиротевших окон.

## Файлы

| Файл | Назначение |
|---|---|
| `deskwall.c` | C-утилита: создание пониженного DESKTOP-окна, restack |
| `bin/deskwall` | Собранный бинарник |
| `iconsource.py` | Источник позиций иконок (gio + desktop-metadata) |
| `themehost.py` | GTK3+WebKit2 хост темы |
| `prototype/flat.html` (и др.) | Тема Deskland (HTML/canvas) — патченная: grain 0, palms 2, birds 1, kayaks 1, scale 0.75 |
| `experiment.sh` | Запуск эксперимента (сейчас — тема flat.html) |
| `wall-on.sh` / `wall-off.sh` / `wall-status.sh` | Обвязка ярлыков |
| `SAFETY.md` | Контракт безопасности (Dark Mode, kill-политика) |

## Ярлыки на рабочем столе

- `Deskland-вкл.desktop` → `~/.local/bin/deskland-on.sh` → `wall-on.sh`
- `Deskland-выкл.desktop` → `~/.local/bin/deskland-off.sh` → `wall-off.sh`
- `Deskland-статус.desktop` → `~/.local/bin/deskland-status.sh` → `wall-status.sh`

## Безопасность (Dark Mode)

Апплет Dark Mode владеет ключами dconf (включая обои `picture-uri`).
Скрипты эксперимента **никогда** не вызывают `gsettings`/`dconf`.
Kill-политика: убиваются только собственные процессы (themehost + deskwall --create).

## Сборка

```bash
# deskwall
cd deskland && cc -O2 -Wall deskwall.c -lX11 -lXext -o bin/deskwall

# Python-зависимости: python3, gi (Gtk 3.0, WebKit2 4.1), iconsource
# Системные: mpv, xwinwrap (не используется в финальной версии), x11-utils
```

## Дорожная карта

- [x] Шаг 1: слой под иконками (deskwall + mpv) — проверено
- [x] Шаг 2: позиции иконок из gio → JSON
- [x] Шаг 3: Electron/WebKit-скелет с flat.html
- [ ] Шаг 4: settings.html, themes.json, сохранение параметров
- [ ] Шаг 5: пауза (EWMH) — реализовано, нужно тестирование
- [ ] Шаг 6: трей, автозапуск, .deb/AppImage
- [ ] Шаг 7: передний кликопрозрачный слой (бонус над иконками)

## Известные ограничения

- Работает только в X11-сессии (Wayland не поддерживается).
- Только основной монитор.
- WebKit использует софтверный GL (стабильность WebGL2) → CPU ~20%.
- nemo-desktop должен быть запущен (иконки).

## Лицензия

Код Deskland — GPL-3.0. Форк с их `prototype/` = производная работа → GPL-3.0.
Имя «Deskland» и иконка не лицензированы — свой репозиторий, своё имя.
