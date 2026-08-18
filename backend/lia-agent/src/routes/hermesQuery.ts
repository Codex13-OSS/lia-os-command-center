import { Router } from 'express';
import type { LiaAgentConfig } from '../config.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import type { AgendaReadSource } from '../services/agendaReadSource.js';
import { readSafeAgendaContext } from '../services/agendaContextReader.js';
import {
  executeHermesQuery,
  type HermesQueryExecutor,
} from '../services/hermesExecutor.js';
import { buildHermesQueryWithAgendaContext } from '../services/hermesPromptBuilder.js';

type HermesQueryBody = {
  query?: unknown;
};

export type HermesQueryRouterDependencies = {
  executeQuery?: HermesQueryExecutor;
  agendaReadSource?: AgendaReadSource;
};

export function createHermesQueryRouter(
  config: LiaAgentConfig,
  dependencies: HermesQueryRouterDependencies = {},
): Router {
  const router = Router();
  const executeQuery = dependencies.executeQuery ?? executeHermesQuery;

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

    const agendaContext = await readSafeAgendaContext(
      dependencies.agendaReadSource,
    );
    const outboundQuery = buildHermesQueryWithAgendaContext(
      query,
      agendaContext,
    );
    const result = await executeQuery(config, outboundQuery);

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
