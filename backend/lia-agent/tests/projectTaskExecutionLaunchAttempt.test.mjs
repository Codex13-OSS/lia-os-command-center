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
import { PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_MAX_LIST_LIMIT } from '../dist/contracts/projectTaskExecutionLaunchAttempt.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';

const TASK_A = '450e8400-e29b-41d4-a716-446655440000';
const TASK_B = '450e8400-e29b-41d4-a716-446655440001';
const TASK_C = '450e8400-e29b-41d4-a716-446655440002';
const UNKNOWN = '450e8400-e29b-41d4-a716-446655440099';
const GOAL = '650e8400-e29b-41d4-a716-446655440000';
const ROOT = '750e8400-e29b-41d4-a716-446655440000';
const WORKER = new URL('./fixtures/projectTaskDispatchWorker.mjs', import.meta.url);
const intent = {
  projectId: 'safe',
  instruction: 'Cross the durable launch boundary without external execution.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests'],
};
const receipt = { executionId: 'historical-result', status: 'verified', resultText: 'done' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Additive V11 relations that must be removed to reconstruct an authentic V10 database.
const REWIND_V11_TO_V10_SQL = `
  DROP TRIGGER project_task_execution_launch_attempts_preserve_on_lease_release;
  DROP TRIGGER project_task_execution_launch_attempts_validate_insert;
  DROP TRIGGER project_task_execution_launch_attempts_immutable_update;
  DROP TRIGGER project_task_execution_launch_attempts_immutable_delete;
  DROP INDEX project_task_execution_launch_attempts_crossed;
  DROP TABLE project_task_execution_launch_attempts;
  UPDATE project_task_meta SET schema_version = 10 WHERE singleton = 1;
`;
const CHAIN_TABLES = [
  'project_tasks', 'project_task_active_stage_traces', 'project_goals',
  'project_task_lineage', 'project_goal_evaluations', 'project_goal_continuation_plans',
  'project_goal_continuation_consumptions', 'project_task_lease_generations',
  'project_task_dispatch_outbox', 'project_task_execution_runs',
  'project_task_execution_invocations',
];

async function fixture(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-attempt-'));
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

function prepare(store, taskId = TASK_A, owner = 'worker', durationMs = 10_000) {
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

const launchInput = (invocation, run, lease, overrides = {}) => ({
  invocationId: invocation.invocationId,
  executionRunId: run.executionRunId,
  taskId: run.taskId,
  leaseOwner: lease.leaseOwner,
  leaseId: lease.leaseId,
  fencingToken: lease.fencingToken,
  ...overrides,
});

function chain(store, taskId = TASK_A, owner = 'worker', durationMs = 10_000) {
  const prepared = prepare(store, taskId, owner, durationMs);
  const invocation = store.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease));
  return { ...prepared, invocation };
}

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

test('first crossing creates exactly one canonical launch attempt and changes no prior boundary', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const before = {
      task: tableRows(databasePath, 'project_tasks'),
      dispatch: tableRows(databasePath, 'project_task_dispatch_outbox'),
      run: tableRows(databasePath, 'project_task_execution_runs'),
      lease: tableRows(databasePath, 'project_task_lease_generations'),
    };
    const result = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    assert.equal(result.created, true);
    assert.match(result.launchAttempt.launchAttemptId, UUID_V4);
    assert.deepEqual(result.launchAttempt, {
      launchAttemptId: result.launchAttempt.launchAttemptId,
      invocationId: invocation.invocationId,
      executionRunId: run.executionRunId,
      taskId: TASK_A,
      launchLeaseId: lease.leaseId,
      launchFencingToken: lease.fencingToken,
      boundaryCrossedAt: 1_000,
    });
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
    assert.equal(store.get(TASK_A).status, 'accepted');
    assert.deepEqual(tableRows(databasePath, 'project_tasks'), before.task);
    assert.deepEqual(tableRows(databasePath, 'project_task_dispatch_outbox'), before.dispatch);
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_runs'), before.run);
    assert.deepEqual(tableRows(databasePath, 'project_task_lease_generations'), before.lease);
  });
});

