import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { PROJECT_TASK_EXECUTION_LAUNCH_RESULT_MAX_LIST_LIMIT } from '../dist/contracts/projectTaskExecutionLaunchResult.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';
import { runProjectTaskDurableExecution } from '../dist/services/projectTaskDurableExecutionRunner.js';
import { executeProjectTaskWorkflow } from '../dist/services/projectTaskWorkflowService.js';

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
const OUTCOMES = ['proposal_valid', 'timeout', 'execution_failed', 'empty_response', 'invalid_hermes_json', 'invalid_hermes_proposal'];
// Additive V12 relations that must be removed to reconstruct an authentic V11 database.
const REWIND_V12_TO_V11_SQL = `
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
  UPDATE project_task_meta SET schema_version = 11 WHERE singleton = 1;
`;
// Authentic V9 rewind (exercises the V9 -> V10 -> V11 -> V12 chain).
const REWIND_V12_TO_V9_SQL = `
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
  DROP TRIGGER project_task_execution_invocations_validate_insert;
  DROP TRIGGER project_task_execution_invocations_immutable_update;
  DROP TRIGGER project_task_execution_invocations_immutable_delete;
  DROP INDEX project_task_execution_invocations_reserved;
  DROP TABLE project_task_execution_invocations;
  UPDATE project_task_meta SET schema_version = 9 WHERE singleton = 1;
`;
const V12_CHAIN_TABLES = [
  'project_tasks', 'project_task_active_stage_traces', 'project_goals',
  'project_task_lineage', 'project_goal_evaluations', 'project_goal_continuation_plans',
  'project_goal_continuation_consumptions', 'project_task_lease_generations',
  'project_task_dispatch_outbox', 'project_task_execution_runs',
  'project_task_execution_invocations', 'project_task_execution_launch_attempts',
];
const V9_CHAIN_TABLES = [
  'project_tasks', 'project_task_active_stage_traces', 'project_goals',
  'project_task_lineage', 'project_goal_evaluations', 'project_goal_continuation_plans',
  'project_goal_continuation_consumptions', 'project_task_lease_generations',
  'project_task_dispatch_outbox',
];

async function fixture(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-'));
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

function resultInput(attempt, outcomeClass, overrides = {}) {
  return {
    launchAttemptId: attempt.launchAttemptId,
    invocationId: attempt.invocationId,
    executionRunId: attempt.executionRunId,
    taskId: attempt.taskId,
    outcomeClass,
    ...overrides,
  };
}

function recordResult(store, attempt, outcomeClass, overrides = {}) {
  return store.recordTaskExecutionLaunchResult(resultInput(attempt, outcomeClass, overrides));
}

function tableRows(databasePath, table) {
  const db = new DatabaseSync(databasePath);
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
  finally { db.close(); }
}

function snapshot(databasePath) {
  return Object.fromEntries([...V12_CHAIN_TABLES, 'project_task_execution_launch_results'].map((table) => [
    table,
    JSON.stringify(tableRows(databasePath, table)),
  ]));
}

function preparedAttempt(store, taskId = TASK_A, owner = 'worker') {
  const prepared = chain(store, taskId, owner);
  const attempt = crossBoundary(store, prepared).launchAttempt;
  return { ...prepared, attempt };
}

// ---------------------------------------------------------------------------
// Workflow-level harness for the post-Hermes result seam.
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
const proposal = (overrides = {}) => ({
  summary: 'Apply a contained change',
  steps: [{
    id: 'step-1', title: 'Implement', objective: 'Change only approved files',
    role: 'implementer', dependsOn: [], requiredCapabilities: ['isolated_worktree_write'],
  }],
  executionMode: 'direct',
  requiresHumanApproval: false,
  blockedActions: [],
  ...overrides,
});
const verificationRegistry = { resolve: () => ({ projectId: 'approved-project', checks: [] }) };

function workflowHarness(overrides = {}) {
  const calls = { hermes: 0, codex: 0, recorded: [] };
  const sequence = [...(overrides.hermesSequence ?? [])];
  return {
    calls,
    dependencies: {
      executeHermes: async () => {
        calls.hermes += 1;
        const next = sequence.shift();
        if (next !== undefined) return next;
        if (overrides.hermes !== undefined) return overrides.hermes;
        return { ok: true, response: JSON.stringify(proposal()) };
      },
      executeCodex: async () => {
        calls.codex += 1;
        if (overrides.codexThrow) throw new Error('PRIVATE');
        return overrides.codex ?? {
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
        if (overrides.recordThrow) throw new Error('PRIVATE persistence failure');
        calls.recorded.push(outcomeClass);
      },
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
const hermesOk = async () => ({ ok: true, response: JSON.stringify({
  summary: 'Read-only analysis',
  steps: [{
    id: 'step-1', title: 'Inspect', objective: 'Inspect approved files only',
    role: 'implementer', dependsOn: [], requiredCapabilities: ['repository_read'],
  }],
  executionMode: 'direct', completionMode: 'analyze',
  requiresHumanApproval: false, blockedActions: [],
}) });
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
// 1-6. First recording of every allowed outcome.
// ===========================================================================
for (const outcomeClass of OUTCOMES) {
  test(`1-6. first ${outcomeClass} result is created exactly once`, async () => {
    await fixture(({ store, databasePath }) => {
      const { attempt } = preparedAttempt(store);
      const before = snapshot(databasePath);
      const result = recordResult(store, attempt, outcomeClass);
      assert.equal(result.created, true);
      assert.match(result.launchResult.launchResultId, UUID_V4);
      assert.deepEqual(result.launchResult, {
        launchResultId: result.launchResult.launchResultId,
        launchAttemptId: attempt.launchAttemptId,
        invocationId: attempt.invocationId,
        executionRunId: attempt.executionRunId,
        taskId: TASK_A,
        outcomeClass,
        recordedAt: 1_000,
      });
      assert.ok(result.launchResult.recordedAt >= attempt.boundaryCrossedAt);
      assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
      // The Launch Attempt and the whole prior durable chain are untouched.
      assert.equal(store.readTaskExecutionLaunchAttempt(attempt.launchAttemptId).launchAttemptId, attempt.launchAttemptId);
      const after = snapshot(databasePath);
      for (const table of [...V12_CHAIN_TABLES]) {
        assert.equal(after[table], before[table], table);
      }
    });
  });
}

// ===========================================================================
// 7. Unknown outcome rejected.
// ===========================================================================
test('7. unknown outcome is rejected', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    for (const bad of ['requiresHumanApproval', 'blockedActions', 'approval-required', 'capability_denied', 'codex_authorized']) {
      assert.throws(
        () => recordResult(store, attempt, bad),
        /invalid_project_task_execution_launch_result_input/,
        bad,
      );
    }
  });
});

// ===========================================================================
// 8. Malformed IDs rejected.
// ===========================================================================
test('8. malformed IDs are rejected', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    const malformed = [
      { launchAttemptId: 'bad' },
      { invocationId: 'bad' },
      { executionRunId: 'bad' },
      { taskId: 'bad' },
      { launchAttemptId: '550e8400-e29b-41d4-a716-4466554400zz' },
    ];
    for (const overrides of malformed) {
      assert.throws(
        () => recordResult(store, attempt, 'proposal_valid', overrides),
        /invalid_project_task_execution_launch_result_input/,
        JSON.stringify(overrides),
      );
    }
    assert.throws(() => store.recordTaskExecutionLaunchResult(undefined), /invalid_project_task_execution_launch_result_input/);
    assert.throws(() => store.recordTaskExecutionLaunchResult({}), /invalid_project_task_execution_launch_result_input/);
  });
});

