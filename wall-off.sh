#!/usr/bin/env bash
# wall-off.sh — выключить эксперимент живых обоев (Deskland PoC).
# Контракт — SAFETY.md: убиваем ТОЛЬКО свою группу; nemo-desktop не трогаем,
# если он жив; чужие gsettings не трогаем никогда.

set -u
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
RUN="$DIR/run"
mkdir -p "$RUN"
PIDF="$RUN/wall.pid"
LOG="$RUN/wall.log"

say() { notify-send -a Deskland "Deskland" "$1" 2>/dev/null || true; }

STOPPED=0

# 1. Основной путь: kill всей группы (experiment.sh запускается через setsid)
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
    say "Внимание: остались процессы ($LEFT) — посмотрите run/wall.log"
fi

# 4. Здоровье рабочего стола: если nemo-desktop умер сам — поднимаем
if ! pgrep -x nemo-desktop >/dev/null; then
    setsid nohup nemo-desktop >/dev/null 2>&1 &
    sleep 2
    if pgrep -x nemo-desktop >/dev/null; then
        say "Слой остановлен. nemo-desktop был мёртв — перезапущен (иконки вернулись)."
    else
        say "Слой остановлен. nemo-desktop не поднялся — запустите вручную: nemo-desktop"
    fi
else
    [ "$STOPPED" = 1 ] && say "Слой остановлен, иконки на месте." \
                         || say "Ничего не запущено — выключать нечего."
fi

echo "== $(date '+%F %T') stopped ==" >> "$LOG"
exit 0
