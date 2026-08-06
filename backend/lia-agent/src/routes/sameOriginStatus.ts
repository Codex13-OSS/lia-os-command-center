import { Router } from 'express';
import { createControlledSameOriginStatusRead } from '../contracts/sameOriginStatus.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';

export function createSameOriginStatusRouter(): Router {
  const router = Router();

  router.route('/api/lia-agent/health').get((_request, response) => {
    response.status(200).json(createControlledSameOriginStatusRead());
  }).all(methodNotAllowed(['GET']));

  return router;
}
