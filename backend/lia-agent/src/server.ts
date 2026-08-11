import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createAgendaSqliteReadSource } from './services/agendaSqliteReadSource.js';
import { createProjectRegistryFileSource } from './services/projectRegistryFileSource.js';
import { createFileProjectVerificationRegistry } from './services/projectVerificationFileSource.js';
import { createProjectTaskStore } from './services/projectTaskStoreFactory.js';
import { reconcileProjectTasksAtStartup } from './services/projectTaskReconciliation.js';

const config = loadConfig();
const projectTaskStore = createProjectTaskStore(config);

// Recover only provably pre-execution durable work before listening. Ambiguous
// work fails closed, and a recovery failure prevents app.listen.
reconcileProjectTasksAtStartup(projectTaskStore);

const dependencies = {
  ...(config.agendaSqlitePath === ''
    ? {}
    : { agendaReadSource: createAgendaSqliteReadSource(config.agendaSqlitePath) }),
  ...(config.projectRegistryPath === ''
    ? {}
    : { projectRegistrySource: createProjectRegistryFileSource(config.projectRegistryPath) }),
  ...(config.projectVerificationPath === ''
    ? {}
    : {
        projectVerificationRegistry:
          createFileProjectVerificationRegistry(config.projectVerificationPath),
      }),
  projectTaskStore,
};
const app = createApp(config, dependencies);
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
