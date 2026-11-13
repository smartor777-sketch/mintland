#!/usr/bin/env python3
"""Превью темы с иконками: снимок одного кадра с ореолами вокруг иконок.

    python3 tools/preview-frame.py prototype/night.html /tmp/frame.png --t 2000
"""

import argparse
import json
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

THEMEHOST = Path(__file__).resolve().parent.parent / "themehost.py"
SHIM = THEMEHOST.read_text(encoding="utf-8").split('SHIM_JS = """')[1].split('"""')[0]


def capture(html, out, t_ms, w, h, icons):
    view = WebKit2.WebView()
    view.set_size_request(w, h)
    try:
        view.get_settings().set_allow_file_access_from_file_urls(True)
    except Exception:  # noqa: BLE001
        pass

    win = Gtk.OffscreenWindow()
    win.set_default_size(w, h)
    win.add(view)
    win.show_all()

    ucm = view.get_user_content_manager()
    ucm.add_script(WebKit2.UserScript(
        SHIM, WebKit2.UserContentInjectedFrames.ALL_FRAMES,
        WebKit2.UserScriptInjectionTime.START, None, None))

    loop = GLib.MainLoop()
    box = {"done": False}

    def shot():
        def done(v, res, _d):
            d = v.get_snapshot_finish(res)
            surf = d[0] if isinstance(d, tuple) else d
            surf.write_to_png(str(out))
            box["done"] = True
            loop.quit()
        view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE,
                          WebKit2.SnapshotOptions.NONE, None, done, None)

    def go():
        if icons:
            js = "window.__inject && window.__inject(%s)" % json.dumps(
                {"t": "icons", "vis": True, "r": icons})
            view.run_javascript(js, None, None, None)
        view.run_javascript("window.__renderAt && window.__renderAt(%d)" % t_ms,
                           None, None, None)
        GLib.timeout_add(120, shot)
        return False

    def on_load(_v, event):
        if event == WebKit2.LoadEvent.FINISHED:
            GLib.timeout_add(400, go)

    view.connect("load-changed", on_load)
    view.load_uri("file://" + str(html.resolve()) + "?wallpaper=1&freeze=1")
    GLib.timeout_add_seconds(30, lambda: (loop.quit(), False)[1])
    loop.run()
    if not box["done"]:
        raise SystemExit("не удалось получить снимок")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--t", type=int, default=2000)
    ap.add_argument("--size", default="1600x900")
    ap.add_argument("--icons", default="grid", help="grid | нет")
    args = ap.parse_args()

    w, h = (int(x) for x in args.size.lower().split("x"))
    icons = []
    if args.icons == "grid":
        # Сетка «как на рабочем столе»: 76×100 с шагом 100 по вертикали.
        gx, gy = 40, 40
        for col in range(2):
            for row in range(4):
                x = gx + col * 100
                y = gy + row * 100
                icons.append([x, y, x + 76, y + 100])
    capture(args.html, args.out, args.t, w, h, icons)
    print("ok:", args.out)


if __name__ == "__main__":
    sys.exit(main())
