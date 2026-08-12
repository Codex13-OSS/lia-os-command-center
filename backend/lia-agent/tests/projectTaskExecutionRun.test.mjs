import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { CONTINUATION_PLANNER_VERSION } from '../dist/contracts/projectGoalContinuationPlan.js';
import { PROJECT_GOAL_EVALUATOR_VERSION } from '../dist/contracts/projectGoalEvaluation.js';
import { PROJECT_TASK_EXECUTION_RUN_MAX_LIST_LIMIT } from '../dist/contracts/projectTaskExecutionRun.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';

const TASK_A = '450e8400-e29b-41d4-a716-446655440000';
const TASK_B = '450e8400-e29b-41d4-a716-446655440001';
const UNKNOWN = '450e8400-e29b-41d4-a716-446655440099';
const GOAL = '650e8400-e29b-41d4-a716-446655440000';
const ROOT = '750e8400-e29b-41d4-a716-446655440000';
const WORKER = new URL('./fixtures/projectTaskDispatchWorker.mjs', import.meta.url);
const intent = {
  projectId: 'safe',
  instruction: 'Prepare a bounded task without executing it.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests'],
};
const receipt = {
  executionId: 'historical-workflow-result-not-a-run-id',
  status: 'verified',
  resultText: 'Partial bounded result.',
  verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
};

const preparationInput = (dispatch, lease, overrides = {}) => ({
  dispatchId: dispatch.dispatchId,
  taskId: dispatch.taskId,
  leaseOwner: lease.leaseOwner,
  leaseId: lease.leaseId,
  fencingToken: lease.fencingToken,
  ...overrides,
});

async function fixture(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-execution-run-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let now = options.now ?? 1_000;
  const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
  store.createOrGet(TASK_A, 'fp-a', intent);
  if (options.twoTasks) store.createOrGet(TASK_B, 'fp-b', intent);
  try {
    await fn({ store, databasePath, setNow(value) { now = value; } });
  } finally {
    if (store.isOpen !== false) store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function claim(store, taskId = TASK_A, owner = 'worker-a', durationMs = 10_000) {
  const dispatch = store.enqueueTaskDispatch(taskId);
  const lease = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: owner, durationMs }).lease;
  return { dispatch, lease, input: preparationInput(dispatch, lease) };
}

