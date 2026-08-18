import { Router } from 'express';
import type { LiaAgentConfig } from '../config.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import {
  PROJECT_GOAL_CONTROL_ERRORS,
  PROJECT_GOAL_CONTROL_INTEGRATION,
} from '../contracts/projectOperatorGoalControl.js';
import {
  createProjectGoalControlService,
  type GoalControlResult,
  type ProjectGoalControlServiceDependencies,
  type ProjectGoalControlServiceStore,
} from '../services/projectGoalControlService.js';

/**
 * Operator Goal Control Surface — thin HTTP handlers (design:
 * operator-goal-control-surface-design.md §J/§K/§M).
 *
 * Every handler validates the `goalId`/body, derives the current stage from
 * durable rows, enforces the stage preconditions, calls ONE existing store
 * primitive (or the existing supervisor `triggerPass`), and returns the fresh
 * read-model payload. There is no route that writes `intent` beyond the
 * validated intake, no route that calls Hermes/Codex, spawns a process or
 * starts a timer. UI/HTTP grants zero authority — every mutation ends in an
 * existing durable transition with all ceiling/lineage/budget checks inside
 * that primitive.
 *
 * Routing-order constraint (design §J): the supervisor router MUST be mounted
 * before this router in `app.ts` so `/api/projects/goals/supervisor` never
 * matches `:goalId`.
 */

export type ProjectGoalControlDependencies = {
  /** Unknown at the router boundary; structurally guarded below. */
  store: unknown;
  config: LiaAgentConfig;
  registry?: ProjectRegistrySource;
  verificationRegistry?: ProjectVerificationRegistry;
  /** Test seam forwarded to the intake runner, never before the durable gate. */
  executeWorkflow?: ProjectGoalControlServiceDependencies['executeWorkflow'];
  onRootTaskTerminalized?: () => void;
  now?: () => number;
  noProgressEscalationThreshold?: number;
};

/** Structural store guard: only durable goal stores expose the control surface. */
export function hasProjectGoalControlSurface(store: unknown): store is ProjectGoalControlServiceStore {
  const candidate = store as { readGoal?: unknown; listGoals?: unknown; createGoalWithRootAttempt?: unknown } | null;
  return candidate !== null
    && typeof candidate.readGoal === 'function'
    && typeof candidate.listGoals === 'function'
    && typeof candidate.createGoalWithRootAttempt === 'function';
}

