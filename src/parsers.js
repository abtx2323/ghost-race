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

  const MAX_EVENTS = 200000;
  const MAX_LINES = 1000000;

  function parseJsonl(text) {
    const lines = [];
    let bad = 0;
    const rawLines = String(text).split(/\r?\n/);
    if (rawLines.length > MAX_LINES) throw new Error('This log has more than ' + MAX_LINES.toLocaleString() + ' lines, which is more than Ghost Race can read.');
    for (const raw of rawLines) {
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
      const m = input.slice(0, 2000).match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
      if (m) return safeText(GR.basename(m[1].trim()), 80);
      return safeText(input, 80);
    }
    const i = input;
    const cmd = i.command != null ? i.command : i.cmd;
    if (cmd != null) return safeText(commandText(cmd), 80);
    const file = i.file_path || i.path || i.notebook_path || i.filename || i.target_file;
    if (file) return safeText(GR.basename(file), 80);
    if (i.pattern) return safeText(i.pattern, 60);
    if (i.query) return safeText(i.query, 60);
    if (i.url) return safeText(i.url, 60);
    if (i.description) return safeText(i.description, 60);
    if (i.subagent_type) return safeText(i.subagent_type, 40);
    return '';
  }

  // Everything shown from a log goes through redaction first, then truncation.
  function safeText(s, n) {
    return GR.truncate(GR.redact(s), n);
  }

  function nonNeg(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
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
    // session transcripts use sessionId/uuid; `claude -p --output-format stream-json` uses session_id
    return lines.some((l) => l && (l.type === 'user' || l.type === 'assistant') && l.message && ('sessionId' in l || 'session_id' in l || 'uuid' in l || 'parentUuid' in l));
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
    let cost = null;
    let failed = false;

    lines.forEach((l, idx) => {
      if (!l) return;
      if (l.type === 'system' && l.subtype === 'init') {
        const ts0 = GR.parseTime(l.timestamp);
        if (Number.isFinite(ts0) && !Number.isFinite(t0)) t0 = ts0;
        if (typeof l.model === 'string') models.set(l.model, (models.get(l.model) || 0) + 1);
        return;
      }
      if (l.type === 'result') {
        if (Number.isFinite(l.total_cost_usd)) cost = l.total_cost_usd;
        if (l.is_error === true || /^error/.test(String(l.subtype || ''))) failed = true;
        return;
      }
      if (l.type !== 'user' && l.type !== 'assistant') return;
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
              events.push({ ts, kind: 'crash', name: tool.name, cat: tool.cat, detail: safeText(textOf(b.content), 80), tokens });
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
      if (msg.model && msg.model !== '<synthetic>' && !l.isSidechain && !l.parent_tool_use_id) {
        models.set(msg.model, (models.get(msg.model) || 0) + 1);
      }
      if (l.isApiErrorMessage || msg.model === '<synthetic>') {
        const text = textOf(msg.content);
        if (/error|overloaded|rate.?limit|timeout/i.test(text)) {
          events.push({ ts, kind: 'crash', name: 'API', cat: 'other', detail: safeText(text, 80), tokens });
        }
        return;
      }
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: textOf(msg.content) }];
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && String(b.text || '').trim()) {
          events.push({ ts, kind: 'talk', name: 'reply', cat: 'talk', detail: safeText(b.text, 80), tokens, sidechain: !!l.isSidechain });
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
      cost,
      outcome: failed ? 'dnf' : undefined,
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
            events.push({ ts, kind: 'talk', name: 'reply', cat: 'talk', detail: safeText(text, 80), tokens });
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
      const evs = Array.isArray(r.events) ? r.events : [];
      if (evs.length > MAX_EVENTS) throw new Error((fileName || 'This file') + ' has more than ' + MAX_EVENTS.toLocaleString() + ' events, which is more than Ghost Race can draw.');
      evs.forEach((e, k) => {
        if (!e || typeof e !== 'object') return;
        let ts;
        if (typeof e.t === 'number') ts = Number.isFinite(e.t) ? e.t * 1000 : NaN;
        else if (e.t != null || e.time != null || e.timestamp != null) {
          ts = GR.parseTime(e.t != null ? e.t : e.time != null ? e.time : e.timestamp);
          if (Number.isFinite(ts) && !Number.isFinite(base)) base = ts;
        } else ts = k * 1000;
        if (!Number.isFinite(ts)) ts = k * 1000;
        const typeKey = String(e.type || e.kind || 'tool').toLowerCase();
        const kind = GR.own(GHOST_KIND, typeKey) ? GHOST_KIND[typeKey] : 'tool';
        tokens += nonNeg(e.tokens);
        cost += nonNeg(e.cost);
        if (kind === 'start') return;
        if (kind === 'finish') {
          finishTs = ts;
          return;
        }
        const name = typeof e.name === 'string' && e.name ? e.name.slice(0, 60) : kind === 'talk' ? 'reply' : 'tool';
        if (kind === 'tool') {
          const ev = makeTool(0, name, e.input || (e.command ? { command: String(e.command) } : null), tokens);
          ev.ts = ts;
          if (GR.isCategory(e.category)) ev.cat = e.category;
          if (e.detail) ev.detail = safeText(e.detail, 80);
          events.push(ev);
          lastCat.set(ev.name, ev.cat);
          if (e.error === true || e.ok === false) {
            events.push({ ts: ts + 1, kind: 'crash', name: ev.name, cat: ev.cat, detail: e.detail ? safeText(e.detail, 80) : '', tokens });
          }
        } else {
          const cat = kind !== 'crash' ? 'talk' : GR.isCategory(e.category) ? e.category : lastCat.get(name) || GR.categorizeTool(name, e.command);
          events.push({ ts, kind, name, cat, detail: safeText(e.detail || '', 80), tokens });
        }
      });
      const t0 = Number.isFinite(base) ? base : 0;
      const run = finalizeRun({
        source: 'ghost-json',
        sourceLabel: 'Ghost JSON',
        file: fileName,
        model: typeof r.model === 'string' ? r.model.slice(0, 80) : null,
        name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : null,
        task: typeof r.task === 'string' ? r.task : null,
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


  // ------------------------------------------------------- codex exec json --
  // `codex exec --json` prints thread/turn/item events. They carry no
  // timestamps unless something (like the Ghost Race runner) adds them.

  function looksLikeCodexExec(lines) {
    return lines.some((l) => l && typeof l.type === 'string' && /^(thread|turn|item)\./.test(l.type));
  }

  function unwrapShell(cmd) {
    if (Array.isArray(cmd)) return commandText(cmd);
    const m = String(cmd || '').match(/^\S*?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/);
    return m ? m[2] : String(cmd || '');
  }

  function parseCodexExec(lines, fileName) {
    const events = [];
    const seen = new Set();
    const crashed = new Set();
    let tokens = 0;
    let t0 = NaN;
    let lastTs = NaN;
    let synthetic = false;
    let failed = false;
    for (const l of lines) {
      if (!l || typeof l.type !== 'string') continue;
      let ts = GR.parseTime(l.timestamp);
      if (!Number.isFinite(ts)) {
        synthetic = true;
        ts = Number.isFinite(lastTs) ? lastTs + 1000 : 0;
      }
      lastTs = ts;
      if (l.type === 'thread.started' || l.type === 'turn.started') {
        if (!Number.isFinite(t0)) t0 = ts;
        continue;
      }
      if (l.type === 'turn.completed') {
        const u = l.usage || {};
        tokens += nonNeg(u.input_tokens) + nonNeg(u.output_tokens);
        continue;
      }
      if (l.type === 'turn.failed' || l.type === 'error') {
        failed = true;
        const msg = (l.error && l.error.message) || l.message || '';
        events.push({ ts, kind: 'crash', name: 'API', cat: 'other', detail: safeText(msg, 80), tokens });
        continue;
      }
      if (!/^item\./.test(l.type) || !l.item) continue;
      const it = l.item;
      const id = String(it.id || Math.random());
      const first = !seen.has(id);
      seen.add(id);
      const done = l.type === 'item.completed';
      const fail = it.status === 'failed' || (Number.isFinite(it.exit_code) && it.exit_code !== 0);
      let tool = null;
      switch (it.type) {
        case 'command_execution':
          if (first) tool = makeTool(0, 'shell', { command: unwrapShell(it.command) }, tokens);
          break;
        case 'file_change': {
          const ch = Array.isArray(it.changes) ? it.changes : [];
          if (first) tool = makeTool(0, 'apply_patch', ch[0] && ch[0].path ? { path: ch[0].path } : null, tokens);
          break;
        }
        case 'mcp_tool_call':
          if (first) {
            tool = makeTool(0, 'mcp__' + (it.server || 'server') + '__' + (it.tool || 'tool'), null, tokens);
            tool.detail = safeText(String(it.server || '') + ' ' + String(it.tool || ''), 60);
          }
          break;
        case 'web_search':
          if (first) tool = makeTool(0, 'web_search', { query: it.query }, tokens);
          break;
        case 'todo_list':
          if (first) tool = makeTool(0, 'update_plan', null, tokens);
          break;
        case 'agent_message':
          if (done && String(it.text || '').trim()) events.push({ ts, kind: 'talk', name: 'reply', cat: 'talk', detail: safeText(it.text, 80), tokens });
          break;
        case 'error':
          if (done) events.push({ ts, kind: 'crash', name: 'API', cat: 'other', detail: safeText(it.message, 80), tokens });
          break;
        default:
          break;
      }
      if (tool) {
        if (!Number.isFinite(t0)) t0 = ts;
        tool.ts = ts;
        events.push(tool);
      }
      if (done && fail && !crashed.has(id) && it.type !== 'agent_message' && it.type !== 'error') {
        crashed.add(id);
        const cat = it.type === 'file_change' ? 'edit' : it.type === 'mcp_tool_call' ? 'mcp' : it.type === 'web_search' ? 'web' : GR.categorizeTool('shell', unwrapShell(it.command));
        events.push({ ts, kind: 'crash', name: it.type === 'command_execution' ? 'shell' : it.type, cat, detail: Number.isFinite(it.exit_code) ? 'exit ' + it.exit_code : '', tokens });
      }
    }
    return finalizeRun({ source: 'codex', sourceLabel: 'Codex', file: fileName, model: null, task: null, t0, synthetic, events, warnings: [], finalTokens: tokens, outcome: failed ? 'dnf' : undefined });
  }

  // --------------------------------------------------------- opentelemetry --
  // OTLP JSON traces. Understands the OpenTelemetry GenAI conventions
  // (gen_ai.*), OpenInference (Arize Phoenix) and Traceloop/OpenLLMetry.
  // Each trace in the file becomes its own ghost.

  function looksLikeOtlp(obj) {
    return !!obj && typeof obj === 'object' && (Array.isArray(obj.resourceSpans) || Array.isArray(obj.resource_spans));
  }

  function otlpValue(v) {
    if (!v || typeof v !== 'object') return v;
    if ('stringValue' in v) return v.stringValue;
    if ('intValue' in v) return Number(v.intValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('boolValue' in v) return !!v.boolValue;
    return undefined;
  }

  function otlpAttrs(list) {
    const out = new Map();
    if (Array.isArray(list)) for (const kv of list) if (kv && typeof kv.key === 'string') out.set(kv.key, otlpValue(kv.value));
    return out;
  }

  function nanosToMs(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n / 1e6 : NaN;
  }

  function parseOtlp(docs, fileName) {
    const traces = new Map();
    for (const doc of docs) {
      for (const rs of doc.resourceSpans || doc.resource_spans || []) {
        const res = otlpAttrs(rs && rs.resource && rs.resource.attributes);
        for (const ss of (rs && (rs.scopeSpans || rs.scope_spans || rs.instrumentationLibrarySpans)) || []) {
          for (const sp of (ss && ss.spans) || []) {
            if (!sp) continue;
            const id = String(sp.traceId || sp.trace_id || 'trace');
            if (!traces.has(id)) traces.set(id, { service: res.get('service.name'), spans: [] });
            traces.get(id).spans.push(sp);
          }
        }
      }
    }
    const runs = [];
    const ordered = [...traces.values()].map((tr) => ({ tr, start: Math.min(...tr.spans.map((sp) => nanosToMs(sp.startTimeUnixNano || sp.start_time_unix_nano)).filter(Number.isFinite)) }))
      .sort((a, b) => a.start - b.start);
    for (const { tr, start } of ordered) {
      if (runs.length >= 6) break;
      const events = [];
      const models = new Map();
      let tokens = 0;
      const spans = tr.spans.slice().sort((a, b) => nanosToMs(a.startTimeUnixNano || a.start_time_unix_nano) - nanosToMs(b.startTimeUnixNano || b.start_time_unix_nano));
      for (const sp of spans) {
        const a = otlpAttrs(sp.attributes);
        const op = String(a.get('gen_ai.operation.name') || '');
        const oi = String(a.get('openinference.span.kind') || '').toUpperCase();
        const tl = String(a.get('traceloop.span.kind') || '').toLowerCase();
        const ts = nanosToMs(sp.startTimeUnixNano || sp.start_time_unix_nano);
        const te = nanosToMs(sp.endTimeUnixNano || sp.end_time_unix_nano) || ts;
        if (!Number.isFinite(ts)) continue;
        const st = sp.status || {};
        const isErr = st.code === 2 || st.code === 'STATUS_CODE_ERROR' || a.has('error.type');
        const name = String(sp.name || '');
        const toolName = a.get('gen_ai.tool.name') || a.get('tool.name') || (op === 'execute_tool' ? name.replace(/^execute_tool\s+/, '') : name);
        const usageIn = a.get('gen_ai.usage.input_tokens') ?? a.get('gen_ai.usage.prompt_tokens') ?? a.get('llm.token_count.prompt');
        const usageOut = a.get('gen_ai.usage.output_tokens') ?? a.get('gen_ai.usage.completion_tokens') ?? a.get('llm.token_count.completion');
        const isTool = op === 'execute_tool' || oi === 'TOOL' || tl === 'tool';
        const isRetriever = oi === 'RETRIEVER';
        const isLlm = ['chat', 'text_completion', 'generate_content', 'completion'].includes(op) || oi === 'LLM' || usageIn != null || usageOut != null;
        if (isTool || isRetriever) {
          const ev = makeTool(0, isRetriever ? 'retriever' : String(toolName), null, tokens);
          ev.ts = ts;
          ev.detail = safeText(isRetriever ? name : toolName, 50);
          events.push(ev);
          if (isErr) events.push({ ts: te, kind: 'crash', name: ev.name, cat: ev.cat, detail: safeText(a.get('error.type') || st.message || '', 80), tokens });
        } else if (isLlm) {
          const total = a.get('llm.token_count.total');
          tokens += usageIn != null || usageOut != null ? nonNeg(usageIn) + nonNeg(usageOut) : nonNeg(total);
          const model = a.get('gen_ai.response.model') || a.get('gen_ai.request.model') || a.get('llm.model_name');
          if (typeof model === 'string') models.set(model, (models.get(model) || 0) + 1);
          events.push({ ts: te, kind: isErr ? 'crash' : 'talk', name: isErr ? 'API' : 'reply', cat: isErr ? 'other' : 'talk', detail: '', tokens });
        }
      }
      if (!events.some((e) => e.kind !== 'crash')) continue;
      const run = finalizeRun({ source: 'otel', sourceLabel: 'OpenTelemetry', file: fileName, model: topKey(models), task: null, t0: start, synthetic: false, events, warnings: [] });
      if (!run.modelLabel && tr.service) run.name = String(tr.service).slice(0, 40);
      runs.push(run);
    }
    if (!runs.length) throw new Error('No LLM or tool spans found in ' + (fileName || 'this trace file') + '.');
    if (traces.size > 6) runs[0].warnings.push('This file has ' + traces.size + ' traces; the first six are on the grid.');
    return runs;
  }

  // -------------------------------------------------- openai agents sdk --
  // Spans exported with span.export() from a tracing processor (see
  // docs/FORMAT.md), one JSON object per line or a JSON array.

  function looksLikeAgentsSdk(items) {
    return Array.isArray(items) && items.some((o) => o && (o.object === 'trace.span' || o.object === 'trace') && ('span_data' in o || 'workflow_name' in o));
  }

  function parseAgentsSdk(items, fileName) {
    const names = new Map();
    const traces = new Map();
    for (const o of items) {
      if (!o || typeof o !== 'object') continue;
      if (o.object === 'trace') names.set(String(o.id), o.workflow_name);
      if (o.object === 'trace.span') {
        const id = String(o.trace_id || 'trace');
        if (!traces.has(id)) traces.set(id, []);
        traces.get(id).push(o);
      }
    }
    const runs = [];
    for (const [id, spans] of traces) {
      if (runs.length >= 6) break;
      spans.sort((a, b) => GR.parseTime(a.started_at) - GR.parseTime(b.started_at));
      const events = [];
      const models = new Map();
      let tokens = 0;
      let agentName = null;
      let t0 = NaN;
      for (const sp of spans) {
        const d = sp.span_data || {};
        const ts = GR.parseTime(sp.started_at);
        const te = GR.parseTime(sp.ended_at) || ts;
        if (!Number.isFinite(ts)) continue;
        if (!Number.isFinite(t0) || ts < t0) t0 = ts;
        const err = sp.error && typeof sp.error === 'object';
        switch (d.type) {
          case 'function': {
            const ev = makeTool(0, String(d.name || 'tool'), null, tokens);
            ev.ts = ts;
            ev.detail = safeText(d.name || '', 50);
            events.push(ev);
            if (err) events.push({ ts: te, kind: 'crash', name: ev.name, cat: ev.cat, detail: safeText(sp.error.message || '', 80), tokens });
            break;
          }
          case 'generation':
          case 'response': {
            const u = d.usage || (d.response && d.response.usage) || {};
            tokens += nonNeg(u.input_tokens ?? u.prompt_tokens) + nonNeg(u.output_tokens ?? u.completion_tokens);
            if (typeof d.model === 'string') models.set(d.model, (models.get(d.model) || 0) + 1);
            events.push({ ts: te, kind: err ? 'crash' : 'talk', name: err ? 'API' : 'reply', cat: err ? 'other' : 'talk', detail: '', tokens });
            break;
          }
          case 'handoff': {
            const ev = makeTool(0, 'handoff', null, tokens);
            ev.ts = ts;
            ev.detail = safeText(d.to_agent || '', 40);
            events.push(ev);
            break;
          }
          case 'guardrail':
            if (d.triggered) events.push({ ts: te, kind: 'crash', name: 'guardrail', cat: 'other', detail: safeText(d.name || '', 40), tokens });
            break;
          case 'agent':
            if (!agentName && d.name) agentName = String(d.name);
            break;
          default:
            break;
        }
      }
      if (!events.some((e) => e.kind !== 'crash')) continue;
      const run = finalizeRun({ source: 'openai-agents', sourceLabel: 'OpenAI Agents', file: fileName, model: topKey(models), task: null, t0, synthetic: false, events, warnings: [] });
      const label = names.get(id) || agentName;
      if (label && !run.modelLabel) run.name = String(label).slice(0, 40);
      runs.push(run);
    }
    if (!runs.length) throw new Error('No agent steps found in ' + (fileName || 'this trace file') + '.');
    return runs;
  }

  // ------------------------------------------------------------ gemini cli --
  // Saved chat sessions (~/.gemini/tmp/<project>/chats/session-*.json) and
  // /chat save checkpoints (checkpoint-*.json, no timestamps).

  function looksLikeGeminiSession(obj) {
    return !!obj && !Array.isArray(obj) && Array.isArray(obj.messages) && obj.messages.some((m) => m && (m.type === 'gemini' || m.type === 'user')) && ('sessionId' in obj || 'projectHash' in obj || 'startTime' in obj);
  }

  function looksLikeGeminiCheckpoint(obj) {
    return Array.isArray(obj) && obj.length > 0 && obj.every((c) => c && typeof c.role === 'string' && Array.isArray(c.parts));
  }

  function geminiText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
    return '';
  }

  function parseGeminiSession(obj, fileName) {
    const events = [];
    const models = new Map();
    let tokens = 0;
    let task = null;
    let t0 = GR.parseTime(obj.startTime);
    let lastTs = NaN;
    let synthetic = false;
    for (const m of obj.messages) {
      if (!m || typeof m !== 'object') continue;
      let ts = GR.parseTime(m.timestamp);
      if (!Number.isFinite(ts)) {
        synthetic = true;
        ts = Number.isFinite(lastTs) ? lastTs + 1000 : 0;
      }
      lastTs = ts;
      if (m.type === 'user') {
        const text = geminiText(m.content);
        if (!isNoisePrompt(text) && task == null) {
          task = text.trim();
          if (!Number.isFinite(t0) || events.length === 0) t0 = ts;
        }
      } else if (m.type === 'gemini') {
        if (typeof m.model === 'string') models.set(m.model, (models.get(m.model) || 0) + 1);
        const tk = m.tokens || {};
        tokens += tk.total != null ? nonNeg(tk.total) : nonNeg(tk.input) + nonNeg(tk.output);
        if (geminiText(m.content).trim()) events.push({ ts, kind: 'talk', name: 'reply', cat: 'talk', detail: safeText(geminiText(m.content), 80), tokens });
        for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
          if (!tc) continue;
          const tts = GR.parseTime(tc.timestamp);
          const ev = makeTool(0, String(tc.name || 'tool'), tc.args || null, tokens);
          ev.ts = Number.isFinite(tts) ? tts : ts;
          events.push(ev);
          if (tc.status === 'error' || tc.status === 'cancelled') events.push({ ts: ev.ts + 1, kind: 'crash', name: ev.name, cat: ev.cat, detail: '', tokens });
        }
      } else if (m.type === 'error') {
        events.push({ ts, kind: 'crash', name: 'API', cat: 'other', detail: safeText(geminiText(m.content), 80), tokens });
      }
    }
    return finalizeRun({ source: 'gemini', sourceLabel: 'Gemini CLI', file: fileName, model: topKey(models), task, t0, synthetic, events, warnings: [] });
  }

  function parseGeminiCheckpoint(arr, fileName) {
    const events = [];
    let task = null;
    let ts = 0;
    for (const c of arr) {
      for (const part of c.parts) {
        if (!part || typeof part !== 'object') continue;
        ts += 1000;
        if (c.role === 'user' && typeof part.text === 'string' && task == null && !isNoisePrompt(part.text)) task = part.text.trim();
        else if (c.role === 'model' && typeof part.text === 'string' && part.text.trim()) events.push({ ts, kind: 'talk', name: 'reply', cat: 'talk', detail: safeText(part.text, 80), tokens: 0 });
        else if (part.functionCall) {
          const ev = makeTool(0, String(part.functionCall.name || 'tool'), part.functionCall.args || null, 0);
          ev.ts = ts;
          events.push(ev);
        } else if (part.functionResponse) {
          const r = part.functionResponse.response || {};
          if (r.error) events.push({ ts, kind: 'crash', name: String(part.functionResponse.name || 'tool'), cat: GR.categorizeTool(part.functionResponse.name), detail: '', tokens: 0 });
        }
      }
    }
    return finalizeRun({ source: 'gemini', sourceLabel: 'Gemini CLI', file: fileName, model: null, task, t0: 0, synthetic: true, events, warnings: [] });
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
      task: r.task ? safeText(r.task, 200) : null,
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
        cost: Number.isFinite(r.cost) && r.cost > 0 ? r.cost : null,
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
      if (whole) {
        if (looksLikeGhostJson(whole)) return parseGhostJson(whole, fileName);
        if (looksLikeOtlp(whole)) return parseOtlp([whole], fileName);
        if (looksLikeGeminiSession(whole)) return [parseGeminiSession(whole, fileName)];
        if (looksLikeGeminiCheckpoint(whole)) return withSyntheticNote([parseGeminiCheckpoint(whole, fileName)]);
        if (looksLikeAgentsSdk(whole)) return parseAgentsSdk(whole, fileName);
        if (whole && Array.isArray(whole.data) && looksLikeAgentsSdk(whole.data)) return parseAgentsSdk(whole.data, fileName);
      }
    }

    const { lines, bad } = parseJsonl(trimmed);
    if (!lines.length) throw new Error("Couldn't read " + (fileName || 'this file') + ' as JSON or JSONL.');

    let runs;
    if (looksLikeClaudeCode(lines)) runs = [parseClaudeCode(lines, fileName)];
    else if (looksLikeCodexExec(lines)) runs = [parseCodexExec(lines, fileName)];
    else if (looksLikeCodex(lines)) runs = [parseCodex(lines, fileName)];
    else if (lines.some(looksLikeOtlp)) runs = parseOtlp(lines.filter(looksLikeOtlp), fileName);
    else if (looksLikeAgentsSdk(lines)) runs = parseAgentsSdk(lines, fileName);
    else {
      throw new Error(
        "Didn't recognise " + (fileName || 'this file') +
          '. Ghost Race reads Claude Code, Codex CLI, Gemini CLI, OpenAI Agents SDK and OpenTelemetry logs, and Ghost Race JSON (.ghost.json).'
      );
    }
    if (bad) runs.forEach((r) => r.warnings.push(bad + ' unreadable line(s) skipped.'));
    return withSyntheticNote(runs);
  };

  function withSyntheticNote(runs) {
    runs.forEach((r) => {
      if (r.timing === 'synthetic') r.warnings.push('No timestamps in this log, so each step counts as 1 second. Race by steps or tokens for a fair result.');
    });
    return runs;
  }

  // Exposed for tests.
  GR._parsers = { parseClaudeCode, parseCodex, parseCodexExec, parseOtlp, parseAgentsSdk, parseGeminiSession, parseGeminiCheckpoint, parseGhostJson, parseJsonl, codexExitCode, toolDetail, unwrapShell };
})(typeof window !== 'undefined' ? window : globalThis);
