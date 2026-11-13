#!/usr/bin/env python3
# iconsource.py — прямоугольники иконок рабочего стола Mint/Cinnamon (Nemo).
#
# Источники:
#   1) файлы ~/Рабочий стол — gvfs-метаданные metadata::nemo-icon-position (gio);
#   2) виртуальные иконки (Компьютер, Корзина, тома) — ~/.config/nemo/desktop-metadata;
#   3) размер ячейки — desktop-grid-adjust=W;H из того же файла.
#
# Выдача: список прямоугольников [left, top, right, bottom] в ЛОГИЧЕСКИХ
# пикселях (физические: умножить на scale, это делает themehost).
# Никаких вызовов gsettings/dconf (см. docs/SAFETY.md).

import configparser
import os
import re
import subprocess
from pathlib import Path

DESKTOP_DIR = Path.home() / "Рабочий стол"
DESKTOP_META = Path.home() / ".config/nemo/desktop-metadata"
DEFAULT_GRID = (82, 75)


def _gio_positions(paths):
    """{path: (x, y)} из gio info; файлы без позиции отсутствуют в результате."""
    if not paths:
        return {}
    cmd = ["gio", "info", "-a", "metadata::nemo-icon-position"] + [str(p) for p in paths]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return {}
    result = {}
    cur = None
    for line in out.splitlines():
        m = re.match(r"^\s*(.+?):\s*$", line) if line and not line.startswith(" ") else None
        # gio выводит блоки: строка с uri/путём, затем "атрибуты:", затем "  metadata::..."
        m_pos = re.search(r"metadata::nemo-icon-position:\s*(\d+)\s*,\s*(\d+)", line)
        if m_pos and cur is not None:
            result[cur] = (int(m_pos.group(1)), int(m_pos.group(2)))
            cur = None
        elif line.startswith("unix mount") or line.startswith("локальный путь"):
            # блок привязан к файлу, показанному строкой выше; берём путь из uri-строки
            pass
        m_uri = re.match(r"^(?:uri|URI):\s*file://(.+)$", line)
        if m_uri:
            from urllib.parse import unquote
            cur = Path("/" + unquote(m_uri.group(1)))
    return result


def _grid_size():
    try:
        text = DESKTOP_META.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return DEFAULT_GRID
    m = re.search(r"desktop-grid-adjust=(\d+);(\d+)", text)
    if not m:
        return DEFAULT_GRID
    return int(m.group(1)), int(m.group(2))


def _virtual_icons():
    """[{name, x, y}] виртуальных иконок из desktop-metadata."""
    result = []
    cp = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        cp.read(DESKTOP_META, encoding="utf-8")
    except Exception:
        return result
    for section in cp.sections():
        pos = cp.get(section, "nemo-icon-position", fallback=None)
        if not pos:
            continue
        m = re.match(r"\s*(\d+)\s*,\s*(\d+)", pos)
        if not m:
            continue
        # имя: computer/trash оставляем как есть, тома — по имени раздела
        name = section.split(".volume")[0].strip("[]")
        result.append({"name": name, "x": int(m.group(1)), "y": int(m.group(2))})
    return result


def collect():
    """Список прямоугольников [[l,t,r,b], ...] в логических пикселях."""
    grid_w, grid_h = _grid_size()
    rects = []

    files = [p for p in DESKTOP_DIR.iterdir() if not p.name.startswith(".")] \
        if DESKTOP_DIR.is_dir() else []
    positions = _gio_positions(files)
    for path, (x, y) in sorted(positions.items()):
        rects.append([x, y, x + grid_w, y + grid_h])

    for v in _virtual_icons():
        x, y = v["x"], v["y"]
        rects.append([x, y, x + grid_w, y + grid_h])

    return rects


if __name__ == "__main__":
    import json
    print(json.dumps(collect()))
