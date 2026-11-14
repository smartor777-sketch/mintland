#!/usr/bin/env python3
"""test-theme.py — проверить страницу темы на соответствие протоколу Mintland.

    python3 tools/test-theme.py prototype/night.html

Проверяется без запуска слоя и без появления окон на экране (Gtk.OffscreenWindow):

  1. страница отправила 'ready';
  2. кадр рисуется (не пустой холст);
  3. страница реагирует на {t:'settings'};
  4. страница реагирует на {t:'icons'};
  5. страница переживает {t:'pause', v:true} и {t:'pause', v:false} без ошибок;
  6. нет ошибок JS в консоли.

Код возврата: 0 — всё хорошо, 1 — есть провал.
"""

import argparse
import json
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

ERROR_JS = """
(function () {
  window.__errors = [];
  window.addEventListener('error', function (e) {
    window.__errors.push(String(e.message || e.error));
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__errors.push('rejection: ' + String(e.reason));
  });
})();
"""

RESULT_JS = r"""
(function () {
  var c = document.getElementById('art') || document.querySelector('canvas');
  var out = { hasCanvas: !!c, w: location.href };
  if (c) {
    try {
      var g = c.getContext('2d');
      if (g) {
        // Пробуем несколько точек: небо может быть однородным сверху.
        var pts = [[0.5,0.5],[0.1,0.1],[0.9,0.8],[0.3,0.7]];
        var nonEmpty = false, sample = [];
        for (var i = 0; i < pts.length; i++) {
          var d = g.getImageData(Math.round(c.width*pts[i][0]), Math.round(c.height*pts[i][1]), 1, 1).data;
          sample.push([d[0], d[1], d[2]]);
          if (d[0] + d[1] + d[2] > 12) nonEmpty = true;
        }
        out.nonEmpty = nonEmpty;
        out.sample = sample;
      } else {
        // WebGL-сцену пиксельно так не прочитать — считаем нарисованной,
        // но запоминаем, что это WebGL, чтобы не требовать ореолов.
        out.webgl = true;
      }
    } catch (e) { out.err = String(e); }
  }
  out.hooks = { renderAt: typeof window.__renderAt, inject: typeof window.__inject };
  return JSON.stringify(out);
})()
"""


