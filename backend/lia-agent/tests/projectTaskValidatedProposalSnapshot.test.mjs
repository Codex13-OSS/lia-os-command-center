import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import {
  PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION,
  PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS,
  PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_MAX_LIST_LIMIT,
} from '../dist/contracts/projectTaskValidatedProposalSnapshot.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';
import { canonicalizeValidatedProposal } from '../dist/services/projectValidatedProposalSnapshotCanonicalization.js';
import {
  hasProjectTaskDurableExecutionPrimitives,
  runProjectTaskDurableExecution,
} from '../dist/services/projectTaskDurableExecutionRunner.js';
import { executeProjectTaskWorkflow } from '../dist/services/projectTaskWorkflowService.js';
import { validateProjectOrchestrationProposal } from '../dist/services/projectOrchestrationValidation.js';

const TASK_A = '450e8400-e29b-41d4-a716-446655440000';
const TASK_B = '450e8400-e29b-41d4-a716-446655440001';
const TASK_C = '450e8400-e29b-41d4-a716-446655440002';
const UNKNOWN = '450e8400-e29b-41d4-a716-446655440099';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const intent = {
  projectId: 'safe',
  instruction: 'Cross the durable launch boundary without external execution.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests'],
};
const receipt = { executionId: 'historical-result', status: 'verified', resultText: 'done' };
const V13_CHAIN_TABLES = [
  'project_tasks', 'project_task_active_stage_traces', 'project_goals',
  'project_task_lineage', 'project_goal_evaluations', 'project_goal_continuation_plans',
  'project_goal_continuation_consumptions', 'project_task_lease_generations',
  'project_task_dispatch_outbox', 'project_task_execution_runs',
  'project_task_execution_invocations', 'project_task_execution_launch_attempts',
  'project_task_execution_launch_results',
];
// Additive V13 relations that must be removed to reconstruct an authentic V12 database.
const REWIND_V13_TO_V12_SQL = `
  DROP TRIGGER project_task_validated_proposal_snapshots_validate_insert;
  DROP TRIGGER project_task_validated_proposal_snapshots_immutable_update;
  DROP TRIGGER project_task_validated_proposal_snapshots_immutable_delete;
  DROP INDEX project_task_validated_proposal_snapshots_recorded;
  DROP TABLE project_task_validated_proposal_snapshots;
  UPDATE project_task_meta SET schema_version = 12 WHERE singleton = 1;
`;
// Authentic V9 rewind (exercises the V9 -> V10 -> V11 -> V12 -> V13 chain).
const REWIND_V13_TO_V9_SQL = `
  DROP TRIGGER project_task_validated_proposal_snapshots_validate_insert;
  DROP TRIGGER project_task_validated_proposal_snapshots_immutable_update;
  DROP TRIGGER project_task_validated_proposal_snapshots_immutable_delete;
  DROP INDEX project_task_validated_proposal_snapshots_recorded;
  DROP TABLE project_task_validated_proposal_snapshots;
  DROP TRIGGER project_task_execution_launch_results_validate_insert;
  DROP TRIGGER project_task_execution_launch_results_immutable_update;
  DROP TRIGGER project_task_execution_launch_results_immutable_delete;
  DROP INDEX project_task_execution_launch_results_recorded;
  DROP TABLE project_task_execution_launch_results;
  DROP TRIGGER project_task_execution_launch_attempts_preserve_on_lease_release;
  DROP TRIGGER project_task_execution_launch_attempts_validate_insert;
  DROP TRIGGER project_task_execution_launch_attempts_immutable_update;
  DROP TRIGGER project_task_execution_launch_attempts_immutable_delete;
  DROP INDEX project_task_execution_launch_attempts_crossed;
  DROP TABLE project_task_execution_launch_attempts;
  DROP TRIGGER project_task_execution_invocations_preserve_on_lease_release;
  DROP TABLE project_task_execution_invocations;
  UPDATE project_task_meta SET schema_version = 9 WHERE singleton = 1;
`;
// Authentic V4 rewind (exercises the V4 -> ... -> V13 chain).
// Drop order respects FK chains: launch_results (child of attempts) →
// attempts (child of invocations + runs) → invocations (child of runs) →
// runs → dispatch_outbox → lease objects.
const REWIND_V13_TO_V4_SQL = `
  DROP TRIGGER project_task_validated_proposal_snapshots_validate_insert;
  DROP TRIGGER project_task_validated_proposal_snapshots_immutable_update;
  DROP TRIGGER project_task_validated_proposal_snapshots_immutable_delete;
  DROP INDEX project_task_validated_proposal_snapshots_recorded;
  DROP TABLE project_task_validated_proposal_snapshots;
  DROP TRIGGER project_task_execution_launch_results_validate_insert;
  DROP TRIGGER project_task_execution_launch_results_immutable_update;
  DROP TRIGGER project_task_execution_launch_results_immutable_delete;
  DROP INDEX project_task_execution_launch_results_recorded;
  DROP TABLE project_task_execution_launch_results;
  DROP TRIGGER project_task_execution_launch_attempts_preserve_on_lease_release;
  DROP TRIGGER project_task_execution_launch_attempts_validate_insert;
  DROP TRIGGER project_task_execution_launch_attempts_immutable_update;
  DROP TRIGGER project_task_execution_launch_attempts_immutable_delete;
  DROP INDEX project_task_execution_launch_attempts_crossed;
  DROP TABLE project_task_execution_launch_attempts;
  DROP TRIGGER project_task_execution_invocations_preserve_on_lease_release;
  DROP TABLE project_task_execution_invocations;
  DROP TABLE project_task_execution_runs;
  DROP TABLE project_task_dispatch_outbox;
  DROP TRIGGER project_task_lease_validate_insert;
  DROP TRIGGER project_task_lease_identity_immutable;
  DROP TRIGGER project_task_lease_expiry_monotonic;
  DROP TRIGGER project_task_lease_release_once;
  DROP TRIGGER project_task_lease_generation_immutable_delete;
  DROP TABLE project_task_lease_generations;
  DROP TRIGGER project_goal_continuation_consumed_plan_state_immutable;
  DROP TABLE project_goal_continuation_consumptions;
`;

