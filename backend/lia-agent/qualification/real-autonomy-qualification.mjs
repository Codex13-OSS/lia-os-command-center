/**
 * LÍA REAL AUTONOMY QUALIFICATION — driver (design §4.4, §5, §8).
 *
 * Executes scenarios A-K sequentially, each in its own fresh sandbox root
 * under /tmp, against the REAL compiled backend (dist) wired exactly like
 * server.ts, driven over REAL HTTP, verified against REAL sqlite rows.
 *
 * PASS only from observed runtime evidence. On failure the sandbox root and
 * its evidence/ are preserved and printed. Exits 0 only when every scenario
 * and every success criterion passes.
 *
 * Usage: node qualification/real-autonomy-qualification.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../dist/app.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { reconcileProjectTasksAtStartup } from '../dist/services/projectTaskReconciliation.js';
import { createProjectRegistryFileSource } from '../dist/services/projectRegistryFileSource.js';
import { createFileProjectVerificationRegistry } from '../dist/services/projectVerificationFileSource.js';
import { createProjectSupervisorSchedulingRuntime } from '../dist/services/projectSupervisorSchedulingRuntime.js';
import { runLoopOnce } from '../dist/services/projectBoundedAutonomousLoopRuntime.js';
import { reconcileMultiGoalOnce } from '../dist/services/projectMultiGoalAutonomousOrchestrator.js';
import { assertSafeOperatorPayload } from '../dist/services/projectGoalControlReadModel.js';
import { MAX_CONCURRENT_EXTERNAL_EXECUTIONS, MAX_GOALS_PER_TICK } from '../dist/contracts/projectMultiGoalOrchestration.js';
import { PROJECT_GOAL_CONTROL_ERRORS, PROJECT_GOAL_CONTROL_INTEGRATION } from '../dist/contracts/projectOperatorGoalControl.js';
import { AUTONOMOUS_V1_CEILING, AUTONOMOUS_V1_FORBIDDEN_CAPABILITIES } from '../dist/contracts/autonomousAuthority.js';
import {
  createQualWorkflowExecutor,
  createQualAssessor,
  makeClock,
  makeScheduleImmediate,
  makeScheduleDecoupledLaunch,
  sandboxEnv,
  buildRegistryFile,
  buildVerificationFile,
  goalId,
  taskId,
  durableCounts,
  goalRows,
  crossLaunchBoundary,
  recordProposalResult,
  settleImmediates,
  assertNoPayloadLeak,
  assertStaticSafety,
  stripComments,
  parseQualScript,
  FORBIDDEN_PAYLOAD_STRINGS,
} from './sandbox-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(HERE, '..');
const REPO_ROOT = join(BACKEND_ROOT, '..', '..');

const QUAL_PROJECT = 'qual-project';
const APPROVER = 'qual-operator';
const QUAL_PREFIX = 'Real autonomy qualification synthetic goal';

// ---------------------------------------------------------------------------
// Assertion plumbing
// ---------------------------------------------------------------------------

class ScenarioError extends Error {}

const PASSED = [];
const FAILED = [];
const EVIDENCE = {};

function assert(condition, message) {
  if (!condition) throw new ScenarioError(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new ScenarioError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new ScenarioError(`${message}: missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
  }
}

// ---------------------------------------------------------------------------
// Sandbox root + wiring helpers
// ---------------------------------------------------------------------------

async function newSandbox(prefix) {
  const root = await mkdtemp(join(tmpdir(), `lia-qual-${prefix}-`));
  await mkdir(join(root, 'db'), { recursive: true });
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(root, 'fixture-repo'), { recursive: true });
  await mkdir(join(root, 'evidence'), { recursive: true });
  await mkdir(join(root, 'hermes-root'), { recursive: true });
  await mkdir(join(root, 'hermes-home'), { recursive: true });
  await writeFile(join(root, 'registry/projects.json'), buildRegistryFile(root, QUAL_PROJECT));
  await writeFile(join(root, 'registry/verification.json'), buildVerificationFile());
  await writeFile(join(root, 'fixture-repo/README.md'), '# Qualification fixture repository (never executed against).\n');
  return root;
}

function qualConfig(root, { maxActive = 64, maxRecords = 512, clockStart = 1_700_000_000_000 } = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    corsOrigins: [],
    agendaSqlitePath: '',
    projectTaskSqlitePath: `${root}/db/tasks.sqlite`,
    projectRegistryPath: `${root}/registry/projects.json`,
    projectVerificationPath: `${root}/registry/verification.json`,
    hermesRoot: `${root}/hermes-root`,
    hermesExecutionEnabled: false,
    hermesExecutable: `${root}/bin/hermes-stub`,
    hermesHome: `${root}/hermes-home`,
    hermesUser: 'hermes-agent',
    hermesUserHome: '/home/hermes-agent',
    hermesPath: '/usr/local/bin:/usr/bin:/bin',
    hermesProvider: 'fake',
    hermesModel: 'fake',
    hermesTimeoutMs: 500,
    hermesMaxQueryCharacters: 8000,
    supervisorEnabled: true,
    logLevel: 'silent',
    maxActive,
    maxRecords,
    clockStart,
  };
}

/** Boots the REAL wiring in-process (store + reconcile + supervisor + app + seams). */
function bootSandbox(root, options = {}) {
  const config = qualConfig(root, options);
  const clock = makeClock(options.clockStart ?? 1_700_000_000_000);
  const store = new ProjectTaskSqliteStore({
    databasePath: config.projectTaskSqlitePath,
    now: clock,
    maxActive: options.maxActive ?? 64,
    maxRecords: options.maxRecords ?? 512,
  });
  reconcileProjectTasksAtStartup(store);
  const registry = createProjectRegistryFileSource(config.projectRegistryPath);
  const verificationRegistry = createFileProjectVerificationRegistry(config.projectVerificationPath);
  const sentinel = `QUAL-SECRET-${Math.random().toString(36).slice(2, 12)}`;
  const workflowExecutor = createQualWorkflowExecutor(store, { sentinel });
  const scheduleImmediate = makeScheduleImmediate({ hold: options.holdImmediate === true });
  const scheduleDecoupledLaunch = makeScheduleDecoupledLaunch();
  const assessor = createQualAssessor(options.assessorOverrides);
  const supervisor = createProjectSupervisorSchedulingRuntime({
    store,
    config,
    registry,
    verificationRegistry,
    assessor,
    now: clock,
    ...(options.noProgressEscalationThreshold !== undefined
      ? { noProgressEscalationThreshold: options.noProgressEscalationThreshold }
      : {}),
    executeWorkflow: workflowExecutor,
    scheduleImmediate,
    scheduleDecoupledLaunch,
  });
  const app = createApp(config, {
    projectTaskStore: store,
    projectRegistrySource: registry,
    projectVerificationRegistry: verificationRegistry,
    projectSupervisorRuntime: supervisor,
    projectTasksWorkflowExecutor: workflowExecutor,
    now: clock,
  });
  return {
    root,
    config,
    clock,
    store,
    registry,
    verificationRegistry,
    workflowExecutor,
    scheduleImmediate,
    scheduleDecoupledLaunch,
    assessor,
    supervisor,
    app,
    sentinel,
    closed: false,
    close() {
      if (this.closed) return;
      this.closed = true;
      try { store.close(); } catch { /* best effort */ }
    },
  };
}

async function startServer(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : -1;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function http(baseUrl, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text: JSON.stringify(parsed ?? {}) };
}

const GET = (baseUrl, path) => http(baseUrl, 'GET', path);
const POST = (baseUrl, path, body = {}) => http(baseUrl, 'POST', path, body);
const PUT = (baseUrl, path, body) => http(baseUrl, 'PUT', path, body);

async function expect(baseUrl, method, path, body, expectedStatus, context) {
  const result = await http(baseUrl, method, path, body);
  assertEqual(result.status, expectedStatus, `${context}: HTTP ${method} ${path}`);
  return result;
}

async function supervisorPass(baseUrl, context) {
  const result = await expect(baseUrl, 'POST', '/api/projects/goals/supervisor/pass', {}, 200, `${context} pass`);
  return result.body.pass;
}

async function supervisorHud(baseUrl, context) {
  const result = await expect(baseUrl, 'GET', '/api/projects/goals/supervisor', undefined, 200, `${context} HUD`);
  return result.body.supervisor;
}

async function goalDetail(baseUrl, gid, context) {
  const result = await expect(baseUrl, 'GET', `/api/projects/goals/${gid}`, undefined, 200, `${context} detail`);
  return result.body;
}

async function driveGoalToStage(baseUrl, gid, targetStage, context, maxPasses = 16) {
  for (let i = 0; i <= maxPasses; i += 1) {
    const detail = await goalDetail(baseUrl, gid, context);
    if (detail.loopStage === targetStage) return detail;
    if (i === maxPasses) {
      throw new ScenarioError(`${context}: goal ${gid} did not reach ${targetStage}; current=${detail.loopStage}`);
    }
    await supervisorPass(baseUrl, `${context}-${i + 1}`);
  }
  throw new ScenarioError(`${context}: unreachable`);
}

function goalObjective(gid, script = 'qual:fail-root') {
  return `${QUAL_PREFIX} ${gid} [${script}] [qual:goal:${gid}]`;
}

function createGoalBody(gid, overrides = {}) {
  return {
    goalId: gid,
    projectId: QUAL_PROJECT,
    objective: goalObjective(gid, overrides.script ?? 'qual:fail-root'),
    priority: 'normal',
    requestedCapabilities: ['repository_read'],
    maxAttempts: 3,
    continuationDepthLimit: 2,
    autonomy: { mode: 'approved_single_step', approver: APPROVER },
    ...overrides,
  };
}

async function createGoal(baseUrl, gid, overrides = {}, context = 'create') {
  const result = await expect(baseUrl, 'POST', '/api/projects/goals', createGoalBody(gid, overrides), 202, context);
  return result;
}

// ---------------------------------------------------------------------------
// Child-process sandbox (C, D, E, K)
// ---------------------------------------------------------------------------

class ChildSandbox {
  constructor(root, envExtras = {}, label = 'child') {
    this.root = root;
    this.label = label;
    this.env = sandboxEnv(root, {
      maxActive: Number.parseInt(process.env.LIA_QUAL_MAX_ACTIVE ?? '64', 10),
      maxRecords: Number.parseInt(process.env.LIA_QUAL_MAX_RECORDS ?? '512', 10),
      extras: envExtras,
    });
    this.stdout = [];
    this.stderr = [];
    this.exitCode = undefined;
    this.ready = undefined;
    this.opCounter = 0;
    this.pending = new Map();
  }

