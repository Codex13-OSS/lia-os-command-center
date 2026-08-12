import type { LiaAgentConfig } from '../config.js';
import {
  ExternalLaunchOutcomeUnknownError,
  PROJECT_TASK_DURABLE_EXECUTION_ERRORS,
  type ProjectTaskDurableExecutionStore,
} from '../contracts/projectTaskDurableExecution.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { ProjectTaskStage, ProjectTaskStore } from '../contracts/projectTask.js';
import type { ProjectTaskWorkflowError, ProjectTaskWorkflowResult } from '../contracts/projectTaskWorkflow.js';
import type { ProjectTaskExecutionLaunchResultOutcome } from '../contracts/projectTaskExecutionLaunchResult.js';
import type { ProjectOrchestrationProposal } from '../contracts/projectOrchestration.js';
import type { ProjectTaskLeaseRecord } from '../contracts/projectTaskLease.js';
import { PROJECT_TASK_LEASE_MAX_DURATION_MS } from '../contracts/projectTaskLease.js';
import type { ProjectTaskDispatchRecord } from '../contracts/projectTaskDispatch.js';
import type { ProjectTaskExecutionRunRecord } from '../contracts/projectTaskExecutionRun.js';
import type { ProjectTaskExecutionInvocationRecord } from '../contracts/projectTaskExecutionInvocation.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import type { ProjectTaskWorkflowDependencies } from './projectTaskWorkflowService.js';
import { executeProjectTaskWorkflow } from './projectTaskWorkflowService.js';
import { canonicalizeValidatedProposal } from './projectValidatedProposalSnapshotCanonicalization.js';
import { createHash } from 'node:crypto';
import type { ProjectTaskResumeDecisionRecord } from '../contracts/projectTaskResumeDecision.js';
import type { ProjectTaskResumeRefusalReason } from '../contracts/projectTaskResumeDecision.js';
import type { ProjectTaskValidatedProposalSnapshotRecord } from '../contracts/projectTaskValidatedProposalSnapshot.js';
import type { ProjectCodexExecutionResult } from '../contracts/projectCodexExecution.js';
import type { ProjectCodexVerificationResult } from './projectCodexVerification.js';
import type { ProjectVisualVerificationResult } from './projectVisualVerification.js';
import type { ProjectCodexCommitResult } from '../contracts/projectCodexCommit.js';
import { buildProjectCodexHandoff } from './projectCodexHandoff.js';
import { executeProjectCodexHandoff } from './projectCodexExecutor.js';
import { mapCodexResultToEvidence, hasCodexSuccessEvidence } from '../contracts/projectTaskCodexEvidence.js';
import type { RecordCodexStartInput, RecordCodexResultInput } from '../contracts/projectTaskCodexEvidence.js';
import { verifyProjectCodexWorkspace } from './projectCodexVerification.js';
import { verifyProjectVisualWorkspace } from './projectVisualVerification.js';
import { commitVerifiedProjectCodexWorkspace } from './projectCodexCommit.js';
import { planProjectTask } from './projectExecutionPlanner.js';
import { validateProjectOrchestrationProposal } from './projectOrchestrationValidation.js';
import { SAFE_TASK_ERROR_MESSAGES, type SafeTaskStage } from '../contracts/projectTask.js';

export type ProjectTaskDurableObservableStage = Extract<
  ProjectTaskStage,
  'planning' | 'hermes' | 'codex' | 'verification' | 'commit'
>;

/**
 * Structural capability guard: detects a store that exposes every existing
 * Layers 5-10 durable primitive plus the Layer 12 launch-result evidence
 * primitive and the Layer 13 validated-proposal snapshot primitives required
 * by the runner. The durable path REQUIRES atomic proposal persistence: a
 * store that cannot persist the snapshot atomically fails closed
 * (unsupportedStore) rather than silently reopening the crash window. The
 * in-memory product fallback deliberately fails this guard, so a non-durable
 * product store can never reach a live Hermes phase through the durable task
 * path.
 */
export function hasProjectTaskDurableExecutionPrimitives(
  store: { [Key in keyof ProjectTaskDurableExecutionStore]?: unknown },
): store is ProjectTaskDurableExecutionStore {
  return typeof store.acquireTaskLease === 'function'
    && typeof store.enqueueTaskDispatch === 'function'
    && typeof store.claimTaskDispatch === 'function'
    && typeof store.prepareTaskExecutionRun === 'function'
    && typeof store.reserveTaskExecutionInvocation === 'function'
    && typeof store.beginTaskExecutionLaunchAttempt === 'function'
    && typeof store.recordTaskExecutionLaunchResult === 'function'
    && typeof store.readTaskExecutionLaunchResultByLaunchAttempt === 'function'
    && typeof store.recordValidatedProposalResult === 'function'
    && typeof store.readValidatedProposalSnapshotByLaunchResult === 'function'
    && typeof store.recordResumeDecision === 'function'
    && typeof store.readResumeDecisionByTask === 'function';
}

