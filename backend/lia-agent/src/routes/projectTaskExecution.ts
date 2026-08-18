import { Router } from 'express';
import type { LiaAgentConfig } from '../config.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import { validateProjectTaskRequest } from '../contracts/projectExecutorValidation.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type {
  ProjectTaskExecutionError,
  ProjectTaskExecutionResult,
} from '../contracts/projectTaskExecution.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import { executeProjectTask } from '../services/projectTaskExecutionService.js';

export type ProjectTaskExecutionExecutor = (
  config: LiaAgentConfig,
  request: ProjectTaskRequest,
  projectRegistrySource: ProjectRegistrySource,
) => Promise<ProjectTaskExecutionResult>;

export type ProjectTaskExecutionRouterDependencies = {
  projectRegistrySource?: ProjectRegistrySource;
  executeTask?: ProjectTaskExecutionExecutor;
};

const ERROR_STATUS: Readonly<Record<ProjectTaskExecutionError, number>> = {
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
  human_approval_required: 409,
  missing_repository_read: 403,
  missing_isolated_worktree_write: 403,
  invalid_generated_path: 500,
  worktree_create_failed: 502,
  codex_execution_failed: 502,
  worktree_cleanup_failed: 502,
};

const isExecutionError = (value: unknown): value is ProjectTaskExecutionError =>
  typeof value === 'string' && Object.hasOwn(ERROR_STATUS, value);

export function createProjectTaskExecutionRouter(
  config: LiaAgentConfig,
  dependencies: ProjectTaskExecutionRouterDependencies = {},
): Router {
  const router = Router();

  router.route('/api/projects/tasks/execute').post(async (request, response) => {
    const registry = dependencies.projectRegistrySource;
    if (registry === undefined) {
      response.status(ERROR_STATUS.registry_unavailable).json({
        ok: false,
        error: 'registry_unavailable',
      });
      return;
    }

    const validation = validateProjectTaskRequest(request.body);
    if (!validation.success) {
      response.status(ERROR_STATUS.invalid_task).json({
        ok: false,
        error: 'invalid_task',
      });
      return;
    }

    let result: ProjectTaskExecutionResult;
    try {
      result = await (dependencies.executeTask ?? executeProjectTask)(
        config,
        validation.request,
        registry,
      );
    } catch {
      response.status(ERROR_STATUS.execution_failed).json({
        ok: false,
        error: 'execution_failed',
      });
      return;
    }

    if (!result.ok) {
      const error = isExecutionError(result.error) ? result.error : 'execution_failed';
      response.status(ERROR_STATUS[error]).json({ ok: false, error });
      return;
    }

    if (
      result.status !== 'completed'
      || typeof result.executionId !== 'string'
      || typeof result.summary !== 'string'
    ) {
      response.status(ERROR_STATUS.execution_failed).json({
        ok: false,
        error: 'execution_failed',
      });
      return;
    }

    response.status(200).json({
      ok: true,
      integration: 'project_execution',
      mode: 'isolated_codex_execution',
      status: 'completed',
      executionId: result.executionId,
      summary: result.summary,
    });
  }).all(methodNotAllowed(['POST']));

  return router;
}
