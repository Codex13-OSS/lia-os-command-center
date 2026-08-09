import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import {
  PROJECT_TASK_SQLITE_SCHEMA_VERSION,
  initializeProjectTaskSqliteDatabaseV1,
} from '../dist/services/projectTaskSqliteSchema.js';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const ID2 = '550e8400-e29b-41d4-a716-446655440001';
const ID3 = '550e8400-e29b-41d4-a716-446655440002';
const ID4 = '550e8400-e29b-41d4-a716-446655440003';
const ID5 = '550e8400-e29b-41d4-a716-446655440004';
const ID6 = '550e8400-e29b-41d4-a716-446655440005';

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Implement safely.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'],
  ...overrides,
});

const receipt = {
  executionId: 'exec-1',
  status: 'committed',
  resultText: 'Cambio completado.',
  verification: { status: 'verified', checksPassed: 2, totalChecks: 3 },
  commit: 'a'.repeat(40),
};

const failure = {
  stage: 'codex',
  code: 'codex_execution_failed',
  message: 'Codex no pudo completar la ejecución.',
};

const interruptedError = {
  code: 'workflow_interrupted',
  message: SAFE_TASK_ERROR_MESSAGES.workflow_interrupted,
};

async function withTempStore(options, fn) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  const store = new ProjectTaskSqliteStore({ databasePath, ...options });
  try {
    await fn(store, databasePath);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('creates a task and reads back every persisted field', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    const result = store.createOrGet(ID, 'fp-1', intent());
    assert.equal(result.kind, 'created');
    const record = store.get(ID);
    assert.equal(record.taskId, ID);
    assert.equal(record.fingerprint, 'fp-1');
    assert.deepEqual(record.intent, intent());
    assert.equal(record.status, 'accepted');
    assert.equal(record.createdAt, 1000);
    assert.equal(record.updatedAt, 1000);
    assert.equal(record.terminalAt, undefined);
    assert.equal(record.receipt, undefined);
    assert.equal(record.error, undefined);
    assert.equal(store.get(ID3), undefined);
  });
});

test('createOrGet is idempotent for the same fingerprint and conflicts for a different one', async () => {
  await withTempStore({}, (store) => {
    assert.equal(store.createOrGet(ID, 'fp-1', intent()).kind, 'created');

    const known = store.createOrGet(ID, 'fp-1', intent({ instruction: 'Ignored on retry.' }));
    assert.equal(known.kind, 'known');
    assert.equal(known.record.fingerprint, 'fp-1');
    assert.deepEqual(known.record.intent, intent());
    assert.equal(known.record.status, 'accepted');

    const conflict = store.createOrGet(ID, 'fp-2', intent());
    assert.equal(conflict.kind, 'conflict');
  });
});

test('existing tasks bypass capacity checks', async () => {
  await withTempStore({ maxRecords: 1, maxActive: 1 }, (store) => {
    assert.equal(store.createOrGet(ID, 'fp-1', intent()).kind, 'created');
    assert.equal(store.createOrGet(ID2, 'fp-2', intent()).kind, 'capacity');
    assert.equal(store.createOrGet(ID, 'fp-1', intent()).kind, 'known');
    assert.equal(store.createOrGet(ID, 'fp-different', intent()).kind, 'conflict');
  });
});

test('transition updates status and timestamps while preserving intent and fingerprint', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    store.createOrGet(ID, 'fp-1', intent());
    now = 2000;
    store.transition(ID, 'planning');
    now = 3000;
    store.transition(ID, 'codex');

    const record = store.get(ID);
    assert.equal(record.status, 'codex');
    assert.equal(record.fingerprint, 'fp-1');
    assert.deepEqual(record.intent, intent());
    assert.equal(record.createdAt, 1000);
    assert.equal(record.updatedAt, 3000);
    assert.equal(record.terminalAt, undefined);
  });
});


