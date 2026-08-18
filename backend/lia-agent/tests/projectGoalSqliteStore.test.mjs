import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT,
  PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS,
} from '../dist/contracts/projectGoal.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import {
  PROJECT_TASK_SQLITE_SCHEMA_VERSION,
  initializeProjectTaskSqliteDatabaseV1,
} from '../dist/services/projectTaskSqliteSchema.js';

const GOAL = '650e8400-e29b-41d4-a716-446655440000';
const GOAL2 = '650e8400-e29b-41d4-a716-446655440001';
const ROOT = '750e8400-e29b-41d4-a716-446655440000';
const CHILD = '750e8400-e29b-41d4-a716-446655440001';
const CHILD2 = '750e8400-e29b-41d4-a716-446655440002';
const CHILD3 = '750e8400-e29b-41d4-a716-446655440003';
const OTHER = '750e8400-e29b-41d4-a716-446655440004';

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Implement only the next bounded step.',
  priority: 'normal',
  requestedCapabilities: ['repository_read'],
  ...overrides,
});

async function withTempStore(options, fn) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-goal-sqlite-'));
  const databasePath = join(directory, 'tasks.sqlite');
  const store = new ProjectTaskSqliteStore({ databasePath, ...options });
  try {
    await fn(store, databasePath);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function createGoal(store, overrides = {}) {
  return store.createGoal({
    goalId: GOAL,
    projectId: 'safe',
    objective: 'Complete the durable mission safely.',
    ...overrides,
  });
}

function createRoot(store, overrides = {}) {
  return store.createRootAttempt({
    taskId: ROOT,
    fingerprint: 'root-fp',
    intent: intent(),
    goalId: GOAL,
    continuationDepth: 0,
    attemptNumber: 0,
    ...overrides,
  });
}

function createChild(store, overrides = {}) {
  return store.createContinuationAttempt({
    taskId: CHILD,
    fingerprint: 'child-fp',
    intent: intent(),
    goalId: GOAL,
    parentTaskId: ROOT,
    continuationDepth: 1,
    attemptNumber: 1,
    ...overrides,
  });
}

test('creates and reads a durable Goal with small explicit V1 defaults', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    const created = createGoal(store);
    assert.deepEqual(created, {
      goalId: GOAL,
      projectId: 'safe',
      objective: 'Complete the durable mission safely.',
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000,
      currentAttempt: null,
      maxAttempts: PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS,
      continuationDepthLimit: PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT,
    });
    assert.deepEqual(store.readGoal(GOAL), created);
    assert.equal(store.readGoal(GOAL2), undefined);
    assert.throws(() => createGoal(store), /project_goal_already_exists/);
    assert.throws(
      () => createGoal(store, { goalId: GOAL2, maxAttempts: 6 }),
      /invalid_project_goal/,
    );
  });
});

