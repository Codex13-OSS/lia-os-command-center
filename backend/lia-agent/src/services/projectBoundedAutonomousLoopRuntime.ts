import type { ProjectGoalRecord, ProjectGoalStore } from '../contracts/projectGoal.js';
import type {
  AutonomyMode,
  AutonomyPolicyState,
  ProjectGoalAutonomyPolicyRecord,
} from '../contracts/projectGoalAutonomyPolicy.js';
import {
  AUTONOMY_POLICY_DEFAULT_MODE,
  deriveAutonomyPolicyState,
} from '../contracts/projectGoalAutonomyPolicy.js';
import type {
  ContinuationApprovalState,
  ProjectGoalContinuationApprovalRecord,
} from '../contracts/projectGoalContinuationApproval.js';
import { deriveContinuationApprovalState } from '../contracts/projectGoalContinuationApproval.js';
import type { ProjectGoalContinuationExecutionAuthorizationRecord } from '../contracts/projectGoalContinuationExecutionAuthorization.js';
import { deriveExecutionAuthorizationState } from '../contracts/projectGoalContinuationExecutionAuthorization.js';
import type { ProjectGoalContinuationPlanRecord } from '../contracts/projectGoalContinuationPlan.js';
import type { ProjectGoalEvaluationRecord } from '../contracts/projectGoalEvaluation.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';
import type { ProjectTaskExecutionLaunchAttemptRecord } from '../contracts/projectTaskExecutionLaunchAttempt.js';
import type { ProjectTaskExecutionLaunchResultRecord } from '../contracts/projectTaskExecutionLaunchResult.js';
import type { ProjectGoalSemanticAssessor } from './projectGoalSatisfactionAssessor.js';
import {
  evaluateAndApplyGoalCompletion,
  type ProjectGoalEvaluationOrchestratorStore,
} from './projectGoalEvaluationOrchestrator.js';
import {
  countConsecutiveNoProgressCycles,
  planGoalContinuation,
  resolveNoProgressThreshold,
  type ProjectGoalContinuationPlanningStore,
} from './projectGoalContinuationPlanningOrchestrator.js';
import {
  materializeApprovedContinuation,
  materializeBoundedAutonomousContinuation,
  type ContinuationExecutionGateStore,
} from './projectGoalContinuationExecutionGate.js';
import {
  evaluateContinuationExecutionEligibility,
  type ContinuationExecutionEligibilityResult,
  type ContinuationExecutionEligibilityStore,
} from './projectContinuationExecutionEligibility.js';
import {
  launchContinuationTaskIfEligible,
  type ContinuationLaunchDependencies,
  type ContinuationExecutionPolicyStore,
} from './projectContinuationExecutionPolicy.js';

/**
 * Bounded Autonomous Loop Runtime — the deterministic, derived-state driver that
 * composes the ALREADY-CLOSED single-goal boundaries:
 *
 *   evaluateAndApplyGoalCompletion
 *     -> planGoalContinuation
 *     -> materializeApprovedContinuation
 *     -> evaluateContinuationExecutionEligibility
 *     -> launchContinuationTaskIfEligible
 *
 * It is a PURE COMPOSITION function. It adds no new durable relation, no new
 * engine, no timer, no polling loop and no recursive autonomous execution.
 * `runLoopOnce(goalId)` advances AT MOST ONE durable boundary per invocation
 * and re-derives its position from durable rows only, so any number of
 * re-entrants converge on the same next action and a process restart resumes
 * at the exact boundary with zero blind replay.
 *
 * LÍA remains the sole authority. The loop's only authority-exercising call is
 * `launchContinuationTaskIfEligible -> runProjectTaskDurableExecution`; every
 * other step is a read or an idempotent, exactly-once write that already
 * exists in the store. The loop never writes `intent`, never writes a
 * capability field, never imports `child_process`/`http(s)`/`net`/`dns`, and
 * never calls Hermes/Codex directly.
 */

/** The store surface the loop requires. It is a strict structural intersection of the existing orchestrator stores. */
export type BoundedAutonomousLoopStore =
  ProjectGoalStore
  & ProjectGoalEvaluationOrchestratorStore
  & ProjectGoalContinuationPlanningStore
  & ContinuationExecutionGateStore
  & ContinuationExecutionEligibilityStore
  & ContinuationExecutionPolicyStore;

