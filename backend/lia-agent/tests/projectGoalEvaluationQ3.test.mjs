import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CONTINUATION_PLANNER_VERSION } from '../dist/contracts/projectGoalContinuationPlan.js';
import { PROJECT_GOAL_EVALUATOR_VERSION } from '../dist/contracts/projectGoalEvaluation.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import {
  evaluateAndApplyGoalCompletion,
  buildProjectGoalVisibleSummary,
} from '../dist/services/projectGoalEvaluationOrchestrator.js';
import {
  createMechanicalGoalAssessor,
  createHermesReasoningGoalAssessor,
  sanitizeResultExcerpt,
} from '../dist/services/projectGoalSatisfactionAssessor.js';

const GOAL = '650e8400-e29b-41d4-a716-4466554400a1';
const TASK = '750e8400-e29b-41d4-a716-4466554400a1';

const OBJECTIVE = 'Implement and export a function capitalize(str) that uppercases only the first character and preserves the remaining characters.';

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Implement the requested bounded objective.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests', 'isolated_worktree_write', 'local_commit'],
  ...overrides,
});

const committedReceipt = (overrides = {}) => ({
  executionId: 'q3-execution-id',
  status: 'committed',
  resultText: 'Final verified result: 2/2 checks passed and local commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was created and validated.',
  verification: { status: 'verified', checksPassed: 2, totalChecks: 2 },
  commit: 'a'.repeat(40),
  stages: ['planning', 'hermes', 'codex', 'verification', 'visualQa', 'commit'],
  ...overrides,
});

const failure = (code = 'codex_execution_failed', overrides = {}) => ({
  code,
  message: SAFE_TASK_ERROR_MESSAGES[code],
  stage: code.startsWith('visual_') || code.startsWith('check_') ? 'verification' : 'codex',
  ...overrides,
});

// Deterministic mechanical classifier for the capitalize qualification fixture.
// It inspects the actual committed result excerpt (MQ2) and classifies the
// semantics honestly: whole-string uppercase is wrong; first-char-only with
// export is satisfied; first-char-only without export is partial.
const CORRECT_SOURCE = `function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }\nexport { capitalize };`;
const WRONG_SOURCE = `function capitalize(str) { return str.toUpperCase(); }\nexport { capitalize };`;
const PARTIAL_SOURCE = `function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }`;

function classifyCapitalize(goal, task, resultText, excerpt) {
  const source = excerpt !== undefined && excerpt.trim() !== '' ? excerpt : resultText;
  const firstCharOnly = /charAt\(0\)\.toUpperCase\(\)|\[0\]\.toUpperCase\(\)/.test(source);
  const preservesRest = /slice\(1\)|substring\(1\)|substr\(1\)/.test(source);
  const uppercasesWhole = /return\s+str\.toUpperCase\(\)/.test(source) && !preservesRest;
  const exported = /export\s*\{?\s*capitalize\s*\}?/.test(source);
  if (uppercasesWhole) {
    return { goalSatisfaction: 'not_demonstrated', blocking: 'none', failure: 'retryable' };
  }
  if (firstCharOnly && preservesRest && exported) {
    return { goalSatisfaction: 'satisfied', blocking: 'none', failure: 'retryable' };
  }
  if (firstCharOnly && preservesRest && !exported) {
    return { goalSatisfaction: 'partial', blocking: 'none', failure: 'retryable' };
  }
  return { goalSatisfaction: 'not_demonstrated', blocking: 'none', failure: 'retryable' };
}

async function tempDatabase(prefix = 'lia-q3-goal-eval-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seedGoal(store, options = {}) {
  const { objective = OBJECTIVE, maxAttempts = 3, continuationDepthLimit = 2, projectId = 'safe' } = options;
  store.createGoal({ goalId: GOAL, projectId, objective, maxAttempts, continuationDepthLimit });
  const created = store.createRootAttempt({
    taskId: TASK,
    fingerprint: 'q3-root-fingerprint',
    intent: intent({ projectId }),
    goalId: GOAL,
    continuationDepth: 0,
    attemptNumber: 0,
  });
  assert.equal(created.kind, 'created');
}

const excerptReader = (text) => async () => text;

