#!/usr/bin/env python3
# themehost.py — хост темы Mintland на Linux Mint (Cinnamon/X11).
#
# Слой: окно типа DESKTOP + keep_below; WebKit рисует выбранную тему
# (flat.html / meadow.html). Тема и параметры читаются из run/control.json,
# который пишет switcher.py. nemo-desktop стартует ДО слоя и рисует иконки
# поверх (Muffin кладёт DESKTOP-окно с BELOW-состоянием ниже nemo).

import argparse
import atexit
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, Gdk, GLib, WebKit2

import iconsource

HERE = Path(__file__).resolve().parent
MARKER = "mintland-wall"

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


def _int_prop(text, key):
    """Число из строки вывода xwininfo вида '  Absolute upper-left X:  0'."""
    for line in text.splitlines():
        if line.strip().startswith(key):
            parts = line.split(":", 1)
            if len(parts) == 2:
                try:
                    return int(parts[1].strip())
                except ValueError:
                    return None
    return None


class ThemeHost:
    # Сколько ждать после последнего изменения раскладки, прежде чем слать
    # её сцене. 700 мс — как у Wololand: достаточно, чтобы отсечь
    # промежуточные кадры перетаскивания, и незаметно при обычных правках.
    ICONS_DEBOUNCE_MS = 700

    def __init__(self, html_path: Path, control_path: Path = None):
        self.html_path = html_path
        self.control_path = control_path or (HERE / "run" / "control.json")
        self.theme_id = None
        self.params = {}
        self.control_seq = None
        self.win = None
        self.view = None
        self.xid = None
        self.last_icons = None
        self._icons_timer = None
        self._monitor_rect = None
        self._nemo_alive = True
        self._nemo_notified = False
        self.started_at = time.time()
        self.paused = False
        self.scale = 1
        self._read_initial_control()
        atexit.register(self._cleanup)

    def _read_initial_control(self):
        """До создания окна: выбрать тему/параметры из run/control.json."""
        try:
            data = json.loads(self.control_path.read_text(encoding="utf-8"))
        except Exception:
            return
        html = data.get("html")
        if html:
            p = Path(html)
            if p.is_file():
                self.html_path = p
        self.theme_id = data.get("theme")
        params = data.get("params")
        if isinstance(params, dict):
            self.params = params
        self.control_seq = data.get("seq")
        self._log("control init: theme=%s html=%s" % (self.theme_id, self.html_path.name))

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
        # Тема грузится с file:// и подтягивает PNG-ассеты (пальмы, мальчик,
        # котёнок). Без этого WebKit может запретить доступ к соседним файлам.
        try:
            ws = self.view.get_settings()
            ws.set_allow_file_access_from_file_urls(True)
        except Exception:
            pass
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

        # Позиции иконок меняются только при перетаскивании — 2 с достаточно.
        # Пауза проверяется раз в секунду, без лишних подпроцессов xprop.
        GLib.timeout_add(2000, self.poll_icons)
        GLib.timeout_add(1000, self.poll_pause)
        GLib.timeout_add(500, self.poll_control)
        GLib.timeout_add_seconds(600, self._health)
        GLib.timeout_add_seconds(5, self._check_nemo)

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

        self._load_uri()

    def _load_uri(self):
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
            self.send_settings()
            self.last_icons = None
            self.poll_icons()
            # Первая раскладка нужна сразу: сцена стартует с пустым полем
            # и дорисовывает берег только через морфинг.
            self.send_icons_now()
            self.poll_pause()
            # После map/reload Muffin может положить наш DESKTOP-слой выше
            # nemo. Поднимаем nemo дважды: сразу и с запасом по времени.
            GLib.timeout_add(300, self._raise_nemo)
            GLib.timeout_add(1200, self._raise_nemo)

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
        if payload == self.last_icons:
            return True
        self.last_icons = payload
        # Дебаунс: при перетаскивании иконки раскладка меняется десятки раз
        # подряд, а пересчёт поля в сцене стоит ~30 мс. Ждём, пока движение
        # прекратится, и отправляем один итоговый набор.
        if self._icons_timer is not None:
            GLib.source_remove(self._icons_timer)
        self._icons_timer = GLib.timeout_add(self.ICONS_DEBOUNCE_MS,
                                              self._flush_icons)
        return True

    def _flush_icons(self):
        self._icons_timer = None
        if self.last_icons:
            self.send(self.last_icons)
        return False

    def send_icons_now(self):
        """Отправить раскладку немедленно — без дебаунса."""
        if self._icons_timer is not None:
            GLib.source_remove(self._icons_timer)
            self._icons_timer = None
        if self.last_icons:
            self.send(self.last_icons)

    def poll_control(self):
        """Живое применение темы/параметров из run/control.json."""
        try:
            data = json.loads(self.control_path.read_text(encoding="utf-8"))
        except Exception:
            return True
        seq = data.get("seq")
        if seq == self.control_seq:
            return True
        self.control_seq = seq
        self.theme_id = data.get("theme", self.theme_id)
        params = data.get("params")
        if isinstance(params, dict):
            self.params = params

        html = data.get("html")
        if html:
            p = Path(html)
            if p.is_file() and p.resolve() != self.html_path.resolve():
                self.html_path = p
                self.last_icons = None
                self._log("control: switch theme=%s html=%s" % (self.theme_id, p.name))
                self._load_uri()
                return True

        self._log("control: apply settings theme=%s" % self.theme_id)
        self.send_settings()
        return True

    def send_settings(self):
        if not self.params:
            return
        self.send(json.dumps({"t": "settings", "v": self.params}, separators=(",", ":")))

    def _raise_nemo(self):
        """Поставить nemo-desktop выше нашего слоя (иконки поверх сцены)."""
        try:
            subprocess.run([str(HERE / "bin" / "deskwall"), "-u"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=3)
        except Exception:
            pass
        return False

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
            # один вызов xprop вместо двух: тип и состояние окна
            props = subprocess.run(["xprop", "-id", m, "_NET_WM_WINDOW_TYPE", "_NET_WM_STATE"],
                                   capture_output=True, text=True, timeout=3).stdout.lower()
            if any(k in props for k in ("desktop", "dock", "notification", "tooltip", "menu")):
                return False
            if "_net_wm_state_hidden" in props:
                return False
            maximized = ("_net_wm_state_maximized_horz" in props and "_net_wm_state_maximized_vert" in props)
            fullscreen = "_net_wm_state_fullscreen" in props
            if maximized or fullscreen:
                return True
            # Окно может закрыть рабочий стол и без maximized/fullscreen —
            # просто растянуто почти на весь экран. Считаем площадь
            # перекрытия: 92% (как у Wololand) оставляет запас на панель,
            # док и тени рамки.
            return self._covers_desktop(m)
        except Exception:
            return False

    def _covers_desktop(self, win_id: str) -> bool:
        """Закрывает ли окно рабочий стол хотя бы на 92%."""
        try:
            info = subprocess.run(["xwininfo", "-id", win_id],
                                  capture_output=True, text=True, timeout=3).stdout
            gx = _int_prop(info, "Absolute upper-left X")
            gy = _int_prop(info, "Absolute upper-left Y")
            gw = _int_prop(info, "Width")
            gh = _int_prop(info, "Height")
            if None in (gx, gy, gw, gh) or gw <= 0 or gh <= 0:
                return False
            mon = self.monitor_rect()
            if mon is None:
                return False
            mx, my, mw, mh = mon
            # Перекрытие окна с монитором.
            ox = max(0, min(gx + gw, mx + mw) - max(gx, mx))
            oy = max(0, min(gy + gh, my + mh) - max(gy, my))
            area = float(mw * mh)
            if area <= 0:
                return False
            return (ox * oy) * 100 >= area * 92
        except Exception:
            return False

    def monitor_rect(self):
        """Прямоугольник основного монитора в физических пикселях."""
        if self._monitor_rect is not None:
            return self._monitor_rect
        try:
            out = subprocess.run(["xrandr", "--listmonitors"],
                                 capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines()[1:]:
                if "*" not in line:
                    continue
                # Формат: " 0: +*eDP-1 2560/344x1440/193+0+0  eDP-1"
                for tok in line.split():
                    # Геометрия в xrandr: "2560/344x1440/193+0+0", где
                    # 2560 — ширина в пикселях, 1440 — высота, дальше
                    # миллиметры и смещение.
                    if tok.count("/") < 2 or tok.count("+") < 2:
                        continue
                    parts = tok.split("+")
                    segs = parts[0].split("/")
                    try:
                        w = int(segs[0])
                        h = int(segs[1].split("x")[1])
                        ox, oy = int(parts[1]), int(parts[2])
                    except (IndexError, ValueError):
                        continue
                    self._monitor_rect = (ox, oy, w, h)
                    return self._monitor_rect
        except Exception:
            pass
        return None

    def _check_nemo(self):
        """Следить за живостью nemo-desktop.

        Если он упадёт при работающем слое, сцена останется, а иконок
        не будет — пользователь увидит обои без ярлыков и не поймёт
        причину. Сообщаем один раз.
        """
        try:
            alive = subprocess.run(["pgrep", "-x", "nemo-desktop"],
                                   capture_output=True, timeout=3).returncode == 0
        except Exception:
            return True
        if alive == self._nemo_alive:
            return True
        self._nemo_alive = alive
        if alive:
            self._log("nemo-desktop снова работает")
        else:
            self._log("ВНИМАНИЕ: nemo-desktop пропал — иконки не рисуются")
            self._notify_once()
        return True

    def _notify_once(self):
        if self._nemo_notified:
            return
        self._nemo_notified = True
        try:
            subprocess.run(
                ["notify-send", "-a", "Mintland",
                 "Mintland: иконки рабочего стола недоступны",
                 "Процесс nemo-desktop не запущен. Перезапустите его "
                 "или выключите и включите слой."],
                capture_output=True, timeout=5)
        except Exception:
            pass

    def send(self, json_str: str):
        try:
            self.view.run_javascript("__mintlandRecv('%s')" % json_str.replace("'", "\\'"))
        except Exception:
            pass

    def _log(self, msg):
        path = HERE / "run/wall.log"
        try:
            # Лог не должен расти без предела: при долгой работе он
            # занимает место и мешает читать свежие сообщения.
            if path.exists() and path.stat().st_size > 256 * 1024:
                path.unlink()
        except Exception:
            pass
        try:
            with open(str(path), "a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except Exception:
            print(msg, file=sys.stderr)

    def _health(self):
        """Раз в 10 минут: сколько памяти занято и как долго работает слой."""
        rss_mb = 0.0
        try:
            with open("/proc/self/status", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss_mb = int(line.split()[1]) / 1024.0
                        break
        except Exception:
            pass
        uptime = int(time.time() - self.started_at)
        self._log("health: rss %.0f МБ, аптайм %d:%02d" % (
            rss_mb, uptime // 60, uptime % 60))

    def _on_load_failed(self, webview, event, uri, error):
        self._log("load-failed: %s %s" % (uri, error))

    def _on_load_changed(self, webview, event):
        self._log("load-changed: %s" % event)


def main():
    global _HOST
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", default=str(HERE / "prototype" / "flat.html"))
    ap.add_argument("--control", default=str(HERE / "run" / "control.json"),
                    help="JSON с выбранной темой и параметрами")
    ap.add_argument("--marker", default=MARKER, help="маркер для pgrep (ярлыки)")
    args = ap.parse_args()

    _HOST = ThemeHost(Path(args.html), Path(args.control))
    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)
    _HOST.build_window()
    _HOST.start()

    Gtk.main()


if __name__ == "__main__":
    sys.exit(main())
