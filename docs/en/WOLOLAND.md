# Wololand: an analysis of someone else's experience

> **Document:** a technical analysis of the [Wololand](https://github.com/gregstein/wololand) project and an assessment of what from it is applicable to Mintland.
> **Date:** 14.11.2026.
> **Subject:** which architectural decisions of Wololand are worth adopting, which are inapplicable and why.
> **What this is not:** this is not a proposal to port Wololand and not a work plan. The plan is in `IMPROVEMENTS.md`.

---

## 0. In short

Wololand is a live wallpaper for Windows that turns the desktop into an Age of Empires II map. Rust, MIT, 7,382 lines, created on 10.11.2026 (that is, it was studied on the third day of the project's life).

The value for Mintland is not in the themes and not in AoE2. The value is in three things:

1. **The rendering model.** The scene is baked into a single texture when the icons change, and a frame is a blit of the texture plus a handful of sprites. Our scene is recomputed every frame.
2. **A theme as a preset, not as a separate program.** Ten themes live in one file and differ by resource tables and a couple of logic branches.
3. **Discipline towards the user.** Priority lowering, debouncing rebuilds, a log with rotation, pausing by coverage area. These are the small things we do not have.

Separately important: **not a single Wololand module tied to Win32 is transferable.** That is 1,600 lines out of 7,382. What transfers is the idea, not the code.

---

## 1. What this project is

| Parameter | Value |
|---|---|
| Purpose | Live wallpaper: an AoE2 map grows around the desktop icons |
| Language | Rust 2024, edition 2024 |
| GUI/rendering | GPUI 0.2 + DirectX 11 |
| Platform | Windows 10/11, native only |
| License | MIT (compatible with our GPL-3.0) |
| Size | 7,382 lines of Rust in 13 modules |
| Themes | 10 |
| Creation date | 10.11.2026 |
| Activity | 7 commits in 3 days, 1 open issue |

### 1.1. Structure

| File | Lines | Purpose |
|---|---:|---|
| `scene.rs` | 1,399 | Map generation for the icons, all 10 themes |
| `app.rs` | 1,199 | The wallpaper window, settings, tick loop |
| `battle.rs` | 1,076 | Icon Wars: the army, icon health, the final castle |
| `actors.rs` | 851 | Animated units, pathfinding |
| `iconfx.rs` | 662 | Icon damage in overlays |
| `desktop.rs` | 424 | Win32: the window under the icons, reading icons, pausing |
| `assets.rs` | 402 | Locating the game, loading sprites and textures |
| `main.rs` | 362 | Entry point, CLI, single instance |
| `overlay.rs` | 318 | Click-through windows above the icons |
| `tray.rs` | 190 | The notification area icon |
| `aoe/` | 361 | SLD, SMP, DDS, BC1/BC4 decoders |
| `noise.rs` | 68 | Noise and PRNG |

### 1.2. The licensing picture

The code is MIT, which means it can be included in a GPL-3.0 project while keeping the attribution notice.

The art is **not MIT**. The sprites and textures belong to Microsoft, and Wololand does not distribute them: it reads `.sld` and `.dds` from an installed copy of the game at runtime. For us this means that "AoE2 themes in Mintland" would require an installed AoE2 DE, that is, a paid game as a dependency of the wallpaper.

Wololand's settings use the art of the game's own menu (parchment, red buttons). That cannot be copied under any code license.

---

## 2. The main idea: baking the scene

### 2.1. How it works for them

From the README:

> The map is baked into a single texture, so each frame only redraws the water and a handful of animated units.

From `scene.rs`:

> The icon rectangles become a signed distance field (negative inside an icon cluster). Each theme turns that field plus some noise into terrain layers and object placement, all baked into one RGBA image on a background thread. Only that image and a handful of animated sprites are drawn per frame, which keeps the wallpaper cheap to run.

Three levels of cost:

| Work | When it happens | Cost |
|---|---|---|
| Baking the map | When the icons, the theme, or the window size change | 200–300 ms on a background thread |
| Blitting the texture + water + sprites | Every frame | fractions of a millisecond |
| Recomputing the distance field | Inside the baking | the main share |

The result according to the README: **3–4% of one core at 15 fps on 1920×1080**, ~140 MB of memory.

### 2.2. How it is arranged for us

`flat.html` and `meadow.html` compute the whole scene in a WebGL shader **every frame**. The distance field to the icons (`computeField`) is recomputed only on changes, but everything else — water, shore, sand, foam, gradients — is drawn anew 30 times per second.

`night.html` draws with canvas 2D: the static sky is cached in a separate canvas, the glow in a downscaled buffer updated once every 140 ms, halos and fog — every frame.

Measurements on this machine (2560×1440, live layer, the sum of `themehost.py` + `WebKitWebProcess`):

| Theme | One core | Share of 20 threads |
|---|---:|---:|
| Beach (`flat.html`) | 41.4% | ~2.1% |
| Night (`night.html`) | 49.7% | ~2.5% |
| Meadow (`meadow.html`) | 62.2% | ~3.1% |

Comparing with their "3–4%" directly is not possible: they are at 1920×1080 at 15 fps, we are at 2560×1440 at 30 fps. Recalculated to equal conditions:

- we have 1.78 times more pixels;
- 2 times more frames;
- in total ~3.6 times more work.

Their 3–4% × 3.6 ≈ **13% of one core**. We have 41–62%. The gap is **3–5 times**, and it is not in a "heavy shader", but in the fact that we redraw what does not change.

### 2.3. What this means

The scene changes only when:

- the user drags an icon;
- a file is added to or removed from the desktop;
- the theme is switched;
- the parameters from `switcher.py` change;
- the screen size changes.

The rest of the time it is a static picture plus a few moving objects. Recomputing it 30 times per second is waste, not design.

---

## 3. The second idea: a theme as a preset

### 3.1. For them

All ten themes are described in a single `scene.rs`. A theme is a set of tables:

```rust
fn textures(self) -> &'static [&'static str] {
    match self {
        Theme::Arabia | Theme::GoldRush => &["g_gr3", "g_gr7", "g_gr4", "g_for", "g_des"],
        Theme::Arena | Theme::Hideout => &["g_gr2", "g_gr6", "g_fo2", "g_gr4", "g_grs"],
        Theme::BlackForest | Theme::ForestNothing => &["g_for", "g_fo2", "g_grs", "g_r01", "g_underbrush_leaves"],
        Theme::Islands => &["g_gr2", "g_gr6", "g_bch", "g_sh2"],
        // …
    }
}

fn sprites(self) -> Vec<&'static str> { /* the same thing */ }
```

Plus a few branches in the shared functions:

```rust
fn forest(&self, d: f32, n1: f32, n2: f32) -> f32 {
    match self.kit.theme {
        Theme::Arabia | Theme::Nomad => smoothstep(0.635, 0.66, n2) * smoothstep(140.0 * ds, 200.0 * ds, d),
        Theme::Arena | Theme::Hideout => { /* a ring of forest behind the walls */ }
        Theme::BlackForest => { /* solid forest with clearings */ }
        Theme::ForestNothing => smoothstep(22.0 * ds, 52.0 * ds, d + (n1 - 0.5) * 40.0 * ds),
        // …
    }
}
```

Adding a theme is a line in `enum Theme`, a line in `ALL`, two tables and one branch. Ten themes in 1,399 lines: **~140 lines per theme**, including the shared engine.

### 3.2. For us

| Theme | File | Lines |
|---|---|---:|
| Beach | `flat.html` + `beach-palms.js` | 1,292 + 159 |
| Meadow | `meadow.html` + `meadow-boy.js` + `meadow-cat.js` | 1,141 + 531 + 101 |
| Night | `night.html` | 579 |

Three themes in 3,803 lines: **~1,270 lines per theme**. Each is a self-contained program with its own rendering, its own protocol and its own handling of `pause`.

This is not a mistake in itself: a standalone page is simpler for the author of a single theme and does not require a shared engine. But it has a price:

- three implementations of the protocol → three places where `pause` can be forgotten;
- three implementations of `devicePixelRatio` → three different behaviors on HiDPI (see `IMPROVEMENTS.md`, §1);
- three implementations of `__renderAt` → `tools/capture-theme.py` works only with `night.html`;
- a new theme = a new file of a thousand lines, not a set of tables.

`night.html` indirectly confirms this: it is 2.2 times shorter than `flat.html` because it is simpler by design, not because the architecture is better.

### 3.3. What follows from this

Not "rewrite everything on a shared engine" — that would destroy what already works. But record in `THEMES.md` two levels of a theme:

| Level | What it is | When to choose it |
|---|---|---|
| **Lightweight theme** | A separate page according to the contract | Something fundamentally different: canvas 2D, different mechanics |
| **Preset theme** | A parameter table over the shared engine | Another variation of an already existing scene |

Beach and Maldives in `themes.json` are literally one scene with different palettes. Right now, for the second one, 1,292 lines would have to be copied.

---

## 4. The third idea: discipline towards the user

This is a set of small things, each of which is unnoticeable on its own, but together they give the feeling that "the program does not get in the way".

### 4.1. RNG streams per purpose

```rust
// One random stream per purpose: adding or moving an icon then only changes what is near it,
// instead of shifting every random choice made after it (islands, piles, buildings...).
let stream = |k: u64| Rng::new(seed ^ k.wrapping_mul(0x9e37_79b9_7f4a_7c15));
```

For us `seed` is global: `flat.html` uses it both for the field noise and for the palms and for the kayaks. Move an icon — potentially everything changed.

### 4.2. Debouncing rebuilds

```rust
if self.read_icons() {
    self.build_due = Some(now + Duration::from_millis(700));
}
```

The comment explains: dragging an icon or writing a file changes the layout dozens of times in a row; you need to rebuild once, when everything settles down.

For us `themehost.py` sends a new layout immediately, and the page immediately calls `commit()` → `computeField()`. Measurement: **28.9 ms** to recompute the field with 11 icons. With a frame budget of 33 ms this is a noticeable hitch, and while dragging it repeats many times.

### 4.3. Priority

```rust
// A wallpaper should never compete with apps.
SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
// for the build thread:
SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
```

We have neither `nice` nor `ionice`. The scene competes with applications on equal terms.

### 4.4. Pausing by coverage area

```rust
let covers = r.left <= s.left && r.top <= s.top && r.right >= s.right && r.bottom >= s.bottom;
// a window covering nearly all of the screen hides the wallpaper too
let covers = covers || iw * ih * 100 >= area * 92;
```

Plus a check of `DWMWA_CLOAKED` — a window may be "visible" but actually hidden by the compositor.

Our `_should_pause()` requires specifically `_NET_WM_STATE_MAXIMIZED` or `_NET_WM_STATE_FULLSCREEN`. A window stretched manually to almost the whole screen will not trigger the pause.

### 4.5. A log with rotation

```rust
if std::fs::metadata(&path).is_ok_and(|m| m.len() > 256 * 1024) {
    let _ = std::fs::remove_file(&path);
}
```

Once every 10 minutes a line about memory, handles and GDI objects is written to the log — so that a leak is visible on a long run.

Our `run/wall.log` grows without limit and contains only debug messages.

### 4.6. Recovery after a shell crash

If Explorer restarted, Wololand reattaches in ~2 seconds: `attachment_state()` distinguishes "the window was destroyed" from "the window detached", and the calling code decides whether to recreate or reattach.

Our `wall-on.sh` and `wall-off.sh` restart `nemo-desktop`, but if `nemo-desktop` crashes by itself while the layer is running, nobody will notice.

---

## 5. What transfers and what does not

### 5.1. Transfers

| Idea | Where it is for them | How for us |
|---|---|---|
| Baking the scene into a texture | `scene.rs`, `app.rs` | Frame cache in `themehost.py` or in the page |
| A theme as a preset | `scene.rs` | Theme levels in `THEMES.md` |
| RNG streams per purpose | `build()` | `seed ^ salt` for each task |
| Debouncing rebuilds | `app.rs` | A delay in `themehost.py` before sending `icons` |
| Lowering priority | `desktop.rs` | `os.nice()` + `ionice` |
| Pausing by area | `desktop.rs` | Checking the geometry of the active window |
| Log rotation | `main.rs` | `run/wall.log` |
| Health log | `desktop.rs` | Once every 10 minutes into the same log |
| Field isolines | `contour_lines()`, `lay_wall()` | A new class of themes: walls, fences, embankments |

### 5.2. Does not transfer

| Module | Lines | Reason |
|---|---:|---|
| `desktop.rs` | 424 | `Progman`, `WorkerW`, `SHELLDLL_DefView`, reading `explorer.exe` memory |
| `overlay.rs` | 318 | `UpdateLayeredWindow`, `WS_EX_TRANSPARENT`, `HTTRANSPARENT` |
| `iconfx.rs` | 662 | Layered windows above the icons, screenshots of icons |
| `tray.rs` | 190 | `Shell_NotifyIcon` |
| `aoe/` | 361 | SLD/DDS decoders — they exist only for the sake of AoE2 art |

A total of 1,955 lines out of 7,382 — that is Win32 and parsing game formats.

### 5.3. Separately: how they read icons

```rust
OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, false, pid)
WriteProcessMemory(...)   // we put a RECT structure into someone else's process
SendMessageW(list, LVM_GETITEMRECT, ...)
ReadProcessMemory(...)    // we take the result back
```

This is reading the memory of someone else's process (`explorer.exe`). It works, but it requires privileges and looks crude.

Our `iconsource.py` reads gvfs metadata (`metadata::nemo-icon-position`) and `~/.config/nemo/desktop-metadata` — without accessing someone else's memory. This is **not worse**, it is more honest.

### 5.4. A curious detail

`overlay.rs` solves the task "draw on top of an icon but do not intercept clicks" via `WM_NCHITTEST → HTTRANSPARENT`. This is exactly our "Step 9: front click-through layer" from the roadmap. We have `input_shape_combine_region` in `themehost.py`, so the technique is familiar — but the confirmation that the approach works is useful.

---

## 6. What they taught us through their mistakes

In the comments you can see several places where the authors clearly stepped on a rake and wrote down the conclusion:

**"Do not move all WorkerWs on every event"**

```rust
// Only move the ones that are above: pushing each one to the very bottom on every call would
// make several WorkerWs swap places forever, each move firing another reorder event in Explorer.
```

A classic feedback loop: your own action generates an event that requires the same action. We have an analogous risk in `_raise_nemo()`, which is called twice after the page loads.

**"Remember that a screenshot failed"**

```rust
/// Failed screenshots, so a covered icon is not retried every frame.
tries: u32,
retry_at: f32,
```

If an operation can fail consistently, it must not be repeated every frame — backoff is needed.

**"Rate-limiting fixes"**

```rust
// Explorer fires these for every window it creates or moves; at most one fix per 50 ms
// (the 400 ms poll catches anything skipped).
```

A fast event handler + slow polling as a safety net. This is exactly the scheme we have in `poll_icons` (2 s) and which we lack for reacting to dragging.

---

## 7. Where Wololand is weaker than us

So that the picture is not one-sided.

| Aspect | Wololand | Mintland |
|---|---|---|
| Dependency on a paid game | Mandatory | None |
| Platform | Windows only | Linux/X11 (Wayland planned) |
| Reading icons | Via someone else's process memory | Via gvfs metadata |
| Transparency of operation | A binary without source documentation of the protocol | `THEMES.md` with a contract |
| Tools for theme authors | CLI `render`/`simulate`/`montage` | `capture`/`test`/`preview`/`bench` |
| Art license | Indeterminate (Microsoft art) | GPL-3.0 for everything except Deskland assets |

Their CLI tools, by the way, are more interesting than ours by design: `render <theme> <out.png>` draws the scene offline around sample icons, `simulate <theme> [seconds]` runs the units headless and prints what they are doing. Our `preview-frame.py` does the first, but we do not have the second (running the animation without a screen).

---

## 8. Conclusion

**What to take first:** baking the scene. This is the only change that gives a gain in times, not in percent.

**What to take along the way:** RNG streams, debouncing, priority, pausing by area, log rotation. Each is a small edit; together they are a noticeable change in the character of the program.

**What to take as a direction:** a preset theme next to a page theme. Not rewriting what exists, but not spawning copies in the future.

**What not to take:** Win32, GPUI, DDS/SLD, AoE2 as a dependency, the game's menu art.

**The main conclusion that hits our `THEMES.md`:** we declared a theme to be a separate page of a thousand lines. This works for three themes. For ten — it does not work. Wololand gets ten themes out of 1,399 lines precisely because for them a theme is data, not a program.

---

## 9. Links

- [Wololand repository](https://github.com/gregstein/wololand)
- [Project page](https://ageofnotes.com/wololand/)
- [`src/scene.rs`](https://github.com/gregstein/wololand/blob/main/src/scene.rs) — map generation and all the themes
- [`src/app.rs`](https://github.com/gregstein/wololand/blob/main/src/app.rs) — tick loop, debouncing, pausing
- [`src/desktop.rs`](https://github.com/gregstein/wololand/blob/main/src/desktop.rs) — Win32 glue
- [`src/noise.rs`](https://github.com/gregstein/wololand/blob/main/src/noise.rs) — noise and PRNG (the only module transferable as is)
- Our documents: [`THEMES.md`](THEMES.md), [`WAYLAND.md`](WAYLAND.md), [`IMPROVEMENTS.md`](IMPROVEMENTS.md)