test('Q3-01: genuinely satisfied goal is judged completed with a single evaluation and no plan', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const outcome = await evaluateAndApplyGoalCompletion(
      store,
      GOAL,
      { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(CORRECT_SOURCE) },
    );

    assert.equal(outcome.evaluation.decision, 'completed');
    assert.equal(outcome.evaluation.reasonCode, 'goal_satisfied');
    assert.equal(outcome.evaluation.evaluatorVersion, PROJECT_GOAL_EVALUATOR_VERSION);
    assert.ok(outcome.evaluation.appliedAt !== undefined);
    assert.equal(outcome.goal.status, 'completed');
    assert.equal(outcome.goal.terminalReason, 'objective_completed');
    assert.equal(store.listGoalEvaluations(GOAL).length, 1);
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
    assert.equal(store.listGoalAttempts(GOAL).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-02: pipeline completed but semantically wrong result is NOT satisfied', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const outcome = await evaluateAndApplyGoalCompletion(
      store,
      GOAL,
      { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(WRONG_SOURCE) },
    );

    assert.equal(outcome.evaluation.decision, 'retryable');
    assert.equal(outcome.evaluation.reasonCode, 'insufficient_evidence');
    assert.equal(outcome.goal.status, 'active');
    assert.notEqual(outcome.evaluation.decision, 'completed');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-03: tests pass but the user goal remains unsatisfied (partial)', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const outcome = await evaluateAndApplyGoalCompletion(
      store,
      GOAL,
      { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(PARTIAL_SOURCE) },
    );

    assert.equal(outcome.evaluation.decision, 'retryable');
    assert.equal(outcome.evaluation.reasonCode, 'partial_result');
    assert.equal(outcome.goal.status, 'active');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-04: retryable unsatisfied execution failure keeps the Goal active', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.fail(TASK, failure('codex_execution_failed'));

    const outcome = await evaluateAndApplyGoalCompletion(store, GOAL);

    assert.equal(outcome.evaluation.decision, 'retryable');
    assert.equal(outcome.evaluation.reasonCode, 'execution_failed');
    assert.equal(outcome.goal.status, 'active');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-05: terminal unrecoverable result fails the Goal and rejects any plan', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.fail(TASK, failure('codex_execution_failed'));

    const terminalAssessor = createMechanicalGoalAssessor(() => ({
      goalSatisfaction: 'not_demonstrated',
      blocking: 'none',
      failure: 'unrecoverable',
    }));
    const outcome = await evaluateAndApplyGoalCompletion(store, GOAL, { assessor: terminalAssessor });

    assert.equal(outcome.evaluation.decision, 'failed');
    assert.equal(outcome.evaluation.reasonCode, 'execution_failed');
    assert.equal(outcome.goal.status, 'failed');
    assert.equal(outcome.goal.terminalReason, 'unrecoverable_failure');

    assert.throws(
      () => store.createContinuationPlan({
        goalId: GOAL,
        sourceEvaluationId: outcome.evaluation.evaluationId,
        plannerVersion: CONTINUATION_PLANNER_VERSION,
        sourceEvidenceFingerprint: outcome.evaluation.evidenceFingerprint,
      }),
      /evaluation_not_retryable/,
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-06: indeterminate / insufficient evidence is downgraded to retryable', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    // Ready-for-review: no verification evidence in the receipt.
    store.complete(TASK, {
      executionId: 'q3-execution-id',
      status: 'ready_for_review',
      resultText: 'Analysis produced but not verified.',
      stages: ['planning', 'hermes', 'codex'],
    });

    const outcome = await evaluateAndApplyGoalCompletion(store, GOAL);

    assert.equal(outcome.evaluation.decision, 'retryable');
    assert.equal(outcome.evaluation.reasonCode, 'insufficient_evidence');
    assert.equal(outcome.goal.status, 'active');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // A garbage assessor output is treated as indeterminate, never as authority.
  const garbage = await tempDatabase('lia-q3-indeterminate-garbage-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath: garbage.databasePath });
    seedGoal(store);
    store.complete(TASK, committedReceipt());
    const garbageAssessor = () => ({ goalSatisfaction: 'satisfied', extra: 'capability_x', commands: ['rm -rf /'] });
    const outcome = await evaluateAndApplyGoalCompletion(store, GOAL, { assessor: garbageAssessor });
    assert.equal(outcome.evaluation.decision, 'retryable');
    assert.equal(outcome.evaluation.reasonCode, 'insufficient_evidence');
    assert.equal(outcome.goal.status, 'active');
    store.close();
  } finally {
    await rm(garbage.directory, { recursive: true, force: true });
  }
});

