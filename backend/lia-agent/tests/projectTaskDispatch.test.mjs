import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { PROJECT_TASK_DISPATCH_MAX_LIST_LIMIT } from '../dist/contracts/projectTaskDispatch.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';

const TASK_A = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';
const UNKNOWN = '550e8400-e29b-41d4-a716-446655440099';
const WORKER = new URL('./fixtures/projectTaskDispatchWorker.mjs', import.meta.url);
const intent = {
  projectId: 'safe',
  instruction: 'Durable dispatch test task.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests'],
};
const receipt = { executionId: 'exec', status: 'verified', resultText: 'done' };

const consumeInput = (dispatch, lease) => ({
  dispatchId: dispatch.dispatchId,
  taskId: dispatch.taskId,
  leaseOwner: lease.leaseOwner,
  leaseId: lease.leaseId,
  fencingToken: lease.fencingToken,
});

async function fixture(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-dispatch-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let now = options.now ?? 1_000;
  const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
  store.createOrGet(TASK_A, 'fp-a', intent);
  if (options.twoTasks) store.createOrGet(TASK_B, 'fp-b', intent);
  try {
    await fn({ store, databasePath, setNow: (value) => { now = value; } });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker_exit_${code}`));
    });
  });
}

test('enqueue is durable, generated internally, idempotent, and leaves task/capabilities untouched', async () => {
  await fixture(({ store, databasePath }) => {
    const before = store.get(TASK_A);
    const first = store.enqueueTaskDispatch(TASK_A);
    const replay = store.enqueueTaskDispatch(TASK_A);
    assert.match(first.dispatchId, /^[0-9a-f-]{36}$/);
    assert.notEqual(first.dispatchId, TASK_A);
    assert.deepEqual(replay, first);
    assert.deepEqual(store.readTaskDispatch(first.dispatchId), first);
    assert.deepEqual(store.readTaskDispatchByTask(TASK_A), first);
    assert.deepEqual(store.get(TASK_A), before);
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project_task_dispatch_outbox').get().total, 1);
    assert.deepEqual(db.prepare('PRAGMA table_info(project_task_dispatch_outbox)').all().map((row) => row.name), [
      'dispatch_id', 'task_id', 'created_at', 'consumed_at',
      'consumed_lease_id', 'consumed_fencing_token',
    ]);
    db.close();
  });
});

test('enqueue rejects unknown, non-accepted, terminal, malformed, and extra-field shaped input', async () => {
  await fixture(({ store }) => {
    assert.throws(() => store.enqueueTaskDispatch(UNKNOWN), /project_task_dispatch_task_not_found/);
    assert.throws(() => store.enqueueTaskDispatch({ taskId: TASK_A, requestedCapabilities: ['production_write'] }), /invalid_project_task_dispatch_input/);
    store.transition(TASK_A, 'planning');
    assert.throws(() => store.enqueueTaskDispatch(TASK_A), /project_task_dispatch_task_unavailable/);
  });
  await fixture(({ store }) => {
    store.complete(TASK_A, receipt);
    assert.throws(() => store.enqueueTaskDispatch(TASK_A), /project_task_dispatch_task_unavailable/);
  });
});

test('pending list is deterministic, bounded, side-effect free, and excludes consumed rows', async () => {
  await fixture(({ store, setNow }) => {
    const a = store.enqueueTaskDispatch(TASK_A);
    store.createOrGet(TASK_B, 'fp-b', intent);
    setNow(2_000);
    const b = store.enqueueTaskDispatch(TASK_B);
    assert.deepEqual(store.listPendingTaskDispatches(1), [a]);
    const beforeLease = store.readTaskLease(TASK_A);
    assert.deepEqual(store.listPendingTaskDispatches(2), [a, b]);
    assert.equal(store.readTaskLease(TASK_A), beforeLease);
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, PROJECT_TASK_DISPATCH_MAX_LIST_LIMIT + 1]) {
      assert.throws(() => store.listPendingTaskDispatches(limit), /invalid_project_task_dispatch_input/);
    }
    const claim = store.claimTaskDispatch({ dispatchId: a.dispatchId, leaseOwner: 'worker-a', durationMs: 2_000 });
    store.consumeTaskDispatch(consumeInput(a, claim.lease));
    assert.deepEqual(store.listPendingTaskDispatches(10), [b]);
  });
});

test('pending dispatch survives close/reopen with identical identity and state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-dispatch-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const firstStore = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    firstStore.createOrGet(TASK_A, 'fp', intent);
    const dispatch = firstStore.enqueueTaskDispatch(TASK_A);
    firstStore.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.deepEqual(reopened.readTaskDispatch(dispatch.dispatchId), dispatch);
    assert.deepEqual(reopened.listPendingTaskDispatches(10), [dispatch]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('claim is atomic with lease, same-owner replay is stable, and competitor is unavailable', async () => {
  await fixture(({ store, databasePath }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const first = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 2_000 });
    const replay = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 5_000 });
    assert.deepEqual(replay, first);
    assert.throws(
      () => store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-b', durationMs: 2_000 }),
      /project_task_lease_unavailable/,
    );
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project_task_lease_generations').get().total, 1);
    db.close();
  });
});

test('claim rejects malformed/unknown/consumed dispatches and status drift without creating authority', async () => {
  await fixture(({ store }) => {
    assert.throws(
      () => store.claimTaskDispatch({ dispatchId: 'x'.repeat(36), leaseOwner: 'worker-a', durationMs: 1_000 }),
      /invalid_project_task_dispatch_input/,
    );
    assert.throws(
      () => store.claimTaskDispatch({ dispatchId: UNKNOWN, leaseOwner: 'worker-a', durationMs: 1_000 }),
      /project_task_dispatch_not_found/,
    );
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    store.transition(TASK_A, 'planning');
    assert.throws(
      () => store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 1_000 }),
      /project_task_dispatch_task_unavailable/,
    );
    assert.equal(store.readTaskLease(TASK_A), undefined);
  });
  await fixture(({ store }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 1_000 });
    store.consumeTaskDispatch(consumeInput(dispatch, claim.lease));
    assert.throws(
      () => store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 1_000 }),
      /project_task_dispatch_already_consumed/,
    );
  });
});

test('expiry takeover increments fencing and stale generation cannot consume', async () => {
  await fixture(({ store, setNow }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const old = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-old', durationMs: 1_000 });
    setNow(2_000);
    const next = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-new', durationMs: 1_000 });
    assert.equal(next.lease.fencingToken, old.lease.fencingToken + 1);
    assert.notEqual(next.lease.leaseId, old.lease.leaseId);
    assert.throws(() => store.consumeTaskDispatch(consumeInput(dispatch, old.lease)), /project_task_dispatch_authority_mismatch/);
    assert.equal(store.consumeTaskDispatch(consumeInput(dispatch, next.lease)).consumedFencingToken, 2);
  });
});

test('exact consume is durable and replay-safe after expiry, reopen, and task terminalization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-dispatch-consume-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const firstStore = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    firstStore.createOrGet(TASK_A, 'fp', intent);
    const dispatch = firstStore.enqueueTaskDispatch(TASK_A);
    const claim = firstStore.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 1_000 });
    const input = consumeInput(dispatch, claim.lease);
    const consumed = firstStore.consumeTaskDispatch(input);
    assert.equal(consumed.consumedLeaseId, claim.lease.leaseId);
    assert.equal(consumed.consumedFencingToken, claim.lease.fencingToken);
    assert.deepEqual(firstStore.consumeTaskDispatch(input), consumed);
    firstStore.complete(TASK_A, receipt);
    assert.deepEqual(firstStore.consumeTaskDispatch(input), consumed);
    firstStore.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.deepEqual(reopened.consumeTaskDispatch(input), consumed);
    assert.deepEqual(reopened.readTaskDispatch(dispatch.dispatchId), consumed);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('consumed replay fails closed for wrong owner, lease id, token, task, and extra fields', async () => {
  await fixture(({ store }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 5_000 });
    const input = consumeInput(dispatch, claim.lease);
    store.consumeTaskDispatch(input);
    assert.throws(() => store.consumeTaskDispatch({ ...input, leaseOwner: 'worker-b' }), /authority_mismatch/);
    assert.throws(() => store.consumeTaskDispatch({ ...input, leaseId: UNKNOWN }), /authority_mismatch/);
    assert.throws(() => store.consumeTaskDispatch({ ...input, fencingToken: 2 }), /authority_mismatch/);
    assert.throws(() => store.consumeTaskDispatch({ ...input, taskId: TASK_B }), /authority_mismatch/);
    assert.throws(() => store.consumeTaskDispatch({ ...input, effectiveCapabilities: ['production_write'] }), /invalid_project_task_dispatch_input/);
    assert.throws(() => store.claimTaskDispatch({
      dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 1_000,
      requestedCapabilities: ['secret_access'],
    }), /invalid_project_task_dispatch_input/);
  });
});

test('first consume fails closed on status drift and expired authority; history remains readable', async () => {
  await fixture(({ store, setNow }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 1_000 });
    store.transition(TASK_A, 'planning');
    assert.throws(() => store.consumeTaskDispatch(consumeInput(dispatch, claim.lease)), /project_task_dispatch_task_unavailable/);
    assert.deepEqual(store.readTaskDispatch(dispatch.dispatchId), dispatch);
  });
  await fixture(({ store, setNow }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 1_000 });
    setNow(2_000);
    assert.throws(() => store.consumeTaskDispatch(consumeInput(dispatch, claim.lease)), /project_task_lease_expired/);
  });
});

test('two real connections converge concurrent enqueue to one logical row', async () => {
  await fixture(async ({ store, databasePath }) => {
    store.close();
    const results = await Promise.all([1, 2].map(() => runWorker({ action: 'enqueue', databasePath, taskId: TASK_A, now: 1_000 })));
    assert.equal(results.every((result) => result.ok), true);
    assert.equal(new Set(results.map((result) => result.result.dispatchId)).size, 1);
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project_task_dispatch_outbox').get().total, 1);
    db.close();
  });
});

test('two owners race claim: one wins; same-owner and expired takeover retain lease semantics', async () => {
  await fixture(async ({ store, databasePath }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    store.close();
    const results = await Promise.all(['worker-a', 'worker-b'].map((leaseOwner) => runWorker({
      action: 'claim', databasePath, now: 1_000,
      input: { dispatchId: dispatch.dispatchId, leaseOwner, durationMs: 1_000 },
    })));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok)[0].error, 'project_task_lease_unavailable');
  });
});

test('concurrent exact consume converges idempotently to the same durable record', async () => {
  await fixture(async ({ store, databasePath }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 10_000 });
    const input = consumeInput(dispatch, claim.lease);
    store.close();
    const results = await Promise.all([1, 2].map(() => runWorker({ action: 'consume', databasePath, now: 1_001, input })));
    assert.equal(results.every((result) => result.ok), true);
    assert.deepEqual(results[0].result, results[1].result);
  });
});

test('enqueue, claim takeover, and consume faults roll back without partial durable state', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    let db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER dispatch_enqueue_fault AFTER INSERT ON project_task_dispatch_outbox BEGIN SELECT RAISE(ABORT, 'enqueue_fault'); END");
    db.close();
    assert.throws(() => store.enqueueTaskDispatch(TASK_A), /enqueue_fault/);
    assert.equal(store.readTaskDispatchByTask(TASK_A), undefined);
    db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER dispatch_enqueue_fault');
    db.close();
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const old = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-old', durationMs: 1_000 });
    setNow(2_000);
    db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER dispatch_claim_fault AFTER INSERT ON project_task_lease_generations WHEN NEW.fencing_token = 2 BEGIN SELECT RAISE(ABORT, 'claim_fault'); END");
    db.close();
    assert.throws(() => store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-new', durationMs: 1_000 }), /claim_fault/);
    assert.deepEqual(store.readTaskLease(TASK_A), old.lease);
    db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER dispatch_claim_fault');
    db.close();
    setNow(1_500);
    const input = consumeInput(dispatch, old.lease);
    db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER dispatch_consume_fault AFTER UPDATE OF consumed_at ON project_task_dispatch_outbox BEGIN SELECT RAISE(ABORT, 'consume_fault'); END");
    db.close();
    assert.throws(() => store.consumeTaskDispatch(input), /consume_fault/);
    assert.deepEqual(store.readTaskDispatch(dispatch.dispatchId), dispatch);
  });
});

test('SQLite constraints protect outbox identity, write-once consumption, deletion, partial state, and duplicate task', async () => {
  await fixture(({ store, databasePath }) => {
    const dispatch = store.enqueueTaskDispatch(TASK_A);
    const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker-a', durationMs: 5_000 });
    const consumed = store.consumeTaskDispatch(consumeInput(dispatch, claim.lease));
    const db = new DatabaseSync(databasePath);
    assert.throws(() => db.prepare('UPDATE project_task_dispatch_outbox SET dispatch_id = ? WHERE task_id = ?').run(UNKNOWN, TASK_A), /project_task_dispatch_immutable/);
    assert.throws(() => db.prepare('UPDATE project_task_dispatch_outbox SET consumed_at = consumed_at + 1 WHERE task_id = ?').run(TASK_A), /project_task_dispatch_immutable/);
    assert.throws(() => db.prepare('DELETE FROM project_task_dispatch_outbox WHERE task_id = ?').run(TASK_A), /project_task_dispatch_immutable/);
    assert.throws(() => db.prepare(`INSERT INTO project_task_dispatch_outbox (dispatch_id, task_id, created_at) VALUES (?, ?, ?)`).run(UNKNOWN, TASK_A, 2_000), /UNIQUE constraint failed/);
    assert.equal(db.prepare('SELECT consumed_at FROM project_task_dispatch_outbox WHERE task_id = ?').get(TASK_A).consumed_at, consumed.consumedAt);
    db.close();
  });
});

test('authentic V7 shape migrates additively to V8 and preserves task and lease history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-dispatch-v7-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createOrGet(TASK_A, 'legacy-fp', intent);
    const lease = initial.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'legacy-worker', durationMs: 10_000 });
    initial.close();
    const v7 = new DatabaseSync(databasePath);
    v7.exec('DROP TRIGGER project_task_execution_launch_results_validate_insert; DROP TRIGGER project_task_execution_launch_results_immutable_update; DROP TRIGGER project_task_execution_launch_results_immutable_delete; DROP INDEX project_task_execution_launch_results_recorded; DROP TABLE project_task_execution_launch_results; DROP TRIGGER project_task_execution_invocations_preserve_on_lease_release; DROP TABLE project_task_execution_invocations; DROP TABLE project_task_execution_runs; DROP TABLE project_task_dispatch_outbox; DROP TRIGGER project_task_execution_launch_attempts_preserve_on_lease_release; DROP TRIGGER project_task_execution_launch_attempts_validate_insert; DROP TRIGGER project_task_execution_launch_attempts_immutable_update; DROP TRIGGER project_task_execution_launch_attempts_immutable_delete; DROP INDEX project_task_execution_launch_attempts_crossed; DROP TABLE project_task_execution_launch_attempts; UPDATE project_task_meta SET schema_version = 7 WHERE singleton = 1');
    v7.close();
    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.equal(migrated.get(TASK_A).fingerprint, 'legacy-fp');
    assert.deepEqual(migrated.readTaskLease(TASK_A), lease);
    const dispatch = migrated.enqueueTaskDispatch(TASK_A);
    assert.equal(dispatch.taskId, TASK_A);
    migrated.close();
    const check = new DatabaseSync(databasePath);
    assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 12);
    check.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
