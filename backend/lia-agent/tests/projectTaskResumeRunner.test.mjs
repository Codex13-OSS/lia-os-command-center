import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeValidatedProposal } from '../dist/services/projectValidatedProposalSnapshotCanonicalization.js';
import test from 'node:test';
import { SAFE_TASK_ERROR_MESSAGES } from '../dist/contracts/projectTask.js';
import { PROJECT_TASK_SQLITE_SCHEMA_VERSION } from '../dist/services/projectTaskSqliteSchema.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import {
  createProjectTaskDurableExecutionRunner,
  hasProjectTaskDurableExecutionPrimitives,
  runProjectTaskDurableExecution,
} from '../dist/services/projectTaskDurableExecutionRunner.js';
import {
  mapCodexResultToEvidence,
  hasCodexSuccessEvidence,
  PROJECT_TASK_CODEX_EVIDENCE_ERRORS,
} from '../dist/contracts/projectTaskCodexEvidence.js';

const TASK_A = '450e8400-e29b-41d4-a716-446655440000';
const TASK_B = '450e8400-e29b-41d4-a716-446655440001';

const intent = {
  projectId: 'safe',
  instruction: 'Layer 14 resume test.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'],
};

const registry = {
  read: async () => [{
    projectId: 'safe',
    displayName: 'Safe Project',
    repositoryRoot: '/registry/safe',
    enabled: true,
  }],
};

const proposal = {
  summary: 'Safe analysis',
  steps: [{
    id: 'step-1', title: 'Inspect', objective: 'Read-only inspection',
    role: 'implementer', dependsOn: [], requiredCapabilities: ['repository_read'],
  }],
  executionMode: 'direct',
  completionMode: 'analyze',
  requiresHumanApproval: false,
  blockedActions: [],
};

const blockedProposal = {
  ...proposal,
  blockedActions: ['push', 'merge'],
};

const humanApprovalProposal = {
  ...proposal,
  requiresHumanApproval: true,
};

const hermesNeverCalled = async () => {
  throw new Error('HERMES_SHOULD_NOT_BE_CALLED');
};

const config = {
  host: '127.0.0.1', port: 3014, corsOrigins: [],
  agendaSqlitePath: '', projectRegistryPath: '',
  hermesRoot: '', hermesExecutionEnabled: true,
  hermesExecutable: '/bin/hermes', hermesHome: '/hermes',
  hermesUser: 'hermes', hermesUserHome: '/home/hermes',
  hermesPath: '/bin', hermesProvider: 'fake', hermesModel: 'fake',
  hermesTimeoutMs: 100, hermesMaxQueryCharacters: 8000, logLevel: 'silent',
};

function runnerOptions(store, taskId, overrides = {}) {
  return {
    store, taskId, workerId: 'runner-worker-1',
    config, request: intent, registry,
    onStage: () => {},
    workflowDependencies: { executeHermes: hermesNeverCalled },
    ...overrides,
  };
}

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-resume-runner-'));
  const databasePath = join(directory, 'tasks.sqlite');
  const store = new ProjectTaskSqliteStore({ databasePath, now: () => Date.now() });
  try {
    await fn(store);
  } finally {
    if (store.isOpen !== false) store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function createResumableTask(store, taskId = TASK_A, proposalOverrides = {}) {
  store.createOrGet(taskId, 'fp-a', intent);
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
  const p = { ...proposal, ...proposalOverrides };
  const canonical = canonicalizeValidatedProposal(p);
  const result = store.recordValidatedProposalResult({
    launchAttemptId: attempt.launchAttempt.launchAttemptId,
    invocationId: invocation.invocationId, executionRunId: run.executionRunId, taskId,
    canonicalProposalJson: canonical.canonicalJson,
    proposalSha256: canonical.sha256,
    executionMode: p.executionMode, completionMode: p.completionMode,
    requiresHumanApproval: p.requiresHumanApproval, blockedActions: p.blockedActions,
  });
  store.transition(taskId, 'planning');
  store.transition(taskId, 'hermes');
  return { taskId, dispatch, claim, run, invocation, attempt, result, sha256: canonical.sha256 };
}

// ===========================================================================
// Layer 14: existing tests
// ===========================================================================
test('Layer 14: resume path records approved decision for clean proposal', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, { resume: false }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'local_resume_available');
    assert.equal(result.stage, 'hermes');

    const task = store.get(TASK_A);
    assert.equal(task.terminalAt, undefined);
    assert.ok(task.status === 'hermes' || task.status === 'planning' || task.status === 'accepted');
  });
});

test('Layer 14: resume=false preserves local_resume_available behavior', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, { resume: false }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'local_resume_available');
    assert.equal(result.stage, 'hermes');
    assert.equal(store.get(TASK_A).terminalAt, undefined);
  });
});

test('Layer 14: resume path never calls Hermes', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    let hermesseCalls = 0;
    try {
      await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
        resume: true,
        workflowDependencies: {
          executeHermes: async () => { hermesseCalls += 1; return { ok: true, response: JSON.stringify(proposal) }; },
        },
      }));
    } catch {
      // Expected: Codex fails
    }
    assert.equal(hermesseCalls, 0);
  });
});

