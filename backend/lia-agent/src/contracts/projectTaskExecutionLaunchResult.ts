export const PROJECT_TASK_EXECUTION_LAUNCH_RESULT_MAX_LIST_LIMIT = 100;

export const PROJECT_TASK_EXECUTION_LAUNCH_RESULT_OUTCOMES = [
  'proposal_valid',
  'timeout',
  'execution_failed',
  'empty_response',
  'invalid_hermes_json',
  'invalid_hermes_proposal',
] as const;

export type ProjectTaskExecutionLaunchResultOutcome =
  (typeof PROJECT_TASK_EXECUTION_LAUNCH_RESULT_OUTCOMES)[number];

export const PROJECT_TASK_EXECUTION_LAUNCH_RESULT_OUTCOME_SET = new Set<string>(
  PROJECT_TASK_EXECUTION_LAUNCH_RESULT_OUTCOMES,
);

export const PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS = {
  invalidInput: 'invalid_project_task_execution_launch_result_input',
  launchAttemptNotFound: 'project_task_execution_launch_result_attempt_not_found',
  lineageMismatch: 'project_task_execution_launch_result_lineage_mismatch',
  contradictory: 'project_task_execution_launch_result_contradictory',
  corruptRecord: 'corrupt_project_task_execution_launch_result_record',
} as const;

/**
 * Immutable durable evidence that LÍA OBSERVED the terminal outcome of the
 * WHOLE admitted live Hermes phase of one Launch Attempt.
 *
 * It redundantly binds the Launch Attempt's existing lineage only for
 * referential/integrity verification. It is evidence only: it never means
 * approved, capability-authorized, Codex-authorized, task/goal complete,
 * successful implementation, safe to replay, or permission to retry. It
 * grants no workflow, external-execution, project, capability, database,
 * commit, remote-repository, or secret authority.
 */
export type ProjectTaskExecutionLaunchResultRecord = {
  launchResultId: string;
  launchAttemptId: string;
  invocationId: string;
  executionRunId: string;
  taskId: string;
  outcomeClass: ProjectTaskExecutionLaunchResultOutcome;
  recordedAt: number;
};

export type RecordProjectTaskExecutionLaunchResultInput = {
  launchAttemptId: string;
  invocationId: string;
  executionRunId: string;
  taskId: string;
  outcomeClass: ProjectTaskExecutionLaunchResultOutcome;
};

/**
 * Non-authoritative result of the first recording operation.
 *
 * created=true  means this process instance performed the durable first
 *               creation of the observed outcome evidence.
 * created=false means the durable tuple already existed (exact replay of the
 *               same launchAttempt + lineage + outcome, including replay after
 *               lease release, lease expiry or DB close/reopen). It is NEVER
 *               permission to execute anything and grants no authority.
 */
export type RecordProjectTaskExecutionLaunchResultResult = {
  launchResult: ProjectTaskExecutionLaunchResultRecord;
  created: boolean;
};

export interface ProjectTaskExecutionLaunchResultStore {
  recordTaskExecutionLaunchResult(
    input: RecordProjectTaskExecutionLaunchResultInput,
  ): RecordProjectTaskExecutionLaunchResultResult;
  readTaskExecutionLaunchResult(
    launchResultId: string,
  ): ProjectTaskExecutionLaunchResultRecord | undefined;
  readTaskExecutionLaunchResultByLaunchAttempt(
    launchAttemptId: string,
  ): ProjectTaskExecutionLaunchResultRecord | undefined;
  readTaskExecutionLaunchResultByInvocation(
    invocationId: string,
  ): ProjectTaskExecutionLaunchResultRecord | undefined;
  readTaskExecutionLaunchResultByTask(
    taskId: string,
  ): ProjectTaskExecutionLaunchResultRecord | undefined;
  listTaskExecutionLaunchResults(limit: number): ProjectTaskExecutionLaunchResultRecord[];
}
