# Cinnamon, Muffin and window ordering

> **Document:** how Cinnamon and Muffin lay out desktop windows, and why this can leave icons underneath the scene.
> **Date:** 15.11.2026.
> **Why:** this knowledge was obtained through measurements and reading sources; without it, the next change to the layer would again turn into guesswork.
> **Related documents:** [`SAFETY.md`](SAFETY.md) — the contract for coexisting with Nemo, [`IMPROVEMENTS.md`](IMPROVEMENTS.md).

---

## 0. In short

Mintland draws the scene in a window of the same type as `nemo-desktop` (`_NET_WM_WINDOW_TYPE_DESKTOP`). Both windows end up **in the same Muffin layer**, and the order within that layer is set **not by X11**, but by Muffin's own stack (`MetaStack`).

Three consequences follow from this, and they were expensive:

1. `XQueryTree` and `_NET_CLIENT_LIST_STACKING` show **not** what is visible on screen.
2. `XRaiseWindow` (`deskwall -u`) has **no effect** on this ordering.
3. On startup, `nemo-desktop` **refuses** to own the desktop if a foreign window of type `DESKTOP` already exists.

Therefore "the icons do not appear" is almost always not slow loading, but occlusion or Nemo declining the role.

---

## 1. Who is responsible for what

| Component | Role |
|---|---|
| **Cinnamon** | Shell: panels, applets, menus. Does not draw the desktop |
| **Muffin** | Compositor and window manager. Decides which window is on top, draws shadows and transitions |
| **nemo-desktop** | A separate process that draws the icons on the desktop |
| **csd-background** | Settings daemon: system wallpaper |
| **Mintland (`themehost.py`)** | Our window with the scene |

Important: **Cinnamon does not draw the desktop**. Icons are `nemo-desktop`, the wallpaper is `csd-background`, the ordering is Muffin. Three different processes that look like a single picture.

---

## 2. Muffin layers

From `src/meta/common.h`:

```c
typedef enum
{
  META_LAYER_DESKTOP           = 0,   /* bottom-most */
  META_LAYER_BOTTOM            = 1,
  META_LAYER_NORMAL            = 2,
  META_LAYER_TOP               = 4,   /* also known as DOCK */
  META_LAYER_DOCK              = 4,
  META_LAYER_OVERRIDE_REDIRECT = 7,
  META_LAYER_LAST              = 8
} MetaStackLayer;
```

The larger the number, the higher the window. **`DESKTOP` is the bottom-most layer**, not a "desktop layer" in the everyday sense.

### 2.1. How a window gets into a layer

From `src/x11/window-x11.c`:

```c
static MetaStackLayer
get_standalone_layer (MetaWindow *window)
{
  switch (window->type)
    {
    case META_WINDOW_DESKTOP:
      layer = META_LAYER_DESKTOP;      /* always, bypassing the flags */
      break;
    case META_WINDOW_DOCK:
      if (window->wm_state_below || ...)
        layer = META_LAYER_BOTTOM;
      else
        layer = META_LAYER_DOCK;
      break;
    ...
    default:
      layer = meta_window_get_default_layer (window);
      break;
    }
}
```

The key point: **for the `DESKTOP` type the layer is assigned rigidly**, the `_NET_WM_STATE_BELOW`/`ABOVE` flags are not taken into account.

And `meta_window_get_default_layer()` (for the other types) looks at the flags:

```c
MetaStackLayer
meta_window_get_default_layer (MetaWindow *window)
{
  if (window->wm_state_below)
    return META_LAYER_BOTTOM;
  else if (window->wm_state_above && !META_WINDOW_MAXIMIZED (window))
    return META_LAYER_TOP;
  else
    return META_LAYER_NORMAL;
}
```

Hence the trap we fell into: if a window has its `DESKTOP` type **removed** but `BELOW` left in place, it moves to `META_LAYER_BOTTOM` — **above** both DESKTOP windows. The scene ends up above the icons, even though "we lowered it".

### 2.2. Ordering within a layer

From `src/core/stack.c`:

```c
static int
compare_window_position (void *a, void *b)
{
  MetaWindow *window_a = a;
  MetaWindow *window_b = b;

  /* Go by layer, then stack_position */
  if (window_a->layer < window_b->layer)
    return 1;
  else if (window_a->layer > window_b->layer)
    return -1;
  else if (window_a->stack_position < window_b->stack_position)
    return 1;                      /* the earlier one is the lower one */
  else if (window_a->stack_position > window_b->stack_position)
    return -1;
  ...
}
```