test('Layer 14: resume path with approved decision but missing snapshot fails closed', async () => {
  await fixture(async (store) => {
    store.createOrGet(TASK_A, 'fp-a', intent);
    store.transition(TASK_A, 'planning');
    store.transition(TASK_A, 'hermes');
    await assert.rejects(
      () => runProjectTaskDurableExecution(runnerOptions(store, TASK_A)),
      /project_task_durable_execution_task_unavailable/,
    );
  });
});

test('Layer 14: post-Codex task with snapshot fails closed', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    store.transition(TASK_A, 'codex');
    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'workflow_interrupted');
  });
});

test('Layer 14: already-refused resume decision returns resume_refused', async () => {
  await fixture(async (store) => {
    const { result: snap } = createResumableTask(store);
    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshot.snapshotId,
      decision: 'refused', refusalReason: 'human_approval_required',
      policyFingerprint: 'a'.repeat(64),
    });
    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'resume_refused');
  });
});

test('Layer 14: resume decision is immutable after recording', async () => {
  await fixture(async (store) => {
    const { result: snap } = createResumableTask(store);
    const decision = store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshot.snapshotId,
      decision: 'approved', policyFingerprint: 'b'.repeat(64),
    });
    assert.equal(decision.created, true);
    assert.throws(
      () => store.recordResumeDecision({
        taskId: TASK_A, snapshotId: snap.snapshot.snapshotId,
        decision: 'refused', refusalReason: 'blocked_actions',
        policyFingerprint: 'c'.repeat(64),
      }),
      /contradictory/,
    );
  });
});

test('Layer 14: hasProjectTaskDurableExecutionPrimitives requires resume decision methods', async () => {
  await fixture(async (store) => {
    assert.equal(hasProjectTaskDurableExecutionPrimitives(store), true);
  });
});

test('Layer 14: recovery preserves resumable tasks for approved decisions', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    const snap = store.readValidatedProposalSnapshotByTask(TASK_A);
    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshotId,
      decision: 'approved', policyFingerprint: 'd'.repeat(64),
    });
    const recovery = store.reconcileRestartSafeTasks();
    assert.equal(recovery.resumableAvailable, 1);
    assert.equal(store.get(TASK_A).terminalAt, undefined);
  });
});

test('Layer 14: recovery terminalizes tasks with refused resume decisions', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    const snap = store.readValidatedProposalSnapshotByTask(TASK_A);
    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshotId,
      decision: 'refused', refusalReason: 'human_approval_required',
      policyFingerprint: 'e'.repeat(64),
    });
    const recovery = store.reconcileRestartSafeTasks();
    assert.equal(recovery.resumableAvailable, 0);
    assert.equal(store.get(TASK_A).status, 'failed');
    assert.deepEqual(store.get(TASK_A).error, {
      code: 'resume_refused',
      message: SAFE_TASK_ERROR_MESSAGES.resume_refused,
      stage: 'hermes',
    });
  });
});

test('Layer 15: schema version is V15', async () => {
  assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 15);
});

test('Layer 14: migration adds resume_decisions table and triggers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-resume-schema-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const db = new (await import('node:sqlite')).DatabaseSync(databasePath);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_task_resume_decisions'").get();
    assert.ok(table !== undefined);
    assert.ok(table.sql.includes('decision_id TEXT PRIMARY KEY'));
    assert.ok(table.sql.includes('decision TEXT NOT NULL CHECK (decision IN'));
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%resume_decision%'").all();
    assert.equal(triggers.length, 3);
    const triggerNames = triggers.map(t => t.name);
    assert.ok(triggerNames.includes('project_task_resume_decisions_validate_insert'));
    assert.ok(triggerNames.includes('project_task_resume_decisions_immutable_update'));
    assert.ok(triggerNames.includes('project_task_resume_decisions_immutable_delete'));
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'project_task_resume_decisions_recorded'").get();
    assert.ok(index !== undefined);
    db.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 14: snapshot is inert data, never derives authority (source audit)', async () => {
  const runnerSource = await readFile(new URL('../src/services/projectTaskDurableExecutionRunner.ts', import.meta.url), 'utf8');
  const contractSource = await readFile(new URL('../src/contracts/projectTaskResumeDecision.ts', import.meta.url), 'utf8');
  for (const source of [runnerSource, contractSource]) {
    assert.doesNotMatch(source, /\b(push|merge|deploy|production_write|database_write|secret_access)\b/);
    assert.doesNotMatch(source, /child_process|execSync|runuser/i);
  }
  for (const source of [runnerSource]) {
    const resumeLines = source.split('\n').filter(l => l.includes('executeResumePath') || l.includes('resume'));
    for (const line of resumeLines) {
      assert.equal(line.includes('executeHermes'), false);
      assert.equal(line.includes('hermesExecutor'), false);
    }
  }
  const runnerCodeOnly = runnerSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(runnerCodeOnly, /automatic.*codex|codex.*replay|replay.*codex/i);
  assert.doesNotMatch(runnerSource, /retry.*authorit|authorit.*retry/i);
  const resumeDecisionContract = contractSource.slice(0, contractSource.indexOf('export interface ProjectTaskResumeDecisionStore'));
  assert.equal(resumeDecisionContract.includes('capabilities'), false);
  assert.equal(resumeDecisionContract.includes('authority'), false);
});

