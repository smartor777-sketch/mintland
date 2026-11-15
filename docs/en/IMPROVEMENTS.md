# Mintland: what to improve right now

> **Document:** a list of concrete improvements following the analysis of [Wololand](WOLOLAND.md).
> **Date:** 14.11.2026, updated 15.11.2026.
> **Marks:** ✅ — done and verified; 🟡 — the mechanism exists, but the task is not closed;
> ⬜ — not started; ⛔ — cancelled, the reason is in the text of the item.
> **Status:** 10 of 14 done, §9 cancelled in favour of §14 (variants inside a
> card), §15 (English) is complete. Not started: §8 (baking), §16 (.deb),
> §17 (maps).
> **Selection principle:** only what can be done without rewriting the architecture and gives a measurable effect.
> **How to read:** the items are ordered by the "gain / risk" ratio. Start at the top.
> **Paths:** all paths in the document are from the repository root, not from `docs/`.

---

## 0. Summary

| № | What | Effect | Status |
|---|---|---|---|
| 1 | Cap the render resolution in Meadow | −2× CPU on Meadow | ✅ done |
| 2 | Debounce rebuilds while dragging icons | removes the stutter | ✅ done |
| 3 | `nice` + `ionice` for the layer | does not compete with applications | ✅ done |
| 4 | Pause by coverage area | closes a hole in auto-pause | ✅ done |
| 5 | RNG streams by purpose | stable partial regeneration | ✅ done |
| 6 | Log rotation + health line | leaks become visible, the log does not grow | ✅ done |
| 7 | `__renderAt`/`__inject` hooks in Beach and Meadow | the tools work on all themes | ✅ done |
| 8 | Baking the static part of the scene | −3…5× CPU on all themes | ⬜ not started |
| 9 | Theme preset next to the theme page | new themes are many times cheaper | ⛔ cancelled in favour of §11 |
| 10 | Watching the liveness of `nemo-desktop` | icons do not disappear silently | ✅ done |
| 11 | Variants inside the theme card | the list does not grow with presets | ✅ done (Night) |
| 12 | English interface and documentation | the program is available outside Russia | ✅ done |
| 13 | Building a `.deb` | installation in two clicks | ⬜ not started |
| 14 | Maps: one engine, four themes | one more class of scenes | ⬜ not started |

Stages 1 and 2 are fully closed: Meadow is no longer the most expensive, the tools
work on all three themes, auto-pause has no holes, the log does not grow.

Separately, beyond this plan, the reason why the icons disappeared under the scene
at all was analysed (the Muffin stack, not X11) — see
[`OCCLUSION.md`](OCCLUSION.md). That was not an optimisation but a bug fix:
there were no icons at all.

---

## 1. ✅ Cap the render resolution in Meadow

**This is the cheapest gain of all the ones found.**

### Problem

Beach and Meadow compute the canvas scale differently.

`prototype/flat.html`:

```js
const scale = PREVIEW ? 0.45 : Math.min(devicePixelRatio || 1, P.quality, 0.75);
```

`prototype/meadow.html`:

```js
const scale = PREVIEW ? 0.45 : Math.min(devicePixelRatio || 1, P.quality);
```

The difference is the third term, `0.75`. On this machine `devicePixelRatio = 2`, `P.quality = 2`, therefore:

| Theme | Scale | Canvas | Pixels |
|---|---:|---|---:|
| Beach | 0.75 | 1920×1080 | 2.07 M |
| Meadow | 2.0 | 5120×2880 | 14.75 M |

**Meadow draws 7.1 times more pixels than Beach.**

### Measurement

The scene's internal benchmark (`window.__dbg.bench()`, median of 10 frames, offscreen 2560×1440):

```text
flat.html            frame 10 ms   canvas 1920×1080
meadow.html          frame 48 ms   canvas 5120×2880
meadow.html + 0.75   frame 24 ms   canvas 1920×1080
```

A live measurement of the layer (the sum of `themehost.py` + `WebKitWebProcess`, 12 s):

| Theme | One core |
|---|---:|
| Beach | 41.4% |
| Night | 49.7% |
| Meadow | **62.2%** |

### Fix

Move the cap from `flat.html` into `meadow.html`:

```js
const scale = PREVIEW ? 0.45 : Math.min(devicePixelRatio || 1, P.quality, 0.75);
```

### Expected effect

Frame: 48 → 24 ms. Live CPU: roughly 62% → 45%.

The difference in quality is invisible: the scene is a blurred background under the icons, small details in the clouds and grass are indistinguishable to the eye, and WebKit scales the canvas to the full screen anyway.

### Remark

The same cap is worth applying in `night.html` — it is already there (`dpr` is capped at one), but for a different reason. It is worth unifying the wording in all three files and mentioning it in `THEMES.md` as a requirement for a new theme, not as a personal finding.

---

## 2. ✅ Debounce rebuilds while dragging icons

### Problem

`themehost.py` polls the icons once every 2 seconds and on any change immediately sends them to the page:

```python
if payload != self.last_icons:
    self.last_icons = payload
    self.send(payload)
```

The page immediately calls `commit()` in response, which recomputes the distance field:

```js
function commit(fromEmpty = false) {
  const nf = computeField(iconRects());
  // …
}
```

### Measurement

`computeField()` with 11 icons at 2560×1440, grid step 5 px, 149 060 nodes:

```text
28.9 ms per call
```

The frame budget at 30 fps is 33 ms. That is, one recomputation is almost a whole frame thrown away entirely.

When dragging an icon, `gio` updates the position many times in a row, and each time that is another 29 ms. Hence the stutter during drag&drop.

### How Wololand solved this

```rust
// Debounce: a file being written to the desktop, or icons being dragged, changes the
// layout many times in a row; build once it settles instead of on every change.
if self.read_icons() {
    self.build_due = Some(now + Duration::from_millis(700));
}
```

### Fix

In `themehost.py`: do not send immediately, but set up a deferred send.

```python
def poll_icons(self):
    rects = iconsource.collect()
    payload = ...
    if payload == self.last_icons:
        return True
    self.last_icons = payload
    if self._icons_timer is not None:
        GLib.source_remove(self._icons_timer)
    self._icons_timer = GLib.timeout_add(700, self._flush_icons)
    return True

def _flush_icons(self):
    self._icons_timer = None
    self.send(self.last_icons)
    return False
```

Separately: when the theme changes and on the first `ready`, the delay must be bypassed — there an immediate reaction matters.

### Expected effect

On a quiet desktop — nothing changes (there are no events). While dragging — one rebuild instead of a dozen. Subjectively this is the most noticeable improvement on the list.

---

## 3. ✅ Lower the priority of the layer

### Problem

The scene competes with applications on equal terms. If the user starts a build or a game, WebKit will take time slices away from it.

### Check

```bash
grep -rn "nice\|ionice\|setpriority" *.py *.sh
# (nothing)
```

### How Wololand solved this

```rust
// A wallpaper should never compete with apps.
SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
// and for the build thread:
SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
```

### Fix

In `themehost.py`, right after start:

```python
import os
try:
    os.nice(10)          # CPU: we yield to everyone
except Exception:
    pass
```

In `start-layer.sh` — lower the I/O priority at the same time:

```bash
setsid ionice -c3 nice -n 10 python3 "$DIR/themehost.py" ... &
```

`ionice -c3` — the idle class, the disk is touched only when it is free.

### Expected effect

At idle — zero. Under load — the scene yields instead of splitting evenly. This is exactly the behaviour you expect from a wallpaper.

### Risk

With too aggressive a `nice`, the scene may "think" when redrawing on a weak machine. `-n 10` is a safe middle; if there are problems, roll back to `-n 5`.

---

## 4. ✅ Pause by coverage area

### Problem

`themehost.py` pauses the scene only on `_NET_WM_STATE_MAXIMIZED_HORZ + _NET_WM_STATE_MAXIMIZED_VERT` or `_NET_WM_STATE_FULLSCREEN`.

A window stretched by hand to 95% of the screen does not trigger the pause — the scene keeps grinding CPU under an almost invisible desktop.

### How Wololand solved this

```rust
let covers = r.left <= s.left && r.top <= s.top && r.right >= s.right && r.bottom >= s.bottom;
// a window covering nearly all of the screen hides the wallpaper too
let covers = covers || iw * ih * 100 >= area * 92;
let on_primary = cx >= s.left && cx < s.right && cy >= s.top && cy < s.bottom;
on_primary && (covers || IsZoomed(fg))
```

Plus a check for `DWMWA_CLOAKED` — a window may be "visible" but hidden by the compositor.

### Fix

In `_should_pause()` add a geometric check via `xwininfo`:

```python
geom = subprocess.run(["xwininfo", "-id", wid], capture_output=True, text=True).stdout
# Width: 2560  Height: 1440  Absolute upper-left X: 0  ...
```

Compute the intersection with the monitor geometry and enable the pause when coverage is ≥ 92%. The 92% threshold was taken from Wololand not out of religion: it leaves a margin for the dock, the taskbar and shadows, so that an ordinary "almost full screen" window is not counted as fullscreen.

### Expected effect

Closes a real hole. On this machine the pause triggers only on true fullscreen; manual stretching — no.

### Cost

One additional `xwininfo` call (1.7 ms) once a second, and only when the window is already maximized/fullscreen — that is, almost never.

---

## 5. ✅ RNG streams by purpose

### Problem

`seed` in `flat.html` is one for everything:

```js
let seed = (Math.random() * 1e6) | 0;
```

It is used both for the field noise (`buildNoise`), and for the positions of the palms, and for the kayaks, and for the seagulls. Any change that shifts the order of calls changes the whole scene — even if only one icon changed.

### How Wololand solved this

