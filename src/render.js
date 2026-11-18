/*!
 * Ghost Race — render.js
 * Draws one frame of the race onto a 2D canvas. Rendering is a pure function
 * of (race, playback time), so scrubbing, replays and exported clips all show
 * exactly the same thing.
 *
 * Two layouts: 16:9 (1920x1080) and square (1080x1080). Everything is drawn in
 * layout units multiplied by a scale factor, so any canvas size works.
 */
(function (root) {
  'use strict';

  const GR = (root.GhostRace = root.GhostRace || {});

  const C = {
    asphalt: '#171A21',
    tarmac: '#2A2F3A',
    paint: '#F2F4F7',
    dim: '#8E97A8',
    faint: 'rgba(242,244,247,0.08)',
    kerb: '#E5484D',
    purple: '#A970FF',
    green: '#3CCB7F',
    yellow: '#FFC93C',
    ink: '#14161C',
  };
  GR.COLORS = C;

  const DISPLAY = '"Anton", Impact, "Arial Narrow", sans-serif';
  const TEXT = '"Fira Sans", "Segoe UI", system-ui, -apple-system, sans-serif';
  GR.FONTS = { display: DISPLAY, text: TEXT };

  const UNIT = { time: 'agent time', tokens: 'tokens burned', steps: 'moves' };

  // ------------------------------------------------------------- timeline --

  GR.makeTimeline = function makeTimeline(raceSeconds) {
    const t = { intro: 2.4, race: raceSeconds || 14, hold: 1.4, outro: 4.6 };
    t.total = t.intro + t.race + t.hold + t.outro;
    return t;
  };

  GR.frameAt = function frameAt(tl, race, t) {
    t = GR.clamp(t, 0, tl.total);
    if (t < tl.intro) return { t, phase: 'intro', phaseT: t, x: 0 };
    if (t < tl.intro + tl.race) {
      const f = (t - tl.intro) / tl.race;
      return { t, phase: 'race', phaseT: t - tl.intro, x: f * race.maxX };
    }
    if (t < tl.intro + tl.race + tl.hold) return { t, phase: 'hold', phaseT: t - tl.intro - tl.race, x: race.maxX };
    return { t, phase: 'outro', phaseT: t - tl.intro - tl.race - tl.hold, x: race.maxX };
  };

  // --------------------------------------------------------------- layout --

  function layoutFor(W, H) {
    if (W / H >= 1.3) {
      const s = W / 1920;
      return {
        kind: 'wide', square: false, tall: false, narrow: false, s, W, H,
        tower: { x: 48 * s, y: 52 * s, w: 436 * s, h: H - 104 * s },
        track: { x: 556 * s, y: 70 * s, w: 1316 * s, h: 850 * s },
        control: { cx: (556 + 658) * s, y: 952 * s },
        laneW: 14 * s,
      };
    }
    const s = W / 1080;
    if (W / H < 0.8) {
      // 9:16 for phone feeds
      return {
        kind: 'tall', square: false, tall: true, narrow: true, s, W, H,
        header: { x: 60 * s, y: 76 * s, w: 960 * s },
        track: { x: 84 * s, y: 330 * s, w: 912 * s, h: 780 * s },
        control: { cx: 540 * s, y: 1196 * s },
        tower: { x: 60 * s, y: 1276 * s, w: 960 * s, h: 470 * s },
        laneW: 13 * s,
      };
    }
    return {
      kind: 'square', square: true, tall: false, narrow: true, s, W, H,
      header: { x: 44 * s, y: 36 * s, w: 992 * s },
      track: { x: 70 * s, y: 176 * s, w: 940 * s, h: 462 * s },
      control: { cx: 540 * s, y: 712 * s },
      tower: { x: 44 * s, y: 752 * s, w: 992 * s, h: 296 * s },
      laneW: 12 * s,
    };
  }

  // ---------------------------------------------------------------- track --

  // A hand-drawn circuit, normalised to the track box. Clockwise, with the
  // start/finish line on the bottom straight.
  const CIRCUIT = [
    [0.52, 0.9], [0.27, 0.91], [0.09, 0.8], [0.05, 0.52], [0.11, 0.24], [0.25, 0.09],
    [0.41, 0.13], [0.48, 0.33], [0.61, 0.39], [0.7, 0.2], [0.84, 0.08], [0.95, 0.22],
    [0.94, 0.48], [0.81, 0.6], [0.9, 0.78], [0.77, 0.91],
  ];

  function catmull(p0, p1, p2, p3, u) {
    const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6, 0.5);
    const t0 = 0;
    const t1 = t0 + d(p0, p1);
    const t2 = t1 + d(p1, p2);
    const t3 = t2 + d(p2, p3);
    const t = t1 + (t2 - t1) * u;
    const mix = (a, b, ta, tb) => [((tb - t) / (tb - ta)) * a[0] + ((t - ta) / (tb - ta)) * b[0], ((tb - t) / (tb - ta)) * a[1] + ((t - ta) / (tb - ta)) * b[1]];
    const a1 = mix(p0, p1, t0, t1);
    const a2 = mix(p1, p2, t1, t2);
    const a3 = mix(p2, p3, t2, t3);
    const b1 = mix(a1, a2, t0, t2);
    const b2 = mix(a2, a3, t1, t3);
    return mix(b1, b2, t1, t2);
  }

  function buildTrack(L, lanes) {
    const box = L.track;
    const P = CIRCUIT.map(([u, v]) => [box.x + u * box.w, box.y + v * box.h]);
    const n = P.length;
    const raw = [];
    const SEG = 60;
    for (let i = 0; i < n; i++) {
      const p0 = P[(i - 1 + n) % n];
      const p1 = P[i];
      const p2 = P[(i + 1) % n];
      const p3 = P[(i + 2) % n];
      for (let j = 0; j < SEG; j++) raw.push(catmull(p0, p1, p2, p3, j / SEG));
    }
    const pts = [];
    let d = 0;
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if (i > 0) d += Math.hypot(a[0] - raw[i - 1][0], a[1] - raw[i - 1][1]);
      pts.push({ x: a[0], y: a[1], d });
    }
    const length = d + Math.hypot(raw[0][0] - raw[raw.length - 1][0], raw[0][1] - raw[raw.length - 1][1]);
    const m = pts.length;
    for (let i = 0; i < m; i++) {
      const a = pts[(i - 1 + m) % m];
      const b = pts[(i + 1) % m];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      pts[i].tx = (b.x - a.x) / len;
      pts[i].ty = (b.y - a.y) / len;
    }
    // signed curvature from neighbouring tangents
    for (let i = 0; i < m; i++) {
      const a = pts[(i - 3 + m) % m];
      const b = pts[(i + 3) % m];
      const cross = a.tx * b.ty - a.ty * b.tx;
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      pts[i].k = cross / dist;
    }
    const laneW = L.laneW;
    const roadW = Math.max(lanes, 3) * laneW + 16 * L.s;
    return { pts, length, laneW, roadW, lanes };
  }

  function pointAt(track, d, off) {
    const { pts, length } = track;
    d = ((d % length) + length) % length;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].d <= d) lo = mid;
      else hi = mid - 1;
    }
    const a = pts[lo];
    const b = pts[(lo + 1) % pts.length];
    const segLen = (b.d > a.d ? b.d : length) - a.d || 1;
    const f = (d - a.d) / segLen;
    const tx = a.tx + (b.tx - a.tx) * f;
    const ty = a.ty + (b.ty - a.ty) * f;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl;
    const ny = tx / tl;
    return { x: a.x + (b.x - a.x) * f + nx * (off || 0), y: a.y + (b.y - a.y) * f + ny * (off || 0), tx: tx / tl, ty: ty / tl, nx, ny };
  }

  function laneOffset(track, i, n) {
    return (i - (n - 1) / 2) * track.laneW;
  }

  // -------------------------------------------------------------- caching --

  const cache = new Map();
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined' && !root.document) return new OffscreenCanvas(w, h);
    const c = root.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function scene(W, H, lanes) {
    const key = W + 'x' + H + 'x' + lanes;
    if (cache.has(key)) return cache.get(key);
    const L = layoutFor(W, H);
    const track = buildTrack(L, lanes);
    const bg = makeCanvas(W, H);
    drawStatic(bg.getContext('2d'), L, track);
    const sc = { L, track, bg, glow: new Map(), crumbs: new WeakMap() };
    if (cache.size > 6) cache.clear();
    cache.set(key, sc);
    return sc;
  }

  function glowSprite(sc, color) {
    if (sc.glow.has(color)) return sc.glow.get(color);
    const r = Math.ceil(46 * sc.L.s);
    const c = makeCanvas(r * 2, r * 2);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, hexA(color, 0.55));
    grad.addColorStop(0.35, hexA(color, 0.22));
    grad.addColorStop(1, hexA(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, r * 2, r * 2);
    const out = { c, r };
    sc.glow.set(color, out);
    return out;
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    const n = parseInt(v, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // --------------------------------------------------------------- static --

  function trackPath(g, track) {
    g.beginPath();
    track.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
  }

  function drawStatic(g, L, track) {
    const { s, W, H } = L;
    g.fillStyle = C.asphalt;
    g.fillRect(0, 0, W, H);
    const cx = L.track.x + L.track.w / 2;
    const cy = L.track.y + L.track.h / 2;
    const vg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.65);
    vg.addColorStop(0, 'rgba(120,140,180,0.10)');
    vg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);

    // faint survey grid behind the circuit, like a track map
    g.fillStyle = 'rgba(242,244,247,0.06)';
    const step = 36 * s;
    for (let x = L.track.x; x <= L.track.x + L.track.w; x += step) {
      for (let y = L.track.y; y <= L.track.y + L.track.h; y += step) g.fillRect(x, y, 1.6 * s, 1.6 * s);
    }

    if (!L.narrow) {
      g.fillStyle = 'rgba(255,255,255,0.025)';
      roundRect(g, L.tower.x - 16 * s, L.tower.y - 16 * s, L.tower.w + 32 * s, L.tower.h + 32 * s, 14 * s);
      g.fill();
    }

    g.lineJoin = 'round';
    g.lineCap = 'round';
    trackPath(g, track);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = track.roadW + 26 * s;
    g.stroke();
    g.strokeStyle = 'rgba(242,244,247,0.92)';
    g.lineWidth = track.roadW + 6 * s;
    g.stroke();
    g.strokeStyle = C.tarmac;
    g.lineWidth = track.roadW;
    g.stroke();

    // kerbs on the outside of the tight corners
    const blk = 13 * s;
    const kerbW = 7 * s;
    let i = 0;
    for (let d = 0; d < track.length - blk; d += blk, i++) {
      const k = curvatureAt(track, d + blk / 2);
      if (Math.abs(k) < 0.0042 / s) continue;
      const side = k > 0 ? -1 : 1;
      const off = side * (track.roadW / 2 + kerbW / 2 + 1 * s);
      const a = pointAt(track, d, off);
      const b = pointAt(track, d + blk, off);
      g.strokeStyle = i % 2 ? C.paint : C.kerb;
      g.lineWidth = kerbW;
      g.lineCap = 'butt';
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }

    // sector ticks
    g.lineCap = 'butt';
    for (const k of [1, 2]) {
      const p = pointAt(track, (track.length * k) / 3, 0);
      g.strokeStyle = 'rgba(242,244,247,0.45)';
      g.lineWidth = 2 * s;
      g.beginPath();
      g.moveTo(p.x - p.nx * track.roadW * 0.5, p.y - p.ny * track.roadW * 0.5);
      g.lineTo(p.x + p.nx * track.roadW * 0.5, p.y + p.ny * track.roadW * 0.5);
      g.stroke();
      const lx = p.x + p.nx * (track.roadW / 2 + 22 * s);
      const ly = p.y + p.ny * (track.roadW / 2 + 22 * s);
      font(g, TEXT, 600, 14 * s);
      g.fillStyle = 'rgba(242,244,247,0.55)';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('S' + (k + 1), lx, ly);
    }

    // chequered start/finish line
    const sf = pointAt(track, 0, 0);
    const q = track.roadW / 6;
    g.save();
    g.translate(sf.x, sf.y);
    g.rotate(Math.atan2(sf.ty, sf.tx));
    for (let r = 0; r < 2; r++) {
      for (let c2 = 0; c2 < 6; c2++) {
        g.fillStyle = (r + c2) % 2 ? C.ink : C.paint;
        g.fillRect(-q + r * q, -track.roadW / 2 + c2 * q, q, q);
      }
    }
    g.restore();
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }

  function curvatureAt(track, d) {
    const { pts, length } = track;
    d = ((d % length) + length) % length;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].d <= d) lo = mid;
      else hi = mid - 1;
    }
    return pts[lo].k;
  }

  // -------------------------------------------------------------- helpers --

  function font(g, family, weight, size) {
    g.font = weight + ' ' + Math.round(size * 10) / 10 + 'px ' + family;
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function fitText(g, text, maxW) {
    text = String(text);
    if (g.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (g.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  function wrap(g, text, maxW, maxLines) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (g.measureText(next).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = fitText(g, lines.slice(maxLines - 1).join(' '), maxW);
      return kept;
    }
    return lines;
  }

  const ease = (t) => 1 - Math.pow(1 - GR.clamp(t, 0, 1), 3);

  function fmtSector(race, v) {
    if (race.mode === 'time') return v < 60 ? v.toFixed(1) : GR.formatDuration(v);
    if (race.mode === 'tokens') return GR.formatTokens(v);
    return String(Math.round(v));
  }

  function resultText(race, racer) {
    if (race.mode === 'time') return GR.formatDuration(racer.xEnd);
    if (race.mode === 'tokens') return GR.formatTokens(racer.xEnd);
    return racer.steps.length + ' moves';
  }

  // ---------------------------------------------------------------- frame --

  /**
   * Draw one frame.
   * opts: { title, showDetails, demo, timeline }
   */
  GR.render = function render(g, W, H, race, frame, opts) {
    opts = opts || {};
    const n = race.racers.length;
    const sc = scene(W, H, n);
    const { L, track } = sc;
    const s = L.s;
    const x = frame.x;
    const tl = opts.timeline || GR.makeTimeline(14);
    const xPerSec = race.maxX / tl.race;

    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(sc.bg, 0, 0, W, H);

    // breadcrumbs: every pit stop and crash so far, left on the racing line
    let crumbs = sc.crumbs.get(race);
    if (!crumbs) {
      crumbs = race.racers.map((r) =>
        r.events
          .filter((e) => e.kind !== 'talk')
          .map((e) => ({ e, pt: pointAt(track, GR.progressAt(r, e.x) * track.length, laneOffset(track, r.index, n)) }))
      );
      sc.crumbs.set(race, crumbs);
    }
    crumbs.forEach((list) => {
      for (const { e, pt } of list) {
        if (e.x > x) break;
        if (e.kind === 'crash') {
          g.fillStyle = hexA(C.yellow, 0.85);
          g.beginPath();
          const r = 4 * s;
          g.moveTo(pt.x, pt.y - r);
          g.lineTo(pt.x + r, pt.y);
          g.lineTo(pt.x, pt.y + r);
          g.lineTo(pt.x - r, pt.y);
          g.closePath();
          g.fill();
        } else {
          g.fillStyle = hexA(GR.categoryColor(e.cat), 0.5);
          g.beginPath();
          g.arc(pt.x, pt.y, 2.4 * s, 0, Math.PI * 2);
          g.fill();
        }
      }
    });

    // ghosts
    const placed = [];
    const ghostPts = race.racers.map((r) => {
      const p = GR.progressAt(r, x);
      const finished = x >= r.xEnd;
      const coast = finished ? Math.min(0.028, ((x - r.xEnd) / race.maxX) * 0.5) : 0;
      const off = laneOffset(track, r.index, n);
      const pt = pointAt(track, (p + coast) * track.length, off);
      return { r, p, pt, off, finished };
    });

    const windowPit = 1.1 * xPerSec;
    const windowCrash = 0.9 * xPerSec;

    for (const gp of ghostPts) {
      const { r, pt, off } = gp;
      // trail
      const K = 26;
      const dx = race.maxX * 0.006;
      let prev = null;
      for (let k = K; k >= 0; k--) {
        const xx = Math.max(0, x - k * dx);
        const pp = GR.progressAt(r, xx);
        const coast = xx >= r.xEnd ? Math.min(0.028, ((xx - r.xEnd) / race.maxX) * 0.5) : 0;
        const q = pointAt(track, (pp + coast) * track.length, off);
        if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) > 0.3) {
          const f = 1 - k / K;
          g.strokeStyle = hexA(r.color, 0.06 + f * 0.5);
          g.lineWidth = (2 + f * 9) * s;
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(prev.x, prev.y);
          g.lineTo(q.x, q.y);
          g.stroke();
        }
        prev = q;
      }

      // crash wobble + sparks
      const recent = GR.eventsNear(r, x, Math.max(windowPit, windowCrash));
      let crash = null;
      let pit = null;
      for (const e of recent) {
        if (e.kind === 'crash' && x - e.x < windowCrash) crash = e;
        if (e.kind !== 'talk' && x - e.x < windowPit) pit = e;
      }
      let gx = pt.x;
      let gy = pt.y;
      if (crash) {
        const age = (x - crash.x) / xPerSec;
        const wob = Math.sin(age * 55) * 4 * s * (1 - age / 0.9);
        gx += pt.nx * wob;
        gy += pt.ny * wob;
        const rnd = GR.rng(r.index * 7919 + Math.round(crash.x * 1000));
        for (let i = 0; i < 16; i++) {
          const a = rnd() * Math.PI * 2;
          const sp = (40 + rnd() * 110) * s;
          const sz = (2 + rnd() * 3.5) * s * (1 - age / 0.9);
          g.fillStyle = i % 2 ? hexA(C.yellow, 1 - age / 0.9) : hexA(C.kerb, 1 - age / 0.9);
          g.fillRect(gx + Math.cos(a) * sp * age - sz / 2, gy + Math.sin(a) * sp * age - sz / 2, sz, sz);
        }
        g.strokeStyle = hexA(C.kerb, 0.9 * (1 - age / 0.9));
        g.lineWidth = 3 * s;
        g.beginPath();
        g.arc(gx, gy, (16 + age * 30) * s, 0, Math.PI * 2);
        g.stroke();
      } else if (pit && pit.kind === 'tool') {
        const age = (x - pit.x) / xPerSec;
        if (age < 0.5) {
          g.strokeStyle = hexA(GR.categoryColor(pit.cat), 0.7 * (1 - age / 0.5));
          g.lineWidth = 2.5 * s;
          g.beginPath();
          g.arc(gx, gy, (13 + age * 44) * s, 0, Math.PI * 2);
          g.stroke();
        }
      }

      drawGhost(g, sc, gx, gy, pt, r.color, s);
      gp.draw = { x: gx, y: gy, pit, crash };
    }

    // labels after ghosts so they sit on top
    const tagH = 22 * s;
    const sorted = ghostPts.slice().sort((a, b) => a.draw.y - b.draw.y);
    for (const gp of sorted) {
      const { r } = gp;
      font(g, TEXT, 700, 14 * s);
      const tw = g.measureText(r.code).width + 14 * s;
      const rect = { x: gp.draw.x - tw / 2, y: gp.draw.y - 22 * s - tagH, w: tw, h: tagH };
      let guard = 0;
      while (placed.some((p) => overlap(p, rect)) && guard++ < 8) rect.y -= tagH + 3 * s;
      placed.push(rect);
      g.fillStyle = r.color;
      roundRect(g, rect.x, rect.y, rect.w, rect.h, 5 * s);
      g.fill();
      g.fillStyle = C.ink;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(r.code, rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5 * s);
    }
    for (const gp of sorted) {
      const ev = gp.draw.crash || gp.draw.pit;
      if (!ev) continue;
      const age = (x - ev.x) / xPerSec;
      const life = ev.kind === 'crash' ? 0.9 : 1.1;
      const alpha = age < 0.12 ? age / 0.12 : age > life - 0.3 ? Math.max(0, (life - age) / 0.3) : 1;
      let label = ev.kind === 'crash' ? 'CRASH: ' + GR.categoryLabel(ev.cat) : GR.categoryLabel(ev.cat);
      if (opts.showDetails && ev.detail && ev.kind !== 'crash') label += '  ' + GR.truncate(ev.detail, 28);
      font(g, TEXT, 700, 13 * s);
      const w = g.measureText(label).width + 16 * s;
      const h = 21 * s;
      const lx = gp.draw.x - w / 2;
      const ly = gp.draw.y + 20 * s - ease(age / life) * 8 * s;
      const rect = { x: lx, y: ly, w, h };
      let guard = 0;
      while (placed.some((p) => overlap(p, rect)) && guard++ < 6) rect.y += h + 3 * s;
      placed.push(rect);
      g.globalAlpha = alpha;
      if (ev.kind === 'crash') {
        g.fillStyle = C.kerb;
        roundRect(g, rect.x, rect.y, w, h, 4 * s);
        g.fill();
        g.fillStyle = '#FFFFFF';
      } else {
        const col = GR.categoryColor(ev.cat);
        g.fillStyle = 'rgba(20,22,28,0.9)';
        roundRect(g, rect.x, rect.y, w, h, 4 * s);
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = 1.5 * s;
        g.stroke();
        g.fillStyle = col;
      }
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, rect.x + w / 2, rect.y + h / 2 + 0.5 * s);
      g.globalAlpha = 1;
    }
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    // standings, with a short moving average so rows slide on overtakes
    const rows = GR.standingsAt(race, x);
    const rankY = new Map();
    const SM = 6;
    const dxr = 0.06 * xPerSec;
    for (let k = 0; k < SM; k++) {
      const st = k === 0 ? rows : GR.standingsAt(race, Math.max(0, x - k * dxr));
      st.forEach((row, i) => rankY.set(row.racer, (rankY.get(row.racer) || 0) + i / SM));
    }
    const climbed = new Map();
    const before = GR.standingsAt(race, Math.max(0, x - 0.7 * xPerSec));
    rows.forEach((row, i) => {
      const j = before.findIndex((b) => b.racer === row.racer);
      if (j > i && frame.phase === 'race') climbed.set(row.racer, true);
    });

    if (L.narrow) drawHeaderSquare(g, L, race, frame, opts);
    else drawTowerHeader(g, L, race, frame, opts);
    drawRows(g, L, race, rows, rankY, climbed, x, frame);
    if (!L.square) drawKey(g, L, race.racers.length);

    if (frame.phase === 'intro') drawLights(g, L, frame.phaseT);
    if (frame.phase === 'race' || frame.phase === 'hold') {
      drawControl(g, L, race, x, xPerSec, frame);
      drawWinner(g, L, race, rows, x, xPerSec, frame, tl);
    }
    if (frame.phase !== 'outro') drawFooter(g, L, opts);
    if (frame.phase === 'outro') drawResults(g, L, race, frame.phaseT, opts);
    g.restore();
  };

  function overlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  function drawGhost(g, sc, x, y, pt, color, s) {
    const glow = glowSprite(sc, color);
    g.drawImage(glow.c, x - glow.r, y - glow.r);
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, 11 * s, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = 1.5 * s;
    g.stroke();
    // eyes look where the ghost is going
    const fx = pt.tx;
    const fy = pt.ty;
    for (const side of [-1, 1]) {
      const ex = x + fx * 3.6 * s + -fy * side * 4.3 * s;
      const ey = y + fy * 3.6 * s + fx * side * 4.3 * s;
      g.fillStyle = '#FFFFFF';
      g.beginPath();
      g.arc(ex, ey, 3.1 * s, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = C.ink;
      g.beginPath();
      g.arc(ex + fx * 1.3 * s, ey + fy * 1.3 * s, 1.6 * s, 0, Math.PI * 2);
      g.fill();
    }
  }

  // ------------------------------------------------------- tower / header --

  function drawWordmark(g, x, y, size) {
    g.save();
    g.translate(x, y);
    g.transform(1, 0, -0.18, 1, 0, 0);
    font(g, DISPLAY, 400, size);
    g.fillStyle = C.paint;
    g.fillText('GHOST RACE', 0, 0);
    const w = g.measureText('GHOST RACE').width;
    // three speed stripes in the first three ghost colours
    for (let i = 0; i < 3; i++) {
      g.fillStyle = GR.PALETTE[i];
      g.fillRect(w + size * 0.18, -size * 0.62 + i * size * 0.22, size * (0.55 - i * 0.12), size * 0.11);
    }
    g.restore();
  }

  function drawTowerHeader(g, L, race, frame, opts) {
    const T = L.tower;
    const s = L.s;
    drawWordmark(g, T.x, T.y + 52 * s, 60 * s);
    font(g, TEXT, 500, 21 * s);
    g.fillStyle = C.dim;
    const title = opts.title || 'Agent race';
    wrap(g, title, T.w, 2).forEach((line, i) => g.fillText(line, T.x, T.y + 92 * s + i * 27 * s));
    font(g, DISPLAY, 400, 76 * s);
    g.fillStyle = C.paint;
    g.fillText(GR.formatClock(race, frame.x), T.x, T.y + 218 * s);
    font(g, TEXT, 500, 17 * s);
    g.fillStyle = C.dim;
    g.fillText(frame.phase === 'intro' ? 'Race by ' + UNIT[race.mode] : UNIT[race.mode], T.x, T.y + 246 * s);
  }

  function drawHeaderSquare(g, L, race, frame, opts) {
    const Hd = L.header;
    const s = L.s;
    if (L.tall) {
      // stacked: wordmark, then title, then a big clock
      drawWordmark(g, Hd.x, Hd.y + 58 * s, 68 * s);
      font(g, TEXT, 500, 26 * s);
      g.fillStyle = C.dim;
      wrap(g, opts.title || 'Agent race', Hd.w, 2).forEach((line, i) => g.fillText(line, Hd.x, Hd.y + 108 * s + i * 32 * s));
      font(g, DISPLAY, 400, 84 * s);
      g.fillStyle = C.paint;
      g.fillText(GR.formatClock(race, frame.x), Hd.x, Hd.y + 222 * s);
      const cw = g.measureText(GR.formatClock(race, frame.x)).width;
      font(g, TEXT, 500, 20 * s);
      g.fillStyle = C.dim;
      g.fillText(UNIT[race.mode], Hd.x + cw + 16 * s, Hd.y + 222 * s);
      return;
    }
    drawWordmark(g, Hd.x, Hd.y + 50 * s, 54 * s);
    font(g, TEXT, 500, 19 * s);
    g.fillStyle = C.dim;
    g.fillText(fitText(g, opts.title || 'Agent race', Hd.w * 0.62), Hd.x, Hd.y + 88 * s);
    g.textAlign = 'right';
    font(g, DISPLAY, 400, 64 * s);
    g.fillStyle = C.paint;
    g.fillText(GR.formatClock(race, frame.x), Hd.x + Hd.w, Hd.y + 58 * s);
    font(g, TEXT, 500, 16 * s);
    g.fillStyle = C.dim;
    g.fillText(UNIT[race.mode], Hd.x + Hd.w, Hd.y + 86 * s);
    g.textAlign = 'left';
  }

  function rowsGeom(L, n) {
    const s = L.s;
    const T = L.tower;
    const compact = L.square;
    const offset = L.narrow ? 0 : 284 * s;
    const avail = T.h - offset;
    return { compact, top: T.y + offset, avail, rh: Math.min(compact ? 60 * s : 96 * s, avail / Math.max(n, 1)) };
  }

  function drawRows(g, L, race, rows, rankY, climbed, x, frame) {
    const onGrid = frame.phase === 'intro' || x <= 0;
    const s = L.s;
    const T = L.tower;
    const n = rows.length;
    const { compact, top, rh } = rowsGeom(L, n);
    const leaderRow = rows[0];
    // fastest completed sector so far, per sector
    const best = [0, 1, 2].map((k) => {
      let b = Infinity;
      for (const r of race.racers) if (r.sectors[k].end <= x && r.sectors[k].time < b) b = r.sectors[k].time;
      return b;
    });

    for (const row of rows) {
      const r = row.racer;
      const y = top + rankY.get(r) * rh;
      const h = rh - (compact ? 6 : 10) * s;
      g.fillStyle = climbed.get(r) ? hexA(C.green, 0.16) : 'rgba(255,255,255,0.045)';
      roundRect(g, T.x, y, T.w, h, 8 * s);
      g.fill();

      const mid = y + h / 2;
      font(g, DISPLAY, 400, (compact ? 28 : 36) * s);
      g.fillStyle = C.paint;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(row.place), T.x + 24 * s, compact ? mid + 1 * s : y + 34 * s);
      g.textAlign = 'left';
      g.fillStyle = r.color;
      g.fillRect(T.x + 48 * s, y + 10 * s, 6 * s, h - 20 * s);

      // gap
      let gapText;
      let gapColor = C.paint;
      if (onGrid) {
        gapText = '';
      } else if (row.dnf) {
        gapText = 'DNF';
        gapColor = C.kerb;
      } else if (row === leaderRow) {
        gapText = row.finished ? resultText(race, r) : 'Leader';
        if (row.finished) gapColor = C.purple;
      } else {
        gapText = GR.formatGap(race, GR.gapAt(race, row, leaderRow, x));
      }
      const st = GR.statsAt(r, x);
      const stops = st.tools + (st.tools === 1 ? ' stop' : ' stops');
      const crashes = st.crashes ? st.crashes + (st.crashes === 1 ? ' crash' : ' crashes') : '';
      const fuel = GR.clamp(st.tokens / race.maxTokens, 0, 1);

      if (compact) {
        font(g, TEXT, 700, 22 * s);
        g.fillStyle = C.paint;
        g.fillText(r.code, T.x + 66 * s, mid + 1 * s);
        font(g, TEXT, 400, 16 * s);
        g.fillStyle = C.dim;
        g.fillText(fitText(g, r.run.name, 190 * s), T.x + 124 * s, mid + 1 * s);
        // fuel bar
        const bx = T.x + 330 * s;
        const bw = 220 * s;
        g.fillStyle = 'rgba(255,255,255,0.1)';
        g.fillRect(bx, mid - 3 * s, bw, 6 * s);
        g.fillStyle = hexA(r.color, 0.9);
        g.fillRect(bx, mid - 3 * s, bw * fuel, 6 * s);
        font(g, TEXT, 500, 15 * s);
        g.fillStyle = C.dim;
        g.fillText(stops, bx + bw + 18 * s, mid + 1 * s);
        if (crashes) {
          g.fillStyle = C.yellow;
          g.fillText(crashes, bx + bw + 18 * s + g.measureText(stops).width + 14 * s, mid + 1 * s);
        }
        font(g, TEXT, 600, 20 * s);
        g.fillStyle = gapColor;
        g.textAlign = 'right';
        g.fillText(gapText, T.x + T.w - 16 * s, mid + 1 * s);
        g.textAlign = 'left';
      } else {
        g.textBaseline = 'alphabetic';
        font(g, TEXT, 700, 27 * s);
        g.fillStyle = C.paint;
        g.fillText(r.code, T.x + 70 * s, y + 38 * s);
        font(g, TEXT, 600, 22 * s);
        g.fillStyle = gapColor;
        g.textAlign = 'right';
        g.fillText(gapText, T.x + T.w - 16 * s, y + 38 * s);
        g.textAlign = 'left';
        if (h > 66 * s) {
          font(g, TEXT, 400, 15 * s);
          g.fillStyle = C.dim;
          g.fillText(fitText(g, r.run.name, 170 * s), T.x + 70 * s, y + 61 * s);
          g.textAlign = 'right';
          font(g, TEXT, 500, 15 * s);
          let rx = T.x + T.w - 16 * s;
          if (crashes) {
            g.fillStyle = C.yellow;
            g.fillText(crashes, rx, y + 61 * s);
            rx -= g.measureText(crashes).width + 12 * s;
          }
          g.fillStyle = C.dim;
          g.fillText(stops, rx, y + 61 * s);
          g.textAlign = 'left';
          // fuel + sectors
          const by = y + h - 14 * s;
          const bx = T.x + 70 * s;
          const bw = T.w - 70 * s - 108 * s;
          g.fillStyle = 'rgba(255,255,255,0.1)';
          g.fillRect(bx, by, bw, 5 * s);
          g.fillStyle = hexA(r.color, 0.9);
          g.fillRect(bx, by, bw * fuel, 5 * s);
          for (let k = 0; k < 3; k++) {
            const sec = r.sectors[k];
            const done = sec.end <= x;
            g.fillStyle = !done ? 'rgba(255,255,255,0.12)' : sec.time <= best[k] + 1e-9 ? C.purple : 'rgba(242,244,247,0.7)';
            g.fillRect(T.x + T.w - 16 * s - (3 - k) * 30 * s + 4 * s, by, 26 * s, 5 * s);
          }
        }
      }
      g.textBaseline = 'alphabetic';
    }
  }

  // A small key so people watching the clip on X can read it cold.
  function drawKey(g, L, n) {
    const s = L.s;
    const T = L.tower;
    const top = L.tall ? L.H - 200 * s : T.y + T.h - 156 * s;
    const geo = rowsGeom(L, n);
    const rowsEnd = geo.top + geo.rh * n;
    if (rowsEnd > top - 12 * s) return;
    const items = [
      ['pit', 'Pit stop: the agent used a tool'],
      ['crash', 'Crash: a tool call failed'],
      ['fuel', 'Fuel bar: tokens burned'],
      ['sector', 'Sectors: purple is the fastest'],
    ];
    font(g, TEXT, 400, 15 * s);
    items.forEach(([kind, text], i) => {
      const y = top + i * 36 * s;
      const ix = T.x + 4 * s;
      if (kind === 'pit') {
        g.strokeStyle = GR.categoryColor('edit');
        g.lineWidth = 1.5 * s;
        roundRect(g, ix, y - 9 * s, 40 * s, 18 * s, 4 * s);
        g.stroke();
        font(g, TEXT, 700, 10 * s);
        g.fillStyle = GR.categoryColor('edit');
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('EDIT', ix + 20 * s, y + 0.5 * s);
        g.textAlign = 'left';
      } else if (kind === 'crash') {
        g.fillStyle = C.yellow;
        g.beginPath();
        g.moveTo(ix + 20 * s, y - 7 * s);
        g.lineTo(ix + 27 * s, y);
        g.lineTo(ix + 20 * s, y + 7 * s);
        g.lineTo(ix + 13 * s, y);
        g.closePath();
        g.fill();
      } else if (kind === 'fuel') {
        g.fillStyle = 'rgba(255,255,255,0.1)';
        g.fillRect(ix, y - 2.5 * s, 40 * s, 5 * s);
        g.fillStyle = GR.PALETTE[0];
        g.fillRect(ix, y - 2.5 * s, 26 * s, 5 * s);
      } else {
        for (let k = 0; k < 3; k++) {
          g.fillStyle = k === 1 ? C.purple : 'rgba(242,244,247,0.7)';
          g.fillRect(ix + k * 14 * s, y - 2.5 * s, 11 * s, 5 * s);
        }
      }
      font(g, TEXT, 400, 15 * s);
      g.fillStyle = C.dim;
      g.textBaseline = 'middle';
      g.fillText(text, ix + 56 * s, y + 1 * s);
      g.textBaseline = 'alphabetic';
    });
  }

  // ----------------------------------------------------------- overlays --

  function drawLights(g, L, t) {
    const s = L.s;
    const cx = L.track.x + L.track.w / 2;
    const cy = L.track.y + L.track.h * (L.narrow ? 0.5 : 0.52);
    const lit = t >= 2.1 ? 0 : GR.clamp(Math.floor((t - 0.2) / 0.36) + 1, 0, 5);
    const r = 24 * s;
    const gap = 66 * s;
    const w = gap * 5 + 22 * s;
    const h = 86 * s;
    g.fillStyle = 'rgba(14,15,19,0.94)';
    roundRect(g, cx - w / 2, cy - h / 2, w, h, 14 * s);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 2 * s;
    g.stroke();
    for (let i = 0; i < 5; i++) {
      const lx = cx - (gap * 4) / 2 + i * gap;
      const on = i < lit;
      if (on) {
        const grad = g.createRadialGradient(lx, cy, 0, lx, cy, r * 2.4);
        grad.addColorStop(0, 'rgba(229,72,77,0.55)');
        grad.addColorStop(1, 'rgba(229,72,77,0)');
        g.fillStyle = grad;
        g.fillRect(lx - r * 2.4, cy - r * 2.4, r * 4.8, r * 4.8);
      }
      g.fillStyle = on ? C.kerb : '#2B1A1D';
      g.beginPath();
      g.arc(lx, cy, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  const KIND_COLOR = { fork: C.purple, crash: C.yellow, lead: C.green, win: C.paint, finish: C.dim };

  function drawControl(g, L, race, x, xPerSec, frame) {
    const s = L.s;
    const LIFE = 2.6;
    let m = null;
    for (const mm of race.moments) {
      if (mm.x > x) break;
      if ((x - mm.x) / xPerSec < LIFE) m = mm;
    }
    if (!m) return;
    if (frame.phase === 'hold' && m.kind !== 'finish') return;
    const age = (x - m.x) / xPerSec;
    const alpha = frame.phase === 'hold' ? GR.clamp(1 - frame.phaseT / 0.5, 0, 1) : age < 0.15 ? age / 0.15 : age > LIFE - 0.35 ? (LIFE - age) / 0.35 : 1;
    font(g, TEXT, 500, 22 * s);
    const tw = Math.min(g.measureText(m.text).width, (L.narrow ? 860 : 1200) * s);
    const w = tw + 52 * s;
    const h = 66 * s;
    const bx = L.control.cx - w / 2;
    const by = L.control.y - h / 2;
    g.globalAlpha = GR.clamp(alpha, 0, 1);
    g.fillStyle = 'rgba(14,15,19,0.94)';
    roundRect(g, bx, by, w, h, 8 * s);
    g.fill();
    g.fillStyle = KIND_COLOR[m.kind] || C.paint;
    g.fillRect(bx, by + 8 * s, 5 * s, h - 16 * s);
    font(g, TEXT, 700, 14 * s);
    g.fillText('Race control: ' + m.title, bx + 24 * s, by + 25 * s);
    font(g, TEXT, 500, 22 * s);
    g.fillStyle = C.paint;
    g.fillText(fitText(g, m.text, tw), bx + 24 * s, by + 52 * s);
    g.globalAlpha = 1;
  }

  function drawWinner(g, L, race, rows, x, xPerSec, frame, tl) {
    const winner = rows.find((r) => r.finished && !r.dnf);
    if (!winner) return;
    const s = L.s;
    const r = winner.racer;
    const age = frame.phase === 'hold' ? (race.maxX - r.xEnd) / xPerSec + frame.phaseT : (x - r.xEnd) / xPerSec;
    const a = ease(age / 0.45);
    const cx = L.track.x + L.track.w / 2;
    const y = L.track.y + (L.narrow ? 6 : 20) * s - (1 - a) * 20 * s;
    font(g, DISPLAY, 400, (L.narrow ? 54 : 66) * s);
    const head = r.run.name + ' wins';
    const hw = g.measureText(head).width;
    font(g, TEXT, 500, 20 * s);
    const st = GR.statsAt(r, r.xEnd);
    const unit = race.mode === 'steps' ? '' : ' ' + UNIT[race.mode];
    const sub = resultText(race, r) + unit + ', ' + st.tools + ' pit stops, ' + st.crashes + (st.crashes === 1 ? ' crash' : ' crashes');
    const sw = g.measureText(sub).width;
    const w = Math.max(hw, sw) + 64 * s;
    const h = (L.narrow ? 104 : 120) * s;
    g.globalAlpha = a;
    g.fillStyle = 'rgba(14,15,19,0.92)';
    roundRect(g, cx - w / 2, y, w, h, 10 * s);
    g.fill();
    // chequered edge
    const q = 8 * s;
    for (let i = 0; i * q < w - 20 * s; i++) {
      for (let j = 0; j < 2; j++) {
        g.fillStyle = (i + j) % 2 ? C.paint : C.ink;
        g.fillRect(cx - w / 2 + 10 * s + i * q, y + h - 2 * q - 6 * s + j * q, q, q);
      }
    }
    g.textAlign = 'center';
    font(g, DISPLAY, 400, (L.narrow ? 54 : 66) * s);
    g.fillStyle = r.color;
    g.fillText(head, cx, y + (L.narrow ? 56 : 66) * s);
    font(g, TEXT, 500, 20 * s);
    g.fillStyle = C.paint;
    g.fillText(sub, cx, y + (L.narrow ? 80 : 92) * s);
    g.textAlign = 'left';
    g.globalAlpha = 1;
    void tl;
  }

  function drawFooter(g, L, opts) {
    const s = L.s;
    font(g, TEXT, 500, 16 * s);
    g.fillStyle = 'rgba(142,151,168,0.85)';
    g.textAlign = 'right';
    const fy = L.H - (L.square ? 12 : L.tall ? 44 : 30) * s;
    g.fillText(GR.repoUrl, L.W - (L.tall ? 60 : L.square ? 44 : 48) * s, fy);
    g.textAlign = 'left';
    if (opts.demo) {
      g.fillText('Demo race with made-up ghosts', L.tall ? 60 * s : L.square ? 44 * s : L.track.x, fy);
    }
  }

  function drawResults(g, L, race, t, opts) {
    const s = L.s;
    const { W, H } = L;
    g.fillStyle = 'rgba(14,15,19,' + 0.95 * ease(t / 0.4) + ')';
    g.fillRect(0, 0, W, H);
    const a = ease((t - 0.1) / 0.4);
    g.globalAlpha = a;

    const sq = L.narrow;
    const cw = L.tall ? W - 120 * s : sq ? W - 88 * s : 1560 * s;
    const cx = (W - cw) / 2;
    const nRows = race.racers.length;
    const block = (sq ? 300 : 330) * s + nRows * (sq ? 78 : 84) * s;
    let y = Math.max(sq ? 96 * s : 120 * s, (H - 80 * s - block) / 2 + 40 * s);
    drawWordmark(g, cx, y, (sq ? 44 : 48) * s);
    y += (sq ? 92 : 104) * s;
    font(g, DISPLAY, 400, (sq ? 64 : 76) * s);
    g.fillStyle = C.paint;
    g.fillText('Results', cx, y);
    font(g, TEXT, 500, 22 * s);
    g.fillStyle = C.dim;
    const ranked = { time: 'Ranked by agent time', tokens: 'Ranked by tokens burned', steps: 'Ranked by number of moves' }[race.mode];
    g.fillText(fitText(g, (opts.title ? opts.title + '. ' : '') + ranked + '.', cw), cx, y + 40 * s);
    y += 96 * s;

    const final = GR.standingsAt(race, race.maxX);
    const winner = final.find((r) => !r.dnf) || final[0];
    const best = [0, 1, 2].map((k) => Math.min(...race.racers.map((r) => r.sectors[k].time)));
    const cols = sq
      ? [['Ghost', 0], ['Result', 470], ['Gap', 610], ['Stops', 760], ['Crashes', 860]]
      : [['Ghost', 0], ['Result', 470], ['Gap', 640], ['S1', 800], ['S2', 910], ['S3', 1020], ['Stops', 1150], ['Crashes', 1260], ['Tokens', 1400]];
    const col = (name) => cx + 64 * s + cols.find((c) => c[0] === name)[1] * s;
    font(g, TEXT, 500, 17 * s);
    g.fillStyle = C.dim;
    cols.forEach(([name]) => g.fillText(name, col(name), y));
    y += 18 * s;
    const rh = sq ? Math.min(78 * s, (H - y - 90 * s) / final.length) : Math.min(84 * s, (H - y - 120 * s) / final.length);

    final.forEach((row, i) => {
      const r = row.racer;
      const ra = GR.clamp((t - 0.45 - i * 0.14) / 0.35, 0, 1);
      g.globalAlpha = a * ra;
      const ry = y + i * rh + (1 - ease(ra)) * 14 * s;
      g.fillStyle = i === 0 && !row.dnf ? hexA(r.color, 0.12) : 'rgba(255,255,255,0.04)';
      roundRect(g, cx, ry + 8 * s, cw, rh - 10 * s, 8 * s);
      g.fill();
      const base = ry + 8 * s + (rh - 10 * s) / 2 + 8 * s;
      font(g, DISPLAY, 400, 34 * s);
      g.fillStyle = C.paint;
      g.fillText(row.dnf ? '–' : String(row.place), cx + 20 * s, base + 4 * s);
      g.fillStyle = r.color;
      g.fillRect(col('Ghost') - 14 * s, ry + 20 * s, 6 * s, rh - 34 * s);
      font(g, TEXT, 700, 26 * s);
      g.fillStyle = C.paint;
      g.fillText(fitText(g, r.run.name, 330 * s), col('Ghost'), base - 4 * s);
      font(g, TEXT, 400, 15 * s);
      g.fillStyle = C.dim;
      const src = [r.code, r.run.modelLabel, r.run.sourceLabel].filter(Boolean).join('  ');
      g.fillText(fitText(g, src, 330 * s), col('Ghost'), base + 18 * s);
      font(g, TEXT, 500, 24 * s);
      g.fillStyle = row.dnf ? C.kerb : C.paint;
      g.fillText(row.dnf ? 'DNF' : resultText(race, r), col('Result'), base + 4 * s);
      g.fillStyle = C.dim;
      g.fillText(row === winner || row.dnf ? '' : GR.formatGap(race, r.xEnd - winner.racer.xEnd), col('Gap'), base + 4 * s);
      if (!sq) {
        for (let k = 0; k < 3; k++) {
          const v = r.sectors[k].time;
          g.fillStyle = v <= best[k] + 1e-9 ? C.purple : C.paint;
          g.fillText(fmtSector(race, v), col('S' + (k + 1)), base + 4 * s);
        }
        g.fillStyle = C.paint;
        g.fillText(GR.formatTokens(r.run.totals.tokens), col('Tokens'), base + 4 * s);
      }
      g.fillStyle = C.paint;
      g.fillText(String(r.run.totals.tools), col('Stops'), base + 4 * s);
      g.fillStyle = r.run.totals.crashes ? C.yellow : C.paint;
      g.fillText(String(r.run.totals.crashes), col('Crashes'), base + 4 * s);
    });

    g.globalAlpha = a * GR.clamp((t - 1.2) / 0.5, 0, 1);
    font(g, TEXT, 500, 20 * s);
    g.fillStyle = C.dim;
    g.textAlign = 'center';
    const foot = 'Race your own agents: ' + GR.repoUrl + (opts.demo ? '   (demo race with made-up ghosts)' : '');
    g.fillText(foot, W / 2, H - (sq ? 40 : 56) * s);
    g.textAlign = 'left';
    g.globalAlpha = 1;
  }

  // Shown before any ghosts are loaded.
  GR.renderEmpty = function renderEmpty(g, W, H, message) {
    const sc = scene(W, H, 3);
    const { L } = sc;
    const s = L.s;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(sc.bg, 0, 0, W, H);
    if (L.narrow) drawWordmark(g, L.header.x, L.header.y + 50 * s, (L.tall ? 66 : 54) * s);
    else drawWordmark(g, L.tower.x, L.tower.y + 52 * s, 60 * s);
    const cx = L.track.x + L.track.w / 2;
    const cy = L.track.y + L.track.h / 2;
    font(g, DISPLAY, 400, 54 * s);
    g.fillStyle = C.paint;
    g.textAlign = 'center';
    g.fillText(message || 'The grid is empty', cx, cy);
    font(g, TEXT, 500, 22 * s);
    g.fillStyle = C.dim;
    g.fillText('Add two agent session logs to start a race.', cx, cy + 44 * s);
    g.textAlign = 'left';
    drawFooter(g, L, {});
    g.restore();
  };

  GR.clearRenderCache = function clearRenderCache() {
    cache.clear();
  };

  GR._render = { layoutFor, buildTrack, pointAt };
})(typeof window !== 'undefined' ? window : globalThis);
