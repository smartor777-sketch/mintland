#!/usr/bin/env bash
# experiment.sh — ТЕКУЩИЙ эксперимент Deskland PoC.
# ЭТАП 2: тема flat.html (пляж) через GTK+WebKit-хост themehost.py + иконки из gio.
# Меняется по мере продвижения; wall-on.sh / ярлыки не трогаем.
#
# ВАЖНО (см. SAFETY.md): никаких gsettings/dconf, никаких kill чужих процессов.

set -u

notify_err() {
    notify-send -u critical -a Deskland "Deskland: не запущено" "$1" 2>/dev/null || true
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

# хост: управляемое окно type=DESKTOP под иконками + WebKit + watchdog restack
# Софтверный рендер (WebGL в WebKitGTK стабильнее с ним; нагрузка ~20% при 0.75×)
export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
exec setsid python3 "$DIR/themehost.py" --html "$HTML" --marker deskland-poc-wall
