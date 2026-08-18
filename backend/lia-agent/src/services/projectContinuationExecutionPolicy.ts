import type { LiaAgentConfig } from '../config.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectTaskDurableExecutionStore } from '../contracts/projectTaskDurableExecution.js';
import type {
  ProjectTaskStage,
  ProjectTaskStore,
  SafeTaskError,
  SafeTaskReceipt,
} from '../contracts/projectTask.js';
import { SAFE_TASK_ERROR_MESSAGES, isSafeTaskStages } from '../contracts/projectTask.js';
import type { ProjectTaskWorkflowResult } from '../contracts/projectTaskWorkflow.js';
import type {
  ProjectGoalAutonomyPolicyRecord,
  ProjectGoalAutonomyPolicyStore,
} from '../contracts/projectGoalAutonomyPolicy.js';
import { deriveAutonomyPolicyState } from '../contracts/projectGoalAutonomyPolicy.js';
import type {
  ProjectGoalContinuationExecutionAuthorizationRecord,
  ProjectGoalContinuationExecutionAuthorizationStore,
} from '../contracts/projectGoalContinuationExecutionAuthorization.js';
import { deriveExecutionAuthorizationState } from '../contracts/projectGoalContinuationExecutionAuthorization.js';
import { runProjectTaskDurableExecution } from './projectTaskDurableExecutionRunner.js';
import {
  evaluateContinuationExecutionEligibility,
  type ContinuationExecutionEligibilityStore,
} from './projectContinuationExecutionEligibility.js';
import {
  countConsecutiveNoProgressCycles,
  resolveNoProgressThreshold,
} from './projectGoalContinuationPlanningOrchestrator.js';

/**
 * Autonomous Continuation Execution Policy (design §5) — the ONE narrow launch
 * orchestrator that feeds an already-materialized `accepted` continuation task
 * into the EXISTING durable execution runner.
 *
 * It is NOT a new engine. Its only authority-exercising call is
 * `runProjectTaskDurableExecution` (the exact entry point the intake route
 * uses). It never widens capabilities, never invokes
 * production/deploy/push/merge, and never bypasses blockedActions /
 * requiresHumanApproval (those are re-checked inside the runner's workflow).
 *
 * Structural separation (mirrors the planner→gate→launch ladder):
 *   evaluateContinuationExecutionEligibility(store, taskId)  // READ-ONLY (§2)
 *   launchContinuationTaskIfEligible(store, taskId, deps)    // the ONE caller
 */

/** The store surface the orchestrator requires: existing durable runner primitives + control reads. */
export type ContinuationExecutionPolicyStore =
  ProjectTaskDurableExecutionStore
  & ContinuationExecutionEligibilityStore
  & ProjectGoalAutonomyPolicyStore
  & ProjectGoalContinuationExecutionAuthorizationStore;

export type ContinuationLaunchDependencies = {
  workerId: string;
  config: LiaAgentConfig;
  registry: ProjectRegistrySource;
  verificationRegistry?: ProjectVerificationRegistry;
  /** Internal observability: durable stage transitions only. */
  onStage?: (stage: Exclude<ProjectTaskStage, 'accepted' | 'completed' | 'failed'>) => void;
  /** Route test seam. Invoked instead of the real workflow, never before the gate. */
  executeWorkflow?: (
    request: ProjectTaskRequest,
    onStage: (stage: Exclude<ProjectTaskStage, 'accepted' | 'completed' | 'failed'>) => void,
  ) => Promise<ProjectTaskWorkflowResult>;
  /** Clock for expiry/eligibility evaluation (default Date.now). */
  now?: () => number;
};

const safeReceipt = (result: Extract<ProjectTaskWorkflowResult, { ok: true }>): SafeTaskReceipt | undefined => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.executionId)) return undefined;
  if (typeof result.resultText !== 'string' || result.resultText.length < 1 || result.resultText.length > 6000) return undefined;
  if ((result.status === 'verified' || result.status === 'committed') && (!result.verification || !Number.isSafeInteger(result.verification.checksPassed) || !Number.isSafeInteger(result.verification.totalChecks) || result.verification.checksPassed < 0 || result.verification.totalChecks < result.verification.checksPassed)) return undefined;
  if (result.status === 'committed' && (!result.commit || !/^[0-9a-fA-F]{40,64}$/.test(result.commit))) return undefined;
  if (result.stages !== undefined && !isSafeTaskStages(result.stages)) return undefined;
  return ({
    executionId: result.executionId,
    status: result.status,
    resultText: result.resultText,
    ...(result.stages !== undefined ? { stages: [...result.stages] } : {}),
    ...(result.verification ? { verification: { status: 'verified', checksPassed: result.verification.checksPassed, totalChecks: result.verification.totalChecks } } : {}),
    ...(result.commit ? { commit: result.commit } : {}),
  });
};

