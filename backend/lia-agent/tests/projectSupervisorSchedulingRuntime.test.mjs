import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { MAX_CONCURRENT_EXTERNAL_EXECUTIONS } from '../dist/contracts/projectMultiGoalOrchestration.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { InMemoryProjectTaskStore } from '../dist/services/inMemoryProjectTaskStore.js';
import { createMechanicalGoalAssessor } from '../dist/services/projectGoalSatisfactionAssessor.js';
import { runLoopOnce } from '../dist/services/projectBoundedAutonomousLoopRuntime.js';
import {
  createProjectSupervisorSchedulingRuntime,
  hasProjectGoalSurface,
} from '../dist/services/projectSupervisorSchedulingRuntime.js';

const OBJECTIVE = 'Deliver the bounded supervisor wiring and verify the result.';

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
  supervisorEnabled: true,
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

async function tempDatabase(prefix = 'lia-sup-') {
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

/** Drives one goal from a failed root attempt all the way to a materialized,
 * bounded_autonomous next attempt (stage `next_attempt_accepted`, eligible). */
async function driveToLaunchable(store, goalIdValue) {
  await runLoopOnce(store, goalIdValue, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
  await runLoopOnce(store, goalIdValue, loopDeps()); // plan
  const plan = store.listGoalContinuationPlans(goalIdValue)[0];
  store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });
  await runLoopOnce(store, goalIdValue, loopDeps()); // materialize
  store.setGoalAutonomyPolicy({
    goalId: goalIdValue,
    mode: 'bounded_autonomous',
    approver: 'operator-1',
    maxCycles: 5,
    elapsedBudgetMs: 60_000,
  });
  return plan.planId;
}

