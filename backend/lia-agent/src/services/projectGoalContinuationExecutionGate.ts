import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import type { ProjectGoalEvaluationRecord } from '../contracts/projectGoalEvaluation.js';
import type { ProjectGoalContinuationPlanRecord } from '../contracts/projectGoalContinuationPlan.js';
import type {
  ContinuationApprovalState,
  ProjectGoalContinuationApprovalRecord,
} from '../contracts/projectGoalContinuationApproval.js';
import { deriveContinuationApprovalState } from '../contracts/projectGoalContinuationApproval.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';
import type { ProjectContinuationMaterializationResult } from '../contracts/projectContinuationRuntime.js';
import { PROJECT_CONTINUATION_RUNTIME_ERRORS } from '../contracts/projectContinuationRuntime.js';
import type { ProjectGoalAutonomyPolicyRecord } from '../contracts/projectGoalAutonomyPolicy.js';
import {
  countConsecutiveNoProgressCycles,
  resolveNoProgressThreshold,
} from './projectGoalContinuationPlanningOrchestrator.js';

/**
 * Goal Continuation Execution Gate — the autonomy boundary BETWEEN a durable
 * `planned` continuation plan and the existing `materializeContinuation`
 * primitive (design: goal-continuation-execution-gating-design.md).
 *
 * It is a pure GATE: it asserts plan usability + a valid one-shot human
 * approval, then calls the EXISTING, already-exactly-once
 * `materializeContinuation` and returns its result. It creates the next task
 * ONLY through that primitive and NEVER dispatches, leases or executes it.
 *
 * Authority model (ratified):
 *  - LÍA's deterministic gate is authoritative. Hermes is advisory only and
 *    has no code path that writes a plan, approval, status or task.
 *  - Codex is not involved in this boundary at all.
 *  - The plan is zero-authority data; the approval is zero-capability state.
 *  - The next task's capabilities are inherited only from the validated parent
 *    and re-validated inside materializeContinuation + its triggers.
 */

/**
 * The store surface this orchestrator requires. It is a STRICT subset of the
 * SQLite store: it deliberately exposes no task creation, no dispatch/lease/
 * execution methods, and no Hermes/Codex/workflow entry points. That absence
 * is a structural guarantee the gate can never cross into execution.
 */
export interface ContinuationExecutionGateStore {
  assertContinuationPlanUsable(planId: string): ProjectGoalContinuationPlanRecord;
  assertContinuationApprovalValid(planId: string): ProjectGoalContinuationApprovalRecord;
  materializeContinuation(planId: string): ProjectContinuationMaterializationResult;
  readGoal(goalId: string): ProjectGoalRecord | undefined;
  readContinuationPlan(planId: string): ProjectGoalContinuationPlanRecord | undefined;
  readContinuationApproval(planId: string): ProjectGoalContinuationApprovalRecord | undefined;
}

export interface BoundedContinuationExecutionGateStore extends ContinuationExecutionGateStore {
  readGoalAutonomyPolicy(goalId: string): ProjectGoalAutonomyPolicyRecord | undefined;
}

export const PROJECT_GOAL_CONTINUATION_GATE_ERRORS = {
  forbiddenAuthority: 'project_goal_continuation_gate_forbidden_authority',
} as const;

/**
 * Structural authority guard: neither the plan nor the approval may carry any
 * capability/command/execution-bearing field. This is compile-time guaranteed
 * by their contracts; the runtime check is the fail-closed re-assertion that
 * the gate never forwards forbidden execution authority.
 */
const FORBIDDEN_AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  'approvedCapabilities',
  'effectiveCapabilities',
  'requestedCapabilities',
  'command',
  'commands',
  'executor',
  'steps',
  'dependencies',
  'sessionId',
  'shell',
  'paths',
  'worktreePath',
]);

export function assertNoForbiddenAuthority(
  plan: ProjectGoalContinuationPlanRecord,
  approval: ProjectGoalContinuationApprovalRecord | undefined,
): void {
  for (const key of Object.keys(plan)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
      throw new Error(PROJECT_GOAL_CONTINUATION_GATE_ERRORS.forbiddenAuthority);
    }
  }
  if (approval !== undefined) {
    for (const key of Object.keys(approval)) {
      if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_GATE_ERRORS.forbiddenAuthority);
      }
    }
  }
}

