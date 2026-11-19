#!/usr/bin/env bash
# wall-off.sh — выключить слой живых обоев Mintland.
# Контракт — docs/SAFETY.md: убиваем ТОЛЬКО свою группу; nemo-desktop перезапускаем
# после снятия слоя (иначе он не вернёт роль рабочего стола); gsettings/dconf
# не трогаем никогда.

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

STOPPED=0

# 1. Основной путь: kill всей группы (start-layer.sh запускается через setsid)
if [ -f "$PIDF" ]; then
    PID="$(cat "$PIDF" 2>/dev/null)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
        sleep 1
        kill -0 "$PID" 2>/dev/null && kill -KILL -- "-$PID" 2>/dev/null
        STOPPED=1
    fi
    rm -f "$PIDF"
fi

# 2. Фолбэк: по пути скрипта хоста (строго, чтобы не задеть чужое)
if pgrep -f 'mintland/themehost\.py' >/dev/null; then
    pkill -TERM -f 'mintland/themehost\.py' 2>/dev/null
    sleep 1
    pkill -KILL -f 'mintland/themehost\.py' 2>/dev/null
    STOPPED=1
fi

# контейнер deskwall (--create) тоже должен умереть
if pgrep -f 'deskwall --create' >/dev/null; then
    pkill -TERM -f 'deskwall --create' 2>/dev/null
    sleep 1
    pkill -KILL -f 'deskwall --create' 2>/dev/null
fi

# 3. Проверка чистоты: наших процессов не осталось
LEFT="$(pgrep -f 'mintland/themehost\.py' | tr '\n' ' ')"
if [ -n "$LEFT" ]; then
    say "Внимание: остались процессы ($LEFT) — посмотрите $LOG"
fi

# 4. Перезапускаем nemo-desktop после остановки: наш DESKTOP-слой заставляет
#    nemo отказаться от роли рабочего стола, и без перезапуска иконки не
#    вернутся (и следующий запуск будет без иконок).
#
#    Важно: ждём не фиксированные секунды, а появления окна рабочего стола.
#    Если вернуться раньше, следующий wall-on.sh поднимет слой до того, как
#    nemo успеет занять роль, — и он откажется её брать
#    («Desktop already managed by another application»).
#    Иконки тогда появятся только после ручного перезапуска nemo.
DESK_OK=0
if command -v nemo-desktop >/dev/null 2>&1; then
    pkill -x nemo-desktop 2>/dev/null
    sleep 1
    setsid nohup nemo-desktop >/dev/null 2>&1 < /dev/null &

    # Ждём окно рабочего стола (до 15 с). Обычно это 1–3 с.
    for _ in $(seq 1 60); do
        if wmctrl -lx 2>/dev/null | grep -q "nemo-desktop\.Nemo-desktop"; then
            DESK_OK=1
            break
        fi
        sleep 0.25
    done
fi

if [ "$DESK_OK" = 1 ]; then
    [ "$STOPPED" = 1 ] && say "Слой остановлен, иконки на месте." \
                         || say "Рабочий стол перезапущен."
else
    say "Слой остановлен, но окно рабочего стола не появилось — запустите: nemo-desktop"
fi
echo "== $(date '+%F %T') stopped ==" >> "$LOG"
exit 0
