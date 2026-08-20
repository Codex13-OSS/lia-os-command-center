import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import type { ProjectGoalSemanticAssessor } from './projectGoalSatisfactionAssessor.js';
import {
  MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
  MAX_GOALS_PER_TICK,
  type MultiGoalOrchestrationEvidence,
  type MultiGoalOrchestrationHud,
  type MultiGoalOrchestrationResult,
  type MultiGoalPerGoalHudEntry,
  type MultiGoalPerGoalOutcome,
  type MultiGoalSkippedGoal,
} from '../contracts/projectMultiGoalOrchestration.js';
import {
  deriveLoopStage,
  deriveLoopStageDetails,
  runLoopOnce,
  type BoundedAutonomousLoopStore,
  type DerivedLoopStageDetails,
  type LoopStage,
} from './projectBoundedAutonomousLoopRuntime.js';
import {
  launchContinuationTaskIfEligible,
  type ContinuationLaunchDependencies,
} from './projectContinuationExecutionPolicy.js';

/**
 * Multi-Goal Autonomous Orchestration — the deterministic driver that
 * coordinates MANY concurrently-active goals by re-entering the
 * ALREADY-CLOSED single-goal boundaries (design:
 * multi-goal-autonomous-orchestration-design.md).
 *
 * The one non-negotiable invariant (§1): orchestration is permission to
 * re-enter the existing single-goal boundaries for MORE than one goal —
 * NEVER a new authority, NEVER a new engine, NEVER a new durable state
 * machine.
 *
 * - The scheduling unit is the ACTIVE GOAL (`listActiveGoals()`).
 * - "Runnable" is the DERIVED `LoopStage` (pure function of durable rows).
 * - The only authority-exercising call is, per goal, the exact
 *   `launchContinuationTaskIfEligible -> runProjectTaskDurableExecution`
 *   chain the single-goal loop uses.
 * - Deterministic fairness: `createdAt ASC, goalId ASC` (FIFO age + goalId
 *   tie-break) — no new ordering data (F2).
 * - Bounded work: at most MAX_GOALS_PER_TICK goals inspected, at most one
 *   boundary per goal, external executions capped by
 *   MAX_CONCURRENT_EXTERNAL_EXECUTIONS (a durable in-flight count, never
 *   process memory).
 * - Per-goal failure isolation: a corrupt/failing goal is caught, mapped to
 *   a safe bounded result, and never aborts the pass (corrects F6).
 * - Launch decoupling (MQ1): a `next_attempt_accepted` launch is scheduled
 *   via `setImmediate` and NOT awaited, so one goal's external execution
 *   (Hermes -> Codex -> verify -> commit) never blocks the other goals.
 * - No timer, no busy loop, no polling storm, no second engine, no new
 *   durable relation.
 *
 * LÍA remains the sole authority. This driver never writes `intent`, never
 * writes a capability field, never imports `child_process`/`http(s)`/`net`/
 * `dns`, never calls `spawn`/`exec`, and never calls Hermes/Codex directly.
 */

/** The store surface the orchestrator requires — the exact single-goal loop store. */
export type MultiGoalOrchestrationStore = BoundedAutonomousLoopStore;

export type MultiGoalOrchestrationDependencies = {
  /** Clock for expiry/eligibility evaluation (default Date.now). */
  now?: () => number;
  /** No-progress escalation threshold (default 2, clamped to [1, maxAttempts]). */
  noProgressEscalationThreshold?: number;
  /** Layer B assessor forwarded to runLoopOnce for the evaluate boundary. */
  assessor?: ProjectGoalSemanticAssessor;
  /** Launch dependencies forwarded verbatim to launchContinuationTaskIfEligible. */
  launch?: ContinuationLaunchDependencies;
  /** Decoupled-launch scheduler (default `setImmediate`). Test seam only. */
  scheduleDecoupledLaunch?: (launch: () => Promise<void>) => void;
  /** Optional follow-up tick trigger (NOT wired in this mission; default no-op). */
  scheduleFollowupTick?: () => void;
};

