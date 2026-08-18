import type { ProjectOrchestrationProposal } from './projectOrchestration.js';

export type ProjectOrchestrationExecutionError =
  | 'invalid_task'
  | 'project_not_found'
  | 'project_disabled'
  | 'registry_unavailable'
  | 'prompt_too_large'
  | 'execution_disabled'
  | 'timeout'
  | 'execution_failed'
  | 'empty_response'
  | 'invalid_hermes_json'
  | 'invalid_hermes_proposal';

export type ProjectOrchestrationExecutionResult =
  | {
    ok: true;
    proposal: ProjectOrchestrationProposal;
  }
  | {
    ok: false;
    error: ProjectOrchestrationExecutionError;
  };
