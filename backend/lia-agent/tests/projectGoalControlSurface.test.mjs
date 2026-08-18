import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { MAX_CONCURRENT_EXTERNAL_EXECUTIONS } from '../dist/contracts/projectMultiGoalOrchestration.js';
import {
  PROJECT_GOAL_CONTROL_ERRORS,
  PROJECT_GOAL_CONTROL_INTEGRATION,
} from '../dist/contracts/projectOperatorGoalControl.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { createMechanicalGoalAssessor } from '../dist/services/projectGoalSatisfactionAssessor.js';
import { runLoopOnce } from '../dist/services/projectBoundedAutonomousLoopRuntime.js';
import { createProjectSupervisorSchedulingRuntime } from '../dist/services/projectSupervisorSchedulingRuntime.js';

/**
 * Operator Goal Control Surface — qualification matrix (design §O) against the
 * SQLite store + `createApp`, following `projectSupervisorSchedulingRuntime.test.mjs`
 * conventions. The control surface is exercised ONLY through the service/HTTP
 * surface; LÍA durable store primitives remain the sole authority underneath.
 */

const OBJECTIVE = 'Deliver the operator goal control surface and verify the result.';

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

/**
 * Workflow seam that never resolves: the durable intake runner crosses the
 * launch boundary and then waits forever, so the root attempt durably stays
 * `accepted` (never executed) for the whole test. No timer/handle is left
 * behind, so the process exits normally.
 */
const neverResolvingWorkflow = () => new Promise(() => {});

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

function makeClock(start = 1000) {
  let value = start;
  const clock = () => value;
  clock.advance = (ms) => { value += ms; };
  return clock;
}

async function tempDatabase(prefix = 'lia-gcs-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, databasePath: join(directory, 'tasks.sqlite') };
}

function seedGoal(store, n, options = {}) {
  const id = options.goalId ?? goalId(n);
  const root = options.taskId ?? taskId(n);
  const projectId = options.projectId ?? 'safe';
  const { goalId: _goalId, taskId: _taskId, projectId: _projectId, ...goalOptions } = options;
  store.createGoal({ goalId: id, projectId, objective: OBJECTIVE, ...goalOptions });
  const created = store.createRootAttempt({
    taskId: root,
    fingerprint: `${root}-fingerprint`,
    intent: intent({ projectId }),
    goalId: id,
    continuationDepth: 0,
    attemptNumber: 0,
  });
  assert.equal(created.kind, 'created');
  return { goalId: id, taskId: root };
}

const loopDeps = (overrides = {}) => ({ now: () => 1000, ...overrides });

/** Drives a goal to the human gate: applied retryable evaluation + `planned` plan (stage `authorization_required`). */
async function driveToApprovalRequired(store, goalIdValue) {
  await runLoopOnce(store, goalIdValue, loopDeps({ assessor: notDemonstratedAssessor })); // evaluate
  await runLoopOnce(store, goalIdValue, loopDeps()); // plan
  const plan = store.listGoalContinuationPlans(goalIdValue)[0];
  assert.ok(plan !== undefined, 'a continuation plan exists');
  assert.equal(plan.status, 'planned');
  return plan;
}

/** Drives a goal from a failed root attempt to a materialized, bounded_autonomous next attempt (stage `next_attempt_accepted`, eligible). */
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