test('created=true is reported only for the first durable creation', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    assert.equal(store.beginTaskExecutionLaunchAttempt(input).created, true);
    assert.equal(store.beginTaskExecutionLaunchAttempt(input).created, false);
    assert.equal(store.beginTaskExecutionLaunchAttempt(input).created, false);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('exact replay returns the same launchAttempt identity with created=false', async () => {
  await fixture(({ store }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    const first = store.beginTaskExecutionLaunchAttempt(input);
    const replay = store.beginTaskExecutionLaunchAttempt(input);
    assert.equal(replay.created, false);
    assert.equal(replay.launchAttempt.launchAttemptId, first.launchAttempt.launchAttemptId);
    assert.deepEqual(replay.launchAttempt, first.launchAttempt);
    assert.deepEqual(store.readTaskExecutionLaunchAttempt(first.launchAttempt.launchAttemptId), first.launchAttempt);
  });
});

test('replay after lease release returns the same attempt with created=false', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    const first = store.beginTaskExecutionLaunchAttempt(input);
    store.releaseTaskLease({
      taskId: TASK_A, leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId, fencingToken: lease.fencingToken,
    });
    const replay = store.beginTaskExecutionLaunchAttempt(input);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.launchAttempt, first.launchAttempt);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('replay after lease expiry returns the same attempt with created=false', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    const first = store.beginTaskExecutionLaunchAttempt(input);
    setNow(20_000);
    assert.ok(20_000 > lease.leaseExpiresAt);
    const replay = store.beginTaskExecutionLaunchAttempt(input);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.launchAttempt, first.launchAttempt);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('replay after database reopen returns the same attempt with created=false', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-attempt-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp', intent);
    const { run, lease, invocation } = chain(first);
    const input = launchInput(invocation, run, lease);
    const attempt = first.beginTaskExecutionLaunchAttempt(input);
    first.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 30_000 });
    const replay = reopened.beginTaskExecutionLaunchAttempt(input);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.launchAttempt, attempt.launchAttempt);
    assert.deepEqual(reopened.readTaskExecutionLaunchAttempt(attempt.launchAttempt.launchAttemptId), attempt.launchAttempt);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed input fails closed without crossing the boundary', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    for (const malformed of [
      null,
      undefined,
      42,
      'launch',
      [],
      {},
      { ...input, invocationId: 42 },
      { ...input, executionRunId: 'bad' },
      { ...input, taskId: 'bad' },
      { ...input, leaseOwner: '' },
      { ...input, leaseId: 42 },
      { ...input, fencingToken: '1' },
      { ...input, fencingToken: 0 },
    ]) assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(malformed),
      /invalid_project_task_execution_launch_attempt_input/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('missing field fails closed', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    for (const key of Object.keys(input)) {
      const missing = { ...input };
      delete missing[key];
      assert.throws(
        () => store.beginTaskExecutionLaunchAttempt(missing),
        /invalid_project_task_execution_launch_attempt_input/,
        key,
      );
    }
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('extra field fails closed', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    for (const extra of [
      'approvedCapabilities', 'authority', 'capabilities', 'extra', 'launchNow', 'force',
    ]) assert.throws(
      () => store.beginTaskExecutionLaunchAttempt({ ...input, [extra]: true }),
      /invalid_project_task_execution_launch_attempt_input/,
      extra,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('unknown invocation fails closed', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { invocationId: UNKNOWN })),
      /project_task_execution_launch_attempt_invocation_not_found/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('unknown run fails closed', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { executionRunId: UNKNOWN })),
      /project_task_execution_launch_attempt_invocation_run_mismatch/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('unknown task fails closed', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { taskId: UNKNOWN })),
      /project_task_execution_launch_attempt_task_not_found/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('mismatched invocation, run and task tuples fail closed', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store, TASK_A, 'worker');
    store.createOrGet(TASK_B, 'fp-b', intent);
    const other = prepare(store, TASK_B, 'worker-b');
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { taskId: TASK_B })),
      /project_task_execution_launch_attempt_invocation_run_mismatch/,
    );
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { executionRunId: other.run.executionRunId })),
      /project_task_execution_launch_attempt_invocation_run_mismatch/,
    );
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, {
        executionRunId: other.run.executionRunId,
        taskId: TASK_B,
      })),
      /project_task_execution_launch_attempt_invocation_run_mismatch/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('terminal and noneligible tasks cannot create a first attempt', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.transition(TASK_A, 'planning');
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /project_task_execution_launch_attempt_task_unavailable/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.complete(TASK_A, receipt);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /project_task_execution_launch_attempt_task_unavailable/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.fail(TASK_A, { code: 'workflow_failed', message: SAFE_TASK_ERROR_MESSAGES.workflow_failed });
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /project_task_execution_launch_attempt_task_unavailable/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('wrong lease owner fails for creation and replay', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { leaseOwner: 'intruder' })),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    const attempt = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    assert.equal(attempt.created, true);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { leaseOwner: 'intruder' })),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('wrong leaseId fails for creation and replay', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { leaseId: UNKNOWN })),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    const attempt = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    assert.equal(attempt.created, true);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { leaseId: UNKNOWN })),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('wrong fencingToken fails for creation and replay', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { fencingToken: 2 })),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    const attempt = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    assert.equal(attempt.created, true);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { fencingToken: 2 })),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('released lease cannot create a FIRST attempt', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.releaseTaskLease({
      taskId: TASK_A, leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId, fencingToken: lease.fencingToken,
    });
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('expired lease cannot create a FIRST attempt', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const { run, lease, invocation } = chain(store, TASK_A, 'worker', 1_000);
    setNow(5_000);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /project_task_lease_expired/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('stale generation cannot create a FIRST attempt', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const { run, lease, invocation } = chain(store, TASK_A, 'old-worker', 1_000);
    setNow(5_000);
    const current = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'new-worker', durationMs: 5_000 });
    assert.equal(current.fencingToken, 2);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('safely reacquired newer generation CAN create the first attempt for the old, still-valid invocation ticket', async () => {
  await fixture(({ store, setNow }) => {
    const { run, lease, invocation } = chain(store, TASK_A, 'old-worker', 1_000);
    const reservedAt = invocation.reservedAt;
    setNow(5_000);
    const current = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'new-worker', durationMs: 5_000 });
    assert.equal(current.fencingToken, 2);
    const result = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, current));
    assert.equal(result.created, true);
    assert.equal(result.launchAttempt.invocationId, invocation.invocationId);
    assert.equal(result.launchAttempt.launchLeaseId, current.leaseId);
    assert.equal(result.launchAttempt.launchFencingToken, 2);
    assert.ok(result.launchAttempt.boundaryCrossedAt >= reservedAt);
    assert.equal(store.readTaskExecutionInvocation(invocation.invocationId).reservedAt, reservedAt);
    assert.equal(store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, current)).created, false);
  });
});

