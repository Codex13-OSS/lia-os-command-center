import type { ProjectCodexExecutionError } from './projectCodexExecution.js';
import type { ProjectOrchestrationExecutionError } from './projectOrchestrationExecution.js';

export type ProjectTaskExecutionError =
  | ProjectOrchestrationExecutionError
  | ProjectCodexExecutionError
  | 'human_approval_required';

/** Safe boundary result. Internal plans, prompts, handoffs and process output are excluded. */
export type ProjectTaskExecutionResult =
  | {
      ok: true;
      status: 'completed';
      executionId: string;
      summary: string;
    }
  | {
      ok: false;
      status: 'failed';
      error: ProjectTaskExecutionError;
      executionId?: string;
      summary?: string;
    };