/** Non-terminal, runner-owned task statuses that count as in-flight (design §6.3). */
const IN_FLIGHT_TASK_STATUSES = new Set<string>(['planning', 'hermes', 'codex', 'verification', 'commit']);

/** Maps an internal machine-code error to a bounded, non-secret blocking reason. */
function toSafeBlockingReason(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    if (/^[a-z][a-z0-9_]{0,127}$/.test(error.message)) return error.message;
  }
  return 'loop_transition_failed';
}

/**
 * Whether a derived stage is *schedulable* (design §3). This is the exact
 * anti-bypass guarantee: the orchestrator never computes its own eligibility —
 * it reuses the derived stage + the already-computed eligibility verdict.
 */
export function isAdvanceableStage(details: DerivedLoopStageDetails): boolean {
  switch (details.stage) {
    case 'task_terminal':
    case 'continuation_required':
    case 'materializing_next_attempt':
      return true;
    case 'next_attempt_accepted':
      return details.eligibility?.eligible === true;
    default:
      return false;
  }
}

/**
 * Deterministic scheduling order (design §4.1). Filters to advanceable goals
 * and returns their ids in `createdAt ASC, goalId ASC` order — exactly the
 * order `listActiveGoals()` already returns. No new ordering data.
 */
export function deriveGoalSchedulingOrder(
  goals: readonly ProjectGoalRecord[],
  stages: ReadonlyMap<string, DerivedLoopStageDetails>,
): string[] {
  return goals
    .filter((goal) => {
      const details = stages.get(goal.goalId);
      return details !== undefined && isAdvanceableStage(details);
    })
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      if (a.goalId < b.goalId) return -1;
      if (a.goalId > b.goalId) return 1;
      return 0;
    })
    .map((goal) => goal.goalId);
}

/**
 * Durable in-flight external execution count (design §6.3) — a bounded scan of
 * `listActiveGoals()` + `listGoalAttempts()` over the EXISTING rows (the
 * acceptable fallback when the optional read-only count query is absent).
 * Per-goal corruption never aborts the count.
 */
export function countInFlightExternalExecutions(
  store: MultiGoalOrchestrationStore,
  activeGoals: readonly ProjectGoalRecord[],
): number {
  let count = 0;
  for (const goal of activeGoals) {
    try {
      for (const task of store.listGoalAttempts(goal.goalId)) {
        if (IN_FLIGHT_TASK_STATUSES.has(task.status)) count += 1;
      }
    } catch {
      // Corrupt goal: contributes nothing; it cannot be launched anyway and is
      // surfaced as an isolated failure elsewhere.
    }
  }
  return count;
}

/**
 * Bounded, non-secret operator HUD (design §12). Pure read; every field is a
 * direct read of an immutable row or a deterministic derivation. Never exposes
 * secrets, prompts, raw model output, commands, paths, session ids or
 * capability-bearing internals.
 */
export function buildMultiGoalOrchestrationEvidence(
  store: MultiGoalOrchestrationStore,
  options: { now?: () => number; noProgressEscalationThreshold?: number } = {},
): MultiGoalOrchestrationHud {
  const activeGoals = store.listActiveGoals();
  const perGoal: MultiGoalPerGoalHudEntry[] = [];
  let runnable = 0;
  let blockedOnHuman = 0;
  let executing = 0;
  let failedOrSuspended = 0;
  let humanRequired = 0;

  for (const goal of activeGoals) {
    let details: DerivedLoopStageDetails;
    try {
      details = deriveLoopStageDetails(store, goal.goalId, options);
    } catch {
      failedOrSuspended += 1;
      humanRequired += 1;
      perGoal.push({
        goalId: goal.goalId,
        stage: 'failed_closed',
        blockingReason: 'loop_transition_failed',
        humanInterventionRequired: true,
        noProgressCount: 0,
        noProgressThreshold: 2,
        escalated: false,
      });
      continue;
    }

    perGoal.push({
      goalId: goal.goalId,
      stage: details.stage,
      ...(details.blockingReason !== undefined ? { blockingReason: details.blockingReason } : {}),
      humanInterventionRequired: details.humanInterventionRequired,
      noProgressCount: details.noProgressCount,
      noProgressThreshold: details.noProgressThreshold,
      escalated: details.escalated,
    });

    if (isAdvanceableStage(details)) {
      runnable += 1;
    } else if (details.stage === 'authorization_required' || details.stage === 'awaiting_execution') {
      blockedOnHuman += 1;
    } else if (details.stage === 'executing') {
      executing += 1;
    } else {
      failedOrSuspended += 1;
    }
    if (details.humanInterventionRequired) humanRequired += 1;
  }

  const inFlight = countInFlightExternalExecutions(store, activeGoals);

  return {
    activeGoalCount: activeGoals.length,
    runnableGoalCount: runnable,
    blockedOnHumanGoalCount: blockedOnHuman,
    executingGoalCount: executing,
    failedOrSuspendedGoalCount: failedOrSuspended,
    externalExecutionCeiling: MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
    maxGoalsPerTick: MAX_GOALS_PER_TICK,
    inFlight,
    humanInterventionRequiredCount: humanRequired,
    perGoal,
  };
}

