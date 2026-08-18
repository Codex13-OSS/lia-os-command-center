import type { ProjectGoalRecord, ProjectGoalStatus, ProjectGoalTerminalReason } from '../contracts/projectGoal.js';
import type { ProjectTaskRecord, SafeTaskStage } from '../contracts/projectTask.js';
import type {
  EvaluateProjectGoalAttemptInput,
  ProjectGoalEvaluationDecision,
  ProjectGoalEvaluationEvidence,
  ProjectGoalEvaluationReasonCode,
  ProjectGoalEvaluationRecord,
} from '../contracts/projectGoalEvaluation.js';
import { PROJECT_GOAL_EVALUATOR_VERSION } from '../contracts/projectGoalEvaluation.js';
import { isProjectGoalEvaluationEvidence } from './projectCompletionEvaluator.js';
import {
  conservativeSemanticClassifier,
  createMechanicalGoalAssessor,
  sanitizeResultExcerpt,
  type ProjectGoalSemanticAssessor,
  type ProjectGoalSemanticAssessmentInput,
} from './projectGoalSatisfactionAssessor.js';

/**
 * Q3 — Goal-Level Completion Evaluation orchestrator (the live wiring).
 *
 * This is the ONLY production code path that advances a Goal from the durable
 * terminal task evidence. It binds the authoritative Goal + Task, produces the
 * bounded semantic assessment (Layer B), and calls the existing
 * `evaluateAndApplyGoalAttempt` deterministic gate + store (Layer A), which is
 * LÍA's sole final authority.
 *
 * It deliberately does NOT plan or materialize continuation. It ends at the
 * applied, durable goal evaluation — the contract boundary handed to the future
 * goal-continuation planning concern.
 */

export const PROJECT_GOAL_EVALUATION_ORCHESTRATOR_ERRORS = {
  goalNotFound: 'project_goal_evaluation_goal_not_found',
  noCurrentAttempt: 'project_goal_evaluation_no_current_attempt',
  taskNotFound: 'project_goal_evaluation_task_not_found',
  taskNotTerminal: 'project_goal_evaluation_task_not_terminal',
  taskGoalMismatch: 'project_goal_evaluation_task_goal_mismatch',
} as const;

/** The store surface the orchestrator requires. The SQLite store already implements it. */
export interface ProjectGoalEvaluationOrchestratorStore {
  readGoal(goalId: string): ProjectGoalRecord | undefined;
  listGoalAttempts(goalId: string): ProjectTaskRecord[];
  evaluateAndApplyGoalAttempt(input: EvaluateProjectGoalAttemptInput): {
    evaluation: ProjectGoalEvaluationRecord;
    goal: ProjectGoalRecord;
  };
}

export type ProjectGoalResultExcerptReader = (
  input: ProjectGoalSemanticAssessmentInput,
) => string | Promise<string> | undefined | Promise<undefined>;

export type ProjectGoalEvaluationOrchestratorDependencies = {
  /** Layer B assessor. Defaults to the mechanical conservative assessor. */
  assessor?: ProjectGoalSemanticAssessor;
  /**
   * MQ2: bounded, sanitized, READ-ONLY excerpt reader for the actual committed
   * result. Only supplied when existing `repository_read` authority permits it.
   * Its output is sanitized, bounded and NEVER persisted. Default: undefined
   * (the assessment is grounded in `receipt.resultText` alone).
   */
  readResultExcerpt?: ProjectGoalResultExcerptReader;
};

export type ProjectGoalEvaluationOutcome = {
  evaluation: ProjectGoalEvaluationRecord;
  goal: ProjectGoalRecord;
  evidence: ProjectGoalEvaluationEvidence;
  visibleSummary: ProjectGoalVisibleSummary;
};

export type ProjectGoalVisibleSummary = {
  decision: ProjectGoalEvaluationDecision;
  reasonCode: ProjectGoalEvaluationReasonCode;
  summary: string;
  evidenceFingerprint: string;
  createdAt: number;
  appliedAt?: number;
  goalId: string;
  taskId: string;
  attemptNumber: number;
  evaluatorVersion: typeof PROJECT_GOAL_EVALUATOR_VERSION;
  goalStatus: ProjectGoalStatus;
  goalTerminalReason?: ProjectGoalTerminalReason;
  resultText: string;
  verification?: { checksPassed: number; totalChecks: number };
  commit?: string;
  stages?: readonly SafeTaskStage[];
};

function resolveCurrentAttemptTask(
  goal: ProjectGoalRecord,
  attempts: ProjectTaskRecord[],
): ProjectTaskRecord {
  if (goal.currentAttempt === null) {
    throw new Error(PROJECT_GOAL_EVALUATION_ORCHESTRATOR_ERRORS.noCurrentAttempt);
  }
  const task = attempts.find(
    (attempt) => attempt.lineage?.goalId === goal.goalId
      && attempt.lineage.attemptNumber === goal.currentAttempt,
  );
  if (task === undefined) {
    throw new Error(PROJECT_GOAL_EVALUATION_ORCHESTRATOR_ERRORS.taskNotFound);
  }
  if (task.lineage?.goalId !== goal.goalId) {
    throw new Error(PROJECT_GOAL_EVALUATION_ORCHESTRATOR_ERRORS.taskGoalMismatch);
  }
  if (task.status !== 'completed' && task.status !== 'failed') {
    throw new Error(PROJECT_GOAL_EVALUATION_ORCHESTRATOR_ERRORS.taskNotTerminal);
  }
  return task;
}

