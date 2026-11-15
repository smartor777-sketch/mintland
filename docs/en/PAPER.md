# Object theme family: a map on paper

> **Document:** a technical description of a new family of Mintland themes — object scenes in the style of an old map.
> **Date:** 14.11.2026.
> **Status:** idea and plan. No code yet.
> **Related documents:** [`THEMES.md`](THEMES.md) — the theme contract, [`WOLOLAND.md`](WOLOLAND.md) — where the idea came from, [`IMPROVEMENTS.md`](IMPROVEMENTS.md) §8–9 — baking and presets.
> **Paths:** all paths in the document are from the repository root, not from `docs/`.

---

## 0. In brief

A new family of themes is proposed: the desktop as an **old map** — parchment, ink, isometric houses, forest, piles of gold and stone, walls around the icons.

Three differences from the existing themes:

1. **Objects, not pixels.** The scene is assembled from sprites on an isometric grid, not computed by a fragment shader.
2. **Own art.** Everything is drawn procedurally or taken from CC0/PD sources. Not a single sprite from proprietary games.
3. **Baking.** The static part is drawn once into a texture, every frame is one blit plus a dozen units.

This is cheaper than the current themes in CPU and more expensive in development time: the engine is ~700 lines, bringing the look up to standard is a week.

---

## 1. Why this at all

### 1.1. The problem the family solves

Shader themes (Beach, Meadow, Night) are good, but they have a limit: **they have no objects**. You cannot draw a house, a tree, a chest or a lantern — only a field of colour. Everything that resembles an object has to be imitated in the shader, and that is expensive.

Hence the consequence: the themes come out "natural". Shore, meadow, sky, water. Everything that can be described by a gradient and noise.

And in the `themes.json` registry there are four themes that cannot be made with a shader:

| id | Name | Description (translation) |
|---|---|---|
| `worldmap` | Old map | Continents on parchment, cities connected by dotted roads, carts carrying supplies |
| `nauticalmap` | Nautical chart | Icons merge into land, ports and lighthouses along the shores, winding fairways, sailing ships and sea serpents |
| `map` | Hand-drawn city | Rows of houses outlined in ink, icons on the square |
| `citymap` | Colourful city | The same, but in colour: red roofs, yellow and light-blue walls |

All four are from Deskland, all have thumbnails in `prototype/thumbs/`, and not one has an HTML page. That is, the idea existed, the implementation did not.

### 1.2. Why "paper" specifically

Because this style **explains itself**.

A map on paper is a convention the viewer accepts instantly: houses are drawn from the side, although the map is from above; trees are little symbols; roads are dotted lines. Nobody demands photorealism, because it is a map, not a view from a window.

For procedural generation these are ideal conditions: **stylisation forgives simplification**, photorealism does not.

Plus paper provides a natural background: it is non-uniform, with stains and fibres, and this hides seams, texture repetition and small flaws in object placement.

### 1.3. What already exists in the project

| Component | State |
|---|---|
| Distance field to the icons `computeField()` | Ready in `flat.html`, debugged, 28.9 ms with 11 icons |
| Two-dimensional field sampler `sampleArr()` | Ready in `flat.html`, bilinear interpolation |
| Noise `fbm()`, `hash2()`, PRNG `mulberry32()` | Present, but **duplicated on every page** |
| Thumbnails of the four themes | Lie in `prototype/thumbs/` |
| Protocol `icons`/`settings`/`pause` | Described in `THEMES.md`, three implementations |
| Baking of the static part | Not done (see `IMPROVEMENTS.md` §8) |

So the foundation exists. What is missing is the object layer.

Worth noting separately: the noise and the PRNG are currently copied into `flat.html` and
`night.html` independently. For the object engine they will have to be moved into a shared
file — otherwise the family will begin with the same problem described in
`IMPROVEMENTS.md` §9 (three implementations of the same thing).

---

## 2. Legal framework

### 2.1. Style is not protected, expression is

