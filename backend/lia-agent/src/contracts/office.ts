import type { ExecutiveBoardDecisionLevel, ExecutiveBoardMode, ExecutiveBoardRole } from './executiveBoard.js';
import type { ProjectOrchestrationExecutionMode, ProjectOrchestrationStepRole } from './projectOrchestration.js';
import type { SupervisorState } from './projectSupervisorSchedulingRuntime.js';

/** Safe visual vocabulary. It describes durable evidence, never inferred leaf execution. */
export const OFFICE_VISUAL_STATES = [
  'idle', 'queued', 'planned', 'planning', 'delegating', 'implementing', 'verifying',
  'reviewing', 'correcting', 'waiting_human', 'completed', 'failed',
] as const;
export type OfficeVisualState = (typeof OFFICE_VISUAL_STATES)[number];

export type OfficePlanStep = {
  id: string;
  title: string;
  role: ProjectOrchestrationStepRole;
  dependsOn: string[];
  state: 'planned' | 'queued';
};

export type OfficeAgent = {
  id: 'hermes' | 'architecture' | 'implementation' | 'verification' | 'data-risk';
  name: string;
  role: string;
  station: string;
  state: OfficeVisualState;
  evidenceKind: 'supervisor_state' | 'durable_task_stage' | 'validated_plan_metadata' | 'none';
  goal?: string;
  taskId?: string;
  attempt?: number;
  continuationDepth?: number;
  stage?: string;
  dependencies: string[];
  verification?: string;
  blockingReason?: string;
  lastChangedAt?: number;
};

export type OfficeBoardDecision = {
  decisionId: string;
  goalId?: string;
  level: ExecutiveBoardDecisionLevel;
  mode: ExecutiveBoardMode;
  rolesConsulted: ExecutiveBoardRole[];
  outcome: string;
  requiresHumanApproval: boolean;
  updatedAt: number;
};

export type OfficeReadModel = {
  integration: 'lia_agent_office_v2';
  readOnly: true;
  telemetry: { leafEventsAvailable: false; contractStatus: 'future_boundary_not_implemented' };
  empty: boolean;
  generatedAt: number;
  supervisor: {
    state: SupervisorState | 'unavailable';
    pendingWakeup: boolean;
    passInProgress: boolean;
    failClosed: boolean;
    lastChangedAt?: number;
  };
  capacity: { inFlight: number; ceiling: number };
  focus?: {
    goalId: string;
    title: string;
    goalStatus: string;
    officeState: OfficeVisualState;
    currentTask?: {
      taskId: string;
      status: string;
      completedStages: string[];
      attemptNumber: number;
      continuationDepth: number;
      updatedAt: number;
    };
    executionMode?: ProjectOrchestrationExecutionMode;
    planRecordedAt?: number;
    planSteps: OfficePlanStep[];
    humanInterventionRequired: boolean;
    noProgress: { count: number; threshold: number; escalated: boolean };
    retry: boolean;
    blockingReason?: string;
    verification?: string;
  };
  agents: OfficeAgent[];
  connections: Array<{ from: string; to: string; kind: 'planned_dependency' }>;
  board: { decisions: OfficeBoardDecision[]; rolesPresent: ExecutiveBoardRole[] };
};
