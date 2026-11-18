/*!
 * Ghost Race — demo.js
 * A built-in demo race with three made-up ghosts, so the page is fun before
 * you load your own logs. These are illustrative runs, not real model results.
 */
(function (root) {
  'use strict';

  const GR = (root.GhostRace = root.GhostRace || {});

  // [seconds, type, tool name, tokens used, detail or command]
  const PLANNER = [
    [0, 'talk', 'reply', 14000, 'Mapping the checkout flow before touching anything.'],
    [18, 'tool', 'Read', 17000, 'checkout.test.ts'],
    [39, 'tool', 'Grep', 16000, 'retry|setTimeout'],
    [61, 'tool', 'Read', 19000, 'payment-mock.ts'],
    [84, 'tool', 'Read', 20000, 'cart.ts'],
    [108, 'talk', 'reply', 15000, 'Found it: the mock resolves after the test timeout.'],
    [131, 'tool', 'TodoWrite', 12000, '3-step plan'],
    [156, 'tool', 'Edit', 24000, 'payment-mock.ts'],
    [176, 'tool', 'Edit', 23000, 'checkout.test.ts'],
    [192, 'tool', 'Bash', 27000, '$ npm test -- checkout'],
    [211, 'tool', 'Bash', 29000, '$ npm test'],
    [226, 'tool', 'Grep', 22000, 'mockPayment'],
    [241, 'tool', 'Edit', 26000, 'cart.test.ts'],
    [258, 'tool', 'Bash', 31000, '$ npm test'],
    [276, 'tool', 'Bash', 18000, '$ git diff --stat'],
    [298, 'talk', 'reply', 21000, 'Fixed. The mock now awaits the timer and all tests pass.'],
  ];

  const SPEED_DEMON = [
    [0, 'talk', 'reply', 9000, 'On it.'],
    [9, 'tool', 'Edit', 22000, 'checkout.test.ts'],
    [21, 'tool', 'Bash', 24000, '$ npm test -- checkout'],
    [30, 'error', 'Bash', 0, '1 failing: checkout > pays'],
    [38, 'tool', 'Read', 18000, 'checkout.test.ts'],
    [50, 'tool', 'Edit', 23000, 'checkout.test.ts'],
    [62, 'tool', 'Bash', 26000, '$ npm test -- checkout'],
    [71, 'error', 'Bash', 0, 'Timeout of 5000ms exceeded'],
    [80, 'tool', 'Read', 19000, 'payment-mock.ts'],
    [92, 'tool', 'Edit', 25000, 'payment-mock.ts'],
    [104, 'tool', 'Bash', 28000, '$ npm test -- checkout'],
    [118, 'tool', 'Bash', 30000, '$ npm test'],
    [139, 'error', 'Bash', 0, 'cart.test.ts now failing'],
    [171, 'tool', 'Grep', 21000, 'mockPayment'],
    [205, 'tool', 'Read', 23000, 'cart.test.ts'],
    [236, 'tool', 'Edit', 27000, 'cart.test.ts'],
    [263, 'tool', 'Bash', 32000, '$ npm test'],
    [291, 'tool', 'Edit', 24000, 'payment-mock.ts'],
    [312, 'tool', 'Bash', 33000, '$ npm test'],
    [331, 'talk', 'reply', 16000, 'All green now.'],
  ];

  const LOOP_GOBLIN = [
    [0, 'talk', 'reply', 12000, 'Let me check everything.'],
    [20, 'tool', 'Task', 38000, 'Explore the test suite'],
    [61, 'tool', 'Read', 26000, 'checkout.test.ts'],
    [80, 'tool', 'Bash', 30000, '$ npm test -- checkout'],
    [92, 'error', 'Bash', 0, '1 failing'],
    [101, 'tool', 'Bash', 31000, '$ npm test -- checkout'],
    [113, 'error', 'Bash', 0, '1 failing'],
    [121, 'tool', 'Bash', 33000, '$ npm test -- checkout --retries=3'],
    [140, 'tool', 'WebSearch', 29000, 'jest flaky test timeout'],
    [166, 'tool', 'WebFetch', 35000, 'jest docs: timer mocks'],
    [190, 'tool', 'Edit', 36000, 'jest.config.js'],
    [208, 'tool', 'Bash', 38000, '$ npm test -- checkout'],
    [222, 'error', 'Bash', 0, 'still flaky'],
    [236, 'tool', 'Read', 37000, 'payment-mock.ts'],
    [262, 'talk', 'reply', 30000, 'Maybe the mock is the problem.'],
    [287, 'tool', 'Edit', 41000, 'payment-mock.ts'],
    [309, 'tool', 'Bash', 43000, '$ npm test -- checkout'],
    [333, 'tool', 'Bash', 45000, '$ npm test'],
    [358, 'tool', 'Edit', 44000, 'cart.test.ts'],
    [384, 'tool', 'Bash', 47000, '$ npm test'],
    [405, 'tool', 'Edit', 40000, 'jest.config.js'],
    [428, 'tool', 'Bash', 48000, '$ npm test'],
    [452, 'talk', 'reply', 26000, 'Should be fixed now, I think.'],
  ];

  function toGhost(name, rows) {
    return {
      name,
      model: 'demo',
      task: 'Fix the flaky checkout test',
      events: rows.map(([t, type, tool, tokens, detail]) => {
        const e = { t, type, name: tool, tokens };
        if (detail && detail.startsWith('$ ')) {
          e.command = detail.slice(2);
          e.detail = detail.slice(2);
        } else if (detail) e.detail = detail;
        return e;
      }),
    };
  }

  GR.demoGhostJson = function demoGhostJson() {
    return {
      ghostrace: 1,
      title: 'Fix the flaky checkout test',
      runs: [toGhost('The Planner', PLANNER), toGhost('Speed Demon', SPEED_DEMON), toGhost('Loop Goblin', LOOP_GOBLIN)],
    };
  };

  GR.demoRuns = function demoRuns() {
    const runs = GR.parseLog(JSON.stringify(GR.demoGhostJson()), 'demo');
    runs.forEach((r) => {
      r.demo = true;
      r.modelLabel = null;
      r.sourceLabel = 'Demo';
    });
    return runs;
  };
})(typeof window !== 'undefined' ? window : globalThis);
