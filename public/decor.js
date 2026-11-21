/*
 * Seasonal decoration (Admin → Appearance → Effects «Сезонное украшение»). html[data-ui-decor] is a
 * space-separated list — any combination of:
 *   snow    — canvas (.ui-decor, z −1 under the content): soft flakes on depth layers (near = bigger,
 *             softer, faster), each swaying at its own rate in a gusting wind; the nearest are crystals;
 *   leaves  — the same canvas: maple / oak / elm silhouettes with veins and a stalk in autumn colours,
 *             tumbling (spin, flip with a paler underside, pendulum swing) while drifting with the wind;
 *   garland — an SVG string of C9 bulbs hung under the top bar ([data-topbar]): a twisted wire sagging
 *             between clips, glass with a radial gradient, a soft halo; bulbs sway and their light runs
 *             in a wave with jitter (CSS animations; still with reduced motion);
 *   drifts  — CSS only (styles.css «Snow drifts»): snow caps on the top edges of cards and panels.
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

  /** Soft flake: a radial gradient disc; light theme gets a blue-grey rim so it shows on parchment. */
  function flakeSprite(radius, light) {
    const size = radius * 2 + 4;
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const cx = size / 2;
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, radius + 1);
    if (light) {
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.55, 'rgba(236,242,250,0.95)');
      grad.addColorStop(0.85, 'rgba(120,145,180,0.55)');
      grad.addColorStop(1, 'rgba(120,145,180,0)');
    } else {
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.45, 'rgba(255,255,255,0.85)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
    }
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cx, radius + 1, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  /** Six-armed crystal for the nearest flakes. */
  function crystalSprite(radius, light) {
    const size = radius * 2 + 6;
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const cx = size / 2;
    g.translate(cx, cx);
    g.lineCap = 'round';
    const draw = (stroke, width) => {
      g.strokeStyle = stroke;
      g.lineWidth = width;
      for (let i = 0; i < 6; i += 1) {
        g.save();
        g.rotate((Math.PI / 3) * i);
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -radius);
        for (const at of [0.45, 0.72]) {
          const len = radius * (at === 0.45 ? 0.32 : 0.22);
          g.moveTo(0, -radius * at);
          g.lineTo(-len, -radius * at - len * 0.8);
          g.moveTo(0, -radius * at);
          g.lineTo(len, -radius * at - len * 0.8);
        }
        g.stroke();
        g.restore();
      }
    };
    if (light) draw('rgba(110,135,170,0.55)', Math.max(1.6, radius * 0.16));
    draw('rgba(255,255,255,0.95)', Math.max(1, radius * 0.1));
    return c;
  }

  /*
   * Leaf outlines in a 100×100 box, the stalk joins at (50, ~88). `veins`: 'palmate' = from the base to
   * each lobe tip (maple), otherwise a midrib with side veins.
   */
  const LEAF_SHAPES = [
    // maple: five sharp lobes with teeth and deep sinuses
    { d: 'M51 86 L60 80 L70 88 L74 78 L86 80 L80 70 L68 62 L82 58 L98 52 L86 46 L92 30 L82 36 L78 22 L74 34 L60 44 L68 26 L60 30 L62 16 L56 18 L50 4 L44 18 L38 16 L40 30 L32 26 L40 44 L26 34 L22 22 L18 36 L8 30 L14 46 L2 52 L18 58 L32 62 L20 70 L14 80 L26 78 L30 88 L40 80 L49 86 Z', base: 86, veins: [[50, 4], [78, 22], [22, 22], [98, 52], [2, 52], [86, 80], [14, 80]] },
    // oak: an oblong blade with rounded lobes and deep bays, narrow at the stalk
    { d: 'M50 92 Q74 88 57 74 Q86 68 60 58 Q90 47 60 40 Q84 30 57 24 Q70 8 50 4 Q30 8 43 24 Q16 30 40 40 Q10 47 40 58 Q14 68 43 74 Q26 88 50 92 Z', base: 92, veins: 'pinnate' },
    // elm: an ovate blade with a pointed tip and a serrated edge
    { d: 'M50 90 C40 88 30 82 25 72 L28 70 C22 62 19 52 20 42 L23 42 C25 30 31 19 39 11 L41 13 C44 8 47 4 50 0 C53 4 56 8 59 13 L61 11 C69 19 75 30 77 42 L80 42 C81 52 78 62 72 70 L75 72 C70 82 60 88 50 90 Z', base: 90, veins: 'pinnate' },
  ];
  const LEAF_COLORS = [
    ['#d9822b', '#9c4a12'], ['#e3a127', '#a8650f'], ['#c8452c', '#7e2214'],
    ['#b8322a', '#6d1a15'], ['#d6b23a', '#94721a'], ['#a8662c', '#5f3612'],
    ['#e07b39', '#a43e16'], ['#9d8a2e', '#5c4f16'],
  ];

  function leafSprite(shapeIndex, colors, back) {
    const size = 96;
    const shape = LEAF_SHAPES[shapeIndex];
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const path = new Path2D(shape.d);
    g.scale(size / 100, size / 100);
    const grad = g.createLinearGradient(20, 10, 80, 95);
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(1, colors[1]);
    g.fillStyle = grad;
    g.fill(path);
    if (back) {
      g.fillStyle = 'rgba(255,240,215,0.28)';
      g.fill(path);
    }
    g.save();
    g.clip(path);
    g.strokeStyle = back ? 'rgba(255,245,225,0.45)' : 'rgba(60,25,8,0.4)';
    g.lineCap = 'round';
    g.beginPath();
    if (Array.isArray(shape.veins)) {
      for (const [x, y] of shape.veins) {
        g.moveTo(50, shape.base);
        g.lineTo(50 + (x - 50) * 0.92, shape.base + (y - shape.base) * 0.92);
      }
      g.lineWidth = 1.5;
    } else {
      g.moveTo(50, shape.base);
      g.lineTo(50, 6);
      for (const [y, dx, dy] of [[78, 24, -14], [64, 26, -16], [50, 24, -16], [36, 18, -13], [22, 10, -9]]) {
        g.moveTo(50, y);
        g.lineTo(50 - dx, y + dy);
        g.moveTo(50, y);
        g.lineTo(50 + dx, y + dy);
      }
      g.lineWidth = 1.4;
    }
    g.stroke();
    g.restore();
    g.strokeStyle = colors[1];
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(50, shape.base - 2);
    g.quadraticCurveTo(51, 96, 48, 100);
    g.stroke();
    return c;
  }

  function buildSprites(want) {
    const light = root.getAttribute('data-theme') === 'light';
    const out = { light, snow: null, leaves: null };
    if (want.snow) {
      out.snow = {
        flakes: [1, 1.6, 2.3, 3.2, 4.4].map((r) => flakeSprite(r, light)),
        crystals: [6, 8, 10].map((r) => crystalSprite(r, light)),
      };
    }
    if (want.leaves) {
      out.leaves = [];
      for (let s = 0; s < LEAF_SHAPES.length; s += 1) {
        for (const colors of LEAF_COLORS) out.leaves.push({ front: leafSprite(s, colors, false), back: leafSprite(s, colors, true) });
      }
    }
    return out;
  }

  /* ── Particles ── */

  function spawnFlake(anyY) {
    const set = sprites.snow;
    const z = Math.pow(Math.random(), 1.6); // most flakes far away
    const crystal = z > 0.93 && Math.random() < 0.6;
    const sprite = crystal ? pick(set.crystals) : set.flakes[Math.min(set.flakes.length - 1, Math.floor(z * set.flakes.length))];
    return {
      x: rand(-40, width + 40),
      y: anyY ? rand(-height * 0.1, height) : rand(-60, -10),
      z,
      sprite,
      crystal,
      vy: 16 + z * 52 + rand(-4, 4),
      sway: rand(6, 22) * (0.4 + z),
      freq: rand(0.25, 0.9),
      phase: rand(0, Math.PI * 2),
      alpha: 0.35 + z * 0.6,
      spin: crystal ? rand(-0.6, 0.6) : 0,
      angle: rand(0, Math.PI * 2),
    };
  }

  function spawnLeaf(anyY) {
    const z = rand(0.45, 1);
    return {
      x: rand(-60, width + 60),
      y: anyY ? rand(-height * 0.2, height) : rand(-120, -40),
      z,
      sprite: pick(sprites.leaves),
      size: (24 + Math.random() * 24) * (0.65 + z * 0.5),
      vy: 26 + z * 34 + rand(-6, 6),
      swing: rand(22, 55),
      swingFreq: rand(0.35, 0.8),
      phase: rand(0, Math.PI * 2),
      angle: rand(0, Math.PI * 2),
      spin: rand(-1.4, 1.4),
      flipFreq: rand(0.6, 1.8),
      flipPhase: rand(0, Math.PI * 2),
      alpha: 0.7 + z * 0.3,
    };
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
    if (active.leaves) fill(leaves, Math.round(Math.min(26, Math.max(7, area / 52000)) * (both ? 0.7 : 1)), spawnLeaf);
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
      p.y += p.vy * dt;
      p.x += (w * (0.35 + p.z * 0.65)) * dt + Math.cos(clock * p.freq + p.phase) * p.sway * dt;
      if (p.y - 20 > height || p.x < -80 || p.x > width + 80) {
        p = flakes[i] = spawnFlake(false);
        if (w > 8) p.x = rand(-80, width * 0.8);
      }
      const s = p.sprite;
      ctx.globalAlpha = p.alpha;
      if (p.crystal) {
        p.angle += p.spin * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.drawImage(s, -s.width / 2, -s.height / 2);
        ctx.restore();
      } else {
        ctx.drawImage(s, p.x - s.width / 2, p.y - s.height / 2);
      }
    }
  }

  function drawLeaves(dt, w) {
    for (let i = 0; i < leaves.length; i += 1) {
      let p = leaves[i];
      const swing = Math.sin(clock * p.swingFreq + p.phase);
      const swingCos = Math.cos(clock * p.swingFreq + p.phase);
      /* pendulum: sideways speed peaks mid-swing, the fall slows at the ends of the swing */
      p.x += (w * (0.5 + p.z * 0.5) + swingCos * p.swing * p.swingFreq) * dt;
      p.y += p.vy * (0.75 + 0.25 * Math.abs(swingCos)) * dt;
      p.angle += (p.spin + swing * 0.6) * dt;
      if (p.y - p.size > height || p.x < -120 || p.x > width + 120) {
        p = leaves[i] = spawnLeaf(false);
        if (w > 10) p.x = rand(-120, width * 0.7);
      }
      const flip = Math.cos(clock * p.flipFreq + p.flipPhase);
      const sprite = flip >= 0 ? p.sprite.front : p.sprite.back;
      ctx.globalAlpha = p.alpha;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle + swing * 0.35);
      ctx.scale(Math.max(0.12, Math.abs(flip)), 1);
      ctx.drawImage(sprite, -p.size / 2, -p.size / 2, p.size, p.size);
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

  /* [glass base, light centre, deep edge] per bulb colour */
  const BULB_COLORS = [
    ['#ff3b3b', '#ffc2b8', '#a30d16'],
    ['#ffc21a', '#fff1b3', '#b07400'],
    ['#2fd36b', '#c4ffd8', '#0b7a35'],
    ['#2e9bff', '#c2e4ff', '#0b4fa8'],
    ['#ff5ccf', '#ffd0f2', '#a3127c'],
    ['#ff8a1f', '#ffd9b0', '#b04a00'],
  ];

  /**
   * One SVG per width. Hooks (small clips) every ~200 px, a twisted two-strand wire sagging between
   * them, a C9 bulb every ~32 px hanging from it: metal socket, glass teardrop with a radial gradient
   * and a shine, a soft halo (radial gradient, no blur filter). Bulbs sway a little and their light runs
   * in a wave along the string with some jitter (CSS animations, per-bulb --t / --d / --s).
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
      + '<stop offset="0" stop-color="#5d636b"/><stop offset=".45" stop-color="#d9dde2"/><stop offset="1" stop-color="#4a4f56"/></linearGradient>';
    BULB_COLORS.forEach(([base, light, deep], i) => {
      defs += `<radialGradient id="gl-b${i}" cx=".38" cy=".32" r=".75">`
        + `<stop offset="0" stop-color="${light}"/><stop offset=".45" stop-color="${base}"/><stop offset="1" stop-color="${deep}"/></radialGradient>`
        + `<radialGradient id="gl-h${i}"><stop offset="0" stop-color="${light}" stop-opacity=".7"/>`
        + `<stop offset=".22" stop-color="${base}" stop-opacity=".42"/><stop offset=".55" stop-color="${base}" stop-opacity=".12"/>`
        + `<stop offset="1" stop-color="${base}" stop-opacity="0"/></radialGradient>`;
    });
    const perSpan = Math.max(4, Math.round(spanW / 32));
    let bulbs = '';
    let hooks = '';
    let n = 0;
    for (let i = 0; i <= spans; i += 1) {
      const x = (i * spanW).toFixed(1);
      hooks += `<g class="ui-garland-hook" transform="translate(${x} ${top})"><rect x="-2.5" y="-3" width="5" height="5" rx="1.5"/><circle cy="-3" r="1.4"/></g>`;
    }
    for (let i = 0; i < spans; i += 1) {
      for (let k = 1; k < perSpan; k += 1) {
        const tt = k / perSpan;
        const x = i * spanW + tt * spanW;
        const y = top + sag * 2 * 2 * tt * (1 - tt);
        const c = n % BULB_COLORS.length;
        /* hang along the wire's slope, then let gravity win a little */
        const slope = Math.atan2(sag * 4 * (1 - 2 * tt), spanW) * 57.3;
        const tilt = (slope * 0.45 + (Math.random() - 0.5) * 10).toFixed(1);
        const t = (2.6 + Math.random() * 1.4).toFixed(2);
        const d = (n * 0.17 - Math.random() * 0.5).toFixed(2);
        const s = (3.2 + Math.random() * 2.4).toFixed(2);
        bulbs += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${tilt})">`
          + `<g class="ui-garland-bulb" style="--t:${t}s;--d:${d}s;--s:${s}s">`
          + `<circle class="ui-garland-halo" cx="0" cy="14" r="20" fill="url(#gl-h${c})"/>`
          + '<path class="ui-garland-socket" d="M-2.8 0h5.6v5.2a1.2 1.2 0 0 1-1.2 1.2h-3.2a1.2 1.2 0 0 1-1.2-1.2z" fill="url(#gl-cap)"/>'
          + `<path class="ui-garland-glass" d="M-3.4 6C-6.2 10-6 17 0 22C6 17 6.2 10 3.4 6Z" fill="url(#gl-b${c})"/>`
          + '<path class="ui-garland-shine" d="M-2.1 9C-3.3 11.5-3.2 14-2.2 16" />'
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
    const w = Math.round(garland.parentElement ? garland.parentElement.clientWidth : window.innerWidth);
    if (!w || w === garlandWidth) return;
    garlandWidth = w;
    garland.innerHTML = garlandSvg(w);
  }

  function startGarland() {
    const bar = document.querySelector('[data-topbar]');
    if (!bar || garland) return;
    garland = document.createElement('div');
    garland.className = 'ui-garland';
    garland.setAttribute('aria-hidden', 'true');
    bar.appendChild(garland);
    garlandWidth = 0;
    layoutGarland();
    /* the bar's width changes without a window resize too (sidebar, zoom, scrollbar) */
    if (window.ResizeObserver) {
      garlandObserver = new ResizeObserver(layoutGarland);
      garlandObserver.observe(bar);
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
