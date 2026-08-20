import type { ExecutiveBoardDecisionStore } from '../contracts/executiveBoard.js';
import type { OfficeAgent, OfficePlanStep, OfficeReadModel, OfficeVisualState } from '../contracts/office.js';
import type { ProjectGoalRecord } from '../contracts/projectGoal.js';
import type { ProjectOrchestrationProposal, ProjectOrchestrationStepRole } from '../contracts/projectOrchestration.js';
import type { ProjectTaskRecord } from '../contracts/projectTask.js';
import type { ProjectTaskValidatedProposalSnapshotRecord } from '../contracts/projectTaskValidatedProposalSnapshot.js';
import type { ProjectSupervisorSchedulingRuntime } from './projectSupervisorSchedulingRuntime.js';
import {
  buildOperatorGoalDetailSafe,
  assertSafeOperatorPayload,
} from './projectGoalControlReadModel.js';
import type { ProjectGoalControlServiceStore } from './projectGoalControlService.js';
import { MAX_CONCURRENT_EXTERNAL_EXECUTIONS } from '../contracts/projectMultiGoalOrchestration.js';

const ACTIVE_STATUSES = new Set(['planning', 'hermes', 'codex', 'verification', 'commit']);
const ROLES = new Set<ProjectOrchestrationStepRole>(['architect', 'implementer', 'reviewer', 'researcher', 'orchestrator']);
const SAFE_STEP_ID = /^[A-Za-z0-9._:-]{1,120}$/;

export type OfficeReadModelDependencies = {
  store?: ProjectGoalControlServiceStore;
  supervisor?: ProjectSupervisorSchedulingRuntime;
  board?: ExecutiveBoardDecisionStore;
  now?: () => number;
};

export function mapTaskToOfficeState(input: {
  goalStatus: string;
  taskStatus?: string;
  attemptNumber?: number;
  humanInterventionRequired?: boolean;
  noProgressEscalated?: boolean;
}): OfficeVisualState {
  if (input.humanInterventionRequired) return 'waiting_human';
  if (input.goalStatus === 'failed' || input.goalStatus === 'blocked' || input.goalStatus === 'exhausted' || input.taskStatus === 'failed') return 'failed';
  if (input.goalStatus === 'completed') return 'completed';
  const retry = (input.attemptNumber ?? 0) > 0 || input.noProgressEscalated === true;
  if (retry && ['accepted', 'planning', 'hermes', 'codex'].includes(input.taskStatus ?? '')) return 'correcting';
  switch (input.taskStatus) {
    case 'accepted': return 'queued';
    case 'planning': return 'planning';
    case 'hermes': return 'planning';
    case 'codex': return 'implementing';
    case 'verification': return 'verifying';
    case 'commit': return 'reviewing';
    case 'completed': return 'reviewing';
    default: return 'idle';
  }
}

