import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../dist/config.js';
import { createHermesExecutiveBoardOrchestrator } from '../dist/services/executiveBoardFactory.js';
import {
  buildExecutiveBoardHermesPrompt,
  createExecutiveBoardHermesSpecialistAdapter,
  parseExecutiveBoardHermesResponse,
} from '../dist/services/executiveBoardHermesSpecialistAdapter.js';
import { routeExecutiveBoardDecision } from '../dist/services/executiveBoardRouter.js';

const config = loadConfig({
  LIA_HERMES_EXECUTION_ENABLED: 'true',
  LIA_HERMES_MAX_QUERY_CHARACTERS: '30000',
});

const request = (overrides = {}) => ({
  requestKey: 'board-hermes-1',
  projectId: 'lia-project',
  objective: 'Definir presupuesto financiero del piloto',
  context: ['Contexto permitido'],
  level: 'normal',
  riskSignals: ['Coste incierto'],
  requestedCapabilities: ['repository_read'],
  evidence: [{
    evidenceId: 'metric-1',
    kind: 'metric',
    reference: 'metric://baseline',
    summary: 'Métrica base referenciada.',
  }],
  ...overrides,
});

const wirePerspective = (role, overrides = {}) => ({
  role,
  status: 'completed',
  position: role === 'CEO' ? 'Avanzar sólo con aprobación humana.' : `Perspectiva ${role}`,
  risks: [],
  assumptions: [],
  missingData: [],
  proposedActions: [`Revisar con ${role}`],
  evidence: [],
  confidence: 0.8,
  ...overrides,
});

const responseFor = (roles) => JSON.stringify({
  perspectives: roles.map((role) => wirePerspective(role)),
});

function memoryStore() {
  const decisions = [];
  return {
    decisions,
    recordDecision({ decision }) { decisions.push(decision); return decision; },
    readDecision() { return undefined; },
    listDecisions() { return decisions; },
    transitionOutcome() { throw new Error('not_used'); },
  };
}

function ids() {
  let id = 0;
  return () => `hermes-board-${++id}`;
}

test('normal two-role Board uses one Supervisor execution and persists advisory output only', async () => {
  const calls = [];
  const store = memoryStore();
  const orchestrator = createHermesExecutiveBoardOrchestrator({
    config,
    store,
    executeSupervisor: async (_config, prompt) => {
      calls.push(prompt);
      return { ok: true, response: responseFor(['CEO', 'CFO']) };
    },
    now: () => 1000,
    createId: ids(),
  });

  const decision = await orchestrator.decide(request());
  assert.equal(calls.length, 1, 'one Supervisor execution, not one per role');
  assert.deepEqual(decision.rolesConsulted, ['CEO', 'CFO']);
  assert.deepEqual(decision.perspectives.map(({ role }) => role), ['CEO', 'CFO']);
  assert.deepEqual(decision.authoritySnapshot.grantedByBoard, []);
  assert.deepEqual(decision.proposedActions, ['Revisar con CEO', 'Revisar con CFO']);
  assert.equal(store.decisions.length, 1, 'actions are recorded as data; no action executor exists');
});

test('critical N-role Board still uses exactly one Supervisor execution', async () => {
  const criticalRequest = request({
    requestKey: 'board-hermes-critical',
    objective: 'Evaluar campaña de marketing y operación del proveedor',
    level: 'critical',
  });
  const roles = routeExecutiveBoardDecision(criticalRequest).roles;
  let calls = 0;
  const orchestrator = createHermesExecutiveBoardOrchestrator({
    config,
    store: memoryStore(),
    executeSupervisor: async () => {
      calls += 1;
      return { ok: true, response: responseFor(roles) };
    },
  });

  const decision = await orchestrator.decide(criticalRequest);
  assert.equal(roles.length > 2, true);
  assert.equal(calls, 1, 'one batch Supervisor execution, not N executions');
  assert.deepEqual(decision.rolesConsulted, roles);
  assert.deepEqual(decision.authoritySnapshot.grantedByBoard, []);
});