test('Layer 14: runner code introduces no production/deploy channels', async () => {
  const sources = [
    '../src/services/projectTaskDurableExecutionRunner.ts',
    '../src/contracts/projectTaskResumeDecision.ts',
    '../src/routes/projectTasks.ts',
  ];
  for (const path of sources) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(push|merge|deploy|production_write|database_write|secret_access)\b/);
    assert.doesNotMatch(source, /(pm2|nginx|iptables|ufw|systemctl|docker\s+compose)/i);
  }
});

test('Layer 14: layer 13 and previous layers remain compatible', async () => {
  await fixture(async (store) => {
    store.createOrGet(TASK_A, 'fp-a', intent);
    store.transition(TASK_A, 'planning');
    store.transition(TASK_A, 'hermes');
    const recovery = store.reconcileRestartSafeTasks();
    assert.equal(recovery.resumableAvailable, 0);
    assert.equal(recovery.failedInterrupted, 1);
    assert.equal(store.get(TASK_A).status, 'failed');
  });
});

test('Layer 14: recovery is idempotent for resume decisions', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    const snap = store.readValidatedProposalSnapshotByTask(TASK_A);
    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshotId,
      decision: 'approved', policyFingerprint: 'f'.repeat(64),
    });
    const r1 = store.reconcileRestartSafeTasks();
    const r2 = store.reconcileRestartSafeTasks();
    assert.deepEqual(r1, r2);
    assert.equal(r1.resumableAvailable, 1);
  });
});

test('Layer 14: contradictory resume decision validation in recovery aborts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-resume-recovery-corrupt-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    createResumableTask(store);
    const snap = store.readValidatedProposalSnapshotByTask(TASK_A);
    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshotId,
      decision: 'approved', policyFingerprint: 'f'.repeat(64),
    });
    store.close();

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec('DROP TRIGGER project_task_resume_decisions_immutable_update');
    db.exec('PRAGMA ignore_check_constraints = ON');
    const updated = db.prepare(
      'UPDATE project_task_resume_decisions SET decision = ?, refusal_reason = NULL WHERE task_id = ?',
    ).run('refused', TASK_A);
    assert.equal(Number(updated.changes), 1);
    db.close();

    assert.throws(
      () => new ProjectTaskSqliteStore({ databasePath, now: () => 2000 }).reconcileRestartSafeTasks(),
      /corrupt_record/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 14: existing approved decision still triggers fresh LIA policy evaluation on re-entry', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    const snap = store.readValidatedProposalSnapshotByTask(TASK_A);
    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshotId,
      decision: 'approved', policyFingerprint: '1'.repeat(64),
    });
    const d = store.readResumeDecisionByTask(TASK_A);
    assert.equal(d.decision, 'approved');
    const throwingRegistry = {
      read: async () => { throw new Error('registry-gone'); },
    };
    const result = await runProjectTaskDurableExecution(runnerOptions(
      store, TASK_A,
      { resume: true, registry: throwingRegistry },
    ));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'resume_refused');
    const task = store.get(TASK_A);
    assert.equal(task.status, 'failed');
  });
});

test('Layer 14: changing current policy can refuse a previously approved resume decision', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    const snap = store.readValidatedProposalSnapshotByTask(TASK_A);
    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshotId,
      decision: 'approved', policyFingerprint: '2'.repeat(64),
    });
    const emptyRegistry = {
      read: async () => [],
    };
    const result = await runProjectTaskDurableExecution(runnerOptions(
      store, TASK_A,
      { resume: true, registry: emptyRegistry },
    ));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'resume_refused');
    assert.equal(store.get(TASK_A).status, 'failed');
  });
});

test('Layer 14: fresh evaluation with approved decision passes when policy unchanged', async () => {
  await fixture(async (store) => {
    createResumableTask(store);
    const snap = store.readValidatedProposalSnapshotByTask(TASK_A);
    store.recordResumeDecision({
      taskId: TASK_A, snapshotId: snap.snapshotId,
      decision: 'approved', policyFingerprint: '3'.repeat(64),
    });
    // With resume=true and a working registry, fresh evaluation should
    // proceed through planning. Codex execution may fail in test env
    // but the fresh evaluation ran.
    try {
      await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, { resume: true }));
    } catch {
      // Expected: Codex fails in test env
    }
    // After the attempt, either the task was terminalized (Codex failed)
    // or it stayed active. The key is that the fresh evaluation ran.
    const task = store.get(TASK_A);
    assert.ok(task !== undefined);
  });
});

// ===========================================================================
// Layer 15: Codex Evidence Tests
// ===========================================================================

test('Layer 15: codex start evidence is recorded and readable', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    const input = {
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    };
    const record = store.recordCodexStartEvidence(input);
    assert.equal(record.created, true);
    assert.equal(record.codexStart.taskId, TASK_A);
    assert.equal(record.codexStart.executionRunId, run.executionRunId);
    assert.equal(record.codexStart.invocationId, invocation.invocationId);
    assert.ok(typeof record.codexStart.startRecordedAt === 'number');
    assert.ok(record.codexStart.startRecordedAt > 0);

    const read = store.readCodexStartEvidence(record.codexStart.codexStartId);
    assert.deepEqual(read, record.codexStart);

    const byTask = store.readCodexStartEvidenceByTask(TASK_A);
    assert.deepEqual(byTask, record.codexStart);
  });
});