test('Goal and ordered root/continuation lineage survive close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-goal-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    createGoal(first);
    assert.equal(createRoot(first).kind, 'created');
    assert.equal(createChild(first).kind, 'created');
    assert.deepEqual(first.get(ROOT).lineage, {
      goalId: GOAL,
      continuationDepth: 0,
      attemptNumber: 0,
    });
    assert.deepEqual(first.get(CHILD).lineage, {
      goalId: GOAL,
      parentTaskId: ROOT,
      continuationDepth: 1,
      attemptNumber: 1,
    });
    assert.deepEqual(first.listGoalAttempts(GOAL).map((record) => record.taskId), [ROOT, CHILD]);
    assert.equal(first.readGoal(GOAL).currentAttempt, 1);
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 2000 });
    assert.equal(reopened.readGoal(GOAL).objective, 'Complete the durable mission safely.');
    assert.deepEqual(reopened.get(ROOT).lineage, {
      goalId: GOAL,
      continuationDepth: 0,
      attemptNumber: 0,
    });
    assert.deepEqual(reopened.get(CHILD).lineage, {
      goalId: GOAL,
      parentTaskId: ROOT,
      continuationDepth: 1,
      attemptNumber: 1,
    });
    assert.deepEqual(reopened.listGoalAttempts(GOAL).map((record) => record.taskId), [ROOT, CHILD]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects self-parent, missing parent, depth/attempt skips and retroactive lineage changes', async () => {
  await withTempStore({}, (store) => {
    createGoal(store);
    createRoot(store);

    assert.throws(
      () => createChild(store, { taskId: ROOT }),
      /invalid_project_task_lineage/,
    );
    assert.throws(
      () => createChild(store, { parentTaskId: OTHER }),
      /project_task_parent_not_found/,
    );
    assert.throws(
      () => createChild(store, { continuationDepth: -1 }),
      /invalid_project_task_lineage/,
    );
    assert.throws(
      () => createChild(store, { attemptNumber: -1 }),
      /invalid_project_task_lineage/,
    );
    assert.throws(
      () => createChild(store, { continuationDepth: 2 }),
      /invalid_project_task_lineage/,
    );
    assert.throws(
      () => createChild(store, { attemptNumber: 2 }),
      /invalid_project_task_lineage/,
    );

    createChild(store);
    assert.throws(
      () => createChild(store, { continuationDepth: 2, attemptNumber: 2 }),
      /project_task_lineage_immutable/,
    );
    assert.deepEqual(store.get(CHILD).lineage, {
      goalId: GOAL,
      parentTaskId: ROOT,
      continuationDepth: 1,
      attemptNumber: 1,
    });
  });
});

test('rejects parents from another Goal and another project', async () => {
  await withTempStore({ maxActive: 10 }, (store) => {
    createGoal(store);
    createRoot(store);
    store.createGoal({ goalId: GOAL2, projectId: 'safe', objective: 'Other mission.' });
    store.createRootAttempt({
      taskId: OTHER,
      fingerprint: 'other-goal',
      intent: intent(),
      goalId: GOAL2,
      continuationDepth: 0,
      attemptNumber: 0,
    });
    assert.throws(
      () => createChild(store, { parentTaskId: OTHER }),
      /project_task_parent_goal_mismatch/,
    );

    const crossProjectTask = CHILD3;
    assert.equal(store.createOrGet(crossProjectTask, 'cross-project', intent({ projectId: 'other' })).kind, 'created');
    assert.throws(
      () => createChild(store, { parentTaskId: crossProjectTask }),
      /project_task_parent_project_mismatch/,
    );
    assert.throws(
      () => createChild(store, { intent: intent({ projectId: 'other' }) }),
      /project_task_parent_project_mismatch/,
    );
  });
});

test('enforces total-attempt and continuation-depth limits without scheduling anything', async () => {
  await withTempStore({ maxActive: 10 }, (store) => {
    createGoal(store, { maxAttempts: 2, continuationDepthLimit: 4 });
    createRoot(store);
    createChild(store);
    assert.throws(
      () => store.createContinuationAttempt({
        taskId: CHILD2,
        fingerprint: 'child-2',
        intent: intent(),
        goalId: GOAL,
        parentTaskId: CHILD,
        continuationDepth: 2,
        attemptNumber: 2,
      }),
      /project_goal_attempt_limit_reached/,
    );
    assert.equal(store.get(CHILD2), undefined);
  });

  await withTempStore({ maxActive: 10 }, (store) => {
    createGoal(store, { maxAttempts: 5, continuationDepthLimit: 1 });
    createRoot(store);
    createChild(store);
    assert.throws(
      () => store.createContinuationAttempt({
        taskId: CHILD2,
        fingerprint: 'child-2',
        intent: intent(),
        goalId: GOAL,
        parentTaskId: CHILD,
        continuationDepth: 2,
        attemptNumber: 2,
      }),
      /project_goal_continuation_depth_limit_reached/,
    );
  });
});

