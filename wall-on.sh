#!/usr/bin/env bash
# wall-on.sh — включить эксперимент живых обоев (Mintland PoC).
# Контракт — SAFETY.md: без gsettings/dconf, только свои процессы.

set -u
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
RUN="$DIR/run"
mkdir -p "$RUN"
PIDF="$RUN/wall.pid"
LOG="$RUN/wall.log"

say() { notify-send -a Mintland "Mintland" "$1" 2>/dev/null || true; }

# 0. Очистка возможного зависшего состояния (осиротевшие окна от предыдущего запуска)
for p in $(pgrep -f 'mintland/themehost\.py'); do kill "$p" 2>/dev/null; done
for p in $(pgrep -x deskwall); do kill "$p" 2>/dev/null; done
sleep 0.5
rm -f "$PIDF"

# 2. Окружение: X11 и живой nemo-desktop — обязательны (см. SAFETY.md)
if [ "${XDG_SESSION_TYPE:-}" != "x11" ]; then
    say "Сессия не X11 (${XDG_SESSION_TYPE:-?}) — эксперимент требует X11."
    exit 1
fi
if ! pgrep -x nemo-desktop >/dev/null; then
    say "nemo-desktop не запущен — иконки не рисуются. Сначала почините рабочий стол."
    exit 1
fi

# 3. Запуск эксперимента
: > "$LOG"
if ! bash "$DIR/experiment.sh" >"$LOG" 2>&1; then
    say "experiment.sh завершился с ошибкой — см. run/wall.log"
    exit 1
fi

# 4. Зафиксировать PID группы (experiment.sh делает setsid)
sleep 1
PID="$(pgrep -f 'mintland/themehost\.py' | head -1)"
if [ -z "$PID" ]; then
    say "Слой не поднялся — см. run/wall.log"
    exit 1
fi
echo "$PID" > "$PIDF"
echo "== $(date '+%F %T') started, pid $PID ==" >> "$LOG"

say "Слой под иконками включён (PID $PID). Иконки должны быть видны и кликабельны."