test('transition records only actually superseded observed stages and never invents canonical gaps', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    store.createOrGet(ID, 'fp-trace', intent());

    now = 2000;
    store.transition(ID, 'planning');
    assert.equal(store.get(ID).completedStages, undefined);

    now = 3000;
    store.transition(ID, 'codex');
    assert.deepEqual(store.get(ID).completedStages, ['planning']);

    now = 4000;
    store.transition(ID, 'verification');
    assert.deepEqual(store.get(ID).completedStages, ['planning', 'codex']);

    now = 5000;
    store.transition(ID, 'verification');
    assert.deepEqual(store.get(ID).completedStages, ['planning', 'codex']);
  });
});


test('backward transitions are ignored and preserve the latest durable active boundary', async () => {
  let now = 1000;

  await withTempStore({ now: () => now }, (store) => {
    store.createOrGet(ID, 'fp-backward', intent());

    now = 2000;
    store.transition(ID, 'planning');

    now = 3000;
    store.transition(ID, 'hermes');

    const before = store.get(ID);
    assert.equal(before.status, 'hermes');
    assert.deepEqual(before.completedStages, ['planning']);
    assert.equal(before.updatedAt, 3000);

    now = 4000;
    store.transition(ID, 'planning');

    const after = store.get(ID);
    assert.equal(after.status, 'hermes');
    assert.deepEqual(after.completedStages, ['planning']);
    assert.equal(after.updatedAt, 3000);
  });
});

