import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { AUTONOMOUS_V1_CEILING, AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES } from '../dist/contracts/autonomousAuthority.js';
import {
  MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
  MAX_GOALS_PER_TICK,
} from '../dist/contracts/projectMultiGoalOrchestration.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { createMechanicalGoalAssessor } from '../dist/services/projectGoalSatisfactionAssessor.js';
import { materializeApprovedContinuation } from '../dist/services/projectGoalContinuationExecutionGate.js';
import { runLoopOnce } from '../dist/services/projectBoundedAutonomousLoopRuntime.js';
import {
  buildMultiGoalOrchestrationEvidence,
  countInFlightExternalExecutions,
  deriveGoalSchedulingOrder,
  reconcileMultiGoalOnce,
} from '../dist/services/projectMultiGoalAutonomousOrchestrator.js';

const OBJECTIVE = 'Deliver the remaining bounded surfaces and verify the result.';

/** Deterministic v4-shaped UUIDs (match the PROJECT_GOAL_ID / PROJECT_TASK_ID shape). */
const goalId = (n) => `d50e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;
const taskId = (n) => `e50e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;

const intent = (overrides = {}) => ({
  projectId: 'safe',
  instruction: 'Complete the bounded durable objective.',
  priority: 'high',
  requestedCapabilities: ['repository_read', 'run_tests'],
  ...overrides,
});

const failure = (code = 'codex_execution_failed', overrides = {}) => ({
  code,
  message: SAFE_TASK_ERROR_MESSAGES[code],
  stage: 'codex',
  ...overrides,
});

const workflowOk = {
  ok: true,
  projectId: 'safe',
  executionId: 'exec-safe',
  status: 'verified',
  executionSummary: 'hidden',
  resultText: 'Bounded verified result.',
  verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
};

const registry = {
  read: async () => [{
    projectId: 'safe',
    displayName: 'Safe Project',
    repositoryRoot: '/registry/safe',
    enabled: true,
  }],
};

const config = {
  host: '127.0.0.1',
  port: 3014,
  corsOrigins: [],
  agendaSqlitePath: '',
  projectTaskSqlitePath: '',
  projectRegistryPath: '',
  projectVerificationPath: '',
  hermesRoot: '',
  hermesExecutionEnabled: true,
  hermesExecutable: '/bin/hermes',
  hermesHome: '/hermes',
  hermesUser: 'hermes',
  hermesUserHome: '/home/hermes',
  hermesPath: '/bin',
  hermesProvider: 'fake',
  hermesModel: 'fake',
  hermesTimeoutMs: 100,
  hermesMaxQueryCharacters: 8000,
  logLevel: 'silent',
};

const notDemonstratedAssessor = createMechanicalGoalAssessor(() => ({
  goalSatisfaction: 'not_demonstrated',
  blocking: 'none',
  failure: 'retryable',
}));
const satisfiedAssessor = createMechanicalGoalAssessor(() => ({
  goalSatisfaction: 'satisfied',
  blocking: 'none',
  failure: 'retryable',
}));

function makeClock(start = 1000) {
  let value = start;
  const clock = () => value;
  clock.advance = (ms) => { value += ms; };
  clock.set = (next) => { value = next; };
  return clock;
}

async function tempDatabase(prefix = 'lia-mgoal-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seedGoal(store, n, options = {}) {
  const id = options.goalId ?? goalId(n);
  const root = options.taskId ?? taskId(n);
  store.createGoal({ goalId: id, projectId: 'safe', objective: OBJECTIVE, ...options });
  const created = store.createRootAttempt({
    taskId: root,
    fingerprint: `${root}-fingerprint`,
    intent: intent(),
    goalId: id,
    continuationDepth: 0,
    attemptNumber: 0,
  });
  assert.equal(created.kind, 'created');
  return { goalId: id, taskId: root };
}

const loopDeps = (overrides = {}) => ({ now: () => 1000, ...overrides });

const launchDeps = (overrides = {}) => ({
  workerId: 'lia-mgoal-test-worker',
  config,
  registry,
  now: () => 1000,
  executeWorkflow: async () => workflowOk,
  ...overrides,
});

