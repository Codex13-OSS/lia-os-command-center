export const PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN = 1;
export const PROJECT_TASK_LEASE_MIN_DURATION_MS = 1_000;
export const PROJECT_TASK_LEASE_MAX_DURATION_MS = 300_000;

export const PROJECT_TASK_LEASE_ERRORS = {
  invalidInput: 'invalid_project_task_lease_input',
  taskNotFound: 'project_task_lease_task_not_found',
  taskTerminal: 'project_task_lease_task_terminal',
  unavailable: 'project_task_lease_unavailable',
  notFound: 'project_task_lease_not_found',
  stale: 'project_task_lease_stale',
  expired: 'project_task_lease_expired',
  fencingExhausted: 'project_task_lease_fencing_exhausted',
  corruptRecord: 'corrupt_project_task_lease_record',
} as const;

export type ProjectTaskLeaseRecord = {
  taskId: string;
  leaseOwner: string;
  leaseId: string;
  fencingToken: number;
  acquiredAt: number;
  leaseExpiresAt: number;
};

export type AcquireProjectTaskLeaseInput = {
  taskId: string;
  leaseOwner: string;
  durationMs: number;
};

export type ProjectTaskLeaseAuthority = {
  taskId: string;
  leaseOwner: string;
  leaseId: string;
  fencingToken: number;
};

export type RenewProjectTaskLeaseInput = ProjectTaskLeaseAuthority & {
  durationMs: number;
};

/**
 * Durable lease/fencing primitive. It grants only temporary internal ownership;
 * it never grants or changes project, goal, workflow, or capability authority.
 * A lease is expired exactly when now >= leaseExpiresAt.
 */
export interface ProjectTaskLeaseStore {
  acquireTaskLease(input: AcquireProjectTaskLeaseInput): ProjectTaskLeaseRecord;
  renewTaskLease(input: RenewProjectTaskLeaseInput): ProjectTaskLeaseRecord;
  releaseTaskLease(authority: ProjectTaskLeaseAuthority): ProjectTaskLeaseRecord;
  readTaskLease(taskId: string): ProjectTaskLeaseRecord | undefined;
  validateTaskLease(authority: ProjectTaskLeaseAuthority): boolean;
  assertCurrentTaskLease(authority: ProjectTaskLeaseAuthority): ProjectTaskLeaseRecord;
}