This is a basic principle of copyright, and here it is decisive.

| Not allowed | Allowed |
|---|---|
| Copying a tree sprite from AoE2 | Drawing your own tree in 2:1 isometric |
| Redrawing a sprite "in the spirit of" while keeping the silhouette and colour | Using a genre palette: warm ochres, dark ink |
| Taking the game's menu art: parchment frames, red buttons, map cards | Making your own frames in a similar spirit |
| Using the name and the logo | Your own style and your own name |
| Taking grass and sand textures from the game | Drawing your own procedurally |

Isometric RTS graphics are a genre technique thirty years old, common to dozens of games. It belongs to nobody.

The key boundary runs along the **silhouette and colour of a specific object**. If our little house has a different proportion, a different roof, a different palette and a different outline — it is a different house, even if the grid is the same.

### 2.2. Difference from Wololand

Wololand solves the problem differently: it **reads art from the installed game** at runtime and distributes nothing. That is legal for a user who has the game.

But:

- it requires the paid game to be installed (on Linux — via a Proton prefix, with fragile paths);
- our theme family then depends on someone else's licence;
- the result cannot be distributed.

Our approach — **own art** — removes all three restrictions. The price: it has to be drawn.

### 2.3. Licences for our project

Mintland is distributed under GPL-3.0. That means the assets must be compatible:

| Licence | Compatible with GPL-3.0 | Comment |
|---|---|---|
| Own art (we are the authors) | Yes | The best option |
| CC0 / Public Domain | Yes | Ideal |
| CC BY | Yes | Attribution required in `NOTICE` |
| CC BY-SA 4.0 | Yes, one-way | Requires the same licence for the derivative — complicates things |
| CC BY-NC, "personal use only" | **No** | Exclude entirely |
| Art from games | **No** | Exclude entirely |

**Project rule:** no licences with a "non-commercial" or "personal use only" restriction. Even if the theme itself is free, GPL-3.0 does not allow this.

---

## 3. Why an object scene is cheaper than a shader one

This is not obvious and therefore requires explanation.

### 3.1. A naive estimate is misleading

It may seem: two hundred trees at 2000 pixels each is 400 thousand blits, that is, a lot. And a shader computes 2 million pixels in a single pass. So sprites are more expensive?

No, and here is why.

### 3.2. The cost is not in pixels but in shader complexity

A measurement of `night.html` at 2560×1440:

```text
everything as is     10.8 ms/frame
glow disabled         0.3 ms/frame     ← this is where the whole cost is
halos disabled        0.1 ms/frame
without effects       0.1 ms/frame
```

That is, **one expensive effect costs 100 times more than the entire rest of the frame**. A full-screen shader with fbm noise, several texture fetches and branches is tens of instructions for each of the 2 million pixels.

A blit of a ready texture is one fetch per pixel. The difference in cost is an order of magnitude.

### 3.3. Baking removes the static part from the frame

In an object scene almost everything is static: ground, forest, houses, walls, piles of gold. Only the units move.

| Layer | When it is drawn |
|---|---|
| Ground + all static objects | Once, when icons/parameters/window size change |
| Water (if any) | Every frame, but that is two shifted blits |
| Units | Every frame, a dozen sprites |

Total frame: one full-screen blit plus several small ones. This is closer to `night.html` without the glow (0.3 ms) than to `flat.html` (10 ms).

This is exactly how Wololand gets its "3–4% of one core".

### 3.4. Consequence: canvas 2D is enough

If a frame is a blit, WebGL is not needed. Canvas 2D copes: `drawImage()` for the background and the sprites.

This matters because **canvas 2D is many times simpler to write than WebGL**. No shaders, no buffers, no state management. `night.html` (579 lines, canvas 2D) is clear proof that a beautiful scene can be made on canvas.

So the object family is **not a WebGL project**. It is canvas 2D with baking.

### 3.5. An honest estimate

Do not expect a miracle. The object scene will be cheaper than the shader one, but:

