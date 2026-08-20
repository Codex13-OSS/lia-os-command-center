/**
 * LÍA REAL AUTONOMY QUALIFICATION — shared sandbox fixtures (design §3-§4).
 *
 * This module implements the ONLY four repository-supported test seams (S1-S4)
 * plus harness-side fixture techniques (F1-F3) exactly as the authoritative
 * design specifies. It is HARNESS code only: it never runs inside production,
 * never touches /opt/lia-os-*, never launches anything outside the sandbox,
 * and never creates a second execution engine.
 *
 * Seam-use invariant (design §3): every workflow execution that occurs during
 * the qualification MUST be counted by S1 and the count MUST equal the number
 * of durable launch attempts. The harness asserts this dynamically.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Deterministic identity helpers (match PROJECT_GOAL_ID / PROJECT_TASK_ID).
// ---------------------------------------------------------------------------

export const goalId = (n) => `d50e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;
export const taskId = (n) => `e50e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;

// ---------------------------------------------------------------------------
// S3 — shared mutable clock. Time is a read; all TTL/expiry logic runs on the
// injected clock exactly as it runs on Date.now.
// ---------------------------------------------------------------------------

export function makeClock(start = 1_700_000_000_000) {
  let value = start;
  const clock = () => value;
  clock.advance = (ms) => { value += ms; };
  clock.set = (next) => { value = next; };
  clock.value = () => value;
  return clock;
}

// ---------------------------------------------------------------------------
// Sandbox environment bootstrap (design §4.3). Returns the REAL config via
// loadConfig(process.env) plus the qualification extras.
// ---------------------------------------------------------------------------

export const NOMINAL_PORT = 31099; // never 3014; the bootstrap actually binds listen(0)

export function sandboxEnv(root, { maxActive = 64, maxRecords = 512, clockStart = 1_700_000_000_000, supervisorEnabled = true, extras = {} } = {}) {
  return {
    LIA_AGENT_HOST: '127.0.0.1',
    LIA_AGENT_PORT: String(NOMINAL_PORT),
    LIA_PROJECT_TASK_SQLITE_PATH: `${root}/db/tasks.sqlite`,
    LIA_PROJECT_REGISTRY_PATH: `${root}/registry/projects.json`,
    LIA_PROJECT_VERIFICATION_PATH: `${root}/registry/verification.json`,
    LIA_SUPERVISOR_ENABLED: supervisorEnabled ? 'true' : 'false',
    LIA_HERMES_EXECUTION_ENABLED: 'false', // belt-and-braces: with S1 the real workflow is never reachable
    LIA_HERMES_ROOT: `${root}/hermes-root`,
    LIA_HERMES_EXECUTABLE: `${root}/bin/hermes-stub`,
    LIA_HERMES_HOME: `${root}/hermes-home`,
    LIA_AGENT_LOG_LEVEL: 'silent',
    LIA_AGENDA_SQLITE_PATH: '', // no agenda source
    LIA_QUAL_MAX_ACTIVE: String(maxActive),
    LIA_QUAL_MAX_RECORDS: String(maxRecords),
    LIA_QUAL_CLOCK_START: String(clockStart),
    ...extras,
  };
}

/** REAL registry file source content (design §4.2). */
export function buildRegistryFile(root, projectId = 'qual-project') {
  return JSON.stringify({
    version: 1,
    projects: [{
      projectId,
      displayName: 'Qualification Fixture',
      repositoryRoot: `${root}/fixture-repo`,
      enabled: true,
    }],
  }, null, 2);
}

/** REAL verification file source content (design §4.2). Never consulted (S1). */
export function buildVerificationFile() {
  return JSON.stringify({ version: 1, profiles: [] }, null, 2);
}

// ---------------------------------------------------------------------------
// S1 — deterministic workflow seam (design §4.5).
//
// Inspects request.instruction (operator-supplied) for the script token and
// the goal token, reads the task lineage from the REAL store, and returns a
// deterministic ProjectTaskWorkflowResult. It is invoked ONLY after the real
// durable Launch Attempt gate has admitted the live phase (the runner calls
// it strictly after gate()), and the runner still owns
// lease/dispatch/run/invocation/result/terminalization.
//
// To keep the full real evidence chain closed (design A.10 completion
// evidence), the seam mirrors exactly what the real workflow's post-Hermes
// seams do — durably recording the launch-result outcome through the REAL
// store primitives (recordTaskExecutionLaunchResult for failures,
// recordValidatedProposalResult for success), never before the gate.
// ---------------------------------------------------------------------------

