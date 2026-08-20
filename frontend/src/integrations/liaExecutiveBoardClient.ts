export type LiaExecutiveBoardRole = 'CEO' | 'CFO' | 'CTO' | 'CMO' | 'COO' | 'LEGAL' | 'DATA';

export type LiaExecutiveBoardDecision = {
  decisionId: string;
  projectId: string;
  goalId?: string;
  objective: string;
  level: 'normal' | 'relevant' | 'critical';
  mode: 'focused' | 'board';
  rolesConsulted: LiaExecutiveBoardRole[];
  perspectives: Array<{
    role: LiaExecutiveBoardRole;
    status: 'completed' | 'blocked_missing_data' | 'failed';
    position: string;
    confidence: number;
  }>;
  disagreements: Array<{
    disagreementId: string;
    roles: LiaExecutiveBoardRole[];
    issue: string;
    positions: Array<{ role: LiaExecutiveBoardRole; position: string }>;
    resolution: 'unresolved' | 'human_decision_required' | 'resolved';
  }>;
  risks: string[];
  assumptions: string[];
  missingData: string[];
  recommendation: string;
  confidence: number;
  proposedActions: string[];
  requiresHumanApproval: boolean;
  evidence: Array<{ evidenceId: string; kind: string; reference: string; summary: string }>;
  outcome: { status: 'pending' | 'approved' | 'rejected' | 'executed' | 'superseded'; summary?: string; recordedAt?: number };
  createdAt: number;
};

export async function readLatestExecutiveBoardDecision(projectId: string): Promise<{
  decision: LiaExecutiveBoardDecision | null;
  durable: boolean;
}> {
  try {
    const response = await fetch(`/api/lia-agent/projects/${encodeURIComponent(projectId)}/board-decisions?limit=1`, {
      cache: 'no-store',
    });
    if (!response.ok) return { decision: null, durable: false };
    const body = await response.json() as {
      ok?: boolean;
      durable?: boolean;
      decisions?: LiaExecutiveBoardDecision[];
    };
    if (body.ok !== true || !Array.isArray(body.decisions)) return { decision: null, durable: false };
    return { decision: body.decisions[0] ?? null, durable: body.durable === true };
  } catch {
    return { decision: null, durable: false };
  }
}

export type LiaBoardOutcomeStatus = 'approved' | 'rejected' | 'executed' | 'superseded';
export type PreparedLiaBoardTransition = {
  projectId: string;
  decisionId: string;
  body: { requestKey: string; status: LiaBoardOutcomeStatus; summary: string; evidence: [] };
};

export function prepareLiaBoardTransition(decision: LiaExecutiveBoardDecision, status: LiaBoardOutcomeStatus): PreparedLiaBoardTransition {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Secure request key generation is unavailable.');
  return {
    projectId: decision.projectId,
    decisionId: decision.decisionId,
    body: {
      requestKey: globalThis.crypto.randomUUID(),
      status,
      summary: `Outcome ${status} registrado por operador UI.`,
      // The UI has no new durable evidence. Never manufacture it.
      evidence: [],
    },
  };
}

/** One ambiguous retry reuses exactly the prepared requestKey and body. */
export async function submitLiaBoardTransition(prepared: PreparedLiaBoardTransition): Promise<
  { ok: true; decision: LiaExecutiveBoardDecision } | { ok: false; message: string }
> {
  const request = async (): Promise<{ ok: true; decision: LiaExecutiveBoardDecision } | { ok: false; message: string } | 'ambiguous'> => {
    try {
      const response = await fetch(`/api/lia-agent/projects/${encodeURIComponent(prepared.projectId)}/board-decisions/${encodeURIComponent(prepared.decisionId)}/outcome-transitions`, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(prepared.body),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; decision?: LiaExecutiveBoardDecision; error?: string } | null;
      if (response.ok && body?.ok === true && body.decision?.decisionId === prepared.decisionId) return { ok: true, decision: body.decision };
      if (response.status >= 500) return 'ambiguous';
      return { ok: false, message: body?.error ? `Transición no disponible: ${body.error.replace(/_/g, ' ')}.` : 'La decisión cambió; actualiza e inténtalo de nuevo.' };
    } catch { return 'ambiguous'; }
  };
  const first = await request();
  const result = first === 'ambiguous' ? await request() : first;
  return result === 'ambiguous' ? { ok: false, message: 'Resultado ambiguo. Se actualizará el registro durable.' } : result;
}
