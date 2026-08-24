import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  PROJECT_GOAL_EVALUATOR_VERSION,
} from '../dist/contracts/projectGoalEvaluation.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { evaluateProjectGoalCompletion } from '../dist/services/projectCompletionEvaluator.js';
import {
  PROJECT_TASK_SQLITE_SCHEMA_VERSION,
  initializeProjectTaskSqliteDatabaseV1,
} from '../dist/services/projectTaskSqliteSchema.js';

const GOAL = '850e8400-e29b-41d4-a716-446655440000';
const GOAL2 = '850e8400-e29b-41d4-a716-446655440001';
const GOAL3 = '850e8400-e29b-41d4-a716-446655440002';
const TASK = '950e8400-e29b-41d4-a716-446655440000';
const TASK2 = '950e8400-e29b-41d4-a716-446655440001';
const LEGACY = '950e8400-e29b-41d4-a716-446655440002';
const TASK3 = '950e8400-e29b-41d4-a716-446655440003';

const intent = (projectId = 'safe', requestedCapabilities = ['repository_read']) => ({
  projectId,
  instruction: 'Complete the bounded durable objective.',
  priority: 'normal',
  requestedCapabilities,
});

const evidence = (overrides = {}) => ({
  goalSatisfaction: 'not_demonstrated',
  blocking: 'none',
  failure: 'retryable',
  ...overrides,
});

const verifiedReceipt = (overrides = {}) => ({
  executionId: 'safe-execution-id',
  status: 'verified',
  resultText: 'Safe public result.',
  verification: { status: 'verified', checksPassed: 2, totalChecks: 2 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
  ...overrides,
});

const failure = (code = 'codex_execution_failed', overrides = {}) => ({
  code,
  message: SAFE_TASK_ERROR_MESSAGES[code],
  stage: code.startsWith('visual_') || code.startsWith('check_') ? 'verification' : 'codex',
  ...overrides,
});

async function tempDatabase(prefix = 'lia-completion-evaluator-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seed(store, {
  goalId = GOAL,
  taskId = TASK,
  projectId = 'safe',
  maxAttempts = 3,
  continuationDepthLimit = 2,
} = {}) {
  store.createGoal({
    goalId,
    projectId,
    objective: 'Deliver every required surface and verify the result.',
    maxAttempts,
    continuationDepthLimit,
  });
  const created = store.createRootAttempt({
    taskId,
    fingerprint: `${taskId}-fingerprint`,
    intent: intent(projectId),
    goalId,
    continuationDepth: 0,
    attemptNumber: 0,
  });
  assert.equal(created.kind, 'created');
}

function evaluate(store, overrides = {}) {
  return store.evaluateGoalAttempt({
    goalId: GOAL,
    taskId: TASK,
    attemptNumber: 0,
    evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
    evidence: evidence(),
    ...overrides,
  });
}

