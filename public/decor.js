/*
 * Seasonal decoration (Admin → Appearance → Effects «Сезонное украшение»). html[data-ui-decor] is a
 * space-separated list — any combination of:
 *   snow    — canvas (.ui-decor, z −1 under the content): fluffy irregular flakes on depth layers (near =
 *             bigger, faster), each fluttering with two-frequency turbulence in a gusting wind; a few
 *             very near flakes are large, soft and out of focus; recycled flakes enter from the upwind side;
 *   leaves  — the same canvas: procedural maple / oak / elm outlines with mottling, darker rims and veins
 *             in autumn colours; most flutter (rock and glide side to side, slowing at the end of each
 *             swing), some tumble; a leaf turned edge-on darkens;
 *   garland — an SVG string of C9 bulbs across the very top of the window (fixed, full width, over the
 *             sidebar and the header picture): a twisted wire sagging
 *             between clips, glowing glass (hot near-white core, saturated edge), a soft halo; the lights
 *             are steady, only a few twinkle slowly (CSS animations; none with reduced motion);
 * Sprites are drawn once; the particle count follows the screen area; DPR ≤ 1.5; paused in a hidden tab;
 * nothing runs while no effect is on (a MutationObserver follows the admin live preview); no canvas with
 * prefers-reduced-motion; nothing at all in E-Ink mode.
 */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  let canvas = null;
  let ctx = null;
  let raf = 0;
  let active = { snow: false, leaves: false };
  let flakes = [];
  let leaves = [];
  let sprites = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let last = 0;
  let clock = 0;
  let garland = null;
  let garlandWidth = 0;
  let garlandObserver = null;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  function wanted() {
    const tokens = new Set(String(root.getAttribute('data-ui-decor') || '').split(/\s+/).filter(Boolean));
    const eink = root.getAttribute('data-eink') === '1';
    const motion = !eink && !(reduceMotion && reduceMotion.matches);
    return {
      snow: motion && tokens.has('snow'),
      leaves: motion && tokens.has('leaves'),
      garland: !eink && tokens.has('garland'),
    };
  }

  /* ── Sprites ── */

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /**
   * Fluffy flake: a few overlapping soft blobs, so it is an irregular clump rather than a perfect disc.
   * The light theme gets a faint blue-grey shadow around it, otherwise white vanishes on parchment.
   */
  function flakeSprite(radius, light) {
    const size = Math.ceil(radius * 3) + 4;
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const cx = size / 2;
    if (light) {
      const shadow = g.createRadialGradient(cx, cx, 0, cx, cx, radius * 1.45);
      shadow.addColorStop(0, 'rgba(105,125,155,0.4)');
      shadow.addColorStop(0.6, 'rgba(105,125,155,0.22)');
      shadow.addColorStop(1, 'rgba(105,125,155,0)');
      g.fillStyle = shadow;
      g.fillRect(0, 0, size, size);
    }
    const blobs = radius < 1.3 ? 1 : 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < blobs; i += 1) {
      const off = blobs === 1 ? 0 : radius * rand(0.15, 0.4);
      const ang = rand(0, Math.PI * 2);
      const bx = cx + Math.cos(ang) * off;
      const by = cx + Math.sin(ang) * off;
      const br = radius * (blobs === 1 ? 1 : rand(0.55, 0.8));
      const grad = g.createRadialGradient(bx, by, 0, bx, by, br + 0.8);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.7)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(bx, by, br + 0.8, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }

  /** A flake right in front of the «lens»: large, soft, out of focus. */
  function bokehSprite(radius, light) {
    const size = Math.ceil(radius * 2) + 4;
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const cx = size / 2;
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, radius);
    if (light) {
      grad.addColorStop(0, 'rgba(255,255,255,0.75)');
      grad.addColorStop(0.55, 'rgba(240,245,252,0.5)');
      grad.addColorStop(0.85, 'rgba(120,140,170,0.18)');
      grad.addColorStop(1, 'rgba(120,140,170,0)');
    } else {
      grad.addColorStop(0, 'rgba(255,255,255,0.6)');
      grad.addColorStop(0.6, 'rgba(255,255,255,0.38)');
      grad.addColorStop(0.85, 'rgba(255,255,255,0.12)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  /*
   * Leaf outlines are generated as point lists in a 100×100 box (stalk joins at (50, base), tip up):
   * maple = polar lobes with pointed tips, deep sinuses and serration; oak = rounded lobes with deep bays
   * along a midrib; elm = an ovate serrated blade, slightly lopsided at the base.
   */
  function mapleOutline() {
    const ox = 50;
    const oy = 62;
    const lobes = [[0, 58], [0.82, 50], [-0.82, 50], [1.62, 37], [-1.62, 37]];
    const pts = [];
    const n = 220;
    for (let i = 0; i < n; i += 1) {
      const phi = -Math.PI + (i / n) * Math.PI * 2;
      let r = 11;
      for (const [at, len] of lobes) {
        const d = Math.abs(phi - at);
        if (d < 0.62) r = Math.max(r, len * Math.pow(1 - d / 0.62, 0.78));
      }
      if (r > 16) {
        const saw = Math.abs(((phi * 9) / Math.PI) % 1 - 0.5) * 2; // triangle wave → small teeth
        r *= 1 + 0.05 * (saw - 0.5);
      }
      pts.push([ox + Math.sin(phi) * r, oy - Math.cos(phi) * r]);
    }
    return { pts, base: 72, veins: lobes.map(([at, len]) => [ox + Math.sin(at) * len * 0.9, oy - Math.cos(at) * len * 0.9]), origin: [ox, oy] };
  }

  function bladeOutline(halfWidth, tipY, baseY) {
    const right = [];
    const left = [];
    const n = 110;
    for (let i = 0; i <= n; i += 1) {
      const s = i / n;
      const y = baseY + (tipY - baseY) * s;
      const [wr, wl] = halfWidth(s);
      right.push([50 + wr, y]);
      left.push([50 - wl, y]);
    }
    return right.concat(left.reverse());
  }

  function oakOutline() {
    const norm = Math.pow(0.55, 0.55) * Math.pow(0.45, 0.45);
    const pts = bladeOutline((s) => {
      const env = (Math.pow(s, 0.55) * Math.pow(1 - s, 0.45)) / norm;
      const lobe = (ph) => 0.5 + 0.5 * Math.pow(Math.abs(Math.sin(Math.PI * 4.5 * s + ph)), 0.6);
      return [27 * env * lobe(0.2), 27 * env * lobe(-0.25)];
    }, 6, 90);
    return { pts, base: 90, veins: 'pinnate', tip: 6 };
  }

  function elmOutline() {
    const norm = Math.pow(0.39, 0.7) * Math.pow(0.61, 1.1);
    const pts = bladeOutline((s) => {
      const env = (Math.pow(s, 0.7) * Math.pow(1 - s, 1.1)) / norm;
      const saw = 1 - 2 * ((s * 24) % 1);
      const teeth = 1 + 0.045 * saw * (s > 0.06 && s < 0.95 ? 1 : 0);
      return [31 * env * teeth, 31 * env * teeth * (s < 0.25 ? 0.88 + s * 0.48 : 1)];
    }, 4, 90);
    return { pts, base: 90, veins: 'pinnate', tip: 4 };
  }

  const LEAF_SHAPES = [mapleOutline(), oakOutline(), elmOutline()];
  const LEAF_COLORS = [
    ['#d9822b', '#9c4a12'], ['#e3a127', '#a8650f'], ['#c8452c', '#7e2214'],
    ['#b8322a', '#6d1a15'], ['#d6b23a', '#94721a'], ['#a8662c', '#5f3612'],
    ['#e07b39', '#a43e16'], ['#9d8a2e', '#5c4f16'],
  ];
  const LEAF_SPOTS = ['rgba(110,50,10,0.38)', 'rgba(240,190,50,0.32)', 'rgba(105,115,30,0.3)', 'rgba(150,30,15,0.3)'];

  function leafPath(shape) {
    const p = new Path2D();
    shape.pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    return p;
  }

  function leafSprite(shapeIndex, colors, back) {
    const size = 96;
    const shape = LEAF_SHAPES[shapeIndex];
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const path = leafPath(shape);
    g.scale(size / 100, size / 100);
    const grad = g.createLinearGradient(rand(15, 35), 8, rand(65, 85), 92);
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(1, colors[1]);
    g.fillStyle = grad;
    g.fill(path);
    g.save();
    g.clip(path);
    /* mottling: a few soft blotches of brown, gold or the last of the green */
    const spots = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < spots; i += 1) {
      const sx = rand(22, 78);
      const sy = rand(12, 80);
      const sr = rand(7, 22);
      const sg = g.createRadialGradient(sx, sy, 0, sx, sy, sr);
      const tint = pick(LEAF_SPOTS);
      sg.addColorStop(0, tint);
      sg.addColorStop(1, tint.replace(/[\d.]+\)$/, '0)'));
      g.fillStyle = sg;
      g.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    }
    if (back) {
      g.fillStyle = 'rgba(255,238,210,0.3)';
      g.fill(path);
    }
    /* darker, drier rim (only the inner half of the stroke survives the clip) */
    g.strokeStyle = back ? 'rgba(120,70,30,0.35)' : colors[1];
    g.globalAlpha = back ? 1 : 0.7;
    g.lineWidth = 4;
    g.stroke(path);
    g.globalAlpha = 1;
    g.strokeStyle = back ? 'rgba(255,245,225,0.5)' : 'rgba(255,225,160,0.32)';
    g.lineCap = 'round';
    g.beginPath();
    if (Array.isArray(shape.veins)) {
      const [ox, oy] = shape.origin;
      for (const [x, y] of shape.veins) {
        g.moveTo(ox, shape.base - 4);
        g.quadraticCurveTo(ox + (x - ox) * 0.35, oy + (y - oy) * 0.2, x, y);
      }
      g.lineWidth = 1.3;
    } else {
      g.moveTo(50, shape.base);
      g.lineTo(50, shape.tip + 4);
      const len = shape.base - shape.tip;
      for (let k = 1; k <= 5; k += 1) {
        const y = shape.base - len * (k / 6.2);
        const dx = 26 * Math.sin(Math.PI * (k / 6.2)) * 0.85;
        g.moveTo(50, y);
        g.quadraticCurveTo(50 - dx * 0.5, y - 3, 50 - dx, y - 12);
        g.moveTo(50, y);
        g.quadraticCurveTo(50 + dx * 0.5, y - 3, 50 + dx, y - 12);
      }
      g.lineWidth = 1.1;
    }
    g.stroke();
    g.restore();
    g.strokeStyle = colors[1];
    g.lineWidth = 2.2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(50, shape.base - 2);
    g.quadraticCurveTo(51.5, 95, 47.5, 99.5);
    g.stroke();
    return c;
  }

  /** Flat dark silhouette, drawn over a leaf turned edge-on to the light. */
  function leafShade(shapeIndex) {
    const size = 96;
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    g.scale(size / 100, size / 100);
    g.fillStyle = '#1b0c04';
    g.fill(leafPath(LEAF_SHAPES[shapeIndex]));
    return c;
  }

  function buildSprites(want) {
    const light = root.getAttribute('data-theme') === 'light';
    const out = { light, snow: null, leaves: null };
    if (want.snow) {
      out.snow = {
        flakes: [0.9, 1.3, 1.8, 2.4, 3.1].map((r) => [0, 1, 2].map(() => flakeSprite(r, light))),
        bokeh: [7, 9.5, 12].map((r) => bokehSprite(r, light)),
      };
    }
    if (want.leaves) {
      out.leaves = [];
      for (let s = 0; s < LEAF_SHAPES.length; s += 1) {
        const shade = leafShade(s);
        for (const colors of LEAF_COLORS) out.leaves.push({ front: leafSprite(s, colors, false), back: leafSprite(s, colors, true), shade });
      }
    }
    return out;
  }

  /* ── Particles ── */

  function spawnFlake(anyY) {
    const set = sprites.snow;
    const z = Math.pow(Math.random(), 1.5); // most flakes far away
    const bokeh = z > 0.95;
    const bucket = set.flakes[Math.min(set.flakes.length - 1, Math.floor(z * set.flakes.length))];
    const sprite = bokeh ? pick(set.bokeh) : pick(bucket);
    const depth = 0.4 + z;
    return {
      x: rand(-40, width + 40),
      y: anyY ? rand(-height * 0.1, height) : rand(-60, -10),
      z,
      sprite,
      vy: bokeh ? rand(85, 115) : 14 + z * 50 + rand(-4, 4),
      f1: rand(0.25, 0.7),
      f2: rand(1.1, 2.4),
      a1: rand(8, 20) * depth,
      a2: rand(2, 6) * depth,
      p1: rand(0, Math.PI * 2),
      p2: rand(0, Math.PI * 2),
      alpha: bokeh ? rand(0.3, 0.5) : 0.35 + z * 0.6,
    };
  }

  function spawnLeaf(anyY) {
    const z = rand(0.45, 1);
    const tumble = Math.random() < 0.35;
    return {
      x: rand(-60, width + 60),
      y: anyY ? rand(-height * 0.2, height) : rand(-120, -40),
      z,
      sprite: pick(sprites.leaves),
      size: (22 + Math.random() * 22) * (0.65 + z * 0.5),
      tumble,
      vy: (tumble ? 42 : 30) + z * 30 + rand(-6, 6),
      swing: tumble ? rand(6, 16) : rand(30, 60),
      swingFreq: tumble ? rand(0.5, 1) : rand(0.35, 0.7),
      phase: rand(0, Math.PI * 2),
      angle: rand(0, Math.PI * 2),
      rock: tumble ? 0.2 : rand(0.5, 0.85),
      spin: tumble ? rand(1.6, 3.2) * (Math.random() < 0.5 ? -1 : 1) : rand(-0.25, 0.25),
      flipFreq: tumble ? rand(1.5, 3) : rand(0.3, 0.8),
      flipPhase: rand(0, Math.PI * 2),
      tiltFreq: rand(0.4, 1.1),
      tiltPhase: rand(0, Math.PI * 2),
      alpha: 0.75 + z * 0.25,
    };
  }

  /** A recycled particle enters from the upwind side as often as the wind carries things in from there. */
  function enterUpwind(p, w, margin) {
    const side = Math.abs(w) / (Math.abs(w) + p.vy);
    if (Math.random() < side) {
      p.x = w > 0 ? -margin : width + margin;
      p.y = rand(-margin, height * 0.85);
    }
    return p;
  }

  function fill(list, want, spawn) {
    while (list.length < want) list.push(spawn(true));
    if (list.length > want) list.length = want;
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const area = width * height;
    /* both at once: a little thinner each, so the page does not turn into a blizzard */
    const both = active.snow && active.leaves;
    if (active.snow) fill(flakes, Math.round(Math.min(130, Math.max(28, area / 12000)) * (both ? 0.7 : 1)), spawnFlake);
    if (active.leaves) fill(leaves, Math.round(Math.min(24, Math.max(7, area / 56000)) * (both ? 0.7 : 1)), spawnLeaf);
  }

  /** Wind in px/s: two slow sines plus a rarer gust, smooth everywhere. */
  function wind(t) {
    const base = Math.sin(t * 0.07) * 14 + Math.sin(t * 0.19 + 1.3) * 8;
    const gust = Math.max(0, Math.sin(t * 0.045 + 0.7)) ** 6 * 38;
    return base + gust;
  }

  function drawFlakes(dt, w) {
    for (let i = 0; i < flakes.length; i += 1) {
      let p = flakes[i];
      /* turbulence: a slow wide drift plus a quick small flutter; the fall itself wavers a little */
      const flutter = Math.sin(clock * p.f2 * 0.7 + p.p2);
      p.y += p.vy * (1 + 0.16 * flutter) * dt;
      p.x += (w * (0.35 + p.z * 0.65) + Math.cos(clock * p.f1 + p.p1) * p.a1 + Math.cos(clock * p.f2 + p.p2) * p.a2) * dt;
      if (p.y - 20 > height || p.x < -80 || p.x > width + 80) {
        p = flakes[i] = enterUpwind(spawnFlake(false), w, 30);
      }
      const s = p.sprite;
      ctx.globalAlpha = p.alpha;
      ctx.drawImage(s, p.x - s.width / 2, p.y - s.height / 2);
    }
  }

  function drawLeaves(dt, w) {
    for (let i = 0; i < leaves.length; i += 1) {
      let p = leaves[i];
      const ph = clock * p.swingFreq + p.phase;
      const swing = Math.sin(ph);
      const swingCos = Math.cos(ph);
      /* falling-leaf glide: sideways speed peaks mid-swing, the leaf rocks up and nearly stops falling at
         each end of the swing; a tumbling leaf just spins down faster */
      p.x += (w * (0.5 + p.z * 0.5) + swingCos * p.swing * p.swingFreq * 2) * dt;
      p.y += p.vy * (p.tumble ? 1 : 0.35 + 0.65 * Math.abs(swingCos)) * dt;
      p.angle += p.spin * dt;
      if (p.y - p.size > height || p.x < -120 || p.x > width + 120) {
        p = leaves[i] = enterUpwind(spawnLeaf(false), w, 60);
      }
      const flip = Math.cos(clock * p.flipFreq + p.flipPhase);
      const sx = Math.max(0.1, Math.abs(flip));
      const sy = 0.78 + 0.22 * Math.abs(Math.cos(clock * p.tiltFreq + p.tiltPhase));
      const sprite = flip >= 0 ? p.sprite.front : p.sprite.back;
      ctx.globalAlpha = p.alpha;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle + swing * p.rock);
      ctx.scale(sx, sy);
      ctx.drawImage(sprite, -p.size / 2, -p.size / 2, p.size, p.size);
      if (sx < 0.85) {
        ctx.globalAlpha = p.alpha * (0.85 - sx) * 0.6;
        ctx.drawImage(p.sprite.shade, -p.size / 2, -p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }
  }

  function frame(now) {
    raf = 0;
    if (!canvas) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    clock += dt;
    const w = wind(clock);
    ctx.clearRect(0, 0, width, height);
    if (active.leaves) drawLeaves(dt, w);
    if (active.snow) drawFlakes(dt, w);
    ctx.globalAlpha = 1;
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }

  function startCanvas(want) {
    const host = document.querySelector('.ui-decor');
    if (!host) return;
    stopCanvas();
    active = { snow: want.snow, leaves: want.leaves };
    sprites = buildSprites(want);
    canvas = document.createElement('canvas');
    canvas.className = 'ui-decor-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    ctx = canvas.getContext('2d');
    flakes = [];
    leaves = [];
    resize();
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stopCanvas() {
    active = { snow: false, leaves: false };
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    flakes = [];
    leaves = [];
    sprites = null;
    if (canvas) canvas.remove();
    canvas = null;
    ctx = null;
  }

  /* ── Garland ── */

  /* [glass base, light, deep edge] per bulb colour — classic C9 glass, not neon */
  const BULB_COLORS = [
    ['#e5312b', '#ffb4a3', '#8f1010'],
    ['#22b35a', '#b8f5cc', '#0b6a2e'],
    ['#f2a51d', '#ffe7a8', '#9c5a00'],
    ['#2f80e6', '#bcdcff', '#123f94'],
    ['#d8429c', '#ffc4e6', '#8a1460'],
  ];

  /**
   * One SVG per width. Hooks (small clips) every ~200 px, a twisted two-strand wire sagging between
   * them, a C9 bulb every ~34 px (a little uneven) hanging from it mostly straight down: metal socket,
   * glass lit from inside (near-white core low in the bulb, saturated edge), a soft halo. Lights are
   * steady; about one bulb in seven twinkles slowly (class ui-garland-tw, per-bulb --t / --d).
   */
  function garlandSvg(totalWidth) {
    const spans = Math.max(2, Math.round(totalWidth / 200));
    const spanW = totalWidth / spans;
    const sag = 15;
    const top = 4;
    const height = top + sag * 2 + 34;
    let wire = `M0 ${top}`;
    for (let i = 0; i < spans; i += 1) {
      const x0 = i * spanW;
      wire += ` Q${(x0 + spanW / 2).toFixed(1)} ${top + sag * 2} ${(x0 + spanW).toFixed(1)} ${top}`;
    }
    let defs = '<linearGradient id="gl-cap" x1="0" y1="0" x2="1" y2="0">'
      + '<stop offset="0" stop-color="#4f555c"/><stop offset=".45" stop-color="#c9ced4"/><stop offset="1" stop-color="#3e434a"/></linearGradient>';
    BULB_COLORS.forEach(([base, light, deep], i) => {
      defs += `<radialGradient id="gl-b${i}" cx=".5" cy=".62" r=".62">`
        + `<stop offset="0" stop-color="#fffdf2"/><stop offset=".2" stop-color="${light}"/>`
        + `<stop offset=".58" stop-color="${base}"/><stop offset="1" stop-color="${deep}"/></radialGradient>`
        + `<radialGradient id="gl-h${i}"><stop offset="0" stop-color="${light}" stop-opacity=".55"/>`
        + `<stop offset=".18" stop-color="${base}" stop-opacity=".34"/><stop offset=".5" stop-color="${base}" stop-opacity=".1"/>`
        + `<stop offset="1" stop-color="${base}" stop-opacity="0"/></radialGradient>`;
    });
    const perSpan = Math.max(4, Math.round(spanW / 34));
    let bulbs = '';
    let hooks = '';
    let n = 0;
    for (let i = 0; i <= spans; i += 1) {
      const x = (i * spanW).toFixed(1);
      hooks += `<g class="ui-garland-hook" transform="translate(${x} ${top})"><rect x="-2.5" y="-3" width="5" height="5" rx="1.5"/><circle cy="-3" r="1.4"/></g>`;
    }
    for (let i = 0; i < spans; i += 1) {
      for (let k = 1; k < perSpan; k += 1) {
        const tt = Math.min(0.97, Math.max(0.03, (k + (Math.random() - 0.5) * 0.18) / perSpan));
        const x = i * spanW + tt * spanW;
        const y = top + sag * 2 * 2 * tt * (1 - tt);
        const c = n % BULB_COLORS.length;
        /* the socket follows the wire a little, the glass hangs mostly straight down */
        const slope = Math.atan2(sag * 4 * (1 - 2 * tt), spanW) * 57.3;
        const tilt = (slope * 0.25 + (Math.random() - 0.5) * 14).toFixed(1);
        const scale = (0.92 + Math.random() * 0.14).toFixed(2);
        const twinkle = Math.random() < 0.15;
        const vars = twinkle ? ` style="--t:${(6 + Math.random() * 6).toFixed(2)}s;--d:${(-Math.random() * 12).toFixed(2)}s"` : '';
        bulbs += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${tilt}) scale(${scale})">`
          + `<g class="ui-garland-bulb${twinkle ? ' ui-garland-tw' : ''}"${vars}>`
          + `<ellipse class="ui-garland-halo" cx="0" cy="15" rx="17" ry="19" fill="url(#gl-h${c})"/>`
          + '<path class="ui-garland-socket" d="M-2.8 0h5.6v5.2a1.2 1.2 0 0 1-1.2 1.2h-3.2a1.2 1.2 0 0 1-1.2-1.2z" fill="url(#gl-cap)"/>'
          + `<path class="ui-garland-glass" d="M-3.4 6C-6.2 10-6 17 0 22C6 17 6.2 10 3.4 6Z" fill="url(#gl-b${c})"/>`
          + '<path class="ui-garland-shine" d="M-2.2 9.5C-3.2 11.6-3.1 13.6-2.3 15.2" />'
          + '</g></g>';
        n += 1;
      }
    }
    return `<svg width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}" aria-hidden="true" focusable="false">`
      + `<defs>${defs}</defs>`
      + `<path class="ui-garland-wire" d="${wire}"/><path class="ui-garland-wire-twist" d="${wire}"/>`
      + `${bulbs}${hooks}</svg>`;
  }

  function layoutGarland() {
    if (!garland) return;
    const w = Math.round(document.documentElement.clientWidth || window.innerWidth);
    if (!w || w === garlandWidth) return;
    garlandWidth = w;
    garland.innerHTML = garlandSvg(w);
  }

  function startGarland() {
    if (garland || !document.body) return;
    garland = document.createElement('div');
    garland.className = 'ui-garland';
    garland.setAttribute('aria-hidden', 'true');
    document.body.appendChild(garland);
    garlandWidth = 0;
    layoutGarland();
    /* the usable width changes without a window resize too (a scrollbar appears or goes) */
    if (window.ResizeObserver) {
      garlandObserver = new ResizeObserver(layoutGarland);
      garlandObserver.observe(document.documentElement);
    }
  }

  function stopGarland() {
    if (garlandObserver) garlandObserver.disconnect();
    garlandObserver = null;
    if (garland) garland.remove();
    garland = null;
    garlandWidth = 0;
  }

  /* ── Control ── */

  function sync() {
    const want = wanted();
    const light = root.getAttribute('data-theme') === 'light';
    const canvasWanted = want.snow || want.leaves;
    const same = canvas && active.snow === want.snow && active.leaves === want.leaves && sprites && sprites.light === light;
    if (!canvasWanted) stopCanvas();
    else if (!same) startCanvas(want);
    if (want.garland) startGarland(); else stopGarland();
  }

  window.addEventListener('resize', () => {
    if (canvas) resize();
    layoutGarland();
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && canvas && !raf) { last = 0; raf = requestAnimationFrame(frame); }
  });
  if (reduceMotion && reduceMotion.addEventListener) reduceMotion.addEventListener('change', sync);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-ui-decor', 'data-theme', 'data-eink'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
})();
