import { Router } from 'express';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import type { ProjectSupervisorSchedulingRuntime } from '../services/projectSupervisorSchedulingRuntime.js';

/**
 * Supervisor Scheduling Runtime Wiring — operator surface.
 *
 * The supervisor runtime is transport/control-flow only and the server is
 * loopback-only (ALLOWED_HOSTS), so an HTTP trigger is transport, not
 * authority. The HUD exposes bounded read-only facts; the pass endpoint
 * performs one bounded inline pass and never queues or escalates.
 *
 * Routes:
 *   GET  /api/projects/goals/supervisor       -> safe operator HUD
 *   POST /api/projects/goals/supervisor/pass  -> one bounded inline pass
 */
const INTEGRATION = 'project_goal_supervisor';

export function createProjectSupervisorRouter(
  runtime: ProjectSupervisorSchedulingRuntime | undefined,
): Router {
  const router = Router();

  router.route('/api/projects/goals/supervisor').get((_request, response) => {
    if (runtime === undefined) {
      response.status(503).json({ ok: false, integration: INTEGRATION, error: 'supervisor_unavailable' });
      return;
    }
    try {
      response.json({ ok: true, integration: INTEGRATION, supervisor: runtime.hud() });
    } catch {
      response.status(503).json({ ok: false, integration: INTEGRATION, error: 'supervisor_unavailable' });
    }
  }).all(methodNotAllowed(['GET']));

  router.route('/api/projects/goals/supervisor/pass').post(async (_request, response) => {
    if (runtime === undefined) {
      response.status(503).json({ ok: false, integration: INTEGRATION, error: 'supervisor_unavailable' });
      return;
    }
    let outcome;
    try {
      outcome = await runtime.triggerPass();
    } catch {
      response.status(503).json({ ok: false, integration: INTEGRATION, error: 'supervisor_unavailable' });
      return;
    }
    if (!outcome.ok) {
      if (outcome.code === 'pass_in_progress') {
        response.status(409).json({ ok: false, integration: INTEGRATION, error: 'pass_in_progress' });
        return;
      }
      response.status(503).json({
        ok: false,
        integration: INTEGRATION,
        error: outcome.code,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      });
      return;
    }
    response.status(200).json({ ok: true, integration: INTEGRATION, pass: outcome.pass });
  }).all(methodNotAllowed(['POST']));

  return router;
}