/** Bounded, deterministic, non-secret operator explanation (design §12). */
export function buildProjectGoalVisibleSummary(
  evaluation: ProjectGoalEvaluationRecord,
  goal: ProjectGoalRecord,
  task: ProjectTaskRecord,
): ProjectGoalVisibleSummary {
  const receipt = task.receipt;
  return {
    decision: evaluation.decision,
    reasonCode: evaluation.reasonCode,
    summary: evaluation.summary,
    evidenceFingerprint: evaluation.evidenceFingerprint,
    createdAt: evaluation.createdAt,
    ...(evaluation.appliedAt !== undefined ? { appliedAt: evaluation.appliedAt } : {}),
    goalId: evaluation.goalId,
    taskId: evaluation.taskId,
    attemptNumber: evaluation.attemptNumber,
    evaluatorVersion: evaluation.evaluatorVersion,
    goalStatus: goal.status,
    ...(goal.terminalReason !== undefined ? { goalTerminalReason: goal.terminalReason } : {}),
    resultText: typeof receipt?.resultText === 'string' ? receipt.resultText : '',
    ...(receipt?.verification !== undefined ? { verification: receipt.verification } : {}),
    ...(receipt?.commit !== undefined ? { commit: receipt.commit } : {}),
    ...(receipt?.stages !== undefined ? { stages: [...receipt.stages] } : {}),
  };
}

const INDETERMINATE_EVIDENCE: ProjectGoalEvaluationEvidence = {
  goalSatisfaction: 'not_demonstrated',
  blocking: 'none',
  failure: 'retryable',
};

/**
 * Evaluates and applies the Goal completion judgment for the goal's current
 * attempt.
 *
 * Flow (all reads are of immutable durable state; the store calls are
 * transactional and idempotent):
 *   1. read the immutable Goal;
 *   2. resolve its current-attempt terminal Task (authoritative binding);
 *   3. read the optional bounded sanitized result excerpt (MQ2);
 *   4. run the Layer B assessor -> bounded evidence (advisory only);
 *   5. validate the evidence; invalid/absent output is treated as indeterminate;
 *   6. `evaluateAndApplyGoalAttempt` — LÍA's deterministic downgrade gate +
 *      durable apply. This is the sole final authority.
 *
 * Replay with the same immutable inputs converges to the same evaluation
 * identity (idempotent); replay with contradictory evidence fails closed via
 * the store's `project_goal_evaluation_evidence_conflict` guard.
 */
export async function evaluateAndApplyGoalCompletion(
  store: ProjectGoalEvaluationOrchestratorStore,
  goalId: string,
  dependencies: ProjectGoalEvaluationOrchestratorDependencies = {},
): Promise<ProjectGoalEvaluationOutcome> {
  const goal = store.readGoal(goalId);
  if (goal === undefined) {
    throw new Error(PROJECT_GOAL_EVALUATION_ORCHESTRATOR_ERRORS.goalNotFound);
  }

  const attempts = store.listGoalAttempts(goalId);
  const task = resolveCurrentAttemptTask(goal, attempts);

  const assessor = dependencies.assessor ?? createMechanicalGoalAssessor();

  let resultExcerpt: string | undefined;
  if (dependencies.readResultExcerpt !== undefined) {
    const raw = await dependencies.readResultExcerpt({ goal, task });
    if (typeof raw === 'string' && raw.trim() !== '') {
      resultExcerpt = sanitizeResultExcerpt(raw);
    }
  }

  let evidence: ProjectGoalEvaluationEvidence;
  try {
    evidence = await assessor({ goal, task, resultExcerpt });
  } catch {
    evidence = INDETERMINATE_EVIDENCE;
  }
  if (!isProjectGoalEvaluationEvidence(evidence)) {
    evidence = INDETERMINATE_EVIDENCE;
  }

  const result = store.evaluateAndApplyGoalAttempt({
    goalId: goal.goalId,
    taskId: task.taskId,
    attemptNumber: task.lineage!.attemptNumber,
    evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
    evidence,
  });

  return {
    evaluation: result.evaluation,
    goal: result.goal,
    evidence,
    visibleSummary: buildProjectGoalVisibleSummary(result.evaluation, result.goal, task),
  };
}

/**
 * Exposed so a caller can build the exact evidence an assessor must produce.
 * Re-exported for test/harness convenience; it is the same conservative
 * classifier the default assessor uses.
 */
export { conservativeSemanticClassifier };
