#!/usr/bin/env python3
"""Mintland — графический переключатель тем и параметров анимации.

Возможности:
  - выбор темы (Beach / Meadow) с превью;
  - включение и выключение слоя;
  - живая настройка параметров темы (пальмы, каяки, чайки, облака, персонажи);
  - сохранение в ~/.config/mintland/settings.json;
  - передача изменений работающему themehost.py через control.json
    (run/ в репозитории, ~/.cache/mintland/ в установленном пакете).

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


def app_version():
    """Версия пакета: из debian/changelog в дереве исходников или из dpkg.

    В заголовке окна номер версии нужен, чтобы по скриншоту было видно,
    какая сборка у пользователя. Тихо возвращаем None, если узнать нельзя.
    """
    try:
        import gzip
        import re
        text = ""
        # Дерево исходников: debian/changelog рядом с кодом.
        local = HERE / "debian" / "changelog"
        if local.is_file():
            text = local.read_text(encoding="utf-8", errors="replace")
        else:
            # Установленный пакет: /usr/share/doc/mintland/changelog.gz
            for doc in (Path("/usr/share/doc/mintland/changelog.gz"),
                        HERE.parent / "share" / "doc" / "mintland" / "changelog.gz"):
                if doc.is_file():
                    text = gzip.decompress(doc.read_bytes()).decode("utf-8", "replace")
                    break
        m = re.search(r"^mintland \(([^)]+)\)", text, re.M)
        if m:
            return m.group(1)
    except Exception:
        pass
    try:
        import subprocess
        out = subprocess.run(["dpkg-query", "-W", "-f=${Version}", "mintland"],
                             capture_output=True, text=True, timeout=3).stdout
        if out.strip():
            return out.strip()
    except Exception:
        pass
    return None


def _data_dir():
    """Каталог с темами и превью.

    В дереве исходников это сам репозиторий; в установленном пакете —
    /usr/share/mintland (см. debian/install).
    """
    env = os.environ.get("MINTLAND_DATA")
    if env:
        return Path(env)
    if (HERE / "prototype").is_dir():
        return HERE
    return Path("/usr/share/mintland")


def _runtime_dir():
    """Каталог рабочего состояния: control.json, wall.pid, wall.log.

    В дереве исходников остаётся run/ (так удобнее для отладки). В
    установленном пакете /usr/lib/mintland только для чтения, поэтому
    состояние уходит в ~/.cache/mintland.
    """
    env = os.environ.get("MINTLAND_RUNTIME")
    if env:
        return Path(env)
    if os.access(HERE, os.W_OK):
        return HERE / "run"
    base = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    return base / "mintland"


DATA = _data_dir()
PROTO = DATA / "prototype"
RUN = _runtime_dir()
CONFIG_DIR = Path.home() / ".config" / "mintland"
SETTINGS = CONFIG_DIR / "settings.json"
CONTROL = RUN / "control.json"
PIDFILE = RUN / "wall.pid"
THEMES_JSON = PROTO / "themes.json"


def script_env():
    """Окружение для wall-on.sh / wall-off.sh.

    Скрипты должны писать состояние туда же, куда и панель, независимо от
    того, запущены они из репозитория или из установленного пакета.
    """
    env = os.environ.copy()
    env["MINTLAND_RUNTIME"] = str(RUN)
    env["MINTLAND_DATA"] = str(DATA)
    return env


def ensure_desktop_shortcut():
    """Положить ярлык Mintland на рабочий стол (один раз).

    Нужен именно файл .desktop в каталоге рабочего стола, а не ссылка на
    /usr/share/applications: Nemo показывает на рабочем столе только такие
    файлы. Копируем установленный ярлык, чтобы описание и иконка совпадали
    с меню приложений.

    Отметка в ~/.config/mintland/desktop-shortcut не даёт создать ярлык
    повторно: если пользователь его удалил или переименовал, при следующем
    запуске мы не навязываем его снова.
    """
    marker = CONFIG_DIR / "desktop-shortcut"
    if marker.exists():
        return

    try:
        desktop = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP)
    except Exception:
        desktop = None
    if not desktop:
        return
    target = Path(desktop) / "Mintland.desktop"
    if target.exists():
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text("created\n", encoding="utf-8")
        except Exception:
            pass
        return

    source = Path("/usr/share/applications/mintland.desktop")
    if source.is_file():
        try:
            text = source.read_text(encoding="utf-8")
        except Exception:
            return
    else:
        # Запасной вариант для запуска из дерева исходников.
        text = """[Desktop Entry]
