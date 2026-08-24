export type LiaAutonomyGoalHudState = 'completed' | 'executing' | 'waiting_human' | 'suspended' | 'failed' | 'fail_closed';

export type LiaAutonomyGoal = {
  goalId: string;
  projectId: string;
  title: string;
  status: 'active' | 'completed' | 'blocked' | 'exhausted' | 'failed';
  currentAttempt: number | null;
  maxAttempts: number;
  continuationDepth: number;
  maxDepth: number;
  humanInterventionRequired: boolean;
  loopStage: string;
  hudState: LiaAutonomyGoalHudState;
  createdAt: number;
  updatedAt: number;
  blockingReason?: string;
  autonomyMode?: string;
  suspensionState?: string;
  currentTask?: { taskId: string; status: string; attemptNumber: number; continuationDepth: number };
  latestEvidence?: {
    decision: string;
    reasonCode: string;
    summary: string;
    evidenceFingerprint: string;
    appliedAt?: number;
  };
  noProgress?: { count: number; threshold: number; escalated: boolean };
  budget?: { attemptsRemaining: number; depthRemaining: number; cyclesRemaining?: number; elapsedBudgetMsRemaining?: number };
  presentation?: { audience?: string; hiddenByDefault?: boolean };
  metadata?: { type?: string; purpose?: string; tags?: string[]; qualification?: boolean; test?: boolean };
  type?: string;
};

/** Durable evidence remains in the read model; this only controls default executive prominence. */
export function isExecutiveGoal(goal: LiaAutonomyGoal): boolean {
  const kinds = [goal.type, goal.metadata?.type, goal.metadata?.purpose].filter(Boolean).map((value) => value!.toLowerCase());
  const tags = goal.metadata?.tags?.map((tag) => tag.toLowerCase()) ?? [];
  return (goal.status === 'active' || goal.status === 'blocked')
    && goal.presentation?.hiddenByDefault !== true
    && goal.presentation?.audience !== 'qualification'
    && goal.metadata?.qualification !== true
    && goal.metadata?.test !== true
    && ![...kinds, ...tags].some((value) => ['qualification', 'test', 'fixture', 'e2e', 'synthetic'].includes(value));
}

export function isExecutivePriorityGoal(goal: LiaAutonomyGoal): boolean {
  return isExecutiveGoal(goal) && (goal.status === 'active' || goal.status === 'blocked');
}

export type LiaAutonomyHud = {
  supervisor: {
    state: string;
    enabled: boolean;
    supported: boolean;
    failClosed: boolean;
    pendingWakeup: boolean;
    passInProgress: boolean;
    goals?: {
      activeGoalCount: number;
      runnableGoalCount: number;
      executingGoalCount: number;
      blockedOnHumanGoalCount: number;
      failedOrSuspendedGoalCount: number;
      humanInterventionRequiredCount: number;
      externalExecutionCeiling: number;
      inFlight: number;
    };
    lastPass?: {
      source: string;
      at: number;
    };
  };
  totalGoals: number;
  activeCount: number;
  terminalCount: number;
  humanInterventionRequiredCount: number;
  executingCount: number;
  inFlight: number;
  externalExecutionCeiling: number;
  maxGoalsPerTick: number;
  goals: LiaAutonomyGoal[];
};

export async function readLiaAutonomyHud(): Promise<LiaAutonomyHud | null> {
  try {
    const [s, g] = await Promise.all([
      fetch('/api/lia-agent/projects/goals/supervisor', { cache: 'no-store' }),
      fetch('/api/lia-agent/projects/goals', { cache: 'no-store' }),
    ]);

    if (!s.ok || !g.ok) return null;

    const supervisor = await s.json() as { ok?: boolean; supervisor?: LiaAutonomyHud['supervisor'] };
    const goals = await g.json() as {
      ok?: boolean;
      total?: number;
      activeCount?: number;
      terminalCount?: number;
      humanInterventionRequiredCount?: number;
      executingCount?: number;
      inFlight?: number;
      externalExecutionCeiling?: number;
      maxGoalsPerTick?: number;
      goals?: LiaAutonomyGoal[];
    };

    if (supervisor.ok !== true || goals.ok !== true || !supervisor.supervisor || !Array.isArray(goals.goals)) return null;

      /* LIA_HONEST_AUTONOMY_METRICS_V32 */
      const metric = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;

      const totalGoals = metric(goals.total);
      const activeCount = metric(goals.activeCount);
      const terminalCount = metric(goals.terminalCount);
      const humanInterventionRequiredCount = metric(goals.humanInterventionRequiredCount);
      const executingCount = metric(goals.executingCount);
      const inFlight = metric(goals.inFlight);
      const externalExecutionCeiling = metric(goals.externalExecutionCeiling);
      const maxGoalsPerTick = metric(goals.maxGoalsPerTick);

      if (
        totalGoals === undefined ||
        activeCount === undefined ||
        terminalCount === undefined ||
        humanInterventionRequiredCount === undefined ||
        executingCount === undefined ||
        inFlight === undefined ||
        externalExecutionCeiling === undefined ||
        maxGoalsPerTick === undefined
      ) return null;

      return {
        supervisor: supervisor.supervisor,
        totalGoals,
        activeCount,
        terminalCount,
        humanInterventionRequiredCount,
        executingCount,
        inFlight,
        externalExecutionCeiling,
        maxGoalsPerTick,
        goals: goals.goals,
      };
  } catch {
    return null;
  }
}
