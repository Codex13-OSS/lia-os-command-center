import { Router } from 'express';
import { createAgendaContextSnapshot } from '../contracts/agenda.js';
import { validateAgendaReadPayload } from '../contracts/agendaValidation.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import {
  createUnconfiguredAgendaReadSource,
  type AgendaReadSource,
} from '../services/agendaReadSource.js';

export function createAgendaRouter(
  source: AgendaReadSource = createUnconfiguredAgendaReadSource(),
): Router {
  const router = Router();

  router.route('/api/agenda/context').get(async (_request, response) => {
    try {
      const result = await source.read();
      const validation = validateAgendaReadPayload(result);

      if (!validation.success) {
        response.status(200).json(
          createAgendaContextSnapshot(
            'unavailable',
            [],
            'America/Mexico_City',
          ),
        );
        return;
      }

      response.status(200).json(
        createAgendaContextSnapshot(
          validation.payload.state,
          validation.payload.events,
          validation.payload.timezone,
        ),
      );
    } catch {
      response.status(200).json(
        createAgendaContextSnapshot(
          'unavailable',
          [],
          'America/Mexico_City',
        ),
      );
    }
  }).all(methodNotAllowed(['GET']));

  return router;
}