export type ProjectTaskDurableExecutionRunnerOptions = {
  /** The product task store; must pass hasProjectTaskDurableExecutionPrimitives. */
  store: ProjectTaskStore;
  taskId: string;
  /** Unique bounded worker/lease-owner identity. Worker metadata, never authority. */
  workerId: string;
  config: LiaAgentConfig;
  request: ProjectTaskRequest;
  registry: ProjectRegistrySource;
  verificationRegistry?: ProjectVerificationRegistry;
  /** Internal observability: durable stage transitions only. */
  onStage: (stage: ProjectTaskDurableObservableStage) => void;
  /**
   * Route test seam. When supplied it is invoked instead of the real
   * workflow, but never before the durable Launch Attempt gate has admitted
   * the live external phase. It cannot bypass the durable boundary.
   */
  executeWorkflow?: (
    request: ProjectTaskRequest,
    onStage: (stage: ProjectTaskDurableObservableStage) => void,
  ) => Promise<ProjectTaskWorkflowResult>;
  /** Optional workflow fakes for controlled tests. onStage, the gate and the result seams are always owned by the runner. */
  workflowDependencies?: Omit<ProjectTaskWorkflowDependencies, 'onStage' | 'beforeExternalLaunch' | 'recordExternalLaunchResult' | 'recordValidatedProposalResult'>;
  /** When true, the runner enters the resume path for a local_resume_available task. */
  resume?: boolean;
};

export type ProjectTaskDurableExecutionRunner = {
  run(): Promise<ProjectTaskWorkflowResult>;
};

const ambiguousFailure = (): ProjectTaskWorkflowResult => ({
  ok: false,
  status: 'failed',
  stage: 'hermes',
  error: 'external_launch_outcome_unknown',
  summary: 'The external launch outcome is unknown; LÍA will not relaunch automatically.',
});

const OUTCOME_FAILURES: Record<ProjectTaskExecutionLaunchResultOutcome, {
  error: ProjectTaskWorkflowError;
  summary: string;
}> = {
  proposal_valid: {
    error: 'workflow_interrupted',
    summary: 'The external phase completed, but durable local continuation is not implemented.',
  },
  timeout: {
    error: 'timeout',
    summary: 'Hermes reasoning did not complete.',
  },
  execution_failed: {
    error: 'execution_failed',
    summary: 'Hermes reasoning did not complete.',
  },
  empty_response: {
    error: 'empty_response',
    summary: 'Hermes reasoning did not complete.',
  },
  invalid_hermes_json: {
    error: 'invalid_hermes_json',
    summary: 'Hermes returned invalid JSON.',
  },
  invalid_hermes_proposal: {
    error: 'invalid_hermes_proposal',
    summary: 'Hermes returned an invalid proposal.',
  },
};

/**
 * Layer 12 re-entry mapping for a KNOWN durable external outcome. It is a
 * state-only result: zero Hermes calls, zero Codex, zero lease reacquire,
 * zero new Launch Attempt, zero new result manufacturing. A final Hermes
 * failure surfaces its exact safe error; proposal_valid surfaces
 * workflow_interrupted because no automatic local resume exists yet.
 */
const knownOutcomeFailure = (
  outcomeClass: ProjectTaskExecutionLaunchResultOutcome,
): ProjectTaskWorkflowResult => {
  const { error, summary } = OUTCOME_FAILURES[outcomeClass];
  return { ok: false, status: 'failed', stage: 'hermes', error, summary };
};

/**
 * Layer 13 state-only re-entry result for a pre-Codex task with a validated
 * proposal snapshot (recovery case 4 mapping). It is NOT a task failure: zero
 * Hermes, zero Codex, zero new attempt/result/lease operations are performed
 * and the caller MUST NOT terminalize the task — it stays in its durable
 * resumable state. The snapshot is evidence only; fresh LÍA policy evaluation
 * is still mandatory before any later action.
 */
const localResumeAvailableFailure = (): ProjectTaskWorkflowResult => ({
  ok: false,
  status: 'failed',
  stage: 'hermes',
  error: 'local_resume_available',
  summary: 'A validated proposal snapshot is durably available; the task remains resumable pending fresh LÍA policy evaluation.',
});

const resumeRefusedFailure = (reason: string): ProjectTaskWorkflowResult => ({
  ok: false,
  status: 'failed',
  stage: 'hermes',
  error: 'resume_refused',
  summary: `LÍA refused the local resume after re-evaluating current policy: ${reason}.`,
});

/**
 * Layer 11 controlled external launch caller with the Layer 12 post-Hermes
 * result evidence seam.
 *
 * It connects the existing Layers 5-10 durable primitives (lease, dispatch,
 * execution run, invocation, launch attempt) to the real /api/projects/tasks
 * execution path through a narrow workflow seam. It owns only task identity,
 * worker/lease identity, fencing, dispatch identity, run/invocation identity,
 * the Launch Attempt gate and the immutable Launch Result evidence recording.
 * The existing workflow owns planning, authorization/policy validation, Hermes
 * proposal validation, effective capability derivation, Codex, verification
 * and the optional local commit.
 *
 * Durable operation order (all store calls are synchronous):
 *   1. acquire the current task lease
 *   2. enqueue the durable dispatch
 *   3. claim the dispatch using the exact current lease/fencing tuple
 *   4. prepareTaskExecutionRun (preserving its atomic dispatch consumption)
 *   5. reserveTaskExecutionInvocation
 *   6. enter workflow planning
 *   7. immediately before the first real Hermes external phase:
 *      validate the current lease and beginTaskExecutionLaunchAttempt
 *   8. only a first valid crossing may enter Hermes; the observable `hermes`
 *      stage is emitted only after the gate admits the live external phase
 *   9. the workflow durably records the final outcome of the WHOLE admitted
 *      live Hermes phase via the post-Hermes result seams (exactly once, after
 *      final proposal validation and before any local approval/Codex step):
 *      failure outcomes via recordExternalLaunchResult; proposal_valid via
 *      recordValidatedProposalResult, which atomically persists the Launch
 *      Result AND the Layer 13 validated-proposal snapshot in one transaction
 *
 * created=true from beginTaskExecutionLaunchAttempt is ephemeral permission
 * for THIS live process only and is never persisted as retry permission.
 * created=false, an existing attempt, a stale/expired/wrong-fencing lease or
 * any contested boundary state produce zero Hermes calls. A crash after the
 * gate leaves durable ambiguity evidence and no automatic relaunch; a durable
 * Launch Result makes the outcome KNOWN but still permits no Hermes/Codex
 * replay and no automatic resume.
 */
