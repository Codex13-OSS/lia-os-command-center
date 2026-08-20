import { createHash, randomUUID } from 'node:crypto';
import type { LiaAgentConfig } from '../config.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectTaskRequestedCapability } from '../contracts/projectExecutor.js';
import { validateProjectTaskRequest } from '../contracts/projectExecutorValidation.js';
import {
  PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT,
  PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT,
  PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS,
  PROJECT_GOAL_ERRORS,
  PROJECT_GOAL_ID,
  PROJECT_GOAL_MAX_ATTEMPTS_LIMIT,
} from '../contracts/projectGoal.js';
import type {
  CreateGoalWithRootAttemptInput,
  CreateGoalWithRootAttemptResult,
  ProjectGoalRecord,
} from '../contracts/projectGoal.js';
import { AUTONOMOUS_V1_CEILING } from '../contracts/autonomousAuthority.js';
import {
  AUTONOMY_BOUNDED_MAX_ELAPSED_BUDGET_MS,
  AUTONOMY_MODES,
} from '../contracts/projectGoalAutonomyPolicy.js';
import {
  PROJECT_GOAL_MIN_ELAPSED_BUDGET_MS,
  type ProjectGoalEffortEstimate,
} from '../contracts/projectGoalEffortEstimate.js';
import type {
  ProjectTaskStage,
  SafeTaskError,
  SafeTaskReceipt,
} from '../contracts/projectTask.js';
import { SAFE_TASK_ERROR_MESSAGES, isSafeTaskStages } from '../contracts/projectTask.js';
import type { ProjectTaskWorkflowResult } from '../contracts/projectTaskWorkflow.js';
import {
  MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
  MAX_GOALS_PER_TICK,
} from '../contracts/projectMultiGoalOrchestration.js';
import { PROJECT_GOAL_CONTROL_ERRORS } from '../contracts/projectOperatorGoalControl.js';
import type {
  ContinuationActionRequest,
  CreateGoalRequest,
  EstimateGoalEffortRequest,
  OperatorGoalAutonomyView,
  OperatorGoalContinuationView,
  OperatorGoalDetail,
  OperatorGoalEvidenceBundle,
  OperatorGoalListItem,
  SetAutonomyRequest,
} from '../contracts/projectOperatorGoalControl.js';
import type {
  ProjectGoalContinuationApprovalStore,
} from '../contracts/projectGoalContinuationApproval.js';
import type { ProjectGoalContinuationPlanStore } from '../contracts/projectGoalContinuationPlan.js';
import {
  deriveLoopStageDetails,
  type BoundedAutonomousLoopStore,
  type DerivedLoopStageDetails,
} from './projectBoundedAutonomousLoopRuntime.js';
import { resolveAuthorizedProject } from './projectRegistry.js';
import { runProjectTaskDurableExecution } from './projectTaskDurableExecutionRunner.js';
import {
  assertSafeOperatorPayload,
  buildOperatorAutonomyView,
  buildOperatorContinuationView,
  buildOperatorGoalDetailSafe,
  buildOperatorEvidenceBundle,
  buildOperatorGoalListItemSafe,
  type OperatorGoalReadModelOptions,
} from './projectGoalControlReadModel.js';
import { estimateProjectGoalEffort } from './projectGoalEffortEstimator.js';

/**
 * Operator Goal Control Service — thin use-case layer (design:
 * operator-goal-control-surface-design.md §C/§D/§K/§N.4). Routes stay thin;
 * every use case ends in ONE existing store/supervisor primitive. No new
 * authority: the service never writes intent beyond the existing
 * `createGoalWithRootAttempt` validated intake, never launches, never
 * materializes, never widens capabilities and never starts a timer.
 *
 * The ONLY execution entry point is the root-attempt intake, which schedules
 * the EXISTING durable runner via `setImmediate` exactly like the tasks route
 * (`projectTasks.ts`). Continuation launch stays exclusively behind
 * `launchContinuationTaskIfEligible` in the supervisor path — never here.
 */

type ObservableStage = Extract<ProjectTaskStage, 'planning' | 'hermes' | 'codex' | 'verification' | 'commit'>;
export type GoalControlWorkflowExecutor = (
  request: ProjectTaskRequest,
  onStage: (stage: ObservableStage) => void,
) => Promise<ProjectTaskWorkflowResult>;

export type ProjectGoalControlServiceDependencies = {
  /** Durable store with the goal surface. Structurally guarded at the router. */
  store: ProjectGoalControlServiceStore;
  config: LiaAgentConfig;
  registry?: ProjectRegistrySource;
  verificationRegistry?: ProjectVerificationRegistry;
  /** Test seam forwarded to the intake runner, never before the durable gate. */
  executeWorkflow?: GoalControlWorkflowExecutor;
  /** Best-effort supervisor wakeup after durable root terminalization. */
  onRootTaskTerminalized?: () => void;
  now?: () => number;
  noProgressEscalationThreshold?: number;
};

