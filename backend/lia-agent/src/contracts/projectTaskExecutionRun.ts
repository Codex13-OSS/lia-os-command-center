export const PROJECT_TASK_EXECUTION_RUN_MAX_LIST_LIMIT = 100;

export const PROJECT_TASK_EXECUTION_RUN_ERRORS = {
  invalidInput: 'invalid_project_task_execution_run_input',
  taskNotFound: 'project_task_execution_run_task_not_found',
  taskUnavailable: 'project_task_execution_run_task_unavailable',
  dispatchNotFound: 'project_task_execution_run_dispatch_not_found',
  dispatchUnavailable: 'project_task_execution_run_dispatch_unavailable',
  authorityMismatch: 'project_task_execution_run_authority_mismatch',
  corruptRecord: 'corrupt_project_task_execution_run_record',
} as const;

/**
 * Durable evidence that a task crossed the atomic pre-execution boundary.
 * This record contains provenance only and grants no execution or project authority.
 */
export type ProjectTaskExecutionRunRecord = {
  executionRunId: string;
  taskId: string;
  dispatchId: string;
  preparationLeaseId: string;
  preparationFencingToken: number;
  preparedAt: number;
};

export type PrepareProjectTaskExecutionRunInput = {
  dispatchId: string;
  taskId: string;
  leaseOwner: string;
  leaseId: string;
  fencingToken: number;
};

export interface ProjectTaskExecutionRunStore {
  prepareTaskExecutionRun(input: PrepareProjectTaskExecutionRunInput): ProjectTaskExecutionRunRecord;
  readTaskExecutionRun(executionRunId: string): ProjectTaskExecutionRunRecord | undefined;
  readTaskExecutionRunByTask(taskId: string): ProjectTaskExecutionRunRecord | undefined;
  listPreparedTaskExecutionRuns(limit: number): ProjectTaskExecutionRunRecord[];
}
