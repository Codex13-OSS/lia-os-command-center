import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';
import { canonicalizeValidatedProposal } from '../dist/services/projectValidatedProposalSnapshotCanonicalization.js';

const TASK_A = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';

const intent = {
  projectId: 'safe',
  instruction: 'Layer 14 resume decision test.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'],
};

const registry = {
  read: async () => [{
    projectId: 'safe',
    displayName: 'Safe Project',
    repositoryRoot: '/safe/repo',
    enabled: true,
  }],
};

async function withStore(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-resume-decision-'));
  const databasePath = join(directory, 'tasks.sqlite');
  const store = new ProjectTaskSqliteStore({ databasePath, now: () => Date.now() });
  try {
    await fn(store, databasePath);
  } finally {
    if (store.isOpen !== false) store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function createResumableTask(store, taskId = TASK_A) {
  store.createOrGet(taskId, 'fp-a', intent);
  // Create dispatch + lease + run + invocation + launch attempt for pre-Codex task
  const dispatch = store.enqueueTaskDispatch(taskId);
  const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner: 'test-worker', durationMs: 60_000 });
  const run = store.prepareTaskExecutionRun({
    dispatchId: dispatch.dispatchId, taskId,
    leaseOwner: claim.lease.leaseOwner, leaseId: claim.lease.leaseId, fencingToken: claim.lease.fencingToken,
  });
  const invocation = store.reserveTaskExecutionInvocation({
    executionRunId: run.executionRunId, taskId,
    leaseOwner: claim.lease.leaseOwner, leaseId: claim.lease.leaseId, fencingToken: claim.lease.fencingToken,
  });
  const attempt = store.beginTaskExecutionLaunchAttempt({
    invocationId: invocation.invocationId, executionRunId: run.executionRunId, taskId,
    leaseOwner: claim.lease.leaseOwner, leaseId: claim.lease.leaseId, fencingToken: claim.lease.fencingToken,
  });
  // Record a validated proposal snapshot using the canonical form
  const proposal = {
    summary: 'Safe analysis',
    steps: [{ id: 's1', title: 'Inspect', objective: 'Read-only', role: 'implementer', dependsOn: [], requiredCapabilities: ['repository_read'] }],
    executionMode: 'direct',
    completionMode: 'analyze',
    requiresHumanApproval: false,
    blockedActions: [],
  };
  const canonical = canonicalizeValidatedProposal(proposal);
  const result = store.recordValidatedProposalResult({
    launchAttemptId: attempt.launchAttempt.launchAttemptId,
    invocationId: invocation.invocationId,
    executionRunId: run.executionRunId,
    taskId,
    canonicalProposalJson: canonical.canonicalJson,
    proposalSha256: canonical.sha256,
    executionMode: proposal.executionMode,
    completionMode: proposal.completionMode,
    requiresHumanApproval: proposal.requiresHumanApproval,
    blockedActions: proposal.blockedActions,
  });
  // Transition to hermes (pre-Codex)
  store.transition(taskId, 'planning');
  store.transition(taskId, 'hermes');
  return { taskId, dispatch, claim, run, invocation, attempt, result, proposal, sha256: canonical.sha256 };
}

test('Layer 14 resume decision: record and read approved decision', async () => {
  await withStore(async (store) => {
    const { result, sha256 } = createResumableTask(store);

    const decision = store.recordResumeDecision({
      taskId: TASK_A,
      snapshotId: result.snapshot.snapshotId,
      decision: 'approved',
      policyFingerprint: 'a'.repeat(64),
    });

    assert.equal(decision.created, true);
    assert.equal(decision.decision.decision, 'approved');
    assert.equal(decision.decision.taskId, TASK_A);
    assert.equal(decision.decision.snapshotId, result.snapshot.snapshotId);
    assert.equal(decision.decision.refusalReason, undefined);

    // Read back
    const read = store.readResumeDecisionByTask(TASK_A);
    assert.deepEqual(read, decision.decision);
    assert.equal(store.readResumeDecisionBySnapshot(result.snapshot.snapshotId).decisionId, decision.decision.decisionId);
  });
});

