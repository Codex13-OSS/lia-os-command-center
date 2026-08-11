import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  PROJECT_TASK_LEASE_MAX_DURATION_MS,
  PROJECT_TASK_LEASE_MIN_DURATION_MS,
} from '../dist/contracts/projectTaskLease.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import {
  PROJECT_TASK_SQLITE_SCHEMA_VERSION,
} from '../dist/services/projectTaskSqliteSchema.js';

const TASK_A = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';
const WORKER = new URL('./fixtures/projectTaskLeaseWorker.mjs', import.meta.url);
const intent = {
  projectId: 'safe',
  instruction: 'Lease test task.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests'],
};
const receipt = { executionId: 'exec', status: 'verified', resultText: 'done' };

const authority = (lease) => ({
  taskId: lease.taskId,
  leaseOwner: lease.leaseOwner,
  leaseId: lease.leaseId,
  fencingToken: lease.fencingToken,
});

async function fixture(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-lease-'));
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

test('acquire starts at token 1; same-owner replay is idempotent and does not renew', async () => {
  await fixture(({ store, setNow }) => {
    const first = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 2_000 });
    assert.equal(first.fencingToken, 1);
    assert.equal(first.acquiredAt, 1_000);
    assert.equal(first.leaseExpiresAt, 3_000);
    setNow(1_500);
    const replay = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 5_000 });
    assert.deepEqual(replay, first);
    assert.deepEqual(store.readTaskLease(TASK_A), first);
    assert.deepEqual(store.assertCurrentTaskLease(authority(first)), first);
    assert.equal(store.validateTaskLease(authority(first)), true);
  });
});

test('competitor is blocked before expiry; expiry boundary permits takeover and fences old authority', async () => {
  await fixture(({ store, setNow }) => {
    const old = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 });
    setNow(1_999);
    assert.throws(
      () => store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-b', durationMs: 1_000 }),
      /project_task_lease_unavailable/,
    );
    setNow(2_000);
    assert.equal(store.validateTaskLease(authority(old)), false);
    assert.throws(() => store.assertCurrentTaskLease(authority(old)), /project_task_lease_expired/);
    const next = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-b', durationMs: 1_000 });
    assert.equal(next.fencingToken, old.fencingToken + 1);
    assert.notEqual(next.leaseId, old.leaseId);
    assert.equal(store.validateTaskLease(authority(old)), false);
    assert.equal(store.validateTaskLease({ ...authority(next), leaseId: old.leaseId }), false);
    assert.equal(store.validateTaskLease({ ...authority(next), leaseOwner: 'worker-a' }), false);
    assert.throws(() => store.releaseTaskLease(authority(old)), /project_task_lease_stale/);
    assert.deepEqual(store.readTaskLease(TASK_A), next);
  });
});

test('same owner after expiry receives a new leaseId and fencing generation', async () => {
  await fixture(({ store, setNow }) => {
    const old = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 });
    setNow(old.leaseExpiresAt);
    const next = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 });
    assert.equal(next.fencingToken, 2);
    assert.notEqual(next.leaseId, old.leaseId);
    assert.equal(store.validateTaskLease(authority(old)), false);
  });
});

test('renew requires exact current authority, extends only expiry, and cannot revive expiry', async () => {
  await fixture(({ store, setNow }) => {
    const lease = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 2_000 });
    setNow(2_000);
    const renewed = store.renewTaskLease({ ...authority(lease), durationMs: 2_000 });
    assert.equal(renewed.leaseExpiresAt, 4_000);
    assert.equal(renewed.leaseId, lease.leaseId);
    assert.equal(renewed.fencingToken, lease.fencingToken);
    assert.throws(
      () => store.renewTaskLease({ ...authority(lease), leaseOwner: 'worker-b', durationMs: 2_000 }),
      /project_task_lease_stale/,
    );
    assert.throws(
      () => store.renewTaskLease({ ...authority(lease), fencingToken: 2, durationMs: 2_000 }),
      /project_task_lease_stale/,
    );
    setNow(4_000);
    assert.throws(
      () => store.renewTaskLease({ ...authority(lease), durationMs: 2_000 }),
      /project_task_lease_expired/,
    );
  });
});

