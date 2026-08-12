import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import {
  PROJECT_TASK_SQLITE_SCHEMA_V16_VERSION,
  PROJECT_TASK_SQLITE_SCHEMA_V18_VERSION,
  PROJECT_TASK_SQLITE_SCHEMA_VERSION,
} from '../dist/services/projectTaskSqliteSchema.js';

const IDS = Array.from({ length: 30 }, (_, index) =>
  `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, '0')}`,
);
const intent = (instruction = 'Layer 18 test task.') => ({
  projectId: 'safe',
  instruction,
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'run_tests', 'local_commit'],
});
const analyzedIntent = (instruction = 'Analyze-only task.') => ({
  projectId: 'safe',
  instruction,
  priority: 'normal',
  requestedCapabilities: [],
});
const receipt = (status = 'committed') => ({
  executionId: 'test-exec',
  status,
  resultText: 'Test completed successfully.',
  ...(status === 'verified' || status === 'committed' ? { verification: { status: 'verified', checksPassed: 10, totalChecks: 10 } } : {}),
  ...(status === 'committed' ? { commit: 'a'.repeat(40) } : {}),
});

async function withDatabase(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-layer18-'));
  const databasePath = join(directory, 'tasks.sqlite');
  let now = options.now ?? 1_000;
  const store = new ProjectTaskSqliteStore({ databasePath, now: () => now });
  try {
    await fn({ store, databasePath, setNow(value) { now = value; } });
  } finally {
    if (store.isOpen !== false) store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function create(store, id, req = intent()) {
  store.createOrGet(id, `fp-${id}`, req);
}

function setupFullLineage(store, taskId, options = {}) {
  const {
    status = 'commit',
    codexOutcome = 'codex_success',
    verifyStatus = 'verified',
    commitStatus = 'committed',
    commitSha = 'a'.repeat(40),
  } = options;

  const lease = store.acquireTaskLease({ taskId, leaseOwner: 'test-worker', durationMs: 60_000 });
  const dispatch = store.enqueueTaskDispatch(taskId);
  const claim = store.claimTaskDispatch({
    dispatchId: dispatch.dispatchId,
    leaseOwner: lease.leaseOwner,
    durationMs: 60_000,
  });
  const runRecord = store.prepareTaskExecutionRun({
    dispatchId: claim.dispatch.dispatchId,
    taskId,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const invocation = store.reserveTaskExecutionInvocation({
    executionRunId: runRecord.executionRunId,
    taskId,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const attemptResult = store.beginTaskExecutionLaunchAttempt({
    invocationId: invocation.invocationId,
    executionRunId: runRecord.executionRunId,
    taskId,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const attempt = attemptResult.launchAttempt;
  // Transition task to appropriate stage
  if (status === 'planning' || status === 'hermes' || status === 'codex' || status === 'verification' || status === 'commit') {
    store.transition(taskId, 'planning');
  }
  if (status === 'hermes' || status === 'codex' || status === 'verification' || status === 'commit') {
    store.transition(taskId, 'hermes');
  }

  // recordValidatedProposalResult atomically creates both the launch result
  // and the validated proposal snapshot. Do NOT create a separate launch result.
  const proposalJson = JSON.stringify({
    executionMode: 'direct',
    completionMode: 'complete',
    requiresHumanApproval: false,
    blockedActions: [],
  });
  const snapshotResult = store.recordValidatedProposalResult({
    launchAttemptId: attempt.launchAttemptId,
    invocationId: invocation.invocationId,
    executionRunId: runRecord.executionRunId,
    taskId,
    canonicalProposalJson: proposalJson,
    proposalSha256: createHash('sha256').update(proposalJson).digest('hex'),
    executionMode: 'direct',
    completionMode: 'complete',
    requiresHumanApproval: false,
    blockedActions: [],
  });
  const snapshot = snapshotResult.snapshot;
  const launchResult = store.readTaskExecutionLaunchResultByLaunchAttempt(attempt.launchAttemptId);

  let codexStart;
  if (status === 'codex' || status === 'verification' || status === 'commit') {
    store.transition(taskId, 'codex');
    codexStart = store.recordCodexStartEvidence({
      taskId,
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
    }).codexStart;
    store.recordCodexResultEvidence({
      codexStartId: codexStart.codexStartId,
      executionId: 'test-exec',
      outcome: codexOutcome,
      success: codexOutcome === 'codex_success' ? 1 : 0,
      error: codexOutcome === 'codex_failed' ? 'codex_execution_failed' : null,
      summary: 'Test Codex execution.',
      resultMetadataJson: JSON.stringify({ executionId: 'test-exec' }),
    });
  }

  let verifyStart;
  if (status === 'verification' || status === 'commit') {
    store.transition(taskId, 'verification');
    verifyStart = store.recordVerificationStartEvidence({
      taskId,
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      executionId: 'test-exec',
    }).verificationStart;
    store.recordVerificationResultEvidence({
      verificationStartId: verifyStart.verificationStartId,
      status: verifyStatus,
      checksPassed: 10,
      totalChecks: 10,
      technicalChecksPassed: 5,
      technicalTotalChecks: 5,
      visualChecksPassed: 5,
      visualTotalChecks: 5,
      failureError: verifyStatus === 'verified' ? null : 'check_failed',
      failureSummary: verifyStatus === 'verified' ? null : 'A check failed.',
    });
  }

  let commitStart;
  if (status === 'commit') {
    store.transition(taskId, 'commit');
    commitStart = store.recordCommitStartEvidence({
      taskId,
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      executionId: 'test-exec',
    }).commitStart;
    store.recordCommitResultEvidence({
      commitStartId: commitStart.commitStartId,
      status: commitStatus,
      commitSha: commitStatus === 'committed' ? commitSha : null,
      error: commitStatus === 'committed' ? null : (commitStatus === 'commit_failed' ? 'git_commit_failed' : 'nothing_to_commit'),
      summary: commitStatus === 'committed' ? 'The verified workspace was committed locally.' : 'Commit failed.',
    });
  }

  return { lease, dispatch, claim, runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart };
}

// ============================================================
// T1: Full pipeline — completion evidence with all IDs populated
// ============================================================
test('T1: recordCompletionEvidence records committed receipt with all IDs', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[0]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[0], { status: 'commit' });

    const rec = receipt('committed');
    const result = store.recordCompletionEvidence({
      taskId: IDS[0],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });

    assert.equal(result.created, true);
    assert.equal(result.completionEvidence.taskId, IDS[0]);
    assert.equal(result.completionEvidence.codexStartId, codexStart.codexStartId);
    assert.equal(result.completionEvidence.verificationStartId, verifyStart.verificationStartId);
    assert.equal(result.completionEvidence.commitStartId, commitStart.commitStartId);
    assert.ok(typeof result.completionEvidence.recordedAt === 'number');
  });
});

// ============================================================
// T2: Analyzed flow — no write capability
// ============================================================
test('T2: recordCompletionEvidence for analyzed flow with null verification/commit IDs', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[1], analyzedIntent());
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart } =
      setupFullLineage(store, IDS[1], { status: 'codex' });

    const rec = receipt('analyzed');
    const result = store.recordCompletionEvidence({
      taskId: IDS[1],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: null,
      commitStartId: null,
      receipt: rec,
    });

    assert.equal(result.created, true);
    assert.equal(result.completionEvidence.verificationStartId, null);
    assert.equal(result.completionEvidence.commitStartId, null);
    assert.equal(result.completionEvidence.codexStartId, codexStart.codexStartId);
  });
});

