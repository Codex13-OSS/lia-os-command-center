import { createHash } from 'node:crypto';
import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';
import type {
  ProjectGoalEvaluationDecision,
  ProjectGoalEvaluationReasonCode,
  ProjectGoalEvaluationRecord,
} from '../contracts/projectGoalEvaluation.js';
import type {
  CreateProjectGoalContinuationPlanInput,
  ProjectGoalContinuationPlanReasonCode,
  ProjectGoalContinuationPlanRecord,
} from '../contracts/projectGoalContinuationPlan.js';
import { CONTINUATION_PLANNER_VERSION } from '../contracts/projectGoalContinuationPlan.js';
import {
  AUTONOMOUS_V1_CEILING,
  AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES,
} from '../contracts/autonomousAuthority.js';
import {
  buildDeterministicContinuationInstruction,
  isSafeContinuationInstruction,
} from './projectContinuationPlanner.js';

/**
 * Goal Continuation Planning — the FIRST autonomy boundary ABOVE the applied
 * Q3 Goal Evaluation (design: goal-continuation-planning-design.md).
 *
 * It consumes an applied, durable `retryable` evaluation and produces — when
 * the deterministic gates open — one durable `planned` continuation plan using
 * the EXISTING `createContinuationPlan` primitive. It ends there.
 *
 * This boundary NEVER materializes, NEVER creates a task, NEVER dispatches,
 * NEVER leases and NEVER executes. Its ONLY durable write is
 * `createContinuationPlan`. Materialization/execution is the NEXT boundary and
 * is human-gated by default (MQ2).
 *
 * Authority model (ratified):
 *  - LÍA's deterministic planner is authoritative. Hermes may be advisory /
 *    reasoning-only but cannot grant authority or override LÍA validation.
 *  - A plan is intent metadata only: no capability, no execution field.
 *  - No-progress escalation threshold = 2 consecutive identical no-progress
 *    continuation cycles (MQ3).
 *  - Single-task continuation first (no DAG, no fan-out).
 */

/**
 * The store surface this orchestrator requires. It is a STRICT subset of the
 * SQLite store: it deliberately exposes no materializeContinuation, no task
 * creation, no dispatch/lease/execution methods. That absence is a structural
 * guarantee that planning can never cross into execution.
 */
export interface ProjectGoalContinuationPlanningStore {
  readGoal(goalId: string): ProjectGoalRecord | undefined;
  listGoalAttempts(goalId: string): ProjectTaskRecord[];
  readGoalEvaluation(evaluationId: string): ProjectGoalEvaluationRecord | undefined;
  readLatestGoalEvaluation(goalId: string): ProjectGoalEvaluationRecord | undefined;
  listGoalEvaluations(goalId: string): ProjectGoalEvaluationRecord[];
  createContinuationPlan(
    input: CreateProjectGoalContinuationPlanInput,
  ): ProjectGoalContinuationPlanRecord;
  readContinuationPlan(planId: string): ProjectGoalContinuationPlanRecord | undefined;
  readContinuationPlanBySourceEvaluation(
    sourceEvaluationId: string,
    plannerVersion?: typeof CONTINUATION_PLANNER_VERSION,
  ): ProjectGoalContinuationPlanRecord | undefined;
  listGoalContinuationPlans(goalId: string): ProjectGoalContinuationPlanRecord[];
  assertContinuationPlanUsable(planId: string): ProjectGoalContinuationPlanRecord;
}

export const PROJECT_GOAL_CONTINUATION_PLANNING_ERRORS = {
  goalNotFound: 'project_goal_continuation_planning_goal_not_found',
  evaluationNotFound: 'project_goal_continuation_planning_evaluation_not_found',
  goalMismatch: 'project_goal_continuation_planning_goal_mismatch',
  parentNotFound: 'project_goal_continuation_planning_parent_not_found',
  evaluationNotApplied: 'project_goal_continuation_planning_evaluation_not_applied',
} as const;

/** Benign no-plan refusals. These are legitimate verdicts that simply require no continuation. */
export const PROJECT_GOAL_CONTINUATION_PLANNING_REFUSALS = {
  goalTerminal: 'goal_terminal',
  evaluationNotRetryable: 'evaluation_not_retryable',
  noProgressEscalation: 'no_progress_escalation',
} as const;
export type PlanningRefusalReason =
  (typeof PROJECT_GOAL_CONTINUATION_PLANNING_REFUSALS)[keyof typeof PROJECT_GOAL_CONTINUATION_PLANNING_REFUSALS];

