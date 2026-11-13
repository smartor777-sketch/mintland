#!/usr/bin/env bash
# wall-status.sh — что сейчас работает (эксперимент, nemo-desktop, X11).

set -u
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PIDF="$DIR/run/wall.pid"
LOG="$DIR/run/wall.log"

lines=()
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
    lines+=("Слой: ЗАПУЩЕН (PID $(cat "$PIDF"))")
else
    lines+=("Слой: не запущен")
fi
lines+=("nemo-desktop: $(pgrep -x nemo-desktop >/dev/null && echo работает || echo НЕТ)")
lines+=("сессия: ${XDG_SESSION_TYPE:-?}")
if [ -s "$LOG" ]; then
    lines+=("--- run/wall.log (последние 5 строк) ---")
    while IFS= read -r l; do lines+=("$l"); done < <(tail -5 "$LOG")
fi

msg="$(printf '%s\n' "${lines[@]}")"
notify-send -a Mintland -t 10000 "Mintland: статус" "$msg" 2>/dev/null \
    || printf '%s\n' "$msg"
