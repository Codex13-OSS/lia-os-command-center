import type { ProjectGoalRecord } from './projectGoal.js';
import type { ProjectGoalEvaluationRecord } from './projectGoalEvaluation.js';
import type { ProjectGoalContinuationPlanRecord } from './projectGoalContinuationPlan.js';

export const CONTINUATION_APPROVAL_VERSION = 'continuation-approval-v1' as const;

/**
 * Conservative approval lifetime (MQ2): an approval for a plan is a dormant
 * gate, so it must expire. 7 days, configurable per project, never unbounded.
 */
export const CONTINUATION_APPROVAL_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const CONTINUATION_APPROVAL_MAX_APPROVER_LENGTH = 200;

export type ApproveContinuationPlanInput = {
  planId: string;
  /** Bounded operator identity (1..200 chars, trimmed). */
  approver: string;
  /** Optional expiry. Absent => the conservative 7-day default. */
  expiresAt?: number;
};

/**
 * A durable, immutable, one-per-plan human approval. It is STATE, not
 * authority: it carries no capability, no instruction, no command, no path.
 * It is the durable proof that a human authorized materialization of a
 * specific plan, and it is necessary-but-not-sufficient for that
 * materialization.
 */
export type ProjectGoalContinuationApprovalRecord = {
  approvalId: string;
  planId: string;
  goalId: string;
  sourceEvaluationId: string;
  planFingerprint: string;
  sourceEvidenceFingerprint: string;
  approver: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
};

export interface ProjectGoalContinuationApprovalStore {
  approveContinuationPlan(input: ApproveContinuationPlanInput): ProjectGoalContinuationApprovalRecord;
  revokeContinuationApproval(planId: string): ProjectGoalContinuationApprovalRecord;
  readContinuationApproval(planId: string): ProjectGoalContinuationApprovalRecord | undefined;
  assertContinuationApprovalValid(planId: string): ProjectGoalContinuationApprovalRecord;
}

export const PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS = {
  invalidInput: 'invalid_project_goal_continuation_approval',
  planNotFound: 'project_goal_continuation_approval_plan_not_found',
  planNotApprovable: 'project_goal_continuation_approval_plan_not_approvable',
  contradictory: 'project_goal_continuation_approval_contradictory',
  approvalNotFound: 'project_goal_continuation_approval_not_found',
  notRevocable: 'project_goal_continuation_approval_not_revocable',
  approvalRequired: 'project_goal_continuation_approval_required',
  approvalRevoked: 'project_goal_continuation_approval_revoked',
  approvalExpired: 'project_goal_continuation_approval_expired',
  approvalInvalid: 'project_goal_continuation_approval_invalid',
} as const;

/**
 * Derived (never stored) approval state vocabulary. The single authoritative
 * durable source is the set of (plan, approval, evaluation, goal) rows; this
 * view is computed from them and is never a second source of truth.
 */
export const CONTINUATION_APPROVAL_STATES = [
  'approval_required',
  'approval_present',
  'approval_revoked',
  'approval_expired',
  'approval_invalid',
  'approval_consumed',
] as const;
export type ContinuationApprovalState = (typeof CONTINUATION_APPROVAL_STATES)[number];

export type ContinuationApprovalStatusInput = {
  plan: ProjectGoalContinuationPlanRecord;
  approval: ProjectGoalContinuationApprovalRecord | undefined;
  evaluation: ProjectGoalEvaluationRecord | undefined;
  goal: ProjectGoalRecord | undefined;
  now: number;
};

/**
 * Only `approval_present` permits the execution gate to proceed to
 * materialization. Every other state is a durable fact read from immutable
 * rows, never process memory or self-report.
 */
export function deriveContinuationApprovalState(
  input: ContinuationApprovalStatusInput,
): ContinuationApprovalState {
  const { plan, approval, evaluation, goal, now } = input;

  if (plan.status === 'consumed') return 'approval_consumed';

  if (approval === undefined) {
    if (plan.status !== 'planned') return 'approval_invalid';
    return 'approval_required';
  }

  if (approval.revokedAt !== undefined) return 'approval_revoked';
  if (approval.expiresAt !== undefined && now >= approval.expiresAt) return 'approval_expired';

  // A present, unrevoked, unexpired approval is only valid if it still binds
  // the exact plan lineage and that lineage is still usable.
  if (
    plan.status !== 'planned'
    || approval.planFingerprint !== plan.fingerprint
    || approval.goalId !== plan.goalId
    || approval.sourceEvaluationId !== plan.sourceEvaluationId
    || approval.sourceEvidenceFingerprint !== plan.sourceEvidenceFingerprint
  ) return 'approval_invalid';
  if (goal === undefined || goal.status !== 'active') return 'approval_invalid';
  if (
    evaluation === undefined
    || evaluation.appliedAt === undefined
    || evaluation.decision !== 'retryable'
  ) return 'approval_invalid';

  return 'approval_present';
}
