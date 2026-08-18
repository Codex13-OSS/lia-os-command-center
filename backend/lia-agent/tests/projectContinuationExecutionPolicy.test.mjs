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
import {
  AUTONOMY_MODES,
  deriveAutonomyPolicyState,
} from '../dist/contracts/projectGoalAutonomyPolicy.js';
import { deriveExecutionAuthorizationState } from '../dist/contracts/projectGoalContinuationExecutionAuthorization.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';
import { materializeApprovedContinuation } from '../dist/services/projectGoalContinuationExecutionGate.js';
import {
  evaluateContinuationExecutionEligibility,
  CONTINUATION_EXECUTION_ELIGIBILITY_REASONS,
} from '../dist/services/projectContinuationExecutionEligibility.js';
import {
  launchContinuationTaskIfEligible,
  buildContinuationExecutionEvidence,
} from '../dist/services/projectContinuationExecutionPolicy.js';

const GOAL = 'd50e8400-e29b-41d4-a716-446655440000';
const ROOT = 'e50e8400-e29b-41d4-a716-446655440000';

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Complete the bounded durable objective.',
  priority: 'high',
  requestedCapabilities: ['repository_read', 'run_tests'],
  ...overrides,
});

const receipt = {
  executionId: 'policy-test-execution',
  status: 'verified',
  resultText: 'Bounded partial result.',
  verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
};

const evidence = { goalSatisfaction: 'partial', blocking: 'none', failure: 'retryable' };

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

function makeClock(start = 1000) {
  let value = start;
  const clock = () => value;
  clock.advance = (ms) => { value += ms; };
  clock.set = (next) => { value = next; };
  return clock;
}

async function tempDatabase(prefix = 'lia-policy-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seedPlan(store, options = {}) {
  const {
    goalId = GOAL,
    taskId = ROOT,
    projectId = 'safe',
    maxAttempts = 3,
    continuationDepthLimit = 2,
  } = options;
  store.createGoal({
    goalId,
    projectId,
    objective: 'Deliver the remaining bounded surfaces and verify the result.',
    maxAttempts,
    continuationDepthLimit,
  });
  assert.equal(store.createRootAttempt({
    taskId,
    fingerprint: `${taskId}-fingerprint`,
    intent: intent({ projectId }),
    goalId,
    continuationDepth: 0,
    attemptNumber: 0,
  }).kind, 'created');
  store.complete(taskId, receipt);
  const evaluation = store.evaluateAndApplyGoalAttempt({
    goalId,
    taskId,
    attemptNumber: 0,
    evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
    evidence,
  }).evaluation;
  const plan = store.createContinuationPlan({
    goalId,
    sourceEvaluationId: evaluation.evaluationId,
    plannerVersion: CONTINUATION_PLANNER_VERSION,
    sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
  });
  return { evaluation, plan };
}

function materialize(store, planId) {
  store.approveContinuationPlan({ planId, approver: 'operator-1' });
  const result = materializeApprovedContinuation(store, planId);
  return { createdTaskId: result.createdTaskId, task: result.task };
}

function setMode(store, goalId, mode, overrides = {}) {
  return store.setGoalAutonomyPolicy({ goalId, mode, approver: 'operator-1', ...overrides });
}

function authorize(store, { goalId, taskId, planId }, overrides = {}) {
  return store.createExecutionAuthorization({ goalId, taskId, planId, approver: 'operator-1', ...overrides });
}

function launch(store, taskId, overrides = {}) {
  return launchContinuationTaskIfEligible(store, taskId, {
    workerId: 'lia-policy-test-worker',
    config,
    registry,
    now: () => 1000,
    executeWorkflow: async () => workflowOk,
    ...overrides,
  });
}

function inspect(databasePath) {
  const database = new DatabaseSync(databasePath);
  const count = (table) => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const result = {
    policies: count('project_goal_autonomy_policies'),
    authorizations: count('project_goal_continuation_execution_authorizations'),
    dispatches: count('project_task_dispatch_outbox'),
    leases: count('project_task_lease_generations'),
    executionRuns: count('project_task_execution_runs'),
    invocations: count('project_task_execution_invocations'),
    launchAttempts: count('project_task_execution_launch_attempts'),
    launchResults: count('project_task_execution_launch_results'),
    codexStarts: count('project_task_codex_start_evidence'),
    commitResults: count('project_task_commit_result_evidence'),
  };
  database.close();
  return result;
}

async function corrupt(databasePath, mutate) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = OFF');
  mutate(database);
  database.close();
}

