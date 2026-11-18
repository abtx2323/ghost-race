// Run with: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../src/core.js');
require('../src/parsers.js');
require('../src/demo.js');
require('../src/race.js');
const GR = globalThis.GhostRace;

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'examples', f), 'utf8');

test('Claude Code: steps, pit stops, crashes and deduplicated tokens', () => {
  const [run] = GR.parseLog(read('claude-code-sample.jsonl'), 'claude-code-sample.jsonl');
  assert.equal(run.source, 'claude-code');
  assert.equal(run.modelLabel, 'Sonnet 4.5');
  assert.equal(run.task, 'The checkout test is flaky. Please fix it.');
  assert.equal(run.timing, 'real');
  assert.equal(run.totals.tools, 6);
  assert.equal(run.totals.talks, 2);
  assert.equal(run.totals.crashes, 1);
  // 7 assistant messages, usage counted once each
  const expected = [
    3 + 12000 + 2400 + 90,
    5 + 14500 + 800 + 60,
    4 + 15400 + 1100 + 340,
    4 + 16600 + 500 + 70,
    4 + 17200 + 900 + 280,
    4 + 18200 + 400 + 60,
    4 + 18700 + 300 + 120,
  ].reduce((a, b) => a + b, 0);
  assert.equal(run.totals.tokens, expected);
  // starts at the real prompt (t=1s), ends at the final reply (t=74s), ignores the later "thanks!"
  assert.equal(run.totals.duration, 73);
  const crash = run.events.find((e) => e.kind === 'crash');
  assert.equal(crash.name, 'Bash');
  assert.equal(crash.cat, 'test', 'crash inherits the category of the tool call that failed');
  assert.equal(crash.t, 37);
  const cats = run.events.filter((e) => e.kind === 'tool').map((e) => e.cat);
  assert.deepEqual(cats, ['read', 'search', 'edit', 'test', 'edit', 'test']);
  assert.equal(run.events.find((e) => e.cat === 'read').detail, 'checkout.test.ts');
});

test('Codex CLI: shell commands are categorised, exit codes become crashes once', () => {
  const [run] = GR.parseLog(read('codex-sample.jsonl'), 'codex-sample.jsonl');
  assert.equal(run.source, 'codex');
  assert.equal(run.modelLabel, 'GPT-5.1 Codex');
  assert.equal(run.task, 'The checkout test is flaky. Please fix it.');
  assert.equal(run.totals.tools, 6);
  assert.equal(run.totals.crashes, 1, 'function_call_output + exec_command_end must not double count');
  assert.equal(run.totals.tokens, 64700);
  const cats = run.events.filter((e) => e.kind === 'tool').map((e) => e.cat);
  assert.deepEqual(cats, ['search', 'read', 'edit', 'test', 'edit', 'test']);
  assert.equal(run.events.find((e) => e.name === 'apply_patch').detail, 'payment-mock.ts');
  // tokens never go backwards
  let last = 0;
  for (const e of run.events) {
    assert.ok(e.tokens >= last);
    last = e.tokens;
  }
});

test('Codex exit code detection handles text and JSON outputs', () => {
  const { codexExitCode } = GR._parsers;
  assert.equal(codexExitCode('{"output":"x","metadata":{"exit_code":2}}'), 2);
  assert.equal(codexExitCode('Chunk ID: 1\nProcess exited with code 1\nOutput:'), 1);
  assert.equal(codexExitCode('Exit code: 0\nWall time: 1s'), 0);
  assert.equal(codexExitCode('all good'), null);
});

test('Ghost JSON: deltas, errors, finish and outcome', () => {
  const runs = GR.parseLog(
    JSON.stringify({
      runs: [
        {
          name: 'A',
          events: [
            { t: 0, type: 'message', tokens: 100 },
            { t: 2, type: 'tool', name: 'search_docs', tokens: 300 },
            { t: 3, type: 'tool', name: 'run_tests', command: 'pytest -q', tokens: 50, error: true },
            { t: 9, type: 'finish' },
          ],
        },
        { name: 'B', outcome: 'dnf', events: [{ t: '2026-01-01T00:00:05Z', type: 'tool', name: 'Read' }, { t: '2026-01-01T00:00:08Z', type: 'error', name: 'Bash' }, { t: '2026-01-01T00:00:10Z', type: 'message' }] },
      ],
    }),
    'x.ghost.json'
  );
  assert.equal(runs.length, 2);
  const [a, b] = runs;
  assert.equal(a.totals.tokens, 450);
  assert.equal(a.totals.crashes, 1);
  assert.equal(a.totals.duration, 9);
  assert.equal(a.events.find((e) => e.name === 'run_tests').cat, 'test');
  assert.equal(b.outcome, 'dnf');
  assert.equal(b.totals.duration, 5);
});

