/*!
 * Ghost Race — race your AI agents.
 * core.js: shared namespace, palette, tool categories and small helpers.
 * MIT License.
 */
(function (root) {
  'use strict';

  const GR = (root.GhostRace = root.GhostRace || {});

  GR.version = '0.1.0';
  GR.repoUrl = 'github.com/abtx2323/ghost-race';

  // Neon ghost colors. Chosen to stay distinct on a near-black track.
  GR.PALETTE = ['#5CF2FF', '#FF5FD2', '#B8FF4D', '#FFC24B', '#A08BFF', '#FF7A55'];

  // Tool categories become the "pit stop" labels on the track.
  // Matching is case-insensitive on the tool name; shell commands are
  // re-categorised from the command text (see categorizeCommand).
  const CATEGORIES = {
    read: { label: 'READ', color: '#8FD3FF' },
    search: { label: 'SEARCH', color: '#C7A6FF' },
    edit: { label: 'EDIT', color: '#B8FF4D' },
    shell: { label: 'SHELL', color: '#FFC24B' },
    test: { label: 'TEST', color: '#FFE45C' },
    web: { label: 'WEB', color: '#5CF2FF' },
    agent: { label: 'SUB-AGENT', color: '#FF8AE2' },
    plan: { label: 'PLAN', color: '#9FB4C8' },
    mcp: { label: 'MCP', color: '#7EF0C1' },
    ask: { label: 'ASK HUMAN', color: '#FFFFFF' },
    other: { label: 'TOOL', color: '#D8DEE9' },
  };
  GR.CATEGORIES = CATEGORIES;

  const NAME_RULES = [
    ['agent', /^(task|agent|spawn_?agent|subagent|delegate)$/],
    ['test', /^(run_?tests?|tests?|pytest|jest|vitest)$/],
    ['plan', /^(todowrite|todo_write|update_plan|exitplanmode|enterplanmode|plan)$/],
    ['ask', /^(askuserquestion|request_user_input|ask_user|ask_human)$/],
    ['edit', /^(edit|multiedit|write|notebookedit|apply_patch|write_file|edit_file|str_replace\w*|create_file|insert)$/],
    ['read', /^(read|view|cat|notebookread|read_file|ls|list_dir|list_files|open_file)$/],
    ['search', /^(grep|glob|search|rg|find|search_files|codebase_search|file_search|grep_search)$/],
    ['web', /^(webfetch|websearch|web_search|web_fetch|fetch|browser\w*|web_search_call)$/],
    ['shell', /^(bash|bashoutput|killshell|killbash|shell|exec_command|local_shell_call|run_command|terminal|run_terminal_cmd|write_stdin|container\.exec|powershell)$/],
  ];

  GR.categorizeTool = function categorizeTool(name, command) {
    const n = String(name || '').toLowerCase();
    if (n.startsWith('mcp__') || n.startsWith('mcp_')) return 'mcp';
    let cat = 'other';
    for (const [c, re] of NAME_RULES) {
      if (re.test(n)) {
        cat = c;
        break;
      }
    }
    if ((cat === 'shell' || cat === 'other') && command) return GR.categorizeCommand(command);
    if (cat === 'other' && n.includes('__')) return 'mcp';
    return cat;
  };

  // Shell commands get a more useful label: running tests is the most
  // dramatic pit stop in any coding race.
  GR.categorizeCommand = function categorizeCommand(command) {
    const c = String(command || '').toLowerCase();
    if (/\b(pytest|jest|vitest|mocha|rspec|phpunit|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|bun test|deno test|make test|unittest|tox|ctest|dotnet test|mvn test|gradle test)\b/.test(c)) return 'test';
    if (/^\s*(apply_patch|patch)\b/.test(c) || c.includes('*** begin patch')) return 'edit';
    if (/^\s*(rg|grep|ag|ack|fd|find)\b/.test(c)) return 'search';
    if (/^\s*(cat|head|tail|less|sed -n|nl|ls|tree|wc|bat)\b/.test(c)) return 'read';
    if (/^\s*(curl|wget)\b/.test(c)) return 'web';
    return 'shell';
  };

  // Logs are untrusted input: only accept keys the map really owns, so values
  // like "__proto__" or "constructor" can't reach Object.prototype.
  GR.own = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
  GR.isCategory = (cat) => GR.own(CATEGORIES, cat);
  GR.categoryLabel = (cat) => (GR.isCategory(cat) ? CATEGORIES[cat] : CATEGORIES.other).label;
  GR.categoryColor = (cat) => (GR.isCategory(cat) ? CATEGORIES[cat] : CATEGORIES.other).color;

  // Scrub secrets and home-folder usernames out of any text that could be
  // shown on the track or in an exported clip. Input is capped first so a
  // huge command can't make the patterns slow.
  const REDACTED = '[redacted]';
  const SECRET_PATTERNS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
    [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
    [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
    [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
    [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
    [/\b(bearer|basic)\s+[^\s"']+/gi, '$1 ' + REDACTED],
    [/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|pwd|api_?key|apikey|access_?key|private_?key|credentials?)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)[^\s"'&,;]+/gi, '$1$2$3' + REDACTED],
    [/(--?(?:token|password|passwd|api-key|apikey|secret|auth)[\s=]+)[^\s"']+/gi, '$1' + REDACTED],
    [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, '$1' + REDACTED + '@'],
    [/\/(?:Users|home)\/[^\/\s"']+/g, '~'],
    [/\b[A-Za-z]:\\Users\\[^\\\s"']+/gi, '~'],
  ];
  GR.redact = function redact(text) {
    let s = String(text == null ? '' : text).slice(0, 400);
    for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
    return s;
  };

  // "claude-opus-4-5-20251101" -> "Opus 4.5", "gpt-5.1-codex-max" -> "GPT-5.1 Codex Max"
  GR.prettyModel = function prettyModel(model) {
    if (!model) return null;
    const m = String(model).toLowerCase().trim();
    let r = m.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?=-|$))?/);
    if (r) return cap(r[1]) + ' ' + r[2] + (r[3] ? '.' + r[3] : '');
    r = m.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/);
    if (r) return cap(r[3]) + ' ' + r[1] + (r[2] ? '.' + r[2] : '');
    if (m.startsWith('gpt-')) {
      const parts = m.split('-');
      const rest = parts.slice(2).filter((p) => !/^\d{4,}$/.test(p));
      return 'GPT-' + parts[1] + (rest.length ? ' ' + rest.map(cap).join(' ') : '');
    }
    if (m.startsWith('gemini-')) return 'Gemini ' + m.slice(7).replace(/-/g, ' ');
    return String(model);
  };

  function cap(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }

  GR.basename = function basename(p) {
    const s = String(p || '');
    const parts = s.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
  };

  GR.truncate = function truncate(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
  };

  GR.parseTime = function parseTime(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v > 1e11 ? v : v * 1000; // ms or s epoch
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  };

  GR.formatDuration = function formatDuration(sec) {
    if (!Number.isFinite(sec)) return '–';
    sec = Math.max(0, sec);
    if (sec < 60) return sec.toFixed(sec < 10 ? 1 : 0) + 's';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    if (m < 60) return m + ':' + String(s).padStart(2, '0');
    const h = Math.floor(m / 60);
    return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };

  GR.formatTokens = function formatTokens(n) {
    if (!Number.isFinite(n)) return '–';
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(n));
  };

  GR.ordinal = function ordinal(n) {
    const s = ['TH', 'ST', 'ND', 'RD'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  GR.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  GR.lerp = (a, b, t) => a + (b - a) * t;

  // Small deterministic PRNG so crash sparks look the same on every replay.
  GR.rng = function rng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) % 100000) / 100000;
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
