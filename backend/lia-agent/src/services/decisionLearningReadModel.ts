import type { ExecutiveBoardDecisionStore } from '../contracts/executiveBoard.js';
import { EXECUTIVE_BOARD_ROLES } from '../contracts/executiveBoard.js';
import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import type { ProjectGoalEvaluationRecord } from '../contracts/projectGoalEvaluation.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';
import {
  DECISION_LEARNING_INTEGRATION,
  DECISION_LEARNING_MIN_CALIBRATION_SAMPLE,
  type DecisionConfidenceBucket,
  type DecisionLearningCase,
  type DecisionLearningReadModel,
  type DecisionLearningSignal,
} from '../contracts/decisionLearning.js';

export type DecisionLearningGoalSource = {
  readGoal(goalId: string): ProjectGoalRecord | undefined;
  listGoalAttempts(goalId: string): ProjectTaskRecord[];
  listGoalEvaluations(goalId: string): ProjectGoalEvaluationRecord[];
};

export type DecisionLearningSources = {
  board?: ExecutiveBoardDecisionStore;
  goals?: DecisionLearningGoalSource;
};

const bucketOf = (confidence: number): DecisionConfidenceBucket => confidence < 0.4 ? 'low' : confidence < 0.7 ? 'medium' : 'high';
const latestApplied = (evaluations: ProjectGoalEvaluationRecord[]): ProjectGoalEvaluationRecord | undefined =>
  evaluations.filter((item) => item.appliedAt !== undefined).sort((a, b) => (a.appliedAt! - b.appliedAt!) || (a.createdAt - b.createdAt))[evaluations.filter((item) => item.appliedAt !== undefined).length - 1];

function evidenceReferences(decisionEvidence: Array<{ reference: string }>, evaluation?: ProjectGoalEvaluationRecord): string[] {
  return [
    ...decisionEvidence.map((item) => item.reference).filter((item) => item.length <= 2_000),
    ...(evaluation ? [`goal-evaluation:${evaluation.evaluationId}`, `evidence-fingerprint:${evaluation.evidenceFingerprint}`] : []),
  ].slice(0, 20);
}

function deriveCase(decision: ReturnType<ExecutiveBoardDecisionStore['listDecisions']>[number], goals?: DecisionLearningGoalSource): {
  item: DecisionLearningCase;
  evaluation?: ProjectGoalEvaluationRecord;
} {
  const goalId = decision.goalId!;
  let goal: ProjectGoalRecord | undefined;
  let attempts: ProjectTaskRecord[] = [];
  let evaluation: ProjectGoalEvaluationRecord | undefined;
  if (goals) {
    try {
      goal = goals.readGoal(goalId);
      if (goal?.projectId === decision.projectId) {
        attempts = goals.listGoalAttempts(goalId);
        evaluation = latestApplied(goals.listGoalEvaluations(goalId));
      } else {
        goal = undefined;
      }
    } catch {
      goal = undefined;
      attempts = [];
      evaluation = undefined;
    }
  }

  const base = {
    decisionId: decision.decisionId,
    goalId,
    recommendation: decision.recommendation.slice(0, 2_000),
    boardOutcome: decision.outcome.status,
    boardConfidence: decision.confidence,
    rolesConsulted: [...decision.rolesConsulted],
    requiresHumanApproval: decision.requiresHumanApproval,
    ...(goal ? { goalStatus: goal.status } : {}),
    ...(goal?.terminalReason ? { goalTerminalReason: goal.terminalReason } : {}),
    attemptCount: attempts.length,
    ...(evaluation ? { latestEvaluationDecision: evaluation.decision, latestEvaluationReason: evaluation.reasonCode } : {}),
  };

  if (decision.outcome.status === 'pending') return { item: { ...base, observedResult: 'inconclusive', learningStatus: 'pending' }, evaluation };
  if (decision.outcome.status === 'rejected' || decision.outcome.status === 'superseded') {
    return { item: { ...base, observedResult: 'not_executed', learningStatus: 'insufficient_evidence' }, evaluation };
  }
  if (!goal) return { item: { ...base, observedResult: 'inconclusive', learningStatus: 'insufficient_evidence' }, evaluation };
  if (goal.status === 'active') return { item: { ...base, observedResult: 'still_running', learningStatus: 'pending' }, evaluation };
  if (decision.outcome.status !== 'executed') {
    return { item: { ...base, observedResult: 'inconclusive', learningStatus: 'insufficient_evidence' }, evaluation };
  }
  const successful = goal.status === 'completed'
    && goal.terminalReason === 'objective_completed'
    && evaluation?.decision === 'completed'
    && evaluation.reasonCode === 'goal_satisfied';
  if (successful) return { item: { ...base, observedResult: 'successful', learningStatus: 'evaluable' }, evaluation };
  const negativeTerminal = ['blocked', 'exhausted', 'failed'].includes(goal.status)
    && goal.terminalReason !== undefined
    && evaluation !== undefined
    && evaluation.decision !== 'completed'
    && evaluation.reasonCode !== 'goal_satisfied'
    && evaluation.reasonCode !== 'insufficient_evidence';
  if (negativeTerminal) return { item: { ...base, observedResult: 'unsuccessful', learningStatus: 'evaluable' }, evaluation };
  return { item: { ...base, observedResult: 'inconclusive', learningStatus: 'insufficient_evidence' }, evaluation };
}

