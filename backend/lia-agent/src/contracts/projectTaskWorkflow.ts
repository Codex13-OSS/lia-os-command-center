import type { ProjectCodexCommitError } from './projectCodexCommit.js';
import type { ProjectCodexExecutionError } from './projectCodexExecution.js';
import type { ProjectResolutionResult } from './projectRegistry.js';
import type { ProjectOrchestrationExecutionError } from './projectOrchestrationExecution.js';
import type { SafeTaskStage } from './projectTask.js';

export type ProjectTaskWorkflowStage =
  | 'planning'
  | 'hermes'
  | 'approval'
  | 'codex'
  | 'verification'
  | 'commit';

type ProjectResolutionError = Extract<ProjectResolutionResult, { ok: false }>['error'];
type ProjectVerificationError =
  | 'check_failed'
  | 'check_timeout'
  | 'verification_unavailable'
  | 'invalid_generated_path';

export type ProjectTaskWorkflowError =
  | 'invalid_task'
  | ProjectResolutionError
  | ProjectOrchestrationExecutionError
  | ProjectCodexExecutionError
  | ProjectVerificationError
  | ProjectCodexCommitError
  | 'local_commit_requires_run_tests'
  | 'invalid_hermes_json'
  | 'invalid_hermes_proposal'
  | 'human_approval_required';

/** Safe workflow receipt. Internal plans, paths, prompts, process output and commands are excluded. */
export type ProjectTaskWorkflowResult =
  | {
      ok: true;
      projectId: string;
      executionId: string;
      status: 'analyzed' | 'ready_for_review' | 'verified' | 'committed';
      executionSummary: string;
      resultText: string;
      verification?: {
        status: 'verified';
        checksPassed: number;
        totalChecks: number;
      };
      commit?: string;
      /** Completed workflow phases in canonical order. Never includes internal data. */
      stages?: readonly SafeTaskStage[];
    }
  | {
      ok: false;
      projectId?: string;
      executionId?: string;
      status: 'failed';
      stage: ProjectTaskWorkflowStage;
      error: ProjectTaskWorkflowError;
      summary: string;
      /** Phases completed before the terminal failure. Never includes internal data. */
      completedStages?: readonly SafeTaskStage[];
    };
