# Mintland на Linux Mint (Cinnamon/X11) — рабочий прототип

Проект: порт Windows-программы [Deskland](https://github.com/BLEZZ0102/Deskland)
(адаптивные обои, сцена реагирует на позиции иконок рабочего стола) под
Linux Mint (Cinnamon / X11). Основан на анализе из `mintland-linux-port.md`.

**Статус:** рабочий прототип v0.2 (пляж под иконками, иконки кликабельны,
вкл/выкл работают повторно, ~12–20% CPU, авто-пауза).

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
│  ├─ csd-background: системные обои                          │
│  ├─ themehost.py: окно DESKTOP + keep_below                 │
│  │     └─ WebKit: flat.html?wallpaper=1 (сцена)             │
│  └─ nemo-desktop: иконки (поднят поверх слоя через -u)      │
└─────────────────────────────────────────────────────────────┘
```

- `themehost.py`: GTK3 + WebKit2 4.1. Окно с типом `DESKTOP` и `keep_below`
  уходит в слой рабочего стола ниже обычных окон; WebKit рисует сцену.
  После запуска `deskwall -u` поднимает окно `nemo-desktop`, поэтому иконки
  оказываются поверх сцены и остаются кликабельными. Протокол Mintland:
  `{t:'icons', vis, r:[[l,t,r,b],...]}` / `ready` / `settings` / `reset` / `pause`.
- `deskwall.c` → `bin/deskwall`: X11-утилита. Режимы: `-u` (поднять
  `nemo-desktop` поверх слоя), `-r 0xWINID` (restack окна ниже nemo),
  `--` (форк команды с подстановкой WID), `--create` (контейнер — оставлен
  как экспериментальный режим, текущий хост его не использует).
- `iconsource.py`: прямоугольники иконок из `gio metadata::nemo-icon-position`
  + виртуальные иконки из `~/.config/nemo/desktop-metadata`, сетка `desktop-grid-adjust`.
- `experiment.sh`: запуск хоста (аппаратное ускорение WebKit).
- `wall-on.sh` / `wall-off.sh` / `wall-status.sh`: обвязка с защитой от дубля
  и очисткой осиротевших окон. `wall-off.sh` после снятия слоя перезапускает
  `nemo-desktop`, чтобы иконки гарантированно вернулись.

## Файлы

| Файл | Назначение |
|---|---|
| `deskwall.c` | C-утилита: подъём nemo поверх слоя, restack, контейнер |
| `bin/deskwall` | Собранный бинарник |
| `iconsource.py` | Источник позиций иконок (gio + desktop-metadata) |
| `themehost.py` | GTK3+WebKit2 хост темы |
| `prototype/flat.html` (и др.) | Тема Mintland (HTML/canvas) — патченная: grain 0, palms 2, birds 1, kayaks 1, scale 0.75 |
| `experiment.sh` | Запуск эксперимента (сейчас — тема flat.html) |
| `wall-on.sh` / `wall-off.sh` / `wall-status.sh` | Обвязка ярлыков |
| `SAFETY.md` | Контракт безопасности (Dark Mode, kill-политика) |

## Ярлыки на рабочем столе

- `Mintland-вкл.desktop` → `~/.local/bin/mintland-on.sh` → `wall-on.sh`
- `Mintland-выкл.desktop` → `~/.local/bin/mintland-off.sh` → `wall-off.sh`
- `Mintland-статус.desktop` → `~/.local/bin/mintland-status.sh` → `wall-status.sh`

## Безопасность (Dark Mode)

Апплет Dark Mode владеет ключами dconf (включая обои `picture-uri`).
Скрипты эксперимента **никогда** не вызывают `gsettings`/`dconf`.
Kill-политика: убиваются только собственные процессы (themehost + deskwall --create).

## Сборка

```bash
# deskwall
cd mintland && cc -O2 -Wall deskwall.c -lX11 -lXext -o bin/deskwall

# Python-зависимости: python3, gi (Gtk 3.0, WebKit2 4.1), iconsource
# Системные: x11-utils (xprop/xwininfo), xrandr; mpv/xwinwrap не используются
```

## Дорожная карта

- [x] Шаг 1: слой под иконками (deskwall) — проверено
- [x] Шаг 2: позиции иконок из gio → JSON
- [x] Шаг 3: Electron/WebKit-скелет с flat.html
- [x] Шаг 4: пауза (EWMH) — проверено, CPU ~0 при развёрнутом окне
- [x] Шаг 5: иконки поверх сцены и кликабельны; цикл вкл/выкл/вкл — проверено
- [ ] Шаг 6: settings.html, themes.json, сохранение параметров
- [ ] Шаг 7: трей, автозапуск, .deb/AppImage
- [ ] Шаг 8: передний кликопрозрачный слой (бонус над иконками)

## Известные ограничения

- Работает только в X11-сессии (Wayland не поддерживается).
- Только основной монитор.
- `nemo-desktop` должен быть запущен **до** слоя; иначе Nemo отказывается
  от роли рабочего стола («Desktop already managed by another application»).
- После выключения слоя `wall-off.sh` перезапускает `nemo-desktop` — это
  возвращает иконки и готовит чистый старт для следующего включения.
- WebKit работает через аппаратное ускорение Mesa (WebGL2); на слабых GPU
  можно включить софтверный рендер переменными `WEBKIT_DISABLE_COMPOSITING_MODE=1`,
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`, `LIBGL_ALWAYS_SOFTWARE=1`.

## Лицензия

Код Deskland (оригинал) — GPL-3.0. Форк с их `prototype/` = производная работа → GPL-3.0.
Имя «Deskland» и иконка оригинала не лицензированы — наш проект использует имя «Mintland».