```rust
// One random stream per purpose: adding or moving an icon then only changes what is near it,
// instead of shifting every random choice made after it (islands, piles, buildings...).
let stream = |k: u64| Rng::new(seed ^ k.wrapping_mul(0x9e37_79b9_7f4a_7c15));
// then: stream(1) for the islands, stream(2) for the trees, …
```

### Fix

Set up several independent PRNGs in the page:

```js
const rng = (salt) => mulberry32((seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0);
const rngPalms = rng(1), rngKayaks = rng(2), rngBirds = rng(3);
```

### Done (15.11.2026)

The measurements confirmed the problem and revealed two different mechanisms:

**Beach, palms.** In `beach-palms.js` the position of a tree was chosen by reservoir
sampling (`if (random() < 1 / ++candidates)`). The number of PRNG calls depended
on how many candidates passed the check, and the check depends on the icons —
shifting one icon rearranged all the trees. Replaced by a choice by point
weight: `palmWeight(x, y, salt)` — a hash of the coordinates and the seed. The
weight of a point does not depend on the traversal order.

Check: the palms `[[461,236],[567,275]]` stayed in place when
an icon was added and removed in another corner of the screen.

**Meadow, clouds.** `makeSkyCloud()` used `Math.random`, so
every recreation gave a different shape. The clouds with the same layout
came out as `[629,264] → [122,293] → [556,269]`. Now the shape is derived from
`mulberry32` with a seed from the cloud's position and the global seed:
`(seed ^ 0x5c10d) + Math.imul(x, 2654435761)`.

Check: `[[756,168],[229,626],[1249,483]]` did not change between three
runs.

**What needed no changes.** In `night.html` the streams were already separate
(four independent `mulberry32`). The beach kayaks and seagulls are also stable:
their initial positions are taken from `Math.random` once at spawn, and are not
recomputed on every icon change.

### Expected effect

Now: moved an icon → the whole map was regenerated. After: only what is next to the icon changed.

This is not about CPU, it is about perception: the user drags a shortcut and does not expect the desert to move somewhere else.

### Risk

Medium: the change touches the order of calls in several places. It is necessary to check that after it the scene looks the same with the same seed.

---

## 6. ✅ Log rotation and the health line

### Problem

`run/wall.log` grows without limit (right now 4 261 bytes, but over weeks of operation that is megabytes). It contains only debug messages, from which one cannot tell whether memory is leaking.

### How Wololand solved this

```rust
if std::fs::metadata(&path).is_ok_and(|m| m.len() > 256 * 1024) {
    let _ = std::fs::remove_file(&path);
}
```

Once every 10 minutes:

```rust
format!("health: private {} MB, working set {} MB, handles {handles}, gdi {gdi}, user {user}", …)
```

### Fix

In `themehost.py`:

```python
def _rotate_log(self):
    try:
        if (RUN / "wall.log").stat().st_size > 256 * 1024:
            (RUN / "wall.log").unlink()
    except Exception:
        pass
```

Once every 10 minutes write a line:

```text
health: rss 167 MB, threads 8, uptime 3h12m
```

RSS is taken from `/proc/self/status` (`VmRSS`).

### Expected effect

The log does not grow. It becomes possible to notice a leak over a long run instead of guessing.

### Remark

Our total RSS right now is **~530 MB** (166 `themehost` + 301 `WebKitWebProcess` + 50 `WebKitNetworkProcess`). Wololand's, according to the README, is ~140 MB. Part of the difference is the unavoidable price of WebKit, but 301 MB in the web process with a single static scene looks inflated. The health log will show whether they grow over time.

---

## 7. ✅ `__renderAt` and `__inject` hooks in Beach and Meadow

### Problem

`tools/capture-theme.py`, `tools/test-theme.py` and `tools/bench-theme.py` require two things from a page:

- `?freeze=1` — do not start `requestAnimationFrame`;
- `window.__renderAt(t)` — draw a frame at the moment `t`;
- `window.__inject(msg)` — deliver a host message (for the tests).

This exists only in `night.html`. For Beach and Meadow the tools print `SKIP`.

### Consequence

- the GIF previews for Beach and Meadow were recorded by hand and are not reproducible;
- the contract of these themes is not checked automatically;
- the effects benchmark does not apply to them.

### Fix

Add three lines to `flat.html` and `meadow.html`:

```js
window.__renderAt = function (t) { draw(t); };
window.__inject = handle;   // the name of the handler function differs in each theme
```

And at the end of initialisation:

```js
if (QS.has('freeze')) { draw(performance.now()); } else { scheduleFrame(); }
```

### Expected effect

The tools start working on all three themes. This is not performance, it is process quality: any new theme is immediately checkable.

---

## 8. ⬜ Baking the static part of the scene

**The main item in terms of effect. And the riskiest.**

### Problem

`flat.html` and `meadow.html` compute a full-screen shader every frame. Between frames only the following change:

- the water (waves, glints);
- the units (the palms sway, the kayaks float, the seagulls fly, the boy runs);
- the morphing of the shore when the icons change.