- baking takes 30–80 ms, and that is noticeable when dragging an icon (fixed by debouncing, see `IMPROVEMENTS.md` §2);
- memory: a baked texture at 2560×1440 is ~14 MB in RGBA, plus the sprite atlas;
- when the window size or the scale changes, the texture has to be recreated.

---

## 4. Engine architecture

### 4.1. Isometric grid

The classic 2:1 scheme — a tile of width `tw` and height `tw/2`.

```text
        /\
      /    \        cell (i,j) → screen
    /        \      x = (i - j) * tw/2
   \        /       y = (i + j) * th/2
    \      /
      \  /
```

The inverse transform is needed to map a click to a cell (if that is needed) and to place objects "by the grid":

```text
i = (x / (tw/2) + y / (th/2)) / 2
j = (y / (th/2) - x / (tw/2)) / 2
```

Traversal: `for i in range(n): for j in range(n)` with culling against the screen. Wololand does exactly the same:

```rust
let x = (i - j) as f32 * tw * 0.5;
let y = (i + j) as f32 * th * 0.5;
if x < -tw || y < -th || x > w + tw || y > h + th * 4.0 { continue; }
```

**Tile size.** Wololand uses 96×48 logical pixels. For a paper map I would take a larger one, 128×64: fewer objects, each more noticeable, and stylisation forgives a large step.

### 4.2. Sprites and the atlas

A sprite is an image with an anchor point (the "sole", the point where it touches the ground), not with a centre.

```js
{ img, ox, oy }        // ox, oy — offset from the anchor point to the top-left corner
```

Drawing: `ctx.drawImage(img, x + ox, y + oy)`.

A tree of 200×280 px is anchored by the bottom of the trunk. A house of 128×96 — by the bottom of the front wall. A wall — by the bottom of its centre.

**The atlas.** To avoid holding hundreds of separate `<img>` elements and paying for switching sources, all sprites are packed into a single canvas atlas at initialisation. Then `drawImage` takes a rectangle from a single source:

```js
ctx.drawImage(atlas, sx, sy, sw, sh, x + ox, y + oy, sw, sh);
```

For the first version you can do without an atlas: a dozen sprites, the difference is imperceptible. The atlas is an optimisation of the second stage.

### 4.3. Depth

The rule is simple: **sort by the y of the anchor point**, ascending.

An object whose sole is lower is drawn later — that is, on top. This gives the correct overlap: a tree in front of a house covers it, a tree behind the house does not.

```js
objects.sort((a, b) => a.y - b.y);
```

Limitation: the rule breaks for very tall objects standing next to each other (a house behind a house of the same height). For a map this is not a problem — the objects have different heights and stand sparsely.

If more precision is needed, the same trick as in Wololand works: sorting by `y`, and within one `y` — by tile index.

### 4.4. Object placement

Three levels of rules, from simple to complex.

**Rule 1: not on the icons.** We have a field `d(x,y)` — the distance to the nearest icon, negative inside. Anything below the threshold is forbidden:

```js
if (d(px, py) < margin) continue;      // too close to an icon
```

**Rule 2: do not intersect each other.** A simple check of rectangles or circles by the sole:

```js
function free(px, py, r) {
  return !placed.some(o => (o.x - px) ** 2 + (o.y - py) ** 2 < (o.r + r) ** 2);
}
```

**Rule 3: thematic masks.** This is where the interesting part begins. Wololand uses shared density functions for this:

```rust
fn forest(&self, d: f32, n1: f32, n2: f32) -> f32 {
    match self.kit.theme {
        Theme::Arabia => smoothstep(0.635, 0.66, n2) * smoothstep(140.0*ds, 200.0*ds, d),
        Theme::Arena  => smoothstep(self.wall_r + 50.0*ds, self.wall_r + 90.0*ds, d) * …,
        // …
    }
}
```

One function per theme, returning a density from 0 to 1. Then, while traversing the tiles:

