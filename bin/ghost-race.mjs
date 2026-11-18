#!/usr/bin/env node
// Ghost Race CLI: race AI coding agents on the same task, or open a race from logs.
//
//   ghost-race race "fix the flaky checkout test" [--agents claude,codex]
//   ghost-race open <log files...>
//   ghost-race --help
//
// No dependencies. Needs Node 20+ and git; `race` also needs the agents' CLIs.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const f of ['core', 'parsers', 'race', 'share']) require(path.join(ROOT, 'src', f + '.js'));
const GR = globalThis.GhostRace;

// ------------------------------------------------------------------ agents --

// How each agent is run headless. {task} is replaced by the task text.
// These are printed before every race, and --<agent>-args adds flags.
const AGENTS = {
  claude: {
    bin: 'claude',
    label: 'Claude Code',
    args: ['-p', '{task}', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash'],
    note: "Claude Code can edit files and run shell commands in its worktree. Its commands aren't sandboxed.",
  },
  codex: {
    bin: 'codex',
    label: 'Codex',
    args: ['exec', '--json', '--full-auto', '{task}'],
    note: 'Codex runs with --full-auto: it edits files and runs commands inside its workspace sandbox.',
  },
};

// ------------------------------------------------------------------- utils --

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const ANSI = ['36', '35', '32', '33', '34', '31'];
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const say = (s = '') => process.stdout.write(s + '\n');
const fail = (msg) => {
  process.stderr.write(paint('31', 'ghost-race: ') + msg + '\n');
  process.exit(1);
};

const VALUE_FLAGS = new Set(['agents', 'repo', 'timeout', 'title', 'mode', 'task', 'claude-args', 'codex-args']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out[key] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(key) && argv[i + 1] != null) out[key] = argv[++i];
      else out[key] = true;
    } else if (a === '-y') out.yes = true;
    else if (a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts });
  if (r.error) fail("git isn't installed or isn't on your PATH.");
  return r;
}

function hasCommand(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return !r.error && r.status !== 127;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function openInBrowser(target) {
  const cmd = process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ----------------------------------------------------------------- results --

function encodeRace(runs, opts) {
  const payload = GR.makeSharePayload(runs, opts);
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
}

// Writes race.html, which redirects to the bundled page with the race in the
// URL hash (some OS "open" commands drop a #fragment from file URLs).
function writeLauncher(dir, encoded) {
  const target = pathToFileURL(path.join(ROOT, 'index.html')).href + GR.SHARE_PREFIX + encoded;
  const file = path.join(dir, 'race.html');
  fs.writeFileSync(
    file,
    `<!DOCTYPE html><meta charset="utf-8"><title>Ghost Race</title>\n<script>location.replace(${JSON.stringify(target)})</script>\n<p><a href="${escapeHtml(target)}">Open the race</a></p>\n`
  );
  return file;
}

function printResults(runs, mode) {
  const race = GR.buildRace(runs, { mode: mode || 'time' });
  const rows = GR.standingsAt(race, race.maxX);
  const winner = rows.find((r) => !r.dnf);
  say();
  say(bold('Results') + dim(`  (ranked by ${GR.MODES[race.mode].unit})`));
  for (const row of rows) {
    const r = row.racer;
    const t = r.run.totals;
    const result = row.dnf ? paint('31', 'DNF') : row === winner ? GR.formatResult(race, r) : GR.formatGap(race, r.xEnd - winner.racer.xEnd);
    say(
      `  ${row.dnf ? '-' : row.place}  ${paint(ANSI[r.index % ANSI.length], r.code)}  ${r.run.name.padEnd(16).slice(0, 16)}  ${String(result).padEnd(10)}` +
        `${String(t.tools).padStart(4)} tool call${t.tools === 1 ? ' ' : 's'}  ${String(t.crashes).padStart(3)} error${t.crashes === 1 ? ' ' : 's'}  ${GR.formatTokens(t.tokens).padStart(6)} tokens` +
        (t.cost ? `  $${t.cost.toFixed(2)}` : '')
    );
  }
  return race;
}

function finishWithLinks(runs, dir, opts) {
  const encoded = encodeRace(runs, { title: opts.title, mode: opts.mode || 'time', skipIdle: true, fromCli: true });
  const publicEncoded = encodeRace(runs, { title: opts.title, mode: opts.mode || 'time', skipIdle: true });
  const launcher = writeLauncher(dir, encoded);
  const publicLink = GR.siteUrl + GR.SHARE_PREFIX + publicEncoded;
  fs.writeFileSync(path.join(dir, 'share-link.txt'), publicLink + '\n');
  say();
  say(bold('Watch the race'));
  say('  ' + launcher);
  say(bold('Share link') + dim(' (names, timings and tool types only; no commands, files or prompts)'));
  say('  ' + (publicLink.length > 300 ? publicLink.slice(0, 120) + '…  ' + dim('(full link in ' + path.join(dir, 'share-link.txt') + ')') : publicLink));
  if (!opts['no-open']) {
    if (openInBrowser(launcher)) say(dim('  Opening it in your browser…'));
  }
}

// -------------------------------------------------------------------- open --

async function cmdOpen(args) {
  const files = args._.slice(1);
  if (!files.length) fail('Give one or more log files, for example: ghost-race open session-a.jsonl session-b.jsonl');
  const runs = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      fail(`Can't read ${f}: ${e.message}`);
    }
    try {
      for (const run of GR.parseLog(text, path.basename(f))) runs.push(run);
    } catch (e) {
      fail(e.message);
    }
  }
  if (runs.length > 6) runs.length = 6;
  const seen = new Map();
  for (const r of runs) {
    const n = (seen.get(r.name) || 0) + 1;
    seen.set(r.name, n);
    if (n > 1) r.name += ' #' + n;
  }
  printResults(runs, args.mode);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-race-'));
  finishWithLinks(runs, dir, { title: args.title || '', mode: args.mode, 'no-open': args['no-open'] });
}