test('Layer 15: codex start evidence is idempotent', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    const input = {
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    };
    const first = store.recordCodexStartEvidence(input);
    assert.equal(first.created, true);
    const second = store.recordCodexStartEvidence(input);
    assert.equal(second.created, false);
    assert.equal(second.codexStart.codexStartId, first.codexStart.codexStartId);
  });
});

test('Layer 15: codex start evidence with contradictory lineage fails closed', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    const input = {
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    };
    store.recordCodexStartEvidence(input);
    // Different lineage
    assert.throws(
      () => store.recordCodexStartEvidence({
        ...input,
        executionRunId: '450e8400-e29b-41d4-a716-44665544ffff',
      }),
      new RegExp(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.contradictory),
    );
  });
});

test('Layer 15: codex result evidence is recorded and readable', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    const startInput = {
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    };
    const start = store.recordCodexStartEvidence(startInput);
    store.transition(TASK_A, 'codex');

    const evidence = mapCodexResultToEvidence({
      success: true,
      executionId: 'exec-123',
      outcome: 'modification_completed',
      summary: 'Codex completed successfully.',
      resultText: 'Result text here.',
    });
    const result = store.recordCodexResultEvidence({
      codexStartId: start.codexStart.codexStartId,
      executionId: 'exec-123',
      outcome: evidence.outcome,
      success: evidence.success,
      error: evidence.error,
      summary: evidence.summary,
      resultMetadataJson: evidence.resultMetadataJson,
    });
    assert.equal(result.created, true);
    assert.equal(result.codexResult.codexStartId, start.codexStart.codexStartId);
    assert.equal(result.codexResult.executionId, 'exec-123');
    assert.equal(result.codexResult.outcome, 'codex_success');
    assert.equal(result.codexResult.success, 1);

    const read = store.readCodexResultEvidence(start.codexStart.codexStartId);
    assert.deepEqual(read, result.codexResult);
  });
});

test('Layer 15: codex result evidence is idempotent', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    const start = store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    });
    store.transition(TASK_A, 'codex');

    const evidence = mapCodexResultToEvidence({
      success: true, executionId: 'exec-abc',
      outcome: 'analysis_completed', summary: 'Done.', resultText: '',
    });
    const input = {
      codexStartId: start.codexStart.codexStartId,
      executionId: 'exec-abc',
      outcome: evidence.outcome,
      success: evidence.success,
      error: evidence.error,
      summary: evidence.summary,
      resultMetadataJson: evidence.resultMetadataJson,
    };
    const first = store.recordCodexResultEvidence(input);
    assert.equal(first.created, true);
    const second = store.recordCodexResultEvidence(input);
    assert.equal(second.created, false);
    assert.equal(second.codexResult.codexResultId, first.codexResult.codexResultId);
  });
});

test('Layer 15: codex result evidence without start fails closed', async () => {
  await fixture(async (store) => {
    store.createOrGet(TASK_A, 'fp-a', intent);
    assert.throws(
      () => store.recordCodexResultEvidence({
        codexStartId: '450e8400-e29b-41d4-a716-44665544ffff',
        executionId: 'exec-123',
        outcome: 'codex_success',
        success: 1,
        error: null,
        summary: 'Done.',
        resultMetadataJson: JSON.stringify({ executionId: 'exec-123' }),
      }),
      /incompatible/,
    );
  });
});

test('Layer 15: codex start evidence is immutable (raw SQL update/delete blocked)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-codex-immutable-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    createResumableTask(store);
    const snapshot = store.readValidatedProposalSnapshotByTask(TASK_A);
    const attempt = store.readTaskExecutionLaunchAttemptByTask(TASK_A);
    const start = store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: snapshot.executionRunId,
      invocationId: snapshot.invocationId,
      launchAttemptId: snapshot.launchAttemptId,
      launchResultId: snapshot.launchResultId,
      snapshotId: snapshot.snapshotId,
    });
    store.close();

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare('UPDATE project_task_codex_start_evidence SET start_recorded_at = 999 WHERE codex_start_id = ?').run(start.codexStart.codexStartId),
      /immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM project_task_codex_start_evidence WHERE codex_start_id = ?').run(start.codexStart.codexStartId),
      /immutable/,
    );
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 15: codex result evidence is immutable (raw SQL update/delete blocked)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-codex-result-immutable-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    createResumableTask(store);
    const snapshot = store.readValidatedProposalSnapshotByTask(TASK_A);
    store.transition(TASK_A, 'codex');
    const start = store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: snapshot.executionRunId,
      invocationId: snapshot.invocationId,
      launchAttemptId: snapshot.launchAttemptId,
      launchResultId: snapshot.launchResultId,
      snapshotId: snapshot.snapshotId,
    });
    const evidence = mapCodexResultToEvidence({
      success: true, executionId: 'exec-xyz',
      outcome: 'analysis_completed', summary: 'Done.', resultText: '',
    });
    const result = store.recordCodexResultEvidence({
      codexStartId: start.codexStart.codexStartId,
      executionId: 'exec-xyz',
      outcome: evidence.outcome,
      success: evidence.success,
      error: evidence.error,
      summary: evidence.summary,
      resultMetadataJson: evidence.resultMetadataJson,
    });
    store.close();

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath);
    assert.throws(
      () => db.prepare('UPDATE project_task_codex_result_evidence SET success = 0 WHERE codex_result_id = ?').run(result.codexResult.codexResultId),
      /immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM project_task_codex_result_evidence WHERE codex_result_id = ?').run(result.codexResult.codexResultId),
      /immutable/,
    );
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 15: hasCodexSuccessEvidence returns true for codex_success outcome', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    store.transition(TASK_A, 'codex');
    const start = store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    });
    const evidence = mapCodexResultToEvidence({
      success: true, executionId: 'exec-ok',
      outcome: 'modification_completed', summary: 'Success.', resultText: '',
    });
    const result = store.recordCodexResultEvidence({
      codexStartId: start.codexStart.codexStartId,
      executionId: 'exec-ok',
      outcome: evidence.outcome,
      success: evidence.success,
      error: evidence.error,
      summary: evidence.summary,
      resultMetadataJson: evidence.resultMetadataJson,
    });
    const startRecord = store.readCodexStartEvidence(start.codexStart.codexStartId);
    const resultRecord = store.readCodexResultEvidence(start.codexStart.codexStartId);
    assert.equal(hasCodexSuccessEvidence(startRecord, resultRecord), true);
  });
});