/**
 * The ONLY production caller of `materializeContinuation`.
 *
 * Deterministic validation order:
 *  1. plan exists (readContinuationPlan);
 *  2. an already-consumed plan is an idempotent replay — the consumed branch of
 *     `materializeContinuation` returns the existing immutable task without
 *     consulting approval again (approval is inert post-materialization);
 *  3. otherwise the plan must still be usable (`assertContinuationPlanUsable`
 *     re-validates the source evaluation, active goal, parent lineage,
 *     attempt/depth budget and the deterministic instruction);
 *  4. a valid, unrevoked, unexpired, lineage-matching approval must exist
 *     (`assertContinuationApprovalValid`);
 *  5. neither the plan nor the approval carries forbidden authority;
 *  6. only then may the EXISTING materialization primitive run.
 *
 * Exactly-once and idempotency are inherited from `materializeContinuation`
 * verbatim; this function adds no second write and performs no dispatch/lease/
 * execution/Hermes/Codex work.
 */
export function materializeApprovedContinuation(
  store: ContinuationExecutionGateStore,
  planId: string,
): ProjectContinuationMaterializationResult {
  const plan = store.readContinuationPlan(planId);
  if (plan === undefined) {
    throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.planNotFound);
  }
  if (plan.status === 'consumed') {
    return store.materializeContinuation(planId);
  }
  store.assertContinuationPlanUsable(planId);
  const approval = store.assertContinuationApprovalValid(planId);
  assertNoForbiddenAuthority(plan, approval);
  return store.materializeContinuation(planId);
}

/**
 * Materializes under the operator's durable bounded policy instead of claiming
 * a new per-plan human approval. The policy carries no capability and this
 * gate still re-validates plan lineage plus attempt/depth/cycle/time bounds.
 */
export function materializeBoundedAutonomousContinuation(
  store: BoundedContinuationExecutionGateStore,
  planId: string,
  now: number = Date.now(),
): ProjectContinuationMaterializationResult {
  const plan = store.readContinuationPlan(planId);
  if (plan === undefined) throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.planNotFound);
  if (plan.status === 'consumed') return store.materializeContinuation(planId);
  store.assertContinuationPlanUsable(planId);
  const policy = store.readGoalAutonomyPolicy(plan.goalId);
  if (policy === undefined || policy.mode !== 'bounded_autonomous') throw new Error('autonomy_manual_only');
  if (policy.revokedAt !== undefined) throw new Error('autonomy_policy_revoked');
  if (policy.suspendedAt !== undefined) throw new Error('autonomy_suspended');
  if (policy.expiresAt !== undefined && now >= policy.expiresAt) throw new Error('autonomy_policy_expired');
  if (policy.elapsedBudgetMs !== undefined && now - policy.createdAt >= policy.elapsedBudgetMs) {
    throw new Error('autonomy_elapsed_budget_exhausted');
  }
  if (policy.maxCycles !== undefined && plan.nextAttemptNumber >= policy.maxCycles) {
    throw new Error('autonomy_cycle_limit_reached');
  }
  assertNoForbiddenAuthority(plan, undefined);
  return store.materializeContinuation(planId);
}

const MAX_VISIBLE_OBJECTIVE_CHARS = 2_000;

export type ContinuationGateAuthorizationState =
  | 'materialized'
  | 'allowed'
  | 'pending'
  | 'refused';

export type ContinuationGateMaterializationState =
  | 'pending'
  | 'materialized';

/**
 * Bounded, non-secret operator-visible gate evidence. Every field is a direct
 * read of an immutable durable row or a deterministic derivation of one; it
 * never exposes capabilities, paths, commands, raw model output, secrets or
 * session identifiers.
 */
export type OperatorVisibleContinuationGateEvidence = {
  goalId: string;
  goalObjective: string;
  planId: string;
  planStatus: string;
  planReasonCode: string;
  nextAttemptNumber: number;
  nextContinuationDepth: number;
  maxAttempts: number;
  continuationDepthLimit: number;
  approvalState: ContinuationApprovalState;
  /** Present exactly when an approval row exists. */
  approvalId?: string;
  authorizationState: ContinuationGateAuthorizationState;
  refusalReason?: string;
  materializationState: ContinuationGateMaterializationState;
  /** Present exactly after successful materialization. */
  createdTaskId?: string;
  /** The materialized task's durable status; 'accepted' means NOT executed. */
  nextTaskExecutionState?: string;
  /** Hard invariant: this boundary never executes the next task. */
  nextTaskExecuted: false;
  noProgress: {
    count: number;
    threshold: number;
    escalated: boolean;
  };
};