// ============================================================
// T3: Ready-for-review flow
// ============================================================
test('T3: recordCompletionEvidence for ready_for_review flow', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[2]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart } =
      setupFullLineage(store, IDS[2], { status: 'codex' });

    const rec = { ...receipt('ready_for_review'), verification: undefined, commit: undefined };
    const result = store.recordCompletionEvidence({
      taskId: IDS[2],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: null,
      commitStartId: null,
      receipt: rec,
    });

    assert.equal(result.created, true);
    assert.equal(result.completionEvidence.verificationStartId, null);
    assert.equal(result.completionEvidence.commitStartId, null);
  });
});

// ============================================================
// T4: Verified flow — tests passed, no local_commit
// ============================================================
test('T4: recordCompletionEvidence for verified flow with commitStartId=null', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[3]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart } =
      setupFullLineage(store, IDS[3], { status: 'verification' });

    const rec = receipt('verified');
    const result = store.recordCompletionEvidence({
      taskId: IDS[3],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: null,
      receipt: rec,
    });

    assert.equal(result.created, true);
    assert.equal(result.completionEvidence.commitStartId, null);
    assert.equal(result.completionEvidence.verificationStartId, verifyStart.verificationStartId);
  });
});

// ============================================================
// T5: Simulated crash — committed flow, completion evidence bridges gap
// ============================================================
test('T5: restart recovery completes task with valid committed completion evidence', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[4]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[4], { status: 'commit' });

    const rec = receipt('committed');
    store.recordCompletionEvidence({
      taskId: IDS[4],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });

    // Task is NOT completed (simulated crash before store.complete())
    assert.notEqual(store.get(IDS[4]).status, 'completed');

    // Restart recovery should find completion evidence and complete the task
    store.reconcileRestartSafeTasks();

    assert.equal(store.get(IDS[4]).status, 'completed');
    assert.deepEqual(store.get(IDS[4]).receipt, rec);
  });
});