// ===========================================================================
// 9. Missing Launch Attempt rejected.
// ===========================================================================
test('9. missing Launch Attempt is rejected', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    assert.throws(
      () => recordResult(store, attempt, 'proposal_valid', { launchAttemptId: UNKNOWN }),
      /project_task_execution_launch_result_attempt_not_found/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 0);
  });
});

// ===========================================================================
// 10-12. Wrong lineage rejected.
// ===========================================================================
test('10. wrong task lineage is rejected', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    assert.throws(
      () => recordResult(store, attempt, 'proposal_valid', { taskId: TASK_B }),
      /project_task_execution_launch_result_lineage_mismatch/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 0);
  });
});

test('11. wrong invocation lineage is rejected', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    assert.throws(
      () => recordResult(store, attempt, 'proposal_valid', { invocationId: UNKNOWN }),
      /project_task_execution_launch_result_lineage_mismatch/,
    );
  });
});

test('12. wrong executionRun lineage is rejected', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    assert.throws(
      () => recordResult(store, attempt, 'proposal_valid', { executionRunId: UNKNOWN }),
      /project_task_execution_launch_result_lineage_mismatch/,
    );
  });
});

// ===========================================================================
// 13. recordedAt cannot precede boundary.
// ===========================================================================
test('13. recordedAt cannot precede boundaryCrossedAt', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const { attempt } = preparedAttempt(store);
    // The store clamps to the boundary: a reverted clock still records at >= boundary.
    setNow(500);
    const recorded = recordResult(store, attempt, 'proposal_valid');
    assert.equal(recorded.launchResult.recordedAt, attempt.boundaryCrossedAt);
    // Direct SQL with recorded_at before the boundary is rejected by the trigger.
    const db = new DatabaseSync(databasePath);
    assert.throws(() => db.prepare(`
      INSERT INTO project_task_execution_launch_results (
        launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
        task_id, outcome_class, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      '550e8400-e29b-41d4-a716-446655449999', attempt.launchAttemptId,
      attempt.invocationId, attempt.executionRunId, attempt.taskId,
      'timeout', attempt.boundaryCrossedAt - 1,
    ), /project_task_execution_launch_result_incompatible/);
    db.close();
  });
});

// ===========================================================================
// 14. One result per Launch Attempt.
// ===========================================================================
test('14. only one result per Launch Attempt is allowed', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const first = recordResult(store, attempt, 'proposal_valid');
    const replay = recordResult(store, attempt, 'proposal_valid');
    assert.equal(replay.created, false);
    assert.equal(replay.launchResult.launchResultId, first.launchResult.launchResultId);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
  });
});

// ===========================================================================
// 15. One result per task/run/invocation.
// ===========================================================================
test('15. one result per task/run/invocation is enforced', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'proposal_valid');
    // A second recording sharing the same invocation/run/task under a different
    // (nonexistent) attempt is contradictory, not a fresh row.
    for (const overrides of [
      { launchAttemptId: UNKNOWN },
      { launchAttemptId: UNKNOWN, invocationId: UNKNOWN },
      { launchAttemptId: UNKNOWN, executionRunId: UNKNOWN },
    ]) {
      assert.throws(
        () => recordResult(store, attempt, 'timeout', overrides),
        /project_task_execution_launch_result_contradictory/,
        JSON.stringify(overrides),
      );
    }
    // The schema itself declares UNIQUE lineage columns.
    const db = new DatabaseSync(databasePath);
    const ddl = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_task_execution_launch_results'",
    ).get().sql;
    for (const column of ['launch_attempt_id', 'invocation_id', 'execution_run_id', 'task_id']) {
      assert.match(ddl, new RegExp(`${column} TEXT NOT NULL UNIQUE`));
    }
    db.close();
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
  });
});

// ===========================================================================
// 16. Exact replay returns the same row with created=false.
// ===========================================================================
test('16. exact replay returns the same row with created=false', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const input = resultInput(attempt, 'empty_response');
    const first = store.recordTaskExecutionLaunchResult(input);
    const replay = store.recordTaskExecutionLaunchResult(input);
    assert.equal(replay.created, false);
    assert.equal(replay.launchResult.launchResultId, first.launchResult.launchResultId);
    assert.deepEqual(replay.launchResult, first.launchResult);
    assert.deepEqual(
      store.readTaskExecutionLaunchResult(first.launchResult.launchResultId),
      first.launchResult,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
  });
});

// ===========================================================================
// 17-18. Replay after lease release / expiry.
// ===========================================================================
test('17. exact replay after lease release returns created=false', async () => {
  await fixture(({ store }) => {
    const { attempt, lease } = preparedAttempt(store);
    const first = recordResult(store, attempt, 'proposal_valid');
    store.releaseTaskLease({
      taskId: TASK_A, leaseOwner: lease.leaseOwner, leaseId: lease.leaseId, fencingToken: lease.fencingToken,
    });
    const replay = recordResult(store, attempt, 'proposal_valid');
    assert.equal(replay.created, false);
    assert.deepEqual(replay.launchResult, first.launchResult);
  });
});

test('18. exact replay after lease expiry returns created=false', async () => {
  await fixture(({ store, setNow }) => {
    const { attempt } = preparedAttempt(store);
    const first = recordResult(store, attempt, 'proposal_valid');
    setNow(400_000); // the launch lease is long expired
    const replay = recordResult(store, attempt, 'proposal_valid');
    assert.equal(replay.created, false);
    assert.deepEqual(replay.launchResult, first.launchResult);
  });
});

// ===========================================================================
// 19. Replay after DB reopen.
// ===========================================================================
test('19. exact replay after DB close/reopen returns created=false', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const firstStore = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    firstStore.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(firstStore);
    const first = recordResult(firstStore, attempt, 'invalid_hermes_json');
    firstStore.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    const replay = recordResult(reopened, attempt, 'invalid_hermes_json');
    assert.equal(replay.created, false);
    assert.deepEqual(replay.launchResult, first.launchResult);
    assert.deepEqual(
      reopened.readTaskExecutionLaunchResultByLaunchAttempt(attempt.launchAttemptId),
      first.launchResult,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ===========================================================================
// 20-21. Contradictory replay fails closed.
// ===========================================================================
test('20. contradictory outcome fails closed', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'proposal_valid');
    assert.throws(
      () => recordResult(store, attempt, 'timeout'),
      /project_task_execution_launch_result_contradictory/,
    );
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
    assert.equal(store.readTaskExecutionLaunchResultByTask(TASK_A).outcomeClass, 'proposal_valid');
  });
});

test('21. contradictory lineage fails closed', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'proposal_valid');
    assert.throws(
      () => recordResult(store, attempt, 'proposal_valid', { invocationId: UNKNOWN }),
      /project_task_execution_launch_result_contradictory/,
    );
    assert.throws(
      () => recordResult(store, attempt, 'proposal_valid', { executionRunId: UNKNOWN }),
      /project_task_execution_launch_result_contradictory/,
    );
    assert.throws(
      () => recordResult(store, attempt, 'proposal_valid', { taskId: TASK_B }),
      /project_task_execution_launch_result_contradictory/,
    );
  });
});

// ===========================================================================
// 22-24. Direct SQL immutability and validation.
// ===========================================================================
test('22. direct SQL UPDATE is rejected', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const { launchResult } = recordResult(store, attempt, 'timeout');
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare("UPDATE project_task_execution_launch_results SET outcome_class = 'proposal_valid' WHERE launch_result_id = ?").run(launchResult.launchResultId),
      /project_task_execution_launch_result_immutable/,
    );
    db.close();
    assert.equal(store.readTaskExecutionLaunchResult(launchResult.launchResultId).outcomeClass, 'timeout');
  });
});

test('23. direct SQL DELETE is rejected', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const { launchResult } = recordResult(store, attempt, 'execution_failed');
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare('DELETE FROM project_task_execution_launch_results WHERE launch_result_id = ?').run(launchResult.launchResultId),
      /project_task_execution_launch_result_immutable/,
    );
    db.close();
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
  });
});

test('24. malformed direct INSERT is rejected', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const db = new DatabaseSync(databasePath);
    const insert = db.prepare(`
      INSERT INTO project_task_execution_launch_results (
        launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
        task_id, outcome_class, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    assert.throws(
      () => insert.run('bad-id', attempt.launchAttemptId, attempt.invocationId, attempt.executionRunId, attempt.taskId, 'proposal_valid', 1_000),
      /CHECK|constraint/i,
    );
    assert.throws(
      () => insert.run('550e8400-e29b-41d4-a716-446655449999', attempt.launchAttemptId, attempt.invocationId, attempt.executionRunId, attempt.taskId, 'not_an_outcome', 1_000),
      /CHECK|constraint/i,
    );
    // recorded_at before the boundary is rejected by the insert trigger.
    assert.throws(
      () => insert.run('550e8400-e29b-41d4-a716-446655449999', attempt.launchAttemptId, attempt.invocationId, attempt.executionRunId, attempt.taskId, 'timeout', -1),
      /project_task_execution_launch_result_incompatible/,
    );
    db.close();
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 0);
  });
});

