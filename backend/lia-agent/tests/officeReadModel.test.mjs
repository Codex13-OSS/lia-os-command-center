import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { mapTaskToOfficeState, toSafeOfficePlan } from '../dist/services/officeReadModel.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  try { await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const snapshot = (proposal) => ({
  snapshotId: 'snapshot-1', launchResultId: 'launch-result-1', launchAttemptId: 'launch-attempt-1',
  invocationId: 'invocation-1', executionRunId: 'execution-run-1', taskId: 'task-1',
  canonicalProposalJson: JSON.stringify(proposal), proposalSha256: 'a'.repeat(64), canonicalVersion: 'validated-proposal-canonical-v1',
  executionMode: proposal.executionMode, completionMode: 'ready_for_review', requiresHumanApproval: false,
  blockedActions: [], recordedAt: 123,
});

const proposal = (executionMode, steps) => ({
  summary: 'raw model summary must not escape', executionMode, completionMode: 'ready_for_review',
  requiresHumanApproval: false, blockedActions: [], steps,
});
const step = (id, role, dependsOn = []) => ({
  id, title: `Step ${id}`, objective: 'raw objective must not escape', role, dependsOn,
  requiredCapabilities: ['repository_read'],
});

test('durable Goal/task stages map to honest office states, including retry, human wait, failure and terminal', () => {
  assert.equal(mapTaskToOfficeState({ goalStatus: 'active', taskStatus: 'accepted' }), 'queued');
  assert.equal(mapTaskToOfficeState({ goalStatus: 'active', taskStatus: 'planning' }), 'planning');
  assert.equal(mapTaskToOfficeState({ goalStatus: 'active', taskStatus: 'codex' }), 'implementing');
  assert.equal(mapTaskToOfficeState({ goalStatus: 'active', taskStatus: 'verification' }), 'verifying');
  assert.equal(mapTaskToOfficeState({ goalStatus: 'active', taskStatus: 'commit' }), 'reviewing');
  assert.equal(mapTaskToOfficeState({ goalStatus: 'active', taskStatus: 'codex', attemptNumber: 1 }), 'correcting');
  assert.equal(mapTaskToOfficeState({ goalStatus: 'active', taskStatus: 'codex', humanInterventionRequired: true }), 'waiting_human');
  assert.equal(mapTaskToOfficeState({ goalStatus: 'failed', taskStatus: 'failed' }), 'failed');
  assert.equal(mapTaskToOfficeState({ goalStatus: 'completed', taskStatus: 'completed' }), 'completed');
});

test('direct/delegated snapshots expose only safe plan metadata and never claim leaf execution', () => {
  const direct = toSafeOfficePlan(snapshot(proposal('direct', [step('one', 'implementer')])));
  assert.equal(direct.executionMode, 'direct');
  assert.deepEqual(direct.steps.map(({ state }) => state), ['queued']);
  const delegated = toSafeOfficePlan(snapshot(proposal('delegated', [
    step('architecture', 'architect'), step('implementation', 'implementer', ['architecture']),
  ])));
  assert.equal(delegated.executionMode, 'delegated');
  assert.deepEqual(delegated.steps.map(({ state }) => state), ['queued', 'planned']);
  const serialized = JSON.stringify(delegated);
  assert.equal(serialized.includes('raw objective'), false);
  assert.equal(serialized.includes('raw model summary'), false);
  assert.equal(serialized.includes('Step architecture'), false);
  assert.equal(serialized.includes('requiredCapabilities'), false);
  assert.equal(serialized.includes('executing'), false);
});

test('Office endpoint is GET-only, empty-state honest, safe and does not expose capabilities, secrets or paths', async () => {
  const rolesConsulted = ['CEO', 'CTO'];
  const board = {
    listDecisions() { return [{
      decisionId: 'decision-123456789', requestKey: 'request-1', version: 'executive-board-v1', projectId: 'lia-hermes',
      objective: 'private raw board objective', context: ['/internal/path'], level: 'relevant', mode: 'focused', rolesConsulted,
      routingReasons: [], perspectives: [], disagreements: [], risks: [], assumptions: [], missingData: [],
      recommendation: 'raw recommendation', confidence: 0.8, proposedActions: [], requiresHumanApproval: true, evidence: [],
      outcome: { status: 'pending', evidence: [] }, authoritySnapshot: { requested: ['repository_read'], grantedByBoard: [] },
      createdAt: 100, updatedAt: 200,
    }]; },
    readDecision() { return undefined; }, recordDecision() { throw new Error('must_not_write'); },
    transitionOutcome() { throw new Error('must_not_write'); },
  };
  await withServer(createApp(undefined, { executiveBoardStore: board, now: () => 500 }), async (base) => {
    const response = await fetch(`${base}/api/projects/office`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.office.readOnly, true);
    assert.equal(body.office.empty, false, 'a durable Board record makes the office non-empty');
    assert.deepEqual(body.office.board.rolesPresent, rolesConsulted);
    assert.deepEqual(body.office.board.decisions[0].rolesConsulted, rolesConsulted);
    assert.equal(body.office.telemetry.leafEventsAvailable, false);
    const text = JSON.stringify(body);
    for (const forbidden of ['authoritySnapshot', 'requestedCapabilities', 'capabilities', 'secret', '/internal/path', 'raw recommendation', 'raw board objective', 'command', 'prompt']) {
      assert.equal(text.includes(forbidden), false, `must not leak ${forbidden}`);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const denied = await fetch(`${base}/api/projects/office`, { method });
      assert.equal(denied.status, 405);
    }
    assert.throws(() => board.recordDecision(), /must_not_write/);
  });
});

test('Office frontend has no synthetic progress or work timers and documents the leaf gap', async () => {
  const source = await readFile(new URL('../../../frontend/src/components/office-r3/OfficeShellR3.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes('setTimeout'), false);
  assert.equal(source.includes('Math.random'), false);
  assert.equal(source.includes('progress'), false);
  assert.match(source, /No hay metadata durable de plan/);
  assert.match(source, /no prueba ejecución leaf/);
});
