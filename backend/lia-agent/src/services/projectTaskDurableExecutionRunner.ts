import type { LiaAgentConfig } from '../config.js';
import {
  ExternalLaunchOutcomeUnknownError,
  PROJECT_TASK_DURABLE_EXECUTION_ERRORS,
  type ProjectTaskDurableExecutionStore,
} from '../contracts/projectTaskDurableExecution.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { ProjectTaskStage, ProjectTaskStore } from '../contracts/projectTask.js';
import type { ProjectTaskWorkflowResult } from '../contracts/projectTaskWorkflow.js';
import type { ProjectTaskLeaseRecord } from '../contracts/projectTaskLease.js';
import { PROJECT_TASK_LEASE_MAX_DURATION_MS } from '../contracts/projectTaskLease.js';
import type { ProjectTaskDispatchRecord } from '../contracts/projectTaskDispatch.js';
import type { ProjectTaskExecutionRunRecord } from '../contracts/projectTaskExecutionRun.js';
import type { ProjectTaskExecutionInvocationRecord } from '../contracts/projectTaskExecutionInvocation.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import type { ProjectTaskWorkflowDependencies } from './projectTaskWorkflowService.js';
import { executeProjectTaskWorkflow } from './projectTaskWorkflowService.js';

export type ProjectTaskDurableObservableStage = Extract<
  ProjectTaskStage,
  'planning' | 'hermes' | 'codex' | 'verification' | 'commit'
>;

/**
 * Structural capability guard: detects a store that exposes every existing
 * Layers 5-10 durable primitive required by the runner. The in-memory product
 * fallback deliberately fails this guard, so a non-durable product store can
 * never reach a live Hermes phase through the durable task path.
 */
export function hasProjectTaskDurableExecutionPrimitives(
  store: { [Key in keyof ProjectTaskDurableExecutionStore]?: unknown },
): store is ProjectTaskDurableExecutionStore {
  return typeof store.acquireTaskLease === 'function'
    && typeof store.enqueueTaskDispatch === 'function'
    && typeof store.claimTaskDispatch === 'function'
    && typeof store.prepareTaskExecutionRun === 'function'
    && typeof store.reserveTaskExecutionInvocation === 'function'
    && typeof store.beginTaskExecutionLaunchAttempt === 'function';
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
  /** Optional workflow fakes for controlled tests. onStage and the gate are always owned by the runner. */
  workflowDependencies?: Omit<ProjectTaskWorkflowDependencies, 'onStage' | 'beforeExternalLaunch'>;
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

/**
 * Layer 11 controlled external launch caller.
 *
 * It connects the existing Layers 5-10 durable primitives (lease, dispatch,
 * execution run, invocation, launch attempt) to the real /api/projects/tasks
 * execution path through a narrow workflow seam. It owns only task identity,
 * worker/lease identity, fencing, dispatch identity, run/invocation identity
 * and the Launch Attempt gate. The existing workflow owns planning,
 * authorization/policy validation, Hermes proposal validation, effective
 * capability derivation, Codex, verification and the optional local commit.
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
 *
 * created=true from beginTaskExecutionLaunchAttempt is ephemeral permission
 * for THIS live process only and is never persisted as retry permission.
 * created=false, an existing attempt, a stale/expired/wrong-fencing lease or
 * any contested boundary state produce zero Hermes calls. A crash after the
 * gate leaves durable ambiguity evidence and no automatic relaunch.
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

  const run = async (): Promise<ProjectTaskWorkflowResult> => {
    // An existing Launch Attempt means the external outcome may already be
    // unknown; fail closed with the safe code and zero Hermes calls.
    if (store.readTaskExecutionLaunchAttemptByTask(taskId) !== undefined) {
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
      // phase, then the observable `hermes` stage is emitted, then Hermes runs.
      return await executeProjectTaskWorkflow(
        options.config,
        options.request,
        options.registry,
        options.verificationRegistry,
        { ...options.workflowDependencies, onStage: options.onStage, beforeExternalLaunch: gate },
      );
    } catch (error) {
      if (gateFired) {
        // Crash/throw after the Launch Attempt boundary: external outcome is
        // unknown. No automatic relaunch; the attempt record is the evidence.
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
