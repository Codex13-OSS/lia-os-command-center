import type { AutonomyMode, AutonomyPolicyState } from './projectGoalAutonomyPolicy.js';
import type {
  ContinuationApprovalState,
} from './projectGoalContinuationApproval.js';
import type { ExecutionAuthorizationState } from './projectGoalContinuationExecutionAuthorization.js';
import type { ProjectGoalContinuationPlanReasonCode } from './projectGoalContinuationPlan.js';
import type { ProjectGoalStatus } from './projectGoal.js';
import type { ProjectGoalEvaluationDecision, ProjectGoalEvaluationReasonCode } from './projectGoalEvaluation.js';
import type { LoopBudget, LoopStage } from '../services/projectBoundedAutonomousLoopRuntime.js';

/**
 * Operator Goal Control Surface — bounded, non-secret operator-visible shapes
 * and the route error vocabulary (design: operator-goal-control-surface-design.md).
 *
 * This module carries ONLY constants and data shapes. It carries no authority,
 * no capability, no engine, no timer, no polling. Every payload below is a
 * deterministic derivation of existing durable rows; nothing here can approve
 * a plan, create an execution authorization, widen a capability ceiling, or
 * start a second execution engine. LÍA remains the sole authority.
 */

export const PROJECT_GOAL_CONTROL_INTEGRATION = 'project_goal_control' as const;

/** HUD state vocabulary (design §I). Derived from `loopStage` + goal row. */
export const OPERATOR_GOAL_HUD_STATES = [
  'completed',
  'executing',
  'waiting_human',
  'suspended',
  'failed',
  'fail_closed',
] as const;
export type OperatorGoalHudState = (typeof OPERATOR_GOAL_HUD_STATES)[number];

/** Bounded budget projection (design §A.2). Never a percentage of completion. */
export type OperatorGoalBudget = {
  attemptsRemaining: number;
  depthRemaining: number;
  cyclesRemaining?: number;
  elapsedBudgetMsRemaining?: number;
};

/** One safe per-goal list item (design §A.2). */
export type OperatorGoalListItem = {
  goalId: string;
  projectId: string;
  /** `objective` bounded to 2000 chars; the full objective stays in the DB. */
  title: string;
  status: ProjectGoalStatus;
  currentAttempt: number | null;
  maxAttempts: number;
  /** Current task lineage depth (0 when no task exists yet). */
  continuationDepth: number;
  maxDepth: number;
  autonomyMode: AutonomyMode;
  suspensionState: AutonomyPolicyState | 'manual_only';
  humanInterventionRequired: boolean;
  loopStage: LoopStage;
  hudState: OperatorGoalHudState;
  currentTask?: { taskId: string; status: string; attemptNumber: number; continuationDepth: number };
  latestEvidence?: {
    decision: ProjectGoalEvaluationDecision;
    reasonCode: ProjectGoalEvaluationReasonCode;
    summary: string;
    evidenceFingerprint: string;
    appliedAt?: number;
  };
  noProgress: { count: number; threshold: number; escalated: boolean };
  createdAt: number;
  updatedAt: number;
  budget: OperatorGoalBudget;
  ambiguousOutcome: boolean;
  nextSafeAction: string;
  blockingReason?: string;
};
/** Safe receipt fragment for terminal tasks (never raw model output). */
export type OperatorGoalReceiptSummary = {
  executionId?: string;
  status?: string;
  verification?: { checksPassed: number; totalChecks: number };
  commit?: string;
  stages?: readonly string[];
};

/** One attempt fragment (design §B.2). */
export type OperatorGoalAttemptSummary = {
  taskId: string;
  status: string;
  attemptNumber: number;
  continuationDepth: number;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  receiptSummary?: OperatorGoalReceiptSummary;
  errorCode?: string;
};