/** Parse only the validated, canonical proposal whitelist; objectives/capabilities are deliberately discarded. */
export function toSafeOfficePlan(snapshot: ProjectTaskValidatedProposalSnapshotRecord | undefined): {
  executionMode?: 'direct' | 'delegated';
  recordedAt?: number;
  steps: OfficePlanStep[];
} {
  if (snapshot === undefined) return { steps: [] };
  try {
    const parsed = JSON.parse(snapshot.canonicalProposalJson) as Partial<ProjectOrchestrationProposal>;
    if ((parsed.executionMode !== 'direct' && parsed.executionMode !== 'delegated') || !Array.isArray(parsed.steps)) return { steps: [] };
    const steps: OfficePlanStep[] = [];
    for (const [index, value] of parsed.steps.entries()) {
      if (typeof value !== 'object' || value === null) return { steps: [] };
      const step = value as unknown as Record<string, unknown>;
      if (typeof step.id !== 'string' || !SAFE_STEP_ID.test(step.id)
        || typeof step.title !== 'string' || step.title.length < 1 || step.title.length > 240
        || typeof step.role !== 'string' || !ROLES.has(step.role as ProjectOrchestrationStepRole)
        || !Array.isArray(step.dependsOn) || !step.dependsOn.every((id) => typeof id === 'string' && SAFE_STEP_ID.test(id))) {
        return { steps: [] };
      }
      steps.push({
        id: step.id,
        // The proposal title is validated but remains model-authored text.
        // Office exposes a neutral ordinal label instead of raw model output.
        title: `Paso ${index + 1}`,
        role: step.role as ProjectOrchestrationStepRole,
        dependsOn: [...step.dependsOn] as string[],
        state: step.dependsOn.length === 0 ? 'queued' : 'planned',
      });
    }
    return { executionMode: parsed.executionMode, recordedAt: snapshot.recordedAt, steps };
  } catch {
    return { steps: [] };
  }
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function verificationSummary(task: ProjectTaskRecord | undefined): string | undefined {
  const verification = task?.receipt?.verification;
  if (verification !== undefined) return `${verification.checksPassed}/${verification.totalChecks} checks passed`;
  if (task?.completedStages?.includes('verification')) return 'Verification stage completed';
  if (task?.error?.completedStages?.includes('verification')) return 'Verification completed before failure';
  return undefined;
}

function snapshotForTask(store: ProjectGoalControlServiceStore, taskId: string): ProjectTaskValidatedProposalSnapshotRecord | undefined {
  const reader = (store as unknown as { readValidatedProposalSnapshotByTask?: (id: string) => ProjectTaskValidatedProposalSnapshotRecord | undefined })
    .readValidatedProposalSnapshotByTask;
  try { return typeof reader === 'function' ? reader.call(store, taskId) : undefined; } catch { return undefined; }
}

function stationAgents(input: {
  state: OfficeVisualState;
  supervisorState: OfficeReadModel['supervisor']['state'];
  title?: string;
  task?: ProjectTaskRecord;
  steps: OfficePlanStep[];
  blockingReason?: string;
  verification?: string;
}): OfficeAgent[] {
  const task = input.task;
  const common = {
    ...(input.title !== undefined ? { goal: input.title } : {}),
    ...(task !== undefined ? {
      taskId: shortId(task.taskId),
      attempt: (task.lineage?.attemptNumber ?? 0) + 1,
      continuationDepth: task.lineage?.continuationDepth ?? 0,
      stage: task.status,
      lastChangedAt: task.updatedAt,
    } : {}),
    ...(input.blockingReason !== undefined ? { blockingReason: input.blockingReason } : {}),
  };
  const plannedFor = (roles: ProjectOrchestrationStepRole[]) => input.steps.filter((step) => roles.includes(step.role));
  const architecture = plannedFor(['architect', 'orchestrator']);
  const implementation = plannedFor(['implementer']);
  const verification = plannedFor(['reviewer']);
  const data = plannedFor(['researcher']);
  const station = (
    id: OfficeAgent['id'], name: string, role: string, label: string,
    activeWhen: OfficeVisualState[], planned: OfficePlanStep[], extra: Partial<OfficeAgent> = {},
  ): OfficeAgent => {
    const active = task !== undefined && activeWhen.includes(input.state);
    return {
      id, name, role, station: label,
      state: active ? input.state : planned.length > 0 ? 'planned' : 'idle',
      evidenceKind: active ? 'durable_task_stage' : planned.length > 0 ? 'validated_plan_metadata' : 'none',
      dependencies: [...new Set(planned.flatMap((step) => step.dependsOn))],
      ...(active || planned.length > 0 ? common : {}),
      ...extra,
    };
  };
  const hermesState: OfficeVisualState = input.supervisorState === 'fail_closed' ? 'failed'
    : input.supervisorState === 'running' ? 'planning'
      : input.supervisorState === 'pending' ? 'queued'
        : input.state === 'planning' ? 'planning'
          : input.steps.length > 1 && input.state === 'queued' ? 'delegating'
            : 'idle';
  return [
    {
      id: 'hermes', name: 'Hermes', role: 'Supervisor central', station: 'Núcleo de coordinación',
      state: hermesState,
      evidenceKind: input.supervisorState === 'unavailable' ? 'none' : 'supervisor_state',
      dependencies: [],
      ...(hermesState !== 'idle' ? common : {}),
    },
    station('architecture', 'Architecture', 'Arquitectura', 'Mesa de Arquitectura', ['planning'], architecture),
    station('implementation', 'Implementation', 'Implementación', 'Estación de Implementación', ['implementing', 'correcting'], implementation),
    station('verification', 'QA / Verification', 'Verificación', 'Laboratorio QA', ['verifying'], verification, input.verification ? { verification: input.verification } : {}),
    station('data-risk', 'Data / Risk', 'Datos y riesgo', 'Observatorio de Riesgo', ['reviewing'], data),
  ];
}

export function buildOfficeReadModel(dependencies: OfficeReadModelDependencies): OfficeReadModel {
  const now = dependencies.now ?? Date.now;
  const supervisorHud = (() => { try { return dependencies.supervisor?.hud(); } catch { return undefined; } })();
  const supervisor: OfficeReadModel['supervisor'] = {
    state: supervisorHud?.state ?? 'unavailable',
    pendingWakeup: supervisorHud?.pendingWakeup ?? false,
    passInProgress: supervisorHud?.passInProgress ?? false,
    failClosed: supervisorHud?.failClosed ?? false,
    ...(supervisorHud?.lastPass?.at !== undefined ? { lastChangedAt: supervisorHud.lastPass.at } : {}),
  };
  let goals: ProjectGoalRecord[] = [];
  try { goals = dependencies.store?.listGoals({ limit: 100, includeTerminal: true }) ?? []; } catch { goals = []; }
  goals.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt - a.updatedAt);
  const goal = goals[0];
  let focus: OfficeReadModel['focus'];
  let task: ProjectTaskRecord | undefined;
  let state: OfficeVisualState = 'idle';
  let plan: ReturnType<typeof toSafeOfficePlan> = { steps: [] };
  let blockingReason: string | undefined;
  let verification: string | undefined;
  if (goal !== undefined && dependencies.store !== undefined) {
    const detail = buildOperatorGoalDetailSafe(dependencies.store, goal.goalId, { now });
    task = detail.currentTask === undefined ? undefined : dependencies.store.get(detail.currentTask.taskId);
    plan = toSafeOfficePlan(task === undefined ? undefined : snapshotForTask(dependencies.store, task.taskId));
    state = mapTaskToOfficeState({
      goalStatus: goal.status,
      taskStatus: task?.status,
      attemptNumber: task?.lineage?.attemptNumber,
      humanInterventionRequired: detail.humanInterventionRequired,
      noProgressEscalated: detail.noProgress.escalated,
    });
    blockingReason = detail.blockingReason;
    verification = verificationSummary(task);
    focus = {
      goalId: shortId(goal.goalId),
      title: goal.objective.slice(0, 2_000),
      goalStatus: goal.status,
      officeState: state,
      ...(task !== undefined ? {
        currentTask: {
          taskId: shortId(task.taskId), status: task.status,
          completedStages: [...(task.completedStages ?? task.error?.completedStages ?? task.receipt?.stages ?? [])],
          attemptNumber: (task.lineage?.attemptNumber ?? 0) + 1,
          continuationDepth: task.lineage?.continuationDepth ?? 0,
          updatedAt: task.updatedAt,
        },
      } : {}),
      ...(plan.executionMode !== undefined ? { executionMode: plan.executionMode } : {}),
      ...(plan.recordedAt !== undefined ? { planRecordedAt: plan.recordedAt } : {}),
      planSteps: plan.steps,
      humanInterventionRequired: detail.humanInterventionRequired,
      noProgress: detail.noProgress,
      retry: (task?.lineage?.attemptNumber ?? 0) > 0,
      ...(blockingReason !== undefined ? { blockingReason } : {}),
      ...(verification !== undefined ? { verification } : {}),
    };
  }
  const projectId = goal?.projectId ?? 'lia-hermes';
  const decisions = (() => {
    try { return dependencies.board?.listDecisions({ projectId, limit: 10 }) ?? []; } catch { return []; }
  })().map((decision) => ({
    decisionId: shortId(decision.decisionId),
    ...(decision.goalId !== undefined ? { goalId: shortId(decision.goalId) } : {}),
    level: decision.level,
    mode: decision.mode,
    rolesConsulted: [...decision.rolesConsulted],
    outcome: decision.outcome.status,
    requiresHumanApproval: decision.requiresHumanApproval,
    updatedAt: decision.updatedAt,
  }));
  const rolesPresent = [...new Set(decisions.flatMap((decision) => decision.rolesConsulted))];
  const model: OfficeReadModel = {
    integration: 'lia_agent_office_v2', readOnly: true,
    telemetry: { leafEventsAvailable: false, contractStatus: 'future_boundary_not_implemented' },
    empty: goal === undefined && decisions.length === 0,
    generatedAt: now(), supervisor,
    capacity: {
      inFlight: goals.filter((item) => {
        try {
          const detail = dependencies.store ? buildOperatorGoalDetailSafe(dependencies.store, item.goalId, { now }) : undefined;
          return detail?.currentTask !== undefined && ACTIVE_STATUSES.has(detail.currentTask.status);
        } catch { return false; }
      }).length,
      ceiling: supervisorHud?.goals?.externalExecutionCeiling ?? MAX_CONCURRENT_EXTERNAL_EXECUTIONS,
    },
    ...(focus !== undefined ? { focus } : {}),
    agents: stationAgents({ state, supervisorState: supervisor.state, ...(goal ? { title: goal.objective.slice(0, 2_000) } : {}), ...(task ? { task } : {}), steps: plan.steps, ...(blockingReason ? { blockingReason } : {}), ...(verification ? { verification } : {}) }),
    connections: plan.steps.flatMap((step) => step.dependsOn.map((dependency) => ({ from: dependency, to: step.id, kind: 'planned_dependency' as const }))),
    board: { decisions, rolesPresent },
  };
  assertSafeOperatorPayload(model);
  return model;
}