test('concurrent exact duplicate callers converge to one durable attempt', async () => {
  await fixture(async ({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    store.close();
    const results = await Promise.all([
      runWorker({ action: 'launch', databasePath, now: 1_001, input }),
      runWorker({ action: 'launch', databasePath, now: 1_001, input }),
    ]);
    assert.equal(results.every((result) => result.ok), true);
    assert.equal(results.filter((result) => result.result.created).length, 1);
    assert.equal(results.filter((result) => !result.result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.result.launchAttempt.launchAttemptId)).size, 1);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
  await fixture(async ({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    store.close();
    const results = await Promise.all([
      runWorker({ action: 'launch', databasePath, now: 1_001, input }),
      runWorker({ action: 'launch', databasePath, now: 1_001, input: { ...input, leaseOwner: 'competitor' } }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);
    assert.match(results.find((result) => !result.ok).error, /project_task_execution_launch_attempt_authority_mismatch/);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('competing owner cannot create another attempt', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const input = launchInput(invocation, run, lease);
    const attempt = store.beginTaskExecutionLaunchAttempt(input);
    assert.equal(attempt.created, true);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease, { leaseOwner: 'competitor' })),
      /project_task_execution_launch_attempt_authority_mismatch/,
    );
    assert.deepEqual(store.listTaskExecutionLaunchAttempts(10), [attempt.launchAttempt]);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('insert fault rolls the transaction back atomically', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const before = {
      task: tableRows(databasePath, 'project_tasks'),
      dispatch: tableRows(databasePath, 'project_task_dispatch_outbox'),
      run: tableRows(databasePath, 'project_task_execution_runs'),
      lease: tableRows(databasePath, 'project_task_lease_generations'),
      invocation: tableRows(databasePath, 'project_task_execution_invocations'),
    };
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER launch_attempt_insert_fault BEFORE INSERT ON project_task_execution_launch_attempts BEGIN SELECT RAISE(ABORT, 'insert_fault'); END");
    db.close();
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /insert_fault/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
    assert.deepEqual({
      task: tableRows(databasePath, 'project_tasks'),
      dispatch: tableRows(databasePath, 'project_task_dispatch_outbox'),
      run: tableRows(databasePath, 'project_task_execution_runs'),
      lease: tableRows(databasePath, 'project_task_lease_generations'),
      invocation: tableRows(databasePath, 'project_task_execution_invocations'),
    }, before);
  });
});

test('direct SQL UPDATE of a launch attempt is rejected', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare('UPDATE project_task_execution_launch_attempts SET boundary_crossed_at = 99_000').run(),
      /project_task_execution_launch_attempt_immutable/,
    );
    assert.throws(
      () => db.prepare('UPDATE project_task_execution_launch_attempts SET launch_lease_id = ?').run(UNKNOWN),
      /project_task_execution_launch_attempt_immutable/,
    );
    db.close();
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('direct SQL DELETE of a launch attempt is rejected', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare('DELETE FROM project_task_execution_launch_attempts').run(),
      /project_task_execution_launch_attempt_immutable/,
    );
    db.close();
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('malformed direct SQL relationship and lifetime inserts are rejected', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.createOrGet(TASK_B, 'fp-b', intent);
    const other = prepare(store, TASK_B, 'worker-b');
    const db = new DatabaseSync(databasePath);
    const insert = db.prepare('INSERT INTO project_task_execution_launch_attempts VALUES (?, ?, ?, ?, ?, ?, ?)');
    // Invocation of task A claimed for task B.
    assert.throws(
      () => insert.run(UNKNOWN, invocation.invocationId, run.executionRunId, TASK_B, lease.leaseId, lease.fencingToken, 1_000),
      /project_task_execution_launch_attempt_incompatible/,
    );
    // Boundary before the invocation was reserved.
    assert.throws(
      () => insert.run(UNKNOWN, invocation.invocationId, run.executionRunId, TASK_A, lease.leaseId, lease.fencingToken, 500),
      /project_task_execution_launch_attempt_incompatible/,
    );
    // Boundary outside the lease lifetime.
    assert.throws(
      () => insert.run(UNKNOWN, invocation.invocationId, run.executionRunId, TASK_A, lease.leaseId, lease.fencingToken, 99_000),
      /project_task_execution_launch_attempt_incompatible/,
    );
    // Launch lease that belongs to another task.
    assert.throws(
      () => insert.run(UNKNOWN, invocation.invocationId, run.executionRunId, TASK_A, other.lease.leaseId, other.lease.fencingToken, 1_000),
      /project_task_execution_launch_attempt_incompatible/,
    );
    db.close();
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('read APIs cause no task, lease, run or invocation mutation', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const attempt = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    const before = Object.fromEntries([
      ...CHAIN_TABLES,
      'project_task_execution_launch_attempts',
    ].map((table) => [table, JSON.stringify(tableRows(databasePath, table))]));
    assert.deepEqual(store.readTaskExecutionLaunchAttempt(attempt.launchAttempt.launchAttemptId), attempt.launchAttempt);
    assert.deepEqual(store.readTaskExecutionLaunchAttemptByInvocation(invocation.invocationId), attempt.launchAttempt);
    assert.deepEqual(store.readTaskExecutionLaunchAttemptByTask(TASK_A), attempt.launchAttempt);
    assert.deepEqual(store.listTaskExecutionLaunchAttempts(10), [attempt.launchAttempt]);
    assert.deepEqual(store.readTaskExecutionInvocation(invocation.invocationId), invocation);
    assert.deepEqual(store.readTaskExecutionRunByTask(TASK_A), run);
    assert.deepEqual(store.readTaskLease(TASK_A), lease);
    assert.deepEqual(store.readTaskDispatchByTask(TASK_A).dispatchId, run.dispatchId);
    assert.equal(store.get(TASK_A).status, 'accepted');
    for (const [table, snapshot] of Object.entries(before)) {
      assert.equal(JSON.stringify(tableRows(databasePath, table)), snapshot, table);
    }
  });
});

test('list is deterministic and bounded', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const first = chain(store, TASK_A, 'worker-a');
    const attemptA = store.beginTaskExecutionLaunchAttempt(launchInput(first.invocation, first.run, first.lease));
    store.createOrGet(TASK_B, 'fp-b', intent);
    setNow(2_000);
    const second = chain(store, TASK_B, 'worker-b');
    const attemptB = store.beginTaskExecutionLaunchAttempt(launchInput(second.invocation, second.run, second.lease));
    store.createOrGet(TASK_C, 'fp-c', intent);
    setNow(3_000);
    const third = chain(store, TASK_C, 'worker-c');
    const attemptC = store.beginTaskExecutionLaunchAttempt(launchInput(third.invocation, third.run, third.lease));
    const expected = [attemptA.launchAttempt, attemptB.launchAttempt, attemptC.launchAttempt];
    assert.deepEqual(store.listTaskExecutionLaunchAttempts(1), expected.slice(0, 1));
    assert.deepEqual(store.listTaskExecutionLaunchAttempts(2), expected.slice(0, 2));
    assert.deepEqual(store.listTaskExecutionLaunchAttempts(3), expected);
    assert.deepEqual(store.listTaskExecutionLaunchAttempts(10), expected);
    assert.deepEqual(store.listTaskExecutionLaunchAttempts(10), store.listTaskExecutionLaunchAttempts(10));
    for (const limit of [0, -1, 1.5, PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_MAX_LIST_LIMIT + 1]) {
      assert.throws(() => store.listTaskExecutionLaunchAttempts(limit), /invalid_project_task_execution_launch_attempt_input/);
    }
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 3);
  });
});

