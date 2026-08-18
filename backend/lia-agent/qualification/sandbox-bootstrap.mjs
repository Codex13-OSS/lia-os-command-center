/**
 * LÍA REAL AUTONOMY QUALIFICATION — sandbox bootstrap (design §4.4).
 *
 * Child-process entry that mirrors `server.ts` wiring EXACTLY:
 *   loadConfig(process.env)
 *   -> REAL ProjectTaskSqliteStore (temp sqlite file, REAL schema bootstrap)
 *   -> reconcileProjectTasksAtStartup(store)
 *   -> REAL registry file source + REAL verification file source
 *   -> REAL supervisor scheduling runtime (when LIA_SUPERVISOR_ENABLED=true)
 *      with S1/S2/S3/S4 seams
 *   -> requestPass('startup') strictly after reconciliation, before listen
 *   -> createApp(config, deps) -> listen(0) on 127.0.0.1 (ephemeral port)
 *
 * The process opens a harness-only stdin JSON control channel (op codes below).
 * This is fixture plumbing INSIDE the sandbox process: it performs no
 * execution, no launch, no scheduling; it only mutates/reads fixture rows and
 * the shared clock. It is NOT part of the product runtime.
 *
 * Ops: ping, clock_advance, snapshot, seam_invocations, drain_state,
 *      decoupled_state, inject_ambiguous_launch, inject_proposal_snapshot,
 *      inject_corrupt_lineage, inject_corrupt_task_json,
 *      inject_terminalize_goal, release_startup
 */

import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { createProjectRegistryFileSource } from '../dist/services/projectRegistryFileSource.js';
import { createFileProjectVerificationRegistry } from '../dist/services/projectVerificationFileSource.js';
import { ProjectTaskSqliteStore } from '../dist/services/projectTaskSqliteStore.js';
import { reconcileProjectTasksAtStartup } from '../dist/services/projectTaskReconciliation.js';
import { createProjectSupervisorSchedulingRuntime } from '../dist/services/projectSupervisorSchedulingRuntime.js';
import {
  createQualWorkflowExecutor,
  createQualAssessor,
  makeClock,
  makeScheduleImmediate,
  makeScheduleDecoupledLaunch,
  crossLaunchBoundary,
  recordProposalResult,
  durableCounts,
  goalRows,
} from './sandbox-fixtures.mjs';

const config = loadConfig();
const root = config.projectTaskSqlitePath.replace(/\/db\/tasks\.sqlite$/, '');

// ---------------------------------------------------------------------------
// Hard sandbox guards (design §4.1/§4.3): never touch production paths/ports.
// ---------------------------------------------------------------------------
if (config.port === 3014) {
  throw new Error('qualification_refused_production_port');
}
if (!config.projectTaskSqlitePath.startsWith('/tmp/')) {
  throw new Error('qualification_refused_non_tmp_database');
}
if (config.projectTaskSqlitePath === '' || config.projectRegistryPath === '') {
  throw new Error('qualification_refused_missing_sandbox_paths');
}

const maxActive = Number.parseInt(process.env.LIA_QUAL_MAX_ACTIVE ?? '64', 10);
const maxRecords = Number.parseInt(process.env.LIA_QUAL_MAX_RECORDS ?? '512', 10);
const clock = makeClock(Number.parseInt(process.env.LIA_QUAL_CLOCK_START ?? '1700000000000', 10));
const sentinel = process.env.LIA_QUAL_SEAM_SENTINEL ?? 'QUAL-SECRET-INTERNAL';

const store = new ProjectTaskSqliteStore({
  databasePath: config.projectTaskSqlitePath,
  now: clock,
  maxActive,
  maxRecords,
});

// Real durable startup reconciliation (design §4.4 / §5 D/E/K).
let reconcileResult;
try {
  reconcileResult = reconcileProjectTasksAtStartup(store);
} catch (error) {
  console.error(JSON.stringify({ event: 'reconcile_failed', error: error instanceof Error ? error.message : 'unknown' }));
  process.exit(2);
}

const projectRegistrySource = createProjectRegistryFileSource(config.projectRegistryPath);
const projectVerificationRegistry = createFileProjectVerificationRegistry(config.projectVerificationPath);

// S4 observation wrappers (design §3). Default body is the REAL setImmediate.
const scheduleImmediate = makeScheduleImmediate({
  hold: process.env.LIA_QUAL_HOLD_STARTUP === '1',
});
const scheduleDecoupledLaunch = makeScheduleDecoupledLaunch();

// S1 + S2 (design §4.5).
const workflowExecutor = createQualWorkflowExecutor(store, { sentinel });
const assessor = createQualAssessor();

// Fail-first-pass fixture (K.3): the FIRST pass-level store read throws a
// bounded machine code; the supervisor latches fail_closed. The throw is
// inside the real drain() -> runPass() -> reconcileMultiGoalOnce() path.
if (process.env.LIA_QUAL_THROW_FIRST_PASS === '1') {
  const originalListActiveGoals = store.listActiveGoals.bind(store);
  let first = true;
  store.listActiveGoals = function listActiveGoalsOnceThrow() {
    if (first) {
      first = false;
      throw new Error('qual_first_pass_boom');
    }
    return originalListActiveGoals();
  };
}