// ============================================================
// T6: Simulated crash — verified flow recovery
// ============================================================
test('T6: restart recovery completes task with valid verified completion evidence', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[5]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart } =
      setupFullLineage(store, IDS[5], { status: 'verification' });

    const rec = receipt('verified');
    store.recordCompletionEvidence({
      taskId: IDS[5],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: null,
      receipt: rec,
    });

    assert.notEqual(store.get(IDS[5]).status, 'completed');
    store.reconcileRestartSafeTasks();
    assert.equal(store.get(IDS[5]).status, 'completed');
    assert.deepEqual(store.get(IDS[5]).receipt, rec);
  });
});

// ============================================================
// T7: Simulated crash — analyzed flow recovery
// ============================================================
test('T7: restart recovery completes task with valid analyzed completion evidence', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[6], analyzedIntent());
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart } =
      setupFullLineage(store, IDS[6], { status: 'codex' });

    const rec = receipt('analyzed');
    store.recordCompletionEvidence({
      taskId: IDS[6],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: null,
      commitStartId: null,
      receipt: rec,
    });

    assert.notEqual(store.get(IDS[6]).status, 'completed');
    store.reconcileRestartSafeTasks();
    assert.equal(store.get(IDS[6]).status, 'completed');
    assert.deepEqual(store.get(IDS[6]).receipt, rec);
  });
});

// ============================================================
// T8: Exact replay idempotency
// ============================================================
test('T8: recordCompletionEvidence is idempotent for identical data', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[7]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[7], { status: 'commit' });

    const rec = receipt('committed');
    const first = store.recordCompletionEvidence({
      taskId: IDS[7],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });

    assert.equal(first.created, true);

    const second = store.recordCompletionEvidence({
      taskId: IDS[7],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });

    assert.equal(second.created, false);
    assert.equal(second.completionEvidence.completionEvidenceId, first.completionEvidence.completionEvidenceId);
  });
});

// ============================================================
// T9: Contradictory replay fails closed
// ============================================================
test('T9: contradictory completion evidence fails closed', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[8]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[8], { status: 'commit' });

    const rec1 = receipt('committed');
    store.recordCompletionEvidence({
      taskId: IDS[8],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec1,
    });

    const rec2 = { ...rec1, status: 'verified', commit: undefined };
    assert.throws(() => {
      store.recordCompletionEvidence({
        taskId: IDS[8],
        executionRunId: runRecord.executionRunId,
        invocationId: invocation.invocationId,
        launchAttemptId: attempt.launchAttemptId,
        launchResultId: launchResult.launchResultId,
        snapshotId: snapshot.snapshotId,
        codexStartId: codexStart.codexStartId,
        verificationStartId: verifyStart.verificationStartId,
        commitStartId: commitStart.commitStartId,
        receipt: rec2,
      });
    }, /contradictory/);
  });
});