export function createProjectGoalControlRouter(dependencies: ProjectGoalControlDependencies): Router {
  const router = Router();
  const supported = hasProjectGoalControlSurface(dependencies.store);
  const service = createProjectGoalControlService({
    store: dependencies.store as ProjectGoalControlServiceStore,
    config: dependencies.config,
    ...(dependencies.registry !== undefined ? { registry: dependencies.registry } : {}),
    ...(dependencies.verificationRegistry !== undefined ? { verificationRegistry: dependencies.verificationRegistry } : {}),
    ...(dependencies.executeWorkflow !== undefined ? { executeWorkflow: dependencies.executeWorkflow } : {}),
    ...(dependencies.onRootTaskTerminalized !== undefined ? { onRootTaskTerminalized: dependencies.onRootTaskTerminalized } : {}),
    ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
    ...(dependencies.noProgressEscalationThreshold !== undefined
      ? { noProgressEscalationThreshold: dependencies.noProgressEscalationThreshold }
      : {}),
  });

  const sendResult = (response: import('express').Response, result: GoalControlResult<unknown>): void => {
    if (result.ok) {
      response.status(result.status).json({
        ok: true,
        integration: PROJECT_GOAL_CONTROL_INTEGRATION,
        ...(result.alreadyKnown !== undefined ? { alreadyKnown: result.alreadyKnown } : {}),
        ...(result.payload as Record<string, unknown>),
      });
      return;
    }
    response.status(result.status).json({
      ok: false,
      integration: PROJECT_GOAL_CONTROL_INTEGRATION,
      error: result.error,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    });
  };

  const unsupported = (response: import('express').Response): boolean => {
    if (supported) return true;
    response.status(503).json({
      ok: false,
      integration: PROJECT_GOAL_CONTROL_INTEGRATION,
      error: PROJECT_GOAL_CONTROL_ERRORS.unsupported,
    });
    return false;
  };

  const bodyOf = (request: import('express').Request): Record<string, unknown> =>
    (typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
      ? request.body
      : {}) as Record<string, unknown>;

  // §A: list read model + §D: create goal + root attempt (the missing intake).
  // One route chain for both methods: a separate `.all(methodNotAllowed)`
  // registration would otherwise swallow the sibling method before its
  // handler is reached (Express runs `.all` for every method).
  router.route('/api/projects/goals').get((request, response) => {
    if (!unsupported(response)) return;
    const result = service.listGoals({
      ...(request.query.projectId !== undefined ? { projectId: request.query.projectId } : {}),
      ...(request.query.includeTerminal !== undefined ? { includeTerminal: request.query.includeTerminal } : {}),
      ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
    });
    sendResult(response, result);
  }).post(async (request, response) => {
    if (!unsupported(response)) return;
    const result = await service.createGoal(bodyOf(request) as Parameters<typeof service.createGoal>[0]);
    sendResult(response, result);
  }).all(methodNotAllowed(['GET', 'POST']));

  // §B: goal detail.
  router.route('/api/projects/goals/:goalId').get((request, response) => {
    if (!unsupported(response)) return;
    const result = service.getGoalDetail(request.params.goalId);
    sendResult(response, result);
  }).all(methodNotAllowed(['GET']));

  // §C #6: suspend.
  router.route('/api/projects/goals/:goalId/suspend').post((request, response) => {
    if (!unsupported(response)) return;
    const result = service.suspend(request.params.goalId);
    sendResult(response, result);
  }).all(methodNotAllowed(['POST']));

  // §C #7: resume.
  router.route('/api/projects/goals/:goalId/resume').post((request, response) => {
    if (!unsupported(response)) return;
    const result = service.resume(request.params.goalId);
    sendResult(response, result);
  }).all(methodNotAllowed(['POST']));

  // §C #5 read side + INITIAL-SET: policy + derived state, one chain so the
  // `.all` guard never swallows the sibling method (same constraint as above).
  router.route('/api/projects/goals/:goalId/autonomy').get((request, response) => {
    if (!unsupported(response)) return;
    const result = service.getAutonomyView(request.params.goalId);
    sendResult(response, result);
  }).put((request, response) => {
    if (!unsupported(response)) return;
    const result = service.setAutonomy(request.params.goalId, bodyOf(request) as Parameters<typeof service.setAutonomy>[1]);
    sendResult(response, result);
  }).all(methodNotAllowed(['GET', 'PUT']));

  // §C #9/#10: continuation view (plan + approval + authorization + eligibility).
  router.route('/api/projects/goals/:goalId/continuation').get((request, response) => {
    if (!unsupported(response)) return;
    const result = service.getContinuationView(request.params.goalId);
    sendResult(response, result);
  }).all(methodNotAllowed(['GET']));

  // §C #3: approve continuation materialization (authorizes MATERIALIZATION only).
  router.route('/api/projects/goals/:goalId/continuation/approve').post((request, response) => {
    if (!unsupported(response)) return;
    const result = service.approveMaterialization(
      request.params.goalId,
      bodyOf(request) as Parameters<typeof service.approveMaterialization>[1],
    );
    sendResult(response, result);
  }).all(methodNotAllowed(['POST']));

  // §C #4: durable refusal via plan cancellation.
  router.route('/api/projects/goals/:goalId/continuation/refuse').post((request, response) => {
    if (!unsupported(response)) return;
    const result = service.refuseMaterialization(request.params.goalId);
    sendResult(response, result);
  }).all(methodNotAllowed(['POST']));

  // §C #12: revoke a granted plan approval (pre-materialization only).
  router.route('/api/projects/goals/:goalId/continuation/approval/revoke').post((request, response) => {
    if (!unsupported(response)) return;
    const result = service.revokeApproval(request.params.goalId);
    sendResult(response, result);
  }).all(methodNotAllowed(['POST']));

  // §C #11: evidence bundle (Q3 summary + plan + authorization + safe receipt).
  router.route('/api/projects/goals/:goalId/evidence').get((request, response) => {
    if (!unsupported(response)) return;
    const result = service.getEvidenceBundle(request.params.goalId);
    sendResult(response, result);
  }).all(methodNotAllowed(['GET']));

  // §C #13: create the per-task execution authorization (approved_single_step only).
  router.route('/api/projects/goals/:goalId/execution/authorize').post((request, response) => {
    if (!unsupported(response)) return;
    const result = service.authorizeExecution(
      request.params.goalId,
      bodyOf(request) as Parameters<typeof service.authorizeExecution>[1],
    );
    sendResult(response, result);
  }).all(methodNotAllowed(['POST']));

  // §C #8: revoke an unconsumed execution authorization.
  router.route('/api/projects/goals/:goalId/execution/revoke').post((request, response) => {
    if (!unsupported(response)) return;
    const result = service.revokeExecutionAuthorization(
      request.params.goalId,
      bodyOf(request) as Parameters<typeof service.revokeExecutionAuthorization>[1],
    );
    sendResult(response, result);
  }).all(methodNotAllowed(['POST']));

  return router;
}
