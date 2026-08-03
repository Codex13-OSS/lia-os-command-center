export type ProjectTaskPriority =
  | 'low'
  | 'normal'
  | 'high'
  | 'critical';

export type ProjectTaskRequestedCapability =
  | 'repository_read'
  | 'isolated_worktree_write'
  | 'run_tests'
  | 'local_commit';

/** Capabilities that a public project task request must never grant. */
export type ProjectTaskBlockedCapability =
  | 'push'
  | 'merge'
  | 'deploy'
  | 'production_write'
  | 'database_write'
  | 'secret_access';

export type ProjectTaskRequest = {
  projectId: string;
  instruction: string;
  priority: ProjectTaskPriority;
  requestedCapabilities: ProjectTaskRequestedCapability[];
};

export type ProjectTaskSafetyPolicy = {
  orchestrator: 'hermes';
  executor: 'codex';
  workspaceIsolation: 'isolated_worktree_only';
  humanApprovalRequiredForBlockedActions: true;
  productionAccess: false;
  databaseWriteAccess: false;
  secretAccess: false;
  allowedCapabilities: ProjectTaskRequestedCapability[];
  blockedCapabilities: ProjectTaskBlockedCapability[];
};

const ALLOWED_CAPABILITIES: readonly ProjectTaskRequestedCapability[] = [
  'repository_read',
  'isolated_worktree_write',
  'run_tests',
  'local_commit',
];

const BLOCKED_CAPABILITIES: readonly ProjectTaskBlockedCapability[] = [
  'push',
  'merge',
  'deploy',
  'production_write',
  'database_write',
  'secret_access',
];

export function createProjectTaskSafetyPolicy(): ProjectTaskSafetyPolicy {
  return {
    orchestrator: 'hermes',
    executor: 'codex',
    workspaceIsolation: 'isolated_worktree_only',
    humanApprovalRequiredForBlockedActions: true,
    productionAccess: false,
    databaseWriteAccess: false,
    secretAccess: false,
    allowedCapabilities: [...ALLOWED_CAPABILITIES],
    blockedCapabilities: [...BLOCKED_CAPABILITIES],
  };
}
