#!/usr/bin/env bash
# experiment.sh — ТЕКУЩИЙ эксперимент Mintland PoC.
# ЭТАП 2: тема flat.html (пляж) через GTK+WebKit-хост themehost.py + иконки из gio.
# Меняется по мере продвижения; wall-on.sh / ярлыки не трогаем.
#
# ВАЖНО (см. SAFETY.md): никаких gsettings/dconf, никаких kill чужих процессов.

set -u

notify_err() {
    notify-send -u critical -a Mintland "Mintland: не запущено" "$1" 2>/dev/null || true
    exit 1
}

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export PATH="$DIR/bin:$PATH"

command -v mpv >/dev/null || true

[ "${XDG_SESSION_TYPE:-}" = "x11" ] || notify_err "Нужна X11-сессия (сейчас: ${XDG_SESSION_TYPE:-?})."
[ -x "$DIR/bin/deskwall" ] || notify_err "bin/deskwall не собран (см. deskwall.c)"
[ -f "$DIR/themehost.py" ] || notify_err "themehost.py не найден"
HTML="${DESKLAND_HTML:-$DIR/prototype/flat.html}"
[ -f "$HTML" ] || notify_err "Тема не найдена: $HTML"

# хост: окно типа DESKTOP + keep_below, WebKit рисует сцену под иконками.
# Используется аппаратное ускорение (WebGL2 через Mesa); софтверный рендер
# оставлен как аварийный вариант через переменные окружения WebKit.
setsid python3 "$DIR/themehost.py" --html "$HTML" --marker mintland-poc-wall &
disown 2>/dev/null || true
exit 0
