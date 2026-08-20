import type { ProjectGoalRecord } from './projectGoal.js';

export const AUTONOMY_POLICY_VERSION = 'autonomy-policy-v1' as const;

/**
 * The new durable autonomy-mode vocabulary (design §3). This is deliberately
 * distinct from the existing direct/delegated `executionMode` (proposal shape)
 * and from goal statuses. It is a per-goal policy and never carries authority.
 */
export const AUTONOMY_MODES = [
  'manual_only',
  'approved_single_step',
  'bounded_autonomous',
] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** v1 default mode (MQ2): LÍA never auto-launches a continuation task. */
export const AUTONOMY_POLICY_DEFAULT_MODE: AutonomyMode = 'manual_only';

/** Optional bounded-loop elapsed budget horizon when enabled (MQ3). Never unbounded. */
export const AUTONOMY_BOUNDED_DEFAULT_ELAPSED_BUDGET_MS = 24 * 60 * 60 * 1000;

/** Hard V1 ceiling. A bounded grant can choose less, never more. */
export const AUTONOMY_BOUNDED_MAX_ELAPSED_BUDGET_MS = 24 * 60 * 60 * 1000;

/** Redundant read-only cycle convenience bound, clamped <= goal.maxAttempts. */
export const AUTONOMY_POLICY_MAX_CYCLES_LIMIT = 5;

export const AUTONOMY_POLICY_MAX_APPROVER_LENGTH = 200;

export type SetGoalAutonomyPolicyInput = {
  goalId: string;
  mode: AutonomyMode;
  /** Bounded operator identity (1..200 chars, trimmed). */
  approver: string;
  /** Redundant cycle convenience bound for bounded_autonomous (clamped <= goal.maxAttempts). */
  maxCycles?: number;
  /** Whole-loop wall-clock budget for bounded_autonomous (optional). */
  elapsedBudgetMs?: number;
  /** Optional horizon. Absent => no expiry (manual_only default has none). */
  expiresAt?: number;
};

/**
 * A durable per-goal autonomy policy plus operator control plus bounded-loop
 * budget. It is STATE, not authority: it carries no capability, no command,
 * no instruction, no path, no model/tool authority. It only selects which
 * durable authorization shape is required for execution; it never alters the
 * capability ceiling, the forbidden set, the intent, or the runner.
 */
export type ProjectGoalAutonomyPolicyRecord = {
  policyId: string;
  goalId: string;
  mode: AutonomyMode;
  /** Operator pause; set once, cleared on resume. */
  suspendedAt?: number;
  /** Optional bounded/budget horizon. */
  expiresAt?: number;
  /** One-way revocation of a bounded grant. */
  revokedAt?: number;
  /** Redundant cycle bound, ONLY meaningful for bounded_autonomous. */
  maxCycles?: number;
  /** Whole-loop wall-clock budget, ONLY meaningful for bounded_autonomous. */
  elapsedBudgetMs?: number;
  approver: string;
  createdAt: number;
  updatedAt: number;
  /** sha256 over meaning (mode + bounds + goal). Immutable identity. */
  fingerprint: string;
};

export interface ProjectGoalAutonomyPolicyStore {
  setGoalAutonomyPolicy(input: SetGoalAutonomyPolicyInput): ProjectGoalAutonomyPolicyRecord;
  readGoalAutonomyPolicy(goalId: string): ProjectGoalAutonomyPolicyRecord | undefined;
  suspendGoalAutonomy(goalId: string): ProjectGoalAutonomyPolicyRecord;
  resumeGoalAutonomy(goalId: string): ProjectGoalAutonomyPolicyRecord;
  revokeGoalAutonomy(goalId: string): ProjectGoalAutonomyPolicyRecord;
}

export const PROJECT_GOAL_AUTONOMY_POLICY_ERRORS = {
  invalidInput: 'invalid_project_goal_autonomy_policy',
  goalNotFound: 'project_goal_autonomy_policy_goal_not_found',
  goalTerminal: 'project_goal_autonomy_policy_goal_terminal',
  policyNotFound: 'project_goal_autonomy_policy_not_found',
  contradictory: 'project_goal_autonomy_policy_contradictory',
  invalidBounds: 'project_goal_autonomy_policy_invalid_bounds',
  notSuspended: 'project_goal_autonomy_policy_not_suspended',
  notResumable: 'project_goal_autonomy_policy_not_resumable',
  notRevocable: 'project_goal_autonomy_policy_not_revocable',
  modeMismatch: 'project_goal_autonomy_policy_mode_mismatch',
  suspended: 'autonomy_suspended',
  revoked: 'autonomy_policy_revoked',
  expired: 'autonomy_policy_expired',
  manualOnly: 'autonomy_manual_only',
  budgetExhausted: 'autonomy_elapsed_budget_exhausted',
  cycleLimitReached: 'autonomy_cycle_limit_reached',
} as const;

/**
 * Derived (never stored) policy-state vocabulary. `suspended`, `revoked` and
 * `expired` are durable control facts layered over any mode; they always forbid
 * launch regardless of the underlying mode.
 */
export const AUTONOMY_POLICY_STATES = [
  'manual_only',
  'approved_single_step',
  'bounded_autonomous',
  'suspended',
  'revoked',
  'expired',
] as const;
export type AutonomyPolicyState = (typeof AUTONOMY_POLICY_STATES)[number];

export function deriveAutonomyPolicyState(
  policy: ProjectGoalAutonomyPolicyRecord,
  now: number,
): AutonomyPolicyState {
  if (policy.revokedAt !== undefined) return 'revoked';
  if (policy.suspendedAt !== undefined) return 'suspended';
  if (policy.expiresAt !== undefined && now >= policy.expiresAt) return 'expired';
  return policy.mode;
}

export type AutonomyPolicyMeaning = {
  goalId: string;
  mode: AutonomyMode;
  maxCycles: number | null;
  elapsedBudgetMs: number | null;
  expiresAt: number | null;
};

/** Canonical fingerprint input: mode + bounds + goal. Nothing else. */
export function autonomyPolicyMeaning(
  policy: Pick<ProjectGoalAutonomyPolicyRecord, 'goalId' | 'mode' | 'maxCycles' | 'elapsedBudgetMs' | 'expiresAt'>,
): AutonomyPolicyMeaning {
  return {
    goalId: policy.goalId,
    mode: policy.mode,
    maxCycles: policy.maxCycles ?? null,
    elapsedBudgetMs: policy.elapsedBudgetMs ?? null,
    expiresAt: policy.expiresAt ?? null,
  };
}

export function isAutonomyMode(value: unknown): value is AutonomyMode {
  return typeof value === 'string' && (AUTONOMY_MODES as readonly string[]).includes(value);
}
