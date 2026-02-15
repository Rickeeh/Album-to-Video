const { createEngineFsm } = require('../../src/main/engine-fsm');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

function assertThrows(fn, code, message) {
  try {
    fn();
  } catch (err) {
    if (!code || err?.code === code) return;
    fail(`${message} (expected code=${code}, got code=${err?.code})`);
  }
  fail(`${message} (expected throw)`);
}

(function run() {
  const transitions = [];
  const fsm = createEngineFsm({
    jobId: 'job-fsm-test',
    onTransition: (entry) => transitions.push(entry),
  });

  fsm.transition('WARMING_UP');
  fsm.transition('STARTING');
  fsm.transition('ENCODING');
  fsm.transition('FINALIZING');
  fsm.transition('DONE');

  assertOk(fsm.getState() === 'DONE', 'FSM test: expected final state DONE.');
  assertOk(fsm.isTerminal() === true, 'FSM test: expected DONE to be terminal.');
  assertOk(transitions.length === 5, `FSM test: expected 5 transitions, got ${transitions.length}.`);

  assertThrows(
    () => fsm.assertCanEmitProgress(),
    'ENGINE_PROGRESS_AFTER_TERMINAL',
    'FSM test: expected progress emission to be blocked after terminal state.'
  );
  assertThrows(
    () => fsm.assertCanMutateMetrics('report.perf'),
    'ENGINE_METRICS_AFTER_TERMINAL',
    'FSM test: expected metrics mutation to be blocked after terminal state.'
  );
  assertThrows(
    () => fsm.transition('CANCELLED'),
    'ENGINE_TERMINAL_ALREADY_COMMITTED',
    'FSM test: expected terminal state to be committed only once.'
  );

  const invalid = createEngineFsm();
  invalid.transition('WARMING_UP');
  invalid.transition('STARTING');
  assertThrows(
    () => invalid.transition('DONE'),
    'ENGINE_INVALID_STATE_TRANSITION',
    'FSM test: expected invalid STARTING -> DONE transition to throw.'
  );

  console.log('OK: engine FSM transitions and terminal guards are deterministic');
})();
