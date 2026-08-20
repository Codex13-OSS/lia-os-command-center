import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { routeExecutiveBoardDecision } from '../dist/services/executiveBoardRouter.js';
import { createExecutiveBoardOrchestrator } from '../dist/services/executiveBoardOrchestrator.js';
import { ExecutiveBoardSqliteStore } from '../dist/services/executiveBoardSqliteStore.js';

const request = (overrides = {}) => ({
  requestKey: 'board-request-1',
  projectId: 'lia-project',
  objective: 'Definir arquitectura de software y presupuesto del proyecto',
  level: 'normal',
  requestedCapabilities: ['repository_read'],
  ...overrides,
});

const perspective = (role) => ({
  role,
  status: 'completed',
  position: role === 'CEO' ? 'Avanzar con un piloto acotado.' : `Perspectiva ${role}`,
  rationale: [`Razón ${role}`],
  risks: role === 'LEGAL' ? ['Revisión contractual pendiente'] : [],
  assumptions: ['Demanda estable'],
  missingData: role === 'DATA' ? ['Métrica base'] : [],
  proposedActions: [`Revisar con ${role}`],
  evidence: [],
  confidence: 0.8,
});

function makeIds() {
  let id = 0;
  return () => `board-id-${++id}`;
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('router deterministically selects 1-2 normal, up to 3 relevant, and applicable BOARD MODE roles', () => {
  const normal = routeExecutiveBoardDecision(request());
  assert.equal(normal.mode, 'focused');
  assert.deepEqual(normal.roles, ['CEO', 'CFO']);

  const relevant = routeExecutiveBoardDecision(request({ level: 'relevant' }));
  assert.equal(relevant.roles.length, 3);
  assert.deepEqual(relevant.roles, ['CEO', 'CFO', 'CTO']);

  const critical = routeExecutiveBoardDecision(request({
    objective: 'Evaluar campaña de marketing y operación del proveedor',
    level: 'critical',
  }));
  assert.equal(critical.mode, 'board');
  assert.deepEqual(critical.roles, ['CEO', 'COO', 'CMO', 'LEGAL', 'DATA']);
  assert.equal(critical.reasons.every(({ reason }) => reason.length > 0), true);
  assert.equal(critical.roles.includes('CFO'), false, 'BOARD MODE still selects only applicable specialists');
});

test('orchestrator consults only routed roles, preserves dissent, human gate, and grants zero capabilities', async () => {
  const recorded = [];
  const consulted = [];
  const orchestrator = createExecutiveBoardOrchestrator({
    specialists: {
      async consult(input) {
        consulted.push(input.role);
        return perspective(input.role);
      },
    },
    store: {
      recordDecision({ decision }) { recorded.push(decision); return decision; },
      readDecision() { return undefined; },
      listDecisions() { return recorded; },
      transitionOutcome() { throw new Error('not_used'); },
    },
    now: () => 1_000,
    createId: makeIds(),
  });

  const decision = await orchestrator.decide(request());
  assert.deepEqual(consulted, ['CEO', 'CFO']);
  assert.deepEqual(decision.rolesConsulted, consulted);
  assert.equal(decision.perspectives.length, 2);
  assert.equal(decision.disagreements.length, 1);
  assert.deepEqual(decision.disagreements[0].positions, [
    { role: 'CEO', position: 'Avanzar con un piloto acotado.' },
    { role: 'CFO', position: 'Perspectiva CFO' },
  ]);
  assert.equal(decision.disagreements[0].resolution, 'unresolved');
  assert.equal(decision.requiresHumanApproval, true);
  assert.deepEqual(decision.authoritySnapshot, { requested: ['repository_read'], grantedByBoard: [] });
  assert.equal(decision.outcome.status, 'pending');
  assert.equal(recorded.length, 1);
});

test('request key is durable and idempotent while distinct requests create distinct immutable snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-board-'));
  const databasePath = join(directory, 'board.sqlite');
  try {
    let store = new ExecutiveBoardSqliteStore(databasePath);
    const orchestrator = createExecutiveBoardOrchestrator({
      specialists: { async consult({ role }) { return perspective(role); } },
      store,
      now: () => 2_000,
      createId: makeIds(),
    });
    const decision = await orchestrator.decide(request({ level: 'critical', goalId: 'goal-1' }));
    const replay = await orchestrator.decide(request({ level: 'critical', goalId: 'goal-1' }));
    assert.equal(replay.decisionId, decision.decisionId);
    assert.deepEqual(replay, decision);
    const distinct = await orchestrator.decide(request({
      requestKey: 'board-request-2',
      level: 'critical',
      goalId: 'goal-1',
    }));
    assert.notEqual(distinct.decisionId, decision.decisionId);
    const peerStore = new ExecutiveBoardSqliteStore(databasePath);
    let firstId = 0;
    let secondId = 0;
    const concurrentRequest = request({ requestKey: 'board-request-concurrent' });
    const firstConcurrent = createExecutiveBoardOrchestrator({
      specialists: { async consult({ role }) { return perspective(role); } },
      store,
      createId: () => `first-${++firstId}`,
    });
    const secondConcurrent = createExecutiveBoardOrchestrator({
      specialists: { async consult({ role }) { return perspective(role); } },
      store: peerStore,
      createId: () => `second-${++secondId}`,
    });
    const [firstResult, secondResult] = await Promise.all([
      firstConcurrent.decide(concurrentRequest),
      secondConcurrent.decide(concurrentRequest),
    ]);
    assert.equal(firstResult.decisionId, secondResult.decisionId);
    peerStore.close();
    assert.equal(decision.mode, 'board');
    assert.deepEqual(decision.authoritySnapshot.grantedByBoard, []);
    store.close();

    store = new ExecutiveBoardSqliteStore(databasePath);
    const restored = store.readDecision(decision.decisionId);
    assert.deepEqual(restored, decision);
    assert.equal(store.listDecisions({ projectId: 'lia-project', goalId: 'goal-1' }).length, 2);
    const reopenedOrchestrator = createExecutiveBoardOrchestrator({
      specialists: { async consult({ role }) { return perspective(role); } },
      store,
      now: () => 9_000,
      createId: makeIds(),
    });
    assert.equal(
      (await reopenedOrchestrator.decide(request({ level: 'critical', goalId: 'goal-1' }))).decisionId,
      decision.decisionId,
    );
    await assert.rejects(
      reopenedOrchestrator.decide(request({ objective: 'Otro payload con la misma key' })),
      /executive_board_request_key_conflict/,
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('outcome transitions are append-only, valid, idempotent, contradictory-safe, and preserve decision_json', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-board-outcome-'));
  const databasePath = join(directory, 'board.sqlite');
  try {
    const store = new ExecutiveBoardSqliteStore(databasePath);
    const orchestrator = createExecutiveBoardOrchestrator({
      specialists: { async consult({ role }) { return perspective(role); } },
      store,
      now: () => 3_000,
      createId: makeIds(),
    });
    const decision = await orchestrator.decide(request());
    const inspector = new DatabaseSync(databasePath, { readOnly: true });
    const before = inspector.prepare(
      'SELECT decision_json FROM executive_board_decisions WHERE decision_id = ?',
    ).get(decision.decisionId).decision_json;
    inspector.close();

    const evidence = [{
      evidenceId: 'approval-1',
      kind: 'document',
      reference: 'operator://approval/1',
      summary: 'Aprobación humana registrada.',
    }];
    const transition = {
      requestKey: 'outcome-request-1',
      decisionId: decision.decisionId,
      status: 'approved',
      summary: 'Piloto aprobado.',
      recordedAt: 4_000,
      evidence,
    };
    const approved = store.transitionOutcome(transition);
    assert.deepEqual(approved.outcome, {
      status: 'approved',
      summary: 'Piloto aprobado.',
      recordedAt: 4_000,
      evidence,
    });
    assert.deepEqual(store.transitionOutcome({ ...transition, recordedAt: 9_999 }), approved);
    assert.throws(() => store.transitionOutcome({
      ...transition,
      requestKey: 'outcome-request-2',
      status: 'rejected',
    }), /illegal_executive_board_outcome_transition/);
    assert.throws(() => store.transitionOutcome({
      ...transition,
      summary: 'Payload contradictorio para la misma key.',
    }), /executive_board_outcome_request_key_conflict/);

    const verifier = new DatabaseSync(databasePath);
    const after = verifier.prepare(
      'SELECT decision_json FROM executive_board_decisions WHERE decision_id = ?',
    ).get(decision.decisionId).decision_json;
    assert.equal(after, before, 'outcome must never rewrite the historical decision snapshot');
    assert.equal(JSON.parse(after).outcome.status, 'pending');
    assert.throws(() => verifier.prepare(
      'UPDATE executive_board_decisions SET updated_at = updated_at + 1 WHERE decision_id = ?',
    ).run(decision.decisionId), /executive_board_decision_immutable/);
    assert.throws(() => verifier.prepare(
      'UPDATE executive_board_outcome_transitions SET summary = ? WHERE decision_id = ?',
    ).run('mutated', decision.decisionId), /executive_board_outcome_immutable/);
    verifier.close();
    store.close();

    const reopened = new ExecutiveBoardSqliteStore(databasePath);
    assert.deepEqual(reopened.readDecision(decision.decisionId)?.outcome, approved.outcome);
    assert.deepEqual(reopened.readDecision(decision.decisionId)?.authoritySnapshot.grantedByBoard, []);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('outcome API performs the minimal safe mutation while existing GET routes remain available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-board-api-'));
  const databasePath = join(directory, 'board.sqlite');
  const store = new ExecutiveBoardSqliteStore(databasePath);
  try {
    const orchestrator = createExecutiveBoardOrchestrator({
      specialists: { async consult({ role }) { return perspective(role); } },
      store,
      now: () => 5_000,
      createId: makeIds(),
    });
    const decision = await orchestrator.decide(request());
    await withServer(createApp(loadConfig({}), { executiveBoardStore: store, now: () => 6_000 }), async (baseUrl) => {
      const list = await fetch(`${baseUrl}/api/projects/lia-project/board-decisions`);
      assert.equal(list.status, 200);
      assert.equal((await list.json()).decisions[0].decisionId, decision.decisionId);
      const detail = await fetch(`${baseUrl}/api/projects/lia-project/board-decisions/${decision.decisionId}`);
      assert.equal(detail.status, 200);

      const transitionUrl = `${baseUrl}/api/projects/lia-project/board-decisions/${decision.decisionId}/outcome-transitions`;
      const body = { requestKey: 'api-outcome-1', status: 'approved', summary: 'Aprobado por operador.', evidence: [] };
      const transitioned = await fetch(transitionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(transitioned.status, 200);
      assert.equal((await transitioned.json()).decision.outcome.status, 'approved');
      const replay = await fetch(transitionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(replay.status, 200);
      const contradiction = await fetch(transitionUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestKey: 'api-outcome-2', status: 'rejected', evidence: [] }),
      });
      assert.equal(contradiction.status, 409);
      const boardCreation = await fetch(`${baseUrl}/api/projects/lia-project/board-decisions`, { method: 'POST' });
      assert.equal(boardCreation.status, 405, 'Board creation must remain unavailable over HTTP');
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP surface keeps GET and returns an honest empty state without a configured store', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/lia-project/board-decisions`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      integration: 'lia_executive_board_v1',
      durable: false,
      advisoryOnly: true,
      decisions: [],
    });
    const post = await fetch(`${baseUrl}/api/projects/lia-project/board-decisions`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
  });
});
