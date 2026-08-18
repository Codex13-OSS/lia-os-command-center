import type { LiaAgentConfig } from '../config.js';
import type { ProjectOrchestrationExecutionResult } from '../contracts/projectOrchestrationExecution.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { HermesQueryExecutor } from './hermesExecutor.js';
import { executeHermesSupervisor } from './hermesSupervisorExecutor.js';
import { planProjectTask } from './projectExecutionPlanner.js';
import { buildProjectOrchestrationPrompt } from './projectOrchestrationPrompt.js';
import { validateProjectOrchestrationProposal } from './projectOrchestrationValidation.js';

export async function orchestrateProjectTask(
  config: LiaAgentConfig,
  value: unknown,
  projectRegistrySource: ProjectRegistrySource,
  executeQuery?: HermesQueryExecutor,
): Promise<ProjectOrchestrationExecutionResult> {
  const planning = await planProjectTask(value, projectRegistrySource);
  if (!planning.ok) {
    return planning;
  }

  let prompt: string;
  try {
    prompt = buildProjectOrchestrationPrompt(planning.plan);
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'project_orchestration_prompt_too_large'
    ) {
      return { ok: false, error: 'prompt_too_large' };
    }
    throw error;
  }

  const result = await (executeQuery ?? executeHermesSupervisor)(config, prompt);
  if (!result.ok) {
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.response);
  } catch {
    return { ok: false, error: 'invalid_hermes_json' };
  }

  const validation = validateProjectOrchestrationProposal(parsed, planning.plan);
  if (!validation.success) {
    return { ok: false, error: 'invalid_hermes_proposal' };
  }

  return { ok: true, proposal: validation.proposal };
}