const DEFAULT_SCHEDULE_DECOUPLED_LAUNCH = (launch: () => Promise<void>): void => {
  setImmediate(() => { void launch(); });
};

/**
 * A. `reconcileMultiGoalOnce` — one bounded, deterministic orchestration pass.
 *
 * It reads active goals, deterministically orders them, inspects at most
 * MAX_GOALS_PER_TICK goals, selects only advanceable derived stages, advances
 * each selected goal AT MOST one boundary, enforces the external-execution
 * concurrency ceiling, decouples launches so no goal blocks another, isolates
 * every per-goal failure, and returns bounded operator-visible results.
 */
export async function reconcileMultiGoalOnce(
  store: MultiGoalOrchestrationStore,
  dependencies: MultiGoalOrchestrationDependencies = {},
): Promise<MultiGoalOrchestrationResult> {
  const options = {
    ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
    ...(dependencies.noProgressEscalationThreshold !== undefined
      ? { noProgressEscalationThreshold: dependencies.noProgressEscalationThreshold }
      : {}),
  };
  const scheduleLaunch = dependencies.scheduleDecoupledLaunch ?? DEFAULT_SCHEDULE_DECOUPLED_LAUNCH;
  const scheduleFollowup = dependencies.scheduleFollowupTick ?? ((): void => { /* not wired */ });

  // 1. Active goals (already createdAt ASC, goal_id ASC).
  const activeGoals = store.listActiveGoals();

  // 2. Derive stages (pure read), isolating each goal's derivation.
  const stages = new Map<string, DerivedLoopStageDetails>();
  const derivationFailures = new Map<string, string>();
  for (const goal of activeGoals) {
    try {
      stages.set(goal.goalId, deriveLoopStageDetails(store, goal.goalId, options));
    } catch (error) {
      derivationFailures.set(goal.goalId, toSafeBlockingReason(error));
    }
  }

  // 3. Deterministic order of advanceable goals.
  const order = deriveGoalSchedulingOrder(activeGoals, stages);

  // 4. Durable in-flight count at pass start.
  const inFlight = countInFlightExternalExecutions(store, activeGoals);

  let localInFlight = inFlight;
  const results: MultiGoalPerGoalOutcome[] = [];
  const skipped: MultiGoalSkippedGoal[] = [];
  let isolatedFailures = derivationFailures.size;
  let selectedCount = 0;
  let launchedCount = 0;
  let synchronousProgressCount = 0;

  // Surface every non-advanceable goal with its safe blocking reason, and
  // every goal whose stage derivation failed (corrupt goal isolation).
  for (const goal of activeGoals) {
    const details = stages.get(goal.goalId);
    if (details === undefined) {
      skipped.push({ goalId: goal.goalId, reason: derivationFailures.get(goal.goalId) ?? 'loop_transition_failed' });
      continue;
    }
    if (!isAdvanceableStage(details)) {
      skipped.push({ goalId: goal.goalId, reason: details.blockingReason ?? details.stage });
    }
  }

  // 5. Iterate the advanceable order, selecting at most MAX_GOALS_PER_TICK.
  const inspectedIds = order.slice(0, MAX_GOALS_PER_TICK);
  for (const goalId of inspectedIds) {
    const details = stages.get(goalId);
    if (details === undefined) continue; // derivation failure already surfaced

    const stage: LoopStage = details.stage;

    if (stage === 'next_attempt_accepted') {
      // Launchable only when eligible (already asserted by the order filter).
      if (dependencies.launch === undefined) {
        skipped.push({ goalId, reason: 'launch_dependencies_missing' });
        continue;
      }
      if (localInFlight >= MAX_CONCURRENT_EXTERNAL_EXECUTIONS) {
        skipped.push({ goalId, reason: 'concurrency_ceiling_reached' });
        continue;
      }
      const taskId = details.nextTask?.taskId;
      if (taskId === undefined) {
        skipped.push({ goalId, reason: 'corrupt_lineage' });
        continue;
      }

      // Decouple the launch: never await the runner (design §9.3 / MQ1). The
      // durable at-most-once Launch-Attempt gate + eligibility re-check inside
      // launchContinuationTaskIfEligible preserve fail-closed semantics, and
      // duplicate wakeups converge through the same gate.
      scheduleLaunch(async () => {
        try {
          await launchContinuationTaskIfEligible(store, taskId, dependencies.launch!);
          scheduleFollowup();
        } catch {
          // fail closed: never blind-retry; durable state reflects the outcome.
        }
      });
      localInFlight += 1;
      launchedCount += 1;
      selectedCount += 1;
      results.push({
        goalId,
        stageBefore: stage,
        stageAfter: deriveLoopStage(store, goalId, options),
        action: 'launched',
        decoupledLaunch: true,
        humanInterventionRequired: false,
        isolatedFailure: false,
      });
      continue;
    }

    // Non-launch advanceable stage: synchronous single-writer write.
    try {
      const result = await runLoopOnce(store, goalId, {
        ...options,
        ...(dependencies.assessor !== undefined ? { assessor: dependencies.assessor } : {}),
        // Deliberately NO launch deps: the multi-goal driver never lets
        // runLoopOnce synchronously await an external execution.
      });
      const advanced = result.action !== 'none' && result.action !== 'held';
      if (advanced) {
        selectedCount += 1;
        synchronousProgressCount += 1;
      }
      results.push({
        goalId,
        stageBefore: result.stageBefore,
        stageAfter: result.stageAfter,
        action: result.action,
        decoupledLaunch: false,
        ...(result.blockingReason !== undefined ? { blockingReason: result.blockingReason } : {}),
        humanInterventionRequired: result.humanInterventionRequired,
        isolatedFailure: false,
      });
    } catch (error) {
      isolatedFailures += 1;
      results.push({
        goalId,
        stageBefore: stage,
        stageAfter: stage,
        action: 'isolated',
        decoupledLaunch: false,
        blockingReason: toSafeBlockingReason(error),
        humanInterventionRequired: true,
        isolatedFailure: true,
      });
    }
  }

  const truncated = order.length > inspectedIds.length;
  const ceilingSkipped = skipped.some((entry) => entry.reason === 'concurrency_ceiling_reached');
  const boundedAdvanceableAfterPass = synchronousProgressCount > 0 && activeGoals.some((goal) => {
    try {
      const details = deriveLoopStageDetails(store, goal.goalId, options);
      return details.mode === 'bounded_autonomous' && isAdvanceableStage(details);
    } catch {
      return false;
    }
  });
  const evidence: MultiGoalOrchestrationEvidence = {
    activeGoalCount: activeGoals.length,
    inspectedGoalCount: inspectedIds.length,
    selectedGoalCount: selectedCount,
    externalExecutionSlotsUsed: launchedCount,
    externalExecutionCeiling: MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
    inFlight,
    isolatedFailureCount: isolatedFailures,
    moreWorkRemains: truncated || ceilingSkipped || boundedAdvanceableAfterPass,
  };

  return { order, results, skipped, evidence };
}