test('Q3-07: contradictory evidence fails closed and preserves the original record', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const satisfied = await evaluateAndApplyGoalCompletion(
      store,
      GOAL,
      { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(CORRECT_SOURCE) },
    );
    assert.equal(satisfied.evaluation.decision, 'completed');

    assert.throws(
      () => store.evaluateGoalAttempt({
        goalId: GOAL,
        taskId: TASK,
        attemptNumber: 0,
        evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
        evidence: { goalSatisfaction: 'not_demonstrated', blocking: 'none', failure: 'retryable' },
      }),
      /project_goal_evaluation_evidence_conflict/,
    );
    assert.equal(store.listGoalEvaluations(GOAL).length, 1);
    assert.equal(store.readLatestGoalEvaluation(GOAL).decision, 'completed');
    assert.equal(store.readGoal(GOAL).status, 'completed');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-08: exact replay is idempotent (same evaluation identity and result)', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const deps = { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(CORRECT_SOURCE) };
    const first = await evaluateAndApplyGoalCompletion(store, GOAL, deps);
    const second = await evaluateAndApplyGoalCompletion(store, GOAL, deps);

    assert.equal(second.evaluation.evaluationId, first.evaluation.evaluationId);
    assert.deepEqual(second.evaluation, first.evaluation);
    assert.equal(store.listGoalEvaluations(GOAL).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-09: restart preserves the same evaluation identity and result', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    seedGoal(first);
    first.complete(TASK, committedReceipt());
    const deps = { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(CORRECT_SOURCE) };
    const original = await evaluateAndApplyGoalCompletion(first, GOAL, deps);
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9999 });
    const replay = await evaluateAndApplyGoalCompletion(reopened, GOAL, deps);
    assert.equal(replay.evaluation.evaluationId, original.evaluation.evaluationId);
    assert.deepEqual(replay.evaluation, original.evaluation);
    assert.equal(replay.goal.status, 'completed');
    assert.equal(reopened.listGoalEvaluations(GOAL).length, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-10: Hermes advice cannot override the LÍA deterministic downgrade gate', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    // No verification evidence — the Hermes "satisfied" claim must be downgraded.
    store.complete(TASK, {
      executionId: 'q3-execution-id',
      status: 'ready_for_review',
      resultText: 'Hermes claims the work is done.',
      stages: ['planning', 'hermes', 'codex'],
    });

    const hermesAssessor = createHermesReasoningGoalAssessor(async () => ({
      ok: true,
      response: JSON.stringify({ goalSatisfaction: 'satisfied', blocking: 'none', failure: 'retryable' }),
    }));
    const outcome = await evaluateAndApplyGoalCompletion(store, GOAL, { assessor: hermesAssessor });

    assert.notEqual(outcome.evaluation.decision, 'completed');
    assert.equal(outcome.evaluation.reasonCode, 'insufficient_evidence');
    assert.equal(outcome.goal.status, 'active');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-11: Codex summary alone cannot override LÍA (result text is not satisfaction)', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    // Technically verified + committed, but the visible result is only a generic
    // Codex-style summary with no excerpt proving semantic match.
    store.complete(TASK, committedReceipt());

    const outcome = await evaluateAndApplyGoalCompletion(store, GOAL);

    assert.notEqual(outcome.evaluation.decision, 'completed');
    assert.equal(outcome.evaluation.reasonCode, 'insufficient_evidence');
    assert.equal(outcome.goal.status, 'active');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-12: completed status plus a satisfied claim without verification cannot produce satisfied', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    // completed with a verification block that did not fully pass.
    store.complete(TASK, committedReceipt({
      verification: { status: 'verified', checksPassed: 1, totalChecks: 2 },
    }));

    const eagerAssessor = createMechanicalGoalAssessor(() => ({
      goalSatisfaction: 'satisfied',
      blocking: 'none',
      failure: 'retryable',
    }));
    const outcome = await evaluateAndApplyGoalCompletion(store, GOAL, { assessor: eagerAssessor });

    assert.notEqual(outcome.evaluation.decision, 'completed');
    assert.equal(outcome.evaluation.reasonCode, 'verification_failed');
    assert.equal(outcome.goal.status, 'active');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-13: goal evaluation grants zero capability/authority expansion', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const before = store.get(TASK).intent.requestedCapabilities;
    const outcome = await evaluateAndApplyGoalCompletion(
      store,
      GOAL,
      { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(CORRECT_SOURCE) },
    );

    assert.deepEqual(store.get(TASK).intent.requestedCapabilities, before);
    assert.deepEqual(Object.keys(outcome.evidence).sort(), ['blocking', 'failure', 'goalSatisfaction']);
    assert.equal('approvedCapabilities' in outcome.evaluation, false);
    assert.equal('effectiveCapabilities' in outcome.evaluation, false);
    assert.equal('requestedCapabilities' in outcome.evaluation, false);
    assert.equal('commands' in outcome.visibleSummary, false);
    assert.equal('paths' in outcome.visibleSummary, false);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-14: bounded visible operator explanation excludes secrets and raw content', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const outcome = await evaluateAndApplyGoalCompletion(
      store,
      GOAL,
      { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(CORRECT_SOURCE) },
    );

    const summary = outcome.visibleSummary;
    assert.ok(summary.resultText.length <= 6000);
    assert.ok(summary.summary.length > 0 && summary.summary.length <= 500);
    assert.equal(typeof summary.decision, 'string');
    assert.equal(typeof summary.reasonCode, 'string');
    assert.equal(typeof summary.evidenceFingerprint, 'string');
    assert.equal(summary.goalId, GOAL);
    assert.equal(summary.taskId, TASK);
    assert.equal(summary.attemptNumber, 0);
    assert.equal(summary.evaluatorVersion, PROJECT_GOAL_EVALUATOR_VERSION);
    assert.equal(JSON.stringify(summary).includes(CORRECT_SOURCE), false);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-15: the raw result excerpt is never persisted', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const SECRET_MARKER = 'TOP_SECRET_FIXTURE_MARKER_9f8a7b6c5d4e3f21';
    const outcome = await evaluateAndApplyGoalCompletion(
      store,
      GOAL,
      {
        assessor: createMechanicalGoalAssessor(classifyCapitalize),
        readResultExcerpt: excerptReader(`${CORRECT_SOURCE}\n// ${SECRET_MARKER}`),
      },
    );
    store.close();

    assert.ok(outcome.evaluation.evidenceFingerprint !== undefined);
    const database = new DatabaseSync(databasePath);
    const rows = database.prepare(
      'SELECT evidence_fingerprint, decision, reason_code, summary FROM project_goal_evaluations',
    ).all();
    database.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].evidence_fingerprint.includes(SECRET_MARKER), false);
    assert.equal(JSON.stringify(rows).includes(SECRET_MARKER), false);
    assert.match(rows[0].evidence_fingerprint, /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-16: the continuation planner is NOT executed by Q3 (boundary defined, not crossed)', async () => {
  const { directory, databasePath } = await tempDatabase();
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store);
    store.complete(TASK, committedReceipt());

    const outcome = await evaluateAndApplyGoalCompletion(
      store,
      GOAL,
      { assessor: createMechanicalGoalAssessor(classifyCapitalize), readResultExcerpt: excerptReader(WRONG_SOURCE) },
    );

    assert.equal(outcome.evaluation.decision, 'retryable');
    assert.equal(outcome.goal.status, 'active');
    // Q3 stopped at the applied evaluation: no plan and no next task.
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
    assert.equal(store.listGoalAttempts(GOAL).length, 1);

    // The gate is defined but only opened by an explicit harness call, and the
    // resulting plan is left unconsumed (no materialization by Q3).
    const plan = store.createContinuationPlan({
      goalId: GOAL,
      sourceEvaluationId: outcome.evaluation.evaluationId,
      plannerVersion: CONTINUATION_PLANNER_VERSION,
      sourceEvidenceFingerprint: outcome.evaluation.evidenceFingerprint,
    });
    assert.equal(plan.status, 'planned');
    assert.equal(store.listGoalContinuationPlans(GOAL).length, 1);
    assert.equal(store.listGoalAttempts(GOAL).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-17: no capability, shell, network, or production channel is introduced', async () => {
  const assessorSource = await readFile(new URL('../src/services/projectGoalSatisfactionAssessor.ts', import.meta.url), 'utf8');
  const orchestratorSource = await readFile(new URL('../src/services/projectGoalEvaluationOrchestrator.ts', import.meta.url), 'utf8');
  for (const source of [assessorSource, orchestratorSource]) {
    assert.equal(source.includes("from 'node:child_process'"), false);
    assert.equal(source.includes("from 'node:http'"), false);
    assert.equal(source.includes("from 'node:https'"), false);
    assert.equal(source.includes("from 'node:net'"), false);
    assert.equal(source.includes("from 'node:dns'"), false);
    assert.equal(source.includes('spawn('), false);
    assert.equal(source.includes('exec('), false);
    assert.equal(/\bpush\b/.test(source), false);
    assert.equal(/\bmerge\b/.test(source), false);
    assert.equal(/\bdeploy\b/.test(source), false);
    assert.equal(/\bproduction_write\b/.test(source), false);
  }
});

