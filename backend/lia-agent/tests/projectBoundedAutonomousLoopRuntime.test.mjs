import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CONTINUATION_PLANNER_VERSION } from '../dist/contracts/projectGoalContinuationPlan.js';
import { PROJECT_GOAL_EVALUATOR_VERSION } from '../dist/contracts/projectGoalEvaluation.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { AUTONOMOUS_V1_CEILING, AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES } from '../dist/contracts/autonomousAuthority.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';
import { createMechanicalGoalAssessor } from '../dist/services/projectGoalSatisfactionAssessor.js';
import { materializeApprovedContinuation } from '../dist/services/projectGoalContinuationExecutionGate.js';
import {
  deriveLoopStage,
  deriveLoopStageDetails,
  runLoopOnce,
  reconcileLoopTick,
  buildLoopRuntimeEvidence,
} from '../dist/services/projectBoundedAutonomousLoopRuntime.js';

const GOAL = 'd50e8400-e29b-41d4-a716-446655440000';
const ROOT = 'e50e8400-e29b-41d4-a716-446655440000';
const OTHER_GOAL = 'd50e8400-e29b-41d4-a716-4466554400aa';
const OTHER_ROOT = 'e50e8400-e29b-41d4-a716-4466554400aa';

const OBJECTIVE = 'Deliver the remaining bounded surfaces and verify the result.';

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Complete the bounded durable objective.',
  priority: 'high',
  requestedCapabilities: ['repository_read', 'run_tests'],
  ...overrides,
});

const committedReceipt = (overrides = {}) => ({
  executionId: 'loop-test-execution',
  status: 'verified',
  resultText: `Final result: ${OBJECTIVE}`,
  verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
  ...overrides,
});

const failure = (code = 'codex_execution_failed', overrides = {}) => ({
  code,
  message: SAFE_TASK_ERROR_MESSAGES[code],
  stage: 'codex',
  ...overrides,
});

const workflowOk = {
  ok: true,
  projectId: 'safe',
  executionId: 'exec-safe',
  status: 'verified',
  executionSummary: 'hidden',
  resultText: 'Bounded verified result.',
  verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
};

const registry = {
  read: async () => [{
    projectId: 'safe',
    displayName: 'Safe Project',
    repositoryRoot: '/registry/safe',
    enabled: true,
  }],
};

const config = {
  host: '127.0.0.1',
  port: 3014,
  corsOrigins: [],
  agendaSqlitePath: '',
  projectTaskSqlitePath: '',
  projectRegistryPath: '',
  projectVerificationPath: '',
  hermesRoot: '',
  hermesExecutionEnabled: true,
  hermesExecutable: '/bin/hermes',
  hermesHome: '/hermes',
  hermesUser: 'hermes',
  hermesUserHome: '/home/hermes',
  hermesPath: '/bin',
  hermesProvider: 'fake',
  hermesModel: 'fake',
  hermesTimeoutMs: 100,
  hermesMaxQueryCharacters: 8000,
  logLevel: 'silent',
};

const satisfiedAssessor = createMechanicalGoalAssessor(() => ({
  goalSatisfaction: 'satisfied',
  blocking: 'none',
  failure: 'retryable',
}));
const notDemonstratedAssessor = createMechanicalGoalAssessor(() => ({
  goalSatisfaction: 'not_demonstrated',
  blocking: 'none',
  failure: 'retryable',
}));

function makeClock(start = 1000) {
  let value = start;
  const clock = () => value;
  clock.advance = (ms) => { value += ms; };
  clock.set = (next) => { value = next; };
  return clock;
}

