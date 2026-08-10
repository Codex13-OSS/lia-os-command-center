import { createHash } from 'node:crypto';
import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import type { ProjectGoalEvaluationRecord } from '../contracts/projectGoalEvaluation.js';
import type {
  ProjectGoalContinuationPlanReasonCode,
  ProjectGoalContinuationPlanRecord,
} from '../contracts/projectGoalContinuationPlan.js';
import {
  CONTINUATION_PLANNER_VERSION,
  PROJECT_GOAL_CONTINUATION_PLAN_ERRORS,
  PROJECT_GOAL_CONTINUATION_PLAN_MAX_INSTRUCTION_LENGTH,
  RETRYABLE_EVALUATION_TO_PLAN_REASON,
} from '../contracts/projectGoalContinuationPlan.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';

const NEXT_FOCUS: Record<ProjectGoalContinuationPlanReasonCode, string> = {
  continue_partial_result: 'Complete only the remaining unsatisfied parts and preserve work already established.',
  retry_verification_failure: 'Correct the bounded cause of technical verification failure, then verify the affected result.',
  retry_visual_failure: 'Correct only the unmet visual acceptance evidence, then repeat the bounded visual verification.',
  retry_execution_failure: 'Address the bounded execution failure and resume from the last safely established result.',
  retry_insufficient_evidence: 'Produce the missing bounded evidence needed to establish whether the Goal is satisfied.',
};

// Plans are intent, not commands. Reject dangerous authority/action language even
// when it entered through an older Goal or task record. False positives fail safe.
const FORBIDDEN_INSTRUCTION = /(?:\b(?:deploy|deployment|push|merge|production|prod|secret|credential|database\s+write|shell|sudo|chmod|chown|curl|wget|ssh|commit)\b|(?:requested|approved|effective)capabilities|repository_read|isolated_worktree_write|run_tests|local_commit|(?:^|\s)(?:\/opt|\/etc|\/var|\/home|\/tmp)\/)/i;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function normalizeBoundedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function isSafeContinuationInstruction(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= PROJECT_GOAL_CONTINUATION_PLAN_MAX_INSTRUCTION_LENGTH
    && !CONTROL_CHARACTER.test(value)
    && !FORBIDDEN_INSTRUCTION.test(value);
}

export function mapEvaluationReasonToPlanReason(
  reasonCode: ProjectGoalEvaluationRecord['reasonCode'],
): ProjectGoalContinuationPlanReasonCode | undefined {
  return RETRYABLE_EVALUATION_TO_PLAN_REASON[reasonCode];
}

export function buildDeterministicContinuationInstruction(
  goal: ProjectGoalRecord,
  evaluation: ProjectGoalEvaluationRecord,
  parent: ProjectTaskRecord,
): { instruction: string; reasonCode: ProjectGoalContinuationPlanReasonCode } {
  const reasonCode = mapEvaluationReasonToPlanReason(evaluation.reasonCode);
  if (evaluation.decision !== 'retryable' || reasonCode === undefined) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.evaluationNotRetryable);
  }

  const objective = normalizeBoundedText(goal.objective);
  const parentInstruction = normalizeBoundedText(parent.intent.instruction);
  const instruction = [
    `Continue the original Goal within its existing scope and safety constraints. Objective: ${objective}`,
    `Next focus: ${NEXT_FOCUS[reasonCode]}`,
    `Use the prior attempt only as context; do not repeat satisfied work unless required for verification. Prior bounded intent: ${parentInstruction}`,
    'Do not broaden scope or authority.',
  ].join(' ');

  if (!isSafeContinuationInstruction(instruction)) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.invalidInput);
  }
  return { instruction, reasonCode };
}

function canonicalPlanMeaning(
  plan: Omit<ProjectGoalContinuationPlanRecord, 'planId' | 'status' | 'fingerprint' | 'createdAt' | 'cancelledAt' | 'createdTaskId' | 'consumedAt'>,
): string {
  return JSON.stringify({
    goalId: plan.goalId,
    instruction: plan.instruction,
    nextAttemptNumber: plan.nextAttemptNumber,
    nextContinuationDepth: plan.nextContinuationDepth,
    parentAttemptNumber: plan.parentAttemptNumber,
    parentTaskId: plan.parentTaskId,
    plannerVersion: plan.plannerVersion,
    reasonCode: plan.reasonCode,
    sourceEvaluationId: plan.sourceEvaluationId,
    sourceEvidenceFingerprint: plan.sourceEvidenceFingerprint,
  });
}

export function fingerprintContinuationPlanMeaning(
  plan: Omit<ProjectGoalContinuationPlanRecord, 'planId' | 'status' | 'fingerprint' | 'createdAt' | 'cancelledAt' | 'createdTaskId' | 'consumedAt'>,
): string {
  if (plan.plannerVersion !== CONTINUATION_PLANNER_VERSION || !isSafeContinuationInstruction(plan.instruction)) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.invalidInput);
  }
  return createHash('sha256').update(canonicalPlanMeaning(plan)).digest('hex');
}
