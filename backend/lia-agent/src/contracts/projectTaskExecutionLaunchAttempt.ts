export const PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_MAX_LIST_LIMIT = 100;

export const PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS = {
  invalidInput: 'invalid_project_task_execution_launch_attempt_input',
  taskNotFound: 'project_task_execution_launch_attempt_task_not_found',
  taskUnavailable: 'project_task_execution_launch_attempt_task_unavailable',
  invocationNotFound: 'project_task_execution_launch_attempt_invocation_not_found',
  invocationRunMismatch: 'project_task_execution_launch_attempt_invocation_run_mismatch',
  authorityMismatch: 'project_task_execution_launch_attempt_authority_mismatch',
  corruptRecord: 'corrupt_project_task_execution_launch_attempt_record',
} as const;

/**
 * Durable evidence that LÍA crossed the boundary after which an external
 * launch MAY have occurred. The record exists only to make replay unsafe:
 * after it exists, LÍA must never blindly launch again without later durable
 * external-result proof.
 *
 * It does NOT mean Hermes started, Hermes received a prompt, a workflow
 * started, Codex started, side effects occurred, execution succeeded or
 * failed, delivery was exactly-once, or that any retry is permitted. It
 * grants no workflow, external-execution, project, or capability authority.
 */
export type ProjectTaskExecutionLaunchAttemptRecord = {
  launchAttemptId: string;
  invocationId: string;
  executionRunId: string;
  taskId: string;
  launchLeaseId: string;
  launchFencingToken: number;
  boundaryCrossedAt: number;
};

export type BeginProjectTaskExecutionLaunchAttemptInput = {
  invocationId: string;
  executionRunId: string;
  taskId: string;
  leaseOwner: string;
  leaseId: string;
  fencingToken: number;
};

/**
 * Non-authoritative result of the first-crossing operation.
 *
 * created=true  means this process instance performed the durable first
 *               creation; the caller MAY be the unique process that crossed
 *               the boundary.
 * created=false means the durable tuple already existed (exact replay,
 *               including replay after lease release/expiry/reopen). It is
 *               NEVER permission to launch externally: the boundary may have
 *               been crossed by a previous instance whose outcome is unknown.
 */
export type BeginProjectTaskExecutionLaunchAttemptResult = {
  launchAttempt: ProjectTaskExecutionLaunchAttemptRecord;
  created: boolean;
};

export interface ProjectTaskExecutionLaunchAttemptStore {
  beginTaskExecutionLaunchAttempt(
    input: BeginProjectTaskExecutionLaunchAttemptInput,
  ): BeginProjectTaskExecutionLaunchAttemptResult;
  readTaskExecutionLaunchAttempt(
    launchAttemptId: string,
  ): ProjectTaskExecutionLaunchAttemptRecord | undefined;
  readTaskExecutionLaunchAttemptByInvocation(
    invocationId: string,
  ): ProjectTaskExecutionLaunchAttemptRecord | undefined;
  readTaskExecutionLaunchAttemptByTask(
    taskId: string,
  ): ProjectTaskExecutionLaunchAttemptRecord | undefined;
  listTaskExecutionLaunchAttempts(limit: number): ProjectTaskExecutionLaunchAttemptRecord[];
}
