import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { CONTINUATION_PLANNER_VERSION } from '../dist/contracts/projectGoalContinuationPlan.js';
import { PROJECT_GOAL_EVALUATOR_VERSION } from '../dist/contracts/projectGoalEvaluation.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import {
  CONTINUATION_APPROVAL_DEFAULT_TTL_MS,
  deriveContinuationApprovalState,
} from '../dist/contracts/projectGoalContinuationApproval.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';
import {
  materializeApprovedContinuation,
  buildContinuationGateEvidence,
  assertNoForbiddenAuthority,
} from '../dist/services/projectGoalContinuationExecutionGate.js';

const GOAL = 'd50e8400-e29b-41d4-a716-446655440000';
const GOAL2 = 'd50e8400-e29b-41d4-a716-446655440001';
const ROOT = 'e50e8400-e29b-41d4-a716-446655440000';

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Complete the bounded durable objective.',
  priority: 'high',
  requestedCapabilities: ['repository_read', 'run_tests'],
  ...overrides,
});

const receipt = {
  executionId: 'gate-test-execution',
  status: 'verified',
  resultText: 'Bounded partial result.',
  verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
};

const evidence = {
  goalSatisfaction: 'partial',
  blocking: 'none',
  failure: 'retryable',
};

function makeClock(start = 1000) {
  let value = start;
  const clock = () => value;
  clock.advance = (ms) => { value += ms; };
  clock.set = (next) => { value = next; };
  return clock;
}

