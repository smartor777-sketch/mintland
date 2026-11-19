# Mintland themes: how they work and how to add a new one

> **Document:** a technical description of the theme contract and the procedure for adding a new one.
> **Date:** 13.11.2026.
> **Scope:** `prototype/`, `switcher.py`, `themehost.py`, `tools/`.
> **Audience:** whoever is adding a theme — their own or a ported one.
> **Paths:** all paths in the document are from the repository root, not from `docs/`.

---

## 0. In brief

A Mintland theme is **not a picture and not a set of video files**. It is an **HTML page with a
scene** that draws itself every frame and receives icon rectangles, parameters and a "pause"
command from the host. The background and the PNG assets are merely material that this page
uses.

The reason is simple: the scene **adapts to the icons**. The shoreline flows around their
outlines, clouds gather around them, halos highlight them. A static background cannot do
that — it does not know where the icons are or how big they are.

The minimal kit for a new theme:

```
prototype/<theme>.html          ← the scene: draws the frame, listens to the host protocol
prototype/themes.json          ← the theme entry (id, name, page, parameters)
switcher.py                    ← Russian labels, card order, preview
docs/theme-<theme>.gif          ← animated preview (optional, but customary)
```

Assets (`prototype/assets/*.png`) — only if the scene uses them.

## Contents

