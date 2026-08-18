import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { createMechanicalGoalAssessor } from '../dist/services/projectGoalSatisfactionAssessor.js';
import { runLoopOnce } from '../dist/services/projectBoundedAutonomousLoopRuntime.js';
import {
  MAX_VISIBLE_OBJECTIVE_CHARS,
  assertSafeOperatorPayload,
  buildOperatorAutonomyView,
  buildOperatorContinuationView,
  buildOperatorEvidenceBundle,
  buildOperatorGoalDetailSafe,
  buildOperatorGoalListItemSafe,
  deriveNextSafeAction,
  mapLoopStageToHudState,
  toOperatorBudget,
} from '../dist/services/projectGoalControlReadModel.js';

/**
 * Operator Goal Control Read Model — safe payload whitelist, no-fake-progress,
 * restart/reopen derivation, fail-closed malformed state, and the
 * HUD/nextSafeAction mappings (design §A.3/§A.4/§I/§L).
 */

const OBJECTIVE = 'Deliver the bounded operator control surface and verify the result.';
const goalId = (n) => `d50e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;
const taskId = (n) => `e50e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Complete the bounded durable objective.',
  priority: 'high',
  requestedCapabilities: ['repository_read', 'run_tests'],
  ...overrides,
});

const failure = (code = 'codex_execution_failed', overrides = {}) => ({
  code,
  message: SAFE_TASK_ERROR_MESSAGES[code],
  stage: 'codex',
  ...overrides,
});

const notDemonstratedAssessor = createMechanicalGoalAssessor(() => ({
  goalSatisfaction: 'not_demonstrated',
  blocking: 'none',
  failure: 'retryable',
}));

function makeClock(start = 1000) {
  let value = start;
  const clock = () => value;
  clock.advance = (ms) => { value += ms; };
  return clock;
}

async function tempDatabase(prefix = 'lia-gcrm-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seedGoal(store, n, options = {}) {
  const id = options.goalId ?? goalId(n);
  const root = options.taskId ?? taskId(n);
  store.createGoal({ goalId: id, projectId: 'safe', objective: OBJECTIVE, ...options });
  const created = store.createRootAttempt({
    taskId: root,
    fingerprint: `${root}-fingerprint`,
    intent: intent(),
    goalId: id,
    continuationDepth: 0,
    attemptNumber: 0,
  });
  assert.equal(created.kind, 'created');
  return { goalId: id, taskId: root };
}

const loopDeps = (overrides = {}) => ({ now: () => 1000, ...overrides });

/** Fakes a derived-stage details object for the pure mapping functions. */
function fakeDetails(stage, overrides = {}) {
  return {
    stage,
    goal: { status: 'active' },
    eligibility: undefined,
    blockingReason: undefined,
    ...overrides,
  };
}

test('01: assertSafeOperatorPayload — whitelist passes safe payloads, fails closed on any forbidden key', () => {
  const safe = {
    goalId: goalId(1),
    title: OBJECTIVE,
    status: 'active',
    budget: { attemptsRemaining: 3, depthRemaining: 2 },
    noProgress: { count: 0, threshold: 2, escalated: false },
    attempts: [{ taskId: taskId(1), status: 'failed', attemptNumber: 0, errorCode: 'codex_execution_failed' }],
  };
  assert.doesNotThrow(() => assertSafeOperatorPayload(safe));

  const forbiddenKeys = [
    'sessionId', 'session_id', 'apiKey', 'api_key', 'accessToken', 'token',
    'secret', 'credential', 'worktreePath', 'worktree_path', 'repositoryRoot',
    'command', 'commands', 'shell', 'prompt', 'rawOutput', 'executionSummary',
    'provider', 'model', 'fencingToken', 'leaseId', 'leaseOwner', 'intent',
    'approvedCapabilities', 'effectiveCapabilities', 'capabilities',
    'capabilityExpansion', 'error', 'stack', 'internalError', 'paths', 'path',
  ];
  for (const key of forbiddenKeys) {
    assert.throws(
      () => assertSafeOperatorPayload({ safeField: 'ok', [key]: 'anything' }),
      /unsafe_operator_payload_field/,
      `key ${key} must fail closed`,
    );
  }
  // Nested and array entries are scanned too.
  assert.throws(() => assertSafeOperatorPayload({ nested: { deep: [{ prompt: 'x' }] } }), /unsafe_operator_payload_field/);
});