// ===========================================================================
// 25. Reads are side-effect free.
// ===========================================================================
test('25. reads are side-effect free', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const { launchResult } = recordResult(store, attempt, 'proposal_valid');
    const before = snapshot(databasePath);
    assert.deepEqual(store.readTaskExecutionLaunchResult(launchResult.launchResultId), launchResult);
    assert.deepEqual(store.readTaskExecutionLaunchResult(UNKNOWN), undefined);
    assert.deepEqual(store.readTaskExecutionLaunchResultByLaunchAttempt(attempt.launchAttemptId), launchResult);
    assert.deepEqual(store.readTaskExecutionLaunchResultByLaunchAttempt(UNKNOWN), undefined);
    assert.deepEqual(store.readTaskExecutionLaunchResultByInvocation(attempt.invocationId), launchResult);
    assert.deepEqual(store.readTaskExecutionLaunchResultByInvocation(UNKNOWN), undefined);
    assert.deepEqual(store.readTaskExecutionLaunchResultByTask(TASK_A), launchResult);
    assert.deepEqual(store.readTaskExecutionLaunchResultByTask(TASK_B), undefined);
    assert.deepEqual(store.listTaskExecutionLaunchResults(10), [launchResult]);
    const after = snapshot(databasePath);
    assert.deepEqual(after, before);
  });
});

