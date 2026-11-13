#!/usr/bin/env python3
"""capture-theme.py — записать анимированное превью темы (GIF) без окна на экране.

Используется так:

    python3 tools/capture-theme.py prototype/night.html docs/theme-night.gif

Страница должна поддерживать ?freeze=1 и window.__renderAt(t): скрипт сам
вызывает кадры с нужными временами, поэтому запись детерминирована и не
зависит от загрузки GPU.

Рендер идёт через WebKitGTK в Gtk.OffscreenWindow — на экране ничего не
появляется и фокус не перехватывается.
"""

import argparse
import math
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

from PIL import Image  # noqa: E402


def render_frames(html, width, height, frames, period_ms, warmup_ms):
    win = Gtk.OffscreenWindow()
    win.set_default_size(width, height)
    view = WebKit2.WebView()
    view.set_size_request(width, height)
    win.add(view)
    win.show_all()

    loop = GLib.MainLoop()
    state = {"done": False, "error": None, "frames": []}
    shot = {"pending": False}

    def fail(msg):
        state["error"] = msg
        state["done"] = True
        loop.quit()

    def grab(index):
        shot["pending"] = True

        def on_done(v, result, _data):
            shot["pending"] = False
            try:
                done = v.get_snapshot_finish(result)
                surf = done[0] if isinstance(done, tuple) else done
                surf.write_to_png("/tmp/mintland-frame.png")
                state["frames"].append(Image.open("/tmp/mintland-frame.png").convert("RGB"))
            except Exception as exc:  # noqa: BLE001
                fail("snapshot: %s" % exc)
                return
            if index + 1 >= frames:
                state["done"] = True
                loop.quit()
            else:
                GLib.timeout_add(10, lambda: (advance(index + 1), False)[1])

        view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE,
            WebKit2.SnapshotOptions.NONE,
            None,
            on_done,
            None,
        )

    def advance(index):
        t = warmup_ms + index * period_ms
        view.run_javascript("window.__renderAt(%d)" % t, None, None, None)
        GLib.timeout_add(60, lambda: (grab(index), False)[1])
        return False

    def on_load(_view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            GLib.timeout_add(400, lambda: (advance(0), False)[1])

    view.connect("load-changed", on_load)
    uri = "file://" + str(html.resolve()) + "?wallpaper=1&freeze=1"
    view.load_uri(uri)

    def on_timeout():
        if not state["done"]:
            fail("таймаут: страница не отдала кадры")
        return False

    GLib.timeout_add_seconds(60, on_timeout)
    loop.run()

    if state["error"]:
        raise SystemExit(state["error"])
    return state["frames"]


def save_gif(frames, out, width, duration_ms, colors=128):
    scaled = [f.resize((width, round(width * f.height / f.width)), Image.LANCZOS)
              for f in frames]
    # Один общий палитровый набор на все кадры — без «дрожания» цветов.
    pal = scaled[0].convert("P", palette=Image.ADAPTIVE, colors=colors)
    quantized = []
    for f in scaled:
        q = f.quantize(palette=pal, dither=Image.Dither.NONE)
        quantized.append(q)
    out.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(
        out,
        save_all=True,
        append_images=quantized[1:],
        duration=duration_ms,
        loop=0,
        optimize=True,
        disposal=1,
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("html", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--frames", type=int, default=30)
    ap.add_argument("--period", type=int, default=100, help="мс между кадрами")
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--width", type=int, default=400, help="ширина GIF")
    ap.add_argument("--warmup", type=int, default=0, help="сдвиг времени первого кадра, мс")
    args = ap.parse_args()

    w, h = (int(x) for x in args.size.lower().split("x"))
    frames = render_frames(args.html, w, h, args.frames, args.period, args.warmup)
    save_gif(frames, args.out, args.width, args.period)
    print("%s: %d кадров, %dx%d → %s (%d КБ)" % (
        args.html.name, len(frames), args.width,
        round(args.width * h / w), args.out, args.out.stat().st_size // 1024))


if __name__ == "__main__":
    main()
