import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';

const IDS = Array.from({ length: 20 }, (_, index) =>
  `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, '0')}`,
);
const interrupted = {
  code: 'workflow_interrupted',
  message: SAFE_TASK_ERROR_MESSAGES.workflow_interrupted,
};
const receipt = { executionId: 'exec', status: 'verified', resultText: 'done' };
const failure = { code: 'workflow_failed', message: SAFE_TASK_ERROR_MESSAGES.workflow_failed };
const intent = (instruction = 'Recovery test task.') => ({
  projectId: 'safe',
  instruction,
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests'],
});

async function withDatabase(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-recovery-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let now = options.now ?? 1_000;
  const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
  try {
    await fn({ store, databasePath, setNow(value) { now = value; } });
  } finally {
    if (store.isOpen !== false) store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function create(store, id, label = id) {
  store.createOrGet(id, `fp-${label}`, intent(`Task ${label}.`));
}

function consume(store, dispatch, lease) {
  return store.consumeTaskDispatch({
    dispatchId: dispatch.dispatchId,
    taskId: dispatch.taskId,
    leaseOwner: lease.leaseOwner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
}

function durableRows(databasePath, table, taskId) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE task_id = ? ORDER BY rowid`).all(taskId);
  } finally {
    db.close();
  }
}

test('CASE A accepted without outbox fails closed and does not manufacture dispatch', async () => {
  await withDatabase(({ store }) => {
    create(store, IDS[0]);
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0,
    });
    assert.equal(store.get(IDS[0]).status, 'failed');
    assert.deepEqual(store.get(IDS[0]).error, interrupted);
    assert.equal(store.readTaskDispatchByTask(IDS[0]), undefined);
  });
});

test('CASE B accepted with pending outbox and no lease is preserved exactly', async () => {
  await withDatabase(({ store, databasePath, setNow }) => {
    create(store, IDS[0]);
    const dispatch = store.enqueueTaskDispatch(IDS[0]);
    const taskBefore = store.get(IDS[0]);
    const outboxBefore = durableRows(databasePath, 'project_task_dispatch_outbox', IDS[0]);
    setNow(9_000);
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 1, failedInterrupted: 0, terminalUnchanged: 0,
    });
    assert.deepEqual(store.get(IDS[0]), taskBefore);
    assert.deepEqual(store.readTaskDispatch(dispatch.dispatchId), dispatch);
    assert.deepEqual(durableRows(databasePath, 'project_task_dispatch_outbox', IDS[0]), outboxBefore);
    assert.equal(store.readTaskLease(IDS[0]), undefined);
  });
});

test('CASE C valid lease and CASE D expired lease remain byte-for-byte unchanged without fencing takeover', async () => {
  await withDatabase(({ store, databasePath, setNow }) => {
    create(store, IDS[0], 'valid');
    create(store, IDS[1], 'expired');
    const validDispatch = store.enqueueTaskDispatch(IDS[0]);
    const expiredDispatch = store.enqueueTaskDispatch(IDS[1]);
    const valid = store.claimTaskDispatch({ dispatchId: validDispatch.dispatchId, leaseOwner: 'valid-owner', durationMs: 10_000 }).lease;
    const expired = store.claimTaskDispatch({ dispatchId: expiredDispatch.dispatchId, leaseOwner: 'expired-owner', durationMs: 1_000 }).lease;
    const validBefore = durableRows(databasePath, 'project_task_lease_generations', IDS[0]);
    const expiredBefore = durableRows(databasePath, 'project_task_lease_generations', IDS[1]);
    setNow(2_000);
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 2, failedInterrupted: 0, terminalUnchanged: 0,
    });
    assert.deepEqual(store.readTaskLease(IDS[0]), valid);
    assert.deepEqual(store.readTaskLease(IDS[1]), expired);
    assert.deepEqual(durableRows(databasePath, 'project_task_lease_generations', IDS[0]), validBefore);
    assert.deepEqual(durableRows(databasePath, 'project_task_lease_generations', IDS[1]), expiredBefore);
    assert.equal(valid.fencingToken, 1);
    assert.equal(expired.fencingToken, 1);
  });
});

test('CASE E accepted with consumed outbox fails closed without reopening outbox', async () => {
  await withDatabase(({ store, databasePath }) => {
    create(store, IDS[0]);
    const dispatch = store.enqueueTaskDispatch(IDS[0]);
    const lease = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'worker', durationMs: 5_000 }).lease;
    const consumed = consume(store, dispatch, lease);
    const before = durableRows(databasePath, 'project_task_dispatch_outbox', IDS[0]);
    assert.equal(store.reconcileRestartSafeTasks().failedInterrupted, 1);
    assert.deepEqual(store.get(IDS[0]).error, interrupted);
    assert.deepEqual(store.readTaskDispatch(dispatch.dispatchId), consumed);
    assert.deepEqual(durableRows(databasePath, 'project_task_dispatch_outbox', IDS[0]), before);
  });
});

test('CASE F/G and every supported post-accepted nonterminal stage fail closed', async () => {
  await withDatabase(({ store }) => {
    const stages = ['planning', 'hermes', 'codex', 'verification', 'commit'];
    stages.forEach((stage, index) => {
      create(store, IDS[index], stage);
      const dispatch = store.enqueueTaskDispatch(IDS[index]);
      if (index % 2 === 1) {
        const lease = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: `worker-${index}`, durationMs: 5_000 }).lease;
        consume(store, dispatch, lease);
      }
      store.transition(IDS[index], stage);
    });
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: stages.length, terminalUnchanged: 0,
    });
    for (const id of IDS.slice(0, stages.length)) {
      assert.equal(store.get(id).status, 'failed');
      assert.deepEqual(store.get(id).error, interrupted);
    }
  });
});

test('CASE H completed and failed records and timestamps remain identical', async () => {
  await withDatabase(({ store, setNow }) => {
    create(store, IDS[0], 'completed');
    create(store, IDS[1], 'failed');
    setNow(1_500);
    store.complete(IDS[0], receipt);
    store.fail(IDS[1], failure);
    const before = [store.get(IDS[0]), store.get(IDS[1])];
    setNow(8_000);
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 2,
    });
    assert.deepEqual([store.get(IDS[0]), store.get(IDS[1])], before);
  });
});

test('recovery is idempotent and durable across a real SQLite close/reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-recovery-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    create(first, IDS[0], 'recoverable');
    const dispatch = first.enqueueTaskDispatch(IDS[0]);
    create(first, IDS[1], 'ambiguous');
    assert.deepEqual(first.reconcileRestartSafeTasks(), {
      preservedRecoverable: 1, failedInterrupted: 1, terminalUnchanged: 0,
    });
    const preserved = first.get(IDS[0]);
    const failed = first.get(IDS[1]);
    assert.deepEqual(first.reconcileRestartSafeTasks(), {
      preservedRecoverable: 1, failedInterrupted: 0, terminalUnchanged: 1,
    });
    first.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.deepEqual(reopened.get(IDS[0]), preserved);
    assert.deepEqual(reopened.get(IDS[1]), failed);
    assert.deepEqual(reopened.readTaskDispatch(dispatch.dispatchId), dispatch);
    assert.deepEqual(reopened.reconcileRestartSafeTasks(), {
      preservedRecoverable: 1, failedInterrupted: 0, terminalUnchanged: 1,
    });
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('terminalization clears legacy receipt and active-stage trace with exact safe error', async () => {
  await withDatabase(({ store, databasePath, setNow }) => {
    create(store, IDS[0]);
    const dispatch = store.enqueueTaskDispatch(IDS[0]);
    store.transition(IDS[0], 'planning');
    store.transition(IDS[0], 'codex');
    store.close();
    const db = new DatabaseSync(databasePath);
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE project_tasks SET receipt_json = ? WHERE task_id = ?')
      .run(JSON.stringify(receipt), IDS[0]);
    db.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    try {
      assert.equal(reopened.reconcileRestartSafeTasks().failedInterrupted, 1);
      const record = reopened.get(IDS[0]);
      assert.deepEqual(record.error, interrupted);
      assert.equal(record.receipt, undefined);
      assert.equal(durableRows(databasePath, 'project_task_active_stage_traces', IDS[0]).length, 0);
      assert.equal(reopened.readTaskDispatch(dispatch.dispatchId).consumedAt, undefined);
    } finally {
      reopened.close();
    }
  });
});

test('contradictory accepted stage trace aborts and rolls back all recovery changes', async () => {
  await withDatabase(({ store, databasePath }) => {
    create(store, IDS[0], 'would-fail');
    create(store, IDS[1], 'corrupt-preserved');
    store.enqueueTaskDispatch(IDS[1]);
    const db = new DatabaseSync(databasePath);
    db.prepare('INSERT INTO project_task_active_stage_traces (task_id, completed_stages_json) VALUES (?, ?)')
      .run(IDS[1], JSON.stringify(['planning']));
    db.close();
    assert.throws(() => store.reconcileRestartSafeTasks(), /corrupt_project_task_record/);
    assert.equal(store.get(IDS[0]).status, 'accepted');
    const check = new DatabaseSync(databasePath);
    assert.equal(check.prepare('SELECT status FROM project_tasks WHERE task_id = ?').get(IDS[1]).status, 'accepted');
    check.close();
  });
});

test('accepted pending dispatch with empty active-stage trace aborts recovery and rolls back', async () => {
  await withDatabase(({ store, databasePath }) => {
    create(store, IDS[0], 'would-fail');
    create(store, IDS[1], 'empty-trace');

    const dispatch = store.enqueueTaskDispatch(IDS[1]);

    const db = new DatabaseSync(databasePath);
    db.prepare(
      'INSERT INTO project_task_active_stage_traces (task_id, completed_stages_json) VALUES (?, ?)',
    ).run(IDS[1], JSON.stringify([]));
    db.close();

    assert.throws(
      () => store.reconcileRestartSafeTasks(),
      /corrupt_project_task_record/,
    );

    // Recovery is atomic: discovering corrupt durable evidence must roll back
    // every classification/application from the same transaction.
    assert.equal(store.get(IDS[0]).status, 'accepted');

    const check = new DatabaseSync(databasePath);

    assert.equal(
      check.prepare(
        'SELECT status FROM project_tasks WHERE task_id = ?',
      ).get(IDS[1]).status,
      'accepted',
    );

    assert.equal(
      check.prepare(
        'SELECT completed_stages_json FROM project_task_active_stage_traces WHERE task_id = ?',
      ).get(IDS[1]).completed_stages_json,
      '[]',
    );

    check.close();

    assert.equal(
      store.readTaskDispatch(dispatch.dispatchId).consumedAt,
      undefined,
    );
  });
});

test('injected update failure rolls back the entire BEGIN IMMEDIATE recovery transaction', async () => {
  await withDatabase(({ store, databasePath }) => {
    create(store, IDS[0], 'first');
    create(store, IDS[1], 'second');
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TRIGGER recovery_fault BEFORE UPDATE ON project_tasks WHEN OLD.task_id = '${IDS[1]}' BEGIN SELECT RAISE(ABORT, 'recovery_fault'); END`);
    db.close();
    assert.throws(() => store.reconcileRestartSafeTasks(), /recovery_fault/);
    assert.equal(store.get(IDS[0]).status, 'accepted');
    assert.equal(store.get(IDS[1]).status, 'accepted');
  });
});