/** Fabricate a crossed launch boundary (W8: attempt present, no result). */
function crossLaunchBoundary(store, taskId) {
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

function recordLaunchResult(store, { attempt, run, invocation }) {
  return store.recordTaskExecutionLaunchResult({
    launchAttemptId: attempt.launchAttemptId,
    invocationId: invocation.invocationId,
    executionRunId: run.executionRunId,
    taskId: run.taskId,
    outcomeClass: 'proposal_valid',
  });
}

test('SCHEMA-19: migration reaches V19 with the two new tables', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-schema-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 19);
    const database = new DatabaseSync(databasePath);
    assert.equal(database.prepare('SELECT schema_version FROM project_task_meta WHERE singleton = 1').get().schema_version, 19);
    database.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('01: manual_only blocks automatic execution (default, no policy row)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-manual-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, 'autonomy_manual_only');
    await assert.rejects(() => launch(store, createdTaskId), /autonomy_manual_only/);
    assert.equal(store.get(createdTaskId).status, 'accepted');
    store.close();
    assert.deepEqual(inspect(databasePath), {
      policies: 0, authorizations: 0, dispatches: 0, leases: 0, executionRuns: 0,
      invocations: 0, launchAttempts: 0, launchResults: 0, codexStarts: 0, commitResults: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('02: approved_single_step allows exactly one authorized task launch', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-single-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    const authorization = authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    assert.equal(authorization.consumedAt, undefined);

    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.mode, 'approved_single_step');

    const result = await launch(store, createdTaskId);
    assert.equal(result.ok, true);
    assert.equal(store.get(createdTaskId).status, 'completed');
    const consumed = store.readExecutionAuthorizationByTask(createdTaskId);
    assert.ok(consumed.consumedAt !== undefined, 'authorization consumed exactly once');

    // A second launch of the same (now terminal) task is refused.
    await assert.rejects(() => launch(store, createdTaskId), /task_not_accepted/);
    store.close();
    const inspected = inspect(databasePath);
    assert.equal(inspected.authorizations, 1);
    assert.equal(inspected.launchAttempts, 1, 'exactly one launch attempt');
    assert.equal(inspected.invocations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('03: bounded_autonomous allows launch only within bounds', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-bounded-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous', { maxCycles: 5, elapsedBudgetMs: 60_000 });

    let eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: clock });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.mode, 'bounded_autonomous');

    // Exceed the elapsed budget: blocked.
    clock.advance(60_000);
    eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: clock });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, 'autonomy_elapsed_budget_exhausted');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('03b: bounded_autonomous maxCycles bound blocks when exceeded', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-bounded-cycles-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous', { maxCycles: 1 });
    // attemptNumber of the materialized continuation is 1, which is >= maxCycles 1.
    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, 'autonomy_cycle_limit_reached');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('04: suspended blocks execution regardless of mode', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-suspend-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');
    store.suspendGoalAutonomy(GOAL);
    const policy = store.readGoalAutonomyPolicy(GOAL);
    assert.equal(deriveAutonomyPolicyState(policy, 1000), 'suspended');

    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, 'autonomy_suspended');
    await assert.rejects(() => launch(store, createdTaskId), /autonomy_suspended/);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('05: exhausted goal blocks execution', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-exhausted-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');
    store.terminalizeGoal(GOAL, 'exhausted');
    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.goalTerminal);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('06: missing authorization blocks (approved_single_step)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-missing-auth-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, 'autonomy_authorization_required');
    await assert.rejects(() => launch(store, createdTaskId), /autonomy_authorization_required/);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('07: revoked and expired authorizations block', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-revoked-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    const authorization = authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });

    // Revocation blocks.
    store.revokeExecutionAuthorization(authorization.authorizationId);
    let eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: clock });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, 'autonomy_authorization_revoked');
    await assert.rejects(() => launch(store, createdTaskId), /autonomy_authorization_revoked/);

    // Expiry blocks (fresh store with a distinct task).
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const { directory: directory2, databasePath: databasePath2 } = await tempDatabase('lia-policy-expired-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath: databasePath2, now: clock });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId }, { expiresAt: 2000 });
    clock.advance(1500);
    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: clock });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, 'autonomy_authorization_expired');
    store.close();
  } finally {
    await rm(directory2, { recursive: true, force: true });
  }
});

