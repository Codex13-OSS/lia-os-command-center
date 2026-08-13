import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import { PROJECT_GOAL_CONTROL_ERRORS } from '../contracts/projectOperatorGoalControl.js';
import type {
  OperatorGoalApprovalCard,
  OperatorGoalApprovalEffect,
  OperatorGoalAttemptSummary,
  OperatorGoalAutonomyView,
  OperatorGoalBudget,
  OperatorGoalContinuationView,
  OperatorGoalDetail,
  OperatorGoalEvaluationSummary,
  OperatorGoalEvidenceBundle,
  OperatorGoalHudState,
  OperatorGoalListItem,
} from '../contracts/projectOperatorGoalControl.js';
import { deriveExecutionAuthorizationState } from '../contracts/projectGoalContinuationExecutionAuthorization.js';
import {
  deriveLoopStageDetails,
  type BoundedAutonomousLoopStore,
  type DerivedLoopStageDetails,
  type LoopBudget,
} from './projectBoundedAutonomousLoopRuntime.js';
import { evaluateContinuationExecutionEligibility } from './projectContinuationExecutionEligibility.js';
import {
  countConsecutiveNoProgressCycles,
  resolveNoProgressThreshold,
} from './projectGoalContinuationPlanningOrchestrator.js';
import { buildProjectGoalVisibleSummary } from './projectGoalEvaluationOrchestrator.js';
import { buildContinuationGateEvidence } from './projectGoalContinuationExecutionGate.js';
import { buildContinuationExecutionEvidence } from './projectContinuationExecutionPolicy.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';

/**
 * Operator Goal Control Read Model — composes the EXISTING derived-stage
 * machine (`deriveLoopStageDetails`) and the EXISTING evidence builders into
 * the operator-safe list/detail/continuation/autonomy/evidence payloads
 * (design: operator-goal-control-surface-design.md §A/§B/§C/§I).
 *
 * Pure read. Every field is a direct read of an immutable durable row or a
 * deterministic derivation; the safe-field whitelist (§A.4) is enforced both
 * structurally (only whitelisted fields are ever composed) and by the
 * `assertSafeOperatorPayload` deep guard applied at the route layer.
 *
 * This module carries zero authority: it never approves, never authorizes,
 * never materializes, never launches, and never starts a second engine.
 */

/** Non-terminal, runner-owned task statuses that count as in-flight. */
const IN_FLIGHT_TASK_STATUSES = new Set<string>(['planning', 'hermes', 'codex', 'verification', 'commit']);

export const MAX_VISIBLE_OBJECTIVE_CHARS = 2_000;

export type OperatorGoalReadModelOptions = {
  now?: () => number;
  noProgressEscalationThreshold?: number;
};

/** Maps a derived stage + goal row to the HUD state vocabulary (design §I). */
export function mapLoopStageToHudState(details: DerivedLoopStageDetails): OperatorGoalHudState {
  const { stage } = details;
  if (stage === 'goal_satisfied') return 'completed';
  if (stage === 'executing') return 'executing';
  if (stage === 'suspended') return 'suspended';
  if (stage === 'exhausted') return 'failed';
  if (stage === 'failed_closed') {
    const status = details.goal?.status;
    if (status === 'failed' || status === 'blocked') return 'failed';
    return 'fail_closed';
  }
  // Every remaining active stage needs a supervisor pass or a human gate.
  return 'waiting_human';
}

/** Advisory `nextSafeAction` vocabulary (design §A.3). Never a promise. */
export function deriveNextSafeAction(details: DerivedLoopStageDetails): string {
  switch (details.stage) {
    case 'awaiting_execution':
      return 'root_attempt_pending';
    case 'task_terminal':
    case 'continuation_required':
    case 'materializing_next_attempt':
      return 'run_supervisor_pass';
    case 'next_attempt_accepted':
      return details.eligibility?.eligible === true
        ? 'run_supervisor_pass'
        : (details.eligibility?.reason ?? details.blockingReason ?? 'hold');
    case 'authorization_required':
      return 'approve_materialization';
    case 'suspended':
      return 'resume';
    case 'failed_closed':
      return 'manual_review_required';
    case 'goal_satisfied':
    case 'exhausted':
      return 'none_terminal';
    case 'executing':
      return 'none_running';
    default:
      return 'none';
  }
}

