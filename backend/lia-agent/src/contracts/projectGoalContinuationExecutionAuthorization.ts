import type { ProjectGoalAutonomyPolicyRecord } from './projectGoalAutonomyPolicy.js';

export const EXECUTION_AUTHORIZATION_VERSION = 'continuation-execution-authorization-v1' as const;

/**
 * Conservative execution-authorization lifetime. Mirrors the materialization
 * approval TTL: a dormant grant must expire. 7 days, configurable, never
 * unbounded.
 */
export const EXECUTION_AUTHORIZATION_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const EXECUTION_AUTHORIZATION_MAX_APPROVER_LENGTH = 200;

export type CreateExecutionAuthorizationInput = {
  goalId: string;
  /** The exact materialized continuation task (accepted, consumed-plan lineage). */
  taskId: string;
  /** The consumed plan that materialized the task. */
  planId: string;
  /** Bounded operator identity (1..200 chars, trimmed). */
  approver: string;
  /** Optional expiry. Absent => the conservative 7-day default. */
  expiresAt?: number;
};

/**
 * A durable, immutable, one-per-task human execution authorization
 * (`approved_single_step`). It is STATE, not authority: it carries no
 * capability, no instruction, no command, no path, no model/tool authority.
 *
 * It binds to the exact task + goal + continuation lineage AND to the active
 * autonomy policy fingerprint/version, so a policy transition (mode change or
 * bound change) invalidates it. It is single-use (`consumedAt`), revocable
 * pre-launch, expiring, and idempotent on exact replay.
 */
export type ProjectGoalContinuationExecutionAuthorizationRecord = {
  authorizationId: string;
  goalId: string;
  taskId: string;
  planId: string;
  /** The active autonomy policy fingerprint at grant time (binds the authorization). */
  policyFingerprint: string;
  approver: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  /** Set exactly once at launch, atomically with the launch decision. */
  consumedAt?: number;
  /** sha256 over (goal_id, task_id, plan_id, policy_fingerprint). */
  fingerprint: string;
};

export interface ProjectGoalContinuationExecutionAuthorizationStore {
  createExecutionAuthorization(
    input: CreateExecutionAuthorizationInput,
  ): ProjectGoalContinuationExecutionAuthorizationRecord;
  revokeExecutionAuthorization(authorizationId: string): ProjectGoalContinuationExecutionAuthorizationRecord;
  readExecutionAuthorization(authorizationId: string): ProjectGoalContinuationExecutionAuthorizationRecord | undefined;
  readExecutionAuthorizationByTask(taskId: string): ProjectGoalContinuationExecutionAuthorizationRecord | undefined;
  /** consumed_at null -> value, once. */
  consumeExecutionAuthorization(authorizationId: string): ProjectGoalContinuationExecutionAuthorizationRecord;
  /** Fail-closed gate for the launch: asserts a valid unconsumed authorization for the task. */
  assertExecutionAuthorizationValid(taskId: string): ProjectGoalContinuationExecutionAuthorizationRecord;
}

export const PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS = {
  invalidInput: 'invalid_project_goal_continuation_execution_authorization',
  taskNotFound: 'project_goal_continuation_execution_authorization_task_not_found',
  taskNotAccepted: 'project_goal_continuation_execution_authorization_task_not_accepted',
  planNotFound: 'project_goal_continuation_execution_authorization_plan_not_found',
  planNotConsumed: 'project_goal_continuation_execution_authorization_plan_not_consumed',
  lineageMismatch: 'project_goal_continuation_execution_authorization_lineage_mismatch',
  policyRequired: 'autonomy_authorization_policy_required',
  policyModeMismatch: 'autonomy_authorization_policy_mode_mismatch',
  policyInvalid: 'autonomy_authorization_policy_invalid',
  authorizationNotFound: 'project_goal_continuation_execution_authorization_not_found',
  notRevocable: 'project_goal_continuation_execution_authorization_not_revocable',
  notConsumable: 'project_goal_continuation_execution_authorization_not_consumable',
  authorizationRequired: 'autonomy_authorization_required',
  authorizationRevoked: 'autonomy_authorization_revoked',
  authorizationExpired: 'autonomy_authorization_expired',
  authorizationInvalid: 'autonomy_authorization_invalid',
  authorizationConsumed: 'autonomy_authorization_consumed',
  authorizationContradictory: 'autonomy_authorization_contradictory',
} as const;

/**
 * Derived (never stored) authorization state. The single authoritative durable
 * source is the authorization row plus the governing policy row plus the task
 * and plan rows; this view is computed from them.
 */
export const EXECUTION_AUTHORIZATION_STATES = [
  'authorization_required',
  'authorization_present',
  'authorization_revoked',
  'authorization_expired',
  'authorization_invalid',
  'authorization_consumed',
] as const;
export type ExecutionAuthorizationState = (typeof EXECUTION_AUTHORIZATION_STATES)[number];

export type ExecutionAuthorizationStatusInput = {
  authorization: ProjectGoalContinuationExecutionAuthorizationRecord | undefined;
  policy: ProjectGoalAutonomyPolicyRecord | undefined;
  /** The governing policy mode actually in force (default manual_only). */
  mode: 'manual_only' | 'approved_single_step' | 'bounded_autonomous';
  now: number;
};

/**
 * Only `authorization_present` permits the launch orchestrator to proceed for
 * `approved_single_step`. Every other state is a durable fact read from
 * immutable rows.
 */
export function deriveExecutionAuthorizationState(
  input: ExecutionAuthorizationStatusInput,
): ExecutionAuthorizationState {
  const { authorization, policy, mode, now } = input;

  if (mode !== 'approved_single_step') return 'authorization_required';
  if (authorization === undefined) return 'authorization_required';
  if (authorization.revokedAt !== undefined) return 'authorization_revoked';
  if (authorization.consumedAt !== undefined) return 'authorization_consumed';
  if (authorization.expiresAt !== undefined && now >= authorization.expiresAt) {
    return 'authorization_expired';
  }
  // A present authorization is only valid if it still binds the exact policy
  // fingerprint/version and the policy is still in the authorizing mode.
  if (policy === undefined) return 'authorization_invalid';
  if (policy.fingerprint !== authorization.policyFingerprint) return 'authorization_invalid';
  if (policy.mode !== 'approved_single_step') return 'authorization_invalid';
  if (policy.revokedAt !== undefined || policy.suspendedAt !== undefined) {
    return 'authorization_invalid';
  }
  if (policy.expiresAt !== undefined && now >= policy.expiresAt) return 'authorization_invalid';

  return 'authorization_present';
}
