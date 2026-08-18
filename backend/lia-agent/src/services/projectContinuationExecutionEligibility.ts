import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import type { ProjectGoalEvaluationRecord } from '../contracts/projectGoalEvaluation.js';
import type { ProjectGoalContinuationPlanRecord } from '../contracts/projectGoalContinuationPlan.js';
import type {
  AutonomyMode,
  ProjectGoalAutonomyPolicyRecord,
} from '../contracts/projectGoalAutonomyPolicy.js';
import { AUTONOMY_POLICY_DEFAULT_MODE } from '../contracts/projectGoalAutonomyPolicy.js';
import type { ProjectGoalContinuationExecutionAuthorizationRecord } from '../contracts/projectGoalContinuationExecutionAuthorization.js';
import type { ProjectTaskExecutionLaunchAttemptRecord } from '../contracts/projectTaskExecutionLaunchAttempt.js';
import type { ProjectTaskExecutionLaunchResultRecord } from '../contracts/projectTaskExecutionLaunchResult.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';
import {
  AUTONOMOUS_V1_CEILING,
  AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES,
} from '../contracts/autonomousAuthority.js';
import { PROJECT_CONTINUATION_RUNTIME_ERRORS } from '../contracts/projectContinuationRuntime.js';
import { isSafeContinuationInstruction } from './projectContinuationPlanner.js';
import {
  countConsecutiveNoProgressCycles,
  resolveNoProgressThreshold,
} from './projectGoalContinuationPlanningOrchestrator.js';

/**
 * LÍA-owned deterministic execution eligibility predicate (design §2 E1–E17).
 *
 * It is a PURE, READ-ONLY function over immutable durable state plus the
 * current policy read. It performs no write and cannot launch. Its store
 * surface deliberately excludes dispatch/lease/execution primitives so it is
 * structurally unable to cross into execution.
 */

/** Read-only store surface. The absence of write/execution methods is a structural guarantee. */
export interface ContinuationExecutionEligibilityStore {
  get(taskId: string): ProjectTaskRecord | undefined;
  readGoal(goalId: string): ProjectGoalRecord | undefined;
  listGoalContinuationPlans(goalId: string): ProjectGoalContinuationPlanRecord[];
  readTaskExecutionLaunchAttemptByTask(taskId: string): ProjectTaskExecutionLaunchAttemptRecord | undefined;
  readTaskExecutionLaunchResultByTask(taskId: string): ProjectTaskExecutionLaunchResultRecord | undefined;
  readGoalAutonomyPolicy(goalId: string): ProjectGoalAutonomyPolicyRecord | undefined;
  readExecutionAuthorizationByTask(taskId: string): ProjectGoalContinuationExecutionAuthorizationRecord | undefined;
  listGoalEvaluations(goalId: string): ProjectGoalEvaluationRecord[];
  listGoalAttempts(goalId: string): ProjectTaskRecord[];
}

export type ContinuationExecutionEligibilityResult =
  | { eligible: true; mode: AutonomyMode }
  | { eligible: false; reason: string; mode: AutonomyMode };

export type ContinuationExecutionEligibilityOptions = {
  now?: () => number;
  noProgressEscalationThreshold?: number;
};

/** Deterministic ineligibility reason codes (E1–E17 + fail-closed facts). */
export const CONTINUATION_EXECUTION_ELIGIBILITY_REASONS = {
  taskNotFound: 'task_not_found',
  taskNotContinuation: 'task_not_continuation',
  goalNotFound: 'goal_not_found',
  goalTerminal: PROJECT_CONTINUATION_RUNTIME_ERRORS.goalTerminal,
  taskNotAccepted: 'task_not_accepted',
  taskCorrupt: 'task_corrupt_record',
  planLineageMismatch: 'continuation_plan_lineage_mismatch',
  launchOutcomeUnknown: 'external_launch_outcome_unknown',
  launchResultRecorded: 'external_launch_result_recorded',
  capabilityExpansion: 'capability_expansion',
  forbiddenCapability: 'forbidden_capability',
  unsafeInstruction: 'unsafe_continuation_instruction',
  staleCurrentAttempt: 'stale_current_attempt',
  attemptLimitReached: 'attempt_limit_reached',
  depthLimitReached: 'depth_limit_reached',
  contradictoryEvidence: 'contradictory_evidence',
  projectMismatch: 'project_mismatch',
  noProgressEscalation: 'no_progress_escalation',
} as const;

const CEILING = new Set<string>(AUTONOMOUS_V1_CEILING);
const FORBIDDEN = new Set<string>(AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES);

/**
 * Deterministic, read-only eligibility evaluation. Any MUST-PASS failure or
 * any MUST-FAIL-CLOSED fact returns `{ eligible: false, reason }`. The result
 * carries the autonomy mode in force so the operator HUD can render it.
 */
