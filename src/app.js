/*!
 * Ghost Race — app.js
 * Page wiring: loading logs, playback, settings and export.
 */
(function (root) {
  'use strict';

  const GR = root.GhostRace;
  const doc = root.document;
  const $ = (id) => doc.getElementById(id);

  const MAX_GHOSTS = 6;
  const MAX_FILE_BYTES = 300 * 1024 * 1024;
  const reducedMotion = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    runs: [],
    demo: false,
    demoTitle: '',
    shared: false,
    mode: 'time',
    skipIdle: true,
    details: false,
    aspect: root.innerWidth < 640 ? 'square' : 'wide',
    length: 14,
    title: '',
    t: 0,
    playing: false,
    race: null,
    timeline: GR.makeTimeline(14),
    exporting: null,
  };

  const canvas = $('race');
  const ctx = canvas.getContext('2d');

  // --------------------------------------------------------------- render --

  function size() {
    if (state.aspect === 'tall') return { w: 1080, h: 1920 };
    return state.aspect === 'square' ? { w: 1080, h: 1080 } : { w: 1920, h: 1080 };
  }

  function renderOpts() {
    return { title: state.title || (state.demo ? state.demoTitle : state.sharedTitle || ''), showDetails: state.details, demo: state.demo, timeline: state.timeline };
  }

  function draw() {
    const { w, h } = size();
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (!state.race) {
      GR.renderEmpty(ctx, w, h);
    } else {
      GR.render(ctx, w, h, state.race, GR.frameAt(state.timeline, state.race, state.t), renderOpts());
    }
    syncTransport();
  }

  function rebuild(opts) {
    opts = opts || {};
    state.timeline = GR.makeTimeline(state.length);
    if (!state.runs.length) {
      state.race = null;
      state.t = 0;
      setPlaying(false);
    } else {
      state.runs.forEach((r, i) => (r.color = r.color || GR.PALETTE[i % GR.PALETTE.length]));
      state.race = GR.buildRace(state.runs, { mode: state.mode, skipIdle: state.skipIdle });
      updateModeControls();
    }
    if (opts.restart) state.t = 0;
    state.t = Math.min(state.t, state.timeline.total);
    renderGrid();
    updateClipNote();
    draw();
  }

  // ------------------------------------------------------------- playback --

  let last = null;
  function loop(now) {
    if (!state.playing) return;
    if (last != null) state.t += (now - last) / 1000;
    last = now;
    if (state.t >= state.timeline.total) {
      state.t = state.timeline.total;
      setPlaying(false);
    }
    draw();
    if (state.playing) root.requestAnimationFrame(loop);
  }

  function setPlaying(on) {
    if (on && !state.race) return;
    if (on && state.t >= state.timeline.total - 0.01) state.t = 0;
    state.playing = on;
    last = null;
    const btn = $('play');
    btn.classList.toggle('is-playing', on);
    btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (on) root.requestAnimationFrame(loop);
  }

  function fmt(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function syncTransport() {
    const scrub = $('scrub');
    const f = state.timeline.total ? state.t / state.timeline.total : 0;
    if (!scrub.matches(':active')) scrub.value = String(Math.round(f * 1000));
    scrub.style.setProperty('--fill', (f * 100).toFixed(2) + '%');
    $('clock').textContent = fmt(state.t) + ' / ' + fmt(state.timeline.total);
  }

  // ----------------------------------------------------------------- grid --

  function metaFor(run) {
    const bits = [run.sourceLabel];
    if (run.modelLabel && run.modelLabel !== run.name) bits.push(run.modelLabel);
    bits.push(GR.formatDuration(run.totals.duration));
    bits.push(run.totals.tools + (run.totals.tools === 1 ? ' tool call' : ' tool calls'));
    bits.push(run.totals.crashes + (run.totals.crashes === 1 ? ' error' : ' errors'));
    if (run.totals.tokens) bits.push(GR.formatTokens(run.totals.tokens) + ' tokens');
    return bits.join(', ');
  }

  function renderGrid() {
    const list = $('grid');
    list.textContent = '';
    $('grid-empty').hidden = state.runs.length > 0;
    const racers = state.race ? state.race.racers : [];
    state.runs.forEach((run, i) => {
      const li = doc.createElement('li');
      const sw = doc.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch';
      sw.style.background = run.color;
      sw.setAttribute('aria-label', 'Change colour for ' + run.name);
      sw.addEventListener('click', () => {
        const used = new Set(state.runs.map((r) => r.color));
        const start = GR.PALETTE.indexOf(run.color);
        for (let k = 1; k <= GR.PALETTE.length; k++) {
          const c = GR.PALETTE[(start + k) % GR.PALETTE.length];
          if (!used.has(c) || k === GR.PALETTE.length) {
            run.color = c;
            break;
          }
        }
        rebuild();
      });

      const name = doc.createElement('input');
      name.className = 'ghost-name';
      name.value = run.name;
      name.maxLength = 40;
      name.setAttribute('aria-label', 'Ghost name');
      name.addEventListener('change', () => {
        run.name = name.value.trim() || run.modelLabel || run.sourceLabel || 'Ghost';
        rebuild();
      });

      const badge = doc.createElement('span');
      badge.className = 'code-badge';
      badge.style.background = run.color;
      badge.textContent = racers[i] ? racers[i].code : '';
      badge.title = 'Short code shown on the track';

      const rm = doc.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.textContent = '×';
      rm.setAttribute('aria-label', 'Remove ' + run.name);
      rm.addEventListener('click', () => {
        state.runs.splice(i, 1);
        if (!state.runs.some((r) => r.demo)) state.demo = false;
        rebuild({ restart: true });
        status('Removed ' + run.name + '.');
      });

      const meta = doc.createElement('p');
      meta.className = 'ghost-meta';
      meta.textContent = run.demo ? 'Made-up demo ghost: ' + metaFor(run).replace(/^Demo, /, '') : metaFor(run);

      li.append(sw, name, badge, rm, meta);
      for (const w of run.warnings || []) {
        const p = doc.createElement('p');
        p.className = 'ghost-warn';
        p.textContent = w;
        li.append(p);
      }
      list.append(li);
    });
  }

  function updateModeControls() {
    const race = state.race;
    for (const input of doc.querySelectorAll('input[name="mode"]')) {
      input.disabled = !!race && !race.available[input.value];
      input.checked = race ? input.value === race.mode : input.value === state.mode;
    }
    const notes = {
      time: 'Time counts active agent time. ' + (state.skipIdle ? 'Gaps over 30 seconds, like waiting for you to approve something, count as 30 seconds.' : 'Every second counts, including time spent waiting for you.'),
      tokens: 'Tokens counts every token each agent sent and received. The cheapest run wins.',
      steps: 'Steps counts agent moves: tool calls and replies. The most direct run wins.',
    };
    let note = notes[race ? race.mode : state.mode];
    if (race && race.mode !== race.requested) {
      note = (race.requested === 'tokens' ? "One of these logs has no token counts, so this race is by steps. " : '') + note;
    }
    $('mode-note').textContent = note;
  }

  function updateClipNote() {
    const total = Math.round(state.timeline.total);
    $('clip-length').textContent = 'The clip adds the start lights and the results card, about ' + total + ' seconds in total.';
    const off = !state.race;
    $('export').disabled = off || !!state.exporting;
    $('png').disabled = off || !!state.exporting;
    $('share').disabled = off;
    if (off) $('share-url').hidden = true;
    $('play').disabled = off;
    $('restart').disabled = off;
    $('scrub').disabled = off;
  }

  // ----------------------------------------------------------- loading ----

  function status(text, kind, where) {
    const el = $(where === 'share' ? 'share-status' : 'status');
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' is-' + kind : '');
  }

  function nextColor() {
    const used = new Set(state.runs.map((r) => r.color));
    return GR.PALETTE.find((c) => !used.has(c)) || GR.PALETTE[state.runs.length % GR.PALETTE.length];
  }

  function uniqueName(name) {
    const names = new Set(state.runs.map((r) => r.name));
    if (!names.has(name)) return name;
    let i = 2;
    while (names.has(name + ' #' + i)) i++;
    return name + ' #' + i;
  }

  function clearShareHash() {
    try {
      if (root.location.hash.startsWith(GR.SHARE_PREFIX)) root.history.replaceState(null, '', root.location.pathname + root.location.search);
    } catch (e) {
      /* some hosts don't allow history changes */
    }
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (state.demo || state.shared) {
      state.runs = state.runs.filter((r) => !r.demo && !r.shared);
      state.demo = false;
      state.shared = false;
      state.sharedTitle = '';
      clearShareHash();
    }
    const added = [];
    const errors = [];
    for (const file of files) {
      if (state.runs.length >= MAX_GHOSTS) {
        errors.push('The grid is full at ' + MAX_GHOSTS + ' ghosts, so ' + file.name + ' was skipped.');
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        errors.push(file.name + ' is ' + Math.round(file.size / 1048576) + ' MB, over the ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB limit. Trim it to the session you want to race.');
        continue;
      }
      try {
        const text = await file.text();
        const runs = GR.parseLog(text, file.name);
        for (const run of runs) {
          if (state.runs.length >= MAX_GHOSTS) break;
          run.name = uniqueName(run.name);
          run.color = nextColor();
          state.runs.push(run);
          added.push(run.name);
        }
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    rebuild({ restart: true });
    if (errors.length) status(errors.join(' '), 'error');
    else if (state.runs.length === 1) status('Added ' + added[0] + '. Add another log to race against it, or watch it run solo.', 'good');
    else if (added.length) status('Added ' + added.join(', ') + '.', 'good');
    if (added.length && !reducedMotion) setPlaying(true);
  }

  function loadDemo() {
    clearShareHash();
    state.shared = false;
    state.sharedTitle = '';
    state.runs = GR.demoRuns();
    state.runs.forEach((r, i) => (r.color = GR.PALETTE[i]));
    state.demo = true;
    state.demoTitle = 'Fix the flaky checkout test';
    rebuild({ restart: true });
    status('Demo race loaded. These ghosts are made up; add your own logs to race real agents.');
  }

  // -------------------------------------------------------------- share ---

  async function loadShared(hash) {
    try {
      const payload = await GR.decodeShare(hash);
      const shared = GR.runsFromShare(payload);
      shared.runs.forEach((r, i) => (r.color = r.color || GR.PALETTE[i % GR.PALETTE.length]));
      state.runs = shared.runs;
      state.demo = false;
      state.shared = true;
      state.sharedTitle = shared.title;
      state.mode = shared.mode;
      state.skipIdle = shared.skipIdle;
      $('skip-idle').checked = shared.skipIdle;
      rebuild({ restart: true });
      status(shared.fromCli ? 'Your race is ready. Export a clip or copy a share link below.' : 'You are watching a shared race. Add your own logs to race your agents.');
      return true;
    } catch (e) {
      status(e.message || String(e), 'error');
      return false;
    }
  }

  async function copyShareLink() {
    if (!state.race) return;
    if (!GR.canShare()) {
      status("This browser can't make share links. Try the latest Chrome, Edge, Firefox or Safari.", 'error', 'share');
      return;
    }
    const payload = GR.makeSharePayload(state.runs, { title: renderOpts().title, mode: state.race.mode, skipIdle: state.skipIdle });
    const url = GR.shareUrl(await GR.encodeShare(payload));
    const field = $('share-url');
    field.value = url;
    field.hidden = false;
    let copied = false;
    try {
      await root.navigator.clipboard.writeText(url);
      copied = true;
    } catch (e) {
      field.focus();
      field.select();
    }
    const kb = Math.round(url.length / 1024);
    const long = url.length > 8000 ? ' It is long (' + kb + ' KB) because the sessions are big; some apps may cut long links, so test it first.' : '';
    status((copied ? 'Share link copied.' : 'Copy the share link from the box below.') + long, copied ? 'good' : '', 'share');
  }

  // ------------------------------------------------------------- export ---

  function stamp() {
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  async function exportClip() {
    if (!state.race || state.exporting) return;
    if (!GR.canExportVideoAtAll()) {
      status("This browser can't make video. Try the latest Chrome, Edge or Safari, or use Save results image.", 'error', 'share');
      return;
    }
    setPlaying(false);
    const ctrl = new AbortController();
    state.exporting = ctrl;
    updateClipNote();
    $('recording').hidden = false;
    const { w, h } = size();
    try {
      const out = await GR.exportClip({
        race: state.race,
        timeline: state.timeline,
        opts: renderOpts(),
        width: w,
        height: h,
        signal: ctrl.signal,
        onFrame: (c, t) => {
          ctx.drawImage(c, 0, 0, canvas.width, canvas.height);
          state.t = Math.min(t, state.timeline.total);
          syncTransport();
        },
        onProgress: (f, how) => {
          $('rec-progress').value = f;
          $('rec-text').textContent = (how === 'render' ? 'Rendering your clip, ' : 'Recording your clip, ') + Math.round(f * 100) + '%';
        },
        onFallback: () => {
          $('rec-text').textContent = 'Recording your clip in real time';
        },
      });
      const name = 'ghost-race-' + stamp() + '.' + out.ext;
      await GR.download(out.blob, name);
      if (out.ext === 'mp4') status('Saved ' + name + '. It is ready to post on X.', 'good', 'share');
      else status('Saved ' + name + '. This browser can only record WebM, which X does not accept. Convert it to MP4, or export from the latest Chrome or Safari.', 'error', 'share');
    } catch (e) {
      if (e && e.name === 'AbortError') status(e.message === 'Save cancelled.' ? 'Save cancelled.' : 'Export cancelled.', '', 'share');
      else status('The export stopped: ' + (e && e.message ? e.message : e), 'error', 'share');
    } finally {
      state.exporting = null;
      $('recording').hidden = true;
      $('rec-progress').value = 0;
      updateClipNote();
      draw();
    }
  }

  async function exportPng() {
    if (!state.race) return;
    const { w, h } = size();
    const blob = await GR.exportPng({ race: state.race, timeline: state.timeline, opts: renderOpts(), width: w, height: h });
    const name = 'ghost-race-results-' + stamp() + '.png';
    try {
      await GR.download(blob, name);
      status('Saved ' + name + '.', 'good', 'share');
    } catch (e) {
      status(e && e.name === 'AbortError' ? 'Save cancelled.' : (e && e.message) || String(e), e && e.name === 'AbortError' ? '' : 'error', 'share');
    }
  }

  // --------------------------------------------------------------- wiring --

  function wire() {
    $('play').addEventListener('click', () => setPlaying(!state.playing));
    $('restart').addEventListener('click', () => {
      state.t = 0;
      draw();
      setPlaying(true);
    });
    $('scrub').addEventListener('input', (e) => {
      state.t = (Number(e.target.value) / 1000) * state.timeline.total;
      draw();
    });
    canvas.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        setPlaying(!state.playing);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        state.t = GR.clamp(state.t + (e.key === 'ArrowRight' ? 1 : -1), 0, state.timeline.total);
        draw();
      }
    });
    canvas.addEventListener('click', () => setPlaying(!state.playing));

    for (const input of doc.querySelectorAll('input[name="mode"]')) {
      input.addEventListener('change', () => {
        state.mode = input.value;
        rebuild();
      });
    }
    for (const input of doc.querySelectorAll('input[name="aspect"]')) {
      input.checked = input.value === state.aspect;
      input.addEventListener('change', () => {
        state.aspect = input.value;
        draw();
      });
    }
    $('skip-idle').addEventListener('change', (e) => {
      state.skipIdle = e.target.checked;
      rebuild();
    });
    $('details').addEventListener('change', (e) => {
      state.details = e.target.checked;
      draw();
    });
    $('title').addEventListener('input', (e) => {
      state.title = e.target.value.trim();
      draw();
    });
    $('length').addEventListener('change', (e) => {
      const f = state.t / state.timeline.total;
      state.length = Number(e.target.value);
      rebuild();
      state.t = f * state.timeline.total;
      draw();
    });
    $('files').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    $('demo').addEventListener('click', () => {
      loadDemo();
      if (!reducedMotion) setPlaying(true);
    });
    $('export').addEventListener('click', exportClip);
    $('share').addEventListener('click', copyShareLink);
    root.addEventListener('hashchange', () => {
      if (root.location.hash.startsWith(GR.SHARE_PREFIX)) loadShared(root.location.hash);
    });
    $('png').addEventListener('click', exportPng);
    $('rec-cancel').addEventListener('click', () => state.exporting && state.exporting.abort());

    // drag and drop anywhere on the page
    let depth = 0;
    const veil = $('drag-veil');
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    root.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      veil.hidden = false;
    });
    root.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    root.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) veil.hidden = true;
    });
    root.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      veil.hidden = true;
      addFiles(e.dataTransfer.files);
    });

    doc.addEventListener('visibilitychange', () => {
      if (doc.hidden && state.exporting) status('Keep this tab visible while the clip records, or the video may skip.', 'error');
    });
  }

  async function start() {
    wire();
    try {
      await Promise.all([
        doc.fonts.load('400 40px "Anton"'),
        doc.fonts.load('400 20px "Fira Sans"'),
        doc.fonts.load('500 20px "Fira Sans"'),
        doc.fonts.load('700 20px "Fira Sans"'),
      ]);
    } catch (e) {
      /* fall back to system fonts */
    }
    GR.clearRenderCache();
    const hash = root.location.hash || '';
    const fromLink = hash.startsWith(GR.SHARE_PREFIX) && (await loadShared(hash));
    if (!fromLink) {
      const keep = $('status').textContent;
      loadDemo();
      status(keep, keep ? 'error' : '');
    }
    if (!reducedMotion) setPlaying(true);
  }

  GR.app = { state, rebuild, draw, setPlaying, addFiles, loadDemo };
  start();
})(window);