export function createProjectTaskDurableExecutionRunner(
  options: ProjectTaskDurableExecutionRunnerOptions,
): ProjectTaskDurableExecutionRunner {
  if (!hasProjectTaskDurableExecutionPrimitives(options.store)) {
    throw new Error(PROJECT_TASK_DURABLE_EXECUTION_ERRORS.unsupportedStore);
  }
  const store: ProjectTaskDurableExecutionStore = options.store;
  const { taskId, workerId } = options;
  let lease: ProjectTaskLeaseRecord | undefined;
  let gateFired = false;

  const crossLaunchBoundary = (
    invocation: ProjectTaskExecutionInvocationRecord,
    run: ProjectTaskExecutionRunRecord,
  ): void => {
    if (lease === undefined) {
      throw new Error(PROJECT_TASK_DURABLE_EXECUTION_ERRORS.taskNotAvailable);
    }
    const authority = {
      taskId,
      leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    };
    // Pre-launch failures (stale/expired/not-found/wrong generation) throw
    // here: the boundary was NOT crossed, so the outcome is known and the
    // caller fails closed as a plain pre-launch failure.
    store.assertCurrentTaskLease(authority);
    let created: boolean;
    try {
      created = store.beginTaskExecutionLaunchAttempt({
        invocationId: invocation.invocationId,
        executionRunId: run.executionRunId,
        ...authority,
      }).created;
    } catch {
      // The boundary state is contested/corrupt: outcome unknown.
      throw new ExternalLaunchOutcomeUnknownError();
    }
    if (!created) {
      // The durable tuple already existed: another instance may have crossed
      // the boundary. Never permission to launch.
      throw new ExternalLaunchOutcomeUnknownError();
    }
    gateFired = true;
  };

  /**
   * Layer 12 post-Hermes evidence seam. The workflow invokes it at most once
   * with ONLY the small final outcome class; the runner records it against the
   * EXACT Launch Attempt admitted by THIS live execution's gate. It never
   * receives raw Hermes output. Without a previously admitted Launch Attempt
   * it fails closed, so no result row can ever exist without a Launch Attempt.
   */
  const recordExternalLaunchResult = async (
    outcomeClass: ProjectTaskExecutionLaunchResultOutcome,
  ): Promise<void> => {
    if (!gateFired) {
      throw new ExternalLaunchOutcomeUnknownError();
    }
    const attempt = store.readTaskExecutionLaunchAttemptByTask(taskId);
    if (attempt === undefined) {
      throw new ExternalLaunchOutcomeUnknownError();
    }
    store.recordTaskExecutionLaunchResult({
      launchAttemptId: attempt.launchAttemptId,
      invocationId: attempt.invocationId,
      executionRunId: attempt.executionRunId,
      taskId: attempt.taskId,
      outcomeClass,
    });
  };

  /**
   * Layer 13 post-Hermes validated-proposal snapshot seam. The workflow
   * invokes it at most once with ONLY the normalized validated proposal object
   * (never the raw Hermes response, prompts, capabilities, paths or
   * credentials). The runner canonicalizes it with the frozen canonicalizer
   * and records the proposal_valid Launch Result and its snapshot ATOMICALLY
   * against the EXACT Launch Attempt admitted by THIS live execution's gate.
   * Without a previously admitted Launch Attempt it fails closed, so the
   * atomic tuple can never exist without a Launch Attempt. The snapshot is
   * evidence only: it grants no approval, capability, Codex or retry
   * authority.
   */
  const recordValidatedProposalResult = async (
    proposal: ProjectOrchestrationProposal,
  ): Promise<void> => {
    if (!gateFired) {
      throw new ExternalLaunchOutcomeUnknownError();
    }
    const attempt = store.readTaskExecutionLaunchAttemptByTask(taskId);
    if (attempt === undefined) {
      throw new ExternalLaunchOutcomeUnknownError();
    }
    const canonical = canonicalizeValidatedProposal(proposal);
    store.recordValidatedProposalResult({
      launchAttemptId: attempt.launchAttemptId,
      invocationId: attempt.invocationId,
      executionRunId: attempt.executionRunId,
      taskId: attempt.taskId,
      canonicalProposalJson: canonical.canonicalJson,
      proposalSha256: canonical.sha256,
      executionMode: proposal.executionMode,
      completionMode: proposal.completionMode,
      requiresHumanApproval: proposal.requiresHumanApproval,
      blockedActions: proposal.blockedActions,
    });
  };

  /**
   * Layer 15: durable Codex start evidence seam. Invoked at most once per
   * live workflow process, after the observable `codex` stage transition
   * and immediately BEFORE the first real Codex external process call.
   * Records the exact execution lineage so an operator can discriminate
   * between "Codex never started" and "Codex returned an outcome."
   * Evidence only — never gates execution.
   */
  const recordCodexStart = async (): Promise<void> => {
    if (!gateFired) return;
    const snapshot = store.readValidatedProposalSnapshotByTask(taskId);
    if (snapshot === undefined) return;
    const attempt = store.readTaskExecutionLaunchAttemptByTask(taskId);
    if (attempt === undefined) return;
    const input: RecordCodexStartInput = {
      taskId,
      executionRunId: snapshot.executionRunId,
      invocationId: snapshot.invocationId,
      launchAttemptId: snapshot.launchAttemptId,
      launchResultId: snapshot.launchResultId,
      snapshotId: snapshot.snapshotId,
    };
    store.recordCodexStartEvidence(input);
  };

  /**
   * Layer 15: durable Codex result evidence seam. Invoked at most once per
   * live workflow process, AFTER executeProjectCodexHandoff returns and
   * BEFORE any verification/visual-QA/commit step. Maps the raw
   * ProjectCodexExecutionResult to the safe evidence vocabulary and
   * records it durably. Evidence only — never gates execution.
   */
  const recordCodexResult = async (result: ProjectCodexExecutionResult): Promise<void> => {
    const startEvidence = store.readCodexStartEvidenceByTask(taskId);
    if (startEvidence === undefined) return;
    const evidence = mapCodexResultToEvidence(result);
    const input: RecordCodexResultInput = {
      codexStartId: startEvidence.codexStartId,
      executionId: result.executionId,
      outcome: evidence.outcome,
      success: evidence.success,
      error: evidence.error,
      summary: evidence.summary,
      resultMetadataJson: evidence.resultMetadataJson,
    };
    store.recordCodexResultEvidence(input);
  };

  /** Known durable outcome for the task, if the Launch Attempt already has a result. */
  const knownOutcomeForTask = (): ProjectTaskWorkflowResult | undefined => {
    const attempt = store.readTaskExecutionLaunchAttemptByTask(taskId);
    if (attempt === undefined) return undefined;
    const result = store.readTaskExecutionLaunchResultByLaunchAttempt(attempt.launchAttemptId);
    if (result === undefined) return undefined;
    if (result.outcomeClass === 'proposal_valid') {
      // Layer 13 pre/post-Codex fence. The durable transition to 'codex'
      // precedes the Codex call, so status >= 'codex' means Codex MAY have
      // started: the snapshot is NEVER replay permission and the task fails
      // closed with workflow_interrupted. Only a PRE-Codex task with a
      // matching validated snapshot reports local_resume_available (state
      // only, zero Hermes, zero Codex, zero new attempt/result).
      const snapshot = store.readValidatedProposalSnapshotByTask(taskId);
      const task = store.get(taskId);
      const status = task?.status;
      if (
        snapshot !== undefined
        && (status === 'accepted' || status === 'planning' || status === 'hermes')
      ) {
        // Layer 14: check if a resume decision exists.
        const resumeDecision = store.readResumeDecisionByTask(taskId);
        if (
          resumeDecision !== undefined
          && resumeDecision.decision === 'refused'
        ) {
          // Resume was refused → task should have been terminalized.
          // If it somehow is not, return a safe failure.
          return resumeRefusedFailure(resumeDecision.refusalReason ?? 'unknown');
        }
        return localResumeAvailableFailure();
      }
      return knownOutcomeFailure('proposal_valid');
    }
    return knownOutcomeFailure(result.outcomeClass);
  };

  /**
   * Layer 14 resume path: fresh LIA policy evaluation + execution.
   *
   * Reads the durable validated-proposal snapshot, re-plans from the task's
   * durable intent with current registry authorization, re-validates the
   * canonical proposal against the fresh plan, re-checks sha256 integrity
   * and approval gates (requiresHumanApproval, blockedActions), computes the
   * policy fingerprint, and durably records an approve/refuse decision BEFORE
   * any Codex call. If approved, proceeds through the same handoff → Codex →
   * verification → commit path as the live workflow (workflowService:367-551).
   * If refused, terminalizes the task with a safe resume_refused error.
   *
   * An existing approved resume decision is durable evidence/data only — it
   * grants ZERO current authority and does NOT authorize skipping fresh LIA
   * policy evaluation on re-entry. Every executable local resume/re-entry
   * MUST derive current authority from fresh LIA policy evaluation.
   *
   * CRASH WINDOWS:
   * - Crash BEFORE decision recorded: task still has local_resume_available +
   *   no resume_decision. Next re-entry retries policy evaluation (idempotent).
   * - Crash AFTER approved but BEFORE observe('codex'): status='hermes' +
   *   resume_decision='approved'. Next re-entry runs fresh policy evaluation
   *   (the approved decision is evidence only, never authority); if policy
   *   still approves, re-entry is idempotent and proceeds to handoff → Codex.
   * - Crash AFTER observe('codex'): status='codex' + resume_decision='approved'.
   *   Codex MAY have started → fail closed workflow_interrupted (Layer 15 gap).
   */
  const executeResumePath = async (): Promise<ProjectTaskWorkflowResult> => {
    const snapshot = store.readValidatedProposalSnapshotByTask(taskId);
    if (snapshot === undefined) {
      return resumeRefusedFailure('invalid_proposal_structure');
    }

    const task = store.get(taskId);
    if (task === undefined || task.terminalAt !== undefined) {
      return resumeRefusedFailure('invalid_proposal_structure');
    }
    if (!(task.status === 'accepted' || task.status === 'planning' || task.status === 'hermes')) {
      // Task status >= 'codex': Codex fence.
      return {
        ok: false,
        status: 'failed',
        stage: 'hermes',
        error: 'workflow_interrupted',
        summary: 'Codex may have started; automatic resume is not permitted.',
      };
    }

    // Check for existing resume decision.
    // A refused decision blocks all re-entry. An approved decision is
    // durable evidence/data only — it grants ZERO current authority and
    // does NOT authorize skipping fresh LIA policy evaluation. Every
    // executable local resume/re-entry MUST derive current authority
    // from fresh LIA policy evaluation below.
    const existingDecision = store.readResumeDecisionByTask(taskId);
    if (
      existingDecision !== undefined
      && existingDecision.decision === 'refused'
    ) {
      return resumeRefusedFailure(existingDecision.refusalReason ?? 'unknown');
    }

    // Fresh LIA policy evaluation — always executed, regardless of
    // whether a prior resume decision exists. An approved decision is
    // evidence only and carries zero current authority.
    // 1. Re-plan from durable task intent with current registry.
    let freshPlan;
    try {
      freshPlan = await planProjectTask(task.intent, options.registry);
    } catch {
      // Planning failed: record refusal
      const policyFingerprint = createHash('sha256').update(JSON.stringify({
        intentFingerprint: task.fingerprint,
        projectId: task.intent.projectId,
        approvedCapabilities: [] as string[],
        planRepositoryRoot: '',
        planKey: '',
        snapshotSha256: snapshot.proposalSha256,
        canonicalVersion: snapshot.canonicalVersion,
      })).digest('hex');
      try {
        store.recordResumeDecision({
          taskId,
          snapshotId: snapshot.snapshotId,
          decision: 'refused',
          refusalReason: 'planning_failed',
          policyFingerprint,
        });
      } catch {
        // Decision recording failed; still return safe error.
      }
      const error = resumeRefusedFailure('planning_failed');
      store.fail(taskId, {
        code: 'resume_refused',
        message: SAFE_TASK_ERROR_MESSAGES.resume_refused,
        stage: 'hermes',
      });
      return error;
    }

    if (!freshPlan.ok) {
      // Planning returned error (registry_unavailable, project_not_found, etc.)
      const refusalReason: ProjectTaskResumeRefusalReason =
        freshPlan.error === 'registry_unavailable' ? 'registry_unavailable' : 'planning_failed';
      const policyFingerprint = createHash('sha256').update(JSON.stringify({
        intentFingerprint: task.fingerprint,
        projectId: task.intent.projectId,
        approvedCapabilities: [] as string[],
        planRepositoryRoot: '',
        planKey: '',
        snapshotSha256: snapshot.proposalSha256,
        canonicalVersion: snapshot.canonicalVersion,
      })).digest('hex');
      try {
        store.recordResumeDecision({
          taskId,
          snapshotId: snapshot.snapshotId,
          decision: 'refused',
          refusalReason,
          policyFingerprint,
        });
      } catch {
        // Decision recording failed; still return safe error.
      }
      const error = resumeRefusedFailure(refusalReason);
      store.fail(taskId, {
        code: 'resume_refused',
        message: SAFE_TASK_ERROR_MESSAGES.resume_refused,
        stage: 'hermes',
      });
      return error;
    }

    const plan = freshPlan.plan;

    // 2. Parse canonical proposal JSON from snapshot
    let proposal: ProjectOrchestrationProposal;
    try {
      proposal = JSON.parse(snapshot.canonicalProposalJson) as ProjectOrchestrationProposal;
    } catch {
      const error = resumeRefusedFailure('invalid_proposal_structure');
      store.fail(taskId, {
        code: 'resume_refused',
        message: SAFE_TASK_ERROR_MESSAGES.resume_refused,
        stage: 'hermes',
      });
      return error;
    }

    // 3. Re-validate proposal against fresh plan
    const validation = validateProjectOrchestrationProposal(proposal, plan);
    if (!validation.success) {
      const error = resumeRefusedFailure('invalid_proposal_structure');
      store.fail(taskId, {
        code: 'resume_refused',
        message: SAFE_TASK_ERROR_MESSAGES.resume_refused,
        stage: 'hermes',
      });
      return error;
    }

    // 4. Re-compute sha256 and compare
    const canonical = canonicalizeValidatedProposal(proposal);
    if (canonical.sha256 !== snapshot.proposalSha256) {
      const error = resumeRefusedFailure('proposal_sha256_mismatch');
      store.fail(taskId, {
        code: 'resume_refused',
        message: SAFE_TASK_ERROR_MESSAGES.resume_refused,
        stage: 'hermes',
      });
      return error;
    }

    // 5. Check requiresHumanApproval and blockedActions
    let refusalReason: string | undefined;
    if (proposal.requiresHumanApproval) {
      refusalReason = 'human_approval_required';
    } else if (proposal.blockedActions.length > 0) {
      refusalReason = 'blocked_actions';
    }

    // 6. Compute policy fingerprint
    const intended = task.intent;
    const policyFingerprint = createHash('sha256').update(JSON.stringify({
      intentFingerprint: task.fingerprint,
      projectId: intended.projectId,
      approvedCapabilities: [...plan.approvedCapabilities].sort(),
      planRepositoryRoot: plan.repositoryRoot,
      planKey: `${intended.projectId}:${[...plan.approvedCapabilities].sort().join(',')}`,
      snapshotSha256: snapshot.proposalSha256,
      canonicalVersion: snapshot.canonicalVersion,
    })).digest('hex');

    // 7. Record decision
    if (refusalReason !== undefined) {
      // Record refusal decision atomically, then terminalize
      try {
        store.recordResumeDecision({
          taskId,
          snapshotId: snapshot.snapshotId,
          decision: 'refused',
          refusalReason: refusalReason as ProjectTaskResumeRefusalReason,
          policyFingerprint,
        });
      } catch {
        // If recording fails, still terminalize with safe error.
      }
      const error = resumeRefusedFailure(refusalReason);
      store.fail(taskId, {
        code: 'resume_refused',
        message: SAFE_TASK_ERROR_MESSAGES.resume_refused,
        stage: 'hermes',
      });
      return error;
    }

    // 8. Record approval decision atomically
    let resumeDecision: ProjectTaskResumeDecisionRecord;
    try {
      const result = store.recordResumeDecision({
        taskId,
        snapshotId: snapshot.snapshotId,
        decision: 'approved',
        policyFingerprint,
      });
      resumeDecision = result.decision;
    } catch {
      return resumeRefusedFailure('planning_failed');
    }

    // 9. Proceed through handoff → Codex → verification → commit
    return await executeApprovedResumeCodexPhase(snapshot, resumeDecision);
  };

  /**
   * Layer 14: execute the Codex phase for an approved resume decision.
   *
   * Re-plans from the task's durable intent, re-validates the proposal against
   * the fresh plan, then executes through the same handoff → Codex →
   * verification → commit path as the live workflow (workflowService:367-551).
   * The resume decision is durable evidence of policy approval; the actual
   * execution is freshly derived and bounded by current authority.
   */
  const executeApprovedResumeCodexPhase = async (
    snapshot: ProjectTaskValidatedProposalSnapshotRecord,
    _resumeDecision: ProjectTaskResumeDecisionRecord,
  ): Promise<ProjectTaskWorkflowResult> => {
    // Re-plan from durable task intent with current registry to get a fresh
    // execution plan for the handoff build.
    const task = store.get(taskId);
    if (task === undefined || task.terminalAt !== undefined) {
      return {
        ok: false, status: 'failed', stage: 'codex',
        error: 'workflow_interrupted',
        summary: 'Task no longer available for resume.',
      };
    }

    let freshPlan;
    try {
      freshPlan = await planProjectTask(task.intent, options.registry);
    } catch {
      return {
        ok: false, status: 'failed', stage: 'planning',
        error: 'workflow_interrupted',
        summary: 'Planning failed during resume Codex phase.',
      };
    }
    if (!freshPlan.ok) {
      return {
        ok: false, status: 'failed', stage: 'planning',
        error: 'workflow_interrupted',
        summary: 'Planning failed during resume Codex phase.',
      };
    }
    const plan = freshPlan.plan;

    // Parse canonical proposal JSON from snapshot
    let proposal: ProjectOrchestrationProposal;
    try {
      proposal = JSON.parse(snapshot.canonicalProposalJson) as ProjectOrchestrationProposal;
    } catch {
      return {
        ok: false, status: 'failed', stage: 'codex',
        error: 'workflow_interrupted',
        summary: 'Failed to parse canonical proposal for Codex handoff.',
      };
    }

    // Re-validate proposal against the fresh plan
    const proposalValidation = validateProjectOrchestrationProposal(proposal, plan);
    if (!proposalValidation.success) {
      return {
        ok: false, status: 'failed', stage: 'codex',
        error: 'workflow_interrupted',
        summary: 'Proposal validation failed during resume.',
      };
    }

    // Build Codex handoff (plan + proposal, 2 args)
    const handoffResult = buildProjectCodexHandoff(plan, proposal);
    if (!handoffResult.success) {
      return {
        ok: false, status: 'failed', stage: 'codex',
        error: 'workflow_interrupted',
        summary: 'Codex handoff build failed during resume.',
      };
    }

    // Layer 16: Check for existing durable Codex success evidence.
    // When known Codex succeeded durably, skip Codex completely.
    // Evidence is state only — never grants execution authority.
    const existingStartEvidence = store.readCodexStartEvidenceByTask(snapshot.taskId);
    let codexResult: ProjectCodexExecutionResult | undefined;

    if (existingStartEvidence !== undefined) {
      const existingResultEvidence = store.readCodexResultEvidence(existingStartEvidence.codexStartId);
      if (hasCodexSuccessEvidence(existingStartEvidence, existingResultEvidence)) {
        // Known durable Codex success. Skip Codex.
        try {
          const metadata = JSON.parse(existingResultEvidence.resultMetadataJson);
          await options.onStage('codex');  // status transition: hermes → codex

          codexResult = {
            success: true,
            executionId: existingResultEvidence.executionId,
            status: 'completed' as const,
            outcome: metadata.outcome ?? 'modification_completed',
            resultText: '',
            summary: existingResultEvidence.summary,
          };

          // analysis_completed: return analyzed immediately, no verification.
          if (metadata.outcome === 'analysis_completed') {
            return {
              ok: true,
              projectId: plan.projectId,
              executionId: existingResultEvidence.executionId,
              status: 'analyzed',
              executionSummary: existingResultEvidence.summary,
              resultText: '',
              stages: ['planning', 'hermes', 'codex'] as readonly SafeTaskStage[],
            };
          }
          // modification_completed: fall through to verification path
          // using codexResult with the evidence executionId.
        } catch {
          // Corrupt metadata JSON: fall through to normal Codex path (fail-safe).
        }
      }
    }

    if (codexResult === undefined) {
      // No known durable Codex success — execute Codex normally.
      // Emit codex stage BEFORE Codex call — establishes the pre/post-Codex
      // fence for resume (same as workflowService:378-380).
      await options.onStage('codex');

      // Layer 15: durably record Codex start evidence BEFORE the external call.
      try {
        store.recordCodexStartEvidence({
          taskId: snapshot.taskId,
          executionRunId: snapshot.executionRunId,
          invocationId: snapshot.invocationId,
          launchAttemptId: snapshot.launchAttemptId,
          launchResultId: snapshot.launchResultId,
          snapshotId: snapshot.snapshotId,
        });
      } catch { /* Evidence must not gate execution. */ }

      try {
        codexResult = await executeProjectCodexHandoff(handoffResult.handoff);
      } catch {
        return {
          ok: false, status: 'failed', stage: 'codex',
          error: 'codex_execution_failed',
          summary: 'Codex execution did not complete.',
        };
      }

      // Layer 15: durably record Codex result evidence AFTER the call returns.
      try {
        const afterStartEvidence = store.readCodexStartEvidenceByTask(snapshot.taskId);
        if (afterStartEvidence !== undefined) {
          const evidence = mapCodexResultToEvidence(codexResult);
          store.recordCodexResultEvidence({
            codexStartId: afterStartEvidence.codexStartId,
            executionId: codexResult.executionId,
            outcome: evidence.outcome,
            success: evidence.success,
            error: evidence.error,
            summary: evidence.summary,
            resultMetadataJson: evidence.resultMetadataJson,
          });
        }
      } catch { /* Evidence must not gate execution. */ }
    }

    if (!codexResult.success) {
      return {
        ok: false, status: 'failed', stage: 'codex',
        error: codexResult.error,
        summary: codexResult.summary,
      };
    }

    const effectiveCapabilities = handoffResult.handoff.effectiveCapabilities;

    // No write capability → analysis only
    if (!effectiveCapabilities.includes('isolated_worktree_write')) {
      return {
        ok: true,
        projectId: plan.projectId,
        executionId: `resume-${taskId}`,
        status: 'analyzed',
        executionSummary: codexResult.summary,
        resultText: codexResult.resultText,
        stages: ['planning', 'hermes', 'codex'] as readonly SafeTaskStage[],
      };
    }

    // Write capability without tests → ready for review
    if (!effectiveCapabilities.includes('run_tests')) {
      return {
        ok: true,
        projectId: plan.projectId,
        executionId: `resume-${taskId}`,
        status: 'ready_for_review',
        executionSummary: codexResult.summary,
        resultText: codexResult.resultText,
        stages: ['planning', 'hermes', 'codex'] as readonly SafeTaskStage[],
      };
    }

    if (options.verificationRegistry === undefined) {
      return {
        ok: false, status: 'failed', stage: 'verification',
        error: 'verification_unavailable',
        summary: 'Verification is not available for this project.',
      };
    }

    // Verification
    let verificationResult: ProjectCodexVerificationResult;
    await options.onStage('verification');
    try {
      verificationResult = await verifyProjectCodexWorkspace(
        plan.repositoryRoot,
        plan.projectId,
        codexResult.executionId,
        options.verificationRegistry,
      );
    } catch {
      return {
        ok: false, status: 'failed', stage: 'verification',
        error: 'verification_unavailable',
        summary: 'Verification is not available for this project.',
      };
    }
    if (!verificationResult.success) {
      return {
        ok: false, status: 'failed', stage: 'verification',
        error: verificationResult.error,
        summary: verificationResult.summary,
      };
    }
    if (verificationResult.executionId !== codexResult.executionId) {
      return {
        ok: false, status: 'failed', stage: 'verification',
        error: 'invalid_generated_path',
        summary: 'The retained workspace could not be resolved safely.',
      };
    }

    // Visual QA
    let visualResult: ProjectVisualVerificationResult;
    try {
      visualResult = await verifyProjectVisualWorkspace(
        plan.projectId,
        codexResult.executionId,
      );
    } catch {
      return {
        ok: false, status: 'failed', stage: 'verification',
        error: 'verification_unavailable',
        summary: 'Visual verification is not available for this project.',
      };
    }
    if (!visualResult.success) {
      return {
        ok: false, status: 'failed', stage: 'verification',
        error: visualResult.error === 'visual_check_failed'
          ? 'visual_check_failed'
          : visualResult.error === 'visual_check_timeout'
            ? 'visual_check_timeout'
            : 'visual_verification_unavailable',
        summary: visualResult.summary,
      };
    }
    if (visualResult.executionId !== codexResult.executionId) {
      return {
        ok: false, status: 'failed', stage: 'verification',
        error: 'invalid_generated_path',
        summary: 'The retained workspace could not be resolved safely.',
      };
    }

    const verification = {
      status: 'verified' as const,
      checksPassed:
        verificationResult.checksPassed
        + visualResult.checksPassed,
      totalChecks:
        verificationResult.totalChecks
        + visualResult.totalChecks,
    };

    if (!effectiveCapabilities.includes('local_commit')) {
      return {
        ok: true,
        projectId: plan.projectId,
        executionId: `resume-${taskId}`,
        status: 'verified',
        executionSummary: codexResult.summary,
        resultText: codexResult.resultText,
        verification,
        stages: ['planning', 'hermes', 'codex', 'verification', 'visualQa'] as readonly SafeTaskStage[],
      };
    }

    // Commit
    let commitResult: ProjectCodexCommitResult;
    await options.onStage('commit');
    try {
      commitResult = await commitVerifiedProjectCodexWorkspace(
        plan.repositoryRoot,
        codexResult.executionId,
        effectiveCapabilities,
        verificationResult,
      );
    } catch {
      return {
        ok: false, status: 'failed', stage: 'commit',
        error: 'git_commit_failed',
        summary: 'The local commit could not be created.',
      };
    }
    if (!commitResult.success) {
      return {
        ok: false, status: 'failed', stage: 'commit',
        error: commitResult.error,
        summary: commitResult.summary,
      };
    }
    if (
      commitResult.executionId !== codexResult.executionId
      || !/^[0-9a-fA-F]{40,64}$/.test(commitResult.commit)
    ) {
      return {
        ok: false, status: 'failed', stage: 'commit',
        error: 'git_revision_failed',
        summary: 'The local commit revision could not be validated.',
      };
    }

    return {
      ok: true,
      projectId: plan.projectId,
      executionId: `resume-${taskId}`,
      status: 'committed',
      executionSummary: codexResult.summary,
      resultText: codexResult.resultText,
      verification,
      commit: commitResult.commit,
      stages: ['planning', 'hermes', 'codex', 'verification', 'visualQa', 'commit'] as readonly SafeTaskStage[],
    };
  };

  const run = async (): Promise<ProjectTaskWorkflowResult> => {
    // Re-entry after a durable Launch Attempt:
    // A) Attempt without a Launch Result: the external outcome may already be
    //    unknown; fail closed with the safe code and zero Hermes calls.
    // B) Attempt WITH a Launch Result: the external outcome is KNOWN; still
    //    zero Hermes calls, zero Codex and no automatic resume. A final
    //    Hermes failure surfaces its exact safe error; proposal_valid with a
    //    validated snapshot on a PRE-Codex task reports local_resume_available
    //    (state only, the task is NOT terminalized), and proposal_valid
    //    without a snapshot or on a POST-Codex task surfaces
    //    workflow_interrupted (the snapshot is never Codex replay permission).
    const known = knownOutcomeForTask();
    if (known !== undefined) {
      // Layer 14: resume path. When options.resume is true and the known
      // outcome is local_resume_available, enter the resume evaluation
      // and execution flow. Otherwise return the known outcome as-is.
      if (options.resume && known.ok === false && known.error === 'local_resume_available') {
        return await executeResumePath();
      }
      return known;
    }
    const existingAttempt = store.readTaskExecutionLaunchAttemptByTask(taskId);
    if (existingAttempt !== undefined) {
      return ambiguousFailure();
    }

    const task = store.get(taskId);
    if (task === undefined || task.status !== 'accepted' || task.terminalAt !== undefined) {
      throw new Error(PROJECT_TASK_DURABLE_EXECUTION_ERRORS.taskNotAvailable);
    }

    // 1. acquire the current task lease (bounded by the existing max TTL).
    store.acquireTaskLease({ taskId, leaseOwner: workerId, durationMs: PROJECT_TASK_LEASE_MAX_DURATION_MS });
    // 2. enqueue the durable dispatch.
    const dispatch: ProjectTaskDispatchRecord = store.enqueueTaskDispatch(taskId);
    // 3. claim using the exact current lease/fencing tuple.
    const claim = store.claimTaskDispatch({
      dispatchId: dispatch.dispatchId,
      leaseOwner: workerId,
      durationMs: PROJECT_TASK_LEASE_MAX_DURATION_MS,
    });
    lease = claim.lease;
    // 4. prepare the durable execution run (atomic dispatch consumption).
    const runRecord = store.prepareTaskExecutionRun({
      dispatchId: claim.dispatch.dispatchId,
      taskId,
      leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    });
    // 5. reserve the durable invocation identity.
    const invocation = store.reserveTaskExecutionInvocation({
      executionRunId: runRecord.executionRunId,
      taskId,
      leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    });

    const gate = async (): Promise<void> => crossLaunchBoundary(invocation, runRecord);

    try {
      if (options.executeWorkflow !== undefined) {
        // Test seam: the durable gate always fires first; it cannot be bypassed.
        await gate();
        return await options.executeWorkflow(options.request, options.onStage);
      }
      // 6-8. The real workflow plans, then the gate admits ONE live Hermes
      // phase, then the observable `hermes` stage is emitted, then Hermes
      // runs, and the post-Hermes result seams durably record the final
      // outcome before any local approval/Codex step: failure outcomes via
      // recordExternalLaunchResult and proposal_valid via the Layer 13 atomic
      // recordValidatedProposalResult (result + snapshot in one transaction).
      return await executeProjectTaskWorkflow(
        options.config,
        options.request,
        options.registry,
        options.verificationRegistry,
        {
          ...options.workflowDependencies,
          onStage: options.onStage,
          beforeExternalLaunch: gate,
          recordExternalLaunchResult,
          recordValidatedProposalResult,
          recordCodexStart,
          recordCodexResult,
        },
      );
    } catch (error) {
      if (gateFired) {
        // Crash/throw after the Launch Attempt boundary. If the workflow had
        // already durably recorded the final outcome, that evidence is
        // authoritative; otherwise the external outcome is unknown. Either
        // way: no automatic relaunch, no new attempt/result manufacturing.
        const known = knownOutcomeForTask();
        if (known !== undefined) {
          return known;
        }
        return ambiguousFailure();
      }
      throw error;
    }
  };

  return { run };
}

/**
 * Durable task-path entry point used by the /api/projects/tasks route.
 *
 * A store without the Layers 5-10 durable primitives fails closed: the
 * returned promise rejects and the caller terminalizes the task safely. No
 * Hermes phase can ever be reached through this path without the durable
 * boundary.
 */
export function runProjectTaskDurableExecution(
  options: ProjectTaskDurableExecutionRunnerOptions,
): Promise<ProjectTaskWorkflowResult> {
  if (!hasProjectTaskDurableExecutionPrimitives(options.store)) {
    return Promise.reject(new Error(PROJECT_TASK_DURABLE_EXECUTION_ERRORS.unsupportedStore));
  }
  return createProjectTaskDurableExecutionRunner(options).run();
}
