#!/usr/bin/env bash
# wall-on.sh — включить слой живых обоев Mintland.
# Контракт — docs/SAFETY.md: без gsettings/dconf, только свои процессы.

set -u
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

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
PIDF="$RUN/wall.pid"
LOG="$RUN/wall.log"

say() { notify-send -a Mintland "Mintland" "$1" 2>/dev/null || true; }

# 0. Очистка возможного зависшего состояния (осиротевшие окна от предыдущего запуска)
#    Исключаем текущий процесс, чтобы не убить самого себя при тестировании из терминала.
for pid in /proc/[0-9]*; do
  p=$(basename "$pid")
  [ "$p" = "$$" ] && continue
  [ "$p" = "$PPID" ] && continue
  [ -r "$pid/cmdline" ] || continue
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

# 2. Окружение: X11, Cinnamon и рабочий стол Nemo — обязательны
#    (см. docs/SAFETY.md).
if [ "${XDG_SESSION_TYPE:-}" != "x11" ]; then
    say "Сессия не X11 (${XDG_SESSION_TYPE:-?}) — слой требует X11."
    exit 1
fi
case "${XDG_CURRENT_DESKTOP:-}" in
    *Cinnamon*) ;;
    *)
        say "Mintland рассчитан на Cinnamon/X11 (сейчас: ${XDG_CURRENT_DESKTOP:-?})."
        exit 1
        ;;
esac
if ! command -v nemo-desktop >/dev/null 2>&1; then
    say "Не найден nemo-desktop. Установите Nemo: Mintland использует его иконки."
    exit 1
fi

# Проверять надо не процесс, а ОКНО рабочего стола. nemo-desktop при старте
# ищет любое окно типа DESKTOP и, найдя, отказывается вести рабочий стол
# («Desktop already managed by another application»). Если процесс жив, но
# окна нет, иконок не будет никогда — сколько ни жди.
desk_window_present() {
    # WM_CLASS не зависит от языка: заголовок может быть «Рабочий стол»
    # или «Desktop», а класс всегда nemo-desktop.Nemo-desktop.
    wmctrl -lx 2>/dev/null | grep -q "nemo-desktop\.Nemo-desktop"
}

if ! desk_window_present; then
    if pgrep -x nemo-desktop >/dev/null; then
        # Процесс есть, но роль рабочего стола он не взял: пока наш слой
        # работал, Nemo видел чужое DESKTOP-окно. Перезапускаем.
        pkill -x nemo-desktop 2>/dev/null
        sleep 1
    fi
    setsid nohup nemo-desktop >/dev/null 2>&1 < /dev/null &
    for _ in $(seq 1 60); do
        desk_window_present && break
        sleep 0.25
    done
    if ! desk_window_present; then
        say "Рабочий стол Nemo не поднялся — иконки не рисуются. Запустите: nemo-desktop"
        exit 1
    fi
fi

# 3. Запуск слоя
: > "$LOG"
if ! bash "$DIR/start-layer.sh" >>"$LOG" 2>&1; then
    say "Скрипт запуска завершился с ошибкой — см. $LOG"
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
    say "Слой не поднялся — см. $LOG"
    exit 1
fi
echo "$PID" > "$PIDF"
echo "== $(date '+%F %T') started, pid $PID ==" >> "$LOG"

# 5. Дождаться окна слоя.
#
#    nemo-desktop должен успеть занять роль рабочего стола ДО появления нашего
#    DESKTOP-окна (иначе он откажется — см. docs/SAFETY.md). Это уже
#    проверено в шаге 2, поэтому здесь только ждём map нашего окна.
#
#    Поднимать nemo через `deskwall -u` НЕ нужно и вредно: замер показал,
#    что XRaiseWindow сбрасывает правильный порядок, который Muffin
#    выставил сам, — и иконки уходят под сцену. themehost.py сам поправляет
#    стек переустановкой типа окна.
LAYER_OK=0
for _ in $(seq 1 40); do
    if wmctrl -l 2>/dev/null | grep -q "mintland-wall"; then
        LAYER_OK=1
        break
    fi
    sleep 0.25
done

if [ "$LAYER_OK" != 1 ]; then
    say "Окно слоя не появилось — см. $LOG"
    exit 1
fi

say "Слой включён (PID $PID)."