/** One applied-evaluation fragment (design §B.2). */
export type OperatorGoalEvaluationSummary = {
  evaluationId: string;
  taskId: string;
  attemptNumber: number;
  decision: ProjectGoalEvaluationDecision;
  reasonCode: ProjectGoalEvaluationReasonCode;
  summary: string;
  evidenceFingerprint: string;
  createdAt: number;
  appliedAt?: number;
};

/** One plan-history fragment (design §B.2). */
export type OperatorGoalPlanSummary = {
  planId: string;
  status: string;
  reasonCode: ProjectGoalContinuationPlanReasonCode;
  nextAttemptNumber: number;
  nextContinuationDepth: number;
  createdAt: number;
  cancelledAt?: number;
  createdTaskId?: string;
  consumedAt?: number;
};

/** The approval card (design §E): the exact plan the operator is asked about. */
export type OperatorGoalApprovalCard = {
  planId: string;
  nextObjective: string;
  nextAttemptNumber: number;
  nextContinuationDepth: number;
  reasonCode: ProjectGoalContinuationPlanReasonCode;
  sourceEvaluationId: string;
  sourceEvidenceFingerprint: string;
  approvalState: ContinuationApprovalState;
  approvalId?: string;
  approver?: string;
  createdAt?: number;
  expiresAt?: number;
  revokedAt?: number;
};

/** Deterministic materialization chain description (design §B.6). Advisory text only. */
export type OperatorGoalApprovalEffect = {
  /** What this approval DOES authorize: materialization of this exact plan only. */
  approvalAuthorizes: string;
  /** What this approval DOES NOT authorize: execution. */
  launchRequirement: string;
};

export type OperatorGoalAutonomyView = {
  goalId: string;
  policyId?: string;
  mode: AutonomyMode;
  policyState: AutonomyPolicyState | 'manual_only';
  approver?: string;
  maxCycles?: number;
  elapsedBudgetMs?: number;
  suspendedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  fingerprint?: string;
};

/** Full operator-safe detail payload (design §B). */
export type OperatorGoalDetail = {
  goalId: string;
  projectId: string;
  title: string;
  status: ProjectGoalStatus;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  terminalReason?: string;
  maxAttempts: number;
  continuationDepthLimit: number;
  currentAttempt: number | null;
  loopStage: LoopStage;
  hudState: OperatorGoalHudState;
  blockingReason?: string;
  humanInterventionRequired: boolean;
  ambiguousOutcome: boolean;
  inFlight: boolean;
  launchState: 'not_launched' | 'launch_attempted' | 'launch_result_recorded' | 'terminal';
  currentTask?: OperatorGoalAttemptSummary;
  nextTask?: { taskId: string; status: string; attemptNumber: number; continuationDepth: number };
  latestEvaluation?: OperatorGoalEvaluationSummary;
  evaluationHistory: OperatorGoalEvaluationSummary[];
  planHistory: OperatorGoalPlanSummary[];
  attempts: OperatorGoalAttemptSummary[];
  autonomy: OperatorGoalAutonomyView;
  approvalState: ContinuationApprovalState | 'not_applicable';
  authorizationState: ExecutionAuthorizationState | 'not_applicable';
  approvalCard?: OperatorGoalApprovalCard;
  approvalEffect: OperatorGoalApprovalEffect;
  budget: OperatorGoalBudget;
  noProgress: { count: number; threshold: number; escalated: boolean };
  nextRequiredBoundary: LoopStage;
  nextSafeAction: string;
  eligibility?: { eligible: boolean; reason?: string; mode: AutonomyMode };
};

