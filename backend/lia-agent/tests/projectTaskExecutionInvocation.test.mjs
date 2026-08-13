import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { CONTINUATION_PLANNER_VERSION } from '../dist/contracts/projectGoalContinuationPlan.js';
import { PROJECT_GOAL_EVALUATOR_VERSION } from '../dist/contracts/projectGoalEvaluation.js';
import { PROJECT_TASK_EXECUTION_INVOCATION_MAX_LIST_LIMIT } from '../dist/contracts/projectTaskExecutionInvocation.js';
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
  instruction: 'Reserve a durable invocation identity without external execution.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests'],
};
const receipt = { executionId: 'historical-result', status: 'verified', resultText: 'done' };

async function fixture(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-invocation-'));
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

function prepare(store, taskId = TASK_A, owner = 'preparer', durationMs = 10_000) {
  const dispatch = store.enqueueTaskDispatch(taskId);
  const lease = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: owner, durationMs }).lease;
  const run = store.prepareTaskExecutionRun({
    dispatchId: dispatch.dispatchId,
    taskId,
    leaseOwner: lease.leaseOwner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
  return { dispatch, lease, run };
}

const reservationInput = (run, lease, overrides = {}) => ({
  executionRunId: run.executionRunId,
  taskId: run.taskId,
  leaseOwner: lease.leaseOwner,
  leaseId: lease.leaseId,
  fencingToken: lease.fencingToken,
  ...overrides,
});

function tableRows(databasePath, table) {
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

test('first reservation creates one canonical authority-free ticket and changes no prior boundary', async () => {
  await fixture(({ store, databasePath }) => {
    const prepared = prepare(store);
    const before = {
      task: store.get(TASK_A),
      dispatch: tableRows(databasePath, 'project_task_dispatch_outbox'),
      run: tableRows(databasePath, 'project_task_execution_runs'),
      lease: tableRows(databasePath, 'project_task_lease_generations'),
    };
    const ticket = store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease));
    assert.match(ticket.invocationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(ticket, {
      invocationId: ticket.invocationId,
      executionRunId: prepared.run.executionRunId,
      taskId: TASK_A,
      reservationLeaseId: prepared.lease.leaseId,
      reservationFencingToken: prepared.lease.fencingToken,
      reservedAt: 1_000,
    });
    assert.equal(store.get(TASK_A).status, 'accepted');
    assert.deepEqual(store.get(TASK_A), before.task);
    assert.deepEqual(tableRows(databasePath, 'project_task_dispatch_outbox'), before.dispatch);
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_runs'), before.run);
    assert.deepEqual(tableRows(databasePath, 'project_task_lease_generations'), before.lease);
    assert.equal(tableRows(databasePath, 'project_task_execution_invocations').length, 1);
    assert.deepEqual(Object.keys(ticket).sort(), [
      'executionRunId', 'invocationId', 'reservationFencingToken',
      'reservationLeaseId', 'reservedAt', 'taskId',
    ]);
    assert.doesNotMatch(JSON.stringify(ticket), /capabilit|authorit|instruction|prompt|command|secret|path|session|agent|provider|model/i);
  });
});

test('missing, malformed, extra-field, unknown task/run, and wrong task/run inputs fail closed', async () => {
  await fixture(({ store }) => {
    const prepared = prepare(store);
    const input = reservationInput(prepared.run, prepared.lease);
    for (const malformed of [
      null,
      {},
      { ...input, approvedCapabilities: ['production_write'] },
      { ...input, executionRunId: 'bad' },
      { ...input, taskId: 'bad' },
      { ...input, leaseOwner: '' },
      { ...input, leaseId: 'bad' },
      { ...input, fencingToken: 0 },
    ]) assert.throws(() => store.reserveTaskExecutionInvocation(malformed), /invalid_project_task_execution_invocation_input/);
    assert.throws(() => store.reserveTaskExecutionInvocation({ ...input, taskId: UNKNOWN }), /task_not_found/);
    assert.throws(() => store.reserveTaskExecutionInvocation({ ...input, executionRunId: UNKNOWN }), /run_not_found/);
    store.createOrGet(TASK_B, 'fp-b', intent);
    const leaseB = store.acquireTaskLease({ taskId: TASK_B, leaseOwner: 'worker-b', durationMs: 5_000 });
    assert.throws(() => store.reserveTaskExecutionInvocation({
      executionRunId: prepared.run.executionRunId,
      taskId: TASK_B,
      leaseOwner: leaseB.leaseOwner,
      leaseId: leaseB.leaseId,
      fencingToken: leaseB.fencingToken,
    }), /run_task_mismatch/);
    assert.equal(store.listReservedTaskExecutionInvocations(10).length, 0);
  });
});

test('nonaccepted and terminal tasks reject first reservation', async () => {
  await fixture(({ store }) => {
    const prepared = prepare(store);
    store.transition(TASK_A, 'planning');
    assert.throws(() => store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease)), /task_unavailable/);
  });
  await fixture(({ store }) => {
    const prepared = prepare(store);
    store.complete(TASK_A, receipt);
    assert.throws(() => store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease)), /task_unavailable/);
  });
});