// ===========================================================================
// 26. Deterministic bounded list.
// ===========================================================================
test('26. deterministic bounded list ordering and limits', async () => {
  await fixture(({ store, databasePath, setNow }) => {
    const first = preparedAttempt(store, TASK_A, 'worker-a');
    recordResult(store, first.attempt, 'proposal_valid');
    store.createOrGet(TASK_B, 'fp-b', intent);
    setNow(2_000);
    const second = preparedAttempt(store, TASK_B, 'worker-b');
    recordResult(store, second.attempt, 'timeout');
    store.createOrGet(TASK_C, 'fp-c', intent);
    setNow(3_000);
    const third = preparedAttempt(store, TASK_C, 'worker-c');
    recordResult(store, third.attempt, 'execution_failed');
    const expected = [
      store.readTaskExecutionLaunchResultByTask(TASK_A),
      store.readTaskExecutionLaunchResultByTask(TASK_B),
      store.readTaskExecutionLaunchResultByTask(TASK_C),
    ];
    assert.deepEqual(store.listTaskExecutionLaunchResults(1), expected.slice(0, 1));
    assert.deepEqual(store.listTaskExecutionLaunchResults(2), expected.slice(0, 2));
    assert.deepEqual(store.listTaskExecutionLaunchResults(3), expected);
    assert.deepEqual(store.listTaskExecutionLaunchResults(10), expected);
    assert.deepEqual(store.listTaskExecutionLaunchResults(10), store.listTaskExecutionLaunchResults(10));
    for (const limit of [0, -1, 1.5, PROJECT_TASK_EXECUTION_LAUNCH_RESULT_MAX_LIST_LIMIT + 1]) {
      assert.throws(() => store.listTaskExecutionLaunchResults(limit), /invalid_project_task_execution_launch_result_input/);
    }
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 3);
  });
});