/** Continuation view (design §C #9/#10): plan + approval + authorization + eligibility + launch state. */
export type OperatorGoalContinuationView = {
  goalId: string;
  plan?: {
    planId: string;
    status: string;
    nextObjective: string;
    reasonCode: ProjectGoalContinuationPlanReasonCode;
    nextAttemptNumber: number;
    nextContinuationDepth: number;
    parentTaskId: string;
    parentAttemptNumber: number;
    createdAt: number;
  };
  approval: {
    state: ContinuationApprovalState | 'not_applicable';
    approvalId?: string;
    approver?: string;
    createdAt?: number;
    expiresAt?: number;
    revokedAt?: number;
  };
  authorization: {
    state: ExecutionAuthorizationState | 'not_applicable';
    authorizationId?: string;
    approver?: string;
    createdAt?: number;
    expiresAt?: number;
    revokedAt?: number;
    consumedAt?: number;
  };
  eligibility: { eligible: boolean; reason?: string; mode: AutonomyMode };
  launchState: 'not_launched' | 'launch_attempted' | 'launch_result_recorded' | 'terminal';
  ambiguousOutcome: boolean;
  materializationState: 'pending' | 'materialized';
  createdTaskId?: string;
  nextTaskExecuted: false;
  inheritedCapabilities: string[];
};

/** Evidence bundle (design §C #11): Q3 summary + plan + authorization + safe receipt. */
export type OperatorGoalEvidenceBundle = {
  goalId: string;
  latestEvaluation?: {
    decision: ProjectGoalEvaluationDecision;
    reasonCode: ProjectGoalEvaluationReasonCode;
    summary: string;
    evidenceFingerprint: string;
    createdAt: number;
    appliedAt?: number;
    taskId: string;
    attemptNumber: number;
    goalStatus: ProjectGoalStatus;
    /** Validated safe receipt text (1..6000 chars), never raw model output. */
    resultText: string;
    verification?: { checksPassed: number; totalChecks: number };
    commit?: string;
    stages?: readonly string[];
  };
  continuationPlan?: {
    planId: string;
    planStatus: string;
    nextObjective: string;
    planReasonCode: ProjectGoalContinuationPlanReasonCode;
    parentTaskId: string;
    parentAttemptNumber: number;
    nextAttemptNumber: number;
    nextContinuationDepth: number;
    materializationPending: boolean;
    continuationExecuted: false;
    escalation: { detected: boolean; consecutiveNoProgress: number; threshold: number; reason?: string };
  };
  approvalState: ContinuationApprovalState | 'not_applicable';
  authorizationState: ExecutionAuthorizationState | 'not_applicable';
  noProgress: { count: number; threshold: number; escalated: boolean };
};

export type CreateGoalRequest = {
  goalId: string;
  projectId: string;
  objective: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  requestedCapabilities?: string[];
  maxAttempts?: number;
  continuationDepthLimit?: number;
  autonomy?: {
    mode: AutonomyMode;
    approver: string;
    maxCycles?: number;
    elapsedBudgetMs?: number;
    expiresAt?: number;
  };
};

export type SetAutonomyRequest = {
  mode: AutonomyMode;
  approver: string;
  maxCycles?: number;
  elapsedBudgetMs?: number;
  expiresAt?: number;
};

export type ContinuationActionRequest = {
  approver?: string;
  expiresAt?: number;
};

export type ExecutionAuthorizationRevokeRequest = {
  authorizationId: string;
};

/** Route error vocabulary (design §J/K). Machine codes only; never internal text. */
export const PROJECT_GOAL_CONTROL_ERRORS = {
  unsupported: 'project_goal_control_unsupported',
  invalidGoalId: 'invalid_goal_id',
  invalidGoal: 'invalid_goal',
  invalidAutonomy: 'invalid_autonomy_request',
  invalidContinuationAction: 'invalid_continuation_action',
  invalidAuthorizationAction: 'invalid_execution_authorization_action',
  invalidProjectFilter: 'invalid_project_filter',
  goalNotFound: 'project_goal_not_found',
  planNotFound: 'project_goal_continuation_plan_not_found',
  approvalNotFound: 'project_goal_continuation_approval_not_found',
  authorizationNotFound: 'project_goal_continuation_execution_authorization_not_found',
  stageMismatch: 'project_goal_stage_mismatch',
  registryUnavailable: 'registry_unavailable',
  projectNotFound: 'project_not_found',
  projectDisabled: 'project_disabled',
  taskCapacityReached: 'project_goal_capacity_reached',
} as const;