test('release is exact and replay-safe, preserves the counter, and is allowed after terminalization', async () => {
  await fixture(({ store, setNow }) => {
    const first = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 3_000 });
    assert.deepEqual(store.releaseTaskLease(authority(first)), first);
    assert.deepEqual(store.releaseTaskLease(authority(first)), first);
    assert.equal(store.readTaskLease(TASK_A), undefined);
    const second = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-b', durationMs: 3_000 });
    assert.equal(second.fencingToken, 2);
    store.complete(TASK_A, receipt);
    assert.equal(store.validateTaskLease(authority(second)), false);
    assert.throws(() => store.renewTaskLease({ ...authority(second), durationMs: 1_000 }), /project_task_lease_task_terminal/);
    assert.throws(() => store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-c', durationMs: 1_000 }), /project_task_lease_task_terminal/);
    setNow(10_000);
    assert.deepEqual(store.releaseTaskLease(authority(second)), second);
    assert.throws(() => store.releaseTaskLease(authority(first)), /project_task_lease_stale/);
  });
});

test('cross-task authority, malformed input, invalid durations, and nonexistent tasks fail closed', async () => {
  await fixture(({ store }) => {
    const lease = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 });
    assert.equal(store.validateTaskLease({ ...authority(lease), taskId: TASK_B }), false);
    assert.throws(
      () => store.acquireTaskLease({ taskId: TASK_B, leaseOwner: 'worker-b', durationMs: 1_000 }),
      /project_task_lease_task_not_found/,
    );
    for (const leaseOwner of ['', ' worker', 'worker space', 'x'.repeat(201)]) {
      assert.throws(
        () => store.acquireTaskLease({ taskId: TASK_A, leaseOwner, durationMs: 1_000 }),
        /invalid_project_task_lease_input/,
      );
    }
    for (const durationMs of [0, 999, 1.5, PROJECT_TASK_LEASE_MAX_DURATION_MS + 1]) {
      assert.throws(
        () => store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs }),
        /invalid_project_task_lease_input/,
      );
    }
    assert.equal(PROJECT_TASK_LEASE_MIN_DURATION_MS, 1_000);
    assert.equal(store.validateTaskLease({ ...authority(lease), extra: 'capability' }), false);
    assert.throws(
      () => store.acquireTaskLease({
        taskId: TASK_A,
        leaseOwner: 'worker-a',
        durationMs: 1_000,
        requestedCapabilities: ['production_write'],
      }),
      /invalid_project_task_lease_input/,
    );
  });
});

test('leases do not alter task intent/capabilities and do not start workflow', async () => {
  await fixture(({ store }) => {
    const before = store.get(TASK_A);
    store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 });
    const after = store.get(TASK_A);
    assert.deepEqual(after.intent, before.intent);
    assert.equal(after.status, 'accepted');
    assert.equal(after.updatedAt, before.updatedAt);
  });
});

test('reconciliation remains legacy-identical and invalidates lease authority without deleting generation', async () => {
  await fixture(({ store }) => {
    const lease = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 10_000 });
    assert.equal(store.reconcileInterruptedTasks(), 1);
    assert.equal(store.get(TASK_A).status, 'failed');
    assert.equal(store.get(TASK_A).error.code, 'workflow_interrupted');
    assert.equal(store.validateTaskLease(authority(lease)), false);
    assert.deepEqual(store.readTaskLease(TASK_A), lease);
    assert.deepEqual(store.releaseTaskLease(authority(lease)), lease);
  });
});

