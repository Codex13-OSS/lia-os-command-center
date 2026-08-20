import type { LiaExecutiveBoardRole } from './liaExecutiveBoardClient';

export type LiaDecisionLearningCase = {
  decisionId: string; goalId: string; recommendation: string;
  boardOutcome: 'pending' | 'approved' | 'rejected' | 'executed' | 'superseded';
  boardConfidence: number; rolesConsulted: LiaExecutiveBoardRole[]; requiresHumanApproval: boolean;
  goalStatus?: string; goalTerminalReason?: string; attemptCount: number;
  latestEvaluationDecision?: string; latestEvaluationReason?: string;
  observedResult: 'successful' | 'unsuccessful' | 'inconclusive' | 'not_executed' | 'still_running';
  learningStatus: 'evaluable' | 'insufficient_evidence' | 'pending';
};
export type LiaDecisionLearning = {
  integration: 'lia_decision_learning_v1'; readOnly: true; causalInference: false; minimumCalibrationSample: number;
  metrics: { totalDecisions: number; linkedToGoals: number; executedDecisions: number; evaluableDecisions: number; successfulObserved: number; unsuccessfulObserved: number; inconclusive: number; pending: number; observedSuccessRate?: number };
  calibrationObservation: Array<{ bucket: 'low' | 'medium' | 'high'; evaluable: number; observedSuccesses: number; observedOutcomeRate?: number; sufficientSample: boolean }>;
  roleParticipationObservations: Array<{ role: LiaExecutiveBoardRole; decisionsConsulted: number; executedAndEvaluable: number; observedSuccessful: number; observedUnsuccessful: number }>;
  signals: Array<{ type: string; decisionId: string; explanation: string; sourceFields: string[]; evidenceReferences: string[] }>;
  cases: LiaDecisionLearningCase[];
};

export async function readLiaDecisionLearning(projectId: string, limit = 20): Promise<LiaDecisionLearning | null> {
  try {
    const response = await fetch(`/api/lia-agent/projects/${encodeURIComponent(projectId)}/board-learning?limit=${limit}`, {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json() as { ok?: boolean } & Partial<LiaDecisionLearning>;
    if (body.ok !== true || body.integration !== 'lia_decision_learning_v1' || body.readOnly !== true
      || body.causalInference !== false || !body.metrics || !Array.isArray(body.cases)
      || !Array.isArray(body.calibrationObservation) || !Array.isArray(body.roleParticipationObservations)
      || !Array.isArray(body.signals)) return null;
    return body as LiaDecisionLearning;
  } catch { return null; }
}