// ============================================================
// T10: Corrupt lineage — broken lineage fails closed
// ============================================================
test('T10: restart recovery does NOT complete task with broken lineage', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[9]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[9], { status: 'commit' });

    const rec = receipt('committed');
    // Layer 18 / V17 schema: snapshot_id has a FOREIGN KEY constraint
    // referencing project_task_validated_proposal_snapshots.
    // A forged snapshotId is rejected at INSERT time — the FK catches
    // corrupt lineage before it can ever reach reconciliation.
    assert.throws(() => {
      store.recordCompletionEvidence({
        taskId: IDS[9],
        executionRunId: runRecord.executionRunId,
        invocationId: invocation.invocationId,
        launchAttemptId: attempt.launchAttemptId,
        launchResultId: launchResult.launchResultId,
        snapshotId: '00000000-0000-4000-a000-000000000000', // WRONG snapshot
        codexStartId: codexStart.codexStartId,
        verificationStartId: verifyStart.verificationStartId,
        commitStartId: commitStart.commitStartId,
        receipt: rec,
      });
    }, /FOREIGN KEY/);
  });
});

// ============================================================
// T11: Commit SHA mismatch — cross-validation fails closed
// ============================================================
test('T11: restart recovery does NOT complete when commit SHA mismatches', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[10]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[10], { status: 'commit', commitSha: 'b'.repeat(40) });

    const rec = { ...receipt('committed'), commit: 'c'.repeat(40) }; // Different SHA
    store.recordCompletionEvidence({
      taskId: IDS[10],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });

    store.reconcileRestartSafeTasks();
    // Should NOT be completed — SHA mismatch
    assert.notEqual(store.get(IDS[10]).status, 'completed');
  });
});

// ============================================================
// T12: V16→V18 migration
// ============================================================
test('T12: V16 schema migrates to V18 additively', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-layer18-migrate-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    // Create a V16 database by initializing then setting schema_version back to 16
    let store = new ProjectTaskSqliteStore({ databasePath });
    store.close();

    // Rewind schema_version to V16
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare('UPDATE project_task_meta SET schema_version = ? WHERE singleton = 1').run(PROJECT_TASK_SQLITE_SCHEMA_V16_VERSION);
    } finally {
      db.close();
    }

    // Re-open: should migrate V16→V18
    store = new ProjectTaskSqliteStore({ databasePath });
    try {
      // Verify migration happened
      const dbCheck = new DatabaseSync(databasePath);
      try {
        const meta = dbCheck.prepare('SELECT schema_version FROM project_task_meta WHERE singleton = 1').get();
        assert.equal(meta.schema_version, PROJECT_TASK_SQLITE_SCHEMA_V18_VERSION);
        assert.equal(meta.schema_version, PROJECT_TASK_SQLITE_SCHEMA_VERSION);

        // Verify the table exists
        const tableCheck = dbCheck.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='project_task_completion_evidence'",
        ).get();
        assert.ok(tableCheck !== undefined);

        // Verify index exists
        const indexCheck = dbCheck.prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_project_task_completion_evidence_task'",
        ).get();
        assert.ok(indexCheck !== undefined);
      } finally {
        dbCheck.close();
      }

      // Create a task and verify completion evidence works on migrated DB
      create(store, IDS[11]);
      const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
        setupFullLineage(store, IDS[11], { status: 'commit' });

      const rec = receipt('committed');
      const result = store.recordCompletionEvidence({
        taskId: IDS[11],
        executionRunId: runRecord.executionRunId,
        invocationId: invocation.invocationId,
        launchAttemptId: attempt.launchAttemptId,
        launchResultId: launchResult.launchResultId,
        snapshotId: snapshot.snapshotId,
        codexStartId: codexStart.codexStartId,
        verificationStartId: verifyStart.verificationStartId,
        commitStartId: commitStart.commitStartId,
        receipt: rec,
      });
      assert.equal(result.created, true);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ============================================================
// T13: Resume path completion evidence
// ============================================================
test('T13: completion evidence for status=commit on resume path', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[12]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[12], { status: 'commit' });

    const rec = receipt('committed');
    store.recordCompletionEvidence({
      taskId: IDS[12],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });

    store.reconcileRestartSafeTasks();
    const completed = store.get(IDS[12]);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.receipt, rec);
  });
});

