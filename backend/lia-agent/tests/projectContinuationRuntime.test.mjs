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
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';

const GOAL = 'd50e8400-e29b-41d4-a716-446655440000';
const GOAL2 = 'd50e8400-e29b-41d4-a716-446655440001';
const ROOT = 'e50e8400-e29b-41d4-a716-446655440000';
const LEGACY = 'e50e8400-e29b-41d4-a716-446655440001';

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Complete the bounded durable objective.',
  priority: 'high',
  requestedCapabilities: ['repository_read', 'run_tests'],
  ...overrides,
});
const receipt = {
  executionId: 'runtime-test-execution',
  status: 'verified',
  resultText: 'Bounded partial result.',
  verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
};
const evidence = {
  goalSatisfaction: 'partial',
  blocking: 'none',
  failure: 'retryable',
};

async function tempDatabase(prefix = 'lia-continuation-runtime-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seedPlan(store, options = {}) {
  const {
    goalId = GOAL,
    taskId = ROOT,
    projectId = 'safe',
    maxAttempts = 3,
    continuationDepthLimit = 2,
  } = options;
  store.createGoal({
    goalId,
    projectId,
    objective: 'Deliver the remaining bounded surfaces and verify the result.',
    maxAttempts,
    continuationDepthLimit,
  });
  assert.equal(store.createRootAttempt({
    taskId,
    fingerprint: `${taskId}-fingerprint`,
    intent: intent({ projectId }),
    goalId,
    continuationDepth: 0,
    attemptNumber: 0,
  }).kind, 'created');
  store.complete(taskId, receipt);
  const evaluation = store.evaluateAndApplyGoalAttempt({
    goalId,
    taskId,
    attemptNumber: 0,
    evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
    evidence,
  }).evaluation;
  const plan = store.createContinuationPlan({
    goalId,
    sourceEvaluationId: evaluation.evaluationId,
    plannerVersion: CONTINUATION_PLANNER_VERSION,
    sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
  });
  return { evaluation, plan };
}

function inspect(databasePath) {
  const database = new DatabaseSync(databasePath);
  const result = {
    tasks: database.prepare('SELECT COUNT(*) AS count FROM project_tasks').get().count,
    lineage: database.prepare('SELECT COUNT(*) AS count FROM project_task_lineage').get().count,
    consumptions: database.prepare('SELECT COUNT(*) AS count FROM project_goal_continuation_consumptions').get().count,
    currentAttempt: database.prepare('SELECT current_attempt FROM project_goals WHERE goal_id = ?').get(GOAL).current_attempt,
  };
  database.close();
  return result;
}

async function corruptAfterPlan(databasePath, mutate) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = OFF');
  mutate(database);
  database.close();
}