export type ProjectGoalControlServiceStore =
  BoundedAutonomousLoopStore
  & ProjectGoalContinuationApprovalStore
  & ProjectGoalContinuationPlanStore
  & {
    listGoals(options?: { projectId?: string; limit?: number; includeTerminal?: boolean }): ProjectGoalRecord[];
    createGoalWithRootAttempt(input: CreateGoalWithRootAttemptInput): CreateGoalWithRootAttemptResult;
  };

export type GoalControlSuccess<T> = { ok: true; status: number; payload: T; alreadyKnown?: boolean };
export type GoalControlFailure = {
  ok: false;
  status: number;
  error: string;
  reason?: string;
  /** Fresh read-model detail so the UI converges after a 409 (§K). */
  detail?: OperatorGoalDetail;
};
export type GoalControlResult<T> = GoalControlSuccess<T> | GoalControlFailure;

const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const CEILING = new Set<string>(AUTONOMOUS_V1_CEILING);
const MODES = new Set<string>(AUTONOMY_MODES);
const SAFE_PROJECT_ID = /^[A-Za-z0-9._-]+$/;

/** sha256 intake fingerprint — identical meaning to the tasks route. */
function intakeFingerprint(request: ProjectTaskRequest): string {
  return createHash('sha256').update(JSON.stringify({
    projectId: request.projectId,
    instruction: request.instruction,
    priority: request.priority,
    requestedCapabilities: [...request.requestedCapabilities].sort(),
  })).digest('hex');
}

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

