import type { ProjectTaskLeaseRecord } from './projectTaskLease.js';

export const PROJECT_TASK_DISPATCH_MAX_LIST_LIMIT = 100;

export const PROJECT_TASK_DISPATCH_ERRORS = {
  invalidInput: 'invalid_project_task_dispatch_input',
  taskNotFound: 'project_task_dispatch_task_not_found',
  taskUnavailable: 'project_task_dispatch_task_unavailable',
  dispatchNotFound: 'project_task_dispatch_not_found',
  alreadyConsumed: 'project_task_dispatch_already_consumed',
  authorityMismatch: 'project_task_dispatch_authority_mismatch',
  corruptRecord: 'corrupt_project_task_dispatch_record',
} as const;

export type ProjectTaskDispatchRecord = {
  dispatchId: string;
  taskId: string;
  createdAt: number;
  consumedAt?: number;
  consumedLeaseId?: string;
  consumedFencingToken?: number;
};

export type ClaimProjectTaskDispatchInput = {
  dispatchId: string;
  leaseOwner: string;
  durationMs: number;
};

export type ProjectTaskDispatchClaim = {
  dispatch: ProjectTaskDispatchRecord;
  lease: ProjectTaskLeaseRecord;
};

export type ConsumeProjectTaskDispatchInput = {
  dispatchId: string;
  taskId: string;
  leaseOwner: string;
  leaseId: string;
  fencingToken: number;
};

/**
 * Durable dispatch intent/outbox primitive. Dispatch metadata and lease
 * ownership never grant or expand project or workflow capabilities.
 */
export interface ProjectTaskDispatchStore {
  enqueueTaskDispatch(taskId: string): ProjectTaskDispatchRecord;
  readTaskDispatch(dispatchId: string): ProjectTaskDispatchRecord | undefined;
  readTaskDispatchByTask(taskId: string): ProjectTaskDispatchRecord | undefined;
  listPendingTaskDispatches(limit: number): ProjectTaskDispatchRecord[];
  claimTaskDispatch(input: ClaimProjectTaskDispatchInput): ProjectTaskDispatchClaim;
  consumeTaskDispatch(input: ConsumeProjectTaskDispatchInput): ProjectTaskDispatchRecord;
}
