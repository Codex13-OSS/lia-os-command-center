import { Router } from 'express';
import type { ExecutiveBoardDecisionStore } from '../contracts/executiveBoard.js';
import { DECISION_LEARNING_INTEGRATION } from '../contracts/decisionLearning.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import { buildDecisionLearningReadModel, type DecisionLearningGoalSource } from '../services/decisionLearningReadModel.js';

const VALID_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

export function createDecisionLearningRouter(sources: {
  board?: ExecutiveBoardDecisionStore;
  goals?: DecisionLearningGoalSource;
}): Router {
  const router = Router();
  router.route('/api/projects/:projectId/board-learning').get((request, response) => {
    const projectId = request.params.projectId;
    const rawLimit = typeof request.query.limit === 'string' ? Number(request.query.limit) : 20;
    if (!VALID_SEGMENT.test(projectId) || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50
      || Object.keys(request.query).some((key) => key !== 'limit')) {
      response.status(400).json({ ok: false, integration: DECISION_LEARNING_INTEGRATION, error: 'invalid_decision_learning_query' });
      return;
    }
    response.status(200).json({
      ok: true,
      ...buildDecisionLearningReadModel(sources, { projectId, limit: rawLimit }),
    });
  }).all(methodNotAllowed(['GET']));
  return router;
}