// ============================================================
// T14: Restart with commit + evidence + approved resume decision
// ============================================================
test('T14: restart completes commit task with completion evidence (no Codex/verification/commit replay)', async () => {
  await withDatabase(async ({ store }) => {
    store.createOrGet(IDS[13], `fp-${IDS[13]}`, { ...intent(), requestedCapabilities: ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'] });
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[13], { status: 'commit' });

    const rec = receipt('committed');
    store.recordCompletionEvidence({
      taskId: IDS[13],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });

    store.reconcileRestartSafeTasks();
    assert.equal(store.get(IDS[13]).status, 'completed');
    assert.deepEqual(store.get(IDS[13]).receipt, rec);
  });
});

// ============================================================
// T15: Pre-L18 task (no completion evidence) backward compat
// ============================================================
test('T15: pre-L18 task at commit with success but no completion evidence is preserved as resumable', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[14]);
    setupFullLineage(store, IDS[14], { status: 'commit' });

    // NO completion evidence recorded

    const taskBefore = store.get(IDS[14]);
    assert.equal(taskBefore.status, 'commit');

    const result = store.reconcileRestartSafeTasks();
    // Without completion evidence, existing M6 behavior: preserved resumable,
    // but not added to resumableAvailable counter (it's preserved via codexSuccessTaskIds).
    // The task remains non-terminal at status='commit'.
    assert.equal(result.resumableAvailable, 0);
    const taskAfter = store.get(IDS[14]);
    assert.equal(taskAfter.status, 'commit');
    assert.equal(taskAfter.terminalAt, undefined);
  });
});

// ============================================================
// T16: Guard — hasProjectTaskDurableExecutionPrimitives requires recordCompletionEvidence
// ============================================================
test('T16: durable execution guard requires recordCompletionEvidence', async () => {
  const { hasProjectTaskDurableExecutionPrimitives } = await import('../dist/services/projectTaskDurableExecutionRunner.js');
  // In-memory store without completion evidence should fail
  const minimal = {
    acquireTaskLease: () => {},
    enqueueTaskDispatch: () => {},
    claimTaskDispatch: () => {},
    prepareTaskExecutionRun: () => {},
    reserveTaskExecutionInvocation: () => {},
    beginTaskExecutionLaunchAttempt: () => {},
    recordTaskExecutionLaunchResult: () => {},
    readTaskExecutionLaunchResultByLaunchAttempt: () => {},
    recordValidatedProposalResult: () => {},
    readValidatedProposalSnapshotByLaunchResult: () => {},
    recordResumeDecision: () => {},
    readResumeDecisionByTask: () => {},
    recordCodexStartEvidence: () => {},
    recordCodexResultEvidence: () => {},
    readCodexStartEvidenceByTask: () => {},
    recordVerificationStartEvidence: () => {},
    recordVerificationResultEvidence: () => {},
    readVerificationStartEvidenceByTask: () => {},
    readVerificationResultEvidence: () => {},
    recordCommitStartEvidence: () => {},
    recordCommitResultEvidence: () => {},
    readCommitStartEvidenceByTask: () => {},
    readCommitResultEvidence: () => {},
    // Missing: recordCompletionEvidence and readCompletionEvidence
  };
  assert.equal(hasProjectTaskDurableExecutionPrimitives(minimal), false);
});

// ============================================================
// S2: Completion evidence with committed status but no commitStartId
// ============================================================
test('S2: committed receipt without commitStartId fails closed', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[15]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart } =
      setupFullLineage(store, IDS[15], { status: 'verification' });

    const rec = receipt('committed');
    store.recordCompletionEvidence({
      taskId: IDS[15],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: null, // Missing required commitStartId for committed
      receipt: rec,
    });

    store.reconcileRestartSafeTasks();
    assert.notEqual(store.get(IDS[15]).status, 'completed');
  });
});

// ============================================================
// S4: Two concurrent calls — first writer wins
// ============================================================
test('S4: first writer wins, second gets contradictory', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[16]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[16], { status: 'commit' });

    const rec1 = receipt('committed');
    const result1 = store.recordCompletionEvidence({
      taskId: IDS[16],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec1,
    });
    assert.equal(result1.created, true);

    const rec2 = { ...rec1, executionId: 'different-exec' };
    assert.throws(() => {
      store.recordCompletionEvidence({
        taskId: IDS[16],
        executionRunId: runRecord.executionRunId,
        invocationId: invocation.invocationId,
        launchAttemptId: attempt.launchAttemptId,
        launchResultId: launchResult.launchResultId,
        snapshotId: snapshot.snapshotId,
        codexStartId: codexStart.codexStartId,
        verificationStartId: verifyStart.verificationStartId,
        commitStartId: commitStart.commitStartId,
        receipt: rec2,
      });
    }, /contradictory/);
  });
});

