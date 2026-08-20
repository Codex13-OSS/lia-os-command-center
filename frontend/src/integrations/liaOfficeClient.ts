export type LiaOfficeState = 'idle' | 'queued' | 'planned' | 'planning' | 'delegating' | 'implementing' | 'verifying' | 'reviewing' | 'correcting' | 'waiting_human' | 'completed' | 'failed';
export type LiaOfficeAgent = {
  id: 'hermes' | 'architecture' | 'implementation' | 'verification' | 'data-risk';
  name: string; role: string; station: string; state: LiaOfficeState;
  evidenceKind: 'supervisor_state' | 'durable_task_stage' | 'validated_plan_metadata' | 'none';
  goal?: string; taskId?: string; attempt?: number; continuationDepth?: number;
  stage?: string; dependencies: string[]; verification?: string; blockingReason?: string; lastChangedAt?: number;
};
export type LiaOfficeReadModel = {
  integration: 'lia_agent_office_v2'; readOnly: true; empty: boolean; generatedAt: number;
  telemetry: { leafEventsAvailable: false; contractStatus: 'future_boundary_not_implemented' };
  supervisor: { state: string; pendingWakeup: boolean; passInProgress: boolean; failClosed: boolean; lastChangedAt?: number };
  capacity: { inFlight: number; ceiling: number };
  focus?: {
    goalId: string; title: string; goalStatus: string; officeState: LiaOfficeState;
    currentTask?: { taskId: string; status: string; completedStages: string[]; attemptNumber: number; continuationDepth: number; updatedAt: number };
    executionMode?: 'direct' | 'delegated'; planRecordedAt?: number;
    planSteps: Array<{ id: string; title: string; role: string; dependsOn: string[]; state: 'planned' | 'queued' }>;
    humanInterventionRequired: boolean; noProgress: { count: number; threshold: number; escalated: boolean };
    retry: boolean; blockingReason?: string; verification?: string;
  };
  agents: LiaOfficeAgent[];
  connections: Array<{ from: string; to: string; kind: 'planned_dependency' }>;
  board: {
    decisions: Array<{ decisionId: string; goalId?: string; level: string; mode: string; rolesConsulted: string[]; outcome: string; requiresHumanApproval: boolean; updatedAt: number }>;
    rolesPresent: string[];
  };
};

export async function readLiaOffice(): Promise<LiaOfficeReadModel | null> {
  try {
    const response = await fetch('/api/lia-agent/projects/office', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json() as { ok?: boolean; office?: LiaOfficeReadModel };
    return body.ok === true && body.office?.readOnly === true ? body.office : null;
  } catch { return null; }
}