/**
 * Derived loop-stage vocabulary (design §3). Stages are a pure function of the
 * existing durable rows; no loop-runtime record is ever persisted. Transient
 * stages (`evaluating_goal`, `planning_continuation`, `materializing_next_attempt`
 * in-process instants) are intentionally not emitted: their durable analogs are
 * re-derived identically after a crash, which is exactly how the existing
 * boundaries already behave.
 */
export const LOOP_STAGES = [
  'goal_missing',
  'awaiting_execution',
  'executing',
  'task_terminal',
  'goal_satisfied',
  'continuation_required',
  'authorization_required',
  'materializing_next_attempt',
  'next_attempt_accepted',
  'suspended',
  'exhausted',
  'failed_closed',
] as const;
export type LoopStage = (typeof LOOP_STAGES)[number];

/** The single action `runLoopOnce` performed this iteration. */
export const LOOP_ACTIONS = ['none', 'evaluated', 'planned', 'held', 'materialized', 'launched'] as const;
export type LoopAction = (typeof LOOP_ACTIONS)[number];

export type LoopRuntimeOptions = {
  /** Clock for expiry/eligibility evaluation (default Date.now). */
  now?: () => number;
  /** No-progress escalation threshold (default 2, clamped to [1, maxAttempts]). */
  noProgressEscalationThreshold?: number;
};

export type LoopBudget = {
  currentAttempt: number | null;
  maxAttempts: number;
  attemptsRemaining: number;
  continuationDepthLimit: number;
  depthRemaining: number;
  cyclesRemaining?: number;
  elapsedBudgetMsRemaining?: number;
};

/** Rich, durable-facts-backed derivation of the loop position. Read-only. */
export type DerivedLoopStageDetails = {
  stage: LoopStage;
  /** Present exactly when the stage is a hold/stop that requires operator action. */
  blockingReason?: string;
  humanInterventionRequired: boolean;
  terminal: boolean;
  ambiguousOutcome: boolean;
  goal?: ProjectGoalRecord;
  policy?: ProjectGoalAutonomyPolicyRecord;
  policyState: AutonomyPolicyState | 'manual_only';
  mode: AutonomyMode;
  currentTask?: ProjectTaskRecord;
  /** Latest applied evaluation for the current attempt (present when the current task is terminal). */
  evaluation?: ProjectGoalEvaluationRecord;
  /** The continuation plan for the latest applied retryable evaluation (when present). */
  plan?: ProjectGoalContinuationPlanRecord;
  approval?: ProjectGoalContinuationApprovalRecord;
  approvalState?: ContinuationApprovalState;
  /** The materialized next task (present when a consumed plan produced an accepted continuation). */
  nextTask?: ProjectTaskRecord;
  executionAuthorization?: ProjectGoalContinuationExecutionAuthorizationRecord;
  /** Eligibility result computed only for `next_attempt_accepted` (read-only). */
  eligibility?: ContinuationExecutionEligibilityResult;
  noProgressCount: number;
  noProgressThreshold: number;
  escalated: boolean;
  budget: LoopBudget;
};

export type LoopRuntimeDependencies = LoopRuntimeOptions & {
  /** Launch dependencies forwarded verbatim to launchContinuationTaskIfEligible. Required when a launch is authorized. */
  launch?: ContinuationLaunchDependencies;
  /** Layer B assessor forwarded to evaluateAndApplyGoalCompletion (default mechanical). */
  assessor?: ProjectGoalSemanticAssessor;
};

/** Bounded, non-secret operator HUD evidence (design §10). Never exposes secrets/prompts/paths/sessions. */
export type OperatorVisibleLoopRuntimeEvidence = {
  goalId: string;
  goalObjective: string;
  derivedLoopStage: LoopStage;
  currentTask: { taskId?: string; status?: string; attemptNumber?: number; continuationDepth?: number };
  goalEvaluation: {
    evaluationId?: string;
    decision?: string;
    reasonCode?: string;
    appliedAt?: number;
    noProgressCount: number;
    noProgressThreshold: number;
    escalated: boolean;
  };
  continuationPlan: { planId?: string; status?: string; nextAttemptNumber?: number; nextContinuationDepth?: number };
  approvalState: ContinuationApprovalState | 'not_applicable';
  executionPolicy: { mode: AutonomyMode; policyState: AutonomyPolicyState | 'manual_only' };
  executionAuthorizationState: string;
  nextTask: { taskId?: string; status?: string };
  actionPerformed: LoopAction;
  nextRequiredBoundary: LoopStage;
  humanInterventionRequired: boolean;
  noProgressCount: number;
  budget: LoopBudget;
  externalLaunchAmbiguity: boolean;
  terminal: boolean;
  blockingReason?: string;
};

