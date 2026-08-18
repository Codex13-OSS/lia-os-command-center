export type LiaAutonomyHud = {
  supervisor: {
    state: string;
    enabled: boolean;
    failClosed: boolean;
    pendingWakeup: boolean;
    passInProgress: boolean;
    goals: {
      activeGoalCount: number;
      executingGoalCount: number;
      blockedOnHumanGoalCount: number;
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
};

export async function readLiaAutonomyHud(): Promise<LiaAutonomyHud | null> {
  try {
    const [s, g] = await Promise.all([
      fetch('/api/lia-agent/projects/goals/supervisor', { cache: 'no-store' }),
      fetch('/api/lia-agent/projects/goals', { cache: 'no-store' }),
    ]);

    if (!s.ok || !g.ok) return null;

    const supervisor = await s.json();
    const goals = await g.json();

    if (supervisor?.ok !== true || goals?.ok !== true) return null;

    return {
      supervisor: supervisor.supervisor,
      totalGoals: Number(goals.total ?? 0),
    };
  } catch {
    return null;
  }
}
