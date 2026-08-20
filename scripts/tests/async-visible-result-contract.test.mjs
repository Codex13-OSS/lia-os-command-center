import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sanitizeProjectTaskPayload } from '../lia-project-task-public-contract.mjs';
import test from 'node:test';

const runtimePath = new URL('../lia-production-same-origin-runtime-server.mjs', import.meta.url);
const clientPath = new URL('../../frontend/src/integrations/liaProjectTaskClient.ts', import.meta.url);
const componentPath = new URL('../../frontend/src/components/projects-r3/ProjectsShellR3.tsx', import.meta.url);
const taskRoutePath = new URL('../../backend/lia-agent/src/routes/projectTasks.ts', import.meta.url);
const viteConfigPath = new URL('../../frontend/vite.config.ts', import.meta.url);

test('vite dev proxy translates lia-agent prefixes to the internal backend contract', async () => {
  const source = await readFile(viteConfigPath, 'utf8');
  assert.match(source, /LIA_AGENT_BACKEND_TARGET = 'http:\/\/127\.0\.0\.1:3014'/);
  assert.doesNotMatch(source, /13004/);
  assert.match(source, /path === '\/api\/lia-agent\/query'/);
  assert.match(source, /'\/api\/hermes\/query'/);
  assert.match(source, /path === '\/api\/lia-agent\/projects\/tasks'/);
  assert.match(source, /path\.startsWith\('\/api\/lia-agent\/projects\/tasks\/'\)/);
  assert.match(source, /path\.replace\(\/\^\\\/api\\\/lia-agent\/, '\/api'\)/);
  assert.match(source, /rewrite: translateLiaAgentPath/);
  assert.match(source, /server:\s*\{\s*proxy: liaProxy/s);
  assert.match(source, /preview:\s*\{\s*host: '0\.0\.0\.0',\s*port: 5199,\s*strictPort: true,\s*proxy: liaProxy/s);
});

test('runtime exposes only exact async submit/status routes with short deadlines and sanitization', async () => {
  const [source, client] = await Promise.all([readFile(runtimePath, 'utf8'), readFile(clientPath, 'utf8')]);
  assert.match(source, /PROJECT_SUBMIT_TIMEOUT_MS = 8_000/);
  assert.match(source, /PROJECT_STATUS_TIMEOUT_MS = 3_000/);
  assert.match(client, /getProjectTaskStatus[\s\S]*?\}, 4_000\)/);
  assert.doesNotMatch(source, /spawnSync/);
  assert.match(source, /requestUrl\.pathname === SAME_ORIGIN_PROJECT_TASKS_PATH/);
  assert.match(source, /\^\\\/api\\\/lia-agent\\\/projects\\\/tasks\\\/\(\[\^\/\]\+\)\$/);
  assert.match(source, /sanitizeProjectTaskPayload/);
  assert.doesNotMatch(source, /startsWith\('\/api\/lia-agent\/projects\/tasks'/);
});

test('runtime accepts the same real instruction size the backend accepts', async () => {
  const [source, appSource] = await Promise.all([
    readFile(runtimePath, 'utf8'),
    readFile(new URL('../../backend/lia-agent/src/app.ts', import.meta.url), 'utf8'),
  ]);
  // Backend contract: instructions of up to 8_000 characters may be up to
  // ~32 KiB in UTF-8, and express.json accepts 64kb bodies.
  assert.match(appSource, /express\.json\(\{ limit: '64kb' \}\)/);
  const maxRequestBytesMatch = source.match(/MAX_REQUEST_BYTES = (\d+) \* 1024/);
  assert.ok(maxRequestBytesMatch, 'runtime defines MAX_REQUEST_BYTES in KiB');
  assert.ok(
    Number(maxRequestBytesMatch[1]) >= 64,
    'runtime request body cap must not be smaller than the backend 64kb JSON limit',
  );
});

test('same-origin task sanitizer allowlists terminal diagnostics and strips internal fields', () => {
  const base = { ok: true, integration: 'project_task', taskId: '550e8400-e29b-41d4-a716-446655440000', status: 'failed', terminal: true };
  const safe = sanitizeProjectTaskPayload({ ...base, error: { stage: 'hermes', code: 'timeout', message: 'Hermes agotó el tiempo de respuesta.', path: '/private', command: 'rm', stderr: 'secret', stdout: 'secret', prompt: 'secret' } });
  assert.deepEqual(safe, { ...base, error: { stage: 'hermes', code: 'timeout', message: 'Hermes agotó el tiempo de respuesta.' } });
  const interrupted = sanitizeProjectTaskPayload({ ...base, error: { code: 'workflow_interrupted', message: 'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.' } });
  assert.deepEqual(interrupted, { ...base, error: { code: 'workflow_interrupted', message: 'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.' } });
  for (const mutation of [
    { stage: 'hermes', code: 'attacker_code', message: 'safe' },
    { stage: 'fake', code: 'timeout', message: 'Hermes agotó el tiempo de respuesta.' },
    { stage: 'hermes', code: 'timeout', message: 'attacker-controlled' },
    { stage: 'commit', code: 'workflow_interrupted', message: 'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.' },
    { code: 'workflow_interrupted', message: 'attacker-controlled' },
  ]) assert.equal(sanitizeProjectTaskPayload({ ...base, error: mutation }), null);
});

test('same-origin task sanitizer allowlists only the fixed stage vocabulary', () => {
  const taskId = '550e8400-e29b-41d4-a716-446655440000';
  const receiptBase = {
    ok: true, integration: 'project_task', taskId, status: 'completed', terminal: true,
    receipt: {
      executionId: 'exec-1', status: 'committed', resultText: 'Cambio completado.',
      verification: { status: 'verified', checksPassed: 2, totalChecks: 3 },
      commit: 'a'.repeat(40),
    },
  };
  const withStages = sanitizeProjectTaskPayload({
    ...receiptBase,
    receipt: { ...receiptBase.receipt, stages: ['planning', 'hermes', 'codex', 'verification', 'visualQa', 'commit'] },
  });
  assert.deepEqual(withStages.receipt.stages, ['planning', 'hermes', 'codex', 'verification', 'visualQa', 'commit']);
  for (const trace of [
    ['planning', '/private', 'prompt'],
    ['planning', 'commit'],
    [],
    'planning',
    ['planning', 'hermes', 'codex', 'visualQa'],
  ]) {
    assert.equal(sanitizeProjectTaskPayload({
      ...receiptBase,
      receipt: { ...receiptBase.receipt, stages: trace },
    }), null, JSON.stringify(trace));
  }

  const failedBase = {
    ok: true, integration: 'project_task', taskId, status: 'failed', terminal: true,
    error: { stage: 'commit', code: 'git_commit_failed', message: 'No se pudo crear el commit local.' },
  };
  const withCompleted = sanitizeProjectTaskPayload({
    ...failedBase,
    error: { ...failedBase.error, completedStages: ['planning', 'hermes', 'codex', 'verification', 'visualQa'] },
  });
  assert.deepEqual(withCompleted.error.completedStages, ['planning', 'hermes', 'codex', 'verification', 'visualQa']);
  for (const trace of [['planning', 'secret'], ['verification', 'planning'], []]) {
    assert.equal(sanitizeProjectTaskPayload({
      ...failedBase,
      error: { ...failedBase.error, completedStages: trace },
    }), null, JSON.stringify(trace));
  }
});

test('frontend maps controlled Hermes failures and retains a generic unknown fallback', async () => {
  const client = await readFile(new URL('../../frontend/src/integrations/liaProjectTaskClient.ts', import.meta.url), 'utf8');
  for (const [code, message] of [
    ['timeout', 'Hermes agotó el tiempo de respuesta.'],
    ['execution_failed', 'Hermes no pudo completar el razonamiento.'],
    ['invalid_hermes_json', 'Hermes devolvió una respuesta con formato inválido.'],
    ['invalid_hermes_proposal', 'Hermes produjo un plan que LÍA rechazó por seguridad o estructura.'],
    ['workflow_interrupted', 'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.'],
  ]) {
    assert.match(client, new RegExp(`${code}: '${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.match(client, /FAILURE_MESSAGES\[code\] \?\? 'La ejecución no pudo completarse\.'/);
});

test('frontend creates client-minted idempotent Goals and avoids the legacy synchronous workflow', async () => {
  const [goalClient, component] = await Promise.all([
    readFile(new URL('../../frontend/src/integrations/liaProjectGoalClient.ts', import.meta.url), 'utf8'),
    readFile(componentPath, 'utf8'),
  ]);
  assert.match(goalClient, /function createGoalId\(\)/);
  assert.match(goalClient, /typeof globalThis\.crypto\?\.randomUUID === 'function'/);
  assert.match(goalClient, /globalThis\.crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.match(goalClient, /bytes\[6\].*0x40/);
  assert.match(goalClient, /bytes\[8\].*0x80/);
  assert.match(goalClient, /goalId: createGoalId\(\)/);
  assert.match(goalClient, /body: JSON\.stringify\(goal\.request\)/);
  assert.match(goalClient, /return first\.kind === 'ambiguous' \? submitOnce\(goal\) : first/);
  assert.match(component, /estimateLiaProjectGoalEffort\(/);
  assert.match(component, /const goal = prepareLiaProjectGoal\(/);
  assert.match(component, /const result = await submitLiaProjectGoal\(goal\)/);
  assert.match(component, /result\.kind === 'accepted'/);
  assert.match(component, /window\.dispatchEvent\(new Event\(LIA_GOAL_CREATED_EVENT\)\)/);
  assert.match(component, /No pude confirmar si el objetivo fue registrado/);
  assert.match(component, /setInstruction\(objective\)/);
  assert.doesNotMatch(component, /requestLiaProjectTaskWorkflow/);
  assert.doesNotMatch(goalClient, /tasks\/workflow/);
});

test('async terminal receipt preserves only bounded analyzed result text', async () => {
  const [client, route] = await Promise.all([readFile(clientPath, 'utf8'), readFile(taskRoutePath, 'utf8')]);
  assert.match(client, /'analyzed'/);
  assert.match(client, /receipt\.resultText\.length <= 6000/);
  assert.match(route, /result\.resultText\.length > 6000/);
  assert.match(route, /resultText: result\.resultText/);
  for (const forbidden of ['repositoryRoot: result', 'stderr: result', 'commands: result', 'env: result', 'prompt: result']) {
    assert.doesNotMatch(route, new RegExp(forbidden));
  }
});

test('real backend serves the same-origin status bridge path used by the UI', async () => {
  const [route, appSource, client] = await Promise.all([
    readFile(new URL('../../backend/lia-agent/src/routes/sameOriginStatus.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../backend/lia-agent/src/app.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/integrations/liaSameOriginStatusAdapterClient.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(route, /router\.route\('\/api\/lia-agent\/health'\)/);
  assert.match(appSource, /createSameOriginStatusRouter/);
  assert.match(client, /LIA_SAME_ORIGIN_STATUS_ADAPTER_PATH = '\/api\/lia-agent\/health'/);
});
