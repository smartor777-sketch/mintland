# Mintland documentation (English)

*[Русская версия](../README.md) — the Russian documents are the source of truth.*

These are translations of the documents in [`docs/`](../). The project's
development language is Russian; English translations are kept alongside so the
project is readable outside Russian-speaking environments.

| Document | What it covers |
|---|---|
| [THEMES.md](THEMES.md) | Theme contract, how a page talks to the host, how to add a theme, variants |
| [IMPROVEMENTS.md](IMPROVEMENTS.md) | Concrete improvements with measurements, decisions and order of work |
| [WAYLAND.md](WAYLAND.md) | Plan for porting from X11 to Wayland: layer-shell, risks, tests |
| [WOLOLAND.md](WOLOLAND.md) | Analysis of a similar project: what to adopt and what does not transfer |
| [PAPER.md](PAPER.md) | The planned object-theme engine ("a map on paper"): art, sprites, baking |
| [OCCLUSION.md](OCCLUSION.md) | How Cinnamon and Muffin stack windows, and why icons end up under the scene |
| [SAFETY.md](SAFETY.md) | Safety contract: Dark Mode applet, kill policy |

Start with [THEMES.md](THEMES.md) if you want to write a theme, and with
[IMPROVEMENTS.md](IMPROVEMENTS.md) if you want to know what is planned.

## Keeping translations current

The Russian documents change more often than the translations. When a Russian
document is edited, the English one should be updated in the same commit — or
at least the change should be noted here so it does not silently drift.

Numbers, measurements and code identifiers are copied verbatim and are never
recomputed during translation: if a figure is wrong, it is wrong in both
languages, and the fix belongs in the Russian original first.

## Not translated

- `README.en.md` at the repository root is the English README. The Russian one is
  `README.md`.
- Code comments in the source are in Russian, deliberately: Russian is the
  development language.
- `NOTICE` and `LICENSE` stay in their original wording — a licence text must not
  be reworded.
