/* Mintland · движок карт (canvas 2D).
 *
 * Первый этап из docs/PAPER.md: бумага, озёра, замки, пунктирные дороги,
 * процедурные спрайты и юниты. Никаких внешних ассетов: всё рисуется кодом.
 *
 * Мир строится детерминированно и не зависит от иконок. Иконки только
 * скрывают ближние объекты при запекании, поэтому перетаскивание иконки
 * не пересобирает карту заново.
 *
 * Движок ничего не знает про протокол хоста. Страница (paper.html) получает
 * icons/settings/pause и вызывает методы setIcons/setParams/render.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  var SPRITE_SCALE = 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function hash2(x, y) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ h >>> 13, 1274126177);
    return ((h ^ h >>> 16) >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  function valueNoise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var v00 = hash2(xi, yi), v10 = hash2(xi + 1, yi);
    var v01 = hash2(xi, yi + 1), v11 = hash2(xi + 1, yi + 1);
    var sx = smooth(xf), sy = smooth(yf);
    return lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sy);
  }

  function fbm(x, y, octaves) {
    var sum = 0, amp = 0.5, norm = 0, f = 1;
    for (var i = 0; i < octaves; i++) {
      sum += valueNoise(x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function smooth01(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function roundRectPath(g, x, y, w, h, r) {
    r = Math.min(r, w * 0.5, h * 0.5);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  function chaikin(points, iterations) {
    var pts = points;
    for (var it = 0; it < iterations; it++) {
      if (pts.length < 3) break;
      var out = [pts[0]];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
    var t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    var rx = bx - ax, ry = by - ay;
    var sx = dx - cx, sy = dy - cy;
    var den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-6) return null;
    var t = ((cx - ax) * sy - (cy - ay) * sx) / den;
    var u = ((cx - ax) * ry - (cy - ay) * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: ax + rx * t, y: ay + ry * t };
  }

  function pointOnPath(road, u) {
    var total = road.length || 1;
    var target = ((u % 1) + 1) % 1 * total;
    var cum = road.cum;
    var lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid; else hi = mid;
    }
    var seg = (cum[hi] - cum[lo]) || 1;
    var t = clamp((target - cum[lo]) / seg, 0, 1);
    var a = road.points[lo], b = road.points[hi];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      angle: Math.atan2(b.y - a.y, b.x - a.x)
    };
  }

  /* ---------- двоичная куча для A* ---------- */

  function MinHeap() { this.a = []; }

  MinHeap.prototype.push = function (node) {
    var a = this.a;
    a.push(node);
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      var t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  };

  MinHeap.prototype.pop = function () {
    var a = this.a;
    var top = a[0];
    var last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        var t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  };

  MinHeap.prototype.size = function () { return this.a.length; };

  /* ---------- спрайты ---------- */

  function makeSprite(w, h, ax, ay, draw) {
    var c = document.createElement('canvas');
    c.width = Math.ceil(w * SPRITE_SCALE);
    c.height = Math.ceil(h * SPRITE_SCALE);
    var g = c.getContext('2d');
    g.scale(SPRITE_SCALE, SPRITE_SCALE);
    draw(g);
    return { c: c, w: w, h: h, ax: ax, ay: ay };
  }

  function blobPath(g, pts) {
    var n = pts.length;
    var m0x = (pts[0][0] + pts[1][0]) * 0.5;
    var m0y = (pts[0][1] + pts[1][1]) * 0.5;
    g.beginPath();
    g.moveTo(m0x, m0y);
    for (var k = 1; k <= n; k++) {
      var p = pts[k % n];
      var next = pts[(k + 1) % n];
      g.quadraticCurveTo(p[0], p[1],
                         (p[0] + next[0]) * 0.5,
                         (p[1] + next[1]) * 0.5);
    }
    g.closePath();
  }

  function setInk(g, spr, scale) {
    g.lineWidth = 1 / Math.max(0.05, scale);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = spr.ink;
  }

  /* Дерево: тонкий ствол и один неровный контур кроны. Внутренних
   * окружностей нет — на старой карте дерево читается силуэтом.
   * k — масштаб значка: на больших картах деревья мельче домов. */
  function drawTree(g, w, h, p, rng, conifer) {
    var ax = w * 0.5, ay = h - 4;
    var k = Math.max(0.62, (h - 8) / 28);
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.fillStyle = p.shadow;
    g.beginPath();
    g.ellipse(ax + 2.5 * k, ay - 1.2, 5.5 * k + rng() * 1.3, 2 * k, 0, 0, TAU);
    g.fill();

    g.strokeStyle = p.ink;
    g.lineWidth = 1.35;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(ax, ay - 1);
    g.quadraticCurveTo(ax - 1, ay - 7 * k, ax + 0.5, ay - 12 * k);
    g.stroke();

    if (conifer) {
      function tier(baseY, halfW, topY) {
        g.beginPath();
        g.moveTo(ax, topY);
        g.lineTo(ax + halfW, baseY);
        g.lineTo(ax - halfW, baseY);
        g.closePath();
        g.globalAlpha = 0.30 + rng() * 0.18;
        g.fillStyle = p.tree;
        g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = p.ink;
        g.lineWidth = 1.1;
        g.stroke();
      }

      tier(ay - 3 * k, 8.5 * k, ay - 17 * k);
      tier(ay - 11 * k, 6.2 * k, ay - 24 * k);
      tier(ay - 18 * k, 3.8 * k, ay - 31 * k);
      return;
    }

    var pts = [];
    var n = 11 + Math.floor(rng() * 3);
    var cy = ay - 20 * k;
    for (var i = 0; i < n; i++) {
      var a = i / n * TAU;
      var rx = 8.5 * k * (0.74 + rng() * 0.36);
      var ry = 7.2 * k * (0.74 + rng() * 0.36);
      pts.push([ax + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    blobPath(g, pts);
    g.globalAlpha = 0.34 + rng() * 0.30;
    g.fillStyle = p.tree;
    g.fill();
    g.globalAlpha = 1;
    setInk(g, spr, 1);
    g.stroke();

    g.strokeStyle = p.treeLight;
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(ax - 4 * k, cy - 2 * k);
    g.lineTo(ax - 1 * k, cy - 5 * k);
    g.moveTo(ax + 1 * k, cy + 2 * k);
    g.lineTo(ax + 4 * k, cy - 1 * k);
    g.moveTo(ax + 3 * k, cy + 4 * k);
    g.lineTo(ax + 5 * k, cy + 1 * k);
    g.stroke();
  }

  function makeTree(seed, p, conifer) {
    var rng = mulberry32(seed);
    var w = conifer ? 22 : 24;
    var h = conifer ? 30 : 32;
    var ax = w * 0.5, ay = h - 4;
    return makeSprite(w, h, ax, ay, function (g) {
      g.save();
      drawTree(g, w, h, p, rng, conifer);
      g.restore();
    });
  }

  /* Дом: низкие пропорции, контур и косые штрихи на стене. */
  function drawHouse(g, w, h, p, rng) {
    var s = 0.52 + rng() * 0.08;
    var ax = w * 0.5, ay = h - 5;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.fillStyle = p.shadow;
    g.beginPath();
    g.ellipse(ax + 2, ay - 1, 9, 2.4, 0, 0, TAU);
    g.fill();

    g.save();
    g.translate(ax, ay);
    g.scale(s, s);
    g.translate(0, -7);
    setInk(g, spr, s);

    g.fillStyle = p.wallLeft;
    g.beginPath();
    g.moveTo(-13, 0); g.lineTo(0, 6); g.lineTo(0, -16); g.lineTo(-13, -22);
    g.closePath(); g.fill(); g.stroke();

    g.fillStyle = p.wallRight;
    g.beginPath();
    g.moveTo(0, 6); g.lineTo(13, 0); g.lineTo(13, -22); g.lineTo(0, -16);
    g.closePath(); g.fill(); g.stroke();

    g.fillStyle = p.roofLeft;
    g.beginPath();
    g.moveTo(-16, -22); g.lineTo(0, -16); g.lineTo(16, -22);
    g.lineTo(7, -33); g.lineTo(-7, -33);
    g.closePath(); g.fill(); g.stroke();

    g.fillStyle = p.roofRight;
    g.globalAlpha = 0.55;
    g.beginPath();
    g.moveTo(-16, -22); g.lineTo(0, -16); g.lineTo(16, -22);
    g.lineTo(13, -24); g.lineTo(0, -19); g.lineTo(-13, -24);
    g.closePath(); g.fill();
    g.globalAlpha = 1;

    g.fillStyle = 'rgba(90,70,48,0.55)';
    g.fillRect(4, -10, 4, 10);
    g.fillStyle = 'rgba(236,222,190,0.65)';
    g.fillRect(-9, -16, 3.5, 3.5);
    g.strokeRect(-9, -16, 3.5, 3.5);

    g.strokeStyle = p.inkSoft;
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(-12, -6); g.lineTo(-7, -10);
    g.moveTo(-12, -2); g.lineTo(-4, -9);
    g.stroke();
    g.restore();
  }

  function makeHouse(seed, p) {
    var rng = mulberry32(seed);
    var w = 26, h = 32, ax = 13, ay = 28;
    return makeSprite(w, h, ax, ay, function (g) {
      drawHouse(g, w, h, p, rng);
    });
  }

  /* Замок: стена с воротами, две боковые башни и донжон с флагом.
   * Именно замок, а не отдельная башня: на карте он должен читаться
   * как узел дорог. */
  function drawCastle(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 5;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.fillStyle = p.shadow;
    g.beginPath();
    g.ellipse(ax + 3, ay - 1.5, 15, 3.4, 0, 0, TAU);
    g.fill();

    g.save();
    g.translate(ax, ay);
    setInk(g, spr, 1);

    // Крыши внутри стен — выглядывают над гребнем, как в замке.
    function innerRoof(rx) {
      g.fillStyle = p.wallLeft;
      g.fillRect(rx - 4, -9, 8, 4);
      g.strokeRect(rx - 4, -9, 8, 4);
      g.fillStyle = p.roofLeft;
      g.beginPath();
      g.moveTo(rx - 5, -9); g.lineTo(rx + 5, -9); g.lineTo(rx, -15);
      g.closePath(); g.fill(); g.stroke();
    }
    innerRoof(-8);
    innerRoof(8);

    // Крепостная стена: передняя и боковые грани.
    g.fillStyle = p.stone;
    g.beginPath();
    g.moveTo(-15, 0); g.lineTo(0, 6); g.lineTo(15, 0);
    g.lineTo(15, -9); g.lineTo(0, -3); g.lineTo(-15, -9);
    g.closePath(); g.fill(); g.stroke();

    // Зубцы стены идут по гребню: в центре ниже, к башням выше.
    for (var k = 0; k < 5; k++) {
      var t = k / 4;
      var bx = -12 + 24 * t;
      var by = -9 + 6 * (1 - Math.abs(2 * t - 1));
      g.fillRect(bx - 1.5, by - 3, 3, 3);
      g.strokeRect(bx - 1.5, by - 3, 3, 3);
    }

    // Ворота.
    g.fillStyle = 'rgba(90,70,48,0.6)';
    g.beginPath();
    g.moveTo(-3, 5); g.lineTo(0, 6.2); g.lineTo(3, 5);
    g.lineTo(3, -1); g.quadraticCurveTo(0, -3.5, -3, -1);
    g.closePath(); g.fill(); g.stroke();

    // Боковые башни: ниже донжона, раздвинуты к краям стены.
    function sideTower(sx) {
      g.fillStyle = p.stone;
      g.beginPath();
      g.moveTo(sx - 4, 0); g.lineTo(sx, 2.5); g.lineTo(sx, -14); g.lineTo(sx - 4, -16.5);
      g.closePath(); g.fill(); g.stroke();

      g.fillStyle = p.stoneDark;
      g.beginPath();
      g.moveTo(sx, 2.5); g.lineTo(sx + 4, 0); g.lineTo(sx + 4, -16.5); g.lineTo(sx, -14);
      g.closePath(); g.fill(); g.stroke();

      g.fillStyle = p.stone;
      g.beginPath();
      g.moveTo(sx - 4, -16.5); g.lineTo(sx, -14); g.lineTo(sx + 4, -16.5);
      g.lineTo(sx, -19); g.closePath();
      g.fill(); g.stroke();

      g.fillRect(sx - 3.5, -20, 2.6, 2.6);
      g.strokeRect(sx - 3.5, -20, 2.6, 2.6);
      g.fillRect(sx + 0.9, -20, 2.6, 2.6);
      g.strokeRect(sx + 0.9, -20, 2.6, 2.6);
    }

    sideTower(-13);
    sideTower(13);

    // Донжон по центру — заметно выше боковых башен.
    g.fillStyle = p.stone;
    g.beginPath();
    g.moveTo(-5, -1); g.lineTo(0, 2); g.lineTo(0, -26); g.lineTo(-5, -29);
    g.closePath(); g.fill(); g.stroke();

    g.fillStyle = p.stoneDark;
    g.beginPath();
    g.moveTo(0, 2); g.lineTo(5, -1); g.lineTo(5, -29); g.lineTo(0, -26);
    g.closePath(); g.fill(); g.stroke();

    g.fillStyle = p.stone;
    g.beginPath();
    g.moveTo(-5, -29); g.lineTo(0, -26); g.lineTo(5, -29); g.lineTo(0, -32);
    g.closePath(); g.fill(); g.stroke();

    g.fillRect(-4.5, -33, 3, 3.2); g.strokeRect(-4.5, -33, 3, 3.2);
    g.fillRect(1.5, -33, 3, 3.2); g.strokeRect(1.5, -33, 3, 3.2);

    // Флаг на донжоне.
    g.strokeStyle = p.ink;
    g.lineWidth = 1.1;
    g.beginPath(); g.moveTo(0, -32); g.lineTo(0, -46); g.stroke();
    g.fillStyle = p.roofLeft;
    g.beginPath(); g.moveTo(0, -46); g.lineTo(8, -43); g.lineTo(0, -40);
    g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  function makeCastle(seed, p) {
    var rng = mulberry32(seed);
    var w = 38, h = 56, ax = 19, ay = 51;
    return makeSprite(w, h, ax, ay, function (g) {
      drawCastle(g, w, h, p, rng);
    });
  }

  /* Гора: два-три пика, штриховка на теневой стороне.
   * Вершины рисуем тонко, как на гравюре, а не как заливные клинья. */
  function drawMountain(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 5;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.fillStyle = p.shadow;
    g.beginPath();
    g.ellipse(ax + 3, ay - 1, 14, 2.8, 0, 0, TAU);
    g.fill();

    function peak(px, baseY, halfW, height) {
      g.strokeStyle = p.ink;
      g.lineWidth = 1.25;
      g.lineJoin = 'round';

      g.fillStyle = p.mountain;
      g.beginPath();
      g.moveTo(px, baseY - height);
      g.lineTo(px - halfW, baseY);
      g.lineTo(px, baseY);
      g.closePath(); g.fill(); g.stroke();

      g.fillStyle = p.mountainDark;
      g.beginPath();
      g.moveTo(px, baseY - height);
      g.lineTo(px + halfW, baseY);
      g.lineTo(px, baseY);
      g.closePath(); g.fill(); g.stroke();

      // Штриховка вдоль склона, а не поперёк.
      g.strokeStyle = p.inkSoft;
      g.lineWidth = 0.8;
      for (var k = 1; k <= 3; k++) {
        var t = k * 0.22;
        var y1 = baseY - height * (t + 0.16);
        var x1 = px + halfW * (1 - (t + 0.16)) * 0.35;
        var y2 = baseY - height * t;
        var x2 = px + halfW * (1 - t) * 0.92;
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
      }
    }

    peak(ax - 9 + rng() * 2, ay - 2, 12 + rng() * 2, 13 + rng() * 3);
    peak(ax + 9 + rng() * 2, ay - 1, 11 + rng() * 2, 11 + rng() * 3);
    peak(ax + (rng() - 0.5) * 3, ay, 16 + rng() * 3, 18 + rng() * 4);
  }

  function makeMountain(seed, p) {
    var rng = mulberry32(seed);
    var w = 52, h = 36, ax = 26, ay = 31;
    return makeSprite(w, h, ax, ay, function (g) {
      drawMountain(g, w, h, p, rng);
    });
  }

  /* Камень: маленький силуэт с контуром. */
  function drawRock(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 3;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.fillStyle = p.shadow;
    g.beginPath();
    g.ellipse(ax + 1.5, ay - 1, 5.5, 1.8, 0, 0, TAU);
    g.fill();

    g.save();
    g.translate(ax, ay);
    setInk(g, spr, 1);
    g.fillStyle = p.mountain;
    g.beginPath();
    g.moveTo(-5.5, 0);
    g.lineTo(-4, -4 - rng() * 1.2);
    g.lineTo(0, -6.5 - rng() * 1.2);
    g.lineTo(4.5, -4 - rng() * 1.2);
    g.lineTo(6, 0);
    g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }

  function makeRock(seed, p) {
    var rng = mulberry32(seed);
    var w = 16, h = 13, ax = 8, ay = 10;
    return makeSprite(w, h, ax, ay, function (g) {
      drawRock(g, w, h, p, rng);
    });
  }

  /* Поле: ромб с бороздами. Заполняет равнины вокруг замков, как на
   * фэнтези-картах, и не спорит с лесом по силуэту. */
  function drawField(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 4;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.save();
    g.translate(ax, ay);
    setInk(g, spr, 1);

    g.fillStyle = p.paperLight;
    g.beginPath();
    g.moveTo(-13, 0); g.lineTo(0, 6); g.lineTo(13, 0); g.lineTo(0, -6);
    g.closePath();
    g.fill(); g.stroke();

    g.strokeStyle = p.inkSoft;
    g.lineWidth = 0.75;
    for (var k = 1; k <= 4; k++) {
      var t = k / 5;
      g.beginPath();
      g.moveTo(-13 + 26 * t, 0 - 6 + 12 * t);
      g.lineTo(-13 + 26 * t, 0 + 6 - 12 * t);
      g.stroke();
    }
    g.restore();
  }

  function makeField(seed, p) {
    var rng = mulberry32(seed);
    var w = 30, h = 18, ax = 15, ay = 14;
    return makeSprite(w, h, ax, ay, function (g) {
      drawField(g, w, h, p, rng);
    });
  }

  /* Кустик: маленькая крона без ствола, заполняет промежутки. */
  function drawBush(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 3;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.fillStyle = p.shadow;
    g.beginPath();
    g.ellipse(ax + 1, ay - 0.8, 4.5, 1.5, 0, 0, TAU);
    g.fill();

    var pts = [];
    var n = 9;
    for (var k = 0; k < n; k++) {
      var a = k / n * TAU;
      var r = 4.5 * (0.8 + rng() * 0.4);
      pts.push([ax + Math.cos(a) * r, ay - 5 + Math.sin(a) * r * 0.8]);
    }
    blobPath(g, pts);
    g.globalAlpha = 0.30 + rng() * 0.22;
    g.fillStyle = p.tree;
    g.fill();
    g.globalAlpha = 1;
    setInk(g, spr, 1);
    g.stroke();
  }

  function makeBush(seed, p) {
    var rng = mulberry32(seed);
    var w = 16, h = 13, ax = 8, ay = 10;
    return makeSprite(w, h, ax, ay, function (g) {
      drawBush(g, w, h, p, rng);
    });
  }

  /* Холмик: дуга с травяными штрихами. Такие знаки на старых картах
   * заполняют пустое место, не превращаясь в объекты. */
  function drawHill(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 3;
    var r = 4.5 + rng() * 2;
    g.strokeStyle = p.inkSoft;
    g.lineWidth = 0.9;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(ax, ay, r, Math.PI, TAU);
    g.stroke();

    var ticks = 2 + Math.floor(rng() * 2);
    for (var k = 0; k < ticks; k++) {
      var t = (k + 1) / (ticks + 1);
      var x = ax - r + 2 * r * t;
      var y = ay - Math.sin(Math.PI * t) * r;
      g.beginPath();
      g.moveTo(x, y - 0.5);
      g.lineTo(x - 1.2, y - 3.6);
      g.stroke();
    }
  }

  function makeHill(seed, p) {
    var rng = mulberry32(seed);
    var w = 18, h = 13, ax = 9, ay = 10;
    return makeSprite(w, h, ax, ay, function (g) {
      drawHill(g, w, h, p, rng);
    });
  }

  /* Повозка: миниатюрная точка на дороге. */
  function drawCart(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 3;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.fillStyle = p.shadow;
    g.beginPath();
    g.ellipse(ax + 1.5, ay - 0.8, 8, 2.2, 0, 0, TAU);
    g.fill();

    g.save();
    g.translate(ax, ay);
    setInk(g, spr, 1);
    g.fillStyle = p.wood;
    g.fillRect(-6.5, -8, 11, 6);
    g.strokeRect(-6.5, -8, 11, 6);

    g.fillStyle = p.roofLeft;
    g.beginPath();
    g.moveTo(-6.5, -8);
    g.quadraticCurveTo(-1, -14, 4.5, -8);
    g.closePath();
    g.fill(); g.stroke();

    g.fillStyle = p.ink;
    g.beginPath(); g.arc(-4.5, 0, 2.4, 0, TAU); g.fill();
    g.beginPath(); g.arc(4.5, 0, 2.4, 0, TAU); g.fill();
    g.restore();
  }

  function makeCart(seed, p) {
    var rng = mulberry32(seed);
    var w = 24, h = 18, ax = 12, ay = 14;
    return makeSprite(w, h, ax, ay, function (g) {
      drawCart(g, w, h, p, rng);
    });
  }

  /* ---------- движок ---------- */

  function PaperEngine(canvas, theme) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    // Статическая основа: бумага, реки, дороги, лес, замки. Не зависит
    // от иконок и пересобирается только при смене мира.
    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d', { alpha: false });

    // Слой полян под иконками. Пересобирается при каждом сдвиге иконки,
    // но это дешёвая операция: маска в четверть разрешения.
    this.overlay = document.createElement('canvas');
    this.overlayCtx = this.overlay.getContext('2d');

    // Готовый кадр: основа + поляны. Пересобирается при сдвиге иконок,
    // а каждый кадр — один блит.
    this.display = document.createElement('canvas');
    this.displayCtx = this.display.getContext('2d', { alpha: false });
    this.displayDirty = true;
    this.theme = theme;
    this.params = Object.assign({}, theme.defaults);
    this.W = 1;
    this.H = 1;
    this.dpr = 1;
    this.icons = [];
    this.world = null;
    this.worldDirty = true;
    this.bakeDirty = true;
    this.bakeMs = 0;
    this.overlayMs = 0;
    this.frameMs = 0;
    this.onFrame = null;
    this._seed = theme.seed || 0x51ed270b;
    this._paper = null;
    this._paperVig = null;
    this._paperKey = '';
    this._sprites = null;
    this._clearing = null;
    this._clearingSig = '';
    this.overlayDirty = true;
    this.displayDirty = true;
    this._blocked = null;
    this._roadsForPlacement = [];
    this._needsWorldRebuild = false;
    this._iconChangedAt = 0;
    this._rebuildDelay = 320;
    this._reserved = [];
    this._buildSprites();
  }

  PaperEngine.prototype._buildSprites = function () {
    var p = this.theme.palette;
    var i;
    var s = { trees: [], houses: [], mountains: [], rocks: [], castles: [], carts: [], hills: [], bushes: [], fields: [] };
    for (i = 0; i < 3; i++) s.trees.push(makeTree(0x1200 + i * 131, p, false));
    for (i = 0; i < 3; i++) s.trees.push(makeTree(0x1e00 + i * 167, p, true));
    for (i = 0; i < 5; i++) s.houses.push(makeHouse(0x3400 + i * 173, p));
    for (i = 0; i < 6; i++) s.mountains.push(makeMountain(0x5600 + i * 211, p));
    for (i = 0; i < 3; i++) s.rocks.push(makeRock(0x7800 + i * 97, p));
    for (i = 0; i < 2; i++) s.castles.push(makeCastle(0x9a00 + i * 151, p));
    for (i = 0; i < 2; i++) s.carts.push(makeCart(0xbc00 + i * 89, p));
    for (i = 0; i < 4; i++) s.hills.push(makeHill(0xde00 + i * 73, p));
    for (i = 0; i < 4; i++) s.bushes.push(makeBush(0xf000 + i * 59, p));
    for (i = 0; i < 3; i++) s.fields.push(makeField(0xfa00 + i * 41, p));
    this._sprites = s;
  };

  PaperEngine.prototype.setTheme = function (theme) {
    this.theme = theme;
    this.params = Object.assign({}, theme.defaults);
    this._seed = theme.seed || 0x51ed270b;
    this._paperKey = '';
    this._clearingSig = '';
    this.overlayDirty = true;
    this.displayDirty = true;
    this._buildSprites();
    this.worldDirty = true;
    this.bakeDirty = true;
  };

  PaperEngine.prototype.setParams = function (v) {
    var keys = ['density', 'forest', 'roads', 'units', 'cap30'];
    var world = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (typeof v[k] !== typeof this.params[k]) continue;
      if (this.params[k] === v[k]) continue;
      this.params[k] = v[k];
      if (k === 'density' || k === 'forest' || k === 'roads') world = true;
    }
    if (world) this.worldDirty = true;
  };

  PaperEngine.prototype.setIcons = function (icons) {
    var before = this._iconSig();
    this.icons = icons || [];
    var after = this._iconSig();

    // Немедленно обновляем поляны — при перетаскивании это дешёвый слой.
    this._clearingSig = '';
    this.overlayDirty = true;
    this.displayDirty = true;
    this.lastIconMove = performance.now();

    // А сам мир (лес, дороги, замки) пересоберём, когда иконка
    // остановится: карта должна обтекать островки, а не просто
    // закрываться подложкой.
    if (before !== after) {
      this._needsWorldRebuild = true;
      this._iconChangedAt = performance.now();
    }
  };

  // Хост присылает прямоугольники на каждом шаге перетаскивания, часто
  // чаще, чем успевает пересобраться слой. Тяжёлую работу откладываем
  // до следующего кадра: render() всё равно соберёт её один раз.
  PaperEngine.prototype.setIconsSoon = function (icons) {
    this._pendingIcons = icons || [];
    this._iconsPending = true;
  };

  PaperEngine.prototype.resize = function (w, h) {
    this.W = Math.max(1, Math.round(w));
    this.H = Math.max(1, Math.round(h));
    // Сцена — фон под иконками. На HiDPI рендерить её в 2× дорого, а
    // разница под иконками почти незаметна; при необходимости поднимем.
    this.dpr = Math.min(global.devicePixelRatio || 1, 1);
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.cv.style.width = this.W + 'px';
    this.cv.style.height = this.H + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.base.width = this.cv.width;
    this.base.height = this.cv.height;
    this.baseCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.overlay.width = this.cv.width;
    this.overlay.height = this.cv.height;
    this.overlayCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.display.width = this.cv.width;
    this.display.height = this.cv.height;
    this.displayCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.displayDirty = true;

    this._paperKey = '';
    this._clearingSig = '';
    this.overlayDirty = true;
    this.worldDirty = true;
    this.bakeDirty = true;
  };

  /* ---------- озёра ---------- */

  PaperEngine.prototype._buildLakes = function (rng) {
    var W = this.W, H = this.H;
    var list = this.theme.lakes || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var cfg = list[i];
      out.push({
        cx: cfg.x * W,
        cy: cfg.y * H,
        rx: Math.max(18, cfg.rx * W),
        ry: Math.max(11, cfg.ry * H),
        ph: [rng() * TAU, rng() * TAU, rng() * TAU],
        amp: [0.10, 0.055, 0.03],
        name: cfg.name || ''
      });
    }
    this.lakes = out;
  };

  PaperEngine.prototype._lakeEdge = function (lake, ang) {
    return 1 +
      lake.amp[0] * Math.sin(3 * ang + lake.ph[0]) +
      lake.amp[1] * Math.sin(5 * ang + lake.ph[1]) +
      lake.amp[2] * Math.sin(7 * ang + lake.ph[2]);
  };

  PaperEngine.prototype._inLake = function (x, y, pad) {
    var lakes = this.lakes || [];
    for (var i = 0; i < lakes.length; i++) {
      var l = lakes[i];
      var nx = (x - l.cx) / l.rx;
      var ny = (y - l.cy) / l.ry;
      var rr = Math.sqrt(nx * nx + ny * ny);
      var ang = Math.atan2(ny, nx);
      var edge = this._lakeEdge(l, ang);
      var p = pad / ((l.rx + l.ry) * 0.5);
      if (rr < edge + p) return true;
    }
    return false;
  };

  PaperEngine.prototype._lakePath = function (g, lake) {
    var N = 72;
    g.beginPath();
    for (var k = 0; k <= N; k++) {
      var ang = k / N * TAU;
      var r = this._lakeEdge(lake, ang);
      var x = lake.cx + Math.cos(ang) * lake.rx * r;
      var y = lake.cy + Math.sin(ang) * lake.ry * r;
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };

  /* ---------- реки ---------- */

  PaperEngine.prototype._buildRivers = function () {
    var W = this.W, H = this.H;
    var list = this.theme.rivers || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var src = list[i].points || [];
      var pts = [];
      for (var k = 0; k < src.length; k++) {
        pts.push({ x: src[k][0] * W, y: src[k][1] * H });
      }
      pts = chaikin(pts, 3);
      var cum = [0];
      for (var q = 1; q < pts.length; q++) {
        cum.push(cum[q - 1] + Math.hypot(pts[q].x - pts[q - 1].x,
                                          pts[q].y - pts[q - 1].y));
      }
      out.push({
        points: pts,
        cum: cum,
        length: cum[cum.length - 1],
        width: list[i].width || 2.2
      });
    }
    this.rivers = out;
  };

  PaperEngine.prototype._nearRiver = function (x, y, pad) {
    var rivers = this.rivers || [];
    for (var i = 0; i < rivers.length; i++) {
      var pts = rivers[i].points;
      var w = rivers[i].width;
      for (var k = 1; k < pts.length; k++) {
        if (distToSegment(x, y, pts[k - 1].x, pts[k - 1].y,
                          pts[k].x, pts[k].y) < pad + w) return true;
      }
    }
    return false;
  };

  /* ---------- зарезервированные места ---------- */

  PaperEngine.prototype._buildReserved = function () {
    var W = this.W, H = this.H;
    this._reserved = [];

    var labels = this.theme.labels || [];
    for (var i = 0; i < labels.length; i++) {
      var l = labels[i];
      var size = l.size || 14;
      var track = l.track || 3;
      var tw = l.text.length * (size * 0.62 + track);
      // Башня и другие высокие объекты стоят ногой чуть ниже текста —
      // поэтому полосу зарезервируем и ниже заголовка.
      this._reserved.push({
        x: l.x * W - tw * 0.5,
        y: l.y * H - size * 1.6,
        w: tw,
        h: size * 6
      });
    }

    var cp = this.theme.compass;
    if (cp) {
      this._reserved.push({
        x: cp.x * W - cp.r * 1.4,
        y: cp.y * H - cp.r * 1.4,
        w: cp.r * 2.8,
        h: cp.r * 2.8
      });
    }
  };

  PaperEngine.prototype._inReserved = function (x, y, r) {
    for (var i = 0; i < this._reserved.length; i++) {
      var q = this._reserved[i];
      if (x > q.x - r && x < q.x + q.w + r &&
          y > q.y - r && y < q.y + q.h + r) return true;
    }
    return false;
  };

  /* ---------- островки иконок ---------- */

  // Прямоугольники иконок с запасом: сюда нельзя ставить объекты и
  // прокладывать дороги. Именно из этого получается «карта вокруг
  // рабочего стола минус иконки», а не подложка поверх рисунка.
  PaperEngine.prototype._inIconZone = function (x, y, pad) {
    var icons = this.icons;
    for (var i = 0; i < icons.length; i++) {
      var r = icons[i];
      if (x > r.x - pad && x < r.x + r.w + pad &&
          y > r.y - pad && y < r.y + r.h + pad) return true;
    }
    return false;
  };

  /* ---------- дороги ---------- */

  PaperEngine.prototype._buildBlocked = function () {
    var W = this.W, H = this.H;
    var step = 16;
    var cols = Math.ceil(W / step) + 2;
    var rows = Math.ceil(H / step) + 2;
    var data = new Uint8Array(cols * rows);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = c * step, y = r * step;
        data[r * cols + c] =
          (x < 18 || x > W - 18 || y < 18 || y > H - 18 ||
           this._inLake(x, y, 22) ||
           this._inIconZone(x, y, 20)) ? 1 : 0;
      }
    }
    this._blocked = { step: step, cols: cols, rows: rows, data: data };
  };

  PaperEngine.prototype._route = function (a, b) {
    var B = this._blocked;
    if (!B) return null;

    var step = B.step, cols = B.cols, rows = B.rows, data = B.data;
    var total = cols * rows;

    function nearest(x, y) {
      var c0 = clamp(Math.round(x / step), 0, cols - 1);
      var r0 = clamp(Math.round(y / step), 0, rows - 1);
      for (var rad = 0; rad <= 6; rad++) {
        for (var dr = -rad; dr <= rad; dr++) {
          for (var dc = -rad; dc <= rad; dc++) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
            var c = c0 + dc, r = r0 + dr;
            if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
            var i = r * cols + c;
            if (data[i] === 0) return i;
          }
        }
      }
      return -1;
    }

    var start = nearest(a.x, a.y);
    var goal = nearest(b.x, b.y);
    if (start < 0 || goal < 0) return null;

    var gScore = new Float32Array(total);
    gScore.fill(1e9);
    var parent = new Int32Array(total);
    parent.fill(-1);
    var closed = new Uint8Array(total);

    function octile(i) {
      var gr = (goal / cols) | 0, gc = goal - gr * cols;
      var r = (i / cols) | 0, c = i - r * cols;
      var dx = Math.abs(gc - c), dy = Math.abs(gr - r);
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
    }

    var dirs = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]
    ];

    var open = new MinHeap();
    gScore[start] = 0;
    open.push({ i: start, f: octile(start) });

    var found = false;
    while (open.size()) {
      var cur = open.pop();
      var ci = cur.i;
      if (closed[ci]) continue;
      closed[ci] = 1;
      if (ci === goal) { found = true; break; }

      var cr = (ci / cols) | 0;
      var cc = ci - cr * cols;
      for (var d = 0; d < 8; d++) {
        var dc = dirs[d][0], dr = dirs[d][1], w = dirs[d][2];
        var nc = cc + dc, nr = cr + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        var ni = nr * cols + nc;
        if (data[ni]) continue;
        if (dc && dr && (data[cr * cols + nc] || data[nr * cols + cc])) continue;
        var ng = gScore[ci] + w;
        if (ng < gScore[ni]) {
          gScore[ni] = ng;
          parent[ni] = ci;
          open.push({ i: ni, f: ng + octile(ni) });
        }
      }
    }

    if (!found && goal !== start) return null;

    var path = [];
    var cur2 = goal;
    while (cur2 >= 0) {
      path.push(cur2);
      if (cur2 === start) break;
      cur2 = parent[cur2];
    }
    if (path[path.length - 1] !== start) return null;
    path.reverse();

    var pts = [];
    for (var p = 0; p < path.length; p++) {
      var idx = path[p];
      var rr = (idx / cols) | 0;
      var cc2 = idx - rr * cols;
      pts.push({ x: cc2 * step, y: rr * step });
    }
    pts[0] = { x: a.x, y: a.y };
    pts[pts.length - 1] = { x: b.x, y: b.y };
    return chaikin(pts, 2);
  };

  /* ---------- мир ---------- */

  PaperEngine.prototype._nearCastle = function (castles, x, y, pad) {
    for (var i = 0; i < castles.length; i++) {
      if (Math.hypot(castles[i].x - x, castles[i].y - y) < pad) return true;
    }
    return false;
  };

  PaperEngine.prototype._nearRoad = function (x, y, pad) {
    var roads = this._roadsForPlacement;
    for (var i = 0; i < roads.length; i++) {
      var pts = roads[i].points;
      for (var k = 1; k < pts.length; k++) {
        if (distToSegment(x, y, pts[k - 1].x, pts[k - 1].y,
                          pts[k].x, pts[k].y) < pad) return true;
      }
    }
    return false;
  };

  PaperEngine.prototype.buildWorld = function () {
    var self = this;
    var W = this.W, H = this.H;
    var rng = mulberry32(this._seed);
    // Плотность на пиксель должна быть одинаковой на любом разрешении.
    var areaScale = clamp((W * H) / (1280 * 720), 0.6, 3.2);

    this._buildLakes(rng);
    this._buildRivers();
    this._buildReserved();
    this._buildBlocked();

    var roadsCfg = this.theme.roads || { maxCastles: 6, castleSpacing: 0.30 };

    /* --- замки: по одному на ячейку сетки, чтобы карта была
     * заполнена равномерно, а не сбивалась в один угол. --- */
    var areaK = Math.min(2.2, Math.sqrt((W * H) / (1280 * 720)));
    var count = clamp(Math.round(this.params.roads * roadsCfg.maxCastles * areaK),
                      2, Math.round(roadsCfg.maxCastles * 2.2));
    var gridCols = count > 4 ? 3 : 2;
    var gridRows = 2;
    var cells = [];
    for (var gr = 0; gr < gridRows; gr++) {
      for (var gc = 0; gc < gridCols; gc++) cells.push([gc, gr]);
    }
    for (var ci = cells.length - 1; ci > 0; ci--) {
      var cj = Math.floor(rng() * (ci + 1));
      var tmp = cells[ci]; cells[ci] = cells[cj]; cells[cj] = tmp;
    }

    var minD = Math.min(W, H) * roadsCfg.castleSpacing;
    var castles = [];
    var cw = W / gridCols, ch = H / gridRows;

    for (var cell = 0; cell < cells.length && castles.length < count; cell++) {
      var cc = cells[cell][0], cr = cells[cell][1];
      var placed = false;
      for (var t = 0; t < 60 && !placed; t++) {
        var x = (cc + 0.5) * cw + (rng() - 0.5) * cw * 0.60;
        var y = (cr + 0.5) * ch + (rng() - 0.5) * ch * 0.60;
        x = clamp(x, 70, W - 70);
        y = clamp(y, 80, H - 80);
        if (this._inLake(x, y, 34)) continue;
        if (this._nearRiver(x, y, 26)) continue;
        if (this._inReserved(x, y, 30)) continue;
        if (this._inIconZone(x, y, 50)) continue;
        var ok = true;
        for (var k = 0; k < castles.length; k++) {
          if (Math.hypot(castles[k].x - x, castles[k].y - y) < minD) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        castles.push({ x: x, y: y });
        placed = true;
      }
    }

    // Запасной вариант, если какая-то ячейка целиком занята водой.
    var tries = 0;
    while (castles.length < count && tries < 800) {
      tries++;
      var rx = 70 + rng() * (W - 140);
      var ry = 80 + rng() * (H - 160);
      if (this._inLake(rx, ry, 34)) continue;
      if (this._nearRiver(rx, ry, 26)) continue;
      if (this._inReserved(rx, ry, 30)) continue;
      if (this._inIconZone(rx, ry, 50)) continue;
      var ok2 = true;
      for (var k2 = 0; k2 < castles.length; k2++) {
        if (Math.hypot(castles[k2].x - rx, castles[k2].y - ry) < minD * 0.75) {
          ok2 = false;
          break;
        }
      }
      if (ok2) castles.push({ x: rx, y: ry });
    }

    /* --- сеть дорог: минимальное остовное дерево --- */
    var edges = [];
    for (var i = 0; i < castles.length; i++) {
      for (var j = i + 1; j < castles.length; j++) {
        edges.push({
          a: i, b: j,
          d: Math.hypot(castles[i].x - castles[j].x, castles[i].y - castles[j].y)
        });
      }
    }
    edges.sort(function (p, q) { return p.d - q.d; });

    var uf = [];
    for (var u = 0; u < castles.length; u++) uf[u] = u;
    function find(a) {
      while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; }
      return a;
    }

    var roadPaths = [];
    var used = {};
    for (var e = 0; e < edges.length && roadPaths.length < castles.length - 1; e++) {
      var ed = edges[e];
      var ra = find(ed.a), rb = find(ed.b);
      if (ra === rb) continue;
      var pts = this._route(castles[ed.a], castles[ed.b]);
      if (!pts || pts.length < 3) continue;
      uf[ra] = rb;
      used[ed.a + ':' + ed.b] = true;
      roadPaths.push(pts);
    }

    // Пара коротких хорд, чтобы дороги шли не только цепочкой:
    // у образца сеть, а не одна линия.
    var chords = 0;
    for (var e2 = 0; e2 < edges.length && chords < 2; e2++) {
      var ed2 = edges[e2];
      if (used[ed2.a + ':' + ed2.b]) continue;
      if (ed2.d > Math.min(W, H) * 0.85) continue;
      var extra = this._route(castles[ed2.a], castles[ed2.b]);
      if (extra && extra.length >= 3) {
        used[ed2.a + ':' + ed2.b] = true;
        roadPaths.push(extra);
        chords++;
      }
    }

    var roads = [];
    for (var rp = 0; rp < roadPaths.length; rp++) {
      var p = roadPaths[rp];
      var cum = [0];
      for (var q = 1; q < p.length; q++) {
        cum.push(cum[q - 1] + Math.hypot(p[q].x - p[q - 1].x,
                                          p[q].y - p[q - 1].y));
      }
      roads.push({ points: p, cum: cum, length: cum[cum.length - 1] });
    }
    this._roadsForPlacement = roads;

    // Мосты: дороги могут пересекать реку, и это должно выглядеть
    // намеренно, а не как разрыв.
    this.bridges = [];
    for (var bi = 0; bi < roads.length; bi++) {
      var rpts = roads[bi].points;
      for (var bk = 1; bk < rpts.length; bk++) {
        for (var ri = 0; ri < this.rivers.length; ri++) {
          var vpts = this.rivers[ri].points;
          for (var rk = 1; rk < vpts.length; rk++) {
            var hit = segCross(rpts[bk - 1].x, rpts[bk - 1].y,
                               rpts[bk].x, rpts[bk].y,
                               vpts[rk - 1].x, vpts[rk - 1].y,
                               vpts[rk].x, vpts[rk].y);
            if (hit) {
              this.bridges.push({
                x: hit.x, y: hit.y,
                angle: Math.atan2(rpts[bk].y - rpts[bk - 1].y,
                                  rpts[bk].x - rpts[bk - 1].x)
              });
            }
          }
        }
      }
    }

    /* --- объекты --- */
    var objects = [];

    var EDGE = Math.max(180, Math.round(Math.min(W, H) * 0.24));

    // Пространственный хэш: без него проверка пересечений на 4K
    // превращается в десятки миллионов вызовов hypot.
    var CELL = 56;
    var buckets = new Map();
    function bucketKey(cx, cy) { return cx + ',' + cy; }
    function remember(x, y, r) {
      var k = bucketKey(Math.floor(x / CELL), Math.floor(y / CELL));
      var arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push({ x: x, y: y, r: r });
    }

    function free(x, y, r) {
      if (x < -EDGE || x > W + EDGE || y < -EDGE || y > H + EDGE) return false;
      if (self._inLake(x, y, 10)) return false;
      if (self._nearRiver(x, y, r + 2)) return false;
      if (self._inReserved(x, y, r)) return false;
      if (self._inIconZone(x, y, r + 18)) return false;

      var pad = r + 22;
      var c0 = Math.floor((x - pad) / CELL);
      var c1 = Math.floor((x + pad) / CELL);
      var r0 = Math.floor((y - pad) / CELL);
      var r1 = Math.floor((y + pad) / CELL);
      for (var cy = r0; cy <= r1; cy++) {
        for (var cx = c0; cx <= c1; cx++) {
          var arr = buckets.get(bucketKey(cx, cy));
          if (!arr) continue;
          for (var k = 0; k < arr.length; k++) {
            var d = Math.hypot(arr[k].x - x, arr[k].y - y);
            if (d < arr[k].r + r) return false;
          }
        }
      }
      return true;
    }

    function put(type, variants, x, y, scale, radius, roadPad) {
      if (!free(x, y, radius)) return false;
      if (roadPad && self._nearRoad(x, y, roadPad)) return false;
      objects.push({
        type: type,
        x: x,
        y: y,
        s: scale,
        v: Math.floor(rng() * variants.length),
        r: radius
      });
      remember(x, y, radius);
      return true;
    }

    /* 1. горные гряды — самое крупное, ставим первыми */
    var ranges = Math.round((20 + this.params.density * 18) * areaScale);
    for (var m = 0; m < ranges; m++) {
      var cx = 0, cy = 0, found = false;
      for (var mt = 0; mt < 80 && !found; mt++) {
        cx = -EDGE * 0.6 + rng() * (W + EDGE * 1.2);
        cy = -EDGE * 0.6 + rng() * (H + EDGE * 1.2);
        if (this._inLake(cx, cy, 24)) continue;
        if (this._inReserved(cx, cy, 40)) continue;
        if (this._nearCastle(castles, cx, cy, 105)) continue;
        found = true;
      }
      if (!found) continue;

      var ang = rng() * TAU;
      var len = 80 + rng() * 170;
      var n = 3 + Math.floor(rng() * 4);
      for (var mk = 0; mk < n; mk++) {
        var tt = n === 1 ? 0 : (mk / (n - 1) - 0.5);
        var mx = cx + Math.cos(ang) * len * tt + (rng() - 0.5) * 16;
        var my = cy + Math.sin(ang) * len * tt * 0.62 + (rng() - 0.5) * 12;
        var ms = 0.74 + rng() * 0.40;
        put('mountain', this._sprites.mountains, mx, my, ms, 13 * ms, 16);
      }
    }

    /* 2. замки: сначала башни, потом полоса под подпись, потом дома */
    for (var ci = 0; ci < castles.length; ci++) {
      var castleT = castles[ci];
      put('castle', this._sprites.castles, castleT.x, castleT.y,
          1.00 + rng() * 0.12, 17, 0);
    }

    for (var cn = 0; cn < castles.length; cn++) {
      this._reserved.push({
        x: castles[cn].x - 80,
        y: castles[cn].y - 78,
        w: 160,
        h: 26
      });
    }

    /* Дома вокруг замка: у образца это плотная кучка крыш, а не
     * отдельная башня. Держим их близко к стенам. */
    for (var cj = 0; cj < castles.length; cj++) {
      var castle = castles[cj];
      var hn = 10 + Math.floor(rng() * 4);
      for (var hk = 0; hk < hn; hk++) {
        var ha = rng() * TAU;
        var hr = 13 + Math.sqrt(rng()) * 27;
        var hx = castle.x + Math.cos(ha) * hr;
        var hy = castle.y + Math.sin(ha) * hr * 0.68;
        var hs = 0.62 + rng() * 0.22;
        put('house', this._sprites.houses, hx, hy, hs, 4.6 * hs, 0);
      }
    }

    /* Поля вокруг замков. */
    for (var fi = 0; fi < castles.length; fi++) {
      var fcst = castles[fi];
      var fnum = 2 + Math.floor(rng() * 3);
      for (var fk2 = 0; fk2 < fnum; fk2++) {
        var fa2 = rng() * TAU;
        var fr2 = 46 + rng() * 54;
        var fpx = fcst.x + Math.cos(fa2) * fr2;
        var fpy = fcst.y + Math.sin(fa2) * fr2 * 0.66;
        var fs2 = 0.8 + rng() * 0.4;
        put('field', this._sprites.fields, fpx, fpy, fs2, 9 * fs2, 8);
      }
    }

    /* 3. леса: плотные массивы по шуму. Так на карте появляются
     * настоящие лесные области, а не отдельные кучки деревьев. */
    var FSTEP = 21;
    for (var gy = -EDGE; gy < H + EDGE; gy += FSTEP) {
      for (var gx = -EDGE; gx < W + EDGE; gx += FSTEP) {
        var fx = gx + (rng() - 0.5) * FSTEP * 1.25;
        var fy = gy + (rng() - 0.5) * FSTEP * 1.25;
        var fnz = fbm(fx * 0.0021 + 7.3, fy * 0.0021 - 2.1, 4);
        var dens = smooth01((fnz - 0.40) / 0.18) * this.params.forest;
        if (rng() > dens) continue;
        if (this._inLake(fx, fy, 14)) continue;
        if (this._inReserved(fx, fy, 24)) continue;
        if (this._nearCastle(castles, fx, fy, 55)) continue;
        var ts = 0.68 + rng() * 0.34;
        put('tree', this._sprites.trees, fx, fy, ts, 4.8 * ts, 0);
      }
    }

    /* 4. одиночные деревья на открытых местах */
    var lone = Math.round((24 + this.params.forest * 16) * areaScale);
    for (var lt = 0; lt < lone; lt++) {
      var lx = -EDGE + rng() * (W + EDGE * 2);
      var ly = -EDGE + rng() * (H + EDGE * 2);
      var ls = 0.72 + rng() * 0.36;
      put('tree', this._sprites.trees, lx, ly, ls, 6 * ls, 8);
    }

    /* 5. камни */
    var rocks = Math.round((24 + this.params.density * 30) * areaScale);
    for (var rk = 0; rk < rocks; rk++) {
      var rx = -EDGE + rng() * (W + EDGE * 2);
      var ry = -EDGE + rng() * (H + EDGE * 2);
      var rs = 0.80 + rng() * 0.45;
      put('rock', this._sprites.rocks, rx, ry, rs, 6 * rs, 8);
    }

    /* 6. кустики */
    var bushes = Math.round((150 + this.params.forest * 130) * Math.min(areaScale, 2.2));
    for (var bu = 0; bu < bushes; bu++) {
      var bx = -EDGE + rng() * (W + EDGE * 2);
      var by = -EDGE + rng() * (H + EDGE * 2);
      var bs = 0.8 + rng() * 0.5;
      put('bush', this._sprites.bushes, bx, by, bs, 4, 5);
    }

    /* 7. холмики: заполняют пустой пергамент, как на образце */
    var hills = Math.round((50 + this.params.density * 44) * areaScale);
    for (var hl = 0; hl < hills; hl++) {
      var hx2 = -EDGE + rng() * (W + EDGE * 2);
      var hy2 = -EDGE + rng() * (H + EDGE * 2);
      var hs2 = 0.8 + rng() * 0.4;
      put('hill', this._sprites.hills, hx2, hy2, hs2, 5, 6);
    }

    objects.sort(function (a, b) { return a.y - b.y; });

    /* 8. травяные штрихи: самый мелкий слой, без проверок на пересечения */
    var tufts = [];
    var tuftCount = Math.round((900 + this.params.density * 600) * Math.min(areaScale, 1.8));
    for (var tf = 0; tf < tuftCount; tf++) {
      var tx2 = -EDGE + rng() * (W + EDGE * 2);
      var ty2 = -EDGE + rng() * (H + EDGE * 2);
      if (this._inLake(tx2, ty2, 6)) continue;
      if (this._nearRiver(tx2, ty2, 3)) continue;
      if (this._nearRoad(tx2, ty2, 5)) continue;
      if (this._inReserved(tx2, ty2, 4)) continue;
      if (this._inIconZone(tx2, ty2, 8)) continue;
      tufts.push({ x: tx2, y: ty2, s: 0.7 + rng() * 0.6, a: rng() * TAU });
    }

    this.world = {
      castles: castles,
      roads: roads,
      objects: objects,
      lakes: this.lakes,
      rivers: this.rivers,
      tufts: tufts
    };
    this.worldDirty = false;
    this.bakeDirty = true;
  };

  /* ---------- бумага ---------- */

  PaperEngine.prototype._ensurePaper = function () {
    var W = this.W, H = this.H, dpr = this.dpr;
    var key = W + 'x' + H + ':' + dpr + ':' + this.theme.id;
    if (this._paperKey === key) return;

    var p = this.theme.palette;
    var c = document.createElement('canvas');
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    var g = c.getContext('2d');
    g.scale(dpr, dpr);

    // Крупное мотло: низкое разрешение, потом растягиваем с сглаживанием.
    var mw = Math.max(64, Math.ceil(W / 10));
    var mh = Math.max(48, Math.ceil(H / 10));
    var mc = document.createElement('canvas');
    mc.width = mw; mc.height = mh;
    var mg = mc.getContext('2d');
    var base = hexToRgb(p.paper);
    var img = mg.createImageData(mw, mh);
    var data = img.data;
    for (var y = 0; y < mh; y++) {
      for (var x = 0; x < mw; x++) {
        var v = fbm(x * 0.065 + 3.7, y * 0.065 + 9.1, 4);
        var i = (y * mw + x) * 4;
        data[i] = base[0] + (v - 0.5) * 30;
        data[i + 1] = base[1] + (v - 0.5) * 28;
        data[i + 2] = base[2] + (v - 0.5) * 24;
        data[i + 3] = 255;
      }
    }
    mg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(mc, 0, 0, W, H);

    var rng = mulberry32(0x9e3779b9);

    // Пятна и выцветшие участки.
    for (var s = 0; s < 11; s++) {
      var sx = rng() * W, sy = rng() * H, sr = 90 + rng() * 280;
      var grad = g.createRadialGradient(sx, sy, 0, sx, sy, sr);
      grad.addColorStop(0, 'rgba(120,86,44,' + (0.025 + rng() * 0.035).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(120,86,44,0)');
      g.fillStyle = grad;
      g.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    }

    // Волокна бумаги.
    g.strokeStyle = 'rgba(96,73,43,0.05)';
    g.lineWidth = 0.6;
    for (var f = 0; f < 460; f++) {
      var fx = rng() * W, fy = rng() * H;
      var fl = 3 + rng() * 14;
      var fa = (rng() - 0.5) * 0.8;
      g.beginPath();
      g.moveTo(fx, fy);
      g.lineTo(fx + Math.cos(fa) * fl, fy + Math.sin(fa) * fl);
      g.stroke();
    }

    // Тёмные края, как у старого листа.
    var edge = Math.min(W, H) * 0.16;
    var eg = g.createLinearGradient(0, 0, 0, edge);
    eg.addColorStop(0, 'rgba(92,68,40,0.10)');
    eg.addColorStop(1, 'rgba(92,68,40,0)');
    g.fillStyle = eg;
    g.fillRect(0, 0, W, edge);
    g.save();
    g.translate(W, H);
    g.rotate(Math.PI);
    g.fillRect(0, 0, W, edge);
    g.restore();

    this._paper = c;
    this._paperKey = key;

    // Та же бумага с виньеткой: из неё вырезаются поляны под иконками.
    var v = document.createElement('canvas');
    v.width = c.width;
    v.height = c.height;
    var vg = v.getContext('2d');
    vg.drawImage(c, 0, 0);
    vg.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawVignette(vg);
    this._paperVig = v;
  };

  /* ---------- отрисовка ---------- */

  // Вода не должна затекать на островки иконок: вырезаем их из
  // области рисования. Иконки всё равно сверху, поэтому край аккуратный.
  PaperEngine.prototype._clipOutsideIcons = function (g, pad) {
    if (!this.icons.length) return false;
    g.beginPath();
    g.rect(0, 0, this.W, this.H);
    for (var i = 0; i < this.icons.length; i++) {
      var r = this.icons[i];
      g.rect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
    }
    g.clip('evenodd');
    return true;
  };

  PaperEngine.prototype._drawLakes = function (g) {
    var p = this.theme.palette;
    var lakes = this.lakes || [];

    for (var i = 0; i < lakes.length; i++) {
      var lake = lakes[i];
      this._lakePath(g, lake);

      g.save();
      g.strokeStyle = 'rgba(250,240,214,0.55)';
      g.lineWidth = 5;
      g.stroke();

      g.fillStyle = p.sea;
      g.fill();
      g.strokeStyle = p.ink;
      g.lineWidth = 1.1;
      g.stroke();

      // Горизонтальная штриховка внутри воды.
      g.clip();
      g.strokeStyle = p.seaLine;
      g.lineWidth = 0.8;
      var top = lake.cy - lake.ry * 1.2;
      var bottom = lake.cy + lake.ry * 1.2;
      for (var y = top; y < bottom; y += 7) {
        g.beginPath();
        for (var x = lake.cx - lake.rx * 1.3; x <= lake.cx + lake.rx * 1.3; x += 6) {
          var yy = y + Math.sin(x * 0.05 + lake.ph[0]) * 1.1;
          if (x === lake.cx - lake.rx * 1.3) g.moveTo(x, yy);
          else g.lineTo(x, yy);
        }
        g.stroke();
      }
      g.restore();
    }
  };

  PaperEngine.prototype._drawRivers = function (g) {
    var rivers = this.rivers || [];
    if (!rivers.length) return;
    var p = this.theme.palette;

    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (var i = 0; i < rivers.length; i++) {
      var pts = rivers[i].points;
      var w = rivers[i].width;

      g.strokeStyle = 'rgba(228,210,168,0.55)';
      g.lineWidth = w + 2.5;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var a = 1; a < pts.length; a++) g.lineTo(pts[a].x, pts[a].y);
      g.stroke();

      g.strokeStyle = p.river;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var b = 1; b < pts.length; b++) g.lineTo(pts[b].x, pts[b].y);
      g.stroke();
    }
    g.restore();
  };

  PaperEngine.prototype._drawTufts = function (g) {
    var tufts = (this.world && this.world.tufts) || [];
    if (!tufts.length) return;
    var p = this.theme.palette;

    g.save();
    g.strokeStyle = p.inkSoft;
    g.lineWidth = 0.8;
    g.lineCap = 'round';
    for (var i = 0; i < tufts.length; i++) {
      var t = tufts[i];
      var s = t.s;
      g.beginPath();
      g.moveTo(t.x, t.y);
      g.lineTo(t.x - 2 * s, t.y - 4 * s);
      g.moveTo(t.x, t.y);
      g.lineTo(t.x + 0.5 * s, t.y - 5 * s);
      g.moveTo(t.x, t.y);
      g.lineTo(t.x + 2.5 * s, t.y - 3.5 * s);
      g.stroke();
    }
    g.restore();
  };

  PaperEngine.prototype._drawRoads = function (g) {
    var roads = (this.world && this.world.roads) || [];
    if (!roads.length) return;
    var p = this.theme.palette;

    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';

    for (var i = 0; i < roads.length; i++) {
      var pts = roads[i].points;

      g.setLineDash([]);
      g.strokeStyle = 'rgba(250,240,214,0.50)';
      g.lineWidth = 4.5;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var a = 1; a < pts.length; a++) g.lineTo(pts[a].x, pts[a].y);
      g.stroke();

      g.setLineDash([1.5, 5]);
      g.strokeStyle = p.road;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var b = 1; b < pts.length; b++) g.lineTo(pts[b].x, pts[b].y);
      g.stroke();
    }
    g.restore();
  };

  PaperEngine.prototype._drawBridges = function (g) {
    var bridges = this.bridges || [];
    if (!bridges.length) return;
    var p = this.theme.palette;

    g.save();
    for (var i = 0; i < bridges.length; i++) {
      var b = bridges[i];
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.angle);
      g.fillStyle = p.paperLight;
      g.fillRect(-9, -3.5, 18, 7);
      g.strokeStyle = p.ink;
      g.lineWidth = 1;
      g.strokeRect(-9, -3.5, 18, 7);
      g.beginPath();
      g.moveTo(-6, -3.5); g.lineTo(-6, 3.5);
      g.moveTo(6, -3.5); g.lineTo(6, 3.5);
      g.stroke();
      g.restore();
    }
    g.restore();
  };

  PaperEngine.prototype._drawSpacedText = function (g, text, x, y, size, color, track, halo, italic) {
    g.save();
    g.font = (italic ? 'italic ' : '') + '600 ' + size + 'px "Liberation Serif", Georgia, "Times New Roman", serif';
    g.fillStyle = color;
    g.textBaseline = 'middle';

    var widths = [];
    var total = 0;
    for (var i = 0; i < text.length; i++) {
      var w = g.measureText(text[i]).width;
      widths.push(w);
      total += w + track;
    }
    total -= track;

    var cx = x - total * 0.5;
    if (halo) {
      g.strokeStyle = halo;
      g.lineWidth = 3;
      g.lineJoin = 'round';
      for (var h = 0; h < text.length; h++) {
        g.strokeText(text[h], cx, y);
        cx += widths[h] + track;
      }
      cx = x - total * 0.5;
    }
    for (var k = 0; k < text.length; k++) {
      g.fillText(text[k], cx, y);
      cx += widths[k] + track;
    }
    g.restore();
    return total;
  };

  PaperEngine.prototype._drawLabels = function (g) {
    var labels = this.theme.labels || [];
    var W = this.W, H = this.H;

    for (var i = 0; i < labels.length; i++) {
      var l = labels[i];
      this._drawSpacedText(g, l.text, l.x * W, l.y * H, l.size || 13,
                           'rgba(90,67,34,0.66)', l.track || 0, null, true);
    }
  };

  // Замки подписаны своим именем, как на старых картах. Подпись ставится
  // над башней, чтобы её не закрывали дома; повторов нет.
  PaperEngine.prototype._drawCastleNames = function (g) {
    var castles = (this.world && this.world.castles) || [];
    var names = this.theme.castleNames || [];
    if (!names.length) return;

    for (var i = 0; i < castles.length; i++) {
      var c = castles[i];
      this._drawSpacedText(g, names[i % names.length], c.x, c.y - 62,
                           12, 'rgba(90,67,34,0.68)', 0,
                           'rgba(214,190,144,0.55)', true);
    }
  };

  PaperEngine.prototype._drawCompass = function (g) {
    var cp = this.theme.compass;
    if (!cp) return;
    var p = this.theme.palette;
    var cx = cp.x * this.W, cy = cp.y * this.H, r = cp.r;

    g.save();
    g.translate(cx, cy);
    g.strokeStyle = p.inkSoft;
    g.fillStyle = p.inkSoft;
    g.lineWidth = 0.9;

    g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke();
    g.beginPath(); g.arc(0, 0, r * 0.72, 0, TAU); g.stroke();

    for (var i = 0; i < 8; i++) {
      var ang = i * TAU / 8 - Math.PI * 0.5;
      var len = (i % 2 === 0) ? r * 0.92 : r * 0.54;
      var wdt = (i % 2 === 0) ? 0.15 : 0.10;
      g.beginPath();
      g.moveTo(Math.cos(ang) * len, Math.sin(ang) * len);
      g.lineTo(Math.cos(ang + wdt) * r * 0.18, Math.sin(ang + wdt) * r * 0.18);
      g.lineTo(Math.cos(ang - wdt) * r * 0.18, Math.sin(ang - wdt) * r * 0.18);
      g.closePath();
      if (i % 2 === 0) {
        g.fillStyle = i === 0 ? p.inkSoft : 'rgba(90,70,48,0.22)';
        g.fill();
      }
      g.stroke();
    }

    g.font = '600 10px "Liberation Serif", Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(90,70,48,0.55)';
    g.fillText('N', 0, -r - 8);
    g.restore();
  };

  // «Островки» под иконками: не рамка и не карточка, а мягкая поляна
  // в лесу. Контур не рисуем — плотный лес вокруг сам образует остров.
  PaperEngine.prototype._iconSig = function () {
    var s = this.W + 'x' + this.H + ':';
    for (var i = 0; i < this.icons.length; i++) {
      var r = this.icons[i];
      s += Math.round(r.x) + ',' + Math.round(r.y) + ',' +
           Math.round(r.w) + ',' + Math.round(r.h) + ';';
    }
    return s;
  };

  PaperEngine.prototype._buildClearing = function () {
    var icons = this.icons;
    if (!icons.length) return null;

    // Маска в 1/8 разрешения: края получаются мягкими, как у поляны.
    var ms = 0.125;
    var mw = Math.max(1, Math.round(this.W * ms));
    var mh = Math.max(1, Math.round(this.H * ms));

    var mask = document.createElement('canvas');
    mask.width = mw;
    mask.height = mh;
    var mg = mask.getContext('2d');
    mg.scale(ms, ms);
    mg.fillStyle = '#fff';

    for (var i = 0; i < icons.length; i++) {
      var r = icons[i];
      var pad = 14;
      var x = r.x - pad, y = r.y - pad;
      var w = r.w + pad * 2, h = r.h + pad * 2;
      var cx = x + w * 0.5, cy = y + h * 0.5;
      var rx = w * 0.5, ry = h * 0.5;
      var rng = mulberry32(Math.round(r.x * 13 + r.y * 7 + r.w * 3 + r.h));
      var pts = [];
      var n = 18;
      for (var k = 0; k < n; k++) {
        var a = k / n * TAU;
        var wob = 0.90 + rng() * 0.10;
        pts.push([cx + Math.cos(a) * rx * wob,
                  cy + Math.sin(a) * ry * wob]);
      }
      blobPath(mg, pts);
      mg.fill();
    }

    // Внутри поляны — та же бумага с теми же пятнами и виньеткой.
    // Поэтому островок не выглядит наклейкой: видно только то, что
    // под ним нет деревьев и дорог.
    var out = document.createElement('canvas');
    out.width = Math.round(this.W * this.dpr);
    out.height = Math.round(this.H * this.dpr);
    var og = out.getContext('2d');
    og.imageSmoothingEnabled = true;
    og.scale(this.dpr, this.dpr);

    if (this._paperVig) {
      og.drawImage(this._paperVig, 0, 0, this.W, this.H);
    } else {
      og.fillStyle = this.theme.palette.paper;
      og.fillRect(0, 0, this.W, this.H);
      this._drawVignette(og);
    }

    // Поляна чуть светлее бумаги — иначе она невидима и кажется, что
    // лес просто вырезан справа от иконки. Текстуру при этом сохраняем.
    og.globalCompositeOperation = 'source-atop';
    og.globalAlpha = 0.16;
    og.fillStyle = this.theme.palette.paperLight;
    og.fillRect(0, 0, this.W, this.H);
    og.globalAlpha = 1;

    og.setTransform(1, 0, 0, 1, 0, 0);
    og.globalCompositeOperation = 'destination-in';
    og.drawImage(mask, 0, 0, out.width, out.height);

    return out;
  };

  PaperEngine.prototype._spriteFor = function (o) {
    var list = this._sprites[o.type + 's'];
    if (!list) return null;
    return list[o.v % list.length];
  };

  PaperEngine.prototype._drawObjects = function (g) {
    var objects = (this.world && this.world.objects) || [];

    for (var i = 0; i < objects.length; i++) {
      var o = objects[i];
      var spr = this._spriteFor(o);
      if (!spr) continue;

      var sw = spr.w * o.s, sh = spr.h * o.s;
      var x0 = o.x - spr.ax * o.s;
      var y0 = o.y - spr.ay * o.s;
      g.drawImage(spr.c, x0, y0, sw, sh);
    }
  };

  PaperEngine.prototype._drawVignette = function (g) {
    var p = this.theme.palette;
    var W = this.W, H = this.H;
    var grad = g.createRadialGradient(
      W * 0.5, H * 0.45, Math.min(W, H) * 0.35,
      W * 0.5, H * 0.45, Math.max(W, H) * 0.78);
    grad.addColorStop(0, 'rgba(80,55,30,0)');
    grad.addColorStop(1, p.paperEdge);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  };

  PaperEngine.prototype._drawFrame = function (g) {
    var W = this.W, H = this.H;
    g.save();
    g.strokeStyle = 'rgba(90,70,48,0.30)';
    g.lineWidth = 1;
    g.strokeRect(14, 14, W - 28, H - 28);
    g.strokeStyle = 'rgba(90,70,48,0.15)';
    g.strokeRect(20, 20, W - 40, H - 40);
    g.restore();
  };

  PaperEngine.prototype.bake = function () {
    var t0 = performance.now();
    if (this.worldDirty || !this.world) this.buildWorld();
    this._ensurePaper();

    var g = this.baseCtx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    g.drawImage(this._paper, 0, 0, this.W, this.H);
    g.save();
    var clipped = this._clipOutsideIcons(g, 10);
    this._drawRivers(g);
    this._drawLakes(g);
    if (clipped) g.restore();
    this._drawTufts(g);
    this._drawRoads(g);
    this._drawBridges(g);
    this._drawLabels(g);
    this._drawObjects(g);
    this._drawCastleNames(g);
    this._drawCompass(g);
    this._drawVignette(g);
    if (this.theme.frame !== false) this._drawFrame(g);

    this.bakeMs = performance.now() - t0;
    this.bakeDirty = false;
    this.displayDirty = true;
  };

  PaperEngine.prototype._ensureOverlay = function () {
    if (!this.overlayDirty) return;
    var t0 = performance.now();

    var g = this.overlayCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.overlay.width, this.overlay.height);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    var sig = this._iconSig();
    if (!this.icons.length) {
      this._clearingSig = sig;
      this._clearing = null;
      this.overlayDirty = false;
      this.overlayMs = 0;
      return;
    }

    if (this._clearingSig !== sig) {
      this._clearingSig = sig;
      this._clearing = this._buildClearing();
    }
    if (this._clearing) {
      g.imageSmoothingEnabled = true;
      g.drawImage(this._clearing, 0, 0, this.W, this.H);
    }

    this.overlayMs = performance.now() - t0;
    this.overlayDirty = false;
    this.displayDirty = true;
  };

  PaperEngine.prototype._drawUnits = function (g, t) {
    var n = Math.max(0, Math.min(10, Math.round(this.params.units || 0)));
    var roads = (this.world && this.world.roads) || [];
    if (!n || !roads.length) return;

    var carts = this._sprites.carts;
    var icons = this.icons;
    var margin = 6;

    for (var i = 0; i < n; i++) {
      var road = roads[i % roads.length];
      var dir = (i % 2 === 0) ? 1 : -1;
      var u = (i * 0.23 + t * 0.000028 * (0.90 + (i % 3) * 0.08)) * dir;
      var pt = pointOnPath(road, u);

      var hidden = false;
      for (var k = 0; k < icons.length; k++) {
        var r = icons[k];
        if (pt.x > r.x - margin && pt.x < r.x + r.w + margin &&
            pt.y > r.y - margin && pt.y < r.y + r.h + margin) {
          hidden = true;
          break;
        }
      }
      if (hidden) continue;

      var spr = carts[i % carts.length];
      var s = 1.0;
      g.save();
      g.translate(pt.x, pt.y);
      g.rotate(pt.angle + (dir < 0 ? Math.PI : 0));
      g.drawImage(spr.c, -spr.ax * s, -spr.ay * s, spr.w * s, spr.h * s);
      g.restore();
    }
  };

  PaperEngine.prototype._compose = function () {
    if (!this.displayDirty) return;
    var g = this.displayCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.base, 0, 0);
    g.drawImage(this.overlay, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.displayDirty = false;
  };

  PaperEngine.prototype.render = function (t) {
    var t0 = performance.now();
    if (this._iconsPending) {
      this._iconsPending = false;
      this.setIcons(this._pendingIcons);
      this._pendingIcons = null;
    }
    if (this._needsWorldRebuild &&
        performance.now() - this._iconChangedAt > this._rebuildDelay) {
      this._needsWorldRebuild = false;
      this.worldDirty = true;
      this.bakeDirty = true;
    }
    if (this.bakeDirty || this.worldDirty || !this.world) this.bake();
    this._ensureOverlay();
    this._compose();

    var g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.display, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawUnits(g, t || 0);

    this.frameMs = performance.now() - t0;
    if (this.onFrame) this.onFrame(this);
  };

  global.PaperEngine = PaperEngine;
})(window);