// ===========================================================================
// 27-28. V11 -> V12 migration.
// ===========================================================================
test('27. V11 to V12 migration preserves all existing durable rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-v11-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(initial);
    recordResult(initial, attempt, 'proposal_valid');
    initial.createOrGet(TASK_B, 'fp-b', intent);
    initial.enqueueTaskDispatch(TASK_B);
    initial.close();

    // Reconstruct an authentic V11 database: the V12 result table (and its
    // rows) is removed; every V11-era row must survive the V11 -> V12
    // migration byte-for-byte.
    const v11 = new DatabaseSync(databasePath);
    const before = Object.fromEntries(V12_CHAIN_TABLES.map((table) => [
      table,
      JSON.stringify(v11.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ]));
    v11.exec(REWIND_V12_TO_V11_SQL);
    v11.close();

    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 17);
    // The preserved Launch Attempt is still readable and fully functional.
    assert.equal(
      migrated.readTaskExecutionLaunchAttempt(attempt.launchAttemptId).launchAttemptId,
      attempt.launchAttemptId,
    );
    migrated.close();

    const check = new DatabaseSync(databasePath);
    for (const [table, snapshotRows] of Object.entries(before)) {
      assert.equal(JSON.stringify(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), snapshotRows, table);
    }
    assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_launch_results').get().total, 0);
    check.close();

    // The migrated V12 database accepts fresh result evidence against the
    // preserved attempt without touching the attempt row.
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 3_000 });
    const fresh = recordResult(reopened, attempt, 'timeout');
    assert.equal(fresh.created, true);
    assert.equal(fresh.launchResult.outcomeClass, 'timeout');
    assert.equal(
      reopened.readTaskExecutionLaunchAttempt(attempt.launchAttemptId).launchAttemptId,
      attempt.launchAttemptId,
    );
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('28. V11 to V12 migration manufactures zero result rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-migrate-zero-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(initial); // Launch Attempt exists, no result
    initial.createOrGet(TASK_B, 'fp-b', intent);
    initial.close();
    const before = Object.fromEntries(V12_CHAIN_TABLES.map((table) => [
      table,
      JSON.stringify(tableRows(databasePath, table)),
    ]));
    const v11 = new DatabaseSync(databasePath);
    v11.exec(REWIND_V12_TO_V11_SQL);
    v11.close();
    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    migrated.close();
    const check = new DatabaseSync(databasePath);
    for (const [table, snapshotRows] of Object.entries(before)) {
      assert.equal(JSON.stringify(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), snapshotRows, table);
    }
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_launch_results').get().total, 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_launch_attempts').get().total, 1);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_invocations').get().total, 1);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM project_task_execution_runs').get().total, 1);
    check.close();
    assert.equal(attempt.boundaryCrossedAt, 1_000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ===========================================================================
// 29. Old V1...V11 chain still reaches V12.
// ===========================================================================
test('29. the V9 -> V12 migration chain still reaches V12 and preserves every V9 row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-v9-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const initial = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    initial.createOrGet(TASK_A, 'fp-a', intent);
    initial.enqueueTaskDispatch(TASK_A);
    initial.createOrGet(TASK_B, 'fp-b', intent);
    initial.close();
    const before = Object.fromEntries(V9_CHAIN_TABLES.map((table) => [
      table,
      JSON.stringify(tableRows(databasePath, table)),
    ]));
    const v9 = new DatabaseSync(databasePath);
    v9.exec(REWIND_V12_TO_V9_SQL);
    v9.close();

    const migrated = new ProjectTaskSqliteStore({ databasePath, now: () => 2_000 });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 17);
    assert.equal(migrated.readTaskDispatchByTask(TASK_A).taskId, TASK_A);
    migrated.close();

    const check = new DatabaseSync(databasePath);
    for (const [table, snapshotRows] of Object.entries(before)) {
      assert.equal(JSON.stringify(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), snapshotRows, table);
    }
    assert.equal(check.prepare('SELECT schema_version FROM project_task_meta').get().schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);
    check.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ===========================================================================
// 30-32. No authority/capability/raw content; evidence authorizes nothing.
// ===========================================================================
test('30. result carries no authority or capability metadata', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const { launchResult } = recordResult(store, attempt, 'proposal_valid');
    assert.deepEqual(Object.keys(launchResult).sort(), [
      'executionRunId', 'invocationId', 'launchAttemptId', 'launchResultId',
      'outcomeClass', 'recordedAt', 'taskId',
    ]);
    const db = new DatabaseSync(databasePath);
    const columns = db.prepare('PRAGMA table_info(project_task_execution_launch_results)').all()
      .map((row) => row.name);
    assert.deepEqual(columns, [
      'launch_result_id', 'launch_attempt_id', 'invocation_id', 'execution_run_id',
      'task_id', 'outcome_class', 'recorded_at',
    ]);
    db.close();
  });
});

test('31. result contains no raw response, prompt, secret, command or path', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    const { launchResult } = recordResult(store, attempt, 'proposal_valid');
    const serialized = JSON.stringify(launchResult);
    for (const forbidden of [
      'response', 'prompt', 'secret', 'apikey', 'api_key', 'token',
      'credential', 'command', 'shell', 'repository', 'path', 'session',
      'subagent', 'stdout', 'stderr', 'provider', 'model',
    ]) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  });
});

test('32. proposal_valid evidence alone authorizes no Codex', async () => {
  await fixture(async ({ store }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'proposal_valid');
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
  });
});

// ===========================================================================
// 33-40. Workflow result seam.
// ===========================================================================
test('33. workflow records proposal_valid after final proposal validation', async () => {
  const fake = workflowHarness();
  const result = await runWorkflow(fake.dependencies);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.recorded, ['proposal_valid']);
  assert.equal(fake.calls.codex, 1);
});

test('34. workflow records proposal_valid BEFORE local approval and Codex', async () => {
  const fake = workflowHarness({ hermes: { ok: true, response: JSON.stringify(proposal({
    requiresHumanApproval: true, blockedActions: ['deploy'],
  })) } });
  const result = await runWorkflow(fake.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'approval');
  assert.equal(result.error, 'human_approval_required');
  assert.deepEqual(fake.calls.recorded, ['proposal_valid']);
  assert.equal(fake.calls.codex, 0);
});

test('35. workflow records the final failure outcome before returning the Hermes failure', async () => {
  const fake = workflowHarness({ hermesSequence: [
    { ok: false, error: 'timeout' },
    { ok: false, error: 'timeout' },
  ] });
  const result = await runWorkflow(fake.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.deepEqual(fake.calls.recorded, ['timeout']);
  assert.equal(fake.calls.codex, 0);
});

test('36. intermediate retry outcomes are not persisted', async () => {
  const fake = workflowHarness({ hermesSequence: [
    { ok: false, error: 'timeout' },
    { ok: true, response: JSON.stringify(proposal()) },
  ] });
  const result = await runWorkflow(fake.dependencies);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.recorded, ['proposal_valid']);
});

test('37. initial invalid -> repaired valid records only proposal_valid', async () => {
  const fake = workflowHarness({ hermesSequence: [
    { ok: true, response: 'not-json' },
    { ok: true, response: JSON.stringify(proposal()) },
  ] });
  const result = await runWorkflow(fake.dependencies);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.recorded, ['proposal_valid']);
});