test('Layer 14 resume decision: record and read refused decision', async () => {
  await withStore(async (store) => {
    const { result } = createResumableTask(store);

    const decision = store.recordResumeDecision({
      taskId: TASK_A,
      snapshotId: result.snapshot.snapshotId,
      decision: 'refused',
      refusalReason: 'human_approval_required',
      policyFingerprint: 'b'.repeat(64),
    });

    assert.equal(decision.created, true);
    assert.equal(decision.decision.decision, 'refused');
    assert.equal(decision.decision.refusalReason, 'human_approval_required');

    const read = store.readResumeDecisionByTask(TASK_A);
    assert.equal(read.decision, 'refused');
  });
});

test('Layer 14 resume decision: exact replay is idempotent', async () => {
  await withStore(async (store) => {
    const { result } = createResumableTask(store);

    const first = store.recordResumeDecision({
      taskId: TASK_A,
      snapshotId: result.snapshot.snapshotId,
      decision: 'approved',
      policyFingerprint: 'c'.repeat(64),
    });
    assert.equal(first.created, true);

    // Exact same call returns the existing record
    const second = store.recordResumeDecision({
      taskId: TASK_A,
      snapshotId: result.snapshot.snapshotId,
      decision: 'approved',
      policyFingerprint: 'c'.repeat(64),
    });
    assert.equal(second.created, false);
    assert.deepEqual(second.decision, first.decision);
  });
});

test('Layer 14 resume decision: contradictory decision throws', async () => {
  await withStore(async (store) => {
    const { result } = createResumableTask(store);

    store.recordResumeDecision({
      taskId: TASK_A,
      snapshotId: result.snapshot.snapshotId,
      decision: 'approved',
      policyFingerprint: 'd'.repeat(64),
    });

    assert.throws(
      () => store.recordResumeDecision({
        taskId: TASK_A,
        snapshotId: result.snapshot.snapshotId,
        decision: 'refused',
        refusalReason: 'human_approval_required',
        policyFingerprint: 'e'.repeat(64),
      }),
      /project_task_resume_decision_contradictory/,
    );
  });
});

test('Layer 14 resume decision: should enforce immutable update trigger', async () => {
  await withStore(async (store, databasePath) => {
    const { result } = createResumableTask(store);

    store.recordResumeDecision({
      taskId: TASK_A,
      snapshotId: result.snapshot.snapshotId,
      decision: 'approved',
      policyFingerprint: 'f'.repeat(64),
    });

    // Try to update directly through SQL
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare('UPDATE project_task_resume_decisions SET decision = ? WHERE task_id = ?').run('refused', TASK_A),
      /project_task_resume_decision_immutable/,
    );
    db.close();
  });
});

test('Layer 14 resume decision: should enforce immutable delete trigger', async () => {
  await withStore(async (store, databasePath) => {
    const { result } = createResumableTask(store);

    store.recordResumeDecision({
      taskId: TASK_A,
      snapshotId: result.snapshot.snapshotId,
      decision: 'approved',
      policyFingerprint: 'f'.repeat(64),
    });

    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare('DELETE FROM project_task_resume_decisions WHERE task_id = ?').run(TASK_A),
      /project_task_resume_decision_immutable/,
    );
    db.close();
  });
});

test('Layer 14 resume decision: should reject tasks with terminal status', async () => {
  await withStore(async (store) => {
    const { result } = createResumableTask(store);
    store.complete(TASK_A, { executionId: 'exec-1', status: 'committed', resultText: 'done' });

    assert.throws(
      () => store.recordResumeDecision({
        taskId: TASK_A,
        snapshotId: result.snapshot.snapshotId,
        decision: 'approved',
        policyFingerprint: '0'.repeat(64),
      }),
      /project_task_resume_decision_task_not_resumable/,
    );
  });
});