test('valid contract persists a versioned retryable decision and apply keeps Goal active', async () => {
  const { directory, databasePath } = await tempDatabase();
  let now = 1000;
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    seed(store);
    store.complete(TASK, verifiedReceipt());
    now = 2000;
    const evaluation = evaluate(store, { evidence: evidence({ goalSatisfaction: 'partial' }) });
    assert.match(evaluation.evaluationId, /^[0-9a-f-]{36}$/);
    assert.equal(evaluation.goalId, GOAL);
    assert.equal(evaluation.taskId, TASK);
    assert.equal(evaluation.attemptNumber, 0);
    assert.equal(evaluation.evaluatorVersion, 'completion-evaluator-v1');
    assert.equal(evaluation.decision, 'retryable');
    assert.equal(evaluation.reasonCode, 'partial_result');
    assert.match(evaluation.evidenceFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(evaluation.createdAt, 2000);
    assert.deepEqual(store.readGoalEvaluation(evaluation.evaluationId), evaluation);
    assert.deepEqual(store.readLatestGoalEvaluation(GOAL), evaluation);
    assert.deepEqual(store.listGoalEvaluations(GOAL), [evaluation]);
    const goal = store.applyGoalEvaluation(evaluation.evaluationId);
    assert.equal(goal.status, 'active');
    assert.equal(store.readGoalEvaluation(evaluation.evaluationId).appliedAt, 2000);
    assert.equal(store.applyGoalEvaluation(evaluation.evaluationId).status, 'active');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('evaluation and fingerprint survive reopen; replay returns the durable decision', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seed(first);
    first.complete(TASK, verifiedReceipt());
    const original = evaluate(first);
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9999 });
    assert.deepEqual(reopened.readGoalEvaluation(original.evaluationId), original);
    assert.deepEqual(evaluate(reopened), original);
    assert.equal(evaluate(reopened).evidenceFingerprint, original.evidenceFingerprint);
    assert.throws(
      () => evaluate(reopened, { evidence: evidence({ goalSatisfaction: 'partial' }) }),
      /project_goal_evaluation_evidence_conflict/,
    );
    assert.equal(reopened.listGoalEvaluations(GOAL).length, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects wrong Goal, project, attempt number, stale attempt, nonterminal and legacy tasks', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
    seed(store);
    store.createGoal({ goalId: GOAL2, projectId: 'safe', objective: 'Other Goal in the same project.' });
    store.createRootAttempt({
      taskId: TASK2,
      fingerprint: 'other',
      intent: intent('safe'),
      goalId: GOAL2,
      continuationDepth: 0,
      attemptNumber: 0,
    });
    store.complete(TASK2, verifiedReceipt());
    store.createGoal({ goalId: GOAL3, projectId: 'other', objective: 'Other project objective.' });
    store.createRootAttempt({
      taskId: TASK3,
      fingerprint: 'other-project',
      intent: intent('other'),
      goalId: GOAL3,
      continuationDepth: 0,
      attemptNumber: 0,
    });
    store.complete(TASK3, verifiedReceipt());
    store.createOrGet(LEGACY, 'legacy', intent());
    store.complete(LEGACY, verifiedReceipt());

    assert.throws(() => evaluate(store), /project_goal_evaluation_task_not_terminal/);
    assert.throws(
      () => evaluate(store, { taskId: TASK2 }),
      /project_goal_evaluation_task_goal_mismatch/,
    );
    assert.throws(
      () => evaluate(store, { taskId: TASK3 }),
      /project_goal_evaluation_task_project_mismatch/,
    );
    assert.throws(
      () => evaluate(store, { taskId: LEGACY }),
      /project_goal_evaluation_task_goal_mismatch/,
    );
    store.complete(TASK, verifiedReceipt());
    assert.throws(
      () => evaluate(store, { attemptNumber: 1 }),
      /project_goal_evaluation_attempt_mismatch/,
    );
    assert.equal(store.get(LEGACY).lineage, undefined);
    assert.equal(store.get(LEGACY).status, 'completed');
    assert.equal(store.listGoalEvaluations(GOAL).length, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a prepared evaluation fails closed if the Goal state changes before explicit apply', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seed(store);
    store.complete(TASK, verifiedReceipt());
    const prepared = evaluate(store, { evidence: evidence({ goalSatisfaction: 'satisfied' }) });
    store.transitionGoal(GOAL, 'failed');
    assert.throws(
      () => store.applyGoalEvaluation(prepared.evaluationId),
      /project_goal_evaluation_incompatible_state/,
    );
    assert.equal(store.readGoal(GOAL).status, 'failed');
    assert.equal(store.readGoalEvaluation(prepared.evaluationId).appliedAt, undefined);
    assert.deepEqual(
      evaluate(store, { evidence: evidence({ goalSatisfaction: 'satisfied' }) }),
      prepared,
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('completed, blocked and failed decisions explicitly terminalize to the mapped Goal state', async () => {
  const cases = [
    {
      name: 'completed',
      finish: (store) => store.complete(TASK, verifiedReceipt()),
      semantic: evidence({ goalSatisfaction: 'satisfied' }),
      decision: 'completed', reason: 'goal_satisfied', status: 'completed',
    },
    {
      name: 'blocked',
      finish: (store) => store.fail(TASK, failure('human_approval_required', { stage: 'approval' })),
      semantic: evidence(),
      decision: 'blocked', reason: 'human_approval_required', status: 'blocked',
    },
    {
      name: 'failed',
      finish: (store) => store.fail(TASK, failure()),
      semantic: evidence({ failure: 'unrecoverable' }),
      decision: 'failed', reason: 'execution_failed', status: 'failed',
    },
  ];
  for (const item of cases) {
    const { directory, databasePath } = await tempDatabase(`lia-evaluator-${item.name}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      seed(store);
      item.finish(store);
      const result = store.evaluateAndApplyGoalAttempt({
        goalId: GOAL,
        taskId: TASK,
        attemptNumber: 0,
        evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
        evidence: item.semantic,
      });
      assert.equal(result.evaluation.decision, item.decision);
      assert.equal(result.evaluation.reasonCode, item.reason);
      assert.equal(result.goal.status, item.status);
      assert.ok(result.evaluation.appliedAt !== undefined);
      assert.throws(
        () => store.transitionGoal(GOAL, item.status === 'completed' ? 'failed' : 'completed'),
        /invalid_project_goal_transition/,
      );
      assert.equal(store.readGoal(GOAL).status, item.status);
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('technical/visual failures, commit-only and verified-only claims never imply Goal completion', async () => {
  const cases = [
    {
      projectId: 'safe',
      finish: (store) => store.fail(TASK, failure('check_failed')),
      semantic: evidence({ goalSatisfaction: 'satisfied' }),
      reason: 'verification_failed',
    },
    {
      projectId: 'lia-hermes-mobile-preview',
      finish: (store) => store.fail(TASK, failure('visual_check_failed')),
      semantic: evidence({ goalSatisfaction: 'satisfied' }),
      reason: 'visual_verification_failed',
    },
    {
      projectId: 'safe',
      finish: (store) => store.complete(TASK, verifiedReceipt({
        status: 'committed', commit: 'a'.repeat(40), verification: undefined,
        stages: ['planning', 'hermes', 'codex'],
      })),
      semantic: evidence({ goalSatisfaction: 'satisfied' }),
      reason: 'insufficient_evidence',
    },
    {
      projectId: 'safe',
      finish: (store) => store.complete(TASK, verifiedReceipt()),
      semantic: evidence(),
      reason: 'insufficient_evidence',
    },
    {
      projectId: 'lia-hermes-mobile-preview',
      finish: (store) => store.complete(TASK, verifiedReceipt()),
      semantic: evidence({ goalSatisfaction: 'satisfied' }),
      reason: 'visual_verification_failed',
    },
  ];
  for (const [index, item] of cases.entries()) {
    const { directory, databasePath } = await tempDatabase(`lia-evidence-${index}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      seed(store, { projectId: item.projectId });
      item.finish(store);
      const result = evaluate(store, { evidence: item.semantic });
      assert.notEqual(result.decision, 'completed');
      assert.equal(result.reasonCode, item.reason);
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('bounded blocking classifications produce blocked without granting capabilities', async () => {
  for (const blocking of ['human_approval_required', 'forbidden_capability_required', 'external_dependency']) {
    const { directory, databasePath } = await tempDatabase(`lia-blocking-${blocking}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      seed(store);
      store.complete(TASK, verifiedReceipt());
      const before = store.get(TASK).intent.requestedCapabilities;
      const result = evaluate(store, {
        evidence: evidence({ blocking, goalSatisfaction: 'satisfied' }),
      });
      assert.equal(result.decision, 'blocked');
      assert.equal(result.reasonCode, blocking);
      assert.deepEqual(store.get(TASK).intent.requestedCapabilities, before);
      assert.equal('approvedCapabilities' in result, false);
      assert.equal('effectiveCapabilities' in result, false);
      assert.equal('requestedCapabilities' in result, false);
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('attempt and depth exhaustion fail closed and terminalize Goal as exhausted', async () => {
  for (const [limits, reason] of [
    [{ maxAttempts: 1, continuationDepthLimit: 2 }, 'attempt_budget_exhausted'],
    [{ maxAttempts: 3, continuationDepthLimit: 0 }, 'continuation_depth_exhausted'],
  ]) {
    const { directory, databasePath } = await tempDatabase(`lia-exhaust-${reason}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      seed(store, limits);
      store.fail(TASK, failure());
      const result = store.evaluateAndApplyGoalAttempt({
        goalId: GOAL,
        taskId: TASK,
        attemptNumber: 0,
        evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
        evidence: evidence(),
      });
      assert.equal(result.evaluation.decision, 'failed');
      assert.equal(result.evaluation.reasonCode, reason);
      assert.equal(result.goal.status, 'exhausted');
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('repeated evaluators cannot create contradictory decisions and SQLite rejects direct mutation', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const first = new ProjectTaskSqliteStore({ databasePath });
    seed(first);
    first.complete(TASK, verifiedReceipt());
    const original = evaluate(first);
    first.close();

    const second = new ProjectTaskSqliteStore({ databasePath });
    assert.deepEqual(evaluate(second), original);
    assert.throws(
      () => evaluate(second, { evidence: evidence({ goalSatisfaction: 'satisfied' }) }),
      /project_goal_evaluation_evidence_conflict/,
    );
    second.close();

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () => database.prepare('UPDATE project_goals SET objective = ? WHERE goal_id = ?')
        .run('Changed objective after evaluation.', GOAL),
      /project_goal_evaluation_incompatible_state/,
    );
    assert.throws(
      () => database.prepare("UPDATE project_goal_evaluations SET decision = 'completed', reason_code = 'goal_satisfied' WHERE evaluation_id = ?")
        .run(original.evaluationId),
      /project_goal_evaluation_immutable/,
    );
    assert.throws(
      () => database.prepare("UPDATE project_goals SET status = 'completed', terminal_reason = 'objective_completed', terminal_at = updated_at WHERE goal_id = ?")
        .run(GOAL)
        && database.prepare("UPDATE project_goals SET status = 'active', terminal_reason = NULL, terminal_at = NULL WHERE goal_id = ?").run(GOAL),
      /invalid_project_goal_transition/,
    );
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent evaluators recover one durable decision instead of creating contradictions', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const seedStore = new ProjectTaskSqliteStore({ databasePath });
    seed(seedStore);
    seedStore.complete(TASK, verifiedReceipt());
    seedStore.close();

    const moduleUrl = new URL('../dist/services/projectTaskSqliteStore.js', import.meta.url).href;
    const contractUrl = new URL('../dist/contracts/projectGoalEvaluation.js', import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        try {
          const { ProjectTaskSqliteStore } = await import(workerData.moduleUrl);
          const { PROJECT_GOAL_EVALUATOR_VERSION } = await import(workerData.contractUrl);
          const store = new ProjectTaskSqliteStore({ databasePath: workerData.databasePath });
          const result = store.evaluateGoalAttempt({
            goalId: workerData.goalId,
            taskId: workerData.taskId,
            attemptNumber: 0,
            evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
            evidence: {
              goalSatisfaction: 'not_demonstrated',
              blocking: 'none',
              failure: 'retryable',
            },
          });
          store.close();
          parentPort.postMessage({ ok: true, result });
        } catch (error) {
          parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    `;
    const runWorker = () => new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { moduleUrl, contractUrl, databasePath, goalId: GOAL, taskId: TASK },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const [first, second] = await Promise.all([runWorker(), runWorker()]);
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.equal(first.result.evaluationId, second.result.evaluationId);
    assert.deepEqual(first.result, second.result);

    const reopened = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(reopened.listGoalEvaluations(GOAL).length, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('evaluation and Goal transition roll back together when apply fails transactionally', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const first = new ProjectTaskSqliteStore({ databasePath });
    seed(first);
    first.complete(TASK, verifiedReceipt());
    const evaluation = evaluate(first, { evidence: evidence({ goalSatisfaction: 'satisfied' }) });
    first.close();

    const sabotage = new DatabaseSync(databasePath);
    sabotage.exec(`
      CREATE TRIGGER test_abort_evaluation_apply
      BEFORE UPDATE OF applied_at ON project_goal_evaluations
      BEGIN SELECT RAISE(ABORT, 'simulated_apply_failure'); END;
    `);
    sabotage.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath });
    assert.throws(() => reopened.applyGoalEvaluation(evaluation.evaluationId), /simulated_apply_failure/);
    assert.equal(reopened.readGoal(GOAL).status, 'active');
    assert.equal(reopened.readGoalEvaluation(evaluation.evaluationId).appliedAt, undefined);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy SQLite migrates additively and evaluator metadata stays outside Codex authority', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.prepare(`
      INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at)
      VALUES (?, 'legacy', ?, 'accepted', 1, 1)
    `).run(LEGACY, JSON.stringify(intent()));
    legacy.close();

    const store = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(store.get(LEGACY).lineage, undefined);
    assert.equal(store.get(LEGACY).status, 'accepted');
    store.close();

    const migrated = new DatabaseSync(databasePath);
    assert.equal(
      migrated.prepare('SELECT schema_version FROM project_task_meta WHERE singleton = 1').get().schema_version,
      PROJECT_TASK_SQLITE_SCHEMA_VERSION,
    );
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_goal_evaluations'").get());
    migrated.close();

    const authoritySources = await Promise.all([
      '../src/services/projectTaskWorkflowService.ts',
      '../src/contracts/projectCodexHandoff.ts',
      '../src/services/projectExecutionPlanner.ts',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
    for (const source of authoritySources) {
      for (const field of [
        'evaluationId', 'reasonCode', 'evidenceFingerprint',
      ]) assert.equal(source.includes(field), false);
    }
    assert.match(authoritySources[1], /effectiveCapabilities/);
    assert.match(authoritySources[2], /approvedCapabilities/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('read-only completed task may satisfy goal from durable analyzed result without code verification', () => {
  const goal = {
    goalId: 'd50e8400-e29b-41d4-a716-446655440099',
    projectId: 'safe',
    objective: 'Inspect repository architecture',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    maxAttempts: 1,
    continuationDepthLimit: 0,
    currentAttempt: 0,
  };

  const task = {
    taskId: '450e8400-e29b-41d4-a716-446655440099',
    fingerprint: 'fp',
    status: 'completed',
    intent: {
      projectId: 'safe',
      instruction: 'Inspect repository architecture',
      priority: 'normal',
      requestedCapabilities: ['repository_read'],
    },
    createdAt: 1,
    updatedAt: 2,
    terminalAt: 2,
    lineage: {
      goalId: goal.goalId,
      rootTaskId: '450e8400-e29b-41d4-a716-446655440099',
      attemptNumber: 0,
      continuationDepth: 0,
    },
    receipt: {
      executionId: 'read-only-execution',
      status: 'analyzed',
      resultText: 'Inspect repository architecture',
      stages: ['planning', 'hermes', 'codex'],
    },
  };

  const result = evaluateProjectGoalCompletion(
    { goal, task },
    {
      goalSatisfaction: 'satisfied',
      blocking: 'none',
      failure: 'retryable',
    },
  );

  assert.equal(result.decision, 'completed');
  assert.equal(result.reasonCode, 'goal_satisfied');
});

test('write-capable completed task still requires technical verification', () => {
  const goal = {
    goalId: 'd50e8400-e29b-41d4-a716-446655440098',
    projectId: 'safe',
    objective: 'Modify repository',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    maxAttempts: 1,
    continuationDepthLimit: 0,
    currentAttempt: 0,
  };

  const task = {
    taskId: '450e8400-e29b-41d4-a716-446655440098',
    fingerprint: 'fp',
    status: 'completed',
    intent: {
      projectId: 'safe',
      instruction: 'Modify repository',
      priority: 'normal',
      requestedCapabilities: ['repository_read', 'isolated_worktree_write'],
    },
    createdAt: 1,
    updatedAt: 2,
    terminalAt: 2,
    lineage: {
      goalId: goal.goalId,
      rootTaskId: '450e8400-e29b-41d4-a716-446655440098',
      attemptNumber: 0,
      continuationDepth: 0,
    },
    receipt: {
      executionId: 'write-execution',
      status: 'analyzed',
      resultText: 'Modify repository',
      stages: ['planning', 'hermes', 'codex'],
    },
  };

  const result = evaluateProjectGoalCompletion(
    { goal, task },
    {
      goalSatisfaction: 'satisfied',
      blocking: 'none',
      failure: 'retryable',
    },
  );

  assert.notEqual(result.decision, 'completed');
});
