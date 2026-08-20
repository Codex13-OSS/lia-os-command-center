import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deriveLiaCoreModel } from '../../frontend/src/components/lia-core-r3/liaCoreState.ts';

const baseOffice = (state = 'idle', overrides = {}) => ({
  integration: 'lia_agent_office_v2', readOnly: true, empty: false, generatedAt: 1,
  telemetry: { leafEventsAvailable: false, contractStatus: 'future_boundary_not_implemented' },
  supervisor: { state: 'idle', pendingWakeup: false, passInProgress: false, failClosed: false },
  capacity: { inFlight: 0, ceiling: 2 },
  focus: {
    goalId: 'goal-real', title: 'Goal real', goalStatus: 'active', officeState: state,
    planSteps: [], humanInterventionRequired: false,
    noProgress: { count: 0, threshold: 3, escalated: false }, retry: false,
    ...overrides,
  },
  agents: [], connections: [], board: { decisions: [], rolesPresent: [] },
});

const evidence = (office, extra = {}) => ({ office, hud: null, hermesAvailability: 'available', chatPending: false, ...extra });

for (const [officeState, expected] of [
  ['idle', 'idle'], ['planned', 'planning'], ['planning', 'planning'], ['delegating', 'delegating'],
  ['implementing', 'executing'], ['verifying', 'verifying'], ['reviewing', 'verifying'],
  ['correcting', 'correcting'], ['waiting_human', 'waiting_human'], ['failed', 'failed'],
]) {
  test(`Office ${officeState} maps to ${expected}`, () => {
    assert.equal(deriveLiaCoreModel(evidence(baseOffice(officeState))).state, expected);
  });
}

test('completed is visual only for a transition backed by evidence', () => {
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('completed'))).state, 'idle');
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('completed'), { completionTransition: true })).state, 'completed');
});

test('Hermes unavailable maps to offline', () => {
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('idle'), { hermesAvailability: 'unavailable' })).state, 'offline');
});

test('chat pending maps to responding only from the real boolean', () => {
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('idle'), { chatPending: false })).state, 'idle');
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('idle'), { chatPending: true })).state, 'responding');
});

test('precedence is deterministic', () => {
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('failed'), { hermesAvailability: 'unavailable', chatPending: true })).state, 'failed');
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('waiting_human'), { chatPending: true })).state, 'waiting_human');
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('correcting'), { chatPending: true })).state, 'responding');
  assert.equal(deriveLiaCoreModel(evidence(baseOffice('verifying'))).state, 'verifying');
});

test('task-stage fallbacks are evidence based', () => {
  const stageOffice = { ...baseOffice('idle'), focus: undefined };
  const baseHud = {
    supervisor: { state: 'idle', enabled: true, supported: true, failClosed: false, pendingWakeup: false, passInProgress: false },
    totalGoals: 1, activeCount: 1, terminalCount: 0, humanInterventionRequiredCount: 0, executingCount: 0, inFlight: 0, externalExecutionCeiling: 2, maxGoalsPerTick: 1,
    goals: [],
  };
  const expected = { planning: 'planning', hermes: 'delegating', codex: 'executing', verification: 'verifying', commit: 'executing', failed: 'failed' };
  for (const [stage, state] of Object.entries(expected)) {
    const goal = { goalId: 'g', projectId: 'p', title: 'Goal durable', status: 'active', currentAttempt: 0, maxAttempts: 2, continuationDepth: 0, maxDepth: 2, humanInterventionRequired: false, loopStage: stage, hudState: 'executing', createdAt: 1, updatedAt: 2, currentTask: { taskId: 't', status: stage, attemptNumber: 1, continuationDepth: 0 } };
    assert.equal(deriveLiaCoreModel({ ...evidence(stageOffice), hud: { ...baseHud, goals: [goal] } }).state, state);
  }
});

test('source has no random cycling, fake progress, thinking or timer-driven listening state', async () => {
  const [stateSource, componentSource, providerSource] = await Promise.all([
    readFile(new URL('../../frontend/src/components/lia-core-r3/liaCoreState.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/components/lia-core-r3/LiaCoreR3.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/components/lia-core-r3/useLiaCoreState.tsx', import.meta.url), 'utf8'),
  ]);
  const source = `${stateSource}\n${componentSource}\n${providerSource}`;
  assert.doesNotMatch(source, /Math\.random|setInterval\([^,]*state|thinking|percentage|percent/iu);
  assert.doesNotMatch(source, /setTimeout[\s\S]{0,160}(voiceListening|listening)|setInterval[\s\S]{0,160}(voiceListening|listening)/iu);
  assert.match(stateSource, /evidence\.voiceListening === true/);
  assert.match(stateSource, /evidence\.voiceSpeaking === true/);
  assert.doesNotMatch(providerSource, /requestLiaHermesResponse|\/query/);
});

test('dashboard, shared shell, iPad and reduced-motion integration remain explicit', async () => {
  const [dashboard, app, styles] = await Promise.all([
    readFile(new URL('../../frontend/src/components/dashboard-r3/DashboardCommandCenterR3.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/styles/dashboardExecutiveR3.css', import.meta.url), 'utf8'),
  ]);
  assert.match(dashboard, /<LiaCoreR3 model=\{core\}/);
  assert.match(app, /LiaCoreStateProvider/);
  assert.match(styles, /prefers-reduced-motion:reduce[\s\S]*\.lia-core-r3/);
  assert.match(styles, /max-width:900px/);
  assert.match(styles, /min-height:100dvh/);
});
