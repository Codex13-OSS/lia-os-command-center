import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createAgendaSqliteReadSource } from './services/agendaSqliteReadSource.js';
import { createProjectRegistryFileSource } from './services/projectRegistryFileSource.js';
import { createFileProjectVerificationRegistry } from './services/projectVerificationFileSource.js';
import { createProjectTaskStore } from './services/projectTaskStoreFactory.js';
import { reconcileProjectTasksAtStartup } from './services/projectTaskReconciliation.js';
import { createProjectSupervisorSchedulingRuntime } from './services/projectSupervisorSchedulingRuntime.js';
import { ExecutiveBoardSqliteStore } from './services/executiveBoardSqliteStore.js';

const config = loadConfig();
const projectTaskStore = createProjectTaskStore(config);
// Board evidence is durable in a separate least-privilege database. It never
// migrates or broadens the task/Goals authority database.
const executiveBoardStore = config.projectTaskSqlitePath === ''
  ? undefined
  : new ExecutiveBoardSqliteStore(`${config.projectTaskSqlitePath}.board.sqlite`);

// Recover only provably pre-execution durable work before listening. Ambiguous
// work fails closed, and a recovery failure prevents app.listen.
reconcileProjectTasksAtStartup(projectTaskStore);

const projectRegistrySource = config.projectRegistryPath === ''
  ? undefined
  : createProjectRegistryFileSource(config.projectRegistryPath);
const projectVerificationRegistry = config.projectVerificationPath === ''
  ? undefined
  : createFileProjectVerificationRegistry(config.projectVerificationPath);

const dependencies = {
  ...(config.agendaSqlitePath === ''
    ? {}
    : { agendaReadSource: createAgendaSqliteReadSource(config.agendaSqlitePath) }),
  ...(projectRegistrySource !== undefined ? { projectRegistrySource } : {}),
  ...(projectVerificationRegistry !== undefined ? { projectVerificationRegistry } : {}),
  projectTaskStore,
  ...(executiveBoardStore !== undefined ? { executiveBoardStore } : {}),
};

// Supervisor Scheduling Runtime Wiring (design: supervisor-scheduling-runtime-wiring-design.md).
// Default OFF (LIA_SUPERVISOR_ENABLED=false): like the bounded pass it drives,
// the runtime ships inert unless explicitly enabled. When enabled, exactly ONE
// bounded reconciliation opportunity is requested per process startup, strictly
// AFTER durable recovery/reconciliation and BEFORE listen. The wakeup is
// coalesced and single-flight, and the pass itself re-derives everything from
// durable rows: a process restart recovers from durable evidence, never from a
// surviving callback. The structural store guard keeps the in-memory store
// (which has no goal surface) in the unsupported state.
const projectSupervisorRuntime = config.supervisorEnabled
  ? createProjectSupervisorSchedulingRuntime({
      store: projectTaskStore,
      config,
      ...(projectRegistrySource !== undefined ? { registry: projectRegistrySource } : {}),
      ...(projectVerificationRegistry !== undefined ? { verificationRegistry: projectVerificationRegistry } : {}),
    })
  : undefined;

if (projectSupervisorRuntime !== undefined) {
  projectSupervisorRuntime.requestPass('startup');
}

const app = createApp(config, {
  ...dependencies,
  ...(projectSupervisorRuntime !== undefined ? { projectSupervisorRuntime } : {}),
});
const server = app.listen(config.port, config.host, () => {
  if (config.logLevel !== 'silent') {
    console.log(`LIA agent TypeScript backend listening on http://${config.host}:${config.port}`);
  }
});

server.on('error', (error) => {
  console.error('LIA agent TypeScript backend refused to start.');
  console.error(error instanceof Error ? error.message : 'unknown_error');
  process.exitCode = 1;
});

function shutdown() {
  try {
    executiveBoardStore?.close();
  } catch {
    // Best-effort close during shutdown.
  }
  const closeStore = (projectTaskStore as { close?: () => void }).close;
  if (typeof closeStore === 'function') {
    try {
      closeStore();
    } catch {
      // Best-effort close during shutdown; server exit proceeds regardless.
    }
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
