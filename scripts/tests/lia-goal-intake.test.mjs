import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { transform } from '../../frontend/node_modules/esbuild/lib/main.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const projectsPath = join(repoRoot, 'frontend/src/components/projects-r3/ProjectsShellR3.tsx');
const clientPath = join(repoRoot, 'frontend/src/integrations/liaProjectGoalClient.ts');
const runtimePath = join(repoRoot, 'scripts/lia-production-same-origin-runtime-server.mjs');
const GOAL_ID = '550e8400-e29b-41d4-a716-446655440000';

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForRuntime(baseUrl, child, output) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runtime exited ${child.exitCode}: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* startup */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error(`runtime startup timeout: ${output()}`);
}

test('frontend Goal client keeps one id across ambiguous retry and sends no authority fields', async () => {
  const source = await readFile(clientPath, 'utf8');
  const built = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' });
  const directory = await mkdtemp(join(tmpdir(), 'lia-goal-client-'));
  try {
    const modulePath = join(directory, 'client.mjs');
    await writeFile(modulePath, built.code);
    const client = await import(`${new URL(`file://${modulePath}`).href}?test=${Date.now()}`);
    const requests = [];
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      call += 1;
      if (call === 1) throw new TypeError('ambiguous network failure');
      return new Response(JSON.stringify({
        ok: true,
        integration: 'project_goal_control',
        alreadyKnown: true,
        goal: { goalId: requests[0].body.goalId, projectId: 'lia-hermes' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const prepared = client.prepareLiaProjectGoal({ projectId: 'lia-hermes', objective: '  Ship safely.  ', priority: 'high' });
      const result = await client.submitLiaProjectGoal(prepared);
      assert.equal(result.kind, 'accepted');
      assert.equal(result.alreadyKnown, true);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0].body, requests[1].body);
      assert.deepEqual(Object.keys(requests[0].body).sort(), ['goalId', 'objective', 'priority', 'projectId']);
      assert.equal(requests[0].body.projectId, 'lia-hermes');
      assert.equal(requests[0].body.objective, 'Ship safely.');
      assert.equal(requests[0].body.priority, 'high');
      assert.match(requests[0].body.goalId, /^[0-9a-f-]{36}$/);
      assert.equal(requests[0].body.goalId, requests[1].body.goalId);
      assert.equal('requestedCapabilities' in requests[0].body, false);
      assert.equal('autonomy' in requests[0].body, false);

      globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'invalid_goal' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
      const rejected = await client.submitLiaProjectGoal(client.prepareLiaProjectGoal({
        projectId: 'lia-hermes', objective: 'Keep this mission.', priority: 'normal',
      }));
      assert.equal(rejected.kind, 'contract');
      assert.match(rejected.message, /Revisa la instrucción/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('frontend sends durable bounded policy only when explicitly selected and retries it exactly', async () => {
  const source = await readFile(clientPath, 'utf8');
  const built = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' });
  const directory = await mkdtemp(join(tmpdir(), 'lia-goal-bounded-client-'));
  const originalFetch = globalThis.fetch;
  try {
    const modulePath = join(directory, 'client.mjs');
    await writeFile(modulePath, built.code);
    const client = await import(`${new URL(`file://${modulePath}`).href}?test=${Date.now()}`);
    const estimate = {
      complexity: 'high', recommendedMaxAttempts: 4, recommendedContinuationDepth: 3,
      recommendedMaxCycles: 4, recommendedElapsedBudgetMs: 21_600_000,
      riskFactors: ['explicit_cross_component_work'], rationale: ['Explicit integration.'], confidence: 0.9,
    };
    const prepared = client.prepareLiaProjectGoal({
      projectId: 'lia-hermes', objective: 'Integrate and verify.', priority: 'high',
      autonomyMode: 'bounded_autonomous', estimate,
    });
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) throw new TypeError('ambiguous');
      return new Response(JSON.stringify({ ok: true, alreadyKnown: true, goal: { goalId: prepared.request.goalId } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    const result = await client.submitLiaProjectGoal(prepared);
    assert.equal(result.kind, 'accepted');
    assert.deepEqual(requests[0], requests[1], 'ambiguous retry reuses the exact goalId and policy');
    assert.deepEqual(requests[0].autonomy, {
      mode: 'bounded_autonomous', approver: 'lia-ui-operator', maxCycles: 4, elapsedBudgetMs: 21_600_000,
    });
    assert.equal(requests[0].maxAttempts, 4);
    assert.equal(requests[0].continuationDepthLimit, 3);
    assert.equal('requestedCapabilities' in requests[0], false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Projects composer uses canonical Goal intake and contains no legacy/direct executor calls', async () => {
  const [projects, client] = await Promise.all([readFile(projectsPath, 'utf8'), readFile(clientPath, 'utf8')]);
  assert.match(projects, /const PROJECT_ID = 'lia-hermes';/);
  assert.match(projects, /<ExecutiveBoardPanelR3 projectId=\{PROJECT_ID\}/);
  assert.doesNotMatch(projects, /prepareProjectTask|submitProjectTask|getProjectTaskStatus/);
  assert.match(projects, /setInstruction\(objective\)/, 'failure restores the mission to the composer');
  assert.doesNotMatch(projects, /progressFor|progressWidth|WORKFLOW_STEPS/);
  assert.match(client, /LIA_PROJECT_GOALS_PATH = '\/api\/lia-agent\/projects\/goals'/);
  assert.doesNotMatch(client, /requestedCapabilities\s*:/);
  assert.doesNotMatch(`${projects}\n${client}`, /fetch\([^\n]*(?:hermes\/query|projects\/tasks)/i);
});

test('production same-origin Goals bridge preserves GET, forwards only exact POST, and fails closed', async () => {
  const upstreamRequests = [];
  const backend = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    upstreamRequests.push({ method: request.method, url: request.url, raw, headers: request.headers });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/projects/goals') {
      const body = JSON.parse(raw);
      response.statusCode = 202;
      response.end(JSON.stringify({
        ok: true,
        integration: 'project_goal_control',
        alreadyKnown: false,
        goal: { goalId: body.goalId, projectId: body.projectId, objective: body.objective },
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/projects/goals/effort-estimate') {
      response.end(JSON.stringify({
        ok: true,
        estimate: {
          complexity: 'medium', recommendedMaxAttempts: 3, recommendedContinuationDepth: 2,
          recommendedMaxCycles: 3, recommendedElapsedBudgetMs: 7_200_000,
          riskFactors: [], rationale: ['Deterministic intake signal.'], confidence: 0.75,
        },
      }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/projects/goals') {
      response.end(JSON.stringify({ ok: true, goals: [], total: 0 }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/projects/goals/supervisor') {
      response.end(JSON.stringify({ ok: true, supervisor: { state: 'idle' } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false }));
  });
  const backendPort = await listen(backend);
  const runtimePort = await freePort();
  let output = '';
  const runtime = spawn(process.execPath, [runtimePath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LIA_PRODUCTION_RUNTIME_PORT: String(runtimePort),
      LIA_HERMES_BACKEND_PORT: String(backendPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runtime.stdout.on('data', (chunk) => { output += chunk; });
  runtime.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${runtimePort}`;
  try {
    await waitForRuntime(base, runtime, () => output);
    let response = await fetch(`${base}/api/lia-agent/projects/goals`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);

    const goal = { goalId: GOAL_ID, projectId: 'lia-hermes', objective: 'Create the durable goal.', priority: 'normal' };
    response = await fetch(`${base}/api/lia-agent/projects/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goal),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.goal.goalId, GOAL_ID);
    const forwarded = upstreamRequests.find((item) => item.method === 'POST');
    assert.deepEqual(JSON.parse(forwarded.raw), goal);
    assert.equal(forwarded.url, '/api/projects/goals');

    const boundedGoal = {
      ...goal,
      goalId: '550e8400-e29b-41d4-a716-446655440001',
      maxAttempts: 3,
      continuationDepthLimit: 2,
      autonomy: { mode: 'bounded_autonomous', approver: 'lia-ui-operator', maxCycles: 3, elapsedBudgetMs: 7_200_000 },
    };
    response = await fetch(`${base}/api/lia-agent/projects/goals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(boundedGoal),
    });
    assert.equal(response.status, 202);
    const forwardedGoals = upstreamRequests.filter((item) => item.method === 'POST' && item.url === '/api/projects/goals');
    assert.deepEqual(JSON.parse(forwardedGoals[1].raw), boundedGoal);

    response = await fetch(`${base}/api/lia-agent/projects/goals/effort-estimate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'lia-hermes', objective: 'Estimate safely.', priority: 'normal' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).estimate.complexity, 'medium');

    response = await fetch(`${base}/api/lia-agent/projects/goals`, { method: 'PUT' });
    assert.equal(response.status, 405);
    response = await fetch(`${base}/api/lia-agent/projects/goals/supervisor`, { method: 'POST' });
    assert.equal(response.status, 405);
    response = await fetch(`${base}/api/lia-agent/projects/goals/other`, { method: 'POST' });
    assert.equal(response.status, 404);
    response = await fetch(`${base}/api/lia-agent/projects/goals`, { method: 'POST', body: JSON.stringify(goal) });
    assert.equal(response.status, 415);
    response = await fetch(`${base}/api/lia-agent/projects/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...goal, requestedCapabilities: ['repository_read'] }),
    });
    assert.equal(response.status, 400);
    assert.equal(upstreamRequests.filter((item) => item.method === 'POST' && item.url === '/api/projects/goals').length, 2);
  } finally {
    runtime.kill('SIGTERM');
    await new Promise((resolveExit) => {
      if (runtime.exitCode !== null) resolveExit();
      else runtime.once('exit', resolveExit);
    });
    await close(backend);
  }
});