async function tempDatabase(prefix = 'lia-gate-') {
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

function approve(store, planId, overrides = {}) {
  return store.approveContinuationPlan({ planId, approver: 'operator-1', ...overrides });
}

function inspect(databasePath) {
  const database = new DatabaseSync(databasePath);
  const count = (table) => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const result = {
    tasks: count('project_tasks'),
    lineage: count('project_task_lineage'),
    consumptions: count('project_goal_continuation_consumptions'),
    approvals: count('project_goal_continuation_approvals'),
    dispatches: count('project_task_dispatch_outbox'),
    leases: count('project_task_lease_generations'),
    executionRuns: count('project_task_execution_runs'),
    invocations: count('project_task_execution_invocations'),
    launchAttempts: count('project_task_execution_launch_attempts'),
    launchResults: count('project_task_execution_launch_results'),
    verificationStarts: count('project_task_verification_start_evidence'),
    verificationResults: count('project_task_verification_result_evidence'),
    commitStarts: count('project_task_commit_start_evidence'),
    commitResults: count('project_task_commit_result_evidence'),
    codexStarts: count('project_task_codex_start_evidence'),
    codexResults: count('project_task_codex_result_evidence'),
    currentAttempt: database.prepare('SELECT current_attempt FROM project_goals WHERE goal_id = ?').get(GOAL).current_attempt,
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

const NO_EXECUTION_TABLES = [
  'dispatches', 'leases', 'executionRuns', 'invocations', 'launchAttempts',
  'launchResults', 'verificationStarts', 'verificationResults', 'commitStarts',
  'commitResults', 'codexStarts', 'codexResults',
];

function assertZeroExecution(inspected) {
  for (const key of NO_EXECUTION_TABLES) {
    assert.equal(inspected[key], 0, `${key} must be zero for the new task`);
  }
}

test('EG-01: no approval -> materialization refused (approval_required), zero writes, zero execution', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-no-approval-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    assert.throws(() => materializeApprovedContinuation(store, plan.planId), /approval_required/);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
    store.close();
    assert.deepEqual(inspect(databasePath), {
      tasks: 1, lineage: 1, consumptions: 0, approvals: 0,
      dispatches: 0, leases: 0, executionRuns: 0, invocations: 0,
      launchAttempts: 0, launchResults: 0, verificationStarts: 0,
      verificationResults: 0, commitStarts: 0, commitResults: 0,
      codexStarts: 0, codexResults: 0, currentAttempt: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-02: valid approval materializes exactly one accepted task with parent-inherited capabilities', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-valid-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    const result = materializeApprovedContinuation(store, plan.planId);
    assert.equal(result.planId, plan.planId);
    assert.equal(result.createdTaskId, result.task.taskId);
    assert.equal(result.task.status, 'accepted');
    assert.equal(result.task.intent.projectId, 'safe');
    assert.equal(result.task.intent.instruction, plan.instruction);
    assert.equal(result.task.intent.priority, 'high');
    assert.deepEqual(result.task.intent.requestedCapabilities, ['repository_read', 'run_tests']);
    assert.equal('approvedCapabilities' in result.task.intent, false);
    assert.equal('effectiveCapabilities' in result.task.intent, false);
    assert.deepEqual(result.task.lineage, {
      goalId: GOAL, parentTaskId: ROOT, continuationDepth: 1, attemptNumber: 1,
    });
    assert.equal(store.readGoal(GOAL).currentAttempt, 1);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'consumed');
    assert.equal(store.readContinuationPlan(plan.planId).createdTaskId, result.createdTaskId);
    store.close();
    const inspected = inspect(databasePath);
    assert.equal(inspected.tasks, 2);
    assert.equal(inspected.consumptions, 1);
    assert.equal(inspected.approvals, 1);
    assertZeroExecution(inspected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-03: exact approval replay is idempotent (same durable approval identity)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-approval-replay-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const first = approve(store, plan.planId);
    const second = approve(store, plan.planId);
    assert.equal(second.approvalId, first.approvalId);
    assert.deepEqual(second, first);
    store.close();
    assert.equal(inspect(databasePath).approvals, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-04: contradictory approval replay fails closed and preserves the original', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-approval-contradiction-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const original = approve(store, plan.planId);
    assert.throws(() => approve(store, plan.planId, { approver: 'operator-2' }), /contradictory/);
    assert.throws(
      () => approve(store, plan.planId, { expiresAt: 2000 }),
      /contradictory/,
    );
    assert.deepEqual(store.readContinuationApproval(plan.planId), original);
    assert.equal(store.readContinuationApproval(plan.planId).approver, 'operator-1');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-05: approval identity is durable across restart', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-approval-restart-');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(first);
    const original = approve(first, plan.planId);
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9999 });
    assert.deepEqual(reopened.readContinuationApproval(plan.planId), original);
    assert.deepEqual(reopened.assertContinuationApprovalValid(plan.planId), original);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-06: gate-level materialization replay returns one immutable task (same process and reopen)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-replay-');
  try {
    const seedStore = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 10 });
    const { plan } = seedPlan(seedStore);
    approve(seedStore, plan.planId);
    const first = materializeApprovedContinuation(seedStore, plan.planId);
    const replay = materializeApprovedContinuation(seedStore, plan.planId);
    assert.equal(replay.createdTaskId, first.createdTaskId);
    seedStore.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
    const afterReopen = materializeApprovedContinuation(reopened, plan.planId);
    assert.equal(afterReopen.createdTaskId, first.createdTaskId);
    reopened.close();

    assert.deepEqual(inspect(databasePath), {
      tasks: 2, lineage: 2, consumptions: 1, approvals: 1,
      dispatches: 0, leases: 0, executionRuns: 0, invocations: 0,
      launchAttempts: 0, launchResults: 0, verificationStarts: 0,
      verificationResults: 0, commitStarts: 0, commitResults: 0,
      codexStarts: 0, codexResults: 0, currentAttempt: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-07: concurrent gate entry materializes exactly one task', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-concurrent-');
  try {
    const seedStore = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 10 });
    const { plan } = seedPlan(seedStore);
    approve(seedStore, plan.planId);
    const expected = materializeApprovedContinuation(seedStore, plan.planId);
    seedStore.close();

    const moduleUrl = new URL('../dist/services/projectGoalContinuationExecutionGate.js', import.meta.url).href;
    // Concurrent entry through the gate: two workers each build their own store
    // and call materializeApprovedContinuation on the same plan.
    const gateUrl = moduleUrl;
    const storeUrl = new URL('../dist/services/projectTaskSqliteStore.js', import.meta.url).href;
    const workerSource2 = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        try {
          const { ProjectTaskSqliteStore } = await import(workerData.storeUrl);
          const { materializeApprovedContinuation } = await import(workerData.gateUrl);
          const store = new ProjectTaskSqliteStore({ databasePath: workerData.databasePath, maxActive: 10 });
          const result = materializeApprovedContinuation(store, workerData.planId);
          store.close();
          parentPort.postMessage({ ok: true, id: result.createdTaskId });
        } catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
      })();
    `;
    const run = () => new Promise((resolve, reject) => {
      const worker = new Worker(workerSource2, {
        eval: true,
        workerData: { storeUrl, gateUrl, databasePath, planId: plan.planId },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.ok, true, a.error);
    assert.equal(b.ok, true, b.error);
    assert.equal(a.id, expected.createdTaskId);
    assert.equal(b.id, expected.createdTaskId);
    const inspected = inspect(databasePath);
    assert.equal(inspected.tasks, 2);
    assert.equal(inspected.consumptions, 1);
    assertZeroExecution(inspected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-08: wrong-plan approval fails closed and cannot transfer', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-wrong-plan-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);

    // A second goal with its own plan that has NO approval.
    seedPlan(store, { goalId: GOAL2, taskId: 'e50e8400-e29b-41d4-a716-446655440001' });
    const planB = store.listGoalContinuationPlans(GOAL2)[0];

    assert.throws(() => materializeApprovedContinuation(store, planB.planId), /approval_required/);
    assert.equal(store.readContinuationPlan(planB.planId).status, 'planned');
    // The approval for plan A is still bound to plan A only.
    assert.equal(store.readContinuationApproval(plan.planId).planId, plan.planId);
    assert.equal(store.readContinuationApproval(planB.planId), undefined);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-09: revoked approval refuses materialization with no write', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-revoked-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    clock.advance(100);
    const revoked = store.revokeContinuationApproval(plan.planId);
    assert.equal(revoked.revokedAt, 1100);
    assert.throws(() => materializeApprovedContinuation(store, plan.planId), /approval_revoked/);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
    store.close();
    const inspected = inspect(databasePath);
    assert.equal(inspected.tasks, 1);
    assert.equal(inspected.consumptions, 0);
    assertZeroExecution(inspected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-10: expired approval refuses materialization with no write', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-expired-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock });
    const { plan } = seedPlan(store);
    approve(store, plan.planId, { expiresAt: 5000 });
    clock.set(5000);
    assert.throws(() => materializeApprovedContinuation(store, plan.planId), /approval_expired/);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
    store.close();
    assert.equal(inspect(databasePath).consumptions, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-11: approval cannot be revoked after materialization', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-revoke-after-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    materializeApprovedContinuation(store, plan.planId);
    assert.throws(() => store.revokeContinuationApproval(plan.planId), /not_revocable/);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-12: a consumed plan cannot be re-approved', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-reapprove-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    materializeApprovedContinuation(store, plan.planId);
    assert.throws(() => approve(store, plan.planId), /plan_not_approvable/);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-13: approval is state-only (no capability fields) with the conservative 7-day expiry default', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-approval-shape-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const approval = approve(store, plan.planId);
    assert.equal(approval.expiresAt - approval.createdAt, CONTINUATION_APPROVAL_DEFAULT_TTL_MS);
    assert.equal(approval.createdAt, 1000);
    for (const key of ['approvedCapabilities', 'effectiveCapabilities', 'requestedCapabilities', 'command', 'commands', 'executor', 'steps', 'dependencies', 'sessionId']) {
      assert.equal(key in approval, false, key);
    }
    const serialized = JSON.stringify(approval);
    assert.equal(/push|merge|deploy|secret|credential|shell|sudo/i.test(serialized), false);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-14: SQL enforces approval immutability (identity, delete, revoke-once)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-approval-sql-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    store.close();

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () => database.prepare('UPDATE project_goal_continuation_approvals SET approver = ? WHERE plan_id = ?').run('operator-2', plan.planId),
      /approval_immutable/,
    );
    assert.throws(
      () => database.prepare('UPDATE project_goal_continuation_approvals SET plan_id = ? WHERE plan_id = ?').run(GOAL2, plan.planId),
      /approval_immutable/,
    );
    assert.throws(
      () => database.prepare('DELETE FROM project_goal_continuation_approvals WHERE plan_id = ?').run(plan.planId),
      /approval_immutable/,
    );
    // Revoke once succeeds at the SQL level; a second revoke is rejected.
    database.prepare('UPDATE project_goal_continuation_approvals SET revoked_at = created_at WHERE plan_id = ?').run(plan.planId);
    assert.throws(
      () => database.prepare('UPDATE project_goal_continuation_approvals SET revoked_at = created_at + 1 WHERE plan_id = ?').run(plan.planId),
      /approval_immutable/,
    );
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-15: the created task is accepted and is NEVER dispatched, leased, verified, committed or executed', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-no-execute-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 500 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    const result = materializeApprovedContinuation(store, plan.planId);
    assert.equal(store.get(result.createdTaskId).status, 'accepted');
    store.close();
    const inspected = inspect(databasePath);
    assertZeroExecution(inspected);

    // Conservative restart recovery fails the undispatched task closed rather
    // than executing it (never auto-dispatched).
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 600 });
    assert.equal(reopened.reconcileInterruptedTasks(), 1);
    const interrupted = reopened.get(result.createdTaskId);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error.code, 'workflow_interrupted');
    assert.equal(interrupted.error.message, SAFE_TASK_ERROR_MESSAGES.workflow_interrupted);
    assert.equal(reopened.readContinuationPlan(plan.planId).createdTaskId, result.createdTaskId);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-16: crash before approval write rolls back cleanly and is retryable (W1/W3)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-crash-approval-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER gate_fail_approval BEFORE INSERT ON project_goal_continuation_approvals
      BEGIN SELECT RAISE(ABORT, 'gate_injected_approval_failure'); END;
    `);
    database.close();
    assert.throws(() => approve(store, plan.planId), /gate_injected_approval_failure/);
    assert.equal(store.readContinuationApproval(plan.planId), undefined);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
    store.close();
    assert.equal(inspect(databasePath).approvals, 0);

    // Remove the injected failure and retry: succeeds exactly once.
    const database2 = new DatabaseSync(databasePath);
    database2.exec('DROP TRIGGER gate_fail_approval');
    database2.close();
    const retried = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const approval = approve(retried, plan.planId);
    assert.ok(approval.approvalId);
    retried.close();
    assert.equal(inspect(databasePath).approvals, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-17: crash after approval write, restart with approval but no materialization (W2/W9)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-crash-after-approval-');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(first);
    approve(first, plan.planId);
    first.close();
    // Restart: approval present, no consumption, no task.
    assert.equal(inspect(databasePath).consumptions, 0);
    assert.equal(inspect(databasePath).tasks, 1);

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9999, maxActive: 10 });
    const result = materializeApprovedContinuation(reopened, plan.planId);
    assert.equal(result.task.status, 'accepted');
    assert.equal(reopened.readContinuationPlan(plan.planId).createdTaskId, result.createdTaskId);
    reopened.close();
    assert.equal(inspect(databasePath).consumptions, 1);
    assert.equal(inspect(databasePath).tasks, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-18: crash during materialization transaction rolls back atomically (W4/W5)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-crash-materialize-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 10 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER gate_fail_task BEFORE INSERT ON project_tasks
      BEGIN SELECT RAISE(ABORT, 'gate_injected_task_failure'); END;
    `);
    database.close();
    assert.throws(() => materializeApprovedContinuation(store, plan.planId), /gate_injected_task_failure/);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
    assert.equal(store.readGoal(GOAL).currentAttempt, 0);
    store.close();
    const inspected = inspect(databasePath);
    assert.equal(inspected.tasks, 1);
    assert.equal(inspected.consumptions, 0);
    assert.equal(inspected.approvals, 1);

    // Retry after removing the failure materializes exactly once.
    const database2 = new DatabaseSync(databasePath);
    database2.exec('DROP TRIGGER gate_fail_task');
    database2.close();
    const retried = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 10 });
    const result = materializeApprovedContinuation(retried, plan.planId);
    assert.equal(result.task.status, 'accepted');
    retried.close();
    assert.equal(inspect(databasePath).consumptions, 1);
    assert.equal(inspect(databasePath).tasks, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-19: crash after task creation but before response — same task recovered (W6/W7)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-crash-after-task-');
  try {
    const seedStore = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 10 });
    const { plan } = seedPlan(seedStore);
    approve(seedStore, plan.planId);
    const first = materializeApprovedContinuation(seedStore, plan.planId);
    seedStore.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
    const recovered = materializeApprovedContinuation(reopened, plan.planId);
    assert.equal(recovered.createdTaskId, first.createdTaskId);
    assert.equal(reopened.readContinuationPlan(plan.planId).status, 'consumed');
    assert.equal(reopened.get(first.createdTaskId).status, 'accepted');
    reopened.close();
    assert.equal(inspect(databasePath).tasks, 2);
    assert.equal(inspect(databasePath).consumptions, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-20: a terminal goal cannot materialize continuation (W13)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-terminal-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    store.transitionGoal(GOAL, 'failed');
    assert.throws(() => materializeApprovedContinuation(store, plan.planId), /plan_not_usable/);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
    store.close();
    const inspected = inspect(databasePath);
    assert.equal(inspected.tasks, 1);
    assert.equal(inspected.consumptions, 0);
    assertZeroExecution(inspected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-21: per-goal attempt and depth budgets refuse materialization (no task)', async () => {
  for (const [name, sql, expected] of [
    ['attempt-budget', 'UPDATE project_goals SET max_attempts = 1 WHERE goal_id = ?', /plan_not_usable/],
    ['depth-budget', 'UPDATE project_goals SET continuation_depth_limit = 0 WHERE goal_id = ?', /plan_not_usable/],
  ]) {
    const { directory, databasePath } = await tempDatabase(`lia-gate-${name}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
      const { plan } = seedPlan(store);
      approve(store, plan.planId);
      store.close();
      await corrupt(databasePath, (db) => {
        db.exec('DROP TRIGGER project_goal_evaluation_identity_immutable');
        db.prepare(sql).run(GOAL);
      });
      const reopened = new ProjectTaskSqliteStore({ databasePath });
      assert.throws(() => materializeApprovedContinuation(reopened, plan.planId), expected);
      reopened.close();
      const inspected = inspect(databasePath);
      assert.equal(inspected.tasks, 1);
      assert.equal(inspected.consumptions, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('EG-22: a stale plan (source no longer current) is refused by materialization', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-stale-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 10 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    // A competing continuation attempt makes the plan's source stale.
    store.createContinuationAttempt({
      taskId: 'e50e8400-e29b-41d4-a716-446655440099',
      fingerprint: 'competing-attempt',
      intent: intent(),
      goalId: GOAL,
      parentTaskId: ROOT,
      continuationDepth: 1,
      attemptNumber: 1,
    });
    assert.throws(() => materializeApprovedContinuation(store, plan.planId), /plan_not_usable/);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-23: forbidden capability injected into the parent fails closed (no escalation)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-capability-escalation-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { plan } = seedPlan(store);
    approve(store, plan.planId);
    store.close();
    await corrupt(databasePath, (db) => {
      db.exec('DROP TRIGGER project_task_lineage_task_identity_immutable');
      db.prepare(`
        UPDATE project_tasks SET intent_json = json_set(intent_json, '$.requestedCapabilities',
          json_array('repository_read', 'run_tests', 'push'))
        WHERE task_id = ?
      `).run(ROOT);
    });
    const reopened = new ProjectTaskSqliteStore({ databasePath });
    assert.throws(() => materializeApprovedContinuation(reopened, plan.planId));
    reopened.close();
    assert.equal(inspect(databasePath).consumptions, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-24: assertNoForbiddenAuthority rejects capability/command-bearing records', () => {
  const plan = { planId: 'p', status: 'planned', reasonCode: 'retry_execution_failure' };
  assert.doesNotThrow(() => assertNoForbiddenAuthority(plan, undefined));
  assert.throws(
    () => assertNoForbiddenAuthority({ ...plan, approvedCapabilities: ['push'] }, undefined),
    /forbidden_authority/,
  );
  assert.throws(
    () => assertNoForbiddenAuthority(plan, { approvalId: 'a', commands: ['rm -rf /'] }),
    /forbidden_authority/,
  );
  assert.throws(
    () => assertNoForbiddenAuthority({ ...plan, steps: [] }, { approvalId: 'a' }),
    /forbidden_authority/,
  );
});

test('EG-25: operator-visible gate evidence derives from durable rows only and is safe', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gate-evidence-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock });
    const { plan } = seedPlan(store);

    const pending = buildContinuationGateEvidence(store, plan.planId, { now: clock });
    assert.equal(pending.approvalState, 'approval_required');
    assert.equal(pending.authorizationState, 'pending');
    assert.equal(pending.materializationState, 'pending');
    assert.equal(pending.createdTaskId, undefined);
    assert.equal(pending.nextTaskExecuted, false);
    assert.equal(pending.approvalId, undefined);

    const approval = approve(store, plan.planId);
    const allowed = buildContinuationGateEvidence(store, plan.planId, { now: clock });
    assert.equal(allowed.approvalState, 'approval_present');
    assert.equal(allowed.authorizationState, 'allowed');
    assert.equal(allowed.approvalId, approval.approvalId);
    assert.equal(allowed.materializationState, 'pending');

    const result = materializeApprovedContinuation(store, plan.planId);
    const materialized = buildContinuationGateEvidence(store, plan.planId, { now: clock });
    assert.equal(materialized.approvalState, 'approval_consumed');
    assert.equal(materialized.authorizationState, 'materialized');
    assert.equal(materialized.materializationState, 'materialized');
    assert.equal(materialized.createdTaskId, result.createdTaskId);
    assert.equal(materialized.nextTaskExecutionState, 'accepted');
    assert.equal(materialized.nextTaskExecuted, false);
    assert.equal(materialized.planId, plan.planId);

    const serialized = JSON.stringify(materialized);
    for (const forbidden of ['push', 'merge', 'deploy', 'secret', 'credential', 'shell', 'sudo', '/opt/', '/etc/', 'spawn', 'session']) {
      assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden);
    }
    assert.equal(serialized.includes('requestedCapabilities'), false);
    assert.equal(serialized.includes('approvedCapabilities'), false);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EG-26: derived approval state vocabulary is correct', () => {
  const plan = (overrides = {}) => ({
    planId: 'p', goalId: GOAL, sourceEvaluationId: 'e', sourceEvidenceFingerprint: 'a'.repeat(64),
    fingerprint: 'b'.repeat(64), status: 'planned', reasonCode: 'retry_execution_failure',
    ...overrides,
  });
  const approval = (overrides = {}) => ({
    approvalId: 'a', planId: 'p', goalId: GOAL, sourceEvaluationId: 'e',
    planFingerprint: 'b'.repeat(64), sourceEvidenceFingerprint: 'a'.repeat(64),
    approver: 'operator-1', createdAt: 1000, ...overrides,
  });
  const evaluation = { evaluationId: 'e', appliedAt: 1000, decision: 'retryable' };
  const goal = { goalId: GOAL, status: 'active' };

  assert.equal(deriveContinuationApprovalState({ plan: plan(), approval: undefined, evaluation, goal, now: 1000 }), 'approval_required');
  assert.equal(deriveContinuationApprovalState({ plan: plan(), approval: approval(), evaluation, goal, now: 1000 }), 'approval_present');
  assert.equal(deriveContinuationApprovalState({ plan: plan(), approval: approval({ revokedAt: 1000 }), evaluation, goal, now: 1000 }), 'approval_revoked');
  assert.equal(deriveContinuationApprovalState({ plan: plan(), approval: approval({ expiresAt: 2000 }), evaluation, goal, now: 2000 }), 'approval_expired');
  assert.equal(deriveContinuationApprovalState({ plan: plan({ status: 'consumed' }), approval: approval(), evaluation, goal, now: 1000 }), 'approval_consumed');
  assert.equal(deriveContinuationApprovalState({ plan: plan({ status: 'cancelled' }), approval: approval(), evaluation, goal, now: 1000 }), 'approval_invalid');
  assert.equal(deriveContinuationApprovalState({ plan: plan(), approval: approval({ planFingerprint: 'c'.repeat(64) }), evaluation, goal, now: 1000 }), 'approval_invalid');
  assert.equal(deriveContinuationApprovalState({ plan: plan(), approval: approval(), evaluation: { ...evaluation, decision: 'completed' }, goal, now: 1000 }), 'approval_invalid');
  assert.equal(deriveContinuationApprovalState({ plan: plan(), approval: approval(), evaluation, goal: { goalId: GOAL, status: 'failed' }, now: 1000 }), 'approval_invalid');
});

test('EG-27: no Hermes, Codex, workflow, dispatch or execution authority exists in the gate', async () => {
  const gateSource = await readFile(new URL('../src/services/projectGoalContinuationExecutionGate.ts', import.meta.url), 'utf8');
  for (const needle of ["from 'node:child_process'", "from 'node:http'", "from 'node:https'", "from 'node:net'", "from 'node:dns'"]) {
    assert.equal(gateSource.includes(needle), false, needle);
  }
  for (const needle of ['runProjectTaskDurableExecution', 'executeProjectTaskWorkflow', 'createProjectTaskDurableExecutionRunner', 'projectCodex', 'projectHermes', 'hermesExecutor', 'codexExecutor', 'hermesRuntime', 'git commit', 'push', 'merge', 'deploy']) {
    assert.equal(gateSource.includes(needle), false, needle);
  }
  assert.equal(gateSource.includes('materializeContinuation'), true);
  const storeSource = await readFile(new URL('../src/services/projectTaskSqliteStore.ts', import.meta.url), 'utf8');
  // The gate's sole authority write is the existing materializeContinuation.
  assert.equal(storeSource.includes('materializeContinuation'), true);
  // Schema version advanced to V18 for the approval table.
  assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 18);
});