async function fixture(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let now = options.now ?? 1_000;
  const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
  store.createOrGet(TASK_A, 'fp-a', intent);
  if (options.twoTasks) store.createOrGet(TASK_B, 'fp-b', intent);
  if (options.threeTasks) store.createOrGet(TASK_C, 'fp-c', intent);
  try {
    await fn({ store, databasePath, setNow(value) { now = value; } });
  } finally {
    if (store.isOpen !== false) store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function chain(store, taskId = TASK_A, owner = 'worker', durationMs = 10_000) {
  const dispatch = store.enqueueTaskDispatch(taskId);
  const lease = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: owner, durationMs }).lease;
  const run = store.prepareTaskExecutionRun({
    dispatchId: dispatch.dispatchId,
    taskId,
    leaseOwner: lease.leaseOwner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
  const invocation = store.reserveTaskExecutionInvocation({
    executionRunId: run.executionRunId,
    taskId,
    leaseOwner: lease.leaseOwner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
  return { dispatch, lease, run, invocation };
}

function crossBoundary(store, { invocation, run, lease }) {
  return store.beginTaskExecutionLaunchAttempt({
    invocationId: invocation.invocationId,
    executionRunId: run.executionRunId,
    taskId: run.taskId,
    leaseOwner: lease.leaseOwner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
}

function preparedAttempt(store, taskId = TASK_A, owner = 'worker') {
  const prepared = chain(store, taskId, owner);
  const attempt = crossBoundary(store, prepared).launchAttempt;
  return { ...prepared, attempt };
}

function recordResult(store, attempt, outcomeClass, overrides = {}) {
  return store.recordTaskExecutionLaunchResult({
    launchAttemptId: attempt.launchAttemptId,
    invocationId: attempt.invocationId,
    executionRunId: attempt.executionRunId,
    taskId: attempt.taskId,
    outcomeClass,
    ...overrides,
  });
}

function tableRows(databasePath, table) {
  const db = new DatabaseSync(databasePath);
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
  finally { db.close(); }
}

function snapshot(databasePath) {
  return Object.fromEntries(V13_CHAIN_TABLES.map((table) => [
    table,
    JSON.stringify(tableRows(databasePath, table)),
  ]));
}

// ---------------------------------------------------------------------------
// Layer 13 canonical proposal fixtures.
// ---------------------------------------------------------------------------
const proposal = (overrides = {}) => ({
  summary: 'Apply a contained change',
  steps: [{
    id: 'step-1',
    title: 'Implement',
    objective: 'Change only approved files',
    role: 'implementer',
    dependsOn: [],
    requiredCapabilities: ['isolated_worktree_write'],
  }],
  executionMode: 'direct',
  completionMode: 'ready_for_review',
  requiresHumanApproval: false,
  blockedActions: [],
  ...overrides,
});

function validatedInput(attempt, proposalObj, overrides = {}) {
  const canonical = canonicalizeValidatedProposal(proposalObj);
  return {
    launchAttemptId: attempt.launchAttemptId,
    invocationId: attempt.invocationId,
    executionRunId: attempt.executionRunId,
    taskId: attempt.taskId,
    canonicalProposalJson: canonical.canonicalJson,
    proposalSha256: canonical.sha256,
    executionMode: proposalObj.executionMode,
    completionMode: proposalObj.completionMode,
    requiresHumanApproval: proposalObj.requiresHumanApproval,
    blockedActions: proposalObj.blockedActions,
    ...overrides,
  };
}

function recordValidated(store, attempt, proposalObj, overrides = {}) {
  return store.recordValidatedProposalResult(validatedInput(attempt, proposalObj, overrides));
}

// ---------------------------------------------------------------------------
// Workflow-level harness for the direct/non-durable compatibility test.
// ---------------------------------------------------------------------------
const workflowConfig = {
  host: '127.0.0.1', port: 3014, corsOrigins: [], agendaSqlitePath: '', projectRegistryPath: '',
  hermesRoot: '', hermesExecutionEnabled: true, hermesExecutable: '/bin/hermes',
  hermesHome: '/hermes', hermesUser: 'hermes', hermesUserHome: '/home/hermes',
  hermesPath: '/bin', hermesProvider: 'fake', hermesModel: 'fake', hermesTimeoutMs: 100,
  hermesMaxQueryCharacters: 8000, logLevel: 'silent',
};
const workflowRequest = (requestedCapabilities = ['repository_read', 'isolated_worktree_write'], overrides = {}) => ({
  projectId: 'approved-project',
  instruction: 'Implement the approved task.',
  priority: 'normal',
  requestedCapabilities,
  ...overrides,
});
const workflowRegistry = (overrides = {}) => ({
  read: async () => [{
    projectId: 'approved-project', displayName: 'Approved Project',
    repositoryRoot: '/registry/approved-project', enabled: true, ...overrides,
  }],
});
const verificationRegistry = { resolve: () => ({ projectId: 'approved-project', checks: [] }) };

function workflowHarness(overrides = {}) {
  const calls = { hermes: 0, codex: 0, recorded: [] };
  return {
    calls,
    dependencies: {
      executeHermes: async () => {
        calls.hermes += 1;
        return { ok: true, response: JSON.stringify(proposal()) };
      },
      executeCodex: async () => {
        calls.codex += 1;
        return {
          success: true, executionId: 'execution-123', status: 'completed',
          summary: 'Codex completed safely.', resultText: 'Useful completion result.',
          outcome: 'modification_completed',
        };
      },
      executeVerification: async () => ({
        success: true, executionId: 'execution-123', status: 'verified',
        checksPassed: 2, totalChecks: 2, summary: 'All checks passed.',
      }),
      executeVisualVerification: async () => ({
        success: true, executionId: 'execution-123', status: 'visual_verified',
        checksPassed: 0, totalChecks: 0, summary: 'Visual verification is not required.',
      }),
      executeCommit: async () => ({
        success: true, executionId: 'execution-123', status: 'committed',
        commit: '0123456789abcdef0123456789abcdef01234567', summary: 'Committed locally.',
      }),
      recordExternalLaunchResult: (outcomeClass) => {
        calls.recorded.push(outcomeClass);
      },
      ...overrides,
    },
  };
}

const runWorkflow = (dependencies, request = workflowRequest()) =>
  executeProjectTaskWorkflow(workflowConfig, request, workflowRegistry(), verificationRegistry, dependencies);

// ---------------------------------------------------------------------------
// Runner-level helpers for re-entry evidence tests.
// ---------------------------------------------------------------------------
const runnerConfig = { ...workflowConfig };
const runnerRegistry = workflowRegistry();
const runnerRequest = {
  projectId: 'approved-project',
  instruction: 'Inspect the repository read-only and report the architecture.',
  priority: 'normal',
  requestedCapabilities: ['repository_read'],
};
const hermesOk = async () => ({ ok: true, response: JSON.stringify(proposal()) });
const codexOk = async () => ({
  success: true, executionId: 'execution-123', status: 'completed',
  summary: 'Codex completed safely.', resultText: 'Useful completion result.',
  outcome: 'modification_completed',
});

function runnerOptions(store, overrides = {}) {
  return {
    store,
    taskId: TASK_A,
    workerId: 'runner-worker-1',
    config: runnerConfig,
    request: runnerRequest,
    registry: runnerRegistry,
    onStage: () => {},
    workflowDependencies: { executeHermes: hermesOk, executeCodex: codexOk },
    ...overrides,
  };
}

// ===========================================================================
// 1-3. Additive migrations manufacture ZERO snapshots.
// ===========================================================================
test('1. V12 -> V13 migration is purely additive: rows byte-identical, schema 13, zero snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-v12-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(initial);
    recordResult(initial, attempt, 'timeout');
    initial.createOrGet(TASK_B, 'fp-b', intent);
    initial.enqueueTaskDispatch(TASK_B);
    initial.close();

    const v12 = new DatabaseSync(databasePath);
    const before = Object.fromEntries(V13_CHAIN_TABLES.map((table) => [
      table,
      JSON.stringify(v12.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ]));
    v12.exec(REWIND_V13_TO_V12_SQL);
    v12.close();

    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 18);
    assert.equal(
      migrated.readTaskExecutionLaunchAttempt(attempt.launchAttemptId).launchAttemptId,
      attempt.launchAttemptId,
    );
    migrated.close();

    const check = new DatabaseSync(databasePath);
    for (const [table, rows] of Object.entries(before)) {
      assert.equal(JSON.stringify(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), rows, table);
    }
    assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_validated_proposal_snapshots').get().total, 0);
    check.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('2. V12-era proposal_valid result migrates with ZERO manufactured snapshots and stays non-resumable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-zero-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(initial);
    recordResult(initial, attempt, 'proposal_valid'); // V12-era evidence: no snapshot exists
    initial.close();

    const v12 = new DatabaseSync(databasePath);
    v12.exec(REWIND_V13_TO_V12_SQL);
    v12.close();

    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.equal(migrated.readTaskExecutionLaunchResultByTask(TASK_A).outcomeClass, 'proposal_valid');
    // Zero snapshot rows were manufactured for the historical evidence.
    assert.equal(migrated.listValidatedProposalSnapshots(10).length, 0);
    // Recovery keeps the exact Layer 12 semantics: workflow_interrupted, never resumable.
    assert.deepEqual(migrated.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0, resumableAvailable: 0,
    });
    assert.equal(migrated.get(TASK_A).error.code, 'workflow_interrupted');
    // The atomic store op refuses to backfill the missing snapshot.
    assert.throws(
      () => recordValidated(migrated, attempt, proposal()),
      new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.atomicityViolation),
    );
    migrated.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('3. V4 and V9 migration chains reach V13 additively with zero manufactured snapshots', async () => {
  for (const [label, rewindSql, expectedVersion, dynamicPlansDrop] of [
    ['V9', REWIND_V13_TO_V9_SQL, 9, false],
    ['V4', REWIND_V13_TO_V4_SQL, 4, true],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `lia-snapshot-${label.toLowerCase()}-`));
    const databasePath = join(directory, 'tasks.sqlite');
    try {
      const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
      initial.createOrGet(TASK_A, 'fp-a', intent);
      initial.enqueueTaskDispatch(TASK_A);
      const { attempt } = preparedAttempt(initial);
      recordResult(initial, attempt, 'execution_failed');
      initial.close();

      const legacy = new DatabaseSync(databasePath);
      const beforeTasks = JSON.stringify(legacy.prepare('SELECT * FROM project_tasks ORDER BY rowid').all());
      legacy.exec(rewindSql);
      if (dynamicPlansDrop) {
        // Reconstruct an authentic V4 fixture: continuation plans (and their
        // triggers/indexes) are also absent at V4 and must be removed too.
        const objects = legacy.prepare(`
          SELECT type, name FROM sqlite_master
          WHERE tbl_name = 'project_goal_continuation_plans' OR name LIKE 'project_goal_continuation_plans_%'
        `).all();
        for (const object of objects.filter((item) => item.type === 'trigger')) legacy.exec(`DROP TRIGGER ${object.name}`);
        for (const object of objects.filter((item) => item.type === 'index' && !item.name.startsWith('sqlite_autoindex'))) legacy.exec(`DROP INDEX ${object.name}`);
        legacy.exec('DROP TABLE project_goal_continuation_plans');
      }
      legacy.exec(`UPDATE project_task_meta SET schema_version = ${expectedVersion} WHERE singleton = 1`);
      legacy.close();

      const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
      assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 18);
      assert.equal(migrated.get(TASK_A).fingerprint, 'fp-a');
      migrated.close();

      const check = new DatabaseSync(databasePath);
      assert.equal(JSON.stringify(check.prepare('SELECT * FROM project_tasks ORDER BY rowid').all()), beforeTasks, label);
      assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, 18, label);
      assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_validated_proposal_snapshots').get().total, 0, label);
      check.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

// ===========================================================================
// 4-5. Exact and contradictory replay.
// ===========================================================================
test('4. exact replay converges: created=true then created=false, one result row, one snapshot row', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const first = recordValidated(store, attempt, proposal());
    const replay = recordValidated(store, attempt, proposal());
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.snapshot.snapshotId, first.snapshot.snapshotId);
    assert.equal(replay.snapshot.launchResultId, first.snapshot.launchResultId);
    assert.deepEqual(replay.snapshot, first.snapshot);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
    assert.equal(tableRows(databasePath, 'project_task_validated_proposal_snapshots').length, 1);
  });
});

test('5. contradictory replay fails closed and leaves the durable rows untouched', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const first = recordValidated(store, attempt, proposal());
    assert.throws(
      () => recordValidated(store, attempt, proposal({ summary: 'A contradictory proposal' })),
      new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.contradictory),
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
    assert.equal(tableRows(databasePath, 'project_task_validated_proposal_snapshots').length, 1);
    assert.equal(store.readValidatedProposalSnapshot(first.snapshot.snapshotId).canonicalProposalJson,
      first.snapshot.canonicalProposalJson);
  });
});