export const DEFAULT_NO_PROGRESS_ESCALATION_THRESHOLD = 2;

/** Bounded, non-secret operator evidence. Never exposes capabilities, paths, commands or raw model output. */
export type OperatorVisibleContinuationPlanEvidence = {
  goalId: string;
  goalObjective: string;
  verdict: {
    decision: ProjectGoalEvaluationDecision;
    reasonCode: ProjectGoalEvaluationReasonCode;
    summary: string;
    evidenceFingerprint: string;
  };
  planExists: boolean;
  planId?: string;
  planStatus?: string;
  nextObjective?: string;
  planReasonCode?: ProjectGoalContinuationPlanReasonCode;
  parentTaskId?: string;
  parentAttemptNumber?: number;
  nextAttemptNumber?: number;
  nextContinuationDepth?: number;
  maxAttempts: number;
  continuationDepthLimit: number;
  /** True exactly when a `planned` plan awaits the human-gated materialization decision. */
  materializationPending: boolean;
  /** Hard invariant: this boundary never executes continuation. Always false. */
  continuationExecuted: false;
  escalation: {
    detected: boolean;
    consecutiveNoProgress: number;
    threshold: number;
    reason?: string;
  };
};

/**
 * Optional advisory (reasoning-only, MQ1) instruction proposer. Disabled by
 * default: the deterministic planner is the sole authority for v1. A proposal
 * can only ever be advisory — it is never persisted and never grants authority.
 */
export type ContinuationInstructionProposer = (input: {
  goal: ProjectGoalRecord;
  evaluation: ProjectGoalEvaluationRecord;
  parent: ProjectTaskRecord;
  deterministicInstruction: string;
  reasonCode: ProjectGoalContinuationPlanReasonCode;
}) => string | undefined | Promise<string | undefined>;

export type ProjectGoalContinuationPlanningDependencies = {
  /** Bind an exact applied evaluation. Defaults to the latest applied evaluation for the goal. */
  sourceEvaluationId?: string;
  /** Advisory (reasoning-only) proposer. Absent => purely deterministic (MQ1 default). */
  proposeInstruction?: ContinuationInstructionProposer;
  /** No-progress escalation threshold (default 2, clamped to [1, maxAttempts]). */
  noProgressEscalationThreshold?: number;
};

export type GoalContinuationPlanningOutcome = {
  goal: ProjectGoalRecord;
  evaluation: ProjectGoalEvaluationRecord;
  planned: boolean;
  plan?: ProjectGoalContinuationPlanRecord;
  escalated: boolean;
  refusalReason?: PlanningRefusalReason;
  noProgressCount: number;
  noProgressThreshold: number;
  visiblePlan: OperatorVisibleContinuationPlanEvidence;
};

const MAX_VISIBLE_OBJECTIVE_CHARS = 2_000;

/** A retryable evaluation counts as "no progress" only for the non-`partial_result` retryable reasons. */
export function isNoProgressEvaluation(evaluation: ProjectGoalEvaluationRecord): boolean {
  return evaluation.decision === 'retryable' && evaluation.reasonCode !== 'partial_result';
}

/**
 * Lineage-independent no-progress signature: the durable evidence that matters
 * for "same failure, same evidence" across attempts. It deliberately excludes
 * lineage (`attemptNumber`/`continuationDepth`/`parentTaskId`) and
 * `goal.currentAttempt`, which differ between attempts by construction and are
 * not evidence of progress.
 */
function noProgressEvidenceSnapshot(
  evaluation: ProjectGoalEvaluationRecord,
  task: ProjectTaskRecord,
): Record<string, unknown> {
  return {
    reasonCode: evaluation.reasonCode,
    taskStatus: task.status,
    receipt: task.receipt === undefined
      ? null
      : {
        status: task.receipt.status,
        verification: task.receipt.verification ?? null,
        stages: task.receipt.stages ?? null,
        hasCommit: task.receipt.commit !== undefined,
      },
    error: task.error === undefined
      ? null
      : {
        code: task.error.code,
        stage: task.error.stage ?? null,
        completedStages: task.error.completedStages ?? null,
      },
  };
}

export function continuationNoProgressSignature(
  evaluation: ProjectGoalEvaluationRecord,
  task: ProjectTaskRecord,
): string {
  return createHash('sha256')
    .update(JSON.stringify(noProgressEvidenceSnapshot(evaluation, task)))
    .digest('hex');
}

