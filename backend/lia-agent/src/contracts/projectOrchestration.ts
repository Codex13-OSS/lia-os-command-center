import type {
  ProjectTaskBlockedCapability,
  ProjectTaskRequestedCapability,
} from "./projectExecutor.js";

export interface ProjectOrchestrationStep {
  title: string;
  objective: string;
  requiredCapabilities: ProjectTaskRequestedCapability[];
}

export interface ProjectOrchestrationProposal {
  summary: string;
  steps: ProjectOrchestrationStep[];
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