// ===========================================================================
// 6-7. Concurrent writers.
// ===========================================================================
test('6. concurrent identical writers: one created, one replay no-op, single durable identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-concurrent-same-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(first);
    const second = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    const input = validatedInput(attempt, proposal());
    const a = first.recordValidatedProposalResult(input);
    const b = second.recordValidatedProposalResult(input);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.snapshot.snapshotId, a.snapshot.snapshotId);
    assert.equal(b.snapshot.launchResultId, a.snapshot.launchResultId);
    assert.equal(second.listValidatedProposalSnapshots(10).length, 1);
    first.close();
    second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('7. concurrent contradictory writers: the second throws and state is unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-concurrent-diff-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(first);
    const second = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    const a = first.recordValidatedProposalResult(validatedInput(attempt, proposal()));
    assert.equal(a.created, true);
    assert.throws(
      () => second.recordValidatedProposalResult(validatedInput(attempt, proposal({ summary: 'other' }))),
      new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.contradictory),
    );
    assert.equal(second.listValidatedProposalSnapshots(10).length, 1);
    assert.equal(
      second.readValidatedProposalSnapshotByTask(TASK_A).canonicalProposalJson,
      a.snapshot.canonicalProposalJson,
    );
    first.close();
    second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ===========================================================================
// 8-11. Atomicity and crash windows.
// ===========================================================================
test('8. result/snapshot atomic rollback: a mid-transaction snapshot failure persists NEITHER row', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    // The canonical JSON (executionMode direct) disagrees with the structured
    // executionMode (delegated): the snapshot insert trigger aborts AFTER the
    // result row was inserted, so the whole transaction must roll back.
    assert.throws(
      () => recordValidated(store, attempt, proposal(), { executionMode: 'delegated' }),
      /project_task_validated_proposal_snapshot_incompatible/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 0);
    assert.equal(tableRows(databasePath, 'project_task_validated_proposal_snapshots').length, 0);
  });
});

