import {
  AUTONOMOUS_V1_CEILING,
  AUTONOMOUS_V1_COMPLETION_MODES,
  AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES,
} from '../contracts/autonomousAuthority.js';
import type { AutonomousV1CompletionMode } from '../contracts/autonomousAuthority.js';
import type {
  ProjectOrchestrationExecutionMode,
  ProjectOrchestrationProposal,
  ProjectOrchestrationStep,
  ProjectOrchestrationStepRole,
  ProjectOrchestrationValidationError,
  ProjectOrchestrationValidationResult,
} from "../contracts/projectOrchestration.js";
import type {
  ProjectTaskBlockedCapability,
  ProjectTaskRequestedCapability,
} from "../contracts/projectExecutor.js";
import type { ProjectExecutionPlan } from "../contracts/projectExecutionPlan.js";

const TOP_LEVEL_FIELDS = ["summary", "steps", "executionMode", "completionMode", "requiresHumanApproval", "blockedActions"] as const;
const STEP_FIELDS = ["id", "title", "objective", "role", "dependsOn", "requiredCapabilities"] as const;
const EXECUTION_MODES = new Set<ProjectOrchestrationExecutionMode>(["direct", "delegated"]);
const COMPLETION_MODES = new Set<AutonomousV1CompletionMode>([...AUTONOMOUS_V1_COMPLETION_MODES]);
const STEP_ROLES = new Set<ProjectOrchestrationStepRole>([
  "architect",
  "implementer",
  "reviewer",
  "researcher",
  "orchestrator",
]);
const REQUESTED_CAPABILITIES = new Set<ProjectTaskRequestedCapability>([
  ...AUTONOMOUS_V1_CEILING,
]);
const BLOCKED_CAPABILITIES = new Set<ProjectTaskBlockedCapability>([
  ...AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES,
]);
const MAX_STEPS = 12;
const MAX_ID_LENGTH = 64;
const MAX_DEPENDS_ON_ENTRIES = 12;

/** A step that parsed cleanly together with its raw position in the submitted array. */
interface ParsedStep {
  rawIndex: number;
  step: ProjectOrchestrationStep;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic DAG cycle detection over validated steps.
 *
 * Callers MUST pass a step list with unique ids: duplicate ids are rejected by
 * the caller before cycle analysis, so the id -> index map is unambiguous.
 * Running cycle analysis over duplicated ids would otherwise produce
 * last-index-wins ambiguity; skipping it keeps validation fail-closed and
 * deterministic.
 *
 * Returns the position (in `steps`) of a step that closes a cycle, if any.
 */
function findDependencyCycleIndex(steps: ProjectOrchestrationStep[]): number | undefined {
  const indexById = new Map(steps.map((step, index) => [step.id, index]));
  const color = new Array<number>(steps.length).fill(0);
  let found: number | undefined;
  const visit = (index: number): boolean => {
    if (found !== undefined) return true;
    if (color[index] === 2) return false;
    if (color[index] === 1) {
      found = index;
      return true;
    }
    color[index] = 1;
    for (const dependency of steps[index].dependsOn) {
      const next = indexById.get(dependency);
      // Self-dependencies are rejected separately; do not treat them as cycles here.
      if (next !== undefined && next !== index && visit(next)) return true;
    }
    color[index] = 2;
    return false;
  };
  for (let index = 0; index < steps.length; index += 1) {
    if (visit(index)) break;
  }
  return found;
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
  const executionMode = value.executionMode;
  const executionModeIsValid = (
    typeof executionMode === "string"
    && EXECUTION_MODES.has(executionMode as ProjectOrchestrationExecutionMode)
  );
  if (!executionModeIsValid) {
    errors.push({ path: "$.executionMode", message: "must be 'direct' or 'delegated'" });
  }

  // completionMode is validated intent metadata only. Missing intent fails
  // closed to the legacy non-final behavior; unknown values are rejected.
  let completionMode: AutonomousV1CompletionMode = "ready_for_review";
  if (value.completionMode !== undefined) {
    if (
      typeof value.completionMode !== "string"
      || !COMPLETION_MODES.has(value.completionMode as AutonomousV1CompletionMode)
    ) {
      errors.push({ path: "$.completionMode", message: "must be one of: analyze, ready_for_review, complete" });
    } else {
      completionMode = value.completionMode as AutonomousV1CompletionMode;
    }
  }

  const steps: ParsedStep[] = [];
  if (!Array.isArray(value.steps)) {
    errors.push({ path: "$.steps", message: "must be an array" });
  } else {
    if (value.steps.length < 1) errors.push({ path: "$.steps", message: "must contain at least 1 step" });
    if (value.steps.length > MAX_STEPS) {
      errors.push({ path: "$.steps", message: `must contain at most ${MAX_STEPS} steps` });
    }
    value.steps.forEach((rawStep, index) => {
      const path = `$.steps[${index}]`;
      if (!isRecord(rawStep)) {
        errors.push({ path, message: "must be an object" });
        return;
      }
      for (const key of Object.keys(rawStep)) {
        if (!(STEP_FIELDS as readonly string[]).includes(key)) errors.push({ path: `${path}.${key}`, message: "unknown field" });
      }
      const id = normalizeString(rawStep.id, `${path}.id`, MAX_ID_LENGTH);
      const title = normalizeString(rawStep.title, `${path}.title`, 160);
      const objective = normalizeString(rawStep.objective, `${path}.objective`, 1200);
      const role = rawStep.role;
      if (typeof role !== "string" || !STEP_ROLES.has(role as ProjectOrchestrationStepRole)) {
        errors.push({ path: `${path}.role`, message: "must be one of: architect, implementer, reviewer, researcher, orchestrator" });
      }
      const dependsOn: string[] = [];
      if (!Array.isArray(rawStep.dependsOn)) {
        errors.push({ path: `${path}.dependsOn`, message: "must be an array" });
      } else {
        if (rawStep.dependsOn.length > MAX_DEPENDS_ON_ENTRIES) {
          errors.push({ path: `${path}.dependsOn`, message: `must contain at most ${MAX_DEPENDS_ON_ENTRIES} entries` });
        }
        for (const dependency of rawStep.dependsOn) {
          const normalized = normalizeString(dependency, `${path}.dependsOn`, MAX_ID_LENGTH);
          if (normalized !== undefined) dependsOn.push(normalized);
        }
      }
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
      if (id !== undefined && title !== undefined && objective !== undefined && typeof role === "string") {
        steps.push({
          rawIndex: index,
          step: {
            id,
            title,
            objective,
            role: role as ProjectOrchestrationStepRole,
            dependsOn,
            requiredCapabilities: capabilities,
          },
        });
      }
    });
  }

  // DAG analysis uses raw submitted indices so diagnostics point at the real step.
  const stepIds = new Set(steps.map(({ step }) => step.id));
  const seenIds = new Set<string>();
  let duplicateIds = false;
  for (const { rawIndex, step } of steps) {
    if (seenIds.has(step.id)) {
      errors.push({ path: `$.steps[${rawIndex}].id`, message: "must be unique" });
      duplicateIds = true;
    }
    seenIds.add(step.id);
    const seenDependencies = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (seenDependencies.has(dependency)) {
        // Duplicate normalized ids inside one dependsOn array fail closed.
        errors.push({ path: `$.steps[${rawIndex}].dependsOn`, message: "must not contain duplicate step ids" });
        continue;
      }
      seenDependencies.add(dependency);
      if (dependency === step.id) {
        errors.push({ path: `$.steps[${rawIndex}].dependsOn`, message: "must not reference itself" });
      } else if (!stepIds.has(dependency)) {
        errors.push({ path: `$.steps[${rawIndex}].dependsOn`, message: "references an unknown step id" });
      }
    }
  }
  // Cycle analysis only runs on unique ids: duplicate ids already fail
  // validation, so the id -> index map can never be ambiguous (no
  // last-index-wins behavior). Malformed steps were already rejected above and
  // are excluded here; the proposal still fails closed.
  if (!duplicateIds && steps.length > 0) {
    const cycleIndex = findDependencyCycleIndex(steps.map(({ step }) => step));
    if (cycleIndex !== undefined) {
      errors.push({ path: `$.steps[${steps[cycleIndex].rawIndex}].dependsOn`, message: "creates a dependency cycle" });
    }
  }

