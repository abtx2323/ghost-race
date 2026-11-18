// End-to-end test of the CLI with stand-in agents. Run with: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'ghost-race.mjs');

function fakeAgent(dir, name, lines, edit) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fake'); process.exit(0); }
const lines = ${JSON.stringify(lines)};
for (const l of lines) console.log(JSON.stringify(l));
require('fs').writeFileSync(${JSON.stringify(edit)}, 'changed by ${name}\\n');
`
  );
  fs.chmodSync(file, 0o755);
}

test('race: runs agents in separate worktrees and reports a winner', { skip: process.platform === 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cli-'));
  const bin = path.join(tmp, 'bin');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(bin);
  fs.mkdirSync(repo);
  fakeAgent(bin, 'claude', [
    { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-4-5' },
    { type: 'assistant', session_id: 's', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'app.js' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
    { type: 'assistant', session_id: 's', message: { id: 'm2', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, output_tokens: 5 } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
  ], 'app.js');
  fakeAgent(bin, 'codex', [
    { type: 'thread.started', thread_id: 'x' },
    { type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'new.js', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } },
  ], 'new.js');
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'app.js'), 'bug\n');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

  const r = spawnSync(process.execPath, [CLI, 'race', 'fix it', '--yes', '--no-open', '--cleanup'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, NO_COLOR: '1' },
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Results/);
  assert.match(r.stdout, /Sonnet 4\.5/);
  assert.match(r.stdout, /Codex/);
  assert.match(r.stdout, /1 file changed/);
  assert.match(r.stdout, /#race=[A-Za-z0-9_-]+/);
  // the user's own checkout is untouched
  assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'bug\n');
  assert.ok(!fs.existsSync(path.join(repo, 'new.js')));
  // --cleanup removed the worktrees
  assert.equal(g('worktree', 'list').stdout.trim().split('\n').length, 1);
});

test('race: refuses to run outside a git repository', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cli-'));
  const r = spawnSync(process.execPath, [CLI, 'race', 'fix it', '--yes', '--no-open'], { cwd: tmp, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /isn't inside a git repository/);
});

test('open: builds a race page from existing logs', () => {
  const ex = (f) => path.join(__dirname, '..', 'examples', f);
  const r = spawnSync(process.execPath, [CLI, 'open', ex('claude-code-sample.jsonl'), ex('codex-sample.jsonl'), '--no-open'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const launcher = r.stdout.match(/(\S+race\.html)/)[1];
  const html = fs.readFileSync(launcher, 'utf8');
  assert.match(html, /index\.html#race=/);
});
