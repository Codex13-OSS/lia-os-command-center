import { Router } from 'express';
import type { ExecutiveBoardDecisionStore } from '../contracts/executiveBoard.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import type { ProjectGoalControlServiceStore } from '../services/projectGoalControlService.js';
import type { ProjectSupervisorSchedulingRuntime } from '../services/projectSupervisorSchedulingRuntime.js';
import { buildOfficeReadModel } from '../services/officeReadModel.js';

export function createOfficeRouter(dependencies: {
  store?: ProjectGoalControlServiceStore;
  supervisor?: ProjectSupervisorSchedulingRuntime;
  board?: ExecutiveBoardDecisionStore;
  now?: () => number;
}): Router {
  const router = Router();
  router.route('/api/projects/office').get((_request, response) => {
    try {
      response.status(200).json({ ok: true, office: buildOfficeReadModel(dependencies) });
    } catch {
      response.status(503).json({ ok: false, error: 'office_read_model_unavailable' });
    }
  }).all(methodNotAllowed(['GET']));
  return router;
}
