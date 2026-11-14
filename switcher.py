#!/usr/bin/env python3
"""Mintland — графический переключатель тем и параметров анимации.

Возможности:
  - выбор темы (Beach / Meadow) с превью;
  - включение и выключение слоя;
  - живая настройка параметров темы (пальмы, каяки, чайки, облака, персонажи);
  - сохранение в ~/.config/mintland/settings.json;
  - передача изменений работающему themehost.py через run/control.json.

Никаких gsettings/dconf — только свои файлы и скрипты (см. docs/SAFETY.md).
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gtk, Gdk, GdkPixbuf, GLib

HERE = Path(__file__).resolve().parent
PROTO = HERE / "prototype"
RUN = HERE / "run"
CONFIG_DIR = Path.home() / ".config" / "mintland"
SETTINGS = CONFIG_DIR / "settings.json"
CONTROL = RUN / "control.json"
PIDFILE = RUN / "wall.pid"
THEMES_JSON = PROTO / "themes.json"

THEME_INFO = {
    "beach": {
        "name": "Пляж",
        "desc": "Песок, вода, пальмы, каяки и чайки.",
        "thumb": "docs/theme-beach.gif",
    },
    "meadow": {
        "name": "Луг",
        "desc": "Облака, мальчик с воздушным змеем и чёрный котёнок.",
        "thumb": "docs/theme-meadow.gif",
    },
    "night": {
        "name": "Ночь",
        "desc": "Звёздное небо, полярное сияние и туман; иконки в мягком ореоле.",
        "thumb": "docs/theme-night.gif",
    },
}

GROUP_LABELS = {
    "beach": ["Берег", "Вода", "Элементы"],
    "meadow": ["Вокруг иконок", "Облака", "Персонажи"],
    "night": ["Иконки", "Небо", "Туман"],
}

PARAM_LABELS = {
    "beach": {
        "sigma": "Расстояние до берега",
        "warp": "Извилистость берега",
        "shoal": "Прозрачная отмель",
        "shallow": "Ширина мелководья",
        "palms": "Кокосовые пальмы",
        "kayaks": "Каяки",
        "birds": "Чайки",
    },
    "meadow": {
        "sigma": "Облако вокруг иконок",
        "cover": "Облака на лугу",
        "flow": "Скорость движения",
        "showBoy": "Мальчик с воздушным змеем",
        "showCat": "Чёрный котёнок",
    },
    "night": {
        "halo": "Свечение вокруг иконок",
        "aurora": "Полярное сияние",
        "shoot": "Метеоры",
        "moon": "Луна",
        "mist": "Плотность тумана",
    },
}

# Наши подобранные значения по умолчанию (в themes.json у Beach 4 пальмы,
# 2 каяка и 3 чайки — это заметно дороже по CPU).
DEFAULT_OVERRIDES = {
    "beach": {"palms": 2, "kayaks": 1, "birds": 1},
}

THEME_ORDER = {"beach": 0, "meadow": 1, "night": 2}

# Единицы только латиницей/по-русски. Счётчики (пальмы, каяки, чайки)
# показываем без единиц: число и так понятно.
UNIT_LABELS = {
    "beach": {"sigma": "px", "shoal": "px", "shallow": "px"},
    "meadow": {"sigma": "px"},
    "night": {"halo": "px", "shoot": "шт"},
}


def load_registry():
    data = json.loads(THEMES_JSON.read_text(encoding="utf-8"))
    themes = [t for t in data.get("themes", [])
              if t.get("status") == "ready" and t.get("page")]
    themes.sort(key=lambda t: THEME_ORDER.get(t.get("id", ""), 99))
    return themes


def theme_defaults(theme):
    out = {}
    for group in theme.get("groups", []):
        for p in group.get("params", []):
            out[p["key"]] = p.get("default")
    out.update(DEFAULT_OVERRIDES.get(theme.get("id", ""), {}))
    return out


def load_state(themes):
    state = {
        "version": 1,
        "theme": themes[0]["id"] if themes else "beach",
        "params": {t["id"]: theme_defaults(t) for t in themes},
    }
    try:
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
    except Exception:
        return state
    tid = data.get("theme")
    if tid in state["params"]:
        state["theme"] = tid
    saved = data.get("params")
    if isinstance(saved, dict):
        for theme_id, vals in saved.items():
            if theme_id in state["params"] and isinstance(vals, dict):
                for key, value in vals.items():
                    if key in state["params"][theme_id]:
                        state["params"][theme_id][key] = value
    return state


def save_state(state):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, SETTINGS)


def write_control(state, theme_id, themes):
    theme = next((t for t in themes if t["id"] == theme_id), None)
    if theme is None:
        return
    data = {
        "seq": time.time_ns(),
        "theme": theme_id,
        "html": str((PROTO / theme["page"]).resolve()),
        "params": state["params"].get(theme_id, {}),
    }
    RUN.mkdir(parents=True, exist_ok=True)
    tmp = CONTROL.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, CONTROL)


def is_running():
    try:
        pid = int(PIDFILE.read_text(encoding="utf-8").strip())
    except Exception:
        return False
    try:
        cmd = Path("/proc/%d/cmdline" % pid).read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except Exception:
        return False
    return "themehost.py" in cmd


class AnimatedThumb(Gtk.DrawingArea):
    """Анимированный GIF-превью, вписанный в заданный размер."""

    def __init__(self, path, width, height):
        super().__init__()
        self.width = width
        self.height = height
        self.anim = GdkPixbuf.PixbufAnimation.new_from_file(str(path))
        self.iter = self.anim.get_iter(None)
        self.scaled = None
        self.timer = None
        self.set_size_request(width, height)
        self.connect("draw", self._on_draw)
        self.connect("destroy", self._on_destroy)
        self.timer = GLib.timeout_add(100, self._tick)

    def _tick(self):
        changed = self.iter.advance(None)
        if not changed:
            self.iter = self.anim.get_iter(None)
            changed = True
        if changed:
            self.scaled = None
            self.queue_draw()
        return True

    def _on_draw(self, _widget, cr):
        if self.scaled is None:
            pb = self.iter.get_pixbuf()
            self.scaled = pb.scale_simple(self.width, self.height,
                                          GdkPixbuf.InterpType.BILINEAR)
        Gdk.cairo_set_source_pixbuf(cr, self.scaled, 0, 0)
        cr.paint()
        return False

    def _on_destroy(self, _widget):
        if self.timer is not None:
            GLib.source_remove(self.timer)
            self.timer = None


def fmt_value(p, value, theme_id):
    fmt = p.get("format")
    if fmt == "percent":
        return "%d%%" % round(float(value) * 100)
    if fmt == "times":
        return "×%.2f" % float(value)
    step = p.get("step", 1)
    if isinstance(step, (int, float)) and float(step).is_integer():
        text = str(int(round(float(value))))
    else:
        text = "%.2f" % float(value)
    unit = UNIT_LABELS.get(theme_id, {}).get(p["key"])
    if unit is None:
        unit = p.get("unit") or ""
        if any("\u4e00" <= ch <= "\u9fff" for ch in unit):
            unit = ""
    return (text + " " + unit) if unit else text


class Switcher(Gtk.Window):
    def __init__(self, themes):
        super().__init__(title="Mintland")
        self.themes = themes
        self.theme_by_id = {t["id"]: t for t in themes}
        self.state = load_state(themes)
        self.theme_id = self.state["theme"]
        self.cards = {}
        self.value_labels = {}
        self._save_timer = None
        self._busy_until = 0.0
        self._updating = False

        self.set_default_size(880, 700)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.set_border_width(12)
        self.set_icon_name("preferences-desktop-wallpaper")
        self.connect("destroy", Gtk.main_quit)

        self._install_css()
        self._build_ui()
        self._select_theme(self.theme_id, initial=True)
        self._persist_now()
        GLib.timeout_add(1000, self._refresh_status)
        self._refresh_status()

    # ---------- внешний вид ----------

    def _install_css(self):
        css = b"""
        .theme-card {
            padding: 8px;
            border: 2px solid transparent;
            border-radius: 12px;
            background-image: none;
            box-shadow: none;
        }
        .theme-card:hover { background-color: alpha(currentColor, 0.06); }
        .theme-card.selected {
            border-color: #3584e4;
            background-color: alpha(#3584e4, 0.12);
        }
        .group-title { font-weight: bold; margin-top: 6px; }
        .param-label { font-size: 92%; }
        .value-label { font-feature-settings: "tnum"; }
        .hint { font-size: 85%; opacity: 0.7; }
        """
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def _build_ui(self):
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.add(outer)

        # статус + кнопки
        status_row = Gtk.Box(spacing=8)
        self.status_label = Gtk.Label(label="Проверка…")
        self.status_label.set_xalign(0)
        status_row.pack_start(self.status_label, True, True, 0)

        self.start_btn = Gtk.Button(label="Включить слой")
        self.stop_btn = Gtk.Button(label="Выключить слой")
        self.start_btn.connect("clicked", self._on_start)
        self.stop_btn.connect("clicked", self._on_stop)
        status_row.pack_end(self.stop_btn, False, False, 0)
        status_row.pack_end(self.start_btn, False, False, 0)
        outer.pack_start(status_row, False, False, 0)

        # карточки тем
        theme_title = Gtk.Label(label="Тема")
        theme_title.set_xalign(0)
        theme_title.get_style_context().add_class("group-title")
        outer.pack_start(theme_title, False, False, 0)

        # Карточки в горизонтальном скроллере: тем может быть сколько угодно,
        # а минимальная ширина окна остаётся разумной. Полоса прокрутки
        # накладывается поверх, места у карточек не отнимает.
        theme_scroll = Gtk.ScrolledWindow()
        theme_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        theme_scroll.set_overlay_scrolling(True)
        self.theme_box = Gtk.Box(spacing=10)
        theme_scroll.add(self.theme_box)
        outer.pack_start(theme_scroll, False, False, 0)
        for theme in self.themes:
            self.theme_box.pack_start(self._make_theme_card(theme), False, False, 0)

        outer.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

        # параметры
        self.settings_title = Gtk.Label(label="Параметры")
        self.settings_title.set_xalign(0)
        self.settings_title.get_style_context().add_class("group-title")
        outer.pack_start(self.settings_title, False, False, 0)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)
        self.settings_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        scroll.add(self.settings_box)
        outer.pack_start(scroll, True, True, 0)

        footer = Gtk.Box(spacing=8)
        self.reset_btn = Gtk.Button(label="Сбросить тему")
        self.reset_btn.connect("clicked", self._on_reset)
        footer.pack_start(self.reset_btn, False, False, 0)
        self.saved_label = Gtk.Label(label="")
        self.saved_label.set_xalign(1)
        footer.pack_end(self.saved_label, True, True, 0)
        outer.pack_start(footer, False, False, 0)

        note = Gtk.Label(label="Слой продолжает работать после закрытия окна.")
        note.set_xalign(0)
        note.get_style_context().add_class("hint")
        outer.pack_start(note, False, False, 0)

        self.show_all()

    def _make_theme_card(self, theme):
        tid = theme["id"]
        info = THEME_INFO.get(tid, {})
        card = Gtk.Button()
        card.set_relief(Gtk.ReliefStyle.NONE)
        card.get_style_context().add_class("theme-card")
        card.set_tooltip_text(info.get("desc", ""))
        card.set_hexpand(True)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        thumb = self._make_thumb(tid)
        thumb.set_halign(Gtk.Align.CENTER)
        box.pack_start(thumb, True, False, 0)
        name = Gtk.Label(label=info.get("name", tid))
        name.set_xalign(0.5)
        box.pack_start(name, False, False, 0)
        desc = Gtk.Label(label=info.get("desc", ""))
        desc.set_xalign(0.5)
        desc.set_line_wrap(True)
        desc.set_max_width_chars(32)
        desc.get_style_context().add_class("hint")
        box.pack_start(desc, False, False, 0)
        card.add(box)
        card.connect("clicked", lambda _b, t=tid: self._select_theme(t))
        self.cards[tid] = card
        return card

    def _make_thumb(self, tid):
        info = THEME_INFO.get(tid, {})
        width, height = 208, 117
        path = HERE / info.get("thumb", "prototype/thumbs/%s.webp" % tid)
        try:
            return AnimatedThumb(path, width, height)
        except Exception:
            try:
                # Запасной вариант — статичное превью из Deskland.
                pb = GdkPixbuf.Pixbuf.new_from_file(
                    str(PROTO / "thumbs" / ("%s.webp" % tid)))
                pb = pb.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)
                img = Gtk.Image.new_from_pixbuf(pb)
            except Exception:
                img = Gtk.Image.new_from_icon_name(
                    "preferences-desktop-wallpaper", Gtk.IconSize.DIALOG)
        img.set_size_request(width, height)
        return img

    # ---------- выбор темы и параметры ----------

    def _select_theme(self, tid, initial=False):
        if tid not in self.theme_by_id:
            return
        self.theme_id = tid
        self.state["theme"] = tid
        for card_id, card in self.cards.items():
            ctx = card.get_style_context()
            if card_id == tid:
                ctx.add_class("selected")
            else:
                ctx.remove_class("selected")
        info = THEME_INFO.get(tid, {})
        self.settings_title.set_text("Параметры темы «%s»" % info.get("name", tid))
        self._rebuild_settings()
        if not initial:
            self._schedule_persist()

    def _rebuild_settings(self):
        # При destroy/show_all GTK может дёргать value-changed у старых
        # слайдеров — не даём этому перезаписать сохранённые параметры.
        self._updating = True
        try:
            for child in self.settings_box.get_children():
                child.destroy()
            self.value_labels.clear()
            theme = self.theme_by_id[self.theme_id]
            group_labels = GROUP_LABELS.get(self.theme_id, [])
            for gi, group in enumerate(theme.get("groups", [])):
                title = Gtk.Label(label=group_labels[gi] if gi < len(group_labels) else "Параметры")
                title.set_xalign(0)
                title.get_style_context().add_class("group-title")
                self.settings_box.pack_start(title, False, False, 0)
                for p in group.get("params", []):
                    row = self._make_param_row(p)
                    if row is not None:
                        self.settings_box.pack_start(row, False, False, 0)
            self.settings_box.show_all()
        finally:
            self._updating = False

    def _param_label(self, p):
        labels = PARAM_LABELS.get(self.theme_id, {})
        return labels.get(p["key"], p["key"])

    def _make_param_row(self, p):
        key = p["key"]
        value = self.state["params"][self.theme_id].get(key, p.get("default"))
        row = Gtk.Box(spacing=8)

        label = Gtk.Label(label=self._param_label(p))
        label.set_xalign(0)
        label.set_size_request(220, -1)
        label.set_line_wrap(True)
        label.get_style_context().add_class("param-label")
        row.pack_start(label, False, False, 0)

        options = p.get("options")
        if options and len(options) == 2 and p.get("default") in (0, 1):
            sw = Gtk.Switch()
            sw.set_active(bool(value))
            sw.connect("state-set", lambda w, state, t=self.theme_id, k=key: self._on_switch(w, state, t, k))
            row.pack_end(sw, False, False, 0)
            return row

        if options:
            combo = Gtk.ComboBoxText()
            for opt in options:
                combo.append_text(str(opt))
            combo.set_active(int(value) if isinstance(value, int) else 0)
            combo.connect("changed", lambda c, t=self.theme_id, k=key: self._on_combo(c, t, k))
            row.pack_end(combo, False, False, 0)
            return row

        if p.get("min") is None or p.get("max") is None:
            return None

        scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL,
                                         float(p["min"]), float(p["max"]),
                                         float(p.get("step", 1)))
        scale.set_value(float(value))
        scale.set_draw_value(False)
        scale.set_hexpand(True)
        val_label = Gtk.Label(label=fmt_value(p, value, self.theme_id))
        val_label.set_xalign(1)
        val_label.set_size_request(74, -1)
        val_label.get_style_context().add_class("value-label")
        self.value_labels[key] = val_label
        scale.connect("value-changed", lambda s, t=self.theme_id, k=key, pp=p:
                      self._on_scale(s, t, k, pp))
        row.pack_start(scale, True, True, 0)
        row.pack_end(val_label, False, False, 0)
        return row

    def _on_scale(self, scale, tid, key, p):
        if self._updating:
            return
        step = float(p.get("step", 1))
        value = scale.get_value()
        value = round(value) if step.is_integer() else round(value, 2)
        self.state["params"][tid][key] = value
        label = self.value_labels.get(key)
        if label is not None:
            label.set_text(fmt_value(p, value, tid))
        self._schedule_persist()

    def _on_switch(self, _switch, state, tid, key):
        if self._updating:
            return False
        self.state["params"][tid][key] = 1 if state else 0
        self._schedule_persist()
        return False

    def _on_combo(self, combo, tid, key):
        if self._updating:
            return
        self.state["params"][tid][key] = combo.get_active()
        self._schedule_persist()

    def _on_reset(self, _btn):
        theme = self.theme_by_id[self.theme_id]
        self.state["params"][self.theme_id] = theme_defaults(theme)
        self._rebuild_settings()
        self._schedule_persist()

    # ---------- сохранение и управление ----------

    def _schedule_persist(self):
        if self._save_timer is not None:
            GLib.source_remove(self._save_timer)
        self._save_timer = GLib.timeout_add(120, self._persist)

    def _persist(self):
        self._save_timer = None
        self._persist_now()
        self.saved_label.set_text("Сохранено")
        GLib.timeout_add(1200, self._clear_saved)
        return False

    def _persist_now(self):
        save_state(self.state)
        write_control(self.state, self.theme_id, self.themes)

    def _clear_saved(self):
        self.saved_label.set_text("")
        return False

    def _on_start(self, _btn):
        self._persist_now()
        # wall-on.sh теперь ждёт фактической готовности (обычно 2-3 с),
        # а не спит фиксированные паузы. Держим кнопки заблокированными
        # чуть дольше, чтобы не поймать промежуточное состояние.
        self._busy_until = time.monotonic() + 5
        self.status_label.set_text("Запуск слоя…")
        self.start_btn.set_sensitive(False)
        self.stop_btn.set_sensitive(False)
        subprocess.Popen(["bash", str(HERE / "wall-on.sh")],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)

    def _on_stop(self, _btn):
        self._busy_until = time.monotonic() + 4
        self.status_label.set_text("Остановка слоя…")
        self.start_btn.set_sensitive(False)
        self.stop_btn.set_sensitive(False)
        subprocess.Popen(["bash", str(HERE / "wall-off.sh")],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)

    def _refresh_status(self):
        if time.monotonic() < self._busy_until:
            return True
        running = is_running()
        self.status_label.set_text("Слой включён" if running else "Слой выключен")
        self.start_btn.set_sensitive(not running)
        self.stop_btn.set_sensitive(running)
        return True


def main():
    themes = load_registry()
    if not themes:
        print("Mintland: в themes.json нет готовых тем", file=sys.stderr)
        return 1
    signal.signal(signal.SIGINT, lambda *_: Gtk.main_quit())
    win = Switcher(themes)
    win.present()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
