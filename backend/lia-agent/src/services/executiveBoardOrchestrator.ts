import { createHash, randomUUID } from 'node:crypto';
import type {
  ExecutiveBoardDecision,
  ExecutiveBoardDecisionRequest,
  ExecutiveBoardDecisionStore,
  ExecutiveBoardDisagreement,
  ExecutiveBoardPerspective,
  ExecutiveBoardSpecialistAdapter,
} from '../contracts/executiveBoard.js';
import { routeExecutiveBoardDecision } from './executiveBoardRouter.js';

export type ExecutiveBoardOrchestratorDependencies = {
  specialists: ExecutiveBoardSpecialistAdapter;
  store: ExecutiveBoardDecisionStore;
  now?: () => number;
  createId?: () => string;
};

const unique = (values: readonly string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
const clampConfidence = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function validateRequest(request: ExecutiveBoardDecisionRequest): void {
  if (!request.requestKey.trim() || request.requestKey.length > 200
    || !request.projectId.trim() || !request.objective.trim() || request.objective.length > 20_000) {
    throw new Error('invalid_executive_board_request');
  }
}

function requestHash(request: ExecutiveBoardDecisionRequest): string {
  const canonical = {
    requestKey: request.requestKey.trim(),
    projectId: request.projectId.trim(),
    goalId: request.goalId?.trim() || null,
    objective: request.objective.trim(),
    context: unique(request.context ?? []),
    level: request.level,
    riskSignals: unique(request.riskSignals ?? []),
    requestedCapabilities: [...new Set(request.requestedCapabilities ?? [])],
    evidence: request.evidence ?? [],
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function normalizePerspective(perspective: ExecutiveBoardPerspective): ExecutiveBoardPerspective {
  return {
    ...perspective,
    position: perspective.position.trim(),
    rationale: unique(perspective.rationale),
    risks: unique(perspective.risks),
    assumptions: unique(perspective.assumptions),
    missingData: unique(perspective.missingData),
    proposedActions: unique(perspective.proposedActions),
    evidence: [...perspective.evidence],
    confidence: clampConfidence(perspective.confidence),
  };
}

function inferDisagreements(perspectives: ExecutiveBoardPerspective[], createId: () => string): ExecutiveBoardDisagreement[] {
  const positions = perspectives.filter(({ status, position }) => status === 'completed' && position !== '');
  if (new Set(positions.map(({ position }) => position.toLocaleLowerCase('es'))).size <= 1) return [];
  return [{
    disagreementId: createId(),
    roles: positions.map(({ role }) => role),
    issue: 'Los especialistas registraron posiciones distintas.',
    positions: positions.map(({ role, position }) => ({ role, position })),
    resolution: 'unresolved',
  }];
}

/**
 * Consults only routed specialists, records dissent verbatim, and persists the
 * advisory decision. Proposed actions are data: this service cannot execute
 * them and cannot grant any LÍA capability.
 */
export function createExecutiveBoardOrchestrator(dependencies: ExecutiveBoardOrchestratorDependencies) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;

  return {
    async decide(request: ExecutiveBoardDecisionRequest): Promise<ExecutiveBoardDecision> {
      validateRequest(request);
      const route = routeExecutiveBoardDecision(request);
      const rawPerspectives = dependencies.specialists.consultBoard
        ? await dependencies.specialists.consultBoard({
            roles: route.roles,
            request,
            routingReasons: route.reasons,
          })
        : await Promise.all(route.reasons.map(({ role, reason }) => dependencies.specialists.consult({
            role,
            request,
            routingReason: reason,
          })));
      const perspectives = rawPerspectives.map(normalizePerspective);
      const disagreements = inferDisagreements(perspectives, createId);
      const risks = unique([...request.riskSignals ?? [], ...perspectives.flatMap((item) => item.risks)]);
      const assumptions = unique(perspectives.flatMap((item) => item.assumptions));
      const missingData = unique(perspectives.flatMap((item) => item.missingData));
      const proposedActions = unique(perspectives.flatMap((item) => item.proposedActions));
      const confidence = perspectives.length === 0
        ? 0
        : perspectives.reduce((total, item) => total + item.confidence, 0) / perspectives.length;
      const requiresHumanApproval = request.level === 'critical'
        || disagreements.length > 0
        || risks.length > 0
        || perspectives.some(({ status }) => status !== 'completed');
      const recommendation = perspectives.find(({ role, status }) => role === 'CEO' && status === 'completed')?.position
        ?? 'No existe una recomendación ejecutiva completa.';
      const timestamp = now();
      const decision: ExecutiveBoardDecision = {
        decisionId: createId(),
        requestKey: request.requestKey.trim(),
        version: 'executive-board-v1',
        projectId: request.projectId.trim(),
        ...(request.goalId?.trim() ? { goalId: request.goalId.trim() } : {}),
        objective: request.objective.trim(),
        context: unique(request.context ?? []),
        level: route.level,
        mode: route.mode,
        rolesConsulted: route.roles,
        routingReasons: route.reasons,
        perspectives,
        disagreements,
        risks,
        assumptions,
        missingData,
        recommendation,
        confidence: clampConfidence(confidence),
        proposedActions,
        requiresHumanApproval,
        evidence: [...request.evidence ?? [], ...perspectives.flatMap((item) => item.evidence)],
        outcome: { status: 'pending', evidence: [] },
        authoritySnapshot: {
          requested: [...request.requestedCapabilities ?? []],
          grantedByBoard: [],
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return dependencies.store.recordDecision({
        requestKey: decision.requestKey,
        requestHash: requestHash(request),
        decision,
      });
    },
  };
}