const setMode = (store, goalIdValue, mode, overrides = {}) =>
  store.setGoalAutonomyPolicy({ goalId: goalIdValue, mode, approver: 'operator-1', ...overrides });

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
  store.beginTaskExecutionLaunchAttempt({
    invocationId: invocation.invocationId,
    executionRunId: run.executionRunId,
    taskId: taskIdValue,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
}

/**
 * Deterministic drain control: the supervisor's coalescing drain is scheduled
 * through this queue instead of setImmediate, so tests can observe exactly how
 * many drains are pending and flush them one at a time.
 */
function makeImmediateQueue() {
  const queue = [];
  let executedDrains = 0;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const step = async () => {
    const fn = queue.shift();
    if (fn !== undefined) {
      executedDrains += 1; // one executed drain === one bounded pass
      fn();
    }
    await settle();
    await settle();
  };
  const drainAll = async () => {
    while (queue.length > 0) await step();
    await settle();
  };
  return {
    scheduleImmediate: (fn) => { queue.push(fn); },
    queued: () => queue.length,
    executed: () => executedDrains,
    step,
    drainAll,
  };
}

function makeSupervisor(store, overrides = {}) {
  return createProjectSupervisorSchedulingRuntime({
    store,
    config,
    registry,
    assessor: notDemonstratedAssessor,
    now: () => 1000,
    ...overrides,
  });
}

/** Counts passes by wrapping the durable read that exactly one pass performs. */
function countingStore(store) {
  let passes = 0;
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === 'listActiveGoals') {
        return (...args) => {
          passes += 1;
          return target.listActiveGoals(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: proxy, passes: () => passes };
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
    launchAttempts: count('project_task_execution_launch_attempts'),
    invocations: count('project_task_execution_invocations'),
  };
  database.close();
  return result;
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

const SERVICE_SOURCE = new URL('../src/services/projectSupervisorSchedulingRuntime.ts', import.meta.url);
const CONTRACT_SOURCE = new URL('../src/contracts/projectSupervisorSchedulingRuntime.ts', import.meta.url);
const ROUTER_SOURCE = new URL('../src/routes/projectSupervisor.ts', import.meta.url);
const SERVER_SOURCE = new URL('../src/server.ts', import.meta.url);
const APP_SOURCE = new URL('../src/app.ts', import.meta.url);

test('01: startup wakeup runs at most one bounded pass', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-startup-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const { goalId: g, taskId: t } = seedGoal(base, 1);
    base.fail(t, failure());
    const { store, passes } = countingStore(base);
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('startup');
    assert.equal(queue.queued(), 1, 'exactly one drain scheduled');
    await queue.drainAll();

    assert.equal(passes(), 1, 'exactly one bounded pass ran');
    assert.equal(supervisor.hud().lastPass.source, 'startup');
    assert.equal(supervisor.hud().lastPass.activeGoalCount, 1);
    assert.equal(store.listGoalEvaluations(g).filter((e) => e.appliedAt !== undefined).length, 1);
    assert.equal(supervisor.hud().state, 'idle', 'no follow-up chain after a non-truncated pass');
    base.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('02: duplicate startup wakeups coalesce into one pass', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-dupstart-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const { goalId: g, taskId: t } = seedGoal(base, 1);
    base.fail(t, failure());
    const { store, passes } = countingStore(base);
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('startup');
    supervisor.requestPass('startup');
    supervisor.requestPass('startup');
    assert.equal(queue.queued(), 1, 'duplicate startup wakeups converge to one drain');
    await queue.drainAll();

    assert.equal(passes(), 1, 'exactly one pass despite three wakeups');
    assert.equal(store.listGoalEvaluations(g).filter((e) => e.appliedAt !== undefined).length, 1, 'one boundary write only');
    base.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('03: two simultaneous terminal events coalesce into one pass', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-term-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const { goalId: g, taskId: t } = seedGoal(base, 1);
    base.fail(t, failure());
    const { store, passes } = countingStore(base);
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('terminalization');
    supervisor.requestPass('terminalization');
    assert.equal(queue.queued(), 1, 'two terminal events converge to one drain');
    await queue.drainAll();

    assert.equal(passes(), 1);
    assert.equal(supervisor.hud().lastPass.source, 'terminalization');
    assert.equal(store.listGoalEvaluations(g).filter((e) => e.appliedAt !== undefined).length, 1);
    base.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('04: pass already running => duplicate wakeups never start a concurrent pass', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-singleflight-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    for (let n = 1; n <= 3; n += 1) {
      const g = seedGoal(base, n);
      base.fail(g.taskId, failure());
    }
    const { store, passes } = countingStore(base);
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('startup');
    const first = queue.step(); // pass 1 starts; running=true synchronously
    // Three wakeups arrive while pass 1 is in flight.
    supervisor.requestPass('terminalization');
    supervisor.requestPass('terminalization');
    supervisor.requestPass('terminalization');
    assert.equal(queue.queued(), 0, 'no concurrent pass is scheduled while running');
    assert.equal(supervisor.hud().passInProgress, true);
    await first; // pass 1 settles; the wakeups converge into ONE follow-up drain

    assert.equal(queue.queued(), 1, 'exactly one follow-up drain, never three');
    await queue.drainAll();

    // Pass 1 evaluated all 3; the single follow-up pass planned all 3.
    assert.equal(queue.executed(), 2, 'exactly two passes total');
    assert.equal(base.listGoalEvaluations(goalId(1)).length, 1);
    assert.equal(base.listGoalContinuationPlans(goalId(1)).length, 1);
    assert.equal(base.listGoalContinuationPlans(goalId(2)).length, 1);
    assert.equal(base.listGoalContinuationPlans(goalId(3)).length, 1);
    base.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('05: operator trigger spam is bounded (409 while running, no queue growth)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-opspam-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const { goalId: g, taskId: t } = seedGoal(store, 1);
    store.fail(t, failure());
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    // Sequential spam: every pass is bounded and completes; nothing queues.
    for (let i = 0; i < 5; i += 1) {
      const outcome = await supervisor.triggerPass();
      assert.equal(outcome.ok, true, `sequential trigger ${i} succeeds`);
    }
    assert.equal(queue.queued(), 0, 'operator passes never accumulate in the drain queue');
    assert.equal(store.listGoalEvaluations(g).filter((e) => e.appliedAt !== undefined).length, 1, 'one boundary write across the spam');

    // Running spam: a trigger while a pass is in flight is refused, not queued.
    const pending = supervisor.triggerPass();
    const refused = await supervisor.triggerPass();
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'pass_in_progress');
    const first = await pending;
    assert.equal(first.ok, true);
    assert.equal(queue.queued(), 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('06: process dies before the scheduled drain => restart recovers from durable rows', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-restart-');
  try {
    // Process 1: seed durable work and request the startup wakeup, then die
    // before the coalesced drain ever executes.
    let store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const { goalId: g, taskId: t } = seedGoal(store, 1);
    store.fail(t, failure());
    const queue1 = makeImmediateQueue();
    const supervisor1 = makeSupervisor(store, { scheduleImmediate: queue1.scheduleImmediate });
    supervisor1.requestPass('startup');
    assert.equal(queue1.queued(), 1, 'startup wakeup pending');
    store.close(); // process exits; the queued drain never runs

    // Process 2: fresh supervisor over the same durable file. Recovery comes
    // from durable rows, never from an assumed surviving callback.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const queue2 = makeImmediateQueue();
    const supervisor2 = makeSupervisor(store, { scheduleImmediate: queue2.scheduleImmediate });
    assert.equal(supervisor2.hud().lastPass, undefined, 'no fabricated success from the dead process');
    assert.equal(supervisor2.hud().state, 'idle');

    supervisor2.requestPass('startup');
    await queue2.drainAll();
    assert.equal(supervisor2.hud().lastPass.source, 'startup');
    assert.equal(supervisor2.hud().lastPass.inspectedGoalCount, 1);
    assert.equal(store.listGoalEvaluations(g).filter((e) => e.appliedAt !== undefined).length, 1, 'exactly one boundary write after recovery');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('07: unknown external launch outcome => never retried by any pass', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-unknown-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToLaunchable(store, g.goalId);
    const materializedTask = store.listGoalAttempts(g.goalId).find((task) => task.status === 'accepted');
    crossLaunchBoundary(store, materializedTask.taskId);

    let launched = false;
    const supervisor = makeSupervisor(store, {
      scheduleDecoupledLaunch: () => { launched = true; },
      scheduleImmediate: (fn) => { fn(); },
    });
    const outcome = await supervisor.triggerPass();
    assert.equal(outcome.ok, true);
    assert.equal(launched, false, 'ambiguous launch is never retried');
    assert.ok(outcome.pass.skipped.some((s) => s.goalId === g.goalId && s.reason === 'external_launch_outcome_unknown'));
    assert.equal(inspect(databasePath).launchAttempts, 1, 'no second launch attempt');
    assert.equal(inspect(databasePath).invocations, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('08: capacity full => launch blocked; execution ceiling 2 preserved', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-ceiling-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(store, 1);
    const b = seedGoal(store, 2);
    const c = seedGoal(store, 3);
    store.fail(a.taskId, failure());
    store.fail(b.taskId, failure());
    store.fail(c.taskId, failure());
    await driveToLaunchable(store, a.goalId);
    await driveToLaunchable(store, b.goalId);
    await driveToLaunchable(store, c.goalId);

    const launches = [];
    const supervisor = makeSupervisor(store, { scheduleDecoupledLaunch: (launch) => { launches.push(launch); } });
    const outcome = await supervisor.triggerPass();

    assert.equal(outcome.ok, true);
    assert.equal(outcome.pass.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);
    assert.equal(outcome.pass.externalExecutionSlotsUsed, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);
    assert.equal(launches.length, MAX_CONCURRENT_EXTERNAL_EXECUTIONS, 'only the ceiling number of launches');
    assert.ok(outcome.pass.skipped.some((s) => s.goalId === c.goalId && s.reason === 'concurrency_ceiling_reached'));
    assert.equal(outcome.pass.truncated, false, 'ceilingSkipped alone never triggers auto follow-up');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('09: all goals human-blocked => zero execution, zero bypass', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-human-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    // Goal A: approved plan missing (authorization_required — human gate).
    const a = seedGoal(store, 1);
    store.fail(a.taskId, failure());
    await runLoopOnce(store, a.goalId, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    await runLoopOnce(store, a.goalId, loopDeps()); // plan, NO approval

    // Goal B: launchable but the autonomy policy is manual_only (default).
    const b = seedGoal(store, 2);
    store.fail(b.taskId, failure());
    await runLoopOnce(store, b.goalId, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
    await runLoopOnce(store, b.goalId, loopDeps()); // plan
    const planB = store.listGoalContinuationPlans(b.goalId)[0];
    store.approveContinuationPlan({ planId: planB.planId, approver: 'operator-1' });
    await runLoopOnce(store, b.goalId, loopDeps()); // materialize; manual_only by default

    const launches = [];
    const supervisor = makeSupervisor(store, { scheduleDecoupledLaunch: (launch) => { launches.push(launch); } });
    const outcome = await supervisor.triggerPass();

    assert.equal(outcome.ok, true);
    assert.equal(outcome.pass.externalExecutionSlotsUsed, 0, 'zero external executions');
    assert.equal(launches.length, 0);
    assert.ok(outcome.pass.skipped.some((s) => s.goalId === a.goalId && s.reason === 'approval_required'));
    assert.ok(outcome.pass.skipped.some((s) => s.goalId === b.goalId && s.reason === 'autonomy_manual_only'));
    const counts = inspect(databasePath);
    assert.equal(counts.launchAttempts, 0);
    assert.equal(counts.invocations, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('10: malformed one-goal state is isolated; unrelated goals still advance', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-isolated-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(base, 1);
    const bad = seedGoal(base, 2);
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

    const supervisor = makeSupervisor(store);
    const outcome = await supervisor.triggerPass();
    assert.equal(outcome.ok, true, 'one malformed goal cannot abort the pass');
    assert.equal(outcome.pass.isolatedFailureCount, 1);
    const advanced = outcome.pass.outcomes.filter((o) => o.action === 'evaluated').map((o) => o.goalId);
    assert.deepEqual(advanced, [a.goalId, c.goalId]);
    assert.equal(supervisor.hud().state, 'idle', 'per-goal isolation never latches the scheduler');
    base.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('11: scheduler callback throw => fail closed; auto-wakeups suppressed; operator clears on success', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-failclosed-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const { goalId: g, taskId: t } = seedGoal(base, 1);
    base.fail(t, failure());
    let thrown = false;
    const store = new Proxy(base, {
      get(target, prop) {
        if (prop === 'listActiveGoals') {
          return (...args) => {
            if (!thrown) {
              thrown = true;
              throw new Error('boom');
            }
            return target.listActiveGoals(...args);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('startup');
    await queue.drainAll();

    assert.equal(supervisor.hud().state, 'fail_closed');
    assert.equal(supervisor.hud().failClosed, true);
    assert.equal(supervisor.hud().lastFailureReason, 'boom', 'safe machine-code reason only');

    // Auto-wakeups are suppressed while latched.
    supervisor.requestPass('terminalization');
    supervisor.requestPass('terminalization');
    assert.equal(queue.queued(), 0, 'no auto-wakeup while fail-closed');
    assert.equal(supervisor.hud().pendingWakeup, false);

    // The operator trigger still runs; success clears the latch.
    const outcome = await supervisor.triggerPass();
    assert.equal(outcome.ok, true);
    assert.equal(supervisor.hud().state, 'idle');
    assert.equal(supervisor.hud().failClosed, false);
    assert.equal(supervisor.hud().lastPass.source, 'operator');
    assert.equal(base.listGoalEvaluations(g).filter((e) => e.appliedAt !== undefined).length, 1);
    base.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('12: policy suspended mid-state => no bypass, no launch', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-suspended-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToLaunchable(store, g.goalId);
    store.suspendGoalAutonomy(g.goalId); // durable operator pause

    let launched = false;
    const supervisor = makeSupervisor(store, {
      scheduleDecoupledLaunch: () => { launched = true; },
      scheduleImmediate: (fn) => { fn(); },
    });
    const outcome = await supervisor.triggerPass();
    assert.equal(outcome.ok, true);
    assert.equal(launched, false, 'suspended policy never launches');
    assert.ok(outcome.pass.skipped.some((s) => s.goalId === g.goalId && s.reason === 'autonomy_suspended'));
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('13: no active goals => safe no-op with zero follow-up chain', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-empty-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('startup');
    await queue.drainAll();

    assert.equal(supervisor.hud().lastPass.activeGoalCount, 0);
    assert.equal(supervisor.hud().lastPass.inspectedGoalCount, 0);
    assert.equal(supervisor.hud().lastPass.moreWorkRemains, false);
    assert.equal(supervisor.hud().lastPass.truncated, false);
    assert.equal(queue.queued(), 0, 'no follow-up chain from an empty pass');
    assert.equal(supervisor.hud().state, 'idle');
    assert.equal(inspect(databasePath).evaluations, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('14: goal terminalizes between wakeup and pass => safe convergence, never advanced', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-terminalize-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('startup'); // wakeup queued
    store.transitionGoal(g.goalId, 'exhausted', 'attempt_limit_reached'); // terminal before the pass runs
    await queue.drainAll();

    assert.equal(supervisor.hud().lastPass.activeGoalCount, 0, 'terminal goal not inspected');
    assert.equal(supervisor.hud().lastPass.selectedGoalCount, 0);
    assert.equal(store.listGoalEvaluations(g.goalId).length, 0, 'never advanced a terminal goal');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('15: shutdown while a pass is active => no fabricated success; restart converges', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-shutdown-');
  try {
    let store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const { goalId: g, taskId: t } = seedGoal(store, 1);
    store.fail(t, failure());
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('startup');
    const dying = queue.step(); // pass starts; the process is cut off before it settles
    await new Promise((resolve) => setImmediate(resolve));
    store.close(); // shutdown while the pass is active
    await dying.catch(() => {}); // the abandoned pass outcome is irrelevant

    // Restart: durable rows only. The new process has no fabricated summary.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const recovered = makeSupervisor(store, { scheduleImmediate: (fn) => { fn(); } });
    assert.equal(recovered.hud().lastPass, undefined, 'no fabricated success across restart');
    const outcome = await recovered.triggerPass();
    assert.equal(outcome.ok, true);
    const applied = store.listGoalEvaluations(g).filter((e) => e.appliedAt !== undefined);
    assert.equal(applied.length, 1, 'converges to exactly one applied evaluation');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('16: bounded truncation chain terminates (auto-follow-up only on truncation)', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-truncate-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const seeded = [];
    for (let n = 1; n <= 12; n += 1) {
      const g = seedGoal(store, n);
      store.fail(g.taskId, failure());
      seeded.push(g);
    }
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, { scheduleImmediate: queue.scheduleImmediate });

    supervisor.requestPass('startup');
    await queue.drainAll();

    // Pass 1 evaluates the FIFO head (8), pass 2 plans them (8), pass 3
    // evaluates the tail (4) — then the chain STOPS at the first non-truncated
    // pass. Zero-progress chaining is impossible; the durable tail waits for
    // the next event (terminalization / operator) instead of self-churning.
    assert.equal(queue.queued(), 0, 'the follow-up chain terminates');
    for (const g of seeded) {
      assert.equal(store.listGoalEvaluations(g.goalId).length, 1, `${g.goalId} evaluated exactly once`);
    }
    for (let n = 1; n <= 8; n += 1) {
      assert.equal(store.listGoalContinuationPlans(goalId(n)).length, 1, `${goalId(n)} planned exactly once`);
    }
    for (let n = 9; n <= 12; n += 1) {
      assert.equal(store.listGoalContinuationPlans(goalId(n)).length, 0, `${goalId(n)} not planned (no self-churn)`);
    }
    assert.equal(supervisor.hud().lastPass.truncated, false);
    assert.equal(supervisor.hud().state, 'idle');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('17: terminalization wakeup fires after a decoupled launch completes', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-followup-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToLaunchable(store, g.goalId);

    const launches = [];
    const queue = makeImmediateQueue();
    const supervisor = makeSupervisor(store, {
      scheduleDecoupledLaunch: (launch) => { launches.push(launch); },
      scheduleImmediate: queue.scheduleImmediate,
      executeWorkflow: async () => workflowOk,
    });

    const outcome = await supervisor.triggerPass();
    assert.equal(outcome.ok, true);
    assert.equal(launches.length, 1);
    assert.equal(outcome.pass.externalExecutionSlotsUsed, 1);
    assert.equal(queue.queued(), 0, 'no auto follow-up for a single non-truncated pass');

    // The decoupled launch completes -> terminalization wakeup -> one pass.
    await Promise.all(launches.map((launch) => launch()));
    assert.equal(queue.queued(), 1, 'terminalization requested exactly one follow-up pass');
    await queue.drainAll();
    assert.equal(supervisor.hud().lastPass.source, 'terminalization');
    assert.equal(supervisor.hud().lastPass.selectedGoalCount, 1, 'the terminal task advanced one boundary');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('18: unsupported store (no goal surface) => unsupported state, wakeups are no-ops', async () => {
  const memoryStore = new InMemoryProjectTaskStore();
  assert.equal(hasProjectGoalSurface(memoryStore), false, 'in-memory store has no goal surface');
  const queue = makeImmediateQueue();
  const supervisor = makeSupervisor(memoryStore, { scheduleImmediate: queue.scheduleImmediate });

  assert.equal(supervisor.hud().state, 'unsupported');
  assert.equal(supervisor.hud().supported, false);
  supervisor.requestPass('startup');
  supervisor.requestPass('terminalization');
  assert.equal(queue.queued(), 0, 'no drain is ever scheduled for an unsupported store');
  const outcome = await supervisor.triggerPass();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'supervisor_unsupported');
});

test('19: operator HTTP surface: HUD, bounded pass, deterministic failures', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-http-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const { goalId: g, taskId: t } = seedGoal(store, 1);
    store.fail(t, failure());

    // Without a runtime, the surface fails closed deterministically.
    await withServer(createApp(config, { projectTaskStore: store }), async (baseUrl) => {
      let response = await fetch(`${baseUrl}/api/projects/goals/supervisor`);
      assert.equal(response.status, 503);
      let body = await response.json();
      assert.equal(body.error, 'supervisor_unavailable');
      response = await fetch(`${baseUrl}/api/projects/goals/supervisor/pass`, { method: 'POST' });
      assert.equal(response.status, 503);
      body = await response.json();
      assert.equal(body.error, 'supervisor_unavailable');
    });

    const supervisor = makeSupervisor(store);
    await withServer(
      createApp(config, { projectTaskStore: store, projectSupervisorRuntime: supervisor }),
      async (baseUrl) => {
        let response = await fetch(`${baseUrl}/api/projects/goals/supervisor`);
        assert.equal(response.status, 200);
        let body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(body.supervisor.state, 'idle');
        assert.equal(body.supervisor.goals.activeGoalCount, 1);
        assert.equal(body.supervisor.goals.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);

        response = await fetch(`${baseUrl}/api/projects/goals/supervisor/pass`, { method: 'POST' });
        assert.equal(response.status, 200);
        body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(body.pass.inspectedGoalCount, 1);
        assert.equal(store.listGoalEvaluations(g).filter((e) => e.appliedAt !== undefined).length, 1);

        // Method guards.
        response = await fetch(`${baseUrl}/api/projects/goals/supervisor/pass`);
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'POST');
        response = await fetch(`${baseUrl}/api/projects/goals/supervisor`, { method: 'POST' });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'GET');
      },
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('20: operator HUD evidence is bounded and safe', async () => {
  const { directory, databasePath } = await tempDatabase('lia-sup-hud-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    const supervisor = makeSupervisor(store, { scheduleImmediate: (fn) => { fn(); } });
    await supervisor.triggerPass();

    const serialized = JSON.stringify(supervisor.hud());
    for (const forbidden of ['command', 'commands', 'prompt', 'sessionId', 'capabilities', 'secret', 'credential', 'worktree', 'provider', 'model', 'apiKey', 'token', 'hermes', '/registry']) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `HUD must not expose ${forbidden}`);
    }
    const hud = supervisor.hud();
    assert.equal(typeof hud.state, 'string');
    assert.equal(typeof hud.pendingWakeup, 'boolean');
    assert.equal(typeof hud.passInProgress, 'boolean');
    assert.equal(typeof hud.failClosed, 'boolean');
    assert.equal(typeof hud.goals.activeGoalCount, 'number');
    assert.equal(typeof hud.goals.executingGoalCount, 'number');
    assert.equal(typeof hud.goals.blockedOnHumanGoalCount, 'number');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('21: structural — no timer/cron/polling/busy-loop; no second engine; no authority expansion', async () => {
  const [service, contract, router] = await Promise.all([
    readFile(SERVICE_SOURCE, 'utf8'),
    readFile(CONTRACT_SOURCE, 'utf8'),
    readFile(ROUTER_SOURCE, 'utf8'),
  ]);
  const sources = [stripComments(service), stripComments(contract), stripComments(router)];
  for (const source of sources) {
    assert.ok(!source.includes('setInterval'), 'no periodic timer');
    assert.ok(!source.includes('setTimeout'), 'no one-shot timer');
    assert.ok(!source.includes('cron'), 'no cron');
    assert.ok(!source.includes('child_process'), 'no process authority');
    assert.ok(!source.includes('node:http') && !source.includes('node:https') && !source.includes('node:net') && !source.includes('node:dns'), 'no new network authority');
    assert.ok(!source.includes('.spawn(') && !source.includes('.exec('), 'no process invocation');
    assert.ok(!source.includes('runProjectTaskDurableExecution'), 'never calls the runner directly');
    assert.ok(!source.includes('projectTaskDurableExecutionRunner'));
    assert.ok(!source.includes('projectTaskWorkflowService'));
    assert.ok(!source.includes('hermesSupervisorExecutor'));
    assert.ok(!source.includes('projectCodexExecutor'));
    assert.ok(!source.includes('hermesExecutor'));
    assert.ok(!source.includes('requestedCapabilities'), 'never writes capabilities');
    assert.ok(!source.includes('approvedCapabilities'));
    for (const forbidden of ['push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access']) {
      assert.ok(!source.includes(forbidden), `must not grant '${forbidden}'`);
    }
  }
  // The single sanctioned scheduling primitive is the bounded coalesced drain.
  assert.ok(service.includes('setImmediate'), 'the only scheduling primitive is setImmediate');
  // The supervisor drives the ONE existing bounded pass and nothing else.
  assert.ok(service.includes('reconcileMultiGoalOnce'), 'reuses the existing bounded pass');
  assert.ok(!service.includes('while'), 'no busy loop');
  assert.ok(!service.includes('for ('), 'no loop of any kind');

  // Server wiring: startup wakeup strictly after durable recovery, before listen.
  const server = stripComments(await readFile(SERVER_SOURCE, 'utf8'));
  const recoverIndex = server.indexOf('reconcileProjectTasksAtStartup');
  const wakeupIndex = server.indexOf("requestPass('startup')");
  const listenIndex = server.indexOf('app.listen');
  assert.ok(recoverIndex !== -1 && wakeupIndex !== -1 && listenIndex !== -1);
  assert.ok(recoverIndex < wakeupIndex, 'startup wakeup strictly after durable recovery');
  assert.ok(wakeupIndex < listenIndex, 'startup wakeup strictly before listen');

  // app.ts mounts the operator surface through the supervisor service only.
  const app = stripComments(await readFile(APP_SOURCE, 'utf8'));
  assert.ok(app.includes('createProjectSupervisorRouter'), 'operator surface mounted');
  assert.ok(!app.includes('reconcileMultiGoalOnce'), 'app stays free of orchestrator identifiers');
  assert.ok(!app.includes('projectMultiGoalAutonomousOrchestrator'));
});