test('opens a legacy V1 database and transactionally migrates it to the current active-trace schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-v1-migration-'));
  const databasePath = join(directory, 'tasks.sqlite');

  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);

    const legacy = new DatabaseSync(databasePath);
    const legacyMeta = legacy.prepare(
      'SELECT schema_version FROM project_task_meta WHERE singleton = 1',
    ).get();
    assert.equal(legacyMeta.schema_version, 1);

    legacy.prepare(`
      INSERT INTO project_tasks
        (task_id, fingerprint, intent_json, status, created_at, updated_at)
      VALUES (?, ?, ?, 'accepted', ?, ?)
    `).run(ID, 'fp-v1', JSON.stringify(intent()), 1000, 1000);
    legacy.close();

    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 2000 });
    assert.equal(store.get(ID).status, 'accepted');
    assert.equal(store.get(ID).completedStages, undefined);

    store.transition(ID, 'planning');
    store.transition(ID, 'codex');

    const migratedRecord = store.get(ID);
    assert.equal(migratedRecord.status, 'codex');
    assert.deepEqual(migratedRecord.completedStages, ['planning']);
    store.close();

    const migrated = new DatabaseSync(databasePath);
    const meta = migrated.prepare(
      'SELECT schema_version FROM project_task_meta WHERE singleton = 1',
    ).get();
    assert.equal(meta.schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);

    const mainColumns = migrated
      .prepare('PRAGMA table_info(project_tasks)')
      .all()
      .map((column) => column.name);
    assert.equal(mainColumns.includes('active_completed_stages_json'), false);

    const sidecar = migrated.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'project_task_active_stage_traces'
    `).get();
    assert.equal(sidecar.name, 'project_task_active_stage_traces');

    const row = migrated.prepare(`
      SELECT completed_stages_json
      FROM project_task_active_stage_traces
      WHERE task_id = ?
    `).get(ID);
    assert.equal(row.completed_stages_json, '["planning"]');
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('fails closed when a V2 sidecar trace contains non-public stage data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-sidecar-corrupt-'));
  const databasePath = join(directory, 'tasks.sqlite');

  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    store.createOrGet(ID, 'fp-sidecar-corrupt', intent());
    store.close();

    const database = new DatabaseSync(databasePath);
    database.prepare(`
      INSERT INTO project_task_active_stage_traces (task_id, completed_stages_json)
      VALUES (?, ?)
    `).run(ID, JSON.stringify(['planning', 'PRIVATE']));
    database.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath });
    try {
      assert.throws(
        () => reopened.get(ID),
        /corrupt_project_task_record/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('fails closed when a V2 sidecar trace contradicts the current active status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-sidecar-status-'));
  const databasePath = join(directory, 'tasks.sqlite');

  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    store.createOrGet(ID, 'fp-sidecar-status', intent());
    store.transition(ID, 'planning');
    store.close();

    const database = new DatabaseSync(databasePath);
    database.prepare(`
      INSERT INTO project_task_active_stage_traces (task_id, completed_stages_json)
      VALUES (?, ?)
    `).run(ID, JSON.stringify(['planning']));
    database.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath });
    try {
      assert.throws(
        () => reopened.get(ID),
        /corrupt_project_task_record/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('transition is a no-op for unknown and already-terminal tasks', async () => {
  await withTempStore({}, (store) => {
    assert.doesNotThrow(() => store.transition(ID3, 'planning'));
    assert.equal(store.get(ID3), undefined);

    store.createOrGet(ID, 'fp-1', intent());
    store.complete(ID, receipt);
    store.transition(ID, 'planning');

    const record = store.get(ID);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.receipt, receipt);
  });
});

test('complete marks the task terminal with receipt and persisted timestamps', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    store.createOrGet(ID, 'fp-1', intent());
    now = 2000;
    store.complete(ID, receipt);

    const record = store.get(ID);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.receipt, receipt);
    assert.equal(record.terminalAt, 2000);
    assert.equal(record.updatedAt, 2000);

    store.fail(ID, failure);
    store.transition(ID, 'planning');
    const after = store.get(ID);
    assert.equal(after.status, 'completed');
    assert.deepEqual(after.receipt, receipt);
    assert.equal(after.error, undefined);
  });
});

test('fail marks the task terminal with error and persisted timestamps', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    assert.doesNotThrow(() => store.fail(ID3, failure));
    store.createOrGet(ID, 'fp-1', intent());
    now = 2000;
    store.fail(ID, failure);

    const record = store.get(ID);
    assert.equal(record.status, 'failed');
    assert.deepEqual(record.error, failure);
    assert.equal(record.terminalAt, 2000);
    assert.equal(record.updatedAt, 2000);

    store.complete(ID, receipt);
    const after = store.get(ID);
    assert.equal(after.status, 'failed');
    assert.deepEqual(after.error, failure);
    assert.equal(after.receipt, undefined);
  });
});

test('complete persists the safe durable stage trace and reads it back', async () => {
  await withTempStore({}, (store) => {
    store.createOrGet(ID, 'fp-1', intent());
    store.complete(ID, {
      ...receipt,
      stages: ['planning', 'hermes', 'codex', 'verification', 'visualQa', 'commit'],
    });
    assert.deepEqual(store.get(ID).receipt, {
      ...receipt,
      stages: ['planning', 'hermes', 'codex', 'verification', 'visualQa', 'commit'],
    });
  });
});

test('fail persists completedStages and reads them back', async () => {
  await withTempStore({}, (store) => {
    store.createOrGet(ID, 'fp-1', intent());
    store.fail(ID, {
      ...failure,
      completedStages: ['planning', 'hermes', 'codex', 'verification'],
    });
    assert.deepEqual(store.get(ID).error, {
      ...failure,
      completedStages: ['planning', 'hermes', 'codex', 'verification'],
    });
  });
});

test('legacy terminal rows without stage traces remain readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    const database = new DatabaseSync(databasePath);
    database.prepare(`
      INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at, terminal_at, receipt_json)
      VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)
    `).run(ID, 'fp-legacy', JSON.stringify(intent()), 1000, 1000, 1000, JSON.stringify(receipt));
    database.prepare(`
      INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at, terminal_at, error_json)
      VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)
    `).run(ID2, 'fp-legacy-2', JSON.stringify(intent()), 1000, 1000, 1000, JSON.stringify(failure));
    database.close();

    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 0 });
    try {
      assert.deepEqual(store.get(ID).receipt, receipt);
      assert.deepEqual(store.get(ID2).error, failure);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when a stored receipt carries an invalid stage trace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    const database = new DatabaseSync(databasePath);
    const invalidTraces = [
      ['planning', '/safe/repo'],
      ['planning', 'commit'],
      ['planning', 'hermes', 'codex', 'visualQa'],
      [],
      'planning',
    ];
    database.exec('PRAGMA ignore_check_constraints = ON');
    invalidTraces.forEach((trace, index) => {
      database.prepare(`
        INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at, terminal_at, receipt_json)
        VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)
      `).run(
        `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, '0')}`,
        `fp-${index}`,
        JSON.stringify(intent()),
        0,
        0,
        0,
        JSON.stringify({ ...receipt, stages: trace }),
      );
    });
    database.close();

    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 0 });
    try {
      for (let index = 0; index < invalidTraces.length; index += 1) {
        assert.throws(
          () => store.get(`550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, '0')}`),
          /corrupt_project_task_record/,
        );
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when a stored error carries invalid completedStages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA ignore_check_constraints = ON');
    const traces = [['planning', 'PRIVATE'], ['commit', 'planning'], []];
    const ids = [ID3, ID4, ID5];
    traces.forEach((trace, index) => {
      database.prepare(`
        INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at, terminal_at, error_json)
        VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)
      `).run(ids[index], `fp-err-${index}`, JSON.stringify(intent()), 0, 0, 0, JSON.stringify({ ...failure, completedStages: trace }));
    });
    database.close();

    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 0 });
    try {
      for (const id of ids) assert.throws(() => store.get(id), /corrupt_project_task_record/);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('maxActive rejects new tasks and never evicts active tasks', async () => {
  await withTempStore({ maxActive: 1, maxRecords: 10 }, (store) => {
    assert.equal(store.createOrGet(ID, 'fp-1', intent()).kind, 'created');
    assert.equal(store.createOrGet(ID2, 'fp-2', intent()).kind, 'capacity');
    assert.equal(store.createOrGet(ID3, 'fp-3', intent()).kind, 'capacity');
    assert.ok(store.get(ID));
  });
});

test('maxRecords and TTL evict only expired terminals deterministically, never active tasks', async () => {
  let now = 0;
  await withTempStore({ maxRecords: 1, maxActive: 1, terminalTtlMs: 10, now: () => now }, (store) => {
    assert.equal(store.createOrGet(ID, 'one', intent()).kind, 'created');
    assert.equal(store.createOrGet(ID2, 'two', intent()).kind, 'capacity');
    assert.ok(store.get(ID));

    store.complete(ID, receipt); // terminal at t=0
    now = 9;
    assert.ok(store.get(ID)); // not yet expired
    assert.equal(store.createOrGet(ID2, 'two', intent()).kind, 'capacity'); // terminal still occupies capacity

    now = 10;
    assert.equal(store.get(ID), undefined); // pruned deterministically at >= TTL
    assert.equal(store.createOrGet(ID2, 'two', intent()).kind, 'created');
  });
});

test('terminal TTL boundary keeps tasks alive until the threshold', async () => {
  let now = 0;
  await withTempStore({ terminalTtlMs: 100, now: () => now }, (store) => {
    store.createOrGet(ID, 'fp-1', intent());
    store.fail(ID, failure);
    assert.equal(store.get(ID).terminalAt, 0);
    now = 99;
    assert.ok(store.get(ID));
    now = 100;
    assert.equal(store.get(ID), undefined);
  });
});

test('fails closed when the schema version is incompatible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    const database = new DatabaseSync(databasePath);
    database.prepare('UPDATE project_task_meta SET schema_version = ?')
      .run(PROJECT_TASK_SQLITE_SCHEMA_VERSION + 1);
    database.close();

    assert.throws(
      () => new ProjectTaskSqliteStore({ databasePath }),
      /invalid_project_task_sqlite_schema/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when the schema is absent (empty file)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    await writeFile(databasePath, '');
    assert.throws(
      () => new ProjectTaskSqliteStore({ databasePath }),
      /invalid_project_task_sqlite_schema/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when the database file is corrupt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    await writeFile(databasePath, 'this is not a sqlite database file');
    assert.throws(
      () => new ProjectTaskSqliteStore({ databasePath }),
      /invalid_project_task_sqlite_schema/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when stored JSON is corrupt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA ignore_check_constraints = ON');
    database.prepare(`
      INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ID, 'fp-1', '{not-json', 'accepted', 0, 0);
    database.prepare(`
      INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at, terminal_at, receipt_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ID2, 'fp-2', JSON.stringify(intent()), 'completed', 0, 0, 0, 'not-json');
    database.close();

    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 0 });
    try {
      assert.throws(() => store.get(ID), /corrupt_project_task_record/);
      assert.throws(() => store.get(ID2), /corrupt_project_task_record/);
      assert.throws(() => store.createOrGet(ID, 'fp-1', intent()), /corrupt_project_task_record/);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects relative database paths', () => {
  assert.throws(
    () => new ProjectTaskSqliteStore({ databasePath: 'relative/tasks.sqlite' }),
    /invalid_project_task_sqlite_path/,
  );
});

test('rejects database paths containing NUL', () => {
  assert.throws(
    () => new ProjectTaskSqliteStore({ databasePath: '/tmp/tasks\0.sqlite' }),
    /invalid_project_task_sqlite_path/,
  );
});

test('initializes the database file privately with mode 0600', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    store.close();
    const mode = (await stat(databasePath)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('close() releases the connection and operations after close fail closed', async () => {
  await withTempStore({}, (store) => {
    store.createOrGet(ID, 'fp-1', intent());
    store.close();
    store.close(); // idempotent

    assert.throws(() => store.get(ID), /project_task_sqlite_closed/);
    assert.throws(() => store.createOrGet(ID2, 'fp-2', intent()), /project_task_sqlite_closed/);
    assert.throws(() => store.transition(ID, 'planning'), /project_task_sqlite_closed/);
    assert.throws(() => store.complete(ID, receipt), /project_task_sqlite_closed/);
    assert.throws(() => store.fail(ID, failure), /project_task_sqlite_closed/);
    assert.throws(() => store.reconcileInterruptedTasks(), /project_task_sqlite_closed/);
  });
});

test('survives restart: A creates and transitions, B sees an identical record, C sees terminal state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let now = 1000;
  try {
    const storeA = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    assert.equal(storeA.createOrGet(ID, 'fp-a', intent()).kind, 'created');
    assert.equal(storeA.createOrGet(ID2, 'fp-b', intent({ instruction: 'Second task.' })).kind, 'created');
    now = 2000;
    storeA.transition(ID, 'planning');
    storeA.transition(ID, 'codex');
    storeA.transition(ID2, 'hermes');
    const beforeClose = storeA.get(ID);
    storeA.close();

    const storeB = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    const recordB = storeB.get(ID);
    assert.deepEqual(recordB, beforeClose);
    assert.equal(recordB.status, 'codex');
    assert.equal(recordB.fingerprint, 'fp-a');
    assert.deepEqual(recordB.intent, intent());
    assert.equal(recordB.createdAt, 1000);
    assert.equal(recordB.updatedAt, 2000);
    assert.equal(recordB.terminalAt, undefined);
    assert.equal(storeB.createOrGet(ID, 'fp-a', intent()).kind, 'known'); // idempotent across restart
    now = 3000;
    storeB.complete(ID, receipt);
    storeB.fail(ID2, failure);
    storeB.close();

    const storeC = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    const completed = storeC.get(ID);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.terminalAt, 3000);
    assert.equal(completed.updatedAt, 3000);
    assert.deepEqual(completed.receipt, receipt);
    assert.equal(completed.error, undefined);

    const failed = storeC.get(ID2);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.terminalAt, 3000);
    assert.deepEqual(failed.error, failure);
    assert.equal(failed.receipt, undefined);
    storeC.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workflow_interrupted is a safe error with the exact required message', () => {
  assert.equal(
    SAFE_TASK_ERROR_MESSAGES.workflow_interrupted,
    'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.',
  );
});

test('reconcileInterruptedTasks converts every non-terminal stage to failed/workflow_interrupted', async () => {
  const ids = [ID, ID2, ID3, ID4, ID5, ID6];
  const stages = ['accepted', 'planning', 'hermes', 'codex', 'verification', 'commit'];
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    ids.forEach((id, index) => {
      store.createOrGet(id, `fp-${index}`, intent({ instruction: `Task ${index}.` }));
      if (stages[index] !== 'accepted') {
        store.transition(id, stages[index]);
      }
    });

    now = 2000;
    assert.equal(store.reconcileInterruptedTasks(), 6);

    for (const [index, id] of ids.entries()) {
      const record = store.get(id);
      assert.equal(record.status, 'failed');
      assert.deepEqual(record.error, interruptedError);
      assert.equal(record.taskId, id);
      assert.equal(record.fingerprint, `fp-${index}`);
      assert.deepEqual(record.intent, intent({ instruction: `Task ${index}.` }));
      assert.equal(record.createdAt, 1000);
      assert.equal(record.updatedAt, 2000);
      assert.equal(record.terminalAt, 2000);
      assert.equal(record.receipt, undefined);
    }
  });
});

test('reconcileInterruptedTasks leaves completed and failed tasks identical and is idempotent', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    store.createOrGet(ID, 'fp-completed', intent());
    store.createOrGet(ID2, 'fp-failed', intent());
    store.createOrGet(ID3, 'fp-interrupted', intent());

    now = 1500;
    store.complete(ID, receipt);
    store.fail(ID2, failure);

    now = 2000;
    store.transition(ID3, 'codex');

    now = 3000;
    assert.equal(store.reconcileInterruptedTasks(), 1);

    const completed = store.get(ID);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.receipt, receipt);
    assert.equal(completed.error, undefined);
    assert.equal(completed.createdAt, 1000);
    assert.equal(completed.updatedAt, 1500);
    assert.equal(completed.terminalAt, 1500);

    const failed = store.get(ID2);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.error, failure);
    assert.equal(failed.receipt, undefined);
    assert.equal(failed.createdAt, 1000);
    assert.equal(failed.updatedAt, 1500);
    assert.equal(failed.terminalAt, 1500);

    const interrupted = store.get(ID3);
    assert.equal(interrupted.status, 'failed');
    assert.deepEqual(interrupted.error, interruptedError);
    assert.equal(interrupted.createdAt, 1000);
    assert.equal(interrupted.updatedAt, 3000);
    assert.equal(interrupted.terminalAt, 3000);

    now = 4000;
    assert.equal(store.reconcileInterruptedTasks(), 0);
    assert.equal(store.get(ID).updatedAt, 1500);
    assert.equal(store.get(ID).terminalAt, 1500);
    assert.equal(store.get(ID2).updatedAt, 1500);
    assert.equal(store.get(ID2).terminalAt, 1500);
    assert.equal(store.get(ID3).updatedAt, 3000);
    assert.equal(store.get(ID3).terminalAt, 3000);
  });
});

test('reconcileInterruptedTasks clears an inconsistent receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA ignore_check_constraints = ON');
    database.prepare(`
      INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at, terminal_at, receipt_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ID, 'fp-1', JSON.stringify(intent()), 'codex', 1000, 1000, null, JSON.stringify(receipt));
    database.close();

    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 2000 });
    try {
      assert.equal(store.reconcileInterruptedTasks(), 1);
      const record = store.get(ID);
      assert.equal(record.status, 'failed');
      assert.deepEqual(record.error, interruptedError);
      assert.equal(record.receipt, undefined);
      assert.equal(record.createdAt, 1000);
      assert.equal(record.updatedAt, 2000);
      assert.equal(record.terminalAt, 2000);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconcileInterruptedTasks persists reconciled failures across close/reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let now = 1000;
  try {
    const storeA = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    storeA.createOrGet(ID, 'fp-a', intent());
    storeA.transition(ID, 'hermes');
    storeA.createOrGet(ID2, 'fp-b', intent({ instruction: 'Second task.' }));
    now = 2000;
    assert.equal(storeA.reconcileInterruptedTasks(), 2);
    storeA.close();

    const storeB = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    const first = storeB.get(ID);
    assert.equal(first.status, 'failed');
    assert.deepEqual(first.error, interruptedError);
    assert.equal(first.fingerprint, 'fp-a');
    assert.deepEqual(first.intent, intent());
    assert.equal(first.createdAt, 1000);
    assert.equal(first.updatedAt, 2000);
    assert.equal(first.terminalAt, 2000);
    assert.equal(first.receipt, undefined);

    const second = storeB.get(ID2);
    assert.equal(second.status, 'failed');
    assert.deepEqual(second.error, interruptedError);
    assert.equal(second.updatedAt, 2000);
    assert.equal(second.terminalAt, 2000);

    assert.equal(storeB.reconcileInterruptedTasks(), 0);
    storeB.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
