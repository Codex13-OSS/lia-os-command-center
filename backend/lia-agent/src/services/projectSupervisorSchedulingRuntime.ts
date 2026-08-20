import { randomUUID } from 'node:crypto';
import type { LiaAgentConfig } from '../config.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { ProjectTaskStage } from '../contracts/projectTask.js';
import type { ProjectTaskWorkflowResult } from '../contracts/projectTaskWorkflow.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import { MAX_GOALS_PER_TICK } from '../contracts/projectMultiGoalOrchestration.js';
import type {
  ProjectSupervisorHud,
  ProjectSupervisorOperatorPassResult,
  SupervisorLastPassSummary,
  SupervisorState,
  SupervisorWakeupSource,
} from '../contracts/projectSupervisorSchedulingRuntime.js';
import type { ProjectGoalSemanticAssessor } from './projectGoalSatisfactionAssessor.js';
import {
  buildMultiGoalOrchestrationEvidence,
  reconcileMultiGoalOnce,
  type MultiGoalOrchestrationDependencies,
  type MultiGoalOrchestrationStore,
} from './projectMultiGoalAutonomousOrchestrator.js';

/**
 * Supervisor Scheduling Runtime Wiring (design:
 * supervisor-scheduling-runtime-wiring-design.md).
 *
 * The supervisor is TRANSPORT / CONTROL-FLOW ONLY. It owns no durable state,
 * no capability, no engine, no timer, no cron, no polling loop. Its single
 * job is to wake the ALREADY-CLOSED bounded multi-goal pass
 * (`reconcileMultiGoalOnce`) under strict single-flight and coalescing rules:
 *
 * - STARTUP: exactly one bounded opportunity per process start, invoked by
 *   the server strictly AFTER durable recovery/reconciliation.
 * - TERMINALIZATION: the orchestrator's `scheduleFollowupTick` hook (fired
 *   after each decoupled launch completes) coalesces into `requestPass`.
 * - OPERATOR: an explicit inline pass with a safe, bounded result.
 * - SINGLE-FLIGHT: one reconciliation pass is active at a time; wakeups that
 *   arrive during a pass converge into a bounded pending state (at most one
 *   follow-up pass).
 * - FAIL-CLOSED: an unexpected pass-level throw latches `fail_closed`;
 *   automatic wakeups are suppressed until an operator pass succeeds or the
 *   process restarts. The server keeps listening: the latch is supervisor
 *   state, never a process crash.
 * - RESTART: pending wakeups and the latch are intentionally ephemeral.
 *   Recovery evidence is the durable rows plus the startup pass — a
 *   surviving in-memory callback is never assumed.
 * - ANTI-LIVELOCK: an automatic follow-up is requested only after truncation
 *   or proven synchronous progress on a bounded-autonomous Goal with another
 *   safe boundary ready. Held/ceiling-only passes never recurse.
 *
 * The supervisor never approves plans, never creates execution
 * authorization, never widens capabilities, and never calls the runner
 * directly. Every authority-exercising call happens inside the existing
 * bounded pass, behind the existing durable gates. LÍA remains the sole
 * authority.
 */

export type ProjectSupervisorSchedulingRuntimeDependencies = {
  /** The project task store. Structurally guarded: only durable goal stores
   * expose the goal surface; the in-memory store has none. */
  store: unknown;
  config: LiaAgentConfig;
  /** Authorized-project registry, forwarded to the launch policy. */
  registry?: ProjectRegistrySource;
  verificationRegistry?: ProjectVerificationRegistry;
  /** Layer B assessor forwarded to the bounded pass. */
  assessor?: ProjectGoalSemanticAssessor;
  /** Clock for evidence timestamps and eligibility evaluation. */
  now?: () => number;
  /** No-progress escalation threshold forwarded to the bounded pass. */
  noProgressEscalationThreshold?: number;
  /** Test seam: decoupled-launch scheduler forwarded to the bounded pass. */
  scheduleDecoupledLaunch?: (launch: () => Promise<void>) => void;
  /** Test seam: the coalescing drain scheduler (default setImmediate). */
  scheduleImmediate?: (fn: () => void) => void;
  /** Test seam: workflow executor forwarded to the launch policy, never
   * before the durable gate. */
  executeWorkflow?: (
    request: ProjectTaskRequest,
    onStage: (stage: Exclude<ProjectTaskStage, 'accepted' | 'completed' | 'failed'>) => void,
  ) => Promise<ProjectTaskWorkflowResult>;
};

