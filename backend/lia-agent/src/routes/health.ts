import { Router } from 'express';
import { createHealthSnapshot } from '../contracts/health.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';

export function createHealthRouter(): Router {
  const router = Router();

  router.route('/health').get((_request, response) => {
    response.status(200).json(createHealthSnapshot());
  }).all(methodNotAllowed(['GET']));

  return router;
}
