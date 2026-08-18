import type { ProjectGoalRecord } from './projectGoal.js';
import type { ProjectTaskRecord } from './projectTask.js';

export const COMPLETION_EVALUATOR_VERSION = 'completion-evaluator-v1';
export const PROJECT_GOAL_EVALUATOR_VERSION = COMPLETION_EVALUATOR_VERSION;

export const PROJECT_GOAL_EVALUATION_DECISIONS = [
  'completed',
  'retryable',
  'blocked',
  'failed',
] as const;
export type ProjectGoalEvaluationDecision = (typeof PROJECT_GOAL_EVALUATION_DECISIONS)[number];

export const PROJECT_GOAL_EVALUATION_REASON_CODES = [
  'goal_satisfied',
  'partial_result',
  'verification_failed',
  'visual_verification_failed',
  'execution_failed',
  'human_approval_required',
  'forbidden_capability_required',
  'external_dependency',
  'attempt_budget_exhausted',
  'continuation_depth_exhausted',
  'insufficient_evidence',
] as const;
export type ProjectGoalEvaluationReasonCode = (typeof PROJECT_GOAL_EVALUATION_REASON_CODES)[number];

/**
 * Bounded semantic boundary for V1. A caller may classify satisfaction and
 * recoverability, but cannot provide prose, commands, paths, capabilities or
 * executable authority. Deterministic durable evidence can only downgrade it.
 */
export type ProjectGoalEvaluationEvidence = {
  goalSatisfaction: 'satisfied' | 'partial' | 'not_demonstrated';
  blocking: 'none' | 'human_approval_required' | 'forbidden_capability_required' | 'external_dependency';
  failure: 'retryable' | 'unrecoverable';
};

export type EvaluateProjectGoalAttemptInput = {
  goalId: string;
  taskId: string;
  attemptNumber: number;
  evaluatorVersion: typeof COMPLETION_EVALUATOR_VERSION;
  evidence: ProjectGoalEvaluationEvidence;
};

export type ProjectGoalEvaluationRecord = {
  evaluationId: string;
  goalId: string;
  taskId: string;
  attemptNumber: number;
  evaluatorVersion: typeof COMPLETION_EVALUATOR_VERSION;
  evidenceFingerprint: string;
  decision: ProjectGoalEvaluationDecision;
  reasonCode: ProjectGoalEvaluationReasonCode;
  summary: string;
  createdAt: number;
  appliedAt?: number;
};

export interface ProjectGoalEvaluationStore {
  evaluateGoalAttempt(input: EvaluateProjectGoalAttemptInput): ProjectGoalEvaluationRecord;
  readGoalEvaluation(evaluationId: string): ProjectGoalEvaluationRecord | undefined;
  readLatestGoalEvaluation(goalId: string): ProjectGoalEvaluationRecord | undefined;
  listGoalEvaluations(goalId: string): ProjectGoalEvaluationRecord[];
  applyGoalEvaluation(evaluationId: string): ProjectGoalRecord;
  evaluateAndApplyGoalAttempt(input: EvaluateProjectGoalAttemptInput): {
    evaluation: ProjectGoalEvaluationRecord;
    goal: ProjectGoalRecord;
  };
}

export const PROJECT_GOAL_EVALUATION_ERRORS = {
  invalidInput: 'invalid_project_goal_evaluation',
  goalNotFound: 'project_goal_evaluation_goal_not_found',
  evaluationNotFound: 'project_goal_evaluation_not_found',
  taskNotFound: 'project_goal_evaluation_task_not_found',
  taskNotTerminal: 'project_goal_evaluation_task_not_terminal',
  taskGoalMismatch: 'project_goal_evaluation_task_goal_mismatch',
  taskProjectMismatch: 'project_goal_evaluation_task_project_mismatch',
  attemptMismatch: 'project_goal_evaluation_attempt_mismatch',
  staleAttempt: 'project_goal_evaluation_stale_attempt',
  terminalGoal: 'project_goal_evaluation_goal_terminal',
  evidenceConflict: 'project_goal_evaluation_evidence_conflict',
  incompatibleState: 'project_goal_evaluation_incompatible_state',
} as const;

export type ProjectGoalEvaluationContext = {
  goal: ProjectGoalRecord;
  task: ProjectTaskRecord;
};
