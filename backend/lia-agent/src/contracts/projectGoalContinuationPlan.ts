import type { ProjectGoalEvaluationReasonCode } from './projectGoalEvaluation.js';

export const CONTINUATION_PLANNER_VERSION = 'continuation-planner-v1' as const;

export const PROJECT_GOAL_CONTINUATION_PLAN_STATUSES = ['planned', 'cancelled', 'consumed'] as const;
export type ProjectGoalContinuationPlanStatus =
  (typeof PROJECT_GOAL_CONTINUATION_PLAN_STATUSES)[number];

export const PROJECT_GOAL_CONTINUATION_PLAN_REASON_CODES = [
  'continue_partial_result',
  'retry_verification_failure',
  'retry_visual_failure',
  'retry_execution_failure',
  'retry_insufficient_evidence',
] as const;
export type ProjectGoalContinuationPlanReasonCode =
  (typeof PROJECT_GOAL_CONTINUATION_PLAN_REASON_CODES)[number];

export const PROJECT_GOAL_CONTINUATION_PLAN_MAX_INSTRUCTION_LENGTH = 2_000;

export type CreateProjectGoalContinuationPlanInput = {
  goalId: string;
  sourceEvaluationId: string;
  plannerVersion: typeof CONTINUATION_PLANNER_VERSION;
  /** Optimistic binding supplied from the durable evaluation previously read by the caller. */
  sourceEvidenceFingerprint: string;
};

/** Intent metadata only. This contract deliberately has no capability or execution fields. */
export type ProjectGoalContinuationPlanRecord = {
  planId: string;
  goalId: string;
  sourceEvaluationId: string;
  parentTaskId: string;
  parentAttemptNumber: number;
  nextAttemptNumber: number;
  nextContinuationDepth: number;
  plannerVersion: typeof CONTINUATION_PLANNER_VERSION;
  status: ProjectGoalContinuationPlanStatus;
  instruction: string;
  reasonCode: ProjectGoalContinuationPlanReasonCode;
  fingerprint: string;
  sourceEvidenceFingerprint: string;
  createdAt: number;
  cancelledAt?: number;
  /** Present exactly when status is consumed. Both fields are immutable. */
  createdTaskId?: string;
  consumedAt?: number;
};

export interface ProjectGoalContinuationPlanStore {
  createContinuationPlan(
    input: CreateProjectGoalContinuationPlanInput,
  ): ProjectGoalContinuationPlanRecord;
  readContinuationPlan(planId: string): ProjectGoalContinuationPlanRecord | undefined;
  readContinuationPlanBySourceEvaluation(
    sourceEvaluationId: string,
    plannerVersion?: typeof CONTINUATION_PLANNER_VERSION,
  ): ProjectGoalContinuationPlanRecord | undefined;
  listGoalContinuationPlans(goalId: string): ProjectGoalContinuationPlanRecord[];
  assertContinuationPlanUsable(planId: string): ProjectGoalContinuationPlanRecord;
  cancelContinuationPlan(planId: string): ProjectGoalContinuationPlanRecord;
}

export const PROJECT_GOAL_CONTINUATION_PLAN_ERRORS = {
  invalidInput: 'invalid_project_goal_continuation_plan',
  goalNotFound: 'project_goal_continuation_plan_goal_not_found',
  evaluationNotFound: 'project_goal_continuation_plan_evaluation_not_found',
  evaluationNotApplied: 'project_goal_continuation_plan_evaluation_not_applied',
  evaluationNotRetryable: 'project_goal_continuation_plan_evaluation_not_retryable',
  goalMismatch: 'project_goal_continuation_plan_goal_mismatch',
  projectMismatch: 'project_goal_continuation_plan_project_mismatch',
  staleAttempt: 'project_goal_continuation_plan_stale_attempt',
  terminalGoal: 'project_goal_continuation_plan_goal_terminal',
  attemptLimit: 'project_goal_continuation_plan_attempt_limit_reached',
  depthLimit: 'project_goal_continuation_plan_depth_limit_reached',
  evidenceConflict: 'project_goal_continuation_plan_evidence_conflict',
  incompatiblePlan: 'project_goal_continuation_plan_incompatible',
  planNotFound: 'project_goal_continuation_plan_not_found',
  planNotUsable: 'project_goal_continuation_plan_not_usable',
  immutable: 'project_goal_continuation_plan_immutable',
} as const;

export const RETRYABLE_EVALUATION_TO_PLAN_REASON: Readonly<
  Partial<Record<ProjectGoalEvaluationReasonCode, ProjectGoalContinuationPlanReasonCode>>
> = {
  partial_result: 'continue_partial_result',
  verification_failed: 'retry_verification_failure',
  visual_verification_failed: 'retry_visual_failure',
  execution_failed: 'retry_execution_failure',
  insufficient_evidence: 'retry_insufficient_evidence',
};
