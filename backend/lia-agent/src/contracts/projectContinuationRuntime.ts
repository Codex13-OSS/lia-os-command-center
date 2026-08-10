import type { ProjectTaskRecord } from './projectTask.js';

export const CONTINUATION_RUNTIME_VERSION = 'continuation-runtime-v1' as const;

export type ProjectContinuationMaterializationResult = {
  planId: string;
  createdTaskId: string;
  task: ProjectTaskRecord;
};

/** Internal-only materialization boundary. planId is the sole caller input. */
export interface ProjectContinuationRuntime {
  materializeContinuation(planId: string): ProjectContinuationMaterializationResult;
}

export const PROJECT_CONTINUATION_RUNTIME_ERRORS = {
  invalidInput: 'invalid_project_continuation_materialization',
  planNotFound: 'project_continuation_plan_not_found',
  planNotUsable: 'project_continuation_plan_not_usable',
  sourceConflict: 'project_continuation_source_evaluation_conflict',
  evaluationNotApplied: 'project_continuation_evaluation_not_applied',
  evaluationNotRetryable: 'project_continuation_evaluation_not_retryable',
  goalNotFound: 'project_continuation_goal_not_found',
  goalTerminal: 'project_continuation_goal_terminal',
  parentNotFound: 'project_continuation_parent_not_found',
  staleParent: 'project_continuation_parent_stale',
  projectMismatch: 'project_continuation_project_mismatch',
  attemptLimit: 'project_continuation_attempt_limit_reached',
  depthLimit: 'project_continuation_depth_limit_reached',
  incompatiblePlan: 'project_continuation_plan_incompatible',
  capacity: 'project_continuation_capacity_reached',
} as const;