/** Read-only store surface for the derived operator HUD (no dispatch/execution). */
export interface ContinuationGateEvidenceStore {
  readGoal(goalId: string): ProjectGoalRecord | undefined;
  readContinuationPlan(planId: string): ProjectGoalContinuationPlanRecord | undefined;
  readContinuationApproval(planId: string): ProjectGoalContinuationApprovalRecord | undefined;
  readGoalEvaluation(evaluationId: string): ProjectGoalEvaluationRecord | undefined;
  listGoalEvaluations(goalId: string): ProjectGoalEvaluationRecord[];
  listGoalAttempts(goalId: string): ProjectTaskRecord[];
}

export type ContinuationGateEvidenceOptions = {
  noProgressEscalationThreshold?: number;
  /** Clock for expiry evaluation (default Date.now). Align with the store's clock in tests. */
  now?: () => number;
};

/**
 * Derives bounded operator-visible gate evidence from durable rows only.
 * Throws `planNotFound` when the plan does not exist. Read-only: it performs
 * no write and can never trigger materialization or execution.
 */
export function buildContinuationGateEvidence(
  store: ContinuationGateEvidenceStore,
  planId: string,
  options: ContinuationGateEvidenceOptions = {},
): OperatorVisibleContinuationGateEvidence {
  const plan = store.readContinuationPlan(planId);
  if (plan === undefined) {
    throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.planNotFound);
  }
  const goal = store.readGoal(plan.goalId);
  const approval = store.readContinuationApproval(planId);
  const evaluation = store.readGoalEvaluation(plan.sourceEvaluationId);
  const now = (options.now ?? Date.now)();

  const approvalState = deriveContinuationApprovalState({
    plan,
    approval,
    evaluation,
    goal,
    now,
  });

  const materialized = plan.status === 'consumed' && plan.createdTaskId !== undefined;
  let authorizationState: ContinuationGateAuthorizationState;
  let refusalReason: string | undefined;
  if (materialized) {
    authorizationState = 'materialized';
  } else if (approvalState === 'approval_present') {
    authorizationState = 'allowed';
  } else if (approvalState === 'approval_required') {
    authorizationState = 'pending';
  } else {
    authorizationState = 'refused';
    refusalReason = approvalState;
  }

  const threshold = goal === undefined
    ? 2
    : resolveNoProgressThreshold(options.noProgressEscalationThreshold, goal);
  const evaluations = goal === undefined ? [] : store.listGoalEvaluations(plan.goalId);
  const attempts = goal === undefined ? [] : store.listGoalAttempts(plan.goalId);
  const resolveTask = (taskId: string): ProjectTaskRecord | undefined =>
    attempts.find((attempt) => attempt.taskId === taskId);
  const noProgressCount = countConsecutiveNoProgressCycles(
    evaluations,
    resolveTask,
    plan.sourceEvaluationId,
  );

  const createdTaskId = materialized ? plan.createdTaskId : undefined;
  let nextTaskExecutionState: string | undefined;
  if (createdTaskId !== undefined) {
    const task = attempts.find((attempt) => attempt.taskId === createdTaskId);
    nextTaskExecutionState = task?.status;
  }

  return {
    goalId: plan.goalId,
    goalObjective: (goal?.objective ?? '').slice(0, MAX_VISIBLE_OBJECTIVE_CHARS),
    planId: plan.planId,
    planStatus: plan.status,
    planReasonCode: plan.reasonCode,
    nextAttemptNumber: plan.nextAttemptNumber,
    nextContinuationDepth: plan.nextContinuationDepth,
    maxAttempts: goal?.maxAttempts ?? 0,
    continuationDepthLimit: goal?.continuationDepthLimit ?? 0,
    approvalState,
    ...(approval !== undefined ? { approvalId: approval.approvalId } : {}),
    authorizationState,
    ...(refusalReason !== undefined ? { refusalReason } : {}),
    materializationState: materialized ? 'materialized' : 'pending',
    ...(createdTaskId !== undefined ? { createdTaskId } : {}),
    ...(nextTaskExecutionState !== undefined ? { nextTaskExecutionState } : {}),
    nextTaskExecuted: false,
    noProgress: {
      count: noProgressCount,
      threshold,
      escalated: noProgressCount >= threshold,
    },
  };
}