export function toOperatorBudget(budget: LoopBudget): OperatorGoalBudget {
  return {
    attemptsRemaining: budget.attemptsRemaining,
    depthRemaining: budget.depthRemaining,
    ...(budget.cyclesRemaining !== undefined ? { cyclesRemaining: budget.cyclesRemaining } : {}),
    ...(budget.elapsedBudgetMsRemaining !== undefined
      ? { elapsedBudgetMsRemaining: budget.elapsedBudgetMsRemaining }
      : {}),
  };
}

function toReceiptSummary(task: ProjectTaskRecord): OperatorGoalAttemptSummary['receiptSummary'] {
  const receipt = task.receipt;
  if (receipt === undefined) return undefined;
  return {
    ...(receipt.executionId !== undefined ? { executionId: receipt.executionId } : {}),
    ...(receipt.status !== undefined ? { status: receipt.status } : {}),
    ...(receipt.verification !== undefined
      ? { verification: { checksPassed: receipt.verification.checksPassed, totalChecks: receipt.verification.totalChecks } }
      : {}),
    ...(receipt.commit !== undefined ? { commit: receipt.commit } : {}),
    ...(receipt.stages !== undefined ? { stages: [...receipt.stages] } : {}),
  };
}

function toAttemptSummary(task: ProjectTaskRecord): OperatorGoalAttemptSummary {
  return {
    taskId: task.taskId,
    status: task.status,
    attemptNumber: task.lineage?.attemptNumber ?? 0,
    continuationDepth: task.lineage?.continuationDepth ?? 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.terminalAt !== undefined ? { terminalAt: task.terminalAt } : {}),
    ...(toReceiptSummary(task) !== undefined ? { receiptSummary: toReceiptSummary(task) } : {}),
    ...(task.error !== undefined && typeof task.error.code === 'string' ? { errorCode: task.error.code } : {}),
  };
}

function toEvaluationSummary(
  evaluation: OperatorGoalDetail['evaluationHistory'][number],
): OperatorGoalEvaluationSummary {
  return {
    evaluationId: evaluation.evaluationId,
    taskId: evaluation.taskId,
    attemptNumber: evaluation.attemptNumber,
    decision: evaluation.decision,
    reasonCode: evaluation.reasonCode,
    summary: evaluation.summary,
    evidenceFingerprint: evaluation.evidenceFingerprint,
    createdAt: evaluation.createdAt,
    ...(evaluation.appliedAt !== undefined ? { appliedAt: evaluation.appliedAt } : {}),
  };
}

function taskLaunchState(
  store: BoundedAutonomousLoopStore,
  task: ProjectTaskRecord | undefined,
): OperatorGoalDetail['launchState'] {
  if (task === undefined) return 'not_launched';
  if (task.status === 'completed' || task.status === 'failed') return 'terminal';
  const launchAttempt = store.readTaskExecutionLaunchAttemptByTask(task.taskId);
  const launchResult = store.readTaskExecutionLaunchResultByTask(task.taskId);
  if (launchResult !== undefined) return 'launch_result_recorded';
  if (launchAttempt !== undefined) return 'launch_attempted';
  return 'not_launched';
}

function resolveCurrentAttemptTask(
  goal: ProjectGoalRecord,
  attempts: readonly ProjectTaskRecord[],
): ProjectTaskRecord | undefined {
  if (goal.currentAttempt === null) return undefined;
  return attempts.find(
    (attempt) => attempt.lineage !== undefined && attempt.lineage.attemptNumber === goal.currentAttempt,
  );
}