Type=Application
Name=Mintland
Comment=Animated clickable desktop wallpaper for Cinnamon
Comment[ru]=Живые обои с кликабельными иконками для Cinnamon
Exec=mintland
Icon=mintland
Terminal=false
Categories=Settings;DesktopSettings;
OnlyShowIn=X-Cinnamon;
StartupNotify=true
StartupWMClass=Mintland
"""
    try:
        target.write_text(text, encoding="utf-8")
        target.chmod(0o755)
    except Exception:
        return

    # Nemo в некоторых версиях требует отметку «доверенный ярлык».
    # metadata::trusted — это gvfs-метаданные, не gsettings/dconf.
    try:
        subprocess.run(
            ["gio", "set", str(target), "metadata::trusted", "true"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        pass

    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("created\n", encoding="utf-8")
    except Exception:
        pass


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
    "forest": {
        "name": "Лес",
        "desc": "Плоские деревья на траве; вокруг иконок — пустые поляны.",
        "thumb": "docs/theme-forest.gif",
    },
    "worldmap": {
        "name": "Старая карта",
        "desc": "Плотная рисованная карта: замки, леса, горы, реки и озёра.",
        "thumb": "docs/theme-worldmap.gif",
    },
}

GROUP_LABELS = {
    "beach": ["Берег", "Вода", "Элементы"],
    "meadow": ["Вокруг иконок", "Облака", "Персонажи"],
    "night": ["Иконки", "Небо", "Туман", "Воздух"],
    "forest": ["Лес"],
    "worldmap": ["Карта"],
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
        "fireflies": "Светлячки",
    },
    "forest": {
        "trees": "Деревья",
        "glade": "Поляна",
    },
    "worldmap": {
        "density": "Плотность",
        "forest": "Леса",
        "roads": "Замки и дороги",
        "units": "Повозки",
        "island": "Отступ вокруг иконок",
        "birds": "Птицы",
    },
}

# Наши подобранные значения по умолчанию (в themes.json у Beach 4 пальмы,
# 2 каяка и 3 чайки — это заметно дороже по CPU).
DEFAULT_OVERRIDES = {
    "beach": {"palms": 2, "kayaks": 1, "birds": 1},
}

THEME_ORDER = {"beach": 0, "meadow": 1, "night": 2, "forest": 3, "worldmap": 4}

# Единицы только латиницей/по-русски. Счётчики (пальмы, каяки, чайки)
# показываем без единиц: число и так понятно.
UNIT_LABELS = {
    "beach": {"sigma": "px", "shoal": "px", "shallow": "px"},
    "meadow": {"sigma": "px"},
    "night": {"halo": "px", "shoot": "шт", "fireflies": "шт"},
    "forest": {"trees": "шт", "glade": "px"},
    "worldmap": {"units": "шт", "birds": "шт"},
}


# ---------------------------------------------------------------------------
# Язык интерфейса
# ---------------------------------------------------------------------------
# Русский — основной язык разработки, английский — перевод и язык по
# умолчанию для всех локалей, кроме русской. Строки собраны в одном месте,
# а не разбросаны по вызовам: иначе при добавлении языка приходится искать
# их по всему файлу.
#
# Названия тем и подписи параметров берутся из themes.json, где лежит
# русский текст; английский — в UI["en"]["themes"] ниже.

UI = {
    "ru": {
        "app_title": "Mintland",
        "checking": "Проверка…",
        "layer_on": "Включить слой",
        "layer_off": "Выключить слой",
        "themes": "Тема",
        "params": "Параметры",
        "params_of": "Параметры темы «%s»",
        "params_fallback": "Параметры",
        "variant": "Вариант",
        "reset": "Сбросить тему",
        "saved": "Сохранено",
        "note": "Слой продолжает работать после закрытия окна.",
        "starting": "Запуск слоя…",
        "stopping": "Остановка слоя…",
        "on": "Слой включён",
        "off": "Слой выключен",
        "language": "Язык",
        "lang_auto": "Как в системе",
        "themes_en": {},
    },
    "en": {
        "app_title": "Mintland",
        "checking": "Checking…",
        "layer_on": "Turn layer on",
        "layer_off": "Turn layer off",
        "themes": "Theme",
        "params": "Settings",
        "params_of": "Settings for “%s”",
        "params_fallback": "Settings",
        "variant": "Variant",
        "reset": "Reset theme",
        "saved": "Saved",
        "note": "The layer keeps running after you close this window.",
        "starting": "Starting layer…",
        "stopping": "Stopping layer…",
        "on": "Layer is on",
        "off": "Layer is off",
        "language": "Language",
        "lang_auto": "System default",
        # Английские названия тем, описания и подписи параметров.
        # Русские лежат в themes.json — он остаётся источником истины.
        "themes_en": {
            "beach": {
                "name": "Beach",
                "desc": "Sand, water, palms, kayaks and gulls.",
                "groups": ["Shore", "Water", "Elements"],
                "params": {
                    "sigma": "Distance to shore", "warp": "Winding shore",
                    "shoal": "Clear shallows", "shallow": "Shallow sea",
                    "palms": "Coconut palms", "kayaks": "Kayaks", "birds": "Gulls",
                },
                "variants": {"beach": "Day"},
            },
            "meadow": {
                "name": "Meadow",
                "desc": "Clouds, a boy with a kite, and a black kitten.",
                "groups": ["Around icons", "Clouds", "Characters"],
                "params": {
                    "sigma": "Cloud around icons", "cover": "Clouds over the meadow",
                    "flow": "Drift speed", "showBoy": "Boy with a kite",
                    "showCat": "Black kitten",
                },
                "variants": {"meadow": "Summer"},
            },
            "night": {
                "name": "Night",
                "desc": "A starry sky with aurora and mist; icons sit in a soft halo.",
                "groups": ["Icons", "Sky", "Mist", "Air"],
                "params": {
                    "halo": "Halo around icons", "aurora": "Aurora",
                    "shoot": "Shooting stars", "moon": "Moon", "mist": "Mist density",
                    "fireflies": "Fireflies",
                },
                "variants": {"polar": "Polar", "fireflies": "Fireflies"},
            },
            "forest": {
                "name": "Forest",
                "desc": "Flat trees on grass; your icons sit in clearings.",
                "groups": ["Forest", "Ground"],
                "params": {
                    "trees": "Trees",
                    "glade": "Clearing",
                },
                "variants": {"forest": "Forest"},
            },
            "worldmap": {
                "name": "Old map",
                "desc": "A dense hand-drawn map: castles, forests, mountains, rivers and lakes.",
                "groups": ["Map"],
                "params": {
                    "density": "Density", "forest": "Forests",
                    "roads": "Castles and roads", "units": "Carts",
                    "island": "Icon clearance",
                    "birds": "Birds",
                },
                "variants": {"worldmap": "Old map"},
            },
        },
    },
}

SETTINGS_LANG = CONFIG_DIR / "lang"


def detect_lang():
    """Язык интерфейса: сохранённый выбор, иначе — из системы.

    Английский — язык по умолчанию для всех локалей, кроме русской:
    иначе англоязычный пользователь видел бы русский интерфейс. Русский
    включается только при `ru_*`. Сохранённый выбор пользователя важнее
    системной локали.
    """
    try:
        saved = SETTINGS_LANG.read_text(encoding="utf-8").strip()
        if saved in UI:
            return saved
    except Exception:
        pass
    loc = (os.environ.get("LC_ALL") or os.environ.get("LC_MESSAGES")
           or os.environ.get("LANG") or "").lower()
    if loc.startswith("ru"):
        return "ru"
    return "en"


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
    # Вариант темы (см. variants в themes.json): обычная строка среди
    # параметров, но страница понимает её особо — переключает сразу
    # небо, холмы и набор значений.
    if theme.get("variants"):
        out["variant"] = theme.get("defaultVariant") or theme["variants"][0]["id"]
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
    params = dict(state["params"].get(theme_id, {}))
    data = {
        "seq": time.time_ns(),
        "theme": theme_id,
        "html": str((PROTO / theme["page"]).resolve()),
        "params": params,
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
        self.path = None
        self.anim = None
        self.iter = None
        self.scaled = None
        self.timer = None
        self.set_size_request(width, height)
        self.connect("draw", self._on_draw)
        self.connect("destroy", self._on_destroy)
        self.load(path)
        self.timer = GLib.timeout_add(100, self._tick)

    def load(self, path):
        """Подменить превью, не пересоздавая виджет.

        Нужно для вариантов темы: одна карточка, но у каждого варианта
        своя анимация. Пересоздавать виджет пришлось бы вместе с
        раскладкой, а так меняется только источник кадров.
        """
        path = Path(path)
        if self.path == path:
            return
        self.path = path
        self.anim = GdkPixbuf.PixbufAnimation.new_from_file(str(path))
        self.iter = self.anim.get_iter(None)
        self.scaled = None
        self.queue_draw()

    def _tick(self):
        if self.iter is None:
            return True
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


def t(lang, key):
    """Одна надпись интерфейса."""
    return UI.get(lang, UI["en"]).get(key, UI["en"].get(key, key))


def theme_text(lang, tid, field, default=None):
    """Название, описание или подписи темы на выбранном языке.

    Русский текст — в themes.json, английский — в UI["en"]["themes_en"].
    Если перевода нет, возвращаем русский: пустая карточка хуже, чем
    карточка с непереведённым названием.
    """
    if lang != "ru":
        tr = UI["en"]["themes_en"].get(tid, {})
        if field in tr:
            return tr[field]
    return default


def param_text(lang, tid, key, default):
    """Подпись параметра: русская из themes.json, английская из словаря."""
    if lang != "ru":
        tr = UI["en"]["themes_en"].get(tid, {}).get("params", {})
        if key in tr:
            return tr[key]
    return default


def group_text(lang, tid, gi, default):
    if lang != "ru":
        tr = UI["en"]["themes_en"].get(tid, {}).get("groups", [])
        if gi < len(tr):
            return tr[gi]
    return default


def variant_text(lang, tid, vid, default):
    if lang != "ru":
        tr = UI["en"]["themes_en"].get(tid, {}).get("variants", {})
        if vid in tr:
            return tr[vid]
    return default


def fmt_value(p, value, theme_id, lang="en"):
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
    # Счётчики в английском идут без единицы: «1 pcs» неверно, а «1 pc»
    # ради одного слова не стоит формы множественного числа. В русском
    # единицу тоже не показываем — см. комментарий у UNIT_LABELS.
    if lang == "en" and unit == "шт":
        unit = ""
    return (text + " " + unit) if unit else text


class Switcher(Gtk.Window):
    def __init__(self, themes):
        version = app_version()
        title = "Mintland v" + version if version else "Mintland"
        super().__init__(title=title)
        self.lang = detect_lang()
        self.themes = themes
        self.theme_by_id = {t["id"]: t for t in themes}
        self.state = load_state(themes)
        self.theme_id = self.state["theme"]
        self.cards = {}
        self.thumbs = {}
        self.value_labels = {}
        self._save_timer = None
        self._busy_until = 0.0
        self._updating = False

        self.set_default_size(1160, 636)
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
        self.status_label = Gtk.Label(label=t(self.lang, "checking"))
        self.status_label.set_xalign(0)
        status_row.pack_start(self.status_label, True, True, 0)

        self.start_btn = Gtk.Button(label=t(self.lang, "layer_on"))
        self.stop_btn = Gtk.Button(label=t(self.lang, "layer_off"))
        self.start_btn.connect("clicked", self._on_start)
        self.stop_btn.connect("clicked", self._on_stop)
        status_row.pack_end(self.stop_btn, False, False, 0)
        status_row.pack_end(self.start_btn, False, False, 0)

        # Язык интерфейса. Стоит справа в строке состояния: это редкая
        # настройка, и она не должна отнимать место у главного.
        self.lang_btn = Gtk.ComboBoxText()
        self.lang_btn.append("ru", "Русский")
        self.lang_btn.append("en", "English")
        self.lang_btn.set_active_id(self.lang)
        self.lang_btn.set_tooltip_text(t(self.lang, "language"))
        self.lang_btn.connect("changed", self._on_lang)
        status_row.pack_end(self.lang_btn, False, False, 0)

        outer.pack_start(status_row, False, False, 0)

        # карточки тем
        self.theme_title = Gtk.Label(label=t(self.lang, "themes"))
        self.theme_title.set_xalign(0)
        self.theme_title.get_style_context().add_class("group-title")
        outer.pack_start(self.theme_title, False, False, 0)

        # Карточки в горизонтальном скроллере: тем может быть сколько угодно,
        # а минимальная ширина окна остаётся разумной. Полоса прокрутки
        # накладывается поверх, места у карточек не отнимает.
        theme_scroll = Gtk.ScrolledWindow()
        theme_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        theme_scroll.set_overlay_scrolling(True)
        self.theme_box = Gtk.Box(spacing=8)
        theme_scroll.add(self.theme_box)
        outer.pack_start(theme_scroll, False, False, 0)
        for theme in self.themes:
            self.theme_box.pack_start(self._make_theme_card(theme), False, False, 0)

        outer.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

        # параметры
        self.settings_title = Gtk.Label(label=t(self.lang, "params"))
        self.settings_title.set_xalign(0)
        self.settings_title.get_style_context().add_class("group-title")
        outer.pack_start(self.settings_title, False, False, 0)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)
        self.settings_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        scroll.add(self.settings_box)
        outer.pack_start(scroll, True, True, 0)

        footer = Gtk.Box(spacing=8)
        self.reset_btn = Gtk.Button(label=t(self.lang, "reset"))
        self.reset_btn.connect("clicked", self._on_reset)
        footer.pack_start(self.reset_btn, False, False, 0)
        self.saved_label = Gtk.Label(label="")
        self.saved_label.set_xalign(1)
        footer.pack_end(self.saved_label, True, True, 0)
        outer.pack_start(footer, False, False, 0)

        # Подпись внизу тоже переводится: держим ссылку на неё.
        self.note_label = Gtk.Label(label=t(self.lang, "note"))
        self.note_label.set_xalign(0)
        self.note_label.get_style_context().add_class("hint")
        outer.pack_start(self.note_label, False, False, 0)

        self.show_all()

    def _make_theme_card(self, theme):
        tid = theme["id"]
        info = THEME_INFO.get(tid, {})
        card = Gtk.Button()
        card.set_relief(Gtk.ReliefStyle.NONE)
        card.get_style_context().add_class("theme-card")
        card.set_tooltip_text(theme_text(self.lang, tid, "desc", info.get("desc", "")))
        card.set_hexpand(True)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        thumb = self._make_thumb(tid)
        thumb.set_halign(Gtk.Align.CENTER)
        self.thumbs[tid] = thumb
        box.pack_start(thumb, True, False, 0)
        name = Gtk.Label(label=theme_text(self.lang, tid, "name", info.get("name", tid)))
        name.set_xalign(0.5)
        box.pack_start(name, False, False, 0)
        desc = Gtk.Label(label=theme_text(self.lang, tid, "desc", info.get("desc", "")))
        desc.set_xalign(0.5)
        desc.set_line_wrap(True)
        desc.set_max_width_chars(22)
        desc.get_style_context().add_class("hint")
        desc.set_lines(2)
        desc.set_ellipsize(3)
        box.pack_start(desc, False, False, 0)
        card.add(box)
        card.connect("clicked", lambda _b, t=tid: self._select_theme(t))
        self.cards[tid] = card
        return card

    def _thumb_path(self, tid, variant=None):
        """Файл превью для темы и её варианта.

        У варианта может быть своё превью (поле `thumb` в записи варианта,
        путь от корня репозитория). Нет своего — берём превью темы.
        """
        theme = self.theme_by_id.get(tid) or {}
        if variant:
            for v in theme.get("variants", []):
                if v["id"] == variant and v.get("thumb"):
                    return DATA / v["thumb"]
        info = THEME_INFO.get(tid, {})
        return DATA / info.get("thumb", "prototype/thumbs/%s.webp" % tid)

    def _make_thumb(self, tid):
        info = THEME_INFO.get(tid, {})
        width, height = 168, 70
        path = self._thumb_path(tid, self.state["params"].get(tid, {}).get("variant"))
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
        name = theme_text(self.lang, tid, "name", info.get("name", tid))
        self.settings_title.set_text(t(self.lang, "params_of") % name)
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
            if theme.get("variants"):
                self.settings_box.pack_start(self._make_variant_row(theme), False, False, 0)
            current = self.state["params"][self.theme_id].get("variant")
            for gi, group in enumerate(theme.get("groups", [])):
                # Группа может состоять целиком из параметров другого
                # варианта — тогда заголовок тоже не нужен.
                shown = [p for p in group.get("params", [])
                         if self._param_applies(p, current)]
                if not shown:
                    continue
                glabel = group_labels[gi] if gi < len(group_labels) else t(self.lang, "params")
                title = Gtk.Label(label=group_text(self.lang, self.theme_id, gi, glabel))
                title.set_xalign(0)
                title.get_style_context().add_class("group-title")
                self.settings_box.pack_start(title, False, False, 0)
                for p in shown:
                    row = self._make_param_row(p)
                    if row is not None:
                        self.settings_box.pack_start(row, False, False, 0)
            self.settings_box.show_all()
        finally:
            self._updating = False

    def _make_variant_row(self, theme):
        """Переключатель вариантов темы: сегментированные кнопки.

        Вариант — это не отдельная карточка в списке тем, а подвид внутри
        неё. Так список не растёт, а пользователь видит, что перед ним одна
        тема в двух видах, а не две похожие темы.
        """
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        title = Gtk.Label(label=t(self.lang, "variant"))
        title.set_xalign(0)
        title.get_style_context().add_class("group-title")
        box.pack_start(title, False, False, 0)

        row = Gtk.Box(spacing=6)
        row.get_style_context().add_class("linked")
        current = self.state["params"][self.theme_id].get("variant")
        buttons = {}
        for v in theme["variants"]:
            btn = Gtk.ToggleButton(label=variant_text(self.lang, self.theme_id,
                                                      v["id"], v.get("name", v["id"])))
            btn.set_tooltip_text(v.get("desc", ""))
            if v["id"] == current:
                btn.set_active(True)
            btn.connect("clicked", lambda b, vid=v["id"]: self._on_variant(vid, buttons))
            buttons[v["id"]] = btn
            row.pack_start(btn, True, True, 0)
        box.pack_start(row, False, False, 0)
        return box

    def _on_variant(self, vid, buttons):
        if self._updating:
            return
        for bid, btn in buttons.items():
            btn.set_active(bid == vid)
        params = self.state["params"][self.theme_id]
        params["variant"] = vid
        # У варианта свои значения параметров: подставляем их, чтобы и
        # ползунки, и сцена показывали одно и то же. Без этого страница
        # получала новый вариант вместе со старыми числами и перекрывала
        # ими то, что вариант только что выставил.
        theme = self.theme_by_id[self.theme_id]
        for v in theme.get("variants", []):
            if v["id"] == vid:
                params.update(v.get("params", {}))
                break
        self._sync_thumb(self.theme_id)
        self._rebuild_settings()
        self._schedule_persist()

    def _sync_thumb(self, tid):
        """Показать в карточке превью текущего варианта.

        Карточка одна, вариантов у неё может быть несколько: превью
        подменяется, чтобы карточка показывала то, что сейчас на столе.
        """
        thumb = self.thumbs.get(tid)
        if thumb is None:
            return
        path = self._thumb_path(tid, self.state["params"].get(tid, {}).get("variant"))
        if isinstance(thumb, AnimatedThumb):
            try:
                thumb.load(path)
                return
            except Exception:
                pass
        if not path.is_file():
            return
        parent = thumb.get_parent()
        if parent is None:
            return
        new_thumb = self._make_thumb(tid)
        new_thumb.set_halign(Gtk.Align.CENTER)
        parent.remove(thumb)
        parent.pack_start(new_thumb, True, False, 0)
        parent.reorder_child(new_thumb, 0)
        new_thumb.show()
        self.thumbs[tid] = new_thumb

    @staticmethod
    def _param_applies(p, variant):
        """Показывать ли параметр в текущем варианте темы.

        Поле `variants` у параметра перечисляет варианты, где он имеет
        смысл: ползунок сияния бессмыслен там, где сияния нет, а число
        светлячков — там, где их нет. Нет поля — параметр общий.
        """
        allowed = p.get("variants")
        if not allowed or not variant:
            return True
        return variant in allowed

    def _param_label(self, p):
        labels = PARAM_LABELS.get(self.theme_id, {})
        return param_text(self.lang, self.theme_id, p["key"],
                          labels.get(p["key"], p["key"]))

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
        scale.set_size_request(-1, 22)
        val_label = Gtk.Label(label=fmt_value(p, value, self.theme_id, self.lang))
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
            label.set_text(fmt_value(p, value, tid, self.lang))
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
        self.saved_label.set_text(t(self.lang, "saved"))
        GLib.timeout_add(1200, self._clear_saved)
        return False

    def _persist_now(self):
        save_state(self.state)
        write_control(self.state, self.theme_id, self.themes)

    def _clear_saved(self):
        self.saved_label.set_text("")
        return False

    def _on_lang(self, combo):
        """Смена языка: сохраняем выбор и перестраиваем надписи.

        Пересобирать всё окно дорого и рискованно (потеряется фокус), поэтому
        обновляем только текст: карточки и панель параметров строятся
        заново из тех же данных.
        """
        code = combo.get_active_id()
        if not code or code == self.lang or code not in UI:
            return
        self.lang = code
        try:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            SETTINGS_LANG.write_text(code + "\n", encoding="utf-8")
        except Exception:
            pass

        self.start_btn.set_label(t(self.lang, "layer_on"))
        self.stop_btn.set_label(t(self.lang, "layer_off"))
        self.reset_btn.set_label(t(self.lang, "reset"))
        self.theme_title.set_text(t(self.lang, "themes"))
        self.note_label.set_text(t(self.lang, "note"))
        self.lang_btn.set_tooltip_text(t(self.lang, "language"))

        # Карточки: имя, описание, подсказка.
        for tid, card in self.cards.items():
            info = THEME_INFO.get(tid, {})
            card.set_tooltip_text(theme_text(self.lang, tid, "desc", info.get("desc", "")))
            box = card.get_child()
            labels = [w for w in box.get_children() if isinstance(w, Gtk.Label)]
            if len(labels) >= 2:
                labels[0].set_text(theme_text(self.lang, tid, "name", info.get("name", tid)))
                labels[1].set_text(theme_text(self.lang, tid, "desc", info.get("desc", "")))

        self._select_theme(self.theme_id, initial=True)
        self._refresh_status()

    def _on_start(self, _btn):
        self._persist_now()
        # wall-on.sh теперь ждёт фактической готовности (обычно 2-3 с),
        # а не спит фиксированные паузы. Держим кнопки заблокированными
        # чуть дольше, чтобы не поймать промежуточное состояние.
        self._busy_until = time.monotonic() + 5
        self.status_label.set_text(t(self.lang, "starting"))
        self.start_btn.set_sensitive(False)
        self.stop_btn.set_sensitive(False)
        subprocess.Popen(["bash", str(HERE / "wall-on.sh")],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=script_env(), start_new_session=True)

    def _on_stop(self, _btn):
        self._busy_until = time.monotonic() + 4
        self.status_label.set_text(t(self.lang, "stopping"))
        self.start_btn.set_sensitive(False)
        self.stop_btn.set_sensitive(False)
        subprocess.Popen(["bash", str(HERE / "wall-off.sh")],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=script_env(), start_new_session=True)

    def _refresh_status(self):
        if time.monotonic() < self._busy_until:
            return True
        running = is_running()
        self.status_label.set_text(t(self.lang, "on") if running else t(self.lang, "off"))
        self.start_btn.set_sensitive(not running)
        self.stop_btn.set_sensitive(running)
        return True


def main():
    themes = load_registry()
    if not themes:
        print("Mintland: в themes.json нет готовых тем", file=sys.stderr)
        return 1
    # В установленном пакете рядом с кодом нет prototype/ — значит, это не
    # дерево исходников, и можно положить ярлык на рабочий стол.
    if not (HERE / "prototype").is_dir():
        ensure_desktop_shortcut()
    signal.signal(signal.SIGINT, lambda *_: Gtk.main_quit())
    win = Switcher(themes)
    win.present()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
