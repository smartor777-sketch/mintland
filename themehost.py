#!/usr/bin/env python3
# themehost.py — хост темы Deskland на Linux Mint (GTK3 + WebKit2).
#
# Окно рендеринга: WebKit-виджет reparent-ится в контейнер deskwall
# (DESKTOP, пониженный при создании — ниже nemo-desktop). Muffin
# композитит контейнер (ниже nemo), WebKit рисует внутрь него.
# Иконки Nemo остаются поверх (nemo-desktop выше контейнера).

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

import ctypes
import ctypes.util
_libX11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
_libX11.XOpenDisplay.restype = ctypes.c_void_p
_libX11.XReparentWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int]
_libX11.XMapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
_libX11.XLowerWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
_libX11.XFlush.argtypes = [ctypes.c_void_p]
_libX11.XShapeCombineRectangles = None
try:
    _libXext = ctypes.CDLL(ctypes.util.find_library("Xext") or "libXext.so.6")
    _libXext.XShapeCombineRectangles.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
except Exception:
    _libXext = None

import iconsource

HERE = Path(__file__).resolve().parent
MARKER = "deskland-poc-wall"
_DISPLAY = _libX11.XOpenDisplay(None)

SHIM_JS = """
(function () {
    if (window.__deskland) return;
    const listeners = [];
    window.chrome = { webview: {
        addEventListener: function (type, cb) { listeners.push(cb); },
        postMessage: function (msg) {
            try { window.webkit.messageHandlers.deskland.postMessage(String(msg)); }
            catch (e) {}
        }
    }};
    window.__desklandRecv = function (json) {
        for (const cb of listeners) cb({ data: json });
    };
})();
"""

_HOST = None


def _term(signum, frame):
    global _HOST
    if _HOST is not None:
        try:
            _HOST._cleanup_container()
        except Exception:
            pass
    sys.exit(0)


class ThemeHost:
    def __init__(self, html_path: Path):
        self.html_path = html_path
        self.win = None
        self.view = None
        self.xid = None          # WebKit view's X window
        self.container_proc = None
        self.container_xid = None
        self.last_icons = None
        self.paused = False
        self.scale = 1
        atexit.register(self._cleanup_container)

    def build_window(self):
        # GTK window (hidden, only for WebKit's widget hierarchy)
        self.win = Gtk.Window(title=MARKER)
        self.win.set_default_size(1, 1)
        self.win.set_decorated(False)
        self.win.set_skip_taskbar_hint(True)
        self.win.set_skip_pager_hint(True)

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

        # realize (creates Gdk windows) but don't show
        self.win.realize()
        self.view.realize()
        while Gtk.events_pending():
            Gtk.main_iteration()

        gdkwin = self.view.get_window()
        if gdkwin is not None:
            try:
                self.xid = gdkwin.get_xid()
                self._log("view xid=0x%x" % self.xid)
            except Exception as e:
                self._log("xid err: %s" % e)

        # контейнер deskwall (DESKTOP, пониженный)
        self._create_container()

        # reparent WebKit view into container
        if self.xid and self.container_xid and _DISPLAY:
            try:
                _libX11.XReparentWindow(_DISPLAY, self.xid, self.container_xid, 0, 0)
                _libX11.XMapWindow(_DISPLAY, self.xid)
                _libX11.XFlush(_DISPLAY)
                self._log("reparented view into container")
            except Exception as e:
                self._log("reparent err: %s" % e)

        # клик-сквозность контейнера (пустая input-форма) — через XShape
        if self.container_xid and _libXext is not None:
            try:
                _libXext.XShapeCombineRectangles(_DISPLAY, self.container_xid, 2, 0, 0, None, 0, 0, 0)
                _libX11.XFlush(_DISPLAY)
            except Exception:
                pass

        # geometry from monitor
        display = Gdk.Display.get_default()
        monitor = display.get_primary_monitor() or display.get_monitor(0)
        geom = monitor.get_geometry()
        self.scale = self._detect_scale(geom.width)

        GLib.timeout_add(1000, self.poll_icons)
        GLib.timeout_add(500, self.poll_pause)

    def _create_container(self):
        try:
            proc = subprocess.Popen(
                [str(HERE / "bin/deskwall"), "--create"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            line = proc.stdout.readline().strip()
            if not line.startswith("0x"):
                self._log("container bad wid: " + line)
                proc.terminate()
                return
            self.container_xid = int(line, 16)
            self.container_proc = proc
            self._log("container=0x%x" % self.container_xid)
        except Exception as e:
            self._log("container err: %s" % e)

    def _cleanup_container(self):
        if self.container_proc is not None:
            try:
                self.container_proc.stdin.close()
            except Exception:
                pass
            try:
                self.container_proc.terminate()
                self.container_proc.wait(timeout=3)
            except Exception:
                try:
                    self.container_proc.kill()
                except Exception:
                    pass
            self.container_proc = None

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

    def start(self):
        ucm = self.view.get_user_content_manager()
        ucm.add_script(WebKit2.UserScript(
            SHIM_JS,
            WebKit2.UserContentInjectedFrames.ALL_FRAMES,
            WebKit2.UserScriptInjectionTime.START,
            None,
            None,
        ))
        ucm.register_script_message_handler("deskland")
        ucm.connect("script-message-received::deskland", self.on_page_message)

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
            rects = self.last_icons or []
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
            self.view.run_javascript("__desklandRecv('%s')" % json_str.replace("'", "\\'"))
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
PY