```js
if (rng() < forest(x, y)) placeTree(x, y);
```

This is a very economical way to set the character of a theme: a few lines per theme, and the picture comes out different.

**The order of placement matters.** First the large (mountains, walls, cities), then the medium (forest, houses), then the small (bushes, stones, flowers). Otherwise the large will find no room.

### 4.5. Ground layers

The ground under the objects is not a shader but several baked layers:

| Layer | What | How |
|---|---|---|
| Paper | The base | A texture or procedural noise |
| Stains | Tone irregularities | 2–3 large fbm stains with low alpha |
| Water | If the theme has water | A flat fill + a gradient near the shore |
| Shore | A border | A band along the contour of the field `d`, as in `flat.html` |
| Ground | Grass/sand/stone | A fill with noise modulation |
| Paths | Roads | Dots along an isoline or along a Bézier curve |

We already have isolines in an embryonic form: `flat.html` builds the shore precisely along the contour of the field. Wololand takes the technique all the way to walls:

```rust
fn contour_lines(f: &Field, level: f32, w: usize, h: usize) -> Vec<Vec<(f32, f32)>>
fn lay_wall(line, ds) -> Vec<(f32, f32, usize)>   // wall pieces along the contour
```

`contour_lines` walks the grid, finds the level crossings and stitches the points into polylines. `lay_wall` lays wall pieces along the polyline, choosing the frame by the direction to the next cell — so that neighbouring pieces join up and the towers hide the joints at the turns.

This is the mechanism that gives "walls around the icons". For a paper map it is not mandatory in the first version, but it is precisely what separates "a set of objects" from "a map".

### 4.6. Units

Decor without movement looks dead, but units are the most expensive part in terms of time.

It is worth starting with the minimum: **wandering creatures without pathfinding**.

```js
u.x += Math.cos(u.a) * u.v * dt;
u.y += Math.sin(u.a) * u.v * dt;
// soft repulsion from icons and obstacles
const rep = repel(u.x, u.y);
u.x += rep.x * dt; u.y += rep.y * dt;
if (Math.random() < 0.01) u.a += (Math.random() - 0.5);
```

Wololand uses a BFS flow field (`Flow`) so that soldiers go around the forest. That is right for a game where the path matters. For a decorative map repulsion is enough: the viewer will not notice the difference, and the code is three times shorter.

What can be added later, in increasing order of complexity:

1. animals wandering over free cells (cheap);
2. carts driving along roads (medium — the roads themselves are needed);
3. workers at objects: standing, playing an animation (cheap, but animation frames are needed);
4. full pathfinding (expensive, hardly needed).

### 4.7. Baking

The heart of performance.

```js
function bake() {
  baked.width = W; baked.height = H;
  const g = baked.getContext('2d');
  drawPaper(g);
  drawWater(g);
  drawGround(g);
  drawObjects(g);      // all static objects in depth order
}

function frame(t) {
  ctx.drawImage(baked, 0, 0);
  drawUnits(ctx, t);
  requestAnimationFrame(frame);
}
```

**Invalidation** is the key question. Rebuilding is needed when:

- the icon rectangles change (after debouncing);
- the theme changes;
- parameters affecting the static part change;
- the window size or `devicePixelRatio` changes;
- the style preset changes.

Not needed when:

- paused (we simply do not draw);
- the units move.

**Estimating the cost of baking.** For comparison: `computeField()` with 11 icons — 28.9 ms. Baking will add tile traversal and blits, roughly the same again. Total 50–80 ms per rebuild. This is noticeable, but it happens rarely and is fixed by debouncing.

**Memory.** A 2560×1440 RGBA texture — 14.7 MB. Plus the sprite atlas, plus the page itself. Acceptable, but with multiple monitors it is multiplied by the number of screens.

---

## 5. Assets: three paths

### 5.1. Comparison