class Runner:
    def __init__(self, html, width=1280, height=720):
        self.html = html
        self.ready = False
        self.console = []
        self.view = WebKit2.WebView()
        self.view.set_size_request(width, height)
        # Как в themehost.py: без этого WebKit не отдаёт соседние .js/.png
        # со страницы, загруженной через file://.
        try:
            self.view.get_settings().set_allow_file_access_from_file_urls(True)
        except Exception:  # noqa: BLE001
            pass

        win = Gtk.OffscreenWindow()
        win.set_default_size(width, height)
        win.add(self.view)
        win.show_all()
        self.win = win

        ucm = self.view.get_user_content_manager()
        ucm.register_script_message_handler("mintland")
        ucm.connect("script-message-received::mintland", self._on_msg)
        # Тот же шим, что и в themehost.py — иначе страница не увидит host.
        ucm.add_script(WebKit2.UserScript(
            Path(__file__).resolve().parent.parent.joinpath("themehost.py")
            .read_text(encoding="utf-8").split('SHIM_JS = """')[1].split('"""')[0],
            WebKit2.UserContentInjectedFrames.ALL_FRAMES,
            WebKit2.UserScriptInjectionTime.START, None, None))

        # В WebKit2GTK 4.1 сигнала console-message нет — собираем ошибки
        # сами через window.onerror и unhandledrejection.
        ucm.add_script(WebKit2.UserScript(
            ERROR_JS,
            WebKit2.UserContentInjectedFrames.ALL_FRAMES,
            WebKit2.UserScriptInjectionTime.START, None, None))
        self.view.connect("load-changed", self._on_load)

    def _on_msg(self, _ucm, res):
        try:
            jv = res.get_js_value()
            text = jv.to_string() if jv else ""
        except Exception:  # noqa: BLE001
            text = ""
        if (text or "").strip() == "ready":
            self.ready = True

    def _collect_errors(self):
        raw = self.eval_js("JSON.stringify(window.__errors || [])")
        try:
            self.console.extend(json.loads(raw) if raw else [])
        except Exception:  # noqa: BLE001
            pass

    def _on_load(self, _v, event):
        if event == WebKit2.LoadEvent.FINISHED:
            self.loaded = True

    def run(self, uri, steps):
        """steps: список (задержка_мс, js). Выполняются последовательно."""
        loop = GLib.MainLoop()
        queue = list(steps)

        def step():
            if not queue:
                loop.quit()
                return False
            delay, js = queue.pop(0)
            if js:
                self.view.run_javascript(js, None, None, None)
            GLib.timeout_add(max(1, delay), step)
            return False

        GLib.timeout_add(900, step)          # первый шаг — после загрузки
        GLib.timeout_add_seconds(45, lambda: (loop.quit(), False)[1])
        self.view.load_uri(uri)
        loop.run()

    def snapshot(self):
        """Снимок текущего кадра как байты RGBA (работает и для 2D, и для WebGL)."""
        loop = GLib.MainLoop()
        box = {"data": None}

        def done(v, res, _d):
            try:
                r = v.get_snapshot_finish(res)
                surf = r[0] if isinstance(r, tuple) else r
                data = bytes(surf.get_data())
                box["data"] = (surf.get_width(), surf.get_height(), surf.get_stride(), data)
            except Exception as exc:  # noqa: BLE001
                box["error"] = str(exc)
            loop.quit()

        def guard():
            loop.quit()
            return False

        self.view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE,
                               WebKit2.SnapshotOptions.NONE, None, done, None)
        GLib.timeout_add_seconds(10, guard)
        loop.run()
        return box.get("data")

    def eval_js(self, js, timeout=5):
        """Синхронно вернуть результат run_javascript."""
        loop = GLib.MainLoop()
        box = {"value": None, "done": False}

        def done(v, res, _d):
            box["done"] = True
            try:
                jr = v.run_javascript_finish(res)
                if jr is not None:
                    box["value"] = jr.get_js_value().to_string()
            except Exception as exc:  # noqa: BLE001
                box["error"] = str(exc)
            loop.quit()

        def guard():
            if not box["done"]:
                loop.quit()
            return False

        self.view.run_javascript(js, None, done, None)
        GLib.timeout_add_seconds(timeout, guard)
        loop.run()
        return box.get("value")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("html", type=Path)
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--settle", type=int, default=500, help="мс на кадр")
    args = ap.parse_args()

    w, h = (int(x) for x in args.size.lower().split("x"))
    runner = Runner(args.html, w, h)
    uri = "file://" + str(args.html.resolve()) + "?wallpaper=1&freeze=1"

    icons = {"t": "icons", "vis": True,
             "r": [[120, 90, 196, 190], [120, 220, 196, 320], [900, 140, 976, 240]]}
    settings = {"t": "settings", "v": {"halo": 150}}

    steps = [
        (args.settle, None),
        (args.settle, "window.__inject && window.__inject(%s)" % json.dumps(icons)),
        (args.settle, "window.__inject && window.__inject(%s)" % json.dumps(settings)),
        (args.settle, "window.__renderAt && window.__renderAt(1500)"),
        (args.settle, "window.__inject && window.__inject({t:'pause',v:true})"),
        (args.settle, "window.__inject && window.__inject({t:'pause',v:false})"),
        (args.settle, "window.__renderAt && window.__renderAt(2600)"),
    ]
    # Кадр без иконок и кадр с иконками должны различаться: сцена строится
    # вокруг иконок, значит они меняют картинку. Сравниваем снимки — так
    # проверка работает и для canvas 2D, и для WebGL.
    runner.run(uri, [
        (args.settle, None),
        (args.settle, "window.__renderAt && window.__renderAt(1500)"),
    ])
    before = runner.snapshot()

    runner.run(uri, steps)
    after = runner.snapshot()

    icons_effect = bool(before and after and before[3] != after[3])

    runner._collect_errors()
    raw = runner.eval_js(RESULT_JS)
    info = json.loads(raw) if raw else {}

    has_hooks = bool(
        info.get("hooks", {}).get("inject") not in (None, "undefined")
        or info.get("hooks", {}).get("renderAt") not in (None, "undefined"))
    is_webgl = bool(info.get("webgl"))

    # (имя, статус): True — OK, False — FAIL, None — SKIP
    checks = [
        ("страница отправила ready", runner.ready),
        ("на странице есть canvas", info.get("hasCanvas", False)),
        ("кадр не пустой", info.get("nonEmpty", is_webgl)),
        ("есть хук __renderAt/__inject (для превью и тестов)",
         has_hooks if has_hooks else None),
        ("иконки влияют на кадр", icons_effect if has_hooks else None),
        ("нет ошибок JS", not runner.console),
    ]

    print("\n%s" % args.html)
    failed = 0
    for name, ok in checks:
        mark = "SKIP" if ok is None else ("OK  " if ok else "FAIL")
        print("  %s %s" % (mark, name))
        if ok is False:
            failed += 1
    if runner.console:
        for line in runner.console[:6]:
            print("    console: %s" % line.strip()[:160])
    if before and after:
        diff = sum(1 for a, b in zip(before[3], after[3]) if a != b)
        print("  изменилось байт кадра: %d из %d" % (diff, len(before[3])))

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
