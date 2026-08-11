import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  CONTINUATION_PLANNER_VERSION,
  PROJECT_GOAL_CONTINUATION_PLAN_REASON_CODES,
} from '../dist/contracts/projectGoalContinuationPlan.js';
import { PROJECT_GOAL_EVALUATOR_VERSION } from '../dist/contracts/projectGoalEvaluation.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import {
  fingerprintContinuationPlanMeaning,
  isSafeContinuationInstruction,
} from '../dist/services/projectContinuationPlanner.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import {
  PROJECT_TASK_SQLITE_SCHEMA_VERSION,
  initializeProjectTaskSqliteDatabaseV1,
} from '../dist/services/projectTaskSqliteSchema.js';

const GOAL = 'a50e8400-e29b-41d4-a716-446655440000';
const GOAL2 = 'a50e8400-e29b-41d4-a716-446655440001';
const ROOT = 'b50e8400-e29b-41d4-a716-446655440000';
const CHILD = 'b50e8400-e29b-41d4-a716-446655440001';
const OTHER = 'b50e8400-e29b-41d4-a716-446655440002';
const LEGACY = 'b50e8400-e29b-41d4-a716-446655440003';

const intent = (projectId = 'safe', instruction = 'Complete the bounded durable objective.') => ({
  projectId,
  instruction,
  priority: 'normal',
  requestedCapabilities: ['repository_read'],
});
const evidence = (overrides = {}) => ({
  goalSatisfaction: 'partial',
  blocking: 'none',
  failure: 'retryable',
  ...overrides,
});
const receipt = {
  executionId: 'planner-test-execution',
  status: 'verified',
  resultText: 'Bounded result.',
  verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
};
const failure = (code = 'codex_execution_failed') => ({
  code,
  message: SAFE_TASK_ERROR_MESSAGES[code],
  stage: code.startsWith('visual_') || code.startsWith('check_') ? 'verification' : 'codex',
});

async function tempDatabase(prefix = 'lia-continuation-planner-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seed(store, {
  goalId = GOAL,
  taskId = ROOT,
  projectId = 'safe',
  objective = 'Deliver the remaining bounded surfaces and verify the result.',
  maxAttempts = 3,
  continuationDepthLimit = 2,
} = {}) {
  store.createGoal({ goalId, projectId, objective, maxAttempts, continuationDepthLimit });
  assert.equal(store.createRootAttempt({
    taskId,
    fingerprint: `${taskId}-fingerprint`,
    intent: intent(projectId),
    goalId,
    continuationDepth: 0,
    attemptNumber: 0,
  }).kind, 'created');
}

function evaluate(store, {
  goalId = GOAL,
  taskId = ROOT,
  attemptNumber = 0,
  semantic = evidence(),
  apply = true,
} = {}) {
  const input = {
    goalId,
    taskId,
    attemptNumber,
    evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
    evidence: semantic,
  };
  return apply
    ? store.evaluateAndApplyGoalAttempt(input).evaluation
    : store.evaluateGoalAttempt(input);
}

function planningInput(evaluation, goalId = evaluation.goalId, overrides = {}) {
  return {
    goalId,
    sourceEvaluationId: evaluation.evaluationId,
    plannerVersion: CONTINUATION_PLANNER_VERSION,
    sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
    ...overrides,
  };
}

function insertSyntheticRetryable(databasePath, {
  goalId = GOAL,
  taskId = ROOT,
  evaluationId = 'c50e8400-e29b-41d4-a716-446655440000',
  reasonCode = 'execution_failed',
} = {}) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  database.prepare(`
    INSERT INTO project_goal_evaluations (
      evaluation_id, goal_id, task_id, attempt_number, evaluator_version,
      decision, reason_code, summary, evidence_fingerprint, created_at
    ) VALUES (?, ?, ?, 0, 'completion-evaluator-v1', 'retryable', ?, ?, ?, 10)
  `).run(evaluationId, goalId, taskId, reasonCode, 'Synthetic bounded retryable evaluation.', 'a'.repeat(64));
  database.close();
  return evaluationId;
}