/** Layer 18 crash-window completion evidence (mirrors the tasks route). */
function tryRecordCompletionEvidence(store: ProjectGoalControlServiceStore, taskId: string, receipt: SafeTaskReceipt): void {
  const durable = store as unknown as Record<string, unknown>;
  if (typeof durable.recordCompletionEvidence !== 'function') return;
  try {
    const readRun = durable.readTaskExecutionRunByTask as ((id: string) => unknown) | undefined;
    const readInvocation = durable.readTaskExecutionInvocationByExecutionRun as ((id: string) => unknown) | undefined;
    const readAttempt = durable.readTaskExecutionLaunchAttemptByInvocation as ((id: string) => unknown) | undefined;
    const readResult = durable.readTaskExecutionLaunchResultByLaunchAttempt as ((id: string) => unknown) | undefined;
    const readSnapshot = durable.readValidatedProposalSnapshotByLaunchResult as ((id: string) => unknown) | undefined;
    const readCodexStart = durable.readCodexStartEvidenceByTask as ((id: string) => unknown) | undefined;
    const readVerifyStart = durable.readVerificationStartEvidenceByTask as ((id: string) => unknown) | undefined;
    const readCommitStart = durable.readCommitStartEvidenceByTask as ((id: string) => unknown) | undefined;
    const recordEvidence = durable.recordCompletionEvidence as ((input: Record<string, unknown>) => unknown) | undefined;
    if (!readRun || !readInvocation || !readAttempt || !readResult || !readSnapshot || !recordEvidence) return;
    const executionRun = readRun(taskId) as Record<string, unknown> | undefined;
    if (!executionRun) return;
    const invocation = readInvocation(executionRun.executionRunId as string) as Record<string, unknown> | undefined;
    if (!invocation) return;
    const launchAttempt = readAttempt(invocation.invocationId as string) as Record<string, unknown> | undefined;
    if (!launchAttempt) return;
    const launchResult = readResult(launchAttempt.launchAttemptId as string) as Record<string, unknown> | undefined;
    if (!launchResult) return;
    const snapshot = readSnapshot(launchResult.launchResultId as string) as Record<string, unknown> | undefined;
    if (!snapshot) return;
    const codexStart = readCodexStart?.(taskId) as Record<string, unknown> | undefined;
    const verifyStart = readVerifyStart?.(taskId) as Record<string, unknown> | undefined;
    const commitStart = readCommitStart?.(taskId) as Record<string, unknown> | undefined;
    recordEvidence({
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

/** Maps an unknown throw to a bounded machine code. */
function toSafeCode(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(error.message)) {
    return error.message;
  }
  return 'internal_error';
}

/**
 * Route-layer HTTP mapping for known store error codes (design §K). Unknown
 * codes fail closed as 500 `internal_error`.
 */
export function mapStoreErrorCode(code: string): { status: number; error: string } {
  if (code === 'pass_in_progress' || code === 'autonomy_suspended') return { status: 409, error: code };
  if (code.includes('capacity')) return { status: 503, error: code };
  if (code.endsWith('_not_found')) return { status: 404, error: code };
  if (code.startsWith('invalid_')) return { status: 400, error: code };
  if (code.endsWith('_unavailable')) return { status: 503, error: code };
  if (code.includes('fail_closed')) return { status: 503, error: code };
  if (
    code.endsWith('_already_exists')
    || code.endsWith('_contradictory')
    || code.endsWith('_not_resumable')
    || code.endsWith('_not_revocable')
    || code.endsWith('_not_approvable')
    || code.endsWith('_not_usable')
    || code.endsWith('_not_suspended')
    || code.endsWith('_not_consumable')
    || code.endsWith('_terminal')
    || code.endsWith('_incompatible')
    || code.endsWith('_revoked')
    || code.endsWith('_expired')
    || code.endsWith('_consumed')
    || code.endsWith('_invalid')
    || code.endsWith('_mismatch')
    || code.endsWith('_required')
    || code.endsWith('_expansion')
    || code.includes('stale')
  ) {
    return { status: 409, error: code };
  }
  return { status: 500, error: 'internal_error' };
}

const fail = (status: number, error: string, reason?: string): GoalControlFailure => ({ ok: false, status, error, ...(reason !== undefined ? { reason } : {}) });

export type GoalControlListPayload = {
  goals: OperatorGoalListItem[];
  total: number;
  activeCount: number;
  terminalCount: number;
  humanInterventionRequiredCount: number;
  executingCount: number;
  inFlight: number;
  externalExecutionCeiling: number;
  maxGoalsPerTick: number;
};

export type GoalControlService = {
  listGoals(query: { projectId?: unknown; includeTerminal?: unknown; limit?: unknown }): GoalControlResult<GoalControlListPayload>;
  getGoalDetail(goalId: string): GoalControlResult<OperatorGoalDetail>;
  getContinuationView(goalId: string): GoalControlResult<OperatorGoalContinuationView>;
  getAutonomyView(goalId: string): GoalControlResult<OperatorGoalAutonomyView>;
  getEvidenceBundle(goalId: string): GoalControlResult<OperatorGoalEvidenceBundle>;
  createGoal(input: CreateGoalRequest): Promise<GoalControlResult<{ goal: OperatorGoalDetail; alreadyKnown: boolean }>>;
  estimateEffort(input: EstimateGoalEffortRequest): GoalControlResult<{ estimate: ProjectGoalEffortEstimate }>;
  setAutonomy(goalId: string, input: SetAutonomyRequest): GoalControlResult<OperatorGoalAutonomyView>;
  suspend(goalId: string): GoalControlResult<OperatorGoalAutonomyView>;
  resume(goalId: string): GoalControlResult<OperatorGoalAutonomyView>;
  approveMaterialization(goalId: string, input: ContinuationActionRequest): GoalControlResult<{ approval: Record<string, unknown>; detail: OperatorGoalDetail }>;
  refuseMaterialization(goalId: string): GoalControlResult<{ plan: Record<string, unknown>; detail: OperatorGoalDetail }>;
  revokeApproval(goalId: string): GoalControlResult<{ approval: Record<string, unknown>; detail: OperatorGoalDetail }>;
  authorizeExecution(goalId: string, input: ContinuationActionRequest): GoalControlResult<{ authorization: Record<string, unknown>; detail: OperatorGoalDetail }>;
  revokeExecutionAuthorization(goalId: string, input: { authorizationId: unknown }): GoalControlResult<{ authorization: Record<string, unknown>; detail: OperatorGoalDetail }>;
};

export function createProjectGoalControlService(
  dependencies: ProjectGoalControlServiceDependencies,
): GoalControlService {
  const store = dependencies.store;
  const options: OperatorGoalReadModelOptions = {
    ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
    ...(dependencies.noProgressEscalationThreshold !== undefined
      ? { noProgressEscalationThreshold: dependencies.noProgressEscalationThreshold }
      : {}),
  };

  const validateGoalId = (goalId: unknown): string | GoalControlFailure => {
    if (typeof goalId !== 'string' || !PROJECT_GOAL_ID.test(goalId)) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoalId);
    }
    return goalId;
  };

  const deriveStage = (goalId: string): { ok: true; details: DerivedLoopStageDetails } | GoalControlFailure => {
    try {
      return { ok: true, details: deriveLoopStageDetails(store, goalId, options) };
    } catch {
      return fail(500, 'internal_error');
    }
  };

  const freshDetail = (goalId: string): OperatorGoalDetail | undefined => {
    try {
      const detail = buildOperatorGoalDetailSafe(store, goalId, options);
      assertSafeOperatorPayload(detail);
      return detail;
    } catch {
      return undefined;
    }
  };

  const validateApprover = (approver: unknown): string | GoalControlFailure => {
    if (typeof approver !== 'string') return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidContinuationAction);
    const trimmed = approver.trim();
    if (trimmed.length < 1 || trimmed.length > 200 || trimmed !== approver) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidContinuationAction);
    }
    return trimmed;
  };

  const validateExpiresAt = (expiresAt: unknown): number | undefined | GoalControlFailure => {
    if (expiresAt === undefined) return undefined;
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidContinuationAction);
    }
    return expiresAt;
  };

  type AutonomyValidation = { ok: true; value: SetAutonomyRequest } | GoalControlFailure;
  const validateAutonomy = (value: unknown): AutonomyValidation => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAutonomy);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.mode !== 'string' || !MODES.has(record.mode)) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAutonomy);
    }
    if (record.mode === 'suspended') {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAutonomy);
    }
    const approver = typeof record.approver === 'string' ? record.approver.trim() : undefined;
    if (approver === undefined || approver.length < 1 || approver.length > 200 || approver !== record.approver) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAutonomy);
    }
    if (record.maxCycles !== undefined
      && (typeof record.maxCycles !== 'number' || !Number.isInteger(record.maxCycles) || record.maxCycles < 1)) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAutonomy);
    }
    if (record.elapsedBudgetMs !== undefined
      && (typeof record.elapsedBudgetMs !== 'number' || !Number.isSafeInteger(record.elapsedBudgetMs) || record.elapsedBudgetMs <= 0)) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAutonomy);
    }
    if (record.expiresAt !== undefined
      && (typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0)) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAutonomy);
    }
    return {
      ok: true,
      value: {
        mode: record.mode as SetAutonomyRequest['mode'],
        approver,
        ...(record.maxCycles !== undefined ? { maxCycles: Math.min(5, record.maxCycles as number) } : {}),
        ...(record.elapsedBudgetMs !== undefined ? {
          elapsedBudgetMs: Math.min(
            AUTONOMY_BOUNDED_MAX_ELAPSED_BUDGET_MS,
            Math.max(PROJECT_GOAL_MIN_ELAPSED_BUDGET_MS, record.elapsedBudgetMs as number),
          ),
        } : {}),
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt as number } : {}),
      },
    };
  };

  const notifyRootTaskTerminalized = (): void => {
    try { dependencies.onRootTaskTerminalized?.(); } catch {
      // Durable terminal state remains authoritative if notification fails.
    }
  };

  /** Schedules the EXISTING durable runner for the root attempt, exactly like the tasks route. */
  const scheduleRootAttemptRunner = (taskId: string, request: ProjectTaskRequest): void => {
    setImmediate(() => {
      const observe = (stage: ObservableStage) => store.transition(taskId, stage);
      const run = runProjectTaskDurableExecution({
        store,
        taskId,
        workerId: `lia-goal-intake-${randomUUID()}`,
        config: dependencies.config,
        request,
        registry: dependencies.registry!,
        verificationRegistry: dependencies.verificationRegistry,
        onStage: observe,
        ...(dependencies.executeWorkflow !== undefined ? { executeWorkflow: dependencies.executeWorkflow } : {}),
      });
      void run.then((result) => {
        if (result.ok) {
          const receipt = safeReceipt(result);
          if (receipt) {
            tryRecordCompletionEvidence(store, taskId, receipt);
            store.complete(taskId, receipt);
            notifyRootTaskTerminalized();
          } else {
            store.fail(taskId, genericFailure());
            notifyRootTaskTerminalized();
          }
        } else if (result.error === 'local_resume_available') {
          // Layer 13: durable resumable state; NOT terminalized, nothing retried.
          return;
        } else {
          store.fail(taskId, safeFailure(result));
          notifyRootTaskTerminalized();
        }
      }).catch(() => {
        store.fail(taskId, genericFailure());
        notifyRootTaskTerminalized();
      });
    });
  };

  const listGoals = (query: { projectId?: unknown; includeTerminal?: unknown; limit?: unknown }): GoalControlResult<GoalControlListPayload> => {
    let projectId: string | undefined;
    if (query.projectId !== undefined) {
      if (typeof query.projectId !== 'string' || query.projectId.trim() === '' || query.projectId.length > 120 || !SAFE_PROJECT_ID.test(query.projectId)) {
        return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidProjectFilter);
      }
      projectId = query.projectId;
    }
    let includeTerminal = true;
    if (query.includeTerminal !== undefined) {
      if (query.includeTerminal !== 'true' && query.includeTerminal !== 'false') {
        return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidProjectFilter);
      }
      includeTerminal = query.includeTerminal === 'true';
    }
    let limit = 100;
    if (query.limit !== undefined) {
      if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)) {
        return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidProjectFilter);
      }
      limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10)));
    }

    let rows: ProjectGoalRecord[];
    try {
      rows = store.listGoals({ projectId, includeTerminal, limit });
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error);
    }
    const goals = rows.map((goal) => buildOperatorGoalListItemSafe(store, goal, options));
    const inFlight = goals.reduce((count, goal) => {
      const status = goal.currentTask?.status;
      return status !== undefined && ['planning', 'hermes', 'codex', 'verification', 'commit'].includes(status) ? count + 1 : count;
    }, 0);
    const payload: GoalControlListPayload = {
      goals,
      total: goals.length,
      activeCount: goals.filter((goal) => goal.status === 'active').length,
      terminalCount: goals.filter((goal) => goal.status !== 'active').length,
      humanInterventionRequiredCount: goals.filter((goal) => goal.humanInterventionRequired).length,
      executingCount: goals.filter((goal) => goal.loopStage === 'executing').length,
      inFlight,
      externalExecutionCeiling: MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
      maxGoalsPerTick: MAX_GOALS_PER_TICK,
    };
    try {
      assertSafeOperatorPayload(payload);
    } catch {
      return fail(500, 'internal_error');
    }
    return { ok: true, status: 200, payload };
  };

  const getGoalDetail = (goalId: string): GoalControlResult<OperatorGoalDetail> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    try {
      const detail = buildOperatorGoalDetailSafe(store, gid, options);
      assertSafeOperatorPayload(detail);
      return { ok: true, status: 200, payload: detail };
    } catch (error) {
      const code = toSafeCode(error);
      if (code === PROJECT_GOAL_CONTROL_ERRORS.goalNotFound || code === PROJECT_GOAL_ERRORS.goalNotFound) {
        return fail(404, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
      }
      const mapped = mapStoreErrorCode(code);
      return fail(mapped.status, mapped.error);
    }
  };

  const getContinuationView = (goalId: string): GoalControlResult<OperatorGoalContinuationView> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    try {
      const view = buildOperatorContinuationView(store, gid, options);
      assertSafeOperatorPayload(view);
      return { ok: true, status: 200, payload: view };
    } catch (error) {
      const code = toSafeCode(error);
      if (code === PROJECT_GOAL_ERRORS.goalNotFound) return fail(404, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
      const mapped = mapStoreErrorCode(code);
      return fail(mapped.status, mapped.error);
    }
  };

  const getAutonomyView = (goalId: string): GoalControlResult<OperatorGoalAutonomyView> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    try {
      const view = buildOperatorAutonomyView(store, gid, options);
      assertSafeOperatorPayload(view);
      return { ok: true, status: 200, payload: view };
    } catch (error) {
      const code = toSafeCode(error);
      if (code === PROJECT_GOAL_ERRORS.goalNotFound) return fail(404, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
      const mapped = mapStoreErrorCode(code);
      return fail(mapped.status, mapped.error);
    }
  };

  const getEvidenceBundle = (goalId: string): GoalControlResult<OperatorGoalEvidenceBundle> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    try {
      const bundle = buildOperatorEvidenceBundle(store, gid, options);
      assertSafeOperatorPayload(bundle);
      return { ok: true, status: 200, payload: bundle };
    } catch (error) {
      const code = toSafeCode(error);
      if (code === PROJECT_GOAL_ERRORS.goalNotFound) return fail(404, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
      const mapped = mapStoreErrorCode(code);
      return fail(mapped.status, mapped.error);
    }
  };

  const estimateEffort = (input: EstimateGoalEffortRequest): GoalControlResult<{ estimate: ProjectGoalEffortEstimate }> => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    }
    if (typeof input.objective !== 'string') return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const objective = input.objective.trim();
    if (objective.length < 1 || objective.length > 8_000) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const priority = input.priority ?? 'normal';
    if (!PRIORITIES.has(priority)) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    if (input.projectId !== undefined && (
      typeof input.projectId !== 'string'
      || input.projectId.length < 1
      || input.projectId.length > 120
      || !SAFE_PROJECT_ID.test(input.projectId)
      || input.projectId.includes('..')
    )) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const estimate = estimateProjectGoalEffort({
      objective,
      priority: priority as EstimateGoalEffortRequest['priority'],
    });
    return { ok: true, status: 200, payload: { estimate } };
  };

  const createGoal = async (input: CreateGoalRequest): Promise<GoalControlResult<{ goal: OperatorGoalDetail; alreadyKnown: boolean }>> => {
    const goalId = validateGoalId(input.goalId);
    if (typeof goalId !== 'string') return goalId;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);

    if (typeof input.projectId !== 'string') return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const projectId = input.projectId.trim();
    if (projectId.length < 1 || projectId.length > 120 || !SAFE_PROJECT_ID.test(projectId) || projectId.includes('..')) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    }
    if (typeof input.objective !== 'string') return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const objective = input.objective.trim();
    if (objective.length < 1 || objective.length > 20_000) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const priority = input.priority ?? 'normal';
    if (!PRIORITIES.has(priority)) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const requestedCapabilities = input.requestedCapabilities ?? [];
    if (!Array.isArray(requestedCapabilities)) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const capabilities: ProjectTaskRequestedCapability[] = [];
    for (const capability of requestedCapabilities) {
      if (typeof capability !== 'string' || !CEILING.has(capability) || capabilities.includes(capability as ProjectTaskRequestedCapability)) {
        return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
      }
      capabilities.push(capability as ProjectTaskRequestedCapability);
    }
    const maxAttempts = input.maxAttempts ?? PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS;
    const continuationDepthLimit = input.continuationDepthLimit ?? PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > PROJECT_GOAL_MAX_ATTEMPTS_LIMIT) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    }
    if (!Number.isInteger(continuationDepthLimit) || continuationDepthLimit < 0 || continuationDepthLimit > PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    }
    let autonomy: SetAutonomyRequest | undefined;
    if (input.autonomy !== undefined) {
      const validated = validateAutonomy(input.autonomy);
      if (!validated.ok) return validated;
      autonomy = validated.value;
    }
    if (autonomy?.maxCycles !== undefined) {
      autonomy = { ...autonomy, maxCycles: Math.min(autonomy.maxCycles, maxAttempts) };
    }

    // The root intent goes through the EXISTING validator (design §D): failure
    // (objective > 8000, capabilities outside the ceiling) -> 400 invalid_goal.
    const intent: ProjectTaskRequest = { projectId, instruction: objective, priority, requestedCapabilities: capabilities };
    const validation = validateProjectTaskRequest(intent);
    if (!validation.success) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
    const normalizedIntent = validation.request;

    if (dependencies.registry === undefined) {
      return fail(503, PROJECT_GOAL_CONTROL_ERRORS.registryUnavailable);
    }
    const authorization = await resolveAuthorizedProject(projectId, dependencies.registry);
    if (!authorization.ok) {
      if (authorization.error === 'project_not_found') return fail(404, PROJECT_GOAL_CONTROL_ERRORS.projectNotFound);
      if (authorization.error === 'project_disabled') return fail(403, PROJECT_GOAL_CONTROL_ERRORS.projectDisabled);
      return fail(503, PROJECT_GOAL_CONTROL_ERRORS.registryUnavailable);
    }

    const taskId = randomUUID();
    try {
      const result = store.createGoalWithRootAttempt({
        goal: { goalId, projectId, objective, maxAttempts, continuationDepthLimit },
        rootAttempt: {
          taskId,
          fingerprint: intakeFingerprint(normalizedIntent),
          intent: normalizedIntent,
          goalId,
          continuationDepth: 0,
          attemptNumber: 0,
        },
      });
      if (result.task.kind !== 'created') {
        return fail(503, PROJECT_GOAL_CONTROL_ERRORS.taskCapacityReached);
      }
      if (autonomy !== undefined) {
        store.setGoalAutonomyPolicy({ goalId, ...autonomy });
      }
      // Root attempt is created as `accepted`; the EXISTING durable runner is
      // scheduled via setImmediate exactly like the tasks route. 202 is
      // returned synchronously — the runner is never awaited here.
      scheduleRootAttemptRunner(result.task.record.taskId, normalizedIntent);
      const detail = freshDetail(goalId) ?? buildOperatorGoalDetailSafe(store, goalId, options);
      return { ok: true, status: 202, payload: { goal: detail, alreadyKnown: false } };
    } catch (error) {
      const code = toSafeCode(error);
      if (code === PROJECT_GOAL_ERRORS.goalExists) {
        // The browser may lose the first 202 response. An exact replay of the
        // same client-minted goalId and normalized intake is success; a reuse
        // with different meaning remains a fail-closed 409.
        const existing = store.readGoal(goalId);
        const rootAttempt = store.listGoalAttempts(goalId)
          .find((attempt) => attempt.lineage?.attemptNumber === 0);
        const policy = store.readGoalAutonomyPolicy(goalId);
        const sameAutonomy = autonomy === undefined
          ? policy === undefined
          : policy !== undefined
            && policy.mode === autonomy.mode
            && policy.approver === autonomy.approver
            && policy.maxCycles === autonomy.maxCycles
            && policy.elapsedBudgetMs === autonomy.elapsedBudgetMs
            && policy.expiresAt === autonomy.expiresAt;
        if (
          existing?.projectId === projectId
          && existing.objective === objective
          && existing.maxAttempts === maxAttempts
          && existing.continuationDepthLimit === continuationDepthLimit
          && rootAttempt?.fingerprint === intakeFingerprint(normalizedIntent)
          && sameAutonomy
        ) {
          const detail = freshDetail(goalId) ?? buildOperatorGoalDetailSafe(store, goalId, options);
          return { ok: true, status: 200, payload: { goal: detail, alreadyKnown: true } };
        }
      }
      if (code === PROJECT_GOAL_ERRORS.invalidLineage || code === PROJECT_GOAL_ERRORS.invalidGoal) {
        return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal);
      }
      const mapped = mapStoreErrorCode(code);
      return fail(mapped.status, mapped.error);
    }
  };

  const setAutonomy = (goalId: string, input: SetAutonomyRequest): GoalControlResult<OperatorGoalAutonomyView> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    const validated = validateAutonomy(input);
    if (!validated.ok) return validated;
    const goal = store.readGoal(gid);
    if (goal === undefined) return fail(404, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
    if (goal.status !== 'active') return fail(409, 'project_goal_terminal');
    try {
      store.setGoalAutonomyPolicy({ goalId: gid, ...validated.value });
      const view = buildOperatorAutonomyView(store, gid, options);
      assertSafeOperatorPayload(view);
      return { ok: true, status: 200, payload: view };
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error);
    }
  };

  const suspend = (goalId: string): GoalControlResult<OperatorGoalAutonomyView> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    const goal = store.readGoal(gid);
    if (goal === undefined) return fail(404, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
    if (store.readGoalAutonomyPolicy(gid) === undefined) {
      return fail(409, 'project_goal_autonomy_policy_not_found');
    }
    const already = store.readGoalAutonomyPolicy(gid)?.suspendedAt !== undefined;
    try {
      store.suspendGoalAutonomy(gid);
      const view = buildOperatorAutonomyView(store, gid, options);
      assertSafeOperatorPayload(view);
      return { ok: true, status: 200, payload: view, alreadyKnown: already };
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error);
    }
  };

  const resume = (goalId: string): GoalControlResult<OperatorGoalAutonomyView> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    const goal = store.readGoal(gid);
    if (goal === undefined) return fail(404, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
    try {
      store.resumeGoalAutonomy(gid);
      const view = buildOperatorAutonomyView(store, gid, options);
      assertSafeOperatorPayload(view);
      return { ok: true, status: 200, payload: view };
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error);
    }
  };

  /** Resolves the goal's current `planned` plan from the DERIVED stage (never client-supplied). */
  const resolvePlannedPlan = (goalId: string): { ok: true; details: DerivedLoopStageDetails; plan: NonNullable<DerivedLoopStageDetails['plan']> } | GoalControlFailure => {
    const derived = deriveStage(goalId);
    if (!derived.ok) return derived;
    const { details } = derived;
    if (details.stage === 'suspended') return fail(409, 'autonomy_suspended', details.stage);
    if (details.stage !== 'authorization_required' && details.stage !== 'materializing_next_attempt') {
      return fail(409, PROJECT_GOAL_CONTROL_ERRORS.stageMismatch, details.stage);
    }
    const plan = details.plan;
    if (plan === undefined || plan.status !== 'planned') {
      return fail(409, PROJECT_GOAL_CONTROL_ERRORS.stageMismatch, details.stage);
    }
    return { ok: true, details, plan };
  };

  const approveMaterialization = (goalId: string, input: ContinuationActionRequest): GoalControlResult<{ approval: Record<string, unknown>; detail: OperatorGoalDetail }> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidContinuationAction);
    const approver = validateApprover(input.approver);
    if (typeof approver !== 'string') return approver;
    const expiresAt = validateExpiresAt(input.expiresAt);
    if (typeof expiresAt !== 'number' && expiresAt !== undefined) return expiresAt;

    const resolved = resolvePlannedPlan(gid);
    if (!resolved.ok) return resolved;
    const { details, plan } = resolved;
    const approvalState = details.approvalState;
    if (approvalState !== 'approval_required' && approvalState !== 'approval_present') {
      return fail(409, approvalState ?? 'approval_invalid', details.stage);
    }
    const existing = store.readContinuationApproval(plan.planId);
    try {
      const approval = store.approveContinuationPlan({
        planId: plan.planId,
        approver,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      return {
        ok: true,
        status: 200,
        alreadyKnown: existing !== undefined,
        payload: {
          approval: {
            approvalId: approval.approvalId,
            planId: approval.planId,
            goalId: approval.goalId,
            approver: approval.approver,
            createdAt: approval.createdAt,
            ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
            ...(approval.revokedAt !== undefined ? { revokedAt: approval.revokedAt } : {}),
          },
          detail: freshDetail(gid) ?? buildOperatorGoalDetailSafe(store, gid, options),
        },
      };
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error, undefined);
    }
  };

  const refuseMaterialization = (goalId: string): GoalControlResult<{ plan: Record<string, unknown>; detail: OperatorGoalDetail }> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    const resolved = resolvePlannedPlan(gid);
    if (!resolved.ok) return resolved;
    const { plan } = resolved;
    const already = plan.status === 'cancelled';
    try {
      const cancelled = store.cancelContinuationPlan(plan.planId);
      return {
        ok: true,
        status: 200,
        alreadyKnown: already,
        payload: {
          plan: {
            planId: cancelled.planId,
            goalId: cancelled.goalId,
            status: cancelled.status,
            reasonCode: cancelled.reasonCode,
            ...(cancelled.cancelledAt !== undefined ? { cancelledAt: cancelled.cancelledAt } : {}),
          },
          detail: freshDetail(gid) ?? buildOperatorGoalDetailSafe(store, gid, options),
        },
      };
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error, undefined);
    }
  };

  const revokeApproval = (goalId: string): GoalControlResult<{ approval: Record<string, unknown>; detail: OperatorGoalDetail }> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    const derived = deriveStage(gid);
    if (!derived.ok) return derived;
    const { details } = derived;
    if (details.stage === 'suspended') return fail(409, 'autonomy_suspended', details.stage);
    const plan = details.plan;
    if (plan === undefined) return fail(409, PROJECT_GOAL_CONTROL_ERRORS.stageMismatch, details.stage);
    if (plan.status !== 'planned') {
      return fail(409, 'project_goal_continuation_approval_not_revocable', plan.status);
    }
    const existing = store.readContinuationApproval(plan.planId);
    if (existing === undefined) return fail(404, PROJECT_GOAL_CONTROL_ERRORS.approvalNotFound);
    const already = existing.revokedAt !== undefined;
    try {
      const revoked = store.revokeContinuationApproval(plan.planId);
      return {
        ok: true,
        status: 200,
        alreadyKnown: already,
        payload: {
          approval: {
            approvalId: revoked.approvalId,
            planId: revoked.planId,
            goalId: revoked.goalId,
            approver: revoked.approver,
            createdAt: revoked.createdAt,
            ...(revoked.expiresAt !== undefined ? { expiresAt: revoked.expiresAt } : {}),
            ...(revoked.revokedAt !== undefined ? { revokedAt: revoked.revokedAt } : {}),
          },
          detail: freshDetail(gid) ?? buildOperatorGoalDetailSafe(store, gid, options),
        },
      };
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error, undefined);
    }
  };

  const authorizeExecution = (goalId: string, input: ContinuationActionRequest): GoalControlResult<{ authorization: Record<string, unknown>; detail: OperatorGoalDetail }> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidContinuationAction);
    const approver = validateApprover(input.approver);
    if (typeof approver !== 'string') return approver;
    const expiresAt = validateExpiresAt(input.expiresAt);
    if (typeof expiresAt !== 'number' && expiresAt !== undefined) return expiresAt;

    const derived = deriveStage(gid);
    if (!derived.ok) return derived;
    const { details } = derived;
    if (details.policy === undefined) return fail(409, 'autonomy_authorization_policy_required', details.stage);
    if (details.policyState === 'suspended') return fail(409, 'autonomy_suspended', details.stage);
    if (details.policyState === 'revoked') return fail(409, 'autonomy_policy_revoked', details.stage);
    if (details.policyState === 'expired') return fail(409, 'autonomy_policy_expired', details.stage);
    if (details.policy.mode !== 'approved_single_step') {
      return fail(409, 'autonomy_authorization_policy_mode_mismatch', details.stage);
    }
    const nextTask = details.nextTask;
    if (nextTask === undefined || nextTask.status !== 'accepted') {
      return fail(409, PROJECT_GOAL_CONTROL_ERRORS.stageMismatch, details.stage);
    }
    const plan = details.plan !== undefined && details.plan.status === 'consumed' && details.plan.createdTaskId === nextTask.taskId
      ? details.plan
      : store.listGoalContinuationPlans(gid).find(
        (candidate) => candidate.status === 'consumed' && candidate.createdTaskId === nextTask.taskId,
      );
    if (plan === undefined) {
      return fail(409, PROJECT_GOAL_CONTROL_ERRORS.stageMismatch, details.stage);
    }
    const existing = store.readExecutionAuthorizationByTask(nextTask.taskId);
    try {
      const authorization = store.createExecutionAuthorization({
        goalId: gid,
        taskId: nextTask.taskId,
        planId: plan.planId,
        approver,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      return {
        ok: true,
        status: 200,
        alreadyKnown: existing !== undefined,
        payload: {
          authorization: {
            authorizationId: authorization.authorizationId,
            goalId: authorization.goalId,
            taskId: authorization.taskId,
            planId: authorization.planId,
            approver: authorization.approver,
            createdAt: authorization.createdAt,
            ...(authorization.expiresAt !== undefined ? { expiresAt: authorization.expiresAt } : {}),
            ...(authorization.revokedAt !== undefined ? { revokedAt: authorization.revokedAt } : {}),
          },
          detail: freshDetail(gid) ?? buildOperatorGoalDetailSafe(store, gid, options),
        },
      };
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error, undefined);
    }
  };

  const revokeExecutionAuthorization = (goalId: string, input: { authorizationId: unknown }): GoalControlResult<{ authorization: Record<string, unknown>; detail: OperatorGoalDetail }> => {
    const gid = validateGoalId(goalId);
    if (typeof gid !== 'string') return gid;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAuthorizationAction);
    const { authorizationId } = input;
    if (typeof authorizationId !== 'string' || !PROJECT_GOAL_ID.test(authorizationId)) {
      return fail(400, PROJECT_GOAL_CONTROL_ERRORS.invalidAuthorizationAction);
    }
    const existing = store.readExecutionAuthorization(authorizationId);
    if (existing === undefined || existing.goalId !== gid) {
      return fail(404, PROJECT_GOAL_CONTROL_ERRORS.authorizationNotFound);
    }
    const already = existing.revokedAt !== undefined;
    try {
      const revoked = store.revokeExecutionAuthorization(authorizationId);
      return {
        ok: true,
        status: 200,
        alreadyKnown: already,
        payload: {
          authorization: {
            authorizationId: revoked.authorizationId,
            goalId: revoked.goalId,
            taskId: revoked.taskId,
            planId: revoked.planId,
            approver: revoked.approver,
            createdAt: revoked.createdAt,
            ...(revoked.expiresAt !== undefined ? { expiresAt: revoked.expiresAt } : {}),
            ...(revoked.revokedAt !== undefined ? { revokedAt: revoked.revokedAt } : {}),
          },
          detail: freshDetail(gid) ?? buildOperatorGoalDetailSafe(store, gid, options),
        },
      };
    } catch (error) {
      const mapped = mapStoreErrorCode(toSafeCode(error));
      return fail(mapped.status, mapped.error, undefined);
    }
  };

  return {
    listGoals,
    getGoalDetail,
    getContinuationView,
    getAutonomyView,
    getEvidenceBundle,
    estimateEffort,
    createGoal,
    setAutonomy,
    suspend,
    resume,
    approveMaterialization,
    refuseMaterialization,
    revokeApproval,
    authorizeExecution,
    revokeExecutionAuthorization,
  };
}
