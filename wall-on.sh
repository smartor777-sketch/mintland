#!/usr/bin/env bash
# wall-on.sh — включить слой живых обоев Mintland.
# Контракт — docs/SAFETY.md: без gsettings/dconf, только свои процессы.

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

# 2. Окружение: X11 и живой nemo-desktop — обязательны (см. docs/SAFETY.md)
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
PID=""
for _ in $(seq 1 40); do
    PID="$(pgrep -f 'mintland/themehost\.py' | head -1)"
    [ -n "$PID" ] && break
    sleep 0.25
done
if [ -z "$PID" ]; then
    say "Слой не поднялся — см. run/wall.log"
    exit 1
fi
echo "$PID" > "$PIDF"
echo "== $(date '+%F %T') started, pid $PID ==" >> "$LOG"

# 5. Поднять nemo-desktop поверх нашего слоя.
#    Ждём появления окна слоя (а не фиксированные секунды): если поднять nemo
#    раньше, Muffin успевает положить новое DESKTOP-окно выше него.
LAYER_OK=0
for _ in $(seq 1 40); do
    if wmctrl -l 2>/dev/null | grep -q "mintland-wall"; then
        LAYER_OK=1
        break
    fi
    sleep 0.25
done

# Позиция окна в _NET_CLIENT_LIST_STACKING (список идёт снизу вверх).
stack_pos() {
    xprop -root _NET_CLIENT_LIST_STACKING 2>/dev/null \
        | tr ',' '\n' | grep -n -i "$1" | cut -d: -f1
}

# Несколько попыток: Muffin может переставить окна после map.
# Между попытками проверяем, что окно рабочего стола действительно оказалось
# выше нашего слоя — иначе иконки будут скрыты.
for _ in 1 2 3 4; do
    "$DIR/bin/deskwall" -u 2>/dev/null || true
    sleep 0.25
    LW=$(wmctrl -l 2>/dev/null | grep "mintland-wall" | awk '{print $1}')
    DW=$(wmctrl -l 2>/dev/null | grep "Рабочий стол" | awk '{print $1}')
    if [ -z "$LW" ] || [ -z "$DW" ]; then
        continue
    fi
    POS_L=$(stack_pos "$LW")
    POS_D=$(stack_pos "$DW")
    # Рабочий стол выше слоя — иконки видны, можно остановиться.
    if [ -n "$POS_L" ] && [ -n "$POS_D" ] && [ "$POS_D" -gt "$POS_L" ]; then
        break
    fi
done

if [ "$LAYER_OK" != 1 ]; then
    say "Окно слоя не появилось — см. run/wall.log"
    exit 1
fi

say "Слой включён (PID $PID)."