function rows(databasePath, table) {
  const db = new DatabaseSync(databasePath);
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
  finally { db.close(); }
}

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker_exit_${code}`)); });
  });
}

test('first prepare atomically consumes one dispatch and creates one authority-free prepared run', async () => {
  await fixture(({ store, databasePath }) => {
    const taskBefore = store.get(TASK_A);
    const { dispatch, lease, input } = claim(store);
    const leaseBefore = rows(databasePath, 'project_task_lease_generations');
    const run = store.prepareTaskExecutionRun(input);
    assert.match(run.executionRunId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(run, {
      executionRunId: run.executionRunId,
      taskId: TASK_A,
      dispatchId: dispatch.dispatchId,
      preparationLeaseId: lease.leaseId,
      preparationFencingToken: lease.fencingToken,
      preparedAt: 1_000,
    });
    assert.equal(store.readTaskDispatch(dispatch.dispatchId).consumedAt, run.preparedAt);
    assert.equal(store.get(TASK_A).status, 'accepted');
    assert.deepEqual(store.get(TASK_A), taskBefore);
    assert.deepEqual(rows(databasePath, 'project_task_lease_generations'), leaseBefore);
    assert.equal(rows(databasePath, 'project_task_execution_runs').length, 1);
    assert.deepEqual(Object.keys(run).sort(), [
      'dispatchId', 'executionRunId', 'preparationFencingToken',
      'preparationLeaseId', 'preparedAt', 'taskId',
    ]);
    assert.doesNotMatch(JSON.stringify(run), /capabilit|authorit|instruction|prompt|secret|command|path/i);
  });
});

test('malformed, extra-field, unknown, cross-task, nonaccepted and terminal inputs fail closed', async () => {
  await fixture(({ store }) => {
    const { dispatch, lease, input } = claim(store);
    assert.throws(() => store.prepareTaskExecutionRun(null), /invalid_project_task_execution_run_input/);
    assert.throws(() => store.prepareTaskExecutionRun({ ...input, approvedCapabilities: ['production_write'] }), /invalid_project_task_execution_run_input/);
    assert.throws(() => store.prepareTaskExecutionRun({ ...input, taskId: UNKNOWN }), /task_not_found/);
    assert.throws(() => store.prepareTaskExecutionRun({ ...input, dispatchId: UNKNOWN }), /dispatch_not_found/);
    store.createOrGet(TASK_B, 'fp-b', intent);
    assert.throws(() => store.prepareTaskExecutionRun({ ...input, taskId: TASK_B }), /authority_mismatch/);
    store.transition(TASK_A, 'planning');
    assert.throws(() => store.prepareTaskExecutionRun(input), /task_unavailable/);
    assert.equal(store.readTaskDispatch(dispatch.dispatchId).consumedAt, undefined);
    assert.equal(store.readTaskExecutionRunByTask(TASK_A), undefined);
    assert.equal(lease.fencingToken, 1);
  });
  await fixture(({ store }) => {
    const { input } = claim(store);
    store.complete(TASK_A, receipt);
    assert.throws(() => store.prepareTaskExecutionRun(input), /task_unavailable/);
  });
});

test('wrong owner, lease id and fencing token fail without consuming pending dispatch', async () => {
  await fixture(({ store }) => {
    const { dispatch, input } = claim(store);
    for (const override of [
      { leaseOwner: 'worker-b' }, { leaseId: UNKNOWN }, { fencingToken: 2 },
    ]) assert.throws(() => store.prepareTaskExecutionRun({ ...input, ...override }), /authority_mismatch/);
    assert.equal(store.readTaskDispatch(dispatch.dispatchId).consumedAt, undefined);
    assert.equal(store.readTaskExecutionRunByTask(TASK_A), undefined);
  });
});

test('released and expired leases cannot perform first preparation', async () => {
  await fixture(({ store }) => {
    const { dispatch, lease, input } = claim(store);
    store.releaseTaskLease({ taskId: TASK_A, leaseOwner: lease.leaseOwner, leaseId: lease.leaseId, fencingToken: lease.fencingToken });
    assert.throws(() => store.prepareTaskExecutionRun(input), /authority_mismatch/);
    assert.equal(store.readTaskDispatch(dispatch.dispatchId).consumedAt, undefined);
  });
  await fixture(({ store, setNow }) => {
    const { dispatch, input } = claim(store, TASK_A, 'worker-a', 1_000);
    setNow(2_000);
    assert.throws(() => store.prepareTaskExecutionRun(input), /project_task_lease_expired/);
    assert.equal(store.readTaskDispatch(dispatch.dispatchId).consumedAt, undefined);
  });
});

test('stale pre-takeover generation cannot prepare after newer fencing authority exists', async () => {
  await fixture(({ store, setNow }) => {
    const old = claim(store, TASK_A, 'worker-old', 1_000);
    setNow(2_000);
    const next = store.claimTaskDispatch({ dispatchId: old.dispatch.dispatchId, leaseOwner: 'worker-new', durationMs: 5_000 }).lease;
    assert.equal(next.fencingToken, 2);
    assert.throws(() => store.prepareTaskExecutionRun(old.input), /authority_mismatch/);
    const run = store.prepareTaskExecutionRun(preparationInput(old.dispatch, next));
    assert.equal(run.preparationFencingToken, 2);
  });
});

test('exact replay returns the same run without mutation after release, expiry and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-execution-run-replay-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    let now = 1_000;
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    first.createOrGet(TASK_A, 'fp', intent);
    const { lease, input } = claim(first, TASK_A, 'worker-a', 1_000);
    const original = first.prepareTaskExecutionRun(input);
    const durableBefore = rows(databasePath, 'project_task_execution_runs');
    first.releaseTaskLease({ taskId: TASK_A, leaseOwner: lease.leaseOwner, leaseId: lease.leaseId, fencingToken: lease.fencingToken });
    now = 9_000;
    assert.deepEqual(first.prepareTaskExecutionRun(input), original);
    assert.deepEqual(rows(databasePath, 'project_task_execution_runs'), durableBefore);
    first.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 20_000 });
    assert.deepEqual(reopened.prepareTaskExecutionRun(input), original);
    assert.deepEqual(reopened.readTaskExecutionRun(original.executionRunId), original);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('wrong replay authority tuple cannot masquerade as exact replay', async () => {
  await fixture(({ store }) => {
    const { input } = claim(store);
    store.prepareTaskExecutionRun(input);
    for (const override of [
      { leaseOwner: 'attacker' }, { leaseId: UNKNOWN }, { fencingToken: 2 },
      { dispatchId: UNKNOWN }, { taskId: TASK_B },
    ]) assert.throws(() => store.prepareTaskExecutionRun({ ...input, ...override }));
    assert.equal(store.listPreparedTaskExecutionRuns(10).length, 1);
  });
});

test('legacy consumed dispatch without a run stays ambiguous and cannot be repaired', async () => {
  await fixture(({ store }) => {
    const { dispatch, lease, input } = claim(store);
    store.consumeTaskDispatch({
      dispatchId: dispatch.dispatchId, taskId: TASK_A, leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId, fencingToken: lease.fencingToken,
    });
    assert.throws(() => store.prepareTaskExecutionRun(input), /dispatch_unavailable/);
    assert.equal(store.readTaskExecutionRunByTask(TASK_A), undefined);
    assert.equal(store.reconcileRestartSafeTasks().failedInterrupted, 1);
  });
});

test('concurrent duplicate preparation converges to one run while competing owner fails', async () => {
  await fixture(async ({ store, databasePath }) => {
    const { input } = claim(store);
    store.close();
    const results = await Promise.all([1, 2].map(() => runWorker({ action: 'prepare', databasePath, now: 1_001, input })));
    assert.equal(results.every((result) => result.ok), true);
    assert.equal(new Set(results.map((result) => result.result.executionRunId)).size, 1);
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project_task_execution_runs').get().total, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project_task_dispatch_outbox WHERE consumed_at IS NOT NULL').get().total, 1);
    db.close();
  });
  await fixture(async ({ store, databasePath }) => {
    const { input } = claim(store);
    store.close();
    const results = await Promise.all([
      runWorker({ action: 'prepare', databasePath, now: 1_001, input }),
      runWorker({ action: 'prepare', databasePath, now: 1_001, input: { ...input, leaseOwner: 'worker-b' } }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.match(results.find((result) => !result.ok).error, /authority_mismatch/);
  });
});

test('faults during and after consume logic roll back run and dispatch together', async () => {
  await fixture(({ store, databasePath }) => {
    const first = claim(store);
    let db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER execution_run_consume_fault AFTER UPDATE OF consumed_at ON project_task_dispatch_outbox BEGIN SELECT RAISE(ABORT, 'consume_fault'); END");
    db.close();
    assert.throws(() => store.prepareTaskExecutionRun(first.input), /consume_fault/);
    assert.equal(store.readTaskDispatch(first.dispatch.dispatchId).consumedAt, undefined);
    assert.equal(store.readTaskExecutionRunByTask(TASK_A), undefined);
    db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER execution_run_consume_fault');
    db.exec("CREATE TRIGGER execution_run_insert_fault BEFORE INSERT ON project_task_execution_runs BEGIN SELECT RAISE(ABORT, 'insert_fault'); END");
    db.close();
    assert.throws(() => store.prepareTaskExecutionRun(first.input), /insert_fault/);
    assert.equal(store.readTaskDispatch(first.dispatch.dispatchId).consumedAt, undefined);
    assert.equal(store.readTaskExecutionRunByTask(TASK_A), undefined);
  });
});

test('SQLite rejects run mutation, deletion, malformed identity, pending dispatch and mismatched provenance', async () => {
  await fixture(({ store, databasePath }) => {
    const { input } = claim(store);
    const run = store.prepareTaskExecutionRun(input);
    const db = new DatabaseSync(databasePath);
    assert.throws(() => db.prepare('UPDATE project_task_execution_runs SET prepared_at = prepared_at + 1').run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM project_task_execution_runs').run(), /immutable/);
    assert.throws(() => db.prepare(`INSERT INTO project_task_execution_runs VALUES (?, ?, ?, ?, ?, ?)`)
      .run('not-a-uuid', TASK_B, UNKNOWN, UNKNOWN, 1, 1_000));
    assert.equal(db.prepare('SELECT execution_run_id FROM project_task_execution_runs').get().execution_run_id, run.executionRunId);
    db.close();
  });
  await fixture(({ store, databasePath }) => {
    const { dispatch, lease } = claim(store);
    const db = new DatabaseSync(databasePath);
    assert.throws(() => db.prepare(`INSERT INTO project_task_execution_runs VALUES (?, ?, ?, ?, ?, ?)`)
      .run(UNKNOWN, TASK_A, dispatch.dispatchId, lease.leaseId, lease.fencingToken, 1_000), /incompatible/);
    db.close();
  });
});

test('read surfaces are side-effect free and prepared list is deterministic and bounded', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const first = claim(store);
    const runA = store.prepareTaskExecutionRun(first.input);
    store.createOrGet(TASK_B, 'fp-b', intent);
    setNow(2_000);
    const second = claim(store, TASK_B, 'worker-b');
    const runB = store.prepareTaskExecutionRun(second.input);
    const before = {
      tasks: rows(databasePath, 'project_tasks'),
      leases: rows(databasePath, 'project_task_lease_generations'),
      outbox: rows(databasePath, 'project_task_dispatch_outbox'),
      runs: rows(databasePath, 'project_task_execution_runs'),
    };
    assert.deepEqual(store.readTaskExecutionRun(runA.executionRunId), runA);
    assert.deepEqual(store.readTaskExecutionRunByTask(TASK_B), runB);
    assert.deepEqual(store.listPreparedTaskExecutionRuns(1), [runA]);
    assert.deepEqual(store.listPreparedTaskExecutionRuns(2), [runA, runB]);
    for (const limit of [0, -1, 1.5, PROJECT_TASK_EXECUTION_RUN_MAX_LIST_LIMIT + 1]) {
      assert.throws(() => store.listPreparedTaskExecutionRuns(limit), /invalid_project_task_execution_run_input/);
    }
    assert.deepEqual({
      tasks: rows(databasePath, 'project_tasks'), leases: rows(databasePath, 'project_task_lease_generations'),
      outbox: rows(databasePath, 'project_task_dispatch_outbox'), runs: rows(databasePath, 'project_task_execution_runs'),
    }, before);
  });
});

test('V8 to V12 migration preserves prior durable chain and legacy consumed ambiguity without inventing runs or tickets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-execution-run-v8-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 100 });
    initial.createGoal({ goalId: GOAL, projectId: 'safe', objective: 'Preserve all prior durable layers.', maxAttempts: 3, continuationDepthLimit: 2 });
    initial.createRootAttempt({ taskId: ROOT, fingerprint: 'root-fp', intent, goalId: GOAL, continuationDepth: 0, attemptNumber: 0 });
    initial.complete(ROOT, receipt);
    const evaluation = initial.evaluateAndApplyGoalAttempt({
      goalId: GOAL, taskId: ROOT, attemptNumber: 0, evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
      evidence: { goalSatisfaction: 'partial', blocking: 'none', failure: 'retryable' },
    }).evaluation;
    initial.createContinuationPlan({
      goalId: GOAL, sourceEvaluationId: evaluation.evaluationId, plannerVersion: CONTINUATION_PLANNER_VERSION,
      sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
    });
    initial.createOrGet(TASK_A, 'legacy-fp', intent);
    const legacy = claim(initial);
    initial.consumeTaskDispatch({
      dispatchId: legacy.dispatch.dispatchId, taskId: TASK_A, leaseOwner: legacy.lease.leaseOwner,
      leaseId: legacy.lease.leaseId, fencingToken: legacy.lease.fencingToken,
    });
    initial.close();
    const v8 = new DatabaseSync(databasePath);
    const before = Object.fromEntries([
      'project_tasks', 'project_goals', 'project_task_lineage', 'project_goal_evaluations',
      'project_goal_continuation_plans', 'project_task_lease_generations', 'project_task_dispatch_outbox',
    ].map((table) => [table, v8.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total]));
    v8.exec('DROP TRIGGER project_task_validated_proposal_snapshots_validate_insert; DROP TRIGGER project_task_validated_proposal_snapshots_immutable_update; DROP TRIGGER project_task_validated_proposal_snapshots_immutable_delete; DROP INDEX project_task_validated_proposal_snapshots_recorded; DROP TABLE project_task_validated_proposal_snapshots; DROP TRIGGER project_task_execution_launch_results_validate_insert; DROP TRIGGER project_task_execution_launch_results_immutable_update; DROP TRIGGER project_task_execution_launch_results_immutable_delete; DROP INDEX project_task_execution_launch_results_recorded; DROP TABLE project_task_execution_launch_results; DROP TRIGGER project_task_execution_invocations_preserve_on_lease_release; DROP TABLE project_task_execution_invocations; DROP TABLE project_task_execution_runs; DROP TRIGGER project_task_execution_launch_attempts_preserve_on_lease_release; DROP TRIGGER project_task_execution_launch_attempts_validate_insert; DROP TRIGGER project_task_execution_launch_attempts_immutable_update; DROP TRIGGER project_task_execution_launch_attempts_immutable_delete; DROP INDEX project_task_execution_launch_attempts_crossed; DROP TABLE project_task_execution_launch_attempts; UPDATE project_task_meta SET schema_version = 8 WHERE singleton = 1');
    v8.close();
    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 200 });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 14);
    assert.equal(migrated.readTaskExecutionRunByTask(TASK_A), undefined);
    migrated.close();
    const check = new DatabaseSync(databasePath);
    for (const [table, total] of Object.entries(before)) {
      assert.equal(check.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total, total, table);
    }
    assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_runs').get().total, 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_invocations').get().total, 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_launch_attempts').get().total, 0);
    check.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery preserves a valid prepared boundary across reopen and remains idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-execution-run-recovery-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp', intent);
    const prepared = claim(first);
    const run = first.prepareTaskExecutionRun(prepared.input);
    first.releaseTaskLease({
      taskId: TASK_A,
      leaseOwner: prepared.lease.leaseOwner,
      leaseId: prepared.lease.leaseId,
      fencingToken: prepared.lease.fencingToken,
    });
    const taskBefore = first.get(TASK_A);
    assert.deepEqual(first.reconcileRestartSafeTasks(), { preservedRecoverable: 1, failedInterrupted: 0, terminalUnchanged: 0, resumableAvailable: 0 });
    assert.deepEqual(first.reconcileRestartSafeTasks(), { preservedRecoverable: 1, failedInterrupted: 0, terminalUnchanged: 0, resumableAvailable: 0 });
    assert.deepEqual(first.get(TASK_A), taskBefore);
    first.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 99_000 });
    assert.deepEqual(reopened.readTaskExecutionRun(run.executionRunId), run);
    assert.deepEqual(reopened.reconcileRestartSafeTasks(), { preservedRecoverable: 1, failedInterrupted: 0, terminalUnchanged: 0, resumableAvailable: 0 });
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery rejects pending-run and corrupt run relationships and rolls back other classifications', async () => {
  await fixture(({ store, databasePath }) => {
    store.createOrGet(TASK_B, 'fp-b', intent);
    const { dispatch, lease } = claim(store);
    const db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER project_task_execution_runs_validate_insert');
    db.prepare(`INSERT INTO project_task_execution_runs VALUES (?, ?, ?, ?, ?, ?)`)
      .run(UNKNOWN, TASK_A, dispatch.dispatchId, lease.leaseId, lease.fencingToken, 1_000);
    db.close();
    assert.throws(() => store.reconcileRestartSafeTasks(), /corrupt_project_task_execution_run_record/);
    assert.equal(store.get(TASK_B).status, 'accepted');
  });
  await fixture(({ store, databasePath }) => {
    store.createOrGet(TASK_B, 'fp-b', intent);
    const first = claim(store);
    store.prepareTaskExecutionRun(first.input);
    const db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER project_task_execution_runs_immutable_update; PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE project_task_execution_runs SET dispatch_id = ?').run(UNKNOWN);
    db.close();
    assert.throws(() => store.reconcileRestartSafeTasks(), /corrupt_project_task_execution_run_record/);
    const check = new DatabaseSync(databasePath);
    assert.equal(check.prepare('SELECT status FROM project_tasks WHERE task_id = ?').get(TASK_B).status, 'accepted');
    check.close();
  });
});

test('execution-run layer contains no automatic execution integration or authority fields', async () => {
  const [storeSource, serverSource, routeSource] = await Promise.all([
    readFile(new URL('../src/services/projectTaskSqliteStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/projectTaskWorkflow.ts', import.meta.url), 'utf8'),
  ]);
  const start = storeSource.indexOf('prepareTaskExecutionRun(');
  const end = storeSource.indexOf('\n  acquireTaskLease(', start);
  const boundary = storeSource.slice(start, end);
  for (const forbidden of ['executeProjectTaskWorkflow', 'hermesExecutor', 'projectCodexExecutor', 'setInterval', 'setTimeout', 'enqueueTaskDispatch(', 'transition(']) {
    assert.equal(boundary.includes(forbidden), false, forbidden);
  }
  assert.equal(serverSource.includes('prepareTaskExecutionRun('), false);
  assert.equal(routeSource.includes('prepareTaskExecutionRun('), false);
  assert.doesNotMatch(boundary, /\b(push|merge|deploy|production_write|database_write|secret_access)\b/);
});