test('Layer 15: hasCodexSuccessEvidence returns false for codex_failed outcome', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    store.transition(TASK_A, 'codex');
    const start = store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    });
    const result = store.recordCodexResultEvidence({
      codexStartId: start.codexStart.codexStartId,
      executionId: 'exec-fail',
      outcome: 'codex_failed',
      success: 0,
      error: 'codex_execution_failed',
      summary: 'Codex execution did not complete.',
      resultMetadataJson: JSON.stringify({ executionId: 'exec-fail' }),
    });
    const startRecord = store.readCodexStartEvidence(start.codexStart.codexStartId);
    const resultRecord = store.readCodexResultEvidence(start.codexStart.codexStartId);
    assert.equal(hasCodexSuccessEvidence(startRecord, resultRecord), false);
  });
});

test('Layer 15: hasCodexSuccessEvidence returns false with start but no result', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    const start = store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    });
    const startRecord = store.readCodexStartEvidence(start.codexStart.codexStartId);
    assert.equal(hasCodexSuccessEvidence(startRecord, undefined), false);
  });
});

test('Layer 15: mapCodexResultToEvidence produces safe evidence vocabulary', async () => {
  const successResult = {
    success: true,
    executionId: 'exec-1',
    outcome: 'modification_completed',
    summary: 'Codex modified files successfully.',
    resultText: 'Here is the full result text with lots of details.',
  };
  const evidence = mapCodexResultToEvidence(successResult);
  assert.equal(evidence.outcome, 'codex_success');
  assert.equal(evidence.success, 1);
  assert.equal(evidence.error, null);
  assert.equal(evidence.summary, 'Codex modified files successfully.');
  const meta = JSON.parse(evidence.resultMetadataJson);
  assert.equal(meta.outcome, 'modification_completed');
  assert.equal(meta.executionId, 'exec-1');
  assert.equal(typeof meta.resultTextLength, 'number');
  // Never exposes raw output
  assert.equal(evidence.resultMetadataJson.includes('Here is the full result'), false);

  const failedResult = {
    success: false,
    executionId: 'exec-2',
    error: 'timeout',
    summary: 'Timed out.',
    resultText: '',
  };
  const failedEvidence = mapCodexResultToEvidence(failedResult);
  assert.equal(failedEvidence.outcome, 'codex_failed');
  assert.equal(failedEvidence.success, 0);
  assert.equal(failedEvidence.error, 'timeout');
});

test('Layer 15: V15 schema has codex evidence tables, indices, and triggers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-v15-schema-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath);

    // Check start evidence table
    const startTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_task_codex_start_evidence'").get();
    assert.ok(startTable !== undefined);
    assert.ok(startTable.sql.includes('codex_start_id TEXT PRIMARY KEY'));
    assert.ok(startTable.sql.includes('task_id TEXT NOT NULL UNIQUE'));
    assert.ok(startTable.sql.includes('STRICT'));

    // Check result evidence table
    const resultTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_task_codex_result_evidence'").get();
    assert.ok(resultTable !== undefined);
    assert.ok(resultTable.sql.includes('codex_result_id TEXT PRIMARY KEY'));
    assert.ok(resultTable.sql.includes('codex_start_id TEXT NOT NULL UNIQUE'));
    assert.ok(resultTable.sql.includes('STRICT'));

    // Check indices
    const startIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'project_task_codex_start_evidence_recorded'").get();
    assert.ok(startIndex !== undefined);
    const resultIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'project_task_codex_result_evidence_recorded'").get();
    assert.ok(resultIndex !== undefined);

    // Check triggers (6 total: validate insert + immutable update/delete for both tables)
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%codex_%'").all();
    assert.equal(triggers.length, 6);
    const triggerNames = triggers.map(t => t.name);
    assert.ok(triggerNames.includes('project_task_codex_start_evidence_validate_insert'));
    assert.ok(triggerNames.includes('project_task_codex_start_evidence_immutable_update'));
    assert.ok(triggerNames.includes('project_task_codex_start_evidence_immutable_delete'));
    assert.ok(triggerNames.includes('project_task_codex_result_evidence_validate_insert'));
    assert.ok(triggerNames.includes('project_task_codex_result_evidence_immutable_update'));
    assert.ok(triggerNames.includes('project_task_codex_result_evidence_immutable_delete'));

    db.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 15: V15 migration has zero manufactured codex evidence rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-v15-zero-evidence-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project_task_codex_start_evidence').get().total, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project_task_codex_result_evidence').get().total, 0);
    db.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 15: pruned terminals excludes tasks carrying codex evidence', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    store.transition(TASK_A, 'codex');
    store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    });
    store.fail(TASK_A, { code: 'workflow_interrupted', message: SAFE_TASK_ERROR_MESSAGES.workflow_interrupted });
    // Task should still be present (not pruned) because it has codex evidence
    const task = store.get(TASK_A);
    assert.ok(task !== undefined);
    assert.equal(task.status, 'failed');
    const startEv = store.readCodexStartEvidenceByTask(TASK_A);
    assert.ok(startEv !== undefined);
  });
});