const genericFailure = (): SafeTaskError => ({ code: 'workflow_failed', message: SAFE_TASK_ERROR_MESSAGES.workflow_failed });

const FAILURE_STAGES = new Set(['planning', 'hermes', 'approval', 'codex', 'verification', 'commit']);
const safeFailure = (result: Extract<ProjectTaskWorkflowResult, { ok: false }>): SafeTaskError => {
  if (!FAILURE_STAGES.has(result.stage) || !Object.hasOwn(SAFE_TASK_ERROR_MESSAGES, result.error)) return genericFailure();
  return {
    stage: result.stage,
    code: result.error,
    message: SAFE_TASK_ERROR_MESSAGES[result.error],
    ...(result.projectId && /^[A-Za-z0-9._-]{1,120}$/.test(result.projectId) ? { projectId: result.projectId } : {}),
    ...(result.executionId && /^[A-Za-z0-9_-]{1,128}$/.test(result.executionId) ? { executionId: result.executionId } : {}),
    ...(result.completedStages !== undefined && isSafeTaskStages(result.completedStages) ? { completedStages: [...result.completedStages] } : {}),
  } as SafeTaskError;
};

/** Layer 18: try to record completion evidence for the crash-window safety net. */
function tryRecordCompletionEvidence(store: ProjectTaskStore, taskId: string, receipt: SafeTaskReceipt): void {
  const durable = store as unknown as Record<string, unknown>;
  if (typeof durable.recordCompletionEvidence !== 'function') return;
  try {
    const readRun = durable.readTaskExecutionRunByTask as ((id: string) => unknown) | undefined;
    const readInvocation = durable.readTaskExecutionInvocationByRun as ((id: string) => unknown) | undefined;
    const readAttempt = durable.readTaskExecutionLaunchAttemptByInvocation as ((id: string) => unknown) | undefined;
    const readResult = durable.readTaskExecutionLaunchResultByLaunchAttempt as ((id: string) => unknown) | undefined;
    const readSnapshot = durable.readValidatedProposalSnapshotByLaunchResult as ((id: string) => unknown) | undefined;
    const readCodexStart = durable.readCodexStartEvidenceByTask as ((id: string) => unknown) | undefined;
    const readVerifyStart = durable.readVerificationStartEvidenceByTask as ((id: string) => unknown) | undefined;
    const readCommitStart = durable.readCommitStartEvidenceByTask as ((id: string) => unknown) | undefined;
    const recordEvidence = durable.recordCompletionEvidence as ((input: Record<string, unknown>) => unknown) | undefined;

    if (!readRun || !readInvocation || !readAttempt || !readResult || !readSnapshot || !recordEvidence) return;

    const executionRun = readRun.call(store, taskId) as Record<string, unknown> | undefined;
    if (!executionRun) return;
    const invocation = readInvocation.call(store, executionRun.executionRunId as string) as Record<string, unknown> | undefined;
    if (!invocation) return;
    const launchAttempt = readAttempt.call(store, invocation.invocationId as string) as Record<string, unknown> | undefined;
    if (!launchAttempt) return;
    const launchResult = readResult.call(store, launchAttempt.launchAttemptId as string) as Record<string, unknown> | undefined;
    if (!launchResult) return;
    const snapshot = readSnapshot.call(store, launchResult.launchResultId as string) as Record<string, unknown> | undefined;
    if (!snapshot) return;

    const codexStart = readCodexStart?.call(store, taskId) as Record<string, unknown> | undefined;
    const verifyStart = readVerifyStart?.call(store, taskId) as Record<string, unknown> | undefined;
    const commitStart = readCommitStart?.call(store, taskId) as Record<string, unknown> | undefined;

    recordEvidence.call(store, {
      taskId,
      executionRunId: executionRun.executionRunId,
      invocationId: invocation.invocationId,
      launchAttemptId: launchAttempt.launchAttemptId,
      launchResultId: launchResult.launchResultId,
      snapshotId: snapshot.snapshotId,
      codexStartId: codexStart?.codexStartId ?? null,
      verificationStartId: verifyStart?.verificationStartId ?? null,
      commitStartId: commitStart?.commitStartId ?? null,
      receipt,
    });
  } catch {
    // Evidence failure must not block completion.
  }
}

