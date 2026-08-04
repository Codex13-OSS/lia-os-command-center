import type {
  ProjectTaskPriority,
  ProjectTaskRequestedCapability,
} from "./projectExecutor.js";
import type { ProjectOrchestrationStep } from "./projectOrchestration.js";

/** Internal-only Codex input. It must never be returned by a public API. */
export interface ProjectCodexHandoff {
  projectId: string;
  projectDisplayName: string;
  repositoryRoot: string;
  instruction: string;
  priority: ProjectTaskPriority;
  approvedCapabilities: ProjectTaskRequestedCapability[];
  /** Validated union of proposal requirements; execution authority is limited to this subset. */
  effectiveCapabilities: ProjectTaskRequestedCapability[];
  proposal: {
    summary: string;
    steps: ProjectOrchestrationStep[];
  };
  executor: "codex";
  workspaceIsolation: "isolated_worktree_only";
  productionAccess: false;
  databaseWriteAccess: false;
  secretAccess: false;
}

export interface ProjectCodexHandoffValidationError {
  path: string;
  message: string;
}

export type ProjectCodexHandoffBuildResult =
  | { success: true; handoff: ProjectCodexHandoff }
  | { success: false; errors: ProjectCodexHandoffValidationError[] };