Everything else — the shore, the sand, the wet sand, the grass, the cloud shadows — is static.

### Estimating the gap

Recalculated to equal conditions with Wololand (their 3–4% at 1920×1080/15 fps, our 41–62% at 2560×1440/30 fps):

| | Wololand | Mintland |
|---|---:|---:|
| Pixels | 2.07 M | 3.69 M |
| Frames/s | 15 | 30 |
| Relative work | 1.0 | 3.6 |
| Declared CPU | 3–4% | 41–62% |
| Recounted to their conditions | 3–4% | **11–17%** |

The gap is **3–5 times**. It is not in the shader — it is in the fact that we redraw what does not change.

### Possible solution

A two-layer scheme:

1. **Static layer.** The shore, the sand, the grass, the static shadows — baked into a texture when the icons/parameters change. For Beach this almost exists already: `computeField()` produces the field, `uploadField()` uploads it into a texture. What remains is to bake the shader result as well.
2. **Live layer.** The water, the units, the morphing — drawn every frame on top.

The morphing of the shore is a separate complication: when dragging an icon the static layer must be recomputed, but this happens rarely and precisely allows a pause of one or two frames.

### Expected effect

By analogy with Wololand — a drop from 41–62% to about 10–20% of one core. It is impossible to predict more precisely without a prototype.

### Risk

High:

- the WebGL scene stops being "a single shader", a second texture and its invalidation logic appear;
- with HiDPI and on window resize the texture must be recreated;
- `night.html` on canvas 2D already does something similar (a sky cache), but Beach and Meadow do not.

That is why this is a separate piece of work of 2–4 days, not an evening's edit. Start with a prototype on `flat.html`, measure, and only then decide.

### What to do before it

Items 1–7. They are cheaper, safer and already give a noticeable result. If after them the CPU is acceptable — item 8 can be postponed.

---

## 9. ⛔ Theme preset next to the theme page

### Problem

Right now a theme is a separate HTML page. The three themes take 3 212 lines, that is ~1 071 lines per theme. Each one reimplements the protocol, the handling of `devicePixelRatio` and the handling of `pause`.

At the same time `themes.json` already holds 11 "locked" themes from Deskland, at least four of which are variations of existing scenes (Maldives is Beach with a different palette).

If they were added by copying, the result would be about 15 thousand lines of almost
identical code.

### How Wololand is structured

Ten themes — one `scene.rs` of 1 399 lines. A theme is set by tables of textures and sprites plus a couple of branches in shared functions.

### Proposal

Not to rewrite what exists, but to introduce two levels and fix them in `THEMES.md`:

| Level | What | When |
|---|---|---|
| **Theme page** | A separate HTML according to the contract | A fundamentally different mechanic (canvas 2D like `night.html`) |
| **Theme preset** | A table of parameters over a shared scene | A variation of an existing one: palette, density, set of objects |

The minimal option: move the palette and the set of elements in `flat.html` into a preset object, and make one page for several `id`s. Then Maldives is `flat.html?preset=maldives`, not a copy of the file.

### An adjacent direction

It is worth keeping in mind separately [`PAPER.md`](PAPER.md): the object family of themes
("a map on paper") is designed from the start as one engine plus tables of
parameters. If it goes into work, it will become that shared engine
this item talks about — and it must be started from a clean page, not by
rewriting Beach.

### What presets do NOT give: they do not speed up loading

This is worth fixing separately, because a wrong conclusion suggests itself.
Measurements on this machine (2560×1440, offscreen):

| What | Time |
|---|---:|
| Cold start of a theme (first load) | **869 ms** |
| Switching a theme now (page reload) | 236–453 ms |
| Changing parameters in a live page (as with presets) | **1–19 ms** |

From this the main point is visible: **presets do not speed up a cold start**. 869 ms is
WebKit starting the process, creating the WebGL context and compiling the shaders.
No matter how many themes are described by tables, the first launch will stay the same.

Presets speed up only **switching between already loaded themes**, and the fact
that there is a 20–200-fold difference there means little in practice: a theme is changed
once a day, not every minute. If a fast cold start is ever needed — that is a separate
task (page cache, preloading in the background), and presets do not solve
it.

### Why presets then: scaling

The only, but decisive reason is the cost of the **next** theme.

| | Value |
|---|---|
| Three themes now | 3 212 lines |
| On average per theme | ~1 071 lines |
| "Locked" themes in the registry | 11 |
| If each is made as a copy | **~14 993 lines** |

Fifteen thousand lines in which the protocol, `devicePixelRatio` and the handling of
`pause` are repeated eleven times. A mistake in one place is not fixed in
the other ten.

Presets turn a new theme from "copy a thousand lines" into "add twenty
lines of a table". It is not about seconds, but about whether ten themes remain
a dream or become a week of work.

### Done: the mechanism exists, but no presets were added

