/*
 * Seasonal decoration (Admin → Appearance → Effects «Сезонное украшение», html[data-ui-decor]).
 * Canvas particles under the page content (.ui-decor, z −1):
 *   snow   — soft flakes on three depth layers (near = bigger, softer, faster), each swaying at its own
 *            rate, a smoothly gusting wind; the nearest few are six-armed crystals;
 *   leaves — maple / oak / elm silhouettes with veins and a stalk in autumn colours, tumbling: they spin,
 *            flip over (the underside is paler) and swing like a pendulum while drifting with the wind.
 * Sprites are drawn once; the particle count follows the screen area; DPR ≤ 1.5; paused in a hidden tab;
 * nothing runs while the attribute is absent (a MutationObserver waits for the admin live preview),
 * with prefers-reduced-motion or in E-Ink mode.
 */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  let canvas = null;
  let ctx = null;
  let raf = 0;
  let mode = '';
  let particles = [];
  let sprites = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let last = 0;
  let clock = 0;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  function wantedMode() {
    const value = root.getAttribute('data-ui-decor') || '';
    if (value !== 'snow' && value !== 'leaves') return '';
    if (root.getAttribute('data-eink') === '1') return '';
    if (reduceMotion && reduceMotion.matches) return '';
    return value;
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

  function buildSprites(kind) {
    const light = root.getAttribute('data-theme') === 'light';
    if (kind === 'snow') {
      return {
        light,
        flakes: [1, 1.6, 2.3, 3.2, 4.4].map((r) => flakeSprite(r, light)),
        crystals: [6, 8, 10].map((r) => crystalSprite(r, light)),
      };
    }
    const leaves = [];
    for (let s = 0; s < LEAF_SHAPES.length; s += 1) {
      for (const colors of LEAF_COLORS) leaves.push({ front: leafSprite(s, colors, false), back: leafSprite(s, colors, true) });
    }
    return { light, leaves };
  }

  /* ── Particles ── */

  function spawnFlake(anyY) {
    const z = Math.pow(Math.random(), 1.6); // most flakes far away
    const crystal = z > 0.93 && Math.random() < 0.6;
    const sprite = crystal ? pick(sprites.crystals) : sprites.flakes[Math.min(sprites.flakes.length - 1, Math.floor(z * sprites.flakes.length))];
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
    const sprite = pick(sprites.leaves);
    return {
      x: rand(-60, width + 60),
      y: anyY ? rand(-height * 0.2, height) : rand(-120, -40),
      z,
      sprite,
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

  function targetCount() {
    const area = width * height;
    return mode === 'snow'
      ? Math.round(Math.min(130, Math.max(28, area / 12000)))
      : Math.round(Math.min(26, Math.max(7, area / 52000)));
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
    const want = targetCount();
    const spawn = mode === 'snow' ? spawnFlake : spawnLeaf;
    while (particles.length < want) particles.push(spawn(true));
    if (particles.length > want) particles.length = want;
  }

  /** Wind in px/s: two slow sines plus a rarer gust, smooth everywhere. */
  function wind(t) {
    const base = Math.sin(t * 0.07) * 14 + Math.sin(t * 0.19 + 1.3) * 8;
    const gust = Math.max(0, Math.sin(t * 0.045 + 0.7)) ** 6 * 38;
    return base + gust;
  }

  function frame(now) {
    raf = 0;
    if (!mode) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    clock += dt;
    const w = wind(clock);
    ctx.clearRect(0, 0, width, height);
    if (mode === 'snow') {
      for (let i = 0; i < particles.length; i += 1) {
        let p = particles[i];
        p.y += p.vy * dt;
        p.x += (w * (0.35 + p.z * 0.65)) * dt + Math.cos(clock * p.freq + p.phase) * p.sway * dt;
        if (p.y - 20 > height || p.x < -80 || p.x > width + 80) {
          p = particles[i] = spawnFlake(false);
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
    } else {
      for (let i = 0; i < particles.length; i += 1) {
        let p = particles[i];
        const swing = Math.sin(clock * p.swingFreq + p.phase);
        /* pendulum: sideways speed peaks mid-swing, the fall slows at the ends of the swing */
        p.x += (w * (0.5 + p.z * 0.5) + Math.cos(clock * p.swingFreq + p.phase) * p.swing * p.swingFreq) * dt;
        p.y += p.vy * (0.75 + 0.25 * Math.abs(Math.cos(clock * p.swingFreq + p.phase))) * dt;
        p.angle += (p.spin + swing * 0.6) * dt;
        if (p.y - p.size > height || p.x < -120 || p.x > width + 120) {
          p = particles[i] = spawnLeaf(false);
          if (w > 10) p.x = rand(-120, width * 0.7);
        }
        const flip = Math.cos(clock * p.flipFreq + p.flipPhase);
        const sprite = flip >= 0 ? p.sprite.front : p.sprite.back;
        const sx = Math.max(0.12, Math.abs(flip));
        ctx.globalAlpha = p.alpha;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle + swing * 0.35);
        ctx.scale(sx, 1);
        ctx.drawImage(sprite, -p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }

  function start(kind) {
    const host = document.querySelector('.ui-decor');
    if (!host) return;
    stop();
    mode = kind;
    sprites = buildSprites(kind);
    canvas = document.createElement('canvas');
    canvas.className = 'ui-decor-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    ctx = canvas.getContext('2d');
    particles = [];
    resize();
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    mode = '';
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    particles = [];
    sprites = null;
    if (canvas) canvas.remove();
    canvas = null;
    ctx = null;
  }

  function sync() {
    const want = wantedMode();
    const theme = root.getAttribute('data-theme');
    if (want === mode && (!sprites || sprites.light === (theme === 'light'))) return;
    if (want) start(want); else stop();
  }

  window.addEventListener('resize', () => { if (mode) resize(); }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && mode && !raf) { last = 0; raf = requestAnimationFrame(frame); }
  });
  if (reduceMotion && reduceMotion.addEventListener) reduceMotion.addEventListener('change', sync);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-ui-decor', 'data-theme', 'data-eink'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
})();