export const SCRIPT_TOKENS = ['qual:fail-root', 'qual:fail-all', 'qual:succeed-now', 'qual:never-resolve'];

export function parseQualScript(instruction) {
  const goalMatch = instruction.match(/\[qual:goal:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/);
  const scriptMatch = instruction.match(/\[qual:(fail-root|fail-all|succeed-now|never-resolve)\]/);
  return { goalId: goalMatch?.[1], script: scriptMatch?.[1] };
}

/** Canonical, deterministic, whitespace-free proposal JSON (design §4.5 + store validation). */
export function buildCanonicalProposalJson(goalIdValue, taskIdValue) {
  return JSON.stringify({
    blockedActions: [],
    completionMode: 'complete',
    executionMode: 'direct',
    goalId: goalIdValue,
    requiresHumanApproval: false,
    taskId: taskIdValue,
  });
}

/** Records the proposal_valid launch result + validated-proposal snapshot atomically (REAL store primitive). */
export function recordProposalResult(store, goalIdValue, taskIdValue) {
  const attempt = store.readTaskExecutionLaunchAttemptByTask(taskIdValue);
  if (attempt === undefined) return false;
  const canonicalProposalJson = buildCanonicalProposalJson(goalIdValue, taskIdValue);
  const proposalSha256 = createHash('sha256').update(canonicalProposalJson).digest('hex');
  store.recordValidatedProposalResult({
    launchAttemptId: attempt.launchAttemptId,
    invocationId: attempt.invocationId,
    executionRunId: attempt.executionRunId,
    taskId: taskIdValue,
    canonicalProposalJson,
    proposalSha256,
    executionMode: 'direct',
    completionMode: 'complete',
    requiresHumanApproval: false,
    blockedActions: [],
  });
  return true;
}

/** Records a failure launch-result outcome (REAL store primitive). */
export function recordFailureLaunchResult(store, taskIdValue, outcomeClass = 'execution_failed') {
  const attempt = store.readTaskExecutionLaunchAttemptByTask(taskIdValue);
  if (attempt === undefined) return false;
  store.recordTaskExecutionLaunchResult({
    launchAttemptId: attempt.launchAttemptId,
    invocationId: attempt.invocationId,
    executionRunId: attempt.executionRunId,
    taskId: taskIdValue,
    outcomeClass,
  });
  return true;
}

/**
 * The S1 seam factory. `secrets` carries the sentinel prompt the seam would
 * (adversarially) hold internally — the leak guard proves it never surfaces.
 */
export function createQualWorkflowExecutor(store, { sentinel = 'QUAL-SECRET-INTERNAL', onInvocation } = {}) {
  let invocations = 0;
  const executor = async (request, onStage) => {
    invocations += 1;
    if (typeof onInvocation === 'function') onInvocation({ count: invocations });
    const { goalId: gid, script } = parseQualScript(request.instruction ?? '');
    // Resolve the task lineage through the REAL durable rows. At seam time the
    // executed task is the goal's only `accepted` task (the runner has not
    // terminalized it yet). The instruction always embeds the goal token
    // (root objective and deterministic continuation instruction both carry it).
    let attemptNumber = 0;
    let taskIdValue;
    if (gid !== undefined) {
      const attempts = store.listGoalAttempts(gid);
      const candidate = attempts
        .filter((t) => t.status === 'accepted' && typeof t.intent?.instruction === 'string' && t.intent.instruction.includes(`[qual:goal:${gid}]`))
        .sort((a, b) => (b.lineage?.attemptNumber ?? 0) - (a.lineage?.attemptNumber ?? 0))[0];
      if (candidate !== undefined) {
        attemptNumber = candidate.lineage?.attemptNumber ?? 0;
        taskIdValue = candidate.taskId;
      }
    }
    // The sentinel lives ONLY inside the seam (internal prompt); it must never
    // be echoed into any response the harness observes.
    const internalPrompt = `Resolve the qualification objective. ${sentinel}`;
    void internalPrompt;

    // The runner's onStage is the durable stage transition (never before the gate).
    onStage('planning');
    onStage('hermes');

    const scriptToken = script ?? 'fail-root';
    if (scriptToken === 'never-resolve') {
      return new Promise(() => { /* durably stays accepted/runner-owned; no timers */ });
    }

    const failResult = {
      ok: false,
      status: 'failed',
      stage: 'codex',
      error: 'codex_execution_failed',
      message: 'Codex no pudo completar la ejecución.',
      projectId: request.projectId,
    };
    const successResult = {
      ok: true,
      projectId: request.projectId,
      executionId: `exec-${taskIdValue ?? randomUUID()}`,
      status: 'verified',
      executionSummary: 'hidden',
      resultText: 'Bounded verified result.',
      verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
      stages: ['planning', 'hermes', 'codex', 'verification'],
    };

    let outcome;
    if (scriptToken === 'succeed-now') {
      outcome = successResult;
    } else if (scriptToken === 'fail-all') {
      outcome = failResult;
    } else { // fail-root
      outcome = attemptNumber === 0 ? failResult : successResult;
    }

    // Mirror the real workflow's post-Hermes durable result seams (exactly
    // once, strictly after the gate): failure outcomes via
    // recordTaskExecutionLaunchResult; success via the atomic
    // proposal_valid + snapshot recording. Evidence must never gate execution.
    if (taskIdValue !== undefined) {
      try {
        if (outcome.ok) {
          recordProposalResult(store, gid, taskIdValue);
        } else {
          recordFailureLaunchResult(store, taskIdValue, 'execution_failed');
        }
      } catch {
        // Evidence failure must not block execution (same contract as the runner).
      }
    }
    return outcome;
  };
  executor.count = () => invocations;
  return executor;
}

// ---------------------------------------------------------------------------
// S2 — mechanical goal assessor (design §4.5). The deterministic classification
// seam; the store's evaluateAndApplyGoalAttempt remains the final authority.
// `overrides` is a Map<goalId, classifier> for goal-specific fixtures (G4).
// ---------------------------------------------------------------------------

const { createMechanicalGoalAssessor } = await import('../dist/services/projectGoalSatisfactionAssessor.js');

export function createQualAssessor(overrides = new Map()) {
  return createMechanicalGoalAssessor((goal, task) => {
    const override = overrides.get(goal.goalId);
    if (override !== undefined) return override(goal, task);
    if (task.status === 'completed' && (task.lineage?.attemptNumber ?? 0) >= 1) {
      return { goalSatisfaction: 'satisfied', blocking: 'none', failure: 'retryable' };
    }
    return { goalSatisfaction: 'not_demonstrated', blocking: 'none', failure: 'retryable' };
  });
}

// ---------------------------------------------------------------------------
// S4 — schedulers with observation counters (design §3 S4, §5 F.1).
// The default body is the real setImmediate; only the observation wrapper is
// harness-owned. `hold` keeps callbacks queued (K.1 process-death-before-
// wakeup); `throwFirstDrain` makes the first drain callback throw (K.3).
// ---------------------------------------------------------------------------

// LIA_QUAL_SCHEDULER_RELEASE_V2
export function makeScheduleImmediate({ hold = false, throwFirstDrain = false } = {}) {
  let holding = hold;
  const state = { scheduled: 0, executed: 0, held: 0, heldCallbacks: [] };
  const scheduleImmediate = (fn) => {
    state.scheduled += 1;
    if (holding) {
      state.held += 1;
      state.heldCallbacks.push(fn);
      return;
    }
    setImmediate(() => {
      state.executed += 1;
      fn();
    });
  };
  scheduleImmediate.state = state;
  scheduleImmediate.releaseAll = () => {
    holding = false;
    const callbacks = state.heldCallbacks.splice(0);
    state.held = 0;
    for (const fn of callbacks) {
      state.executed += 1;
      setImmediate(fn);
    }
  };
  return scheduleImmediate;
}

export function makeScheduleDecoupledLaunch() {
  const state = { scheduled: 0, executed: 0 };
  const scheduleDecoupledLaunch = (launch) => {
    state.scheduled += 1;
    setImmediate(() => {
      state.executed += 1;
      void launch();
    });
  };
  scheduleDecoupledLaunch.state = state;
  return scheduleDecoupledLaunch;
}

// ---------------------------------------------------------------------------
// F1 — durable row fixtures (harness-only; never launches, never an engine).
// ---------------------------------------------------------------------------

/** Crosses the durable Launch Attempt boundary WITHOUT a launch result (ambiguous tuple). */
export function crossLaunchBoundary(store, taskIdValue, leaseOwner = 'qual-fixture-worker') {
  const dispatch = store.enqueueTaskDispatch(taskIdValue);
  const claim = store.claimTaskDispatch({ dispatchId: dispatch.dispatchId, leaseOwner, durationMs: 300_000 });
  const run = store.prepareTaskExecutionRun({
    dispatchId: dispatch.dispatchId,
    taskId: taskIdValue,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const invocation = store.reserveTaskExecutionInvocation({
    executionRunId: run.executionRunId,
    taskId: taskIdValue,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  const attempt = store.beginTaskExecutionLaunchAttempt({
    invocationId: invocation.invocationId,
    executionRunId: run.executionRunId,
    taskId: taskIdValue,
    leaseOwner: claim.lease.leaseOwner,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
  });
  return { dispatch, run, invocation, attempt, lease: claim.lease };
}

/**
 * Pre-Codex resumable fixture (K.2): launch attempt + proposal_valid result +
 * validated snapshot + task transitioned planning -> hermes. The real
 * reconcileRestartSafeTasks must preserve this as resumable (case 4).
 */
export function injectPreCodexResumable(store, goalIdValue, taskIdValue, intent) {
  crossLaunchBoundary(store, taskIdValue);
  recordProposalResult(store, goalIdValue, taskIdValue);
  store.transition(taskIdValue, 'planning');
  store.transition(taskIdValue, 'hermes');
}

// ---------------------------------------------------------------------------
// Durable snapshot — REAL row counts over the SAME sqlite file via a second
// DatabaseSync connection (identical technique to the existing tests).
// ---------------------------------------------------------------------------

const TABLE_COUNTS = [
  ['tasks', 'project_tasks'],
  ['evaluations', 'project_goal_evaluations'],
  ['appliedEvaluations', 'project_goal_evaluations', 'WHERE applied_at IS NOT NULL'],
  ['plans', 'project_goal_continuation_plans'],
  ['approvals', 'project_goal_continuation_approvals'],
  ['authorizations', 'project_goal_continuation_execution_authorizations'],
  ['autonomyPolicies', 'project_goal_autonomy_policies'],
  ['launchAttempts', 'project_task_execution_launch_attempts'],
  ['launchResults', 'project_task_execution_launch_results'],
  ['invocations', 'project_task_execution_invocations'],
  ['runs', 'project_task_execution_runs'],
  ['dispatches', 'project_task_dispatch_outbox'],
  ['leases', 'project_task_lease_generations'],
  ['snapshots', 'project_task_validated_proposal_snapshots'],
  ['completionEvidence', 'project_task_completion_evidence'],
  ['resumeDecisions', 'project_task_resume_decisions'],
];

export function durableCounts(databasePathOrRoot) {
  const normalized = databasePathOrRoot.replace(/\/+$/, '');
  const databasePath = normalized.endsWith('.sqlite')
    ? normalized
    : `${normalized}/db/tasks.sqlite`;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const counts = {};
    for (const [key, table, extra = ''] of TABLE_COUNTS) {
      counts[key] = database.prepare(`SELECT COUNT(*) AS n FROM ${table} ${extra}`).get().n;
    }
    return counts;
  } finally {
    database.close();
  }
}

/** Per-goal durable rows via the real store handle. */
export function goalRows(store, goalIdValue) {
  const goal = store.readGoal(goalIdValue);
  if (goal === undefined) return undefined;
  const attempts = store.listGoalAttempts(goalIdValue).map((t) => ({
    taskId: t.taskId,
    status: t.status,
    attemptNumber: t.lineage?.attemptNumber ?? 0,
    continuationDepth: t.lineage?.continuationDepth ?? 0,
    parentTaskId: t.lineage?.parentTaskId,
    errorCode: t.error?.code,
    receiptStatus: t.receipt?.status,
  }));
  const evaluations = store.listGoalEvaluations(goalIdValue).map((e) => ({
    evaluationId: e.evaluationId,
    taskId: e.taskId,
    decision: e.decision,
    reasonCode: e.reasonCode,
    appliedAt: e.appliedAt,
  }));
  const plans = store.listGoalContinuationPlans(goalIdValue).map((p) => ({
    planId: p.planId,
    status: p.status,
    createdTaskId: p.createdTaskId,
  }));
  return {
    goal: {
      goalId: goal.goalId,
      status: goal.status,
      currentAttempt: goal.currentAttempt,
      maxAttempts: goal.maxAttempts,
      continuationDepthLimit: goal.continuationDepthLimit,
      terminalReason: goal.terminalReason,
    },
    attempts,
    evaluations,
    plans,
  };
}

// ---------------------------------------------------------------------------
// F2 — static safety assertions on the built artifact (mirrors existing test 21
// and test 24 conventions). No periodic timer, no polling, no second engine.
// ---------------------------------------------------------------------------

export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const F2_MODULES = [
  'src/services/projectBoundedAutonomousLoopRuntime.ts',
  'src/services/projectMultiGoalAutonomousOrchestrator.ts',
  'src/services/projectSupervisorSchedulingRuntime.ts',
  'src/services/projectGoalControlService.ts',
  'src/services/projectGoalControlReadModel.ts',
  'src/routes/projectGoalControl.ts',
  'src/routes/projectSupervisor.ts',
];

const F2_FORBIDDEN = [
  'setInterval', 'setTimeout', 'cron', 'child_process', '.spawn(', '.exec(',
  'node:http', 'node:net', 'node:dns', 'node:https',
];

export function assertStaticSafety(backendRoot, { readFile }) {
  const findings = [];
  for (const modulePath of F2_MODULES) {
    const source = stripComments(readFile(`${backendRoot}/${modulePath}`, 'utf8'));
    for (const forbidden of F2_FORBIDDEN) {
      if (source.includes(forbidden)) {
        findings.push(`${modulePath} contains forbidden token: ${forbidden}`);
      }
    }
    if (source.includes('runProjectTaskDurableExecution(') && !modulePath.includes('projectGoalControlService')) {
      findings.push(`${modulePath} calls the runner (only the goal-control SERVICE intake may)`);
    }
  }
  const service = stripComments(readFile(`${backendRoot}/src/services/projectGoalControlService.ts`, 'utf8'));
  const runnerCallSites = service.match(/runProjectTaskDurableExecution\(/g) ?? [];
  if (runnerCallSites.length !== 1) findings.push(`goal control service must have exactly one runner call site, found ${runnerCallSites.length}`);
  return findings;
}

// ---------------------------------------------------------------------------
// F3 — payload leak guard helpers.
// ---------------------------------------------------------------------------

export const FORBIDDEN_PAYLOAD_STRINGS = [
  'sessionId', 'session_id', 'apiKey', 'api_key', 'accessToken', 'token',
  'secret', 'credential', 'worktreePath', 'worktree_path', 'repositoryRoot',
  'command', 'commands', 'shell', 'prompt', 'rawOutput', 'executionSummary',
  'provider', 'model', 'fencingToken', 'leaseId', 'leaseOwner', 'intent',
  'approvedCapabilities', 'effectiveCapabilities', 'capabilities',
  'capabilityExpansion', 'stack', 'internalError',
  'push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access',
];

export function assertNoPayloadLeak(serialized, sentinels = []) {
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error('leak: response is not valid JSON');
  }

  const forbiddenKeys = new Set(FORBIDDEN_PAYLOAD_STRINGS.map((value) => value.toLowerCase()));
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLowerCase())) {
        throw new Error(`leak: forbidden payload key "${key}" present in response`);
      }
      visit(nested);
    }
  };

  visit(payload);

  for (const sentinel of sentinels) {
    if (sentinel !== undefined && sentinel !== '' && serialized.includes(sentinel)) {
      throw new Error(`leak: sentinel "${sentinel}" present in response`);
    }
  }
}

// ---------------------------------------------------------------------------
// Event-loop settlement helper (harness driver only; bounded, no wall-clock
// polling of the runtime — mirrors the existing tests' flushImmediates).
// ---------------------------------------------------------------------------

export async function settleImmediates(maxRounds = 60, condition = undefined) {
  for (let i = 0; i < maxRounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (condition !== undefined && await condition()) return i + 1;
  }
  return maxRounds;
}

// ---------------------------------------------------------------------------
// Dynamic import helper (dist modules are ESM).
// ---------------------------------------------------------------------------

const importCache = new Map();
export function awaitImport(spec) {
  if (!importCache.has(spec)) {
    importCache.set(spec, import(spec));
  }
  return importCache.get(spec);
}
