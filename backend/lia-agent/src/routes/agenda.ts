import { Router } from 'express';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import {
  type AgendaReadSource,
} from '../services/agendaReadSource.js';
import { readSafeAgendaContext } from '../services/agendaContextReader.js';

export function createAgendaRouter(
  source?: AgendaReadSource,
): Router {
  const router = Router();

  router.route('/api/agenda/context').get(async (_request, response) => {
    const snapshot = await readSafeAgendaContext(source);
    response.status(200).json(snapshot);
  }).all(methodNotAllowed(['GET']));

  return router;
}