/**
 * Counts the consecutive applied no-progress evaluations ending at the given
 * evaluation (inclusive), where "identical" means the same lineage-independent
 * no-progress signature. A partial-result or terminal evaluation breaks the run.
 */
export function countConsecutiveNoProgressCycles(
  evaluations: readonly ProjectGoalEvaluationRecord[],
  resolveTask: (taskId: string) => ProjectTaskRecord | undefined,
  currentEvaluationId: string,
): number {
  const applied = evaluations.filter((evaluation) => evaluation.appliedAt !== undefined);
  const index = applied.findIndex((evaluation) => evaluation.evaluationId === currentEvaluationId);
  if (index < 0) return 0;
  const current = applied[index];
  if (!isNoProgressEvaluation(current)) return 0;
  const currentTask = resolveTask(current.taskId);
  if (currentTask === undefined) return 0;
  const signature = continuationNoProgressSignature(current, currentTask);
  let count = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const evaluation = applied[cursor];
    if (!isNoProgressEvaluation(evaluation)) break;
    const task = resolveTask(evaluation.taskId);
    if (task === undefined) break;
    if (continuationNoProgressSignature(evaluation, task) !== signature) break;
    count += 1;
  }
  return count;
}

export function resolveNoProgressThreshold(
  configured: number | undefined,
  goal: ProjectGoalRecord,
): number {
  if (configured === undefined || !Number.isInteger(configured) || configured < 1) {
    return DEFAULT_NO_PROGRESS_ESCALATION_THRESHOLD;
  }
  // MQ3: the threshold may never exceed the goal's attempt budget.
  return Math.min(configured, goal.maxAttempts);
}

/**
 * A structured continuation proposal. It carries ONLY lineage binding plus an
 * optional advisory instruction refinement. Any capability/steps/dependency key
 * is structurally rejected.
 */
export type ContinuationPlanningProposal = {
  goalId: string;
  sourceEvaluationId: string;
  sourceEvidenceFingerprint: string;
  instruction?: string;
};

export type ContinuationPlanningContext = {
  goal: ProjectGoalRecord;
  evaluation: ProjectGoalEvaluationRecord;
  parent: ProjectTaskRecord;
  /** Current policy read at validation time. Defaults to the backend-owned V1 ceiling. */
  capabilityCeiling?: readonly string[];
  forbiddenCapabilities?: readonly string[];
};

export type ContinuationProposalValidation =
  | { ok: true; instruction: string; reasonCode: ProjectGoalContinuationPlanReasonCode }
  | { ok: false; reason: string };

const PROPOSAL_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'goalId',
  'sourceEvaluationId',
  'sourceEvidenceFingerprint',
  'instruction',
]);

/**
 * Deterministic LÍA proposal validation (design §5). Pure function of immutable
 * durable state + the current policy read. Every failure rejects the proposal;
 * the orchestrator falls back to the deterministic instruction where safe, else
 * produces no plan (fail closed).
 */