test('02: built payloads never leak secrets, prompts, sessions, paths or internals', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcrm-leak-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, g.goalId, loopDeps());
    store.approveContinuationPlan({ planId: store.listGoalContinuationPlans(g.goalId)[0].planId, approver: 'operator-1' });
    await runLoopOnce(store, g.goalId, loopDeps());
    store.setGoalAutonomyPolicy({ goalId: g.goalId, mode: 'approved_single_step', approver: 'operator-1' });

    const payloads = [
      buildOperatorGoalListItemSafe(store, store.readGoal(g.goalId)),
      buildOperatorGoalDetailSafe(store, g.goalId, { now: () => 1000 }),
      buildOperatorContinuationView(store, g.goalId, { now: () => 1000 }),
      buildOperatorAutonomyView(store, g.goalId, { now: () => 1000 }),
      buildOperatorEvidenceBundle(store, g.goalId, { now: () => 1000 }),
    ];
    for (const payload of payloads) {
      assert.doesNotThrow(() => assertSafeOperatorPayload(payload), 'every built payload passes the deep whitelist guard');
      const serialized = JSON.stringify(payload);
      for (const forbidden of [
        'sessionId', 'session_id', 'apiKey', 'api_key', 'accessToken', 'token',
        'secret', 'credential', 'worktreePath', 'worktree_path', 'repositoryRoot',
        'command', 'commands', 'shell', 'prompt', 'rawOutput', 'executionSummary',
        'provider', 'model', 'fencingToken', 'leaseId', 'leaseOwner',
        'approvedCapabilities', 'effectiveCapabilities', 'capabilityExpansion',
        'stack', 'internalError', 'paths', 'path', 'push', 'merge', 'deploy',
        'production_write', 'database_write', 'secret_access',
      ]) {
        assert.ok(!serialized.includes(forbidden), `payload must not expose ${forbidden}`);
      }
    }
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('03: no fake progress — bounded attempts/depth/cycle numbers, never completion percentages', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcrm-progress-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, g.goalId, loopDeps());

    const detail = buildOperatorGoalDetailSafe(store, g.goalId, { now: () => 1000 });
    const serialized = JSON.stringify(detail);
    // The only numeric "progress-like" facts are the bounded attempt/depth
    // counters; no percentage field exists anywhere in the payload.
    assert.ok(!/progress(Percent|Percentage|Pct)/i.test(serialized));
    assert.ok(!serialized.includes('percent'));
    assert.ok(!serialized.includes('percentage'));
    assert.ok(!serialized.includes('completionRatio'));
    assert.equal(detail.budget.attemptsRemaining, 3, 'budget is remaining attempts, not a percentage');
    assert.equal(detail.budget.depthRemaining, 2);
    assert.equal(detail.currentAttempt, 0);
    assert.equal(detail.maxAttempts, 3);
    assert.equal(detail.continuationDepthLimit, 2);

    // The list title is bounded to the whitelisted window; the raw objective
    // tail never leaves the DB.
    const longObjective = `x${'y'.repeat(MAX_VISIBLE_OBJECTIVE_CHARS + 500)}`;
    store.createGoal({ goalId: goalId(9), projectId: 'safe', objective: longObjective });
    const listItem = buildOperatorGoalListItemSafe(store, store.readGoal(goalId(9)));
    assert.equal(listItem.title.length, MAX_VISIBLE_OBJECTIVE_CHARS);
    assert.equal(listItem.title, longObjective.slice(0, MAX_VISIBLE_OBJECTIVE_CHARS));
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('04: restart/reopen — derived stage, budget and HUD re-derive identically from durable rows', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcrm-restart-');
  try {
    let store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, g.goalId, loopDeps());
    store.approveContinuationPlan({ planId: store.listGoalContinuationPlans(g.goalId)[0].planId, approver: 'operator-1' });
    await runLoopOnce(store, g.goalId, loopDeps());
    store.setGoalAutonomyPolicy({ goalId: g.goalId, mode: 'approved_single_step', approver: 'operator-1' });
    store.suspendGoalAutonomy(g.goalId);

    const before = buildOperatorGoalDetailSafe(store, g.goalId, { now: () => 1000 });
    assert.equal(before.loopStage, 'suspended');
    assert.equal(before.hudState, 'suspended');
    store.close();

    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const after = buildOperatorGoalDetailSafe(store, g.goalId, { now: () => 1000 });
    assert.equal(after.loopStage, 'suspended', 'derived stage survives reopen');
    assert.equal(after.hudState, 'suspended');
    assert.equal(after.blockingReason, 'autonomy_suspended');
    assert.equal(after.nextSafeAction, 'resume');
    assert.deepEqual(after.budget, before.budget, 'budget re-derives identically');
    // While suspended the derived stage carries no live plan, so the approval
    // state is durably not_applicable (the approval row itself survives).
    assert.equal(after.approvalState, 'not_applicable');
    assert.equal(after.authorizationState, 'not_applicable', 'suspended policy derives no authorization state');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('05: fail-closed malformed state — corrupt derivation surfaces as failed_closed, never aborts', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcrm-failclosed-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(base, 1);
    const store = new Proxy(base, {
      get(target, prop) {
        if (prop === 'listGoalAttempts') {
          return () => { throw new Error('corrupt_project_task_record'); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const listItem = buildOperatorGoalListItemSafe(store, store.readGoal(g.goalId));
    assert.equal(listItem.loopStage, 'failed_closed');
    assert.equal(listItem.hudState, 'fail_closed');
    assert.equal(listItem.blockingReason, 'loop_transition_failed');
    assert.equal(listItem.nextSafeAction, 'manual_review_required');
    assert.equal(listItem.humanInterventionRequired, true);
    assert.doesNotThrow(() => assertSafeOperatorPayload(listItem));

    const detail = buildOperatorGoalDetailSafe(store, g.goalId);
    assert.equal(detail.loopStage, 'failed_closed');
    assert.equal(detail.hudState, 'fail_closed');
    assert.equal(detail.blockingReason, 'loop_transition_failed');
    assert.equal(detail.nextSafeAction, 'manual_review_required');
    assert.equal(detail.humanInterventionRequired, true);
    assert.equal(detail.inFlight, false);
    assert.deepEqual(detail.attempts, []);
    assert.doesNotThrow(() => assertSafeOperatorPayload(detail));

    // A missing goal still surfaces as not-found, never a fake fail-closed row.
    assert.throws(() => buildOperatorGoalDetailSafe(store, goalId(99)), /project_goal_not_found/);
    base.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('06: nextSafeAction derivation — every stage maps to the advisory vocabulary', () => {
  assert.equal(deriveNextSafeAction(fakeDetails('awaiting_execution')), 'root_attempt_pending');
  assert.equal(deriveNextSafeAction(fakeDetails('task_terminal')), 'run_supervisor_pass');
  assert.equal(deriveNextSafeAction(fakeDetails('continuation_required')), 'run_supervisor_pass');
  assert.equal(deriveNextSafeAction(fakeDetails('materializing_next_attempt')), 'run_supervisor_pass');
  assert.equal(
    deriveNextSafeAction(fakeDetails('next_attempt_accepted', { eligibility: { eligible: true } })),
    'run_supervisor_pass',
  );
  assert.equal(
    deriveNextSafeAction(fakeDetails('next_attempt_accepted', {
      eligibility: { eligible: false, reason: 'authorization_required' },
    })),
    'authorization_required',
  );
  assert.equal(
    deriveNextSafeAction(fakeDetails('next_attempt_accepted', { blockingReason: 'autonomy_suspended' })),
    'autonomy_suspended',
  );
  assert.equal(deriveNextSafeAction(fakeDetails('authorization_required')), 'approve_materialization');
  assert.equal(deriveNextSafeAction(fakeDetails('suspended')), 'resume');
  assert.equal(deriveNextSafeAction(fakeDetails('failed_closed')), 'manual_review_required');
  assert.equal(deriveNextSafeAction(fakeDetails('goal_satisfied')), 'none_terminal');
  assert.equal(deriveNextSafeAction(fakeDetails('exhausted')), 'none_terminal');
  assert.equal(deriveNextSafeAction(fakeDetails('executing')), 'none_running');
});

test('07: HUD state mapping — derived stages map to the six-state vocabulary', () => {
  assert.equal(mapLoopStageToHudState(fakeDetails('goal_satisfied')), 'completed');
  assert.equal(mapLoopStageToHudState(fakeDetails('executing')), 'executing');
  assert.equal(mapLoopStageToHudState(fakeDetails('suspended')), 'suspended');
  assert.equal(mapLoopStageToHudState(fakeDetails('exhausted')), 'failed');
  // Row-terminal failed_closed (failed/blocked goal row) renders as failed.
  assert.equal(
    mapLoopStageToHudState(fakeDetails('failed_closed', { goal: { status: 'failed' } })),
    'failed',
  );
  assert.equal(
    mapLoopStageToHudState(fakeDetails('failed_closed', { goal: { status: 'blocked' } })),
    'failed',
  );
  // Derived-hold failed_closed (active row) renders as fail_closed.
  assert.equal(
    mapLoopStageToHudState(fakeDetails('failed_closed', { goal: { status: 'active' } })),
    'fail_closed',
  );
  // Every remaining active stage needs a human/supervisor pass.
  for (const stage of ['awaiting_execution', 'task_terminal', 'continuation_required', 'authorization_required', 'materializing_next_attempt', 'next_attempt_accepted']) {
    assert.equal(mapLoopStageToHudState(fakeDetails(stage)), 'waiting_human', stage);
  }
});

test('08: toOperatorBudget — bounded projection, optional cycle/time fields only when present', () => {
  const base = { attemptsRemaining: 2, depthRemaining: 1 };
  assert.deepEqual(toOperatorBudget(base), { attemptsRemaining: 2, depthRemaining: 1 });
  assert.deepEqual(
    toOperatorBudget({ ...base, cyclesRemaining: 3, elapsedBudgetMsRemaining: 4000 }),
    { attemptsRemaining: 2, depthRemaining: 1, cyclesRemaining: 3, elapsedBudgetMsRemaining: 4000 },
  );
});

test('09: evidence bundle — safe receipt fields only, escalation facts derived, no raw output', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcrm-evidence-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock, assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock }));

    const bundle = buildOperatorEvidenceBundle(store, g.goalId, { now: clock });
    assert.equal(bundle.latestEvaluation.decision, 'retryable');
    // A failed task without a receipt legitimately has empty resultText; the
    // contract is a bounded, validated string (never raw model output).
    assert.equal(typeof bundle.latestEvaluation.resultText, 'string');
    assert.ok(bundle.latestEvaluation.resultText.length >= 0);
    assert.ok(bundle.latestEvaluation.resultText.length <= 6000);
    assert.equal(bundle.continuationPlan.planStatus, 'planned');
    assert.equal(bundle.continuationPlan.materializationPending, true);
    assert.equal(bundle.continuationPlan.continuationExecuted, false);
    assert.equal(bundle.continuationPlan.escalation.detected, false);
    assert.equal(bundle.continuationPlan.escalation.consecutiveNoProgress, 1);
    assert.equal(bundle.approvalState, 'approval_required');
    assert.equal(bundle.noProgress.count, 1);
    assert.deepEqual(bundle.noProgress, { count: 1, threshold: 2, escalated: false });
    assert.doesNotThrow(() => assertSafeOperatorPayload(bundle));
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
