import { deriveAutonomousV1CompletionCapabilities } from "../contracts/autonomousAuthority.js";
import type {
  ProjectCodexHandoffBuildResult,
  ProjectCodexHandoffValidationError,
} from "../contracts/projectCodexHandoff.js";
import type { ProjectExecutionPlan } from "../contracts/projectExecutionPlan.js";
import type { ProjectOrchestrationProposal } from "../contracts/projectOrchestration.js";
import type {
  ProjectTaskPriority,
  ProjectTaskRequestedCapability,
} from "../contracts/projectExecutor.js";
import { validateProjectOrchestrationProposal } from "./projectOrchestrationValidation.js";

const PLAN_FIELDS = new Set([
  "projectId",
  "projectDisplayName",
  "repositoryRoot",
  "instruction",
  "priority",
  "approvedCapabilities",
  "orchestrator",
  "executor",
  "workspaceIsolation",
  "requiresHumanApprovalForBlockedActions",
  "productionAccess",
  "databaseWriteAccess",
  "secretAccess",
]);
const PRIORITIES = new Set<ProjectTaskPriority>(["low", "normal", "high", "critical"]);
const CAPABILITIES = new Set<ProjectTaskRequestedCapability>([
  "repository_read",
  "isolated_worktree_write",
  "run_tests",
  "local_commit",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePlan(value: unknown): {
  plan?: ProjectExecutionPlan;
  errors: ProjectCodexHandoffValidationError[];
} {
  if (!isRecord(value)) {
    return { errors: [{ path: "$.plan", message: "must be a validated execution plan" }] };
  }

  const errors: ProjectCodexHandoffValidationError[] = [];
  for (const key of Object.keys(value)) {
    if (!PLAN_FIELDS.has(key)) errors.push({ path: `$.plan.${key}`, message: "unknown field" });
  }

  for (const key of ["projectId", "projectDisplayName", "repositoryRoot", "instruction"] as const) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      errors.push({ path: `$.plan.${key}`, message: "must be a non-empty string" });
    }
  }
  if (!PRIORITIES.has(value.priority as ProjectTaskPriority)) {
    errors.push({ path: "$.plan.priority", message: "invalid priority" });
  }

  const approvedCapabilities: ProjectTaskRequestedCapability[] = [];
  if (!Array.isArray(value.approvedCapabilities)) {
    errors.push({ path: "$.plan.approvedCapabilities", message: "must be an array" });
  } else {
    for (const capability of value.approvedCapabilities) {
      if (!CAPABILITIES.has(capability as ProjectTaskRequestedCapability)) {
        errors.push({ path: "$.plan.approvedCapabilities", message: "contains an unknown capability" });
      } else if (!approvedCapabilities.includes(capability as ProjectTaskRequestedCapability)) {
        approvedCapabilities.push(capability as ProjectTaskRequestedCapability);
      }
    }
  }

  const constants = [
    ["orchestrator", "hermes"],
    ["executor", "codex"],
    ["workspaceIsolation", "isolated_worktree_only"],
    ["requiresHumanApprovalForBlockedActions", true],
    ["productionAccess", false],
    ["databaseWriteAccess", false],
    ["secretAccess", false],
  ] as const;
  for (const [key, expected] of constants) {
    if (value[key] !== expected) errors.push({ path: `$.plan.${key}`, message: "invalid safety policy" });
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    plan: {
      projectId: (value.projectId as string).trim(),
      projectDisplayName: (value.projectDisplayName as string).trim(),
      repositoryRoot: (value.repositoryRoot as string).trim(),
      instruction: (value.instruction as string).trim(),
      priority: value.priority as ProjectTaskPriority,
      approvedCapabilities,
      orchestrator: "hermes",
      executor: "codex",
      workspaceIsolation: "isolated_worktree_only",
      requiresHumanApprovalForBlockedActions: true,
      productionAccess: false,
      databaseWriteAccess: false,
      secretAccess: false,
    },
  };
}

export function buildProjectCodexHandoff(
  executionPlan: unknown,
  orchestrationProposal: unknown,
): ProjectCodexHandoffBuildResult {
  const planValidation = validatePlan(executionPlan);
  if (planValidation.plan === undefined) {
    return { success: false, errors: planValidation.errors };
  }

  const proposalValidation = validateProjectOrchestrationProposal(
    orchestrationProposal,
    planValidation.plan,
  );
  if (!proposalValidation.success) {
    return {
      success: false,
      errors: proposalValidation.errors.map((error) => ({
        path: `$.proposal${error.path.slice(1)}`,
        message: error.message,
      })),
    };
  }

  if (
    proposalValidation.proposal.requiresHumanApproval
    || proposalValidation.proposal.blockedActions.length > 0
  ) {
    return {
      success: false,
      errors: [{
        path: "$.proposal.blockedActions",
        message: "blocked actions cannot be handed off to Codex",
      }],
    };
  }

  const plan = planValidation.plan;
  const proposal: ProjectOrchestrationProposal = proposalValidation.proposal;
  const proposedCapabilities = proposal.steps.flatMap((step) => step.requiredCapabilities)
    .filter((capability, index, all) => all.indexOf(capability) === index);
  // The BINDING execution capability set is derived by the backend-owned
  // completion policy. Hermes requiredCapabilities express only the minimum
  // operational requirements of its steps; for completionMode="complete"
  // modification work the backend adds the safe completion prerequisites
  // (run_tests, local_commit, repository_read). The completionMode value
  // itself is validated intent metadata and never grants authority on its own.
  const completionPolicy = deriveAutonomousV1CompletionCapabilities(
    proposal.completionMode,
    proposedCapabilities,
    plan.approvedCapabilities,
  );
  if (!completionPolicy.ok) {
    const message = completionPolicy.reason === "unknown_completion_mode"
      ? "unknown completionMode"
      : completionPolicy.reason === "analyze_not_read_only"
        ? "analyze completionMode must remain read-only"
        : completionPolicy.reason === "local_commit_without_run_tests"
          ? "local_commit requires run_tests"
          : "complete completion prerequisites are not available within approvedCapabilities";
    return {
      success: false,
      errors: [{
        path: "$.proposal.completionMode",
        message,
      }],
    };
  }
  const effectiveCapabilities = completionPolicy.capabilities;
  // Binding execution set invariant: effectiveCapabilities MUST remain a
  // subset of approvedCapabilities. Validation and the completion policy
  // already guarantee it; this check fails closed in case the invariant is
  // ever violated.
  if (effectiveCapabilities.some((capability) => !plan.approvedCapabilities.includes(capability))) {
    return {
      success: false,
      errors: [{
        path: "$.proposal.effectiveCapabilities",
        message: "must be a subset of approvedCapabilities",
      }],
    };
  }
  return {
    success: true,
    handoff: {
      projectId: plan.projectId,
      projectDisplayName: plan.projectDisplayName,
      repositoryRoot: plan.repositoryRoot,
      instruction: plan.instruction,
      priority: plan.priority,
      approvedCapabilities: [...plan.approvedCapabilities],
      effectiveCapabilities,
      proposal: {
        summary: proposal.summary,
        steps: proposal.steps.map((step) => ({
          title: step.title,
          objective: step.objective,
          requiredCapabilities: [...step.requiredCapabilities],
        })),
      },
      executor: "codex",
      workspaceIsolation: "isolated_worktree_only",
      productionAccess: false,
      databaseWriteAccess: false,
      secretAccess: false,
    },
  };
}
