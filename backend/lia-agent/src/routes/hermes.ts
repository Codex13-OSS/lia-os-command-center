import { Router } from 'express';
import type { LiaAgentConfig } from '../config.js';
import {
  createHermesContractsSnapshot,
  createHermesStatusSnapshot,
} from '../contracts/hermes.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import { inspectHermesRuntime } from '../services/hermesRuntime.js';

export function createHermesRouter(config: LiaAgentConfig): Router {
  const router = Router();

  router.route('/api/hermes/status').get(async (_request, response) => {
    const probe = await inspectHermesRuntime(config.hermesRoot);
    response.status(200).json(createHermesStatusSnapshot(probe, config.hermesExecutionEnabled));
  }).all(methodNotAllowed(['GET']));

  router.route('/api/hermes/contracts').get((_request, response) => {
    response.status(200).json(createHermesContractsSnapshot(config.hermesExecutionEnabled));
  }).all(methodNotAllowed(['GET']));

  return router;
}