| Path | Pros | Cons | When to choose |
|---|---|---|---|
| **Procedurally, with code** | The licence is clean by definition; zero weight; the style is changed by a parameter | You must be able to draw with code; complex objects are tedious | The main path |
| **CC0 sets** | Fast; neatly drawn | The style will have to be adjusted; often "cartoonish" | If volume is needed quickly |
| **Scans of old books** | Real paper, engravings, ink | The licence of each scan has to be checked separately | For paper and engraved details |

### 5.2. Recommendation: procedurally

Not because of the licence, but because of **coherence**.

A stylised map rests on unity: one palette, one outline, one light source, one manner of shadow. Mixing three CC0 sets is almost guaranteed to produce a patchwork where every object comes from its own world.

Drawing with code gives coherence for free: all objects pass through the same functions of tone, outline and shadow. Change the outline function — the whole world changes consistently.

### 5.3. How to draw sprites with code

A sprite is drawn into an offscreen canvas at initialisation:

```js
function makeTree(seed) {
  const c = document.createElement('canvas');
  c.width = 120; c.height = 170;
  const g = c.getContext('2d');
  const r = mulberry32(seed);
  // trunk
  g.fillStyle = INK; g.fillRect(56, 120, 8, 46);
  // crown: three overlapping circles
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.arc(60 + (r() - 0.5) * 30, 80 + (r() - 0.5) * 30, 30 + r() * 12, 0, 6.283);
    g.fill();
  }
  return c;
}
```

For a paper map this is enough: the crown is not "real leaves" but three circles with an uneven outline. Stylisation forgives.

Houses are harder: perspective, roof, windows, shadow are needed. But here too the "two planes" trick works: the front wall is a rectangle, the roof is a parallelogram, the side wall is another parallelogram. Three shapes, and the house reads.

### 5.4. If taking ready-made

**CC0 sources** (check the licence on the page of each set):

- Kenney — sets in the public domain, a uniform style within a set;
- OpenGameArt with a CC0 filter;
- itch.io with a CC0 filter (careful: some "free" sets ≠ CC0).

**Scans** (only for paper and engravings):

- Wikimedia Commons with the PD-old-70/PD-old-100 template;
- Old Book Illustrations — they claim public domain;
- rawpixel, the public domain collection.

**Important about scans.** Public domain in the original does not always mean the same for a scan: in some jurisdictions there is separate protection for a photographic reproduction. For two-dimensional works this usually does not get in the way, but the rule is simple: **take only sources that explicitly claim PD or CC0**, not "we think this is old".

### 5.5. Project policy

1. Everything that can be drawn with code is drawn with code.
2. External assets — only CC0 or explicit PD, with the source stated in `NOTICE`.
3. No "free for personal use", "non-commercial", "free with attribution and no derivatives".
4. Every asset enters the repository only together with a line in `NOTICE`: what it is, where from, under which licence.
5. If the licence is in doubt — we do not take the asset.

---

## 6. Style rules

Three rules that must be accepted before work begins, otherwise you get clipart.

### 6.1. Limited palette

No more than 6–8 colours per theme.

```js
const PALETTE = {
  paper:  '#efe3c8',
  ink:    '#3b2f22',
  shade:  '#7a6849',
  water:  '#9db8a8',
  green:  '#7d8f5a',
  accent: '#a8452f',   // roofs, flags
};
```

The limitation itself makes the picture stylish. The fewer colours, the more it looks like a book illustration and the less like a random craft project.

### 6.2. One light source and one type of shadow

All objects cast a shadow in one direction (for example, down-right), of the same softness and the same opacity.

This rule is broken most often: a tree with a shadow to the left, a house with a shadow to the right — and the picture falls apart, although each object individually is good.

The shadow is drawn once, in the same function as the object:

```js
function withShadow(g, x, y, draw) {
  g.save();
  g.globalAlpha = 0.18;
  g.fillStyle = '#000';
  g.translate(6, 4);
  draw(g, x, y);          // the same shape, shifted
  g.restore();
  draw(g, x, y);          // the object itself
}
```

