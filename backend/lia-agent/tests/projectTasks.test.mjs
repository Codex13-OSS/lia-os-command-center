import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { InMemoryProjectTaskStore } from '../dist/services/inMemoryProjectTaskStore.js';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const request = (overrides = {}) => ({ taskId: ID, projectId: 'safe', instruction: 'Implement safely.', priority: 'normal', requestedCapabilities: ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'], ...overrides });
const registry = { read: async () => [{ projectId: 'safe', displayName: 'Safe', repositoryRoot: '/safe/repo', enabled: true }] };
const success = { ok: true, projectId: 'safe', executionId: 'exec-safe', status: 'committed', executionSummary: 'hidden', resultText: 'Cambio completado.', verification: { status: 'verified', checksPassed: 2, totalChecks: 3 }, commit: 'a'.repeat(40) };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function server(app, fn) { const s = app.listen(0, '127.0.0.1'); await once(s, 'listening'); try { await fn(`http://127.0.0.1:${s.address().port}`); } finally { await new Promise((r) => s.close(r)); } }
const post = (base, body) => fetch(`${base}/api/projects/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('acknowledges before detached workflow, retries once, publishes stages and safe committed receipt', async () => {
  const gate = deferred(); let calls = 0; const stages = [];
  const app = createApp(loadConfig({}), { projectRegistrySource: registry, projectTaskStore: new InMemoryProjectTaskStore(), projectTasksWorkflowExecutor: async (_request, observe) => { calls++; for (const stage of ['planning', 'hermes', 'codex', 'verification', 'commit']) { observe(stage); stages.push(stage); } await gate.promise; return success; } });
  await server(app, async (base) => {
    const first = await post(base, request()); assert.equal(first.status, 202); assert.equal((await first.json()).status, 'accepted');
    await new Promise(setImmediate); assert.equal(calls, 1);
    const retry = await post(base, request()); assert.equal(retry.status, 200); assert.equal((await retry.json()).alreadyKnown, true); assert.equal(calls, 1);
    const conflict = await post(base, request({ instruction: 'Different.' })); assert.equal(conflict.status, 409); assert.equal(calls, 1);
    gate.resolve(); await new Promise(setImmediate);
    const status = await fetch(`${base}/api/projects/tasks/${ID}`); const body = await status.json();
    assert.deepEqual(stages, ['planning', 'hermes', 'codex', 'verification', 'commit']);
    assert.deepEqual(body, { ok: true, integration: 'project_task', taskId: ID, status: 'completed', terminal: true, receipt: { executionId: 'exec-safe', status: 'committed', resultText: 'Cambio completado.', verification: { status: 'verified', checksPassed: 2, totalChecks: 3 }, commit: 'a'.repeat(40) } });
    assert.equal(JSON.stringify(body).includes('/safe/repo'), false); assert.equal(JSON.stringify(body).includes('hidden'), false);
  });
});

test('terminalizes thrown failures and validates invalid and unknown IDs', async () => {
  const app = createApp(loadConfig({}), { projectRegistrySource: registry, projectTasksWorkflowExecutor: async () => { throw new Error('PRIVATE /path command prompt'); } });
  await server(app, async (base) => {
    assert.equal((await post(base, request({ taskId: 'bad' }))).status, 400);
    assert.equal((await fetch(`${base}/api/projects/tasks/550e8400-e29b-41d4-a716-446655440001`)).status, 404);
    await post(base, request()); await new Promise(setImmediate);
    const body = await (await fetch(`${base}/api/projects/tasks/${ID}`)).json(); assert.deepEqual(body.error, { code: 'workflow_failed', message: 'La ejecución no pudo completarse.' }); assert.equal(JSON.stringify(body).includes('PRIVATE'), false);
  });
});

test('serves current status promptly while a deliberately slow workflow is still running', async () => {
  const gate = deferred();
  const enteredCodex = deferred();
  const app = createApp(loadConfig({}), {
    projectRegistrySource: registry,
    projectTasksWorkflowExecutor: async (_request, observe) => {
      observe('planning');
      observe('hermes');
      observe('codex');
      enteredCodex.resolve();
      await gate.promise;
      return success;
    },
  });

  await server(app, async (base) => {
    assert.equal((await post(base, request())).status, 202);
    await enteredCodex.promise;

    const startedAt = performance.now();
    const response = await fetch(`${base}/api/projects/tasks/${ID}`);
    const elapsedMs = performance.now() - startedAt;

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      integration: 'project_task',
      taskId: ID,
      status: 'codex',
      terminal: false,
    });
    assert.ok(elapsedMs < 250, `status took ${elapsedMs.toFixed(1)}ms while workflow was active`);

    gate.resolve();
  });
});

test('store capacity never evicts active tasks and terminal TTL uses injected clock', () => {
  let now = 0; const store = new InMemoryProjectTaskStore({ maxRecords: 1, maxActive: 1, terminalTtlMs: 10, now: () => now });
  const intent = request(); delete intent.taskId;
  assert.equal(store.createOrGet(ID, 'one', intent).kind, 'created');
  assert.equal(store.createOrGet('550e8400-e29b-41d4-a716-446655440001', 'two', intent).kind, 'capacity'); assert.ok(store.get(ID));
  store.complete(ID, { executionId: 'x', status: 'ready_for_review', resultText: 'Done.' }); now = 10; assert.equal(store.get(ID), undefined);
  assert.equal(store.createOrGet('550e8400-e29b-41d4-a716-446655440001', 'two', intent).kind, 'created');
});