test('recovery calls no claim/consume API and exposes no authority or capability metadata', async () => {
  await withDatabase(({ store }) => {
    create(store, IDS[0]);
    store.enqueueTaskDispatch(IDS[0]);
    store.claimTaskDispatch = () => { throw new Error('claim_called'); };
    store.consumeTaskDispatch = () => { throw new Error('consume_called'); };
    const result = store.reconcileRestartSafeTasks();
    assert.deepEqual(Object.keys(result).sort(), ['failedInterrupted', 'preservedRecoverable', 'terminalUnchanged']);
    assert.equal(JSON.stringify(result).match(/capabilit|authorit|lease|dispatch|session|secret|command/i), null);
  });
});

test('Recovery V1 remains conservative under schema V11 without execution or authority side channels', async () => {
  assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 11);
  const source = await readFile(new URL('../src/services/projectTaskSqliteStore.ts', import.meta.url), 'utf8');
  const start = source.indexOf('reconcileRestartSafeTasks()');
  const end = source.indexOf('\n  enqueueTaskDispatch(', start);
  const recovery = source.slice(start, end);
  for (const forbidden of ['claimTaskDispatch(', 'consumeTaskDispatch(', 'acquireTaskLease(', 'renewTaskLease(', 'releaseTaskLease(', 'executeProjectTaskWorkflow', 'hermesExecutor', 'projectCodexExecutor', 'setImmediate', 'randomUUID']) {
    assert.equal(recovery.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(recovery, /\b(push|merge|deploy|production_write|database_write|secret_access)\b/);
});
