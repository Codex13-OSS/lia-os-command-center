import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { buildDecisionLearningReadModel } from '../dist/services/decisionLearningReadModel.js';

const goalId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const decision = (n, outcome, confidence = 0.8, overrides = {}) => ({
  decisionId: `decision-${n}`, requestKey: `request-${n}`, version: 'executive-board-v1', projectId: 'lia-hermes', goalId: goalId(n),
  objective: `Objetivo ${n}`, context: [], level: 'normal', mode: 'focused', rolesConsulted: ['CEO', 'CTO'], routingReasons: [], perspectives: [],
  disagreements: [], risks: [], assumptions: [], missingData: [], recommendation: `Recomendación ${n}`, confidence, proposedActions: [],
  requiresHumanApproval: false, evidence: [], outcome: { status: outcome, evidence: [] }, authoritySnapshot: { requested: [], grantedByBoard: [] },
  createdAt: n, updatedAt: n, ...overrides,
});
const goal = (n, status, terminalReason) => ({
  goalId: goalId(n), projectId: 'lia-hermes', objective: `Objetivo ${n}`, status, createdAt: n, updatedAt: n,
  currentAttempt: 0, maxAttempts: 3, continuationDepthLimit: 2,
  ...(status === 'active' ? {} : { terminalAt: n + 100, terminalReason }),
});
const evaluation = (n, decisionValue, reasonCode, applied = true) => ({
  evaluationId: `evaluation-${n}`, goalId: goalId(n), taskId: `task-${n}`, attemptNumber: 0,
  evaluatorVersion: 'completion-evaluator-v1', evidenceFingerprint: 'a'.repeat(64), decision: decisionValue, reasonCode,
  summary: 'Resumen seguro', createdAt: n + 10, ...(applied ? { appliedAt: n + 20 } : {}),
});
const attempt = (n) => ({ taskId: `task-${n}`, fingerprint: 'b'.repeat(64), intent: { projectId: 'lia-hermes', instruction: 'x', priority: 'normal', requestedCapabilities: [] }, status: 'completed', createdAt: n, updatedAt: n, lineage: { goalId: goalId(n), continuationDepth: 0, attemptNumber: 0 } });