test('terminal Goals reject children and terminal states never revive', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    createGoal(store);
    createRoot(store);
    now = 2000;
    const terminal = store.terminalizeGoal(GOAL, 'completed');
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.terminalReason, 'objective_completed');
    assert.equal(terminal.terminalAt, 2000);
    assert.throws(() => createChild(store), /project_goal_terminal/);
    assert.equal(store.get(CHILD), undefined);
    assert.throws(
      () => store.transitionGoal(GOAL, 'failed'),
      /invalid_project_goal_transition/,
    );
    assert.equal(store.readGoal(GOAL).status, 'completed');
  });
});

test('continuations cannot expand requested capabilities and Goal metadata grants none', async () => {
  await withTempStore({}, (store) => {
    createGoal(store, { objective: 'deploy push secret_access database_write' });
    createRoot(store);
    assert.throws(
      () => createChild(store, {
        intent: intent({ requestedCapabilities: ['repository_read', 'isolated_worktree_write'] }),
      }),
      /project_task_continuation_capability_expansion/,
    );
    assert.deepEqual(store.get(ROOT).intent.requestedCapabilities, ['repository_read']);
    assert.deepEqual(store.readGoal(GOAL).objective, 'deploy push secret_access database_write');
    assert.equal(store.get(ROOT).intent.goalId, undefined);
    assert.equal(store.get(ROOT).intent.parentTaskId, undefined);
  });
});

test('lineage metadata is not part of workflow authority or the Codex handoff', async () => {
  const workflow = await readFile(new URL('../src/services/projectTaskWorkflowService.ts', import.meta.url), 'utf8');
  const handoff = await readFile(new URL('../src/contracts/projectCodexHandoff.ts', import.meta.url), 'utf8');
  const planner = await readFile(new URL('../src/services/projectExecutionPlanner.ts', import.meta.url), 'utf8');
  for (const source of [workflow, handoff, planner]) {
    assert.equal(source.includes('goalId'), false);
    assert.equal(source.includes('parentTaskId'), false);
    assert.equal(source.includes('continuationDepth'), false);
    assert.equal(source.includes('attemptNumber'), false);
  }
  assert.match(handoff, /effectiveCapabilities/);
  assert.match(planner, /approvedCapabilities/);
});

test('legacy task behavior and reconciliation semantics remain unchanged for Goal attempts', async () => {
  let now = 1000;
  await withTempStore({ now: () => now }, (store) => {
    assert.equal(store.createOrGet(OTHER, 'legacy', intent()).kind, 'created');
    assert.equal(store.get(OTHER).lineage, undefined);
    createGoal(store);
    createRoot(store);
    store.transition(OTHER, 'codex');
    store.transition(ROOT, 'codex');
    now = 2000;
    assert.equal(store.reconcileInterruptedTasks(), 2);
    assert.equal(store.get(OTHER).status, 'failed');
    assert.equal(store.get(OTHER).error.code, 'workflow_interrupted');
    assert.equal(store.get(OTHER).lineage, undefined);
    assert.equal(store.get(ROOT).status, 'failed');
    assert.equal(store.get(ROOT).error.code, 'workflow_interrupted');
    assert.deepEqual(store.get(ROOT).lineage, {
      goalId: GOAL,
      continuationDepth: 0,
      attemptNumber: 0,
    });
    assert.equal(store.readGoal(GOAL).status, 'active');
    assert.equal(store.readGoal(GOAL).currentAttempt, 0);
    assert.equal(store.listGoalAttempts(GOAL).length, 1);
  });
});