The first level was implemented — the palette was moved out of the shader into uniforms, a
`PALETTES` table was added to `flat.html` and two ways to choose a preset: the `?preset=…` parameter
in the page address and the `palette` field in the theme parameters, which
`switcher.py` takes from `preset` in `themes.json`. Switching a preset does not
reload the page: the log has one `loading file` entry instead of two.

Verified by measuring the average colour of the sea on the same frame:
`beach` — `#0292bd`, `maldives` — `#12b4c1`, `lagoon` — `#0d519a`.

Verified that **the look of Beach has not changed**: `beach` is the previous colours,
simply moved into a table.

But when I added two preset themes (Maldives and Lagoon), it turned out that
they **look like Beach**. The measurement confirmed it: only the colours differ.

| | Beach | Maldives | Lagoon |
|---|---|---|---|
| water in the distance | `#008fba` | `#12b2bf` | `#0d4f99` |
| dry sand | `#f7ede0` | `#fcf7eb` | `#edebe3` |
| sand difference from Beach | — | 12/441 | **11/441** |

The difference in the sand is about 3%, which is indistinguishable. Even after adding different
geometric parameters (Maldives has a wider shoal, Lagoon has a more indented shore)
the silhouette stays the same: the same shoreline, the same palms, the same kayaks.

Therefore both themes were removed from the list. The registry has three themes again, and that is more honest
than five cards, three of which are the same beach in different colours.

**Conclusion for future preset themes:** a palette is not enough. For a variation to
read as a separate theme, it must change **form**: the shoreline silhouette,
the set of objects, the composition. Otherwise it is not a theme but a colour scheme.

### How it all ended: the mechanism was cancelled

Later it turned out that this is not a solution either. A preset as **a separate entry in the
registry** stands next to the original theme: `switcher.py` draws a card
for each ready entry, there is no nesting. Five cards, two of which are
variants of the neighbouring ones, are worse than three honest ones.

Therefore the mechanism was replaced by **variants inside the card** (§11 in this plan,
§14 in `THEMES.md`): one card, a switcher inside it, the theme list does not
grow. The `preset` field was removed from the registry, `switcher.py` no longer reads it.

The useful part of the first stage remained: **the palette moved out of the shader into
uniforms**. Now it lives in the `VARIANTS` table of each theme — the same in all three,
including Meadow, where the colours used to be hard-coded as constants.

### Expected effect

A new variation of an existing theme — not 1 000 lines, but 20. This changes the economics: ten themes become a real goal, not a dream.

### Risk

Medium: it touches `themes.json`, `switcher.py` and the pages themselves. Do it after item 8 settles down, not at the same time as it.

---

## 10. ✅ Watching the liveness of `nemo-desktop`

### Problem

The layer works only if `nemo-desktop` is alive and holds the desktop role. `wall-on.sh` checks this at startup:

```bash
if ! pgrep -x nemo-desktop >/dev/null; then
    say "nemo-desktop is not running — icons are not drawn."
```

But if `nemo-desktop` crashes **after** the layer is enabled, nobody notices: the scene keeps running, but there are no icons. The user sees beautiful wallpaper without shortcuts and does not understand what happened.

### How Wololand solved this

```rust
pub enum AttachState {
    Ok,
    Gone,       // the window is destroyed (Explorer restarted)
    Detached,   // the window exists, but is no longer a child of the desktop
}
```

Once every 400 ms the state is checked, and on `Gone`/`Detached` the application re-attaches.

### Fix

In `themehost.py` once every 5 seconds:

```python
if not subprocess.run(["pgrep", "-x", "nemo-desktop"], capture_output=True).returncode == 0:
    self._log("nemo-desktop disappeared — icons are not drawn")
    # and a notification once, not every 5 seconds
```

Plus a flag so that `notify-send` does not spam.

### Expected effect

The user learns about the problem immediately and understands what to do, instead of looking for the cause.

---

## 11. Order of work

### Done

**Stage 1 — hygiene:**

1. ✅ Resolution cap in Meadow (§1) — frame 48 → 15 ms.
2. ✅ `nice`/`ionice` (§3) — verified: `ni=10`, class `idle`.
3. ✅ Log rotation and health (§6).
4. ✅ Hooks in Beach and Meadow (§7) — `test-theme.py` passes 6/6 on all themes.

**Stage 2 — behaviour:**

5. ✅ Debounce of rebuilds (§2).
6. ✅ Pause by area (§4).
7. ✅ Watching `nemo-desktop` (§10).

**Beyond the plan:** the overlap of icons by the Muffin stack was fixed and the
flicker when enabling the layer was removed — [`OCCLUSION.md`](OCCLUSION.md).

### Remaining

**Stage 3 — scene stability:**

8. ✅ RNG streams (§5) — the palms and clouds no longer move.

**Stage 4 — theme economics (3–5 days, medium risk):**

9. ⛔ Theme preset (§9) — **cancelled**. The mechanism was written and worked, but both
   preset themes (Maldives, Lagoon) turned out to be visual clones of Beach:
   only the colours differed. Replaced by variants inside the card (§11).