// ============================================================
// S5: Impossible verification totals fail validation
// ============================================================
test('S5: completion evidence with impossible verification fails safe', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[17]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart } =
      setupFullLineage(store, IDS[17], { status: 'verification' });

    const rec = { ...receipt('verified'), verification: { status: 'verified', checksPassed: 100, totalChecks: 50 } };
    assert.throws(() => {
      store.recordCompletionEvidence({
        taskId: IDS[17],
        executionRunId: runRecord.executionRunId,
        invocationId: invocation.invocationId,
        launchAttemptId: attempt.launchAttemptId,
        launchResultId: launchResult.launchResultId,
        snapshotId: snapshot.snapshotId,
        codexStartId: codexStart.codexStartId,
        verificationStartId: verifyStart.verificationStartId,
        commitStartId: null,
        receipt: rec,
      });
    }, /corrupt/);
  });
});

// ============================================================
// S10: Codex failed outcome with verified status
// ============================================================
test('S10: completion evidence with codex_failed but verified status fails closed', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[18]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart } =
      setupFullLineage(store, IDS[18], { status: 'codex', codexOutcome: 'codex_failed' });

    const rec = receipt('verified');
    store.recordCompletionEvidence({
      taskId: IDS[18],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: null,
      commitStartId: null,
      receipt: rec,
    });

    store.reconcileRestartSafeTasks();
    assert.notEqual(store.get(IDS[18]).status, 'completed');
  });
});

// ============================================================
// S12: Exact replay idempotent (same as T8 but from adversarial angle)
// ============================================================
test('S12: replay of identical completion evidence returns already-existing', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[19]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[19], { status: 'commit' });

    const rec = receipt('committed');
    const first = store.recordCompletionEvidence({
      taskId: IDS[19],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });
    assert.equal(first.created, true);

    const second = store.recordCompletionEvidence({
      taskId: IDS[19],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });
    assert.equal(second.created, false);
    assert.ok(first.completionEvidence.completionEvidenceId === second.completionEvidence.completionEvidenceId);
  });
});

// ============================================================
// readCompletionEvidence test
// ============================================================
test('readCompletionEvidence returns recorded evidence', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[20]);
    const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
      setupFullLineage(store, IDS[20], { status: 'commit' });

    const rec = receipt('committed');
    store.recordCompletionEvidence({
      taskId: IDS[20],
      executionRunId: runRecord.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart.codexStartId,
      verificationStartId: verifyStart.verificationStartId,
      commitStartId: commitStart.commitStartId,
      receipt: rec,
    });

    const read = store.readCompletionEvidence(IDS[20]);
    assert.ok(read !== undefined);
    assert.equal(read.taskId, IDS[20]);
    assert.equal(read.codexStartId, codexStart.codexStartId);
  });
});

test('readCompletionEvidence returns undefined for non-existent task', async () => {
  await withDatabase(async ({ store }) => {
    create(store, IDS[21]);
    assert.equal(store.readCompletionEvidence(IDS[21]), undefined);
  });
});

// ============================================================
// Completion evidence is immutable (delete/update triggers)
// ============================================================
test('completion evidence table is immutable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-layer18-immutable-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath });
    try {
      create(store, IDS[22]);
      const { runRecord, invocation, attempt, launchResult, snapshot, codexStart, verifyStart, commitStart } =
        setupFullLineage(store, IDS[22], { status: 'commit' });

      const rec = receipt('committed');
      store.recordCompletionEvidence({
        taskId: IDS[22],
        executionRunId: runRecord.executionRunId,
        invocationId: invocation.invocationId,
        launchAttemptId: attempt.launchAttemptId,
        launchResultId: launchResult.launchResultId,
        snapshotId: snapshot.snapshotId,
        codexStartId: codexStart.codexStartId,
        verificationStartId: verifyStart.verificationStartId,
        commitStartId: commitStart.commitStartId,
        receipt: rec,
      });
    } finally {
      store.close();
    }

    // Try to delete/update directly
    const db = new DatabaseSync(databasePath);
    try {
      assert.throws(() => {
        db.exec("DELETE FROM project_task_completion_evidence");
      }, /immutable/);
      assert.throws(() => {
        db.exec("UPDATE project_task_completion_evidence SET receipt_json = '{}'");
      }, /immutable/);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
