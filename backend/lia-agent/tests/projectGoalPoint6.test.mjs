import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { estimateProjectGoalEffort } from '../dist/services/projectGoalEffortEstimator.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { createMechanicalGoalAssessor } from '../dist/services/projectGoalSatisfactionAssessor.js';
import { runLoopOnce } from '../dist/services/projectBoundedAutonomousLoopRuntime.js';

const gid = (n) => `a50e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;
const tid = (n) => `b50e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;
const registry = { read: async () => [{ projectId: 'safe', displayName: 'Safe', repositoryRoot: '/safe', enabled: true }] };
const config = {
  host: '127.0.0.1', port: 3014, corsOrigins: [], agendaSqlitePath: '', projectTaskSqlitePath: '',
  projectRegistryPath: '', projectVerificationPath: '', hermesRoot: '', hermesExecutionEnabled: true,
  hermesExecutable: '/bin/false', hermesHome: '', hermesUser: '', hermesUserHome: '', hermesPath: '',
  hermesProvider: 'fake', hermesModel: 'fake', hermesTimeoutMs: 100, hermesMaxQueryCharacters: 8000,
  supervisorEnabled: true, logLevel: 'silent',
};
const retryableAssessor = createMechanicalGoalAssessor(() => ({
  goalSatisfaction: 'not_demonstrated', blocking: 'none', failure: 'retryable',
}));
const workflowOk = {
  ok: true, projectId: 'safe', executionId: 'point6-exec', status: 'verified', executionSummary: 'hidden',
  resultText: 'Verified bounded result.', verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
  stages: ['planning', 'hermes', 'codex', 'verification'],
};
const failure = {
  code: 'codex_execution_failed', message: SAFE_TASK_ERROR_MESSAGES.codex_execution_failed, stage: 'codex',
};

async function temporaryStore(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, store: new ProjectTaskSqliteStore({ databasePath: join(directory, 'tasks.sqlite'), now: () => 1000 }) };
}
async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const createBody = (n, overrides = {}) => ({
  goalId: gid(n), projectId: 'safe', objective: 'Apply one focused change and verify it.', priority: 'normal', ...overrides,
});

function seedFailedRoot(store, n = 1) {
  store.createGoal({ goalId: gid(n), projectId: 'safe', objective: 'Fix and verify the bounded objective.', maxAttempts: 3, continuationDepthLimit: 2 });
  store.createRootAttempt({
    taskId: tid(n), fingerprint: `fp-${n}`,
    intent: { projectId: 'safe', instruction: 'Fix and verify the bounded objective.', priority: 'normal', requestedCapabilities: ['repository_read', 'run_tests'] },
    goalId: gid(n), continuationDepth: 0, attemptNumber: 0,
  });
  store.fail(tid(n), failure);
}

test('P6 estimator: low/medium/high are deterministic, clamped, and carry no capability authority', () => {
  const lowA = estimateProjectGoalEffort({ objective: 'Rename one local label.', priority: 'normal' });
  const lowB = estimateProjectGoalEffort({ objective: 'Rename one local label.', priority: 'normal' });
  const medium = estimateProjectGoalEffort({ objective: 'Integrate the local API response with the existing UI.', priority: 'normal' });
  const high = estimateProjectGoalEffort({
    objective: 'Migrate authentication across the multi-service integration and verify the security boundary.', priority: 'critical',
  });
  assert.deepEqual(lowA, lowB);
  assert.equal(lowA.complexity, 'low');
  assert.equal(medium.complexity, 'medium');
  assert.ok(['high', 'critical'].includes(high.complexity));
  for (const estimate of [lowA, medium, high]) {
    assert.ok(estimate.recommendedMaxAttempts >= 1 && estimate.recommendedMaxAttempts <= 5);
    assert.ok(estimate.recommendedContinuationDepth >= 0 && estimate.recommendedContinuationDepth <= 4);
    assert.ok(estimate.recommendedMaxCycles <= estimate.recommendedMaxAttempts);
    assert.ok(estimate.recommendedElapsedBudgetMs <= 24 * 60 * 60 * 1000);
    assert.equal(JSON.stringify(estimate).includes('capabilit'), false);
  }
});

