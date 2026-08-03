import { Router } from 'express';
import type { LiaAgentConfig } from '../config.js';
import type { ProjectOrchestrationExecutionError } from '../contracts/projectOrchestrationExecution.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import type { HermesQueryExecutor } from '../services/hermesExecutor.js';
import { orchestrateProjectTask } from '../services/projectOrchestrationService.js';

export type ProjectOrchestrationRouterDependencies = {
  projectRegistrySource?: ProjectRegistrySource;
  executeQuery?: HermesQueryExecutor;
};

const ERROR_STATUS: Readonly<Record<ProjectOrchestrationExecutionError, number>> = {
  invalid_task: 400,
  project_not_found: 404,
  project_disabled: 403,
  registry_unavailable: 503,
  prompt_too_large: 413,
  execution_disabled: 503,
  timeout: 504,
  execution_failed: 502,
  empty_response: 502,
  invalid_hermes_json: 502,
  invalid_hermes_proposal: 502,
};

export function createProjectOrchestrationRouter(
  config: LiaAgentConfig,
  dependencies: ProjectOrchestrationRouterDependencies = {},
): Router {
  const router = Router();

  router.route('/api/projects/tasks/orchestrate').post(async (request, response) => {
    if (dependencies.projectRegistrySource === undefined) {
      response.status(ERROR_STATUS.registry_unavailable).json({
        ok: false,
        error: 'registry_unavailable',
      });
      return;
    }

    let result;
    try {
      result = await orchestrateProjectTask(
        config,
        request.body,
        dependencies.projectRegistrySource,
        dependencies.executeQuery,
      );
    } catch {
      response.status(ERROR_STATUS.execution_failed).json({
        ok: false,
        error: 'execution_failed',
      });
      return;
    }

    if (!result.ok) {
      response.status(ERROR_STATUS[result.error]).json({
        ok: false,
        error: result.error,
      });
      return;
    }

    response.status(200).json({
      ok: true,
      integration: 'project_orchestration',
      mode: 'reasoning_only',
      proposal: result.proposal,
    });
  }).all(methodNotAllowed(['POST']));

  return router;
}
