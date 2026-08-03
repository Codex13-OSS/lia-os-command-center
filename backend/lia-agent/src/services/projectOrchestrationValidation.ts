import type {
  ProjectOrchestrationProposal,
  ProjectOrchestrationValidationError,
  ProjectOrchestrationValidationResult,
} from "../contracts/projectOrchestration.js";
import type {
  ProjectTaskBlockedCapability,
  ProjectTaskRequestedCapability,
} from "../contracts/projectExecutor.js";
import type { ProjectExecutionPlan } from "../contracts/projectExecutionPlan.js";

const TOP_LEVEL_FIELDS = ["summary", "steps", "requiresHumanApproval", "blockedActions"] as const;
const STEP_FIELDS = ["title", "objective", "requiredCapabilities"] as const;
const REQUESTED_CAPABILITIES = new Set<ProjectTaskRequestedCapability>([
  "repository_read",
  "isolated_worktree_write",
  "run_tests",
  "local_commit",
]);
const BLOCKED_CAPABILITIES = new Set<ProjectTaskBlockedCapability>([
  "push",
  "merge",
  "deploy",
  "production_write",
  "database_write",
  "secret_access",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProjectOrchestrationProposal(
  value: unknown,
  plan: ProjectExecutionPlan,
): ProjectOrchestrationValidationResult {
  const errors: ProjectOrchestrationValidationError[] = [];
  if (!isRecord(value)) {
    return { success: false, errors: [{ path: "$", message: "must be an object" }] };
  }

  for (const key of Object.keys(value)) {
    if (!(TOP_LEVEL_FIELDS as readonly string[]).includes(key)) {
      errors.push({ path: `$.${key}`, message: "unknown field" });
    }
  }

  const normalizeString = (input: unknown, path: string, max: number): string | undefined => {
    if (typeof input !== "string") {
      errors.push({ path, message: "must be a string" });
      return undefined;
    }
    const normalized = input.trim();
    if (!normalized) errors.push({ path, message: "must not be empty" });
    if (normalized.length > max) errors.push({ path, message: `must be at most ${max} characters` });
    return normalized;
  };

  const summary = normalizeString(value.summary, "$.summary", 1200);
  const steps: ProjectOrchestrationProposal["steps"] = [];
  if (!Array.isArray(value.steps)) {
    errors.push({ path: "$.steps", message: "must be an array" });
  } else {
    if (value.steps.length < 1) errors.push({ path: "$.steps", message: "must contain at least 1 step" });
    if (value.steps.length > 12) errors.push({ path: "$.steps", message: "must contain at most 12 steps" });
    value.steps.forEach((rawStep, index) => {
      const path = `$.steps[${index}]`;
      if (!isRecord(rawStep)) {
        errors.push({ path, message: "must be an object" });
        return;
      }
      for (const key of Object.keys(rawStep)) {
        if (!(STEP_FIELDS as readonly string[]).includes(key)) errors.push({ path: `${path}.${key}`, message: "unknown field" });
      }
      const title = normalizeString(rawStep.title, `${path}.title`, 160);
      const objective = normalizeString(rawStep.objective, `${path}.objective`, 1200);
      const capabilities: ProjectTaskRequestedCapability[] = [];
      if (!Array.isArray(rawStep.requiredCapabilities)) {
        errors.push({ path: `${path}.requiredCapabilities`, message: "must be an array" });
      } else {
        for (const capability of rawStep.requiredCapabilities) {
          const capabilityPath = `${path}.requiredCapabilities`;
          if (typeof capability !== "string" || !REQUESTED_CAPABILITIES.has(capability as ProjectTaskRequestedCapability)) {
            errors.push({ path: capabilityPath, message: "contains an unknown capability" });
          } else if (!plan.approvedCapabilities.includes(capability as ProjectTaskRequestedCapability)) {
            errors.push({ path: capabilityPath, message: "contains a capability not approved by LÍA" });
          } else if (!capabilities.includes(capability as ProjectTaskRequestedCapability)) {
            capabilities.push(capability as ProjectTaskRequestedCapability);
          }
        }
      }
      if (title !== undefined && objective !== undefined) steps.push({ title, objective, requiredCapabilities: capabilities });
    });
  }

  const blockedActions: ProjectTaskBlockedCapability[] = [];
  if (!Array.isArray(value.blockedActions)) {
    errors.push({ path: "$.blockedActions", message: "must be an array" });
  } else {
    if (value.blockedActions.length > 6) errors.push({ path: "$.blockedActions", message: "must contain at most 6 actions" });
    for (const action of value.blockedActions) {
      if (typeof action !== "string" || !BLOCKED_CAPABILITIES.has(action as ProjectTaskBlockedCapability)) {
        errors.push({ path: "$.blockedActions", message: "contains an unknown blocked action" });
      } else if (!blockedActions.includes(action as ProjectTaskBlockedCapability)) {
        blockedActions.push(action as ProjectTaskBlockedCapability);
      }
    }
  }

  if (typeof value.requiresHumanApproval !== "boolean") {
    errors.push({ path: "$.requiresHumanApproval", message: "must be a boolean" });
  } else if (value.requiresHumanApproval !== (blockedActions.length > 0)) {
    errors.push({ path: "$.requiresHumanApproval", message: "must match whether blockedActions is non-empty" });
  }

  if (errors.length || summary === undefined) return { success: false, errors };
  return { success: true, proposal: { summary, steps, requiresHumanApproval: value.requiresHumanApproval as boolean, blockedActions } };
}
