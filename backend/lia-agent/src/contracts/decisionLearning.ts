import type { ExecutiveBoardOutcome, ExecutiveBoardRole } from './executiveBoard.js';
import type { ProjectGoalEvaluationDecision, ProjectGoalEvaluationReasonCode } from './projectGoalEvaluation.js';
import type { ProjectGoalStatus, ProjectGoalTerminalReason } from './projectGoal.js';

export const DECISION_LEARNING_INTEGRATION = 'lia_decision_learning_v1';
export const DECISION_LEARNING_MIN_CALIBRATION_SAMPLE = 5;

export type DecisionObservedResult = 'successful' | 'unsuccessful' | 'inconclusive' | 'not_executed' | 'still_running';
export type DecisionLearningStatus = 'evaluable' | 'insufficient_evidence' | 'pending';
export type DecisionConfidenceBucket = 'low' | 'medium' | 'high';

export type DecisionLearningCase = {
  decisionId: string;
  goalId: string;
  recommendation: string;
  boardOutcome: ExecutiveBoardOutcome['status'];
  boardConfidence: number;
  rolesConsulted: ExecutiveBoardRole[];
  requiresHumanApproval: boolean;
  goalStatus?: ProjectGoalStatus;
  goalTerminalReason?: ProjectGoalTerminalReason;
  attemptCount: number;
  latestEvaluationDecision?: ProjectGoalEvaluationDecision;
  latestEvaluationReason?: ProjectGoalEvaluationReasonCode;
  observedResult: DecisionObservedResult;
  learningStatus: DecisionLearningStatus;
};

export type DecisionLearningSignalType =
  | 'high_confidence_unsuccessful'
  | 'low_confidence_successful'
  | 'repeated_missing_data'
  | 'decision_not_executed'
  | 'insufficient_sample'
  | 'disagreement_present'
  | 'human_approval_required';

export type DecisionLearningSignal = {
  type: DecisionLearningSignalType;
  decisionId: string;
  explanation: string;
  sourceFields: string[];
  evidenceReferences: string[];
};

export type DecisionCalibrationObservation = {
  bucket: DecisionConfidenceBucket;
  evaluable: number;
  observedSuccesses: number;
  observedOutcomeRate?: number;
  sufficientSample: boolean;
};

export type DecisionRoleParticipationObservation = {
  role: ExecutiveBoardRole;
  decisionsConsulted: number;
  executedAndEvaluable: number;
  observedSuccessful: number;
  observedUnsuccessful: number;
};

export type DecisionLearningReadModel = {
  integration: typeof DECISION_LEARNING_INTEGRATION;
  readOnly: true;
  causalInference: false;
  minimumCalibrationSample: number;
  metrics: {
    totalDecisions: number;
    linkedToGoals: number;
    executedDecisions: number;
    evaluableDecisions: number;
    successfulObserved: number;
    unsuccessfulObserved: number;
    inconclusive: number;
    pending: number;
    observedSuccessRate?: number;
  };
  calibrationObservation: DecisionCalibrationObservation[];
  roleParticipationObservations: DecisionRoleParticipationObservation[];
  signals: DecisionLearningSignal[];
  cases: DecisionLearningCase[];
};