export type LoopRuntimeResult = {
  goalId: string;
  stageBefore: LoopStage;
  action: LoopAction;
  stageAfter: LoopStage;
  blockingReason?: string;
  humanInterventionRequired: boolean;
  noProgressCount: number;
  noProgressThreshold: number;
  escalated: boolean;
  ambiguousOutcome: boolean;
  terminal: boolean;
  /** Durable ids produced by the transition, when any (never secret). */
  evaluationId?: string;
  planId?: string;
  createdTaskId?: string;
  evidence: OperatorVisibleLoopRuntimeEvidence;
};

const MAX_VISIBLE_OBJECTIVE_CHARS = 2_000;

function resolveCurrentAttemptTask(
  goal: ProjectGoalRecord,
  attempts: readonly ProjectTaskRecord[],
): ProjectTaskRecord | undefined {
  if (goal.currentAttempt === null) return undefined;
  return attempts.find(
    (attempt) => attempt.lineage !== undefined && attempt.lineage.attemptNumber === goal.currentAttempt,
  );
}

function resolveTaskById(
  attempts: readonly ProjectTaskRecord[],
  taskId: string,
): ProjectTaskRecord | undefined {
  return attempts.find((attempt) => attempt.taskId === taskId);
}

/** Maps an internal machine-code error to a bounded, non-secret blocking reason. */
function toSafeBlockingReason(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    if (/^[a-z][a-z0-9_]{0,127}$/.test(error.message)) return error.message;
  }
  return 'loop_transition_failed';
}

/**
 * Pure, read-only derivation of the loop stage plus the durable facts that
 * prove it (design §3). Never writes. Never self-reports; every fact is read
 * from the store.
 */