async function tempDatabase(prefix = 'lia-loop-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seedGoal(store, options = {}) {
  const {
    goalId = GOAL,
    taskId = ROOT,
    projectId = 'safe',
    objective = OBJECTIVE,
    maxAttempts = 3,
    continuationDepthLimit = 2,
  } = options;
  store.createGoal({ goalId, projectId, objective, maxAttempts, continuationDepthLimit });
  const created = store.createRootAttempt({
    taskId,
    fingerprint: `${taskId}-fingerprint`,
    intent: intent({ projectId }),
    goalId,
    continuationDepth: 0,
    attemptNumber: 0,
  });
  assert.equal(created.kind, 'created');
}

const loopDeps = (overrides = {}) => ({ now: () => 1000, ...overrides });

const launchDeps = (overrides = {}) => ({
  workerId: 'lia-loop-test-worker',
  config,
  registry,
  now: () => 1000,
  executeWorkflow: async () => workflowOk,
  ...overrides,
});

function materialize(store, planId) {
  store.approveContinuationPlan({ planId, approver: 'operator-1' });
  const result = materializeApprovedContinuation(store, planId);
  return { createdTaskId: result.createdTaskId, task: result.task };
}

function setMode(store, goalId, mode, overrides = {}) {
  return store.setGoalAutonomyPolicy({ goalId, mode, approver: 'operator-1', ...overrides });
}

