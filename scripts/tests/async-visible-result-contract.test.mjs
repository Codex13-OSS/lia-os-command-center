import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimePath = new URL('../lia-production-same-origin-runtime-server.mjs', import.meta.url);
const clientPath = new URL('../../frontend/src/integrations/liaProjectTaskClient.ts', import.meta.url);
const componentPath = new URL('../../frontend/src/components/projects-r3/ProjectsShellR3.tsx', import.meta.url);

test('runtime exposes only exact async submit/status routes with short deadlines and sanitization', async () => {
  const source = await readFile(runtimePath, 'utf8');
  assert.match(source, /PROJECT_SUBMIT_TIMEOUT_MS = 8_000/);
  assert.match(source, /PROJECT_STATUS_TIMEOUT_MS = 4_000/);
  assert.match(source, /requestUrl\.pathname === SAME_ORIGIN_PROJECT_TASKS_PATH/);
  assert.match(source, /\^\\\/api\\\/lia-agent\\\/projects\\\/tasks\\\/\(\[\^\/\]\+\)\$/);
  assert.match(source, /sanitizeTaskPayload/);
  assert.doesNotMatch(source, /startsWith\('\/api\/lia-agent\/projects\/tasks'/);
});

test('frontend persists before submit, reuses UUID, polls server stages and does not use synchronous workflow', async () => {
  const [client, component] = await Promise.all([readFile(clientPath, 'utf8'), readFile(componentPath, 'utf8')]);
  assert.ok(client.indexOf('storage.setItem(LIA_PROJECT_TASK_STORAGE_KEY') < client.indexOf('export async function submitProjectTask'));
  assert.match(client, /const existing = loadPersistedProjectTask\(storage\); if \(existing\) return existing/);
  assert.match(client, /body\.status as LiaProjectTaskStage/);
  assert.match(component, /loadPersistedProjectTask\(\)/);
  assert.match(component, /LÍA · Hermes · Codex conectados/);
  assert.match(component, /Recuperando ejecución…/);
  assert.match(component, /LÍA está lista para recibir una tarea\./);
  assert.match(component, /WORKFLOW_LABELS = \['Hermes', 'Codex', 'Verificación', 'Resultado'\]/);
  assert.match(component, /stage === 'accepted' \|\| stage === 'planning'/);
  assert.match(component, /aria-current=\{step\.state === 'active' \? 'step' : undefined\}/);
  assert.match(component, /<h3>Tarea completada<\/h3>/);
  assert.match(component, /receipt\.verification\.checksPassed/);
  assert.match(component, /receipt\.commit/);
  assert.match(component, /El servicio pudo haberse reiniciado/);
  assert.match(component, /setReceipt\(result\.receipt\)/);
  assert.doesNotMatch(component, /requestLiaProjectTaskWorkflow/);
  assert.doesNotMatch(client, /tasks\/workflow/);
});