test('creates the exact durable contract from an applied retryable evaluation without side effects', async () => {
  const { directory, databasePath } = await tempDatabase();
  let now = 100;
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
    seed(store);
    store.complete(ROOT, receipt);
    const evaluation = evaluate(store);
    const taskBefore = store.get(ROOT);
    const goalBefore = store.readGoal(GOAL);
    now = 200;
    const plan = store.createContinuationPlan(planningInput(evaluation));

    assert.match(plan.planId, /^[0-9a-f-]{36}$/);
    assert.equal(plan.goalId, GOAL);
    assert.equal(plan.sourceEvaluationId, evaluation.evaluationId);
    assert.equal(plan.parentTaskId, ROOT);
    assert.equal(plan.parentAttemptNumber, 0);
    assert.equal(plan.nextAttemptNumber, 1);
    assert.equal(plan.nextContinuationDepth, 1);
    assert.equal(plan.plannerVersion, 'continuation-planner-v1');
    assert.equal(plan.status, 'planned');
    assert.equal(plan.reasonCode, 'continue_partial_result');
    assert.equal(plan.sourceEvidenceFingerprint, evaluation.evidenceFingerprint);
    assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(plan.createdAt, 200);
    assert.ok(plan.instruction.length > 0 && plan.instruction.length <= 2_000);
    assert.match(plan.instruction, /remaining unsatisfied parts/);
    assert.equal(isSafeContinuationInstruction(plan.instruction), true);
    assert.deepEqual(store.readContinuationPlan(plan.planId), plan);
    assert.deepEqual(store.readContinuationPlanBySourceEvaluation(evaluation.evaluationId), plan);
    assert.deepEqual(store.listGoalContinuationPlans(GOAL), [plan]);
    assert.deepEqual(store.assertContinuationPlanUsable(plan.planId), plan);
    assert.deepEqual(store.get(ROOT), taskBefore);
    assert.deepEqual(store.readGoal(GOAL), goalBefore);
    assert.equal(store.listGoalAttempts(GOAL).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay and reopen preserve one stable plan and fingerprint', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 100 });
    seed(first);
    first.complete(ROOT, receipt);
    const evaluation = evaluate(first);
    const original = first.createContinuationPlan(planningInput(evaluation));
    assert.deepEqual(first.createContinuationPlan(planningInput(evaluation)), original);
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 999 });
    assert.deepEqual(reopened.readContinuationPlan(original.planId), original);
    assert.deepEqual(reopened.createContinuationPlan(planningInput(evaluation)), original);
    assert.equal(reopened.listGoalContinuationPlans(GOAL).length, 1);
    const meaning = { ...original };
    for (const field of ['planId', 'status', 'fingerprint', 'createdAt', 'cancelledAt']) delete meaning[field];
    assert.equal(fingerprintContinuationPlanMeaning(meaning), original.fingerprint);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed for unapplied, non-retryable, wrong Goal, terminal Goal and evidence conflicts', async () => {
  const cases = [
    { name: 'completed', finish: (s) => s.complete(ROOT, receipt), semantic: evidence({ goalSatisfaction: 'satisfied' }), error: /evaluation_not_retryable/ },
    { name: 'blocked', finish: (s) => s.fail(ROOT, { code: 'human_approval_required', message: SAFE_TASK_ERROR_MESSAGES.human_approval_required, stage: 'approval' }), semantic: evidence(), error: /evaluation_not_retryable/ },
    { name: 'failed', finish: (s) => s.fail(ROOT, failure()), semantic: evidence({ failure: 'unrecoverable' }), error: /evaluation_not_retryable/ },
  ];
  for (const item of cases) {
    const { directory, databasePath } = await tempDatabase(`lia-planner-${item.name}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      seed(store);
      item.finish(store);
      const evaluation = evaluate(store, { semantic: item.semantic });
      assert.throws(() => store.createContinuationPlan(planningInput(evaluation)), item.error);
      assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const { directory, databasePath } = await tempDatabase('lia-planner-source-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
    seed(store);
    store.complete(ROOT, receipt);
    const prepared = evaluate(store, { apply: false });
    assert.throws(() => store.createContinuationPlan(planningInput(prepared)), /evaluation_not_applied/);
    store.applyGoalEvaluation(prepared.evaluationId);
    assert.throws(
      () => store.createContinuationPlan(planningInput(prepared, GOAL2)),
      /goal_mismatch/,
    );
    assert.throws(
      () => store.createContinuationPlan(planningInput(prepared, GOAL, { sourceEvidenceFingerprint: 'b'.repeat(64) })),
      /evidence_conflict/,
    );
    store.transitionGoal(GOAL, 'failed');
    assert.throws(() => store.createContinuationPlan(planningInput(prepared)), /goal_terminal/);
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects another Goal/project, stale attempts, exhausted attempt/depth and legacy tasks', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    let store = new ProjectTaskSqliteStore({ databasePath, maxActive: 10 });
    seed(store);
    store.complete(ROOT, receipt);
    const oldEvaluation = evaluate(store);
    store.createContinuationAttempt({
      taskId: CHILD,
      fingerprint: 'child',
      intent: intent(),
      goalId: GOAL,
      parentTaskId: ROOT,
      continuationDepth: 1,
      attemptNumber: 1,
    });
    assert.throws(() => store.createContinuationPlan(planningInput(oldEvaluation)), /stale_attempt/);

    seed(store, { goalId: GOAL2, taskId: OTHER, projectId: 'other' });
    store.complete(OTHER, receipt);
    const otherEvaluation = evaluate(store, { goalId: GOAL2, taskId: OTHER });
    assert.throws(() => store.createContinuationPlan(planningInput(otherEvaluation, GOAL)), /goal_mismatch/);
    store.createOrGet(LEGACY, 'legacy', intent());
    store.complete(LEGACY, receipt);
    assert.throws(
      () => store.createContinuationPlan({
        goalId: GOAL,
        sourceEvaluationId: LEGACY,
        plannerVersion: CONTINUATION_PLANNER_VERSION,
        sourceEvidenceFingerprint: 'a'.repeat(64),
      }),
      /evaluation_not_found/,
    );
    store.close();

    for (const [limits, expected] of [
      [{ maxAttempts: 1, continuationDepthLimit: 2 }, /attempt_limit/],
      [{ maxAttempts: 3, continuationDepthLimit: 0 }, /depth_limit/],
    ]) {
      const isolated = await tempDatabase(`lia-planner-limit-${limits.maxAttempts}-`);
      try {
        store = new ProjectTaskSqliteStore({ databasePath: isolated.databasePath });
        seed(store, limits);
        store.fail(ROOT, failure());
        const evaluationId = insertSyntheticRetryable(isolated.databasePath);
        const goal = store.applyGoalEvaluation(evaluationId);
        assert.equal(goal.status, 'active');
        const evaluation = store.readGoalEvaluation(evaluationId);
        assert.throws(() => store.createContinuationPlan(planningInput(evaluation)), expected);
        assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
        store.close();
      } finally {
        await rm(isolated.directory, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('all retryable evaluator reasons map to a closed plan reason vocabulary', async () => {
  const cases = [
    ['partial_result', (s) => s.complete(ROOT, receipt), evidence()],
    ['verification_failed', (s) => s.fail(ROOT, failure('check_failed')), evidence({ goalSatisfaction: 'not_demonstrated' })],
    ['visual_verification_failed', (s) => s.fail(ROOT, failure('visual_check_failed')), evidence({ goalSatisfaction: 'not_demonstrated' })],
    ['execution_failed', (s) => s.fail(ROOT, failure()), evidence({ goalSatisfaction: 'not_demonstrated' })],
    ['insufficient_evidence', (s) => s.complete(ROOT, receipt), evidence({ goalSatisfaction: 'not_demonstrated' })],
  ];
  const expected = [
    'continue_partial_result', 'retry_verification_failure', 'retry_visual_failure',
    'retry_execution_failure', 'retry_insufficient_evidence',
  ];
  for (const [index, [evaluationReason, finish, semantic]] of cases.entries()) {
    const { directory, databasePath } = await tempDatabase(`lia-planner-reason-${index}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      seed(store);
      finish(store);
      const evaluation = evaluate(store, { semantic });
      assert.equal(evaluation.reasonCode, evaluationReason);
      const plan = store.createContinuationPlan(planningInput(evaluation));
      assert.equal(plan.reasonCode, expected[index]);
      assert.ok(PROJECT_GOAL_CONTINUATION_PLAN_REASON_CODES.includes(plan.reasonCode));
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('concurrent planners serialize to exactly one durable compatible plan', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const seedStore = new ProjectTaskSqliteStore({ databasePath });
    seed(seedStore);
    seedStore.complete(ROOT, receipt);
    const evaluation = evaluate(seedStore);
    seedStore.close();

    const moduleUrl = new URL('../dist/services/projectTaskSqliteStore.js', import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        try {
          const { ProjectTaskSqliteStore } = await import(workerData.moduleUrl);
          const store = new ProjectTaskSqliteStore({ databasePath: workerData.databasePath });
          const result = store.createContinuationPlan(workerData.input);
          store.close();
          parentPort.postMessage({ ok: true, result });
        } catch (error) {
          parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    `;
    const run = () => new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { moduleUrl, databasePath, input: planningInput(evaluation) },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const [first, second] = await Promise.all([run(), run()]);
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.deepEqual(first.result, second.result);
    const reopened = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(reopened.listGoalContinuationPlans(GOAL).length, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('lost response after durable commit is recovered by idempotent replay', async () => {
  const { directory, databasePath } = await tempDatabase('lia-planner-lost-response-');
  try {
    const seedStore = new ProjectTaskSqliteStore({ databasePath });
    seed(seedStore);
    seedStore.complete(ROOT, receipt);
    const evaluation = evaluate(seedStore);
    seedStore.close();

    const moduleUrl = new URL('../dist/services/projectTaskSqliteStore.js', import.meta.url).href;
    const workerSource = `
      const { workerData } = require('node:worker_threads');
      (async () => {
        const { ProjectTaskSqliteStore } = await import(workerData.moduleUrl);
        const store = new ProjectTaskSqliteStore({ databasePath: workerData.databasePath });
        store.createContinuationPlan(workerData.input);
        process.exit(23);
      })();
    `;
    const exitCode = await new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { moduleUrl, databasePath, input: planningInput(evaluation) },
      });
      worker.once('exit', resolve);
      worker.once('error', reject);
    });
    assert.equal(exitCode, 23);

    const reopened = new ProjectTaskSqliteStore({ databasePath });
    const recovered = reopened.createContinuationPlan(planningInput(evaluation));
    assert.deepEqual(reopened.readContinuationPlanBySourceEvaluation(evaluation.evaluationId), recovered);
    assert.equal(reopened.listGoalContinuationPlans(GOAL).length, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('identity is immutable in SQL, cancellation is one-way, and cancelled plans are unusable', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 100 });
    seed(store);
    store.complete(ROOT, receipt);
    const evaluation = evaluate(store);
    const plan = store.createContinuationPlan(planningInput(evaluation));
    const cancelled = store.cancelContinuationPlan(plan.planId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelledAt, 100);
    assert.deepEqual(store.cancelContinuationPlan(plan.planId), cancelled);
    assert.throws(() => store.assertContinuationPlanUsable(plan.planId), /not_usable/);
    store.close();

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    for (const [column, value] of [
      ['source_evaluation_id', 'c50e8400-e29b-41d4-a716-446655440099'],
      ['parent_attempt_number', 9],
      ['next_attempt_number', 9],
      ['next_continuation_depth', 9],
      ['instruction', 'Different bounded instruction.'],
      ['reason_code', 'retry_execution_failure'],
    ]) {
      assert.throws(
        () => database.prepare(`UPDATE project_goal_continuation_plans SET ${column} = ? WHERE plan_id = ?`).run(value, plan.planId),
        /project_goal_continuation_plan_immutable/,
      );
    }
    assert.throws(
      () => database.prepare("UPDATE project_goal_continuation_plans SET status = 'planned', cancelled_at = NULL WHERE plan_id = ?").run(plan.planId),
      /project_goal_continuation_plan_immutable/,
    );
    assert.throws(
      () => database.prepare('DELETE FROM project_goal_continuation_plans WHERE plan_id = ?').run(plan.planId),
      /project_goal_continuation_plan_immutable/,
    );
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('instruction and caller validation reject empty, oversized, forbidden and capability-injecting input', async () => {
  assert.equal(isSafeContinuationInstruction(''), false);
  assert.equal(isSafeContinuationInstruction('x'.repeat(2_001)), false);
  for (const instruction of ['deploy to production', 'push the result', 'run shell command', 'read /opt/private']) {
    assert.equal(isSafeContinuationInstruction(instruction), false);
  }
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seed(store, { objective: 'Deploy the result to production.' });
    store.complete(ROOT, receipt);
    const evaluation = evaluate(store);
    assert.throws(() => store.createContinuationPlan(planningInput(evaluation)), /invalid_project_goal_continuation_plan/);
    assert.throws(
      () => store.createContinuationPlan({ ...planningInput(evaluation), requestedCapabilities: ['local_commit'] }),
      /invalid_project_goal_continuation_plan/,
    );
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plan metadata grants no authority, does not enter Codex handoff, and starts no task/workflow', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seed(store);
    store.complete(ROOT, receipt);
    const evaluation = evaluate(store);
    const beforeAttempts = store.listGoalAttempts(GOAL);
    const plan = store.createContinuationPlan(planningInput(evaluation));
    for (const field of ['approvedCapabilities', 'effectiveCapabilities', 'requestedCapabilities', 'executor', 'command']) {
      assert.equal(field in plan, false);
    }
    assert.deepEqual(store.listGoalAttempts(GOAL), beforeAttempts);
    assert.equal(store.readGoal(GOAL).currentAttempt, 0);
    assert.equal(store.get(CHILD), undefined);
    store.close();

    const authoritySources = await Promise.all([
      '../src/services/projectTaskWorkflowService.ts',
      '../src/contracts/projectCodexHandoff.ts',
      '../src/services/projectCodexHandoff.ts',
      '../src/services/projectExecutionPlanner.ts',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
    for (const source of authoritySources) {
      for (const field of [
        'planId', 'sourceEvaluationId', 'parentAttemptNumber', 'nextAttemptNumber',
        'nextContinuationDepth', 'sourceEvidenceFingerprint',
      ]) assert.equal(source.includes(field), false);
    }
    assert.match(authoritySources[1], /effectiveCapabilities/);
    assert.match(authoritySources[2], /approvedCapabilities/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy V4 database migrates additively and legacy tasks remain unchanged', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    initializeProjectTaskSqliteDatabaseV1(databasePath);
    let store = new ProjectTaskSqliteStore({ databasePath });
    store.createOrGet(LEGACY, 'legacy-fingerprint', intent());
    store.close();

    const legacy = new DatabaseSync(databasePath);
    // Remove V9/V8/V7/V6 additive relations before reconstructing an authentic V4 fixture.
    legacy.exec(`
      DROP TABLE project_task_execution_runs;
      DROP TABLE project_task_dispatch_outbox;
      DROP TRIGGER project_task_lease_validate_insert;
      DROP TRIGGER project_task_lease_identity_immutable;
      DROP TRIGGER project_task_lease_expiry_monotonic;
      DROP TRIGGER project_task_lease_release_once;
      DROP TRIGGER project_task_lease_generation_immutable_delete;
      DROP TABLE project_task_lease_generations;
    `);
    legacy.exec('DROP TABLE project_goal_continuation_consumptions');
    const objects = legacy.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE tbl_name = 'project_goal_continuation_plans' OR name LIKE 'project_goal_continuation_plans_%'
    `).all();
    for (const object of objects.filter((item) => item.type === 'trigger')) legacy.exec(`DROP TRIGGER ${object.name}`);
    for (const object of objects.filter((item) => item.type === 'index' && !item.name.startsWith('sqlite_autoindex'))) legacy.exec(`DROP INDEX ${object.name}`);
    legacy.exec('DROP TABLE project_goal_continuation_plans');
    legacy.prepare('UPDATE project_task_meta SET schema_version = 4 WHERE singleton = 1').run();
    legacy.close();

    store = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(store.get(LEGACY).fingerprint, 'legacy-fingerprint');
    assert.equal(store.get(LEGACY).lineage, undefined);
    store.close();

    const migrated = new DatabaseSync(databasePath);
    assert.equal(migrated.prepare('SELECT schema_version FROM project_task_meta WHERE singleton = 1').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_goal_continuation_plans'").get());
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
