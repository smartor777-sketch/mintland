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

  function segIntersect(a, b, c, d) {
    var rx = b.x - a.x, ry = b.y - a.y;
    var sx = d.x - c.x, sy = d.y - c.y;
    var den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return false;
    var t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    var u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
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
  /* Замок: плотная кучка высоких домов с острыми крышами, как на
   * старых картах. Центральная башня выше остальных и с флагом. */
  function drawCastle(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 6;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };

    g.save();
    g.translate(ax, ay);

    g.fillStyle = p.shadow;
    g.beginPath();
    g.ellipse(2, -1, 22, 3.8, 0, 0, TAU);
    g.fill();

    // Один дом: прямоугольное тело, острая крыша, два окна.
    // x, y — центр основания; bw — ширина; bh — высота стен.
    function house(x, y, bw, bh, flag) {
      var roofH = bw * 0.85;
      var half = bw * 0.5;

      g.strokeStyle = p.ink;
      g.lineWidth = 1.25;
      g.lineJoin = 'round';

      // Стена.
      g.fillStyle = p.paperLight;
      g.beginPath();
      g.rect(x - half, y - bh, bw, bh);
      g.fill();
      g.stroke();

      // Крыша: треугольник с небольшим свесом.
      g.fillStyle = p.wallLeft;
      g.beginPath();
      g.moveTo(x - half - 1.2, y - bh);
      g.lineTo(x + half + 1.2, y - bh);
      g.lineTo(x, y - bh - roofH);
      g.closePath();
      g.fill();
      g.stroke();

      // Теневая правая половина крыши — как на гравюре.
      g.fillStyle = p.stoneDark;
      g.globalAlpha = 0.55;
      g.beginPath();
      g.moveTo(x, y - bh - roofH);
      g.lineTo(x + half + 1.2, y - bh);
      g.lineTo(x, y - bh);
      g.closePath();
      g.fill();
      g.globalAlpha = 1;

      // Окна.
      g.fillStyle = p.ink;
      var ww = Math.max(1.4, bw * 0.16);
      var gap = bw * 0.22;
      g.fillRect(x - gap - ww * 0.5, y - bh * 0.62, ww, ww);
      g.fillRect(x + gap - ww * 0.5, y - bh * 0.62, ww, ww);

      // Флаг на центральной башне.
      if (flag) {
        g.strokeStyle = p.ink;
        g.lineWidth = 1.1;
        g.beginPath();
        g.moveTo(x, y - bh - roofH);
        g.lineTo(x, y - bh - roofH - 9);
        g.stroke();
        g.fillStyle = p.roofLeft;
        g.beginPath();
        g.moveTo(x, y - bh - roofH - 9);
        g.lineTo(x + 7, y - bh - roofH - 6.6);
        g.lineTo(x, y - bh - roofH - 4.2);
        g.closePath();
        g.fill();
        g.stroke();
      }
    }

    // Задний ряд.
    house(-12, -6, 9, 17, false);
    house(12, -6, 9, 17, false);

    // Центральная башня.
    house(0, -2, 11, 30, true);

    // Средний ряд.
    house(-18, 4, 8.5, 15, false);
    house(18, 4, 8.5, 15, false);

    // Передний ряд: ниже всех и ближе к зрителю.
    house(-8, 12, 10, 16, false);
    house(8, 12, 10, 16, false);

    g.restore();
  }

  function makeCastle(seed, p) {
    var rng = mulberry32(seed);
    var w = 54, h = 68, ax = 27, ay = 62;
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
  /* Поле: ромб с бороздами. Борозды идут вдоль одной из сторон ромба,
   * а не пересекают его — иначе поле читается как пустой ромб. */
  /* Поле: ромб с бороздами. Борозды рисуем по клипу ромба, чтобы они
   * гарантированно заполняли его и не вылезали за контур. */
  function drawField(g, w, h, p, rng) {
    var ax = w * 0.5, ay = h - 4;
    var spr = { ink: p.ink, inkSoft: p.inkSoft };
    var rx = 13, ry = 6;

    g.save();
    g.translate(ax, ay);

    g.fillStyle = p.paperLight;
    g.beginPath();
    g.moveTo(-rx, 0); g.lineTo(0, ry); g.lineTo(rx, 0); g.lineTo(0, -ry);
    g.closePath();
    g.fill();
    setInk(g, spr, 1);
    g.stroke();

    // Борозды внутри ромба.
    g.save();
    g.beginPath();
    g.moveTo(-rx, 0); g.lineTo(0, ry); g.lineTo(rx, 0); g.lineTo(0, -ry);
    g.closePath();
    g.clip();

    g.strokeStyle = p.inkSoft;
    g.lineWidth = 0.7;
    for (var k = -rx + 3; k < rx; k += 3.2) {
      g.beginPath();
      g.moveTo(k, -ry - 1);
      g.lineTo(k + ry * 2, ry + 1);
      g.stroke();
    }
    g.restore();

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

  /* Кораблик: трёхмачтовый парусник, как на референсе. Прямые паруса
   * ярусами, тёмный корпус с ватерлинией, тень-отражение под днищем.
   * Привязка — ватерлиния, чтобы покачивание шло вокруг воды. */
  function makeBoat(seed, p) {
    var rng = mulberry32(seed);
    var w = 56, h = 62, ax = 28, ay = 50;
    return makeSprite(w, h, ax, ay, function (g) {
      g.translate(ax, ay);

      g.strokeStyle = p.ink;
      g.lineWidth = 1.15;
      g.lineJoin = 'round';
      g.lineCap = 'round';

      // Отражение и ватерлиния.
      g.fillStyle = 'rgba(70,51,29,0.14)';
      g.beginPath();
      g.ellipse(1, 9.5, 16, 2.4, 0, 0, TAU);
      g.fill();

      g.strokeStyle = p.inkSoft;
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(-17, 7); g.lineTo(17, 7);
      g.stroke();

      g.strokeStyle = p.ink;
      g.lineWidth = 1.15;

      // Корпус: высокий борт, крутой нос и корма.
      g.fillStyle = p.wood;
      g.beginPath();
      g.moveTo(-16, -3);
      g.quadraticCurveTo(-13, 5, -6, 6.5);
      g.lineTo(7, 6.5);
      g.quadraticCurveTo(14, 5, 17, -3);
      g.quadraticCurveTo(9, 1.5, 0, 1.5);
      g.quadraticCurveTo(-9, 1.5, -16, -3);
      g.closePath();
      g.fill(); g.stroke();

      // Тёмная нижняя часть борта.
      g.save();
      g.beginPath();
      g.moveTo(-16, -3);
      g.quadraticCurveTo(-13, 5, -6, 6.5);
      g.lineTo(7, 6.5);
      g.quadraticCurveTo(14, 5, 17, -3);
      g.quadraticCurveTo(9, 1.5, 0, 1.5);
      g.quadraticCurveTo(-9, 1.5, -16, -3);
      g.closePath();
      g.clip();
      g.fillStyle = p.roofRight;
      g.globalAlpha = 0.55;
      g.fillRect(-18, 1, 36, 7);
      g.globalAlpha = 1;
      g.restore();

      // Палуба.
      g.strokeStyle = p.inkSoft;
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(-13, -1.2);
      g.quadraticCurveTo(0, 2.2, 13, -1.2);
      g.stroke();

      // Мачты: фок, грот, бизань.
      function mast(mx, top) {
        g.strokeStyle = p.ink;
        g.lineWidth = 1.25;
        g.beginPath();
        g.moveTo(mx, -1);
        g.lineTo(mx, top);
        g.stroke();
      }

      // Прямой парус: прямоугольник с выпуклыми шкаторинами.
      function sail(cx, top, bottom, halfW) {
        var mid = (top + bottom) * 0.5;
        g.fillStyle = p.paperLight;
        g.strokeStyle = p.ink;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx - halfW, top);
        g.lineTo(cx + halfW, top);
        g.quadraticCurveTo(cx + halfW * 0.72, mid, cx + halfW, bottom);
        g.lineTo(cx - halfW, bottom);
        g.quadraticCurveTo(cx - halfW * 0.72, mid, cx - halfW, top);
        g.closePath();
        g.fill(); g.stroke();

        // Рейхи — тонкие линии сверху и снизу.
        g.strokeStyle = p.ink;
        g.lineWidth = 1.1;
        g.beginPath();
        g.moveTo(cx - halfW - 1.2, top);
        g.lineTo(cx + halfW + 1.2, top);
        g.moveTo(cx - halfW - 1.2, bottom);
        g.lineTo(cx + halfW + 1.2, bottom);
        g.stroke();
      }

      var jitter = (rng() - 0.5) * 0.6;

      mast(-9, -30);
      mast(0, -44);
      mast(10, -26);

      // Фок: два яруса.
      sail(-9, -27 + jitter, -19, 7);
      sail(-9, -17, -9, 8);

      // Грот: два широких яруса.
      sail(0, -41, -32, 8.5);
      sail(0, -29, -18, 9.5);

      // Бизань.
      sail(10, -23, -13, 6);

      // Вымпелы на верхушках.
      g.fillStyle = p.roofLeft;
      g.strokeStyle = p.ink;
      g.lineWidth = 0.9;
      g.beginPath();
      g.moveTo(0, -44);
      g.lineTo(6, -42.4);
      g.lineTo(0, -40.8);
      g.closePath();
      g.fill(); g.stroke();

      g.beginPath();
      g.moveTo(-9, -30);
      g.lineTo(-4.5, -28.8);
      g.lineTo(-9, -27.6);
      g.closePath();
      g.fill(); g.stroke();
    });
  }

  /* Тыковка у избушки: приплюснутый плод с долками и хвостиком. */
  function makePumpkin(seed, p) {
    var rng = mulberry32(seed);
    var w = 26, h = 22, ax = 13, ay = 18;
    return makeSprite(w, h, ax, ay, function (g) {
      g.translate(ax, ay);

      g.fillStyle = p.shadow;
      g.beginPath();
      g.ellipse(1, 0, 8.5, 2.2, 0, 0, TAU);
      g.fill();

      var fill = p.roofLeft;
      g.strokeStyle = p.ink;
      g.lineWidth = 1;

      // Три дольки: средняя выше, боковые ниже.
      var lobes = [
        [-5.2, 7, 6.4],
        [0, 8, 7.4],
        [5.2, 7, 6.4]
      ];
      g.fillStyle = fill;
      for (var i = 0; i < lobes.length; i++) {
        g.beginPath();
        g.ellipse(lobes[i][0], -lobes[i][2] + 1.5, lobes[i][1] * 0.72,
                  lobes[i][2], 0, 0, TAU);
        g.fill();
        g.stroke();
      }

      // Бороздки между долек.
      g.strokeStyle = p.inkSoft;
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(-2.4, -12); g.lineTo(-2.4, -1);
      g.moveTo(2.4, -12); g.lineTo(2.4, -1);
      g.stroke();

      // Хвостик.
      g.strokeStyle = p.ink;
      g.lineWidth = 1.6;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(1.5, -13.5);
      g.quadraticCurveTo(3.2, -16.5, 1, -18);
      g.stroke();
    });
  }

  /* Котик у избы: сидит, хвост трубой. Рисуем в том же ключе, что и
   * остальные объекты — светлая заливка и контур тушью, иначе на карте
   * он читается просто чёрным пятном. */
  function makeCat(seed, p, sleeping) {
    var w = 22, h = 22, ax = 11, ay = 18;
    return makeSprite(w, h, ax, ay, function (g) {
      g.translate(ax, ay);

      g.fillStyle = p.shadow;
      g.beginPath();
      g.ellipse(1, 0, 6.5, 1.9, 0, 0, TAU);
      g.fill();

      g.strokeStyle = p.ink;
      g.lineWidth = 1.05;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.fillStyle = p.wallRight;

      if (sleeping) {
        // Свернулся калачиком.
        g.beginPath();
        g.ellipse(-0.5, -3.8, 6.8, 3.5, 0, 0, TAU);
        g.fill(); g.stroke();

        g.beginPath();
        g.arc(4.0, -6.0, 2.2, 0, TAU);
        g.fill(); g.stroke();

        // Ушки.
        g.beginPath();
        g.moveTo(3.2, -7.6); g.lineTo(4.2, -9.6); g.lineTo(5.6, -7.4);
        g.closePath(); g.fill(); g.stroke();

        // Хвост вокруг тела.
        g.beginPath();
        g.moveTo(-6.4, -2.6);
        g.quadraticCurveTo(-9.0, -5.4, -6.0, -7.0);
        g.stroke();

        // Закрытые глаза.
        g.beginPath();
        g.moveTo(4.6, -6.2); g.lineTo(5.8, -6.0);
        g.stroke();
        return;
      }

      // Сидящее тело.
      g.beginPath();
      g.ellipse(0, -4.6, 4.0, 5.4, 0, 0, TAU);
      g.fill(); g.stroke();

      // Голова.
      g.beginPath();
      g.arc(0.4, -11.0, 3.5, 0, TAU);
      g.fill(); g.stroke();

      // Уши.
      g.beginPath();
      g.moveTo(-2.6, -12.6); g.lineTo(-3.2, -16.0); g.lineTo(-0.2, -13.8);
      g.closePath(); g.fill(); g.stroke();
      g.beginPath();
      g.moveTo(2.8, -12.6); g.lineTo(3.8, -15.8); g.lineTo(0.8, -13.8);
      g.closePath(); g.fill(); g.stroke();

      // Хвост трубой.
      g.beginPath();
      g.moveTo(-3.2, -2.4);
      g.quadraticCurveTo(-8.6, -4.6, -6.4, -11.2);
      g.stroke();

      // Мордочка: глаза и нос.
      g.fillStyle = p.ink;
      g.beginPath(); g.arc(-1.2, -11.2, 0.7, 0, TAU); g.fill();
      g.beginPath(); g.arc(1.8, -11.2, 0.7, 0, TAU); g.fill();
      g.beginPath();
      g.moveTo(0.3, -9.9); g.lineTo(1.5, -9.9); g.lineTo(0.9, -9.1);
      g.closePath(); g.fill();
    });
  }

  /* Маяк: сужающаяся полосатая башня, галерея, фонарь и купол. */
  function makeLighthouse(seed, p) {
    var w = 30, h = 56, ax = 15, ay = 49;
    return makeSprite(w, h, ax, ay, function (g) {
      g.translate(ax, ay);

      g.fillStyle = p.shadow;
      g.beginPath();
      g.ellipse(2, 0, 11, 2.8, 0, 0, TAU);
      g.fill();

      g.strokeStyle = p.ink;
      g.lineWidth = 1.2;
      g.lineJoin = 'round';

      g.fillStyle = p.mountain;
      g.beginPath();
      g.moveTo(-12, 0); g.lineTo(-9, -6); g.lineTo(-3, -9);
      g.lineTo(4, -8); g.lineTo(10, -4); g.lineTo(13, 0);
      g.closePath(); g.fill(); g.stroke();

      g.fillStyle = p.stone;
      g.beginPath();
      g.moveTo(-7, -8); g.lineTo(-4, -34); g.lineTo(4, -34); g.lineTo(7, -8);
      g.closePath(); g.fill(); g.stroke();

      g.save();
      g.beginPath();
      g.moveTo(-7, -8); g.lineTo(-4, -34); g.lineTo(4, -34); g.lineTo(7, -8);
      g.closePath();
      g.clip();
      g.fillStyle = p.roofLeft;
      g.fillRect(-8, -16, 16, 4.5);
      g.fillRect(-8, -25, 16, 4);
      g.restore();

      g.strokeStyle = p.ink;
      g.lineWidth = 1.1;
      g.fillStyle = p.stoneDark;
      g.beginPath();
      g.moveTo(-6.5, -34); g.lineTo(6.5, -34);
      g.lineTo(5.5, -37.5); g.lineTo(-5.5, -37.5);
      g.closePath(); g.fill(); g.stroke();

      g.fillStyle = 'rgba(244,232,204,0.95)';
      g.fillRect(-3.2, -44, 6.4, 6.5);
      g.strokeRect(-3.2, -44, 6.4, 6.5);

      g.fillStyle = p.roofLeft;
      g.beginPath();
      g.moveTo(-4.4, -44); g.lineTo(0, -49); g.lineTo(4.4, -44);
      g.closePath(); g.fill(); g.stroke();
    });
  }

  /* Лучик маяка: конус света, рисуется в динамическом слое. */
  function makeBeam(seed, p) {
    var w = 64, h = 26, ax = 6, ay = 13;
    return makeSprite(w, h, ax, ay, function (g) {
      g.translate(ax, ay);
      var grad = g.createLinearGradient(0, 0, w * 0.85, 0);
      grad.addColorStop(0, 'rgba(250,240,206,0.42)');
      grad.addColorStop(1, 'rgba(250,240,206,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, -2.5);
      g.lineTo(w * 0.85, -h * 0.42);
      g.lineTo(w * 0.85, h * 0.42);
      g.lineTo(0, 2.5);
      g.closePath();
      g.fill();
    });
  }

  function makeWitch(seed, p) {
    var rng = mulberry32(seed);
    var w = 56, h = 52, ax = 28, ay = 44;
    return makeSprite(w, h, ax, ay, function (g) {
      g.translate(ax, ay);

      g.fillStyle = p.shadow;
      g.beginPath();
      g.ellipse(2, 0, 17, 3.6, 0, 0, TAU);
      g.fill();

      g.strokeStyle = p.ink;
      g.lineWidth = 1.2;
      g.lineJoin = 'round';

      // Лужица справа от избы.
      g.fillStyle = p.sea;
      g.beginPath();
      g.ellipse(18, 0.5, 8, 2.6, 0, 0, TAU);
      g.fill();
      g.strokeStyle = p.inkSoft;
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(14, 0.5); g.lineTo(22, 0.5);
      g.stroke();

      // Изба, слегка покосившаяся.
      g.save();
      g.rotate(-0.035);
      g.strokeStyle = p.ink;
      g.lineWidth = 1.2;

      g.fillStyle = p.wallLeft;
      g.beginPath();
      g.moveTo(-9, 0); g.lineTo(0, 4); g.lineTo(0, -17); g.lineTo(-9, -21);
      g.closePath(); g.fill(); g.stroke();

      g.fillStyle = p.wallRight;
      g.beginPath();
      g.moveTo(0, 4); g.lineTo(9, 0); g.lineTo(9, -21); g.lineTo(0, -17);
      g.closePath(); g.fill(); g.stroke();

      // Брёвна на стене.
      g.strokeStyle = p.inkSoft;
      g.lineWidth = 0.8;
      for (var k = 1; k <= 3; k++) {
        var yy = -4 - k * 4;
        g.beginPath();
        g.moveTo(-8.5, yy - 1);
        g.lineTo(-0.5, yy + 2.5);
        g.stroke();
      }

      // Кривая крыша.
      g.strokeStyle = p.ink;
      g.lineWidth = 1.2;
      g.fillStyle = p.roofLeft;
      g.beginPath();
      g.moveTo(-13, -20);
      g.lineTo(0, -14);
      g.lineTo(13, -20);
      g.quadraticCurveTo(9, -30, 5, -36);
      g.quadraticCurveTo(1, -31, -5, -34);
      g.quadraticCurveTo(-9, -28, -13, -20);
      g.closePath();
      g.fill(); g.stroke();

      // Труба и дымок.
      g.fillStyle = p.stoneDark;
      g.fillRect(4, -33, 4, 7);
      g.strokeRect(4, -33, 4, 7);
      g.strokeStyle = p.inkSoft;
      g.lineWidth = 0.9;
      g.beginPath();
      g.moveTo(6, -35);
      g.quadraticCurveTo(9, -38, 6.5, -41);
      g.quadraticCurveTo(4, -44, 7, -46);
      g.stroke();

      // Дверь и окошко.
      g.fillStyle = 'rgba(90,70,48,0.6)';
      g.fillRect(2, -8, 4, 9);
      g.fillStyle = 'rgba(244,232,204,0.8)';
      g.fillRect(-6, -14, 3.5, 3.5);
      g.strokeStyle = p.ink;
      g.lineWidth = 0.9;
      g.strokeRect(-6, -14, 3.5, 3.5);

      g.restore();

      // Забор слева.
      g.strokeStyle = p.ink;
      g.lineWidth = 1;
      for (var f = 0; f < 3; f++) {
        var fx = -20 + f * 5;
        g.beginPath();
        g.moveTo(fx, 0);
        g.lineTo(fx, -7);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(-21, -4.5);
      g.lineTo(-9, -4.5);
      g.stroke();
    });
  }

  /* Ворон: два кадра взмаха. Силуэт, чтобы читался на любом фоне. */
  function makeBird(seed, p, flap) {
    var w = 18, h = 12, ax = 9, ay = 6;
    return makeSprite(w, h, ax, ay, function (g) {
      g.translate(ax, ay);
      g.fillStyle = p.ink;
      g.strokeStyle = p.ink;
      g.lineWidth = 1.1;
      g.lineCap = 'round';
      g.lineJoin = 'round';

      g.beginPath();
      g.ellipse(0, 0, 2.4, 1.3, 0, 0, TAU);
      g.fill();
      g.beginPath();
      g.arc(2.4, -0.8, 1.2, 0, TAU);
      g.fill();

      g.beginPath();
      if (flap) {
        g.moveTo(-0.5, 0);
        g.quadraticCurveTo(-5, -6, -9, -4.5);
        g.quadraticCurveTo(-5.5, -2.2, -0.5, 0);
        g.moveTo(0.5, 0);
        g.quadraticCurveTo(5, -6, 8.5, -4);
        g.quadraticCurveTo(5, -1.8, 0.5, 0);
      } else {
        g.moveTo(-0.5, 0);
        g.quadraticCurveTo(-6, -1, -9, 2);
        g.quadraticCurveTo(-5, 1.2, -0.5, 0);
        g.moveTo(0.5, 0);
        g.quadraticCurveTo(5.5, -0.5, 8.5, 2.2);
        g.quadraticCurveTo(4.8, 1.2, 0.5, 0);
      }
      g.fill();

      g.beginPath();
      g.moveTo(-2, 0);
      g.lineTo(-5, 1.6);
      g.lineTo(-2, 0.8);
      g.closePath();
      g.fill();
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

    // Слой воды: реки и озёра рисуются отдельно, затем вокруг иконок
    // вырезается мягкая «бухта», и только потом слой кладётся на бумагу.
    this.water = document.createElement('canvas');
    this.waterCtx = this.water.getContext('2d');
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
    var s = { trees: [], houses: [], mountains: [], rocks: [], castles: [], carts: [], hills: [], bushes: [], fields: [], boats: [], witches: [], birds: [], lighthouses: [], beams: [], pumpkins: [], cats: [] };
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
    for (i = 0; i < 3; i++) s.boats.push(makeBoat(0xfc00 + i * 37, p));
    for (i = 0; i < 2; i++) s.witches.push(makeWitch(0xfe00 + i * 61, p));
    for (i = 0; i < 2; i++) s.birds.push(makeBird(0xff00 + i * 29, p, i === 0));
    for (i = 0; i < 2; i++) s.lighthouses.push(makeLighthouse(0xaa00 + i * 43, p));
    for (i = 0; i < 2; i++) s.beams.push(makeBeam(0xab00 + i * 47, p));
    for (i = 0; i < 3; i++) s.pumpkins.push(makePumpkin(0xac00 + i * 31, p));
    s.cats.push(makeCat(0xad00, p, false));
    s.cats.push(makeCat(0xad40, p, true));
    this._sprites = s;
  };

  PaperEngine.prototype.setTheme = function (theme) {
    this.theme = theme;
    this.params = Object.assign({}, theme.defaults);
    this._seed = theme.seed || 0x51ed270b;
    this._paperKey = '';
    this.overlayDirty = true;
    this.displayDirty = true;
    this._buildSprites();
    this.worldDirty = true;
    this.bakeDirty = true;
  };

  PaperEngine.prototype.setParams = function (v) {
    var keys = ['density', 'forest', 'roads', 'units', 'cap30', 'island', 'birds'];
    var world = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (typeof v[k] !== typeof this.params[k]) continue;
      if (this.params[k] === v[k]) continue;
      this.params[k] = v[k];
      if (k === 'density' || k === 'forest' || k === 'roads' || k === 'island') world = true;
    }
    if (world) this.worldDirty = true;

    // Ползунок острова: сама подложка меняется сразу (это дёшево), а
    // мир пересобирается с задержкой — иначе каждый шаг ползунка
    // вызывал бы полную перестройку A*.
    if (Object.prototype.hasOwnProperty.call(v, 'island')) {
      this.overlayDirty = true;
      this.displayDirty = true;
      this.worldDirty = false;
      this._needsWorldRebuild = true;
      this._iconChangedAt = performance.now();
    }
  };

  PaperEngine.prototype.setIcons = function (icons) {
    var before = this._iconSig();
    this.icons = icons || [];
    var after = this._iconSig();

    // Немедленно обновляем поляны — при перетаскивании это дешёвый слой.
    this.overlayDirty = true;
    this.displayDirty = true;
    this.lastIconMove = performance.now();

    // А сам мир (лес, дороги, замки) пересоберём, когда иконка
    // остановится: карта должна обтекать островки, а не просто
    // закрываться подложкой.
    if (before !== after) {
      if (!before) {
        // Первый набор иконок после запуска: ждать нечего, пересобираем
        // сразу, иначе на старте в островках успевают появиться деревья.
        this.worldDirty = true;
        this.bakeDirty = true;
      } else {
        this._needsWorldRebuild = true;
        this._iconChangedAt = performance.now();
      }
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

    this.water.width = this.cv.width;
    this.water.height = this.cv.height;
    this.waterCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this._paperKey = '';
    this.overlayDirty = true;
    this.worldDirty = true;
    this.bakeDirty = true;
  };

  /* ---------- озёра ---------- */

  // Озёра целиком внутри листа и никогда не под иконками. Если на
  // исходном месте не помещаются, ищем свободное место по сетке; если
  // и там тесно — уменьшаем. Так верхнее озеро больше не наезжает на
  // колонку значков.
  PaperEngine.prototype._buildLakes = function (rng) {
    var W = this.W, H = this.H;
    var list = this.theme.lakes || [];
    var out = [];
    var placed = [];

    for (var i = 0; i < list.length; i++) {
      var cfg = list[i];
      var baseRx = Math.max(18, cfg.rx * W);
      var baseRy = Math.max(11, cfg.ry * H);
      var best = null;

      for (var shrink = 1; shrink >= 0.48; shrink -= 0.12) {
        var rx = baseRx * shrink;
        var ry = baseRy * shrink;

        // Форма гуляет на ±10%, плюс светлый берег и тень: берём
        // запас 35%, чтобы озеро гарантированно не касалось кромки.
        var mX = rx * 1.35, mY = ry * 1.35;
        var minX = mX, maxX = W - mX;
        var minY = mY, maxY = H - mY;
        if (maxX <= minX || maxY <= minY) continue;

        var cands = [];
        var ox = clamp(cfg.x * W, minX, maxX);
        var oy = clamp(cfg.y * H, minY, maxY);
        cands.push({ x: ox, y: oy });

        var stepX = Math.max(56, rx * 0.75);
        var stepY = Math.max(46, ry * 0.75);
        for (var gy = minY; gy <= maxY + 1; gy += stepY) {
          for (var gx = minX; gx <= maxX + 1; gx += stepX) {
            cands.push({ x: gx, y: gy });
          }
        }

        for (var c = 0; c < cands.length; c++) {
          var cx = cands[c].x, cy = cands[c].y;

          // Не ставим озеро на подписи и компас.
          if (this._inReserved(cx, cy, Math.max(rx, ry) * 0.6)) continue;

          // Зазор до иконок: прямоугольник озера + отступ островка.
          var clear = Infinity;
          for (var k = 0; k < this.icons.length; k++) {
            var r = this.icons[k];
            var dx = Math.max(r.x - (cx + rx * 1.1), 0, (cx - rx * 1.1) - (r.x + r.w));
            var dy = Math.max(r.y - (cy + ry * 1.1), 0, (cy - ry * 1.1) - (r.y + r.h));
            var d = Math.hypot(dx, dy);
            if (d < clear) clear = d;
          }
          if (this.icons.length && clear < this._islandPad() + 26) continue;

          // Не сливаемся с другим озером.
          var clash = false;
          for (var q = 0; q < placed.length; q++) {
            var o = placed[q];
            if (Math.hypot(o.cx - cx, o.cy - cy) <
                (o.rx + rx) * 1.15 + 24) { clash = true; break; }
          }
          if (clash) continue;

          var distHome = Math.hypot(cx - cfg.x * W, cy - cfg.y * H);
          var score = clear * 2 - distHome * 0.15;
          if (!best || score > best.score) {
            best = { x: cx, y: cy, rx: rx, ry: ry, score: score };
          }
        }

        if (best) break;
      }

      if (!best) continue;

      out.push({
        cx: best.x,
        cy: best.y,
        rx: best.rx,
        ry: best.ry,
        ph: [rng() * TAU, rng() * TAU, rng() * TAU],
        amp: [0.10, 0.055, 0.03],
        name: cfg.name || ''
      });
      placed.push({ cx: best.x, cy: best.y, rx: best.rx, ry: best.ry });
    }

    this._lakeHome = out.map(function (l) { return { cx: l.cx, cy: l.cy }; });
    this.lakes = out;
  };

  // По одному кораблику на озеро. Ходит по внутреннему эллипсу,
  // поэтому никогда не вылезает на берег; покачивание — в рендере.
  PaperEngine.prototype._buildBoats = function (rng) {
    var out = [];
    var lakes = this.lakes || [];
    for (var i = 0; i < lakes.length; i++) {
      var l = lakes[i];
      if (l.rx < 34 || l.ry < 20) continue;
      out.push({
        lake: i,
        phase: rng() * TAU,
        speed: 0.000028 + rng() * 0.000014,
        turn: rng() * TAU,
        bob: 0.6 + rng() * 0.8,
        v: Math.floor(rng() * 3)
      });
    }
    this.boats = out;
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

  // Точка на кромке озера в направлении (tx, ty). k < 1 — чуть внутри
  // воды, чтобы линия начиналась под берегом, а не в воздухе.
  PaperEngine.prototype._lakeRim = function (lake, tx, ty, k) {
    var ang = Math.atan2((ty - lake.cy) / lake.ry, (tx - lake.cx) / lake.rx);
    var r = this._lakeEdge(lake, ang) * (k == null ? 0.72 : k);
    return {
      x: lake.cx + Math.cos(ang) * lake.rx * r,
      y: lake.cy + Math.sin(ang) * lake.ry * r
    };
  };

  // Вода строится ОТ размещённых озёр, а не по фиксированным координатам.
  // Одно русло проходит через все озёра цепочкой и уходит за края листа.
  // Поэтому:
  //   • каждая протока действительно соединяет озёра;
  //   • нет раздвоенных русел (цепочка, а не дерево);
  //   • нет самопересечений и пересечений между руслами — каждая дуга
  //     проверяется по уже построенным.
  PaperEngine.prototype._buildWaterNetwork = function (rng) {
    var lakes = this.lakes || [];
    this.rivers = [];
    this.lakeLinks = [];
    if (!lakes.length) return;

    var self = this;
    var W = this.W, H = this.H;
    var built = [];

    // Рамка ломаной: без неё проверка пересечений — O(n²) на каждую
    // пробную дугу, и запекание вырастало до 400+ мс.
    function bbox(pts) {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
      }
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    var builtBoxes = [];

    function crossesBuilt(pts, ignoreIdx) {
      var bb = bbox(pts);
      for (var o = 0; o < built.length; o++) {
        if (ignoreIdx != null && o === ignoreIdx) continue;
        var ob = builtBoxes[o];
        if (bb.x1 < ob.x0 || bb.x0 > ob.x1 ||
            bb.y1 < ob.y0 || bb.y0 > ob.y1) continue;

        var op = built[o];
        for (var i = 1; i < pts.length; i++) {
          var ax = pts[i - 1].x, ay = pts[i - 1].y;
          var bx = pts[i].x, by = pts[i].y;
          var segX0 = Math.min(ax, bx), segX1 = Math.max(ax, bx);
          var segY0 = Math.min(ay, by), segY1 = Math.max(ay, by);

          for (var j = 1; j < op.length; j++) {
            var cx = op[j - 1].x, cy = op[j - 1].y;
            var dx = op[j].x, dy = op[j].y;
            // Быстрый отсев по рамке отрезка.
            if (Math.max(cx, dx) < segX0 || Math.min(cx, dx) > segX1 ||
                Math.max(cy, dy) < segY0 || Math.min(cy, dy) > segY1) continue;
            if (segIntersect(pts[i - 1], pts[i], op[j - 1], op[j])) {
              return true;
            }
          }
        }
      }
      return false;
    }

    function pushSegment(pts, width) {
      built.push(pts);
      builtBoxes.push(bbox(pts));
      var cum = [0];
      for (var q = 1; q < pts.length; q++) {
        cum.push(cum[q - 1] + Math.hypot(pts[q].x - pts[q - 1].x,
                                          pts[q].y - pts[q - 1].y));
      }
      self.rivers.push({
        points: pts,
        cum: cum,
        length: cum[cum.length - 1],
        width: width || 1.8
      });
    }

    // Дуга из a в b с изгибом. Перебираем изгибы, пока не получим
    // линию, не пересекающую уже построенную воду.
    function coarseArc(a, b, nx, ny, amp, wave, N) {
      var dx = b.x - a.x, dy = b.y - a.y;
      var pts = [];
      for (var k = 0; k <= N; k++) {
        var t = k / N;
        var off = Math.sin(t * Math.PI * wave) * amp * Math.sin(Math.PI * t);
        pts.push({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off });
      }
      return pts;
    }

    // Дуга с плавным меандром: одна длинная дуга читалась как линейка.
    // Пробуем несколько амплитуд, пока линия не перестанет пересекать
    // уже построенную воду.
    function addArc(a, b, width) {
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.hypot(dx, dy) || 1;
      var nx = -dy / len, ny = dx / len;   // нормаль к прямой

      var amps = [0.10, 0.16, 0.22, 0.28, 0.36, 0.46, 0.58];
      for (var ai = 0; ai < amps.length; ai++) {
        var amp = amps[ai] * len;
        var wave = Math.max(1, Math.round(len / 260));

        // Грубая проверка на редкой выборке, затем точная на
        // сглаженной линии. Полная проверка каждого пробного изгиба
        // стоила сотни миллисекунд на запекание.
        if (crossesBuilt(coarseArc(a, b, nx, ny, amp, wave, Math.max(10, Math.round(len / 40))))) {
          continue;
        }

        var pts = [];
        var N = Math.max(24, Math.round(len / 8));
        for (var k = 0; k <= N; k++) {
          var t = k / N;
          var baseX = a.x + dx * t;
          var baseY = a.y + dy * t;
          // Мягкий S-образный изгиб: синус с нулём на концах.
          var off = Math.sin(t * Math.PI * wave) * amp * Math.sin(Math.PI * t);
          pts.push({ x: baseX + nx * off, y: baseY + ny * off });
        }

        // Сглаживаем до проверки: chaikin немного смещает линию, и
        // проверка «до» пропускала пересечения после сглаживания.
        var smooth = chaikin(pts, 2);
        if (crossesBuilt(smooth)) continue;
        pushSegment(smooth, width);
        return true;
      }
      return false;
    }

    // Порядок озёр: ближайший сосед, начиная с верхнего левого.
    var order = [];
    var left = [];
    for (var i = 0; i < lakes.length; i++) left.push(i);
    left.sort(function (a, b) {
      var la = lakes[a], lb = lakes[b];
      return (la.cx + la.cy) - (lb.cx + lb.cy);
    });
    order.push(left.shift());
    while (left.length) {
      var last = lakes[order[order.length - 1]];
      var bi2 = 0, bd = Infinity;
      for (var k2 = 0; k2 < left.length; k2++) {
        var cand = lakes[left[k2]];
        var d = Math.hypot(cand.cx - last.cx, cand.cy - last.cy);
        if (d < bd) { bd = d; bi2 = k2; }
      }
      order.push(left.splice(bi2, 1)[0]);
    }

    // Исток: продолжаем линию от первого озера за пределы листа.
    var first = lakes[order[0]];
    var second = lakes[order[1]] || { cx: first.cx + 100, cy: first.cy + 100 };
    // Исток продолжает линию ОТ второго озера через первое — то есть
    // уходит наружу, а не тянется через всю карту.
    var outX = first.cx - second.cx;
    var outY = first.cy - second.cy;
    var outLen = Math.hypot(outX, outY) || 1;
    var far = Math.hypot(W, H) + 120;
    var src = {
      x: first.cx + outX / outLen * far,
      y: first.cy + outY / outLen * far
    };
    addArc(src, this._lakeRim(first, src.x, src.y, 0.55), 2.4);

    // Протоки между озёрами в порядке цепочки.
    for (var c = 1; c < order.length; c++) {
      var a = lakes[order[c - 1]];
      var b = lakes[order[c]];
      var p0 = this._lakeRim(a, b.cx, b.cy, 0.62);
      var p1 = this._lakeRim(b, a.cx, a.cy, 0.62);
      addArc(p0, p1, 1.7);
    }

    // Устье: уводим воду от последнего озера за край листа.
    var lastLake = lakes[order[order.length - 1]];
    var prevLake = lakes[order[order.length - 2]] || lastLake;
    var dirX = lastLake.cx - prevLake.cx;
    var dirY = lastLake.cy - prevLake.cy;
    var dlen = Math.hypot(dirX, dirY) || 1;
    var sink = {
      x: lastLake.cx + dirX / dlen * (Math.hypot(W, H) + 120),
      y: lastLake.cy + dirY / dlen * (Math.hypot(W, H) + 120)
    };
    addArc(this._lakeRim(lastLake, sink.x, sink.y, 0.55), sink, 2.2);

    // Ответвления: тонкие рукава в сторону от основного русла.
    // Истончаются к концу и никуда не ведут — как на старых картах.
    function addTributary(main) {
      var mp = main.points;

      // Берём точку русла, которая реально видна на листе.
      var cands = [];
      for (var i = 2; i < mp.length - 2; i++) {
        var p = mp[i];
        if (p.x > W * 0.08 && p.x < W * 0.92 &&
            p.y > H * 0.10 && p.y < H * 0.90) {
          cands.push(i);
        }
      }
      if (!cands.length) return false;

      var idx = cands[Math.floor(rng() * cands.length)];
      var base = mp[idx];
      var prev = mp[Math.max(0, idx - 4)];
      var tx = base.x - prev.x, ty = base.y - prev.y;
      var tlen = Math.hypot(tx, ty) || 1;
      tx /= tlen; ty /= tlen;

      // Перпендикуляр к руслу, случайная сторона.
      var side = rng() < 0.5 ? -1 : 1;
      var nx = -ty * side, ny = tx * side;

      var length = 70 + rng() * 90;
      var steps = 16;
      var pts = [];
      var x = base.x, y = base.y;

      for (var si = 0; si <= steps; si++) {
        pts.push({ x: x, y: y });
        var t = si / steps;
        // Рукав плавно отходит вбок и слегка загибается по течению.
        var dirX = nx * (1 - t * 0.35) + tx * t * 0.55;
        var dirY = ny * (1 - t * 0.35) + ty * t * 0.55;
        var dl = Math.hypot(dirX, dirY) || 1;
        x += dirX / dl * (length / steps);
        y += dirY / dl * (length / steps);
      }

      // Первые точки лежат на родительском русле — его игнорируем.
      var parentIdx = built.indexOf(main.points);
      if (crossesBuilt(pts, parentIdx)) return false;

      built.push(pts);
      builtBoxes.push(bbox(pts));
      var cum2 = [0];
      for (var q4 = 1; q4 < pts.length; q4++) {
        cum2.push(cum2[q4 - 1] + Math.hypot(pts[q4].x - pts[q4 - 1].x,
                                             pts[q4].y - pts[q4 - 1].y));
      }
      self.rivers.push({
        points: pts,
        cum: cum2,
        length: cum2[cum2.length - 1],
        width: 0.95,
        taper: true
      });
      return true;
    }

    // По одному-двум рукавам от каждой видимой крупной реки.
    var mainRivers = this.rivers.slice();
    for (var mi = 0; mi < mainRivers.length; mi++) {
      if (mainRivers[mi].width < 1.5) continue;
      var want = 1 + (mi % 2);
      for (var wi = 0; wi < want; wi++) addTributary(mainRivers[mi]);
    }

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
  // Ближайшая точка вне островка иконки: используется реками и
  // корабликами, которым нельзя стоять на «суше» под значком.
  PaperEngine.prototype._pushOutOfIcons = function (x, y, pad) {
    var best = { x: x, y: y };
    var bestD = Infinity;
    for (var i = 0; i < this.icons.length; i++) {
      var r = this.icons[i];
      var l = r.x - pad, t = r.y - pad;
      var rr = r.x + r.w + pad, b = r.y + r.h + pad;
      if (x <= l || x >= rr || y <= t || y >= b) continue;
      var cand = [
        { x: l, y: y, d: x - l },
        { x: rr, y: y, d: rr - x },
        { x: x, y: t, d: y - t },
        { x: x, y: b, d: b - y }
      ];
      for (var k = 0; k < cand.length; k++) {
        if (cand[k].d < bestD) { bestD = cand[k].d; best = cand[k]; }
      }
    }
    return best;
  };

  PaperEngine.prototype._distToIcons = function (x, y) {
    var best = Infinity;
    for (var i = 0; i < this.icons.length; i++) {
      var r = this.icons[i];
      var dx = Math.max(r.x - x, 0, x - (r.x + r.w));
      var dy = Math.max(r.y - y, 0, y - (r.y + r.h));
      var d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
    return best;
  };

  // Отступ островка вокруг иконки. Ползунок «Остров» двигает его в
  // пределах 0.4–2.0 от базового значения.
  PaperEngine.prototype._islandPad = function () {
    var k = this.params.island;
    if (typeof k !== 'number') k = 31;
    // В старых сохранениях island был долей 0..1. Понимаем оба формата,
    // чтобы после обновления остров не схлопнулся в 1 px.
    if (k <= 1.5) k = 6 + k * 46;
    return clamp(Math.round(k), 0, 120);
  };

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
           this._inIconZone(x, y, this._islandPad() + 12)) ? 1 : 0;
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
    pts = chaikin(pts, 2);

    // Держим дорогу на небольшом отдалении от края островка: иначе
    // пунктир идёт ровно по береговой линии и сливается с контуром.
    if (this.icons.length) {
      var margin = this._islandPad() + 10;
      var lastX = pts[0].x, lastY = pts[0].y;
      for (var pi = 1; pi < pts.length - 1; pi++) {
        if (this._inIconZone(pts[pi].x, pts[pi].y, margin)) {
          var push = this._pushOutOfIcons(pts[pi].x, pts[pi].y, margin);
          var dx = push.x - pts[pi].x;
          var dy = push.y - pts[pi].y;
          var len2 = Math.hypot(dx, dy) || 1;
          // Минимальный сдвиг наружу — не рвём линию.
          pts[pi].x += dx / len2 * 10;
          pts[pi].y += dy / len2 * 10;
        }
      }
      // Сгладить сдвиг, сохранив удаление от зоны.
      for (var pass = 0; pass < 6; pass++) {
        for (var pj = 1; pj < pts.length - 1; pj++) {
          var nx = (pts[pj - 1].x + 2 * pts[pj].x + pts[pj + 1].x) / 4;
          var ny = (pts[pj - 1].y + 2 * pts[pj].y + pts[pj + 1].y) / 4;
          if (!this._inIconZone(nx, ny, margin - 2)) {
            pts[pj].x = nx;
            pts[pj].y = ny;
          }
        }
      }
    }

    return pts;
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

    // Исходные точки рек нужны до смещения озёр: _dodgeLakes поправит
    // те, что привязаны к центрам.
    this._buildLakes(rng);
    // Вода строится из размещённых озёр: так русла всегда связаны
    // с озёрами и не пересекаются друг с другом.
    this._buildWaterNetwork(rng);
    this._buildBoats(rng);
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
        if (this._inIconZone(x, y, this._islandPad() + 10)) continue;
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
        var waters = (this.rivers || []).concat(this.lakeLinks || []);
        for (var ri = 0; ri < waters.length; ri++) {
          var vpts = waters[ri].points;
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
      if (self._inIconZone(x, y, r + self._islandPad() + 6)) return false;

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

    // Прямоугольник, который займёт спрайт: высота важна не меньше
    // точки подошвы, иначе крона дерева залезает на островок.
    function spriteBox(variants, x, y, scale, radius) {
      var spr = variants[0];
      var w = spr.w * scale;
      var h = spr.h * scale;
      return {
        x: x - spr.ax * scale,
        y: y - spr.ay * scale,
        w: w,
        h: h
      };
    }

    function boxHitsIcon(box, pad) {
      for (var i = 0; i < self.icons.length; i++) {
        var r = self.icons[i];
        if (box.x < r.x + r.w + pad && box.x + box.w > r.x - pad &&
            box.y < r.y + r.h + pad && box.y + box.h > r.y - pad) {
          return true;
        }
      }
      return false;
    }

    function put(type, variants, x, y, scale, radius, roadPad) {
      if (!free(x, y, radius)) return false;
      if (roadPad && self._nearRoad(x, y, roadPad)) return false;
      if (self.icons.length) {
        var box = spriteBox(variants, x, y, scale, radius);
        // Небольшой запас, чтобы контур не касался кромки островка.
        if (boxHitsIcon(box, 6)) return false;
      }
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

    /* 1.5. Маяк на берегу самого большого озера. Ищем точку у кромки
     * воды, снаружи, чтобы башня стояла на суше. */
    this.lighthouses = [];
    var biggest = null;
    for (var li = 0; li < this.lakes.length; li++) {
      var lk = this.lakes[li];
      if (!biggest || lk.rx * lk.ry > biggest.rx * biggest.ry) biggest = lk;
    }
    if (biggest) {
      for (var la = 0; la < TAU; la += 0.18) {
        var lx = biggest.cx + Math.cos(la) * biggest.rx * 1.22;
        var ly = biggest.cy + Math.sin(la) * biggest.ry * 1.22;
        if (this._inLake(lx, ly, 14)) continue;
        if (this._inIconZone(lx, ly, 34)) continue;
        if (this._inReserved(lx, ly, 24)) continue;
        if (this._nearRoad(lx, ly, 20)) continue;
        var lsc = 0.95;
        if (put('lighthouse', this._sprites.lighthouses, lx, ly, lsc, 12, 0)) {
          this.lighthouses.push({ x: lx, y: ly - 42 * lsc, phase: rng() * TAU });
          break;
        }
      }
    }

    /* 2. замки: сначала башни, потом полоса под подпись, потом дома */
    for (var ci = 0; ci < castles.length; ci++) {
      var castleT = castles[ci];
      put('castle', this._sprites.castles, castleT.x, castleT.y,
          0.92 + rng() * 0.12, 23, 0);
    }

    for (var cn = 0; cn < castles.length; cn++) {
      this._reserved.push({
        x: castles[cn].x - 80,
        y: castles[cn].y - 78,
        w: 160,
        h: 26
      });
    }

    /* Дома вокруг замка больше не нужны: сам спрайт замка — плотная
     * кучка домов с острой крышей и флагом, как на образце. Отдельные
     * домики только размывали силуэт. */

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
        // Деревья не стоят на дороге: иначе ствол закрывает пунктир.
        // Отступ чуть больше радиуса кроны, но меньше, чем у городов, —
        // лес по-прежнему подступает к обочине.
        put('tree', this._sprites.trees, fx, fy, ts, 4.8 * ts, 9);
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

    /* 7.5. Избушка ведьмы в самом пустом месте карты.
     * Считаем расстояния по грубой сетке, чтобы не сканировать всё поле
     * на каждый кандидат. */
    var witch = null;
    var bestScore = -1;
    var STEP = 64;
    for (var wy = 80; wy < H - 80; wy += STEP) {
      for (var wx = 80; wx < W - 80; wx += STEP) {
        var px = wx + (rng() - 0.5) * STEP * 0.8;
        var py = wy + (rng() - 0.5) * STEP * 0.8;
        if (this._inLake(px, py, 30)) continue;
        if (this._nearRiver(px, py, 26)) continue;
        if (this._nearRoad(px, py, 26)) continue;
        if (this._inIconZone(px, py, this._islandPad() + 20)) continue;
        if (this._inReserved(px, py, 50)) continue;

        // Ближайший объект: чем дальше, тем «пустее» место.
        var near = 1e9;
        var labelBlocked = false;
        for (var oi = 0; oi < objects.length; oi++) {
          var oo = objects[oi];
          var d = Math.hypot(oo.x - px, oo.y - py);
          if (d < near) near = d;
          // Над избой нужна чистая полоса под подпись «Witch».
          if (oo.x > px - 34 && oo.x < px + 34 &&
              oo.y > py - 56 && oo.y < py - 16) {
            labelBlocked = true;
            break;
          }
        }
        if (labelBlocked) continue;
        if (near > bestScore) { bestScore = near; witch = { x: px, y: py }; }
      }
    }
    if (witch) {
      var wsc = 0.95 + rng() * 0.08;
      objects.push({
        type: 'witch', x: witch.x, y: witch.y, s: wsc,
        v: Math.floor(rng() * this._sprites.witches.length),
        r: 20 * wsc
      });

      // Тыковка у крыльца: маленькая, чуть впереди и сбоку, чтобы
      // читалась рядом с избой, а не под ней.
      var pumpkinX = witch.x + 48;
      var pumpkinY = witch.y + 8;
      objects.push({
        type: 'pumpkin', x: pumpkinX, y: pumpkinY, s: 0.55 + rng() * 0.12,
        v: Math.floor(rng() * this._sprites.pumpkins.length),
        r: 8
      });

      // Котик: у избы, с другой стороны от тыквы. Половина шансов,
      // что он спит — так сцена живее.
      var catX = witch.x + 30;
      var catY = witch.y + 4;
      objects.push({
        type: 'cat',
        x: catX,
        y: catY,
        s: 1.25 + rng() * 0.15,
        v: 0,
        r: 10
      });

      this._witchLabel = { x: witch.x, y: witch.y };
      objects.sort(function (a, b) { return a.y - b.y; });
    }

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
      if (this._inIconZone(tx2, ty2, this._islandPad() + 4)) continue;
      tufts.push({ x: tx2, y: ty2, s: 0.7 + rng() * 0.6, a: rng() * TAU });
    }

    this.world = {
      castles: castles,
      roads: roads,
      objects: objects,
      lakes: this.lakes,
      rivers: this.rivers,
      tufts: tufts,
      witch: witch
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
        // База почти ровная: основную «обжитую» неровность дают
        // отдельные пятна, а не общий шум.
        data[i] = base[0] + (v - 0.5) * 12;
        data[i + 1] = base[1] + (v - 0.5) * 11;
        data[i + 2] = base[2] + (v - 0.5) * 10;
        data[i + 3] = 255;
      }
    }
    mg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(mc, 0, 0, W, H);

    var rng = mulberry32(0x9e3779b9);

    // Пятна — мелкие и разбросанные по всему листу. Крупные области
    // давали «грязные» зоны; для старой бумаги нужна равномерная
    // крапчатость, которую замечаешь только вблизи.
    var spotCount = Math.round(110 * Math.min(2.4, (W * H) / (1280 * 720)));
    for (var sp = 0; sp < spotCount; sp++) {
      var sx = rng() * W;
      var sy = rng() * H;
      var sr = 22 + rng() * 74;
      var alpha = 0.060 + rng() * 0.085;

      // Мягкий край без чёткой границы: радиальный градиент от центра.
      var grad2 = g.createRadialGradient(sx, sy, 0, sx, sy, sr);
      grad2.addColorStop(0, 'rgba(104,76,38,' + alpha.toFixed(3) + ')');
      grad2.addColorStop(0.55, 'rgba(104,76,38,' + (alpha * 0.6).toFixed(3) + ')');
      grad2.addColorStop(1, 'rgba(104,76,38,0)');
      g.fillStyle = grad2;
      g.beginPath();
      g.arc(sx, sy, sr, 0, TAU);
      g.fill();
    }

    // Совсем мелкая «крапчатость», как пыль и поры бумаги.
    for (var dp = 0; dp < 1500; dp++) {
      var dx = rng() * W, dy = rng() * H;
      var dr = 0.5 + rng() * 1.6;
      g.fillStyle = 'rgba(96,70,36,' + (0.03 + rng() * 0.07).toFixed(3) + ')';
      g.beginPath();
      g.arc(dx, dy, dr, 0, TAU);
      g.fill();
    }

    // Немного светлых проплешин, чтобы карта «дышала».
    for (var s2 = 0; s2 < 7; s2++) {
      var lx = rng() * W, ly = rng() * H, lr = 110 + rng() * 260;
      var lg = g.createRadialGradient(lx, ly, 0, lx, ly, lr);
      lg.addColorStop(0, 'rgba(250,240,214,0.10)');
      lg.addColorStop(1, 'rgba(250,240,214,0)');
      g.fillStyle = lg;
      g.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
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
    // Реки и протоки между озёрами рисуются одинаково: это одна вода.
    var rivers = (this.rivers || []).concat(this.lakeLinks || []);
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
      if (rivers[i].taper) {
        // Рукав истончается к концу: рисуем посегментно.
        for (var q3 = 1; q3 < pts.length; q3++) {
          var tq = q3 / (pts.length - 1);
          g.lineWidth = Math.max(0.35, w * (1 - tq * 0.85));
          g.beginPath();
          g.moveTo(pts[q3 - 1].x, pts[q3 - 1].y);
          g.lineTo(pts[q3].x, pts[q3].y);
          g.stroke();
        }
      } else {
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (var b = 1; b < pts.length; b++) g.lineTo(pts[b].x, pts[b].y);
        g.stroke();
      }
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

      // Старая карта: у дороги тёмные края и светлая середина, а по
      // центру идёт пунктир. Тёмный кант делает дорогу читаемой на
      // плотном лесу, где раньше она терялась.
      g.setLineDash([]);
      g.strokeStyle = 'rgba(70,50,24,0.42)';
      g.lineWidth = 5.0;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var a = 1; a < pts.length; a++) g.lineTo(pts[a].x, pts[a].y);
      g.stroke();

      g.strokeStyle = 'rgba(246,236,210,0.75)';
      g.lineWidth = 2.6;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var a2 = 1; a2 < pts.length; a2++) g.lineTo(pts[a2].x, pts[a2].y);
      g.stroke();

      g.setLineDash([1.5, 5]);
      g.strokeStyle = p.road;
      g.lineWidth = 1.5;
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

      // Тень под мостом.
      g.fillStyle = 'rgba(70,51,29,0.22)';
      g.beginPath();
      g.ellipse(0, 1.5, 12, 3, 0, 0, TAU);
      g.fill();

      // Настил: светлая доска с тёмным контуром.
      g.fillStyle = p.paperLight;
      g.strokeStyle = p.ink;
      g.lineWidth = 1.1;
      g.beginPath();
      g.rect(-11, -4.2, 22, 8.4);
      g.fill();
      g.stroke();

      // Поперечные доски.
      g.strokeStyle = p.inkSoft;
      g.lineWidth = 0.8;
      for (var pk = -8; pk <= 8; pk += 3.6) {
        g.beginPath();
        g.moveTo(pk, -3.6);
        g.lineTo(pk, 3.6);
        g.stroke();
      }

      // Перила вдоль обеих сторон.
      g.strokeStyle = p.ink;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(-11, -4.2); g.lineTo(11, -4.2);
      g.moveTo(-11, 4.2); g.lineTo(11, 4.2);
      g.stroke();

      // Стойки перил.
      g.lineWidth = 0.9;
      for (var sk = -8; sk <= 8; sk += 8) {
        g.beginPath();
        g.moveTo(sk, -4.2); g.lineTo(sk, -6.2);
        g.moveTo(sk, 4.2); g.lineTo(sk, 6.2);
        g.stroke();
      }
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
      this._drawSpacedText(g, names[i % names.length], c.x, c.y - 60,
                           13, 'rgba(90,67,34,0.68)', 0,
                           'rgba(214,190,144,0.55)', true);
    }
  };

  // Подпись избушки ведьмы — как у замков, только мельче.
  PaperEngine.prototype._drawWitchLabel = function (g) {
    var w = this._witchLabel;
    if (!w) return;
    this._drawSpacedText(g, 'Witch', w.x, w.y - 44,
                         11, 'rgba(90,67,34,0.62)', 0,
                         'rgba(214,190,144,0.5)', true);
  };

  PaperEngine.prototype._drawCompass = function (g) {
    var cp = this.theme.compass;
    if (!cp) return;
    var p = this.theme.palette;
    var cx = cp.x * this.W, cy = cp.y * this.H, r = cp.r;

    g.save();
    g.translate(cx, cy);

    g.strokeStyle = 'rgba(70,50,24,0.95)';
    g.lineWidth = 1.5;

    // Двойное кольцо.
    g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke();
    g.beginPath(); g.arc(0, 0, r * 0.80, 0, TAU); g.stroke();

    // 16 лучей: 4 главных, 4 промежуточных, 8 малых.
    for (var i = 0; i < 16; i++) {
      var ang = i * TAU / 16 - Math.PI * 0.5;
      var major = (i % 4 === 0);
      var mid = (i % 2 === 0);
      var len = major ? r * 0.98 : (mid ? r * 0.70 : r * 0.46);
      var half = major ? 0.085 : (mid ? 0.065 : 0.045);
      var base = r * 0.10;

      g.beginPath();
      g.moveTo(Math.cos(ang) * len, Math.sin(ang) * len);
      g.lineTo(Math.cos(ang + half) * base, Math.sin(ang + half) * base);
      g.lineTo(Math.cos(ang - half) * base, Math.sin(ang - half) * base);
      g.closePath();

      if (i === 0) {
        // Северная стрелка — тёмная, остальные светлее.
        g.fillStyle = 'rgba(78,58,30,1)';
        g.fill();
      } else if (major) {
        g.fillStyle = 'rgba(78,58,30,0.78)';
        g.fill();
      } else if (mid) {
        g.fillStyle = 'rgba(78,58,30,0.55)';
        g.fill();
      }
      g.strokeStyle = 'rgba(70,50,24,0.80)';
      g.lineWidth = 1.0;
      g.stroke();
    }

    // Центральный кружок.
    g.beginPath(); g.arc(0, 0, r * 0.075, 0, TAU);
    g.fillStyle = 'rgba(78,58,30,1)';
    g.fill();

    // Буквы.
    g.font = '600 11px "Liberation Serif", Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 12px "Liberation Serif", Georgia, serif';
    g.fillStyle = 'rgba(78,58,30,1)';
    g.fillText('N', 0, -r - 9);
    g.fillStyle = 'rgba(78,58,30,0.88)';
    g.fillText('S', 0, r + 9);
    g.fillStyle = 'rgba(78,58,30,0.88)';
    g.fillText('E', r + 9, 0);
    g.fillText('W', -r - 9, 0);
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

  var SPRITE_KEYS = { witch: 'witches', bush: 'bushes', pumpkin: 'pumpkins', cat: 'cats' };

  PaperEngine.prototype._spriteFor = function (o) {
    var key = SPRITE_KEYS[o.type] || (o.type + 's');
    var list = this._sprites[key];
    if (!list || !list.length) return null;
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

  // Слой воды с мягкими бухтами вокруг иконок. Иконки не «заклеивают»
  // воду прямоугольником: берег плавно отступает, как настоящая бухта.
  PaperEngine.prototype._buildWater = function () {
    var g = this.waterCtx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.W, this.H);

    this._drawRivers(g);
    this._drawLakes(g);

    // Вода обтекает островки иконок: вырезаем их силуэт с мягким краем,
    // иначе озеро обрывается ровной кромкой под значком.
    if (this.icons.length) {
      var mask = this._iconIslandMask(this._islandPad() + 4);
      g.globalCompositeOperation = 'destination-out';
      g.imageSmoothingEnabled = true;
      g.drawImage(mask.canvas, 0, 0, this.W, this.H);
      g.globalCompositeOperation = 'source-over';
    }

    return this.water;
  };

  PaperEngine.prototype.bake = function () {
    var t0 = performance.now();
    if (this.worldDirty || !this.world) this.buildWorld();
    this._ensurePaper();

    var g = this.baseCtx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    g.drawImage(this._paper, 0, 0, this.W, this.H);
    g.drawImage(this._buildWater(), 0, 0);
    this._drawTufts(g);
    this._drawRoads(g);
    this._drawBridges(g);
    this._drawLabels(g);
    this._drawObjects(g);
    this._drawCastleNames(g);
    this._drawWitchLabel(g);
    this._drawVignette(g);
    if (this.theme.frame !== false) this._drawFrame(g);

    this.bakeMs = performance.now() - t0;
    this.bakeDirty = false;
    this.displayDirty = true;
  };

  // Островки иконок: как на референсе — не карточка, а береговая линия
  // вокруг группы значков. Внутри пусто (объекты туда не ставятся),
  // снаружи двойной контур тушью. Пересобирается только при сдвиге.
  PaperEngine.prototype._iconIslandMask = function (padOverride) {
    // Половина разрешения достаточно: островок — мягкий силуэт, а
    // маска в полном разрешении стоила ~300 мс на каждый сдвиг иконки.
    var ms = 0.5;
    var mw = Math.max(1, Math.round(this.W * ms));
    var mh = Math.max(1, Math.round(this.H * ms));
    var mask = document.createElement('canvas');
    mask.width = mw;
    mask.height = mh;
    var mg = mask.getContext('2d');
    mg.scale(ms, ms);
    mg.fillStyle = '#fff';

    for (var i = 0; i < this.icons.length; i++) {
      var r = this.icons[i];
      // Соседние значки дают один общий остров, а не гирлянду кружков.
      var pad = (padOverride == null ? this._islandPad() : padOverride);
      var x = r.x - pad, y = r.y - pad;
      var w = r.w + pad * 2, h = r.h + pad * 2;
      var cx = x + w * 0.5, cy = y + h * 0.5;
      var rx = w * 0.5, ry = h * 0.5;

      // Суперэллипс (сквиркл): вписанный эллипс у соседних значков
      // оставляет между собой ромбовидные щели, а прямоугольник
      // выглядит как панель. Степень 4 заполняет углы почти полностью,
      // но силуэт остаётся мягким; шум по радиусу даёт неровный берег.
      var rng = mulberry32(Math.round(r.x * 13 + r.y * 7 + r.w * 3 + r.h));
      var pts = [];
      var n = 28;
      var e = 2 / 4;   // показатель суперэллипса
      for (var k = 0; k < n; k++) {
        var a = k / n * TAU;
        var ca = Math.cos(a), sa = Math.sin(a);
        var sx = (ca < 0 ? -1 : 1) * Math.pow(Math.abs(ca), e);
        var sy = (sa < 0 ? -1 : 1) * Math.pow(Math.abs(sa), e);
        var wob = 0.94 + rng() * 0.09;
        pts.push([cx + sx * rx * wob, cy + sy * ry * wob]);
      }
      blobPath(mg, pts);
      mg.fill();
    }
    return { canvas: mask, w: mw, h: mh };
  };

  PaperEngine.prototype._ensureOverlay = function () {
    if (!this.overlayDirty) return;
    var t0 = performance.now();

    var g = this.overlayCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.overlay.width, this.overlay.height);

    if (!this.icons.length) {
      this.overlayMs = performance.now() - t0;
      this.overlayDirty = false;
      this.displayDirty = true;
      return;
    }

    var mask = this._iconIslandMask();
    var palette = this.theme.palette;

    // Две тонкие линии по контуру. band(a, b) — полоса между
    // расширениями маски на a и b пикселей. Раньше при inner = 0
    // вычитания не происходило и заливался весь остров.
    function band(inner, outer, alpha) {
      function dilated(amount) {
        var c = document.createElement('canvas');
        c.width = mask.w;
        c.height = mask.h;
        var cg = c.getContext('2d');
        for (var d = 0; d <= amount; d++) {
          if (d === 0) {
            cg.drawImage(mask.canvas, 0, 0);
            continue;
          }
          cg.drawImage(mask.canvas, -d, 0);
          cg.drawImage(mask.canvas, d, 0);
          cg.drawImage(mask.canvas, 0, -d);
          cg.drawImage(mask.canvas, 0, d);
        }
        return c;
      }

      var big = dilated(outer);
      var small = dilated(inner);
      var cg = big.getContext('2d');
      cg.globalCompositeOperation = 'destination-out';
      cg.drawImage(small, 0, 0);
      cg.globalCompositeOperation = 'source-in';
      cg.fillStyle = palette.ink;
      cg.fillRect(0, 0, big.width, big.height);

      var out = document.createElement('canvas');
      out.width = big.width;
      out.height = big.height;
      var og = out.getContext('2d');
      og.globalAlpha = alpha;
      og.drawImage(big, 0, 0);
      return out;
    }

    var outer = band(4, 6, 0.34);
    var inner = band(1, 2, 0.28);

    // Светлая подложка островка: чистый пергамент без леса и травы,
    // как на референсе. Вырезаем её по той же маске.
    var fill = document.createElement('canvas');
    fill.width = mask.w;
    fill.height = mask.h;
    var fg = fill.getContext('2d');

    // Остров заливается тем же пергаментом, что и карта: он не должен
    // выглядеть светлой заплаткой, только чистым местом без деталей.
    if (this._paperVig) {
      fg.drawImage(this._paperVig, 0, 0, mask.w, mask.h);
    } else if (this._paper) {
      fg.drawImage(this._paper, 0, 0, mask.w, mask.h);
    } else {
      fg.fillStyle = palette.paper;
      fg.fillRect(0, 0, mask.w, mask.h);
    }

    fg.globalCompositeOperation = 'destination-in';
    fg.drawImage(mask.canvas, 0, 0);

    g.save();
    g.imageSmoothingEnabled = true;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(fill, 0, 0, this.overlay.width, this.overlay.height);
    g.drawImage(outer, 0, 0, this.overlay.width, this.overlay.height);
    g.drawImage(inner, 0, 0, this.overlay.width, this.overlay.height);
    g.restore();

    this.overlayMs = performance.now() - t0;
    this.overlayDirty = false;
    this.displayDirty = true;
  };

  // Луч маяка медленно поворачивается и слегка тускнеет.
  PaperEngine.prototype._drawLighthouseBeams = function (g, t) {
    var beams = this._sprites.beams || [];
    var lighthouses = this.lighthouses || [];
    if (!beams.length || !lighthouses.length) return;

    for (var i = 0; i < lighthouses.length; i++) {
      var lh = lighthouses[i];
      var a = t * 0.00035 + lh.phase;
      var pulse = 0.45 + 0.25 * Math.sin(t * 0.0011 + lh.phase);
      var spr = beams[i % beams.length];

      g.save();
      g.globalAlpha = pulse;
      g.translate(lh.x, lh.y);
      g.rotate(a);
      g.drawImage(spr.c, -spr.ax, -spr.ay, spr.w, spr.h);
      g.rotate(Math.PI);
      g.globalAlpha = pulse * 0.55;
      g.drawImage(spr.c, -spr.ax, -spr.ay, spr.w, spr.h);
      g.restore();
    }
  };

  PaperEngine.prototype._drawBoats = function (g, t) {
    var boats = this.boats || [];
    var sprites = this._sprites.boats || [];
    if (!boats.length || !sprites.length) return;

    var icons = this.icons;
    for (var i = 0; i < boats.length; i++) {
      var b = boats[i];
      var lake = this.lakes[b.lake];
      if (!lake) continue;

      // Эллипс внутри озера; угол медленно растёт. 0.34 радиуса —
      // с запасом от берега, иначе кораблик «стоит» на суше.
      var a = b.phase + t * b.speed;
      var x = lake.cx + Math.cos(a) * lake.rx * 0.22;
      var y = lake.cy + Math.sin(a) * lake.ry * 0.16;

      // Не заходим на островки иконок.
      if (this._inIconZone(x, y, 18)) continue;

      // Покачивание только по вертикали и с целыми пикселями:
      // вращение спрайта каждый кадр давало субпиксельное дрожание.
      var dy = Math.round(Math.sin(t * 0.0021 + b.phase) * b.bob);

      var spr = sprites[b.v % sprites.length];

      // Масштаб от размера озера: на маленьком озере кораблик меньше,
      // иначе он выглядит как лодка в луже.
      var sc = clamp(Math.min(lake.rx, lake.ry) / 44, 0.52, 0.95);

      g.save();
      g.translate(Math.round(x), Math.round(y) + dy);
      g.drawImage(spr.c, -spr.ax * sc, -spr.ay * sc,
                  spr.w * sc, spr.h * sc);
      g.restore();
    }
  };

  // Ворон кружит над избушкой ведьмы: медленный эллипс и два кадра
  // взмаха. Двигается только в динамическом слое.
  // Птицы кружат над избушкой ведьмы: количество задаётся ползунком,
  // каждая летит по своей орбите с собственным периодом.
  // Птицы летают по всей карте: у каждой своя замкнутая орбита с
  // собственным центром, радиусом и периодом. Над избой ведьмы они
  // тоже бывают — её координаты входят в набор орбит.
  PaperEngine.prototype._drawBirds = function (g, t) {
    var sprites = this._sprites.birds || [];
    if (!sprites.length || !this.world) return;

    var n = clamp(Math.round(this.params.birds == null ? 2 : this.params.birds), 0, 12);
    if (!n) return;

    var W = this.W, H = this.H;
    var witch = this.world.witch;
    var rng = mulberry32(0x5eed + 17);

    // Заранее считаем орбиты: часть над избой, часть по всей карте.
    if (!this._birdOrbits || this._birdOrbitsN !== n ||
        this._birdOrbitsW !== W || this._birdOrbitsH !== H) {
      var orbits = [];
      for (var i = 0; i < n; i++) {
        var overHut = witch && i < Math.ceil(n / 2);
        var cx, cy, rx, ry;
        if (overHut) {
          cx = witch.x;
          cy = witch.y - 88 - (i % 3) * 12;
          rx = 44 + (i % 4) * 14;
          ry = rx * 0.36;
        } else {
          cx = W * (0.12 + rng() * 0.76);
          cy = H * (0.12 + rng() * 0.62);
          rx = Math.min(W, H) * (0.18 + rng() * 0.22);
          ry = rx * (0.30 + rng() * 0.25);
        }
        orbits.push({
          cx: cx, cy: cy, rx: rx, ry: ry,
          speed: 0.00022 + rng() * 0.00022,
          phase: rng() * TAU,
          tilt: (rng() - 0.5) * 0.10,
          flap: 0.0035 + rng() * 0.0022
        });
      }
      this._birdOrbits = orbits;
      this._birdOrbitsN = n;
      this._birdOrbitsW = W;
      this._birdOrbitsH = H;
    }

    var orbits = this._birdOrbits;
    for (var k = 0; k < orbits.length; k++) {
      var o = orbits[k];
      var a = t * o.speed + o.phase;
      var bx = o.cx + Math.cos(a) * o.rx;
      var by = o.cy + Math.sin(a) * o.ry;

      // Не рисуем над иконками и за пределами листа.
      if (bx < -20 || bx > W + 20 || by < -20 || by > H + 20) continue;
      if (this._inIconZone(bx, by, 18)) continue;

      var spr = sprites[Math.floor(t * o.flap + k * 0.7) % sprites.length];
      var sc = 1.0 + (k % 3) * 0.12;

      g.save();
      g.translate(Math.round(bx), Math.round(by));
      g.rotate(Math.cos(a) * 0.10 + o.tilt);
      g.scale(sc, sc);
      g.globalAlpha = 0.92;
      g.drawImage(spr.c, -spr.ax, -spr.ay, spr.w, spr.h);
      g.restore();
    }
  };

  PaperEngine.prototype._drawUnits = function (g, t) {
    this._drawLighthouseBeams(g, t);
    this._drawBoats(g, t);
    this._drawBirds(g, t);

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

    // Роза ветров — поверх островков: в углу часто стоит иконка, и на
    // базовом слое компас под её поляной был бы не виден.
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawCompass(g);

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