function sources(decisions, goals, evaluations = new Map()) {
  const calls = { boardLists: 0, goalReads: 0, attempts: 0, evaluations: 0, writes: 0 };
  return {
    calls,
    value: {
      board: {
        recordDecision() { calls.writes += 1; throw new Error('write_called'); }, readDecision() { return undefined; },
        listDecisions() { calls.boardLists += 1; return decisions; }, transitionOutcome() { calls.writes += 1; throw new Error('write_called'); },
      },
      goals: {
        readGoal(id) { calls.goalReads += 1; return goals.get(id); },
        listGoalAttempts(id) { calls.attempts += 1; return goals.has(id) ? [attempt(Number(id.slice(-1)))] : []; },
        listGoalEvaluations(id) { calls.evaluations += 1; return evaluations.get(id) ?? []; },
      },
    },
  };
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('Decision Learning V1 conservatively derives real outcomes without mutating either source', () => {
  const decisions = [
    decision(1, 'executed', 0.8), decision(2, 'executed', 0.8, { requiresHumanApproval: true }), decision(3, 'rejected', 0.3),
    decision(4, 'approved', 0.6), decision(5, 'executed', 0.7), decision(6, 'executed', 0.8), decision(7, 'pending', 0.8),
  ];
  const goals = new Map([
    [goalId(1), goal(1, 'completed', 'objective_completed')],
    [goalId(2), goal(2, 'failed', 'unrecoverable_failure')],
    [goalId(3), goal(3, 'completed', 'objective_completed')],
    [goalId(4), goal(4, 'completed', 'objective_completed')],
    [goalId(5), goal(5, 'active')],
    [goalId(6), goal(6, 'completed', 'objective_completed')],
    [goalId(7), goal(7, 'active')],
  ]);
  const evaluations = new Map([
    [goalId(1), [evaluation(1, 'completed', 'goal_satisfied')]],
    [goalId(2), [evaluation(2, 'failed', 'execution_failed')]],
    [goalId(3), [evaluation(3, 'completed', 'goal_satisfied')]],
    [goalId(4), [evaluation(4, 'completed', 'goal_satisfied')]],
    [goalId(5), []],
    [goalId(6), [evaluation(6, 'completed', 'goal_satisfied', false)]],
  ]);
  const fixture = sources(decisions, goals, evaluations);
  const model = buildDecisionLearningReadModel(fixture.value, { projectId: 'lia-hermes' });
  const result = Object.fromEntries(model.cases.map((item) => [item.decisionId, item]));
  assert.equal(result['decision-1'].observedResult, 'successful');
  assert.equal(result['decision-2'].observedResult, 'unsuccessful');
  assert.equal(result['decision-3'].observedResult, 'not_executed');
  assert.equal(result['decision-4'].observedResult, 'inconclusive', 'approved must not mean executed');
  assert.equal(result['decision-5'].observedResult, 'still_running');
  assert.equal(result['decision-6'].observedResult, 'inconclusive', 'unapplied evaluation is insufficient');
  assert.equal(result['decision-7'].learningStatus, 'pending');
  assert.equal(model.metrics.evaluableDecisions, 2);
  assert.equal(model.metrics.observedSuccessRate, undefined, 'low sample must not expose a percentage');
  assert.equal(model.calibrationObservation.every((bucket) => bucket.observedOutcomeRate === undefined), true);
  assert.equal(model.signals.some((signal) => signal.type === 'insufficient_sample'), true);
  assert.equal(model.signals.some((signal) => signal.type === 'high_confidence_unsuccessful'), true);
  assert.equal(model.signals.some((signal) => signal.type === 'human_approval_required'), true);
  assert.equal(fixture.calls.writes, 0);
  assert.deepEqual(model.roleParticipationObservations[0], { role: 'CEO', decisionsConsulted: 7, executedAndEvaluable: 2, observedSuccessful: 1, observedUnsuccessful: 1 });
  assert.equal(Object.hasOwn(model.roleParticipationObservations[0], 'ranking'), false);
  assert.equal(Object.hasOwn(model.roleParticipationObservations[0], 'performanceScore'), false);
  assert.equal(model.causalInference, false);
  assert.equal(Object.hasOwn(model, 'capabilities'), false);
  assert.equal(Object.hasOwn(model, 'authority'), false);
});

test('confidence buckets, denominator zero, and deterministic signals remain honest', () => {
  const empty = buildDecisionLearningReadModel({}, { projectId: 'lia-hermes' });
  assert.equal(empty.metrics.totalDecisions, 0);
  assert.equal(empty.metrics.observedSuccessRate, undefined);
  assert.deepEqual(empty.calibrationObservation.map((item) => [item.bucket, item.evaluable, item.observedOutcomeRate]), [['low', 0, undefined], ['medium', 0, undefined], ['high', 0, undefined]]);

  const decisions = [
    decision(1, 'executed', 0.39, { missingData: ['baseline'], disagreements: [{ disagreementId: 'd1', roles: ['CEO', 'CTO'], issue: 'scope', positions: [], resolution: 'unresolved' }] }),
    decision(2, 'executed', 0.4, { missingData: ['budget'] }), decision(3, 'executed', 0.7),
  ];
  const goals = new Map(decisions.map((_, index) => [goalId(index + 1), goal(index + 1, 'completed', 'objective_completed')]));
  const evaluations = new Map(decisions.map((_, index) => [goalId(index + 1), [evaluation(index + 1, 'completed', 'goal_satisfied')]]));
  const model = buildDecisionLearningReadModel(sources(decisions, goals, evaluations).value, { projectId: 'lia-hermes' });
  assert.deepEqual(model.calibrationObservation.map((item) => [item.bucket, item.evaluable]), [['low', 1], ['medium', 1], ['high', 1]]);
  assert.equal(model.signals.some((item) => item.type === 'low_confidence_successful'), true);
  assert.equal(model.signals.filter((item) => item.type === 'repeated_missing_data').length, 2);
  assert.equal(model.signals.some((item) => item.type === 'disagreement_present'), true);

  const calibratedDecisions = Array.from({ length: 5 }, (_, index) => decision(index + 1, 'executed', 0.75));
  const calibratedGoals = new Map(calibratedDecisions.map((_, index) => [goalId(index + 1), goal(index + 1, 'completed', 'objective_completed')]));
  const calibratedEvaluations = new Map(calibratedDecisions.map((_, index) => [goalId(index + 1), [evaluation(index + 1, 'completed', 'goal_satisfied')]]));
  const calibrated = buildDecisionLearningReadModel(sources(calibratedDecisions, calibratedGoals, calibratedEvaluations).value, { projectId: 'lia-hermes' });
  assert.equal(calibrated.metrics.observedSuccessRate, 1);
  assert.deepEqual(calibrated.calibrationObservation.find((item) => item.bucket === 'high'), { bucket: 'high', evaluable: 5, observedSuccesses: 5, sufficientSample: true, observedOutcomeRate: 1 });
});

test('board-learning API is GET-only and explicitly read-only/non-causal', async () => {
  const decisions = [decision(1, 'executed')];
  const goals = new Map([[goalId(1), goal(1, 'completed', 'objective_completed')]]);
  const evaluations = new Map([[goalId(1), [evaluation(1, 'completed', 'goal_satisfied')]]]);
  const fixture = sources(decisions, goals, evaluations);
  const taskStore = { ...fixture.value.goals, createOrGet() { throw new Error('not_used'); }, get() {}, transition() {}, complete() {}, fail() {} };
  await withServer(createApp(loadConfig({}), { executiveBoardStore: fixture.value.board, projectTaskStore: taskStore }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/lia-hermes/board-learning?limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.integration, 'lia_decision_learning_v1');
    assert.equal(body.readOnly, true);
    assert.equal(body.causalInference, false);
    const post = await fetch(`${baseUrl}/api/projects/lia-hermes/board-learning`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
  });
  assert.equal(fixture.calls.writes, 0);
});

test('same-origin learning surface and frontend remain GET-only with no Hermes/Codex calls', async () => {
  const runtime = await readFile(new URL('../../../scripts/lia-production-same-origin-runtime-server.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /board-learning/);
  assert.match(runtime, /request\.method !== 'GET'/);
  assert.match(runtime, /lia_decision_learning_v1/);
  const client = await readFile(new URL('../../../frontend/src/integrations/liaDecisionLearningClient.ts', import.meta.url), 'utf8');
  assert.match(client, /method: 'GET'/);
  assert.doesNotMatch(client, /Hermes|Codex|\/query|method: 'POST'/i);
});