function buildAutonomyView(
  details: DerivedLoopStageDetails,
): OperatorGoalAutonomyView {
  const goal = details.goal;
  const policy = details.policy;
  if (goal === undefined) throw new Error(PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
  return {
    goalId: goal.goalId,
    ...(policy !== undefined
      ? {
        policyId: policy.policyId,
        mode: policy.mode,
        approver: policy.approver,
        ...(policy.maxCycles !== undefined ? { maxCycles: policy.maxCycles } : {}),
        ...(policy.elapsedBudgetMs !== undefined ? { elapsedBudgetMs: policy.elapsedBudgetMs } : {}),
        ...(policy.suspendedAt !== undefined ? { suspendedAt: policy.suspendedAt } : {}),
        ...(policy.expiresAt !== undefined ? { expiresAt: policy.expiresAt } : {}),
        ...(policy.revokedAt !== undefined ? { revokedAt: policy.revokedAt } : {}),
        createdAt: policy.createdAt,
        updatedAt: policy.updatedAt,
        fingerprint: policy.fingerprint,
      }
      : { mode: details.mode }),
    policyState: details.policyState,
  };
}

function buildApprovalCard(details: DerivedLoopStageDetails): OperatorGoalApprovalCard | undefined {
  const plan = details.plan;
  if (plan === undefined || plan.status !== 'planned') return undefined;
  const approval = details.approval;
  return {
    planId: plan.planId,
    nextObjective: plan.instruction,
    nextAttemptNumber: plan.nextAttemptNumber,
    nextContinuationDepth: plan.nextContinuationDepth,
    reasonCode: plan.reasonCode,
    sourceEvaluationId: plan.sourceEvaluationId,
    sourceEvidenceFingerprint: plan.sourceEvidenceFingerprint,
    approvalState: details.approvalState ?? 'approval_required',
    ...(approval !== undefined
      ? {
        approvalId: approval.approvalId,
        approver: approval.approver,
        createdAt: approval.createdAt,
        ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
        ...(approval.revokedAt !== undefined ? { revokedAt: approval.revokedAt } : {}),
      }
      : {}),
  };
}

function buildApprovalEffect(mode: DerivedLoopStageDetails['mode'], planId: string | undefined): OperatorGoalApprovalEffect {
  return {
    approvalAuthorizes: planId === undefined
      ? 'Approval authorizes materialization of the proposed plan only (a new task created as `accepted`); it never authorizes execution.'
      : `Approval authorizes materialization of plan ${planId} only (a new task created as \`accepted\`); it never authorizes execution.`,
    launchRequirement: mode === 'approved_single_step'
      ? 'Launch additionally requires eligibility E1-E17 AND an unconsumed execution authorization for the exact materialized task.'
      : mode === 'bounded_autonomous'
        ? 'Launch additionally requires eligibility E1-E17 AND an active, unsuspended, unexpired, within-bounds policy.'
        : 'Launch additionally requires eligibility E1-E17; manual_only goals are never launched by the loop.',
  };
}

/**
 * Resolves the operator-visible approval state. `deriveLoopStageDetails` only
 * sets `approvalState` while a `planned` plan is in play; a consumed plan's
 * approval is durably `approval_consumed` (design §E vocabulary) and every
 * other stage with no live plan is `not_applicable`.
 */
function resolveApprovalState(details: DerivedLoopStageDetails): OperatorGoalDetail['approvalState'] {
  if (details.approvalState !== undefined) return details.approvalState;
  if (details.plan !== undefined && details.plan.status === 'consumed') return 'approval_consumed';
  return 'not_applicable';
}

/** One bounded, operator-safe list item (design §A). */
export function buildOperatorGoalListItem(
  store: BoundedAutonomousLoopStore,
  goal: ProjectGoalRecord,
  options: OperatorGoalReadModelOptions = {},
): OperatorGoalListItem {
  const details = deriveLoopStageDetails(store, goal.goalId, options);
  const currentTask = details.currentTask;
  return {
    goalId: goal.goalId,
    projectId: goal.projectId,
    title: goal.objective.slice(0, MAX_VISIBLE_OBJECTIVE_CHARS),
    status: goal.status,
    currentAttempt: goal.currentAttempt,
    maxAttempts: goal.maxAttempts,
    continuationDepth: currentTask?.lineage?.continuationDepth ?? 0,
    maxDepth: goal.continuationDepthLimit,
    autonomyMode: details.mode,
    suspensionState: details.policyState,
    humanInterventionRequired: details.humanInterventionRequired,
    loopStage: details.stage,
    hudState: mapLoopStageToHudState(details),
    ...(currentTask !== undefined
      ? {
        currentTask: {
          taskId: currentTask.taskId,
          status: currentTask.status,
          attemptNumber: currentTask.lineage?.attemptNumber ?? 0,
          continuationDepth: currentTask.lineage?.continuationDepth ?? 0,
        },
      }
      : {}),
    ...(details.evaluation !== undefined
      ? {
        latestEvidence: {
          decision: details.evaluation.decision,
          reasonCode: details.evaluation.reasonCode,
          summary: details.evaluation.summary,
          evidenceFingerprint: details.evaluation.evidenceFingerprint,
          ...(details.evaluation.appliedAt !== undefined ? { appliedAt: details.evaluation.appliedAt } : {}),
        },
      }
      : {}),
    noProgress: {
      count: details.noProgressCount,
      threshold: details.noProgressThreshold,
      escalated: details.escalated,
    },
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    budget: toOperatorBudget(details.budget),
    ambiguousOutcome: details.ambiguousOutcome,
    nextSafeAction: deriveNextSafeAction(details),
    ...(details.blockingReason !== undefined ? { blockingReason: details.blockingReason } : {}),
  };
}

/** Per-goal isolation wrapper (design §L): a corrupt goal never aborts the list. */
export function buildOperatorGoalListItemSafe(
  store: BoundedAutonomousLoopStore,
  goal: ProjectGoalRecord,
  options: OperatorGoalReadModelOptions = {},
): OperatorGoalListItem {
  try {
    return buildOperatorGoalListItem(store, goal, options);
  } catch {
    return {
      goalId: goal.goalId,
      projectId: goal.projectId,
      title: goal.objective.slice(0, MAX_VISIBLE_OBJECTIVE_CHARS),
      status: goal.status,
      currentAttempt: goal.currentAttempt,
      maxAttempts: goal.maxAttempts,
      continuationDepth: 0,
      maxDepth: goal.continuationDepthLimit,
      autonomyMode: 'manual_only',
      suspensionState: 'manual_only',
      humanInterventionRequired: true,
      loopStage: 'failed_closed',
      hudState: 'fail_closed',
      blockingReason: 'loop_transition_failed',
      noProgress: { count: 0, threshold: 2, escalated: false },
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      budget: { attemptsRemaining: 0, depthRemaining: 0 },
      ambiguousOutcome: false,
      nextSafeAction: 'manual_review_required',
    };
  }
}

/** Full operator-safe detail payload (design §B — the seven questions). */
export function buildOperatorGoalDetail(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  options: OperatorGoalReadModelOptions = {},
): OperatorGoalDetail {
  const details = deriveLoopStageDetails(store, goalId, options);
  const goal = details.goal;
  if (goal === undefined) throw new Error(PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
  const now = (options.now ?? Date.now)();

  const attempts = store.listGoalAttempts(goalId);
  const evaluations = store.listGoalEvaluations(goalId);
  const plans = store.listGoalContinuationPlans(goalId);
  const currentTask = details.currentTask;
  const nextTask = details.nextTask;
  const policy = details.policy;

  const inFlight = attempts.some((attempt) => IN_FLIGHT_TASK_STATUSES.has(attempt.status));

  const authTask = nextTask ?? currentTask;
  let authorizationState: OperatorGoalDetail['authorizationState'] = 'not_applicable';
  if (authTask !== undefined && details.mode === 'approved_single_step') {
    const authorization = store.readExecutionAuthorizationByTask(authTask.taskId);
    authorizationState = deriveExecutionAuthorizationState({
      authorization,
      policy,
      mode: details.mode,
      now,
    });
  }

  let eligibility: OperatorGoalDetail['eligibility'];
  if (nextTask !== undefined) {
    const verdict = evaluateContinuationExecutionEligibility(store, nextTask.taskId, options);
    eligibility = {
      eligible: verdict.eligible,
      mode: verdict.mode,
      ...(verdict.eligible ? {} : { reason: verdict.reason }),
    };
  }

  return {
    goalId: goal.goalId,
    projectId: goal.projectId,
    title: goal.objective.slice(0, MAX_VISIBLE_OBJECTIVE_CHARS),
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.terminalAt !== undefined ? { terminalAt: goal.terminalAt } : {}),
    ...(goal.terminalReason !== undefined ? { terminalReason: goal.terminalReason } : {}),
    maxAttempts: goal.maxAttempts,
    continuationDepthLimit: goal.continuationDepthLimit,
    currentAttempt: goal.currentAttempt,
    loopStage: details.stage,
    hudState: mapLoopStageToHudState(details),
    ...(details.blockingReason !== undefined ? { blockingReason: details.blockingReason } : {}),
    humanInterventionRequired: details.humanInterventionRequired,
    ambiguousOutcome: details.ambiguousOutcome,
    inFlight,
    launchState: taskLaunchState(store, currentTask),
    ...(currentTask !== undefined ? { currentTask: toAttemptSummary(currentTask) } : {}),
    ...(nextTask !== undefined
      ? {
        nextTask: {
          taskId: nextTask.taskId,
          status: nextTask.status,
          attemptNumber: nextTask.lineage?.attemptNumber ?? 0,
          continuationDepth: nextTask.lineage?.continuationDepth ?? 0,
        },
      }
      : {}),
    ...(details.evaluation !== undefined ? { latestEvaluation: toEvaluationSummary(details.evaluation) } : {}),
    evaluationHistory: evaluations.map((evaluation) => toEvaluationSummary(evaluation)),
    planHistory: plans.map((plan) => ({
      planId: plan.planId,
      status: plan.status,
      reasonCode: plan.reasonCode,
      nextAttemptNumber: plan.nextAttemptNumber,
      nextContinuationDepth: plan.nextContinuationDepth,
      createdAt: plan.createdAt,
      ...(plan.cancelledAt !== undefined ? { cancelledAt: plan.cancelledAt } : {}),
      ...(plan.createdTaskId !== undefined ? { createdTaskId: plan.createdTaskId } : {}),
      ...(plan.consumedAt !== undefined ? { consumedAt: plan.consumedAt } : {}),
    })),
    attempts: attempts.map((attempt) => toAttemptSummary(attempt)),
    autonomy: buildAutonomyView(details),
    approvalState: resolveApprovalState(details),
    authorizationState,
    ...(buildApprovalCard(details) !== undefined ? { approvalCard: buildApprovalCard(details) } : {}),
    approvalEffect: buildApprovalEffect(details.mode, details.plan?.planId),
    budget: toOperatorBudget(details.budget),
    noProgress: {
      count: details.noProgressCount,
      threshold: details.noProgressThreshold,
      escalated: details.escalated,
    },
    nextRequiredBoundary: details.stage,
    nextSafeAction: deriveNextSafeAction(details),
    ...(eligibility !== undefined ? { eligibility } : {}),
  };
}

/** Per-goal isolation wrapper: a corrupt goal surfaces as `failed_closed` + safe reason. */
export function buildOperatorGoalDetailSafe(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  options: OperatorGoalReadModelOptions = {},
): OperatorGoalDetail {
  try {
    return buildOperatorGoalDetail(store, goalId, options);
  } catch (error) {
    const goal = store.readGoal(goalId);
    if (goal === undefined) throw error;
    return {
      goalId: goal.goalId,
      projectId: goal.projectId,
      title: goal.objective.slice(0, MAX_VISIBLE_OBJECTIVE_CHARS),
      status: goal.status,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      maxAttempts: goal.maxAttempts,
      continuationDepthLimit: goal.continuationDepthLimit,
      currentAttempt: goal.currentAttempt,
      loopStage: 'failed_closed',
      hudState: 'fail_closed',
      blockingReason: 'loop_transition_failed',
      humanInterventionRequired: true,
      ambiguousOutcome: false,
      inFlight: false,
      launchState: 'not_launched',
      evaluationHistory: [],
      planHistory: [],
      attempts: [],
      autonomy: {
        goalId: goal.goalId,
        mode: 'manual_only',
        policyState: 'manual_only',
      },
      approvalState: 'not_applicable',
      authorizationState: 'not_applicable',
      approvalEffect: buildApprovalEffect('manual_only', undefined),
      budget: { attemptsRemaining: 0, depthRemaining: 0 },
      noProgress: { count: 0, threshold: 2, escalated: false },
      nextRequiredBoundary: 'failed_closed',
      nextSafeAction: 'manual_review_required',
    };
  }
}

/** Continuation view (design §C #9/#10): plan + approval + authorization + eligibility + launch state. */
export function buildOperatorContinuationView(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  options: OperatorGoalReadModelOptions = {},
): OperatorGoalContinuationView {
  const details = deriveLoopStageDetails(store, goalId, options);
  const goal = details.goal;
  if (goal === undefined) throw new Error(PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);
  const now = (options.now ?? Date.now)();

  const plan = details.plan;
  const nextTask = details.nextTask ?? (details.plan?.createdTaskId !== undefined
    ? store.get(details.plan.createdTaskId)
    : undefined);
  const policy = details.policy;

  const execution = nextTask !== undefined
    ? buildContinuationExecutionEvidence(store, nextTask.taskId, options)
    : undefined;
  const gate = plan !== undefined ? buildContinuationGateEvidence(store, plan.planId, options) : undefined;

  let authorization: OperatorGoalContinuationView['authorization'] = { state: 'not_applicable' };
  if (nextTask !== undefined && details.mode === 'approved_single_step') {
    const record = store.readExecutionAuthorizationByTask(nextTask.taskId);
    if (record !== undefined) {
      authorization = {
        state: deriveExecutionAuthorizationState({ authorization: record, policy, mode: details.mode, now }),
        authorizationId: record.authorizationId,
        approver: record.approver,
        createdAt: record.createdAt,
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
        ...(record.consumedAt !== undefined ? { consumedAt: record.consumedAt } : {}),
      };
    } else {
      authorization = { state: 'authorization_required' };
    }
  }

  const inheritedCapabilities: string[] = plan === undefined
    ? []
    : (store.get(plan.parentTaskId)?.intent.requestedCapabilities ?? []);

  return {
    goalId,
    ...(plan !== undefined
      ? {
        plan: {
          planId: plan.planId,
          status: plan.status,
          nextObjective: plan.instruction,
          reasonCode: plan.reasonCode,
          nextAttemptNumber: plan.nextAttemptNumber,
          nextContinuationDepth: plan.nextContinuationDepth,
          parentTaskId: plan.parentTaskId,
          parentAttemptNumber: plan.parentAttemptNumber,
          createdAt: plan.createdAt,
        },
      }
      : {}),
    approval: {
      state: plan === undefined
        ? 'not_applicable'
        : (details.approvalState ?? (plan.status === 'consumed' ? 'approval_consumed' : 'approval_required')),
      ...(details.approval !== undefined
        ? {
          approvalId: details.approval.approvalId,
          approver: details.approval.approver,
          createdAt: details.approval.createdAt,
          ...(details.approval.expiresAt !== undefined ? { expiresAt: details.approval.expiresAt } : {}),
          ...(details.approval.revokedAt !== undefined ? { revokedAt: details.approval.revokedAt } : {}),
        }
        : {}),
    },
    authorization,
    eligibility: nextTask === undefined
      ? { eligible: false, mode: details.mode }
      : (execution !== undefined
        ? { eligible: execution.eligible, mode: details.mode, ...(execution.eligibilityReason !== undefined ? { reason: execution.eligibilityReason } : {}) }
        : { eligible: false, mode: details.mode }),
    launchState: execution?.launchState ?? taskLaunchState(store, nextTask),
    ambiguousOutcome: execution?.ambiguousOutcome ?? details.ambiguousOutcome,
    materializationState: gate?.materializationState ?? (plan !== undefined && plan.status === 'consumed' ? 'materialized' : 'pending'),
    ...(gate?.createdTaskId !== undefined ? { createdTaskId: gate.createdTaskId } : {}),
    nextTaskExecuted: false,
    inheritedCapabilities,
  };
}

/** Autonomy view (design §C #5 read side). */
export function buildOperatorAutonomyView(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  options: OperatorGoalReadModelOptions = {},
): OperatorGoalAutonomyView {
  const details = deriveLoopStageDetails(store, goalId, options);
  return buildAutonomyView(details);
}

/** Evidence bundle (design §C #11): Q3 summary + plan + authorization + safe receipt. */
export function buildOperatorEvidenceBundle(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  options: OperatorGoalReadModelOptions = {},
): OperatorGoalEvidenceBundle {
  const details = deriveLoopStageDetails(store, goalId, options);
  const goal = details.goal;
  if (goal === undefined) throw new Error(PROJECT_GOAL_CONTROL_ERRORS.goalNotFound);

  const attempts = store.listGoalAttempts(goalId);
  const evaluations = store.listGoalEvaluations(goalId);
  const resolveTask = (taskId: string): ProjectTaskRecord | undefined =>
    attempts.find((attempt) => attempt.taskId === taskId);
  const applied = evaluations.filter((evaluation) => evaluation.appliedAt !== undefined);
  const latest = applied.at(-1);

  const threshold = resolveNoProgressThreshold(options.noProgressEscalationThreshold, goal);
  const noProgressCount = latest === undefined
    ? 0
    : countConsecutiveNoProgressCycles(evaluations, resolveTask, latest.evaluationId);

  let latestEvaluation: OperatorGoalEvidenceBundle['latestEvaluation'];
  if (latest !== undefined) {
    const task = resolveTask(latest.taskId);
    if (task !== undefined) {
      const summary = buildProjectGoalVisibleSummary(latest, goal, task);
      latestEvaluation = {
        decision: summary.decision,
        reasonCode: summary.reasonCode,
        summary: summary.summary,
        evidenceFingerprint: summary.evidenceFingerprint,
        createdAt: summary.createdAt,
        ...(summary.appliedAt !== undefined ? { appliedAt: summary.appliedAt } : {}),
        taskId: summary.taskId,
        attemptNumber: summary.attemptNumber,
        goalStatus: summary.goalStatus,
        resultText: summary.resultText,
        ...(summary.verification !== undefined ? { verification: summary.verification } : {}),
        ...(summary.commit !== undefined ? { commit: summary.commit } : {}),
        ...(summary.stages !== undefined ? { stages: [...summary.stages] } : {}),
      };
    }
  }

  let continuationPlan: OperatorGoalEvidenceBundle['continuationPlan'];
  if (latest !== undefined) {
    const plan = store.readContinuationPlanBySourceEvaluation(latest.evaluationId);
    const escalated = noProgressCount >= threshold;
    if (plan !== undefined) {
      continuationPlan = {
        planId: plan.planId,
        planStatus: plan.status,
        nextObjective: plan.instruction,
        planReasonCode: plan.reasonCode,
        parentTaskId: plan.parentTaskId,
        parentAttemptNumber: plan.parentAttemptNumber,
        nextAttemptNumber: plan.nextAttemptNumber,
        nextContinuationDepth: plan.nextContinuationDepth,
        materializationPending: plan.status === 'planned',
        continuationExecuted: false,
        escalation: {
          detected: escalated,
          consecutiveNoProgress: noProgressCount,
          threshold,
          ...(escalated ? { reason: 'no_progress_escalation' } : {}),
        },
      };
    }
  }

  const authTask = details.nextTask ?? details.currentTask;
  let authorizationState: OperatorGoalEvidenceBundle['authorizationState'] = 'not_applicable';
  if (authTask !== undefined && details.mode === 'approved_single_step') {
    const authorization = store.readExecutionAuthorizationByTask(authTask.taskId);
    authorizationState = deriveExecutionAuthorizationState({
      authorization,
      policy: details.policy,
      mode: details.mode,
      now: (options.now ?? Date.now)(),
    });
  }

  return {
    goalId,
    ...(latestEvaluation !== undefined ? { latestEvaluation } : {}),
    ...(continuationPlan !== undefined ? { continuationPlan } : {}),
    approvalState: resolveApprovalState(details),
    authorizationState,
    noProgress: { count: noProgressCount, threshold, escalated: noProgressCount >= threshold },
  };
}

/**
 * Safe-field whitelist guard (design §A.4). Deep key scan: any payload key in
 * the forbidden set fails closed. Applied at the route layer as defense in
 * depth; the read-model builders already compose whitelisted fields only.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set<string>([
  'sessionId', 'session_id', 'apiKey', 'api_key', 'accessToken', 'token',
  'secret', 'credential', 'worktreePath', 'worktree_path', 'repositoryRoot',
  'command', 'commands', 'shell', 'prompt', 'rawOutput', 'executionSummary',
  'provider', 'model', 'fencingToken', 'leaseId', 'leaseOwner', 'intent',
  'approvedCapabilities', 'effectiveCapabilities', 'capabilities',
  'capabilityExpansion', 'error', 'stack', 'internalError', 'paths', 'path',
]);

export function assertSafeOperatorPayload(payload: unknown): void {
  if (Array.isArray(payload)) {
    for (const entry of payload) assertSafeOperatorPayload(entry);
    return;
  }
  if (typeof payload !== 'object' || payload === null) return;
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      throw new Error('unsafe_operator_payload_field');
    }
    assertSafeOperatorPayload(value);
  }
}