test('V10 to V11 migration preserves the complete existing chain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-attempt-v10-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createGoal({
      goalId: GOAL,
      projectId: 'safe',
      objective: 'Preserve the complete durable chain through V11 migration.',
      maxAttempts: 3,
      continuationDepthLimit: 2,
    });
    initial.createRootAttempt({ taskId: ROOT, fingerprint: 'root-fp', intent, goalId: GOAL, continuationDepth: 0, attemptNumber: 0 });
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
    const prepared = prepare(initial, continuation.createdTaskId);
    const invocation = initial.reserveTaskExecutionInvocation(reservationInput(prepared.run, prepared.lease));
    initial.createOrGet(TASK_B, 'fp-b', intent);
    initial.enqueueTaskDispatch(TASK_B);
    initial.close();

    const v10 = new DatabaseSync(databasePath);
    const before = Object.fromEntries(CHAIN_TABLES.map((table) => [
      table,
      JSON.stringify(v10.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ]));
    v10.exec(REWIND_V11_TO_V10_SQL);
    v10.close();

    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 11);
    assert.equal(migrated.readTaskExecutionInvocationByRun(prepared.run.executionRunId).invocationId, invocation.invocationId);
    assert.equal(migrated.readTaskExecutionRunByTask(continuation.createdTaskId).executionRunId, prepared.run.executionRunId);
    migrated.close();

    const check = new DatabaseSync(databasePath);
    for (const [table, snapshot] of Object.entries(before)) {
      assert.equal(JSON.stringify(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), snapshot, table);
    }
    assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, 11);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_launch_attempts').get().total, 0);
    check.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('V10 to V11 migration manufactures zero launch attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-attempt-migrate-zero-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createOrGet(TASK_A, 'fp-a', intent);
    const prepared = chain(initial);
    initial.createOrGet(TASK_B, 'fp-b', intent);
    initial.close();
    const before = Object.fromEntries(CHAIN_TABLES.map((table) => [
      table,
      JSON.stringify(tableRows(databasePath, table)),
    ]));
    const v10 = new DatabaseSync(databasePath);
    v10.exec(REWIND_V11_TO_V10_SQL);
    v10.close();
    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    migrated.close();
    const check = new DatabaseSync(databasePath);
    for (const [table, snapshot] of Object.entries(before)) {
      assert.equal(JSON.stringify(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), snapshot, table);
    }
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_launch_attempts').get().total, 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_invocations').get().total, 1);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_runs').get().total, 1);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_dispatch_outbox').get().total, 1);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_lease_generations').get().total, 1);
    check.close();
    assert.equal(prepared.invocation.reservedAt, 1_000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery with invocation but no launch attempt keeps safe pre-launch behavior', async () => {
  await fixture(({ store, databasePath }) => {
    const { dispatch, run, lease, invocation } = chain(store);
    const result = store.reconcileRestartSafeTasks();
    assert.deepEqual(result, { preservedRecoverable: 1, failedInterrupted: 0, terminalUnchanged: 0 });
    const task = store.get(TASK_A);
    assert.equal(task.status, 'accepted');
    assert.equal(task.terminalAt, undefined);
    assert.equal(task.error, undefined);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
    assert.equal(tableRows(databasePath, 'project_task_execution_invocations').length, 1);
    assert.equal(tableRows(databasePath, 'project_task_execution_runs').length, 1);
    assert.equal(tableRows(databasePath, 'project_task_dispatch_outbox').length, 1);
    assert.equal(tableRows(databasePath, 'project_task_lease_generations').length, 1);
    assert.deepEqual(store.readTaskExecutionInvocation(invocation.invocationId), invocation);
    assert.deepEqual(store.readTaskDispatch(dispatch.dispatchId).consumedAt, run.preparedAt);
  });
});