Within a single layer, `stack_position` decides — Muffin's internal counter. It is **not related** to the window order in X11.

---

## 3. Why X11 lies

The X11 order (`XQueryTree`, `_NET_CLIENT_LIST_STACKING`) reflects what Muffin sent to the server **last**. But the compositor does not draw according to that order, it draws according to its own `MetaStack`.

An observation from this machine (both windows are `DESKTOP`):

```text
XQueryTree (bottom to top):
  80  themehost.py      2560x1440 viewable
  81  nemo-desktop      2560x1360 viewable     ← Nemo is "higher"

_NET_CLIENT_LIST_STACKING:
  1: 0x460000d (our scene)
  2: 0x3e0001b (Рабочий стол)                  ← Nemo is "higher"

But on screen: the scene is on top of the icons.
```

This is not an X11 bug and not a Muffin bug. These are two different representations: the server was told one thing, another is drawn.

**Practical conclusion:** checking the layer order via `xprop`/`xwininfo` for DESKTOP windows is pointless. What must be checked is **the screen**.

---

## 4. Why Nemo refuses to draw icons

From `src/nemo-desktop-application.c` (Nemo):

```c
static gboolean
desktop_already_managed (void)
{
  windows = gdk_screen_get_window_stack (screen);

  for (iter = windows; iter != NULL; iter = iter->next) {
      GdkWindow *window = GDK_WINDOW (iter->data);

      if (gdk_window_get_type_hint (window) == GDK_WINDOW_TYPE_HINT_DESKTOP) {
          gchar **ignored = g_settings_get_strv (desktop_preferences,
                            NEMO_PREFERENCES_DESKTOP_IGNORED_DESKTOP_HANDLERS);
          if (!desktop_handler_is_ignored (window, ignored)) {
              ret = TRUE;
          }
          break;
      }
  }
  ...
}
```

and in `local_command_line`:

```c
if (desktop_already_managed ()) {
    goto out;      /* we simply exit without drawing anything */
}
```

The terminal message:

```text
Nemo-WARNING: Desktop already managed by another application, skipping desktop setup.
To change this, modify org.nemo.desktop 'ignored-desktop-handlers'.
```

The meaning: Nemo looks for **any** window with the type `DESKTOP` and, having found it, **does not create the window with icons at all**. It is not "drawing slowly", it never draws — no matter how long you wait.

### 4.1. What counts as "ignored"

The `org.nemo.desktop ignored-desktop-handlers` list on this machine:

```bash
$ gsettings get org.nemo.desktop ignored-desktop-handlers
['conky', 'csd-background']
```

The check is performed against the window's `WM_CLASS` (case-insensitively, as a substring). Our class is `themehost.py`, it is not in the list, so Nemo gives up.

> **Important regarding the `SAFETY.md` contract:** we **will not** add ourselves to this list — that would be modifying someone else's settings via `gsettings`, which is explicitly forbidden. The correct path is the startup order described below.

---

## 5. The working scheme

### 5.1. Startup order

```text
1. nemo-desktop is running and ALREADY owns the desktop
   (the "Рабочий стол" window exists)
2. Mintland creates its own window of type DESKTOP
3. Muffin places it into the same DESKTOP layer
4. One remap of the Nemo window  →  Muffin places it above our scene
```

Violating step 1 is the most frequent cause of "no icons": if the scene appears earlier, Nemo declines the role.

### 5.2. Check the window, not the process

The process may be alive but the role may not be taken. The correct check:

```bash
wmctrl -l | grep -q "Рабочий стол"
```

and not `pgrep -x nemo-desktop`. We had this bug in `wall-on.sh`.

### 5.3. One remap instead of raise

The only one of the tested means that places Nemo above the scene within the layer:

```python
# libX11 via ctypes — without external utilities
lib.XUnmapWindow(display, xid)
lib.XSync(display, 0)
time.sleep(0.3)
lib.XMapWindow(display, xid)
lib.XSync(display, 0)
```

Muffin perceives this as a window appearing and places it higher.

---

## 6. What does not work (verified by measurements)

All the methods below **left the icons under the scene**:

