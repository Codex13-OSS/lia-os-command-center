import { Router } from 'express';
import { createStatusSnapshot } from '../contracts/status.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';

export function createStatusRouter(): Router {
  const router = Router();

  router.route('/api/status').get((_request, response) => {
    response.status(200).json(createStatusSnapshot());
  }).all(methodNotAllowed(['GET']));

  return router;
}