export function buildDecisionLearningReadModel(
  sources: DecisionLearningSources,
  input: { projectId: string; limit?: number },
): DecisionLearningReadModel {
  const decisions = sources.board?.listDecisions({ projectId: input.projectId, limit: input.limit ?? 20 }) ?? [];
  const linked = decisions.filter((decision) => decision.goalId !== undefined);
  const derived = linked.map((decision) => ({ decision, ...deriveCase(decision, sources.goals) }));
  const cases = derived.map(({ item }) => item);
  const evaluable = cases.filter((item) => item.learningStatus === 'evaluable');
  const successes = evaluable.filter((item) => item.observedResult === 'successful').length;
  const signals: DecisionLearningSignal[] = [];
  const missingDataDecisionCount = linked.filter((decision) => decision.missingData.length > 0).length;

  for (const { decision, item, evaluation } of derived) {
    const refs = evidenceReferences([...decision.evidence, ...decision.outcome.evidence], evaluation);
    const add = (type: DecisionLearningSignal['type'], explanation: string, sourceFields: string[]) =>
      signals.push({ type, decisionId: decision.decisionId, explanation, sourceFields, evidenceReferences: refs });
    if (item.observedResult === 'unsuccessful' && item.boardConfidence >= 0.7) add('high_confidence_unsuccessful', 'Una decisión de alta confianza tuvo un resultado observado no satisfactorio; no se atribuye causalidad.', ['confidence', 'outcome.status', 'goal.status', 'goal.terminalReason', 'evaluation.reasonCode']);
    if (item.observedResult === 'successful' && item.boardConfidence < 0.4) add('low_confidence_successful', 'Una decisión de baja confianza tuvo un resultado observado satisfactorio; no se atribuye causalidad.', ['confidence', 'outcome.status', 'goal.status', 'evaluation.reasonCode']);
    if (missingDataDecisionCount >= 2 && decision.missingData.length > 0) add('repeated_missing_data', `Se registraron datos faltantes en ${missingDataDecisionCount} decisiones de la muestra.`, ['missingData']);
    if (item.observedResult === 'not_executed') add('decision_not_executed', 'La recomendación fue rechazada o sustituida sin ejecución y no se usa para evaluar resultado.', ['outcome.status']);
    if (decision.disagreements.length > 0) add('disagreement_present', 'La decisión conserva desacuerdos explícitos del Board.', ['disagreements']);
    if (decision.requiresHumanApproval) add('human_approval_required', 'La decisión registró que requería aprobación humana.', ['requiresHumanApproval']);
  }
  if (evaluable.length > 0 && evaluable.length < DECISION_LEARNING_MIN_CALIBRATION_SAMPLE) {
    for (const item of evaluable) signals.push({
      type: 'insufficient_sample', decisionId: item.decisionId,
      explanation: `La muestra evaluable (${evaluable.length}) es menor al mínimo ${DECISION_LEARNING_MIN_CALIBRATION_SAMPLE}; no se muestra una tasa.`,
      sourceFields: ['learningStatus', 'observedResult'], evidenceReferences: [],
    });
  }

  const calibrationObservation = (['low', 'medium', 'high'] as const).map((bucket) => {
    const bucketCases = evaluable.filter((item) => bucketOf(item.boardConfidence) === bucket);
    const observedSuccesses = bucketCases.filter((item) => item.observedResult === 'successful').length;
    const sufficientSample = bucketCases.length >= DECISION_LEARNING_MIN_CALIBRATION_SAMPLE;
    return {
      bucket, evaluable: bucketCases.length, observedSuccesses, sufficientSample,
      ...(sufficientSample ? { observedOutcomeRate: observedSuccesses / bucketCases.length } : {}),
    };
  });

  const roleParticipationObservations = EXECUTIVE_BOARD_ROLES.map((role) => {
    const roleCases = cases.filter((item) => item.rolesConsulted.includes(role));
    const roleEvaluable = roleCases.filter((item) => item.boardOutcome === 'executed' && item.learningStatus === 'evaluable');
    return {
      role,
      decisionsConsulted: decisions.filter((decision) => decision.rolesConsulted.includes(role)).length,
      executedAndEvaluable: roleEvaluable.length,
      observedSuccessful: roleEvaluable.filter((item) => item.observedResult === 'successful').length,
      observedUnsuccessful: roleEvaluable.filter((item) => item.observedResult === 'unsuccessful').length,
    };
  });

  return {
    integration: DECISION_LEARNING_INTEGRATION,
    readOnly: true,
    causalInference: false,
    minimumCalibrationSample: DECISION_LEARNING_MIN_CALIBRATION_SAMPLE,
    metrics: {
      totalDecisions: decisions.length,
      linkedToGoals: linked.length,
      executedDecisions: linked.filter((decision) => decision.outcome.status === 'executed').length,
      evaluableDecisions: evaluable.length,
      successfulObserved: successes,
      unsuccessfulObserved: evaluable.length - successes,
      inconclusive: cases.filter((item) => item.observedResult === 'inconclusive' || item.observedResult === 'not_executed').length,
      pending: cases.filter((item) => item.learningStatus === 'pending').length,
      ...(evaluable.length >= DECISION_LEARNING_MIN_CALIBRATION_SAMPLE ? { observedSuccessRate: successes / evaluable.length } : {}),
    },
    calibrationObservation,
    roleParticipationObservations,
    signals,
    cases,
  };
}