// -------------------------------------------------------------------- race --

function feedFor(kind, obj) {
  const out = [];
  if (kind === 'claude') {
    const content = obj && obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
    if (obj.type === 'assistant') {
      for (const b of content) {
        if (b && b.type === 'tool_use') out.push({ cat: GR.categorizeTool(b.name, b.input && b.input.command), detail: GR._parsers.toolDetail(b.name, b.input) });
      }
    } else if (obj.type === 'user') {
      for (const b of content) if (b && b.type === 'tool_result' && b.is_error) out.push({ crash: true });
    }
  } else if (kind === 'codex' && obj && obj.item) {
    const it = obj.item;
    if (obj.type === 'item.started' && it.type === 'command_execution') {
      const cmd = GR._parsers.unwrapShell(it.command);
      out.push({ cat: GR.categorizeTool('shell', cmd), detail: GR.truncate(GR.redact(cmd), 60) });
    } else if (obj.type === 'item.completed' && it.type === 'file_change') {
      const p = Array.isArray(it.changes) && it.changes[0] ? it.changes[0].path : '';
      out.push({ cat: 'edit', detail: GR.basename(p) });
    } else if (obj.type === 'item.started' && it.type === 'mcp_tool_call') out.push({ cat: 'mcp', detail: `${it.server || ''} ${it.tool || ''}` });
    else if (obj.type === 'item.started' && it.type === 'web_search') out.push({ cat: 'web', detail: GR.truncate(GR.redact(it.query || ''), 60) });
    if (obj.type === 'item.completed' && (it.status === 'failed' || (Number.isFinite(it.exit_code) && it.exit_code !== 0))) out.push({ crash: true });
  }
  return out;
}

