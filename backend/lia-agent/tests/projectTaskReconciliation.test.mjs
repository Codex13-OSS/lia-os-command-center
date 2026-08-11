import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../dist/config.js';
import { InMemoryProjectTaskStore } from '../dist/services/inMemoryProjectTaskStore.js';
import {
  hasReconcileInterruptedTasks,
  hasReconcileRestartSafeTasks,
  reconcileProjectTasksAtStartup,
  reconcileInterruptedTasksIfSupported,
} from '../dist/services/projectTaskReconciliation.js';
import { createProjectTaskStore } from '../dist/services/projectTaskStoreFactory.js';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const ID2 = '550e8400-e29b-41d4-a716-446655440001';

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Implement safely.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'],
  ...overrides,
});

function fakeStore(overrides = {}) {
  return {
    createOrGet() {
      return { kind: 'created' };
    },
    get() {
      return undefined;
    },
    transition() {},
    complete() {},
    fail() {},
    ...overrides,
  };
}

test('capability guard detects the typed reconciliation contract without instanceof', () => {
  assert.equal(hasReconcileInterruptedTasks(fakeStore({ reconcileInterruptedTasks() { return 0; } })), true);
  assert.equal(hasReconcileInterruptedTasks(fakeStore()), false);
  assert.equal(hasReconcileInterruptedTasks(new InMemoryProjectTaskStore()), false);
});

test('reconcileInterruptedTasksIfSupported calls through and returns the count for capable stores', () => {
  const calls = [];
  const store = fakeStore({
    reconcileInterruptedTasks() {
      calls.push('reconcile');
      return 3;
    },
  });
  assert.equal(reconcileInterruptedTasksIfSupported(store), 3);
  assert.deepEqual(calls, ['reconcile']);
});

test('reconcileInterruptedTasksIfSupported returns 0 and never calls unsupported stores', () => {
  assert.equal(reconcileInterruptedTasksIfSupported(fakeStore()), 0);
  assert.equal(reconcileInterruptedTasksIfSupported(new InMemoryProjectTaskStore()), 0);
});

test('reconcile failure propagates: no silent fallback to memory', () => {
  const store = fakeStore({
    reconcileInterruptedTasks() {
      throw new Error('reconcile exploded');
    },
  });
  assert.throws(
    () => reconcileInterruptedTasksIfSupported(store),
    (error) => error instanceof Error && error.message === 'reconcile exploded',
  );
});

test('startup wrapper prefers restart-safe recovery, retains legacy fallback, and ignores memory', () => {
  const calls = [];
  const restartSafe = fakeStore({
    reconcileRestartSafeTasks() {
      calls.push('restart-safe');
      return { preservedRecoverable: 2, failedInterrupted: 1, terminalUnchanged: 3 };
    },
    reconcileInterruptedTasks() {
      calls.push('legacy');
      return 99;
    },
  });
  assert.equal(hasReconcileRestartSafeTasks(restartSafe), true);
  assert.deepEqual(reconcileProjectTasksAtStartup(restartSafe), {
    preservedRecoverable: 2, failedInterrupted: 1, terminalUnchanged: 3,
  });
  assert.deepEqual(calls, ['restart-safe']);
  assert.deepEqual(reconcileProjectTasksAtStartup(fakeStore({ reconcileInterruptedTasks: () => 4 })), {
    preservedRecoverable: 0, failedInterrupted: 4, terminalUnchanged: 0,
  });
  assert.deepEqual(reconcileProjectTasksAtStartup(new InMemoryProjectTaskStore()), {
    preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 0,
  });
});

test('bootstrap wiring reconciles before the server starts listening', async () => {
  const serverSource = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const reconcileIndex = serverSource.indexOf('reconcileProjectTasksAtStartup(projectTaskStore)');
  const listenIndex = serverSource.indexOf('const server = app.listen(');
  assert.ok(reconcileIndex !== -1, 'server.ts must call reconcileProjectTasksAtStartup');
  assert.ok(listenIndex !== -1, 'server.ts must call app.listen');
  assert.ok(reconcileIndex < listenIndex, 'reconciliation must run before app.listen');
  assert.match(serverSource, /from '\.\/services\/projectTaskReconciliation\.js'/);
});

test('bootstrap sequence reconciles a real SQLite store before serving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-task-reconcile-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const seed = createProjectTaskStore(loadConfig({ LIA_PROJECT_TASK_SQLITE_PATH: databasePath }));
    seed.createOrGet(ID, 'fp-a', intent());
    seed.transition(ID, 'codex');
    seed.createOrGet(ID2, 'fp-b', intent({ instruction: 'Second task.' }));
    seed.close();

    // This is exactly the sequence server.ts performs during bootstrap.
    const store = createProjectTaskStore(loadConfig({ LIA_PROJECT_TASK_SQLITE_PATH: databasePath }));
    try {
      assert.deepEqual(reconcileProjectTasksAtStartup(store), {
        preservedRecoverable: 0, failedInterrupted: 2, terminalUnchanged: 0,
      });
      const first = store.get(ID);
      assert.equal(first.status, 'failed');
      assert.deepEqual(first.error, {
        code: 'workflow_interrupted',
        message: 'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.',
      });
      assert.equal(store.get(ID2).status, 'failed');
      assert.deepEqual(reconcileProjectTasksAtStartup(store), {
        preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 2,
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconciliation wiring contains no execution side channels', async () => {
  const serverSource = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const reconciliationSource = await readFile(
    new URL('../src/services/projectTaskReconciliation.ts', import.meta.url),
    'utf8',
  );
  const storeSource = await readFile(new URL('../src/services/projectTaskSqliteStore.ts', import.meta.url), 'utf8');

  for (const source of [reconciliationSource, storeSource]) {
    assert.equal(source.includes('child_process'), false);
    assert.equal(source.includes('execSync'), false);
    assert.equal(source.includes('spawn'), false);
    assert.equal(source.includes('hermesExecutor'), false);
    assert.equal(source.includes('projectCodexExecutor'), false);
    assert.equal(source.includes('projectCodexWorkspace'), false);
    assert.equal(source.includes('projectCodexCommit'), false);
    assert.doesNotMatch(source, /\b(push|merge|deploy|worktree)\b/i);
  }

  for (const term of ['child_process', 'execSync', 'spawn', 'hermesExecutor', 'projectCodexExecutor', 'projectCodexWorkspace', 'projectCodexCommit', 'executeProjectTaskWorkflow', 'writeFile']) {
    assert.equal(serverSource.includes(term), false);
  }
  assert.doesNotMatch(serverSource, /\b(push|merge|deploy)\b/i);
});
