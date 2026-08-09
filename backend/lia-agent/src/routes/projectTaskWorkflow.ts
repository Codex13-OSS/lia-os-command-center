import { Router } from 'express';
import type { LiaAgentConfig } from '../config.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import { validateProjectTaskRequest } from '../contracts/projectExecutorValidation.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import { isSafeTaskStages } from '../contracts/projectTask.js';
import type {
  ProjectTaskWorkflowResult,
  ProjectTaskWorkflowStage,
} from '../contracts/projectTaskWorkflow.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import { executeProjectTaskWorkflow } from '../services/projectTaskWorkflowService.js';

export type ProjectTaskWorkflowExecutor = (
  config: LiaAgentConfig,
  request: ProjectTaskRequest,
  projectRegistrySource: ProjectRegistrySource,
  projectVerificationRegistry?: ProjectVerificationRegistry,
) => Promise<ProjectTaskWorkflowResult>;

export type ProjectTaskWorkflowRouterDependencies = {
  projectRegistrySource?: ProjectRegistrySource;
  projectVerificationRegistry?: ProjectVerificationRegistry;
  executeWorkflow?: ProjectTaskWorkflowExecutor;
};

const ERROR_STATUS: Readonly<Record<ProjectTaskWorkflowStage, Readonly<Record<string, number>>>> = {
  planning: {
    invalid_task: 400,
    project_not_found: 404,
    project_disabled: 403,
    registry_unavailable: 503,
    local_commit_requires_run_tests: 400,
  },
  hermes: {
    prompt_too_large: 413,
    execution_disabled: 503,
    timeout: 504,
    execution_failed: 502,
    empty_response: 502,
    invalid_hermes_json: 502,
    invalid_hermes_proposal: 502,
  },
  approval: { human_approval_required: 409 },
  codex: {
    missing_repository_read: 403,
    missing_isolated_worktree_write: 403,
    prompt_too_large: 413,
    invalid_generated_path: 500,
    worktree_create_failed: 502,
    codex_execution_failed: 502,
    timeout: 504,
    worktree_cleanup_failed: 502,
  },
  verification: {
    verification_unavailable: 503,
    invalid_generated_path: 500,
    check_failed: 422,
    check_timeout: 504,
  },
  commit: {
    local_commit_not_approved: 403,
    workspace_not_verified: 409,
    invalid_generated_path: 500,
    nothing_to_commit: 409,
    git_status_failed: 502,
    git_stage_failed: 502,
    git_commit_failed: 502,
    git_revision_failed: 502,
  },
};

const STAGES = new Set<ProjectTaskWorkflowStage>([
  'planning', 'hermes', 'approval', 'codex', 'verification', 'commit',
]);

const isStage = (value: unknown): value is ProjectTaskWorkflowStage =>
  typeof value === 'string' && STAGES.has(value as ProjectTaskWorkflowStage);

export function createProjectTaskWorkflowRouter(
  config: LiaAgentConfig,
  dependencies: ProjectTaskWorkflowRouterDependencies = {},
): Router {
  const router = Router();

  router.route('/api/projects/tasks/workflow').post(async (request, response) => {
    const registry = dependencies.projectRegistrySource;
    if (registry === undefined) {
      response.status(503).json({ ok: false, error: 'registry_unavailable' });
      return;
    }

    const validation = validateProjectTaskRequest(request.body);
    if (!validation.success) {
      response.status(400).json({
        ok: false,
        integration: 'project_workflow',
        stage: 'planning',
        error: 'invalid_task',
      });
      return;
    }

    let result: ProjectTaskWorkflowResult;
    try {
      result = await (dependencies.executeWorkflow ?? executeProjectTaskWorkflow)(
        config,
        validation.request,
        registry,
        dependencies.projectVerificationRegistry,
      );
    } catch {
      response.status(502).json({
        ok: false,
        integration: 'project_workflow',
        stage: 'hermes',
        error: 'execution_failed',
      });
      return;
    }

    if (!result.ok) {
      const stage = isStage(result.stage) ? result.stage : 'planning';
      const error = typeof result.error === 'string' ? result.error : 'unknown_error';
      const status = ERROR_STATUS[stage][error] ?? 500;
      response.status(status).json({
        ok: false,
        integration: 'project_workflow',
        stage,
        error,
        ...(typeof result.projectId === 'string' ? { projectId: result.projectId } : {}),
        ...(typeof result.executionId === 'string' ? { executionId: result.executionId } : {}),
        ...(typeof result.summary === 'string' ? { summary: result.summary } : {}),
        ...(result.completedStages !== undefined && isSafeTaskStages(result.completedStages)
          ? { completedStages: [...result.completedStages] }
          : {}),
      });
      return;
    }

    if (
      typeof result.projectId !== 'string'
      || typeof result.executionId !== 'string'
      || typeof result.executionSummary !== 'string'
      || typeof result.resultText !== 'string'
      || result.resultText.length < 1
      || result.resultText.length > 6000
      || !['analyzed', 'ready_for_review', 'verified', 'committed'].includes(result.status)
    ) {
      response.status(500).json({
        ok: false,
        integration: 'project_workflow',
        stage: 'codex',
        error: 'codex_execution_failed',
      });
      return;
    }

    const receipt = {
      ok: true,
      integration: 'project_workflow',
      mode: 'isolated_codex_workflow',
      projectId: result.projectId,
      executionId: result.executionId,
      status: result.status,
      executionSummary: result.executionSummary,
      resultText: result.resultText,
      ...(result.stages !== undefined && isSafeTaskStages(result.stages) ? { stages: [...result.stages] } : {}),
    };

    if (result.status === 'ready_for_review' || result.status === 'analyzed') {
      response.status(200).json(receipt);
      return;
    }

    const verification = result.verification;
    if (
      verification === undefined
      || verification.status !== 'verified'
      || !Number.isSafeInteger(verification.checksPassed)
      || !Number.isSafeInteger(verification.totalChecks)
      || verification.checksPassed < 0
      || verification.totalChecks < verification.checksPassed
    ) {
      response.status(500).json({
        ok: false,
        integration: 'project_workflow',
        stage: 'verification',
        error: 'verification_unavailable',
      });
      return;
    }

    if (result.status === 'verified') {
      response.status(200).json({ ...receipt, verification: {
        status: 'verified',
        checksPassed: verification.checksPassed,
        totalChecks: verification.totalChecks,
      } });
      return;
    }

    if (typeof result.commit !== 'string' || !/^[0-9a-fA-F]{40,64}$/.test(result.commit)) {
      response.status(500).json({
        ok: false,
        integration: 'project_workflow',
        stage: 'commit',
        error: 'git_revision_failed',
      });
      return;
    }

    response.status(200).json({
      ...receipt,
      verification: {
        status: 'verified',
        checksPassed: verification.checksPassed,
        totalChecks: verification.totalChecks,
      },
      commit: result.commit,
    });
  }).all(methodNotAllowed(['POST']));

  return router;
}