### 6.3. Outline

A thin dark contour around every object is the cheapest way to tie heterogeneous shapes together.

For a paper map the thickness is 1–2 px at scale 1. At a render scale of 0.75 (see `THEMES.md`, "Render scale") the outline remains visible if it is drawn with a margin.

---

## 7. Style presets

The main advantage of the procedural approach: **the style becomes a parameter**.

If the geometry is one and the palette, outline, texture and shadow softness change — you get different themes from one engine.

| Preset | Palette | Outline | Texture | Mood |
|---|---|---|---|---|
| **Ink on parchment** | Ochres + sepia | 1.5 px, dark | Paper, stains | An old map, an engraving |
| **Watercolour** | Muted, blurred | None | Soft fills with an uneven edge | A children's book |
| **Engraving** | Two tones | 0.5 px + hatching | Dense hatching instead of a fill | A 17th-century engraving |
| **Colour book** | Bright, 6 colours | 3 px, black | Flat fills | A modern illustration |

This is exactly the mechanism that `THEMES.md` lacks (see `IMPROVEMENTS.md` §9): a theme not as a separate program but as a set of parameters.

### 7.1. What changes between the presets

| Parameter | Effect |
|---|---|
| `palette` | Colours of the ground, water, objects |
| `outline` | Thickness and colour of the contour |
| `shadow` | Offset, opacity, blur |
| `grain` | Intensity of the paper noise |
| `texture` | Whether there is hatching and in which direction |
| `softness` | Sharpness of the edges of the fills |

Eight numbers — and one geometry gives four different worlds.

---

## 8. Which themes this covers

| id from the registry | Name | What is needed | Complexity |
|---|---|---|---|
| `worldmap` | Old map | Paper, continent contours, mountains as symbols, dotted roads, carts | Medium |
| `nauticalmap` | Nautical chart | Water, islands made of icons, ports, lighthouses, sailing ships, a sea serpent | Medium |
| `map` | Hand-drawn city | Houses in ink, streets, mills, a square | Medium |
| `citymap` | Colourful city | The same, a different palette | Low (a preset) |

Plus potentially:

| Idea | What | Complexity |
|---|---|---|
| Forest wilderness | Dense forest, glades around the icons, a hut | Low |
| Mountain country | Cliffs, passes, bridges | Medium |
| Battlefield | Siege machines, tents, flags | High |

The last three are not from the registry, but simply natural continuations of the genre.

---

## 9. How this fits into the project

### 9.1. Two families side by side

| Family | Themes | Engine | Frame |
|---|---|---|---|
| Shader | Beach, Meadow, Night | Each has its own page, WebGL/canvas | Full recomputation |
| Object | Old map, Nautical, Cities | One shared engine, canvas 2D | Blit + units |

Coexistence, not replacement. Beach and Meadow stay as they are.

### 9.2. Registration

From the point of view of `themehost.py` and `switcher.py` nothing changes: a theme is still an HTML page according to the contract from `THEMES.md`.

The difference is inside the page: instead of a single shader — an engine plus a theme configuration.

```text
prototype/paper.html          ← the engine + the entry point
prototype/paper/engine.js     ← grid, sprites, depth, baking
prototype/paper/sprites.js    ← procedural sprites
prototype/paper/themes.js     ← theme configurations (worldmap, map, …)
```

The page chooses the theme by a parameter:

```text
file:///…/paper.html?wallpaper=1&theme=worldmap
```

### 9.3. What will have to be finished

| Component | Change |
|---|---|
| `themehost.py` | Pass the theme id in the URL on load (currently only `?wallpaper=1`) |
| `themes.json` | The `worldmap`/`map`/… entries get `status: "ready"` and `page: "paper.html"` |
| `switcher.py` | `THEME_INFO` and labels for the new themes |
| `THEMES.md` | A section about the object family |
| `NOTICE` | If external assets appear |

