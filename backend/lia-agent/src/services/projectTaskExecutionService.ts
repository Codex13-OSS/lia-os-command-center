import type { LiaAgentConfig } from '../config.js';
import type { ProjectCodexHandoff } from '../contracts/projectCodexHandoff.js';
import type { ProjectCodexExecutionResult } from '../contracts/projectCodexExecution.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { ProjectTaskExecutionResult } from '../contracts/projectTaskExecution.js';
import type { HermesExecutionResult, HermesQueryExecutor } from './hermesExecutor.js';
import { executeHermesSupervisor } from './hermesSupervisorExecutor.js';
import { executeProjectCodexHandoff } from './projectCodexExecutor.js';
import { buildProjectCodexHandoff } from './projectCodexHandoff.js';
import { planProjectTask } from './projectExecutionPlanner.js';
import { buildProjectOrchestrationPrompt } from './projectOrchestrationPrompt.js';
import { validateProjectOrchestrationProposal } from './projectOrchestrationValidation.js';

export type ProjectCodexHandoffExecutor = (
  handoff: ProjectCodexHandoff,
) => Promise<ProjectCodexExecutionResult>;

export interface ProjectTaskExecutionDependencies {
  executeHermes?: HermesQueryExecutor;
  executeCodex?: ProjectCodexHandoffExecutor;
}

export async function executeProjectTask(
  config: LiaAgentConfig,
  request: ProjectTaskRequest,
  projectRegistrySource: ProjectRegistrySource,
  dependencies: ProjectTaskExecutionDependencies = {},
): Promise<ProjectTaskExecutionResult> {
  const planning = await planProjectTask(request, projectRegistrySource);
  if (!planning.ok) {
    return { ok: false, status: 'failed', error: planning.error };
  }

  let prompt: string;
  try {
    prompt = buildProjectOrchestrationPrompt(planning.plan);
  } catch (error) {
    if (error instanceof Error && error.message === 'project_orchestration_prompt_too_large') {
      return { ok: false, status: 'failed', error: 'prompt_too_large' };
    }
    return { ok: false, status: 'failed', error: 'execution_failed' };
  }

  let hermesResult: HermesExecutionResult;
  try {
    hermesResult = await (dependencies.executeHermes ?? executeHermesSupervisor)(config, prompt);
  } catch {
    return { ok: false, status: 'failed', error: 'execution_failed' };
  }
  if (!hermesResult.ok) {
    return { ok: false, status: 'failed', error: hermesResult.error };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(hermesResult.response);
  } catch {
    return { ok: false, status: 'failed', error: 'invalid_hermes_json' };
  }

  const validation = validateProjectOrchestrationProposal(parsed, planning.plan);
  if (!validation.success) {
    return { ok: false, status: 'failed', error: 'invalid_hermes_proposal' };
  }
  if (
    validation.proposal.requiresHumanApproval
    || validation.proposal.blockedActions.length > 0
  ) {
    return { ok: false, status: 'failed', error: 'human_approval_required' };
  }

  const handoffResult = buildProjectCodexHandoff(planning.plan, validation.proposal);
  if (!handoffResult.success) {
    return { ok: false, status: 'failed', error: 'invalid_hermes_proposal' };
  }

  let codexResult: ProjectCodexExecutionResult;
  try {
    codexResult = await (dependencies.executeCodex ?? executeProjectCodexHandoff)(
      handoffResult.handoff,
    );
  } catch {
    return {
      ok: false,
      status: 'failed',
      error: 'codex_execution_failed',
      executionId: 'unavailable',
      summary: 'Codex execution did not complete.',
    };
  }

  if (!codexResult.success) {
    return {
      ok: false,
      status: codexResult.status,
      error: codexResult.error,
      executionId: codexResult.executionId,
      summary: codexResult.summary,
    };
  }
  return {
    ok: true,
    status: codexResult.status,
    executionId: codexResult.executionId,
    summary: codexResult.summary,
  };
}
