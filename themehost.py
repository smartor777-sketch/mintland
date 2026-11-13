#!/usr/bin/env python3
# themehost.py — хост темы Mintland на Linux Mint (Cinnamon/X11).
#
# Слой: окно типа DESKTOP + keep_below; WebKit рисует тему flat.html.
# nemo-desktop стартует ДО слоя и рисует иконки поверх (Muffin кладёт
# DESKTOP-окно с BELOW-состоянием ниже nemo в том же слое).

import argparse
import atexit
import json
import signal
import subprocess
import sys
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, Gdk, GLib, WebKit2

import iconsource

HERE = Path(__file__).resolve().parent
MARKER = "mintland-poc-wall"

SHIM_JS = """
(function () {
    if (window.__mintland) return;
    const listeners = [];
    window.chrome = { webview: {
        addEventListener: function (type, cb) { listeners.push(cb); },
        postMessage: function (msg) {
            try { window.webkit.messageHandlers.mintland.postMessage(String(msg)); }
            catch (e) {}
        }
    }};
    window.__mintlandRecv = function (json) {
        for (const cb of listeners) cb({ data: json });
    };
})();
"""

_HOST = None


def _term(signum, frame):
    global _HOST
    if _HOST is not None:
        try:
            _HOST._cleanup()
        except Exception:
            pass
    sys.exit(0)


def cairo_empty_region():
    import cairo
    return cairo.Region()