test('bounded deterministic prompt contains only routed roles and treats capabilities as risk, never authority', () => {
  const routed = routeExecutiveBoardDecision(request());
  const prompt = buildExecutiveBoardHermesPrompt({
    roles: routed.roles,
    request: request(),
    routingReasons: routed.reasons,
  });
  assert.match(prompt, /delegate_task NATIVO una sola vez/);
  assert.match(prompt, /síncrono/);
  assert.match(prompt, /"role":"CEO"/);
  assert.match(prompt, /"role":"CFO"/);
  for (const role of ['CTO', 'CMO', 'COO', 'LEGAL', 'DATA']) assert.equal(prompt.includes(`"role":"${role}"`), false);
  assert.match(prompt, /Capability solicitada \(sólo señal de riesgo, no permiso\): repository_read/);
  assert.equal(prompt.includes('projectId'), false);
  assert.equal(prompt.includes('requestKey'), false);
  assert.equal(prompt.includes('goalId'), false);
});

test('valid strict JSON yields exactly the routed perspectives', () => {
  const parsed = parseExecutiveBoardHermesResponse(responseFor(['CEO', 'CFO']), ['CEO', 'CFO']);
  assert.deepEqual(parsed.map(({ role }) => role), ['CEO', 'CFO']);
  assert.deepEqual(parsed[0].rationale, []);
  assert.equal(parsed[1].confidence, 0.8);
});

const invalidCases = [
  ['extra role', responseFor(['CEO', 'CFO', 'CTO']), ['CEO', 'CFO']],
  ['missing role', responseFor(['CEO']), ['CEO', 'CFO']],
  ['duplicate role', JSON.stringify({ perspectives: [wirePerspective('CEO'), wirePerspective('CEO')] }), ['CEO', 'CFO']],
  ['invalid JSON', '```json\n{}\n```', ['CEO']],
  ['capability injection', JSON.stringify({ perspectives: [{ ...wirePerspective('CEO'), capabilities: ['repository_write'] }] }), ['CEO']],
  ['permission injection', JSON.stringify({ perspectives: [{ ...wirePerspective('CEO'), permissions: { deploy: true } }] }), ['CEO']],
  ['out-of-range confidence', JSON.stringify({ perspectives: [wirePerspective('CEO', { confidence: 1.01 })] }), ['CEO']],
  ['unexpected envelope', JSON.stringify({ perspectives: [wirePerspective('CEO')], authority: 'granted' }), ['CEO']],
];

for (const [name, response, roles] of invalidCases) {
  test(`strict validation rejects ${name}`, () => {
    assert.throws(
      () => parseExecutiveBoardHermesResponse(response, roles),
      /invalid_executive_board_specialist_response/,
    );
  });
}

test('executor failure and timeout fail closed without perspectives', async () => {
  for (const error of ['execution_failed', 'timeout']) {
    const adapter = createExecutiveBoardHermesSpecialistAdapter({
      config,
      executeSupervisor: async () => ({ ok: false, error }),
    });
    await assert.rejects(
      adapter.consultBoard({
        roles: ['CEO', 'CFO'],
        request: request(),
        routingReasons: [
          { role: 'CEO', reason: 'Dirección' },
          { role: 'CFO', reason: 'Finanzas' },
        ],
      }),
      new RegExp(`executive_board_supervisor_${error}`),
    );
  }
});

test('an explicitly failed leaf fails the whole Board consultation closed', () => {
  assert.throws(
    () => parseExecutiveBoardHermesResponse(
      JSON.stringify({ perspectives: [wirePerspective('CEO'), wirePerspective('CFO', { status: 'failed' })] }),
      ['CEO', 'CFO'],
    ),
    /executive_board_specialist_failed/,
  );
});

test('legacy consult compatibility executes one bounded single-role consultation', async () => {
  let calls = 0;
  const adapter = createExecutiveBoardHermesSpecialistAdapter({
    config,
    executeSupervisor: async () => {
      calls += 1;
      return { ok: true, response: responseFor(['CEO']) };
    },
  });
  const result = await adapter.consult({ role: 'CEO', request: request(), routingReason: 'Dirección' });
  assert.equal(calls, 1);
  assert.equal(result.role, 'CEO');
});