export function evaluateContinuationExecutionEligibility(
  store: ContinuationExecutionEligibilityStore,
  taskId: string,
  options: ContinuationExecutionEligibilityOptions = {},
): ContinuationExecutionEligibilityResult {
  const now = (options.now ?? Date.now)();

  const task = store.get(taskId);
  if (task === undefined) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.taskNotFound, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }
  if (task.lineage === undefined) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.taskNotContinuation, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }
  const goalId = task.lineage.goalId;

  const goal = store.readGoal(goalId);
  if (goal === undefined) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.goalNotFound, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E1: goal active.
  if (goal.status !== 'active') {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.goalTerminal, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E2: the exact materialized continuation task, still non-terminal.
  if (task.status !== 'accepted' || task.terminalAt !== undefined) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.taskNotAccepted, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }
  // E12: no failed-closed reconciliation evidence on an accepted task.
  if (task.error !== undefined) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.taskCorrupt, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E3: plan→task lineage exact (consumed plan created exactly this task).
  const plans = store.listGoalContinuationPlans(goalId);
  const plan = plans.find((candidate) => candidate.status === 'consumed' && candidate.createdTaskId === taskId);
  if (plan === undefined || plan.goalId !== goalId) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.planLineageMismatch, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E4 (MUST FAIL CLOSED): no existing launch attempt and no known launch
  // result. Presence of either forbids a new launch (at-most-once boundary).
  const launchAttempt = store.readTaskExecutionLaunchAttemptByTask(taskId);
  const launchResult = store.readTaskExecutionLaunchResultByTask(taskId);
  if (launchAttempt !== undefined && launchResult === undefined) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.launchOutcomeUnknown, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }
  if (launchResult !== undefined) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.launchResultRecorded, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E6/E7: capability ceiling unchanged and re-validated.
  for (const capability of task.intent.requestedCapabilities) {
    if (!CEILING.has(capability)) {
      return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.capabilityExpansion, mode: AUTONOMY_POLICY_DEFAULT_MODE };
    }
  }
  for (const capability of task.intent.requestedCapabilities) {
    if (FORBIDDEN.has(capability)) {
      return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.forbiddenCapability, mode: AUTONOMY_POLICY_DEFAULT_MODE };
    }
  }

  // E8: the inherited instruction already passed the safe-instruction gate.
  if (!isSafeContinuationInstruction(plan.instruction)) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.unsafeInstruction, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E9: budgets remain and the task is the current allowed continuation attempt.
  if (task.lineage.attemptNumber !== goal.currentAttempt) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.staleCurrentAttempt, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }
  if (task.lineage.attemptNumber >= goal.maxAttempts) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.attemptLimitReached, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }
  if (task.lineage.continuationDepth > goal.continuationDepthLimit) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.depthLimitReached, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E11: no contradictory durable evidence.
  if (task.intent.projectId !== goal.projectId) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.projectMismatch, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }
  const evaluations = store.listGoalEvaluations(goalId);
  const source = evaluations.find((evaluation) => evaluation.evaluationId === plan.sourceEvaluationId);
  if (source === undefined || source.appliedAt === undefined || source.decision !== 'retryable') {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.contradictoryEvidence, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E10: no-progress/runaway state below threshold.
  const attempts = store.listGoalAttempts(goalId);
  const resolveTask = (id: string): ProjectTaskRecord | undefined =>
    attempts.find((attempt) => attempt.taskId === id);
  const noProgressCount = countConsecutiveNoProgressCycles(evaluations, resolveTask, plan.sourceEvaluationId);
  const threshold = resolveNoProgressThreshold(options.noProgressEscalationThreshold, goal);
  if (noProgressCount >= threshold) {
    return { eligible: false, reason: CONTINUATION_EXECUTION_ELIGIBILITY_REASONS.noProgressEscalation, mode: AUTONOMY_POLICY_DEFAULT_MODE };
  }

  // E13: operator cancellation/hold (policy suspended/revoked/expired) and the
  // bounded-mode elapsed budget (E17).
  const policy = store.readGoalAutonomyPolicy(goalId);
  const mode: AutonomyMode = policy === undefined ? AUTONOMY_POLICY_DEFAULT_MODE : policy.mode;
  if (policy !== undefined) {
    if (policy.revokedAt !== undefined) {
      return { eligible: false, reason: 'autonomy_policy_revoked', mode };
    }
    if (policy.suspendedAt !== undefined) {
      return { eligible: false, reason: 'autonomy_suspended', mode };
    }
    if (policy.expiresAt !== undefined && now >= policy.expiresAt) {
      return { eligible: false, reason: 'autonomy_policy_expired', mode };
    }
    if (policy.elapsedBudgetMs !== undefined && now - policy.createdAt >= policy.elapsedBudgetMs) {
      return { eligible: false, reason: 'autonomy_elapsed_budget_exhausted', mode };
    }
    if (policy.maxCycles !== undefined && task.lineage.attemptNumber >= policy.maxCycles) {
      return { eligible: false, reason: 'autonomy_cycle_limit_reached', mode };
    }
  }

  // E14: a valid execution authorization exists for the mode in force.
  if (mode === 'manual_only') {
    return { eligible: false, reason: 'autonomy_manual_only', mode };
  }
  if (mode === 'approved_single_step') {
    const authorization = store.readExecutionAuthorizationByTask(taskId);
    if (authorization === undefined) {
      return { eligible: false, reason: 'autonomy_authorization_required', mode };
    }
    if (authorization.revokedAt !== undefined) {
      return { eligible: false, reason: 'autonomy_authorization_revoked', mode };
    }
    if (authorization.consumedAt !== undefined) {
      return { eligible: false, reason: 'autonomy_authorization_consumed', mode };
    }
    if (authorization.expiresAt !== undefined && now >= authorization.expiresAt) {
      return { eligible: false, reason: 'autonomy_authorization_expired', mode };
    }
    // Bind the exact task + goal + lineage + policy fingerprint/version.
    if (
      policy === undefined
      || policy.fingerprint !== authorization.policyFingerprint
      || authorization.goalId !== goalId
      || authorization.taskId !== taskId
      || authorization.planId !== plan.planId
    ) {
      return { eligible: false, reason: 'autonomy_authorization_invalid', mode };
    }
    return { eligible: true, mode };
  }

  // bounded_autonomous: the active, unsuspended, unrevoked, unexpired,
  // within-bounds policy IS the authorization.
  return { eligible: true, mode };
}
