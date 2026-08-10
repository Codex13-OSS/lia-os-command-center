import { createHash } from 'node:crypto';
import type {
  ProjectGoalEvaluationContext,
  ProjectGoalEvaluationDecision,
  ProjectGoalEvaluationEvidence,
  ProjectGoalEvaluationReasonCode,
} from '../contracts/projectGoalEvaluation.js';
import { projectRequiresVisualVerification } from './projectVisualVerification.js';

export type ProjectGoalEvaluationResult = {
  decision: ProjectGoalEvaluationDecision;
  reasonCode: ProjectGoalEvaluationReasonCode;
  summary: string;
  evidenceFingerprint: string;
};

const SUMMARIES: Record<ProjectGoalEvaluationReasonCode, string> = {
  goal_satisfied: 'Durable goal satisfaction is supported by bounded semantic, technical, and visual evidence.',
  partial_result: 'The attempt produced only a partial or unsatisfied result.',
  verification_failed: 'Technical verification did not establish a safe completed result.',
  visual_verification_failed: 'Visual verification did not establish a safe completed result.',
  execution_failed: 'The attempt failed without establishing durable goal satisfaction.',
  human_approval_required: 'Safe continuation requires explicit human approval.',
  forbidden_capability_required: 'Safe continuation requires a capability forbidden by policy.',
  external_dependency: 'Safe continuation depends on an external prerequisite.',
  attempt_budget_exhausted: 'No further attempt remains within the durable goal budget.',
  continuation_depth_exhausted: 'No further continuation remains within the durable depth limit.',
  insufficient_evidence: 'Available structured evidence is insufficient to establish goal satisfaction.',
};

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function isProjectGoalEvaluationEvidence(value: unknown): value is ProjectGoalEvaluationEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record);
  if (fields.length !== 3 || fields.some((field) => !['goalSatisfaction', 'blocking', 'failure'].includes(field))) return false;
  if (!['satisfied', 'partial', 'not_demonstrated'].includes(String(record.goalSatisfaction))) return false;
  if (![
    'none', 'human_approval_required', 'forbidden_capability_required', 'external_dependency',
  ].includes(String(record.blocking))) return false;
  if (!['retryable', 'unrecoverable'].includes(String(record.failure))) return false;
  return true;
}

/** Hashes only bounded safe evidence; resultText, commits, commands and paths are excluded. */
export function fingerprintProjectGoalEvidence(
  context: ProjectGoalEvaluationContext,
  evidence: ProjectGoalEvaluationEvidence,
): string {
  const { goal, task } = context;
  const safeSnapshot = {
    evidence,
    goal: {
      goalId: goal.goalId,
      projectId: goal.projectId,
      objectiveFingerprint: createHash('sha256').update(goal.objective).digest('hex'),
      currentAttempt: goal.currentAttempt,
      maxAttempts: goal.maxAttempts,
      continuationDepthLimit: goal.continuationDepthLimit,
    },
    task: {
      status: task.status,
      receipt: task.receipt === undefined ? undefined : {
        status: task.receipt.status,
        verification: task.receipt.verification,
        stages: task.receipt.stages,
        hasCommit: task.receipt.commit !== undefined,
      },
      error: task.error === undefined ? undefined : {
        code: task.error.code,
        stage: task.error.stage,
        completedStages: task.error.completedStages,
      },
      lineage: task.lineage,
    },
  };
  return createHash('sha256').update(canonicalize(safeSnapshot)).digest('hex');
}

function result(
  decision: ProjectGoalEvaluationDecision,
  reasonCode: ProjectGoalEvaluationReasonCode,
  evidenceFingerprint: string,
): ProjectGoalEvaluationResult {
  return { decision, reasonCode, summary: SUMMARIES[reasonCode], evidenceFingerprint };
}

const TECHNICAL_FAILURES = new Set([
  'check_failed', 'check_timeout', 'verification_unavailable',
]);
const VISUAL_FAILURES = new Set([
  'visual_check_failed', 'visual_check_timeout', 'visual_verification_unavailable',
]);

export function evaluateProjectGoalCompletion(
  context: ProjectGoalEvaluationContext,
  evidence: ProjectGoalEvaluationEvidence,
): ProjectGoalEvaluationResult {
  const fingerprint = fingerprintProjectGoalEvidence(context, evidence);
  const { goal, task } = context;

  const retryOrExhaust = (reasonCode: ProjectGoalEvaluationReasonCode): ProjectGoalEvaluationResult => {
    if (task.lineage === undefined) return result('failed', 'insufficient_evidence', fingerprint);
    if (task.lineage.attemptNumber + 1 >= goal.maxAttempts) {
      return result('failed', 'attempt_budget_exhausted', fingerprint);
    }
    if (task.lineage.continuationDepth >= goal.continuationDepthLimit) {
      return result('failed', 'continuation_depth_exhausted', fingerprint);
    }
    return result('retryable', reasonCode, fingerprint);
  };

  if (task.error?.code === 'human_approval_required') {
    return result('blocked', 'human_approval_required', fingerprint);
  }
  if (evidence.blocking !== 'none') {
    return result('blocked', evidence.blocking, fingerprint);
  }

  if (task.status === 'failed') {
    if (task.error !== undefined && VISUAL_FAILURES.has(task.error.code)) {
      return retryOrExhaust('visual_verification_failed');
    }
    if (task.error !== undefined && TECHNICAL_FAILURES.has(task.error.code)) {
      return retryOrExhaust('verification_failed');
    }
    if (evidence.failure === 'unrecoverable') {
      return result('failed', 'execution_failed', fingerprint);
    }
    return retryOrExhaust('execution_failed');
  }

  const receipt = task.receipt;
  const technicallyVerified = receipt?.verification?.status === 'verified'
    && receipt.verification.totalChecks > 0
    && receipt.verification.checksPassed === receipt.verification.totalChecks
    && receipt.stages?.includes('verification') === true;
  const visuallyVerified = !projectRequiresVisualVerification(goal.projectId)
    || receipt?.stages?.includes('visualQa') === true;

  if (evidence.goalSatisfaction === 'satisfied' && technicallyVerified && visuallyVerified) {
    return result('completed', 'goal_satisfied', fingerprint);
  }
  if (evidence.goalSatisfaction === 'partial') {
    return retryOrExhaust('partial_result');
  }
  if (receipt?.verification !== undefined && !technicallyVerified) {
    return retryOrExhaust('verification_failed');
  }
  if (technicallyVerified && !visuallyVerified) {
    return retryOrExhaust('visual_verification_failed');
  }
  return retryOrExhaust('insufficient_evidence');
}
