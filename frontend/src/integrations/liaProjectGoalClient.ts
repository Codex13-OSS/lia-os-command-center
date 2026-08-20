import type { LiaProjectTaskPriority } from './liaProjectTaskWorkflowClient';

export const LIA_PROJECT_GOALS_PATH = '/api/lia-agent/projects/goals';
export const LIA_PROJECT_GOAL_ESTIMATE_PATH = `${LIA_PROJECT_GOALS_PATH}/effort-estimate`;
export const LIA_GOAL_CREATED_EVENT = 'lia:project-goal-created';
export const LIA_BOUNDED_AUTONOMY_APPROVER = 'lia-ui-operator';

export type LiaProjectGoalComplexity = 'low' | 'medium' | 'high' | 'critical';
export type LiaProjectGoalEffortEstimate = {
  complexity: LiaProjectGoalComplexity;
  recommendedMaxAttempts: number;
  recommendedContinuationDepth: number;
  recommendedMaxCycles: number;
  recommendedElapsedBudgetMs: number;
  riskFactors: string[];
  rationale: string[];
  confidence: number;
};

export type LiaProjectGoalRequest = {
  goalId: string;
  projectId: string;
  objective: string;
  priority: LiaProjectTaskPriority;
  maxAttempts?: number;
  continuationDepthLimit?: number;
  autonomy?: {
    mode: 'bounded_autonomous';
    approver: typeof LIA_BOUNDED_AUTONOMY_APPROVER;
    maxCycles: number;
    elapsedBudgetMs: number;
  };
};

export type PreparedLiaProjectGoal = {
  request: LiaProjectGoalRequest;
  createdAt: number;
};

export type LiaProjectGoalSubmitResult =
  | { kind: 'accepted'; goalId: string; alreadyKnown: boolean }
  | { kind: 'ambiguous'; goalId: string }
  | { kind: 'contract'; goalId: string; message: string };

const CONTRACT_MESSAGES: Readonly<Record<string, string>> = {
  invalid_goal: 'No fue posible registrar el objetivo. Revisa la instrucción e inténtalo de nuevo.',
  invalid_goal_id: 'No fue posible identificar el objetivo de forma segura.',
  project_not_found: 'El proyecto de LÍA no está disponible.',
  project_disabled: 'El proyecto de LÍA está deshabilitado.',
  registry_unavailable: 'El registro de proyectos no está disponible.',
  project_goal_capacity_reached: 'LÍA alcanzó temporalmente el límite de objetivos activos.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function createGoalId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('Secure UUID generation is unavailable.');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isEffortEstimate(value: unknown): value is LiaProjectGoalEffortEstimate {
  if (!isRecord(value)) return false;
  return ['low', 'medium', 'high', 'critical'].includes(String(value.complexity))
    && Number.isInteger(value.recommendedMaxAttempts)
    && Number.isInteger(value.recommendedContinuationDepth)
    && Number.isInteger(value.recommendedMaxCycles)
    && Number.isSafeInteger(value.recommendedElapsedBudgetMs)
    && Array.isArray(value.riskFactors) && value.riskFactors.every((item) => typeof item === 'string')
    && Array.isArray(value.rationale) && value.rationale.every((item) => typeof item === 'string')
    && typeof value.confidence === 'number' && value.confidence >= 0 && value.confidence <= 1;
}

/** Read-only deterministic estimate. It never creates a Goal or grants authority. */
export async function estimateLiaProjectGoalEffort(input: {
  projectId: string;
  objective: string;
  priority: LiaProjectTaskPriority;
}): Promise<LiaProjectGoalEffortEstimate | null> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(LIA_PROJECT_GOAL_ESTIMATE_PATH, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: input.projectId.trim(),
        objective: input.objective.trim(),
        priority: input.priority,
      }),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    return response.ok && isRecord(body) && body.ok === true && isEffortEstimate(body.estimate)
      ? body.estimate
      : null;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export function prepareLiaProjectGoal(input: {
  projectId: string;
  objective: string;
  priority: LiaProjectTaskPriority;
  autonomyMode?: 'supervised' | 'bounded_autonomous';
  estimate?: LiaProjectGoalEffortEstimate;
}): PreparedLiaProjectGoal {
  const request: LiaProjectGoalRequest = {
    goalId: createGoalId(),
    projectId: input.projectId.trim(),
    objective: input.objective.trim(),
    priority: input.priority,
  };
  if (input.autonomyMode === 'bounded_autonomous') {
    if (input.estimate === undefined) throw new Error('Bounded autonomy requires a confirmed estimate.');
    request.maxAttempts = input.estimate.recommendedMaxAttempts;
    request.continuationDepthLimit = input.estimate.recommendedContinuationDepth;
    request.autonomy = {
      mode: 'bounded_autonomous',
      approver: LIA_BOUNDED_AUTONOMY_APPROVER,
      maxCycles: input.estimate.recommendedMaxCycles,
      elapsedBudgetMs: input.estimate.recommendedElapsedBudgetMs,
    };
  }
  return { request, createdAt: Date.now() };
}

async function submitOnce(goal: PreparedLiaProjectGoal): Promise<LiaProjectGoalSubmitResult> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(LIA_PROJECT_GOALS_PATH, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      // No capability field is sent. The backend ceiling remains authoritative.
      body: JSON.stringify(goal.request),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (
      response.ok
      && isRecord(body)
      && body.ok === true
      && isRecord(body.goal)
      && body.goal.goalId === goal.request.goalId
      && (body.alreadyKnown === true || body.alreadyKnown === false)
    ) {
      return { kind: 'accepted', goalId: goal.request.goalId, alreadyKnown: body.alreadyKnown };
    }
    if (response.status >= 500) return { kind: 'ambiguous', goalId: goal.request.goalId };
    const error = isRecord(body) && typeof body.error === 'string' ? body.error : '';
    return {
      kind: 'contract',
      goalId: goal.request.goalId,
      message: CONTRACT_MESSAGES[error] ?? 'No fue posible registrar el objetivo de forma segura.',
    };
  } catch {
    return { kind: 'ambiguous', goalId: goal.request.goalId };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** A single bounded retry reuses the exact prepared request, goalId and policy. */
export async function submitLiaProjectGoal(
  goal: PreparedLiaProjectGoal,
): Promise<LiaProjectGoalSubmitResult> {
  const first = await submitOnce(goal);
  return first.kind === 'ambiguous' ? submitOnce(goal) : first;
}