test('9. crash before the transaction: only the attempt exists, zero result/snapshot rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-crash-before-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(first);
    first.close(); // process crash before the atomic write ever began

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.equal(reopened.readTaskExecutionLaunchResultByTask(TASK_A), undefined);
    assert.equal(reopened.readValidatedProposalSnapshotByTask(TASK_A), undefined);
    assert.equal(
      reopened.readTaskExecutionLaunchAttemptByTask(TASK_A).launchAttemptId,
      attempt.launchAttemptId,
    );
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('10. crash during the transaction: SQLite atomicity leaves zero rows after rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-crash-during-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(first);
    const canonical = canonicalizeValidatedProposal(proposal());
    first.close();

    // Simulate the two-row write and a crash BEFORE COMMIT.
    const raw = new DatabaseSync(databasePath);
    raw.exec('BEGIN IMMEDIATE');
    raw.prepare(`
      INSERT INTO project_task_execution_launch_results (
        launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
        task_id, outcome_class, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      '450e8400-e29b-41d4-a716-44665544aaaa', attempt.launchAttemptId,
      attempt.invocationId, attempt.executionRunId, attempt.taskId,
      'proposal_valid', 1_000,
    );
    raw.prepare(`
      INSERT INTO project_task_validated_proposal_snapshots (
        snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
        execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
        canonical_version, execution_mode, completion_mode,
        requires_human_approval, blocked_actions_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '450e8400-e29b-41d4-a716-44665544bbbb', '450e8400-e29b-41d4-a716-44665544aaaa',
      attempt.launchAttemptId, attempt.invocationId, attempt.executionRunId, attempt.taskId,
      canonical.canonicalJson, canonical.sha256,
      PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION,
      'direct', 'ready_for_review', 0, '[]', 1_000,
    );
    raw.exec('ROLLBACK'); // crash before COMMIT
    raw.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.equal(reopened.readTaskExecutionLaunchResultByTask(TASK_A), undefined);
    assert.equal(reopened.readValidatedProposalSnapshotByTask(TASK_A), undefined);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('11. crash after the transaction: reopen sees BOTH rows and replay converges to the same identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-crash-after-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(first);
    const recorded = recordValidated(first, attempt, proposal());
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.equal(reopened.readTaskExecutionLaunchResultByTask(TASK_A).outcomeClass, 'proposal_valid');
    assert.equal(
      reopened.readValidatedProposalSnapshotByTask(TASK_A).snapshotId,
      recorded.snapshot.snapshotId,
    );
    const replay = recordValidated(reopened, attempt, proposal());
    assert.equal(replay.created, false);
    assert.equal(replay.snapshot.snapshotId, recorded.snapshot.snapshotId);
    assert.equal(replay.snapshot.launchResultId, recorded.snapshot.launchResultId);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ===========================================================================
// 12. Reopen identity.
// ===========================================================================
test('12. reopen identity: every lineage-keyed read returns the identical record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(first);
    const { snapshot: recorded } = recordValidated(first, attempt, proposal());
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.deepEqual(reopened.readValidatedProposalSnapshot(recorded.snapshotId), recorded);
    assert.deepEqual(reopened.readValidatedProposalSnapshotByLaunchResult(recorded.launchResultId), recorded);
    assert.deepEqual(reopened.readValidatedProposalSnapshotByLaunchAttempt(attempt.launchAttemptId), recorded);
    assert.deepEqual(reopened.readValidatedProposalSnapshotByInvocation(attempt.invocationId), recorded);
    assert.deepEqual(reopened.readValidatedProposalSnapshotByExecutionRun(attempt.executionRunId), recorded);
    assert.deepEqual(reopened.readValidatedProposalSnapshotByTask(TASK_A), recorded);
    assert.deepEqual(reopened.listValidatedProposalSnapshots(10), [recorded]);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ===========================================================================
// 13-15. Corrupt lineage and missing counterpart fail closed.
// ===========================================================================
test('13. corrupt lineage fails closed: raw UPDATE/DELETE immutable, mismatched raw INSERT aborts', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const { snapshot } = recordValidated(store, attempt, proposal());
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare('UPDATE project_task_validated_proposal_snapshots SET task_id = ? WHERE snapshot_id = ?')
        .run(TASK_B, snapshot.snapshotId),
      /project_task_validated_proposal_snapshot_immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM project_task_validated_proposal_snapshots WHERE snapshot_id = ?')
        .run(snapshot.snapshotId),
      /project_task_validated_proposal_snapshot_immutable/,
    );
    // Raw INSERT with a mismatched task lineage is aborted by the validate trigger.
    assert.throws(
      () => db.prepare(`
        INSERT INTO project_task_validated_proposal_snapshots (
          snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
          execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
          canonical_version, execution_mode, completion_mode,
          requires_human_approval, blocked_actions_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '450e8400-e29b-41d4-a716-44665544cccc', snapshot.launchResultId,
        attempt.launchAttemptId, attempt.invocationId, attempt.executionRunId,
        TASK_B, snapshot.canonicalProposalJson, snapshot.proposalSha256,
        snapshot.canonicalVersion, snapshot.executionMode, snapshot.completionMode,
        snapshot.requiresHumanApproval ? 1 : 0, JSON.stringify(snapshot.blockedActions),
        snapshot.recordedAt,
      ),
      /project_task_validated_proposal_snapshot_incompatible/,
    );
    db.close();
    assert.equal(tableRows(databasePath, 'project_task_validated_proposal_snapshots').length, 1);
  });
});

test('14. snapshot without proposal_valid result is impossible: raw INSERT aborts', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const { launchResult } = recordResult(store, attempt, 'timeout');
    const canonical = canonicalizeValidatedProposal(proposal());
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare(`
        INSERT INTO project_task_validated_proposal_snapshots (
          snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
          execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
          canonical_version, execution_mode, completion_mode,
          requires_human_approval, blocked_actions_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '450e8400-e29b-41d4-a716-44665544dddd', launchResult.launchResultId,
        attempt.launchAttemptId, attempt.invocationId, attempt.executionRunId,
        attempt.taskId, canonical.canonicalJson, canonical.sha256,
        PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION,
        'direct', 'ready_for_review', 0, '[]', 1_000,
      ),
      /project_task_validated_proposal_snapshot_incompatible/,
    );
    db.close();
    assert.equal(tableRows(databasePath, 'project_task_validated_proposal_snapshots').length, 0);
  });
});

test('15. proposal_valid without a snapshot fails closed: atomicityViolation, never backfilled', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'proposal_valid'); // plain V12-style recording, no snapshot
    assert.equal(store.readValidatedProposalSnapshotByTask(TASK_A), undefined);
    assert.throws(
      () => recordValidated(store, attempt, proposal()),
      new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.atomicityViolation),
    );
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0, resumableAvailable: 0,
    });
    assert.equal(store.get(TASK_A).error.code, 'workflow_interrupted');
  });
});