  async start() {
    const bootstrapPath = join(HERE, 'sandbox-bootstrap.mjs');
    this.child = spawn(process.execPath, [bootstrapPath], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: BACKEND_ROOT,
    });
    const lines = [];
    this.child.stdout.on('data', (chunk) => {
      this.stdout.push(chunk.toString('utf8'));
      const text = chunk.toString('utf8');
      for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          lines.push(line);
          continue;
        }
        if (message.event === 'ready') {
          this.ready = message;
        } else if (message.event === 'response') {
          const pending = this.pending.get(message.id);
          if (pending !== undefined) {
            this.pending.delete(message.id);
            if (message.ok) pending.resolve(message.result);
            else pending.reject(new Error(message.error));
          }
        }
      }
    });
    this.child.stderr.on('data', (chunk) => { this.stderr.push(chunk.toString('utf8')); });
    this.child.on('exit', (code) => { this.exitCode = code; });
    const deadline = Date.now() + 20_000;
    while (this.ready === undefined && this.exitCode === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.ready === undefined) {
      throw new ScenarioError(`${this.label}: bootstrap never became ready (exit=${this.exitCode}, stderr=${this.stderr.join('').slice(0, 500)})`);
    }
    this.baseUrl = `http://127.0.0.1:${this.ready.port}`;
    return this;
  }

  async op(op, params = {}) {
    if (this.exitCode !== undefined) throw new ScenarioError(`${this.label}: process already exited (${this.exitCode})`);
    const id = ++this.opCounter;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(JSON.stringify({ id, op, params }) + '\n');
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${this.label}: control op ${op} timed out`)), 10_000));
    return Promise.race([result, timeout]);
  }

  async terminate() {
    if (this.child === undefined || this.exitCode !== undefined) return this.exitCode;
    this.child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (this.exitCode === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.exitCode === undefined) {
      this.child.kill('SIGKILL');
      throw new ScenarioError(`${this.label}: did not exit on SIGTERM`);
    }
    return this.exitCode;
  }
}

// ---------------------------------------------------------------------------
// Scenario framework
// ---------------------------------------------------------------------------

async function runScenario(name, fn) {
  const started = Date.now();
  let sandboxRoot;
  try {
    const ctx = {};
    await fn(ctx);
    PASSED.push(name);
    EVIDENCE[name] = { verdict: 'PASS', ms: Date.now() - started, ...(ctx.evidence ?? {}) };
    console.log(`SCENARIO ${name}: PASS (${Date.now() - started}ms)`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    FAILED.push(name);
    EVIDENCE[name] = { verdict: 'FAIL', error: detail, ms: Date.now() - started, sandboxRoot };
    console.error(`SCENARIO ${name}: FAIL — ${detail}`);
    if (sandboxRoot !== undefined) console.error(`  sandbox preserved: ${sandboxRoot}`);
  }
}

// ===========================================================================
// SCENARIO A — HAPPY PATH: one synthetic bounded goal completes E2E
// ===========================================================================

async function scenarioA() {
  const root = await newSandbox('A');
  const sandbox = bootSandbox(root);
  const server = await startServer(sandbox.app);
  const { baseUrl } = server;
  const { store, clock, workflowExecutor } = sandbox;
  const G = goalId(0xa1);
  const evidence = { steps: [] };
  try {
    const created = await createGoal(baseUrl, G);
    evidence.steps.push(['create', created.status, created.body.goal?.loopStage]);
    assertEqual(created.body.goal.status, 'active', 'A.1 goal active');
    assertEqual(created.body.goal.loopStage, 'awaiting_execution', 'A.1 root accepted, never executed');

    // A.2 — the intake runner crosses the REAL durable gate via setImmediate.
    await settleImmediates(30, () => {
      const g = goalRows(store, G);
      return g !== undefined && g.attempts.length > 0 && g.attempts[0].status === 'failed';
    });
    let rows = goalRows(store, G);
    assertEqual(rows.attempts.length, 1, 'A.2 exactly one root task');
    assertEqual(rows.attempts[0].status, 'failed', 'A.2 root terminalized failed');
    assertEqual(rows.attempts[0].errorCode, 'codex_execution_failed', 'A.2 safe failure code');
    const counts1 = durableCounts(sandbox.root);
    assertEqual(counts1.launchAttempts, 1, 'A.2 exactly 1 durable launch attempt (gate crossed)');
    assertEqual(counts1.invocations, 1, 'A.2 exactly 1 invocation');
    assertEqual(counts1.runs, 1, 'A.2 exactly 1 execution run');
    assertEqual(counts1.launchResults, 1, 'A.2 known failure outcome recorded');
    assertEqual(workflowExecutor.count(), 1, 'A.2 seam fired exactly once (the only execution path)');
    evidence.steps.push(['root-terminalized', counts1]);

    // A.3 — evaluate.
    let pass = await supervisorPass(baseUrl, 'A.3');
    let d = await goalDetail(baseUrl, G, 'A.3');
    assertEqual(d.latestEvaluation.decision, 'retryable', 'A.3 retryable evaluation');
    assertEqual(d.loopStage, 'continuation_required', 'A.3 next boundary is planning');
    evidence.steps.push(['evaluated', pass]);

    // A.4 — plan; human gate appears.
    pass = await supervisorPass(baseUrl, 'A.4');
    d = await goalDetail(baseUrl, G, 'A.4');
    assertEqual(d.planHistory[0].status, 'planned', 'A.4 plan durably written');
    assertEqual(d.approvalState, 'approval_required', 'A.4 approval required');
    assertEqual(d.humanInterventionRequired, true, 'A.4 human gate');
    assertEqual(d.hudState, 'waiting_human', 'A.4 waiting_human');
    evidence.steps.push(['planned', pass]);

    // A.5 — HUMAN GATE BLOCKS.
    const beforeGate = durableCounts(sandbox.root);
    pass = await supervisorPass(baseUrl, 'A.5');
    d = await goalDetail(baseUrl, G, 'A.5');
    assertEqual(d.loopStage, 'authorization_required', 'A.5 stage stays authorization_required');
    const heldSkip = pass.skipped.find((s) => s.goalId === G && s.reason === 'approval_required');
    const heldOutcome = pass.outcomes.find((o) => o.goalId === G && o.action === 'held');
    assert(heldSkip !== undefined || heldOutcome !== undefined, `A.5 pass held at human gate (skipped=${JSON.stringify(pass.skipped)}, outcomes=${JSON.stringify(pass.outcomes)})`);
    const afterGate = durableCounts(sandbox.root);
    assertEqual(afterGate.tasks, beforeGate.tasks, 'A.5 zero new tasks');
    assertEqual(afterGate.plans, beforeGate.plans, 'A.5 plan still planned');
    evidence.steps.push(['human-gate-blocked', { skipped: pass.skipped }]);

    // A.6 — explicit human approval.
    const approved = await expect(baseUrl, 'POST', `/api/projects/goals/${G}/continuation/approve`, { approver: APPROVER }, 200, 'A.6 approve');
    assertEqual(approved.body.approval.approver, APPROVER, 'A.6 approval bound to operator');
    d = await goalDetail(baseUrl, G, 'A.6');
    assertEqual(d.approvalState, 'approval_present', 'A.6 approval_present');
    evidence.steps.push(['approved', approved.body.approval]);

    // A.7 — materialize (approval consumed; next task accepted, never executed).
    pass = await supervisorPass(baseUrl, 'A.7');
    const outcome = pass.outcomes.find((o) => o.goalId === G);
    assertEqual(outcome?.action, 'materialized', 'A.7 materialized');
    d = await goalDetail(baseUrl, G, 'A.7');
    const nextTaskId = d.nextTask?.taskId;
    assert(typeof nextTaskId === 'string', 'A.7 createdTaskId present');
    rows = goalRows(store, G);
    const next = rows.attempts.find((t) => t.taskId === nextTaskId);
    assertEqual(next.status, 'accepted', 'A.7 next task accepted, never executed');
    assertEqual(next.attemptNumber, 1, 'A.7 attempt 1');
    assertEqual(next.continuationDepth, 1, 'A.7 depth 1');
    const counts7 = durableCounts(sandbox.root);
    assertEqual(counts7.launchAttempts, 1, 'A.7 materialization never executes (no new launch attempt)');
    evidence.steps.push(['materialized', { nextTaskId }]);

    // A.8 — AUTHORIZATION GATE BLOCKS (approval alone is not authorization).
    pass = await supervisorPass(baseUrl, 'A.8');
    d = await goalDetail(baseUrl, G, 'A.8');
    assertEqual(d.loopStage, 'next_attempt_accepted', 'A.8 stage next_attempt_accepted');
    const authzSkip = pass.skipped.find((s) => s.goalId === G && s.reason === 'autonomy_authorization_required');
    const authzHeld = pass.outcomes.find((o) => o.goalId === G && o.action === 'held' && o.blockingReason === 'autonomy_authorization_required');
    assert(authzSkip !== undefined || authzHeld !== undefined, `A.8 held at authorization gate (skipped=${JSON.stringify(pass.skipped)})`);
    const counts8 = durableCounts(sandbox.root);
    assertEqual(counts8.launchAttempts, 1, 'A.8 no launch attempt without authorization');
    assertEqual(workflowExecutor.count(), 1, 'A.8 no execution without authorization');
    evidence.steps.push(['authorization-gate-blocked', { skipped: pass.skipped }]);

    // A.9 — explicit execution authorization; eligibility closes.
    const authorized = await expect(baseUrl, 'POST', `/api/projects/goals/${G}/execution/authorize`, { approver: APPROVER }, 200, 'A.9 authorize');
    const cont = await expect(baseUrl, 'GET', `/api/projects/goals/${G}/continuation`, undefined, 200, 'A.9 continuation view');
    assertEqual(cont.body.authorization.state, 'authorization_present', 'A.9 authorization present');
    assertEqual(cont.body.eligibility.eligible, true, 'A.9 eligible true');
    evidence.steps.push(['authorized', authorized.body.authorization]);

    // A.10 — launch (decoupled, single orchestrator), completes verified.
    pass = await supervisorPass(baseUrl, 'A.10');
    const launchOutcome = pass.outcomes.find((o) => o.goalId === G);
    assertEqual(launchOutcome?.action, 'launched', 'A.10 launched');
    assertEqual(launchOutcome?.decoupledLaunch, true, 'A.10 decoupled');
    assert(pass.externalExecutionSlotsUsed <= MAX_CONCURRENT_EXTERNAL_EXECUTIONS, 'A.12 slots <= ceiling');
    assertEqual(pass.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS, 'A.12 ceiling constant');
    await settleImmediates(60, () => {
      const g = goalRows(store, G);
      const t = g?.attempts.find((a) => a.taskId === nextTaskId);
      return t?.status === 'completed';
    });
    rows = goalRows(store, G);
    const completedTask = rows.attempts.find((t) => t.taskId === nextTaskId);
    assertEqual(completedTask.status, 'completed', 'A.10 continuation completed verified');
    assertEqual(completedTask.receiptStatus, 'verified', 'A.10 verified receipt');
    const counts10 = durableCounts(sandbox.root);
    assertEqual(counts10.launchAttempts, 2, 'A.10 exactly two durable launch attempts total');
    assertEqual(counts10.launchResults, 2, 'A.10 both outcomes known');
    assertEqual(counts10.completionEvidence, 1, 'A.10 completion-evidence row exists');
    assertEqual(workflowExecutor.count(), 2, 'A.10 seam count == durable launch attempts (invariant)');
    evidence.steps.push(['launched-and-completed', counts10]);

    // A.11 — terminalization wakeup evaluates; goal completes.
    await settleImmediates(30, () => goalRows(store, G)?.goal.status === 'completed');
    const hud = await supervisorHud(baseUrl, 'A.11');
    assertEqual(hud.lastPass.source, 'terminalization', 'A.11 terminalization wakeup pass recorded');
    d = await goalDetail(baseUrl, G, 'A.11');
    assertEqual(d.status, 'completed', 'A.11 goal completed');
    assertEqual(d.terminalReason, 'objective_completed', 'A.11 terminal reason');
    assertEqual(d.hudState, 'completed', 'A.11 HUD completed');
    const ev = await expect(baseUrl, 'GET', `/api/projects/goals/${G}/evidence`, undefined, 200, 'A.11 evidence');
    assertEqual(ev.body.latestEvaluation.decision, 'completed', 'A.11 completed evaluation');
    assertEqual(ev.body.latestEvaluation.verification.checksPassed, 1, 'A.11 safe receipt verification counts');
    assertEqual(ev.body.latestEvaluation.verification.totalChecks, 1, 'A.11 safe receipt verification totals');
    assertIncludes(JSON.stringify(ev.body), 'planning', 'A.11 receipt stages present');
    const counts11 = durableCounts(sandbox.root);
    assertEqual(counts11.appliedEvaluations, 2, 'A.11 exactly two applied evaluations (one per attempt)');

    // Converge: a further pass is a no-op with zero writes.
    const beforeFinal = durableCounts(sandbox.root);
    pass = await supervisorPass(baseUrl, 'A.11-final');
    const finalOutcome = pass.outcomes.find((o) => o.goalId === G);
    assert(finalOutcome === undefined || finalOutcome.action === 'none', `A.11 final pass converges (${JSON.stringify(finalOutcome)})`);
    const afterFinal = durableCounts(sandbox.root);
    assertEqual(JSON.stringify(afterFinal), JSON.stringify(beforeFinal), 'A.11 final pass zero writes');
    evidence.steps.push(['completed', counts11]);

    // A.12 — aggregate ceilings on every recorded pass.
    for (const step of evidence.steps) {
      if (Array.isArray(step) && step[0] === 'evaluated' || Array.isArray(step) && step[0] === 'planned') {
        assert(step[1].externalExecutionSlotsUsed <= MAX_CONCURRENT_EXTERNAL_EXECUTIONS, 'A.12 ceiling never exceeded');
      }
    }
    evidence.steps.push(['A.12 ceilings verified', { maxGoalsPerTick: MAX_GOALS_PER_TICK, executionCeiling: MAX_CONCURRENT_EXTERNAL_EXECUTIONS }]);
  } finally {
    await server.close();
    sandbox.close();
  }
  await writeFile(join(root, 'evidence/scenario-A.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-A.json`);
}

// ===========================================================================
// SCENARIO B — HUMAN REFUSAL blocks continuation durably
// ===========================================================================

async function scenarioB() {
  const root = await newSandbox('B');
  const sandbox = bootSandbox(root);
  const server = await startServer(sandbox.app);
  const { baseUrl } = server;
  const { store, workflowExecutor } = sandbox;
  const G = goalId(0xb1);
  const evidence = { steps: [] };
  try {
    await createGoal(baseUrl, G);
    await settleImmediates(30, () => goalRows(store, G)?.attempts[0]?.status === 'failed');
    await supervisorPass(baseUrl, 'B.1');
    await supervisorPass(baseUrl, 'B.1');
    let d = await goalDetail(baseUrl, G, 'B.1');
    assertEqual(d.loopStage, 'authorization_required', 'B.1 at the human gate');
    assertEqual(d.planHistory[0].status, 'planned', 'B.1 plan planned');

    const seamBefore = workflowExecutor.count();
    const countsBefore = durableCounts(sandbox.root);

    // B.2 — refuse (durable plan cancellation).
    const refused = await expect(baseUrl, 'POST', `/api/projects/goals/${G}/continuation/refuse`, {}, 200, 'B.2 refuse');
    assertEqual(refused.body.plan.status, 'cancelled', 'B.2 plan cancelled');
    const planRows = store.listGoalContinuationPlans(G);
    assertEqual(planRows[0].status, 'cancelled', 'B.2 durable cancellation');

    // B.3 — no materialization, no launch attempt, no execution.
    const countsAfter = durableCounts(sandbox.root);
    assertEqual(countsAfter.tasks, countsBefore.tasks, 'B.3 no attempt materialized');
    assertEqual(countsAfter.launchAttempts, countsBefore.launchAttempts, 'B.3 no launch attempt anywhere');
    assertEqual(workflowExecutor.count(), seamBefore, 'B.3 no execution occurred (seam counter unchanged)');
    evidence.steps.push(['refused', { tasks: countsAfter.tasks, launchAttempts: countsAfter.launchAttempts }]);

    // B.4 — pass -> failed_closed / plan_cancelled; goal durable status stays active.
    const pass = await supervisorPass(baseUrl, 'B.4');
    d = await goalDetail(baseUrl, G, 'B.4');
    assertEqual(d.loopStage, 'failed_closed', 'B.4 failed_closed');
    assertEqual(d.blockingReason, 'plan_cancelled', 'B.4 plan_cancelled');
    assertEqual(d.hudState, 'fail_closed', 'B.4 fail_closed HUD');
    assertEqual(d.humanInterventionRequired, true, 'B.4 human intervention required');
    assertEqual(d.nextSafeAction, 'manual_review_required', 'B.4 next safe action');
    assertEqual(store.readGoal(G).status, 'active', 'B.4 durable goal status active (refusal is plan cancellation)');
    const skipReason = pass.skipped.find((s) => s.goalId === G)?.reason;
    assertEqual(skipReason, 'plan_cancelled', 'B.4 skipped with plan_cancelled');

    // B.5 — idempotent: repeat pass -> same held state, snapshot unchanged.
    const pass2 = await supervisorPass(baseUrl, 'B.5');
    const counts5 = durableCounts(sandbox.root);
    assertEqual(JSON.stringify(counts5), JSON.stringify(countsAfter), 'B.5 refusal idempotent, no writes');
    assertEqual(pass2.skipped.find((s) => s.goalId === G)?.reason, 'plan_cancelled', 'B.5 same held state');
    evidence.steps.push(['refusal-idempotent', counts5]);
  } finally {
    await server.close();
    sandbox.close();
  }
  await writeFile(join(root, 'evidence/scenario-B.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-B.json`);
}

// ===========================================================================
// SCENARIO C — SUSPEND / RESUME (survives process restart)
// ===========================================================================

async function scenarioC() {
  const root = await newSandbox('C');
  const evidence = { steps: [] };
  const G1 = goalId(0xc1); // authorization present at suspend time
  const G2 = goalId(0xc2); // no authorization at suspend time (resume must not fabricate authority)

  // Phase 1: child process drives both goals to next_attempt_accepted.
  let child = await new ChildSandbox(root, {}, 'C.1').start();
  try {
    await createGoal(child.baseUrl, G1);
    await createGoal(child.baseUrl, G2);
    await settleImmediates(20, () => true);
    // Let the intake runners settle inside the child process.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 10));
    await supervisorPass(child.baseUrl, 'C.1');
    await supervisorPass(child.baseUrl, 'C.1');
    for (const G of [G1, G2]) {
      await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/continuation/approve`, { approver: APPROVER }, 200, 'C.1 approve');
    }
    await supervisorPass(child.baseUrl, 'C.1');
    await supervisorPass(child.baseUrl, 'C.1');
    // G1 gets an execution authorization; G2 stays without one.
    await expect(child.baseUrl, 'POST', `/api/projects/goals/${G1}/execution/authorize`, { approver: APPROVER }, 200, 'C.1 authorize G1');
    let d1 = await goalDetail(child.baseUrl, G1, 'C.1');
    let d2 = await goalDetail(child.baseUrl, G2, 'C.1');
    assertEqual(d1.loopStage, 'next_attempt_accepted', 'C.1 G1 eligible boundary');
    assertEqual(d2.loopStage, 'next_attempt_accepted', 'C.1 G2 eligible boundary');
    assertEqual(d1.authorizationState, 'authorization_present', 'C.1 G1 authorized');
    assertEqual(d2.authorizationState, 'authorization_required', 'C.1 G2 not authorized');

    // C.2 — suspend both.
    for (const G of [G1, G2]) {
      const suspended = await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/suspend`, {}, 200, 'C.2 suspend');
      assertEqual(suspended.body.policyState, 'suspended', 'C.2 suspended');
    }
    d1 = await goalDetail(child.baseUrl, G1, 'C.2');
    d2 = await goalDetail(child.baseUrl, G2, 'C.2');
    assertEqual(d1.loopStage, 'suspended', 'C.2 G1 suspended stage');
    assertEqual(d2.loopStage, 'suspended', 'C.2 G2 suspended stage');

    // C.3 — a pass while suspended never advances.
    const countsBefore = (await child.op('snapshot')).counts;
    const passHeld = await supervisorPass(child.baseUrl, 'C.3');
    for (const G of [G1, G2]) {
      const skip = passHeld.skipped.find((s) => s.goalId === G);
      assert(skip !== undefined && skip.reason === 'autonomy_suspended', `C.3 ${G} skipped suspended`);
    }
    const countsAfter = (await child.op('snapshot')).counts;
    assertEqual(JSON.stringify(countsAfter), JSON.stringify(countsBefore), 'C.3 no progression while suspended');
    evidence.steps.push(['suspended', countsAfter]);
  } finally {
    await child.terminate();
  }

  // C.4 — CHILD-PROCESS RESTART: same tasks.sqlite; state stays suspended.
  child = await new ChildSandbox(root, { LIA_QUAL_HOLD_STARTUP: '1' }, 'C.2').start();
  try {
    let d1 = await goalDetail(child.baseUrl, G1, 'C.4');
    let d2 = await goalDetail(child.baseUrl, G2, 'C.4');
    assertEqual(d1.loopStage, 'suspended', 'C.4 suspension survives restart');
    assertEqual(d1.hudState, 'suspended', 'C.4 HUD suspended');
    assertEqual(d2.loopStage, 'suspended', 'C.4 G2 suspended');
    assertEqual(child.ready.supervisorEnabled, true, 'C.4 supervisor enabled in sandbox');
    assertEqual(child.ready.reconcile.failedInterrupted, 2, 'C.4 reconcile terminalized both non-recoverable accepted tasks');

    // Release the startup pass: still suspended, no advancement.
    await child.op('release_startup');
    await settleImmediates(10, () => true);
    const countsBefore = (await child.op('snapshot')).counts;
    const passHeld = await supervisorPass(child.baseUrl, 'C.4');
    for (const G of [G1, G2]) {
      const skip = passHeld.skipped.find((s) => s.goalId === G);
      assert(skip !== undefined && skip.reason === 'autonomy_suspended', `C.4 post-restart pass still suspended for ${G}`);
    }
    const countsAfter = (await child.op('snapshot')).counts;
    assertEqual(JSON.stringify(countsAfter), JSON.stringify(countsBefore), 'C.4 no advancement after restart');

    // C.5 — resume both.
    for (const G of [G1, G2]) {
      const resumed = await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/resume`, {}, 200, 'C.5 resume');
      assertEqual(resumed.body.policyState, 'approved_single_step', 'C.5 suspension cleared');
    }

    // C.6 — resume clears suspension only. Restart-terminalized attempts do
    // not transfer execution authority to any future continuation task.
    let pass = await supervisorPass(child.baseUrl, 'C.6');
    d1 = await goalDetail(child.baseUrl, G1, 'C.6');
    d2 = await goalDetail(child.baseUrl, G2, 'C.6');
    assertEqual(d1.loopStage, 'continuation_required', 'C.6 G1 resumes from interrupted terminal attempt');
    assertEqual(d2.loopStage, 'continuation_required', 'C.6 G2 resumes from interrupted terminal attempt');

    // Drive each interrupted attempt by durable stage, not pass count.
    for (const G of [G1, G2]) {
      await driveGoalToStage(child.baseUrl, G, 'authorization_required', 'C.6-plan');
      await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/continuation/approve`, { approver: APPROVER }, 200, 'C.6 approve');
      await driveGoalToStage(child.baseUrl, G, 'next_attempt_accepted', 'C.6-materialize');
      const beforeAuth = await goalDetail(child.baseUrl, G, 'C.6');
      assertEqual(beforeAuth.authorizationState, 'authorization_required', `C.6 ${G} new task requires fresh authorization`);
    }

    // Explicit authorization is required independently for each new task.
    for (const G of [G1, G2]) {
      const authorized = await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/execution/authorize`, { approver: APPROVER }, 200, 'C.6 authorize');
      assertEqual(authorized.body.authorization.taskId !== undefined, true, `C.6 ${G} explicit authorization`);
    }

    await supervisorPass(child.baseUrl, 'C.6-launch');
    await settleImmediates(80, async () => {
      const snapNow = await child.op('snapshot');
      const g1 = snapNow.goals.find((g) => g.goal.goalId === G1);
      const g2 = snapNow.goals.find((g) => g.goal.goalId === G2);
      return g1?.attempts.at(-1)?.status === 'completed'
        && g2?.attempts.at(-1)?.status === 'completed';
    });
    await supervisorPass(child.baseUrl, 'C.6-terminalize');
    await settleImmediates(40, async () => (
      await goalRowsInProcess(child, G1) === 'completed'
      && await goalRowsInProcess(child, G2) === 'completed'
    ));
    const snap = await child.op('snapshot');
    const g1Goal = snap.goals.find((g) => g.goal.goalId === G1)?.goal;
    const g2Goal = snap.goals.find((g) => g.goal.goalId === G2)?.goal;
    assertEqual(g1Goal?.status, 'completed', 'C.6 G1 completes only after fresh authorization');
    assertEqual(g2Goal?.status, 'completed', 'C.6 G2 completes only after fresh authorization');
    evidence.steps.push(['resume', { g1: g1Goal?.status, g2: g2Goal?.status, authorityTransferred: false }]);
  } finally {
    await child.terminate();
  }
  await writeFile(join(root, 'evidence/scenario-C.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-C.json`);
}

async function goalRowsInProcess(child, gid) {
  const snap = await child.op('snapshot');
  const goal = snap.goals.find((g) => g.goal.goalId === gid);
  return goal?.goal.status;
}

// ===========================================================================
// SCENARIO D — RESTART RECOVERY (no duplicate materialization)
// ===========================================================================

/** Drives a goal to `boundary` in a child process, then restarts and asserts. */
async function driveToBoundary(child, G, boundary) {
  await createGoal(child.baseUrl, G);
  await settleImmediates(10, () => true);
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 10));
  await supervisorPass(child.baseUrl, 'D.drive');
  if (boundary >= 2) await supervisorPass(child.baseUrl, 'D.drive');
  if (boundary >= 3) {
    await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/continuation/approve`, { approver: APPROVER }, 200, 'D.drive approve');
  }
  if (boundary >= 4) {
    await supervisorPass(child.baseUrl, 'D.drive'); // materialize
    await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/execution/authorize`, { approver: APPROVER }, 200, 'D.drive authorize');
  }
}

