#!/usr/bin/env bash
# wall-on.sh — включить слой живых обоев Mintland.
# Контракт — SAFETY.md: без gsettings/dconf, только свои процессы.

set -u
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
RUN="$DIR/run"
mkdir -p "$RUN"
PIDF="$RUN/wall.pid"
LOG="$RUN/wall.log"

say() { notify-send -a Mintland "Mintland" "$1" 2>/dev/null || true; }

# 0. Очистка возможного зависшего состояния (осиротевшие окна от предыдущего запуска)
#    Исключаем текущий процесс, чтобы не убить самого себя при тестировании из терминала.
for pid in /proc/[0-9]*; do
  p=$(basename "$pid")
  [ "$p" = "$$" ] && continue
  [ "$p" = "$PPID" ] && continue
  cmd=$(tr '\0' ' ' < "$pid/cmdline" 2>/dev/null)
  case "$cmd" in
    *"mintland/themehost.py"*) kill "$p" 2>/dev/null ;;
  esac
done
for p in $(pgrep -x deskwall); do
  [ "$p" = "$$" ] && continue
  kill "$p" 2>/dev/null
done
sleep 0.5
rm -f "$PIDF"

# 2. Окружение: X11 и живой nemo-desktop — обязательны (см. SAFETY.md)
if [ "${XDG_SESSION_TYPE:-}" != "x11" ]; then
    say "Сессия не X11 (${XDG_SESSION_TYPE:-?}) — слой требует X11."
    exit 1
fi
if ! pgrep -x nemo-desktop >/dev/null; then
    say "nemo-desktop не запущен — иконки не рисуются. Сначала почините рабочий стол."
    exit 1
fi

# 3. Запуск слоя
: > "$LOG"
if ! bash "$DIR/start-layer.sh" >>"$LOG" 2>&1; then
    say "Скрипт запуска завершился с ошибкой — см. run/wall.log"
    exit 1
fi

# 4. Зафиксировать PID группы (start-layer.sh делает setsid)
sleep 1
PID="$(pgrep -f 'mintland/themehost\.py' | head -1)"
if [ -z "$PID" ]; then
    say "Слой не поднялся — см. run/wall.log"
    exit 1
fi
echo "$PID" > "$PIDF"
echo "== $(date '+%F %T') started, pid $PID ==" >> "$LOG"

# поднять nemo-desktop поверх нашего слоя (иначе иконки перекрываются).
# Ждём, пока окно слоя реально появится: если поднять nemo раньше, Muffin
# успевает положить новое DESKTOP-окно выше него — иконки пропадают.
for _ in $(seq 1 20); do
    xwininfo -root -tree 2>/dev/null | grep -q '"mintland-wall"' && break
    sleep 0.5
done
# нескольких попыток достаточно, если Muffin переставит окна после map
for _ in 1 2 3; do
    "$DIR/bin/deskwall" -u 2>/dev/null || true
    sleep 0.5
done

say "Слой включён (PID $PID)."