/**
 * The ONE production caller of `runProjectTaskDurableExecution` for
 * continuation tasks.
 *
 * Deterministic flow:
 *   1. evaluate eligibility (pure, read-only) — ineligible => throw reason;
 *   2. for `approved_single_step`, assert + consume the execution
 *      authorization (consumed exactly once, before the runner);
 *   3. invoke the EXISTING runner with the materialized task's own intent;
 *   4. apply the identical post-run terminalization the route applies.
 *
 * It cannot widen capabilities or bypass approval: the only authority call is
 * the runner, whose effective capabilities are capped by the backend ceiling.
 */
export async function launchContinuationTaskIfEligible(
  store: ContinuationExecutionPolicyStore,
  taskId: string,
  dependencies: ContinuationLaunchDependencies,
): Promise<ProjectTaskWorkflowResult> {
  const eligibility = evaluateContinuationExecutionEligibility(store, taskId, { now: dependencies.now });
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason);
  }

  // approved_single_step: consume the authorization exactly once, atomically,
  // before the runner is invoked (fail-closed on revoke/expiry/consumption).
  if (eligibility.mode === 'approved_single_step') {
    const authorization = store.assertExecutionAuthorizationValid(taskId);
    store.consumeExecutionAuthorization(authorization.authorizationId);
  }

  const task = store.get(taskId);
  if (task === undefined) {
    throw new Error('task_not_found');
  }
  const observe = (stage: Exclude<ProjectTaskStage, 'accepted' | 'completed' | 'failed'>): void => {
    (dependencies.onStage ?? ((): void => { /* noop */ }))(stage);
    store.transition(taskId, stage);
  };

  const result = await runProjectTaskDurableExecution({
    store,
    taskId,
    workerId: dependencies.workerId,
    config: dependencies.config,
    request: task.intent,
    registry: dependencies.registry,
    verificationRegistry: dependencies.verificationRegistry,
    onStage: observe,
    ...(dependencies.executeWorkflow !== undefined ? { executeWorkflow: dependencies.executeWorkflow } : {}),
  });

  // Identical post-run terminalization to the intake route.
  if (result.ok) {
    const receipt = safeReceipt(result);
    if (receipt) {
      tryRecordCompletionEvidence(store, taskId, receipt);
      store.complete(taskId, receipt);
    } else {
      store.fail(taskId, genericFailure());
    }
  } else if (result.error === 'local_resume_available') {
    // Layer 13: the task keeps its durable resumable state; it is NOT
    // terminalized and nothing is retried.
    return result;
  } else {
    store.fail(taskId, safeFailure(result));
  }

  return result;
}

/* ------------------------------------------------------------------------ *
 * Operator HUD evidence (design §12 K). Safe, bounded, read-only.
 * ------------------------------------------------------------------------ */

const MAX_VISIBLE_OBJECTIVE_CHARS = 2_000;

export type OperatorVisibleContinuationExecutionEvidence = {
  goalId: string;
  goalObjective: string;
  taskId: string;
  taskStatus: string;
  autonomyMode: string;
  policyState: string;
  eligible: boolean;
  eligibilityReason?: string;
  authorizationState: string;
  authorizationId?: string;
  lineage: {
    attemptNumber: number;
    continuationDepth: number;
    currentAttempt: number | null;
    maxAttempts: number;
    continuationDepthLimit: number;
  };
  budget: {
    attemptsRemaining: number;
    depthRemaining: number;
    cyclesRemaining?: number;
    elapsedBudgetMsRemaining?: number;
  };
  noProgress: { count: number; threshold: number; escalated: boolean };
  launchState: 'not_launched' | 'launch_attempted' | 'launch_result_recorded' | 'terminal';
  ambiguousOutcome: boolean;
  nextTaskExecuted: boolean;
  operatorActionRequired: boolean;
  blockingReason?: string;
};

export type ContinuationExecutionEvidenceOptions = {
  now?: () => number;
  noProgressEscalationThreshold?: number;
};

/**
 * Bounded, non-secret operator-visible execution evidence. Every field is a
 * direct read of an immutable durable row or a deterministic derivation. It
 * never exposes secrets, prompts, raw model output, commands, paths, session
 * ids or capability-bearing internals.
 */