async function cmdRace(args) {
  const task = args._.slice(1).join(' ').trim() || (typeof args.task === 'string' ? args.task : '');
  if (!task) fail('Say what the agents should do, for example: ghost-race race "fix the flaky checkout test"');

  const keys = String(args.agents || 'claude,codex').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (keys.length < 1 || keys.length > 6) fail('Race between one and six agents.');
  for (const k of keys) if (!AGENTS[k]) fail(`Unknown agent "${k}". Built-in agents: ${Object.keys(AGENTS).join(', ')}.`);

  const repoArg = path.resolve(typeof args.repo === 'string' ? args.repo : process.cwd());
  const top = git(repoArg, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) fail(`${repoArg} isn't inside a git repository. Each agent gets its own git worktree, so run this from a repo.`);
  const repo = top.stdout.trim();
  const head = git(repo, ['rev-parse', '--short', 'HEAD']);
  if (head.status !== 0) fail('This repository has no commits yet. Commit something first so the agents have a starting point.');
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const dirty = git(repo, ['status', '--porcelain']).stdout.trim();

  const missing = [...new Set(keys)].filter((k) => !hasCommand(AGENTS[k].bin));
  if (missing.length) fail(`Can't find ${missing.map((k) => AGENTS[k].bin).join(' and ')} on your PATH. Install and sign in first.`);

  const minutes = Math.max(1, Number(args.timeout) || 30);
  const runDir = path.join(os.tmpdir(), 'ghost-race', `${path.basename(repo)}-${stamp()}`);
  const racers = keys.map((k, i) => {
    const def = AGENTS[k];
    const n = keys.slice(0, i).filter((x) => x === k).length;
    const id = n ? `${k}-${n + 1}` : k;
    const extra = typeof args[`${k}-args`] === 'string' ? args[`${k}-args`].split(/\s+/).filter(Boolean) : [];
    return { id, kind: k, def, color: ANSI[i % ANSI.length], wt: path.join(runDir, id), args: def.args.map((a) => (a === '{task}' ? task : a)).concat(extra) };
  });

  say(bold('Ghost Race'));
  say(`  Task    ${JSON.stringify(task)}`);
  say(`  Repo    ${repo} @ ${head.stdout.trim()}${branch && branch !== 'HEAD' ? ` (${branch})` : ''}`);
  for (const r of racers) say(`  ${paint(r.color, r.id.padEnd(7))} ${r.def.bin} ${r.args.map((a) => (a === task ? '"<task>"' : a)).join(' ')}`);
  say(`  Each agent works in its own git worktree in ${runDir}`);
  for (const k of new Set(keys)) say(dim('  ' + AGENTS[k].note));
  say(dim(`  Time limit: ${minutes} minutes per agent. Press Ctrl+C to stop the race early.`));
  if (dirty) say(paint('33', "  Note: you have uncommitted changes. Agents start from the last commit and won't see them."));

  if (!args.yes) {
    if (!process.stdin.isTTY) fail('Add --yes to start without a prompt.');
    const answer = (await ask('Start the race? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      say('Race cancelled.');
      return;
    }
  }

  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  for (const r of racers) {
    const add = git(repo, ['worktree', 'add', '--detach', r.wt, 'HEAD']);
    if (add.status !== 0) fail(`Couldn't create a worktree for ${r.id}: ${add.stderr.trim()}`);
  }

  say();
  say(bold('Lights out') + dim('  (live feed: time, agent, pit stop)'));
  const start = Date.now();
  let stopping = false;

  const runAgent = (r) =>
    new Promise((resolve) => {
      const logPath = path.join(runDir, 'logs', `${r.id}.jsonl`);
      const log = fs.createWriteStream(logPath);
      const errLog = fs.createWriteStream(path.join(runDir, 'logs', `${r.id}.stderr.log`));
      // npm installs agent CLIs as .cmd shims on Windows, which need a shell and quoted args
      const win = process.platform === 'win32';
      const argv = win ? r.args.map((a) => '"' + String(a).replace(/"/g, '\\"') + '"') : r.args;
      const child = spawn(r.def.bin, argv, { cwd: r.wt, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: win });
      r.child = child;
      r.logPath = logPath;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, minutes * 60000);
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (e) {
          return;
        }
        if (!obj || typeof obj !== 'object') return;
        if (!obj.timestamp) obj.timestamp = new Date().toISOString();
        log.write(JSON.stringify(obj) + '\n');
        for (const f of feedFor(r.kind, obj)) {
          const t = dim(clock(Date.now() - start).padStart(5));
          const who = paint(r.color, r.id.padEnd(8));
          say(f.crash ? `  ${t}  ${who}${paint('31', 'CRASH')}` : `  ${t}  ${who}${GR.categoryLabel(f.cat).padEnd(10)}${dim(f.detail || '')}`);
        }
      });
      child.stderr.pipe(errLog);
      child.on('error', (e) => errLog.write(String(e) + '\n'));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        r.code = code;
        r.signal = signal;
        r.timedOut = timedOut;
        r.ms = Date.now() - start;
        log.end();
        errLog.end();
        const how = timedOut ? paint('31', 'ran out of time') : code === 0 ? paint('32', 'finished') : stopping ? paint('33', 'stopped') : paint('31', `exited with code ${code}`);
        say(`  ${dim(clock(r.ms).padStart(5))}  ${paint(r.color, r.id.padEnd(8))}${how}`);
        resolve();
      });
    });

  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    say(paint('33', '\n  Stopping the agents. Press Ctrl+C again to quit without results.'));
    for (const r of racers) if (r.child && r.child.exitCode == null) r.child.kill('SIGTERM');
  };
  process.on('SIGINT', onSigint);
  if (args.sequential) for (const r of racers) await runAgent(r);
  else await Promise.all(racers.map(runAgent));
  process.off('SIGINT', onSigint);

  // Parse what each agent did.
  const runs = [];
  const racerOf = new Map();
  for (const r of racers) {
    let run;
    try {
      [run] = GR.parseLog(fs.readFileSync(r.logPath, 'utf8'), path.basename(r.logPath));
    } catch (e) {
      say(paint('31', `  ${r.id}: no moves recorded (${e.message}). See ${path.join(runDir, 'logs', r.id + '.stderr.log')}`));
      continue;
    }
    run.name = run.modelLabel || r.def.label;
    if (r.timedOut || r.code !== 0) run.outcome = 'dnf';
    run.color = null;
    runs.push(run);
    racerOf.set(run, r);
  }
  const seen = new Map();
  for (const run of runs) {
    const n = (seen.get(run.name) || 0) + 1;
    seen.set(run.name, n);
    if (n > 1) run.name += ' #' + n;
  }
  if (!runs.length) fail(`No agent made a move. Logs are in ${path.join(runDir, 'logs')}`);

  const race = printResults(runs, args.mode);
  const winRow = GR.standingsAt(race, race.maxX).find((row) => !row.dnf);
  const winner = winRow ? racerOf.get(winRow.run) : null;

  say();
  say(bold('What each agent changed'));
  for (const r of racers) {
    git(r.wt, ['add', '-A']); // stage inside the agent's own worktree so new files count too
    const stat = git(r.wt, ['diff', '--cached', '--stat', 'HEAD']).stdout.trim().split('\n').pop();
    say(`  ${paint(r.color, r.id.padEnd(8))}${(stat || '').trim() || 'no changes'}`);
    say(dim(`          ${r.wt}`));
  }
  if (args.cleanup) {
    for (const r of racers) git(repo, ['worktree', 'remove', '--force', r.wt]);
    say(dim('  Worktrees removed.'));
  } else {
    if (winner) say(dim(`  Save the winner's changes:  git -C ${winner.wt} diff --cached HEAD > winner.patch`));
    say(dim(`  Remove a worktree:          git -C ${repo} worktree remove --force <path>`));
  }

  finishWithLinks(runs, runDir, { title: typeof args.title === 'string' ? args.title : task.slice(0, 80), mode: args.mode, 'no-open': args['no-open'] });
  say(dim(`  Logs: ${path.join(runDir, 'logs')}`));
}