- [0. In brief](#0-in-brief)
- [1. What already exists in the project](#1-what-already-exists-in-the-project)
- [2. The page contract](#2-the-page-contract)
- [3. How the scene uses icons](#3-how-the-scene-uses-icons)
- [4. The entry in `themes.json`](#4-the-entry-in-themesjson)
- [5. Registration in `switcher.py`](#5-registration-in-switcherpy)
- [6. Preview](#6-preview)
- [7. Tools](#7-tools)
- [8. New theme checklist](#8-new-theme-checklist)
- [9. Pitfalls](#9-pitfalls)
- [10. How much it costs](#10-how-much-it-costs)
- [11. Can a theme be built "from scratch", without the Deskland sources](#11-can-a-theme-be-built-from-scratch-without-the-deskland-sources)
  - [11.1. How the "Night" theme was built (a walkthrough)](#111-how-the-night-theme-was-built-a-walkthrough)
- [12. Step by step](#12-step-by-step)
- [13. Code references](#13-code-references)
- [14. Why there are no presets, only variants](#14-why-there-are-no-presets-only-variants)
- [15. Theme variants](#15-theme-variants)

---

## 1. What already exists in the project

| Theme | Page | What is interesting about it |
|---|---|---|
| Beach | `prototype/flat.html` | WebGL2 shader: the shoreline is built from the icons, waves, palms, kayaks, seagulls |
| Meadow | `prototype/meadow.html` | WebGL2: clouds around the icons, a boy with a kite, a kitten |
| Night | `prototype/night.html` | Canvas 2D without a single asset file: stars, aurora, mist, halos around the icons |
| Forest | `prototype/forest.html` | WebGL2 ground with a canvas 2D layer on top: trees of seven kinds, drawn in code; clearings around the icons |

Another 11 themes in `themes.json` have `status: "locked"` — there are no HTML scenes for them.
These are not "disabled" themes but blanks from Deskland: they only have a thumbnail.

The night theme was added as a check of the contract: it is written from scratch, contains no
external files and fits in ~580 lines.

---

## 2. The page contract

### 2.1. How the host opens a theme

`themehost.py` loads the page like this:

```text
file:///…/prototype/<theme>.html?wallpaper=1
```

and **before** the page loads it injects a shim that replaces the WebView2 API
(Deskland was written for Windows, the pages expect `window.chrome.webview`):

```js
window.chrome.webview.addEventListener('message', cb);  // incoming messages
window.chrome.webview.postMessage('ready');             // outgoing
```

The shim is defined in `themehost.py` (`SHIM_JS`). There is no need to change it — you need
to use it.

### 2.2. Messages: host → page

| Message | Fields | Meaning |
|---|---|---|
| `icons` | `vis: bool`, `r: [[l,t,r,b], …]` | Icon rectangles in **physical** pixels. Arrive once every 2 s, and also right after loading and a theme switch |
| `settings` | `v: {key: value}` | Theme parameters. A partial update, not the full set |
| `reset` | `v: {…}` | Reset to the default values |
| `pause` | `v: bool` | `true` — there is a maximized or fullscreen window on screen, the animation must stop |

### 2.3. Messages: page → host

One: the string `ready`, when the page is ready to receive messages. The host uses it to
start polling icons and pause.

### 2.4. Responsibilities of the page

1. Send `ready` **after** the scene is ready to draw.
2. Accept `icons` and take the rectangles into account in rendering.
3. Accept `settings` and apply only those keys it knows.
4. **Respect `pause`**: while paused, do not schedule the next frame. This is not
   a wish — without it the scene will burn a core under a fullscreen video.
5. Limit the FPS (in the existing themes — 30 fps, the `cap30` flag).

### 2.5. Minimal working theme

Such a file already starts, turns on and off, but does not yet know about
the icons:

```html
<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #06101f; }
  #art { position: fixed; inset: 0; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="art"></canvas>
<script>
(function () {
  'use strict';
  var cv = document.getElementById('art');
  var ctx = cv.getContext('2d', { alpha: false });
  var P = { glow: 60, cap30: true };
  var icons = [], paused = false, last = 0;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
    cv.style.width = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function render(t) {
    ctx.fillStyle = '#06101f';
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    var k = window.devicePixelRatio || 1;
    for (var i = 0; i < icons.length; i++) {          // halo around the icon
      var r = icons[i];
      var cx = (r[0] + r[2]) / 2 / k, cy = (r[1] + r[3]) / 2 / k;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, P.glow);
      g.addColorStop(0, 'rgba(140,200,255,0.35)');
      g.addColorStop(1, 'rgba(140,200,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, P.glow, 0, Math.PI * 2); ctx.fill();
    }
  }

  function frame(now) {
    if (paused) { last = 0; return; }                 // while paused we do not schedule a frame
    requestAnimationFrame(frame);
    if (P.cap30 && now - last < 31) return;
    last = now;
    render(now);
  }

  function handle(m) {
    if (!m || !m.t) return;
    if (m.t === 'pause') { paused = !!m.v; if (!paused) requestAnimationFrame(frame); return; }
    if (m.t === 'settings') { for (var k in m.v) if (k in P && typeof m.v[k] === typeof P[k]) P[k] = m.v[k]; return; }
    if (m.t !== 'icons') return;
    icons = m.vis ? (m.r || []) : [];
    render(performance.now());
  }

  resize();
  addEventListener('resize', function () { resize(); render(performance.now()); });
  render(performance.now());
  requestAnimationFrame(frame);

  var host = window.chrome && window.chrome.webview;
  if (host) {
    host.addEventListener('message', function (ev) { handle(JSON.parse(ev.data)); });
    host.postMessage('ready');
  }
})();
</script>
</body>
</html>
```

---

## 3. How the scene uses icons

The host sends **physical** pixels (logical × `scale`). The page divides
them by `window.devicePixelRatio` and gets CSS pixels:

```js
const k = window.devicePixelRatio || 1;
icons = m.r.map(([l, t, r, b]) => ({
  x: l / k, y: t / k, w: (r - l) / k, h: (b - t) / k
}));
```

Then there are three levels of complexity:

| Level | What the scene does | Example | Cost |
|---|---|---|---|
| 1 | Nothing: just a background | the minimal theme above | hours |
| 2 | A halo/spot/shadow under each icon | `night.html` | 1–2 days |
| 3 | A distance field to the icons, from which the relief is built | `flat.html`, `meadow.html` | 1–2 weeks |

The third level is when the shoreline "flows around" the icons instead of merely highlighting
them. In `flat.html`, for this a distance map is computed (Gaussian "metaballs" +
noise), and from it the shader draws water, sand and foam.

---

## 4. The entry in `themes.json`

The file lives in `prototype/themes.json`. Names, descriptions and parameter labels are
stored right in it, in Russian.

```json
{
  "id": "night",
  "adaptive": true,
  "name": "Ночь",
  "desc": "Звёздное небо, полярное сияние и туман; вокруг иконок — мягкое свечение",
  "page": "night.html",
  "status": "ready",
  "product": "free",
  "groups": [
    {
      "name": "Иконки",
      "params": [
        { "key": "halo", "label": "Свечение вокруг иконок",
          "hint": "мягкий ореол, чтобы иконки читались на тёмном небе",
          "min": 40, "max": 200, "step": 1, "default": 96, "unit": "px" }
      ]
    }
  ]
}
```

Rules:

- **`status: "ready"` + `page`** — without this the theme will not appear in the list.
  The other 11 entries have `status: "locked"`.
- **`groups[].params[]`** — from them `switcher.py` builds sliders and
  toggles. The `key` key must match the key in the `P` object on
  the page.
- **The value type matters.** The page applies a parameter only if
  `typeof v[k] === typeof P[k]`. The number `1` is a number, not `true`; `0/1`
  for a toggle, not `false/true`.
- **A toggle** — a parameter with `options` of two strings and `default: 0|1`.
  `switcher.py` will show a `Gtk.Switch`.
- **`format`**: `"percent"` (0..1 → "70%"), `"times"` (→ "×0.65").

---

## 5. Registration in `switcher.py`

Six dictionaries. If something is not filled in, the theme will still appear, but with
the description from `themes.json` and technical keys instead of labels.

| Dictionary | What it sets | If skipped |
|---|---|---|
| `THEME_INFO` | Russian name, description, path to the GIF | the name and description are taken from `themes.json`, the preview — not |
| `GROUP_LABELS` | Russian group headings | the headings will be "Parameters" |
| `PARAM_LABELS` | Russian parameter labels | the labels will be technical keys (`halo`) |
| `THEME_ORDER` | card order | the theme goes to the end (code `99`) |
| `UNIT_LABELS` | units of measurement | the unit is taken from `themes.json` |
| `DEFAULT_OVERRIDES` | your own default values | taken from `themes.json` (Beach is more expensive on CPU there) |

Example for the night theme:

```python
THEME_INFO = {
    # …
    "night": {
        "name": "Ночь",
        "desc": "Звёздное небо, полярное сияние и туман; иконки в мягком ореоле.",
        "thumb": "docs/theme-night.gif",
    },
}

GROUP_LABELS = {"night": ["Иконки", "Небо", "Туман"]}
PARAM_LABELS = {"night": {"halo": "Свечение вокруг иконок", "aurora": "Полярное сияние"}}
THEME_ORDER = {"beach": 0, "meadow": 1, "night": 2}
UNIT_LABELS = {"night": {"halo": "px", "shoot": "шт"}}
```

---

## 6. Preview

The theme card shows an **animated GIF** 250×141 from `docs/theme-<id>.gif`.
The search order in `switcher.py`:

1. `docs/theme-<id>.gif` — animated preview;
2. `prototype/thumbs/<id>.webp` — static thumbnail from Deskland;
3. a GTK placeholder icon.

### 6.1. Recording a GIF

The repository has `tools/capture-theme.py`. It renders the page into
a `Gtk.OffscreenWindow` (nothing appears on screen), invokes frames at
the required times and stitches a GIF together:

```bash
python3 tools/capture-theme.py prototype/night.html docs/theme-night.gif \
    --frames 30 --size 1280x720 --width 400
```

Requirements for the page:

- understand `?freeze=1` — do not start `requestAnimationFrame`;
- have `window.__renderAt(t)` — draw a frame at time `t` ms.

Without these two hooks, recording would have to be done with window screenshots, which is
non-deterministic and requires a visible desktop.

Result: 30 frames of 100 ms each, 400×225, loop. Size — 300–400 KB.

---

## 7. Tools

| File | What it does |
|---|---|
| `tools/capture-theme.py` | records a GIF preview via `?freeze=1` + `__renderAt(t)` |
| `tools/test-theme.py` | contract check: `ready`, a frame, reaction to `icons`/`settings`/`pause`, JS errors |
| `tools/preview-frame.py` | one frame with an icon grid — to see how the scene looks under the icons |
| `tools/bench-theme.py` | frame time and the contribution of each effect separately |

Checking a new theme before committing:

```bash
python3 tools/test-theme.py prototype/night.html
```

Output:

```text
prototype/night.html
  OK   the page sent ready
  OK   the page has a canvas
  OK   the frame is not empty
  OK   the __renderAt/__inject hook is present (for previews and tests)
  OK   the icons affect the frame
  OK   no JS errors
  brightness at the icon point: 419 before, 658 after
```

`SKIP` is printed for themes without hooks (Beach and Meadow were written before the
tools appeared) and for WebGL scenes: their pixels cannot be read this way.

### 7.1. Performance

`tools/bench-theme.py` measures how much a frame costs and immediately shows which
effect is responsible for it:

```text
prototype/night.html (2560x1440)
  everything as is     10.8 ms/frame   (92 fps)
  mist off              9.2 ms/frame   (109 fps)
  aurora off            0.3 ms/frame   (4000 fps)
  halos off             0.1 ms/frame   (12000 fps)
  no effects            0.1 ms/frame   (12000 fps)
```

From this it is clear: the aurora eats all the time, the rest is fractions of a millisecond.
That is why it was then cached (see §9). Without the measurement the edits would have been
guesswork.

A live measurement of the same thing on this machine (scene on screen): **~50% of one core**,
of which roughly equally `themehost.py` and `WebKitWebProcess`. While paused —
**0.4% of one core**.

---

## 8. New theme checklist

- [ ] `prototype/<theme>.html` — the scene, without external dependencies or with
      assets in `prototype/assets/`
- [ ] the page sends `ready`
- [ ] it handles `icons`, `settings`, `pause`
- [ ] while paused it does not schedule frames
- [ ] a 30 fps limit
- [ ] it works with `?wallpaper=1`
- [ ] it understands `?freeze=1` and supports `__renderAt(t)` (for previews and tests)
- [ ] an entry in `themes.json`: `status: "ready"`, `page`, `groups`
- [ ] the `default` types match the types in `P` on the page
- [ ] `THEME_INFO`, `GROUP_LABELS`, `PARAM_LABELS`, `THEME_ORDER`, `UNIT_LABELS`
- [ ] `docs/theme-<id>.gif`
- [ ] `python3 tools/test-theme.py prototype/<theme>.html` passes
- [ ] verified live: turn on the layer, switch the theme, move the icons,
      turn it off and on again (filming method — §9, "Live check")
- [ ] verified that under a maximized window the scene pauses

---

## 9. Pitfalls

**Parameter types.** The most common cause of "the slider does nothing": in
`themes.json` `default: 1`, while in `P` it is `true`. The page silently ignores
the value.

**Render scale.** Limit it. `flat.html` does
`Math.min(devicePixelRatio, P.quality, 0.75)`, while `meadow.html` for a long time
did the same without the last term — and drew 7 times more pixels for
the same picture (walkthrough in [`IMPROVEMENTS.md`](IMPROVEMENTS.md), §1). The scene is
a blurred background under the icons, detail above 0.75 is not visible.

**`devicePixelRatio`.** The host sends physical pixels. If you forget to
divide by `devicePixelRatio`, at 150% scaling the halos will drift away from the icons.
On Wayland this spot is additionally complicated — see `WAYLAND.md`, §4.4.

**Files next to the page.** By default WebKit does not serve neighbouring `.js` and `.png`
files to a `file://` page. In `themehost.py` this is enabled
(`set_allow_file_access_from_file_urls`), and in `tools/test-theme.py` it is
repeated, otherwise the check will show false errors.

**Pause.** If while paused you simply "do not draw" but keep scheduling
frames, the CPU does not drop: `requestAnimationFrame` keeps waking the compositor
30 times a second. What is needed is precisely **not scheduling** the next frame.

**The cost of effects.** A fullscreen aurora drawn honestly every frame is
~10 ms at 2560×1440. It is cured by three techniques, all applied in
`night.html`:

1. draw into a small buffer and stretch it (`AURORA_K = 4`) — the upscale itself
   provides the blur;
2. update the buffer not every frame (`AURORA_EVERY = 140` ms) — the aurora changes
   slowly, no difference is visible;
3. do not render in physical pixels (`dpr` is capped at one): the scene is
   a blurred background under the icons, extra detail is not visible.

**Live check.** A screenshot of the desktop often lies: if any window is on top (even a
transparent one), you are capturing it, not the icons. You need to check
like this:

```bash
wmctrl -k on                      # show the desktop
sleep 1
gnome-screenshot -f /tmp/desk.png
wmctrl -k off                     # bring the windows back
```

And compare not "by eye" but by the number of pixels of the characteristic icon colour in
the top-left corner. Otherwise it is easy to get a false alarm "the icons are gone".

**The `nemo-desktop` window is not empty even when it seems so.** `xwd` on the icon window
shows a black frame — that is normal: Nemo draws through the compositor, and
reading the window directly gives no content. You can only judge by a screenshot of the screen.

**Preview cache.** WebKit caches files by URL; when a GIF is replaced, the card may
show the old version. Restarting `switcher.py` helps.

**Licence.** The project as a whole is under GPL-3.0 (`NOTICE`). New themes must be
compatible with GPL-3.0. The Deskland names and logos are trademarks, they must not
be used.

**The language of the texts.** The Russian names and labels live right in `themes.json`, in
the fields `name`, `desc`, `label`, `hint`, `unit`, `options`. `switcher.py` takes
them from there, and `THEME_INFO` only sets the card descriptions and the path to the preview.

There is no Chinese in the project: comments in the legacy code have been translated into Russian.

---

## 10. How much it costs

| Theme type | What is inside | Time |
|---|---|---:|
| Gradient/canvas not tied to the icons | ~100–150 lines | 1–3 hours |
| 2D scene with halos and mist | canvas 2D, sprites, a couple of layers | 1–2 days |
| 2D scene with relief driven by the icons | distance field, smoothing, transitions | 3–5 days |
| A full-fledged WebGL scene like Beach/Meadow | shaders, assets, small-object physics | 1–2 weeks |

The night theme is the second option: **~580 lines, one evening** together with the preview
and the tests. That is exactly why it was made: so that the contract would be not theory but a
working example.

A measurement on this machine (2560×1440, 30 fps, scene active): **~50% of one core**,
that is roughly **2.5% of the whole processor** (20 threads). Beach under the same
conditions — ~65% of one core, because there the WebGL shader covers the whole screen.

---

## 11. Can a theme be built "from scratch", without the Deskland sources

Yes. The night theme proves it: it does not use a single file from
`prototype/assets/`, all the materials — gradients, noise and shapes — are drawn by
code.

What is really needed to build a new theme:

| Material | Required | Where to get it |
|---|---|---|
| An idea and a palette | yes | chosen by hand |
| Scene geometry | yes | code: canvas 2D, SVG or WebGL |
| Textures, characters | no | drawn by code, or PNG in `prototype/assets/` |
| Noise/grain | no | generated by a function (`mulberry32` + sines) |
| Preview | no, but customary | `tools/capture-theme.py` |

There is one restriction: **assets must be your own or GPL-compatible**.
The ready-made PNGs from Deskland are already in the repository under GPL-3.0 — they can be
reused, but you must not bring in images with an unclear licence.

---

### 11.1. How the "Night" theme was built (a walkthrough)

The night theme is not an example "in words" but a path that was walked. It is useful to know
what exactly took the time.

**What was done without a single external file:**

- the sky — a linear gradient + a diagonal "milky" haze;
- the stars — a deterministic PRNG (`mulberry32`), ~700 points, some of them twinkle;
- the moon — two radial gradients plus three craters;
- the aurora — three ribbons, each of ~190 vertical "beams" with
  an individual length and brightness; the high-frequency component gives the
  storm effect;
- the mist — 9 copies of a cloud sprite, an edge mask, a slow drift;
- the icon halos — one radial sprite, one per icon;
- meteors — a parameterised segment with a gradient, a "lifetime" of 0.95 s;
- the hills — two sine lines with a gradient fill.

**What took the most time:** not the code, but **finding the look of the aurora**. The first
three approaches gave bands, "bars" and a seam between sprites — on screenshots this is
visible immediately, while in the code it looks fine. What helped was that each variant was
recorded to a GIF and compared by eye.

**What gave the main CPU gain:** the aurora buffer cache and the `dpr` cap.
Before that a frame cost ~12 ms, after — ~2.5 ms (see §7.1).

**Conclusion:** a mid-level theme can be built in one evening if you have the
tools (`capture`, `test`, `bench`, `preview-frame`). Without them the loop
"changed → looked → measured" stretches several times over.

---

## 12. Step by step

1. **Determine the level** (see §3): background, halos or relief driven by the icons.
2. **Write the page** according to the contract from §2; check `?wallpaper=1` manually.
3. **Add the hook** `__renderAt(t)` and `?freeze=1` — otherwise there will be no preview.
4. **Run** `tools/test-theme.py`.
5. **Look at** `tools/preview-frame.py` with the icon grid.
6. **Record** `docs/theme-<id>.gif`.
7. **Register** in `themes.json` and `switcher.py`.
8. **Check live**: turn on, switch, move the icons, turn off,
   turn on again.
9. **Measure the CPU** of the active scene and of the pause; if the pause does not drop below 5%
   of one core — look for what keeps scheduling frames.
10. **Update** the theme table in `README.md`.

---

## 13. Code references

- `prototype/night.html` — the reference simple theme (canvas 2D, no assets);
  a walkthrough of its construction is in §11.1.
- `prototype/flat.html` — WebGL2, a distance field to the icons, assets.
- `prototype/meadow.html` — WebGL2, clouds around the icons, characters.
- `themehost.py` — the host, the shim, polling of icons and pause, theme switching.
- `switcher.py` — cards, sliders, saving, writing `control.json`.
- `iconsource.py` — where the icon rectangles come from.
- `tools/capture-theme.py`, `tools/test-theme.py`, `tools/preview-frame.py`,
  `tools/bench-theme.py`.
- [`WOLOLAND.md`](WOLOLAND.md) — a walkthrough of someone else's project, from which the
  ideas of caching and theme presets were taken.
- [`IMPROVEMENTS.md`](IMPROVEMENTS.md) — what else is worth fixing, with measurements.
- [`OCCLUSION.md`](OCCLUSION.md) — the Cinnamon/Muffin layers and why the icons
  may end up under the scene.
- [`PAPER.md`](PAPER.md) — object themes ("a map on paper"): another way
  of building a scene, from sprites on an isometric grid.

---

## 14. Why there are no presets, only variants

Previously there was a section "Theme preset" in this place: a mechanism whereby a theme is
a separate entry in `themes.json` with a `preset` field, and the page receives the
palette name and switches colours. The mechanism was written and worked. In the end it was
abandoned, and the section was rewritten as an explanation of why.

If you are looking for how to add a variety of a theme, that is §15, not here.

### 14.1. What there was

In `flat.html` a `PALETTES` table appeared: name → the colours of the sea, sand, foam.
The colours went into the shader as uniforms, so switching did not reload the
page. The preset was selected via `?preset=…` or the `preset` field in the registry,
which `switcher.py` turned into `palette` among the parameters.

`switcher.py` builds the theme list like this:

```python
themes = [t for t in data["themes"] if t.get("status") == "ready"]
for theme in self.themes:
    self.theme_box.pack_start(self._make_theme_card(theme), ...)
```

Each ready entry is a separate card, there is no nesting. So a preset stood **next to**
the original theme as an equal.

### 14.2. Why it was abandoned

Two presets were made, Maldives and Lagoon, and both turned out to be visual
clones of Beach. The measurement:

| | Beach | Maldives | Lagoon |
|---|---|---|---|
| water in the distance | `#008fba` | `#12b2bf` | `#0d4f99` |
| dry sand | `#f7ede0` | `#fcf7eb` | `#edebe3` |
| sand difference | — | 12/441 | **11/441** |

The difference in the sand is about 3% — invisible to the eye. Even different shoreline
parameters (Maldives has a wider shoal, Lagoon has a more indented shore) did not help: the
silhouette, the palms and the kayaks stayed the same.

In a list of three themes there were five cards, two of which were variants of
the neighbouring ones. That is worse than three honest themes.

Conclusion: **a palette is not enough**. A variety must change the form —
the silhouette, the set of objects, the composition — otherwise it reads as a filter.

### 14.3. What was done instead

Two changes:

1. **The variety moved inside the card** — it became `variant` rather than
   a separate entry in the registry. The list of themes does not grow. Details in §15.
2. **The variant gained the right to change more than colour.** In Night it sets the sky,
   the hills and the set of objects; colour is only part of the table.

The registry no longer knows the `preset` field at all: `switcher.py` does not read it,
and neither do the pages.

### 14.4. What is left of the mechanism

The useful part — **the palette taken out of the shader into uniforms**. It has not gone
anywhere, but now it lives in each theme's `VARIANTS` table:

| Theme | Table | What is in it |
|---|---|---|
| Beach | `VARIANTS.beach` | the colours of the sea, sand, foam |
| Meadow | `VARIANTS.meadow` | the colours of the grass and clouds |
| Night | `VARIANTS.polar`, `VARIANTS.fireflies` | sky, hills, set of objects |

This is the unification for the sake of which everything was done: all three themes have one
way of describing a variety.

---

## 15. Theme variants

A variant is a subspecies within one theme, not a separate card in the list.
That way the catalogue does not bloat: three themes stay three, and there can be
any number of varieties.

### 15.1. When it is a variant and when it is a separate theme

| Criterion | Variant | Separate theme |
|---|---|---|
| Drawing mechanics | the same | different (canvas 2D instead of WebGL) |
| What changes | the sky, the palette, the set of objects | everything, including how the frame is assembled |
| Cost | ~50 lines per effect | its own page |

If the difference comes down only to colours and numbers, the variant is formally
acceptable, but it reads as a clone — this was tested on Maldives and Lagoon (§14.2).
Therefore a variant must have at least one thing unreachable by sliders:
its own sky, its own layer of objects, its own geometry.

### 15.2. The entry in `themes.json`

```json
{
  "id": "night",
  "name": "Ночь",
  "variants": [
    {
      "id": "polar", "name": "Полярная", "desc": "Сияние, луна и холодные холмы",
      "params": { "aurora": 0.7, "moon": 1, "mist": 0.5, "fireflies": 0 }
    },
    {
      "id": "fireflies", "name": "Светлячки", "desc": "Тёплый горизонт, рой светлячков",
      "params": { "aurora": 0, "moon": 0, "mist": 0.28, "fireflies": 40 }
    }
  ],
  "defaultVariant": "polar"
}
```

A variant sets not only the look but also the starting values of the sliders. If they are
stored in two places — in the registry and inside the page — they will diverge:
the page will set its own, and then they will be overridden by the old numbers that arrived
in the same message from the sliders.

`theme_defaults()` in `switcher.py` adds `variant` to the theme parameters,
so nothing else in the registry needs to be changed.

### 15.3. What the page must be able to do

- Store the variant table: identifier → everything the variant changes.
- Accept `variant` by an ordinary `settings` message and apply it
  **before** the other parameters: the variant sets the starting values.
- Rebuild what depends on the size and the variant (in Night — the sky,
  the hills and the swarm of fireflies).

A ready example — `prototype/night.html`, the `VARIANTS` table and
`applySettings()`.

### 15.4. A variant's own parameters

A parameter that makes sense only in one variant is marked with the `variants` field:

```json
{ "key": "aurora", "label": "Полярное сияние", "variants": ["polar"], ... }
{ "key": "fireflies", "label": "Светлячки", "variants": ["fireflies"], ... }
```

`switcher.py` does not show such a slider in other variants, and hides a group
consisting only of them entirely. No field — the parameter is shared.

This is not cosmetics: the aurora slider in "Fireflies" looks broken —
you drag it and nothing happens on screen, because the aurora is turned off there by
the variant.

A variant can also have its own parameter values — the `params` field in its
entry. `switcher.py` substitutes them when switching, so that the sliders and the
scene show the same thing.

### 15.5. Variant preview

A variant can have its own preview — the `thumb` field in its entry (a path from the
repository root). If it has none — the theme's preview from `THEME_INFO` is taken.

`switcher.py` swaps the image in the card when switching: one
card, but it shows what is currently on the desktop. The file
changes without recreating the widget, so the animation is not disturbed.

```json
{ "id": "fireflies", "name": "Светлячки", "thumb": "docs/night-fireflies.gif" }
```

### 15.6. A mandatory condition

A variant must contain **something unreachable by sliders**. In Night that is
the sky and the hills: the gradient is set only in the variant table, which is why
"Fireflies" cannot be assembled by hand.

If a variant is merely another set of values of existing parameters,
the user will make it themselves in five seconds, and the card will be superfluous.