function makeSupervisor(store, overrides = {}) {
  return createProjectSupervisorSchedulingRuntime({
    store,
    config,
    registry,
    assessor: notDemonstratedAssessor,
    now: () => 1000,
    scheduleImmediate: (fn) => { fn(); },
    ...overrides,
  });
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

/** Lets a bounded number of setImmediate rounds run (intake runner scheduling). */
const flushImmediates = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const post = (baseUrl, path, body) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});
const put = (baseUrl, path, body) => fetch(`${baseUrl}${path}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

/** Default control-surface app: sqlite store + authorized registry + never-executing intake seam. */
function controlApp(store, overrides = {}) {
  return createApp(config, {
    projectTaskStore: store,
    projectRegistrySource: registry,
    projectTasksWorkflowExecutor: neverResolvingWorkflow,
    // The read model must derive time-sensitive approval/authorization states
    // on the SAME clock as the store (the store is frozen at 1000 in these
    // fixtures; real Date.now would see every 7-day-TTL row as long expired).
    now: () => 1000,
    ...overrides,
  });
}

const ROUTER_SOURCE = new URL('../src/routes/projectGoalControl.ts', import.meta.url);
const CONTRACT_SOURCE = new URL('../src/contracts/projectOperatorGoalControl.ts', import.meta.url);
const SERVICE_SOURCE = new URL('../src/services/projectGoalControlService.ts', import.meta.url);
const READ_MODEL_SOURCE = new URL('../src/services/projectGoalControlReadModel.ts', import.meta.url);

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const createBody = (overrides = {}) => ({
  goalId: goalId(1),
  projectId: 'safe',
  objective: OBJECTIVE,
  priority: 'normal',
  requestedCapabilities: ['repository_read'],
  maxAttempts: 3,
  continuationDepthLimit: 2,
  ...overrides,
});

test('01: list zero goals => 200, empty goals, all counts zero', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-empty-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    await withServer(controlApp(store), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/goals`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.integration, PROJECT_GOAL_CONTROL_INTEGRATION);
      assert.deepEqual(body.goals, []);
      assert.equal(body.total, 0);
      assert.equal(body.activeCount, 0);
      assert.equal(body.terminalCount, 0);
      assert.equal(body.humanInterventionRequiredCount, 0);
      assert.equal(body.executingCount, 0);
      assert.equal(body.inFlight, 0);
      assert.equal(body.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('02: list multiple goals => deterministic order and derived per-goal fields', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-list-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(store, 1, { taskId: taskId(10) });
    clock.advance(100);
    const b = seedGoal(store, 2, { taskId: taskId(20) });
    clock.advance(100);
    const c = seedGoal(store, 3, { taskId: taskId(30) });
    store.fail(a.taskId, failure());
    store.transitionGoal(c.goalId, 'completed', 'objective_completed');

    await withServer(controlApp(store), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/goals`);
      assert.equal(response.status, 200);
      const body = await response.json();
      // Active first (a, b), then terminal (c); within each group created_at ASC.
      assert.deepEqual(body.goals.map((g) => g.goalId), [a.goalId, b.goalId, c.goalId]);
      assert.equal(body.activeCount, 2);
      assert.equal(body.terminalCount, 1);
      const item = body.goals[0];
      assert.equal(item.projectId, 'safe');
      assert.equal(item.title, OBJECTIVE);
      assert.equal(item.status, 'active');
      assert.equal(item.currentAttempt, 0);
      assert.equal(item.maxAttempts, 3);
      assert.equal(item.continuationDepth, 0);
      assert.equal(item.maxDepth, 2);
      assert.equal(item.autonomyMode, 'manual_only');
      assert.equal(item.suspensionState, 'manual_only');
      assert.equal(item.loopStage, 'task_terminal');
      assert.equal(item.hudState, 'waiting_human');
      assert.equal(item.humanInterventionRequired, false);
      assert.equal(item.currentTask.status, 'failed');
      assert.equal(item.noProgress.count, 0);
      assert.equal(item.budget.attemptsRemaining, 3);
      assert.equal(typeof item.nextSafeAction, 'string');
      assert.equal(typeof item.createdAt, 'number');
      assert.equal(typeof item.updatedAt, 'number');
      // The terminal goal maps to the completed HUD state.
      const terminal = body.goals[2];
      assert.equal(terminal.hudState, 'completed');
      assert.equal(terminal.nextSafeAction, 'none_terminal');
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('03: list filters — projectId, includeTerminal=false, limit, invalid filter', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-filter-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const a = seedGoal(store, 1, { projectId: 'safe' });
    // Second project: goal row AND root intent must share the projectId.
    const b = seedGoal(store, 2, { projectId: 'other' });
    store.fail(b.taskId, failure());
    store.transitionGoal(a.goalId, 'completed', 'objective_completed');

    await withServer(controlApp(store), async (baseUrl) => {
      let response = await fetch(`${baseUrl}/api/projects/goals?projectId=safe`);
      let body = await response.json();
      assert.deepEqual(body.goals.map((g) => g.goalId), [a.goalId]);

      response = await fetch(`${baseUrl}/api/projects/goals?includeTerminal=false`);
      body = await response.json();
      assert.deepEqual(body.goals.map((g) => g.goalId), [b.goalId]);

      response = await fetch(`${baseUrl}/api/projects/goals?limit=1`);
      body = await response.json();
      assert.equal(body.goals.length, 1);

      response = await fetch(`${baseUrl}/api/projects/goals?projectId=..%2Fetc`);
      assert.equal(response.status, 400);
      body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.invalidProjectFilter);
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('04: goal detail => full §B payload, durable evidence ids, safe whitelist', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-detail-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, g.goalId, loopDeps());
    const plan = store.listGoalContinuationPlans(g.goalId)[0];

    await withServer(controlApp(store), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/goals/${g.goalId}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.goalId, g.goalId);
      assert.equal(body.title, OBJECTIVE);
      assert.equal(body.status, 'active');
      assert.equal(body.loopStage, 'authorization_required');
      assert.equal(body.hudState, 'waiting_human');
      assert.equal(body.humanInterventionRequired, true);
      assert.equal(body.approvalState, 'approval_required');
      assert.equal(body.nextSafeAction, 'approve_materialization');
      assert.ok(Array.isArray(body.evaluationHistory) && body.evaluationHistory.length === 1);
      assert.equal(body.evaluationHistory[0].taskId, g.taskId);
      assert.equal(body.planHistory.length, 1);
      assert.equal(body.planHistory[0].planId, plan.planId);
      assert.equal(body.approvalCard.planId, plan.planId);
      assert.equal(body.approvalCard.nextAttemptNumber, 1);
      assert.equal(body.approvalCard.nextContinuationDepth, 1);
      assert.ok(typeof body.approvalEffect.approvalAuthorizes === 'string');
      assert.ok(typeof body.approvalEffect.launchRequirement === 'string');
      assert.equal(body.attempts.length, 1);
      assert.equal(body.attempts[0].status, 'failed');
      assert.equal(body.attempts[0].errorCode, failure().code);
      assert.equal(body.autonomy.mode, 'manual_only');
      assert.equal(body.budget.attemptsRemaining, 3);
      assert.equal(body.nextRequiredBoundary, 'authorization_required');
      // Every receipt fragment stays bounded: the full objective is truncated.
      assert.equal(body.title.length, OBJECTIVE.length);

      const serialized = JSON.stringify(body);
      for (const forbidden of ['sessionId', 'apiKey', 'secret', 'credential', 'worktree', 'repositoryRoot', 'prompt', 'rawOutput', 'provider', 'model', 'leaseId', 'fencingToken', 'capabilities']) {
        assert.ok(!serialized.includes(forbidden), `detail must not expose ${forbidden}`);
      }
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('05: create goal => 202, active, root attempt accepted and never executed, bounds echoed', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-create-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });

    await withServer(controlApp(store), async (baseUrl) => {
      const response = await post(baseUrl, '/api/projects/goals', createBody());
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.alreadyKnown, false);
      assert.equal(body.integration, PROJECT_GOAL_CONTROL_INTEGRATION);
      assert.equal(body.goal.status, 'active');
      assert.equal(body.goal.currentAttempt, 0);
      assert.equal(body.goal.loopStage, 'awaiting_execution');
      assert.equal(body.goal.maxAttempts, 3);
      assert.equal(body.goal.continuationDepthLimit, 2);
    });

    // The intake runner is scheduled (setImmediate), so the durable task row
    // must still be `accepted` — the control surface never executes anything.
    await flushImmediates();
    // The service mints the root taskId (randomUUID), so resolve it through
    // the durable lineage, never by guessing the id.
    const rootAttempt = store.listGoalAttempts(goalId(1))[0];
    assert.ok(rootAttempt !== undefined, 'root attempt row exists');
    assert.equal(rootAttempt.status, 'accepted', 'root attempt stays accepted; intake never executes');
    assert.equal(rootAttempt.lineage.attemptNumber, 0);
    assert.equal(store.readGoal(goalId(1)).currentAttempt, 0);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('06: duplicate create => 409 project_goal_already_exists, no second row', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-dupcreate-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    await withServer(controlApp(store), async (baseUrl) => {
      const first = await post(baseUrl, '/api/projects/goals', createBody());
      assert.equal(first.status, 202);
      const second = await post(baseUrl, '/api/projects/goals', createBody());
      assert.equal(second.status, 409);
      const body = await second.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, 'project_goal_already_exists');
      assert.equal(store.listGoals().length, 1);
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('07: malformed create => 400 invalid_goal / invalid_goal_id', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-malformed-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    await withServer(controlApp(store), async (baseUrl) => {
      const cases = [
        [{ ...createBody(), goalId: 'not-a-uuid' }, PROJECT_GOAL_CONTROL_ERRORS.invalidGoalId],
        [{ ...createBody(), objective: '   ' }, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal],
        [{ ...createBody(), maxAttempts: 6 }, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal],
        [{ ...createBody(), continuationDepthLimit: 5 }, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal],
        [{ ...createBody(), requestedCapabilities: ['push'] }, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal],
        [{ ...createBody(), priority: 'urgent' }, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal],
        [{ ...createBody(), projectId: '../etc' }, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal],
      ];
      for (const [payload, expected] of cases) {
        const response = await post(baseUrl, '/api/projects/goals', payload);
        assert.equal(response.status, 400, JSON.stringify(payload));
        const body = await response.json();
        assert.equal(body.error, expected);
      }
      assert.equal(store.listGoals().length, 0, 'nothing was created by malformed requests');
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('08: autonomy mode control — initial-set, read, one-shot contradiction, suspended rejected', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-autonomy-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    await withServer(controlApp(store), async (baseUrl) => {
      let response = await fetch(`${baseUrl}/api/projects/goals/${g.goalId}/autonomy`);
      let body = await response.json();
      assert.equal(body.mode, 'manual_only');
      assert.equal(body.policyState, 'manual_only');

      response = await put(baseUrl, `/api/projects/goals/${g.goalId}/autonomy`, {
        mode: 'approved_single_step',
        approver: 'operator-1',
      });
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.mode, 'approved_single_step');
      assert.equal(body.policyState, 'approved_single_step');
      assert.equal(body.approver, 'operator-1');

      // One-shot: any meaning change is durably contradictory.
      response = await put(baseUrl, `/api/projects/goals/${g.goalId}/autonomy`, {
        mode: 'bounded_autonomous',
        approver: 'operator-1',
      });
      assert.equal(response.status, 409);
      body = await response.json();
      assert.equal(body.error, 'project_goal_autonomy_policy_contradictory');

      // `suspended` is a derived state, never a settable mode.
      response = await put(baseUrl, `/api/projects/goals/${g.goalId}/autonomy`, {
        mode: 'suspended',
        approver: 'operator-1',
      });
      assert.equal(response.status, 400);
      body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.invalidAutonomy);
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('09: suspend => durable suspended_at, derived suspended, no launch; double suspend idempotent', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-suspend-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToLaunchable(store, g.goalId);

    let launched = false;
    const supervisor = makeSupervisor(store, {
      scheduleDecoupledLaunch: () => { launched = true; },
    });
    await withServer(controlApp(store, { projectSupervisorRuntime: supervisor }), async (baseUrl) => {
      let response = await post(baseUrl, `/api/projects/goals/${g.goalId}/suspend`);
      assert.equal(response.status, 200);
      let body = await response.json();
      assert.equal(body.policyState, 'suspended');
      assert.ok(typeof body.suspendedAt === 'number');

      // Double suspend: same durable outcome, alreadyKnown.
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/suspend`);
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.alreadyKnown, true);

      response = await fetch(`${baseUrl}/api/projects/goals/${g.goalId}`);
      body = await response.json();
      assert.equal(body.loopStage, 'suspended');
      assert.equal(body.hudState, 'suspended');
      assert.equal(body.nextSafeAction, 'resume');
    });

    // A supervisor pass while suspended never launches.
    const outcome = await supervisor.triggerPass();
    assert.equal(outcome.ok, true);
    assert.equal(launched, false, 'suspended goal never launches');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('10: resume => cleared suspension, derived stage recovers; resume without suspension => 409', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-resume-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.setGoalAutonomyPolicy({ goalId: g.goalId, mode: 'bounded_autonomous', approver: 'operator-1' });
    store.suspendGoalAutonomy(g.goalId);

    await withServer(controlApp(store), async (baseUrl) => {
      let response = await post(baseUrl, `/api/projects/goals/${g.goalId}/resume`);
      assert.equal(response.status, 200);
      let body = await response.json();
      assert.equal(body.policyState, 'bounded_autonomous');
      assert.equal(body.suspendedAt, undefined);

      // Resume again without a suspension: durably not resumable.
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/resume`);
      assert.equal(response.status, 409);
      body = await response.json();
      assert.equal(body.error, 'project_goal_autonomy_policy_not_resumable');
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('11: continuation approve — exact plan, duplicate idempotent, contradictory 409', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-approve-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    const plan = await driveToApprovalRequired(store, g.goalId);

    await withServer(controlApp(store), async (baseUrl) => {
      let response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/approve`, { approver: 'operator-1' });
      assert.equal(response.status, 200);
      let body = await response.json();
      assert.equal(body.approval.planId, plan.planId);
      assert.equal(body.approval.approver, 'operator-1');
      const approvalRow = store.readContinuationApproval(plan.planId);
      assert.equal(approvalRow.approvalId, body.approval.approvalId);
      assert.equal(approvalRow.planFingerprint, plan.fingerprint, 'approval binds the exact plan fingerprint');

      // Exact replay: idempotent, alreadyKnown.
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/approve`, { approver: 'operator-1' });
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.alreadyKnown, true);

      // Different approver: contradictory, no second row.
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/approve`, { approver: 'operator-2' });
      assert.equal(response.status, 409);
      body = await response.json();
      assert.equal(body.error, 'project_goal_continuation_approval_contradictory');
      assert.equal(store.listGoalContinuationPlans(g.goalId).length, 1);

      // Approval present => the next pass may materialize (stage moves on).
      await runLoopOnce(store, g.goalId, loopDeps());
      response = await fetch(`${baseUrl}/api/projects/goals/${g.goalId}`);
      body = await response.json();
      assert.equal(body.loopStage, 'next_attempt_accepted');
      assert.equal(body.approvalState, 'approval_consumed');
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('12: continuation refuse — durable cancellation; approve-after-refuse conflict', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-refuse-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToApprovalRequired(store, g.goalId);

    await withServer(controlApp(store), async (baseUrl) => {
      let response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/refuse`);
      assert.equal(response.status, 200);
      let body = await response.json();
      assert.equal(body.plan.status, 'cancelled');
      assert.equal(store.listGoalContinuationPlans(g.goalId)[0].status, 'cancelled');

      // The derived stage fails closed with a safe reason; no un-cancel exists.
      response = await fetch(`${baseUrl}/api/projects/goals/${g.goalId}`);
      body = await response.json();
      assert.equal(body.loopStage, 'failed_closed');
      assert.equal(body.hudState, 'fail_closed');
      assert.equal(body.blockingReason, 'plan_cancelled');
      assert.equal(body.humanInterventionRequired, true);
      assert.equal(body.nextSafeAction, 'manual_review_required');

      // Approving a cancelled plan is a conflict, never a silent override.
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/approve`, { approver: 'operator-1' });
      assert.equal(response.status, 409);
      body = await response.json();
      assert.ok(typeof body.error === 'string');
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('13: human gates — approval card, eligibility and authorization states, no bypass', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-gates-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToApprovalRequired(store, g.goalId);
    store.approveContinuationPlan({ planId: store.listGoalContinuationPlans(g.goalId)[0].planId, approver: 'operator-1' });
    await runLoopOnce(store, g.goalId, loopDeps()); // materialize
    store.setGoalAutonomyPolicy({ goalId: g.goalId, mode: 'approved_single_step', approver: 'operator-1' });

    await withServer(controlApp(store), async (baseUrl) => {
      // Materialized next task without an execution authorization: human gate.
      let response = await fetch(`${baseUrl}/api/projects/goals/${g.goalId}/continuation`);
      let body = await response.json();
      assert.equal(body.launchState, 'not_launched');
      assert.equal(body.authorization.state, 'authorization_required');
      assert.equal(body.eligibility.eligible, false);
      assert.equal(body.nextTaskExecuted, false);

      // The human gate appears in the detail too.
      response = await fetch(`${baseUrl}/api/projects/goals/${g.goalId}`);
      body = await response.json();
      assert.equal(body.humanInterventionRequired, true);
      assert.equal(body.authorizationState, 'authorization_required');
      // The eligibility reason is the repository's authoritative vocabulary
      // (E14: approved_single_step with no execution authorization yet).
      assert.equal(body.eligibility.reason, 'autonomy_authorization_required');

      // Authorize the exact materialized task.
      const nextTask = store.listGoalAttempts(g.goalId).find((t) => t.status === 'accepted');
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/execution/authorize`, { approver: 'operator-1' });
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.authorization.taskId, nextTask.taskId);

      // Exact replay idempotent.
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/execution/authorize`, { approver: 'operator-1' });
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.alreadyKnown, true);

      // Now eligible: the gate is closed only by the durable authorization.
      response = await fetch(`${baseUrl}/api/projects/goals/${g.goalId}/continuation`);
      body = await response.json();
      assert.equal(body.authorization.state, 'authorization_present');
      assert.equal(body.eligibility.eligible, true);
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('14: operator pass — one bounded pass, launch scheduled exactly once, ceiling preserved', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-pass-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToLaunchable(store, g.goalId);

    const launches = [];
    const supervisor = makeSupervisor(store, {
      scheduleDecoupledLaunch: (launch) => { launches.push(launch); },
    });
    await withServer(controlApp(store, { projectSupervisorRuntime: supervisor }), async (baseUrl) => {
      let response = await fetch(`${baseUrl}/api/projects/goals/supervisor`);
      assert.equal(response.status, 200);
      let body = await response.json();
      assert.equal(body.supervisor.goals.activeGoalCount, 1);
      assert.equal(body.supervisor.goals.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);

      response = await post(baseUrl, '/api/projects/goals/supervisor/pass');
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.pass.externalExecutionSlotsUsed, 1);
      assert.equal(body.pass.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS);
      assert.equal(body.pass.activeGoalCount, 1);
      assert.equal(body.pass.moreWorkRemains, false);
      assert.equal(body.pass.truncated, false);
    });
    assert.equal(launches.length, 1, 'exactly one launch through the ONE existing orchestrator');

    // The pass is single-flight: a trigger while running is refused, never queued.
    const pending = supervisor.triggerPass();
    const refused = await supervisor.triggerPass();
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'pass_in_progress');
    await pending;
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('15: idempotency across the surface — suspend, approve, authorize, duplicate create', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-idem-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToApprovalRequired(store, g.goalId);
    // Suspend requires a governing autonomy policy row (service precondition).
    store.setGoalAutonomyPolicy({ goalId: g.goalId, mode: 'approved_single_step', approver: 'operator-1' });

    await withServer(controlApp(store), async (baseUrl) => {
      // suspend twice
      await post(baseUrl, `/api/projects/goals/${g.goalId}/suspend`);
      let response = await post(baseUrl, `/api/projects/goals/${g.goalId}/suspend`);
      let body = await response.json();
      assert.equal(body.alreadyKnown, true, 'double suspend is idempotent');
      await post(baseUrl, `/api/projects/goals/${g.goalId}/resume`);

      // approve twice (same approver)
      await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/approve`, { approver: 'operator-1' });
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/approve`, { approver: 'operator-1' });
      body = await response.json();
      assert.equal(body.alreadyKnown, true, 'double approval is idempotent');

      // Refusal is a one-shot durable transition: the first call cancels the
      // plan; a second refuse is a stage mismatch (the surface is fail-closed,
      // there is no un-cancel). The store primitive stays replay-safe.
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/refuse`);
      assert.equal(response.status, 200);
      assert.equal(store.listGoalContinuationPlans(g.goalId)[0].status, 'cancelled');
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/refuse`);
      assert.equal(response.status, 409);
      body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.stageMismatch);
      assert.equal(store.listGoalContinuationPlans(g.goalId)[0].status, 'cancelled', 'no un-cancel exists');

      // duplicate create goal
      await post(baseUrl, '/api/projects/goals', createBody({ goalId: goalId(9) }));
      response = await post(baseUrl, '/api/projects/goals', createBody({ goalId: goalId(9) }));
      assert.equal(response.status, 409);
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('16: conflict 409 vocabulary — stage mismatch and terminal goal mutations', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-conflict-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    await withServer(controlApp(store), async (baseUrl) => {
      // No planned plan exists => approve/refuse are stage mismatches, never silent.
      let response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/approve`, { approver: 'operator-1' });
      assert.equal(response.status, 409);
      let body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.stageMismatch);

      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/continuation/refuse`);
      assert.equal(response.status, 409);
      body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.stageMismatch);

      // Suspension refuses approve/authorize at the surface guard.
      store.setGoalAutonomyPolicy({ goalId: g.goalId, mode: 'approved_single_step', approver: 'operator-1' });
      store.suspendGoalAutonomy(g.goalId);
      response = await post(baseUrl, `/api/projects/goals/${g.goalId}/suspend`);
      assert.equal(response.status, 200);

      // Terminal goal: mutations fail closed.
      store.resumeGoalAutonomy(g.goalId);
      store.transitionGoal(g.goalId, 'completed', 'objective_completed');
      response = await put(baseUrl, `/api/projects/goals/${g.goalId}/autonomy`, {
        mode: 'bounded_autonomous',
        approver: 'operator-1',
      });
      assert.equal(response.status, 409);
      body = await response.json();
      assert.equal(body.error, 'project_goal_terminal');
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('17: capacity exhaustion => 503 taskCapacityReached and no partial goal row', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-capacity-');
  try {
    // maxActive 1: the pre-seeded active root task fills the durable ceiling.
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 1, maxRecords: 4 });
    const existing = seedGoal(store, 1, { goalId: goalId(8), taskId: taskId(8) });
    assert.equal(store.readGoal(existing.goalId).status, 'active');

    await withServer(controlApp(store), async (baseUrl) => {
      const response = await post(baseUrl, '/api/projects/goals', createBody());
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.taskCapacityReached);
    });
    // Atomic intake: the failed goal row was rolled back, no orphan goal.
    assert.equal(store.readGoal(goalId(1)), undefined, 'no partial goal without its root attempt');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('18: no-progress escalation => failed_closed, no new plan, terminal derived', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-noprog-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock, assessor: notDemonstratedAssessor })); // eval 1 (count 1)
    clock.advance(1000);
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock })); // plan 1
    const plan = store.listGoalContinuationPlans(g.goalId)[0];
    store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock })); // materialize
    const next = store.listGoalAttempts(g.goalId).find((t) => t.status === 'accepted');
    store.fail(next.taskId, failure()); // same no-progress signature
    clock.advance(1000);
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock, assessor: notDemonstratedAssessor })); // eval 2 (count 2)
    const escalated = await runLoopOnce(store, g.goalId, loopDeps({ now: clock })); // planning gate

    assert.equal(escalated.blockingReason, 'no_progress_escalation');
    assert.equal(escalated.humanInterventionRequired, true);
    assert.equal(store.listGoalContinuationPlans(g.goalId).length, 1, 'no second plan is ever written');

    const service = (await import('../dist/services/projectGoalControlService.js')).createProjectGoalControlService({
      store,
      config,
      registry,
      executeWorkflow: neverResolvingWorkflow,
    });
    const detail = service.getGoalDetail(g.goalId);
    assert.equal(detail.ok, true);
    assert.equal(detail.payload.loopStage, 'failed_closed');
    assert.equal(detail.payload.blockingReason, 'no_progress_escalation');
    assert.equal(detail.payload.hudState, 'fail_closed');
    assert.equal(detail.payload.noProgress.count, 2);
    assert.equal(detail.payload.noProgress.escalated, true);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('19: attempt exhaustion => goal terminalizes exhausted; HUD failed, no launch', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-exhaust-');
  try {
    const clock = makeClock(1000);
    const store = new ProjectTaskSqliteStore({ databasePath, now: clock, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1, { maxAttempts: 2 });
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock, assessor: notDemonstratedAssessor })); // eval retryable (attempt 0)
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock })); // plan (attempt 1)
    const plan = store.listGoalContinuationPlans(g.goalId)[0];
    store.approveContinuationPlan({ planId: plan.planId, approver: 'operator-1' });
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock }));
    // Second attempt at attemptNumber 1 == maxAttempts 2 boundary... the next
    // evaluation reaches the attempt ceiling and terminalizes the goal.
    const next = store.listGoalAttempts(g.goalId).find((t) => t.status === 'accepted');
    store.fail(next.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock, assessor: notDemonstratedAssessor }));
    await runLoopOnce(store, g.goalId, loopDeps({ now: clock })); // planning gate hits the budget

    const goal = store.readGoal(g.goalId);
    assert.equal(goal.status, 'exhausted');
    assert.equal(goal.terminalReason, 'attempt_limit_reached');

    const service = (await import('../dist/services/projectGoalControlService.js')).createProjectGoalControlService({
      store,
      config,
      registry,
      executeWorkflow: neverResolvingWorkflow,
    });
    const detail = service.getGoalDetail(g.goalId);
    assert.equal(detail.ok, true);
    assert.equal(detail.payload.loopStage, 'exhausted');
    assert.equal(detail.payload.hudState, 'failed');
    assert.equal(detail.payload.nextSafeAction, 'none_terminal');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('20: malformed/corrupt goal is isolated — list and detail fail closed, others unaffected', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-corrupt-');
  try {
    const base = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const good = seedGoal(base, 1);
    const bad = seedGoal(base, 2, { goalId: goalId(7) });
    base.fail(bad.taskId, failure());

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

    await withServer(controlApp(store), async (baseUrl) => {
      // The corrupt goal surfaces as a safe failed_closed item; the list never aborts.
      let response = await fetch(`${baseUrl}/api/projects/goals`);
      assert.equal(response.status, 200);
      let body = await response.json();
      assert.equal(body.goals.length, 2);
      const corrupt = body.goals.find((item) => item.goalId === bad.goalId);
      assert.equal(corrupt.loopStage, 'failed_closed');
      assert.equal(corrupt.hudState, 'fail_closed');
      assert.equal(corrupt.blockingReason, 'loop_transition_failed');
      assert.equal(corrupt.nextSafeAction, 'manual_review_required');
      const healthy = body.goals.find((item) => item.goalId === good.goalId);
      assert.equal(healthy.loopStage, 'awaiting_execution');

      // The corrupt goal detail fails closed with a safe reason.
      response = await fetch(`${baseUrl}/api/projects/goals/${bad.goalId}`);
      assert.equal(response.status, 200);
      body = await response.json();
      assert.equal(body.hudState, 'fail_closed');
      assert.equal(body.blockingReason, 'loop_transition_failed');
    });
    base.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('21: restart-safe — suspension and approval survive close/reopen; stage re-derives identically', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-restart-');
  try {
    let store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToApprovalRequired(store, g.goalId);
    store.approveContinuationPlan({ planId: store.listGoalContinuationPlans(g.goalId)[0].planId, approver: 'operator-1' });
    store.setGoalAutonomyPolicy({ goalId: g.goalId, mode: 'approved_single_step', approver: 'operator-1' });
    store.suspendGoalAutonomy(g.goalId);

    const before = (await import('../dist/services/projectGoalControlReadModel.js'))
      .buildOperatorGoalDetailSafe(store, g.goalId, { now: () => 1000 });
    assert.equal(before.loopStage, 'suspended');
    // While suspended the derived stage carries no live plan, so the approval
    // state is durably not_applicable (the approval row itself survives).
    assert.equal(before.approvalState, 'not_applicable');
    store.close();

    // Process 2: fresh store over the same durable file.
    store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    assert.equal(store.readGoal(g.goalId).status, 'active');
    assert.ok(store.readGoalAutonomyPolicy(g.goalId).suspendedAt !== undefined, 'suspension survives restart');
    const after = (await import('../dist/services/projectGoalControlReadModel.js'))
      .buildOperatorGoalDetailSafe(store, g.goalId, { now: () => 1000 });
    assert.equal(after.loopStage, 'suspended');
    assert.equal(after.hudState, 'suspended');
    assert.equal(after.approvalState, 'not_applicable');

    // Resume through the fresh surface converges to the pre-suspension gate:
    // the durable approval is still in force, so the derived stage is the
    // materialization gate with approval_present (never silently consumed).
    const service = (await import('../dist/services/projectGoalControlService.js')).createProjectGoalControlService({
      store,
      config,
      registry,
      executeWorkflow: neverResolvingWorkflow,
      now: () => 1000,
    });
    const resumed = service.resume(g.goalId);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.payload.policyState, 'approved_single_step');
    const detail = service.getGoalDetail(g.goalId);
    assert.equal(detail.ok, true);
    assert.equal(detail.payload.loopStage, 'materializing_next_attempt');
    assert.equal(detail.payload.approvalState, 'approval_present');
    assert.equal(detail.payload.authorizationState, 'authorization_required');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('22: authority preservation — payloads never carry secrets, paths, prompts, sessions or capabilities', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-authority-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);
    store.fail(g.taskId, failure());
    await driveToApprovalRequired(store, g.goalId);
    store.approveContinuationPlan({ planId: store.listGoalContinuationPlans(g.goalId)[0].planId, approver: 'operator-1' });
    await runLoopOnce(store, g.goalId, loopDeps()); // materialize
    store.setGoalAutonomyPolicy({ goalId: g.goalId, mode: 'approved_single_step', approver: 'operator-1' });

    await withServer(controlApp(store), async (baseUrl) => {
      const responses = [
        await fetch(`${baseUrl}/api/projects/goals`),
        await fetch(`${baseUrl}/api/projects/goals/${g.goalId}`),
        await fetch(`${baseUrl}/api/projects/goals/${g.goalId}/continuation`),
        await fetch(`${baseUrl}/api/projects/goals/${g.goalId}/autonomy`),
        await fetch(`${baseUrl}/api/projects/goals/${g.goalId}/evidence`),
      ];
      for (const response of responses) {
        assert.equal(response.status, 200);
        const serialized = JSON.stringify(await response.json());
        for (const forbidden of [
          'sessionId', 'session_id', 'apiKey', 'api_key', 'accessToken', 'token',
          'secret', 'credential', 'worktreePath', 'worktree_path', 'repositoryRoot',
          'command', 'shell', 'prompt', 'rawOutput', 'executionSummary', 'provider',
          'model', 'fencingToken', 'leaseId', 'leaseOwner', 'stack',
          'push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access',
        ]) {
          assert.ok(!serialized.includes(forbidden), `surface payload must not expose ${forbidden}`);
        }
      }
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('23: no capability escalation — ceiling enforced, continuations inherit never expand', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-caps-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    const g = seedGoal(store, 1);

    // Create with a capability outside the backend ceiling => 400.
    await withServer(controlApp(store), async (baseUrl) => {
      const response = await post(baseUrl, '/api/projects/goals', createBody({
        goalId: goalId(3),
        requestedCapabilities: ['repository_read', 'run_tests', 'push'],
      }));
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    });

    // A continuation intent that would widen the parent set is durably refused
    // by the lineage/capability guard the surface sits on top of.
    store.fail(g.taskId, failure());
    await runLoopOnce(store, g.goalId, loopDeps({ assessor: notDemonstratedAssessor }));
    const plan = store.listGoalContinuationPlans(g.goalId)[0];
    assert.throws(
      () => store.createContinuationAttempt({
        taskId: taskId(5),
        fingerprint: 'expanding-fp',
        intent: intent({ requestedCapabilities: ['repository_read', 'run_tests', 'isolated_worktree_write'] }),
        goalId: g.goalId,
        parentTaskId: g.taskId,
        continuationDepth: 1,
        attemptNumber: 1,
      }),
      /project_task_continuation_capability_expansion/,
    );
    // The surface never carries a capability field of its own.
    const service = (await import('../dist/services/projectGoalControlService.js')).createProjectGoalControlService({
      store,
      config,
      registry,
      executeWorkflow: neverResolvingWorkflow,
    });
    const detail = service.getGoalDetail(g.goalId);
    assert.equal(detail.ok, true);
    const serialized = JSON.stringify(detail.payload);
    assert.ok(!serialized.includes('approvedCapabilities'));
    assert.ok(!serialized.includes('effectiveCapabilities'));
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('24: no direct execution-engine bypass, no timer/polling — structural source checks', async () => {
  const [router, contract, service, readModel] = await Promise.all([
    readFile(ROUTER_SOURCE, 'utf8'),
    readFile(CONTRACT_SOURCE, 'utf8'),
    readFile(SERVICE_SOURCE, 'utf8'),
    readFile(READ_MODEL_SOURCE, 'utf8'),
  ]);
  const routerSource = stripComments(router);
  const contractSource = stripComments(contract);
  const serviceSource = stripComments(service);
  const readModelSource = stripComments(readModel);

  for (const source of [routerSource, contractSource, readModelSource]) {
    assert.ok(!source.includes('setInterval'), 'no periodic timer');
    assert.ok(!source.includes('setTimeout'), 'no one-shot timer');
    assert.ok(!source.includes('cron'), 'no cron');
    assert.ok(!source.includes('child_process'), 'no process authority');
    assert.ok(!source.includes('.spawn(') && !source.includes('.exec('), 'no process invocation');
    assert.ok(!source.includes('node:http') && !source.includes('node:net') && !source.includes('node:dns'), 'no new network authority');
    assert.ok(!source.includes('runProjectTaskDurableExecution'), 'routes/contracts/read-model never call the runner');
    assert.ok(!source.includes('projectTaskDurableExecutionRunner'));
    assert.ok(!source.includes('projectTaskWorkflowService'));
    assert.ok(!source.includes('hermesSupervisorExecutor'));
    assert.ok(!source.includes('projectCodexExecutor'));
    assert.ok(!source.includes('hermesExecutor'));
    assert.ok(!source.includes('launchContinuationTaskIfEligible'), 'no launch bypass');
  }

  // The service's ONLY execution touch is the sanctioned intake scheduling of
  // the EXISTING durable runner via setImmediate (mirror of the tasks route).
  // The architectural assertion is about CALL SITES, not references: one
  // import + exactly one call. An import alone is a reference to the one
  // existing engine, never a second engine.
  const runnerCallSites = serviceSource.match(/runProjectTaskDurableExecution\(/g) ?? [];
  assert.equal(runnerCallSites.length, 1, 'exactly one runner call site (the intake)');
  const runnerImports = serviceSource.match(/import\s*\{[^}]*runProjectTaskDurableExecution[^}]*\}/g) ?? [];
  assert.equal(runnerImports.length, 1, 'the single runner reference is the sanctioned import');
  assert.ok(serviceSource.includes('setImmediate'), 'the only scheduling primitive is setImmediate');
  assert.ok(serviceSource.includes('scheduleRootAttemptRunner'), 'intake runner is the only execution path');
  assert.ok(!serviceSource.includes('setInterval'));
  assert.ok(!serviceSource.includes('setTimeout'));
  assert.ok(!serviceSource.includes('cron'));
  assert.ok(!serviceSource.includes('while'), 'no busy loop');

  // The contract module carries constants and shapes only: no store writes.
  assert.ok(!contractSource.includes('store.'), 'contract never touches the store');
});

test('25: nonexistent goal => 404; malformed goalId => 400 invalid_goal_id', async () => {
  const { directory, databasePath } = await tempDatabase('lia-gcs-404-');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000, maxActive: 64, maxRecords: 256 });
    await withServer(controlApp(store), async (baseUrl) => {
      let response = await fetch(`${baseUrl}/api/projects/goals/${goalId(42)}`);
      assert.equal(response.status, 404);
      let body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);

      response = await fetch(`${baseUrl}/api/projects/goals/not-a-uuid`);
      assert.equal(response.status, 400);
      body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.invalidGoalId);

      response = await post(baseUrl, `/api/projects/goals/${goalId(42)}/suspend`);
      assert.equal(response.status, 404);
      body = await response.json();
      assert.equal(body.error, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);

      // Method guards: GET-only and POST-only surfaces stay strict.
      response = await fetch(`${baseUrl}/api/projects/goals`, { method: 'DELETE' });
      assert.equal(response.status, 405);
    });
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("root attempt terminalization wakes supervisor automatically", async () => {
  const { directory, databasePath } = await tempDatabase("lia-gcs-root-wakeup-");
  try {
    const store = new ProjectTaskSqliteStore({
      databasePath,
      now: () => 1000,
      maxActive: 64,
      maxRecords: 256,
    });
    const supervisor = makeSupervisor(store, { assessor: satisfiedAssessor });

    await withServer(controlApp(store, {
      projectTasksWorkflowExecutor: async () => workflowOk,
      projectSupervisorRuntime: supervisor,
    }), async (baseUrl) => {
      const created = await post(baseUrl, "/api/projects/goals", createBody({
        maxAttempts: 1,
        continuationDepthLimit: 0,
      }));
      assert.equal(created.status, 202);

      let detail;
      for (let i = 0; i < 20; i += 1) {
        await flushImmediates(2);
        detail = await (await fetch(baseUrl + "/api/projects/goals/" + goalId(1))).json();
        if (detail.status === "completed") break;
      }

      assert.equal(detail.status, "completed");
      assert.equal(detail.terminalReason, "objective_completed");
      assert.equal(detail.attempts.length, 1);

      const hud = await (await fetch(baseUrl + "/api/projects/goals/supervisor")).json();
      assert.equal(hud.ok, true);
      assert.equal(hud.supervisor.lastPass.source, "terminalization");
      assert.equal(hud.supervisor.lastPass.externalExecutionSlotsUsed, 0);
    });

    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
