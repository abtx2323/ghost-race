/*!
 * Ghost Race — race.js
 * Turns parsed runs into a race: where each ghost is on the track at any
 * point on the race clock, who is leading, and where the runs forked.
 *
 * The race clock ("x") can be measured three ways:
 *   time   – active seconds (long idle gaps capped so a coffee break doesn't lose the race)
 *   tokens – total tokens burned (the cheapest run wins)
 *   steps  – agent moves (the most direct run wins)
 * Each ghost completes one lap between its first and its last move.
 */
(function (root) {
  'use strict';

  const GR = (root.GhostRace = root.GhostRace || {});

  GR.MODES = {
    time: { label: 'Time', unit: 'agent time' },
    tokens: { label: 'Tokens', unit: 'tokens burned' },
    steps: { label: 'Steps', unit: 'moves' },
  };

  GR.buildRace = function buildRace(runs, opts) {
    opts = opts || {};
    const requested = opts.mode || 'time';
    const skipIdle = opts.skipIdle !== false;
    const idleCap = opts.idleCap || 30;

    const available = {
      time: true,
      tokens: runs.length > 0 && runs.every((r) => r.totals.tokens > 0),
      steps: true,
    };
    const mode = available[requested] ? requested : 'steps';

    const racers = runs.map((run, index) => {
      // Active time: cap long gaps (waiting on a human, lunch, etc).
      let prevT = 0;
      let active = 0;
      const events = run.events.map((e) => {
        let gap = e.t - prevT;
        if (skipIdle && gap > idleCap) gap = idleCap;
        active += Math.max(0, gap);
        prevT = e.t;
        return Object.assign({}, e, { at: active });
      });

      const steps = events.filter((e) => e.kind !== 'crash');
      const N = steps.length;
      steps.forEach((e, k) => {
        e.x = mode === 'time' ? e.at : mode === 'tokens' ? e.tokens : k;
      });
      // tokens can repeat across moves made in one model call; keep x monotonic
      for (let k = 1; k < N; k++) if (steps[k].x < steps[k - 1].x) steps[k].x = steps[k - 1].x;

      const points = [{ x: 0, p: 0 }];
      if (N === 1) {
        points.push({ x: Math.max(steps[0].x, 1e-6), p: 1 });
      } else {
        steps.forEach((e, k) => points.push({ x: e.x, p: k / (N - 1) }));
      }

      for (const e of events) {
        if (e.kind !== 'crash') continue;
        if (mode === 'time') e.x = e.at;
        else if (mode === 'tokens') e.x = e.tokens;
        else e.x = Math.min(Math.max(0, e.step - 1) + 0.5, Math.max(0, N - 1));
      }

      const xEnd = points[points.length - 1].x;
      return {
        index,
        run,
        color: run.color || GR.PALETTE[index % GR.PALETTE.length],
        events,
        steps,
        points,
        xEnd,
        dnf: run.outcome === 'dnf',
      };
    });

    assignCodes(racers);
    const maxX = Math.max(1e-6, ...racers.map((r) => r.xEnd));
    const maxTokens = Math.max(1, ...racers.map((r) => r.run.totals.tokens || 0));
    const race = { mode, requested, available, skipIdle, racers, maxX, maxTokens };
    race.fork = findFork(racers);
    racers.forEach((r) => {
      r.sectors = [1, 2, 3].map((k) => {
        const end = GR.xAtProgress(r, k / 3);
        const start = k === 1 ? 0 : GR.xAtProgress(r, (k - 1) / 3);
        return { end, time: end - start };
      });
    });
    race.moments = computeMoments(race);
    return race;
  };

  // Three-letter codes, broadcast style: "The Planner" -> PLA, "Sonnet 4.5" -> SON.
  function assignCodes(racers) {
    const used = new Set();
    for (const r of racers) {
      const words = String(r.run.name || 'Ghost')
        .replace(/[^A-Za-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => /[A-Za-z]{3,}/.test(w) && !/^(the|and|for)$/i.test(w));
      let base = (words.length ? words[words.length > 1 ? words.length - 1 : 0] : 'GHO').replace(/[^A-Za-z]/g, '');
      if (words.length > 1 && /^(codex|max|mini|pro|preview|run|version|agent|v\d+)$/i.test(base)) base = words[0].replace(/[^A-Za-z]/g, '');
      let code = (base + 'XXX').slice(0, 3).toUpperCase();
      let n = 2;
      while (used.has(code)) code = code.slice(0, 2) + n++;
      used.add(code);
      r.code = code;
    }
  }

  GR.xAtProgress = function xAtProgress(racer, p) {
    const pts = racer.points;
    if (p <= 0) return 0;
    if (p >= 1) return racer.xEnd;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].p >= p) {
        const a = pts[i - 1];
        const b = pts[i];
        if (b.p === a.p) return b.x;
        return a.x + (b.x - a.x) * ((p - a.p) / (b.p - a.p));
      }
    }
    return racer.xEnd;
  };

  // F1-style interval: how much earlier on the clock the leader reached the
  // point on the lap where this ghost is now.
  GR.gapAt = function gapAt(race, row, leaderRow, x) {
    if (row === leaderRow) return 0;
    if (row.finished && leaderRow.finished) return row.racer.xEnd - leaderRow.racer.xEnd;
    return Math.max(0, x - GR.xAtProgress(leaderRow.racer, row.p));
  };

  GR.formatGap = function formatGap(race, gap) {
    if (race.mode === 'time') return '+' + (gap < 60 ? gap.toFixed(1) + 's' : GR.formatDuration(gap));
    if (race.mode === 'tokens') return '+' + GR.formatTokens(gap);
    const g = Math.round(gap);
    return '+' + g + (g === 1 ? ' move' : ' moves');
  };

  const VERBS = {
    read: 'reads', search: 'searches', edit: 'edits', shell: 'runs a command', test: 'runs the tests',
    web: 'hits the web', agent: 'sends a sub-agent', plan: 'makes a plan', mcp: 'calls an MCP tool',
    ask: 'asks the human', other: 'calls a tool',
  };
  const CRASH_NOUNS = {
    test: 'a failing test', shell: 'a failed command', edit: 'a failed edit', read: 'a failed read',
    search: 'a failed search', web: 'a failed web request', mcp: 'a failed MCP call', agent: 'a failed sub-agent',
    other: 'a failed tool call',
  };

  function listJoin(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  // Story beats for the race-control box: fork, crashes, lead changes, finishes.
  function computeMoments(race) {
    const moments = [];
    const { racers, maxX } = race;
    if (race.fork) {
      const parts = race.fork.picks.map((pk) => pk.racer.code + ' ' + (pk.cat ? VERBS[pk.cat] || VERBS.other : 'stops using tools'));
      moments.push({ x: race.fork.x, kind: 'fork', title: 'Fork at move ' + race.fork.move, text: listJoin(parts) + '.' });
    }
    for (const r of racers) {
      for (const e of r.events) {
        if (e.kind !== 'crash') continue;
        const noun = e.name === 'API' ? 'an API error' : CRASH_NOUNS[e.cat] || CRASH_NOUNS.other;
        moments.push({ x: e.x, kind: 'crash', title: 'Crash', text: r.code + ' crashes on ' + noun + '.', racer: r });
      }
    }
    if (racers.length > 1) {
      const samples = 600;
      let leader = null;
      let lastChangeX = -Infinity;
      for (let i = 1; i <= samples; i++) {
        const x = (i / samples) * maxX;
        const rows = GR.standingsAt(race, x);
        if (rows.every((rw) => rw.p === 0)) continue;
        const top = rows[0].racer;
        if (leader && top !== leader && !rows[0].finished) {
          if (x - lastChangeX > maxX * 0.02) {
            moments.push({ x, kind: 'lead', title: 'New leader', text: top.code + ' takes the lead from ' + leader.code + '.', racer: top });
          }
          lastChangeX = x;
        }
        leader = top;
      }
    }
    const final = GR.standingsAt(race, maxX);
    const winner = final.find((rw) => !rw.dnf);
    for (const rw of final) {
      const r = rw.racer;
      let text;
      if (rw.dnf || !winner) text = r.code + ' reaches the end but did not finish the task.';
      else if (rw === winner) text = r.code + ' wins in ' + GR.formatResult(race, r) + '.';
      else text = r.code + ' finishes P' + rw.place + ', ' + GR.formatGap(race, r.xEnd - winner.racer.xEnd) + '.';
      moments.push({ x: r.xEnd, kind: rw === winner ? 'win' : 'finish', title: rw === winner ? 'Chequered flag' : 'Finish', text, racer: r });
    }
    moments.sort((a, b) => a.x - b.x);
    return moments;
  }

  // Where did the runs first choose a different kind of tool?
  function findFork(racers) {
    if (racers.length < 2) return null;
    const seqs = racers.map((r) => r.events.filter((e) => e.kind === 'tool'));
    const minLen = Math.min(...seqs.map((s) => s.length));
    const maxLen = Math.max(...seqs.map((s) => s.length));
    let i = 0;
    while (i < minLen && seqs.every((s) => s[i].cat === seqs[0][i].cat)) i++;
    if (i === minLen && minLen === maxLen) return null;
    const picks = racers.map((r, k) => ({ racer: r, cat: seqs[k][i] ? seqs[k][i].cat : null }));
    const x = Math.max(...racers.map((r, k) => (seqs[k][i] ? seqs[k][i].x : r.xEnd)));
    return { move: i + 1, x, picks };
  }

  GR.progressAt = function progressAt(racer, x) {
    const pts = racer.points;
    if (x <= 0) return 0;
    if (x >= racer.xEnd) return 1;
    // last point with px <= x
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].x <= x) lo = mid;
      else hi = mid - 1;
    }
    const a = pts[lo];
    const b = pts[Math.min(lo + 1, pts.length - 1)];
    if (b.x <= a.x) return a.p;
    return a.p + (b.p - a.p) * ((x - a.x) / (b.x - a.x));
  };

  GR.statsAt = function statsAt(racer, x) {
    let steps = 0;
    let tools = 0;
    let crashes = 0;
    let tokens = 0;
    let last = null;
    for (const e of racer.events) {
      if (e.x > x + 1e-9) break;
      if (e.kind === 'crash') crashes++;
      else {
        steps++;
        if (e.kind === 'tool') tools++;
        last = e;
      }
      tokens = Math.max(tokens, e.tokens || 0);
    }
    return { steps, tools, crashes, tokens, last };
  };

  GR.standingsAt = function standingsAt(race, x) {
    const rows = race.racers.map((r) => {
      const p = GR.progressAt(r, x);
      const finished = x >= r.xEnd;
      return { racer: r, run: r.run, p, finished, dnf: r.dnf && finished };
    });
    rows.sort((a, b) => {
      const ga = a.dnf ? 2 : a.finished ? 0 : 1;
      const gb = b.dnf ? 2 : b.finished ? 0 : 1;
      if (ga !== gb) return ga - gb;
      if (ga === 0) return a.racer.xEnd - b.racer.xEnd;
      return b.p - a.p || a.racer.index - b.racer.index;
    });
    rows.forEach((row, i) => (row.place = i + 1));
    return rows;
  };

  // Events on this racer's timeline inside (x - window, x].
  GR.eventsNear = function eventsNear(racer, x, windowX) {
    const out = [];
    for (const e of racer.events) {
      if (e.x > x) break;
      if (e.x > x - windowX) out.push(e);
    }
    return out;
  };

  GR.formatClock = function formatClock(race, x) {
    if (race.mode === 'time') return GR.formatDuration(x);
    if (race.mode === 'tokens') return GR.formatTokens(x);
    return 'Move ' + Math.min(Math.floor(x) + 1, Math.round(race.maxX) + 1);
  };

  GR.formatResult = function formatResult(race, racer) {
    if (race.mode === 'time') return GR.formatDuration(racer.xEnd);
    if (race.mode === 'tokens') return GR.formatTokens(racer.xEnd) + ' tok';
    return racer.steps.length + ' moves';
  };
})(typeof window !== 'undefined' ? window : globalThis);
