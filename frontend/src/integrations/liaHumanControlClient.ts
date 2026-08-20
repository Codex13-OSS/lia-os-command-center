import { LIA_BOUNDED_AUTONOMY_APPROVER } from './liaProjectGoalClient';

export type LiaGoalContinuationView = {
  goalId: string;
  plan?: { planId: string; status: string; nextObjective: string; nextAttemptNumber: number; nextContinuationDepth: number };
  approval: { state: string; approvalId?: string; revokedAt?: number; expiresAt?: number };
  authorization: { state: string; authorizationId?: string; revokedAt?: number; consumedAt?: number; expiresAt?: number };
  eligibility: { eligible: boolean; reason?: string; mode: string };
  launchState: string;
  materializationState: 'pending' | 'materialized';
};

export type LiaGoalAutonomyView = {
  goalId: string;
  mode: string;
  policyState: string;
  suspendedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
};

export type LiaGoalControlSnapshot = {
  continuation: LiaGoalContinuationView;
  autonomy: LiaGoalAutonomyView;
};

export type LiaGoalControlAction = 'suspend' | 'resume' | 'approve-continuation' | 'refuse-continuation' | 'revoke-approval' | 'authorize-execution' | 'revoke-authorization';
export type LiaControlResult = { ok: true; alreadyKnown: boolean } | { ok: false; message: string };

const BASE = '/api/lia-agent/projects/goals';
const ACTION_PATH: Record<LiaGoalControlAction, string> = {
  suspend: 'suspend', resume: 'resume', 'approve-continuation': 'continuation/approve',
  'refuse-continuation': 'continuation/refuse', 'revoke-approval': 'continuation/approval/revoke',
  'authorize-execution': 'execution/authorize', 'revoke-authorization': 'execution/revoke',
};

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return response.ok && body?.ok === true ? body : null;
  } catch { return null; }
}

export async function readLiaGoalControl(goalId: string): Promise<LiaGoalControlSnapshot | null> {
  const base = `${BASE}/${encodeURIComponent(goalId)}`;
  const [continuation, autonomy] = await Promise.all([readJson(`${base}/continuation`), readJson(`${base}/autonomy`)]);
  if (!continuation || !autonomy || continuation.goalId !== goalId || autonomy.goalId !== goalId) return null;
  return { continuation: continuation as LiaGoalContinuationView, autonomy: autonomy as LiaGoalAutonomyView };
}

function bodyFor(action: LiaGoalControlAction, snapshot: LiaGoalControlSnapshot): Record<string, string> | null {
  if (action === 'approve-continuation' || action === 'authorize-execution') return { approver: LIA_BOUNDED_AUTONOMY_APPROVER };
  if (action === 'revoke-authorization') {
    const authorizationId = snapshot.continuation.authorization.authorizationId;
    return authorizationId ? { authorizationId } : null;
  }
  return {};
}

/** Retries once only after an ambiguous transport/5xx result, with the exact same body. */
export async function runLiaGoalControlAction(action: LiaGoalControlAction, goalId: string, snapshot: LiaGoalControlSnapshot): Promise<LiaControlResult> {
  const body = bodyFor(action, snapshot);
  if (body === null) return { ok: false, message: 'No existe una autorización durable real que revocar.' };
  const request = async (): Promise<LiaControlResult | 'ambiguous'> => {
    try {
      const response = await fetch(`${BASE}/${encodeURIComponent(goalId)}/${ACTION_PATH[action]}`, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; alreadyKnown?: boolean; error?: string } | null;
      if (response.ok && payload?.ok === true) return { ok: true, alreadyKnown: payload.alreadyKnown === true };
      if (response.status >= 500) return 'ambiguous';
      return { ok: false, message: payload?.error ? `Acción no disponible: ${payload.error.replace(/_/g, ' ')}.` : 'La acción ya no es válida para el estado actual.' };
    } catch { return 'ambiguous'; }
  };
  const first = await request();
  const result = first === 'ambiguous' ? await request() : first;
  return result === 'ambiguous' ? { ok: false, message: 'Resultado ambiguo. Se refrescará el estado durable antes de reintentar.' } : result;
}