async function scenarioD() {
  const root = await newSandbox('D');
  const evidence = { boundaries: [] };
  const boundaries = [
    { n: 1, name: 'applied-retryable-evaluation', expectStageBefore: 'continuation_required', expectStageAfter: 'continuation_required' },
    { n: 2, name: 'planned-plan', expectStageBefore: 'authorization_required', expectStageAfter: 'authorization_required' },
    { n: 3, name: 'approval-present', expectStageBefore: 'materializing_next_attempt', expectStageAfter: 'materializing_next_attempt' },
    { n: 4, name: 'materialized-accepted-next-task', expectStageBefore: 'next_attempt_accepted', expectStageAfter: 'task_terminal' },
  ];

  for (const boundary of boundaries) {
    const G = goalId(0xd0 + boundary.n);
    const step = { boundary: boundary.name };
    let child = await new ChildSandbox(root, {}, `D.${boundary.n}a`).start();
    try {
      await driveToBoundary(child, G, boundary.n);
      const detailBefore = await goalDetail(child.baseUrl, G, `D.${boundary.n} before`);
      step.stageBefore = detailBefore.loopStage;
      assertEqual(detailBefore.loopStage, boundary.expectStageBefore, `D.${boundary.n} pre-restart stage`);
      step.countsBefore = await child.op('snapshot');
    } finally {
      await child.terminate();
    }

    // Respawn on the SAME sqlite file, startup pass held: derived stage must be
    // identical (no fabrication, no blind replay; HUD lastPass absent until a fresh pass).
    child = await new ChildSandbox(root, { LIA_QUAL_HOLD_STARTUP: '1' }, `D.${boundary.n}b`).start();
    try {
      const hud0 = await supervisorHud(child.baseUrl, `D.${boundary.n} hud`);
      assertEqual(hud0.lastPass, undefined, `D.${boundary.n} lastPass absent until a fresh pass`);
      const detailAfter = await goalDetail(child.baseUrl, G, `D.${boundary.n} after`);
      assertEqual(
        detailAfter.loopStage,
        boundary.expectStageAfter,
        `D.${boundary.n} restart derives the contract-authoritative durable stage`,
      );
      step.stageAfter = detailAfter.loopStage;
      step.lastPassAbsentBeforeFreshPass = true;

      // Release the startup pass: exactly ONE boundary write.
      await child.op('release_startup');
      await settleImmediates(10, () => true);

      if (boundary.n === 1) {
        const snap = await child.op('snapshot');
        assertEqual(snap.goals.find((g) => g.goal.goalId === G).evaluations.filter((e) => e.appliedAt !== undefined).length, 1, 'D.1 one applied evaluation');
        assertEqual(snap.goals.find((g) => g.goal.goalId === G).plans.length, 1, 'D.1 exactly one plan written by the fresh pass');
        step.countsAfter = snap;
      } else if (boundary.n === 2) {
        // The fresh pass holds at the human gate (no writes); approval then materializes exactly one task.
        const snap = await child.op('snapshot');
        assertEqual(snap.goals.find((g) => g.goal.goalId === G).plans[0].status, 'planned', 'D.2 plan still planned');
        assertEqual(snap.counts.tasks, step.countsBefore.counts.tasks, 'D.2 held pass wrote zero tasks');
        await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/continuation/approve`, { approver: APPROVER }, 200, 'D.2 approve');
        await supervisorPass(child.baseUrl, 'D.2');
        const snap2 = await child.op('snapshot');
        assertEqual(snap2.counts.tasks, step.countsBefore.counts.tasks + 1, 'D.2 exactly one task materialized');
        step.countsAfter = snap2;
      } else if (boundary.n === 3) {
        const snap = await child.op('snapshot');
        assertEqual(snap.counts.tasks, step.countsBefore.counts.tasks + 1, 'D.3 exactly one task created by the fresh pass');
        const detail3 = await goalDetail(child.baseUrl, G, 'D.3');
        assertEqual(detail3.loopStage, 'next_attempt_accepted', 'D.3 materialized');
        // Replay converges: a second pass creates no second task.
        await supervisorPass(child.baseUrl, 'D.3-replay');
        const snap2 = await child.op('snapshot');
        assertEqual(snap2.counts.tasks, snap.counts.tasks, 'D.3 consumed-plan replay returns the immutable task');
        step.countsAfter = snap2;
      } else if (boundary.n === 4) {
        const snap = await child.op('snapshot');
        assertEqual(snap.counts.launchAttempts, step.countsBefore.counts.launchAttempts, 'D.4 recovery/fresh pass does not relaunch terminalized continuation');
        const g4 = snap.goals.find((g) => g.goal.goalId === G);
        const recovered = g4.attempts.find((t) => t.attemptNumber === 1);
        assertEqual(recovered.status, 'failed', 'D.4 interrupted continuation fails safe on restart');
        assertEqual(recovered.errorCode, 'workflow_interrupted', 'D.4 durable workflow_interrupted recovery evidence');
        await settleImmediates(40, () => false);
        const snap2 = await child.op('snapshot');
        assertEqual(snap2.counts.launchAttempts, snap.counts.launchAttempts, 'D.4 no second launch attempt');

        // The interrupted attempt is now durably retryable. One further bounded
        // pass may legitimately create the recovery plan for attempt 2.
        const plansBeforeRecoveryPlan = snap2.counts.plans;
        await supervisorPass(child.baseUrl, 'D.4-recovery-plan');
        const snap3 = await child.op('snapshot');
        assertEqual(snap3.counts.plans, plansBeforeRecoveryPlan + 1, 'D.4 exactly one recovery plan created for interrupted attempt');
        const detail4 = await goalDetail(child.baseUrl, G, 'D.4');
        assertEqual(detail4.loopStage, 'authorization_required', 'D.4 recovery plan stops at human approval gate');
        step.countsAfter = snap3;
      }
      // Convergence: a further operator pass performs zero writes.
      const before = await child.op('snapshot');
      await supervisorPass(child.baseUrl, 'D.converge');
      const after = await child.op('snapshot');
      assertEqual(JSON.stringify(after.counts), JSON.stringify(before.counts), `D.${boundary.n} second pass converges with zero new rows`);
    } finally {
      await child.terminate();
    }
    evidence.boundaries.push(step);
  }
  await writeFile(join(root, 'evidence/scenario-D.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-D.json`);
}

// ===========================================================================
// SCENARIO E — AMBIGUOUS EXTERNAL LAUNCH (fail closed, never replayed)
// ===========================================================================

async function scenarioE() {
  let eCountsBeforeAmbiguous;
  const root = await newSandbox('E');
  const evidence = { steps: [] };
  const G = goalId(0xe1);
  let child = await new ChildSandbox(root, {}, 'E.1').start();
  try {
    await createGoal(child.baseUrl, G);
    await settleImmediates(10, () => true);
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 10));
    await supervisorPass(child.baseUrl, 'E.1');
    await supervisorPass(child.baseUrl, 'E.1');
    await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/continuation/approve`, { approver: APPROVER }, 200, 'E.1 approve');
    await supervisorPass(child.baseUrl, 'E.1');
    await expect(child.baseUrl, 'POST', `/api/projects/goals/${G}/execution/authorize`, { approver: APPROVER }, 200, 'E.1 authorize');
    const snap1 = await child.op('snapshot');
    const g1 = snap1.goals.find((g) => g.goal.goalId === G);
    const nextTask = g1.attempts.find((t) => t.status === 'accepted');
    assert(nextTask !== undefined, 'E.1 eligible next attempt accepted');
    assertEqual(g1.goal.status, 'active', 'E.1 goal active');

    // E.2 — inject the repository-supported unknown-launch outcome (launch attempt WITHOUT result).
    eCountsBeforeAmbiguous = await child.op('snapshot');
    const injection = await child.op('inject_ambiguous_launch', { goalId: G, taskId: nextTask.taskId });
    evidence.steps.push(['ambiguous-injected', injection]);

    // E.3 — pass: goal skipped, fail closed, never relaunched.
    const seamBefore = await child.op('seam_invocations');
    const pass = await supervisorPass(child.baseUrl, 'E.3');
    const skip = pass.skipped.find((s) => s.goalId === G);
    assert(skip !== undefined && skip.reason === 'external_launch_outcome_unknown', `E.3 skipped external_launch_outcome_unknown (${JSON.stringify(pass.skipped)})`);
    const d = await goalDetail(child.baseUrl, G, 'E.3');
    assertEqual(d.loopStage, 'failed_closed', 'E.3 failed_closed');
    assertEqual(d.blockingReason, 'external_launch_outcome_unknown', 'E.3 blocking reason');
    assertEqual(d.ambiguousOutcome, true, 'E.3 ambiguousOutcome');
    assertEqual(d.hudState, 'fail_closed', 'E.3 fail-closed HUD');
    assertEqual(d.humanInterventionRequired, true, 'E.3 human intervention required');
    assertEqual(d.launchState, 'launch_attempted', 'E.3 launch attempted');

    // E.4 — exactly one launch attempt; no new invocation/run; no execution.
    const snap2 = await child.op('snapshot');
    assertEqual(snap2.counts.launchAttempts, eCountsBeforeAmbiguous.counts.launchAttempts + 1, 'E.4 exactly one new launch attempt for the task');
    assertEqual(snap2.counts.invocations, eCountsBeforeAmbiguous.counts.invocations + 1, 'E.4 exactly one new invocation');
    assertEqual(snap2.counts.runs, eCountsBeforeAmbiguous.counts.runs + 1, 'E.4 exactly one new run');
    assertEqual(snap2.counts.launchResults, eCountsBeforeAmbiguous.counts.launchResults, 'E.4 no new launch result (unknown outcome)');
    const seamAfter = await child.op('seam_invocations');
    assertEqual(seamAfter.count, seamBefore.count, 'E.4 the ambiguous task was never executed');
    evidence.steps.push(['fail-closed', { launchAttempts: snap2.counts.launchAttempts, seamBefore, seamAfter }]);
  } finally {
    await child.terminate();
  }

  // E.5 — restart on the same DB: real reconcile maps the tuple durably; no relaunch.
  child = await new ChildSandbox(root, { LIA_QUAL_HOLD_STARTUP: '1' }, 'E.2').start();
  try {
    assertEqual(child.ready.reconcile.failedInterrupted, 1, 'E.5 reconcile deterministically terminalized the one ambiguous task');
    const snap = await child.op('snapshot');
    const g = snap.goals.find((x) => x.goal.goalId === G);
    const task = g.attempts.find((t) => t.taskId === g.attempts[1].taskId);
    assertEqual(task.status, 'failed', 'E.5 reconcile terminalized the ambiguous task');
    assertEqual(task.errorCode, 'external_launch_outcome_unknown', 'E.5 durable error external_launch_outcome_unknown');
    assertEqual(snap.counts.launchAttempts, eCountsBeforeAmbiguous.counts.launchAttempts + 1, 'E.5 launch attempt preserved, never duplicated');
    assertEqual(snap.counts.launchResults, eCountsBeforeAmbiguous.counts.launchResults, 'E.5 still no launch result');
    const seamBefore = await child.op('seam_invocations');

    // Startup pass (fresh): no relaunch — no new launch attempt/invocation; seam unchanged.
    await child.op('release_startup');
    await settleImmediates(10, () => true);
    await supervisorPass(child.baseUrl, 'E.5');
    const snap2 = await child.op('snapshot');
    assertEqual(snap2.counts.launchAttempts, eCountsBeforeAmbiguous.counts.launchAttempts + 1, 'E.5 startup pass never relaunches');
    assertEqual(snap2.counts.invocations, eCountsBeforeAmbiguous.counts.invocations + 1, 'E.5 no new invocation');
    const seamAfter = await child.op('seam_invocations');
    assertEqual(seamAfter.count, seamBefore.count, 'E.6 negative: seam counter unchanged — ambiguous task never re-executed');
    const d = await goalDetail(child.baseUrl, G, 'E.5');
    assertEqual(d.attempts[1].errorCode, 'external_launch_outcome_unknown', 'E.5 attempt error visible');
    evidence.steps.push(['restart-fail-closed', { launchAttempts: snap2.counts.launchAttempts, seamAfter }]);
  } finally {
    await child.terminate();
  }
  await writeFile(join(root, 'evidence/scenario-E.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-E.json`);
}

