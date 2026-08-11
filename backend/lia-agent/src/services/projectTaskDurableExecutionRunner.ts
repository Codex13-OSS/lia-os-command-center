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
    && typeof store.readValidatedProposalSnapshotByLaunchResult === 'function';
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
        return localResumeAvailableFailure();
      }
      return knownOutcomeFailure('proposal_valid');
    }
    return knownOutcomeFailure(result.outcomeClass);
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
