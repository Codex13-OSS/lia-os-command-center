import { createAutonomousV1ApprovedCapabilities } from '../contracts/autonomousAuthority.js';
import { createProjectTaskSafetyPolicy } from '../contracts/projectExecutor.js';
import type { ProjectExecutionPlanningResult } from '../contracts/projectExecutionPlan.js';
import { validateProjectTaskRequest } from '../contracts/projectExecutorValidation.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import { resolveAuthorizedProject } from './projectRegistry.js';

export async function planProjectTask(
  value: unknown,
  projectRegistrySource: ProjectRegistrySource,
): Promise<ProjectExecutionPlanningResult> {
  const validation = validateProjectTaskRequest(value);
  if (!validation.success) {
    return { ok: false, error: 'invalid_task' };
  }

  const resolution = await resolveAuthorizedProject(
    validation.request.projectId,
    projectRegistrySource,
  );
  if (!resolution.ok) {
    return resolution;
  }

  const policy = createProjectTaskSafetyPolicy();

  return {
    ok: true,
    plan: {
      projectId: resolution.target.projectId,
      projectDisplayName: resolution.target.displayName,
      repositoryRoot: resolution.target.repositoryRoot,
      instruction: validation.request.instruction,
      priority: validation.request.priority,
      // Backend-owned Autonomous V1 ceiling only. requestedCapabilities is
      // request metadata and never controls backend execution authority.
      approvedCapabilities: createAutonomousV1ApprovedCapabilities(),
      orchestrator: policy.orchestrator,
      executor: policy.executor,
      workspaceIsolation: policy.workspaceIsolation,
      requiresHumanApprovalForBlockedActions:
        policy.humanApprovalRequiredForBlockedActions,
      productionAccess: policy.productionAccess,
      databaseWriteAccess: policy.databaseWriteAccess,
      secretAccess: policy.secretAccess,
    },
  };
}