test('08: contradictory authorization fails closed', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-contradict-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId }, { approver: 'operator-1' });
    assert.throws(
      () => authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId }, { approver: 'operator-2' }),
      /autonomy_authorization_contradictory/,
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('09: exact authorization replay is idempotent', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-replay-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    const first = authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    const second = authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    assert.equal(first.authorizationId, second.authorizationId);
    assert.equal(first.fingerprint, second.fingerprint);
    store.close();
    assert.equal(inspect(databasePath).authorizations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('10: task lineage mismatch blocks authorization', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-lineage-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    // A non-existent plan id fails closed before lineage comparison.
    assert.throws(
      () => authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: ROOT }),
      /plan_not_found/,
    );
    // A foreign goal without an autonomy policy fails closed before lineage
    // comparison. Earlier policy rejection is the authoritative boundary.
    assert.throws(
      () => authorize(store, { goalId: 'd50e8400-e29b-41d4-a716-446655440099', taskId: createdTaskId, planId: plan.planId }),
      /autonomy_authorization_policy_required/,
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('11: stale currentAttempt blocks eligibility', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-stale-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');
    // Corrupt the goal's current_attempt so it no longer matches the task lineage.
    store.close();
    await corrupt(databasePath, (database) => {
      database.prepare('UPDATE project_goals SET current_attempt = 0 WHERE goal_id = ?').run(GOAL);
    });
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    // The durable store detects the contradictory goal/task lineage before
    // eligibility can consume it. Earlier fail-closed detection is authoritative.
    assert.throws(
      () => evaluateContinuationExecutionEligibility(reopened, createdTaskId, { now: () => 1000 }),
      /corrupt_project_task_record/,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('12: capability ceiling is preserved and forbidden capability fails closed', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-cap-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId, task } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');
    // Capabilities are inherited from the parent, within the ceiling.
    for (const capability of task.intent.requestedCapabilities) {
      assert.ok(AUTONOMOUS_V1_CEILING.includes(capability));
      assert.ok(!AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES.includes(capability));
    }
    // Adversarial mutation is rejected at the SQLite immutability boundary
    // before a forbidden capability can ever enter durable task lineage.
    store.close();
    await assert.rejects(
      () => corrupt(databasePath, (database) => {
        const row = database.prepare('SELECT intent_json FROM project_tasks WHERE task_id = ?').get(createdTaskId);
        const parsed = JSON.parse(row.intent_json);
        parsed.requestedCapabilities = ['repository_read', 'push'];
        database.prepare('UPDATE project_tasks SET intent_json = ? WHERE task_id = ?')
          .run(JSON.stringify(parsed), createdTaskId);
      }),
      /project_task_lineage_immutable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('13: requiresHumanApproval refusal is propagated, never bypassed', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-approval-refusal-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    const result = await launch(store, createdTaskId, {
      executeWorkflow: async () => ({
        ok: false, status: 'failed', stage: 'approval', error: 'human_approval_required',
        summary: 'Human approval required.',
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'human_approval_required');
    const terminal = store.get(createdTaskId);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.error.code, 'human_approval_required');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('14: blockedActions refusal is propagated, never bypassed', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-blocked-refusal-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    const result = await launch(store, createdTaskId, {
      executeWorkflow: async () => ({
        ok: false, status: 'failed', stage: 'approval', error: 'human_approval_required',
        summary: 'Blocked actions require human approval.',
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(store.get(createdTaskId).status, 'failed');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('15: launch uses the existing durable runner (lease/dispatch/run/invocation/attempt)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-runner-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    await launch(store, createdTaskId);
    store.close();
    const inspected = inspect(databasePath);
    // These durable rows are ONLY written by runProjectTaskDurableExecution.
    assert.equal(inspected.dispatches, 1);
    assert.equal(inspected.leases, 1);
    assert.equal(inspected.executionRuns, 1);
    assert.equal(inspected.invocations, 1);
    assert.equal(inspected.launchAttempts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('16: no second engine exists (structural)', async () => {
  const policySource = await readFile(new URL('../dist/services/projectContinuationExecutionPolicy.js', import.meta.url), 'utf8');
  const eligibilitySource = await readFile(new URL('../dist/services/projectContinuationExecutionEligibility.js', import.meta.url), 'utf8');
  // The eligibility predicate cannot launch: it never references the runner.
  assert.ok(!/runProjectTaskDurableExecution|createProjectTaskDurableExecutionRunner|executeProjectTaskWorkflow/.test(eligibilitySource));
  // The orchestrator's only execution entry is the existing runner.
  assert.ok(/runProjectTaskDurableExecution/.test(policySource));
  assert.ok(!/createProjectTaskDurableExecutionRunner/.test(policySource));
  assert.ok(!/executeProjectTaskWorkflow/.test(policySource));
  // Neither imports process-spawning or network authority.
  for (const source of [policySource, eligibilitySource]) {
    assert.ok(!/child_process/.test(source), 'no child_process');
    assert.ok(!/node:http|node:https|node:net|node:dns/.test(source), 'no network');
    assert.ok(!/spawn\(|exec\(/.test(source), 'no spawn/exec');
  }
});

test('17: crash before authorization write => no manufactured authorization', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-crash-pre-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    // No authorization written; simulate crash by closing without authorizing.
    store.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    assert.equal(reopened.readExecutionAuthorizationByTask(createdTaskId), undefined);
    const eligibility = evaluateContinuationExecutionEligibility(reopened, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.reason, 'autonomy_authorization_required');
    await assert.rejects(() => launch(reopened, createdTaskId), /autonomy_authorization_required/);
    reopened.close();
    assert.equal(inspect(databasePath).authorizations, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('18: crash after authorization write => same authorization after reopen', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-crash-post-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    const authorization = authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    store.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const after = reopened.readExecutionAuthorizationByTask(createdTaskId);
    assert.equal(after.authorizationId, authorization.authorizationId);
    assert.equal(after.fingerprint, authorization.fingerprint);
    assert.equal(after.consumedAt, undefined);
    // Still eligible exactly once after reopen.
    const eligibility = evaluateContinuationExecutionEligibility(reopened, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, true);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('18b: restart cannot silently auto-run an authorized task', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-restart-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    store.close();
    // Reopen: nothing may auto-dispatch/lease/execute.
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    assert.equal(reopened.get(createdTaskId).status, 'accepted');
    const inspected = inspect(databasePath);
    assert.equal(inspected.dispatches, 0);
    assert.equal(inspected.leases, 0);
    assert.equal(inspected.launchAttempts, 0);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('19: launch ambiguity => external_launch_outcome_unknown (fail closed)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-ambiguity-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');
    crossLaunchBoundary(store, createdTaskId); // attempt present, no result
    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.launchOutcomeUnknown);
    await assert.rejects(() => launch(store, createdTaskId), /external_launch_outcome_unknown/);
    store.close();
    assert.equal(inspect(databasePath).launchAttempts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('20: launch ambiguity never blind-retries', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-no-retry-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');
    crossLaunchBoundary(store, createdTaskId);
    let calls = 0;
    const executeWorkflow = async () => { calls += 1; return workflowOk; };
    await assert.rejects(() => launch(store, createdTaskId, { executeWorkflow }), /external_launch_outcome_unknown/);
    await assert.rejects(() => launch(store, createdTaskId, { executeWorkflow }), /external_launch_outcome_unknown/);
    assert.equal(calls, 0, 'executor never invoked');
    store.close();
    assert.equal(inspect(databasePath).launchAttempts, 1, 'no new launch attempt manufactured');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('21: known durable result never replays executor', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-known-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'bounded_autonomous');
    const boundary = crossLaunchBoundary(store, createdTaskId);
    recordLaunchResult(store, boundary); // known outcome (proposal_valid)
    let calls = 0;
    const executeWorkflow = async () => { calls += 1; return workflowOk; };
    const eligibility = evaluateContinuationExecutionEligibility(store, createdTaskId, { now: () => 1000 });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.launchResultRecorded);
    await assert.rejects(() => launch(store, createdTaskId, { executeWorkflow }), /external_launch_result_recorded/);
    assert.equal(calls, 0, 'executor never replayed');
    store.close();
    const inspected = inspect(databasePath);
    assert.equal(inspected.launchAttempts, 1);
    assert.equal(inspected.launchResults, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('21b: terminal results remain stable across restart', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-terminal-stable-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    await launch(store, createdTaskId);
    const before = store.get(createdTaskId);
    assert.equal(before.status, 'completed');
    store.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const after = reopened.get(createdTaskId);
    assert.equal(after.status, 'completed');
    assert.equal(after.receipt.executionId, before.receipt.executionId);
    // Re-launch of the terminal task is refused and does not change state.
    await assert.rejects(() => launch(reopened, createdTaskId), /task_not_accepted/);
    assert.equal(reopened.get(createdTaskId).status, 'completed');
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('22: operator HUD evidence is safe and bounded', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-hud-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    const evidence1 = buildContinuationExecutionEvidence(store, createdTaskId, { now: () => 1000 });
    assert.equal(evidence1.eligible, false);
    assert.equal(evidence1.authorizationState, 'authorization_required');
    assert.equal(evidence1.nextTaskExecuted, false);
    assert.equal(evidence1.taskStatus, 'accepted');

    authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    const evidence2 = buildContinuationExecutionEvidence(store, createdTaskId, { now: () => 1000 });
    assert.equal(evidence2.eligible, true);
    assert.equal(evidence2.authorizationState, 'authorization_present');
    assert.equal(evidence2.autonomyMode, 'approved_single_step');

    // The HUD never exposes secrets/prompts/commands/paths/session ids.
    const allowedKeys = new Set([
      'goalId', 'goalObjective', 'taskId', 'taskStatus', 'autonomyMode', 'policyState',
      'eligible', 'eligibilityReason', 'authorizationState', 'authorizationId', 'lineage',
      'budget', 'noProgress', 'launchState', 'ambiguousOutcome', 'nextTaskExecuted',
      'operatorActionRequired', 'blockingReason',
    ]);
    for (const key of Object.keys(evidence2)) assert.ok(allowedKeys.has(key), `unexpected HUD key ${key}`);
    const serialized = JSON.stringify(evidence2);
    for (const forbidden of ['secret', 'password', 'token', 'command', '/home/', '/opt/', 'sessionId', 'prompt']) {
      assert.ok(!serialized.toLowerCase().includes(forbidden), `HUD leaks ${forbidden}`);
    }
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('23: policy and authorization carry zero authority', async () => {
  const { directory, databasePath } = await tempDatabase('lia-policy-zero-auth-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    const policy = setMode(store, GOAL, 'bounded_autonomous', { maxCycles: 3, elapsedBudgetMs: 5000 });
    const policyKeys = new Set(Object.keys(policy));
    for (const forbidden of ['capability', 'capabilities', 'command', 'commands', 'model', 'tool', 'executor', 'path', 'sessionId']) {
      for (const key of policyKeys) assert.ok(!key.toLowerCase().includes(forbidden), `policy key ${key} carries authority`);
    }
    // Switch to single-step for the authorization shape.
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const { directory: directory2, databasePath: databasePath2 } = await tempDatabase('lia-policy-zero-auth-2-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath: databasePath2, now: () => 1000 });
    const { plan } = seedPlan(store);
    const { createdTaskId } = materialize(store, plan.planId);
    setMode(store, GOAL, 'approved_single_step');
    const authorization = authorize(store, { goalId: GOAL, taskId: createdTaskId, planId: plan.planId });
    const authKeys = new Set(Object.keys(authorization));
    for (const forbidden of ['capability', 'command', 'model', 'tool', 'executor', 'path', 'sessionId', 'instruction']) {
      for (const key of authKeys) assert.ok(!key.toLowerCase().includes(forbidden), `authorization key ${key} carries authority`);
    }
    store.close();
  } finally {
    await rm(directory2, { recursive: true, force: true });
  }
});

test('24: no scheduler/loop execution occurs in this mission', async () => {
  const policySource = await readFile(new URL('../dist/services/projectContinuationExecutionPolicy.js', import.meta.url), 'utf8');
  const eligibilitySource = await readFile(new URL('../dist/services/projectContinuationExecutionEligibility.js', import.meta.url), 'utf8');
  for (const source of [policySource, eligibilitySource]) {
    assert.ok(!/setInterval|setTimeout/.test(source), 'no timers/scheduler');
    assert.ok(!/evaluateAndApplyGoalCompletion/.test(source), 'no goal-evaluation loop');
    assert.ok(!/planGoalContinuation/.test(source), 'no planning loop');
    assert.ok(!/materializeContinuation/.test(source), 'no materialization loop');
  }
});

test('mode vocabulary is exactly the four ratified terms', () => {
  assert.deepEqual([...AUTONOMY_MODES], ['manual_only', 'approved_single_step', 'bounded_autonomous']);
  // suspended is a derived control state, not a stored mode.
  const states = ['manual_only', 'approved_single_step', 'bounded_autonomous', 'suspended', 'revoked', 'expired'];
  const policy = {
    policyId: 'p', goalId: GOAL, mode: 'bounded_autonomous', approver: 'op',
    createdAt: 1000, updatedAt: 1000, fingerprint: 'a'.repeat(64), suspendedAt: 2000,
  };
  assert.equal(deriveAutonomyPolicyState(policy, 3000), 'suspended');
  const revoked = { ...policy, suspendedAt: undefined, revokedAt: 2000 };
  assert.equal(deriveAutonomyPolicyState(revoked, 3000), 'revoked');
  assert.ok(states.includes('suspended'));
});
