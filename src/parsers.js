/*!
 * Ghost Race — parsers.js
 * Turns agent session logs into "runs": a timeline of steps, pit stops
 * (tool calls), crashes (failed tool results) and fuel (tokens).
 *
 * Supported inputs:
 *   - Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl)
 *   - Codex CLI rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 *   - The open Ghost Race format (*.ghost.json), see docs/FORMAT.md
 *
 * Everything runs locally. Nothing in a log ever leaves the browser.
 */
(function (root) {
  'use strict';

  const GR = (root.GhostRace = root.GhostRace || {});

  // Event shape produced by every parser:
  //   { t: seconds since start, kind: 'tool' | 'talk' | 'crash',
  //     name, cat, detail, tokens: cumulative tokens at this point }

  // ---------------------------------------------------------------- utils --

  function parseJsonl(text) {
    const lines = [];
    let bad = 0;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch (e) {
        bad++;
      }
    }
    return { lines, bad };
  }

  function textOf(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (typeof b === 'string' ? b : b && (b.text || b.input_text || b.output_text || '')))
        .filter(Boolean)
        .join('\n');
    }
    if (typeof content === 'object' && content.text) return content.text;
    return '';
  }

  function safeJson(s) {
    if (typeof s !== 'string') return s;
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  function commandText(cmd) {
    if (Array.isArray(cmd)) {
      // ["bash", "-lc", "npm test"] -> "npm test"
      if (cmd.length >= 3 && /(^|\/)(ba|z)?sh$/.test(cmd[0]) && /^-\w*c$/.test(cmd[1])) return String(cmd[2]);
      return cmd.join(' ');
    }
    return cmd == null ? '' : String(cmd);
  }

  // Pull a short, human-readable detail out of a tool's input.
  function toolDetail(name, input) {
    if (input == null) return '';
    if (typeof input === 'string') {
      const m = input.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
      if (m) return GR.basename(m[1].trim());
      return GR.truncate(input, 80);
    }
    const i = input;
    const cmd = i.command != null ? i.command : i.cmd;
    if (cmd != null) return GR.truncate(commandText(cmd), 80);
    const file = i.file_path || i.path || i.notebook_path || i.filename || i.target_file;
    if (file) return GR.basename(file);
    if (i.pattern) return GR.truncate(i.pattern, 60);
    if (i.query) return GR.truncate(i.query, 60);
    if (i.url) return GR.truncate(i.url, 60);
    if (i.description) return GR.truncate(i.description, 60);
    if (i.subagent_type) return String(i.subagent_type);
    return '';
  }

  function toolCommand(input) {
    if (input && typeof input === 'object') {
      const cmd = input.command != null ? input.command : input.cmd;
      if (cmd != null) return commandText(cmd);
    }
    if (typeof input === 'string' && input.includes('*** Begin Patch')) return input;
    return '';
  }

  function makeTool(t, name, input, tokens, extra) {
    const cat = GR.categorizeTool(name, toolCommand(input));
    return Object.assign({ t, kind: 'tool', name: String(name || 'tool'), cat, detail: toolDetail(name, input), tokens }, extra || {});
  }

  // Skip harness noise that isn't a real user prompt.
  function isNoisePrompt(text) {
    const s = String(text || '').trim();
    if (!s) return true;
    return /^<(command-|local-command|environment_context|user_instructions|system-reminder|user-memory|INSTRUCTIONS)/i.test(s) ||
      /^Caveat: The messages below/i.test(s) ||
      /^# AGENTS\.md/i.test(s) ||
      /^\[Request interrupted/i.test(s);
  }

  // ----------------------------------------------------------- claude code --

  function looksLikeClaudeCode(lines) {
    return lines.some((l) => l && (l.type === 'user' || l.type === 'assistant') && l.message && ('sessionId' in l || 'uuid' in l || 'parentUuid' in l));
  }

  function usageTotal(u) {
    if (!u) return 0;
    return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
  }

  function parseClaudeCode(lines, fileName) {
    const warnings = [];
    // Claude Code writes one line per content block, repeating the message's
    // usage on each. Keep the largest usage per message id and count it once.
    const usageById = new Map();
    for (const l of lines) {
      if (l.type !== 'assistant' || !l.message) continue;
      const id = l.message.id || l.uuid;
      const total = usageTotal(l.message.usage);
      if (!usageById.has(id) || usageById.get(id) < total) usageById.set(id, total);
    }

    const models = new Map();
    const toolNames = new Map();
    const events = [];
    const counted = new Set();
    let tokens = 0;
    let task = null;
    let t0 = NaN;
    let lastTs = NaN;
    let synthetic = false;

    lines.forEach((l, idx) => {
      if (!l || (l.type !== 'user' && l.type !== 'assistant')) return;
      let ts = GR.parseTime(l.timestamp);
      if (!Number.isFinite(ts)) {
        synthetic = true;
        ts = Number.isFinite(lastTs) ? lastTs + 1000 : 0;
      }
      lastTs = ts;
      const msg = l.message || {};

      if (l.type === 'user') {
        const content = msg.content;
        if (!l.isMeta && !l.isCompactSummary) {
          const text = typeof content === 'string' ? content : textOf((content || []).filter((b) => b && b.type === 'text'));
          if (!isNoisePrompt(text)) {
            if (task == null) task = text.trim();
            if (!Number.isFinite(t0)) t0 = ts;
          }
        }
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && b.type === 'tool_result' && b.is_error === true) {
              const tool = toolNames.get(b.tool_use_id) || { name: 'tool', cat: 'other' };
              events.push({ ts, kind: 'crash', name: tool.name, cat: tool.cat, detail: GR.truncate(textOf(b.content), 80), tokens });
            }
          }
        }
        return;
      }

      // assistant
      if (!Number.isFinite(t0)) t0 = ts;
      const id = msg.id || l.uuid || 'line' + idx;
      if (!counted.has(id)) {
        counted.add(id);
        tokens += usageById.get(id) || 0;
      }
      if (msg.model && msg.model !== '<synthetic>' && !l.isSidechain) {
        models.set(msg.model, (models.get(msg.model) || 0) + 1);
      }
      if (l.isApiErrorMessage || msg.model === '<synthetic>') {
        const text = textOf(msg.content);
        if (/error|overloaded|rate.?limit|timeout/i.test(text)) {
          events.push({ ts, kind: 'crash', name: 'API', cat: 'other', detail: GR.truncate(text, 80), tokens });
        }
        return;
      }
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: textOf(msg.content) }];
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && String(b.text || '').trim()) {
          events.push({ ts, kind: 'talk', name: 'reply', cat: 'talk', detail: GR.truncate(b.text, 80), tokens, sidechain: !!l.isSidechain });
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const ev = makeTool(0, b.name, b.input, tokens, { sidechain: !!l.isSidechain });
          toolNames.set(b.id, { name: ev.name, cat: ev.cat });
          ev.ts = ts;
          events.push(ev);
        }
      }
    });

    const model = topKey(models);
    return finalizeRun({
      source: 'claude-code',
      sourceLabel: 'Claude Code',
      file: fileName,
      model,
      task,
      t0,
      synthetic,
      events,
      warnings,
    });
  }

  // ----------------------------------------------------------------- codex --

  const CODEX_WRAPPERS = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted']);
  const CODEX_ITEMS = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'web_search_call', 'reasoning']);

  function looksLikeCodex(lines) {
    if (lines.some((l) => l && CODEX_WRAPPERS.has(l.type) && l.payload)) return true;
    if (lines[0] && 'instructions' in lines[0] && 'id' in lines[0]) return true;
    return lines.some((l) => l && (l.type === 'function_call' || l.type === 'local_shell_call'));
  }

  function codexExitCode(output) {
    if (output == null) return null;
    const obj = typeof output === 'object' ? output : safeJson(output);
    if (obj && obj.metadata && Number.isFinite(obj.metadata.exit_code)) return obj.metadata.exit_code;
    if (obj && Number.isFinite(obj.exit_code)) return obj.exit_code;
    const s = typeof output === 'string' ? output : obj && typeof obj.output === 'string' ? obj.output : '';
    const m = s.match(/(?:exited with code|Exit code:)\s*(-?\d+)/i);
    if (m) return parseInt(m[1], 10);
    if (/^(error|failed|apply_patch verification failed)/i.test(s.trim())) return 1;
    return null;
  }

  function parseCodex(lines, fileName) {
    const warnings = [];
    const events = [];
    const toolByCall = new Map();
    const crashed = new Set();
    const models = new Map();
    let tokens = 0;
    let task = null;
    let t0 = NaN;
    let lastTs = NaN;
    let synthetic = false;

    for (const raw of lines) {
      if (!raw) continue;
      let kind;
      let p;
      if (CODEX_WRAPPERS.has(raw.type) && raw.payload) {
        kind = raw.type;
        p = raw.payload;
      } else if (CODEX_ITEMS.has(raw.type)) {
        kind = 'response_item';
        p = raw;
      } else {
        continue; // legacy header / state records
      }
      let ts = GR.parseTime(raw.timestamp);
      if (!Number.isFinite(ts)) {
        synthetic = true;
        ts = Number.isFinite(lastTs) ? lastTs + 1000 : 0;
      }
      lastTs = ts;

      if (kind === 'turn_context' || kind === 'session_meta') {
        if (p.model) models.set(p.model, (models.get(p.model) || 0) + 1);
        continue;
      }

      if (kind === 'event_msg') {
        if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
          const u = p.info.total_token_usage;
          const total = u.total_tokens != null ? u.total_tokens : (u.input_tokens || 0) + (u.output_tokens || 0);
          if (total > tokens) tokens = total;
        } else if (p.type === 'user_message' && !isNoisePrompt(p.message)) {
          if (task == null) task = String(p.message).trim();
          if (!Number.isFinite(t0)) t0 = ts;
        } else if (p.type === 'exec_command_end' && p.call_id && Number.isFinite(p.exit_code) && p.exit_code !== 0 && !crashed.has(p.call_id)) {
          crashed.add(p.call_id);
          const tool = toolByCall.get(p.call_id) || { name: 'shell', cat: 'shell' };
          events.push({ ts, kind: 'crash', name: tool.name, cat: tool.cat, detail: 'exit ' + p.exit_code, tokens });
        }
        continue;
      }

      if (kind !== 'response_item') continue;

      switch (p.type) {
        case 'message': {
          const text = textOf(p.content);
          if (p.role === 'user') {
            if (!isNoisePrompt(text)) {
              if (task == null) task = text.trim();
              if (!Number.isFinite(t0)) t0 = ts;
            }
          } else if (p.role === 'assistant' && text.trim()) {
            if (!Number.isFinite(t0)) t0 = ts;
            events.push({ ts, kind: 'talk', name: 'reply', cat: 'talk', detail: GR.truncate(text, 80), tokens });
          }
          break;
        }
        case 'function_call':
        case 'custom_tool_call':
        case 'local_shell_call':
        case 'web_search_call': {
          if (!Number.isFinite(t0)) t0 = ts;
          let name = p.name;
          let input = p.type === 'function_call' ? safeJson(p.arguments) || p.arguments : p.input;
          if (p.type === 'local_shell_call') {
            name = 'shell';
            input = { command: p.action && p.action.command };
          } else if (p.type === 'web_search_call') {
            name = 'web_search';
            input = { query: p.action && p.action.query };
          }
          const ev = makeTool(0, name, input, tokens);
          ev.ts = ts;
          events.push(ev);
          if (p.call_id) toolByCall.set(p.call_id, { name: ev.name, cat: ev.cat });
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const code = codexExitCode(p.output);
          if (code != null && code !== 0 && !crashed.has(p.call_id)) {
            crashed.add(p.call_id);
            const tool = toolByCall.get(p.call_id) || { name: 'tool', cat: 'other' };
            events.push({ ts, kind: 'crash', name: tool.name, cat: tool.cat, detail: 'exit ' + code, tokens });
          }
          break;
        }
        default:
          break;
      }
    }

    // token_count events arrive just after the step they paid for, so each
    // event carries the running total known at that moment, and the final
    // total lands on the last event.
    return finalizeRun({
      source: 'codex',
      sourceLabel: 'Codex',
      file: fileName,
      model: topKey(models),
      task,
      t0,
      synthetic,
      events,
      warnings,
      finalTokens: tokens,
    });
  }

  // ------------------------------------------------------ ghost race json --

  function looksLikeGhostJson(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (Array.isArray(obj)) return obj.length > 0 && obj.every((r) => r && Array.isArray(r.events));
    return Array.isArray(obj.events) || Array.isArray(obj.runs);
  }

  const GHOST_KIND = {
    tool: 'tool', tool_call: 'tool', call: 'tool', pit: 'tool',
    error: 'crash', crash: 'crash', fail: 'crash', failure: 'crash',
    message: 'talk', talk: 'talk', step: 'talk', reply: 'talk', thought: 'talk',
    finish: 'finish', end: 'finish', done: 'finish',
    start: 'start',
  };

  function parseGhostJson(obj, fileName) {
    const list = Array.isArray(obj) ? obj : Array.isArray(obj.runs) ? obj.runs : [obj];
    return list.map((r, i) => {
      const warnings = [];
      const events = [];
      let tokens = 0;
      let cost = 0;
      let finishTs = NaN;
      let base = NaN;
      const lastCat = new Map();
      (r.events || []).forEach((e, k) => {
        if (!e) return;
        let ts;
        if (typeof e.t === 'number') ts = e.t * 1000;
        else if (e.t != null || e.time != null || e.timestamp != null) {
          ts = GR.parseTime(e.t != null ? e.t : e.time != null ? e.time : e.timestamp);
          if (Number.isFinite(ts) && !Number.isFinite(base)) base = ts;
        } else ts = k * 1000;
        if (!Number.isFinite(ts)) ts = k * 1000;
        const kind = GHOST_KIND[String(e.type || e.kind || 'tool').toLowerCase()] || 'tool';
        tokens += Number(e.tokens) || 0;
        cost += Number(e.cost) || 0;
        if (kind === 'start') return;
        if (kind === 'finish') {
          finishTs = ts;
          return;
        }
        const name = e.name || (kind === 'talk' ? 'reply' : 'tool');
        if (kind === 'tool') {
          const ev = makeTool(0, name, e.input || (e.command ? { command: e.command } : null), tokens);
          ev.ts = ts;
          if (e.category && GR.CATEGORIES[e.category]) ev.cat = e.category;
          if (e.detail) ev.detail = GR.truncate(e.detail, 80);
          events.push(ev);
          lastCat.set(ev.name, ev.cat);
          if (e.error === true || e.ok === false) {
            events.push({ ts: ts + 1, kind: 'crash', name: ev.name, cat: ev.cat, detail: e.detail ? GR.truncate(e.detail, 80) : '', tokens });
          }
        } else {
          const cat = kind !== 'crash' ? 'talk' : e.category && GR.CATEGORIES[e.category] ? e.category : lastCat.get(name) || GR.categorizeTool(name, e.command);
          events.push({ ts, kind, name, cat, detail: GR.truncate(e.detail || '', 80), tokens });
        }
      });
      const t0 = Number.isFinite(base) ? base : 0;
      const run = finalizeRun({
        source: 'ghost-json',
        sourceLabel: 'Ghost JSON',
        file: fileName,
        model: r.model || null,
        name: r.name || null,
        task: r.task || null,
        t0,
        synthetic: false,
        events,
        warnings,
        finishTs,
        outcome: r.outcome,
      });
      if (cost > 0) run.totals.cost = cost;
      if (!r.name && list.length > 1) run.name = (run.name || 'Ghost') + ' ' + (i + 1);
      return run;
    });
  }

  // --------------------------------------------------------------- common --

  function topKey(map) {
    let best = null;
    let n = -1;
    for (const [k, v] of map) {
      if (v > n) {
        best = k;
        n = v;
      }
    }
    return best;
  }

  function finalizeRun(r) {
    let events = r.events.slice();
    if (!events.length) throw new Error('No agent steps found in ' + (r.file || 'this file') + '.');
    // stable sort by time
    events = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
    let t0 = Number.isFinite(r.t0) ? r.t0 : events[0].ts;
    if (events[0].ts < t0) t0 = events[0].ts;

    // Codex reports tokens after the fact; make cumulative tokens monotonic and
    // let the final count land on the last event.
    if (r.finalTokens != null) {
      for (let i = events.length - 2; i >= 0; i--) {
        if (events[i].tokens > events[i + 1].tokens) events[i].tokens = events[i + 1].tokens;
      }
      const last = events[events.length - 1];
      if (r.finalTokens > last.tokens) last.tokens = r.finalTokens;
    }

    let step = 0;
    for (const e of events) {
      e.t = Math.max(0, (e.ts - t0) / 1000);
      delete e.ts;
      if (e.kind !== 'crash') e.step = ++step;
      else e.step = step;
    }
    const steps = events.filter((e) => e.kind !== 'crash');
    if (!steps.length) throw new Error('No agent steps found in ' + (r.file || 'this file') + '.');

    let duration = steps[steps.length - 1].t;
    if (Number.isFinite(r.finishTs)) duration = Math.max(duration, (r.finishTs - t0) / 1000);
    const tokens = events.reduce((m, e) => Math.max(m, e.tokens || 0), 0);

    const pretty = GR.prettyModel(r.model);
    const outcome = /^(dnf|fail|failed|failure|error)$/i.test(String(r.outcome || '')) ? 'dnf' : 'finish';
    return {
      id: 'run-' + Math.random().toString(36).slice(2, 9),
      name: r.name || pretty || r.sourceLabel || 'Ghost',
      model: r.model || null,
      modelLabel: pretty,
      source: r.source,
      sourceLabel: r.sourceLabel,
      file: r.file || null,
      task: r.task ? GR.truncate(r.task, 200) : null,
      timing: r.synthetic ? 'synthetic' : 'real',
      outcome,
      events,
      totals: {
        steps: steps.length,
        tools: events.filter((e) => e.kind === 'tool').length,
        crashes: events.filter((e) => e.kind === 'crash').length,
        talks: events.filter((e) => e.kind === 'talk').length,
        tokens,
        duration,
        cost: null,
      },
      warnings: r.warnings || [],
    };
  }

  // ---------------------------------------------------------------- entry --

  /**
   * Parse one file's text into an array of runs.
   * Throws an Error with a friendly message if the format isn't recognised.
   */
  GR.parseLog = function parseLog(text, fileName) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error((fileName || 'File') + ' is empty.');

    if (trimmed[0] === '{' || trimmed[0] === '[') {
      const whole = safeJson(trimmed);
      if (whole && looksLikeGhostJson(whole)) return parseGhostJson(whole, fileName);
    }

    const { lines, bad } = parseJsonl(trimmed);
    if (!lines.length) throw new Error("Couldn't read " + (fileName || 'this file') + ' as JSON or JSONL.');

    let runs;
    if (looksLikeClaudeCode(lines)) runs = [parseClaudeCode(lines, fileName)];
    else if (looksLikeCodex(lines)) runs = [parseCodex(lines, fileName)];
    else {
      throw new Error(
        "Didn't recognise " + (fileName || 'this file') +
          '. Ghost Race reads Claude Code (.jsonl), Codex CLI (.jsonl) and Ghost Race JSON (.ghost.json) files.'
      );
    }
    if (bad) runs.forEach((r) => r.warnings.push(bad + ' unreadable line(s) skipped.'));
    if (runs[0].timing === 'synthetic') runs[0].warnings.push('No timestamps in this log, so each step counts as 1 second.');
    return runs;
  };

  // Exposed for tests.
  GR._parsers = { parseClaudeCode, parseCodex, parseGhostJson, parseJsonl, codexExitCode, toolDetail };
})(typeof window !== 'undefined' ? window : globalThis);