export type ProjectSupervisorSchedulingRuntime = {
  /** Coalescing wakeup. Duplicate calls converge into at most one pass. */
  requestPass: (source?: SupervisorWakeupSource) => void;
  /** Explicit operator pass: inline, bounded, 409 when a pass is running. */
  triggerPass: () => Promise<ProjectSupervisorOperatorPassResult>;
  /** Read-only operator HUD. */
  hud: () => ProjectSupervisorHud;
};

/**
 * Structural store guard: only durable goal stores expose the goal surface.
 * The in-memory store has no `listActiveGoals`, so a supervisor over it can
 * only report `unsupported` — it can never pretend to schedule anything.
 */
export function hasProjectGoalSurface(store: unknown): boolean {
  return typeof (store as { listActiveGoals?: unknown } | null)?.listActiveGoals === 'function';
}

/** Maps an unknown throw to a bounded, non-secret machine-code reason. */
function toSafeReason(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(error.message)) {
    return error.message;
  }
  return 'supervisor_pass_failed';
}

export function createProjectSupervisorSchedulingRuntime(
  dependencies: ProjectSupervisorSchedulingRuntimeDependencies,
): ProjectSupervisorSchedulingRuntime {
  const supported = hasProjectGoalSurface(dependencies.store);
  const store = dependencies.store as MultiGoalOrchestrationStore;
  const scheduleImmediate = dependencies.scheduleImmediate ?? ((fn: () => void): void => { setImmediate(fn); });
  const now = dependencies.now ?? Date.now;

  let running = false;
  let pendingWakeup = false;
  let drainScheduled = false;
  let failedClosed = false;
  let lastPass: SupervisorLastPassSummary | undefined;
  let lastFailureReason: string | undefined;

  /** Builds the bounded-pass options for THIS pass. Launch dependencies are
   * only present when an authorized-project registry exists; without one,
   * launchable goals are skipped fail-closed by the bounded pass itself. */
  function buildOrchestratorOptions(): MultiGoalOrchestrationDependencies {
    const launch = dependencies.registry === undefined
      ? undefined
      : {
          workerId: `lia-supervisor-${randomUUID()}`,
          config: dependencies.config,
          registry: dependencies.registry,
          ...(dependencies.verificationRegistry !== undefined ? { verificationRegistry: dependencies.verificationRegistry } : {}),
          ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
          ...(dependencies.executeWorkflow !== undefined ? { executeWorkflow: dependencies.executeWorkflow } : {}),
        };
    return {
      ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
      ...(dependencies.noProgressEscalationThreshold !== undefined
        ? { noProgressEscalationThreshold: dependencies.noProgressEscalationThreshold }
        : {}),
      ...(dependencies.assessor !== undefined ? { assessor: dependencies.assessor } : {}),
      ...(dependencies.scheduleDecoupledLaunch !== undefined
        ? { scheduleDecoupledLaunch: dependencies.scheduleDecoupledLaunch }
        : {}),
      ...(launch !== undefined ? { launch } : {}),
      // Terminalization wakeup: every completed decoupled launch requests a
      // bounded follow-up pass. Coalesced by requestPass; never recursive.
      scheduleFollowupTick: (): void => { requestPass('terminalization'); },
    };
  }

  /** One bounded reconciliation pass, reduced to safe operator evidence. */
  async function runPass(source: SupervisorWakeupSource): Promise<SupervisorLastPassSummary> {
    const result = await reconcileMultiGoalOnce(store, buildOrchestratorOptions());
    const truncated = result.order.length > MAX_GOALS_PER_TICK;
    return {
      at: now(),
      source,
      activeGoalCount: result.evidence.activeGoalCount,
      inspectedGoalCount: result.evidence.inspectedGoalCount,
      selectedGoalCount: result.evidence.selectedGoalCount,
      externalExecutionSlotsUsed: result.evidence.externalExecutionSlotsUsed,
      externalExecutionCeiling: result.evidence.externalExecutionCeiling,
      inFlight: result.evidence.inFlight,
      isolatedFailureCount: result.evidence.isolatedFailureCount,
      moreWorkRemains: result.evidence.moreWorkRemains,
      truncated,
      outcomes: result.results.map((outcome) => ({
        goalId: outcome.goalId,
        stageBefore: outcome.stageBefore,
        stageAfter: outcome.stageAfter,
        action: outcome.action,
        decoupledLaunch: outcome.decoupledLaunch,
        humanInterventionRequired: outcome.humanInterventionRequired,
        isolatedFailure: outcome.isolatedFailure,
        ...(outcome.blockingReason !== undefined ? { blockingReason: outcome.blockingReason } : {}),
      })),
      skipped: result.skipped.map((entry) => ({ goalId: entry.goalId, reason: entry.reason })),
    };
  }

  /** Schedules exactly one coalesced drain. Never more than one pending. */
  function scheduleDrain(source: SupervisorWakeupSource): void {
    if (drainScheduled || running || !supported) return;
    drainScheduled = true;
    scheduleImmediate(() => {
      drainScheduled = false;
      void drain(source);
    });
  }

  /** Single-flight drain: at most one pass at a time; wakeups arriving during
   * a pass converge into at most one follow-up pass. */
  async function drain(source: SupervisorWakeupSource): Promise<void> {
    if (running) {
      // Never a second concurrent pass: fold the wakeup into pending state.
      pendingWakeup = true;
      return;
    }
    running = true;
    pendingWakeup = false;
    try {
      lastPass = await runPass(source);
      lastFailureReason = undefined;
      failedClosed = false; // a completed pass clears the latch
      // Continue only after proven durable progress with another advanceable
      // boundary, or truncation. Held/zero-progress passes never recurse.
      if (lastPass.truncated || (lastPass.moreWorkRemains && lastPass.selectedGoalCount > 0)) pendingWakeup = true;
    } catch (error) {
      failedClosed = true; // wiring failure fails closed
      lastFailureReason = toSafeReason(error);
    } finally {
      running = false;
      if (pendingWakeup && !failedClosed) {
        pendingWakeup = false;
        scheduleDrain('followup');
      }
    }
  }

  /** Coalescing wakeup entry point (startup / terminalization / followup). */
  function requestPass(source: SupervisorWakeupSource = 'terminalization'): void {
    if (!supported || failedClosed) return; // unsupported store or fail-closed latch: no auto wakeup
    pendingWakeup = true;
    scheduleDrain(source);
  }

  /** Explicit operator pass. Inline, bounded, never queued behind other
   * wakeups, never concurrent with another pass. Clears the fail-closed
   * latch on success. */
  async function triggerPass(): Promise<ProjectSupervisorOperatorPassResult> {
    if (!supported) return { ok: false, code: 'supervisor_unsupported' };
    if (running) return { ok: false, code: 'pass_in_progress' };
    pendingWakeup = false; // the operator pass supersedes coalesced wakeups
    running = true;
    try {
      const summary = await runPass('operator');
      lastPass = summary;
      lastFailureReason = undefined;
      failedClosed = false; // operator success clears the fail-closed latch
      if (summary.truncated || (summary.moreWorkRemains && summary.selectedGoalCount > 0)) pendingWakeup = true;
      return { ok: true, pass: summary };
    } catch (error) {
      failedClosed = true;
      lastFailureReason = toSafeReason(error);
      return { ok: false, code: 'pass_failed_closed', reason: lastFailureReason };
    } finally {
      running = false;
      if (pendingWakeup && !failedClosed) {
        pendingWakeup = false;
        scheduleDrain('followup');
      }
    }
  }

  /** Read-only operator HUD: bounded facts only. */
  function hud(): ProjectSupervisorHud {
    const state: SupervisorState = !supported
      ? 'unsupported'
      : failedClosed
        ? 'fail_closed'
        : running
          ? 'running'
          : pendingWakeup || drainScheduled
            ? 'pending'
            : 'idle';
    let goals: ReturnType<typeof buildMultiGoalOrchestrationEvidence> | undefined;
    let goalsReadFailure = false;
    if (supported) {
      try {
        goals = buildMultiGoalOrchestrationEvidence(store, {
          ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
          ...(dependencies.noProgressEscalationThreshold !== undefined
            ? { noProgressEscalationThreshold: dependencies.noProgressEscalationThreshold }
            : {}),
        });
      } catch {
        goalsReadFailure = true; // evidence failure never latches the scheduler
      }
    }
    return {
      state,
      enabled: true,
      supported,
      pendingWakeup,
      passInProgress: running,
      failClosed: failedClosed,
      ...(lastPass !== undefined ? { lastPass } : {}),
      ...(lastFailureReason !== undefined ? { lastFailureReason } : {}),
      ...(goals !== undefined ? { goals } : {}),
      ...(goalsReadFailure ? { goalsReadFailure: true } : {}),
    };
  }

  return { requestPass, triggerPass, hud };
}