test('wrong owner, lease id, fencing token, released lease and expired lease reject first reservation', async () => {
  await fixture(({ store }) => {
    const prepared = prepare(store);
    for (const override of [
      { leaseOwner: 'other' }, { leaseId: UNKNOWN }, { fencingToken: 2 },
    ]) assert.throws(() => store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease, override)), /authority_mismatch/);
    store.releaseTaskLease({
      taskId: TASK_A, leaseOwner: prepared.lease.leaseOwner,
      leaseId: prepared.lease.leaseId, fencingToken: prepared.lease.fencingToken,
    });
    assert.throws(() => store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease)), /authority_mismatch/);
  });
  await fixture(({ store, setNow }) => {
    const prepared = prepare(store, TASK_A, 'preparer', 1_000);
    setNow(2_000);
    assert.throws(() => store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease)), /project_task_lease_expired/);
  });
});

test('stale generation cannot reserve, while a safely reacquired generation can reserve an old run', async () => {
  await fixture(({ store, setNow }) => {
    const prepared = prepare(store, TASK_A, 'old-worker', 1_000);
    setNow(2_000);
    const current = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'new-worker', durationMs: 5_000 });
    assert.equal(current.fencingToken, 2);
    assert.throws(() => store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease)), /authority_mismatch/);
    const ticket = store.reserveTaskExecutionInvocation(reservationInput(prepared.run, current));
    assert.equal(ticket.reservationFencingToken, 2);
    assert.equal(ticket.reservationLeaseId, current.leaseId);
    assert.notEqual(ticket.reservationLeaseId, prepared.run.preparationLeaseId);
    assert.notEqual(ticket.reservationFencingToken, prepared.run.preparationFencingToken);
  });
});

test('exact replay returns the same ticket without mutation after release, expiry and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-invocation-replay-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    let now = 1_000;
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    first.createOrGet(TASK_A, 'fp', intent);
    const prepared = prepare(first, TASK_A, 'worker', 1_000);
    const input = reservationInput(prepared.run, prepared.lease);
    const ticket = first.reserveTaskExecutionInvocation(input);
    const before = tableRows(databasePath, 'project_task_execution_invocations');
    first.releaseTaskLease({
      taskId: TASK_A, leaseOwner: prepared.lease.leaseOwner,
      leaseId: prepared.lease.leaseId, fencingToken: prepared.lease.fencingToken,
    });
    now = 9_000;
    assert.deepEqual(first.reserveTaskExecutionInvocation(input), ticket);
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_invocations'), before);
    first.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 20_000 });
    assert.deepEqual(reopened.reserveTaskExecutionInvocation(input), ticket);
    assert.deepEqual(reopened.readTaskExecutionInvocation(ticket.invocationId), ticket);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('later lease release cannot invalidate historical reservation provenance', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const prepared = prepare(store);
    setNow(1_500);
    const input = reservationInput(prepared.run, prepared.lease);
    const ticket = store.reserveTaskExecutionInvocation(input);
    const db = new DatabaseSync(databasePath);
    assert.throws(() => db.prepare(`
      UPDATE project_task_lease_generations SET released_at = 1200
      WHERE lease_id = ?
    `).run(prepared.lease.leaseId), /invocation_incompatible/);
    db.close();
    setNow(1_200);
    store.releaseTaskLease({
      taskId: TASK_A, leaseOwner: prepared.lease.leaseOwner,
      leaseId: prepared.lease.leaseId, fencingToken: prepared.lease.fencingToken,
    });
    assert.equal(tableRows(databasePath, 'project_task_lease_generations')[0].released_at, ticket.reservedAt);
    assert.deepEqual(store.readTaskExecutionInvocation(ticket.invocationId), ticket);
  });
});