export function deriveLoopStageDetails(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  options: LoopRuntimeOptions = {},
): DerivedLoopStageDetails {
  const now = (options.now ?? Date.now)();
  const goal = store.readGoal(goalId);

  const base = {
    humanInterventionRequired: false,
    terminal: false,
    ambiguousOutcome: false,
    policyState: 'manual_only' as AutonomyPolicyState | 'manual_only',
    mode: AUTONOMY_POLICY_DEFAULT_MODE as AutonomyMode,
    noProgressCount: 0,
    noProgressThreshold: 2,
    escalated: false,
    budget: {
      currentAttempt: null as number | null,
      maxAttempts: 0,
      attemptsRemaining: 0,
      continuationDepthLimit: 0,
      depthRemaining: 0,
    } satisfies LoopBudget,
  };

  if (goal === undefined) {
    return { ...base, stage: 'goal_missing' };
  }

  const goalBudget: LoopBudget = {
    currentAttempt: goal.currentAttempt,
    maxAttempts: goal.maxAttempts,
    attemptsRemaining: Math.max(0, goal.maxAttempts - (goal.currentAttempt ?? 0)),
    continuationDepthLimit: goal.continuationDepthLimit,
    depthRemaining: goal.continuationDepthLimit,
  };

  const terminalByStatus = (blockingReason: string | undefined, stage: LoopStage): DerivedLoopStageDetails => ({
    stage,
    blockingReason,
    humanInterventionRequired: stage === 'failed_closed',
    terminal: true,
    ambiguousOutcome: false,
    goal,
    policyState: 'manual_only',
    mode: AUTONOMY_POLICY_DEFAULT_MODE,
    noProgressCount: 0,
    noProgressThreshold: 2,
    escalated: false,
    budget: goalBudget,
  });

  if (goal.status === 'completed') return terminalByStatus(goal.terminalReason, 'goal_satisfied');
  if (goal.status === 'exhausted') return terminalByStatus(goal.terminalReason, 'exhausted');
  if (goal.status === 'failed' || goal.status === 'blocked') {
    return terminalByStatus(goal.terminalReason ?? goal.status, 'failed_closed');
  }

  // Goal is active.
  const policy = store.readGoalAutonomyPolicy(goalId);
  const policyState: AutonomyPolicyState | 'manual_only' = policy === undefined
    ? 'manual_only'
    : deriveAutonomyPolicyState(policy, now);
  const mode: AutonomyMode = policy === undefined ? AUTONOMY_POLICY_DEFAULT_MODE : policy.mode;

  // §4 rule 2: suspended / revoked / expired -> hold (no launch). Survives restart.
  if (policyState === 'suspended') {
    return { ...base, stage: 'suspended', blockingReason: 'autonomy_suspended', humanInterventionRequired: true, goal, policy, policyState, mode, budget: goalBudget };
  }
  if (policyState === 'revoked') {
    return { ...base, stage: 'failed_closed', blockingReason: 'autonomy_policy_revoked', humanInterventionRequired: true, goal, policy, policyState, mode, budget: goalBudget };
  }
  if (policyState === 'expired') {
    return { ...base, stage: 'failed_closed', blockingReason: 'autonomy_policy_expired', humanInterventionRequired: true, goal, policy, policyState, mode, budget: goalBudget };
  }

  const attempts = store.listGoalAttempts(goalId);
  const currentTask = resolveCurrentAttemptTask(goal, attempts);

  if (currentTask === undefined) {
    // No root attempt yet (operator creates it via the intake route).
    return { ...base, stage: 'awaiting_execution', humanInterventionRequired: true, goal, policy, policyState, mode, budget: goalBudget };
  }

  const currentDepth = currentTask.lineage?.continuationDepth ?? 0;
  const budget: LoopBudget = {
    currentAttempt: goal.currentAttempt,
    maxAttempts: goal.maxAttempts,
    attemptsRemaining: Math.max(0, goal.maxAttempts - (currentTask.lineage?.attemptNumber ?? 0)),
    continuationDepthLimit: goal.continuationDepthLimit,
    depthRemaining: Math.max(0, goal.continuationDepthLimit - currentDepth),
    ...(policy?.maxCycles !== undefined
      ? { cyclesRemaining: Math.max(0, policy.maxCycles - (currentTask.lineage?.attemptNumber ?? 0)) }
      : {}),
    ...(policy?.elapsedBudgetMs !== undefined
      ? { elapsedBudgetMsRemaining: Math.max(0, policy.elapsedBudgetMs - (now - policy.createdAt)) }
      : {}),
  };

  const isLaunchAmbiguous = (task: ProjectTaskRecord): boolean => {
    const launchAttempt = store.readTaskExecutionLaunchAttemptByTask(task.taskId);
    const launchResult = store.readTaskExecutionLaunchResultByTask(task.taskId);
    return launchAttempt !== undefined && launchResult === undefined;
  };

  if (currentTask.status === 'accepted') {
    // Accepted current task: a materialized continuation has a consumed plan
    // that created it; the root attempt does not.
    const plans = store.listGoalContinuationPlans(goalId);
    const consumedPlan = plans.find(
      (candidate) => candidate.status === 'consumed' && candidate.createdTaskId === currentTask.taskId,
    );
    if (consumedPlan === undefined) {
      if (currentTask.lineage?.parentTaskId !== undefined) {
        return { ...base, stage: 'failed_closed', blockingReason: 'corrupt_lineage', humanInterventionRequired: true, goal, policy, policyState, mode, currentTask, budget };
      }
      // Root attempt accepted but not yet launched (operator dispatch).
      return { ...base, stage: 'awaiting_execution', humanInterventionRequired: true, goal, policy, policyState, mode, currentTask, budget };
    }
    if (isLaunchAmbiguous(currentTask)) {
      // §4 rule 3 / §7: crossed launch boundary with unknown outcome -> fail closed, never relaunch.
      return { ...base, stage: 'failed_closed', blockingReason: 'external_launch_outcome_unknown', humanInterventionRequired: true, terminal: true, ambiguousOutcome: true, goal, policy, policyState, mode, currentTask, plan: consumedPlan, nextTask: currentTask, budget };
    }
    const eligibility = evaluateContinuationExecutionEligibility(store, currentTask.taskId, {
      now: options.now,
      noProgressEscalationThreshold: options.noProgressEscalationThreshold,
    });
    return {
      ...base,
      stage: 'next_attempt_accepted',
      blockingReason: eligibility.eligible ? undefined : eligibility.reason,
      humanInterventionRequired: !eligibility.eligible,
      goal,
      policy,
      policyState,
      mode,
      currentTask,
      plan: consumedPlan,
      nextTask: currentTask,
      executionAuthorization: store.readExecutionAuthorizationByTask(currentTask.taskId),
      eligibility,
      budget,
    };
  }

  if (currentTask.status !== 'completed' && currentTask.status !== 'failed') {
    // Non-terminal (planning/hermes/codex/verification/commit). Runner owns it.
    return { ...base, stage: 'executing', goal, policy, policyState, mode, currentTask, budget };
  }

  // Current task is terminal.
  const evaluations = store.listGoalEvaluations(goalId);
  const appliedForAttempt = evaluations.filter(
    (evaluation) => evaluation.appliedAt !== undefined && evaluation.attemptNumber === goal.currentAttempt,
  );
  const latestApplied = appliedForAttempt.at(-1);

  if (latestApplied === undefined) {
    // Terminal task, no applied evaluation -> evaluate (the Q3 boundary).
    return { ...base, stage: 'task_terminal', goal, policy, policyState, mode, currentTask, budget };
  }

  if (latestApplied.decision === 'completed') {
    return { ...base, stage: 'goal_satisfied', blockingReason: 'objective_completed', terminal: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, budget };
  }
  if (latestApplied.decision !== 'retryable') {
    // blocked / failed (defensive: the goal should already be terminal).
    return { ...base, stage: 'failed_closed', blockingReason: latestApplied.decision, humanInterventionRequired: true, terminal: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, budget };
  }

  // Retryable evaluation -> continuation plan.
  const threshold = resolveNoProgressThreshold(options.noProgressEscalationThreshold, goal);
  const noProgressCount = countConsecutiveNoProgressCycles(
    evaluations,
    (taskId) => resolveTaskById(attempts, taskId),
    latestApplied.evaluationId,
  );
  const escalated = noProgressCount >= threshold;

  const plan = store.readContinuationPlanBySourceEvaluation(latestApplied.evaluationId);

  if (plan === undefined) {
    // §4 rule 4: repeated identical no-progress -> stop, escalate to operator.
    if (escalated) {
      return { ...base, stage: 'failed_closed', blockingReason: 'no_progress_escalation', humanInterventionRequired: true, terminal: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, noProgressCount, noProgressThreshold: threshold, escalated, budget };
    }
    return { ...base, stage: 'continuation_required', goal, policy, policyState, mode, currentTask, evaluation: latestApplied, noProgressCount, noProgressThreshold: threshold, escalated, budget };
  }

  if (plan.status === 'planned') {
    const approval = store.readContinuationApproval(plan.planId);
    const approvalState = deriveContinuationApprovalState({
      plan,
      approval,
      evaluation: latestApplied,
      goal,
      now,
    });
    if (approvalState === 'approval_present') {
      return { ...base, stage: 'materializing_next_attempt', goal, policy, policyState, mode, currentTask, evaluation: latestApplied, plan, approval, approvalState, noProgressCount, noProgressThreshold: threshold, escalated, budget };
    }
    if (mode === 'bounded_autonomous' && policy !== undefined) {
      if (policy.elapsedBudgetMs !== undefined && now - policy.createdAt >= policy.elapsedBudgetMs) {
        return { ...base, stage: 'failed_closed', blockingReason: 'autonomy_elapsed_budget_exhausted', humanInterventionRequired: true, terminal: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, plan, noProgressCount, noProgressThreshold: threshold, escalated, budget };
      }
      if (policy.maxCycles !== undefined && plan.nextAttemptNumber >= policy.maxCycles) {
        return { ...base, stage: 'exhausted', blockingReason: 'autonomy_cycle_limit_reached', humanInterventionRequired: true, terminal: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, plan, noProgressCount, noProgressThreshold: threshold, escalated, budget };
      }
      return { ...base, stage: 'materializing_next_attempt', goal, policy, policyState, mode, currentTask, evaluation: latestApplied, plan, noProgressCount, noProgressThreshold: threshold, escalated, budget };
    }
    return {
      ...base,
      stage: 'authorization_required',
      blockingReason: approvalState,
      humanInterventionRequired: true,
      goal,
      policy,
      policyState,
      mode,
      currentTask,
      evaluation: latestApplied,
      plan,
      approval,
      approvalState,
      noProgressCount,
      noProgressThreshold: threshold,
      escalated,
      budget,
    };
  }

  if (plan.status === 'cancelled') {
    return { ...base, stage: 'failed_closed', blockingReason: 'plan_cancelled', humanInterventionRequired: true, terminal: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, plan, noProgressCount, noProgressThreshold: threshold, escalated, budget };
  }

  // Consumed plan: its createdTaskId is the current attempt (already handled
  // above when the current task was accepted/non-terminal). Reaching here with
  // a terminal current task means the consumed task's evaluation is missing.
  const nextTaskId = plan.createdTaskId;
  if (nextTaskId === undefined) {
    return { ...base, stage: 'failed_closed', blockingReason: 'corrupt_lineage', humanInterventionRequired: true, terminal: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, plan, noProgressCount, noProgressThreshold: threshold, escalated, budget };
  }
  const nextTask = store.get(nextTaskId);
  if (nextTask === undefined) {
    return { ...base, stage: 'failed_closed', blockingReason: 'corrupt_lineage', humanInterventionRequired: true, terminal: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, plan, noProgressCount, noProgressThreshold: threshold, escalated, budget };
  }
  if (nextTask.status === 'accepted') {
    if (isLaunchAmbiguous(nextTask)) {
      return { ...base, stage: 'failed_closed', blockingReason: 'external_launch_outcome_unknown', humanInterventionRequired: true, terminal: true, ambiguousOutcome: true, goal, policy, policyState, mode, currentTask, evaluation: latestApplied, plan, nextTask, noProgressCount, noProgressThreshold: threshold, escalated, budget };
    }
    const eligibility = evaluateContinuationExecutionEligibility(store, nextTask.taskId, {
      now: options.now,
      noProgressEscalationThreshold: options.noProgressEscalationThreshold,
    });
    return {
      ...base,
      stage: 'next_attempt_accepted',
      blockingReason: eligibility.eligible ? undefined : eligibility.reason,
      humanInterventionRequired: !eligibility.eligible,
      goal,
      policy,
      policyState,
      mode,
      currentTask,
      evaluation: latestApplied,
      plan,
      nextTask,
      executionAuthorization: store.readExecutionAuthorizationByTask(nextTask.taskId),
      eligibility,
      noProgressCount,
      noProgressThreshold: threshold,
      escalated,
      budget,
    };
  }
  if (nextTask.status !== 'completed' && nextTask.status !== 'failed') {
    return { ...base, stage: 'executing', goal, policy, policyState, mode, currentTask: nextTask, evaluation: latestApplied, plan, nextTask, noProgressCount, noProgressThreshold: threshold, escalated, budget };
  }
  // Next task is terminal but its own evaluation has not been applied yet.
  return { ...base, stage: 'task_terminal', goal, policy, policyState, mode, currentTask: nextTask, noProgressCount, noProgressThreshold: threshold, escalated, budget };
}