test('close/reopen preserves fencing history and old generations remain stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-lease-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const firstStore = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    firstStore.createOrGet(TASK_A, 'fp', intent);
    const first = firstStore.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 });
    firstStore.close();
    const secondStore = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    const second = secondStore.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-b', durationMs: 1_000 });
    assert.equal(second.fencingToken, 2);
    assert.equal(secondStore.validateTaskLease(authority(first)), false);
    secondStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('two real SQLite connections serialize concurrent first acquire', async () => {
  await fixture(async ({ store, databasePath }) => {
    store.close();
    const results = await Promise.all(['worker-a', 'worker-b'].map((leaseOwner) => runWorker({
      databasePath, taskId: TASK_A, leaseOwner, durationMs: 10_000, now: 1_000,
    })));
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].lease.fencingToken, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].error, 'project_task_lease_unavailable');
  });
});

test('two real SQLite connections serialize concurrent expired takeover to one next generation', async () => {
  await fixture(async ({ store, databasePath }) => {
    store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-old', durationMs: 1_000 });
    store.close();
    const results = await Promise.all(['worker-a', 'worker-b'].map((leaseOwner) => runWorker({
      databasePath, taskId: TASK_A, leaseOwner, durationMs: 10_000, now: 2_000,
    })));
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].lease.fencingToken, 2);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].error, 'project_task_lease_unavailable');
  });
});

test('concurrent competitor acquire and exact renew serialize without owner or generation ABA', async () => {
  await fixture(async ({ store, databasePath }) => {
    const lease = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-old', durationMs: 2_000 });
    store.close();
    const [acquireResult, renewResult] = await Promise.all([
      runWorker({
        databasePath, taskId: TASK_A, leaseOwner: 'worker-new', durationMs: 2_000, now: 2_000,
      }),
      runWorker({
        action: 'renew', databasePath, authority: authority(lease), durationMs: 2_000, now: 2_000,
      }),
    ]);
    assert.equal(acquireResult.ok, false);
    assert.equal(acquireResult.error, 'project_task_lease_unavailable');
    assert.equal(renewResult.ok, true);
    assert.equal(renewResult.lease.fencingToken, 1);
    assert.equal(renewResult.lease.leaseId, lease.leaseId);
    assert.equal(renewResult.lease.leaseExpiresAt, 4_000);
  });
});

test('concurrent expired takeover fences stale renew and old release cannot affect new lease', async () => {
  await fixture(async ({ store, databasePath }) => {
    const old = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-old', durationMs: 1_000 });
    store.close();
    const [takeover, renewal] = await Promise.all([
      runWorker({
        databasePath, taskId: TASK_A, leaseOwner: 'worker-new', durationMs: 10_000, now: 2_000,
      }),
      runWorker({
        action: 'renew', databasePath, authority: authority(old), durationMs: 2_000, now: 2_000,
      }),
    ]);
    assert.equal(takeover.ok, true);
    assert.equal(takeover.lease.fencingToken, 2);
    assert.equal(renewal.ok, false);
    assert.match(renewal.error, /project_task_lease_(expired|stale)/);

    const staleRelease = await runWorker({
      action: 'release', databasePath, authority: authority(old), now: 2_001,
    });
    assert.equal(staleRelease.ok, false);
    assert.equal(staleRelease.error, 'project_task_lease_stale');
    const check = new ProjectTaskSqliteStore({ databasePath, now: () => 2_001 });
    assert.deepEqual(check.readTaskLease(TASK_A), takeover.lease);
    check.close();
  });
});

test('fault during takeover rolls back both old release and new generation', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const old = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-old', durationMs: 1_000 });
    const injector = new DatabaseSync(databasePath);
    injector.exec(`
      CREATE TRIGGER lease_fault BEFORE INSERT ON project_task_lease_generations
      WHEN NEW.fencing_token = 2 BEGIN SELECT RAISE(ABORT, 'injected_fault'); END
    `);
    injector.close();
    setNow(2_000);
    assert.throws(
      () => store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-new', durationMs: 1_000 }),
      /injected_fault/,
    );
    assert.deepEqual(store.readTaskLease(TASK_A), old);
    const database = new DatabaseSync(databasePath);
    const rows = database.prepare('SELECT fencing_token, released_at FROM project_task_lease_generations').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fencing_token, 1);
    assert.equal(rows[0].released_at, null);
    database.close();
  });
});

