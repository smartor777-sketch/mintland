# Mintland on Mint — rules for coexisting with Dark Mode

The Mintland live-wallpaper layer (the scene under the icons) has to live alongside the
**Dark Mode applet (darkMode@linuxedo.com)** and not break it. Here is the hard contract.

## What belongs to the Dark Mode applet — DO NOT TOUCH

When switching dark/light the applet writes to dconf:

| Schema / key | What it is |
|---|---|
| `org.x.apps.portal color-scheme` | preferred color scheme |
| `org.cinnamon.desktop.wm.preferences theme` | window border theme |
| `org.cinnamon.desktop.interface gtk-theme` | GTK theme |
| `org.cinnamon.desktop.interface icon-theme` | icons |
| `org.cinnamon.theme name` | Cinnamon theme |
| `org.cinnamon.desktop.background picture-uri` | **wallpaper** (its own sets for light/dark) |

The rule for all Mintland scripts: **not a single call to `gsettings`/`dconf`**.
The wallpaper layer neither reads nor writes system settings at all.

## Why window order is a separate topic

The order of the scene and the icons is set not by X11 but by the Muffin stack. Because of
this, checks via `xprop`/`xwininfo` do not show what is visible on the screen, and `deskwall -u`
has no effect on the order. A walkthrough with sources and measurements is in
[`OCCLUSION.md`](OCCLUSION.md).

## The known (non-breaking) overlap

The Dark Mode applet changes the wallpaper. Our layer is drawn ON TOP of the system
wallpaper, so while the layer is enabled, a wallpaper change when switching dark/light
mode will be invisible — it happens "under" the layer. This is expected and is rolled back
by turning the layer off (`wall-off.sh`). There is no degradation of the switching scheme.

## What the scripts do not do (kill policy)

- they do not kill or restart `cinnamon`, `muffin`, `csd-*`;
- they do not touch other people's windows and processes;
- `switcher.py` does not call `gsettings`/`dconf`: only its own files
  `~/.config/mintland/settings.json` and `control.json` (`run/` when
  running from the repository, `~/.cache/mintland/` in an installed package);
- they kill only their own processes: the group recorded in `run/wall.pid`
  (`setsid`), plus a fallback by the unique path `mintland/themehost.py`
  and by `deskwall --create`;
- `nemo-desktop` is the only deliberate exception: `wall-off.sh`
  restarts it **after** the layer is removed. This gives Nemo back the desktop
  role and does not affect Dark Mode: icon positions are stored
  in gvfs metadata, while the theme/wallpaper live in dconf, which we neither read nor write.

## Applications menu entry

| Applications menu entry | Action |
|---|---|
| **Mintland** (`/usr/bin/mintland`) | `switcher.py` — themes, parameters, on/off |

There are no separate on and off menu entries: `wall-on.sh` / `wall-off.sh`
remain service scripts that the application calls.

## Step 1 results (12.11.2026) — the layer under the icons works

Verified on a live machine (Mint 21.x, Cinnamon/Muffin, X11, 2560×1440):

| Attempt | Result |
|---|---|
| `xwinwrap -ov` (including `-argb`, `-fdt`, `-ovr`) | ❌ BadMatch: it gets parented into an **XComposite overlay window** (a window without properties, depth/visual do not match) |
| an override-redirect window in root (`deskwall` v1) | ❌ Muffin **raises the OR window to the top** — it covered the whole screen, XLowerWindow/CWSibling do not hold |
| **a managed window (not OR) + `_NET_WM_WINDOW_TYPE_DESKTOP` + BELOW/SKIP_TASKBAR/SKIP_PAGER + input=False (WM_HINTS) + XShape(input, empty) + CWSibling-Below watchdog to nemo-desktop** | ✅ video under the icons, panel in place, window not in Alt-Tab |

Tool: `deskwall.c` → `bin/deskwall` (forks mpv, lives just as long,
every 2 s it moves its own window strictly below the `nemo-desktop` window).
The takeaway for all following steps: **no override-redirect windows — only
a managed window with the DESKTOP type**.

Not verified by a human: icon clickability (by architecture it should
work: nemo-desktop is above, our input shape is empty).

## Results: the functional version (13.11.2026)

Verified on a live machine (Mint 21.x, Cinnamon/Muffin, X11, 2560×1440):

| Approach | Result |
|---|---|
| DESKTOP window + `keep_below`, `nemo-desktop` started earlier | ✅ scene under the icons, the icons are visible and clickable |
| `deskwall -u` after the layer starts | ✅ raises nemo above the scene, the icons are not lost |
| `wall-off.sh` → `wall-on.sh` again | ✅ the scene and the icons come back |
| `deskwall --create` container + reparenting WebKit | ⚠️ the scene is drawn, but nemo loses the desktop role → no icons; rejected |
| NORMAL window under the icons | ❌ always above the DESKTOP layer, the icons are hidden |
| XShape "cut-outs" for the icons | ❌ rejected: fragile and unnecessary with the right stack |

The key condition: **`nemo-desktop` must be started before the layer is created**.
If the layer already exists, Nemo prints `Desktop already managed by another
application, skipping desktop setup` and does not draw the icons. That is why
`wall-off.sh` always restarts Nemo after the layer is removed.

## Structure

```
start-layer.sh  — starts the layer (changes separately from the application)
switcher.py     — GTK3: themes, parameters, on/off; writes settings/control
wall-on.sh      — service start: environment checks, PID file, deskwall -u
wall-off.sh     — service stop: kill the group, restart nemo-desktop
run/            — wall.pid, wall.log, control.json (gitignore)
~/.cache/mintland/ — the same in an installed package
~/.config/mintland/settings.json — saved theme and parameters
```
