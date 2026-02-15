const ENGINE_STATES = Object.freeze({
  IDLE: 'IDLE',
  WARMING_UP: 'WARMING_UP',
  STARTING: 'STARTING',
  ENCODING: 'ENCODING',
  FINALIZING: 'FINALIZING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const TERMINAL_STATES = new Set([
  ENGINE_STATES.DONE,
  ENGINE_STATES.FAILED,
  ENGINE_STATES.CANCELLED,
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  [ENGINE_STATES.IDLE]: new Set([
    ENGINE_STATES.WARMING_UP,
    ENGINE_STATES.STARTING,
    ENGINE_STATES.FAILED,
    ENGINE_STATES.CANCELLED,
  ]),
  [ENGINE_STATES.WARMING_UP]: new Set([
    ENGINE_STATES.STARTING,
    ENGINE_STATES.FAILED,
    ENGINE_STATES.CANCELLED,
  ]),
  [ENGINE_STATES.STARTING]: new Set([
    ENGINE_STATES.ENCODING,
    ENGINE_STATES.FINALIZING,
    ENGINE_STATES.FAILED,
    ENGINE_STATES.CANCELLED,
  ]),
  [ENGINE_STATES.ENCODING]: new Set([
    ENGINE_STATES.FINALIZING,
    ENGINE_STATES.FAILED,
    ENGINE_STATES.CANCELLED,
  ]),
  [ENGINE_STATES.FINALIZING]: new Set([
    ENGINE_STATES.DONE,
    ENGINE_STATES.FAILED,
    ENGINE_STATES.CANCELLED,
  ]),
  [ENGINE_STATES.DONE]: new Set(),
  [ENGINE_STATES.FAILED]: new Set(),
  [ENGINE_STATES.CANCELLED]: new Set(),
});

function buildTransitionError({ code, fromState, toState, message }) {
  const err = new Error(message);
  err.code = code;
  err.fromState = fromState;
  err.toState = toState;
  return err;
}

function createEngineFsm({ jobId = null, onTransition = null } = {}) {
  let state = ENGINE_STATES.IDLE;
  let terminalCommitted = false;

  const isTerminal = () => TERMINAL_STATES.has(state);

  const assertCanMutateMetrics = (label = 'metrics') => {
    if (!isTerminal()) return;
    throw buildTransitionError({
      code: 'ENGINE_METRICS_AFTER_TERMINAL',
      fromState: state,
      toState: state,
      message: `Cannot mutate ${label} after terminal state: ${state}`,
    });
  };

  const assertCanEmitProgress = () => {
    if (!isTerminal()) return;
    throw buildTransitionError({
      code: 'ENGINE_PROGRESS_AFTER_TERMINAL',
      fromState: state,
      toState: state,
      message: `Cannot emit progress after terminal state: ${state}`,
    });
  };

  const transition = (nextStateRaw, meta = {}) => {
    const nextState = String(nextStateRaw || '').toUpperCase();
    if (!ALLOWED_TRANSITIONS[state]) {
      throw buildTransitionError({
        code: 'ENGINE_UNKNOWN_STATE',
        fromState: state,
        toState: nextState,
        message: `Unknown engine state: ${state}`,
      });
    }
    if (terminalCommitted) {
      throw buildTransitionError({
        code: 'ENGINE_TERMINAL_ALREADY_COMMITTED',
        fromState: state,
        toState: nextState,
        message: `Terminal state already committed: ${state}`,
      });
    }
    if (!ALLOWED_TRANSITIONS[state].has(nextState)) {
      throw buildTransitionError({
        code: 'ENGINE_INVALID_STATE_TRANSITION',
        fromState: state,
        toState: nextState,
        message: `Invalid engine transition: ${state} -> ${nextState}`,
      });
    }

    const prev = state;
    state = nextState;
    if (TERMINAL_STATES.has(state)) terminalCommitted = true;

    if (typeof onTransition === 'function') {
      onTransition({
        jobId,
        fromState: prev,
        toState: state,
        terminal: TERMINAL_STATES.has(state),
        ...meta,
      });
    }
    return state;
  };

  return {
    getState: () => state,
    isTerminal,
    assertCanEmitProgress,
    assertCanMutateMetrics,
    transition,
  };
}

module.exports = {
  ENGINE_STATES,
  createEngineFsm,
};