  // executionMode runtime semantics. Metadata only: it never grants
  // capabilities, but it constrains the shape of the validated proposal.
  if (executionModeIsValid) {
    const mode = executionMode as ProjectOrchestrationExecutionMode;
    if (mode === "direct") {
      if (steps.length !== 1) {
        errors.push({ path: "$.steps", message: "direct executionMode must contain exactly 1 step" });
      }
      for (const { rawIndex, step } of steps) {
        if (step.dependsOn.length > 0) {
          errors.push({ path: `$.steps[${rawIndex}].dependsOn`, message: "direct executionMode must not declare dependencies" });
        }
      }
    } else if (mode === "delegated") {
      if (steps.length < 2) {
        errors.push({ path: "$.steps", message: "delegated executionMode must contain at least 2 steps" });
      }
    }
  }

  // completionMode=analyze runtime semantics: the proposal must stay genuinely
  // read-only. Intent metadata never grants authority; this constraint keeps
  // analyze unable to smuggle write, run_tests or local_commit capability.
  if (completionMode === "analyze") {
    for (const { rawIndex, step } of steps) {
      const nonReadOnly = step.requiredCapabilities.find(
        (capability) => capability !== "repository_read",
      );
      if (nonReadOnly !== undefined) {
        errors.push({
          path: `$.steps[${rawIndex}].requiredCapabilities`,
          message: "analyze completionMode must not require isolated_worktree_write, run_tests or local_commit",
        });
      }
    }
  }

  const blockedActions: ProjectTaskBlockedCapability[] = [];
  if (!Array.isArray(value.blockedActions)) {
    errors.push({ path: "$.blockedActions", message: "must be an array" });
  } else {
    if (value.blockedActions.length > BLOCKED_CAPABILITIES.size) {
      errors.push({ path: "$.blockedActions", message: `must contain at most ${BLOCKED_CAPABILITIES.size} actions` });
    }
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
  return {
    success: true,
    proposal: {
      summary,
      steps: steps.map(({ step }) => step),
      executionMode: executionMode as ProjectOrchestrationExecutionMode,
      completionMode,
      requiresHumanApproval: value.requiresHumanApproval as boolean,
      blockedActions,
    },
  };
}