class ThemeHost:
    def __init__(self, html_path: Path):
        self.html_path = html_path
        self.win = None
        self.view = None
        self.xid = None
        self.last_icons = None
        self.paused = False
        self.scale = 1
        atexit.register(self._cleanup)

    def build_window(self):
        self.win = Gtk.Window(title=MARKER)
        self.win.set_type_hint(Gdk.WindowTypeHint.DESKTOP)
        self.win.set_accept_focus(False)
        self.win.set_focus_on_map(False)
        self.win.set_skip_taskbar_hint(True)
        self.win.set_skip_pager_hint(True)
        self.win.set_decorated(False)
        self.win.set_keep_below(True)

        screen = Gdk.Screen.get_default()
        rgba_visual = screen.get_rgba_visual() if screen else None
        if rgba_visual is not None:
            self.win.set_visual(rgba_visual)
            self.win.set_app_paintable(True)

        self.view = WebKit2.WebView()
        self.view.set_hexpand(True)
        self.view.set_vexpand(True)
        rgba = Gdk.RGBA(0, 0, 0, 0)
        try:
            self.view.set_background_color(rgba)
        except Exception:
            pass
        self.view.connect("load-failed", self._on_load_failed)
        self.view.connect("load-changed", self._on_load_changed)
        self.win.add(self.view)

        display = Gdk.Display.get_default()
        monitor = display.get_primary_monitor() or display.get_monitor(0)
        geom = monitor.get_geometry()
        self.win.set_default_size(geom.width, geom.height)
        self.win.move(geom.x, geom.y)

        self.scale = self._detect_scale(geom.width)

        self.win.show_all()

        gdkwin = self.win.get_window()
        if gdkwin is not None:
            try:
                gdkwin.lower()
            except Exception:
                pass

        while Gtk.events_pending():
            Gtk.main_iteration()

        if gdkwin is not None:
            region = cairo_empty_region()
            gdkwin.input_shape_combine_region(region, 0, 0)
            try:
                self.xid = gdkwin.get_xid()
                self._log("xid=0x%x" % self.xid)
            except Exception as e:
                self._log("xid err: %s" % e)
                self.xid = None

        GLib.timeout_add(1000, self.poll_icons)
        GLib.timeout_add(500, self.poll_pause)

    @staticmethod
    def _detect_scale(logical_w: int) -> int:
        try:
            out = subprocess.run(["xrandr", "--listmonitors"], capture_output=True,
                                 text=True, timeout=5).stdout
            for line in out.splitlines()[1:]:
                if "*" not in line:
                    continue
                for tok in line.split():
                    if tok[0:1].isdigit() and "x" in tok:
                        phys_w = int(tok.split("x")[0].split("/")[0])
                        if logical_w > 0:
                            return max(1, round(phys_w / logical_w))
        except Exception:
            pass
        return 1

    def _cleanup(self):
        pass

    def start(self):
        ucm = self.view.get_user_content_manager()
        ucm.add_script(WebKit2.UserScript(
            SHIM_JS,
            WebKit2.UserContentInjectedFrames.ALL_FRAMES,
            WebKit2.UserScriptInjectionTime.START,
            None,
            None,
        ))
        ucm.register_script_message_handler("mintland")
        ucm.connect("script-message-received::mintland", self.on_page_message)

        uri = "file://" + str(self.html_path) + "?wallpaper=1"
        self._log("loading " + uri)
        self.view.load_uri(uri)

    def on_page_message(self, ucm, js_result):
        text = ""
        try:
            jv = js_result.get_js_value() if hasattr(js_result, "get_js_value") else None
            if jv is not None and hasattr(jv, "to_string"):
                text = jv.to_string()
        except Exception:
            pass
        text = (text or "").strip()
        self._log("page-msg: " + text[:60])
        if text == "ready":
            self.last_icons = None
            self.poll_icons()
            self.poll_pause()

    def poll_icons(self):
        try:
            rects = iconsource.collect()
        except Exception:
            rects = []
        payload = json.dumps({
            "t": "icons",
            "vis": True,
            "r": [[round(l * self.scale), round(t * self.scale),
                   round(r * self.scale), round(b * self.scale)] for l, t, r, b in rects],
        }, separators=(",", ":"))
        if payload != self.last_icons:
            self.last_icons = payload
            self.send(payload)
        return True

    def poll_pause(self):
        should = self._should_pause()
        if should != self.paused:
            self.paused = should
            self.send(json.dumps({"t": "pause", "v": should}, separators=(",", ":")))
        return True

    def _should_pause(self) -> bool:
        try:
            out = subprocess.run(["xprop", "-root", "_NET_ACTIVE_WINDOW"],
                                 capture_output=True, text=True, timeout=3).stdout
            m = None
            for tok in out.split():
                if tok.startswith("0x"):
                    m = tok
                    break
            if not m or m in ("0x0",):
                return False
            if self.xid and m.lower() == hex(self.xid).lower():
                return False
            t = subprocess.run(["xprop", "-id", m, "_NET_WM_WINDOW_TYPE"],
                               capture_output=True, text=True, timeout=3).stdout.lower()
            if any(k in t for k in ("desktop", "dock", "notification", "tooltip", "menu")):
                return False
            s = subprocess.run(["xprop", "-id", m, "_NET_WM_STATE"],
                               capture_output=True, text=True, timeout=3).stdout.lower()
            maximized = ("_net_wm_state_maximized_horz" in s and "_net_wm_state_maximized_vert" in s)
            fullscreen = "_net_wm_state_fullscreen" in s
            if not (maximized or fullscreen):
                return False
            if "_net_wm_state_hidden" in s:
                return False
            return True
        except Exception:
            return False

    def send(self, json_str: str):
        try:
            self.view.run_javascript("__mintlandRecv('%s')" % json_str.replace("'", "\\'"))
        except Exception:
            pass

    def _log(self, msg):
        try:
            with open(str(HERE / "run/wall.log"), "a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except Exception:
            print(msg, file=sys.stderr)

    def _on_load_failed(self, webview, event, uri, error):
        self._log("load-failed: %s %s" % (uri, error))

    def _on_load_changed(self, webview, event):
        self._log("load-changed: %s" % event)


def main():
    global _HOST
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", default=str(HERE / "prototype" / "flat.html"))
    ap.add_argument("--marker", default=MARKER, help="маркер для pgrep (ярлыки)")
    args = ap.parse_args()

    _HOST = ThemeHost(Path(args.html))
    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)
    _HOST.build_window()
    _HOST.start()

    Gtk.main()


if __name__ == "__main__":
    sys.exit(main())
