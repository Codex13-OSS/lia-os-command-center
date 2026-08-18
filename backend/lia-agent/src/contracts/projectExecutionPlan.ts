import type {
  ProjectTaskPriority,
  ProjectTaskRequestedCapability,
} from './projectExecutor.js';

/** Internal execution data. It must not be returned by the public API. */
export type ProjectExecutionPlan = {
  projectId: string;
  projectDisplayName: string;
  repositoryRoot: string;
  instruction: string;
  priority: ProjectTaskPriority;
  approvedCapabilities: ProjectTaskRequestedCapability[];
  orchestrator: 'hermes';
  executor: 'codex';
  workspaceIsolation: 'isolated_worktree_only';
  requiresHumanApprovalForBlockedActions: true;
  productionAccess: false;
  databaseWriteAccess: false;
  secretAccess: false;
};

export type ProjectExecutionPlanningResult =
  | { ok: true; plan: ProjectExecutionPlan }
  | {
    ok: false;
    error:
      | 'invalid_task'
      | 'project_not_found'
      | 'project_disabled'
      | 'registry_unavailable';
  };