test('38. initial invalid -> repaired invalid records only the final invalid outcome', async () => {
  const jsonCase = workflowHarness({ hermesSequence: [
    { ok: true, response: 'not-json' },
    { ok: true, response: 'still-not-json' },
  ] });
  const jsonResult = await runWorkflow(jsonCase.dependencies);
  assert.equal(jsonResult.error, 'invalid_hermes_json');
  assert.deepEqual(jsonCase.calls.recorded, ['invalid_hermes_json']);

  const structureCase = workflowHarness({ hermesSequence: [
    { ok: true, response: '{}' },
    { ok: true, response: JSON.stringify({ summary: 'still invalid' }) },
  ] });
  const structureResult = await runWorkflow(structureCase.dependencies);
  assert.equal(structureResult.error, 'invalid_hermes_proposal');
  assert.deepEqual(structureCase.calls.recorded, ['invalid_hermes_proposal']);
});

test('39. result recording failure causes external_launch_outcome_unknown', async () => {
  const fake = workflowHarness({ recordThrow: true });
  const result = await runWorkflow(fake.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'external_launch_outcome_unknown');
  assert.equal(result.stage, 'hermes');
});

test('40. result recording failure causes zero Codex', async () => {
  const fake = workflowHarness({ recordThrow: true });
  const result = await runWorkflow(fake.dependencies);
  assert.equal(result.error, 'external_launch_outcome_unknown');
  assert.equal(fake.calls.codex, 0);
});

// ===========================================================================
// 41-51. Recovery V2 for result evidence.
// ===========================================================================
test('41. Launch Attempt with no Result remains ambiguous on recovery', async () => {
  await fixture(({ store }) => {
    preparedAttempt(store);
    const result = store.reconcileRestartSafeTasks();
    assert.deepEqual(result, { preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0, resumableAvailable: 0 });
    assert.deepEqual(store.get(TASK_A).error, {
      code: 'external_launch_outcome_unknown',
      message: SAFE_TASK_ERROR_MESSAGES.external_launch_outcome_unknown,
    });
  });
});

const RECOVERY_OUTCOME_CASES = [
  ['timeout', 'timeout'],
  ['execution_failed', 'execution_failed'],
  ['empty_response', 'empty_response'],
  ['invalid_hermes_json', 'invalid_hermes_json'],
  ['invalid_hermes_proposal', 'invalid_hermes_proposal'],
  ['proposal_valid', 'workflow_interrupted'],
];

for (const [outcomeClass, expectedError] of RECOVERY_OUTCOME_CASES) {
  test(`recovery ${outcomeClass} -> ${expectedError}`, async () => {
    await fixture(({ store, databasePath }) => {
      const { attempt } = preparedAttempt(store);
      recordResult(store, attempt, outcomeClass);
      const durableBefore = {
        attempts: tableRows(databasePath, 'project_task_execution_launch_attempts'),
        results: tableRows(databasePath, 'project_task_execution_launch_results'),
        leases: tableRows(databasePath, 'project_task_lease_generations'),
        dispatch: tableRows(databasePath, 'project_task_dispatch_outbox'),
      };
      const result = store.reconcileRestartSafeTasks();
      assert.deepEqual(result, { preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0, resumableAvailable: 0 });
      const task = store.get(TASK_A);
      assert.equal(task.status, 'failed');
      assert.equal(task.error.code, expectedError);
      assert.equal(task.error.message, SAFE_TASK_ERROR_MESSAGES[expectedError]);
      // Zero new attempt/result/lease/dispatch manufacturing.
      assert.deepEqual(tableRows(databasePath, 'project_task_execution_launch_attempts'), durableBefore.attempts);
      assert.deepEqual(tableRows(databasePath, 'project_task_execution_launch_results'), durableBefore.results);
      assert.deepEqual(tableRows(databasePath, 'project_task_lease_generations'), durableBefore.leases);
      assert.deepEqual(tableRows(databasePath, 'project_task_dispatch_outbox'), durableBefore.dispatch);
    });
  });
}

test('50. recovery is idempotent after DB reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-recovery-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const { attempt } = preparedAttempt(first);
    recordResult(first, attempt, 'timeout');
    assert.deepEqual(first.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 1, terminalUnchanged: 0, resumableAvailable: 0,
    });
    const failed = first.get(TASK_A);
    assert.equal(failed.error.code, 'timeout');
    assert.deepEqual(first.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 1, resumableAvailable: 0,
    });
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.deepEqual(reopened.get(TASK_A), failed);
    assert.deepEqual(reopened.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 1, resumableAvailable: 0,
    });
    assert.equal(reopened.readTaskExecutionLaunchResultByTask(TASK_A).outcomeClass, 'timeout');
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('51. corrupt result relationship rolls back recovery atomically', async () => {
  await fixture(async ({ store, databasePath }) => {
    // TASK_A has a valid attempt + result; TASK_B is a would-fail plain task.
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'proposal_valid');
    const db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER project_task_execution_launch_results_immutable_update');
    db.prepare('UPDATE project_task_execution_launch_results SET recorded_at = ? WHERE task_id = ?')
      .run(attempt.boundaryCrossedAt - 1, TASK_A);
    db.close();
    assert.throws(
      () => store.reconcileRestartSafeTasks(),
      /corrupt_project_task_execution_launch_result_record/,
    );
    // Nothing was mutated: both tasks remain accepted.
    assert.equal(store.get(TASK_A).status, 'accepted');
    assert.equal(store.get(TASK_B).status, 'accepted');
    const check = new DatabaseSync(databasePath);
    assert.equal(check.prepare('SELECT status FROM project_tasks WHERE task_id = ?').get(TASK_A).status, 'accepted');
    check.close();
  }, { twoTasks: true });
});

