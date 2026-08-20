import { Router } from 'express';
import type {
  ExecutiveBoardDecisionStore,
  ExecutiveBoardEvidence,
  ExecutiveBoardTerminalOutcomeStatus,
} from '../contracts/executiveBoard.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';

const VALID_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const OUTCOME_STATUSES = new Set<ExecutiveBoardTerminalOutcomeStatus>([
  'approved',
  'rejected',
  'executed',
  'superseded',
]);
const EVIDENCE_KINDS = new Set([
  'goal',
  'task',
  'verification',
  'document',
  'metric',
  'specialist_output',
]);

function isEvidence(value: unknown): value is ExecutiveBoardEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.evidenceId === 'string' && VALID_SEGMENT.test(item.evidenceId)
    && typeof item.kind === 'string' && EVIDENCE_KINDS.has(item.kind)
    && typeof item.reference === 'string' && item.reference.length > 0 && item.reference.length <= 2_000
    && typeof item.summary === 'string' && item.summary.length <= 20_000;
}

export function createExecutiveBoardRouter(store?: ExecutiveBoardDecisionStore, now: () => number = Date.now): Router {
  const router = Router();

  router.route('/api/projects/:projectId/board-decisions').get((request, response) => {
    const projectId = request.params.projectId;
    const goalId = typeof request.query.goalId === 'string' ? request.query.goalId : undefined;
    const rawLimit = typeof request.query.limit === 'string' ? Number(request.query.limit) : 20;
    if (!VALID_SEGMENT.test(projectId) || (goalId !== undefined && !VALID_SEGMENT.test(goalId)) || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      response.status(400).json({ ok: false, error: 'invalid_executive_board_query' });
      return;
    }
    const decisions = store?.listDecisions({ projectId, ...(goalId ? { goalId } : {}), limit: rawLimit }) ?? [];
    response.status(200).json({
      ok: true,
      integration: 'lia_executive_board_v1',
      durable: store !== undefined,
      advisoryOnly: true,
      decisions,
    });
  }).all(methodNotAllowed(['GET']));

  router.route('/api/projects/:projectId/board-decisions/:decisionId').get((request, response) => {
    const { projectId, decisionId } = request.params;
    if (!VALID_SEGMENT.test(projectId) || !VALID_SEGMENT.test(decisionId)) {
      response.status(400).json({ ok: false, error: 'invalid_executive_board_query' });
      return;
    }
    const decision = store?.readDecision(decisionId);
    if (!decision || decision.projectId !== projectId) {
      response.status(404).json({ ok: false, error: 'executive_board_decision_not_found' });
      return;
    }
    response.status(200).json({ ok: true, integration: 'lia_executive_board_v1', decision });
  }).all(methodNotAllowed(['GET']));

  router.route('/api/projects/:projectId/board-decisions/:decisionId/outcome-transitions').post((request, response) => {
    const { projectId, decisionId } = request.params;
    const body = (typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
      ? request.body
      : {}) as Record<string, unknown>;
    const evidence = body.evidence ?? [];
    if (!VALID_SEGMENT.test(projectId) || !VALID_SEGMENT.test(decisionId)
      || typeof body.requestKey !== 'string' || !VALID_SEGMENT.test(body.requestKey)
      || typeof body.status !== 'string' || !OUTCOME_STATUSES.has(body.status as ExecutiveBoardTerminalOutcomeStatus)
      || (body.summary !== undefined && (typeof body.summary !== 'string' || body.summary.length > 20_000))
      || !Array.isArray(evidence) || !evidence.every(isEvidence)) {
      response.status(400).json({ ok: false, error: 'invalid_executive_board_outcome_transition' });
      return;
    }
    if (!store) {
      response.status(503).json({ ok: false, error: 'executive_board_store_unavailable' });
      return;
    }
    const existing = store.readDecision(decisionId);
    if (!existing || existing.projectId !== projectId) {
      response.status(404).json({ ok: false, error: 'executive_board_decision_not_found' });
      return;
    }
    try {
      const decision = store.transitionOutcome({
        requestKey: body.requestKey,
        decisionId,
        status: body.status as ExecutiveBoardTerminalOutcomeStatus,
        ...(typeof body.summary === 'string' && body.summary !== '' ? { summary: body.summary } : {}),
        recordedAt: now(),
        evidence,
      });
      response.status(200).json({
        ok: true,
        integration: 'lia_executive_board_v1',
        advisoryOnly: true,
        decision,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'unknown_error';
      if (code === 'illegal_executive_board_outcome_transition'
        || code === 'executive_board_outcome_request_key_conflict') {
        response.status(409).json({ ok: false, error: code });
        return;
      }
      if (code === 'executive_board_decision_not_found') {
        response.status(404).json({ ok: false, error: code });
        return;
      }
      throw error;
    }
  }).all(methodNotAllowed(['POST']));

  return router;
}