/** Design §3.2: the loop stage as a pure function of durable rows. */
export function deriveLoopStage(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  options: LoopRuntimeOptions = {},
): LoopStage {
  return deriveLoopStageDetails(store, goalId, options).stage;
}

/**
 * Builds the bounded, non-secret operator HUD (design §10). Pure read; every
 * field is a direct read of an immutable row or a deterministic derivation.
 */
export function buildLoopRuntimeEvidence(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  options: LoopRuntimeOptions & { action?: LoopAction } = {},
): OperatorVisibleLoopRuntimeEvidence {
  const details = deriveLoopStageDetails(store, goalId, options);
  const { action = 'none' } = options;
  const goal = details.goal;

  return {
    goalId,
    goalObjective: (goal?.objective ?? '').slice(0, MAX_VISIBLE_OBJECTIVE_CHARS),
    derivedLoopStage: details.stage,
    currentTask: {
      ...(details.currentTask !== undefined
        ? {
          taskId: details.currentTask.taskId,
          status: details.currentTask.status,
          ...(details.currentTask.lineage !== undefined
            ? {
              attemptNumber: details.currentTask.lineage.attemptNumber,
              continuationDepth: details.currentTask.lineage.continuationDepth,
            }
            : {}),
        }
        : {}),
    },
    goalEvaluation: {
      ...(details.evaluation !== undefined
        ? {
          evaluationId: details.evaluation.evaluationId,
          decision: details.evaluation.decision,
          reasonCode: details.evaluation.reasonCode,
          ...(details.evaluation.appliedAt !== undefined ? { appliedAt: details.evaluation.appliedAt } : {}),
        }
        : {}),
      noProgressCount: details.noProgressCount,
      noProgressThreshold: details.noProgressThreshold,
      escalated: details.escalated,
    },
    continuationPlan: {
      ...(details.plan !== undefined
        ? {
          planId: details.plan.planId,
          status: details.plan.status,
          nextAttemptNumber: details.plan.nextAttemptNumber,
          nextContinuationDepth: details.plan.nextContinuationDepth,
        }
        : {}),
    },
    approvalState: details.approvalState ?? 'not_applicable',
    executionPolicy: { mode: details.mode, policyState: details.policyState },
    executionAuthorizationState: details.executionAuthorization === undefined
      ? (details.mode === 'approved_single_step' ? 'authorization_required' : 'not_applicable')
      : deriveExecutionAuthorizationState({
        authorization: details.executionAuthorization,
        policy: details.policy,
        mode: details.mode,
        now: (options.now ?? Date.now)(),
      }),
    nextTask: {
      ...(details.nextTask !== undefined
        ? { taskId: details.nextTask.taskId, status: details.nextTask.status }
        : {}),
    },
    actionPerformed: action,
    nextRequiredBoundary: details.stage,
    humanInterventionRequired: details.humanInterventionRequired,
    noProgressCount: details.noProgressCount,
    budget: details.budget,
    externalLaunchAmbiguity: details.ambiguousOutcome,
    terminal: details.terminal,
    ...(details.blockingReason !== undefined ? { blockingReason: details.blockingReason } : {}),
  };
}