11. ✅ Variants inside the card (§14) — in all three themes. Night has two
   ("Polar", "Fireflies"), Beach and Meadow have one each so far — the mechanism
   is shared, varieties are added by a table.
   The preview in the card follows the variant; sliders that make no sense in the
   current variant are hidden.

**Stage 5 — performance (2–4 days, high risk):**

10. ⬜ Baking the static part of the scene (§8).

**Stage 6 — accessibility (3–5 days, low risk):**

12. ✅ English interface and documentation (§15).
13. ⬜ Building a `.deb` (§16).

**Stage 7 — new scenes (1–2 weeks, medium risk):**

14. ⬜ Map engine (§17).

### Why §9 comes before §8

In an earlier edition this document put baking (§8) before theme
presets (§9). That turned out to be the wrong order.

Baking is a rework of **how the scene is assembled**: the static part is
baked into a texture, the frame becomes a blit. Presets are a rework of
**how a theme is described**: a table of parameters instead of a separate page.

If baking is done first and presets after, `flat.html` would have to be
rewritten twice. It is more reasonable to first set up a shared engine (that is
§9), and build baking into it right away — it fits there, because
the assembly of the scene in that engine will already be a separate stage.

---

## 12. What to measure after each stage

So as not to argue about results by eye:

```bash
# the frame cost of a theme (offscreen, no window)
python3 tools/bench-theme.py prototype/night.html

# the live CPU of the layer
python3 - <<'PY'
import time, os
pids=[]
for q in os.listdir('/proc'):
    if not q.isdigit(): continue
    try: cmd=open('/proc/%s/cmdline'%q,'rb').read().replace(b'\0',b' ').decode()
    except Exception: continue
    if 'themehost.py --html' in cmd or 'WebKitWebProcess' in cmd: pids.append(int(q))
def snap():
    t=0
    for p in pids:
        f=open('/proc/%d/stat'%p).read().split(); t+=int(f[13])+int(f[14])
    return t
a=snap(); t0=time.time(); time.sleep(12); b=snap()
print('%.1f%% of one core' % ((b-a)/os.sysconf('SC_CLK_TCK')/(time.time()-t0)*100))
PY

# memory
for p in $(pgrep -f "themehost.py --html") $(pgrep -f WebKitWebProcess); do
    awk -v p=$p '/^VmRSS/{printf "%s: %d MB\n", p, $2/1024}' /proc/$p/status
done
```

**Current baseline** (2560×1440, X11, live layer):

| Theme | One core | RSS |
|---|---:|---:|
| Beach | 41.4% | ~530 MB |
| Meadow | 62.2% | ~530 MB |
| Night | 49.7% | ~530 MB |

Check the on/off cycle and the icons by the method from `THEMES.md`, §9 ("Live check"): a screenshot captures the topmost window, so run `wmctrl -k on` first.

---

## 13. What is deliberately absent from this list

- **AoE2 themes.** They require an installed paid game and Microsoft art. Not our case.
- **A port of the Win32 code.** `desktop.rs`, `overlay.rs`, `iconfx.rs` — 1 400 lines that are inapplicable on Linux.
- **A full rewrite onto a shared engine.** It would kill what works. Item 9 proposes coexistence, not replacement.
- **Our own renderer instead of WebKit.** That is a separate project of months; the current architecture gives an acceptable result and is already debugged.

---

## 14. ✅ A variant inside the card, not a separate theme

### Problem

The first two presets (Maldives, Lagoon) were made as separate entries in
`themes.json`. `switcher.py` builds the list like this:

```python
themes = [t for t in data["themes"] if t.get("status") == "ready"]
for theme in self.themes:
    self.theme_box.pack_start(self._make_theme_card(theme), ...)
```

Each ready entry is a separate card, there is no nesting. Therefore a preset
stood next to the original theme as an equal, and in a list of three themes there appeared
five cards, two of which were variants of the neighbouring ones.

### Solution

A variant lives **inside** the card. Two fields appear in the theme in the registry:

```json
"variants": [
  { "id": "polar", "name": "Полярная", "desc": "Сияние, луна и холодные холмы" },
  { "id": "fireflies", "name": "Светлячки", "desc": "Тёплый горизонт, рой светлячков над полем" }
],
"defaultVariant": "polar"
```

`theme_defaults()` adds `variant` to the theme parameters, `switcher.py`
draws the switcher as the first block in the parameters panel, and the page receives
`variant` with an ordinary `settings` message.

```
[ Beach ]   [ Meadow ]   [ Night ]
                        └ Variant: Polar | Fireflies
```

The theme list does not grow: three cards, as it was.

### How a variant differs from a set of sliders

This is the main point. If a variant is only different values of existing sliders,
the user will assemble it themselves, and the theme is not needed.

Therefore a variant sets what cannot be reached with sliders: **its own sky and its own
hills**. A `VARIANTS` table appeared in `night.html`:

| | Polar | Fireflies |
|---|---|---|
| sky at the horizon | `#173152` cold blue | `#5a4a34` warm olive |
| hills | blue rocky | greenish grassy |
| aurora | 0.7 | 0 |
| moon | present | absent |
| fireflies | 0 | 40 |

The sky is not a slider: the gradient is set only in the variants table, so
"Fireflies" cannot be reproduced by turning the settings.

### Fireflies

A new layer, ~60 lines. Each one lives in its own area above the hills and moves along a
closed curve: two sinusoids with incommensurable periods give a
non-repeating but smooth path. The brightness also breathes, each one with its own rhythm —
the swarm does not blink in time. They are drawn in `lighter` mode, between the mist and the
icon halos, so as not to obscure the labels.

The position is stored as fractions of the frame, so when the window size changes the swarm
is rebuilt and the dots stay in their places.

### Verified

- the switcher appeared: "Variant · Polar | Fireflies";
- a click on "Fireflies" changes `variant` in the state, writes it to
  `control.json`, and the page receives `fireflies`;
- "Polar" is rendered and matches the former Night;
- `test-theme.py` — 6/6 on all three themes.

### What remains

A second variant for Meadow. The mechanism is shared, but `meadow.html` has not yet moved the palette into
`VARIANTS` — there the colours are hard-coded in the shader.

---

## 15. ✅ English interface and documentation

### Problem

Right now everything is in Russian: the labels in `switcher.py`, `THEMES.md`, `README.md`,
the comments in the code. A user outside a Russian-speaking environment will not figure it out.

### Proposal

Two independent levels, they must not be mixed:

| What | How | Why |
|---|---|---|
| Interface | `i18n/ru.json` and `en.json` plus a switcher in the window | for the person who launched the program |
| Documentation | `README.en.md`, `docs/en/` | for the person who reads the repository |

For the interface: a dictionary of strings and a `t(key)` function; the language is taken from
`LANG`, overridden manually and remembered in the settings. There is already a
ready sample — `settings.html`, which was removed as dead code; its
`loadLang`/`localizeRegistry` can be taken as a basis (the file is in the history,
commit `4b1ede9`).

### Pitfalls

- **Width.** German and English text is longer than Russian: buttons and
  labels will shift. Check with a screenshot, not by eye.
- **Pluralisation.** "1 firefly / 2 fireflies / 5 fireflies" cannot be expressed in a shared
  dictionary with a single string; a form with a number is needed.
- **The documentation will diverge.** The two languages must be updated together, otherwise
  the English one will lag several commits behind. Either generate it, or
  keep the English one short (installation and the contract only).

### Cost

The interface — 1–2 days. The documentation — 1–2 days for the translation and as much again
for keeping it up to date.

### Done

**Interface.** All of `switcher.py`'s labels live in a `UI` dictionary with
`ru` and `en` entries, read through `t(lang, key)`. Theme names, descriptions,
groups, parameter labels, variants and units go through `theme_text`,
`param_text`, `group_text`, `variant_text` — the Russian text still lives in
`themes.json` so there is a single source. The language switch sits in the
status row; the choice is stored in `~/.config/mintland/lang`, and without it
the language comes from `LANG`, defaulting to Russian.

Found and fixed while checking: the "The layer keeps running after you close
this window" note and the "Theme" heading were local variables and stayed
Russian when the language changed. They are widget attributes now.

**Documentation.** `README.en.md` is a full translation of the README, and the
two link to each other. `docs/en/` holds all seven documents plus an index,
3 577 lines. Verified by structure rather than by eye: heading counts, code
fence counts and table row counts match the originals for every file.

Russian stays the development language: the strings in `themes.json`, the code
comments and the original documents are Russian. English is added alongside.

---

## 16. ⬜ Building a `.deb`

### Why

Right now installation is: clone the repository, `pip install pygobject`, compile
`deskwall.c` and edit the `.desktop` file by hand. For an end user this is
unacceptable.

A `.deb` gives: installed with a double click, dependencies pulled in automatically,
files placed in standard paths, clean removal.

### It is reasonable, yes

The project is already better prepared for this than it seems:

| What is needed | State |
|---|---|
| Dependencies expressed explicitly | `gi`, `webkit2gtk-4.1`, `libx11` — all from the Mint repository |
| No build in place | `deskwall.c` is the only binary, 200 lines |
| No vendored libraries | everything is system |
| Config in `~/.config` | already so |

### What will be needed

1. **`debian/`**: `control` (dependencies), `rules` (building `deskwall`),
   `install` (what goes where), `postinst`/`prerm`.
2. **Paths.** Right now everything runs from the project directory. In the package the code
   will move to `/usr/share/mintland/`, the settings will stay in `~/.config/mintland/`.
   That means `HERE`/`PROTO` in `switcher.py` and `themehost.py` must be computed from
   the package location, not from the current directory.