test('wrong replay tuple fails closed and cannot replace durable identity', async () => {
  await fixture(({ store }) => {
    const prepared = prepare(store);
    const input = reservationInput(prepared.run, prepared.lease);
    const ticket = store.reserveTaskExecutionInvocation(input);
    for (const override of [
      { executionRunId: UNKNOWN }, { taskId: TASK_B }, { leaseOwner: 'other' },
      { leaseId: UNKNOWN }, { fencingToken: 2 },
    ]) assert.throws(() => store.reserveTaskExecutionInvocation({ ...input, ...override }));
    assert.deepEqual(store.listReservedTaskExecutionInvocations(10), [ticket]);
  });
});

test('concurrent exact duplicates converge to one ticket and a competing owner cannot reserve', async () => {
  await fixture(async ({ store, databasePath }) => {
    const prepared = prepare(store);
    const input = reservationInput(prepared.run, prepared.lease);
    store.close();
    const results = await Promise.all([1, 2].map(() => runWorker({ action: 'reserve', databasePath, now: 1_001, input })));
    assert.equal(results.every((result) => result.ok), true);
    assert.equal(new Set(results.map((result) => result.result.invocationId)).size, 1);
    assert.equal(tableRows(databasePath, 'project_task_execution_invocations').length, 1);
  });
  await fixture(async ({ store, databasePath }) => {
    const prepared = prepare(store);
    const input = reservationInput(prepared.run, prepared.lease);
    store.close();
    const results = await Promise.all([
      runWorker({ action: 'reserve', databasePath, now: 1_001, input }),
      runWorker({ action: 'reserve', databasePath, now: 1_001, input: { ...input, leaseOwner: 'competitor' } }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.match(results.find((result) => !result.ok).error, /authority_mismatch/);
    assert.equal(tableRows(databasePath, 'project_task_execution_invocations').length, 1);
  });
});

test('fault during ticket insertion rolls back atomically', async () => {
  await fixture(({ store, databasePath }) => {
    const prepared = prepare(store);
    const before = {
      task: tableRows(databasePath, 'project_tasks'),
      dispatch: tableRows(databasePath, 'project_task_dispatch_outbox'),
      run: tableRows(databasePath, 'project_task_execution_runs'),
      lease: tableRows(databasePath, 'project_task_lease_generations'),
    };
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER invocation_insert_fault BEFORE INSERT ON project_task_execution_invocations BEGIN SELECT RAISE(ABORT, 'insert_fault'); END");
    db.close();
    assert.throws(() => store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease)), /insert_fault/);
    assert.equal(tableRows(databasePath, 'project_task_execution_invocations').length, 0);
    assert.deepEqual({
      task: tableRows(databasePath, 'project_tasks'),
      dispatch: tableRows(databasePath, 'project_task_dispatch_outbox'),
      run: tableRows(databasePath, 'project_task_execution_runs'),
      lease: tableRows(databasePath, 'project_task_lease_generations'),
    }, before);
  });
});

test('SQLite forbids ticket update/delete and rejects malformed, missing, mismatched and invalid-lifetime inserts', async () => {
  await fixture(({ store, databasePath }) => {
    const prepared = prepare(store);
    store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease));
    const db = new DatabaseSync(databasePath);
    assert.throws(() => db.prepare('UPDATE project_task_execution_invocations SET reserved_at = reserved_at + 1').run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM project_task_execution_invocations').run(), /immutable/);
    db.close();
  });
  await fixture(({ store, databasePath }) => {
    const prepared = prepare(store);
    const db = new DatabaseSync(databasePath);
    const insert = db.prepare('INSERT INTO project_task_execution_invocations VALUES (?, ?, ?, ?, ?, ?)');
    assert.throws(() => insert.run('bad', prepared.run.executionRunId, TASK_A, prepared.lease.leaseId, 1, 1_000));
    assert.throws(() => insert.run(UNKNOWN, UNKNOWN, TASK_A, prepared.lease.leaseId, 1, 1_000), /incompatible/);
    assert.throws(() => insert.run(UNKNOWN, prepared.run.executionRunId, TASK_B, prepared.lease.leaseId, 1, 1_000), /incompatible/);
    assert.throws(() => insert.run(UNKNOWN, prepared.run.executionRunId, TASK_A, prepared.lease.leaseId, 1, 99_000), /incompatible/);
    db.close();
  });
});