/**
 * A. The deterministic run-once driver.
 *
 * Advances AT MOST ONE durable boundary per invocation. No `while(true)`, no
 * internal polling loop, no timer scheduler, no busy waiting, and no recursive
 * autonomous execution. Each call (1) reads existing durable state, (2) derives
 * the loop stage, (3) performs at most one authorized transition, and
 * (4) returns bounded safe evidence describing what happened and the next
 * boundary.
 */
export async function runLoopOnce(
  store: BoundedAutonomousLoopStore,
  goalId: string,
  dependencies: LoopRuntimeDependencies = {},
): Promise<LoopRuntimeResult> {
  const options: LoopRuntimeOptions = {
    ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
    ...(dependencies.noProgressEscalationThreshold !== undefined
      ? { noProgressEscalationThreshold: dependencies.noProgressEscalationThreshold }
      : {}),
  };

  const detailsBefore = deriveLoopStageDetails(store, goalId, options);
  const stageBefore = detailsBefore.stage;

  const buildResult = (
    action: LoopAction,
    overrides: Partial<LoopRuntimeResult> = {},
  ): LoopRuntimeResult => {
    const detailsAfter = deriveLoopStageDetails(store, goalId, options);
    return {
      goalId,
      stageBefore,
      action,
      stageAfter: detailsAfter.stage,
      ...(overrides.blockingReason !== undefined
        ? { blockingReason: overrides.blockingReason }
        : detailsAfter.blockingReason !== undefined
          ? { blockingReason: detailsAfter.blockingReason }
          : {}),
      humanInterventionRequired: detailsAfter.humanInterventionRequired,
      noProgressCount: detailsAfter.noProgressCount,
      noProgressThreshold: detailsAfter.noProgressThreshold,
      escalated: detailsAfter.escalated,
      ambiguousOutcome: detailsAfter.ambiguousOutcome,
      terminal: detailsAfter.terminal,
      ...(overrides.evaluationId !== undefined ? { evaluationId: overrides.evaluationId } : {}),
      ...(overrides.planId !== undefined ? { planId: overrides.planId } : {}),
      ...(overrides.createdTaskId !== undefined ? { createdTaskId: overrides.createdTaskId } : {}),
      evidence: buildLoopRuntimeEvidence(store, goalId, { ...options, action }),
    };
  };

  // Terminal / hold / wait stages: no durable write.
  switch (stageBefore) {
    case 'goal_missing':
    case 'goal_satisfied':
    case 'exhausted':
    case 'suspended':
    case 'executing':
    case 'awaiting_execution':
      return buildResult('none');

    case 'failed_closed':
      return buildResult('none', { blockingReason: detailsBefore.blockingReason });

    case 'authorization_required':
      // Human gate: never auto-approves. No write.
      return buildResult('held', { blockingReason: detailsBefore.blockingReason });

    case 'task_terminal': {
      try {
        const outcome = await evaluateAndApplyGoalCompletion(store, goalId, {
          ...(dependencies.assessor !== undefined ? { assessor: dependencies.assessor } : {}),
        });
        return buildResult('evaluated', { evaluationId: outcome.evaluation.evaluationId });
      } catch (error) {
        return buildResult('held', { blockingReason: toSafeBlockingReason(error) });
      }
    }

    case 'continuation_required': {
      // §4 rule 4: escalate instead of planning once the no-progress threshold is met.
      if (detailsBefore.escalated) {
        return buildResult('held', { blockingReason: 'no_progress_escalation' });
      }
      try {
        const outcome = await planGoalContinuation(store, goalId, {
          ...(dependencies.noProgressEscalationThreshold !== undefined
            ? { noProgressEscalationThreshold: dependencies.noProgressEscalationThreshold }
            : {}),
        });
        if (outcome.planned && outcome.plan !== undefined) {
          return buildResult('planned', { planId: outcome.plan.planId });
        }
        // Benign refusal (evaluationNotRetryable / goalTerminal / noProgressEscalation).
        return buildResult('held', { blockingReason: outcome.refusalReason });
      } catch (error) {
        return buildResult('held', { blockingReason: toSafeBlockingReason(error) });
      }
    }

    case 'materializing_next_attempt': {
      if (detailsBefore.plan === undefined) {
        return buildResult('held', { blockingReason: 'corrupt_lineage' });
      }
      try {
        const result = detailsBefore.mode === 'bounded_autonomous'
          ? materializeBoundedAutonomousContinuation(
              store,
              detailsBefore.plan.planId,
              (dependencies.now ?? Date.now)(),
            )
          : materializeApprovedContinuation(store, detailsBefore.plan.planId);
        return buildResult('materialized', { createdTaskId: result.createdTaskId });
      } catch (error) {
        return buildResult('held', { blockingReason: toSafeBlockingReason(error) });
      }
    }

    case 'next_attempt_accepted': {
      const nextTask = detailsBefore.nextTask;
      if (nextTask === undefined) {
        return buildResult('held', { blockingReason: 'corrupt_lineage' });
      }
      const eligibility = detailsBefore.eligibility
        ?? evaluateContinuationExecutionEligibility(store, nextTask.taskId, {
          now: options.now,
          noProgressEscalationThreshold: options.noProgressEscalationThreshold,
        });
      if (!eligibility.eligible) {
        // Hold: manual_only / missing authorization / revoked / expired /
        // suspended / bound breach / no-progress escalation. No write.
        return buildResult('held', { blockingReason: eligibility.reason });
      }
      if (dependencies.launch === undefined) {
        return buildResult('held', { blockingReason: 'launch_dependencies_missing' });
      }
      try {
        await launchContinuationTaskIfEligible(store, nextTask.taskId, dependencies.launch);
        return buildResult('launched');
      } catch (error) {
        return buildResult('held', { blockingReason: toSafeBlockingReason(error) });
      }
    }

    default:
      return buildResult('none');
  }
}

export type LoopTickResult = {
  goalId: string;
  result: LoopRuntimeResult;
};

/**
 * One-pass reconciler tick (design §8): list active goals and run `runLoopOnce`
 * exactly once each, then stop. It never loops, never scans on a timer, and
 * performs zero iterations when there are no active goals. This is the startup
 * / operator trigger surface; it is NOT wired into the server in this mission
 * (the runtime ships inert, manual_only by default).
 */
export async function reconcileLoopTick(
  store: BoundedAutonomousLoopStore,
  dependencies: LoopRuntimeDependencies = {},
): Promise<LoopTickResult[]> {
  const activeGoals = store.listActiveGoals();
  const results: LoopTickResult[] = [];
  for (const goal of activeGoals) {
    // Each goal advances at most one boundary per tick.
    results.push({ goalId: goal.goalId, result: await runLoopOnce(store, goal.goalId, dependencies) });
  }
  return results;
}
