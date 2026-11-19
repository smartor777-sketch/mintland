#!/usr/bin/env bash
# start-layer.sh — запуск слоя Mintland.
# Тема по умолчанию — flat.html (пляж); выбор темы делает switcher.py.
# Скрипт вызывается из wall-on.sh.
#
# ВАЖНО (см. docs/SAFETY.md): никаких gsettings/dconf, никаких kill чужих процессов.

set -u

notify_err() {
    notify-send -u critical -a Mintland "Mintland: не запущено" "$1" 2>/dev/null || true
    exit 1
}

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export PATH="$DIR/bin:$PATH"

# Рабочее состояние: run/ в дереве исходников, ~/.cache/mintland в
# установленном пакете (/usr/lib/mintland только для чтения).
if [ -n "${MINTLAND_RUNTIME:-}" ]; then
    RUN="$MINTLAND_RUNTIME"
elif [ -w "$DIR" ]; then
    RUN="$DIR/run"
else
    RUN="${XDG_CACHE_HOME:-$HOME/.cache}/mintland"
fi
export MINTLAND_RUNTIME="$RUN"
mkdir -p "$RUN"

# Данные (HTML-темы, превью): рядом с кодом в репозитории или в
# /usr/share/mintland в установленном пакете.
if [ -d "$DIR/prototype" ]; then
    DATA="$DIR"
else
    DATA="${MINTLAND_DATA:-/usr/share/mintland}"
fi

command -v mpv >/dev/null || true

[ "${XDG_SESSION_TYPE:-}" = "x11" ] || notify_err "Нужна X11-сессия (сейчас: ${XDG_SESSION_TYPE:-?})."
case "${XDG_CURRENT_DESKTOP:-}" in
    *Cinnamon*) ;;
    *) notify_err "Mintland рассчитан на Cinnamon/X11 (сейчас: ${XDG_CURRENT_DESKTOP:-?})." ;;
esac
command -v nemo-desktop >/dev/null 2>&1 || \
    notify_err "Не найден nemo-desktop. Установите Nemo: Mintland использует его иконки."
[ -x "$DIR/bin/deskwall" ] || notify_err "bin/deskwall не собран (см. deskwall.c)"
[ -f "$DIR/themehost.py" ] || notify_err "themehost.py не найден"
HTML="${DESKLAND_HTML:-$DATA/prototype/flat.html}"
[ -f "$HTML" ] || notify_err "Тема не найдена: $HTML"

# хост: окно типа DESKTOP + keep_below, WebKit рисует сцену под иконками.
# Используется аппаратное ускорение (WebGL2 через Mesa); софтверный рендер
# оставлен как аварийный вариант через переменные окружения WebKit.
#
# Приоритет снижен: обои не должны конкурировать с приложениями пользователя.
# nice -n 10 понижает приоритет CPU (для обычного пользователя это разрешено —
# понижать можно всегда), ionice -c3 переводит ввод-вывод в класс idle.
# Порядок важен: ionice запускает nice, а не наоборот, иначе класс I/O
# теряется.
NICE="nice -n 10"
if command -v ionice >/dev/null 2>&1; then
    NICE="ionice -c3 nice -n 10"
fi

setsid $NICE python3 "$DIR/themehost.py" \
    --html "$HTML" --control "$RUN/control.json" --marker mintland-wall &
disown 2>/dev/null || true
exit 0