test('recovery with a launch attempt fails closed as external_launch_outcome_unknown and performs no relaunch', async () => {
  await fixture(({ store, databasePath }) => {
    const { dispatch, run, lease, invocation } = chain(store);
    const attempt = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    const result = store.reconcileRestartSafeTasks();
    assert.deepEqual(result, { preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0 });
    const task = store.get(TASK_A);
    assert.equal(task.status, 'failed');
    assert.equal(task.error.code, 'external_launch_outcome_unknown');
    assert.equal(task.error.message, SAFE_TASK_ERROR_MESSAGES.external_launch_outcome_unknown);
    assert.ok(task.terminalAt >= attempt.launchAttempt.boundaryCrossedAt);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_launch_attempts')[0].launch_attempt_id, attempt.launchAttempt.launchAttemptId);
    assert.equal(tableRows(databasePath, 'project_task_execution_invocations').length, 1);
    assert.equal(tableRows(databasePath, 'project_task_execution_runs').length, 1);
    assert.equal(tableRows(databasePath, 'project_task_dispatch_outbox').length, 1);
    assert.equal(tableRows(databasePath, 'project_task_lease_generations').length, 1);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
    assert.equal(store.listPendingTaskDispatches(10).length, 0);
    assert.equal(store.listReservedTaskExecutionInvocations(10).length, 1);
    assert.equal(store.readTaskDispatch(dispatch.dispatchId).consumedAt, run.preparedAt);
  });
});