test('Q3-18: visual-QA-required projects are downgraded when visual evidence is absent', async () => {
  const { directory, databasePath } = await tempDatabase('lia-q3-visual-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    seedGoal(store, { projectId: 'lia-hermes-mobile-preview' });
    store.complete(TASK, committedReceipt({ stages: ['planning', 'hermes', 'codex', 'verification'] }));

    const satisfiedAssessor = createMechanicalGoalAssessor(() => ({
      goalSatisfaction: 'satisfied',
      blocking: 'none',
      failure: 'retryable',
    }));
    const outcome = await evaluateAndApplyGoalCompletion(store, GOAL, { assessor: satisfiedAssessor });

    assert.notEqual(outcome.evaluation.decision, 'completed');
    assert.equal(outcome.evaluation.reasonCode, 'visual_verification_failed');
    assert.equal(outcome.goal.status, 'active');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Q3-19: bounded blocking classifications produce blocked with no continuation', async () => {
  for (const blocking of ['human_approval_required', 'forbidden_capability_required', 'external_dependency']) {
    const { directory, databasePath } = await tempDatabase(`lia-q3-blocked-${blocking}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      seedGoal(store);
      store.complete(TASK, committedReceipt());
      const blockingAssessor = createMechanicalGoalAssessor(() => ({
        goalSatisfaction: 'not_demonstrated',
        blocking,
        failure: 'retryable',
      }));
      const outcome = await evaluateAndApplyGoalCompletion(store, GOAL, { assessor: blockingAssessor });
      assert.equal(outcome.evaluation.decision, 'blocked');
      assert.equal(outcome.evaluation.reasonCode, blocking);
      assert.equal(outcome.goal.status, 'blocked');
      assert.equal(outcome.goal.terminalReason, 'human_intervention_required');
      assert.equal(store.listGoalContinuationPlans(GOAL).length, 0);
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('Q3-20: attempt/depth exhaustion terminalizes the Goal as exhausted', async () => {
  const cases = [
    [{ maxAttempts: 1, continuationDepthLimit: 2 }, 'attempt_budget_exhausted'],
    [{ maxAttempts: 3, continuationDepthLimit: 0 }, 'continuation_depth_exhausted'],
  ];
  for (const [limits, reason] of cases) {
    const { directory, databasePath } = await tempDatabase(`lia-q3-exhaust-${reason}-`);
    try {
      const store = new ProjectTaskSqliteStore({ databasePath });
      seedGoal(store, limits);
      store.fail(TASK, failure('codex_execution_failed'));
      const outcome = await evaluateAndApplyGoalCompletion(store, GOAL);
      assert.equal(outcome.evaluation.decision, 'failed');
      assert.equal(outcome.evaluation.reasonCode, reason);
      assert.equal(outcome.goal.status, 'exhausted');
      assert.equal(outcome.goal.terminalReason, 'attempt_limit_reached');
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('Q3-21: sanitizeResultExcerpt bounds and redacts without granting authority', () => {
  const dirty = 'ok line\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n' + 'x'.repeat(10000);
  const clean = sanitizeResultExcerpt(dirty, 500);
  assert.ok(clean.length <= 500);
  assert.equal(clean.includes('PRIVATE KEY'), false);
  assert.equal(clean.includes('BEGIN RSA'), false);
});

test('Q3-22: the reasoning-only Hermes assessor reuses the no-tools executor and falls back safely', async () => {
  const { createHermesReasoningOnlyGoalAssessor } = await import('../dist/services/projectGoalSatisfactionAssessor.js');
  // hermesExecutionEnabled=false short-circuits the reasoning-only executor
  // without spawning any process; the assessor must fall back conservatively.
  const assessor = createHermesReasoningOnlyGoalAssessor({ hermesExecutionEnabled: false });
  const evidence = await assessor({
    goal: { goalId: GOAL, projectId: 'safe', objective: OBJECTIVE, status: 'active', createdAt: 0, updatedAt: 0, currentAttempt: 0, maxAttempts: 3, continuationDepthLimit: 2 },
    task: { taskId: TASK, fingerprint: 'x', intent: intent(), status: 'completed', createdAt: 0, updatedAt: 0, receipt: committedReceipt() },
  });
  assert.deepEqual(evidence, { goalSatisfaction: 'not_demonstrated', blocking: 'none', failure: 'retryable' });
});