// REAL supervisor runtime wiring (mirror of server.ts:42-53) with seams.
const supervisor = createProjectSupervisorSchedulingRuntime({
  store,
  config,
  registry: projectRegistrySource,
  verificationRegistry: projectVerificationRegistry,
  assessor,
  now: clock,
  executeWorkflow: workflowExecutor,
  scheduleImmediate,
  scheduleDecoupledLaunch,
});

if (config.supervisorEnabled) {
  supervisor.requestPass('startup');
}

const app = createApp(config, {
  projectTaskStore: store,
  projectRegistrySource,
  projectVerificationRegistry,
  projectSupervisorRuntime: supervisor,
  projectTasksWorkflowExecutor: workflowExecutor,
  now: clock,
});

const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : -1;
  process.stdout.write(JSON.stringify({
    event: 'ready',
    port,
    pid: process.pid,
    reconcile: reconcileResult,
    supervisorEnabled: config.supervisorEnabled,
  }) + '\n');
});

// ---------------------------------------------------------------------------
// Harness-only stdin control channel (fixture plumbing, NOT product runtime).
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let opSequence = 0;

function respond(id, result) {
  process.stdout.write(JSON.stringify({ event: 'response', id, ok: true, result }) + '\n');
}

function respondError(id, error) {
  process.stdout.write(JSON.stringify({ event: 'response', id, ok: false, error }) + '\n');
}

function snapshot() {
  const counts = durableCounts(config.projectTaskSqlitePath);
  const goals = store.listGoals({ includeTerminal: true, limit: 100 }).map((g) => goalRows(store, g.goalId));
  return {
    counts,
    goals,
    hud: supervisor.hud(),
  };
}

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, op, params = {} } = message;
  if (id === undefined) return;
  opSequence += 1;
  try {
    switch (op) {
      case 'ping':
        respond(id, { pong: true, pid: process.pid });
        break;
      case 'clock_advance':
        clock.advance(params.ms ?? 0);
        respond(id, { now: clock.value() });
        break;
      case 'snapshot':
        respond(id, snapshot());
        break;
      case 'seam_invocations':
        respond(id, { count: workflowExecutor.count() });
        break;
      case 'drain_state':
        respond(id, {
          scheduled: scheduleImmediate.state.scheduled,
          executed: scheduleImmediate.state.executed,
          held: scheduleImmediate.state.held,
        });
        break;
      case 'decoupled_state':
        respond(id, {
          scheduled: scheduleDecoupledLaunch.state.scheduled,
          executed: scheduleDecoupledLaunch.state.executed,
        });
        break;
      case 'inject_ambiguous_launch': {
        const result = crossLaunchBoundary(store, params.taskId);
        respond(id, {
          launchAttemptId: result.attempt.launchAttempt.launchAttemptId,
          launchResultCount: durableCounts(config.projectTaskSqlitePath).launchResults,
        });
        break;
      }
      case 'inject_proposal_snapshot': {
        // K.2 pre-Codex resumable fixture: attempt + proposal_valid + snapshot + planning/hermes.
        crossLaunchBoundary(store, params.taskId);
        recordProposalResult(store, params.goalId, params.taskId);
        store.transition(params.taskId, 'planning');
        store.transition(params.taskId, 'hermes');
        respond(id, { ok: true });
        break;
      }
      case 'inject_corrupt_lineage': {
        // G5: an accepted continuation task with NO consumed plan. The real
        // createContinuationAttempt primitive writes the lineage; the goal's
        // current_attempt is aligned via a raw fixture UPDATE so the derived
        // stage resolves the corrupt task as current (corrupt_lineage).
        const created = store.createContinuationAttempt({
          taskId: params.taskId,
          fingerprint: `${params.taskId}-fixture-fingerprint`,
          intent: params.intent,
          goalId: params.goalId,
          parentTaskId: params.parentTaskId,
          continuationDepth: 1,
          attemptNumber: 1,
        });
        if (created.kind !== 'created') {
          throw new Error(`corrupt_lineage_injection_failed:${created.kind}`);
        }
        const database = new DatabaseSync(config.projectTaskSqlitePath);
        try {
          database.prepare('UPDATE project_goals SET current_attempt = 1 WHERE goal_id = ?').run(params.goalId);
        } finally {
          database.close();
        }
        respond(id, { created: true });
        break;
      }
      case 'inject_corrupt_task_json': {
        // Durable row corruption: intent_json no longer parses -> decodeRow
        // throws corrupt_record -> per-goal isolation in the pass (K.4).
        const database = new DatabaseSync(config.projectTaskSqlitePath);
        try {
          database.prepare('UPDATE project_tasks SET intent_json = ? WHERE task_id = ?')
            .run('{not-json', params.taskId);
        } finally {
          database.close();
        }
        respond(id, { corrupted: true });
        break;
      }
      case 'inject_terminalize_goal':
        respond(id, {
          goal: store.transitionGoal(params.goalId, params.status, params.reason),
        });
        break;
      case 'release_startup':
        scheduleImmediate.releaseAll();
        respond(id, { released: true });
        break;
      default:
        respondError(id, `unknown_op:${op}`);
    }
  } catch (error) {
    respondError(id, error instanceof Error ? error.message : 'control_channel_error');
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown (mirror of server.ts:71-87): close store + server.
// ---------------------------------------------------------------------------
function shutdown() {
  try {
    store.close();
  } catch {
    // best-effort
  }
  server.close(() => {
    process.exit(0);
  });
  // Hard fallback if the server never opened.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