test('read-by-id/run/task are side-effect free and list is bounded and deterministic', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const first = prepare(store);
    const ticketA = store.reserveTaskExecutionInvocation(reservationInput(first.run, first.lease));
    store.createOrGet(TASK_B, 'fp-b', intent);
    setNow(2_000);
    const second = prepare(store, TASK_B, 'worker-b');
    const ticketB = store.reserveTaskExecutionInvocation(reservationInput(second.run, second.lease));
    const before = tableRows(databasePath, 'project_task_execution_invocations');
    assert.deepEqual(store.readTaskExecutionInvocation(ticketA.invocationId), ticketA);
    assert.deepEqual(store.readTaskExecutionInvocationByRun(ticketB.executionRunId), ticketB);
    assert.deepEqual(store.readTaskExecutionInvocationByTask(TASK_A), ticketA);
    assert.deepEqual(store.listReservedTaskExecutionInvocations(1), [ticketA]);
    assert.deepEqual(store.listReservedTaskExecutionInvocations(2), [ticketA, ticketB]);
    for (const limit of [0, -1, 1.5, PROJECT_TASK_EXECUTION_INVOCATION_MAX_LIST_LIMIT + 1]) {
      assert.throws(() => store.listReservedTaskExecutionInvocations(limit), /invalid_project_task_execution_invocation_input/);
    }
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_invocations'), before);
  });
});

test('V9 to V12 migration preserves the complete durable chain and manufactures no tickets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-invocation-v9-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createGoal({
      goalId: GOAL,
      projectId: 'safe',
      objective: 'Preserve the complete durable chain through migration.',
      maxAttempts: 3,
      continuationDepthLimit: 2,
    });
    initial.createRootAttempt({
      taskId: ROOT,
      fingerprint: 'root-fp',
      intent,
      goalId: GOAL,
      continuationDepth: 0,
      attemptNumber: 0,
    });
    initial.complete(ROOT, receipt);
    const evaluation = initial.evaluateAndApplyGoalAttempt({
      goalId: GOAL,
      taskId: ROOT,
      attemptNumber: 0,
      evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
      evidence: { goalSatisfaction: 'partial', blocking: 'none', failure: 'retryable' },
    }).evaluation;
    const plan = initial.createContinuationPlan({
      goalId: GOAL,
      sourceEvaluationId: evaluation.evaluationId,
      plannerVersion: CONTINUATION_PLANNER_VERSION,
      sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
    });
    const continuation = initial.materializeContinuation(plan.planId);
    prepare(initial, continuation.createdTaskId);
    initial.createOrGet(TASK_B, 'fp-b', intent);
    initial.enqueueTaskDispatch(TASK_B);
    initial.close();
    const v9 = new DatabaseSync(databasePath);
    const tables = [
      'project_tasks', 'project_task_active_stage_traces', 'project_goals',
      'project_task_lineage', 'project_goal_evaluations', 'project_goal_continuation_plans',
      'project_goal_continuation_consumptions', 'project_task_lease_generations',
      'project_task_dispatch_outbox', 'project_task_execution_runs',
    ];
    const before = Object.fromEntries(tables.map((table) => [
      table,
      JSON.stringify(v9.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ]));
    v9.exec('DROP TRIGGER project_task_validated_proposal_snapshots_validate_insert; DROP TRIGGER project_task_validated_proposal_snapshots_immutable_update; DROP TRIGGER project_task_validated_proposal_snapshots_immutable_delete; DROP INDEX project_task_validated_proposal_snapshots_recorded; DROP TABLE project_task_validated_proposal_snapshots; DROP TRIGGER project_task_execution_launch_results_validate_insert; DROP TRIGGER project_task_execution_launch_results_immutable_update; DROP TRIGGER project_task_execution_launch_results_immutable_delete; DROP INDEX project_task_execution_launch_results_recorded; DROP TABLE project_task_execution_launch_results; DROP TRIGGER project_task_execution_invocations_preserve_on_lease_release; DROP TABLE project_task_execution_invocations; DROP TRIGGER project_task_execution_launch_attempts_preserve_on_lease_release; DROP TRIGGER project_task_execution_launch_attempts_validate_insert; DROP TRIGGER project_task_execution_launch_attempts_immutable_update; DROP TRIGGER project_task_execution_launch_attempts_immutable_delete; DROP INDEX project_task_execution_launch_attempts_crossed; DROP TABLE project_task_execution_launch_attempts; UPDATE project_task_meta SET schema_version = 9 WHERE singleton = 1');
    v9.close();
    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 19);
    assert.equal(migrated.listReservedTaskExecutionInvocations(10).length, 0);
    migrated.close();
    const check = new DatabaseSync(databasePath);
    for (const [table, snapshot] of Object.entries(before)) {
      assert.equal(JSON.stringify(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), snapshot, table);
    }
    assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_invocations').get().total, 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_launch_attempts').get().total, 0);
    check.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery preserves prepared runs with and without tickets across reopen and remains idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-invocation-recovery-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const a = prepare(first);
    const ticket = first.reserveTaskExecutionInvocation(reservationInput(a.run, a.lease));
    first.createOrGet(TASK_B, 'fp-b', intent);
    prepare(first, TASK_B, 'worker-b');
    const tasksBefore = [first.get(TASK_A), first.get(TASK_B)];
    const expected = { preservedRecoverable: 2, failedInterrupted: 0, terminalUnchanged: 0, resumableAvailable: 0 };
    assert.deepEqual(first.reconcileRestartSafeTasks(), expected);
    assert.deepEqual(first.reconcileRestartSafeTasks(), expected);
    assert.deepEqual([first.get(TASK_A), first.get(TASK_B)], tasksBefore);
    first.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 99_000 });
    assert.deepEqual(reopened.readTaskExecutionInvocation(ticket.invocationId), ticket);
    assert.deepEqual(reopened.reconcileRestartSafeTasks(), expected);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery rejects corrupt ticket relationships and lifetime atomically; legacy consumed/no-run remains ambiguous', async () => {
  await fixture(({ store, databasePath }) => {
    const prepared = prepare(store);
    store.createOrGet(TASK_B, 'fp-b', intent);
    const db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER project_task_execution_invocations_validate_insert; PRAGMA foreign_keys = OFF');
    db.prepare('INSERT INTO project_task_execution_invocations VALUES (?, ?, ?, ?, ?, ?)')
      .run(UNKNOWN, UNKNOWN, TASK_A, prepared.lease.leaseId, prepared.lease.fencingToken, 1_000);
    db.close();
    assert.throws(() => store.reconcileRestartSafeTasks(), /corrupt_project_task_execution_invocation_record/);
    assert.equal(store.get(TASK_B).status, 'accepted');
  });
  await fixture(({ store, databasePath }) => {
    const prepared = prepare(store);
    store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease));
    store.createOrGet(TASK_B, 'fp-b', intent);
    const db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER project_task_execution_invocations_immutable_update; PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE project_task_execution_invocations SET reserved_at = 999999').run();
    db.close();
    assert.throws(() => store.reconcileRestartSafeTasks(), /corrupt_project_task_execution_invocation_record/);
    assert.equal(store.get(TASK_B).status, 'accepted');
  });
  await fixture(({ store }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const lease = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'legacy', durationMs: 5_000 }).lease;
    store.consumeTaskDispatch({
      dispatchId: dispatch.dispatchId, taskId: TASK_A, leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId, fencingToken: lease.fencingToken,
    });
    assert.equal(store.reconcileRestartSafeTasks().failedInterrupted, 1);
    assert.equal(store.readTaskExecutionInvocationByTask(TASK_A), undefined);
  });
});

