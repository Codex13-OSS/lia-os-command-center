import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { InMemoryProjectTaskStore } from '../dist/services/inMemoryProjectTaskStore.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { hasReconcileInterruptedTasks, reconcileInterruptedTasksIfSupported } from '../dist/services/projectTaskReconciliation.js';
import { createProjectTaskStore } from '../dist/services/projectTaskStoreFactory.js';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const request = (overrides = {}) => ({
  taskId: ID,
  projectId: 'safe',
  instruction: 'Implement safely.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'],
  ...overrides,
});
const registry = {
  read: async () => [{ projectId: 'safe', displayName: 'Safe', repositoryRoot: '/safe/repo', enabled: true }],
};

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-factory-'));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function handleRequest(app, method, url, body) {
  const req = { method, url, originalUrl: url, headers: {}, body };
  const res = {
    statusCode: 200,
    headersSent: false,
    payload: undefined,
    json(payload) {
      this.payload = payload;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
    },
  };
  app.handle(req, res, () => {});
  for (let tick = 0; tick < 10 && res.payload === undefined; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return res;
}

test('missing projectTaskSqlitePath configuration resolves to empty string', () => {
  assert.equal(loadConfig({}).projectTaskSqlitePath, '');
});

test('blank projectTaskSqlitePath configuration resolves to empty string', () => {
  assert.equal(loadConfig({ LIA_PROJECT_TASK_SQLITE_PATH: '   ' }).projectTaskSqlitePath, '');
});

test('absolute projectTaskSqlitePath configuration is accepted after trimming', () => {
  assert.equal(
    loadConfig({ LIA_PROJECT_TASK_SQLITE_PATH: '  /tmp/lia-project-tasks.sqlite  ' })
      .projectTaskSqlitePath,
    '/tmp/lia-project-tasks.sqlite',
  );
});

test('relative projectTaskSqlitePath configuration is rejected', () => {
  assert.throws(
    () => loadConfig({ LIA_PROJECT_TASK_SQLITE_PATH: './tasks.sqlite' }),
    (error) => error instanceof Error && error.message === 'invalid_lia_project_task_sqlite_path',
  );
});

test('NUL-containing projectTaskSqlitePath configuration is rejected', () => {
  assert.throws(
    () => loadConfig({ LIA_PROJECT_TASK_SQLITE_PATH: '/tmp/lia\0tasks.sqlite' }),
    (error) => error instanceof Error && error.message === 'invalid_lia_project_task_sqlite_path',
  );
});

test('createApp preserves an injected projectTaskStore', async () => {
  const calls = [];
  const record = {
    taskId: ID,
    fingerprint: 'fp-injected',
    intent: request(),
    status: 'planning',
    createdAt: 1,
    updatedAt: 1,
  };
  const injected = {
    createOrGet(taskId, fingerprint, intent) {
      calls.push(['createOrGet', taskId]);
      return { kind: 'known', record: { ...record, fingerprint, intent } };
    },
    get(taskId) {
      calls.push(['get', taskId]);
      return record;
    },
    transition() {},
    complete() {},
    fail() {},
  };
  const app = createApp(loadConfig({}), {
    projectRegistrySource: registry,
    projectTaskStore: injected,
  });

  const postResponse = await handleRequest(app, 'POST', '/api/projects/tasks', request());
  assert.equal(postResponse.statusCode, 200);
  assert.equal(postResponse.payload.alreadyKnown, true);
  assert.equal(postResponse.payload.status, 'planning');

  const getResponse = await handleRequest(app, 'GET', `/api/projects/tasks/${ID}`);
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.payload.status, 'planning');
  assert.equal(getResponse.payload.terminal, false);

  assert.deepEqual(calls, [['createOrGet', ID], ['get', ID]]);
});

test('createProjectTaskStore selects in-memory when the configured path is empty', () => {
  const store = createProjectTaskStore(loadConfig({}));
  assert.equal(store instanceof InMemoryProjectTaskStore, true);
});

test('createProjectTaskStore selects SQLite when a path is configured', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'tasks.sqlite');
    const store = createProjectTaskStore(loadConfig({ LIA_PROJECT_TASK_SQLITE_PATH: databasePath }));
    try {
      assert.equal(store instanceof ProjectTaskSqliteStore, true);
      assert.equal(store instanceof InMemoryProjectTaskStore, false);
      assert.equal(hasReconcileInterruptedTasks(store), true);
      assert.equal(typeof store.reconcileInterruptedTasks, 'function');
    } finally {
      store.close();
    }

    const memory = createProjectTaskStore(loadConfig({}));
    assert.equal(hasReconcileInterruptedTasks(memory), false);
    assert.equal(reconcileInterruptedTasksIfSupported(memory), 0);
  });
});

test('SQLite bootstrap failure fails closed and never falls back to memory', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'corrupt.sqlite');
    await writeFile(databasePath, Buffer.from('this is not a sqlite database'.repeat(128)));

    let store;
    assert.throws(
      () => {
        store = createProjectTaskStore(loadConfig({ LIA_PROJECT_TASK_SQLITE_PATH: databasePath }));
      },
      (error) => error instanceof Error && error.message === 'invalid_project_task_sqlite_schema',
    );
    assert.equal(store, undefined);

    // The incompatible file must not be deleted or recreated by the failed bootstrap.
    const remaining = await readFile(databasePath, 'utf8');
    const remainingStat = await stat(databasePath);
    assert.equal(remaining.includes('this is not a sqlite database'), true);
    assert.equal(remainingStat.isFile(), true);
  });
});
