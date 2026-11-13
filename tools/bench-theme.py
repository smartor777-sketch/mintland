#!/usr/bin/env python3
"""bench-theme.py — время одного кадра темы и вклад отдельных эффектов.

    python3 tools/bench-theme.py prototype/night.html

Страница должна понимать ?freeze=1 и window.__renderAt(t). Замер идёт в
Gtk.OffscreenWindow, окно на экране не появляется.
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

BENCH_JS = r"""
(function (paramJson) {
  if (paramJson) {
    var v = JSON.parse(paramJson);
    if (window.__inject) window.__inject({ t: 'settings', v: v });
  }
  if (!window.__renderAt) return JSON.stringify({ error: 'нет __renderAt' });
  var N = 12;
  window.__renderAt(1000);                       // прогрев
  var t0 = performance.now();
  for (var i = 0; i < N; i++) window.__renderAt(1000 + i * 33);
  var ms = (performance.now() - t0) / N;
  return JSON.stringify({ ms: ms, fps: 1000 / ms });
})(%s)
"""


class Bench:
    def __init__(self, html, w, h):
        self.view = WebKit2.WebView()
        self.view.set_size_request(w, h)
        try:
            self.view.get_settings().set_allow_file_access_from_file_urls(True)
        except Exception:  # noqa: BLE001
            pass
        win = Gtk.OffscreenWindow()
        win.set_default_size(w, h)
        win.add(self.view)
        win.show_all()
        self.win = win
        ucm = self.view.get_user_content_manager()
        ucm.add_script(WebKit2.UserScript(
            SHIM, WebKit2.UserContentInjectedFrames.ALL_FRAMES,
            WebKit2.UserScriptInjectionTime.START, None, None))
        self.loop = GLib.MainLoop()

    def load(self, uri):
        done = {"v": False}

        def on_load(_v, ev):
            if ev == WebKit2.LoadEvent.FINISHED:
                GLib.timeout_add(600, lambda: (self.loop.quit(), False)[1])

        self.view.connect("load-changed", on_load)
        self.view.load_uri(uri)
        GLib.timeout_add_seconds(40, lambda: (self.loop.quit(), False)[1])
        self.loop.run()

    def eval_js(self, js, timeout=20):
        loop = GLib.MainLoop()
        box = {}

        def done(v, res, _d):
            try:
                jr = v.run_javascript_finish(res)
                if jr is not None:
                    box["v"] = jr.get_js_value().to_string()
            except Exception as exc:  # noqa: BLE001
                box["e"] = str(exc)
            loop.quit()

        self.view.run_javascript(js, None, done, None)
        GLib.timeout_add_seconds(timeout, lambda: (loop.quit(), False)[1])
        loop.run()
        return box.get("v")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html", type=Path)
    ap.add_argument("--size", default="2560x1440")
    args = ap.parse_args()

    w, h = (int(x) for x in args.size.lower().split("x"))
    b = Bench(args.html, w, h)
    b.load("file://" + str(args.html.resolve()) + "?wallpaper=1&freeze=1")

    cases = [
        ("всё как есть", None),
        ("туман выключен", {"mist": 0}),
        ("сияние выключено", {"aurora": 0}),
        ("ореолы выключены", {"halo": 0}),
        ("без эффектов", {"mist": 0, "aurora": 0, "halo": 0, "shoot": 0}),
        ("вернуть всё", {"mist": 0.5, "aurora": 0.7, "halo": 96, "shoot": 2}),
    ]

    print("\n%s (%dx%d)" % (args.html, w, h))
    for name, params in cases:
        raw = b.eval_js(BENCH_JS % json.dumps(json.dumps(params) if params else ""))
        try:
            d = json.loads(raw)
        except Exception:  # noqa: BLE001
            print("  %-18s ошибка: %r" % (name, raw))
            continue
        if "error" in d:
            print("  %-18s %s" % (name, d["error"]))
            return 1
        print("  %-18s %6.1f мс/кадр   (%.0f fps)" % (name, d["ms"], d["fps"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
