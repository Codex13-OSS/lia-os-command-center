import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { transform } from '../../frontend/node_modules/esbuild/lib/main.js';

const root = resolve(import.meta.dirname, '../..');
const runtimePath = join(root, 'scripts/lia-production-same-origin-runtime-server.mjs');
const GOAL = '550e8400-e29b-41d4-a716-446655440000';
const DECISION = 'board-decision-1';
const PROJECT = 'lia-hermes';

async function listen(server) { await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen)); return server.address().port; }
async function close(server) { await new Promise((resolveClose) => server.close(resolveClose)); }
async function freePort() { const server = createServer(); const port = await listen(server); await close(server); return port; }
async function wait(base, child, output) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output());
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* startup */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  }
  throw new Error(`runtime timeout: ${output()}`);
}

async function importTs(path, name) {
  const source = await readFile(path, 'utf8');
  const built = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  const directory = await mkdtemp(join(tmpdir(), `lia-point9-${name}-`));
  const modulePath = join(directory, `${name}.mjs`);
  await writeFile(modulePath, built.code);
  return { module: await import(`${new URL(`file://${modulePath}`).href}?${Date.now()}`), directory };
}

test('Point 9 clients pin identity, carry no fake evidence, require real revoke id, and reuse ambiguous retry payload', async () => {
  const boardLoaded = await importTs(join(root, 'frontend/src/integrations/liaExecutiveBoardClient.ts'), 'board');
  const goalSource = await readFile(join(root, 'frontend/src/integrations/liaHumanControlClient.ts'), 'utf8');
  const inlinedGoalSource = goalSource.replace("import { LIA_BOUNDED_AUTONOMY_APPROVER } from './liaProjectGoalClient';", "const LIA_BOUNDED_AUTONOMY_APPROVER = 'lia-ui-operator';");
  const goalBuilt = await transform(inlinedGoalSource, { loader: 'ts', format: 'esm', target: 'es2022' });
  const goalDirectory = await mkdtemp(join(tmpdir(), 'lia-point9-goal-'));
  const goalPath = join(goalDirectory, 'goal.mjs'); await writeFile(goalPath, goalBuilt.code);
  const goal = await import(`${new URL(`file://${goalPath}`).href}?${Date.now()}`);
  const originalFetch = globalThis.fetch;
  try {
    const decision = { decisionId: DECISION, projectId: PROJECT };
    const prepared = boardLoaded.module.prepareLiaBoardTransition(decision, 'approved');
    assert.deepEqual(prepared.body.evidence, []);
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) throw new TypeError('ambiguous');
      return new Response(JSON.stringify({ ok: true, decision: { ...decision, outcome: { status: 'approved' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    assert.equal((await boardLoaded.module.submitLiaBoardTransition(prepared)).ok, true);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].requestKey, prepared.body.requestKey);

    const snapshot = { continuation: { authorization: {}, approval: {} }, autonomy: {} };
    assert.equal((await goal.runLiaGoalControlAction('revoke-authorization', GOAL, snapshot)).ok, false);
    assert.equal(requests.length, 2, 'missing real authorizationId performs no request');
    globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(init.body)); return new Response('{}', { status: 503 }); };
    await goal.runLiaGoalControlAction('approve-continuation', GOAL, snapshot);
    assert.deepEqual(requests.at(-1), { approver: 'lia-ui-operator' });
    assert.deepEqual(requests.at(-2), requests.at(-1));
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all([rm(boardLoaded.directory, { recursive: true, force: true }), rm(goalDirectory, { recursive: true, force: true })]);
  }
});

test('Point 9 same-origin bridge exposes only exact declared controls with strict methods and bodies', async () => {
  const upstream = [];
  const backend = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    upstream.push({ method: request.method, url: request.url, raw });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url?.endsWith('/continuation')) return response.end(JSON.stringify({ ok: true, integration: 'project_goal_control', goalId: GOAL, approval: {}, authorization: {} }));
    if (request.method === 'GET' && request.url?.endsWith('/autonomy')) return response.end(JSON.stringify({ ok: true, integration: 'project_goal_control', goalId: GOAL, mode: 'approved_single_step', policyState: 'approved_single_step' }));
    if (request.method === 'GET' && request.url === `/api/projects/${PROJECT}/board-decisions?limit=1`) return response.end(JSON.stringify({ ok: true, integration: 'lia_executive_board_v1', decisions: [] }));
    if (request.method === 'POST' && request.url?.includes('board-decisions')) return response.end(JSON.stringify({ ok: true, integration: 'lia_executive_board_v1', advisoryOnly: true, decision: { decisionId: DECISION } }));
    if (request.method === 'POST') return response.end(JSON.stringify({ ok: true, integration: 'project_goal_control', alreadyKnown: false }));
    response.statusCode = 404; response.end(JSON.stringify({ ok: false }));
  });
  const backendPort = await listen(backend); const runtimePort = await freePort(); let output = '';
  const child = spawn(process.execPath, [runtimePath], { cwd: root, env: { ...process.env, LIA_PRODUCTION_RUNTIME_PORT: String(runtimePort), LIA_HERMES_BACKEND_PORT: String(backendPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${runtimePort}`;
  try {
    await wait(base, child, () => output);
    let response = await fetch(`${base}/api/lia-agent/projects/goals/${GOAL}/continuation`); assert.equal(response.status, 200);
    response = await fetch(`${base}/api/lia-agent/projects/goals/${GOAL}/suspend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 200);
    response = await fetch(`${base}/api/lia-agent/projects/goals/${GOAL}/continuation/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approver: 'other' }) }); assert.equal(response.status, 400);
    response = await fetch(`${base}/api/lia-agent/projects/goals/${GOAL}/execution/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 400);
    response = await fetch(`${base}/api/lia-agent/projects/goals/${GOAL}/suspend`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 405);
    response = await fetch(`${base}/api/lia-agent/projects/goals/${GOAL}/anything`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 404);
    response = await fetch(`${base}/api/lia-agent/projects/office`, { method: 'POST' }); assert.equal(response.status, 405);
    response = await fetch(`${base}/api/lia-agent/projects/${PROJECT}/board-decisions?limit=1`); assert.equal(response.status, 200);
    const boardBody = { requestKey: 'request-1', status: 'approved', summary: 'Operator outcome.', evidence: [] };
    response = await fetch(`${base}/api/lia-agent/projects/${PROJECT}/board-decisions/${DECISION}/outcome-transitions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(boardBody) }); assert.equal(response.status, 200);
    assert.equal((await response.json()).advisoryOnly, true);
    const forwardedBoard = upstream.find((item) => item.url?.includes('outcome-transitions'));
    assert.deepEqual(JSON.parse(forwardedBoard.raw), boardBody);
    response = await fetch(`${base}/api/lia-agent/projects/${PROJECT}/board-decisions/${DECISION}/outcome-transitions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...boardBody, evidence: [{ fake: true }] }) }); assert.equal(response.status, 400);
  } finally {
    child.kill('SIGTERM'); await new Promise((resolveExit) => child.exitCode !== null ? resolveExit() : child.once('exit', resolveExit)); await close(backend);
  }
});