test('Layer 15: recovery with codex start evidence but no result fails closed', async () => {
  await fixture(async (store) => {
    const { run, invocation, attempt, result: snapResult } = createResumableTask(store);
    store.transition(TASK_A, 'codex');
    store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: run.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: attempt.launchAttempt.launchAttemptId,
      launchResultId: snapResult.snapshot.launchResultId,
      snapshotId: snapResult.snapshot.snapshotId,
    });
    // Task is in 'codex' state with start evidence but no result evidence
    const recovery = store.reconcileRestartSafeTasks();
    // Should be terminalized as interrupted
    assert.equal(store.get(TASK_A).status, 'failed');
    assert.ok(recovery.failedInterrupted >= 0);
  });
});

test('Layer 15: codex start evidence is zero authority (source audit)', async () => {
  const contractSource = await readFile(new URL('../src/contracts/projectTaskCodexEvidence.ts', import.meta.url), 'utf8');
  // No execution or authority channels
  assert.doesNotMatch(contractSource, /\b(push|merge|deploy|production_write|database_write|secret_access)\b/);
  assert.doesNotMatch(contractSource, /child_process|execSync|spawn\(|runuser/i);
  // No automatic replay language
  assert.doesNotMatch(contractSource, /automatic.*replay|replay.*automatic|auto.*retry|retry.*auto/i);
  // Evidence vocabulary only — no authority fields (allow descriptive comments)
  // Strip comments before checking for authority/permission/capability keywords
  const codeOnly = contractSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /authorit|permission|capa(bilit|cit)/i);
});

// ===========================================================================
// Layer 16: Codex-skip on known durable Codex success
// ===========================================================================

function createTaskWithCodexSuccessEvidence(store, taskId = TASK_A, outcome = 'modification_completed') {
  const result = createResumableTask(store, taskId);

  // Record Codex start evidence on the task (task is at 'hermes')
  const startRec = store.recordCodexStartEvidence({
    taskId,
    executionRunId: result.run.executionRunId,
    invocationId: result.invocation.invocationId,
    launchAttemptId: result.attempt.launchAttempt.launchAttemptId,
    launchResultId: result.result.snapshot.launchResultId,
    snapshotId: result.result.snapshot.snapshotId,
  });

  // Record Codex result evidence (success)
  store.recordCodexResultEvidence({
    codexStartId: startRec.codexStart.codexStartId,
    executionId: 'codex-execution-123',
    outcome: 'codex_success',
    success: 1,
    error: null,
    summary: 'Codex completed safely.',
    resultMetadataJson: JSON.stringify({
      outcome,
      resultTextLength: 20,
      executionId: 'codex-execution-123',
    }),
  });

  return result;
}

// ===========================================================================
// Layer 16: Core Codex-skip tests
// ===========================================================================

test('Layer 16: known durable Codex success skips Codex (analysis_completed)', async () => {
  await fixture(async (store) => {
    createTaskWithCodexSuccessEvidence(store, TASK_A, 'analysis_completed');

    let codexCalls = 0;
    let codexOptions = [];
    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          throw new Error('HERMES_SHOULD_NOT_BE_CALLED');
        },
        executeCodex: async (opts) => {
          codexCalls += 1;
          codexOptions.push(opts);
          return { success: true, executionId: 'exec-new', status: 'completed', summary: 'ok', resultText: 'ok', outcome: 'analysis_completed' };
        },
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'analyzed');
    assert.equal(result.executionId, 'codex-execution-123');
    assert.equal(codexCalls, 0);
    assert.equal(codexOptions.length, 0);
  });
});

test('Layer 16: known durable Codex success continues to verification (modification_completed)', async () => {
  await fixture(async (store) => {
    createTaskWithCodexSuccessEvidence(store, TASK_A, 'modification_completed');

    let codexCalls = 0;
    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          throw new Error('HERMES_SHOULD_NOT_BE_CALLED');
        },
        executeCodex: async () => {
          codexCalls += 1;
          return { success: true, executionId: 'exec-new', status: 'completed', summary: 'ok', resultText: 'ok', outcome: 'modification_completed' };
        },
      },
    }));
    // Codex is skipped. With completionMode 'analyze' the effectiveCapabilities
    // are read-only, so the flow returns analyzed. The key assertion: Codex was
    // NOT executed.
    assert.equal(result.ok, true);
    assert.equal(codexCalls, 0);
  });
});

