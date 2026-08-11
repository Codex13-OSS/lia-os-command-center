export const PROJECT_TASK_EXECUTION_INVOCATION_MAX_LIST_LIMIT = 100;

export const PROJECT_TASK_EXECUTION_INVOCATION_ERRORS = {
  invalidInput: 'invalid_project_task_execution_invocation_input',
  taskNotFound: 'project_task_execution_invocation_task_not_found',
  taskUnavailable: 'project_task_execution_invocation_task_unavailable',
  executionRunNotFound: 'project_task_execution_invocation_run_not_found',
  runTaskMismatch: 'project_task_execution_invocation_run_task_mismatch',
  authorityMismatch: 'project_task_execution_invocation_authority_mismatch',
  corruptRecord: 'corrupt_project_task_execution_invocation_record',
} as const;

/**
 * Durable evidence that LÍA reserved an invocation identity for a prepared run.
 * It is an invocation intent/ticket only: it does not mean execution started and
 * grants no workflow, external-execution, project, or capability authority.
 */
export type ProjectTaskExecutionInvocationRecord = {
  invocationId: string;
  executionRunId: string;
  taskId: string;
  reservationLeaseId: string;
  reservationFencingToken: number;
  reservedAt: number;
};

export type ReserveProjectTaskExecutionInvocationInput = {
  executionRunId: string;
  taskId: string;
  leaseOwner: string;
  leaseId: string;
  fencingToken: number;
};

export interface ProjectTaskExecutionInvocationStore {
  reserveTaskExecutionInvocation(
    input: ReserveProjectTaskExecutionInvocationInput,
  ): ProjectTaskExecutionInvocationRecord;
  readTaskExecutionInvocation(
    invocationId: string,
  ): ProjectTaskExecutionInvocationRecord | undefined;
  readTaskExecutionInvocationByRun(
    executionRunId: string,
  ): ProjectTaskExecutionInvocationRecord | undefined;
  readTaskExecutionInvocationByTask(
    taskId: string,
  ): ProjectTaskExecutionInvocationRecord | undefined;
  listReservedTaskExecutionInvocations(limit: number): ProjectTaskExecutionInvocationRecord[];
}
