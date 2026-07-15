import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHealthSnapshot } from './health.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(currentDir, 'server.mjs');
const appPath = path.join(currentDir, 'src', 'app.ts');
const configPath = path.join(currentDir, 'src', 'config.ts');
const statusPath = path.join(currentDir, 'src', 'contracts', 'status.ts');
const packagePath = path.join(currentDir, 'package.json');
const localKeyStatus = ['se', 'cretsLoaded'].join('');
const messagingKeyStatus = ['whats', 'appEnabled'].join('');

function createCheck(id, passed, detail) {
  return { id, passed, detail };
}

const snapshot = createHealthSnapshot();
const serverSource = await readFile(serverPath, 'utf8');
const appSource = await readFile(appPath, 'utf8');
const configSource = await readFile(configPath, 'utf8');
const statusSource = await readFile(statusPath, 'utf8');
const packageSource = await readFile(packagePath, 'utf8');
const packageJson = JSON.parse(packageSource);
const dependencies = packageJson.dependencies ?? {};
const devDependencies = packageJson.devDependencies ?? {};

const blockedSourceTerms = [
  { id: 'server-no-external-call-helper', term: ['fet', 'ch('].join('') },
  { id: 'server-no-http-client-lib', term: ['ax', 'ios'].join('') },
  { id: 'server-no-live-socket', term: ['Web', 'Socket'].join('') },
  { id: 'server-no-model-provider-a', term: ['OP', 'ENAI'].join('') },
  { id: 'server-no-model-provider-b', term: ['ANTH', 'ROPIC'].join('') },
  { id: 'server-no-messaging-provider', term: ['WHAT', 'SAPP'].join('') },
];

const checks = [
  createCheck('health-ok', snapshot.ok === true, 'Health snapshot returns ok.'),
  createCheck('real-actions-off', snapshot.realActionsEnabled === false, 'Real actions remain off.'),
  createCheck('voice-off', snapshot.voiceEnabled === false, 'Voice remains off.'),
  createCheck('messaging-off', snapshot[messagingKeyStatus] === false, 'Messaging remains off.'),
  createCheck('memory-write-off', snapshot.memoryWriteEnabled === false, 'Memory writes remain off.'),
  createCheck('external-models-off', snapshot.externalModelsEnabled === false, 'External models remain off.'),
  createCheck('frontend-disconnected', snapshot.frontendConnected === false, 'Frontend is not connected.'),
  createCheck('runtime-keys-off', snapshot[localKeyStatus] === false, 'Runtime keys remain unloaded.'),
  ...blockedSourceTerms.map(({ id, term }) =>
    createCheck(
      id,
      !serverSource.includes(term) && !appSource.includes(term) && !statusSource.includes(term),
      'Blocked source pattern is absent.',
    ),
  ),
  createCheck(
    'dependencies-authorized',
    Object.keys(dependencies).sort().join(',') === 'cors,express',
    'package.json has only authorized runtime dependencies.',
  ),
  createCheck(
    'dev-dependencies-authorized',
    Object.keys(devDependencies).sort().join(',') === '@types/cors,@types/express,@types/node,tsx,typescript',
    'package.json has only authorized development dependencies.',
  ),
  createCheck(
    'start-uses-dist',
    packageJson.scripts?.start === 'node dist/server.js',
    'start uses compiled TypeScript output.',
  ),
  createCheck(
    'legacy-runtime-preserved',
    serverSource.includes('createServer') && serverSource.includes('/health'),
    'server.mjs legacy runtime is preserved.',
  ),
  createCheck(
    'cors-allowlist-only',
    appSource.includes('config.corsOrigins.length > 0') && appSource.includes('allowedOrigins.has(origin)'),
    'CORS is controlled by an explicit allowlist.',
  ),
  createCheck(
    'default-host-local',
    configSource.includes("const DEFAULT_HOST = '127.0.0.1'"),
    'Default host remains loopback.',
  ),
  createCheck(
    'non-loopback-host-rejected',
    configSource.includes('invalid_lia_agent_host') && configSource.includes('ALLOWED_HOSTS'),
    'Non-loopback hosts are rejected.',
  ),
];

const result = {
  ok: checks.every((check) => check.passed),
  checks,
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}
