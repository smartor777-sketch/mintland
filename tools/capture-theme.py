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
import json
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

from PIL import Image  # noqa: E402


def sample_icons(width, height, dpr=1):
    """Тестовая раскладка иконок: сетка слева, как на рабочем столе.

    Координаты — в физических пикселях: страница делит их на
    devicePixelRatio, поэтому масштабируем сами.
    """
    rects = []
    cell_w, cell_h = 76, 100
    gx, gy = 40, 40
    for col in range(2):
        for row in range(4):
            x = gx + col * (cell_w + 24)
            y = gy + row * (cell_h + 10)
            if y + cell_h > height:
                break
            rects.append([x, y, x + cell_w, y + cell_h])
    if dpr != 1:
        rects = [[int(v * dpr) for v in r] for r in rects]
    return rects


def render_frames(html, width, height, frames, period_ms, warmup_ms, icons=None):
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
        # Кадр должен попасть в композитор, иначе снимок пустой.
        # Для WebGL-сцен это занимает несколько кадров, поэтому ждём подольше.
        GLib.timeout_add(450, lambda: (grab(index), False)[1])
        return False

    def send_icons():
        if not icons:
            return False
        # Страница ждёт иконки в физических пикселях, а делит их потом
        # на devicePixelRatio — масштабируем по фактическому dpr страницы.
        dpr_js = "window.devicePixelRatio || 1"

        def got(v, result, _d):
            try:
                jr = v.run_javascript_finish(result)
                dpr = float(jr.get_js_value().to_string()) if jr else 1.0
            except Exception:  # noqa: BLE001
                dpr = 1.0
            rects = [[int(c * dpr) for c in r] for r in icons]
            js = "window.__inject && window.__inject(%s)" % json.dumps(
                {"t": "icons", "vis": True, "r": rects})
            view.run_javascript(js, None, None, None)

        view.run_javascript(dpr_js, None, got, None)
        return False

    def on_load(_view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            GLib.timeout_add(400, lambda: (send_icons(), False)[1])
            # Даём странице пересчитать поле и догнать композитору кадр.
            GLib.timeout_add(1200, lambda: (advance(0), False)[1])

    view.connect("load-changed", on_load)
    uri = "file://" + str(html.resolve()) + "?wallpaper=1&freeze=1"
    view.load_uri(uri)

    def on_timeout():
        if not state["done"]:
            fail("таймаут: страница не отдала кадры")
        return False

    GLib.timeout_add_seconds(180, on_timeout)
    loop.run()

    if state["error"]:
        raise SystemExit(state["error"])
    return state["frames"]


def save_gif(frames, out, width, duration_ms, colors=128):
    scaled = [f.resize((width, round(width * f.height / f.width)), Image.LANCZOS)
              for f in frames]
    # Палитра строится по ВСЕМ кадрам сразу. Если взять палитру одного кадра,
    # остальные квантуются в неё и схлопываются в первый — GIF выходит
    # одно-кадровым.
    strip_h = scaled[0].height
    strip = Image.new("RGB", (scaled[0].width, strip_h * len(scaled)))
    for i, f in enumerate(scaled):
        strip.paste(f, (0, i * strip_h))
    pal = strip.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    quantized = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in scaled]

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
    ap.add_argument("--icons", default="grid", help="grid | нет — тестовая раскладка иконок")
    args = ap.parse_args()

    w, h = (int(x) for x in args.size.lower().split("x"))
    icons = sample_icons(w, h) if args.icons != "нет" else None
    frames = render_frames(args.html, w, h, args.frames, args.period, args.warmup, icons)
    save_gif(frames, args.out, args.width, args.period)
    print("%s: %d кадров, %dx%d → %s (%d КБ)" % (
        args.html.name, len(frames), args.width,
        round(args.width * h / w), args.out, args.out.stat().st_size // 1024))


if __name__ == "__main__":
    main()