test('legacy V2 SQLite migrates additively, preserving project_tasks and adding useful indexes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-goal-v2-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE project_task_active_stage_traces (
        task_id TEXT PRIMARY KEY CHECK (task_id <> ''),
        completed_stages_json TEXT NOT NULL CHECK (
          json_valid(completed_stages_json) AND json_type(completed_stages_json, '$') IS 'array'
        )
      ) STRICT;
      UPDATE project_task_meta SET schema_version = 2 WHERE singleton = 1;
    `);
    legacy.prepare(`
      INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at)
      VALUES (?, ?, ?, 'accepted', 1, 1)
    `).run(OTHER, 'legacy-v2', JSON.stringify(intent()));
    legacy.close();

    const store = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(store.get(OTHER).fingerprint, 'legacy-v2');
    assert.equal(store.get(OTHER).lineage, undefined);
    createGoal(store);
    createRoot(store);
    store.close();

    const migrated = new DatabaseSync(databasePath);
    assert.equal(
      migrated.prepare('SELECT schema_version FROM project_task_meta WHERE singleton = 1').get().schema_version,
      PROJECT_TASK_SQLITE_SCHEMA_VERSION,
    );
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM project_tasks').get().count, 2);
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_goals'").get());
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_task_lineage'").get());
    const indexes = migrated.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name);
    assert.ok(indexes.includes('project_task_lineage_goal_id'));
    assert.ok(indexes.includes('project_task_lineage_parent_task_id'));
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite constraints make cycles and direct lineage mutation impossible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-goal-cycle-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    createGoal(store);
    createRoot(store);
    createChild(store);
    store.close();

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () => database.prepare('UPDATE project_task_lineage SET parent_task_id = ? WHERE task_id = ?').run(CHILD, ROOT),
      /project_task_lineage_immutable/,
    );
    assert.throws(
      () => database.prepare('UPDATE project_task_lineage SET goal_id = ? WHERE task_id = ?').run(GOAL2, CHILD),
      /project_task_lineage_immutable/,
    );
    assert.throws(
      () => database.prepare('DELETE FROM project_task_lineage WHERE task_id = ?').run(ROOT),
      /project_task_lineage_immutable/,
    );
    assert.throws(
      () => database.prepare('UPDATE project_tasks SET intent_json = ? WHERE task_id = ?')
        .run(JSON.stringify(intent({ projectId: 'escaped' })), ROOT),
      /project_task_lineage_immutable/,
    );
    database.prepare(`
      UPDATE project_goals
      SET status = 'completed', terminal_reason = 'objective_completed',
          terminal_at = created_at, updated_at = created_at
      WHERE goal_id = ?
    `).run(GOAL);
    assert.throws(
      () => database.prepare(`
        UPDATE project_goals
        SET status = 'active', terminal_reason = NULL, terminal_at = NULL
        WHERE goal_id = ?
      `).run(GOAL),
      /invalid_project_goal_transition/,
    );
    database.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath });
    assert.deepEqual(reopened.listGoalAttempts(GOAL).map((record) => record.taskId), [ROOT, CHILD]);
    assert.equal(reopened.readGoal(GOAL).status, 'completed');
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('listGoals enumerates active first, then terminal, deterministic within groups', async () => {
  let now = 1000;
  const directory = await mkdtemp(join(tmpdir(), 'lia-goal-list-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    const g = (n) => `650e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;
    // Terminal goal (created first), then active goals in a defined order.
    store.createGoal({ goalId: g(1), projectId: 'safe', objective: 'Terminal mission.' });
    store.transitionGoal(g(1), 'completed', 'objective_completed');
    now = 2000;
    store.createGoal({ goalId: g(3), projectId: 'safe', objective: 'Third active.' });
    now = 3000;
    store.createGoal({ goalId: g(2), projectId: 'other', objective: 'Second active.' });
    now = 4000;

    const all = store.listGoals();
    assert.deepEqual(all.map((record) => record.goalId), [g(3), g(2), g(1)], 'active first, created_at ASC, goal_id ASC; terminal last');
    assert.equal(all[0].status, 'active');
    assert.equal(all[1].status, 'active');
    assert.equal(all[2].status, 'completed');

    assert.deepEqual(
      store.listGoals({ includeTerminal: false }).map((record) => record.goalId),
      [g(3), g(2)],
      'includeTerminal=false hides terminal goals',
    );
    assert.deepEqual(
      store.listGoals({ projectId: 'other' }).map((record) => record.goalId),
      [g(2)],
      'project filter narrows to one project',
    );
    // Limit selects the NEWEST rows by updated_at DESC, then re-orders.
    assert.deepEqual(
      store.listGoals({ limit: 2 }).map((record) => record.goalId),
      [g(3), g(2)],
      'limit keeps the newest updated rows and still orders active-first',
    );
    assert.deepEqual(
      store.listGoals({ limit: 0 }).map((record) => record.goalId),
      [g(2)],
      'limit is clamped to [1, 100]',
    );
    assert.throws(
      () => store.listGoals({ projectId: '   ' }),
      /invalid_project_goal/,
      'malformed project filter fails closed',
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('createGoalWithRootAttempt is an atomic intake composition', async () => {
  let now = 1000;
  const directory = await mkdtemp(join(tmpdir(), 'lia-goal-intake-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    const goalId = GOAL;
    const taskId = ROOT;
    const result = store.createGoalWithRootAttempt({
      goal: { goalId, projectId: 'safe', objective: 'Atomic intake mission.' },
      rootAttempt: {
        taskId,
        fingerprint: 'intake-fp',
        intent: intent(),
        goalId,
        continuationDepth: 0,
        attemptNumber: 0,
      },
    });
    assert.equal(result.goal.status, 'active');
    assert.equal(result.task.kind, 'created');
    assert.equal(result.task.record.status, 'accepted');
    assert.equal(result.task.record.lineage.attemptNumber, 0);
    assert.equal(result.task.record.lineage.parentTaskId, undefined);
    assert.equal(store.readGoal(goalId).currentAttempt, 0);
    assert.equal(store.listGoalAttempts(goalId).length, 1);

    // Duplicate goalId -> deterministic conflict, no second row.
    assert.throws(
      () => store.createGoalWithRootAttempt({
        goal: { goalId, projectId: 'safe', objective: 'Duplicate.' },
        rootAttempt: {
          taskId: CHILD,
          fingerprint: 'intake-fp-2',
          intent: intent(),
          goalId,
          continuationDepth: 0,
          attemptNumber: 0,
        },
      }),
      /project_goal_already_exists/,
    );

    // Invalid lineage (capability outside the ceiling) rolls the whole
    // transaction back: no goal row is left behind.
    const badGoal = '650e8400-e29b-41d4-a716-4466554400ff';
    assert.throws(
      () => store.createGoalWithRootAttempt({
        goal: { goalId: badGoal, projectId: 'safe', objective: 'Bad intake.' },
        rootAttempt: {
          taskId: OTHER,
          fingerprint: 'intake-fp-3',
          intent: intent({ requestedCapabilities: ['push'] }),
          goalId: badGoal,
          continuationDepth: 0,
          attemptNumber: 0,
        },
      }),
      /invalid_project_task_lineage/,
    );
    assert.equal(store.readGoal(badGoal), undefined, 'failed intake leaves no goal row');
    assert.equal(store.get(OTHER), undefined, 'failed intake leaves no task row');

    // Capacity refuses partial creation: the goal row rolls back too.
    const fullStore = new ProjectTaskSqliteStore({
      databasePath: join(directory, 'full.sqlite'),
      maxRecords: 1,
      maxActive: 1,
      now: () => now,
    });
    fullStore.createOrGet(taskId, 'fp', intent());
    assert.throws(
      () => fullStore.createGoalWithRootAttempt({
        goal: { goalId: badGoal, projectId: 'safe', objective: 'Capacity intake.' },
        rootAttempt: {
          taskId: '750e8400-e29b-41d4-a716-4466554400fe',
          fingerprint: 'intake-fp-4',
          intent: intent(),
          goalId: badGoal,
          continuationDepth: 0,
          attemptNumber: 0,
        },
      }),
      /project_goal_capacity_reached/,
    );
    assert.equal(fullStore.readGoal(badGoal), undefined, 'capacity refuses a goal without its root attempt');
    fullStore.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