export function buildContinuationExecutionEvidence(
  store: ContinuationExecutionEligibilityStore,
  taskId: string,
  options: ContinuationExecutionEvidenceOptions = {},
): OperatorVisibleContinuationExecutionEvidence {
  const now = (options.now ?? Date.now)();
  const eligibility = evaluateContinuationExecutionEligibility(store, taskId, options);

  const task = store.get(taskId);
  const goalId = task?.lineage?.goalId;
  const goal = goalId === undefined ? undefined : store.readGoal(goalId);

  const policy: ProjectGoalAutonomyPolicyRecord | undefined =
    goalId === undefined ? undefined : store.readGoalAutonomyPolicy(goalId);
  const policyState = policy === undefined
    ? 'manual_only'
    : deriveAutonomyPolicyState(policy, now);

  const authorization: ProjectGoalContinuationExecutionAuthorizationRecord | undefined =
    store.readExecutionAuthorizationByTask(taskId);
  const mode = eligibility.mode;
  const authorizationState = deriveExecutionAuthorizationState({
    authorization,
    policy,
    mode,
    now,
  });

  const launchAttempt = store.readTaskExecutionLaunchAttemptByTask(taskId);
  const launchResult = store.readTaskExecutionLaunchResultByTask(taskId);
  const ambiguousOutcome = launchAttempt !== undefined && launchResult === undefined;
  let launchState: OperatorVisibleContinuationExecutionEvidence['launchState'];
  if (task !== undefined && (task.status === 'completed' || task.status === 'failed')) {
    launchState = 'terminal';
  } else if (launchResult !== undefined) {
    launchState = 'launch_result_recorded';
  } else if (launchAttempt !== undefined) {
    launchState = 'launch_attempted';
  } else {
    launchState = 'not_launched';
  }

  const attempts = goalId === undefined ? [] : store.listGoalAttempts(goalId);
  const evaluations = goalId === undefined ? [] : store.listGoalEvaluations(goalId);
  const plans = goalId === undefined ? [] : store.listGoalContinuationPlans(goalId);
  const plan = plans.find((candidate) => candidate.status === 'consumed' && candidate.createdTaskId === taskId);
  const resolveTask = (id: string) => attempts.find((candidate) => candidate.taskId === id);
  const noProgressCount = plan === undefined
    ? 0
    : countConsecutiveNoProgressCycles(evaluations, resolveTask, plan.sourceEvaluationId);
  const threshold = goal === undefined
    ? 2
    : resolveNoProgressThreshold(options.noProgressEscalationThreshold, goal);

  const attemptsRemaining = goal === undefined
    ? 0
    : Math.max(0, goal.maxAttempts - (task?.lineage?.attemptNumber ?? 0));
  const depthRemaining = goal === undefined
    ? 0
    : Math.max(0, goal.continuationDepthLimit - (task?.lineage?.continuationDepth ?? 0));
  const cyclesRemaining = policy?.maxCycles === undefined
    ? undefined
    : Math.max(0, policy.maxCycles - (task?.lineage?.attemptNumber ?? 0));
  const elapsedBudgetMsRemaining = policy?.elapsedBudgetMs === undefined
    ? undefined
    : Math.max(0, policy.elapsedBudgetMs - (now - policy.createdAt));

  const nextTaskExecuted = task !== undefined && task.status !== 'accepted';

  const blockingReason = eligibility.eligible
    ? (ambiguousOutcome ? 'external_launch_outcome_unknown' : undefined)
    : eligibility.reason;
  const operatorActionRequired = !eligibility.eligible
    || ambiguousOutcome
    || authorizationState === 'authorization_required'
    || authorizationState === 'authorization_revoked'
    || authorizationState === 'authorization_expired'
    || authorizationState === 'authorization_invalid';

  return {
    goalId: goalId ?? '',
    goalObjective: (goal?.objective ?? '').slice(0, MAX_VISIBLE_OBJECTIVE_CHARS),
    taskId,
    taskStatus: task?.status ?? 'missing',
    autonomyMode: mode,
    policyState,
    eligible: eligibility.eligible,
    ...(eligibility.eligible ? {} : { eligibilityReason: eligibility.reason }),
    authorizationState,
    ...(authorization !== undefined ? { authorizationId: authorization.authorizationId } : {}),
    lineage: {
      attemptNumber: task?.lineage?.attemptNumber ?? 0,
      continuationDepth: task?.lineage?.continuationDepth ?? 0,
      currentAttempt: goal?.currentAttempt ?? null,
      maxAttempts: goal?.maxAttempts ?? 0,
      continuationDepthLimit: goal?.continuationDepthLimit ?? 0,
    },
    budget: {
      attemptsRemaining,
      depthRemaining,
      ...(cyclesRemaining !== undefined ? { cyclesRemaining } : {}),
      ...(elapsedBudgetMsRemaining !== undefined ? { elapsedBudgetMsRemaining } : {}),
    },
    noProgress: { count: noProgressCount, threshold, escalated: noProgressCount >= threshold },
    launchState,
    ambiguousOutcome,
    nextTaskExecuted,
    operatorActionRequired,
    ...(blockingReason !== undefined ? { blockingReason } : {}),
  };
}
