import { Router } from 'express';
import type { LiaAgentConfig } from '../config.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import { executeHermesQuery } from '../services/hermesExecutor.js';

type HermesQueryBody = {
  query?: unknown;
};

export function createHermesQueryRouter(config: LiaAgentConfig): Router {
  const router = Router();

  router.route('/api/hermes/query').post(async (request, response) => {
    const body = request.body as HermesQueryBody;
    const query = typeof body?.query === 'string' ? body.query.trim() : '';

    if (query.length === 0 || query.length > config.hermesMaxQueryCharacters) {
      response.status(400).json({
        ok: false,
        error: 'invalid_query',
        maxCharacters: config.hermesMaxQueryCharacters,
      });
      return;
    }

    const result = await executeHermesQuery(config, query);

    if (!result.ok) {
      const status = result.error === 'execution_disabled' ? 503 : 502;
      response.status(status).json({
        ok: false,
        error: result.error,
      });
      return;
    }

    response.status(200).json({
      ok: true,
      integration: 'hermes',
      model: config.hermesModel,
      response: result.response,
    });
  }).all(methodNotAllowed(['POST']));

  return router;
}
