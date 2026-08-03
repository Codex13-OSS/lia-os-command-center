import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createAgendaSqliteReadSource } from './services/agendaSqliteReadSource.js';
import { createProjectRegistryFileSource } from './services/projectRegistryFileSource.js';

const config = loadConfig();
// Verification policy is intentionally not constructed here until the internal
// project-task workflow has a dependency slot that does not expose a public route.
const dependencies = {
  ...(config.agendaSqlitePath === ''
    ? {}
    : { agendaReadSource: createAgendaSqliteReadSource(config.agendaSqlitePath) }),
  ...(config.projectRegistryPath === ''
    ? {}
    : { projectRegistrySource: createProjectRegistryFileSource(config.projectRegistryPath) }),
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
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