// ===========================================================================
// 16-17. Terminal tasks and lease-independent evidence recording.
// ===========================================================================
test('16. terminal tasks reject the atomic write exactly like the result trigger', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    store.complete(TASK_A, receipt);
    assert.throws(
      () => recordValidated(store, attempt, proposal()),
      /project_task_execution_launch_result_incompatible/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 0);
    assert.equal(tableRows(databasePath, 'project_task_validated_proposal_snapshots').length, 0);
    assert.equal(store.get(TASK_A).status, 'completed');
  });
});

test('17. released/expired lease evidence recording succeeds; fresh attempts still need a fresh lease', async () => {
  await fixture(({ store, setNow }) => {
    const { attempt, lease } = preparedAttempt(store);
    store.releaseTaskLease({
      taskId: TASK_A, leaseOwner: lease.leaseOwner, leaseId: lease.leaseId, fencingToken: lease.fencingToken,
    });
    const afterRelease = recordValidated(store, attempt, proposal());
    assert.equal(afterRelease.created, true);
    setNow(400_000); // the launch lease is long expired
    const replay = recordValidated(store, attempt, proposal());
    assert.equal(replay.created, false);
    assert.deepEqual(replay.snapshot, afterRelease.snapshot);

    // Creating a NEW Launch Attempt still requires a fresh lease (unchanged).
    store.createOrGet(TASK_B, 'fp-b', intent);
    const preparedB = chain(store, TASK_B, 'worker-b'); // lease expires at 410_000
    setNow(420_000);
    assert.throws(
      () => store.beginTaskExecutionLaunchAttempt({
        invocationId: preparedB.invocation.invocationId,
        executionRunId: preparedB.run.executionRunId,
        taskId: TASK_B,
        leaseOwner: preparedB.lease.leaseOwner,
        leaseId: preparedB.lease.leaseId,
        fencingToken: preparedB.lease.fencingToken,
      }),
      /project_task_lease_expired/,
    );
  });
});

// ===========================================================================
// 18-21. Authority: the snapshot grants nothing.
// ===========================================================================
test('18. requiredCapabilities persist as metadata and are NEVER authority', async () => {
  await fixture(async ({ store }) => {
    const { attempt } = preparedAttempt(store);
    const { snapshot } = recordValidated(store, attempt, proposal());
    assert.match(snapshot.canonicalProposalJson, /isolated_worktree_write/);
    assert.equal(Object.hasOwn(snapshot, 'effectiveCapabilities'), false);
    assert.equal(Object.hasOwn(snapshot, 'approvedCapabilities'), false);

    // Re-entry with the snapshot: state-only local_resume_available, zero
    // Hermes, zero Codex — the proposal's requiredCapabilities authorize nothing.
    let hermesCalls = 0;
    let codexCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: async () => { codexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'local_resume_available');
    assert.equal(hermesCalls, 0);
    assert.equal(codexCalls, 0);
    assert.equal(store.get(TASK_A).terminalAt, undefined);
  });
});

test('19. requiresHumanApproval stays an unapproved gated fact', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const { attempt } = preparedAttempt(store);
    const gated = proposal({ requiresHumanApproval: true, blockedActions: ['push'] });
    const { snapshot } = recordValidated(store, attempt, gated);
    assert.equal(snapshot.requiresHumanApproval, true);
    assert.deepEqual(snapshot.blockedActions, ['push']);
    // No approval receipt/decision exists anywhere in the snapshot.
    assert.equal(Object.hasOwn(snapshot, 'approval'), false);
    assert.equal(Object.hasOwn(snapshot, 'approvedAt'), false);
    const ddl = new DatabaseSync(databasePath)
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_task_validated_proposal_snapshots'")
      .get().sql;
    // No approval receipt/decision columns exist anywhere in the snapshot DDL.
    // 'requires_human_approval' is a gated fact (boolean), NOT an approval receipt.
    assert.doesNotMatch(ddl, /approved_at|approved_by|approval_status|approval_receipt|approval_decision/i);

    // Recovery keeps the gated task preserved non-terminal (case 4): still gated.
    setNow(9_000);
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 0, resumableAvailable: 1,
    });
    const task = store.get(TASK_A);
    assert.equal(task.status, 'hermes');
    assert.equal(task.terminalAt, undefined);
    assert.equal(store.readValidatedProposalSnapshotByTask(TASK_A).requiresHumanApproval, true);
  });
});