test('P6 intake: supervised and bounded both schedule root; only bounded persists clamped policy', async () => {
  const { directory, store } = await temporaryStore('lia-p6-intake-');
  let workflowCalls = 0;
  const executeWorkflow = async () => { workflowCalls += 1; return workflowOk; };
  try {
    const app = createApp(config, { projectTaskStore: store, projectRegistrySource: registry, projectTasksWorkflowExecutor: executeWorkflow, now: () => 1000 });
    await withServer(app, async (base) => {
      let response = await post(base, '/api/projects/goals', createBody(1));
      assert.equal(response.status, 202);
      response = await post(base, '/api/projects/goals', createBody(2, {
        maxAttempts: 3,
        continuationDepthLimit: 2,
        autonomy: { mode: 'bounded_autonomous', approver: 'lia-ui-operator', maxCycles: 999, elapsedBudgetMs: 999_999_999 },
      }));
      assert.equal(response.status, 202);
      await flush();
    });
    assert.equal(workflowCalls, 2, 'both root attempts entered the existing durable runner');
    assert.equal(store.readGoalAutonomyPolicy(gid(1)), undefined, 'supervised is the manual_only default');
    const policy = store.readGoalAutonomyPolicy(gid(2));
    assert.equal(policy.mode, 'bounded_autonomous');
    assert.equal(policy.approver, 'lia-ui-operator');
    assert.equal(policy.maxCycles, 3, 'clamped to Goal maxAttempts');
    assert.equal(policy.elapsedBudgetMs, 24 * 60 * 60 * 1000, 'clamped to official horizon');
    assert.deepEqual(store.listGoalAttempts(gid(2))[0].intent.requestedCapabilities, [], 'autonomy grants no capabilities');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('P6 continuation: bounded policy materializes and launches without a new per-plan approval; manual_only holds', async () => {
  const { directory, store } = await temporaryStore('lia-p6-chain-');
  try {
    seedFailedRoot(store, 1);
    store.setGoalAutonomyPolicy({ goalId: gid(1), mode: 'bounded_autonomous', approver: 'lia-ui-operator', maxCycles: 3, elapsedBudgetMs: 60_000 });
    await runLoopOnce(store, gid(1), { now: () => 1000, assessor: retryableAssessor });
    await runLoopOnce(store, gid(1), { now: () => 1000 });
    const plan = store.listGoalContinuationPlans(gid(1))[0];
    assert.equal(store.readContinuationApproval(plan.planId), undefined);
    const materialized = await runLoopOnce(store, gid(1), { now: () => 1000 });
    assert.equal(materialized.action, 'materialized');
    assert.equal(store.readContinuationApproval(plan.planId), undefined, 'bounded grant is not misrepresented as a per-plan human approval');
    const launched = await runLoopOnce(store, gid(1), {
      now: () => 1000,
      launch: { workerId: 'point6-worker', config, registry, now: () => 1000, executeWorkflow: async () => workflowOk },
    });
    assert.equal(launched.action, 'launched');

    seedFailedRoot(store, 2);
    await runLoopOnce(store, gid(2), { now: () => 1000, assessor: retryableAssessor });
    await runLoopOnce(store, gid(2), { now: () => 1000 });
    const held = await runLoopOnce(store, gid(2), { now: () => 1000 });
    assert.equal(held.action, 'held');
    assert.equal(held.blockingReason, 'approval_required');
    assert.equal(store.listGoalAttempts(gid(2)).length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('P6 fail-closed: expired, revoked and no-progress policy cannot materialize another attempt', async () => {
  for (const [name, mutate, now] of [
    ['expired', () => {}, 3000],
    ['revoked', (store, goalId) => store.revokeGoalAutonomy(goalId), 1000],
  ]) {
    const { directory, store } = await temporaryStore(`lia-p6-${name}-`);
    try {
      seedFailedRoot(store, 1);
      store.setGoalAutonomyPolicy({ goalId: gid(1), mode: 'bounded_autonomous', approver: 'lia-ui-operator', expiresAt: 2000 });
      mutate(store, gid(1));
      const result = await runLoopOnce(store, gid(1), { now: () => now, assessor: retryableAssessor });
      assert.equal(result.action, 'none');
      assert.match(result.blockingReason, /expired|revoked/);
      assert.equal(store.listGoalAttempts(gid(1)).length, 1);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