test('SQL constraints/triggers reject generation mutation, reuse, deletion, and invalid fencing', async () => {
  await fixture(({ store, databasePath }) => {
    const lease = store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 });
    const database = new DatabaseSync(databasePath);
    assert.throws(() => database.prepare(
      'UPDATE project_task_lease_generations SET fencing_token = 9 WHERE task_id = ?',
    ).run(TASK_A), /project_task_lease_generation_immutable/);
    assert.throws(() => database.prepare(
      'DELETE FROM project_task_lease_generations WHERE task_id = ?',
    ).run(TASK_A), /project_task_lease_generation_immutable/);
    assert.throws(() => database.prepare(`
      INSERT INTO project_task_lease_generations
        (task_id, lease_id, lease_owner, fencing_token, acquired_at, lease_expires_at)
      VALUES (?, ?, 'attacker', 9, 1000, 2000)
    `).run(TASK_A, '550e8400-e29b-41d4-a716-446655440099'), /project_task_lease_invalid_fencing_token|UNIQUE constraint failed/);
    assert.throws(() => database.prepare(`
      INSERT INTO project_task_lease_generations
        (task_id, lease_id, lease_owner, fencing_token, acquired_at, lease_expires_at)
      VALUES (?, ?, 'attacker', 2, 1000, 2000)
    `).run(TASK_B, lease.leaseId), /project_task_lease_task_unavailable|UNIQUE constraint failed/);
    database.close();
  });
});

test('fencing counter fails closed at the JavaScript safe-integer ceiling', async () => {
  await fixture(({ store, databasePath }) => {
    const database = new DatabaseSync(databasePath);
    database.exec('DROP TRIGGER project_task_lease_validate_insert');
    database.prepare(`
      INSERT INTO project_task_lease_generations (
        task_id, lease_id, lease_owner, fencing_token, acquired_at, lease_expires_at, released_at
      ) VALUES (?, ?, 'historical-worker', ?, 1, 2, 2)
    `).run(TASK_A, '550e8400-e29b-41d4-a716-446655440099', Number.MAX_SAFE_INTEGER);
    database.close();
    assert.throws(
      () => store.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 }),
      /project_task_lease_fencing_exhausted/,
    );
    const check = new DatabaseSync(databasePath);
    assert.equal(check.prepare(
      'SELECT COUNT(*) AS total FROM project_task_lease_generations WHERE task_id = ?',
    ).get(TASK_A).total, 1);
    check.close();
  });
});

test('an authentic V6-shaped database migrates additively to V8 and keeps legacy task data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-task-lease-v6-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createOrGet(TASK_A, 'legacy-fp', intent);
    initial.close();
    const v6 = new DatabaseSync(databasePath);
    v6.exec(`
      DROP TRIGGER project_task_execution_invocations_preserve_on_lease_release;
      DROP TABLE project_task_execution_invocations;
      DROP TABLE project_task_execution_runs;
      DROP TABLE project_task_dispatch_outbox;
      DROP TRIGGER project_task_lease_validate_insert;
      DROP TRIGGER project_task_lease_identity_immutable;
      DROP TRIGGER project_task_lease_expiry_monotonic;
      DROP TRIGGER project_task_lease_release_once;
      DROP TRIGGER project_task_lease_generation_immutable_delete;
      DROP TABLE project_task_lease_generations;
      UPDATE project_task_meta SET schema_version = 6 WHERE singleton = 1;
    `);
    v6.close();
    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.equal(migrated.get(TASK_A).fingerprint, 'legacy-fp');
    assert.equal(migrated.acquireTaskLease({ taskId: TASK_A, leaseOwner: 'worker-a', durationMs: 1_000 }).fencingToken, 1);
    migrated.close();
    const check = new DatabaseSync(databasePath);
    assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    check.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