test('20. blockedActions remain gated and derive zero authority', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    const gated = proposal({ requiresHumanApproval: true, blockedActions: ['push', 'merge', 'deploy'] });
    const { snapshot } = recordValidated(store, attempt, gated);
    assert.deepEqual(snapshot.blockedActions, ['push', 'merge', 'deploy']);
    // The snapshot stores the facts; nothing reads them as permission.
    assert.equal(store.readValidatedProposalSnapshotByTask(TASK_A).blockedActions.length, 3);
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 0, resumableAvailable: 1,
    });
    assert.equal(store.get(TASK_A).terminalAt, undefined);
  });
});

test('21. effectiveCapabilities are NOT snapshot authority and cannot enter canonical JSON', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    recordValidated(store, attempt, proposal());
    const db = new DatabaseSync(databasePath);
    const ddl = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_task_validated_proposal_snapshots'",
    ).get().sql;
    db.close();
    assert.doesNotMatch(ddl, /effective_capabilit|approved_capabilit/i);
    // The frozen canonicalizer output for a validated proposal never contains them.
    const canonical = canonicalizeValidatedProposal(proposal());
    assert.doesNotMatch(canonical.canonicalJson, /effectiveCapabilit|approvedCapabilit/i);
    // The validator rejects proposals smuggling effectiveCapabilities (unknown field).
    const validation = validateProjectOrchestrationProposal(
      { ...proposal(), effectiveCapabilities: ['repository_read'] },
      { approvedCapabilities: ['isolated_worktree_write', 'repository_read'] },
    );
    assert.equal(validation.success, false);
    assert.ok(validation.errors.some((error) => error.path === '$.effectiveCapabilities'), JSON.stringify(validation.errors));
  });
});

// ===========================================================================
// 22-25. Re-entry: zero Hermes, zero Codex, zero new attempts; post-Codex fence.
// ===========================================================================
test('22-24. snapshot re-entry: local_resume_available with zero Hermes, zero Codex, zero new Launch Attempt', async () => {
  await fixture(async ({ store }) => {
    const { attempt } = preparedAttempt(store);
    const { snapshot } = recordValidated(store, attempt, proposal());
    const attemptsBefore = store.listTaskExecutionLaunchAttempts(10).length;
    const resultsBefore = store.listTaskExecutionLaunchResults(10).length;
    const snapshotsBefore = store.listValidatedProposalSnapshots(10).length;
    let hermesCalls = 0;
    let codexCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: async () => { codexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'local_resume_available');
    assert.equal(hermesCalls, 0);
    assert.equal(codexCalls, 0);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, attemptsBefore);
    assert.equal(store.listTaskExecutionLaunchResults(10).length, resultsBefore);
    assert.equal(store.listValidatedProposalSnapshots(10).length, snapshotsBefore);
    assert.equal(store.get(TASK_A).terminalAt, undefined); // NOT terminalized
    assert.equal(store.readValidatedProposalSnapshot(snapshot.snapshotId).snapshotId, snapshot.snapshotId);
  });
});

test('25. post-Codex tasks cannot use the snapshot as replay permission', async () => {
  await fixture(async ({ store }) => {
    const { attempt } = preparedAttempt(store);
    recordValidated(store, attempt, proposal());
    store.transition(TASK_A, 'codex');
    let hermesCalls = 0;
    let codexCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: async () => { codexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'workflow_interrupted');
    assert.equal(hermesCalls, 0);
    assert.equal(codexCalls, 0);
    // Recovery applies the same pre/post-Codex fence: not resumable.
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0, resumableAvailable: 0,
    });
    assert.equal(store.get(TASK_A).error.code, 'workflow_interrupted');
  });
});

// ===========================================================================
// 26. Direct/non-durable workflow compatibility.
// ===========================================================================
test('26. direct/non-durable workflow records nothing durable and behaves as today', async () => {
  // No durable dependencies at all: the proposal_valid site records nothing.
  const direct = workflowHarness();
  delete direct.dependencies.recordExternalLaunchResult;
  const directResult = await runWorkflow(direct.dependencies);
  assert.equal(directResult.ok, true);
  assert.deepEqual(direct.calls.recorded, []);
  assert.equal(direct.calls.codex, 1);

  // Legacy durable callback (no Layer 13 seam): proposal_valid via the old path.
  const legacy = workflowHarness();
  const legacyResult = await runWorkflow(legacy.dependencies);
  assert.equal(legacyResult.ok, true);
  assert.deepEqual(legacy.calls.recorded, ['proposal_valid']);

  // Layer 13 seam present: it receives ONLY the normalized validated proposal;
  // the legacy callback is not used for proposal_valid.
  const seamed = workflowHarness();
  const seen = [];
  seamed.dependencies.recordValidatedProposalResult = async (received) => { seen.push(received); };
  const seamedResult = await runWorkflow(seamed.dependencies);
  assert.equal(seamedResult.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].summary, 'Apply a contained change');
  assert.deepEqual(seamed.calls.recorded, []);
  assert.equal(seamed.calls.codex, 1);

  // A seam throw fails closed as external_launch_outcome_unknown with zero Codex.
  const failing = workflowHarness();
  failing.dependencies.recordValidatedProposalResult = async () => { throw new Error('PRIVATE persistence failure'); };
  const failingResult = await runWorkflow(failing.dependencies);
  assert.equal(failingResult.ok, false);
  assert.equal(failingResult.error, 'external_launch_outcome_unknown');
  assert.equal(failing.calls.codex, 0);
});