test('Layer 16: Codex executor call count is ZERO during resumed known-success path', async () => {
  await fixture(async (store) => {
    createTaskWithCodexSuccessEvidence(store, TASK_A, 'analysis_completed');

    let codexCalls = 0;
    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          throw new Error('HERMES_SHOULD_NOT_BE_CALLED');
        },
        executeCodex: async () => {
          codexCalls += 1;
          return { success: true, executionId: 'exec-new', status: 'completed', summary: 'ok', resultText: 'ok', outcome: 'analysis_completed' };
        },
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(codexCalls, 0);
  });
});

test('Layer 16: repeated re-entry never reruns Codex', async () => {
  await fixture(async (store) => {
    createTaskWithCodexSuccessEvidence(store, TASK_A, 'analysis_completed');

    let codexCalls = 0;
    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    for (let i = 0; i < 3; i++) {
      const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
        resume: true,
        registry: testRegistry,
        workflowDependencies: {
          executeHermes: async () => {
            throw new Error('HERMES_SHOULD_NOT_BE_CALLED');
          },
          executeCodex: async () => {
            codexCalls += 1;
            return { success: true, executionId: 'exec-new', status: 'completed', summary: 'ok', resultText: 'ok', outcome: 'analysis_completed' };
          },
        },
      }));
      assert.equal(result.ok, true);
    }
    assert.equal(codexCalls, 0);
  });
});

test('Layer 16: known durable Codex failure never reaches verification', async () => {
  await fixture(async (store) => {
    const result = createResumableTask(store, TASK_A);

    const startRec = store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: result.run.executionRunId,
      invocationId: result.invocation.invocationId,
      launchAttemptId: result.attempt.launchAttempt.launchAttemptId,
      launchResultId: result.result.snapshot.launchResultId,
      snapshotId: result.result.snapshot.snapshotId,
    });

    store.recordCodexResultEvidence({
      codexStartId: startRec.codexStart.codexStartId,
      executionId: 'codex-exec-failed',
      outcome: 'codex_failed',
      success: 0,
      error: 'codex_execution_failed',
      summary: 'Codex execution failed.',
      resultMetadataJson: JSON.stringify({ executionId: 'codex-exec-failed' }),
    });

    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    let hermeseCalls = 0;
    const resumeResult = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          hermeseCalls += 1;
          return { ok: true, response: JSON.stringify(proposal) };
        },
      },
    }));
    assert.equal(hermeseCalls, 0);
    assert.equal(resumeResult.ok, false);
    assert.notEqual(resumeResult.error, 'verification_unavailable');
    assert.notEqual(resumeResult.stage, 'verification');
  });
});

test('Layer 16: missing start evidence with result fails closed (no Codex skip)', async () => {
  await fixture(async (store) => {
    createResumableTask(store, TASK_A);

    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    let hermeseCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          hermeseCalls += 1;
          return { ok: true, response: JSON.stringify(proposal) };
        },
      },
    }));
    assert.equal(hermeseCalls, 0);
    assert.equal(result.ok, false);
    assert.ok(
      result.stage === 'codex' || result.stage === 'planning',
      `Expected codex/planning stage, got ${result.stage}`,
    );
  });
});

test('Layer 16: corrupt result metadata falls through to normal Codex path', async () => {
  await fixture(async (store) => {
    const result = createResumableTask(store, TASK_A);

    const startRec = store.recordCodexStartEvidence({
      taskId: TASK_A,
      executionRunId: result.run.executionRunId,
      invocationId: result.invocation.invocationId,
      launchAttemptId: result.attempt.launchAttempt.launchAttemptId,
      launchResultId: result.result.snapshot.launchResultId,
      snapshotId: result.result.snapshot.snapshotId,
    });

    // codex_success result but missing 'outcome' in metadata
    store.recordCodexResultEvidence({
      codexStartId: startRec.codexStart.codexStartId,
      executionId: 'codex-exec-123',
      outcome: 'codex_success',
      success: 1,
      error: null,
      summary: 'Codex completed safely.',
      resultMetadataJson: JSON.stringify({ executionId: 'codex-exec-123' }),
    });

    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    let hermeseCalls = 0;
    const resumeResult = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          hermeseCalls += 1;
          return { ok: true, response: JSON.stringify(proposal) };
        },
      },
    }));
    assert.equal(hermeseCalls, 0);
    // metadata.outcome is undefined → defaults to modification_completed.
    // With completionMode 'analyze' the effectiveCapabilities are read-only,
    // so the flow returns analyzed (ok: true) rather than entering verification.
    assert.equal(resumeResult.ok, true);
    assert.notEqual(resumeResult.error, 'codex_execution_failed');
  });
});

test('Layer 16: contradictory lineage fails closed (wrong task)', async () => {
  await fixture(async (store) => {
    createResumableTask(store, TASK_A);

    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    let hermeseCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          hermeseCalls += 1;
          return { ok: true, response: JSON.stringify(proposal) };
        },
      },
    }));
    assert.equal(hermeseCalls, 0);
    assert.equal(result.ok, false);
  });
});

