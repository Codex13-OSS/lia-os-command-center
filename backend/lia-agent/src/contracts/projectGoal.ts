import type { ProjectTaskRequest } from './projectExecutor.js';
import type { CreateProjectTaskResult, ProjectTaskRecord } from './projectTask.js';

export const PROJECT_GOAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PROJECT_GOAL_STATUSES = [
  'active',
  'completed',
  'blocked',
  'exhausted',
  'failed',
] as const;
export type ProjectGoalStatus = (typeof PROJECT_GOAL_STATUSES)[number];
export type ProjectGoalTerminalStatus = Exclude<ProjectGoalStatus, 'active'>;

/** Fixed, non-sensitive terminal metadata. Free-form runtime output is never persisted here. */
export const PROJECT_GOAL_TERMINAL_REASONS = [
  'objective_completed',
  'human_intervention_required',
  'attempt_limit_reached',
  'unrecoverable_failure',
] as const;
export type ProjectGoalTerminalReason = (typeof PROJECT_GOAL_TERMINAL_REASONS)[number];

/** Small V1 safety ceilings. A goal may choose lower limits, never higher ones. */
export const PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS = 3;
export const PROJECT_GOAL_MAX_ATTEMPTS_LIMIT = 5;
export const PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT = 2;
export const PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT = 4;

export type ProjectGoalRecord = {
  goalId: string;
  projectId: string;
  objective: string;
  status: ProjectGoalStatus;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  /** Null means that no root attempt has been created. Attempts are zero-based. */
  currentAttempt: number | null;
  maxAttempts: number;
  continuationDepthLimit: number;
  terminalReason?: ProjectGoalTerminalReason;
};

export type CreateProjectGoalInput = {
  goalId: string;
  projectId: string;
  objective: string;
  maxAttempts?: number;
  continuationDepthLimit?: number;
};

export type CreateRootAttemptInput = {
  taskId: string;
  fingerprint: string;
  intent: ProjectTaskRequest;
  goalId: string;
  parentTaskId?: undefined;
  continuationDepth: 0;
  attemptNumber: 0;
};

export type CreateContinuationAttemptInput = {
  taskId: string;
  fingerprint: string;
  intent: ProjectTaskRequest;
  goalId: string;
  parentTaskId: string;
  continuationDepth: number;
  attemptNumber: number;
};

/**
 * Bounded goal enumeration options (operator goal control surface, design §A).
 * The limit selects the NEWEST N rows by `updated_at DESC, goal_id ASC`; the
 * returned rows are then ordered active-first, `created_at ASC, goal_id ASC`.
 */
export type ListProjectGoalsOptions = {
  projectId?: string;
  /** Bounded read ceiling; clamped to [1, 100]. Default 100. */
  limit?: number;
  /** Hide terminal goals. Default true (include terminal). */
  includeTerminal?: boolean;
};

/**
 * Single-transaction intake composition (design §D / §N): create the goal row
 * and its root attempt atomically through the SAME validated primitives the
 * store already exposes. Zero authority change — the root attempt is created
 * as `accepted` and is never launched inside the store.
 */
export type CreateGoalWithRootAttemptInput = {
  goal: CreateProjectGoalInput;
  rootAttempt: CreateRootAttemptInput;
};

export type CreateGoalWithRootAttemptResult = {
  goal: ProjectGoalRecord;
  task: CreateProjectTaskResult;
};

export interface ProjectGoalStore {
  createGoal(input: CreateProjectGoalInput): ProjectGoalRecord;
  readGoal(goalId: string): ProjectGoalRecord | undefined;
  /** Read-only enumeration of every `active` goal (bounded loop runtime surface). */
  listActiveGoals(): ProjectGoalRecord[];
  /** Bounded operator enumeration (active first, then terminal). */
  listGoals(options?: ListProjectGoalsOptions): ProjectGoalRecord[];
  /**
   * Atomic intake: create the goal and its root attempt in ONE transaction.
   * Both validations are the exact existing ones; the root attempt is created
   * as `accepted` and is never dispatched, leased or executed here.
   */
  createGoalWithRootAttempt(input: CreateGoalWithRootAttemptInput): CreateGoalWithRootAttemptResult;
  createRootAttempt(input: CreateRootAttemptInput): CreateProjectTaskResult;
  createContinuationAttempt(input: CreateContinuationAttemptInput): CreateProjectTaskResult;
  listGoalAttempts(goalId: string): ProjectTaskRecord[];
  transitionGoal(
    goalId: string,
    status: ProjectGoalTerminalStatus,
    terminalReason?: ProjectGoalTerminalReason,
  ): ProjectGoalRecord;
  terminalizeGoal(
    goalId: string,
    status: ProjectGoalTerminalStatus,
    terminalReason?: ProjectGoalTerminalReason,
  ): ProjectGoalRecord;
}

export const PROJECT_GOAL_ERRORS = {
  invalidGoal: 'invalid_project_goal',
  goalExists: 'project_goal_already_exists',
  goalNotFound: 'project_goal_not_found',
  goalTerminal: 'project_goal_terminal',
  invalidTransition: 'invalid_project_goal_transition',
  invalidLineage: 'invalid_project_task_lineage',
  lineageImmutable: 'project_task_lineage_immutable',
  parentNotFound: 'project_task_parent_not_found',
  parentProjectMismatch: 'project_task_parent_project_mismatch',
  parentGoalMismatch: 'project_task_parent_goal_mismatch',
  capabilityExpansion: 'project_task_continuation_capability_expansion',
  attemptLimit: 'project_goal_attempt_limit_reached',
  depthLimit: 'project_goal_continuation_depth_limit_reached',
  /** Intake capacity: the atomic goal+root-attempt composition refuses partial creation. */
  capacity: 'project_goal_capacity_reached',
} as const;