// -------------------------------------------------------------------- help --

const HELP = `${bold('Ghost Race')}: race your AI agents.

${bold('Usage')}
  ghost-race race "<task>" [options]     Run agents on the same task and race them
  ghost-race open <log files...>          Open a race from existing session logs

${bold('Race options')}
  --agents claude,codex   Agents to race (built in: ${Object.keys(AGENTS).join(', ')}; repeat one to race it against itself)
  --repo <path>           Git repo to work in (default: current folder)
  --timeout <minutes>     Time limit per agent (default 30)
  --claude-args "<flags>" Extra flags for Claude Code, e.g. --claude-args "--model opus"; same for --codex-args
  --title "<text>"        Title shown on the race and in share links (default: the task)
  --mode time|tokens|steps  How to rank the race (default time)
  --sequential            Run agents one after another instead of at once
  --cleanup               Remove the worktrees afterwards (default: keep them so you can inspect the changes)
  --yes, -y               Don't ask before starting
  --no-open               Don't open the browser

Each agent works in its own git worktree, so they can't touch each other's
files or your working copy. The race opens in your browser; nothing is uploaded.`;

// -------------------------------------------------------------------- main --

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (args.help || !cmd || cmd === 'help') say(HELP);
else if (cmd === 'race') await cmdRace(args);
else if (cmd === 'open') await cmdOpen(args);
else fail(`Unknown command "${cmd}". Try: ghost-race race "<task>"  or  ghost-race open <files>`);