The point about `themehost.py` is the only real change in the existing code: right now the page address is assembled as `file://…?wallpaper=1`, and the theme parameter needs to be added. That is a few lines.

---

## 10. Work stages and estimate

### 10.1. Stages

| Stage | What | Result | Time |
|---|---|---|---|
| 1 | Grid, sprites, depth, baking | A stub: grey rectangles on paper | 2–3 days |
| 2 | Procedural sprites: tree, house, stone, gold, wall | An atlas of objects | 3–4 days |
| 3 | The first theme in full: "Old map" | A working theme without units | 2–3 days |
| 4 | Units: wandering animals, carts | The map comes alive | 2–4 days |
| 5 | Style presets | Four themes from one engine | 1–2 days |
| 6 | Polish: light, shadows, outline, paper | "Not embarrassing to show" | 3–5 days |

### 10.2. Estimate

| Variant | What is included | Time |
|---|---|---|
| **MVP** | Engine + one theme + a static map | **~1 week** |
| **Full** | Engine + 2–3 themes + units + 4 presets | **2–3 weeks** |
| **With polish** | Plus bringing the look up to standard | **3–4 weeks** |

### 10.3. The ratio worth accepting in advance

**The engine — 2–3 days. The look — a week.**

This is the most important warning of the document. Writing code that places little houses is easy. Making it look like a map and not like a diagram takes a long time.

### 10.4. Comparison with the alternative

| What | Time | What it gives |
|---|---|---|
| One more shader theme (like `night.html`) | an evening | One theme |
| The object family | 1–3 weeks | An engine + 4 themes + a foundation for more |

The choice depends on whether more than one object theme is planned. Judging by the registry — it is.

---

## 11. Risks

| Risk | Probability | What to do |
|---|---|---|
| It looks like clipart and not like a map | **High** | Accept the style rules (§6) before starting; make presets |
| Baking is too slow | Medium | Debounce; measure at stage 1 |
| Memory with multiple monitors | Medium | One texture per monitor; free it on change |
| Units eat all the time | High | Make them last and keep them to a minimum |
| Licence of an external asset | Low with the procedural path | Policy §5.5 |
| The styles do not combine between themes | Medium | One engine, one set of rules |
| Artefacts when the window size changes | Medium | Invalidation on resize + `devicePixelRatio` |

---

## 12. What not to do

- **Do not drag in AoE2 art.** Neither sprites, nor textures, nor menu art.
- **Do not copy the Wololand interface.** It is built on the game's menu art — the most problematic spot of their project.
- **Do not start with units.** A static map first: if it does not work without movement, movement will not save it.
- **Do not do everything in WebGL.** For an object scene canvas 2D is enough and three times simpler.
- **Do not mix styles in one theme.** One engine — one set of rules.
- **Do not rewrite Beach and Meadow.** The object family is a separate page.

---

## 13. The first step

The most sensible entry point is **"Old map" (`worldmap`)**:

- the geometry is simple: land, mountains as symbols, roads as dots;
- no water is needed, and with it the most complex part goes away;
- the description and the thumbnail are already in the registry;
- the "engraving" preset fits perfectly.

The first prototype is worth making **without icons at all**: just a map over the whole screen. If it looks good on its own — then the field `d(x,y)` will fit in without surprises. If it does not look good — better to learn that on the second day than in the second week.

---

## 14. Links

- [`THEMES.md`](THEMES.md) — the theme contract, registration, preview.
- [`WOLOLAND.md`](WOLOLAND.md) — an analysis of someone else's project: baking, isolines, placement by masks.
- [`IMPROVEMENTS.md`](IMPROVEMENTS.md) — §8 (baking), §9 (theme presets).
- [`SAFETY.md`](SAFETY.md) — the safety contract.
- `prototype/themes.json` — the entries `worldmap`, `nauticalmap`, `map`, `citymap`.
- `prototype/thumbs/old map.webp`, `nautical chart.webp`, `hand draw city.webp`, `colorful city.webp` — thumbnails of the idea.