/** Strips // and /* comments so static safety assertions only inspect real code. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function authorize(store, { goalId, taskId, planId }, overrides = {}) {
  return store.createExecutionAuthorization({ goalId, taskId, planId, approver: 'operator-1', ...overrides });
}

function inspect(databasePath) {
  const database = new DatabaseSync(databasePath);
  const count = (table) => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const result = {
    evaluations: count('project_goal_evaluations'),
    plans: count('project_goal_continuation_plans'),
    tasks: count('project_tasks'),
    authorizations: count('project_goal_continuation_execution_authorizations'),
    launchAttempts: count('project_task_execution_launch_attempts'),
    launchResults: count('project_task_execution_launch_results'),
    invocations: count('project_task_execution_invocations'),
  };
  database.close();
  return result;
}

async function crossLaunchBoundary(store, taskId) {
  const dispatch = store.enqueueTaskDispatch(taskId);
  const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'pre-worker', durationMs: 10_000 });
  const run = store.prepareTaskExecutionRun({
    dispatchId: dispatch.dispatchId,
    taskId,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const invocation = store.reserveTaskExecutionInvocation({
    executionRunId: run.executionRunId,
    taskId,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const attemptResult = store.beginTaskExecutionLaunchAttempt({
    invocationId: invocation.invocationId,
    executionRunId: run.executionRunId,
    taskId,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  return { attempt: attemptResult.launchAttempt, run, invocation };
}

test('SCHEMA: loop runtime compiles against V19 with no new tables', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-schema-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 19);
    const database = new DatabaseSync(databasePath);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.ok(!tables.some((name) => /loop/i.test(name)), 'no loop-runtime table may exist');
    database.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('01: completed Goal -> loop terminal no-op', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-done-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.complete(ROOT, committedReceipt());
    const first = await runLoopOnce(store, GOAL, loopDeps({ assessor: satisfiedAssessor }));
    assert.equal(first.action, 'evaluated');
    assert.equal(store.readGoal(GOAL).status, 'completed');

    const second = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(second.stageBefore, 'goal_satisfied');
    assert.equal(second.action, 'none');
    assert.equal(second.terminal, true);
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
    assert.equal(store.listGoalAttempts(GOAL).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('02: task terminal -> exactly one Goal Evaluation boundary', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-eval-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    const result = await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(result.stageBefore, 'task_terminal');
    assert.equal(result.action, 'evaluated');
    assert.equal(result.stageAfter, 'continuation_required');
    const evaluations = store.listGoalEvaluations(GOAL);
    assert.equal(evaluations.length, 1);
    assert.equal(evaluations[0].decision, 'retryable');
    assert.ok(evaluations[0].appliedAt !== undefined);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('03: retryable evaluation -> exactly one durable plan boundary', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-plan-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    const result = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(result.stageBefore, 'continuation_required');
    assert.equal(result.action, 'planned');
    assert.equal(result.stageAfter, 'authorization_required');
    const plans = store.listGoalContinuationPlans(GOAL);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].status, 'planned');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('04: plan needing approval -> human_intervention_required (no write)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-approve-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    const planned = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(planned.action, 'planned');

    const result = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(result.stageBefore, 'authorization_required');
    assert.equal(result.action, 'held');
    assert.equal(result.blockingReason, 'approval_required');
    assert.equal(result.humanInterventionRequired, true);
    // No materialization write, no task beyond the root.
    assert.equal(store.listGoalAttempts(GOAL).length, 1);
    assert.equal(store.listGoalContinuationPlans(GOAL)[0].status, 'planned');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('05: approved plan -> exactly one materialization boundary', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-materialize-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    await runLoopOnce(store, GOAL, loopDeps()); // plan
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });

    const result = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(result.stageBefore, 'materializing_next_attempt');
    assert.equal(result.action, 'materialized');
    assert.equal(result.stageAfter, 'next_attempt_accepted');
    assert.ok(result.createdTaskId);
    assert.equal(store.listGoalAttempts(GOAL).length, 2);
    assert.equal(store.listGoalContinuationPlans(GOAL)[0].status, 'consumed');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('06: materialized task in manual_only -> no launch', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-manual-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    await runLoopOnce(store, GOAL, loopDeps()); // plan
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);

    const result = await runLoopOnce(store, GOAL, loopDeps({ launch: launchDeps() }));
    assert.equal(result.stageBefore, 'next_attempt_accepted');
    assert.equal(result.action, 'held');
    assert.equal(result.blockingReason, 'autonomy_manual_only');
    assert.equal(store.get(createdTaskId).status, 'accepted');
    const inspected = inspect(databasePath);
    assert.equal(inspected.launchAttempts, 0);
    assert.equal(inspected.launchResults, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('07: approved_single_step authorization -> one launch', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-single-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    await runLoopOnce(store, GOAL, loopDeps()); // plan
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });

    const result = await runLoopOnce(store, GOAL, loopDeps({ launch: launchDeps() }));
    assert.equal(result.stageBefore, 'next_attempt_accepted');
    assert.equal(result.action, 'launched');
    assert.equal(store.get(createdTaskId).status, 'completed');
    const authorization = store.readExecutionAuthorizationByTask(createdTaskId);
    assert.ok(authorization.consumedAt !== undefined, 'authorization consumed exactly once');
    const inspected = inspect(databasePath);
    assert.equal(inspected.authorizations, 1);
    assert.equal(inspected.launchAttempts, 1);
    assert.equal(inspected.invocations, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('08: bounded_autonomous within limits -> one launch', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-bounded-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    await runLoopOnce(store, GOAL, loopDeps()); // plan
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous', { maxCycles: 5, elapsedBudgetMs: 60_000 });

    const result = await runLoopOnce(store, GOAL, loopDeps({ launch: launchDeps() }));
    assert.equal(result.action, 'launched');
    assert.equal(store.get(createdTaskId).status, 'completed');
    assert.equal(store.readExecutionAuthorizationByTask(createdTaskId), undefined, 'no per-step authorization row in bounded mode');
    const inspected = inspect(databasePath);
    assert.equal(inspected.authorizations, 0);
    assert.equal(inspected.launchAttempts, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('09: missing authorization -> blocked', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-missing-auth-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    await runLoopOnce(store, GOAL, loopDeps()); // plan
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    // No authorization row.

    const result = await runLoopOnce(store, GOAL, loopDeps({ launch: launchDeps() }));
    assert.equal(result.action, 'held');
    assert.equal(result.blockingReason, 'autonomy_authorization_required');
    assert.equal(store.get(createdTaskId).status, 'accepted');
    assert.equal(inspect(databasePath).launchAttempts, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('10: revoked/expired/suspended -> blocked', async () => {
  async function scenario(prefix, mutate) {
    const { directory, databasePath } = await tempDatabase(prefix);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
      seedGoal(store);
      store.fail(ROOT, failure('codex_execution_failed'));
      await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
      await runLoopOnce(store, GOAL, loopDeps());
      const plan = store.listGoalContinuationPlans(GOAL)[0];
      const { createdTaskId } = materialize(store, plan.planId);
      setMode(store, GOAL, 'bounded_autonomous');
      mutate(store);
      const result = await runLoopOnce(store, GOAL, loopDeps({ launch: launchDeps() }));
      return { result, createdTaskId, databasePath, directory, store };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  {
    const { result, createdTaskId, databasePath, directory, store } = await scenario('lia-loop-suspend-', (s) => s.suspendGoalAutonomy(GOAL));
    try {
      assert.equal(result.action, 'none');
      assert.equal(result.blockingReason, 'autonomy_suspended');
      assert.equal(store.get(createdTaskId).status, 'accepted');
      assert.equal(inspect(databasePath).launchAttempts, 0);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  {
    const { result, createdTaskId, databasePath, directory, store } = await scenario('lia-loop-revoke-', (s) => s.revokeGoalAutonomy(GOAL));
    try {
      assert.equal(result.action, 'none');
      assert.equal(result.blockingReason, 'autonomy_policy_revoked');
      assert.equal(store.get(createdTaskId).status, 'accepted');
      assert.equal(inspect(databasePath).launchAttempts, 0);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  {
    const { directory, databasePath } = await tempDatabase('lia-loop-expire-');
    try {
      const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
      seedGoal(store);
      store.fail(ROOT, failure('codex_execution_failed'));
      await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
      await runLoopOnce(store, GOAL, loopDeps());
      const plan = store.listGoalContinuationPlans(GOAL)[0];
      const { createdTaskId } = materialize(store, plan.planId);
      setMode(store, GOAL, 'bounded_autonomous', { expiresAt: 2000 }); // valid at now=1000
      const result = await runLoopOnce(store, GOAL, loopDeps({ now: () => 3000, launch: launchDeps() })); // now past expiry
      assert.equal(result.action, 'none');
      assert.equal(result.blockingReason, 'autonomy_policy_expired');
      assert.equal(store.get(createdTaskId).status, 'accepted');
      assert.equal(inspect(databasePath).launchAttempts, 0);
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('11: no-progress occurrence 1 -> allowed to continue', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-noprog1-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    const evaluated = await runLoopOnce(store, GOAL, loopDeps({ now: clock, assessor: notDemonstratedAssessor }));
    assert.equal(evaluated.action, 'evaluated');
    assert.equal(evaluated.noProgressCount, 1);
    assert.equal(evaluated.escalated, false);

    clock.advance(1000);
    const planned = await runLoopOnce(store, GOAL, loopDeps({ now: clock }));
    assert.equal(planned.action, 'planned');
    assert.equal(planned.escalated, false);
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('12: no-progress occurrence 2 -> escalation gate (no new plan)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-noprog2-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ now: clock, assessor: notDemonstratedAssessor })); // eval 1 (count 1)
    clock.advance(1000);
    await runLoopOnce(store, GOAL, loopDeps({ now: clock })); // plan 1
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    // The continuation fails with the SAME no-progress signature.
    store.fail(createdTaskId, failure('codex_execution_failed'));
    clock.advance(1000);
    const evaluated2 = await runLoopOnce(store, GOAL, loopDeps({ now: clock, assessor: notDemonstratedAssessor }));
    assert.equal(evaluated2.action, 'evaluated');
    assert.equal(evaluated2.noProgressCount, 2);
    assert.equal(evaluated2.escalated, true);

    // Escalation gates planning with zero durable write.
    const escalated = await runLoopOnce(store, GOAL, loopDeps({ now: clock }));
    assert.equal(escalated.action, 'none');
    assert.equal(escalated.blockingReason, 'no_progress_escalation');
    assert.equal(escalated.humanInterventionRequired, true);
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 1, 'no second plan');
    assert.equal(store.listGoalAttempts(GOAL).length, 2, 'no third task');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('13: exhausted attempt budget -> terminal/gated', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-attempts-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store, { maxAttempts: 2 });
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // eval retryable (attempt 0)
    await runLoopOnce(store, GOAL, loopDeps()); // plan
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    store.fail(createdTaskId, failure('codex_execution_failed'));
    const evaluated = await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(evaluated.action, 'evaluated');
    assert.equal(store.readGoal(GOAL).status, 'exhausted');

    const after = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(after.stageBefore, 'exhausted');
    assert.equal(after.action, 'none');
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 1);
    assert.equal(store.listGoalAttempts(GOAL).length, 2);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('14: exhausted depth budget -> terminal/gated', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-depth-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store, { maxAttempts: 3, continuationDepthLimit: 1 });
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor })); // eval retryable
    await runLoopOnce(store, GOAL, loopDeps()); // plan (depth 1)
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    store.fail(createdTaskId, failure('codex_execution_failed'));
    const evaluated = await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(evaluated.action, 'evaluated');
    assert.equal(store.readGoal(GOAL).status, 'exhausted');
    const after = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(after.action, 'none');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('15: runLoopOnce advances at most one boundary; re-entry converges (exactly-once writes)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-once-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));

    // Boundary 1: evaluate.
    const r1 = await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(r1.stageBefore, 'task_terminal');
    assert.equal(r1.action, 'evaluated');
    assert.equal(r1.stageAfter, 'continuation_required');
    assert.equal(inspect(databasePath).evaluations, 1);

    // Boundary 2: plan.
    const r2 = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(r2.action, 'planned');
    assert.equal(inspect(databasePath).plans, 1);

    // Re-entry at the plan boundary must not duplicate the plan.
    const r3 = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(r3.stageBefore, 'authorization_required');
    assert.equal(r3.action, 'held');
    assert.equal(inspect(databasePath).plans, 1);

    // Boundary 3: materialize (exactly-once via consumed-plan branch).
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });
    const r4 = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(r4.action, 'materialized');
    assert.equal(inspect(databasePath).tasks, 2);

    // Re-materialization converges (consumed branch returns the existing task).
    const r5 = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(r5.stageBefore, 'next_attempt_accepted');
    assert.equal(r5.action, 'held'); // manual_only
    assert.equal(inspect(databasePath).tasks, 2);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('16: concurrent duplicate wakeups converge to a single transition', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-concurrent-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));

    // An async assessor forces interleaving between the two wakeups.
    const interleavingAssessor = createMechanicalGoalAssessor(() => ({
      goalSatisfaction: 'not_demonstrated',
      blocking: 'none',
      failure: 'retryable',
    }));
    const [a, b] = await Promise.all([
      runLoopOnce(store, GOAL, loopDeps({ assessor: interleavingAssessor })),
      runLoopOnce(store, GOAL, loopDeps({ assessor: interleavingAssessor })),
    ]);
    assert.equal(a.action, 'evaluated');
    assert.equal(b.action, 'evaluated');
    assert.equal(inspect(databasePath).evaluations, 1, 'exactly one applied evaluation');
    assert.equal(store.listGoalEvaluations(GOAL).filter((e) => e.appliedAt !== undefined).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('17: restart after every major boundary reconstructs the next action', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-restart-');
  let store;
  try {
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    store.close();

    // W4: before goal evaluation -> task_terminal -> evaluate.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    let result = await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(result.stageBefore, 'task_terminal');
    assert.equal(result.action, 'evaluated');
    store.close();

    // W5: after evaluation before planning -> continuation_required -> plan.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    result = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(result.stageBefore, 'continuation_required');
    assert.equal(result.action, 'planned');
    store.close();

    // W6: after plan before approval -> authorization_required -> hold.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    result = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(result.stageBefore, 'authorization_required');
    assert.equal(result.action, 'held');
    assert.equal(result.blockingReason, 'approval_required');

    // Approve, then restart before materialization.
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });
    store.close();

    // W7: after approval before materialization -> materializing_next_attempt.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    result = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(result.stageBefore, 'materializing_next_attempt');
    assert.equal(result.action, 'materialized');
    const createdTaskId = result.createdTaskId;
    assert.ok(createdTaskId);
    store.close();

    // W8: after materialization before execution -> next_attempt_accepted (manual_only hold).
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    result = await runLoopOnce(store, GOAL, loopDeps({ launch: launchDeps() }));
    assert.equal(result.stageBefore, 'next_attempt_accepted');
    assert.equal(result.action, 'held');
    assert.equal(result.blockingReason, 'autonomy_manual_only');

    // Authorize for a single step, then restart before launch.
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    store.close();

    // W2: after authorization before launch -> one launch exactly once.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    result = await runLoopOnce(store, GOAL, loopDeps({ launch: launchDeps() }));
    assert.equal(result.action, 'launched');
    assert.equal(store.get(createdTaskId).status, 'completed');
    assert.equal(inspect(databasePath).launchAttempts, 1);
    store.close();

    // W8: after known task result -> task_terminal -> evaluate.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    result = await runLoopOnce(store, GOAL, loopDeps({ assessor: satisfiedAssessor }));
    assert.equal(result.stageBefore, 'task_terminal');
    assert.equal(result.action, 'evaluated');
    assert.equal(store.readGoal(GOAL).status, 'completed');
    store.close();
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('18: unknown external launch outcome -> fail closed, never replay', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-unknown-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, GOAL, loopDeps());
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');
    // Cross the launch boundary without recording a result.
    crossLaunchBoundary(store, createdTaskId);

    const details = deriveLoopStageDetails(store, GOAL, loopDeps());
    assert.equal(details.stage, 'failed_closed');
    assert.equal(details.blockingReason, 'external_launch_outcome_unknown');
    assert.equal(details.ambiguousOutcome, true);

    const result = await runLoopOnce(store, GOAL, loopDeps({ launch: launchDeps() }));
    assert.equal(result.action, 'none');
    assert.equal(result.blockingReason, 'external_launch_outcome_unknown');
    // At-most-once: the loop never relaunches across the ambiguous boundary.
    assert.equal(inspect(databasePath).launchAttempts, 1, 'no second launch attempt');
    assert.equal(store.get(createdTaskId).status, 'accepted');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('19: known durable result -> never rerun executor', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-known-');
  try {
    let executions = 0;
    const countingLaunch = launchDeps({
      executeWorkflow: async () => {
        executions += 1;
        return workflowOk;
      },
    });
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, GOAL, loopDeps());
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');

    const launched = await runLoopOnce(store, GOAL, loopDeps({ launch: countingLaunch }));
    assert.equal(launched.action, 'launched');
    assert.equal(executions, 1);
    assert.equal(store.get(createdTaskId).status, 'completed');

    // The task is terminal with a durable result; the loop must never rerun the executor.
    const next = await runLoopOnce(store, GOAL, loopDeps({ launch: countingLaunch, assessor: satisfiedAssessor }));
    assert.equal(next.action, 'evaluated');
    assert.equal(executions, 1, 'executor ran exactly once');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('20: capability ceiling preserved across the loop', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-cap-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, GOAL, loopDeps());
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    const task = store.get(createdTaskId);
    // Inherited capabilities are a subset of the ceiling and disjoint from the forbidden set.
    for (const capability of task.intent.requestedCapabilities) {
      assert.ok(AUTONOMOUS_V1_CEILING.includes(capability), `${capability} inside ceiling`);
      assert.ok(!AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES.includes(capability), `${capability} not forbidden`);
    }
    assert.deepEqual(
      task.intent.requestedCapabilities,
      store.get(ROOT).intent.requestedCapabilities,
      'capabilities inherited exactly from the parent',
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('21: requiresHumanApproval / blockedActions are never bypassed by the loop', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-blocked-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    // The loop never grants execution authority on its own; the human gate
    // (approval / authorization) is the only path and is never manufactured.
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, GOAL, loopDeps());
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');

    // With no launch dependencies, the loop can never manufacture an authorization.
    const result = await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(result.action, 'held');
    assert.equal(result.blockingReason, 'launch_dependencies_missing');
    assert.equal(store.get(createdTaskId).status, 'accepted');
    assert.equal(inspect(databasePath).launchAttempts, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('22: blockedActions stay forbidden (loop can never grant production authority)', async () => {
  const source = stripComments(await readFile(new URL('../src/services/projectBoundedAutonomousLoopRuntime.ts', import.meta.url), 'utf8'));
  // The loop never references a forbidden capability identifier (as a quoted
  // capability name) anywhere in its code; `results.push(...)` is a plain array
  // method, not a capability grant.
  const quoted = (word) => source.includes(`'${word}'`) || source.includes(`"${word}"`);
  for (const forbidden of ['push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access']) {
    assert.ok(!quoted(forbidden), `loop source must not reference capability '${forbidden}'`);
  }
  assert.ok(!source.includes('child_process'));
  assert.ok(!source.includes('spawn'));
  assert.ok(!source.includes('exec('));
});

test('23: loop imports no second execution engine', async () => {
  const source = stripComments(await readFile(new URL('../src/services/projectBoundedAutonomousLoopRuntime.ts', import.meta.url), 'utf8'));
  assert.ok(!source.includes('runProjectTaskDurableExecution'), 'loop never calls the runner directly');
  assert.ok(!source.includes('projectTaskDurableExecutionRunner'), 'loop never imports the runner');
  assert.ok(!source.includes('projectTaskWorkflowService'));
  assert.ok(!source.includes('hermesSupervisorExecutor'));
  assert.ok(!source.includes('projectCodexExecutor'));
  assert.ok(!source.includes('hermesExecutor'));
  assert.ok(source.includes('launchContinuationTaskIfEligible'), 'the single authority path');
});

test('24: loop has no while/timer/polling scheduler', async () => {
  const source = stripComments(await readFile(new URL('../src/services/projectBoundedAutonomousLoopRuntime.ts', import.meta.url), 'utf8'));
  assert.ok(!/\bwhile\b/.test(source), 'no while loop');
  assert.ok(!source.includes('setInterval'));
  assert.ok(!source.includes('setTimeout'));
  assert.ok(!source.includes('setImmediate'));
});

test('25: safe operator evidence', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-evidence-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.fail(ROOT, failure('codex_execution_failed'));
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));

    const evidence = buildLoopRuntimeEvidence(store, GOAL, loopDeps());
    assert.equal(evidence.goalId, GOAL);
    assert.equal(evidence.derivedLoopStage, 'continuation_required');
    assert.equal(evidence.goalEvaluation.decision, 'retryable');
    assert.equal(evidence.goalEvaluation.reasonCode, 'execution_failed');
    assert.equal(evidence.currentTask.taskId, ROOT);
    assert.equal(evidence.currentTask.status, 'failed');
    assert.equal(evidence.budget.maxAttempts, 3);
    assert.equal(evidence.terminal, false);

    // No secret / capability-bearing field may be exposed.
    const serialized = JSON.stringify(evidence);
    for (const forbidden of ['command', 'commands', 'prompt', 'path', 'sessionId', 'capabilities', 'secret', 'credential', 'worktree']) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `evidence must not expose ${forbidden}`);
    }
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('26: no production/push/merge/deploy authority (loop + forbidden set intact)', async () => {
  const source = stripComments(await readFile(new URL('../src/services/projectBoundedAutonomousLoopRuntime.ts', import.meta.url), 'utf8'));
  const quoted = (word) => source.includes(`'${word}'`) || source.includes(`"${word}"`);
  for (const forbidden of ['production_write', 'push', 'merge', 'deploy', 'database_write', 'secret_access']) {
    assert.ok(!quoted(forbidden), `loop must not grant '${forbidden}'`);
  }
  // Forbidden set remains the backend-owned constant (unchanged).
  assert.deepEqual(
    [...AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES].sort(),
    ['push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access'].sort(),
  );
});

test('27: no real continuation execution outside the isolated test seam', async () => {
  const source = stripComments(await readFile(new URL('../src/services/projectBoundedAutonomousLoopRuntime.ts', import.meta.url), 'utf8'));
  // The loop composes launchContinuationTaskIfEligible only; the real
  // Hermes/Codex executors are unreachable from the loop.
  assert.ok(!source.includes('hermesSupervisorExecutor'));
  assert.ok(!source.includes('projectCodexExecutor'));
  assert.ok(!source.includes('executeHermesReasoningOnly'));
  assert.ok(!source.includes('projectTaskWorkflowService'));
});

test('listActiveGoals returns only active goals', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-list-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store, { goalId: GOAL, taskId: ROOT });
    seedGoal(store, { goalId: OTHER_GOAL, taskId: OTHER_ROOT });
    store.complete(OTHER_ROOT, committedReceipt());
    await runLoopOnce(store, OTHER_GOAL, loopDeps({ assessor: satisfiedAssessor })); // completes OTHER_GOAL

    const active = store.listActiveGoals();
    assert.deepEqual(active.map((goal) => goal.goalId), [GOAL]);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconcileLoopTick advances each active goal by at most one boundary and stops', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-tick-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store, { goalId: GOAL, taskId: ROOT });
    seedGoal(store, { goalId: OTHER_GOAL, taskId: OTHER_ROOT });
    store.fail(ROOT, failure('codex_execution_failed'));
    store.fail(OTHER_ROOT, failure('codex_execution_failed'));

    const results = await reconcileLoopTick(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(results.length, 2);
    for (const { result } of results) {
      assert.equal(result.action, 'evaluated');
      assert.equal(result.stageAfter, 'continuation_required');
    }
    // Each goal advanced exactly one boundary: one evaluation each, no plan yet.
    assert.equal(store.listGoalEvaluations(GOAL).length, 1);
    assert.equal(store.listGoalEvaluations(OTHER_GOAL).length, 1);
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
    assert.equal(store.listGoalContinuationPlans(OTHER_GOAL).length, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deriveLoopStage exposes the full derived vocabulary', async () => {
  const { directory, databasePath } = await tempDatabase('lia-loop-stage-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    // Missing goal.
    assert.equal(deriveLoopStage(store, GOAL, loopDeps()), 'goal_missing');
    seedGoal(store);
    // Active root accepted, not launched -> awaiting_execution.
    assert.equal(deriveLoopStage(store, GOAL, loopDeps()), 'awaiting_execution');
    store.fail(ROOT, failure('codex_execution_failed'));
    assert.equal(deriveLoopStage(store, GOAL, loopDeps()), 'task_terminal');
    await runLoopOnce(store, GOAL, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(deriveLoopStage(store, GOAL, loopDeps()), 'continuation_required');
    await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(deriveLoopStage(store, GOAL, loopDeps()), 'authorization_required');
    const plan = store.listGoalContinuationPlans(GOAL)[0];
    store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });
    assert.equal(deriveLoopStage(store, GOAL, loopDeps()), 'materializing_next_attempt');
    await runLoopOnce(store, GOAL, loopDeps());
    assert.equal(deriveLoopStage(store, GOAL, loopDeps()), 'next_attempt_accepted');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