test('Layer 14 resume decision: should reject tasks without snapshot', async () => {
  await withStore(async (store) => {
    // Task in pre-Codex state but no snapshot
    store.createOrGet(TASK_A, 'fp-no-snapshot', intent);
    store.transition(TASK_A, 'planning');
    store.transition(TASK_A, 'hermes');

    assert.throws(
      () => store.recordResumeDecision({
        taskId: TASK_A,
        snapshotId: '00000000-0000-4000-8000-000000000000',
        decision: 'approved',
        policyFingerprint: '1'.repeat(64),
      }),
      /snapshot_not_found/,
    );
  });
});

test('Layer 14 resume decision: policy fingerprint must be valid sha256', async () => {
  await withStore(async (store) => {
    const { result } = createResumableTask(store);

    assert.throws(
      () => store.recordResumeDecision({
        taskId: TASK_A,
        snapshotId: result.snapshot.snapshotId,
        decision: 'approved',
        policyFingerprint: 'not-a-valid-hash',
      }),
      /invalid_input/,
    );
  });
});

test('Layer 14 resume decision: refusal reason required for refused, forbidden for approved', async () => {
  await withStore(async (store) => {
    const { result } = createResumableTask(store);

    // Refused without reason
    assert.throws(
      () => store.recordResumeDecision({
        taskId: TASK_A,
        snapshotId: result.snapshot.snapshotId,
        decision: 'refused',
        policyFingerprint: '2'.repeat(64),
      }),
      /invalid_input/,
    );

    // Approved with reason
    assert.throws(
      () => store.recordResumeDecision({
        taskId: TASK_A,
        snapshotId: result.snapshot.snapshotId,
        decision: 'approved',
        refusalReason: 'human_approval_required',
        policyFingerprint: '3'.repeat(64),
      }),
      /invalid_input/,
    );
  });
});

test('Layer 14 resume decision: list decisions respects limit', async () => {
  await withStore(async (store) => {
    const { result: r1 } = createResumableTask(store);

    // Create second task
    store.createOrGet(TASK_B, 'fp-b', intent);
    const dispatch2 = store.enqueueTaskDispatch(TASK_B);
    const claim2 = store.claimTaskDispatch({ dispatchId: dispatch2.dispatchId, leaseOwner: 'test-worker', durationMs: 60_000 });
    const run2 = store.prepareTaskExecutionRun({
      dispatchId: dispatch2.dispatchId, taskId: TASK_B,
      leaseOwner: claim2.lease.leaseOwner, leaseId: claim2.lease.leaseId, fencingToken: claim2.lease.fencingToken,
    });
    const inv2 = store.reserveTaskExecutionInvocation({
      executionRunId: run2.executionRunId, taskId: TASK_B,
      leaseOwner: claim2.lease.leaseOwner, leaseId: claim2.lease.leaseId, fencingToken: claim2.lease.fencingToken,
    });
    const att2 = store.beginTaskExecutionLaunchAttempt({
      invocationId: inv2.invocationId, executionRunId: run2.executionRunId, taskId: TASK_B,
      leaseOwner: claim2.lease.leaseOwner, leaseId: claim2.lease.leaseId, fencingToken: claim2.lease.fencingToken,
    });
    const proposal = {
      summary: 'Test', steps: [{ id: 's1', title: 'Test', objective: 'Test', role: 'implementer', dependsOn: [], requiredCapabilities: ['repository_read'] }],
      executionMode: 'direct', completionMode: 'analyze', requiresHumanApproval: false, blockedActions: [],
    };
    const r2 = store.recordValidatedProposalResult({
      launchAttemptId: att2.launchAttempt.launchAttemptId,
      invocationId: inv2.invocationId, executionRunId: run2.executionRunId, taskId: TASK_B,
      canonicalProposalJson: canonicalizeValidatedProposal(proposal).canonicalJson,
      proposalSha256: canonicalizeValidatedProposal(proposal).sha256,
      executionMode: 'direct', completionMode: 'analyze',
      requiresHumanApproval: false, blockedActions: [],
    });
    store.transition(TASK_B, 'planning');
    store.transition(TASK_B, 'hermes');

    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: r1.snapshot.snapshotId, decision: 'approved', policyFingerprint: '4'.repeat(64),
    });
    store.recordResumeDecision({
      taskId: TASK_B, snapshotId: r2.snapshot.snapshotId, decision: 'refused',
      refusalReason: 'blocked_actions', policyFingerprint: '5'.repeat(64),
    });

    const list = store.listResumeDecisions(10);
    assert.equal(list.length, 2);
    assert.equal(list[0].taskId, TASK_A);
    assert.equal(list[1].taskId, TASK_B);
  });
});