const setMode = (store, goalIdValue, mode, overrides = {}) =>
  store.setGoalAutonomyPolicy({ goalId: goalIdValue, mode, approver: 'operator-1', ...overrides });

/** Drives one goal from a failed root attempt all the way to a materialized,
 * bounded_autonomous next attempt (stage `next_attempt_accepted`, eligible). */
async function driveToLaunchable(store, goalIdValue, options = {}) {
  await runLoopOnce(store, goalIdValue, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
  await runLoopOnce(store, goalIdValue, loopDeps()); // plan
  const plan = store.listGoalContinuationPlans(goalIdValue)[0];
  store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });
  await runLoopOnce(store, goalIdValue, loopDeps()); // materialize
  setMode(store, goalIdValue, 'bounded_autonomous', { maxCycles: 5, elapsedBudgetMs: 60_000 });
  return plan.planId;
}

/** Strips comments so static safety assertions only inspect real code. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function inspect(databasePath) {
  const database = new DatabaseSync(databasePath);
  const count = (table) => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const result = {
    evaluations: count('project_goal_evaluations'),
    plans: count('project_goal_continuation_plans'),
    tasks: count('project_tasks'),
    authorizations: count('project_goal_continuation_execution_authorizations'),
    launchAttempts: count('project_task_execution_launch_attempts'),
    launchResults: count('project_task_execution_launch_results'),
    invocations: count('project_task_execution_invocations'),
  };
  database.close();
  return result;
}

function crossLaunchBoundary(store, taskIdValue) {
  const dispatch = store.enqueueTaskDispatch(taskIdValue);
  const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'pre-worker', durationMs: 10_000 });
  const run = store.prepareTaskExecutionRun({
    dispatchId: dispatch.dispatchId,
    taskId: taskIdValue,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const invocation = store.reserveTaskExecutionInvocation({
    executionRunId: run.executionRunId,
    taskId: taskIdValue,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const attemptResult = store.beginTaskExecutionLaunchAttempt({
    invocationId: invocation.invocationId,
    executionRunId: run.executionRunId,
    taskId: taskIdValue,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  return { attempt: attemptResult.launchAttempt, run, invocation };
}

const ORCHESTRATOR_SOURCE = new URL('../src/services/projectMultiGoalAutonomousOrchestrator.ts', import.meta.url);
const CONTRACT_SOURCE = new URL('../src/contracts/projectMultiGoalOrchestration.ts', import.meta.url);

test('01: zero active goals -> empty bounded result, zero writes', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-zero-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const result = await reconcileMultiGoalOnce(store, loopDeps());
    assert.deepEqual(result.order, []);
    assert.deepEqual(result.results, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.evidence.activeGoalCount, 0);
    assert.equal(result.evidence.inspectedGoalCount, 0);
    assert.equal(result.evidence.selectedGoalCount, 0);
    assert.equal(result.evidence.externalExecutionSlotsUsed, 0);
    assert.equal(result.evidence.moreWorkRemains, false);
    const counts = inspect(databasePath);
    assert.equal(counts.evaluations, 0);
    assert.equal(counts.tasks, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('02: one active goal -> exactly one boundary (identical to runLoopOnce)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-one-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { goalId: g, taskId: t } = seedGoal(store, 1);
    store.fail(t, failure('codex_execution_failed'));

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.deepEqual(result.order, [g]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].goalId, g);
    assert.equal(result.results[0].stageBefore, 'task_terminal');
    assert.equal(result.results[0].action, 'evaluated');
    assert.equal(result.results[0].stageAfter, 'continuation_required');
    assert.equal(result.evidence.selectedGoalCount, 1);
    assert.equal(store.listGoalEvaluations(g).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('03: deterministic FIFO order (createdAt ASC, then goalId ASC)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-fifo-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(store, 1);           // createdAt 1000
    clock.advance(1000);
    const b = seedGoal(store, 2);           // createdAt 2000
    clock.advance(1000);
    const c = seedGoal(store, 3);           // createdAt 3000

    // Insert out of order: seedGoal above already created 1,2,3 in order; re-assert
    // deriveGoalSchedulingOrder yields pure createdAt ASC regardless of list order.
    const goals = store.listActiveGoals();
    const stages = new Map(goals.map((g) => [g.goalId, { stage: 'continuation_required' }]));
    const shuffled = [goals[2], goals[0], goals[1]];
    const order = deriveGoalSchedulingOrder(shuffled, stages);
    assert.deepEqual(order, [a.goalId, b.goalId, c.goalId]);

    // And reconcileMultiGoalOnce inspects in the same FIFO order.
    store.fail(a.taskId, failure());
    store.fail(b.taskId, failure());
    store.fail(c.taskId, failure());
    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.deepEqual(result.order, [a.goalId, b.goalId, c.goalId]);
    assert.deepEqual(result.results.map((r) => r.goalId), [a.goalId, b.goalId, c.goalId]);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('04: goalId tie-break when createdAt is identical', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-tie-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock, maxActive: 64, maxRecords: 256 });
    // Same clock -> identical createdAt; goalId decides the order.
    const low = seedGoal(store, 0x0b); // goalId ...-00b
    const high = seedGoal(store, 0x0a); // goalId ...-00a
    const goals = store.listActiveGoals();
    const stages = new Map(goals.map((g) => [g.goalId, { stage: 'continuation_required' }]));
    const order = deriveGoalSchedulingOrder(goals, stages);
    // goalId lexicographic: ...-00a < ...-00b, regardless of creation sequence.
    assert.deepEqual(order, [high.goalId, low.goalId]);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('05: at most MAX_GOALS_PER_TICK inspected per pass', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-max8-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const total = MAX_GOALS_PER_TICK + 3;
    const seeded = [];
    for (let n = 1; n <= total; n += 1) {
      const g = seedGoal(store, n);
      store.fail(g.taskId, failure());
      seeded.push(g);
    }

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(result.evidence.activeGoalCount, total);
    assert.equal(result.evidence.inspectedGoalCount, MAX_GOALS_PER_TICK);
    assert.equal(result.results.length, MAX_GOALS_PER_TICK);
    assert.equal(result.evidence.moreWorkRemains, true);

    // The inspected set is the FIFO head; the tail is untouched this pass.
    const inspectedIds = result.results.map((r) => r.goalId);
    const expectedHead = seeded.slice(0, MAX_GOALS_PER_TICK).map((g) => g.goalId);
    assert.deepEqual(inspectedIds, expectedHead);

    // Skipped tail goals lose no durable place: they were NOT evaluated.
    const tail = seeded.slice(MAX_GOALS_PER_TICK);
    for (const g of tail) {
      assert.equal(store.listGoalEvaluations(g.goalId).length, 0, `${g.goalId} not advanced this pass`);
    }

    // FIFO continues: pass 2 advances the head's NEXT boundary (plan), and the
    // tail is still behind the older goals (no unfair jump, no starvation).
    const second = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    const secondInspected = second.results.map((r) => r.goalId);
    assert.deepEqual(secondInspected, expectedHead);
    for (const r of second.results) {
      assert.equal(r.action, 'planned');
    }
    for (const g of tail) {
      assert.equal(store.listGoalEvaluations(g.goalId).length, 0);
    }

    // Pass 3: the head is now authorization_required (blocked on human), so the
    // tail — still advanceable — is finally reached. No goal is starved.
    const third = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.deepEqual(third.results.map((r) => r.goalId), tail.map((g) => g.goalId));
    for (const g of tail) {
      assert.equal(store.listGoalEvaluations(g.goalId).length, 1);
    }
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('06: external execution ceiling = 2 (3rd launchable goal skipped)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-ceil-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(store, 1);
    clock.advance(1000);
    const b = seedGoal(store, 2);
    clock.advance(1000);
    const c = seedGoal(store, 3);
    store.fail(a.taskId, failure());
    store.fail(b.taskId, failure());
    store.fail(c.taskId, failure());
    await driveToLaunchable(store, a.goalId);
    await driveToLaunchable(store, b.goalId);
    await driveToLaunchable(store, c.goalId);

    const launches = [];
    const result = await reconcileMultiGoalOnce(store, loopDeps({
      launch: launchDeps(),
      scheduleDecoupledLaunch: (launch) => { launches.push(launch); },
    }));

    assert.equal(result.evidence.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);
    assert.equal(result.evidence.externalExecutionSlotsUsed, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);
    assert.equal(launches.length, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);
    // The third launchable goal was skipped with the ceiling reason, not launched.
    const skippedCeiling = result.skipped.filter((s) => s.reason === 'concurrency_ceiling_reached');
    assert.equal(skippedCeiling.length, 1);
    assert.equal(skippedCeiling[0].goalId, c.goalId);

    // Two goals were launched; one was held back. Run the decoupled launches to
    // settle them, then confirm the held goal's task remains unexecuted.
    await Promise.all(launches.map((launch) => launch()));
    const materializedForC = store.listGoalAttempts(c.goalId).find((t) => t.status === 'accepted');
    assert.ok(materializedForC, 'held-back goal task is still accepted (never launched)');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('07: each selected goal advances at most one boundary', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-oneboundary-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const goals = [];
    for (let n = 1; n <= 4; n += 1) {
      const g = seedGoal(store, n);
      store.fail(g.taskId, failure());
      goals.push(g);
    }

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(result.results.length, 4);
    for (const r of result.results) {
      assert.equal(r.stageBefore, 'task_terminal');
      assert.equal(r.action, 'evaluated');
      assert.equal(r.stageAfter, 'continuation_required');
    }
    // No goal was planned in the same pass (one boundary only).
    for (const g of goals) {
      assert.equal(store.listGoalContinuationPlans(g.goalId).length, 0);
      assert.equal(store.listGoalEvaluations(g.goalId).length, 1);
    }
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('08: one corrupt/failing goal does not stop later goals', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-failisol-');
  try {
    const clock = makeClock(1000);
    const base = new ProjectTaskSqliteStore({ databasePath, now: clock, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(base, 1);
    clock.advance(1000);
    const bad = seedGoal(base, 2);
    clock.advance(1000);
    const c = seedGoal(base, 3);
    base.fail(a.taskId, failure());
    base.fail(bad.taskId, failure());
    base.fail(c.taskId, failure());

    // The middle goal's derivation throws -> isolated; A and C still advance.
    const store = new Proxy(base, {
      get(target, prop) {
        if (prop === 'listGoalAttempts') {
          return (g) => {
            if (g === bad.goalId) throw new Error('corrupt_project_task_record');
            return target.listGoalAttempts(g);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    const advancedIds = result.results.filter((r) => r.action === 'evaluated').map((r) => r.goalId);
    assert.deepEqual(advancedIds, [a.goalId, c.goalId]);
    assert.equal(result.evidence.isolatedFailureCount, 1);
    assert.equal(store.listGoalEvaluations(a.goalId).length, 1);
    assert.equal(store.listGoalEvaluations(c.goalId).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('09: corrupt goal is isolated with a safe bounded per-goal result', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-corrupt-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(base, 1);
    const bad = seedGoal(base, 2);
    base.fail(a.taskId, failure());
    base.fail(bad.taskId, failure());

    const store = new Proxy(base, {
      get(target, prop) {
        if (prop === 'readGoal') {
          return (g) => {
            if (g === bad.goalId) throw new Error('/secret/path and a raw error with spaces');
            return target.readGoal(g);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    // The corrupt goal is surfaced in `skipped` with a safe machine-code reason,
    // never the raw message (which contained a path + spaces).
    const badSkipped = result.skipped.find((s) => s.goalId === bad.goalId);
    assert.ok(badSkipped, 'corrupt goal appears in skipped');
    assert.equal(badSkipped.reason, 'loop_transition_failed');
    assert.ok(!JSON.stringify(result).includes('/secret/path'), 'no raw error internals leaked');
    // The healthy goal still advanced.
    assert.equal(store.listGoalEvaluations(a.goalId).length, 1);
    assert.equal(result.evidence.isolatedFailureCount, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('10: completed goal is skipped (not advanced)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-completed-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const done = seedGoal(store, 1);
    const active = seedGoal(store, 2);
    store.complete(done.taskId, {
      executionId: 'done-exec',
      status: 'verified',
      resultText: `Final result: ${OBJECTIVE}`,
      verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
      stages: ['planning', 'hermes', 'codex', 'verification'],
    });
    store.fail(active.taskId, failure());
    // Complete `done` via its own loop (satisfied assessor).
    await runLoopOnce(store, done.goalId, loopDeps({ assessor: satisfiedAssessor }));
    assert.equal(store.readGoal(done.goalId).status, 'completed');

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.ok(!result.order.includes(done.goalId), 'completed goal not in advanceable order');
    assert.ok(!result.results.some((r) => r.goalId === done.goalId));
    assert.equal(result.evidence.activeGoalCount, 1);
    assert.equal(store.listGoalEvaluations(active.goalId).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('11: failed goal is skipped (not advanced)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-failed-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const dead = seedGoal(store, 1);
    const active = seedGoal(store, 2);
    store.fail(dead.taskId, failure());
    store.fail(active.taskId, failure());
    store.transitionGoal(dead.goalId, 'failed', 'unrecoverable_failure');

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.ok(!result.order.includes(dead.goalId));
    assert.ok(!result.results.some((r) => r.goalId === dead.goalId));
    assert.equal(store.listGoalEvaluations(active.goalId).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('12: exhausted goal is skipped (not advanced)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-exhausted-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const done = seedGoal(store, 1);
    const active = seedGoal(store, 2);
    store.fail(done.taskId, failure());
    store.fail(active.taskId, failure());
    store.transitionGoal(done.goalId, 'exhausted', 'attempt_limit_reached');

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.ok(!result.order.includes(done.goalId));
    assert.ok(!result.results.some((r) => r.goalId === done.goalId));
    assert.equal(store.listGoalEvaluations(active.goalId).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('13: manual_only does not execute', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-manual-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, g.goalId, loopDeps());
    const plan = store.listGoalContinuationPlans(g.goalId)[0];
    store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });
    await runLoopOnce(store, g.goalId, loopDeps()); // materialize; manual_only by default

    let launched = false;
    const result = await reconcileMultiGoalOnce(store, loopDeps({
      launch: launchDeps(),
      scheduleDecoupledLaunch: () => { launched = true; },
    }));
    assert.equal(launched, false, 'no launch in manual_only');
    assert.ok(result.skipped.some((s) => s.goalId === g.goalId && s.reason === 'autonomy_manual_only'));
    const counts = inspect(databasePath);
    assert.equal(counts.launchAttempts, 0);
    assert.equal(counts.invocations, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('14: missing materialization approval remains gated (no auto-approval)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-gate-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, g.goalId, loopDeps()); // plan, NO approval

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    // Stage is authorization_required -> not advanceable; the plan stays `planned`.
    assert.ok(result.skipped.some((s) => s.goalId === g.goalId && s.reason === 'approval_required'));
    assert.equal(store.listGoalContinuationPlans(g.goalId)[0].status, 'planned');
    assert.equal(store.listGoalAttempts(g.goalId).length, 1, 'no materialization happened');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('15: duplicate wakeups converge (no double boundary write)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-dup-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());

    // An async assessor forces interleaving between two identical passes.
    const interleavingAssessor = createMechanicalGoalAssessor(() => ({
      goalSatisfaction: 'not_demonstrated',
      blocking: 'none',
      failure: 'retryable',
    }));
    const [ra, rb] = await Promise.all([
      reconcileMultiGoalOnce(store, loopDeps({ assessor: interleavingAssessor })),
      reconcileMultiGoalOnce(store, loopDeps({ assessor: interleavingAssessor })),
    ]);
    assert.equal(ra.evidence.selectedGoalCount, 1);
    assert.equal(rb.evidence.selectedGoalCount, 1);
    // Exactly one applied evaluation, never two.
    assert.equal(store.listGoalEvaluations(g.goalId).filter((e) => e.appliedAt !== undefined).length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('16: concurrent orchestration calls converge to one boundary per goal', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-concurrent-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(store, 1);
    const b = seedGoal(store, 2);
    store.fail(a.taskId, failure());
    store.fail(b.taskId, failure());

    const interleavingAssessor = createMechanicalGoalAssessor(() => ({
      goalSatisfaction: 'not_demonstrated',
      blocking: 'none',
      failure: 'retryable',
    }));
    await Promise.all([
      reconcileMultiGoalOnce(store, loopDeps({ assessor: interleavingAssessor })),
      reconcileMultiGoalOnce(store, loopDeps({ assessor: interleavingAssessor })),
    ]);
    // Each goal was evaluated exactly once, never twice.
    for (const g of [a, b]) {
      assert.equal(store.listGoalEvaluations(g.goalId).filter((e) => e.appliedAt !== undefined).length, 1);
    }
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('17: restart/reopen is stable (resumes at the exact boundary)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-restart-');
  let store;
  try {
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    // First pass: evaluate.
    const r1 = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(r1.results[0].action, 'evaluated');
    store.close();

    // Reopen from durable rows only.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const r2 = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    assert.equal(r2.results[0].stageBefore, 'continuation_required');
    assert.equal(r2.results[0].action, 'planned');
    assert.equal(store.listGoalEvaluations(g.goalId).filter((e) => e.appliedAt !== undefined).length, 1, 'no evaluation replay');
    assert.equal(store.listGoalContinuationPlans(g.goalId).length, 1);
    store.close();
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('18: unknown external launch outcome -> fail closed, never relaunch', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-unknown-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToLaunchable(store, g.goalId);
    const materializedTask = store.listGoalAttempts(g.goalId).find((t) => t.status === 'accepted');
    crossLaunchBoundary(store, materializedTask.taskId);

    let launched = false;
    const result = await reconcileMultiGoalOnce(store, loopDeps({
      launch: launchDeps(),
      scheduleDecoupledLaunch: () => { launched = true; },
    }));
    assert.equal(launched, false, 'never relaunch across an ambiguous boundary');
    assert.ok(result.skipped.some((s) => s.goalId === g.goalId && s.reason === 'external_launch_outcome_unknown'));
    assert.equal(inspect(databasePath).launchAttempts, 1, 'no second launch attempt');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('19: known launch result is never replayed', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-known-');
  try {
    let executions = 0;
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToLaunchable(store, g.goalId);

    const launches = [];
    const r1 = await reconcileMultiGoalOnce(store, loopDeps({
      launch: launchDeps({
        executeWorkflow: async () => { executions += 1; return workflowOk; },
      }),
      scheduleDecoupledLaunch: (launch) => { launches.push(launch); },
    }));
    assert.equal(r1.results[0].action, 'launched');
    await Promise.all(launches.map((launch) => launch()));
    assert.equal(executions, 1);

    // The launched task is now terminal; the next pass evaluates, never reruns.
    const r2 = await reconcileMultiGoalOnce(store, loopDeps({
      launch: launchDeps({ executeWorkflow: async () => { executions += 1; return workflowOk; } }),
      scheduleDecoupledLaunch: (launch) => { launches.push(launch); },
      assessor: satisfiedAssessor,
    }));
    assert.equal(executions, 1, 'executor ran exactly once');
    assert.ok(!r2.results.some((r) => r.action === 'launched'), 'no relaunch');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('20: no authority expansion (ceiling + forbidden set unchanged)', async () => {
  const source = stripComments(await readFile(ORCHESTRATOR_SOURCE, 'utf8'));
  const contract = stripComments(await readFile(CONTRACT_SOURCE, 'utf8'));
  const combined = `${source}\n${contract}`;
  const quoted = (word) => combined.includes(`'${word}'`) || combined.includes(`"${word}"`);
  for (const forbidden of ['push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access']) {
    assert.ok(!quoted(forbidden), `orchestrator must not grant '${forbidden}'`);
  }
  assert.ok(!combined.includes('child_process'));
  assert.ok(!combined.includes('spawn'));
  assert.ok(!combined.includes('exec('));
  assert.ok(!combined.includes('requestedCapabilities'), 'orchestrator never writes capabilities');
  assert.ok(!combined.includes('approvedCapabilities'));
  assert.deepEqual([...AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES].sort(), ['push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access'].sort());
  assert.deepEqual([...AUTONOMOUS_V1_CEILING].sort(), ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'].sort());
});

test('21: no task intent mutation by the orchestrator', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-intent-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToLaunchable(store, g.goalId);

    const rootIntent = store.get(g.taskId).intent;
    const materialized = store.listGoalAttempts(g.goalId).find((t) => t.taskId !== g.taskId);
    // Capabilities inherited exactly from the parent, never expanded or mutated.
    assert.deepEqual(materialized.intent.requestedCapabilities, rootIntent.requestedCapabilities);
    assert.equal(materialized.intent.projectId, rootIntent.projectId);

    const source = stripComments(await readFile(ORCHESTRATOR_SOURCE, 'utf8'));
    assert.ok(!/\.intent\s*=/.test(source), 'orchestrator never assigns a task intent');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('22: no second execution engine (only runLoopOnce + launchContinuationTaskIfEligible)', async () => {
  const source = stripComments(await readFile(ORCHESTRATOR_SOURCE, 'utf8'));
  assert.ok(!source.includes('runProjectTaskDurableExecution'), 'never calls the runner directly');
  assert.ok(!source.includes('projectTaskDurableExecutionRunner'));
  assert.ok(!source.includes('projectTaskWorkflowService'));
  assert.ok(!source.includes('hermesSupervisorExecutor'));
  assert.ok(!source.includes('projectCodexExecutor'));
  assert.ok(!source.includes('hermesExecutor'));
  assert.ok(!source.includes('child_process'));
  assert.ok(source.includes('launchContinuationTaskIfEligible'), 'the single authority path');
  assert.ok(source.includes('runLoopOnce'), 'reuses the existing durable runner');
});

test('23: no timer / busy loop / polling storm', async () => {
  const source = stripComments(await readFile(ORCHESTRATOR_SOURCE, 'utf8'));
  assert.ok(!/\bwhile\b/.test(source), 'no while loop');
  assert.ok(!/for\s*\(\s*;\s*;/.test(source), 'no infinite for loop');
  assert.ok(!source.includes('setInterval'));
  assert.ok(!source.includes('setTimeout'));
  // setImmediate is the sanctioned one-shot decoupling primitive (design §9.3),
  // mirroring the intake route — never a recurring timer.
  assert.ok(source.includes('setImmediate'));
});

test('24: operator evidence is bounded and safe', async () => {
  const { directory, databasePath } = await tempDatabase('lia-mgoal-evidence-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());

    const result = await reconcileMultiGoalOnce(store, loopDeps({ assessor: notDemonstratedAssessor }));
    const hud = buildMultiGoalOrchestrationEvidence(store, loopDeps());

    assert.equal(result.evidence.activeGoalCount, 1);
    assert.equal(hud.activeGoalCount, 1);
    assert.equal(hud.runnableGoalCount, 1);
    assert.equal(hud.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);
    assert.equal(hud.maxGoalsPerTick, MAX_GOALS_PER_TICK);
    assert.equal(typeof hud.inFlight, 'number');

    const serialized = JSON.stringify({ result, hud });
    for (const forbidden of ['command', 'commands', 'prompt', 'path', 'sessionId', 'capabilities', 'secret', 'credential', 'worktree', '/registry']) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `evidence must not expose ${forbidden}`);
    }
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('25: orchestrator is NOT wired into the server (inert by design)', async () => {
  const server = stripComments(await readFile(new URL('../src/server.ts', import.meta.url), 'utf8'));
  const app = stripComments(await readFile(new URL('../src/app.ts', import.meta.url), 'utf8'));
  for (const source of [server, app]) {
    assert.ok(!source.includes('reconcileMultiGoalOnce'), 'no server wiring of the orchestrator');
    assert.ok(!source.includes('projectMultiGoalAutonomousOrchestrator'));
  }
  const orchestrator = stripComments(await readFile(ORCHESTRATOR_SOURCE, 'utf8'));
  assert.ok(!orchestrator.includes('setInterval'));
  assert.ok(!orchestrator.includes('setTimeout'));
});
