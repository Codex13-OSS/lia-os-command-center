import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT,
  executeController,
  jsonText,
} from './deploy-controller.mjs';

export const HERMES_V501_POLICY = Object.freeze({
  schemaVersion: 'lia-agent-backend-deploy/v1',
  repoRoot: '/opt/executive-platform-demo-hermes',
  branch: 'feat/lia-os-v500-hermes-adapter-foundation',
  sourceBackendDir: '/opt/executive-platform-demo-hermes/backend/lia-agent',
  deployDir: '/opt/lia-agent-backend',
  backupRoot: '/opt/lia-agent-backups',
  pm2ProcessName: 'lia-agent-backend',
  host: '127.0.0.1',
  port: 3014,
  currentVersion: 'v5.0.0',
  targetVersion: 'v5.0.1',
  currentScript: 'dist/server.js',
  targetScript: 'dist/server.js',
  healthPath: '/health',
  statusPath: '/api/status',
  allowedServicePorts: [3004, 3014, 3023],
});

export const HERMES_V501_PM2_ENV = Object.freeze({
  LIA_AGENT_HOST: '127.0.0.1',
  LIA_AGENT_PORT: '3014',
  LIA_AGENT_CORS_ORIGINS: '',
  LIA_AGENT_LOG_LEVEL: 'info',
  NODE_ENV: 'production',
  LIA_HERMES_ROOT: '/home/hermes-agent/.hermes/hermes-agent',
  LIA_HERMES_EXECUTION_ENABLED: 'true',
  LIA_HERMES_EXECUTABLE: '/home/hermes-agent/.local/bin/hermes',
  LIA_HERMES_HOME: '/home/hermes-agent/.hermes',
  LIA_HERMES_USER: 'hermes-agent',
  LIA_HERMES_USER_HOME: '/home/hermes-agent',
  LIA_HERMES_PATH: '/home/hermes-agent/.local/bin:/usr/local/bin:/usr/bin:/bin',
  LIA_HERMES_PROVIDER: 'openai-codex',
  LIA_HERMES_MODEL: 'gpt-5.6-terra',
  LIA_HERMES_TIMEOUT_MS: '120000',
  LIA_HERMES_MAX_QUERY_CHARACTERS: '8000',
});

export async function executeHermesV501Controller(argv) {
  return executeController({
    argv,
    policy: HERMES_V501_POLICY,
    pm2FunctionalEnv: HERMES_V501_PM2_ENV,
  });
}

async function main() {
  try {
    const result = await executeHermesV501Controller(process.argv.slice(2));
    process.stdout.write(jsonText(result));
    process.exitCode = result.ok ? EXIT.OK : EXIT.PREFLIGHT;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(jsonText({
      details: error.details ?? {},
      error: error.message,
      ok: false,
    }));
    process.exitCode = error.code ?? EXIT.APPLY_FAILED;
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  await main();
}
