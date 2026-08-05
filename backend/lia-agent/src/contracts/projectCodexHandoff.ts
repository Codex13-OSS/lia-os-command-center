import type {
  ProjectTaskPriority,
  ProjectTaskRequestedCapability,
} from "./projectExecutor.js";

/**
 * Minimal proposal step forwarded to Codex. Multi-agent metadata (id, role,
 * dependsOn, executionMode) is never handed off and never influences either
 * capability set. Capabilities derive only from LÍA authorization and
 * validated requiredCapabilities.
 */
export interface ProjectCodexHandoffStep {
  title: string;
  objective: string;
  requiredCapabilities: ProjectTaskRequestedCapability[];
}

/**
 * Internal-only Codex input. It must never be returned by a public API.
 *
 * Capability semantics:
 * - `approvedCapabilities` is ONLY the LÍA-authorized ceiling/context. Its
 *   presence does NOT authorize execution: an executor MUST NOT use a
 *   capability merely because it exists here.
 * - `effectiveCapabilities` is the BINDING execution capability set. A
 *   capability is executable if and only if it is present here.
 * - Invariant: effectiveCapabilities is always a subset of
 *   approvedCapabilities. buildProjectCodexHandoff preserves this invariant
 *   and fails closed if it would ever be violated.
 * - Metadata (id, role, dependsOn, executionMode) MUST NOT influence either
 *   capability set.
 */
export interface ProjectCodexHandoff {
  projectId: string;
  projectDisplayName: string;
  repositoryRoot: string;
  instruction: string;
  priority: ProjectTaskPriority;
  /** LÍA-authorized ceiling/context only; never an execution grant by itself. */
  approvedCapabilities: ProjectTaskRequestedCapability[];
  /**
   * BINDING execution capability set. Derived exclusively from the validated
   * requiredCapabilities of the proposal steps, capped by approvedCapabilities.
   * Always a subset of approvedCapabilities.
   */
  effectiveCapabilities: ProjectTaskRequestedCapability[];
  proposal: {
    summary: string;
    steps: ProjectCodexHandoffStep[];
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
