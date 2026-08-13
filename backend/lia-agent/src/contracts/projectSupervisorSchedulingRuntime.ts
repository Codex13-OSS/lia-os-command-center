import type { MultiGoalOrchestrationHud } from './projectMultiGoalOrchestration.js';

/**
 * Supervisor Scheduling Runtime Wiring — scheduling vocabulary + bounded,
 * non-secret operator-visible shapes
 * (design: supervisor-scheduling-runtime-wiring-design.md).
 *
 * This module carries ONLY constants and data shapes. It carries no
 * authority, no capability, no engine, no timer, no cron, no polling. The
 * supervisor it describes is transport/control-flow only: it wakes the
 * ALREADY-CLOSED bounded multi-goal pass (`reconcileMultiGoalOnce`) at most
 * one pass at a time, coalesces duplicate wakeups, and re-derives everything
 * from durable rows so a restart never depends on a surviving callback.
 *
 * LÍA remains the sole authority. Nothing here can approve a plan, create an
 * execution authorization, widen a capability ceiling, or start a second
 * execution engine.
 */

/** Scheduler states visible to the operator (mission §9). */
export const SUPERVISOR_STATES = [
  'unsupported',
  'idle',
  'pending',
  'running',
  'fail_closed',
] as const;
export type SupervisorState = (typeof SUPERVISOR_STATES)[number];

/**
 * Wakeup sources. Only the sanctioned event-driven triggers exist:
 * - `startup`: the single bounded opportunity per process start
 * - `terminalization`: a durable task reached a terminal state
 * - `operator`: explicit operator-triggered pass
 * - `followup`: bounded coalesced continuation of a truncated pass
 *
 * There is deliberately no periodic/cron/polling source.
 */
export const SUPERVISOR_WAKEUP_SOURCES = [
  'startup',
  'terminalization',
  'operator',
  'followup',
] as const;
export type SupervisorWakeupSource = (typeof SUPERVISOR_WAKEUP_SOURCES)[number];

/** Bounded per-goal fragment of the last pass. Never exposes secrets. */
export type SupervisorPerGoalOutcomeSummary = {
  goalId: string;
  stageBefore: string;
  stageAfter: string;
  action: string;
  decoupledLaunch: boolean;
  humanInterventionRequired: boolean;
  isolatedFailure: boolean;
  blockingReason?: string;
};

/** A goal that was inspected but not advanced during the last pass. */
export type SupervisorSkippedGoalSummary = {
  goalId: string;
  reason: string;
};

/**
 * Bounded, non-secret summary of one completed reconciliation pass.
 * Aggregate counts plus per-goal outcomes; never prompts, raw model output,
 * commands, paths, session ids, secrets or capability-bearing internals.
 */
export type SupervisorLastPassSummary = {
  /** Wall-clock (or injected clock) instant the pass completed. */
  at: number;
  source: SupervisorWakeupSource;
  activeGoalCount: number;
  inspectedGoalCount: number;
  selectedGoalCount: number;
  externalExecutionSlotsUsed: number;
  externalExecutionCeiling: number;
  /** Durable in-flight external executions at pass start. */
  inFlight: number;
  isolatedFailureCount: number;
  moreWorkRemains: boolean;
  /** True when more advanceable goals remain than one pass may inspect. */
  truncated: boolean;
  outcomes: SupervisorPerGoalOutcomeSummary[];
  skipped: SupervisorSkippedGoalSummary[];
};

/**
 * Read-only operator HUD (mission §9). Safe bounded facts only: scheduler
 * state, pending wakeup, pass-in-progress, fail-closed latch, last pass
 * summary, and the pure-read multi-goal counts. Never exposes secrets,
 * prompts, provider/session identifiers, or raw internal exceptions.
 */
export type ProjectSupervisorHud = {
  state: SupervisorState;
  enabled: boolean;
  supported: boolean;
  pendingWakeup: boolean;
  passInProgress: boolean;
  failClosed: boolean;
  lastPass?: SupervisorLastPassSummary;
  /** Safe machine-code reason for the fail-closed latch. */
  lastFailureReason?: string;
  goals?: MultiGoalOrchestrationHud;
  /** True when the read-only goal evidence could not be derived this call. */
  goalsReadFailure?: boolean;
};

/**
 * Result of the explicit operator-triggered pass. The operator pass is
 * inline and bounded; it never queues behind other wakeups and never runs
 * concurrently with another pass.
 */
export type ProjectSupervisorOperatorPassResult =
  | { ok: true; pass: SupervisorLastPassSummary }
  | { ok: false; code: 'pass_in_progress' | 'supervisor_unsupported' | 'pass_failed_closed'; reason?: string };