export function validateContinuationProposal(
  proposal: ContinuationPlanningProposal,
  context: ContinuationPlanningContext,
): ContinuationProposalValidation {
  const { goal, evaluation, parent } = context;

  // §5.3 / §5.6: structural — a proposal with any unknown key (capability,
  // steps, dependency, command, etc.) is rejected outright.
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    return { ok: false, reason: 'invalid_proposal' };
  }
  for (const key of Object.keys(proposal)) {
    if (!PROPOSAL_ALLOWED_KEYS.has(key)) return { ok: false, reason: 'forbidden_proposal_field' };
  }

  // §5.1 / §5.2: exact goal + evaluation lineage.
  if (proposal.goalId !== goal.goalId || proposal.goalId !== evaluation.goalId) {
    return { ok: false, reason: 'goal_mismatch' };
  }
  if (proposal.sourceEvaluationId !== evaluation.evaluationId) {
    return { ok: false, reason: 'evaluation_mismatch' };
  }
  if (proposal.sourceEvidenceFingerprint !== evaluation.evidenceFingerprint) {
    return { ok: false, reason: 'evidence_conflict' };
  }
  if (evaluation.appliedAt === undefined) {
    return { ok: false, reason: 'evaluation_not_applied' };
  }
  if (evaluation.decision !== 'retryable') {
    return { ok: false, reason: 'evaluation_not_retryable' };
  }

  // §5.11: no continuation after satisfied/terminal.
  if (goal.status !== 'active') {
    return { ok: false, reason: 'goal_terminal' };
  }

  // §5.1 / §5.9: the parent must be the evaluated current attempt.
  const lineage = parent.lineage;
  if (
    lineage === undefined
    || lineage.goalId !== goal.goalId
    || lineage.attemptNumber !== evaluation.attemptNumber
    || goal.currentAttempt !== evaluation.attemptNumber
  ) {
    return { ok: false, reason: 'stale_attempt' };
  }

  // §5.8: bounded retry budget.
  if (lineage.attemptNumber + 1 >= goal.maxAttempts) {
    return { ok: false, reason: 'attempt_limit' };
  }
  if (lineage.continuationDepth + 1 > goal.continuationDepthLimit) {
    return { ok: false, reason: 'depth_limit' };
  }

  // §5.12: current policy re-evaluation — inherited parent capabilities must
  // remain inside the ceiling and outside the forbidden set. A plan itself
  // carries NO capabilities; this only proves the inherited set is still safe.
  const ceiling = context.capabilityCeiling ?? AUTONOMOUS_V1_CEILING;
  const forbidden = context.forbiddenCapabilities ?? AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES;
  for (const capability of parent.intent.requestedCapabilities) {
    if (!ceiling.includes(capability)) return { ok: false, reason: 'capability_outside_ceiling' };
    if (forbidden.includes(capability)) return { ok: false, reason: 'forbidden_capability' };
  }

  // Deterministic floor (§4/§5): the durable instruction is always derived
  // mechanically from the immutable goal/evaluation/parent.
  let deterministic;
  try {
    deterministic = buildDeterministicContinuationInstruction(goal, evaluation, parent);
  } catch {
    return { ok: false, reason: 'evaluation_not_retryable' };
  }

  // §5.4 / §4: an advisory instruction (if present) must itself be safe and
  // authority-free. In v1 it can only ever narrow the deterministic floor.
  let instruction = deterministic.instruction;
  if (proposal.instruction !== undefined) {
    if (!isSafeContinuationInstruction(proposal.instruction)) {
      return { ok: false, reason: 'unsafe_instruction' };
    }
    instruction = proposal.instruction;
  }

  return { ok: true, instruction, reasonCode: deterministic.reasonCode };
}

export function buildContinuationPlanVisibleEvidence(
  goal: ProjectGoalRecord,
  evaluation: ProjectGoalEvaluationRecord,
  plan: ProjectGoalContinuationPlanRecord | undefined,
  escalation: {
    detected: boolean;
    consecutiveNoProgress: number;
    threshold: number;
    reason?: string;
  },
): OperatorVisibleContinuationPlanEvidence {
  const planExists = plan !== undefined;
  return {
    goalId: goal.goalId,
    goalObjective: goal.objective.slice(0, MAX_VISIBLE_OBJECTIVE_CHARS),
    verdict: {
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
      summary: evaluation.summary,
      evidenceFingerprint: evaluation.evidenceFingerprint,
    },
    planExists,
    ...(plan !== undefined
      ? {
        planId: plan.planId,
        planStatus: plan.status,
        nextObjective: plan.instruction,
        planReasonCode: plan.reasonCode,
        parentTaskId: plan.parentTaskId,
        parentAttemptNumber: plan.parentAttemptNumber,
        nextAttemptNumber: plan.nextAttemptNumber,
        nextContinuationDepth: plan.nextContinuationDepth,
      }
      : {}),
    maxAttempts: goal.maxAttempts,
    continuationDepthLimit: goal.continuationDepthLimit,
    materializationPending: planExists && plan.status === 'planned',
    continuationExecuted: false,
    escalation,
  };
}

/**
 * LIVE Q3 → CONTINUATION PLAN WIRING (the planning boundary).
 *
 * Reads the applied, durable goal evaluation and — subject to the deterministic
 * gates (§2), the LÍA proposal validator (§5) and the no-progress escalation
 * hook (§10) — persists one durable `planned` continuation plan through the
 * existing `createContinuationPlan` primitive.
 *
 * Idempotent on exact replay; fail-closed on contradiction/stale lineage/corrupt
 * evaluation. It never materializes, never creates a task, never executes.
 */