test('recovery remains idempotent after database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-attempt-recovery-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp', intent);
    const { run, lease, invocation } = chain(first);
    first.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    assert.deepEqual(first.reconcileRestartSafeTasks(), { preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0 });
    const failedSnapshot = JSON.stringify(tableRows(databasePath, 'project_tasks'));
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.deepEqual(reopened.reconcileRestartSafeTasks(), { preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 1 });
    assert.equal(JSON.stringify(tableRows(databasePath, 'project_tasks')), failedSnapshot);
    assert.equal(reopened.get(TASK_A).error.code, 'external_launch_outcome_unknown');
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('corrupt launch-attempt relationship causes atomic fail-closed recovery', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.createOrGet(TASK_B, 'fp-b', intent);
    const leaseB = store.acquireTaskLease({ taskId: TASK_B, leaseOwner: 'worker-b', durationMs: 10_000 });
    const db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER project_task_execution_launch_attempts_validate_insert');
    db.prepare(`
      INSERT INTO project_task_execution_launch_attempts (
        launch_attempt_id, invocation_id, execution_run_id, task_id,
        launch_lease_id, launch_fencing_token, boundary_crossed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(UNKNOWN, invocation.invocationId, run.executionRunId, TASK_B, leaseB.leaseId, leaseB.fencingToken, 1_000);
    db.close();
    assert.throws(
      () => store.reconcileRestartSafeTasks(),
      /corrupt_project_task_execution_launch_attempt_record/,
    );
    assert.equal(store.get(TASK_A).status, 'accepted');
    assert.equal(store.get(TASK_A).error, undefined);
    assert.equal(store.get(TASK_B).status, 'accepted');
    assert.equal(store.get(TASK_B).error, undefined);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
});

test('terminal task behavior stays unchanged', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.complete(TASK_A, receipt);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /project_task_execution_launch_attempt_task_unavailable/,
    );
    assert.deepEqual(store.reconcileRestartSafeTasks(), { preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 1 });
    const task = store.get(TASK_A);
    assert.equal(task.status, 'completed');
    assert.deepEqual(task.receipt, receipt);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    store.fail(TASK_A, { code: 'workflow_failed', message: SAFE_TASK_ERROR_MESSAGES.workflow_failed });
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease)),
      /project_task_execution_launch_attempt_task_unavailable/,
    );
    assert.deepEqual(store.reconcileRestartSafeTasks(), { preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 1 });
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 0);
  });
});

test('contract and state contain no new authority or capability fields', async () => {
  await fixture(({ store }) => {
    const { run, lease, invocation } = chain(store);
    const attempt = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    assert.deepEqual(Object.keys(attempt.launchAttempt).sort(), [
      'boundaryCrossedAt', 'executionRunId', 'invocationId', 'launchAttemptId',
      'launchFencingToken', 'launchLeaseId', 'taskId',
    ]);
    const input = launchInput(invocation, run, lease);
    assert.deepEqual(Object.keys(input).sort(), [
      'executionRunId', 'fencingToken', 'invocationId', 'leaseId', 'leaseOwner', 'taskId',
    ]);
    assert.doesNotMatch(JSON.stringify(attempt.launchAttempt), /capabilit|authorit|instruction|prompt|command|secret|session|agent|provider|model|hermes|codex|workflow/i);
  });
  const source = await readFile(new URL('../src/contracts/projectTaskExecutionLaunchAttempt.ts', import.meta.url), 'utf8');
  const recordType = source.slice(
    source.indexOf('export type ProjectTaskExecutionLaunchAttemptRecord'),
    source.indexOf('export type BeginProjectTaskExecutionLaunchAttemptInput'),
  );
  assert.doesNotMatch(recordType, /capabilit|authorit|instruction|prompt|command|secret|session|agent|provider|model/i);
  assert.match(recordType, /launchAttemptId: string;\n  invocationId: string;\n  executionRunId: string;\n  taskId: string;\n  launchLeaseId: string;\n  launchFencingToken: number;\n  boundaryCrossedAt: number;/);
});

test('a launch attempt existing does not mean Hermes started', async () => {
  await fixture(({ store, databasePath }) => {
    const { run, lease, invocation } = chain(store);
    const attempt = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    assert.equal(attempt.created, true);
    assert.doesNotMatch(JSON.stringify(attempt.launchAttempt), /started|executed|delivered|prompt|session|agent|hermes|codex|workflow|executor|timer/i);
    const db = new DatabaseSync(databasePath);
    const runtimeObjects = db.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name LIKE '%hermes%' OR name LIKE '%codex%' OR name LIKE '%workflow%'
         OR name LIKE '%executor%' OR name LIKE '%agent%' OR name LIKE '%session%'
         OR name LIKE '%prompt%' OR name LIKE '%timer%'
    `).all();
    assert.deepEqual(runtimeObjects, []);
    db.close();
    assert.equal(store.readTaskExecutionLaunchAttemptByInvocation(invocation.invocationId).launchAttemptId, attempt.launchAttempt.launchAttemptId);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_attempts').length, 1);
  });
  const source = await readFile(new URL('../src/contracts/projectTaskExecutionLaunchAttempt.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('It does NOT mean Hermes started'));
  assert.ok(source.includes('NEVER permission to launch externally'));
});