test('52. terminal task with result remains unchanged', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'proposal_valid');
    store.complete(TASK_A, { executionId: 'exec', status: 'verified', resultText: 'done' });
    const before = store.get(TASK_A);
    const resultBefore = tableRows(databasePath, 'project_task_execution_launch_results');
    assert.deepEqual(store.reconcileRestartSafeTasks(), {
      preservedRecoverable: 0, failedInterrupted: 0, terminalUnchanged: 1, resumableAvailable: 0,
    });
    assert.deepEqual(store.get(TASK_A), before);
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_launch_results'), resultBefore);
  });
});

// ===========================================================================
// 53-57. Runner re-entry with durable evidence.
// ===========================================================================
test('53. runner replay with a known failure result calls zero Hermes', async () => {
  await fixture(async ({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'timeout');
    const durableBefore = snapshot(databasePath);
    let hermesCalls = 0;
    let codexCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: async () => { codexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'timeout');
    assert.equal(hermesCalls, 0);
    assert.equal(codexCalls, 0);
    assert.deepEqual(snapshot(databasePath), durableBefore);
  });
});

test('54. runner replay with proposal_valid calls zero Hermes and zero Codex', async () => {
  await fixture(async ({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'proposal_valid');
    const durableBefore = snapshot(databasePath);
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
    assert.deepEqual(snapshot(databasePath), durableBefore);
  });
});

test('55. existing Launch Attempt without result still reports unknown', async () => {
  await fixture(async ({ store }) => {
    preparedAttempt(store); // attempt only, no result
    let hermesCalls = 0;
    let codexCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: async () => { codexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(hermesCalls, 0);
    assert.equal(codexCalls, 0);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
    assert.equal(store.listTaskExecutionLaunchResults(10).length, 0);
  });
});

test('56. result does not create retry permission', async () => {
  await fixture(async ({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    recordResult(store, attempt, 'execution_failed');
    const attemptsBefore = tableRows(databasePath, 'project_task_execution_launch_attempts');
    const resultsBefore = tableRows(databasePath, 'project_task_execution_launch_results');
    const leasesBefore = tableRows(databasePath, 'project_task_lease_generations');
    await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: { executeHermes: hermesOk, executeCodex: codexOk },
    }));
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_launch_attempts'), attemptsBefore);
    assert.deepEqual(tableRows(databasePath, 'project_task_execution_launch_results'), resultsBefore);
    assert.deepEqual(tableRows(databasePath, 'project_task_lease_generations'), leasesBefore);
  });
});

test('57. result does not create an exactly-once claim', async () => {
  await fixture(({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store);
    const first = recordResult(store, attempt, 'proposal_valid');
    const replay = recordResult(store, attempt, 'proposal_valid');
    assert.equal(replay.created, false);
    assert.equal(replay.launchResult.launchResultId, first.launchResult.launchResultId);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 1);
    const serialized = JSON.stringify(first.launchResult);
    for (const forbidden of ['exactlyOnce', 'exactly_once', 'claim', 'retry', 'resume', 'authorized', 'approved', 'capabilit']) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  });
});

// ===========================================================================
// 58-60. Scope guards.
// ===========================================================================
test('58. Schema V12 only adds state/evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-scope-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 17);
    assert.equal(store.readTaskExecutionLaunchResultByTask(TASK_A), undefined);
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project_task_execution_launch_results').get().total, 0);
    const columns = db.prepare('PRAGMA table_info(project_task_execution_launch_results)').all().map((row) => row.name);
    assert.deepEqual(columns, [
      'launch_result_id', 'launch_attempt_id', 'invocation_id', 'execution_run_id',
      'task_id', 'outcome_class', 'recorded_at',
    ]);
    db.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('59. no generic /api/hermes/query modification', async () => {
  const source = await readFile(new URL('../src/routes/hermesQuery.ts', import.meta.url), 'utf8');
  for (const forbidden of ['launchResult', 'launch_result', 'launchAttempt', 'launch_attempt', 'execution_run', 'invocation']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('60. no push/merge/deploy/production integration', async () => {
  // Layer 12 additions introduce no deployment/remote-execution machinery and
  // no process spawning.
  const cleanFiles = [
    '../src/contracts/projectTaskExecutionLaunchResult.ts',
    '../src/contracts/projectTaskDurableExecution.ts',
    '../src/contracts/projectTaskWorkflow.ts',
    '../src/services/projectTaskWorkflowService.ts',
    '../src/services/projectTaskDurableExecutionRunner.ts',
  ];
  for (const file of cleanFiles) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(push|merge|deploy|production)\b/i, file);
    assert.doesNotMatch(source, /child_process|spawn\(|execSync|runuser/i, file);
  }
  // The schema/store may only mention those words inside the pre-existing
  // defensive instruction guards (NOT LIKE ... '%deploy%') or the Layer 13
  // SNAPSHOT_BLOCKED_ACTIONS inert validation allowlist (a constant definition
  // and its array elements; never execution machinery).
  for (const file of [
    '../src/services/projectTaskSqliteSchema.ts',
    '../src/services/projectTaskSqliteStore.ts',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      // Match push/merge/deploy/production only as standalone words, not as
      // JavaScript method calls (e.g. actions.push(...)) or property access.
      if (/\b(?<!\.)(push|merge|deploy|production)\b/i.test(line)) {
        assert.match(line, /NOT LIKE|SNAPSHOT_BLOCKED_ACTIONS|production_write|database_write|secret_access/, `${file}:${index + 1} must only be a guard or inert allowlist`);
      }
    });
  }
});

// ===========================================================================
// Adversarial extras.
// ===========================================================================
test('A1. recording after the task is terminal fails closed', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    store.complete(TASK_A, { executionId: 'exec', status: 'verified', resultText: 'done' });
    assert.throws(
      () => recordResult(store, attempt, 'proposal_valid'),
      /project_task_execution_launch_result_incompatible/,
    );
  });
});