test('materializes exactly one durable task with plan-derived identity, intent and lineage', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 200 });
    const { plan } = seedPlan(store);
    const result = store.materializeContinuation(plan.planId);
    assert.equal(result.planId, plan.planId);
    assert.equal(result.createdTaskId, result.task.taskId);
    assert.match(result.createdTaskId, /^[0-9a-f-]{36}$/);
    assert.equal(result.task.intent.projectId, 'safe');
    assert.equal(result.task.intent.instruction, plan.instruction);
    assert.equal(result.task.intent.priority, 'high');
    assert.deepEqual(result.task.intent.requestedCapabilities, ['repository_read', 'run_tests']);
    assert.deepEqual(result.task.lineage, {
      goalId: GOAL,
      parentTaskId: ROOT,
      continuationDepth: 1,
      attemptNumber: 1,
    });
    assert.equal(result.task.status, 'accepted');
    assert.equal(store.listGoalAttempts(GOAL).length, 2);
    assert.equal(store.readGoal(GOAL).currentAttempt, 1);
    const consumed = store.readContinuationPlan(plan.planId);
    assert.equal(consumed.status, 'consumed');
    assert.equal(consumed.createdTaskId, result.createdTaskId);
    assert.equal(consumed.consumedAt, 200);
    assert.equal('approvedCapabilities' in result.task.intent, false);
    assert.equal('effectiveCapabilities' in result.task.intent, false);
    store.close();

    assert.deepEqual(inspect(databasePath), {
      tasks: 2,
      lineage: 2,
      consumptions: 1,
      currentAttempt: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay, reopen and concurrent calls return one immutable createdTaskId', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const seedStore = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
    const { plan } = seedPlan(seedStore);
    const first = seedStore.materializeContinuation(plan.planId);
    assert.equal(seedStore.materializeContinuation(plan.planId).createdTaskId, first.createdTaskId);
    seedStore.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
    assert.equal(reopened.materializeContinuation(plan.planId).createdTaskId, first.createdTaskId);
    reopened.close();

    const moduleUrl = new URL('../dist/services/projectTaskSqliteStore.js', import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        try {
          const { ProjectTaskSqliteStore } = await import(workerData.moduleUrl);
          const store = new ProjectTaskSqliteStore({ databasePath: workerData.databasePath, maxActive: 10 });
          const result = store.materializeContinuation(workerData.planId);
          store.close();
          parentPort.postMessage({ ok: true, createdTaskId: result.createdTaskId });
        } catch (error) {
          parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    `;
    const run = () => new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { moduleUrl, databasePath, planId: plan.planId },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const calls = await Promise.all([run(), run()]);
    assert.deepEqual(calls, [
      { ok: true, createdTaskId: first.createdTaskId },
      { ok: true, createdTaskId: first.createdTaskId },
    ]);
    assert.deepEqual(inspect(databasePath), {
      tasks: 2,
      lineage: 2,
      consumptions: 1,
      currentAttempt: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('two genuinely concurrent first materializations serialize to one task', async () => {
  const { directory, databasePath } = await tempDatabase('lia-runtime-concurrent-first-');
  try {
    const seedStore = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
    const { plan } = seedPlan(seedStore);
    seedStore.close();
    const moduleUrl = new URL('../dist/services/projectTaskSqliteStore.js', import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        try {
          const { ProjectTaskSqliteStore } = await import(workerData.moduleUrl);
          const store = new ProjectTaskSqliteStore({ databasePath: workerData.databasePath, maxActive: 10 });
          const result = store.materializeContinuation(workerData.planId);
          store.close();
          parentPort.postMessage({ ok: true, id: result.createdTaskId });
        } catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
      })();
    `;
    const run = () => new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl, databasePath, planId: plan.planId } });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.ok, true, a.error);
    assert.equal(b.ok, true, b.error);
    assert.equal(a.id, b.id);
    assert.deepEqual(inspect(databasePath), { tasks: 2, lineage: 2, consumptions: 1, currentAttempt: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects missing, invalid, cancelled and terminal-Goal plans without writes', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    const { plan } = seedPlan(store);
    assert.throws(() => store.materializeContinuation('not-a-plan'), /invalid_project_continuation/);
    assert.throws(() => store.materializeContinuation('d50e8400-e29b-41d4-a716-446655440099'), /plan_not_found/);
    store.cancelContinuationPlan(plan.planId);
    assert.throws(() => store.materializeContinuation(plan.planId), /plan_not_usable/);
    assert.deepEqual(inspect(databasePath), { tasks: 1, lineage: 1, consumptions: 0, currentAttempt: 0 });
    store.close();

    const isolated = await tempDatabase('lia-runtime-terminal-');
    try {
      const terminal = new ProjectTaskSqliteStore({ databasePath: isolated.databasePath });
      const seeded = seedPlan(terminal);
      terminal.transitionGoal(GOAL, 'failed');
      assert.throws(() => terminal.materializeContinuation(seeded.plan.planId), /goal_terminal/);
      assert.deepEqual(inspect(isolated.databasePath), { tasks: 1, lineage: 1, consumptions: 0, currentAttempt: 0 });
      terminal.close();
    } finally {
      await rm(isolated.directory, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed for unapplied, non-retryable and conflicting source evaluations', async () => {
  const mutations = [
    ['unapplied', (db, evaluationId) => {
      db.exec('DROP TRIGGER project_goal_evaluations_applied_once');
      db.prepare('UPDATE project_goal_evaluations SET applied_at = NULL WHERE evaluation_id = ?').run(evaluationId);
    }, /evaluation_not_applied/],
    ['non-retryable', (db, evaluationId) => {
      db.exec('DROP TRIGGER project_goal_evaluations_decision_immutable');
      db.prepare("UPDATE project_goal_evaluations SET decision = 'failed', reason_code = 'execution_failed' WHERE evaluation_id = ?").run(evaluationId);
    }, /evaluation_not_retryable/],
    ['fingerprint-conflict', (db, evaluationId) => {
      db.exec('DROP TRIGGER project_goal_evaluations_decision_immutable');
      db.prepare('UPDATE project_goal_evaluations SET evidence_fingerprint = ? WHERE evaluation_id = ?').run('f'.repeat(64), evaluationId);
    }, /source_evaluation_conflict/],
    ['other-goal', (db, evaluationId) => {
      db.exec('DROP TRIGGER project_goal_evaluations_decision_immutable');
      db.prepare('UPDATE project_goal_evaluations SET goal_id = ? WHERE evaluation_id = ?').run(GOAL2, evaluationId);
    }, /source_evaluation_conflict/],
    ['other-project', (db) => {
      db.exec('DROP TRIGGER project_goal_evaluation_identity_immutable');
      db.prepare("UPDATE project_goals SET project_id = 'other' WHERE goal_id = ?").run(GOAL);
    }, /corrupt_project_task_record/],
  ];
  for (const [name, mutation, expected] of mutations) {
    const { directory, databasePath } = await tempDatabase(`lia-runtime-${name}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      const { evaluation, plan } = seedPlan(store);
      if (name === 'other-goal') store.createGoal({ goalId: GOAL2, projectId: 'other', objective: 'Other Goal.' });
      store.close();
      await corruptAfterPlan(databasePath, (db) => mutation(db, evaluation.evaluationId));
      const reopened = new ProjectTaskSqliteStore({ databasePath });
      assert.throws(() => reopened.materializeContinuation(plan.planId), expected);
      assert.equal(reopened.readContinuationPlan(plan.planId).status, 'planned');
      if (name !== 'other-project') assert.equal(reopened.listGoalAttempts(GOAL).length, 1);
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('rejects stale parent and adversarial post-plan attempt/depth exhaustion', async () => {
  const stale = await tempDatabase('lia-runtime-stale-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath: stale.databasePath, maxActive: 10 });
    const { plan } = seedPlan(store);
    store.createContinuationAttempt({
      taskId: 'e50e8400-e29b-41d4-a716-446655440099',
      fingerprint: 'competing-attempt',
      intent: intent(),
      goalId: GOAL,
      parentTaskId: ROOT,
      continuationDepth: 1,
      attemptNumber: 1,
    });
    assert.throws(() => store.materializeContinuation(plan.planId), /parent_stale/);
    assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
    assert.equal(store.listGoalAttempts(GOAL).length, 2);
    store.close();
  } finally {
    await rm(stale.directory, { recursive: true, force: true });
  }

  for (const [name, sql, expected] of [
    ['budget', 'UPDATE project_goals SET max_attempts = 1 WHERE goal_id = ?', /attempt_limit/],
    ['depth', 'UPDATE project_goals SET continuation_depth_limit = 0 WHERE goal_id = ?', /depth_limit/],
  ]) {
    const { directory, databasePath } = await tempDatabase(`lia-runtime-${name}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      const { plan } = seedPlan(store);
      store.close();
      await corruptAfterPlan(databasePath, (db) => {
        db.exec('DROP TRIGGER project_goal_evaluation_identity_immutable');
        db.prepare(sql).run(GOAL);
      });
      const reopened = new ProjectTaskSqliteStore({ databasePath });
      assert.throws(() => reopened.materializeContinuation(plan.planId), expected);
      assert.deepEqual(inspect(databasePath), { tasks: 1, lineage: 1, consumptions: 0, currentAttempt: 0 });
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('SQL makes createdTaskId and consumed state immutable and cannot create consumption without matching task', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    const { plan } = seedPlan(store);
    const result = store.materializeContinuation(plan.planId);
    store.close();
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () => database.prepare('UPDATE project_goal_continuation_consumptions SET created_task_id = ? WHERE plan_id = ?').run(ROOT, plan.planId),
      /consumption_immutable/,
    );
    assert.throws(
      () => database.prepare('DELETE FROM project_goal_continuation_consumptions WHERE plan_id = ?').run(plan.planId),
      /consumption_immutable/,
    );
    assert.throws(
      () => database.prepare("UPDATE project_goal_continuation_plans SET status = 'cancelled', cancelled_at = created_at WHERE plan_id = ?").run(plan.planId),
      /consumption_immutable/,
    );
    assert.throws(
      () => database.prepare("UPDATE project_goal_continuation_plans SET status = 'planned', cancelled_at = NULL WHERE plan_id = ?").run(plan.planId),
      /consumption_immutable/,
    );
    assert.equal(database.prepare('SELECT created_task_id FROM project_goal_continuation_consumptions WHERE plan_id = ?').get(plan.planId).created_task_id, result.createdTaskId);
    database.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(reopened.readContinuationPlan(plan.planId).status, 'consumed');
    assert.equal(reopened.materializeContinuation(plan.planId).createdTaskId, result.createdTaskId);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const isolated = await tempDatabase('lia-runtime-false-consumption-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath: isolated.databasePath });
    const { plan } = seedPlan(store);
    store.close();
    const database = new DatabaseSync(isolated.databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () => database.prepare('INSERT INTO project_goal_continuation_consumptions VALUES (?, ?, ?)').run(plan.planId, ROOT, 999),
      /plan_incompatible/,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM project_goal_continuation_consumptions').get().count, 0);
    database.close();
  } finally {
    await rm(isolated.directory, { recursive: true, force: true });
  }
});

test('task-insert and post-lineage/pre-consumption failures roll back task, lineage, Goal and plan', async () => {
  for (const [name, trigger] of [
    ['task-insert', `
      CREATE TRIGGER runtime_fail_task BEFORE INSERT ON project_tasks
      BEGIN SELECT RAISE(ABORT, 'runtime_injected_task_failure'); END;
    `],
    ['before-consumption', `
      CREATE TRIGGER runtime_fail_consumption BEFORE INSERT ON project_goal_continuation_consumptions
      BEGIN SELECT RAISE(ABORT, 'runtime_injected_consumption_failure'); END;
    `],
  ]) {
    const { directory, databasePath } = await tempDatabase(`lia-runtime-rollback-${name}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
      const { plan } = seedPlan(store);
      const database = new DatabaseSync(databasePath);
      database.exec(trigger);
      database.close();
      assert.throws(() => store.materializeContinuation(plan.planId), /runtime_injected/);
      assert.deepEqual(inspect(databasePath), { tasks: 1, lineage: 1, consumptions: 0, currentAttempt: 0 });
      assert.equal(store.readContinuationPlan(plan.planId).status, 'planned');
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('schema rejects a second plan for one evaluation and runtime does not duplicate lineage', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    const { evaluation, plan } = seedPlan(store);
    const replayedPlan = store.createContinuationPlan({
      goalId: GOAL,
      sourceEvaluationId: evaluation.evaluationId,
      plannerVersion: CONTINUATION_PLANNER_VERSION,
      sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
    });
    assert.equal(replayedPlan.planId, plan.planId);
    const one = store.materializeContinuation(plan.planId);
    const two = store.materializeContinuation(plan.planId);
    assert.equal(one.createdTaskId, two.createdTaskId);
    assert.deepEqual(store.listGoalAttempts(GOAL).map((task) => task.lineage.attemptNumber), [0, 1]);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy task behavior is unchanged and an authentic V5 database migrates additively', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    let store = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(store.createOrGet(LEGACY, 'legacy', intent()).kind, 'created');
    assert.equal(store.get(LEGACY).lineage, undefined);
    store.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TRIGGER project_task_execution_launch_results_validate_insert;
      DROP TRIGGER project_task_execution_launch_results_immutable_update;
      DROP TRIGGER project_task_execution_launch_results_immutable_delete;
      DROP INDEX project_task_execution_launch_results_recorded;
      DROP TABLE project_task_execution_launch_results;
      DROP TRIGGER project_task_execution_invocations_preserve_on_lease_release;
      DROP TABLE project_task_execution_invocations;
      DROP TABLE project_task_execution_runs;
      DROP TABLE project_task_dispatch_outbox;
      DROP TRIGGER project_task_lease_validate_insert;
      DROP TRIGGER project_task_lease_identity_immutable;
      DROP TRIGGER project_task_lease_expiry_monotonic;
      DROP TRIGGER project_task_lease_release_once;
      DROP TRIGGER project_task_lease_generation_immutable_delete;
      DROP TRIGGER project_task_execution_launch_attempts_preserve_on_lease_release;
      DROP TRIGGER project_task_execution_launch_attempts_validate_insert;
      DROP TRIGGER project_task_execution_launch_attempts_immutable_update;
      DROP TRIGGER project_task_execution_launch_attempts_immutable_delete;
      DROP INDEX project_task_execution_launch_attempts_crossed;
      DROP TABLE project_task_execution_launch_attempts;
      DROP TABLE project_task_lease_generations;
    `);
    legacy.exec('DROP TRIGGER project_goal_continuation_consumed_plan_state_immutable');
    legacy.exec('DROP TABLE project_goal_continuation_consumptions');
    legacy.prepare('UPDATE project_task_meta SET schema_version = 5 WHERE singleton = 1').run();
    legacy.close();

    store = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(store.get(LEGACY).fingerprint, 'legacy');
    assert.equal(store.get(LEGACY).lineage, undefined);
    store.close();
    const migrated = new DatabaseSync(databasePath);
    assert.equal(migrated.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_goal_continuation_consumptions'").get());
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime is materialization-only and does not enter workflow, Hermes, Codex, handoff or routing authority', async () => {
  const [storeSource, workflowSource, handoffSource, routesSource] = await Promise.all([
    readFile(new URL('../src/services/projectTaskSqliteStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/projectTaskWorkflowService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/projectCodexHandoff.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/projectTasks.ts', import.meta.url), 'utf8'),
  ]);
  const materialization = storeSource.slice(
    storeSource.indexOf('materializeContinuation('),
    storeSource.indexOf('cancelContinuationPlan(', storeSource.indexOf('materializeContinuation(')),
  );
  for (const forbidden of ['workflowService', 'executeProject', 'Codex', 'Hermes', 'git commit', 'push', 'merge', 'deploy']) {
    assert.equal(materialization.includes(forbidden), false, forbidden);
  }
  assert.equal(workflowSource.includes('materializeContinuation'), false);
  assert.equal(handoffSource.includes('planId'), false);
  assert.equal(routesSource.includes('materializeContinuation'), false);
  assert.match(handoffSource, /effectiveCapabilities/);
});

test('legacy reconciliation remains unchanged for a materialized but undispatched task', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 500 });
    const { plan } = seedPlan(store);
    const result = store.materializeContinuation(plan.planId);
    assert.equal(store.reconcileInterruptedTasks(), 1);
    const interrupted = store.get(result.createdTaskId);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error.code, 'workflow_interrupted');
    assert.equal(interrupted.error.message, SAFE_TASK_ERROR_MESSAGES.workflow_interrupted);
    assert.equal(store.readContinuationPlan(plan.planId).createdTaskId, result.createdTaskId);
    assert.equal(store.readGoal(GOAL).currentAttempt, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
