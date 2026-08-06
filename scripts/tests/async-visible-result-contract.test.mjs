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

test('same-origin task sanitizer allowlists terminal diagnostics and strips internal fields', () => {
  const base = { ok: true, integration: 'project_task', taskId: '550e8400-e29b-41d4-a716-446655440000', status: 'failed', terminal: true };
  const safe = sanitizeProjectTaskPayload({ ...base, error: { stage: 'hermes', code: 'timeout', message: 'Hermes agotó el tiempo de respuesta.', path: '/private', command: 'rm', stderr: 'secret', stdout: 'secret', prompt: 'secret' } });
  assert.deepEqual(safe, { ...base, error: { stage: 'hermes', code: 'timeout', message: 'Hermes agotó el tiempo de respuesta.' } });
  for (const mutation of [
    { stage: 'hermes', code: 'attacker_code', message: 'safe' },
    { stage: 'fake', code: 'timeout', message: 'Hermes agotó el tiempo de respuesta.' },
    { stage: 'hermes', code: 'timeout', message: 'attacker-controlled' },
  ]) assert.equal(sanitizeProjectTaskPayload({ ...base, error: mutation }), null);
});

test('frontend maps controlled Hermes failures and retains a generic unknown fallback', async () => {
  const client = await readFile(new URL('../../frontend/src/integrations/liaProjectTaskClient.ts', import.meta.url), 'utf8');
  for (const [code, message] of [
    ['timeout', 'Hermes agotó el tiempo de respuesta.'],
    ['execution_failed', 'Hermes no pudo completar el razonamiento.'],
    ['invalid_hermes_json', 'Hermes devolvió una respuesta con formato inválido.'],
    ['invalid_hermes_proposal', 'Hermes produjo un plan que LÍA rechazó por seguridad o estructura.'],
  ]) {
    assert.match(client, new RegExp(`${code}: '${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.match(client, /FAILURE_MESSAGES\[code\] \?\? 'La ejecución no pudo completarse\.'/);
});

test('frontend creates new persisted tasks, recovers reloads, retries idempotently and avoids synchronous workflow', async () => {
  const [client, component] = await Promise.all([readFile(clientPath, 'utf8'), readFile(componentPath, 'utf8')]);
  assert.ok(client.indexOf('storage.setItem(LIA_PROJECT_TASK_STORAGE_KEY') < client.indexOf('export async function submitProjectTask'));
  assert.doesNotMatch(client, /const existing = loadPersistedProjectTask\(storage\)/);
  assert.match(client, /taskId: createProjectTaskId\(\)/);
  assert.match(client, /typeof globalThis\.crypto\?\.randomUUID === 'function'/);
  assert.match(client, /globalThis\.crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.match(client, /bytes\[6\].*0x40/);
  assert.match(client, /bytes\[8\].*0x80/);
  assert.match(client, /export function clearPersistedProjectTask\(taskId: string/);
  assert.match(client, /persisted\?\.taskId === taskId/);
  assert.match(client, /body\.status as LiaProjectTaskStage/);
  assert.match(component, /useEffect\(\(\) => \{[\s\S]*?const saved = loadPersistedProjectTask\(\)/);
  assert.match(component, /result\.kind === 'unknown'\) \{ clearPersistedProjectTask\(task\.taskId\)/);
  assert.match(component, /if \(submitted === 'ambiguous'\) \{[\s\S]*?await submitProjectTask\(task\)/);
  assert.match(component, /No fue posible preparar o enviar la tarea\./);
  assert.doesNotMatch(component, /No fue posible iniciar la recuperación de la tarea\./);
  assert.match(component, /LÍA · Hermes · Codex conectados/);
  assert.match(component, /LÍA está recuperando el último estado confirmado de la tarea\./);
  assert.match(component, /eyebrow: 'LÍA ESTÁ LISTA'/);
  assert.match(component, /label: 'Preparando'/);
  assert.match(component, /label: 'Hermes'/);
  assert.match(component, /label: 'Ejecutando'/);
  assert.match(component, /label: 'Verificando'/);
  assert.match(component, /label: 'Guardando'/);
  assert.match(component, /stage === 'accepted' \|\| stage === 'planning'/);
  assert.match(component, /aria-current=\{step\.state === 'active' \? 'step' : undefined\}/);
  assert.match(component, /Análisis completado/);
  assert.match(component, /receipt\.resultText/);
  assert.match(component, /No requerida/);
  assert.match(component, /receipt\.verification\.checksPassed/);
  assert.match(component, /receipt\.commit/);
  assert.match(component, /El servicio pudo haberse reiniciado/);
  assert.match(component, /setReceipt\(result\.receipt\)/);
  assert.match(component, /result\.kind === 'temporary'[\s\S]*?await wait\(TEMPORARY_RETRY_MS\)/);
  assert.doesNotMatch(component, /shouldPauseAfterTemporaryFailure/);
  assert.doesNotMatch(component, /MAX_POLL_DURATION_MS/);
  assert.doesNotMatch(component, /El seguimiento se pausó/);
  assert.doesNotMatch(component, /requestLiaProjectTaskWorkflow/);
  assert.doesNotMatch(client, /tasks\/workflow/);
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