test('A2. workflow without the result callback keeps legacy behavior', async () => {
  const fake = workflowHarness();
  delete fake.dependencies.recordExternalLaunchResult;
  const result = await runWorkflow(fake.dependencies);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.recorded, []);
  assert.equal(fake.calls.codex, 1);
});

test('A3. a failed local continuation after recorded proposal_valid leaves the evidence intact and re-entry surfaces local_resume_available', async () => {
  await fixture(async ({ store }) => {
    // First live run: Hermes succeeds (proposal_valid + snapshot are durably
    // recorded atomically by Layer 13), Codex then fails locally. The runner
    // returns the Codex failure.
    const firstRun = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: hermesOk,
        executeCodex: async () => { throw new Error('PRIVATE codex crash'); },
      },
    }));
    assert.equal(firstRun.ok, false);
    assert.equal(firstRun.error, 'codex_execution_failed');
    const result = store.readTaskExecutionLaunchResultByTask(TASK_A);
    assert.ok(result !== undefined);
    assert.equal(result.outcomeClass, 'proposal_valid');

    // Re-entry: proposal_valid + validated snapshot + pre-Codex durable state
    // => local_resume_available. The task remains resumable (NOT terminalized),
    // with zero Hermes, zero Codex, zero new Launch Attempt, no automatic
    // Codex replay. Fresh LÍA policy reevaluation is mandatory before any
    // future continuation. The existing result and snapshot evidence are
    // unchanged.
    let hermesCalls = 0;
    let codexCalls = 0;
    const replay = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: async () => { codexCalls += 1; return codexOk(); },
      },
    }));
    assert.equal(replay.ok, false);
    assert.equal(replay.error, 'local_resume_available');
    assert.equal(hermesCalls, 0);
    assert.equal(codexCalls, 0);
    assert.equal(store.listTaskExecutionLaunchAttempts(10).length, 1);
    assert.equal(store.listTaskExecutionLaunchResults(10).length, 1);
  });
});

test('A4. gate rejection manufactures zero result rows', async () => {
  await fixture(async ({ store, databasePath }) => {
    const { attempt } = preparedAttempt(store, TASK_A, 'pre-worker');
    void attempt;
    let hermesCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, {
      workflowDependencies: {
        executeHermes: async () => { hermesCalls += 1; return hermesOk(); },
        executeCodex: codexOk,
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'external_launch_outcome_unknown');
    assert.equal(hermesCalls, 0);
    assert.equal(tableRows(databasePath, 'project_task_execution_launch_results').length, 0);
  });
});

test('A5. replay after lease release, expiry and DB reopen returns the same immutable row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-triple-replay-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const prepared = preparedAttempt(first);
    const recorded = recordResult(first, prepared.attempt, 'invalid_hermes_proposal');
    first.releaseTaskLease({
      taskId: TASK_A, leaseOwner: prepared.lease.leaseOwner,
      leaseId: prepared.lease.leaseId, fencingToken: prepared.lease.fencingToken,
    });
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 400_000 });
    const replay = recordResult(reopened, prepared.attempt, 'invalid_hermes_proposal');
    assert.equal(replay.created, false);
    assert.deepEqual(replay.launchResult, recorded.launchResult);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A6. contradictory replay after DB reopen fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-launch-result-contradict-reopen-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const first = new ProjectTaskSqliteStore({ databasePath, now: () => 1_000 });
    first.createOrGet(TASK_A, 'fp-a', intent);
    const prepared = preparedAttempt(first);
    recordResult(first, prepared.attempt, 'proposal_valid');
    first.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 9_000 });
    assert.throws(
      () => recordResult(reopened, prepared.attempt, 'timeout'),
      /project_task_execution_launch_result_contradictory/,
    );
    assert.throws(
      () => recordResult(reopened, prepared.attempt, 'proposal_valid', { taskId: TASK_B }),
      /project_task_execution_launch_result_contradictory/,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A7. reads by missing and malformed ids behave safely', async () => {
  await fixture(({ store }) => {
    const { attempt } = preparedAttempt(store);
    const { launchResult } = recordResult(store, attempt, 'empty_response');
    assert.equal(store.readTaskExecutionLaunchResult(UNKNOWN), undefined);
    assert.equal(store.readTaskExecutionLaunchResultByLaunchAttempt(UNKNOWN), undefined);
    assert.equal(store.readTaskExecutionLaunchResultByInvocation(UNKNOWN), undefined);
    assert.equal(store.readTaskExecutionLaunchResultByTask(TASK_B), undefined);
    for (const read of [
      () => store.readTaskExecutionLaunchResult('bad'),
      () => store.readTaskExecutionLaunchResultByLaunchAttempt('bad'),
      () => store.readTaskExecutionLaunchResultByInvocation('bad'),
      () => store.readTaskExecutionLaunchResultByTask('bad'),
    ]) {
      assert.throws(read, /invalid_project_task_execution_launch_result_input/);
    }
    assert.equal(store.readTaskExecutionLaunchResult(launchResult.launchResultId).outcomeClass, 'empty_response');
  });
});
