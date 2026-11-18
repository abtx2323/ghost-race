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