test('invocation layer has no automatic workflow, Hermes, Codex, authority, timer, route or server integration', async () => {
  const [storeSource, contractSource, serverSource, routeSource] = await Promise.all([
    readFile(new URL('../src/services/projectTaskSqliteStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/contracts/projectTaskExecutionInvocation.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/projectTaskWorkflow.ts', import.meta.url), 'utf8'),
  ]);
  const start = storeSource.indexOf('reserveTaskExecutionInvocation(');
  const end = storeSource.indexOf('\n  acquireTaskLease(', start);
  const boundary = storeSource.slice(start, end);
  for (const forbidden of [
    'executeProjectTaskWorkflow', 'hermesExecutor', 'projectCodexExecutor',
    'setInterval', 'setTimeout', 'setImmediate', 'enqueueTaskDispatch(',
    'prepareTaskExecutionRun(', 'transition(', 'acquireTaskLease(',
    'renewTaskLease(', 'releaseTaskLease(',
  ]) assert.equal(boundary.includes(forbidden), false, forbidden);
  assert.equal(serverSource.includes('reserveTaskExecutionInvocation('), false);
  assert.equal(routeSource.includes('reserveTaskExecutionInvocation('), false);
  assert.doesNotMatch(boundary + contractSource, /\b(push|merge|deploy|production_write|database_write|secret_access|arbitrary shell)\b/);
  assert.match(contractSource, /does not mean execution started/);
  assert.match(contractSource, /grants no workflow, external-execution, project, or capability authority/);
});
