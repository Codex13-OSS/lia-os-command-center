export type ProjectRegistryEntry = {
  projectId: string;
  displayName: string;
  repositoryRoot: string;
  enabled: boolean;
};

export type ProjectRegistrySource = {
  read(): Promise<ProjectRegistryEntry[]>;
};

export type ProjectExecutionTarget = {
  projectId: string;
  displayName: string;
  repositoryRoot: string;
};

export type ProjectResolutionResult =
  | { ok: true; target: ProjectExecutionTarget }
  | {
    ok: false;
    error: 'project_not_found' | 'project_disabled' | 'registry_unavailable';
  };