test('Unknown files give a friendly error', () => {
  assert.throws(() => GR.parseLog('{"hello":"world"}\n{"x":1}', 'notes.jsonl'), /Didn't recognise notes\.jsonl/);
  assert.throws(() => GR.parseLog('   ', 'empty.jsonl'), /empty/);
});

test('Model names are prettified', () => {
  assert.equal(GR.prettyModel('claude-opus-4-5-20251101'), 'Opus 4.5');
  assert.equal(GR.prettyModel('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(GR.prettyModel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(GR.prettyModel('gpt-5.1-codex-max'), 'GPT-5.1 Codex Max');
  assert.equal(GR.prettyModel('gpt-4o'), 'GPT-4o');
});

test('Demo race: The Planner overtakes Speed Demon late and wins every mode', () => {
  const runs = GR.demoRuns();
  for (const mode of ['time', 'tokens', 'steps']) {
    const race = GR.buildRace(runs, { mode });
    const final = GR.standingsAt(race, race.maxX);
    assert.equal(final[0].run.name, 'The Planner', mode);
  }
  const race = GR.buildRace(runs, { mode: 'time' });
  const early = GR.standingsAt(race, race.maxX * 0.3);
  assert.equal(early[0].run.name, 'Speed Demon');
  assert.ok(race.fork, 'demo has a fork');
  assert.equal(race.fork.move, 1);
});

test('Race: idle gaps are capped and progress is monotonic', () => {
  const runs = GR.parseLog(
    JSON.stringify({ events: [{ t: 0, type: 'tool', name: 'Read' }, { t: 600, type: 'tool', name: 'Edit' }, { t: 610, type: 'message' }] }),
    'idle.ghost.json'
  );
  const race = GR.buildRace(runs, { mode: 'time', skipIdle: true, idleCap: 30 });
  assert.equal(race.racers[0].xEnd, 40);
  const raw = GR.buildRace(runs, { mode: 'time', skipIdle: false });
  assert.equal(raw.racers[0].xEnd, 610);
  let prev = -1;
  for (let x = 0; x <= 40; x += 0.5) {
    const p = GR.progressAt(race.racers[0], x);
    assert.ok(p >= prev);
    prev = p;
  }
  assert.equal(GR.progressAt(race.racers[0], 40), 1);
});

test('examples/demo-race.ghost.json loads three ghosts', () => {
  const runs = GR.parseLog(read('demo-race.ghost.json'), 'demo-race.ghost.json');
  assert.deepEqual(runs.map((r) => r.name), ['The Planner', 'Speed Demon', 'Loop Goblin']);
});

test('Secrets and home-folder usernames are scrubbed from anything shown on the track', () => {
  const cases = [
    ['curl -H "Authorization: Bearer sk-ant-api03-AbCdEf1234567890xyz" https://api.example.com', ['sk-ant', 'AbCdEf1234567890xyz']],
    ['export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 && gh pr list', ['ghp_abcdef']],
    ['OPENAI_API_KEY=sk-proj-0123456789abcdefABCDEF python run.py', ['sk-proj', '0123456789abcdef']],
    ['psql postgres://admin:hunter2@db.internal/app', ['hunter2']],
    ['cat /Users/alexsmith/project/.env', ['alexsmith']],
    ['mysql --password=correcthorse -u root', ['correcthorse']],
    ['echo {"api_key": "live_12345abcde"}', ['live_12345abcde']],
    ['aws s3 ls --profile x AKIAIOSFODNN7EXAMPLE', ['AKIAIOSFODNN7EXAMPLE']],
    ['curl -H "x-jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"', ['eyJhbGciOiJIUzI1NiJ9']],
  ];
  for (const [cmd, secrets] of cases) {
    const [run] = GR.parseLog(JSON.stringify({ events: [{ t: 0, type: 'tool', name: 'Bash', command: cmd }, { t: 1, type: 'message' }] }), 's.ghost.json');
    const shown = run.events[0].detail;
    for (const secret of secrets) assert.ok(!shown.includes(secret), `"${secret}" leaked in: ${shown}`);
  }
  // ordinary commands are left alone
  assert.equal(GR.redact('npm test -- checkout'), 'npm test -- checkout');
  assert.equal(GR.redact('rg -n token src'), 'rg -n token src');
});

test('Claude Code tool results and prompts are redacted too', () => {
  const lines = [
    { type: 'user', uuid: 'a', sessionId: 's', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'deploy with key sk-live-abcdefghijklmnop1234' } },
    { type: 'assistant', uuid: 'b', sessionId: 's', timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -u bob:s3cretpass https://x' } }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'user', uuid: 'c', sessionId: 's', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Error: password=hunter2 rejected' }] } },
    { type: 'assistant', uuid: 'd', sessionId: 's', timestamp: '2026-01-01T00:00:03Z', message: { id: 'm2', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  const [run] = GR.parseLog(lines.map((l) => JSON.stringify(l)).join('\n'), 'x.jsonl');
  const all = JSON.stringify(run);
  assert.ok(!all.includes('sk-live-abcdefghijklmnop1234'));
  assert.ok(!all.includes('hunter2'));
});

test('Hostile .ghost.json values are ignored instead of breaking the race', () => {
  const runs = GR.parseLog(
    '{"runs":[{"name":{"x":1},"events":[' +
      '{"t":0,"type":"tool","name":"x","category":"__proto__","tokens":-500},' +
      '{"t":1,"type":"constructor","tokens":"lots"},' +
      '{"t":2,"type":"error","name":"x","category":"toString"},' +
      '{"t":3,"type":"message","tokens":1e400}]}]}',
    'evil.ghost.json'
  );
  const [run] = runs;
  assert.equal(typeof run.name, 'string');
  for (const e of run.events) {
    assert.equal(typeof e.kind, 'string');
    assert.ok(e.cat === 'talk' || GR.isCategory(e.cat), 'bad category ' + e.cat);
    assert.ok(Number.isFinite(e.tokens) && e.tokens >= 0);
  }
  assert.equal(GR.categoryColor('__proto__'), GR.CATEGORIES.other.color);
  const race = GR.buildRace(runs, { mode: 'time' });
  assert.ok(Number.isFinite(race.maxX));
});

test('Oversized ghost files are refused with a clear message', () => {
  const events = Array.from({ length: 200001 }, (_, i) => ({ t: i, type: 'tool' }));
  assert.throws(() => GR.parseLog(JSON.stringify({ events }), 'huge.ghost.json'), /more than 200,000 events/);
});

test('Share links round-trip a race without commands, files or prompts', async () => {
  require('../src/share.js');
  const [cc] = GR.parseLog(read('claude-code-sample.jsonl'), 'claude-code-sample.jsonl');
  const [cx] = GR.parseLog(read('codex-sample.jsonl'), 'codex-sample.jsonl');
  cc.name = 'Claude Code run';
  cx.outcome = 'dnf';
  const payload = GR.makeSharePayload([cc, cx], { title: 'Flaky test', mode: 'tokens', skipIdle: true });
  const encoded = await GR.encodeShare(payload);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  const back = GR.runsFromShare(await GR.decodeShare('#race=' + encoded));
  assert.equal(back.title, 'Flaky test');
  assert.equal(back.mode, 'tokens');
  const [a, b] = back.runs;
  assert.equal(a.name, 'Claude Code run');
  assert.equal(a.modelLabel, 'Sonnet 4.5');
  assert.equal(b.outcome, 'dnf');
  assert.equal(a.totals.tools, cc.totals.tools);
  assert.equal(a.totals.crashes, cc.totals.crashes);
  assert.equal(a.totals.tokens, cc.totals.tokens);
  assert.ok(Math.abs(a.totals.duration - cc.totals.duration) < 0.2);
  assert.deepEqual(a.events.filter((e) => e.kind === 'tool').map((e) => e.cat), cc.events.filter((e) => e.kind === 'tool').map((e) => e.cat));
  // nothing private travels in the link
  const json = JSON.stringify(payload);
  for (const secret of ['checkout.test.ts', 'npm test', 'The checkout test is flaky', 'payment-mock']) assert.ok(!json.includes(secret), secret);
});

test('Broken or hostile share links fail with a clear message', async () => {
  require('../src/share.js');
  await assert.rejects(GR.decodeShare('#race=not!base64'), /broken or incomplete/);
  await assert.rejects(GR.decodeShare('#race=' + 'A'.repeat(500000)), /too long/);
  // a valid link to a payload that isn't a race
  const enc = await GR.encodeShare({ hello: 'world' });
  await assert.rejects(GR.decodeShare(enc), /isn't a Ghost Race link/);
  // a zip bomb: 20 MB of zeros compresses tiny but must be refused
  const big = { v: 1, r: [{ n: 'x', e: new Array(5000000).fill(0) }] };
  const bomb = await GR.encodeShare(big);
  await assert.rejects(GR.decodeShare(bomb), /broken or incomplete/);
});

test('claude -p stream-json: timestamps, cost and model', () => {
  const [run] = GR.parseLog(read('claude-stream-sample.jsonl'), 'claude-stream-sample.jsonl');
  assert.equal(run.source, 'claude-code');
  assert.equal(run.modelLabel, 'Sonnet 4.5');
  assert.equal(run.totals.tools, 3);
  assert.equal(run.totals.talks, 2);
  assert.equal(run.totals.cost, 0.0412);
  assert.equal(run.totals.duration, 34);
  assert.deepEqual(run.events.filter((e) => e.kind === 'tool').map((e) => e.cat), ['read', 'edit', 'test']);
});

test('codex exec --json: items, exit codes, file changes and turn usage', () => {
  const [run] = GR.parseLog(read('codex-exec-sample.jsonl'), 'codex-exec-sample.jsonl');
  assert.equal(run.source, 'codex');
  assert.deepEqual(run.events.filter((e) => e.kind === 'tool').map((e) => e.cat), ['search', 'edit', 'test', 'plan', 'edit', 'test']);
  assert.equal(run.totals.crashes, 1);
  assert.equal(run.events.find((e) => e.kind === 'crash').cat, 'test');
  assert.equal(run.totals.tokens, 50100);
  assert.equal(run.events.find((e) => e.name === 'apply_patch').detail, 'payment-mock.ts');
  assert.equal(GR._parsers.unwrapShell("bash -lc 'npm test'"), 'npm test');
});

test('OpenTelemetry: one ghost per trace, GenAI and OpenInference attributes', () => {
  const runs = GR.parseLog(read('otel-sample.json'), 'otel-sample.json');
  assert.equal(runs.length, 2);
  const [a, b] = runs;
  assert.equal(a.sourceLabel, 'OpenTelemetry');
  assert.equal(a.modelLabel, 'GPT-4.1');
  assert.equal(a.totals.tools, 2);
  assert.equal(a.totals.crashes, 1);
  assert.equal(a.totals.tokens, 1200 + 80 + 1500 + 120);
  assert.equal(b.modelLabel, 'Haiku 4.5');
  assert.equal(b.totals.tools, 1);
  assert.equal(b.events.find((e) => e.kind === 'tool').detail, 'search_docs');
});

test('OpenAI Agents SDK span exports', () => {
  const [run] = GR.parseLog(read('openai-agents-sample.jsonl'), 'openai-agents-sample.jsonl');
  assert.equal(run.sourceLabel, 'OpenAI Agents');
  assert.equal(run.modelLabel, 'GPT-4.1 Mini');
  assert.deepEqual(run.events.filter((e) => e.kind === 'tool').map((e) => e.cat), ['agent', 'other', 'other']);
  assert.equal(run.totals.crashes, 1);
  assert.equal(run.totals.tokens, 700 + 40 + 900 + 70);
});

test('Gemini CLI saved sessions', () => {
  const [run] = GR.parseLog(read('gemini-session-sample.json'), 'gemini-session-sample.json');
  assert.equal(run.sourceLabel, 'Gemini CLI');
  assert.equal(run.modelLabel, 'Gemini 2.5 Pro');
  assert.equal(run.task, 'The checkout test is flaky. Please fix it.');
  assert.deepEqual(run.events.filter((e) => e.kind === 'tool').map((e) => e.cat), ['read', 'search', 'edit', 'test', 'test']);
  assert.equal(run.totals.crashes, 1);
  assert.equal(run.totals.tokens, 8420 + 9100 + 9800);
  // checkpoints have no timestamps
  const [cp] = GR.parseLog(JSON.stringify([
    { role: 'user', parts: [{ text: 'fix it' }] },
    { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { absolute_path: '/a/b.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { error: 'nope' } } }] },
    { role: 'model', parts: [{ text: 'done' }] },
  ]), 'checkpoint.json');
  assert.equal(cp.timing, 'synthetic');
  assert.equal(cp.totals.crashes, 1);
});