test('no exactly-once semantic is claimed', async () => {
  await fixture(({ store }) => {
    const { run, lease, invocation } = chain(store);
    const attempt = store.beginTaskExecutionLaunchAttempt(launchInput(invocation, run, lease));
    assert.deepEqual(Object.keys(attempt.launchAttempt).sort(), [
      'boundaryCrossedAt', 'executionRunId', 'invocationId', 'launchAttemptId',
      'launchFencingToken', 'launchLeaseId', 'taskId',
    ]);
    assert.doesNotMatch(JSON.stringify(attempt), /delivered|acknowledged|consumed|retryCount|attemptCount|status/i);
  });
  const source = await readFile(new URL('../src/contracts/projectTaskExecutionLaunchAttempt.ts', import.meta.url), 'utf8');
  assert.match(source, /does NOT mean[\s\S]{0,400}exactly-once/);
  assert.match(source, /created=false[\s\S]{0,300}NEVER permission to launch/);
});

test('no product-runtime workflow, Hermes, Codex, route or timer launch integration exists', async () => {
  const [storeSource, contractSource] = await Promise.all([
    readFile(new URL('../src/services/projectTaskSqliteStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/contracts/projectTaskExecutionLaunchAttempt.ts', import.meta.url), 'utf8'),
  ]);
  const begin = storeSource.slice(
    storeSource.indexOf('beginTaskExecutionLaunchAttempt('),
    storeSource.indexOf('readTaskExecutionLaunchAttempt(', storeSource.indexOf('beginTaskExecutionLaunchAttempt(')),
  );
  for (const forbidden of [
    'workflowService', 'executeProjectTaskWorkflow', 'hermesExecutor', 'projectCodexExecutor',
    'setTimeout', 'setInterval', 'fetch(', 'child_process', 'spawn(', 'execFile',
  ]) assert.equal(begin.includes(forbidden), false, forbidden);
  assert.doesNotMatch(begin, /\b(push|merge|deploy|production_write|secret_access|database_write)\b/);

  const workflowService = await readFile(new URL('../src/services/projectTaskWorkflowService.ts', import.meta.url), 'utf8');
  const executionService = await readFile(new URL('../src/services/projectTaskExecutionService.ts', import.meta.url), 'utf8');
  const reconciliation = await readFile(new URL('../src/services/projectTaskReconciliation.ts', import.meta.url), 'utf8');
  const inMemoryStore = await readFile(new URL('../src/services/inMemoryProjectTaskStore.ts', import.meta.url), 'utf8');
  for (const [name, source] of [
    ['projectTaskWorkflowService.ts', workflowService],
    ['projectTaskExecutionService.ts', executionService],
    ['projectTaskReconciliation.ts', reconciliation],
    ['inMemoryProjectTaskStore.ts', inMemoryStore],
  ]) {
    assert.equal(source.includes('LaunchAttempt'), false, name);
    assert.equal(source.includes('launch attempt'), false, name);
  }
  for (const route of [
    'status.ts', 'sameOriginStatus.ts', 'projectTasks.ts', 'projectTaskWorkflow.ts',
    'projectTaskExecution.ts', 'projectOrchestration.ts', 'hermesQuery.ts', 'hermes.ts',
    'health.ts', 'agenda.ts',
  ]) {
    const source = await readFile(new URL(`../src/routes/${route}`, import.meta.url), 'utf8');
    assert.equal(source.includes('LaunchAttempt'), false, route);
    assert.equal(source.includes('launch attempt'), false, route);
  }
  assert.equal(contractSource.includes('ProjectTaskExecutionLaunchAttemptStore'), true);
  assert.equal(contractSource.includes('beginTaskExecutionLaunchAttempt'), true);
});