test('Point 9 UI is stage-aware, confirms destructive actions, refreshes, and uses touch targets', async () => {
  const [goal, board, dashboard, css, client] = await Promise.all([
    readFile(join(root, 'frontend/src/components/autonomy-r3/HumanGoalControlPanelR3.tsx'), 'utf8'),
    readFile(join(root, 'frontend/src/components/autonomy-r3/ExecutiveBoardPanelR3.tsx'), 'utf8'),
    readFile(join(root, 'frontend/src/components/dashboard-r3/DashboardCommandCenterR3.tsx'), 'utf8'),
    readFile(join(root, 'frontend/src/styles/projectsExecutiveR3.css'), 'utf8'),
    readFile(join(root, 'frontend/src/integrations/liaHumanControlClient.ts'), 'utf8'),
  ]);
  assert.match(goal, /goal\.loopStage === 'authorization_required'/);
  assert.match(goal, /autonomy\.mode === 'approved_single_step'/);
  assert.match(goal, /authorization\.authorizationId/);
  assert.match(goal, /await refresh\(\)/);
  assert.match(`${goal}\n${board}`, /ConfirmControlDialogR3/);
  assert.match(board, /Decisión ejecutiva ≠ autorización operativa/);
  assert.match(board, /No se tocará ningún Goal/);
  assert.match(dashboard, /Abrir control humano/);
  assert.match(css, /min-height:44px/);
  assert.doesNotMatch(`${goal}\n${board}`, /window\.confirm/);
  assert.doesNotMatch(client, /hermes|codex/i);
  assert.doesNotMatch(client, /requestedCapabilities|evidence/);
});
