import type { AutonomousV1CompletionMode } from "./autonomousAuthority.js";
import type {
  ProjectTaskBlockedCapability,
  ProjectTaskRequestedCapability,
} from "./projectExecutor.js";

/**
 * How a validated proposal is meant to be executed. METADATA ONLY: it never
 * grants, expands or derives capabilities. Capabilities come exclusively from
 * LÍA authorization (approvedCapabilities) and validated requiredCapabilities.
 *
 * Runtime semantics enforced by the validator:
 * - "direct": non-delegated execution by a single executor. The proposal MUST
 *   contain exactly ONE step, that step MUST have dependsOn=[], and there MUST
 *   be no DAG/delegation structure. A direct proposal with more than one step,
 *   or whose single step declares dependencies, fails validation.
 * - "delegated": orchestrated multi-step planning metadata. The proposal MUST
 *   contain at least TWO steps and a valid DAG (unique ids, no unknown or self
 *   dependencies, no cycles). Roles remain metadata only; executionMode itself
 *   grants no capabilities.
 */
export type ProjectOrchestrationExecutionMode = "direct" | "delegated";

/**
 * Roles available for step planning metadata. METADATA ONLY, never authority:
 * a role never grants, implies or maps to capabilities or permissions.
 */
export type ProjectOrchestrationStepRole =
  | "architect"
  | "implementer"
  | "reviewer"
  | "researcher"
  | "orchestrator";

export interface ProjectOrchestrationStep {
  /** Stable, unique identifier referenced by dependsOn. Metadata only. */
  id: string;
  title: string;
  objective: string;
  /** Planning metadata only; never grants capabilities. */
  role: ProjectOrchestrationStepRole;
  /**
   * IDs of steps that must be planned before this one. Metadata only: it never
   * grants capabilities. Must reference existing, distinct ids (no duplicates
   * inside the array, no self references, no cycles).
   */
  dependsOn: string[];
  /**
   * The only capability source of a step: every entry must be inside
   * approvedCapabilities. Validated, deduplicated, fail-closed.
   */
  requiredCapabilities: ProjectTaskRequestedCapability[];
}

export interface ProjectOrchestrationProposal {
  summary: string;
  steps: ProjectOrchestrationStep[];
  /**
   * Execution intent metadata only. It never grants capabilities; it only
   * constrains the validated proposal shape (see
   * ProjectOrchestrationExecutionMode).
   */
  executionMode: ProjectOrchestrationExecutionMode;
  /**
   * Completion intent metadata only. VALIDATED INTENT, never authority: the
   * value itself does not grant, expand or derive capabilities. The LÍA
   * backend-owned autonomous authority policy (see
   * deriveAutonomousV1CompletionCapabilities) is the sole translator of a
   * valid completion intent into the binding workflow capability set.
   * Absent values fail closed to "ready_for_review" (the legacy non-final
   * behavior); unknown values are rejected by validation.
   */
  completionMode: AutonomousV1CompletionMode;
  requiresHumanApproval: boolean;
  blockedActions: ProjectTaskBlockedCapability[];
}

export interface ProjectOrchestrationValidationError {
  path: string;
  message: string;
}

export type ProjectOrchestrationValidationResult =
  | { success: true; proposal: ProjectOrchestrationProposal }
  | { success: false; errors: ProjectOrchestrationValidationError[] };
