import type { LoopAction, LoopStage } from '../services/projectBoundedAutonomousLoopRuntime.js';

/**
 * Multi-Goal Autonomous Orchestration — scheduling vocabulary + bounded,
 * non-secret operator-visible result/evidence shapes
 * (design: multi-goal-autonomous-orchestration-design.md).
 *
 * The scheduling unit is the ACTIVE GOAL (`project_goals` row). "Runnable" is
 * never persisted — it is the DERIVED `LoopStage`, a pure function of existing
 * durable rows. This module carries ONLY constants and data shapes: no
 * authority, no capability, no engine.
 */

/** Maximum advanceable goals selected per orchestration pass (design §5.1). */
export const MAX_GOALS_PER_TICK = 8;

/**
 * Maximum concurrent external executions (Hermes -> Codex) initiated by the
 * orchestrator (design §5.1). Enforced as a DURABLE in-flight count, never
 * process memory. Never unbounded.
 */
export const MAX_CONCURRENT_EXTERNAL_EXECUTIONS = 2;

/**
 * Deterministic total-order scheduling key. The order is exactly
 * `createdAt ASC, goalId ASC` — the order `listActiveGoals()` already returns,
 * so no new ordering data is required (design §4.1).
 */
export type GoalSchedulingOrderKey = {
  createdAt: number;
  goalId: string;
};

/**
 * Action vocabulary for a per-goal orchestration outcome. It extends the
 * single-goal `LoopAction` with the two multi-goal-specific outcomes:
 * `skipped` (inspected but not advanced — ceiling reached / ineligible / no
 * launch deps) and `isolated` (a thrown transition was caught per goal).
 */
export type MultiGoalAction = LoopAction | 'skipped' | 'isolated';

/**
 * Bounded, non-secret per-goal outcome. Never exposes prompts, raw model
 * output, commands, paths, session ids, secrets or capability-bearing
 * internals.
 */
export type MultiGoalPerGoalOutcome = {
  goalId: string;
  /** Derived stage when the goal was inspected this pass. */
  stageBefore: LoopStage;
  /** Derived stage after the (at most one) boundary. For a decoupled launch the
   * durable boundary has not yet advanced, so this is re-derived truthfully. */
  stageAfter: LoopStage;
  action: MultiGoalAction;
  /** True when a `next_attempt_accepted` boundary was launched without awaiting
   * the runner (design §9.3 / MQ1). */
  decoupledLaunch: boolean;
  /** Safe machine-code blocking reason, when the goal was not advanced. */
  blockingReason?: string;
  humanInterventionRequired: boolean;
  /** True when this goal's transition threw and was caught per goal (§8). */
  isolatedFailure: boolean;
};

/** A goal that was inspected but not advanced, with a safe reason. */
export type MultiGoalSkippedGoal = {
  goalId: string;
  reason: string;
};

/** Aggregate, bounded operator evidence for one orchestration pass (mission G). */
export type MultiGoalOrchestrationEvidence = {
  activeGoalCount: number;
  /** Number of advanceable goals actually examined this pass (<= MAX_GOALS_PER_TICK). */
  inspectedGoalCount: number;
  /** Number of inspected goals that advanced a boundary (or launched, decoupled). */
  selectedGoalCount: number;
  /** External executions initiated this pass (decoupled launches). */
  externalExecutionSlotsUsed: number;
  externalExecutionCeiling: number;
  /** Durable in-flight external executions at pass start. */
  inFlight: number;
  isolatedFailureCount: number;
  /** True when more advanceable work remains beyond this pass. */
  moreWorkRemains: boolean;
};

export type MultiGoalOrchestrationResult = {
  /** Deterministic advanceable order (design §4.1): createdAt ASC, goalId ASC. */
  order: string[];
  /** Per-goal outcomes for the goals that were acted on this pass (bounded). */
  results: MultiGoalPerGoalOutcome[];
  /** Inspected-but-not-advanced goals plus derivation-failed goals, with reasons. */
  skipped: MultiGoalSkippedGoal[];
  evidence: MultiGoalOrchestrationEvidence;
};

/** One safe per-goal fragment of the operator HUD (design §12). */
export type MultiGoalPerGoalHudEntry = {
  goalId: string;
  stage: LoopStage;
  blockingReason?: string;
  humanInterventionRequired: boolean;
  noProgressCount: number;
  noProgressThreshold: number;
  escalated: boolean;
};

/** Pure-read aggregate operator HUD (design §12). Never exposes secrets. */
export type MultiGoalOrchestrationHud = {
  activeGoalCount: number;
  runnableGoalCount: number;
  blockedOnHumanGoalCount: number;
  executingGoalCount: number;
  failedOrSuspendedGoalCount: number;
  externalExecutionCeiling: number;
  maxGoalsPerTick: number;
  inFlight: number;
  humanInterventionRequiredCount: number;
  perGoal: MultiGoalPerGoalHudEntry[];
};