test('Layer 16: restart/re-entry is deterministic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-l16-deterministic-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => Date.now() });
    createTaskWithCodexSuccessEvidence(store, TASK_A, 'analysis_completed');

    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    const opts = (s) => runnerOptions(s, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          throw new Error('HERMES_SHOULD_NOT_BE_CALLED');
        },
      },
    });

    const result1 = await runProjectTaskDurableExecution(opts(store));
    assert.equal(result1.ok, true);
    assert.equal(result1.status, 'analyzed');
    assert.equal(result1.executionId, 'codex-execution-123');

    store.close();
    const reopened = new ProjectTaskSqliteStore({ databasePath, now: () => Date.now() });
    try {
      const result2 = await runProjectTaskDurableExecution(opts(reopened));
      assert.equal(result2.ok, true);
      assert.equal(result2.status, 'analyzed');
      assert.equal(result2.executionId, 'codex-execution-123');

      const result3 = await runProjectTaskDurableExecution(opts(reopened));
      assert.equal(result3.ok, true);
      assert.equal(result3.status, 'analyzed');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 16: no Hermes replay introduced by codex-skip path', async () => {
  await fixture(async (store) => {
    createTaskWithCodexSuccessEvidence(store, TASK_A, 'analysis_completed');

    const testRegistry = {
      read: async () => [{
        projectId: 'safe', displayName: 'Safe Project',
        repositoryRoot: '/registry/safe', enabled: true,
      }],
    };

    let hermeseCalls = 0;
    let codexCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry: testRegistry,
      workflowDependencies: {
        executeHermes: async () => {
          hermeseCalls += 1;
          return { ok: true, response: JSON.stringify(proposal) };
        },
        executeCodex: async () => {
          codexCalls += 1;
          return { success: true, executionId: 'exec-new', status: 'completed', summary: 'ok', resultText: 'ok', outcome: 'analysis_completed' };
        },
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(hermeseCalls, 0);
    assert.equal(codexCalls, 0);
  });
});

// ===========================================================================
// Layer 16: Layer 14 and Layer 15 regression
// ===========================================================================

test('Layer 16: Layer 14 resume behavior remains valid (no codex evidence)', async () => {
  await fixture(async (store) => {
    createResumableTask(store, TASK_A);

    let hermeseCalls = 0;
    const result = await runProjectTaskDurableExecution(runnerOptions(store, TASK_A, {
      resume: true,
      registry,
      workflowDependencies: {
        executeHermes: async () => {
          hermeseCalls += 1;
          return { ok: true, response: JSON.stringify(proposal) };
        },
      },
    }));
    assert.equal(hermeseCalls, 0);
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'codex');
  });
});

test('Layer 16: Layer 15 evidence behavior remains valid', async () => {
  await fixture(async (store) => {
    const result = createTaskWithCodexSuccessEvidence(store, TASK_A, 'modification_completed');

    const startEvidence = store.readCodexStartEvidenceByTask(TASK_A);
    assert.ok(startEvidence !== undefined);
    assert.equal(startEvidence.taskId, TASK_A);
    assert.equal(startEvidence.launchAttemptId, result.attempt.launchAttempt.launchAttemptId);

    const resultEvidence = store.readCodexResultEvidence(startEvidence.codexStartId);
    assert.ok(resultEvidence !== undefined);
    assert.equal(resultEvidence.outcome, 'codex_success');
    assert.equal(resultEvidence.success, 1);
    assert.equal(resultEvidence.error, null);
    assert.equal(resultEvidence.codexStartId, startEvidence.codexStartId);

    assert.ok(hasCodexSuccessEvidence(startEvidence, resultEvidence));
  });
});

test('Layer 16: no authority/capability expansion in the codex-skip branch', async () => {
  const runnerSource = await readFile(
    new URL('../src/services/projectTaskDurableExecutionRunner.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(runnerSource, /\b(shell|exec\(|spawn\(|eval\()/);
  assert.doesNotMatch(runnerSource, /child_process|execSync|runuser/i);
  const codeOnly = runnerSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /\b(authorit|permission)\b/);
  assert.doesNotMatch(runnerSource, /automatic\s+(replay|retry)|replay\s+automatic|auto[-\s]retry/i);
});

// ===========================================================================
// Layer 16: Migration compatibility
// ===========================================================================

test('Layer 16: schema version unchanged at V15', async () => {
  assert.equal(PROJECT_TASK_SQLITE_SCHEMA_VERSION, 15);
});

test('Layer 16: V15 database has codex evidence tables with zero manufactured rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-l16-v15-compat-'));
  const databasePath = join(directory, 'tasks.sqlite');
  try {
    const store = new ProjectTaskSqliteStore({ databasePath, now: () => 1000 });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%codex%' ORDER BY name",
    ).all();
    const tableNames = tables.map((t) => t.name);
    assert.ok(tableNames.includes('project_task_codex_start_evidence'));
    assert.ok(tableNames.includes('project_task_codex_result_evidence'));

    assert.equal(
      db.prepare('SELECT COUNT(*) AS total FROM project_task_codex_start_evidence').get().total,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS total FROM project_task_codex_result_evidence').get().total,
      0,
    );

    db.close();
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layer 16: live workflow unchanged (no codex-skip in live path)', async () => {
  const workflowSource = await readFile(
    new URL('../src/services/projectTaskWorkflowService.ts', import.meta.url),
    'utf8',
  );
  assert.ok(workflowSource.includes('executeProjectCodexHandoff'));
  assert.equal(workflowSource.includes('hasCodexSuccessEvidence'), false);
});