| Method | Why it does not help |
|---|---|
| `deskwall -u` / `XRaiseWindow` | Changes the X11 order, not `MetaStack` |
| `deskwall -r` (place below Nemo) | Same: it edits X, but Muffin draws |
| Switching the type `NORMAL` ↔ `DESKTOP` | The DESKTOP type still yields `META_LAYER_DESKTOP`, while NORMAL+`BELOW` goes to `BOTTOM` — higher |
| Removing `_NET_WM_STATE_BELOW` | For DESKTOP the flag is ignored (`get_standalone_layer`) |
| Removing `_NET_WM_STATE_DEMANDS_ATTENTION` | The flag does not affect the layer, only "attention" |
| Waiting "for it to finish loading" | There will be no icons at all — Nemo has exited |

Worth remembering separately: **the `BELOW` flag is dangerous**. For a window of type `DESKTOP` it is ignored, but for any other type it raises the window to `META_LAYER_BOTTOM`, that is, above the desktop.

---

## 7. How to debug this

### 7.1. Look at the types and flags

```bash
# our windows
for w in $(wmctrl -l | awk '{print $1}'); do
    echo "$w $(xprop -id $w _NET_WM_WINDOW_TYPE | grep -o 'WINDOW_TYPE_[A-Z]*')"
done
```

Expected: both `Рабочий стол` and `mintland-wall` are `WINDOW_TYPE_DESKTOP`.

### 7.2. Check whether Nemo has declined

```bash
nemo-desktop 2>&1 | head -5
```

If you see `Desktop already managed by another application` — that is it.

### 7.3. Check by the screen, not by X11

The only reliable way:

```bash
wmctrl -k on                      # show the desktop
sleep 1
gnome-screenshot -f /tmp/desk.png
wmctrl -k off                     # bring the windows back
```

And look at the picture. The traps I stepped into:

- **Screensaver.** If the screen is locked, the snapshot will show the lock screen, not the desktop. Check: `gdbus call --session --dest org.cinnamon.ScreenSaver --object-path /org/cinnamon/ScreenSaver --method org.cinnamon.ScreenSaver.GetActive`.
- **Foreign windows.** `wmctrl -k on` does not minimize windows marked "always on top". You must verify that there are no other windows in the icon area.
- **Light theme background.** The "white pixels = icons" detector breaks on light themes like Beach: the sand is light too. It is more reliable to look for the label text — a light pixel next to a dark one (the outline).

### 7.4. Debugging Muffin itself

The sources have debug topics, including `META_DEBUG_STACK` — it prints the stack "Bottom to top" with the layer number and `stack_position` of each window:

```c
meta_topic (META_DEBUG_STACK, "%u:%d - %s ",
            w->layer, w->stack_position, w->desc);
```

It is enabled by the `MUFFIN_DEBUG=1` variable (see `src/core/main.c`), but only works if the compositor is built with `WITH_VERBOSE_MODE`. In the Linux Mint distribution build this support is, as a rule, disabled, so in practice checking by the screen remains.

---

## 8. How this differs from Wayland

On Wayland the layers are set by a protocol, not by guesswork:

| | X11 (now) | Wayland (plan) |
|---|---|---|
| Who decides the order | Muffin's `MetaStack`, by `stack_position` | The `wlr-layer-shell` protocol: `BACKGROUND` / `BOTTOM` / `TOP` / `OVERLAY` |
| Order between DESKTOP windows | undefined, depends on history | `nemo-desktop` — `BOTTOM`, Mintland — `BACKGROUND` |
| How to verify | only by the screen | the protocol states it explicitly |
| `deskwall -u` | needed (and does not help) | not needed and meaningless |

That is, on Wayland this confusion will not exist by construction — details in [`WAYLAND.md`](WAYLAND.md).

---

## 9. Final memo

- **Cinnamon does not draw the desktop.** Icons are `nemo-desktop`, the wallpaper is `csd-background`.
- **`META_LAYER_DESKTOP = 0` is the bottom-most layer.** Within it, the order is set by `stack_position`, not by X11.
- **The X11 stack lies** for windows of the same type. Verify only by the screen.
- **`BELOW` for a non-DESKTOP window raises it above the desktop.** Do not set it "just in case".
- **Nemo declines the role** if it sees a foreign DESKTOP window. The startup order is critical, and you must check the window, not the process.
- **The only thing that places Nemo above the scene** is a short unmap/map of its window. Once; more than that and the icons flicker.