// ===========================================================================
// 27. No forbidden payload persistence.
// ===========================================================================
test('27. no prompt/raw response/secret/session/subagent/command/path persistence', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const { snapshot } = recordValidated(store, attempt, proposal());
    const db = new DatabaseSync(databasePath);
    const ddl = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_task_validated_proposal_snapshots'",
    ).get().sql;
    db.close();
    for (const forbidden of [
      'prompt', 'response', 'secret', 'credential', 'session', 'subagent',
      'command', 'path', 'output', 'execution_id', 'commit_hash',
    ]) {
      assert.doesNotMatch(ddl, new RegExp(`\\b${forbidden}\\b`, 'i'), forbidden);
    }
    // The decoded record exposes exactly the contract fields and nothing else.
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'blockedActions', 'canonicalProposalJson', 'canonicalVersion', 'completionMode',
      'executionMode', 'executionRunId', 'invocationId', 'launchAttemptId',
      'launchResultId', 'proposalSha256', 'recordedAt', 'requiresHumanApproval',
      'snapshotId', 'taskId',
    ]);
    // The canonical JSON holds only proposal fields.
    assert.deepEqual(Object.keys(JSON.parse(snapshot.canonicalProposalJson)).sort(), [
      'blockedActions', 'completionMode', 'executionMode', 'requiresHumanApproval',
      'steps', 'summary',
    ]);
  });
});

// ===========================================================================
// 28. List bounds and deterministic order.
// ===========================================================================
test('28. deterministic (recorded_at, snapshot_id) order with bounded limits', async () => {
  await fixture(({ store, setNow }) => {
    const firstAttempt = preparedAttempt(store, TASK_A, 'worker-a');
    recordValidated(store, firstAttempt.attempt, proposal());
    store.createOrGet(TASK_B, 'fp-b', intent);
    const secondAttempt = preparedAttempt(store, TASK_B, 'worker-b');
    recordValidated(store, secondAttempt.attempt, proposal());
    store.createOrGet(TASK_C, 'fp-c', intent);
    setNow(2_000);
    const thirdAttempt = preparedAttempt(store, TASK_C, 'worker-c');
    recordValidated(store, thirdAttempt.attempt, proposal());

    const expected = [
      store.readValidatedProposalSnapshotByTask(TASK_A),
      store.readValidatedProposalSnapshotByTask(TASK_B),
      store.readValidatedProposalSnapshotByTask(TASK_C),
    ].sort((a, b) =>
      a.recordedAt - b.recordedAt || a.snapshotId.localeCompare(b.snapshotId),
    );
    assert.deepEqual(store.listValidatedProposalSnapshots(1), expected.slice(0, 1));
    assert.deepEqual(store.listValidatedProposalSnapshots(2), expected.slice(0, 2));
    assert.deepEqual(store.listValidatedProposalSnapshots(3), expected);
    assert.deepEqual(store.listValidatedProposalSnapshots(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_MAX_LIST_LIMIT), expected);
    assert.deepEqual(store.listValidatedProposalSnapshots(10), store.listValidatedProposalSnapshots(10));
    // Same-recordedAt ties break deterministically on snapshot_id.
    assert.deepEqual(
      store.listValidatedProposalSnapshots(3),
      [...expected].sort((a, b) =>
        a.recordedAt - b.recordedAt || a.snapshotId.localeCompare(b.snapshotId),
      ),
    );
    for (const limit of [0, -1, 1.5, PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_MAX_LIST_LIMIT + 1]) {
      assert.throws(
        () => store.listValidatedProposalSnapshots(limit),
        new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput),
      );
    }
  });
});

// ===========================================================================
// 29. Decoder fail-closed.
// ===========================================================================
test('29. corrupt rows fail closed: recovery aborts atomically and reads throw corruptRecord', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-snapshot-corrupt-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    store.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(store);
    recordValidated(store, attempt, proposal());
    // TASK_B gets a valid proposal_valid result, then a raw snapshot row whose
    // proposal_sha256 does NOT match sha256(canonical JSON).
    store.createOrGet(TASK_B, 'fp-b', intent);
    const preparedB = preparedAttempt(store, TASK_B, 'worker-b');
    const resultB = recordResult(store, preparedB.attempt, 'proposal_valid');
    const canonical = canonicalizeValidatedProposal(proposal());
    const raw = new DatabaseSync(databasePath);
    raw.prepare(`
      INSERT INTO project_task_validated_proposal_snapshots (
        snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
        execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
        canonical_version, execution_mode, completion_mode,
        requires_human_approval, blocked_actions_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '450e8400-e29b-41d4-a716-44665544eeee', resultB.launchResult.launchResultId,
      preparedB.attempt.launchAttemptId, preparedB.attempt.invocationId,
      preparedB.attempt.executionRunId, TASK_B,
      canonical.canonicalJson, '0'.repeat(64),
      PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION,
      'direct', 'ready_for_review', 0, '[]', 1_000,
    );
    raw.close();

    // The recovery pre-pass recomputes the fingerprint: corruptRecord aborts the
    // WHOLE recovery transaction, so no task is terminalized on corrupt evidence.
    assert.throws(
      () => store.reconcileRestartSafeTasks(),
      new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.corruptRecord),
    );
    assert.equal(store.get(TASK_A).terminalAt, undefined);
    assert.equal(store.get(TASK_B).terminalAt, undefined);
    store.close();

    // A structurally corrupt row (bad canonical version) fails the decoder on
    // read. TASK_C carries its own proposal_valid result so the corrupt row can
    // be inserted against a fresh launch_result_id (UNIQUE lineage columns).
    const corruptor = new DatabaseSync(databasePath);
    const taskStore = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    taskStore.createOrGet(TASK_C, 'fp-c', intent);
    const preparedC = preparedAttempt(taskStore, TASK_C, 'worker-c');
    const resultC = recordResult(taskStore, preparedC.attempt, 'proposal_valid');
    taskStore.close();
    corruptor.exec('PRAGMA ignore_check_constraints = ON');
    corruptor.prepare(`
      INSERT INTO project_task_validated_proposal_snapshots (
        snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
        execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
        canonical_version, execution_mode, completion_mode,
        requires_human_approval, blocked_actions_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '450e8400-e29b-41d4-a716-44665544ffff', resultC.launchResult.launchResultId,
      preparedC.attempt.launchAttemptId, preparedC.attempt.invocationId,
      preparedC.attempt.executionRunId, TASK_C,
      canonical.canonicalJson, canonical.sha256,
      'corrupt-canonical-v9', 'direct', 'ready_for_review', 0, '[]', 1_000,
    );
    corruptor.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.throws(
      () => reopened.readValidatedProposalSnapshotByTask(TASK_C),
      new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.corruptRecord),
    );
    assert.throws(
      () => reopened.reconcileRestartSafeTasks(),
      new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.corruptRecord),
    );
    // Malformed read ids fail closed with invalidInput.
    for (const read of [
      () => reopened.readValidatedProposalSnapshot('bad'),
      () => reopened.readValidatedProposalSnapshotByLaunchResult('bad'),
      () => reopened.readValidatedProposalSnapshotByLaunchAttempt('bad'),
      () => reopened.readValidatedProposalSnapshotByInvocation('bad'),
      () => reopened.readValidatedProposalSnapshotByExecutionRun('bad'),
      () => reopened.readValidatedProposalSnapshotByTask('bad'),
    ]) {
      assert.throws(read, new RegExp(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput));
    }
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ===========================================================================
// 30. Schema version and guard contract.
// ===========================================================================
test('30. migration chain asserts SCHEMA_VERSION 18 in every affected test file', async () => {
  assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 18);
  for (const file of [
    'projectTaskDispatch.test.mjs',
    'projectTaskDurableExecutionRunner.test.mjs',
    'projectTaskExecutionInvocation.test.mjs',
    'projectTaskExecutionLaunchAttempt.test.mjs',
    'projectTaskExecutionLaunchResult.test.mjs',
    'projectTaskExecutionRun.test.mjs',
    'projectTaskRecovery.test.mjs',
  ]) {
    const source = await readFile(new URL(`../tests/${file}`, import.meta.url), 'utf8');
    assert.equal(source.includes('PROJECT_TASK_SQLITE_SCHEMA_VERSION, 18'), true, file);
    assert.equal(source.includes('PROJECT_TASK_SQLITE_SCHEMA_VERSION, 14'), false, file);
  }
});

