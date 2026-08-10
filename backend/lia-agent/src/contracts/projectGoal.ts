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

export interface ProjectGoalStore {
  createGoal(input: CreateProjectGoalInput): ProjectGoalRecord;
  readGoal(goalId: string): ProjectGoalRecord | undefined;
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
} as const;