test('Layer 14 resume decision: recovery V14 migration does not manufacture rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-resume-decision-v14-migration-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    // Create a V13 store
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    // Schema version should be V14
    assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 18);
    // Table should exist
    const db = new DatabaseSync(databasePath);
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_task_resume_decisions'").get();
    assert.ok(tableCheck !== undefined);
    // Should be empty
    const count = db.prepare('SELECT COUNT(*) as cnt FROM project_task_resume_decisions').get();
    assert.equal(count.cnt, 0);
    db.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 14 resume decision: recovery handles corrupt resume decision fail-closed', async () => {
  await withStore(async (store, databasePath) => {
    const { result } = createResumableTask(store);

    // Record a valid resume decision first
    store.recordResumeDecision({
      taskId: TASK_A,
      snapshotId: result.snapshot.snapshotId,
      decision: 'approved',
      policyFingerprint: '1'.repeat(64),
    });
    store.close();

    // Corrupt the existing decision: drop the immutable_update trigger so the
    // row can be modified, enable PRAGMA ignore_check_constraints to bypass
    // CHECK constraints, then mutate the row into an invalid shape.
    const db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER project_task_resume_decisions_immutable_update');
    db.exec('PRAGMA ignore_check_constraints = ON');
    // Change to refused with NULL refusal_reason (invalid for 'refused')
    const updated = db.prepare(
      'UPDATE project_task_resume_decisions SET decision = ?, refusal_reason = NULL WHERE task_id = ?',
    ).run('refused', TASK_A);
    assert.equal(Number(updated.changes), 1);
    db.close();

    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => 2000 });
    try {
      assert.throws(
        () => reopened.reconcileRestartSafeTasks(),
        /corrupt_record/,
      );
    } finally {
      reopened.close();
    }
  });
});

test('Layer 14 resume decision: snapshot idempotency — same snapshot cannot have two decisions', async () => {
  await withStore(async (store) => {
    const { result } = createResumableTask(store);

    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: result.snapshot.snapshotId, decision: 'approved', policyFingerprint: '6'.repeat(64),
    });

    // Same snapshot with a second decision (should fail via UNIQUE constraint on snapshot_id)
    assert.throws(
      () => store.recordResumeDecision({
        taskId: TASK_A, snapshotId: result.snapshot.snapshotId, decision: 'refused',
        refusalReason: 'human_approval_required', policyFingerprint: '7'.repeat(64),
      }),
      /contradictory/,
    );
  });
});

test('Layer 14 resume decision: invalid input validation', async () => {
  await withStore(async (store) => {
    const { result } = createResumableTask(store);

    // Missing fields
    assert.throws(() => store.recordResumeDecision({}), /invalid_input/);
    assert.throws(() => store.recordResumeDecision({ taskId: TASK_A }), /invalid_input/);

    // Invalid decision value
    assert.throws(() => store.recordResumeDecision({
      taskId: TASK_A, snapshotId: result.snapshot.snapshotId, decision: 'invalid',
      policyFingerprint: '8'.repeat(64),
    }), /invalid_input/);

    // Read non-existent
    assert.equal(store.readResumeDecision('00000000-0000-4000-8000-000000000000'), undefined);
  });
});