export async function planGoalContinuation(
  store: ProjectGoalContinuationPlanningStore,
  goalId: string,
  dependencies: ProjectGoalContinuationPlanningDependencies = {},
): Promise<GoalContinuationPlanningOutcome> {
  const goal = store.readGoal(goalId);
  if (goal === undefined) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLANNING_ERRORS.goalNotFound);
  }

  const sourceEvaluationId = dependencies.sourceEvaluationId
    ?? store.readLatestGoalEvaluation(goalId)?.evaluationId;
  if (sourceEvaluationId === undefined) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLANNING_ERRORS.evaluationNotFound);
  }
  const evaluation = store.readGoalEvaluation(sourceEvaluationId);
  if (evaluation === undefined) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLANNING_ERRORS.evaluationNotFound);
  }
  if (evaluation.goalId !== goalId) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLANNING_ERRORS.goalMismatch);
  }

  const threshold = resolveNoProgressThreshold(dependencies.noProgressEscalationThreshold, goal);
  const evaluations = store.listGoalEvaluations(goalId);
  const attempts = store.listGoalAttempts(goalId);
  const resolveTask = (taskId: string): ProjectTaskRecord | undefined =>
    attempts.find((attempt) => attempt.taskId === taskId);

  const parent = resolveTask(evaluation.taskId);
  if (parent === undefined) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLANNING_ERRORS.parentNotFound);
  }

  const noProgressCount = countConsecutiveNoProgressCycles(
    evaluations,
    resolveTask,
    evaluation.evaluationId,
  );
  const escalated = noProgressCount >= threshold;

  const buildNoPlanOutcome = (refusalReason: PlanningRefusalReason): GoalContinuationPlanningOutcome => ({
    goal,
    evaluation,
    planned: false,
    escalated,
    refusalReason,
    noProgressCount,
    noProgressThreshold: threshold,
    visiblePlan: buildContinuationPlanVisibleEvidence(goal, evaluation, undefined, {
      detected: escalated,
      consecutiveNoProgress: noProgressCount,
      threshold,
      reason: escalated ? PROJECT_GOAL_CONTINUATION_PLANNING_REFUSALS.noProgressEscalation : undefined,
    }),
  });

  // §2: planning opens ONLY from an applied, retryable verdict on an active goal.
  if (evaluation.appliedAt === undefined) {
    throw new Error(PROJECT_GOAL_CONTINUATION_PLANNING_ERRORS.evaluationNotApplied);
  }
  if (evaluation.decision !== 'retryable') {
    return buildNoPlanOutcome(PROJECT_GOAL_CONTINUATION_PLANNING_REFUSALS.evaluationNotRetryable);
  }
  if (goal.status !== 'active') {
    return buildNoPlanOutcome(PROJECT_GOAL_CONTINUATION_PLANNING_REFUSALS.goalTerminal);
  }

  // §10: repeated no-progress escalation gates planning with NO durable write.
  if (escalated) {
    return buildNoPlanOutcome(PROJECT_GOAL_CONTINUATION_PLANNING_REFUSALS.noProgressEscalation);
  }

  // §5: deterministic LÍA validation of the proposal derived from durable state.
  const validation = validateContinuationProposal(
    {
      goalId: goal.goalId,
      sourceEvaluationId: evaluation.evaluationId,
      sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
    },
    { goal, evaluation, parent },
  );
  if (!validation.ok) {
    // The validator's remaining refusals are all fail-closed conditions the
    // store enforces identically. Surface them as errors.
    throw new Error(`project_goal_continuation_planning_${validation.reason}`);
  }

  // §4 / MQ1: optional advisory (reasoning-only) Hermes proposal. Disabled by
  // default. A proposal is advisory only: invalid/escalating advice is ignored
  // and NO proposal is ever persisted — the durable plan is always the
  // deterministic floor.
  if (dependencies.proposeInstruction !== undefined) {
    await dependencies.proposeInstruction({
      goal,
      evaluation,
      parent,
      deterministicInstruction: validation.instruction,
      reasonCode: validation.reasonCode,
    });
    // Whatever the proposer returns (safe or escalating) is advisory only:
    // the raw response is discarded here and never persisted.
    // createContinuationPlan below persists the deterministic instruction only.
  }

  // §9 / §12: the ONLY write is createContinuationPlan (idempotent, fail-closed).
  const plan = store.createContinuationPlan({
    goalId: goal.goalId,
    sourceEvaluationId: evaluation.evaluationId,
    plannerVersion: CONTINUATION_PLANNER_VERSION,
    sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
  });

  return {
    goal,
    evaluation,
    planned: true,
    plan,
    escalated: false,
    noProgressCount,
    noProgressThreshold: threshold,
    visiblePlan: buildContinuationPlanVisibleEvidence(goal, evaluation, plan, {
      detected: false,
      consecutiveNoProgress: noProgressCount,
      threshold,
    }),
  };
}