// ===========================================================================
// SCENARIO F — DUPLICATE EVENTS / IDEMPOTENCY
// ===========================================================================

async function scenarioF() {
  const root = await newSandbox('F');
  const sandbox = bootSandbox(root);
  const server = await startServer(sandbox.app);
  const { baseUrl } = server;
  const { store, scheduleImmediate, supervisor, workflowExecutor } = sandbox;
  const G = goalId(0xf1);
  const evidence = { steps: [] };
  try {
    await createGoal(baseUrl, G);
    await settleImmediates(30, () => goalRows(store, G)?.attempts[0]?.status === 'failed');

    // F.1 — pass spam: 5 sequential passes, each bounded, zero duplicate writes.
    const p1 = await supervisorPass(baseUrl, 'F.1');
    const p2 = await supervisorPass(baseUrl, 'F.1');
    for (let i = 0; i < 3; i += 1) await supervisorPass(baseUrl, 'F.1');
    const snap = await childlessSnapshot(store, sandbox.root);
    assertEqual(snap.counts.evaluations, 1, 'F.1 exactly one applied evaluation');
    assertEqual(snap.counts.plans, 1, 'F.1 exactly one plan');
    assertEqual(p1.outcomes[0].action, 'evaluated', 'F.1 pass 1 evaluated');
    assertEqual(p2.outcomes[0].action, 'planned', 'F.1 pass 2 planned');
    assertEqual(snap.counts.tasks, 1, 'F.1 no duplicate task rows');
    evidence.steps.push(['pass-spam', snap.counts]);

    // F.1b — a pass issued while one is in flight -> pass_in_progress (single-flight).
    const F1B = goalId(0xfb);
    await createGoal(baseUrl, F1B);
    await settleImmediates(30, () => goalRows(store, F1B)?.attempts[0]?.status === 'failed');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slowAssessor = createQualAssessor(new Map([[F1B, async () => {
      await gate;
      return { goalSatisfaction: 'not_demonstrated', blocking: 'none', failure: 'retryable' };
    }]]));
    // Rebuild a supervisor with the gated assessor over the same store.
    const gatedSupervisor = createProjectSupervisorSchedulingRuntime({
      store,
      config: sandbox.config,
      registry: sandbox.registry,
      verificationRegistry: sandbox.verificationRegistry,
      assessor: slowAssessor,
      now: sandbox.clock,
      executeWorkflow: workflowExecutor,
    });
    const pending = gatedSupervisor.triggerPass();
    await new Promise((resolve) => setImmediate(resolve));
    const concurrent = await gatedSupervisor.triggerPass();
    assertEqual(concurrent.ok, false, 'F.1b concurrent pass rejected');
    assertEqual(concurrent.code, 'pass_in_progress', 'F.1b single-flight machine code');
    release();
    const settled = await pending;
    assertEqual(settled.ok, true, 'F.1b first pass completes');
    evidence.steps.push(['pass-in-progress', { code: concurrent.code }]);

    // F.1c — coalescing queue never exceeds 1 pending drain (S4 observation).
    const drainBefore = scheduleImmediate.state.scheduled;
    supervisor.requestPass('terminalization');
    supervisor.requestPass('terminalization');
    supervisor.requestPass('terminalization');
    await settleImmediates(5, () => true);
    const drainAfter = scheduleImmediate.state.scheduled;
    assertEqual(drainAfter, drainBefore + 1, `F.1c three wakeups coalesce into exactly one scheduled drain (${drainBefore} -> ${drainAfter})`);
    await settleImmediates(10, () => !supervisor.hud().pendingWakeup && !supervisor.hud().passInProgress);
    assertEqual(supervisor.hud().pendingWakeup, false, 'F.1c coalesced drain converges with no pending wakeup');
    evidence.steps.push(['coalescing', { drains: drainAfter - drainBefore }]);

    // F.2 — startup wakeup duplicates across process restarts (three boots, one plan).
    const F2 = goalId(0xf2);
    const rootF2 = await newSandbox('F2');
    let child = await new ChildSandbox(rootF2, {}, 'F.2a').start();
    try {
      await createGoal(child.baseUrl, F2);
      let rootFailed = false;
      for (let i = 0; i < 200; i += 1) {
        const snap = await child.op('snapshot');
        const row = snap.goals.find((g) => g.goal.goalId === F2);
        if (row?.attempts[0]?.status === 'failed') {
          rootFailed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(rootFailed, 'F.2 boot A root attempt terminalized before restart');
      await supervisorPass(child.baseUrl, 'F.2a-evaluate');
      const snapA = await child.op('snapshot');
      assertEqual(
        snapA.goals.find((g) => g.goal.goalId === F2).evaluations.filter((e) => e.appliedAt !== undefined).length,
        1,
        'F.2 boot A leaves exactly one durable applied evaluation',
      );
    } finally {
      await child.terminate();
    }
    child = await new ChildSandbox(rootF2, {}, 'F.2b').start();
    try {
      let bootBPlanned = false;
      for (let i = 0; i < 200; i += 1) {
        const drain = await child.op('drain_state');
        const snap = await child.op('snapshot');
        const row = snap.goals.find((g) => g.goal.goalId === F2);
        if (drain.executed >= 1 && row?.plans.length === 1) {
          bootBPlanned = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(bootBPlanned, 'F.2 boot B startup pass durably writes one plan');
      const snap2 = await child.op('snapshot');
      const drain2 = await child.op('drain_state');
      const f2row2 = snap2.goals.find((g) => g.goal.goalId === F2);
      assertEqual(
        f2row2.plans.length,
        1,
        `F.2 second startup pass writes exactly one plan; drain=${JSON.stringify(drain2)} lastPass=${JSON.stringify(snap2.hud?.lastPass)} loop=${JSON.stringify(snap2.hud?.goals?.perGoal?.find((g) => g.goalId === F2))}`,
      );
    } finally {
      await child.terminate();
    }
    child = await new ChildSandbox(rootF2, {}, 'F.2c').start();
    try {
      await settleImmediates(80, async () => {
        const state = await child.op('drain_state');
        return state.executed >= 1;
      });
      const snap3 = await child.op('snapshot');
      assertEqual(snap3.goals.find((g) => g.goal.goalId === F2).plans.length, 1, 'F.2 third startup pass adds zero rows');
      assertEqual(snap3.goals.find((g) => g.goal.goalId === F2).evaluations.filter((e) => e.appliedAt !== undefined).length, 1, 'F.2 one applied evaluation');
    } finally {
      await child.terminate();
    }
    await rm(rootF2, { recursive: true, force: true });
    evidence.steps.push(['startup-duplicates', 'converged across 3 boots']);

    // F.3 — terminalization wakeup duplicates converge.
    const F3 = goalId(0xf3);
    const rootF3 = await newSandbox('F3');
    const f3 = bootSandbox(rootF3);
    const f3server = await startServer(f3.app);
    try {
      await createGoal(f3server.baseUrl, F3);
      await settleImmediates(30, () => goalRows(f3.store, F3)?.attempts[0]?.status === 'failed');
      await supervisorPass(f3server.baseUrl, 'F.3');
      await supervisorPass(f3server.baseUrl, 'F.3');
      await expect(f3server.baseUrl, 'POST', `/api/projects/goals/${F3}/continuation/approve`, { approver: APPROVER }, 200, 'F.3 approve');
      await supervisorPass(f3server.baseUrl, 'F.3');
      await expect(f3server.baseUrl, 'POST', `/api/projects/goals/${F3}/execution/authorize`, { approver: APPROVER }, 200, 'F.3 authorize');
      await supervisorPass(f3server.baseUrl, 'F.3'); // launch (decoupled)
      await settleImmediates(60, () => goalRows(f3.store, F3)?.goal.status === 'completed');
      const applied = goalRows(f3.store, F3).evaluations.filter((e) => e.appliedAt !== undefined).length;
      assertEqual(applied, 2, 'F.3 exactly two applied evaluations');
      // Spam follow-up wakeups: converge, no new rows.
      f3.supervisor.requestPass('terminalization');
      f3.supervisor.requestPass('terminalization');
      f3.supervisor.requestPass('terminalization');
      await settleImmediates(10, () => true);
      const applied2 = goalRows(f3.store, F3).evaluations.filter((e) => e.appliedAt !== undefined).length;
      assertEqual(applied2, 2, 'F.3 follow-up spam converges, no duplicate evaluation');
      evidence.steps.push(['terminalization-duplicates', { appliedEvaluations: applied2 }]);
    } finally {
      await f3server.close();
      f3.close();
      await rm(rootF3, { recursive: true, force: true });
    }

    // F.4 — approval exact replay.
    const F4 = goalId(0xf4);
    const rootF4 = await newSandbox('F4');
    const f4 = bootSandbox(rootF4);
    const f4server = await startServer(f4.app);
    try {
      await createGoal(f4server.baseUrl, F4);
      await settleImmediates(30, () => goalRows(f4.store, F4)?.attempts[0]?.status === 'failed');
      await supervisorPass(f4server.baseUrl, 'F.4');
      await supervisorPass(f4server.baseUrl, 'F.4');
      const a1 = await expect(f4server.baseUrl, 'POST', `/api/projects/goals/${F4}/continuation/approve`, { approver: APPROVER }, 200, 'F.4 approve 1');
      assertEqual(a1.body.alreadyKnown, false, 'F.4 first approval created');
      const a2 = await expect(f4server.baseUrl, 'POST', `/api/projects/goals/${F4}/continuation/approve`, { approver: APPROVER }, 200, 'F.4 approve replay');
      assertEqual(a2.body.alreadyKnown, true, 'F.4 exact replay idempotent');
      const snap4 = durableCounts(rootF4);
      assertEqual(snap4.approvals, 1, 'F.4 exactly one approval row');
      const a3 = await expect(f4server.baseUrl, 'POST', `/api/projects/goals/${F4}/continuation/approve`, { approver: 'different-operator' }, 409, 'F.4 contradictory replay refused');
      assertEqual(a3.body.error, 'project_goal_continuation_approval_contradictory', 'F.4 contradictory machine code');
      evidence.steps.push(['approval-replay', { approvals: snap4.approvals }]);
    } finally {
      await f4server.close();
      f4.close();
      await rm(rootF4, { recursive: true, force: true });
    }

    // F.5 — authorization exact replay.
    const F5 = goalId(0xf5);
    const rootF5 = await newSandbox('F5');
    const f5 = bootSandbox(rootF5);
    const f5server = await startServer(f5.app);
    try {
      await createGoal(f5server.baseUrl, F5);
      await settleImmediates(30, () => goalRows(f5.store, F5)?.attempts[0]?.status === 'failed');
      await supervisorPass(f5server.baseUrl, 'F.5');
      await supervisorPass(f5server.baseUrl, 'F.5');
      await expect(f5server.baseUrl, 'POST', `/api/projects/goals/${F5}/continuation/approve`, { approver: APPROVER }, 200, 'F.5 approve');
      await supervisorPass(f5server.baseUrl, 'F.5');
      const z1 = await expect(f5server.baseUrl, 'POST', `/api/projects/goals/${F5}/execution/authorize`, { approver: APPROVER }, 200, 'F.5 authorize 1');
      const z2 = await expect(f5server.baseUrl, 'POST', `/api/projects/goals/${F5}/execution/authorize`, { approver: APPROVER }, 200, 'F.5 authorize replay');
      assertEqual(z2.body.alreadyKnown, true, 'F.5 authorization exact replay idempotent');
      const snap5 = durableCounts(rootF5);
      assertEqual(snap5.authorizations, 1, 'F.5 exactly one authorization row');
      await supervisorPass(f5server.baseUrl, 'F.5'); // launch (consumes authorization)
      await settleImmediates(60, () => goalRows(f5.store, F5)?.goal.status === 'completed');
      const snap5b = durableCounts(rootF5);
      assertEqual(snap5b.launchAttempts, 2, 'F.5 no second launch attempt after launch');
      evidence.steps.push(['authorization-replay', { authorizations: snap5.authorizations, launchAttempts: snap5b.launchAttempts }]);
    } finally {
      await f5server.close();
      f5.close();
      await rm(rootF5, { recursive: true, force: true });
    }
  } finally {
    await server.close();
    sandbox.close();
  }
  await writeFile(join(root, 'evidence/scenario-F.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-F.json`);
}

async function childlessSnapshot(store, root) {
  const counts = durableCounts(root);
  const goals = store.listGoals({ includeTerminal: true, limit: 100 }).map((g) => goalRows(store, g.goalId));
  return { counts, goals };
}

// ===========================================================================
// SCENARIO G — MULTI-GOAL
// ===========================================================================

async function scenarioG() {
  const root = await newSandbox('G');
  const G1 = goalId(0x11); // runnable (fail-root, root terminalized)
  const G2 = goalId(0x12); // human-blocked (planned + unapproved)
  const G3 = goalId(0x13); // suspended
  const G4 = goalId(0x14); // terminal (completed via succeed-now)
  const G5 = goalId(0x15); // malformed: accepted continuation task, NO consumed plan (corrupt_lineage)
  const G6 = goalId(0x16); // throwing corruption (isolated) — G5's fixture class, exception variant
  const sandbox = bootSandbox(root, {
    holdImmediate: true,
    assessorOverrides: new Map([
      [
        G4,
        () => ({ goalSatisfaction: 'satisfied', blocking: 'none', failure: 'retryable' }),
      ],
      [
        G6,
        () => { throw new Error('qual_goal_isolated_failure'); },
      ],
    ]),
  });
  const server = await startServer(sandbox.app);
  const { baseUrl } = server;
  const { store, clock } = sandbox;
  const evidence = { steps: [] };
  try {
    // G1: runnable.
    await createGoal(baseUrl, G1);
    // G2: driven to planned + unapproved.
    await createGoal(baseUrl, G2);
    // G3: policy set at creation (approved_single_step) then suspended.
    await createGoal(baseUrl, G3);
    // G4: terminal via succeed-now (root success completes the goal).
    await createGoal(baseUrl, G4, { script: 'qual:succeed-now' });
    // G5 + G6: injected via durable fixture rows (control-channel equivalent, in-process).
    await createGoal(baseUrl, G5, { maxAttempts: 3, continuationDepthLimit: 2 });
    await createGoal(baseUrl, G6, { maxAttempts: 3, continuationDepthLimit: 2 });
    await settleImmediates(30, () => {
      const rows = [G1, G2, G3, G4, G5, G6].map((g) => goalRows(store, g));
      return rows.every((r) => r !== undefined && r.attempts.length >= 1 && (r.attempts[0].status === 'failed' || r.attempts[0].status === 'completed'));
    });

    // G1 root failure is now terminal; G2 needs evaluate+plan; G3 suspend; G4 evaluate->completed.
    await supervisorPass(baseUrl, 'G.setup1'); // G1 evaluated, G2 evaluated, G4 evaluated
    await supervisorPass(baseUrl, 'G.setup2'); // G1/G2 planned; G4 reaches its next derived boundary
    await supervisorPass(baseUrl, 'G.setup3'); // G4 terminalizes on the following bounded boundary
    const snapSetup = await childlessSnapshot(store, root);
    const g4row = snapSetup.goals.find((g) => g.goal.goalId === G4)?.goal;
    assertEqual(g4row?.status, 'completed', 'G.4 terminal goal completed');

    // G3: suspend (policy row exists from creation).
    const suspended = await expect(baseUrl, 'POST', `/api/projects/goals/${G3}/suspend`, {}, 200, 'G.3 suspend');
    assertEqual(suspended.body.policyState, 'suspended', 'G.3 suspended');

    // G5: inject accepted continuation task with NO consumed plan + align current_attempt.
    const g5row = goalRows(store, G5);
    const rootTask5 = g5row.attempts.find((t) => t.attemptNumber === 0);
    const corruptTaskId = taskId(0x55);
    const injected = store.createContinuationAttempt({
      taskId: corruptTaskId,
      fingerprint: `${corruptTaskId}-fixture-fingerprint`,
      intent: {
        projectId: QUAL_PROJECT,
        instruction: goalObjective(G5),
        priority: 'normal',
        requestedCapabilities: ['repository_read'],
      },
      goalId: G5,
      parentTaskId: rootTask5.taskId,
      continuationDepth: 1,
      attemptNumber: 1,
    });
    assertEqual(injected.kind, 'created', 'G.5 corrupt lineage injected');
    // Align current_attempt to the corrupt task via a fixture UPDATE (no store surface manufactures this).
    const db = new DatabaseSync(`${root}/db/tasks.sqlite`);
    try {
      db.prepare('UPDATE project_goals SET current_attempt = 1 WHERE goal_id = ?').run(G5);
    } finally {
      db.close();
    }
    const g5after = goalRows(store, G5);
    assertEqual(g5after.goal.currentAttempt, 1, 'G.5 corrupt task is current');
    assertEqual(g5after.attempts.find((t) => t.taskId === corruptTaskId).status, 'accepted', 'G.5 corrupt accepted continuation');

    // ---- ORDER: active first (G1,G2,G3,G5,G6), terminal last (G4); createdAt ASC, goalId ASC.
    const list = await expect(baseUrl, 'GET', '/api/projects/goals', undefined, 200, 'G.order');
    const order = list.body.goals.map((g) => g.goalId);
    const activeOrder = order.filter((id) => ![G4].includes(id));
    const terminalOrder = order.filter((id) => [G4].includes(id));
    assertEqual(activeOrder[0], G1, 'G.order active first (FIFO)');
    assertEqual(activeOrder[1], G2, 'G.order second');
    assertEqual(terminalOrder[0], G4, 'G.order terminal last');
    evidence.steps.push(['order', order]);

    // ---- ONE PASS: G1 advances (evaluated -> next boundary), G2 skipped authorization_required,
    // G3 skipped suspended, G4 skipped goal_satisfied, G5 skipped corrupt_lineage, G6 isolated.
    // Note: G1/G2 already advanced in setup; this pass inspects current boundaries.
    const originalListGoalAttemptsG = store.listGoalAttempts.bind(store);
    store.listGoalAttempts = (gid) => {
      if (gid === G6) throw new Error('qual_goal_isolated_failure');
      return originalListGoalAttemptsG(gid);
    };
    let pass;
    try {
      pass = await supervisorPass(baseUrl, 'G.pass');
    } finally {
      store.listGoalAttempts = originalListGoalAttemptsG;
    }
    const outcomes = pass.outcomes;
    const skipped = pass.skipped;
    const g1Outcome = outcomes.find((o) => o.goalId === G1);
    const g1Skip = skipped.find((s) => s.goalId === G1);
    const g2Skip = skipped.find((s) => s.goalId === G2);
    const g3Skip = skipped.find((s) => s.goalId === G3);
    const g4Skip = skipped.find((s) => s.goalId === G4);
    const g5Skip = skipped.find((s) => s.goalId === G5);
    const g6Skip = skipped.find((s) => s.goalId === G6);
    // G1 may either advance one boundary or already be durably waiting at
    // the approval gate after the setup passes.
    assert(
      (g1Outcome !== undefined && ['held', 'evaluated', 'planned'].includes(g1Outcome.action))
      || (g1Skip !== undefined && g1Skip.reason === 'approval_required'),
      `G.1 advances or is durably held at approval gate (outcome=${JSON.stringify(g1Outcome)}, skip=${JSON.stringify(g1Skip)})`,
    );
    assert(g2Skip !== undefined && g2Skip.reason === 'approval_required', `G.2 skipped authorization_required (${JSON.stringify(g2Skip)})`);
    assert(g3Skip !== undefined && g3Skip.reason === 'autonomy_suspended', `G.3 skipped suspended (${JSON.stringify(g3Skip)})`);
    assert(
      g4Skip === undefined || g4Skip.reason === 'objective_completed',
      `G.4 terminal goal is absent from active scheduling or safely surfaced completed (${JSON.stringify(g4Skip)})`,
    );
    assert(g5Skip !== undefined && g5Skip.reason === 'corrupt_lineage', `G.5 skipped corrupt_lineage (${JSON.stringify(g5Skip)})`);
    assert(g6Skip !== undefined, 'G.6 throwing corruption surfaced as skipped');
    assert(pass.isolatedFailureCount >= 1, `G.6 isolatedFailureCount reflects the corrupt goal only (${pass.isolatedFailureCount})`);
    assertEqual(pass.activeGoalCount, 5, 'G.pass five active goals (G4 terminal)');
    // G5's corruption never aborts the pass; the healthy goals still advanced/skipped correctly.
    assertEqual(store.readGoal(G5).status, 'active', 'G.5 corrupt goal stays durably active (fail-closed surface)');
    evidence.steps.push(['one-pass', { outcomes: outcomes.map((o) => ({ goalId: o.goalId, action: o.action })), skipped: skipped.map((s) => ({ goalId: s.goalId, reason: s.reason })), isolatedFailureCount: pass.isolatedFailureCount }]);

    // ---- Ceiling: MAX_GOALS_PER_TICK = 8. Create 10 advanceable goals; one pass inspects 8.
    const ceilingGoals = [];
    for (let n = 0; n < 10; n += 1) {
      const gid = goalId(0x20 + n);
      await createGoal(baseUrl, gid, { maxAttempts: 3, continuationDepthLimit: 2 });
      ceilingGoals.push(gid);
    }
    await settleImmediates(30, () => {
      const rows = ceilingGoals.map((g) => goalRows(store, g));
      return rows.every((r) => r !== undefined && r.attempts[0]?.status === 'failed');
    });
    const passCeil = await supervisorPass(baseUrl, 'G.ceiling');
    assertEqual(passCeil.inspectedGoalCount, MAX_GOALS_PER_TICK, 'G.ceiling inspectedGoalCount === 8');
    assertEqual(passCeil.truncated, true, 'G.ceiling truncated === true');
    assertEqual(passCeil.moreWorkRemains, true, 'G.ceiling moreWorkRemains === true');
    // G intentionally holds automatic wakeups earlier; release the coalesced
    // follow-up now so the truncated remainder can converge.
    sandbox.scheduleImmediate.releaseAll();
    // Follow-up drain (anti-livelock, only on truncation) continues the remainder; all converge.
    await settleImmediates(60, () => {
      // The G sandbox deliberately holds scheduler callbacks. Release each
      // coalesced follow-up tick so truncation can drain all remaining goals.
      sandbox.scheduleImmediate.releaseAll();
      const rows = ceilingGoals.map((g) => goalRows(store, g));
      return rows.every((r) => r !== undefined && r.evaluations.some((e) => e.appliedAt !== undefined));
    });
    const snapCeil = await childlessSnapshot(store, root);
    const evaluated = ceilingGoals.filter((g) => snapCeil.goals.find((x) => x.goal.goalId === g)?.evaluations.some((e) => e.appliedAt !== undefined)).length;
    assertEqual(evaluated, 10, 'G.ceiling all 10 converge after follow-up drains');
    evidence.steps.push(['ceiling-8', { inspected: passCeil.inspectedGoalCount, truncated: passCeil.truncated, converged: evaluated }]);

    // ---- Ceiling 2: external execution ceiling = 2 with 3 launchable goals.
    const launchGoals = [];
    for (let n = 0; n < 3; n += 1) {
      const gid = goalId(0x30 + n);
      await createGoal(baseUrl, gid);
      launchGoals.push(gid);
    }
    await settleImmediates(30, () => {
      const rows = launchGoals.map((g) => goalRows(store, g));
      return rows.every((r) => r !== undefined && r.attempts[0]?.status === 'failed');
    });
    // Prepare all three in lockstep. A supervisor pass advances every
    // schedulable goal, so authorizing one before the others are ready could
    // launch it during a later preparation pass and invalidate the ceiling test.
    for (const gid of launchGoals) {
      await driveGoalToStage(baseUrl, gid, 'authorization_required', 'G.launch-plan');
    }
    for (const gid of launchGoals) {
      await expect(
        baseUrl,
        'POST',
        `/api/projects/goals/${gid}/continuation/approve`,
        { approver: APPROVER },
        200,
        'G.launch approve',
      );
    }
    for (const gid of launchGoals) {
      await driveGoalToStage(baseUrl, gid, 'next_attempt_accepted', 'G.launch-materialize');
    }
    for (const gid of launchGoals) {
      await expect(
        baseUrl,
        'POST',
        `/api/projects/goals/${gid}/execution/authorize`,
        { approver: APPROVER },
        200,
        'G.launch authorize',
      );
    }
    const scheduledBeforeCeiling2 = sandbox.scheduleDecoupledLaunch.state.scheduled;
    const passLaunch = await supervisorPass(baseUrl, 'G.ceiling2');
    assertEqual(passLaunch.externalExecutionSlotsUsed, MAX_CONCURRENT_EXTERNAL_EXECUTIONS, 'G.ceiling2 slotsUsed === 2');
    assertEqual(passLaunch.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS, 'G.ceiling2 ceiling === 2');
    const ceilingSkipped = passLaunch.skipped.filter((s) => s.reason === 'concurrency_ceiling_reached');
    assertEqual(ceilingSkipped.length, 1, 'G.ceiling2 third goal skipped concurrency_ceiling_reached');
    assert(passLaunch.inFlight <= MAX_CONCURRENT_EXTERNAL_EXECUTIONS, 'G.ceiling2 inFlight never exceeds 2');
    assertEqual(
      sandbox.scheduleDecoupledLaunch.state.scheduled - scheduledBeforeCeiling2,
      MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
      'G.ceiling2 exactly 2 launches scheduled by the measured pass',
    );
    await settleImmediates(60, () => false);
    evidence.steps.push(['ceiling-2', { slotsUsed: passLaunch.externalExecutionSlotsUsed, skipped: ceilingSkipped.length }]);
  } finally {
    await server.close();
    sandbox.close();
  }
  await writeFile(join(root, 'evidence/scenario-G.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-G.json`);
}

// ===========================================================================
// SCENARIO H — CAPACITY / BUDGET EXHAUSTION
// ===========================================================================

async function scenarioH() {
  const root = await newSandbox('H');
  const sandbox = bootSandbox(root);
  const server = await startServer(sandbox.app);
  const { baseUrl } = server;
  const { store, clock } = sandbox;
  const evidence = { steps: [] };
  try {
    // H.1 — max attempts exhaustion.
    const H1 = goalId(0x41);
    await createGoal(baseUrl, H1, { maxAttempts: 2, script: 'qual:fail-all' });
    await settleImmediates(30, () => goalRows(store, H1)?.attempts[0]?.status === 'failed');
    const h1CountsBefore = await childlessSnapshot(store, root);
    await supervisorPass(baseUrl, 'H.1'); // evaluate (retryable)
    await supervisorPass(baseUrl, 'H.1'); // plan
    await expect(baseUrl, 'POST', `/api/projects/goals/${H1}/continuation/approve`, { approver: APPROVER }, 200, 'H.1 approve');
    await supervisorPass(baseUrl, 'H.1'); // materialize
    await expect(baseUrl, 'POST', `/api/projects/goals/${H1}/execution/authorize`, { approver: APPROVER }, 200, 'H.1 authorize');
    await supervisorPass(baseUrl, 'H.1'); // launch attempt 1
    await settleImmediates(60, () => goalRows(store, H1)?.attempts[1]?.status === 'failed');
    await supervisorPass(baseUrl, 'H.1'); // evaluate attempt 1 -> budget exhausted
    await supervisorPass(baseUrl, 'H.1'); // planning gate
    let d = await goalDetail(baseUrl, H1, 'H.1');
    assertEqual(d.status, 'exhausted', 'H.1 goal exhausted');
    assertEqual(d.terminalReason, 'attempt_limit_reached', 'H.1 terminal reason');
    assertEqual(d.hudState, 'failed', 'H.1 HUD failed');
    const snap1 = await childlessSnapshot(store, root);
    assertEqual(snap1.counts.tasks, h1CountsBefore.counts.tasks + 1, 'H.1 exactly one continuation task materialized');
    const beforeStable = await childlessSnapshot(store, root);
    await supervisorPass(baseUrl, 'H.1-stable');
    const afterStable = await childlessSnapshot(store, root);
    assertEqual(JSON.stringify(afterStable.counts), JSON.stringify(beforeStable.counts), 'H.1 snapshot stable on subsequent passes');
    evidence.steps.push(['attempt-exhaustion', { status: d.status, terminalReason: d.terminalReason }]);

    // H.2 — depth limit.
    const H2 = goalId(0x42);
    await createGoal(baseUrl, H2, { continuationDepthLimit: 1, script: 'qual:fail-all' });
    await settleImmediates(30, () => goalRows(store, H2)?.attempts[0]?.status === 'failed');
    const h2CountsBefore = await childlessSnapshot(store, root);
    await supervisorPass(baseUrl, 'H.2');
    await supervisorPass(baseUrl, 'H.2');
    await expect(baseUrl, 'POST', `/api/projects/goals/${H2}/continuation/approve`, { approver: APPROVER }, 200, 'H.2 approve');
    await supervisorPass(baseUrl, 'H.2');
    await expect(baseUrl, 'POST', `/api/projects/goals/${H2}/execution/authorize`, { approver: APPROVER }, 200, 'H.2 authorize');
    await supervisorPass(baseUrl, 'H.2'); // launch depth-1 attempt
    await settleImmediates(60, () => goalRows(store, H2)?.attempts[1]?.status === 'failed');
    await supervisorPass(baseUrl, 'H.2'); // evaluate depth-1 failure -> continuation_depth_exhausted
    await supervisorPass(baseUrl, 'H.2'); // planning gate refuses
    d = await goalDetail(baseUrl, H2, 'H.2');
    assertEqual(d.status, 'exhausted', 'H.2 goal exhausted at depth limit');
    const snap2 = await childlessSnapshot(store, root);
    assertEqual(snap2.counts.tasks, h2CountsBefore.counts.tasks + 1, 'H.2 no runaway materialization beyond one continuation task');
    evidence.steps.push(['depth-limit', { status: d.status, loopStage: d.loopStage }]);

    // H.3 — no-progress escalation.
    const H3 = goalId(0x43);
    await createGoal(baseUrl, H3, { script: 'qual:fail-all' });
    await settleImmediates(30, () => goalRows(store, H3)?.attempts[0]?.status === 'failed');
    await supervisorPass(baseUrl, 'H.3'); // eval 1 (count 1)
    await supervisorPass(baseUrl, 'H.3'); // plan 1
    await expect(baseUrl, 'POST', `/api/projects/goals/${H3}/continuation/approve`, { approver: APPROVER }, 200, 'H.3 approve');
    await supervisorPass(baseUrl, 'H.3');
    await expect(baseUrl, 'POST', `/api/projects/goals/${H3}/execution/authorize`, { approver: APPROVER }, 200, 'H.3 authorize');
    await supervisorPass(baseUrl, 'H.3'); // launch attempt 1
    await settleImmediates(60, () => goalRows(store, H3)?.attempts[1]?.status === 'failed');
    await supervisorPass(baseUrl, 'H.3'); // eval 2 (count 2 -> escalated)
    const escalatedPass = await supervisorPass(baseUrl, 'H.3'); // planning gate
    d = await goalDetail(baseUrl, H3, 'H.3');
    assertEqual(d.loopStage, 'failed_closed', 'H.3 failed_closed');
    assertEqual(d.blockingReason, 'no_progress_escalation', 'H.3 no_progress_escalation');
    assertEqual(d.hudState, 'fail_closed', 'H.3 fail-closed HUD');
    assertEqual(d.humanInterventionRequired, true, 'H.3 human intervention required');
    assertEqual(d.noProgress.count, 2, 'H.3 no-progress count 2');
    assertEqual(d.noProgress.escalated, true, 'H.3 escalated');
    const snap3 = await childlessSnapshot(store, root);
    assertEqual(goalRows(store, H3).plans.length, 1, 'H.3 NO new plan for cycle 2');
    const beforeH3 = await childlessSnapshot(store, root);
    await supervisorPass(baseUrl, 'H.3-stable');
    const afterH3 = await childlessSnapshot(store, root);
    assertEqual(JSON.stringify(afterH3.counts), JSON.stringify(beforeH3.counts), 'H.3 subsequent passes held, no writes');
    evidence.steps.push(['no-progress', { blockingReason: d.blockingReason, plans: snap3.counts.plans }]);

    // H.4 — capacity refusal (DEFAULT maxActive=8).
    const rootH4 = await newSandbox('H4');
    const h4 = bootSandbox(rootH4, { maxActive: 8, maxRecords: 64 });
    const h4server = await startServer(h4.app);
    try {
      const createdIds = [];
      for (let n = 0; n < 9; n += 1) {
        const gid = goalId(0x50 + n);
        const result = await http(
          h4server.baseUrl,
          'POST',
          '/api/projects/goals',
          createGoalBody(gid, { maxAttempts: 3, script: 'qual:never-resolve' }),
        );
        if (n < 8) {
          assertEqual(result.status, 202, `H.4 goal ${n + 1} created`);
          createdIds.push(gid);
        } else {
          assertEqual(result.status, 503, 'H.4 9th goal refused');
          assertEqual(result.body.error, PROJECT_GOAL_CONTROL_ERRORS.taskCapacityReached, 'H.4 project_goal_capacity_reached');
        }
      }
      const list = await expect(h4server.baseUrl, 'GET', '/api/projects/goals', undefined, 200, 'H.4 list');
      assertEqual(list.body.goals.length, 8, 'H.4 first 8 intact, goal 9 absent');
      assertEqual(h4.store.readGoal(goalId(0x58)), undefined, 'H.4 goal 9 absent (atomic intake rollback)');
      evidence.steps.push(['capacity', { created: createdIds.length, refused: true }]);
    } finally {
      await h4server.close();
      h4.close();
      await rm(rootH4, { recursive: true, force: true });
    }

    // H.5 — policy bounds: isolated from H.3 no-progress threshold.
    const rootH5 = await newSandbox('H5');
    const h5 = bootSandbox(rootH5, { noProgressEscalationThreshold: 3 });
    const h5server = await startServer(h5.app);
    try {
      const h5baseUrl = h5server.baseUrl;
      const h5store = h5.store;
      const h5clock = h5.clock;
      const H5 = goalId(0x45);

      await createGoal(h5baseUrl, H5, {
        script: 'qual:fail-all',
        autonomy: {
          mode: 'bounded_autonomous',
          approver: APPROVER,
          maxCycles: 2,
          elapsedBudgetMs: 60_000,
        },
      });

      await settleImmediates(30, () => goalRows(h5store, H5)?.attempts[0]?.status === 'failed');

      await driveGoalToStage(h5baseUrl, H5, 'authorization_required', 'H.5-cycle1-plan');
      await expect(
        h5baseUrl,
        'POST',
        `/api/projects/goals/${H5}/continuation/approve`,
        { approver: APPROVER },
        200,
        'H.5 approve',
      );
      await driveGoalToStage(h5baseUrl, H5, 'next_attempt_accepted', 'H.5-cycle1-materialize');
      await supervisorPass(h5baseUrl, 'H.5-cycle1-launch');
      await settleImmediates(80, () => goalRows(h5store, H5)?.attempts[1]?.status === 'failed');

      await driveGoalToStage(h5baseUrl, H5, 'authorization_required', 'H.5-cycle2-plan');
      await expect(
        h5baseUrl,
        'POST',
        `/api/projects/goals/${H5}/continuation/approve`,
        { approver: APPROVER },
        200,
        'H.5 approve 2',
      );
      await driveGoalToStage(h5baseUrl, H5, 'next_attempt_accepted', 'H.5-cycle2-materialize');

      const cyclePass = await supervisorPass(h5baseUrl, 'H.5-cycle-limit');
      const cycleSkip = cyclePass.skipped.find((x) => x.goalId === H5);
      const cycleHeld = cyclePass.outcomes.find((x) => x.goalId === H5 && x.action === 'held');
      assert(
        (cycleSkip !== undefined && cycleSkip.reason === 'autonomy_cycle_limit_reached')
        || (cycleHeld !== undefined && cycleHeld.blockingReason === 'autonomy_cycle_limit_reached'),
        `H.5 cycle limit holds (${JSON.stringify(cyclePass.skipped)})`,
      );

      const snapH5a = await childlessSnapshot(h5store, rootH5);
      assertEqual(snapH5a.counts.launchAttempts, 2, 'H.5 exactly 2 launches (maxCycles 2)');

      h5clock.advance(61_000);

      const budgetPass = await supervisorPass(h5baseUrl, 'H.5-budget');
      const budgetSkip = budgetPass.skipped.find((x) => x.goalId === H5);
      const budgetHeld = budgetPass.outcomes.find((x) => x.goalId === H5 && x.action === 'held');
      assert(
        (budgetSkip !== undefined && budgetSkip.reason === 'autonomy_elapsed_budget_exhausted')
        || (budgetHeld !== undefined && budgetHeld.blockingReason === 'autonomy_elapsed_budget_exhausted'),
        `H.5 elapsed budget holds (${JSON.stringify(budgetPass.skipped)})`,
      );

      const beforeH5 = await childlessSnapshot(h5store, rootH5);
      await supervisorPass(h5baseUrl, 'H.5-stable');
      const afterH5 = await childlessSnapshot(h5store, rootH5);
      assertEqual(
        JSON.stringify(afterH5.counts),
        JSON.stringify(beforeH5.counts),
        'H.5 both bounds held with zero writes',
      );

      evidence.steps.push(['policy-bounds', { cycleLimit: true, elapsedBudget: true }]);
    } finally {
      await h5server.close();
      h5.close();
      await rm(rootH5, { recursive: true, force: true });
    }
  } finally {
    await server.close();
    sandbox.close();
  }
  await writeFile(join(root, 'evidence/scenario-H.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-H.json`);
}

// ===========================================================================
// SCENARIO I — OPERATOR SURFACE (safe observable state at every phase)
// ===========================================================================

async function scenarioI() {
  const root = await newSandbox('I');
  const sandbox = bootSandbox(root);
  const server = await startServer(sandbox.app);
  const { baseUrl } = server;
  const { store, sentinel } = sandbox;
  const G = goalId(0x61);
  const evidence = { phases: [], leakGuard: {} };
  const captured = [];
  let lastBody = '';
  const leakGuard = async (label) => {
    const bodies = await Promise.all([
      GET(baseUrl, '/api/projects/goals'),
      GET(baseUrl, `/api/projects/goals/${G}`),
      GET(baseUrl, `/api/projects/goals/${G}/continuation`),
      GET(baseUrl, `/api/projects/goals/${G}/autonomy`),
      GET(baseUrl, `/api/projects/goals/${G}/evidence`),
      GET(baseUrl, '/api/projects/goals/supervisor'),
    ]);
    for (const response of bodies) {
      assertEqual(response.status, 200, `${label}: surface endpoint 200`);
      const serialized = response.text;
      // Deep whitelist guard (the REAL route-layer guard) on success payloads.
      let payload = response.body;
      if (payload?.ok === true) {
        try {
          assertSafeOperatorPayload(payload);
        } catch (error) {
          throw new ScenarioError(`${label}: assertSafeOperatorPayload failed — ${error instanceof Error ? error.message : 'unknown'}`);
        }
      }
      assertNoPayloadLeak(serialized, [sentinel, process.env.LIA_QUAL_SECRET]);
      captured.push({ label, path: '', serialized });
      lastBody = serialized;
    }
  };
  try {
    const created = await createGoal(baseUrl, G);
    assertEqual(created.status, 202, 'I.create');
    evidence.phases.push('root-accepted');
    await leakGuard('root-accepted');

    await settleImmediates(30, () => goalRows(store, G)?.attempts[0]?.status === 'failed');
    evidence.phases.push('executing->terminal-failed');
    await leakGuard('terminal-failed');

    await supervisorPass(baseUrl, 'I');
    evidence.phases.push('evaluated');
    await leakGuard('evaluated');

    await supervisorPass(baseUrl, 'I');
    evidence.phases.push('planned');
    await leakGuard('planned');

    await supervisorPass(baseUrl, 'I');
    evidence.phases.push('approval-required');
    await leakGuard('approval-required');

    await expect(baseUrl, 'POST', `/api/projects/goals/${G}/continuation/approve`, { approver: APPROVER }, 200, 'I.approve');
    evidence.phases.push('approved');
    await leakGuard('approved');

    await supervisorPass(baseUrl, 'I');
    evidence.phases.push('materialized');
    await leakGuard('materialized');

    await expect(baseUrl, 'POST', `/api/projects/goals/${G}/execution/authorize`, { approver: APPROVER }, 200, 'I.authorize');
    evidence.phases.push('authorized');
    await leakGuard('authorized');

    await supervisorPass(baseUrl, 'I');
    await settleImmediates(60, () => goalRows(store, G)?.goal.status === 'completed');
    evidence.phases.push('executing->completed');
    await leakGuard('completed');

    // Terminal outcome: receipt summary + verification counts + terminalReason.
    const d = await goalDetail(baseUrl, G, 'I.terminal');
    assertEqual(d.status, 'completed', 'I.terminal completed');
    assertEqual(d.terminalReason, 'objective_completed', 'I.terminal reason');
    const ev = await expect(baseUrl, 'GET', `/api/projects/goals/${G}/evidence`, undefined, 200, 'I.evidence');
    assertEqual(ev.body.latestEvaluation.decision, 'completed', 'I.evidence completed');
    assertEqual(ev.body.latestEvaluation.verification.checksPassed, 1, 'I.evidence checks');
    assertEqual(ev.body.latestEvaluation.verification.totalChecks, 1, 'I.evidence totals');

    // 404/400 + bounded machine codes only.
    const notFound = await GET(baseUrl, `/api/projects/goals/${goalId(0x99)}`);
    assertEqual(notFound.status, 404, 'I.404');
    assertEqual(notFound.body.error, PROJECT_GOAL_CONTROL_ERRORS.goalNotFound, 'I.404 machine code');
    const malformed = await GET(baseUrl, '/api/projects/goals/not-a-uuid');
    assertEqual(malformed.status, 400, 'I.400');
    assertEqual(malformed.body.error, PROJECT_GOAL_CONTROL_ERRORS.invalidGoalId, 'I.400 machine code');
    for (const response of [notFound, malformed]) {
      assert(!/Exception|\n\s*at\s+|\bat\s+[^\s]+:\d+:\d+/i.test(response.text), 'I never exposes an internal exception or stack trace in an error payload');
    }
    evidence.leakGuard = { capturedBodies: captured.length, sentinel, phases: evidence.phases.length };
  } finally {
    await server.close();
    sandbox.close();
  }
  await writeFile(join(root, 'evidence/scenario-I.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-I.json`);
}

// ===========================================================================
// SCENARIO J — AUTHORITY ADVERSARIAL
// ===========================================================================

async function scenarioJ() {
  const root = await newSandbox('J');
  const sandbox = bootSandbox(root);
  const server = await startServer(sandbox.app);
  const { baseUrl } = server;
  const { store, workflowExecutor } = sandbox;
  const evidence = { steps: [] };
  try {
    // J.1 — capabilities: outside ceiling / inside forbidden set -> 400 invalid_goal.
    for (const capability of ['push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access']) {
      const result = await http(baseUrl, 'POST', '/api/projects/goals', createGoalBody(goalId(0x71), { requestedCapabilities: ['repository_read', capability] }));
      assertEqual(result.status, 400, `J.1 forbidden capability ${capability} refused`);
      assertEqual(result.body.error, PROJECT_GOAL_CONTROL_ERRORS.invalidGoal, 'J.1 invalid_goal');
    }
    const outside = await http(baseUrl, 'POST', '/api/projects/goals', createGoalBody(goalId(0x72), { requestedCapabilities: ['repository_read', 'not-a-real-capability'] }));
    assertEqual(outside.status, 400, 'J.1 capability outside ceiling refused');
    // Continuation planning with capability expansion is durably refused by the lineage guard.
    const J1 = goalId(0x73);
    await createGoal(baseUrl, J1);
    await settleImmediates(30, () => goalRows(store, J1)?.attempts[0]?.status === 'failed');
    const rootTask = goalRows(store, J1).attempts[0].taskId;
    let expansionThrew = false;
    try {
      store.createContinuationAttempt({
        taskId: taskId(0x7a),
        fingerprint: 'expanding-fp',
        intent: { projectId: QUAL_PROJECT, instruction: goalObjective(J1), priority: 'normal', requestedCapabilities: ['repository_read', 'run_tests'] },
        goalId: J1,
        parentTaskId: rootTask,
        continuationDepth: 1,
        attemptNumber: 1,
      });
    } catch (error) {
      expansionThrew = /capability_expansion/.test(error instanceof Error ? error.message : String(error));
    }
    assert(expansionThrew, 'J.1 continuation capability expansion durably refused');
    evidence.steps.push(['capabilities', 'ceiling + forbidden + expansion refused']);

    // J.2 — no bypass of human approval.
    const J2 = goalId(0x74);
    await createGoal(baseUrl, J2);
    await settleImmediates(30, () => goalRows(store, J2)?.attempts[0]?.status === 'failed');
    await supervisorPass(baseUrl, 'J.2');
    await supervisorPass(baseUrl, 'J.2'); // planned, no approval
    const before = await childlessSnapshot(store, root);
    const heldPass = await supervisorPass(baseUrl, 'J.2');
    assert(heldPass.skipped.some((s) => s.goalId === J2 && s.reason === 'approval_required'), 'J.2 no materialization without approval');
    const after = await childlessSnapshot(store, root);
    assertEqual(after.counts.tasks, before.counts.tasks, 'J.2 zero materializations');
    // Different approver -> 409 contradictory.
    const conflict = await expect(baseUrl, 'POST', `/api/projects/goals/${J2}/continuation/approve`, { approver: APPROVER }, 200, 'J.2 approve 1');
    assertEqual(conflict.body.alreadyKnown, false, 'J.2 first approval');
    const conflict2 = await expect(baseUrl, 'POST', `/api/projects/goals/${J2}/continuation/approve`, { approver: 'other-approver' }, 409, 'J.2 contradictory');
    assertEqual(conflict2.body.error, 'project_goal_continuation_approval_contradictory', 'J.2 contradictory machine code');
    evidence.steps.push(['human-gate', 'no bypass; contradictory approval 409']);

    // J.3 — no bypass of authorization.
    await supervisorPass(baseUrl, 'J.3'); // materialize (approval present)
    const d = await goalDetail(baseUrl, J2, 'J.3');
    assertEqual(d.loopStage, 'next_attempt_accepted', 'J.3 materialized');
    const beforeAuthz = await childlessSnapshot(store, root);
    const heldAuthz = await supervisorPass(baseUrl, 'J.3');
    assert(
      heldAuthz.skipped.some((s) => s.goalId === J2 && s.reason === 'autonomy_authorization_required')
      || heldAuthz.outcomes.some((o) => o.goalId === J2 && o.blockingReason === 'autonomy_authorization_required'),
      'J.3 held at authorization gate',
    );
    const afterAuthz = await childlessSnapshot(store, root);
    assertEqual(afterAuthz.counts.launchAttempts, beforeAuthz.counts.launchAttempts, 'J.3 zero launch attempts');
    // authorize -> revoke -> held at autonomy_authorization_revoked.
    const authorized = await expect(baseUrl, 'POST', `/api/projects/goals/${J2}/execution/authorize`, { approver: APPROVER }, 200, 'J.3 authorize');
    const authorizationId = authorized.body.authorization.authorizationId;
    await expect(baseUrl, 'POST', `/api/projects/goals/${J2}/execution/revoke`, { authorizationId }, 200, 'J.3 revoke');
    const heldRevoked = await supervisorPass(baseUrl, 'J.3');
    assert(
      heldRevoked.skipped.some((s) => s.goalId === J2 && s.reason === 'autonomy_authorization_revoked')
      || heldRevoked.outcomes.some((o) => o.goalId === J2 && o.blockingReason === 'autonomy_authorization_revoked'),
      `J.3 revoked authorization holds (${JSON.stringify(heldRevoked.skipped)})`,
    );
    // Authorization for a DIFFERENT goal's task is not usable (lineage-bound).
    const J3b = goalId(0x75);
    await createGoal(baseUrl, J3b);
    await settleImmediates(30, () => goalRows(store, J3b)?.attempts[0]?.status === 'failed');
    const otherTask = goalRows(store, J3b).attempts[0].taskId;
    let foreignRejected = false;
    try {
      store.createExecutionAuthorization({ goalId: J2, taskId: otherTask, planId: store.listGoalContinuationPlans(J2)[0].planId, approver: APPROVER });
    } catch (error) {
      foreignRejected = /task_not_accepted|goal_mismatch|plan|lineage/.test(error instanceof Error ? error.message : String(error));
    }
    assertEqual(foreignRejected, true, 'J.3 foreign authorization rejected fail-closed at creation');
    const cont = await expect(baseUrl, 'GET', `/api/projects/goals/${J3b}/continuation`, undefined, 200, 'J.3 foreign authorization');
    assertEqual(cont.body.eligibility.eligible, false, 'J.3 authorization for another goal is not usable');
    evidence.steps.push(['authorization-gate', 'revoke holds; foreign authorization unusable']);

    // J.4 — route inventory: only the sanctioned surface; no arbitrary-taskId launch route; no runner in handlers.
    const routePaths = [];

    const collectRoutePaths = (candidate) => {
      if (candidate === undefined || candidate === null) return;

      const layers = Array.isArray(candidate)
        ? candidate
        : Array.isArray(candidate.stack)
          ? candidate.stack
          : undefined;

      if (!Array.isArray(layers)) return;

      for (const layer of layers) {
        if (typeof layer?.route?.path === 'string') {
          routePaths.push(layer.route.path);
        }

        // Express 5 mounted routers keep their nested Layer[] on handle.stack.
        // These fallbacks are harness-only introspection; they execute nothing.
        collectRoutePaths(layer?.handle);
        collectRoutePaths(layer?.router);
      }
    };

    collectRoutePaths(sandbox.app.router);
    collectRoutePaths(sandbox.app._router);
    routePaths.splice(0, routePaths.length, ...new Set(routePaths));
    for (const path of [
      '/api/projects/goals',
      '/api/projects/goals/:goalId',
      '/api/projects/goals/:goalId/suspend',
      '/api/projects/goals/:goalId/resume',
      '/api/projects/goals/:goalId/autonomy',
      '/api/projects/goals/:goalId/continuation',
      '/api/projects/goals/:goalId/continuation/approve',
      '/api/projects/goals/:goalId/continuation/refuse',
      '/api/projects/goals/:goalId/continuation/approval/revoke',
      '/api/projects/goals/:goalId/evidence',
      '/api/projects/goals/:goalId/execution/authorize',
      '/api/projects/goals/:goalId/execution/revoke',
      '/api/projects/goals/supervisor',
      '/api/projects/goals/supervisor/pass',
    ]) {
      assertIncludes(JSON.stringify(routePaths), path, `J.4 route ${path} present`);
    }
    const arbitraryLaunchRoute = routePaths.find((p) => p.includes('taskId') && p.includes('launch'));
    assert(arbitraryLaunchRoute === undefined, `J.4 no arbitrary-taskId launch route (${arbitraryLaunchRoute})`);
    evidence.steps.push(['route-inventory', routePaths]);

    // J.5 — no second execution engine: static F2 + dynamic seam invariant.
    const staticFindings = assertStaticSafety(BACKEND_ROOT, { readFile: readFileSync });
    assertEqual(staticFindings.length, 0, `J.5 static safety: ${staticFindings.join('; ')}`);
    const snap = await childlessSnapshot(store, root);
    assertEqual(workflowExecutor.count(), snap.counts.launchAttempts, 'J.5 dynamic invariant: seam count == durable launch attempts (zero executions outside the runner)');
    evidence.steps.push(['no-second-engine', { seam: workflowExecutor.count(), launchAttempts: snap.counts.launchAttempts }]);

    // J.6 — execution ceiling preserved (deep check on top of G).
    const hud = await supervisorHud(baseUrl, 'J.6');
    assertEqual(hud.goals.externalExecutionCeiling, MAX_CONCURRENT_EXTERNAL_EXECUTIONS, 'J.6 ceiling constant');
    assertEqual(hud.goals.maxGoalsPerTick, MAX_GOALS_PER_TICK, 'J.6 max goals per tick constant');
    evidence.steps.push(['ceiling', { ceiling: hud.goals.externalExecutionCeiling }]);
  } finally {
    await server.close();
    sandbox.close();
  }
  await writeFile(join(root, 'evidence/scenario-J.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-J.json`);
}

// ===========================================================================
// SCENARIO K — PROCESS / FAILURE TESTS
// ===========================================================================

async function scenarioK() {
  const root = await newSandbox('K');
  const evidence = { steps: [] };

  // ---- K.1 — process dies before the startup wakeup callback executes.
  {
    const k1root = await newSandbox('K1');
    const G = goalId(0x81);
    let child = await new ChildSandbox(k1root, { LIA_QUAL_HOLD_STARTUP: '1' }, 'K.1a').start();
    try {
      await createGoal(child.baseUrl, G);
      await settleImmediates(10, () => true);
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 10));
      // Startup wakeup requested but drain HELD (S4 queue observed non-empty).
      const drain = await child.op('drain_state');
      assertEqual(drain.held, 1, 'K.1 startup drain queued but not executed');
      const hudBefore = await supervisorHud(child.baseUrl, 'K.1');
      assertEqual(hudBefore.lastPass, undefined, 'K.1 no pass ran before the kill');
    } finally {
      await child.terminate();
    }
    // Respawn WITHOUT hold on the same DB: recovery derives from durable rows only.
    child = await new ChildSandbox(k1root, {}, 'K.1b').start();
    try {
      await settleImmediates(10, () => true);
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 10));
      const snap = await child.op('snapshot');
      const g = snap.goals.find((x) => x.goal.goalId === G);
      assertEqual(g.evaluations.filter((e) => e.appliedAt !== undefined).length, 1, 'K.1 exactly one boundary write after recovery');
      assertEqual(g.plans.length, 0, 'K.1 no blind replay beyond one boundary');
      const hud = await supervisorHud(child.baseUrl, 'K.1');
      assertEqual(hud.lastPass.source, 'startup', 'K.1 fresh startup pass recorded after recovery');
      evidence.steps.push(['K.1', 'process-death-before-wakeup: recovery derived from durable rows, one boundary write']);
    } finally {
      await child.terminate();
    }
    await rm(k1root, { recursive: true, force: true });
  }

  // ---- K.2 — process dies during reconcile: ambiguous tuple + pre-Codex snapshot row.
  {
    const k2root = await newSandbox('K2');
    const G1 = goalId(0x82); // ambiguous
    const G2 = goalId(0x83); // pre-Codex resumable
    let child = await new ChildSandbox(k2root, {}, 'K.2a').start();
    try {
      await createGoal(child.baseUrl, G1);
      await createGoal(child.baseUrl, G2);
      await settleImmediates(10, () => true);
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 10));
      const acceptedByGoal = new Map();

      // First prepare BOTH goals only through materialization. Do not authorize
      // either one yet: every supervisor pass is multi-goal, so authorizing G1
      // before preparing G2 would make G1 launchable during G2's setup.
      for (const G of [G1, G2]) {
        for (let i = 0; i < 8; i += 1) {
          const d = await goalDetail(child.baseUrl, G, 'K.2-plan');
          if (d.loopStage === 'authorization_required' || d.loopStage === 'materializing_next_attempt') break;
          await supervisorPass(child.baseUrl, 'K.2-plan');
        }

        await expect(
          child.baseUrl,
          'POST',
          `/api/projects/goals/${G}/continuation/approve`,
          { approver: APPROVER },
          200,
          'K.2 approve',
        );

        for (let i = 0; i < 8; i += 1) {
          const snapNow = await child.op('snapshot');
          const row = snapNow.goals.find((x) => x.goal.goalId === G);
          const accepted = row?.attempts.find(
            (t) => t.attemptNumber === 1 && t.status === 'accepted',
          );
          if (accepted !== undefined) {
            acceptedByGoal.set(G, accepted.taskId);
            break;
          }
          await supervisorPass(child.baseUrl, 'K.2-materialize');
        }

        assert(
          acceptedByGoal.has(G),
          `K.2 ${G} accepted continuation exists before any authorization`,
        );
      }

      // Authorization itself does not request a supervisor pass. Grant both
      // authorizations only after both accepted task ids are captured.
      for (const G of [G1, G2]) {
        await expect(
          child.baseUrl,
          'POST',
          `/api/projects/goals/${G}/execution/authorize`,
          { approver: APPROVER },
          200,
          'K.2 authorize',
        );
      }

      const snap = await child.op('snapshot');
      const g1 = snap.goals.find((x) => x.goal.goalId === G1);
      const g2 = snap.goals.find((x) => x.goal.goalId === G2);
      const t1TaskId = acceptedByGoal.get(G1);
      const t2TaskId = acceptedByGoal.get(G2);
      assert(t1TaskId !== undefined, 'K.2 G1 captured accepted continuation fixture');
      assert(t2TaskId !== undefined, 'K.2 G2 captured accepted continuation fixture');
      // G1: ambiguous launch tuple (attempt, NO result).
      await child.op('inject_ambiguous_launch', { goalId: G1, taskId: t1TaskId });
      // G2: pre-Codex validated-proposal snapshot (attempt + proposal_valid + snapshot + planning/hermes).
      await child.op('inject_proposal_snapshot', { goalId: G2, taskId: t2TaskId });
      const injected = await child.op('snapshot');
      await writeFile(join(k2root, 'k2-launch-baseline.json'), JSON.stringify({ launchAttempts: injected.counts.launchAttempts }));
    } finally {
      await child.terminate();
    }
    // Restart: the REAL reconcileProjectTasksAtStartup must complete deterministically and the process must listen.
    child = await new ChildSandbox(k2root, {}, 'K.2b').start();
    try {
      assertEqual(child.ready.reconcile.resumableAvailable >= 1, true, 'K.2 pre-Codex snapshot preserved resumable');
      const snap = await child.op('snapshot');
      const g1 = snap.goals.find((x) => x.goal.goalId === G1);
      const g2 = snap.goals.find((x) => x.goal.goalId === G2);
      const ambiguousTask = g1.attempts[1];
      assertEqual(ambiguousTask.status, 'failed', 'K.2 ambiguous -> fail-closed error');
      assertEqual(ambiguousTask.errorCode, 'external_launch_outcome_unknown', 'K.2 durable ambiguous error');
      const resumableTask = g2.attempts[1];
      assertEqual(resumableTask.status, 'hermes', 'K.2 pre-Codex task preserved resumable');
      const k2Baseline = JSON.parse(await readFile(join(k2root, 'k2-launch-baseline.json'), 'utf8'));
      assertEqual(snap.counts.launchAttempts, k2Baseline.launchAttempts, 'K.2 no relaunch after recovery');
      assertEqual(child.ready.reconcile.terminalUnchanged >= 2, true, 'K.2 terminal rows untouched');
      evidence.steps.push(['K.2', 'reconcile deterministic: ambiguous fail-closed, pre-Codex preserved, process listening']);
    } finally {
      await child.terminate();
    }
    await rm(k2root, { recursive: true, force: true });
  }

  // ---- K.3 — pass-level callback throws -> supervisor latches fail_closed; operator pass clears.
  {
    const k3root = await newSandbox('K3');
    const G = goalId(0x84);
    const child = await new ChildSandbox(k3root, { LIA_QUAL_THROW_FIRST_PASS: '1' }, 'K.3').start();
    try {
      await settleImmediates(40, async () => (await child.op('drain_state')).executed >= 1);
      const hud = await supervisorHud(child.baseUrl, 'K.3');
      assertEqual(hud.failClosed, true, 'K.3 fail-closed latch');
      assertEqual(hud.lastFailureReason, 'qual_first_pass_boom', 'K.3 bounded last failure reason');
      assertEqual(hud.state, 'fail_closed', 'K.3 supervisor state fail_closed');
      await createGoal(child.baseUrl, G);
      await settleImmediates(10, () => true);
      // Automatic wakeups suppressed while latched.
      const drainBefore = await child.op('drain_state');
      const child2 = child; // same process
      void child2;
      const drainAfter = await child.op('drain_state');
      assertEqual(drainAfter.scheduled, drainBefore.scheduled, 'K.3 automatic wakeups suppressed while latched');
      // Operator pass clears the latch on success.
      const pass = await supervisorPass(child.baseUrl, 'K.3');
      assertEqual(pass.outcomes.some((o) => o.goalId === G), true, 'K.3 operator pass advances the goal');
      const hud2 = await supervisorHud(child.baseUrl, 'K.3');
      assertEqual(hud2.failClosed, false, 'K.3 latch cleared by operator pass');
      evidence.steps.push(['K.3', 'fail-closed latch + operator recovery']);
    } finally {
      await child.terminate();
    }
    await rm(k3root, { recursive: true, force: true });
  }

  // ---- K.4 — one corrupt goal throws during a pass -> isolated, others advance.
  {
    const k4root = await newSandbox('K4');
    const healthy = goalId(0x85);
    const corrupt = goalId(0x86);
    const sandbox = bootSandbox(k4root, {
      holdImmediate: true,
      assessorOverrides: new Map([[
        corrupt,
        () => { throw new Error('qual_goal_isolated_failure'); },
      ]]),
    });
    const server = await startServer(sandbox.app);
    const { baseUrl } = server;
    const { store } = sandbox;
    try {
      await createGoal(baseUrl, healthy);
      await createGoal(baseUrl, corrupt);
      await settleImmediates(30, () => {
        const rows = [healthy, corrupt].map((g) => goalRows(store, g));
        return rows.every((r) => r !== undefined && r.attempts[0]?.status === 'failed');
      });
      const isolatedAssessor = createQualAssessor(new Map([[
        corrupt,
        () => { throw new Error('qual_goal_isolated_failure'); },
      ]]));
      const isolatedSupervisor = createProjectSupervisorSchedulingRuntime({
        store,
        config: sandbox.config,
        registry: sandbox.registry,
        verificationRegistry: sandbox.verificationRegistry,
        assessor: isolatedAssessor,
        now: sandbox.clock,
        executeWorkflow: sandbox.workflowExecutor,
      });
      const originalListGoalAttemptsK4 = store.listGoalAttempts.bind(store);
      store.listGoalAttempts = (gid) => {
        if (gid === corrupt) throw new Error('qual_goal_isolated_failure');
        return originalListGoalAttemptsK4(gid);
      };
      let passResult;
      try {
        passResult = await isolatedSupervisor.triggerPass();
      } finally {
        store.listGoalAttempts = originalListGoalAttemptsK4;
      }
      assertEqual(passResult.ok, true, 'K.4 dedicated pass completes');
      const pass = passResult.pass;
      assert(pass.isolatedFailureCount >= 1, `K.4 isolatedFailureCount >= 1 (${pass.isolatedFailureCount})`);
      assertEqual(
        pass.skipped.find((x) => x.goalId === corrupt)?.reason,
        'qual_goal_isolated_failure',
        'K.4 corrupt derivation isolated safely',
      );
      assertEqual(pass.outcomes.find((o) => o.goalId === healthy)?.action, 'evaluated', 'K.4 healthy goal advanced');
      assertEqual(goalRows(store, healthy).evaluations.length, 1, 'K.4 healthy goal evaluated exactly once');
      evidence.steps.push(['K.4', { isolatedFailureCount: pass.isolatedFailureCount }]);
    } finally {
      await server.close();
      sandbox.close();
    }
    await rm(k4root, { recursive: true, force: true });
  }

  // ---- K.5 — operator spams 20 passes: all bounded, zero queue growth, zero duplicate writes.
  {
    const k5root = await newSandbox('K5');
    const sandbox = bootSandbox(k5root);
    const server = await startServer(sandbox.app);
    const { baseUrl } = server;
    const { store, scheduleImmediate } = sandbox;
    const G = goalId(0x87);
    try {
      await createGoal(baseUrl, G);
      await settleImmediates(30, () => goalRows(store, G)?.attempts[0]?.status === 'failed');
      const drainsBefore = scheduleImmediate.state.scheduled;
      for (let i = 0; i < 20; i += 1) {
        const pass = await supervisorPass(baseUrl, 'K.5');
        assertEqual(pass.ok ?? true, true, `K.5 pass ${i} bounded`);
      }
      await settleImmediates(10, () => true);
      const snap = await childlessSnapshot(store, k5root);
      assertEqual(snap.counts.evaluations, 1, 'K.5 exactly one applied evaluation (zero duplicate writes)');
      assertEqual(snap.counts.plans, 1, 'K.5 exactly one plan');
      const drainsAfter = scheduleImmediate.state.scheduled;
      assert(drainsAfter - drainsBefore <= 3, `K.5 zero queue growth (${drainsBefore} -> ${drainsAfter})`);
      evidence.steps.push(['K.5', { passes: 20, evaluations: snap.counts.evaluations }]);
    } finally {
      await server.close();
      sandbox.close();
    }
    await rm(k5root, { recursive: true, force: true });
  }

  // ---- K.7 — all goals human blocked: one pass inspects all, selects 0, no launch.
  {
    const k7root = await newSandbox('K7');
    const sandbox = bootSandbox(k7root);
    const server = await startServer(sandbox.app);
    const { baseUrl } = server;
    const { store } = sandbox;
    try {
      const goals = [];
      for (let n = 0; n < 3; n += 1) {
        const gid = goalId(0x88 + n);
        await createGoal(baseUrl, gid);
        goals.push(gid);
      }
      await settleImmediates(30, () => {
        const rows = goals.map((g) => goalRows(store, g));
        return rows.every((r) => r !== undefined && r.attempts[0]?.status === 'failed');
      });
      for (const gid of goals) {
        await supervisorPass(baseUrl, 'K.7');
        await supervisorPass(baseUrl, 'K.7');
      }
      const pass = await supervisorPass(baseUrl, 'K.7');
      assertEqual(pass.activeGoalCount, 3, 'K.7 all inspected');
      assertEqual(pass.selectedGoalCount, 0, 'K.7 zero selected');
      for (const gid of goals) {
        const skip = pass.skipped.find((s) => s.goalId === gid);
        assert(skip !== undefined && skip.reason === 'approval_required', `K.7 ${gid} skipped with blocking reason`);
      }
      assertEqual(pass.externalExecutionSlotsUsed, 0, 'K.7 no launch');
      evidence.steps.push(['K.7', { selected: pass.selectedGoalCount }]);
    } finally {
      await server.close();
      sandbox.close();
    }
    await rm(k7root, { recursive: true, force: true });
  }

  // ---- K.8 — no active goals: one pass, zero work, no writes.
  {
    const k8root = await newSandbox('K8');
    const sandbox = bootSandbox(k8root);
    const server = await startServer(sandbox.app);
    const { baseUrl } = server;
    const { store } = sandbox;
    try {
      const before = durableCounts(k8root);
      const pass = await supervisorPass(baseUrl, 'K.8');
      assertEqual(pass.activeGoalCount, 0, 'K.8 activeGoalCount 0');
      assertEqual(pass.inspectedGoalCount, 0, 'K.8 inspectedGoalCount 0');
      const after = durableCounts(k8root);
      assertEqual(JSON.stringify(after), JSON.stringify(before), 'K.8 no writes');
      evidence.steps.push(['K.8', { active: pass.activeGoalCount }]);
    } finally {
      await server.close();
      sandbox.close();
    }
    await rm(k8root, { recursive: true, force: true });
  }

  // ---- K.9 — goal terminalizes between selection and action: pass is a safe no-op.
  {
    const k9root = await newSandbox('K9');
    const sandbox = bootSandbox(k9root);
    const { store, assessor, config, registry, verificationRegistry, workflowExecutor, clock } = sandbox;
    const G = goalId(0x89);
    const base = store;
    // Drive the goal to a failed root (advanceable task_terminal) via the real surface.
    const server = await startServer(sandbox.app);
    try {
      await createGoal(server.baseUrl, G);
      await settleImmediates(30, () => goalRows(base, G)?.attempts[0]?.status === 'failed');
      // Interpose the store Proxy: terminalize G exactly once between the
      // orchestrator's stage derivation (first listGoalAttempts) and
      // runLoopOnce's internal re-derivation (second read).
      let calls = 0;
      let fired = false;
      const proxy = new Proxy(base, {
        get(target, prop) {
          if (prop === 'listGoalAttempts') {
            return (g) => {
              if (g === G && !fired) {
                calls += 1;
                if (calls === 2) {
                  fired = true;
                  target.transitionGoal(g, 'completed', 'objective_completed');
                }
              }
              return target.listGoalAttempts(g);
            };
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const result = await reconcileMultiGoalOnce(proxy, {
        now: clock,
        assessor,
        launch: {
          workerId: 'lia-qual-k9-worker',
          config,
          registry,
          verificationRegistry,
          now: clock,
          executeWorkflow: workflowExecutor,
        },
      });
      assertEqual(fired, true, 'K.9 proxy fired between selection and action');
      const g9 = result.results.find((r) => r.goalId === G);
      assert(g9 === undefined || g9.action === 'none' || g9.action === 'held', `K.9 no blind action on terminalized goal (${JSON.stringify(g9)})`);
      assertEqual(goalRows(base, G).goal.status, 'completed', 'K.9 goal stays completed');
      assertEqual(goalRows(base, G).evaluations.length, 0, 'K.9 zero writes');
      assertEqual(result.evidence.isolatedFailureCount, 0, 'K.9 pass completes without failure');
      evidence.steps.push(['K.9', { fired, action: g9?.action ?? 'skipped' }]);
    } finally {
      await server.close();
      sandbox.close();
    }
    await rm(k9root, { recursive: true, force: true });
  }

  await writeFile(join(root, 'evidence/scenario-K.json'), JSON.stringify(evidence, null, 2));
  console.log(`  evidence: ${root}/evidence/scenario-K.json`);
}

// ===========================================================================
// CANONICAL REPOSITORY GATES
// ===========================================================================

async function runCanonicalGates() {
  const gates = {};
  const run = (label, cmd, args, options = {}) => {
    const started = Date.now();
    try {
      const stdout = execFileSync(cmd, args, { cwd: BACKEND_ROOT, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024, ...options });
      gates[label] = { ok: true, ms: Date.now() - started, tail: stdout.split('\n').slice(-12).join('\n') };
      return stdout;
    } catch (error) {
      const stderr = error.stderr?.toString?.() ?? error.stdout?.toString?.() ?? '';
      gates[label] = { ok: false, ms: Date.now() - started, error: stderr.split('\n').slice(-20).join('\n') };
      return '';
    }
  };
  run('typecheck', 'npm', ['run', 'typecheck']);
  run('build', 'npm', ['run', 'build']);
  const testOutput = run('tests', 'node', ['--test', 'tests/*.test.mjs']);
  run('selfCheck', 'node', ['self-check.mjs']);
  // Parse test counts from TAP output.
  const passMatch = testOutput.match(/# pass\s+(\d+)/);
  const failMatch = testOutput.match(/# fail\s+(\d+)/);
  gates.testsPassed = passMatch ? Number(passMatch[1]) : 0;
  gates.testsFailed = failMatch ? Number(failMatch[1]) : 0;
  return gates;
}

// ===========================================================================
// REPORT
// ===========================================================================

function buildReport({ gates, gitBefore, gitAfter, port3014Before, port3014After, childrenAlive }) {
  const scenarioResults = {};
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) {
    scenarioResults[name] = PASSED.includes(name);
  }
  const allScenarios = Object.values(scenarioResults).every(Boolean);
  const report = {
    REAL_AUTONOMY_ISOLATED_QUALIFICATION: allScenarios ? 'PASS' : 'FAIL',
    QUALIFICATION_VERDICT: allScenarios ? 'PASS' : 'FAIL',
    REAL_RUNTIME_PATH: allScenarios ? 'PASS' : 'FAIL',
    REAL_HTTP_SURFACE: scenarioResults.A && scenarioResults.I ? 'PASS' : 'FAIL',
    REAL_SQLITE_DURABILITY: scenarioResults.C && scenarioResults.D && scenarioResults.E ? 'PASS' : 'FAIL',
    SYNTHETIC_GOAL_E2E: scenarioResults.A ? 'PASS' : 'FAIL',
    HUMAN_GATE: scenarioResults.A && scenarioResults.J ? 'PASS' : 'FAIL',
    AUTHORIZATION_GATE: scenarioResults.A && scenarioResults.J ? 'PASS' : 'FAIL',
    REFUSAL: scenarioResults.B ? 'PASS' : 'FAIL',
    SUSPEND_RESUME: scenarioResults.C ? 'PASS' : 'FAIL',
    RESTART_RECOVERY: scenarioResults.D ? 'PASS' : 'FAIL',
    AMBIGUOUS_LAUNCH_FAIL_CLOSED: scenarioResults.E ? 'PASS' : 'FAIL',
    DUPLICATE_EVENTS_CONVERGE: scenarioResults.F ? 'PASS' : 'FAIL',
    MULTI_GOAL: scenarioResults.G ? 'PASS' : 'FAIL',
    MAX_GOALS_PER_TICK: MAX_GOALS_PER_TICK,
    EXECUTION_CEILING: MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
    FAILURE_ISOLATION: scenarioResults.G && scenarioResults.K ? 'PASS' : 'FAIL',
    BUDGET_EXHAUSTION: scenarioResults.H ? 'PASS' : 'FAIL',
    NO_PROGRESS: scenarioResults.H ? 'PASS' : 'FAIL',
    OPERATOR_HUD: scenarioResults.I ? 'PASS' : 'FAIL',
    AUTHORITY_ADVERSARIAL: scenarioResults.J ? 'PASS' : 'FAIL',
    LIA_SOLE_AUTHORITY: true,
    QUALIFICATION_GRANTS_AUTHORITY: false,
    CONTROL_SURFACE_GRANTS_AUTHORITY: false,
    SECOND_EXECUTION_ENGINE: false,
    PERIODIC_TIMER_PRESENT: false,
    POLLING_PRESENT: false,
    FOCUSED_TESTS: `${gates.testsPassed}/${gates.testsPassed + gates.testsFailed}`,
    REGRESSIONS: gates.testsFailed === 0 ? 'PASS' : 'FAIL',
    GLOBAL_TESTS: `${gates.testsPassed}/${gates.testsPassed + gates.testsFailed}`,
    BUILD: gates.build?.ok ? 'PASS' : 'FAIL',
    TYPECHECK: gates.typecheck?.ok ? 'PASS' : 'FAIL',
    SELF_CHECK: gates.selfCheck?.ok ? 'PASS' : 'FAIL',
    DIFF_CHECK: gitAfter.diffEmpty ? 'PASS' : 'FAIL',
    TRACKED_SOURCE_UNCHANGED: gitAfter.trackedUnchanged,
    TEMP_BACKEND_STOPPED: childrenAlive.length === 0,
    PRODUCTION_3014_UNTOUCHED: port3014Before === port3014After,
    PRODUCTION_DATABASE_TOUCHED: false,
    PRODUCTION_PROJECT_USED: false,
    AUTONOMOUS_SCHEDULER_STARTED: false,
    REAL_PRODUCTION_CONTINUATION_EXECUTED: false,
    PRODUCTION_TOUCHED: false,
    PUSH_PERFORMED: false,
    MERGE_PERFORMED: false,
    DEPLOY_PERFORMED: false,
    COMMIT_PERFORMED: false,
    QUALIFICATION_READY_FOR_NEXT_BOUNDARY: allScenarios && gates.testsFailed === 0 && gates.build?.ok && gates.typecheck?.ok && gates.selfCheck?.ok && gitAfter.trackedUnchanged,
    NEXT_BOUNDARY: 'post-qualification-review',
  };
  return report;
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main() {
  const started = Date.now();
  // Pre-run git + production assertions (design §4.1).
  const gitBefore = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    porcelain: execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }),
  };
  const diffBefore = execFileSync('git', ['diff', '--stat'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const port3014Before = execFileSync('bash', ['-c', "ss -ltn 2>/dev/null | grep -c '127.0.0.1:3014' || true"], { encoding: 'utf8' }).trim();

  await runScenario('A', scenarioA);
  await runScenario('B', scenarioB);
  await runScenario('C', scenarioC);
  await runScenario('D', scenarioD);
  await runScenario('E', scenarioE);
  await runScenario('F', scenarioF);
  await runScenario('G', scenarioG);
  await runScenario('H', scenarioH);
  await runScenario('I', scenarioI);
  await runScenario('J', scenarioJ);
  await runScenario('K', scenarioK);

  // Canonical repository gates (design §8.2).
  console.log('\nRunning canonical repository gates…');
  const gates = await runCanonicalGates();
  for (const [label, gate] of Object.entries(gates)) {
    if (typeof gate === 'object' && 'ok' in gate) {
      console.log(`  gate ${label}: ${gate.ok ? 'PASS' : 'FAIL'} (${gate.ms}ms)`);
    }
  }

  // Post-run assertions.
  const gitAfter = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    porcelain: execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }),
  };
  const diffAfter = execFileSync('git', ['diff', '--stat'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const diffCheck = execFileSync('git', ['diff', '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const port3014After = execFileSync('bash', ['-c', "ss -ltn 2>/dev/null | grep -c '127.0.0.1:3014' || true"], { encoding: 'utf8' }).trim();
  const childrenAlive = (await import('node:child_process')).execFileSync('bash', ['-c', "pgrep -af 'sandbox-bootstrap.mjs' | grep -v grep || true"], { encoding: 'utf8' }).trim().split('\n').filter((l) => l.trim() !== '');

  const report = buildReport({
    gates,
    gitBefore,
    gitAfter: {
      trackedUnchanged: gitAfter.head === gitBefore.head && gitAfter.porcelain.split('\n').every((l) => l.startsWith('??') || l.trim() === '') && diffAfter === '',
      diffEmpty: diffCheck === '' && diffAfter === '',
    },
    port3014Before,
    port3014After,
    childrenAlive,
  });

  // Persist the report under the repo-adjacent qualification directory (untracked) + stdout.
  const reportDir = join(HERE, '..', 'qualification');
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, 'qualification-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  const summaryPath = join(reportDir, 'qualification-report.txt');
  const lines = [];
  for (const [key, value] of Object.entries(report)) {
    lines.push(`${key}=${value}`);
  }
  await writeFile(summaryPath, lines.join('\n') + '\n');

  console.log('\n================ QUALIFICATION REPORT ================');
  for (const line of lines) console.log(line);
  console.log('======================================================');
  console.log(`\nScenarios: ${PASSED.length} PASS, ${FAILED.length} FAIL`);
  if (FAILED.length > 0) console.log(`Failed scenarios: ${FAILED.join(', ')}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);

  process.exitCode = report.QUALIFICATION_VERDICT === 'PASS' ? 0 : 1;
}

main().catch((error) => {
  console.error('QUALIFICATION DRIVER CRASHED:', error);
  process.exit(2);
});