test('30b. the durable runner guard requires the resume decision primitives (fail closed, no silent V13 fallback)', () => {
  const base = {
    acquireTaskLease() {}, enqueueTaskDispatch() {}, claimTaskDispatch() {},
    prepareTaskExecutionRun() {}, reserveTaskExecutionInvocation() {},
    beginTaskExecutionLaunchAttempt() {}, recordTaskExecutionLaunchResult() {},
    readTaskExecutionLaunchResultByLaunchAttempt() {},
  };
  assert.equal(hasProjectTaskDurableExecutionPrimitives(base), false);
  // V13 snapshot primitives pass the Layer 13 guard but fail the Layer 14 guard.
  assert.equal(hasProjectTaskDurableExecutionPrimitives({
    ...base,
    recordValidatedProposalResult() {},
    readValidatedProposalSnapshotByLaunchResult() {},
  }), false);
  // Layer 14 requires both snapshot AND resume-decision primitives.
  assert.equal(hasProjectTaskDurableExecutionPrimitives({
    ...base,
    recordValidatedProposalResult() {},
    readValidatedProposalSnapshotByLaunchResult() {},
    recordResumeDecision() {},
    readResumeDecisionByTask() {},
  }), false);
  // Layer 17 guard (codex + verification + commit) returns false:
  // Layer 18 now requires recordCompletionEvidence + readCompletionEvidence.
  assert.equal(hasProjectTaskDurableExecutionPrimitives({
    ...base,
    recordValidatedProposalResult() {},
    readValidatedProposalSnapshotByLaunchResult() {},
    recordResumeDecision() {},
    readResumeDecisionByTask() {},
    recordCodexStartEvidence() {},
    recordCodexResultEvidence() {},
    readCodexStartEvidenceByTask() {},
    recordVerificationStartEvidence() {},
    recordVerificationResultEvidence() {},
    readVerificationStartEvidenceByTask() {},
    readVerificationResultEvidence() {},
    recordCommitStartEvidence() {},
    recordCommitResultEvidence() {},
    readCommitStartEvidenceByTask() {},
    readCommitResultEvidence() {},
  }), false);
  // Layer 18: full guard with completion evidence primitives.
  assert.equal(hasProjectTaskDurableExecutionPrimitives({
    ...base,
    recordValidatedProposalResult() {},
    readValidatedProposalSnapshotByLaunchResult() {},
    recordResumeDecision() {},
    readResumeDecisionByTask() {},
    recordCodexStartEvidence() {},
    recordCodexResultEvidence() {},
    readCodexStartEvidenceByTask() {},
    recordVerificationStartEvidence() {},
    recordVerificationResultEvidence() {},
    readVerificationStartEvidenceByTask() {},
    readVerificationResultEvidence() {},
    recordCommitStartEvidence() {},
    recordCommitResultEvidence() {},
    readCommitStartEvidenceByTask() {},
    readCommitResultEvidence() {},
    recordCompletionEvidence() {},
    readCompletionEvidence() {},
  }), true);
});

// ===========================================================================
// Canonicalizer determinism (frozen validated-proposal-canonical-v1).
// ===========================================================================
test('canonicalizer determinism, key ordering and hash stability', () => {
  const first = canonicalizeValidatedProposal(proposal());
  const second = canonicalizeValidatedProposal(proposal());
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  // Canonical JSON has no formatting whitespace between tokens, but
  // string values (e.g. "Change only approved files") contain spaces
  // as valid data.  A round-trip through parse + re-serialize is
  // deterministic — identical sorted-key output for the same object.
  const roundTripped = JSON.stringify(JSON.parse(first.canonicalJson));
  assert.equal(JSON.stringify(JSON.parse(roundTripped)), roundTripped);
  const parsed = JSON.parse(first.canonicalJson);
  assert.deepEqual(Object.keys(parsed), [
    'blockedActions', 'completionMode', 'executionMode', 'requiresHumanApproval', 'steps', 'summary',
  ]);
  // A differently-ordered input object canonicalizes to the same bytes.
  const reordered = canonicalizeValidatedProposal({
    blockedActions: [],
    completionMode: 'ready_for_review',
    executionMode: 'direct',
    requiresHumanApproval: false,
    summary: 'Apply a contained change',
    steps: proposal().steps,
  });
  assert.equal(reordered.canonicalJson, first.canonicalJson);
  assert.equal(reordered.sha256, first.sha256);
});

// ===========================================================================
// Terminal-task prune exclusion for snapshot carriers.
// ===========================================================================
test('pruneExpiredTerminals excludes terminal tasks carrying snapshots', async () => {
  await fixture(({ store, setNow }) => {
    const { attempt } = preparedAttempt(store);
    recordValidated(store, attempt, proposal());
    store.complete(TASK_A, receipt);
    setNow(100_000_000); // far beyond the terminal TTL
    store.complete(TASK_A, receipt); // triggers pruneExpiredTerminals
    assert.equal(store.get(TASK_A).status, 'completed');
    assert.equal(store.readValidatedProposalSnapshotByTask(TASK_A).taskId, TASK_A);
  });
});