3. **Launching.** A `.desktop` in `/usr/share/applications/`, an icon in
   `/usr/share/icons/`, autostart — optional.
4. **The default theme** on first launch and a clear message if
   the session is not X11.

### Risk

Medium. The main trap is **paths**: if they are left relative, the
package will build and even run from the folder, but after installation it will not find
`prototype/`. It must be checked on a clean machine or in a container, not where
the source lives.

Second: `nemo-desktop` and `deskwall` are tied to Cinnamon/Muffin. In
`control` it is worth specifying `Recommends: cinnamon`, and in the description honestly
write that X11 and Cinnamon are supported.

### Order

It is more logical after §15: a package with an interface in one language is worse than a package with
two. And after §8 (baking), because it changes the file structure of a
theme, and therefore what is put into the package.

---

## 17. ⬜ Maps: one engine, four themes

### What this is

Four themes in `themes.json` are locked right now, and all four are maps:

| Theme | What is on it |
|---|---|
| Hand-drawn city | a top-down view of an old city: houses in ink, streets, icons on squares |
| Colourful city | the same street grid, but with red roofs and coloured walls |
| Old map | parchment, a continent, dotted roads, carts between cities |
| Sea chart | parchment, ports, lighthouses, fairways, sailing ships |

The word "family" here is not about genre — no "Nature / Fantasy". It is about
**technical kinship**: all four are assembled by one piece of code and differ by a
table — a set of tiles, building density, palette.

### How a map differs from the current themes

All three current themes are built the same way: they have a **distance field to the
icons**, and the scene adapts to it.

- in Beach the shoreline curves around the icons, the waves roll in along the normal;
- in Meadow the clouds gather in circles above the icons;
- in Night a halo shines around each icon.

That is, **the icons set the shape of the scene**.

A map works the other way round: it has **its own permanent geometry** — a street grid,
a river bed, a shoreline. It does not adapt to the icons, but leaves empty
places for them in advance: squares, courtyards, clearings. Here **the scene
sets the places for the icons**.

This inverts the relation "scene ↔ icons", and it requires different code, not a
different shader.

### What this means in practice

| | Current themes | Maps |
|---|---|---|
| Relation to icons | the scene deforms around them | the scene is constant, places are left for the icons |
| Basis | distance field (SDF) | a tile grid plus ready-made artwork |
| New code | shader | tile layout, finding free places |
| Movement | animation over the field | objects on a schedule: carts, ships, smoke |

**What stays shared.** Not only the protocol (`icons`, `settings`,
`pause`, `ready`) — it is shared by all themes by definition. All the
plumbing around the scene also stays shared: reading the icon positions, handling
`devicePixelRatio`, pausing by window coverage, the `tools/` utilities, writing
previews. That is the part that does not need to be written anew.

**What will have to be written.** Two things, and both are new:

1. **Map layout.** The street grid must be laid out so that it keeps
   plots for the icons of a particular user. The easiest way is to
   build the city around the known positions: where an icon stands, there is a square,
   and quarters around it.
2. **Finding a free place.** The inverse task: if an icon was dragged,
   find the nearest suitable plot without breaking the picture.

### Where this is already described in detail

This item is only an introduction. The full technical description, including the choice
of isometry, the sprite format, the baking of static parts and the review of licences, is in
[`PAPER.md`](PAPER.md).

They must be read together: `PAPER.md` answers "how to arrange this", while here —
only "why this is a separate item of the plan and when to take it on".

### Why one engine, not four pages

"Hand-drawn city" and "Colourful city" are literally one street grid in two
styles. Writing them as two pages means repeating the layout, the
search for places and the drawing of houses twice.

An engine plus a table gives: a new map style is a set of tiles and a palette,
that is tens of lines, not a thousand.

### How this relates to §9 and §14

This is exactly the case §14 in `THEMES.md` talks about: the mechanics are
fundamentally different, therefore **its own page** is needed, not a variant of
an existing one.

But the lesson of §9 remains: the engine must be written with a table of parameters from the start, otherwise
four maps will again turn into four copies of a thousand lines.

### When to take it on

Not before §8 (baking) is closed: `PAPER.md` relies directly on it — the static
part is drawn once into a texture. English (§15) is already done, so the second
condition is met.

### Cost

1–2 weeks for the first engine and one map, then a day or two per theme.

---

## 18. Related documents

- [`WOLOLAND.md`](WOLOLAND.md) — the analysis of the other project, from which the ideas were taken.
- [`THEMES.md`](THEMES.md) — the theme contract. Items 7, 9 and 11 are reflected: §14 — theme presets, §14 — variants inside the card.
- [`WAYLAND.md`](WAYLAND.md) — the port plan; items 3, 4 and 10 will have to be rethought on Wayland (there `nice` works, but `xprop` does not).
- [`PAPER.md`](PAPER.md) — a technical description of the map engine (§17): isometry, sprites, baking, licences.
- [`SAFETY.md`](SAFETY.md) — the safety contract; none of the items above violate it.
