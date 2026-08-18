import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AutonomousV1CompletionMode } from '../contracts/autonomousAuthority.js';
import type { ProjectOrchestrationExecutionMode } from '../contracts/projectOrchestration.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import type { ProjectTaskBlockedCapability } from '../contracts/projectExecutor.js';
import { validateProjectTaskRequest } from '../contracts/projectExecutorValidation.js';
import type {
  CreateContinuationAttemptInput,
  CreateGoalWithRootAttemptInput,
  CreateGoalWithRootAttemptResult,
  CreateProjectGoalInput,
  CreateRootAttemptInput,
  ListProjectGoalsOptions,
  ProjectGoalRecord,
  ProjectGoalStore,
  ProjectGoalTerminalReason,
  ProjectGoalTerminalStatus,
} from '../contracts/projectGoal.js';
import {
  PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT,
  PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT,
  PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS,
  PROJECT_GOAL_ERRORS,
  PROJECT_GOAL_ID,
  PROJECT_GOAL_MAX_ATTEMPTS_LIMIT,
  PROJECT_GOAL_STATUSES,
  PROJECT_GOAL_TERMINAL_REASONS,
} from '../contracts/projectGoal.js';
import type {
  EvaluateProjectGoalAttemptInput,
  ProjectGoalEvaluationDecision,
  ProjectGoalEvaluationRecord,
  ProjectGoalEvaluationReasonCode,
  ProjectGoalEvaluationStore,
} from '../contracts/projectGoalEvaluation.js';
import {
  PROJECT_GOAL_EVALUATION_DECISIONS,
  PROJECT_GOAL_EVALUATION_ERRORS,
  PROJECT_GOAL_EVALUATION_REASON_CODES,
  PROJECT_GOAL_EVALUATOR_VERSION,
} from '../contracts/projectGoalEvaluation.js';
import type {
  CreateProjectGoalContinuationPlanInput,
  ProjectGoalContinuationPlanReasonCode,
  ProjectGoalContinuationPlanRecord,
  ProjectGoalContinuationPlanStatus,
  ProjectGoalContinuationPlanStore,
} from '../contracts/projectGoalContinuationPlan.js';
import {
  CONTINUATION_PLANNER_VERSION,
  PROJECT_GOAL_CONTINUATION_PLAN_ERRORS,
  PROJECT_GOAL_CONTINUATION_PLAN_REASON_CODES,
} from '../contracts/projectGoalContinuationPlan.js';
import type {
  ApproveContinuationPlanInput,
  ProjectGoalContinuationApprovalRecord,
  ProjectGoalContinuationApprovalStore,
} from '../contracts/projectGoalContinuationApproval.js';
import {
  CONTINUATION_APPROVAL_DEFAULT_TTL_MS,
  CONTINUATION_APPROVAL_MAX_APPROVER_LENGTH,
  PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS,
} from '../contracts/projectGoalContinuationApproval.js';
import type {
  AutonomyMode,
  ProjectGoalAutonomyPolicyRecord,
  ProjectGoalAutonomyPolicyStore,
  SetGoalAutonomyPolicyInput,
} from '../contracts/projectGoalAutonomyPolicy.js';
import {
  AUTONOMY_MODES,
  AUTONOMY_POLICY_MAX_APPROVER_LENGTH,
  AUTONOMY_POLICY_VERSION,
  PROJECT_GOAL_AUTONOMY_POLICY_ERRORS,
  autonomyPolicyMeaning,
} from '../contracts/projectGoalAutonomyPolicy.js';
import type {
  CreateExecutionAuthorizationInput,
  ProjectGoalContinuationExecutionAuthorizationRecord,
  ProjectGoalContinuationExecutionAuthorizationStore,
} from '../contracts/projectGoalContinuationExecutionAuthorization.js';
import {
  EXECUTION_AUTHORIZATION_DEFAULT_TTL_MS,
  EXECUTION_AUTHORIZATION_MAX_APPROVER_LENGTH,
  EXECUTION_AUTHORIZATION_VERSION,
  PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS,
} from '../contracts/projectGoalContinuationExecutionAuthorization.js';
import type {
  ProjectContinuationMaterializationResult,
  ProjectContinuationRuntime,
} from '../contracts/projectContinuationRuntime.js';
import { PROJECT_CONTINUATION_RUNTIME_ERRORS } from '../contracts/projectContinuationRuntime.js';
import type {
  ClaimProjectTaskDispatchInput,
  ConsumeProjectTaskDispatchInput,
  ProjectTaskDispatchClaim,
  ProjectTaskDispatchRecord,
  ProjectTaskDispatchStore,
} from '../contracts/projectTaskDispatch.js';
import {
  PROJECT_TASK_DISPATCH_ERRORS,
  PROJECT_TASK_DISPATCH_MAX_LIST_LIMIT,
} from '../contracts/projectTaskDispatch.js';
import type {
  PrepareProjectTaskExecutionRunInput,
  ProjectTaskExecutionRunRecord,
  ProjectTaskExecutionRunStore,
} from '../contracts/projectTaskExecutionRun.js';
import {
  PROJECT_TASK_EXECUTION_RUN_ERRORS,
  PROJECT_TASK_EXECUTION_RUN_MAX_LIST_LIMIT,
} from '../contracts/projectTaskExecutionRun.js';
import type {
  ProjectTaskExecutionInvocationRecord,
  ProjectTaskExecutionInvocationStore,
  ReserveProjectTaskExecutionInvocationInput,
} from '../contracts/projectTaskExecutionInvocation.js';
import {
  PROJECT_TASK_EXECUTION_INVOCATION_ERRORS,
  PROJECT_TASK_EXECUTION_INVOCATION_MAX_LIST_LIMIT,
} from '../contracts/projectTaskExecutionInvocation.js';
import type {
  BeginProjectTaskExecutionLaunchAttemptInput,
  BeginProjectTaskExecutionLaunchAttemptResult,
  ProjectTaskExecutionLaunchAttemptRecord,
  ProjectTaskExecutionLaunchAttemptStore,
} from '../contracts/projectTaskExecutionLaunchAttempt.js';
import {
  PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS,
  PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_MAX_LIST_LIMIT,
} from '../contracts/projectTaskExecutionLaunchAttempt.js';
import type {
  ProjectTaskExecutionLaunchResultOutcome,
  ProjectTaskExecutionLaunchResultRecord,
  ProjectTaskExecutionLaunchResultStore,
  RecordProjectTaskExecutionLaunchResultInput,
  RecordProjectTaskExecutionLaunchResultResult,
} from '../contracts/projectTaskExecutionLaunchResult.js';
import {
  PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS,
  PROJECT_TASK_EXECUTION_LAUNCH_RESULT_MAX_LIST_LIMIT,
  PROJECT_TASK_EXECUTION_LAUNCH_RESULT_OUTCOME_SET,
} from '../contracts/projectTaskExecutionLaunchResult.js';
import type {
  RecordValidatedProposalInput,
  RecordValidatedProposalResult,
  ProjectTaskValidatedProposalSnapshotRecord,
  ProjectTaskValidatedProposalSnapshotStore,
} from '../contracts/projectTaskValidatedProposalSnapshot.js';
import {
  PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION,
  PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS,
  PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_MAX_LIST_LIMIT,
} from '../contracts/projectTaskValidatedProposalSnapshot.js';
import type {
  ProjectTaskResumeDecisionRecord,
  ProjectTaskResumeDecisionStore,
  RecordResumeDecisionInput,
  RecordResumeDecisionResult,
} from '../contracts/projectTaskResumeDecision.js';
import {
  PROJECT_TASK_RESUME_DECISION_ERRORS,
  PROJECT_TASK_RESUME_DECISION_MAX_LIST_LIMIT,
  PROJECT_TASK_RESUME_DECISIONS,
  PROJECT_TASK_RESUME_REFUSAL_REASONS,
} from '../contracts/projectTaskResumeDecision.js';
import type {
  CodexStartEvidenceRecord,
  CodexResultEvidenceRecord,
  RecordCodexStartInput,
  RecordCodexStartResult,
  RecordCodexResultInput,
  RecordCodexResultResult,
  ProjectTaskCodexEvidenceStore,
} from '../contracts/projectTaskCodexEvidence.js';
import {
  CODEX_RESULT_OUTCOMES,
  PROJECT_TASK_CODEX_EVIDENCE_ERRORS,
} from '../contracts/projectTaskCodexEvidence.js';
import type {
  VerificationStartEvidenceRecord,
  VerificationResultEvidenceRecord,
  RecordVerificationStartInput,
  RecordVerificationStartResult,
  RecordVerificationResultInput,
  RecordVerificationResultResult,
  ProjectTaskVerificationEvidenceStore,
} from '../contracts/projectTaskVerificationEvidence.js';
import {
  VERIFICATION_RESULT_STATUSES,
  VERIFICATION_FAILURE_ERRORS,
  PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS,
} from '../contracts/projectTaskVerificationEvidence.js';
import type {
  CommitStartEvidenceRecord,
  CommitResultEvidenceRecord,
  RecordCommitStartInput,
  RecordCommitStartResult,
  RecordCommitResultInput,
  RecordCommitResultResult,
  ProjectTaskCommitEvidenceStore,
} from '../contracts/projectTaskCommitEvidence.js';
import {
  COMMIT_RESULT_STATUSES,
  COMMIT_FAILURE_ERRORS,
  PROJECT_TASK_COMMIT_EVIDENCE_ERRORS,
} from '../contracts/projectTaskCommitEvidence.js';
import type {
  ProjectTaskCompletionEvidenceRecord,
  RecordCompletionEvidenceInput,
  RecordCompletionEvidenceResult,
  ProjectTaskCompletionEvidenceStore,
} from '../contracts/projectTaskCompletionEvidence.js';
import {
  PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS,
} from '../contracts/projectTaskCompletionEvidence.js';
import type {
  AcquireProjectTaskLeaseInput,
  ProjectTaskLeaseAuthority,
  ProjectTaskLeaseRecord,
  ProjectTaskLeaseStore,
  RenewProjectTaskLeaseInput,
} from '../contracts/projectTaskLease.js';
import {
  PROJECT_TASK_LEASE_ERRORS,
  PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN,
  PROJECT_TASK_LEASE_MAX_DURATION_MS,
  PROJECT_TASK_LEASE_MIN_DURATION_MS,
} from '../contracts/projectTaskLease.js';
import type {
  CreateProjectTaskResult,
  ActiveTaskStage,
  ProjectTaskRecord,
  ProjectTaskReconciler,
  ProjectTaskRestartRecoveryResult,
  ProjectTaskRestartSafeReconciler,
  ProjectTaskLineage,
  ProjectTaskStage,
  ProjectTaskStore,
  SafeTaskError,
  SafeTaskReceipt,
} from '../contracts/projectTask.js';
import { ACTIVE_TASK_STAGES, isActiveTaskCompletedStages, isSafeTaskStages, PROJECT_TASK_ID, SAFE_TASK_ERROR_MESSAGES } from '../contracts/projectTask.js';
import {
  PROJECT_TASK_SQLITE_ERRORS,
  PROJECT_TASK_SQLITE_SCHEMA_VERSION,
  PROJECT_TASK_SQLITE_STAGES,
  initializeProjectTaskSqliteDatabaseV1,
  migrateProjectTaskSqliteDatabaseToCurrent,
} from './projectTaskSqliteSchema.js';
import {
  evaluateProjectGoalCompletion,
  isProjectGoalEvaluationEvidence,
} from './projectCompletionEvaluator.js';
import {
  buildDeterministicContinuationInstruction,
  fingerprintContinuationPlanMeaning,
  isSafeContinuationInstruction,
} from './projectContinuationPlanner.js';

export type ProjectTaskSqliteStoreOptions = {
  databasePath: string;
  maxRecords?: number;
  maxActive?: number;
  terminalTtlMs?: number;
  now?: () => number;
};

type ResolvedProjectTaskSqliteStoreOptions = {
  databasePath: string;
  maxRecords: number;
  maxActive: number;
  terminalTtlMs: number;
  now?: () => number;
};

const STAGES = new Set<string>(PROJECT_TASK_SQLITE_STAGES);
const RECEIPT_STATUSES = new Set<string>(['analyzed', 'ready_for_review', 'verified', 'committed']);
const ERROR_STAGES = new Set<string>(['planning', 'hermes', 'approval', 'codex', 'verification', 'commit']);
const ACTIVE_STAGE_INDEX = new Map<string, number>(
  ACTIVE_TASK_STAGES.map((stage, index) => [stage, index]),
);
const GOAL_STATUSES = new Set<string>(PROJECT_GOAL_STATUSES);
const GOAL_TERMINAL_REASONS = new Set<string>(PROJECT_GOAL_TERMINAL_REASONS);
const EVALUATION_DECISIONS = new Set<string>(PROJECT_GOAL_EVALUATION_DECISIONS);
const EVALUATION_REASON_CODES = new Set<string>(PROJECT_GOAL_EVALUATION_REASON_CODES);
const CONTINUATION_PLAN_REASON_CODES = new Set<string>(PROJECT_GOAL_CONTINUATION_PLAN_REASON_CODES);
const SNAPSHOT_EXECUTION_MODES = new Set<string>(['direct', 'delegated']);
const SNAPSHOT_COMPLETION_MODES = new Set<string>(['analyze', 'ready_for_review', 'complete']);
const SNAPSHOT_BLOCKED_ACTIONS = new Set<string>([
  'push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access',
]);
const RESUME_DECISIONS = new Set<string>(PROJECT_TASK_RESUME_DECISIONS);
const RESUME_REFUSAL_REASONS = new Set<string>(PROJECT_TASK_RESUME_REFUSAL_REASONS);
const AUTONOMY_MODE_SET = new Set<string>(AUTONOMY_MODES);

/** Fingerprint for the durable per-goal autonomy policy: sha256 over meaning (mode + bounds + goal). */
function fingerprintAutonomyPolicy(meaning: ReturnType<typeof autonomyPolicyMeaning>): string {
  return createHash('sha256').update(JSON.stringify({
    ...meaning,
    version: AUTONOMY_POLICY_VERSION,
  })).digest('hex');
}

/** Fingerprint for the durable execution authorization: sha256 over (goal_id, task_id, plan_id, policy_fingerprint). */
function fingerprintExecutionAuthorization(meaning: {
  goalId: string;
  taskId: string;
  planId: string;
  policyFingerprint: string;
}): string {
  return createHash('sha256').update(JSON.stringify({
    ...meaning,
    version: EXECUTION_AUTHORIZATION_VERSION,
  })).digest('hex');
}


type ProjectTaskRow = {
  task_id: unknown;
  fingerprint: unknown;
  intent_json: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  terminal_at: unknown;
  receipt_json: unknown;
  error_json: unknown;
};

type ProjectGoalRow = {
  goal_id: unknown;
  project_id: unknown;
  objective: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  terminal_at: unknown;
  current_attempt: unknown;
  max_attempts: unknown;
  continuation_depth_limit: unknown;
  terminal_reason: unknown;
};

type ProjectTaskLineageRow = {
  task_id: unknown;
  goal_id: unknown;
  parent_task_id: unknown;
  continuation_depth: unknown;
  attempt_number: unknown;
};

type ProjectGoalEvaluationRow = {
  evaluation_id: unknown;
  goal_id: unknown;
  task_id: unknown;
  attempt_number: unknown;
  evaluator_version: unknown;
  decision: unknown;
  reason_code: unknown;
  summary: unknown;
  evidence_fingerprint: unknown;
  created_at: unknown;
  applied_at: unknown;
};

type ProjectGoalContinuationPlanRow = {
  plan_id: unknown;
  goal_id: unknown;
  source_evaluation_id: unknown;
  parent_task_id: unknown;
  parent_attempt_number: unknown;
  next_attempt_number: unknown;
  next_continuation_depth: unknown;
  planner_version: unknown;
  status: unknown;
  instruction: unknown;
  reason_code: unknown;
  fingerprint: unknown;
  source_evidence_fingerprint: unknown;
  created_at: unknown;
  cancelled_at: unknown;
};

type ProjectGoalContinuationApprovalRow = {
  approval_id: unknown;
  plan_id: unknown;
  goal_id: unknown;
  source_evaluation_id: unknown;
  plan_fingerprint: unknown;
  source_evidence_fingerprint: unknown;
  approver: unknown;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
};

type ProjectGoalAutonomyPolicyRow = {
  policy_id: unknown;
  goal_id: unknown;
  mode: unknown;
  suspended_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  max_cycles: unknown;
  elapsed_budget_ms: unknown;
  approver: unknown;
  created_at: unknown;
  updated_at: unknown;
  fingerprint: unknown;
};

type ProjectGoalContinuationExecutionAuthorizationRow = {
  authorization_id: unknown;
  goal_id: unknown;
  task_id: unknown;
  plan_id: unknown;
  policy_fingerprint: unknown;
  approver: unknown;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  consumed_at: unknown;
  fingerprint: unknown;
};

type ProjectTaskLeaseRow = {
  task_id: unknown;
  lease_id: unknown;
  lease_owner: unknown;
  fencing_token: unknown;
  acquired_at: unknown;
  lease_expires_at: unknown;
  released_at: unknown;
};

type ProjectTaskDispatchRow = {
  dispatch_id: unknown;
  task_id: unknown;
  created_at: unknown;
  consumed_at: unknown;
  consumed_lease_id: unknown;
  consumed_fencing_token: unknown;
};

type ProjectTaskExecutionRunRow = {
  execution_run_id: unknown;
  task_id: unknown;
  dispatch_id: unknown;
  preparation_lease_id: unknown;
  preparation_fencing_token: unknown;
  prepared_at: unknown;
};

type ProjectTaskExecutionInvocationRow = {
  invocation_id: unknown;
  execution_run_id: unknown;
  task_id: unknown;
  reservation_lease_id: unknown;
  reservation_fencing_token: unknown;
  reserved_at: unknown;
};

type ProjectTaskExecutionLaunchAttemptRow = {
  launch_attempt_id: unknown;
  invocation_id: unknown;
  execution_run_id: unknown;
  task_id: unknown;
  launch_lease_id: unknown;
  launch_fencing_token: unknown;
  boundary_crossed_at: unknown;
};

type ProjectTaskExecutionLaunchResultRow = {
  launch_result_id: unknown;
  launch_attempt_id: unknown;
  invocation_id: unknown;
  execution_run_id: unknown;
  task_id: unknown;
  outcome_class: unknown;
  recorded_at: unknown;
};

type ProjectTaskValidatedProposalSnapshotRow = {
  snapshot_id: unknown;
  launch_result_id: unknown;
  launch_attempt_id: unknown;
  invocation_id: unknown;
  execution_run_id: unknown;
  task_id: unknown;
  canonical_proposal_json: unknown;
  proposal_sha256: unknown;
  canonical_version: unknown;
  execution_mode: unknown;
  completion_mode: unknown;
  requires_human_approval: unknown;
  blocked_actions_json: unknown;
  recorded_at: unknown;
};

type ProjectTaskResumeDecisionRow = {
  decision_id: unknown;
  task_id: unknown;
  snapshot_id: unknown;
  decision: unknown;
  refusal_reason: unknown;
  policy_fingerprint: unknown;
  recorded_at: unknown;
};

type CodexStartEvidenceRow = {
  codex_start_id: unknown;
  task_id: unknown;
  execution_run_id: unknown;
  invocation_id: unknown;
  launch_attempt_id: unknown;
  launch_result_id: unknown;
  snapshot_id: unknown;
  start_recorded_at: unknown;
};

type CodexResultEvidenceRow = {
  codex_result_id: unknown;
  codex_start_id: unknown;
  execution_id: unknown;
  outcome: unknown;
  success: unknown;
  error: unknown;
  summary: unknown;
  result_metadata_json: unknown;
  result_recorded_at: unknown;
};

type VerificationStartEvidenceRow = {
  verification_start_id: unknown;
  task_id: unknown;
  execution_run_id: unknown;
  invocation_id: unknown;
  launch_attempt_id: unknown;
  launch_result_id: unknown;
  snapshot_id: unknown;
  codex_start_id: unknown;
  execution_id: unknown;
  start_recorded_at: unknown;
};

type VerificationResultEvidenceRow = {
  verification_result_id: unknown;
  verification_start_id: unknown;
  status: unknown;
  checks_passed: unknown;
  total_checks: unknown;
  technical_checks_passed: unknown;
  technical_total_checks: unknown;
  visual_checks_passed: unknown;
  visual_total_checks: unknown;
  failure_error: unknown;
  failure_summary: unknown;
  result_recorded_at: unknown;
};

type CommitStartEvidenceRow = {
  commit_start_id: unknown;
  task_id: unknown;
  execution_run_id: unknown;
  invocation_id: unknown;
  launch_attempt_id: unknown;
  launch_result_id: unknown;
  snapshot_id: unknown;
  codex_start_id: unknown;
  verification_start_id: unknown;
  execution_id: unknown;
  start_recorded_at: unknown;
};

type CommitResultEvidenceRow = {
  commit_result_id: unknown;
  commit_start_id: unknown;
  status: unknown;
  commit_sha: unknown;
  error: unknown;
  summary: unknown;
  result_recorded_at: unknown;
};

type CompletionEvidenceRow = {
  completion_evidence_id: unknown;
  task_id: unknown;
  execution_run_id: unknown;
  invocation_id: unknown;
  launch_attempt_id: unknown;
  launch_result_id: unknown;
  snapshot_id: unknown;
  codex_start_id: unknown;
  verification_start_id: unknown;
  commit_start_id: unknown;
  receipt_json: unknown;
  recorded_at: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Storage-integrity shape check for the frozen canonical proposal JSON. */
function isValidCanonicalProposalJson(value: string): boolean {
  if (value.length < 1 || value.length > 131072) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  return isRecord(parsed);
}

function isSafeTaskReceipt(value: unknown): value is SafeTaskReceipt {
  if (!isRecord(value)) return false;
  if (typeof value.executionId !== 'string' || value.executionId === '') return false;
  if (typeof value.status !== 'string' || !RECEIPT_STATUSES.has(value.status)) return false;
  if (typeof value.resultText !== 'string') return false;

  if (value.verification !== undefined) {
    if (!isRecord(value.verification) || value.verification.status !== 'verified') return false;
    const checksPassed = value.verification.checksPassed;
    const totalChecks = value.verification.totalChecks;
    if (!isNonNegativeInteger(checksPassed) || !isNonNegativeInteger(totalChecks)) return false;
    if (checksPassed > totalChecks) return false;
  }

  if (value.commit !== undefined && typeof value.commit !== 'string') return false;
  if (value.stages !== undefined && !isSafeTaskStages(value.stages)) return false;
  return true;
}

function isSafeTaskError(value: unknown): value is SafeTaskError {
  if (!isRecord(value)) return false;
  if (typeof value.code !== 'string' || !Object.hasOwn(SAFE_TASK_ERROR_MESSAGES, value.code)) return false;
  if (typeof value.message !== 'string' || value.message === '') return false;
  if (value.stage !== undefined && (typeof value.stage !== 'string' || !ERROR_STAGES.has(value.stage))) return false;
  if (value.projectId !== undefined && typeof value.projectId !== 'string') return false;
  if (value.executionId !== undefined && typeof value.executionId !== 'string') return false;
  if (value.completedStages !== undefined && !isSafeTaskStages(value.completedStages)) return false;
  return true;
}

/**
 * Durable ProjectTaskStore backed by node:sqlite.
 *
 * The store keeps one DatabaseSync connection open for its lifetime (the
 * interface is synchronous and the router calls it from a single-threaded
 * event loop, so per-operation open/close would only add cost and failure
 * points). Callers must invoke close() when the store is no longer needed;
 * every operation after close() fails closed.
 */
export class ProjectTaskSqliteStore implements ProjectTaskStore, ProjectTaskReconciler, ProjectTaskRestartSafeReconciler, ProjectGoalStore, ProjectGoalEvaluationStore, ProjectGoalContinuationPlanStore, ProjectGoalContinuationApprovalStore, ProjectContinuationRuntime, ProjectGoalAutonomyPolicyStore, ProjectGoalContinuationExecutionAuthorizationStore, ProjectTaskLeaseStore, ProjectTaskDispatchStore, ProjectTaskExecutionRunStore, ProjectTaskExecutionInvocationStore, ProjectTaskExecutionLaunchAttemptStore, ProjectTaskExecutionLaunchResultStore, ProjectTaskValidatedProposalSnapshotStore, ProjectTaskResumeDecisionStore, ProjectTaskCodexEvidenceStore, ProjectTaskVerificationEvidenceStore, ProjectTaskCommitEvidenceStore, ProjectTaskCompletionEvidenceStore {
  private readonly options: ResolvedProjectTaskSqliteStoreOptions;
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(options: ProjectTaskSqliteStoreOptions) {
    const { databasePath } = options;
    if (!isAbsolute(databasePath) || databasePath.includes('\0')) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.invalidPath);
    }

    this.options = { maxRecords: 200, maxActive: 8, terminalTtlMs: 86_400_000, ...options };

    // Bootstrap a missing file privately (0600) with the versioned schema.
    // An existing file is left untouched and validated strictly instead.
    let created = false;
    try {
      initializeProjectTaskSqliteDatabaseV1(databasePath);
      created = true;
    } catch (error) {
      if (!(error instanceof Error && error.message === PROJECT_TASK_SQLITE_ERRORS.alreadyExists)) {
        throw error;
      }
    }

    let database: DatabaseSync;
    try {
      database = new DatabaseSync(databasePath);
    } catch (error) {
      if (created) {
        try {
          unlinkSync(databasePath);
        } catch {
          // Preserve the original initialization error.
        }
      }
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }

    this.database = database;

    try {
      this.database.exec('PRAGMA foreign_keys = ON');
      this.database.exec('PRAGMA busy_timeout = 5000');
      migrateProjectTaskSqliteDatabaseToCurrent(this.database);
      this.assertSchemaCompatible();
    } catch (error) {
      try {
        this.database.close();
      } catch {
        // Preserve the original initialization error.
      }

      if (created) {
        try {
          unlinkSync(databasePath);
        } catch {
          // Preserve the original initialization error.
        }
      }

      throw error;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.closed);
    }
  }

  private assertSchemaCompatible(): void {
    let metaRows: Array<{ singleton: unknown; schema_version: unknown }>;
    try {
      metaRows = this.database
        .prepare('SELECT singleton, schema_version FROM project_task_meta WHERE singleton = 1')
        .all() as unknown as typeof metaRows;
    } catch {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }

    if (metaRows.length !== 1) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }

    const [meta] = metaRows;
    if (meta.singleton !== 1 || meta.schema_version !== PROJECT_TASK_SQLITE_SCHEMA_VERSION) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }

    try {
      this.database.prepare('SELECT task_id FROM project_tasks LIMIT 1').all();
      this.database.prepare(
        'SELECT task_id, completed_stages_json FROM project_task_active_stage_traces LIMIT 1',
      ).all();
      this.database.prepare('SELECT goal_id FROM project_goals LIMIT 1').all();
      this.database.prepare(
        'SELECT task_id, goal_id, parent_task_id, continuation_depth, attempt_number FROM project_task_lineage LIMIT 1',
      ).all();
      this.database.prepare(
        'SELECT evaluation_id, goal_id, task_id, evaluator_version FROM project_goal_evaluations LIMIT 1',
      ).all();
      this.database.prepare(
        'SELECT plan_id, goal_id, source_evaluation_id, planner_version FROM project_goal_continuation_plans LIMIT 1',
      ).all();
      this.database.prepare(
        'SELECT plan_id, created_task_id, consumed_at FROM project_goal_continuation_consumptions LIMIT 1',
      ).all();
      this.database.prepare(
        'SELECT approval_id, plan_id, goal_id, source_evaluation_id, plan_fingerprint, source_evidence_fingerprint, approver, created_at, expires_at, revoked_at FROM project_goal_continuation_approvals LIMIT 1',
      ).all();
      this.database.prepare(
        'SELECT policy_id, goal_id, mode, suspended_at, expires_at, revoked_at, max_cycles, elapsed_budget_ms, approver, created_at, updated_at, fingerprint FROM project_goal_autonomy_policies LIMIT 1',
      ).all();
      this.database.prepare(
        'SELECT authorization_id, goal_id, task_id, plan_id, policy_fingerprint, approver, created_at, expires_at, revoked_at, consumed_at, fingerprint FROM project_goal_continuation_execution_authorizations LIMIT 1',
      ).all();
      this.database.prepare(`
        SELECT task_id, lease_id, lease_owner, fencing_token, acquired_at,
               lease_expires_at, released_at
        FROM project_task_lease_generations LIMIT 1
      `).all();
      this.database.prepare(`
        SELECT dispatch_id, task_id, created_at, consumed_at,
               consumed_lease_id, consumed_fencing_token
        FROM project_task_dispatch_outbox LIMIT 1
      `).all();
      this.database.prepare(`
        SELECT execution_run_id, task_id, dispatch_id, preparation_lease_id,
               preparation_fencing_token, prepared_at
        FROM project_task_execution_runs LIMIT 1
      `).all();
      this.database.prepare(`
        SELECT invocation_id, execution_run_id, task_id, reservation_lease_id,
               reservation_fencing_token, reserved_at
        FROM project_task_execution_invocations LIMIT 1
      `).all();
      this.database.prepare(`
        SELECT launch_attempt_id, invocation_id, execution_run_id, task_id,
               launch_lease_id, launch_fencing_token, boundary_crossed_at
        FROM project_task_execution_launch_attempts LIMIT 1
      `).all();
      this.database.prepare(`
        SELECT launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
               task_id, outcome_class, recorded_at
        FROM project_task_execution_launch_results LIMIT 1
      `).all();
      this.database.prepare(`
        SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
               execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
               canonical_version, execution_mode, completion_mode,
               requires_human_approval, blocked_actions_json, recorded_at
        FROM project_task_validated_proposal_snapshots LIMIT 1
      `).all();
      this.database.prepare(`
        SELECT decision_id, task_id, snapshot_id, decision, refusal_reason,
               policy_fingerprint, recorded_at
        FROM project_task_resume_decisions LIMIT 1
      `).all();
    } catch {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.schema);
    }
  }

  private inTransaction<T>(operation: () => T): T {
    this.requireOpen();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  private pruneExpiredTerminals(): void {
    this.database.prepare(`
      DELETE FROM project_tasks
      WHERE terminal_at IS NOT NULL
        AND ? - terminal_at >= ?
        AND task_id NOT IN (SELECT task_id FROM project_task_lineage)
        AND task_id NOT IN (SELECT task_id FROM project_task_dispatch_outbox)
        AND task_id NOT IN (SELECT task_id FROM project_task_validated_proposal_snapshots)
        AND task_id NOT IN (SELECT task_id FROM project_task_resume_decisions)
    `).run(this.now(), this.options.terminalTtlMs);

    this.database.prepare(`
      DELETE FROM project_task_active_stage_traces
      WHERE task_id NOT IN (SELECT task_id FROM project_tasks)
    `).run();
  }

  private selectRow(taskId: string): ProjectTaskRow | undefined {
    return this.database.prepare(`
      SELECT task_id, fingerprint, intent_json, status, created_at, updated_at, terminal_at, receipt_json, error_json
      FROM project_tasks
      WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskRow | undefined;
  }

  private selectCurrentLeaseRow(taskId: string): ProjectTaskLeaseRow | undefined {
    return this.database.prepare(`
      SELECT task_id, lease_id, lease_owner, fencing_token, acquired_at,
             lease_expires_at, released_at
      FROM project_task_lease_generations
      WHERE task_id = ? AND released_at IS NULL
    `).get(taskId) as unknown as ProjectTaskLeaseRow | undefined;
  }

  private selectLeaseGenerationRow(
    taskId: string,
    leaseId: string,
    fencingToken: number,
  ): ProjectTaskLeaseRow | undefined {
    return this.database.prepare(`
      SELECT task_id, lease_id, lease_owner, fencing_token, acquired_at,
             lease_expires_at, released_at
      FROM project_task_lease_generations
      WHERE task_id = ? AND lease_id = ? AND fencing_token = ?
    `).get(taskId, leaseId, fencingToken) as unknown as ProjectTaskLeaseRow | undefined;
  }

  private selectDispatchRow(dispatchId: string): ProjectTaskDispatchRow | undefined {
    return this.database.prepare(`
      SELECT dispatch_id, task_id, created_at, consumed_at,
             consumed_lease_id, consumed_fencing_token
      FROM project_task_dispatch_outbox WHERE dispatch_id = ?
    `).get(dispatchId) as unknown as ProjectTaskDispatchRow | undefined;
  }

  private selectExecutionRunRow(executionRunId: string): ProjectTaskExecutionRunRow | undefined {
    return this.database.prepare(`
      SELECT execution_run_id, task_id, dispatch_id, preparation_lease_id,
             preparation_fencing_token, prepared_at
      FROM project_task_execution_runs WHERE execution_run_id = ?
    `).get(executionRunId) as unknown as ProjectTaskExecutionRunRow | undefined;
  }

  private selectExecutionRunByTaskRow(taskId: string): ProjectTaskExecutionRunRow | undefined {
    return this.database.prepare(`
      SELECT execution_run_id, task_id, dispatch_id, preparation_lease_id,
             preparation_fencing_token, prepared_at
      FROM project_task_execution_runs WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskExecutionRunRow | undefined;
  }

  private selectExecutionInvocationRow(
    invocationId: string,
  ): ProjectTaskExecutionInvocationRow | undefined {
    return this.database.prepare(`
      SELECT invocation_id, execution_run_id, task_id, reservation_lease_id,
             reservation_fencing_token, reserved_at
      FROM project_task_execution_invocations WHERE invocation_id = ?
    `).get(invocationId) as unknown as ProjectTaskExecutionInvocationRow | undefined;
  }

  private selectExecutionInvocationByRunRow(
    executionRunId: string,
  ): ProjectTaskExecutionInvocationRow | undefined {
    return this.database.prepare(`
      SELECT invocation_id, execution_run_id, task_id, reservation_lease_id,
             reservation_fencing_token, reserved_at
      FROM project_task_execution_invocations WHERE execution_run_id = ?
    `).get(executionRunId) as unknown as ProjectTaskExecutionInvocationRow | undefined;
  }

  private selectExecutionInvocationByTaskRow(
    taskId: string,
  ): ProjectTaskExecutionInvocationRow | undefined {
    return this.database.prepare(`
      SELECT invocation_id, execution_run_id, task_id, reservation_lease_id,
             reservation_fencing_token, reserved_at
      FROM project_task_execution_invocations WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskExecutionInvocationRow | undefined;
  }

  private selectLaunchAttemptRow(
    launchAttemptId: string,
  ): ProjectTaskExecutionLaunchAttemptRow | undefined {
    return this.database.prepare(`
      SELECT launch_attempt_id, invocation_id, execution_run_id, task_id,
             launch_lease_id, launch_fencing_token, boundary_crossed_at
      FROM project_task_execution_launch_attempts WHERE launch_attempt_id = ?
    `).get(launchAttemptId) as unknown as ProjectTaskExecutionLaunchAttemptRow | undefined;
  }

  private selectLaunchAttemptByInvocationRow(
    invocationId: string,
  ): ProjectTaskExecutionLaunchAttemptRow | undefined {
    return this.database.prepare(`
      SELECT launch_attempt_id, invocation_id, execution_run_id, task_id,
             launch_lease_id, launch_fencing_token, boundary_crossed_at
      FROM project_task_execution_launch_attempts WHERE invocation_id = ?
    `).get(invocationId) as unknown as ProjectTaskExecutionLaunchAttemptRow | undefined;
  }

  private selectLaunchAttemptByRunRow(
    executionRunId: string,
  ): ProjectTaskExecutionLaunchAttemptRow | undefined {
    return this.database.prepare(`
      SELECT launch_attempt_id, invocation_id, execution_run_id, task_id,
             launch_lease_id, launch_fencing_token, boundary_crossed_at
      FROM project_task_execution_launch_attempts WHERE execution_run_id = ?
    `).get(executionRunId) as unknown as ProjectTaskExecutionLaunchAttemptRow | undefined;
  }

  private selectLaunchAttemptByTaskRow(
    taskId: string,
  ): ProjectTaskExecutionLaunchAttemptRow | undefined {
    return this.database.prepare(`
      SELECT launch_attempt_id, invocation_id, execution_run_id, task_id,
             launch_lease_id, launch_fencing_token, boundary_crossed_at
      FROM project_task_execution_launch_attempts WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskExecutionLaunchAttemptRow | undefined;
  }

  private selectLaunchResultRow(
    launchResultId: string,
  ): ProjectTaskExecutionLaunchResultRow | undefined {
    return this.database.prepare(`
      SELECT launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
             task_id, outcome_class, recorded_at
      FROM project_task_execution_launch_results WHERE launch_result_id = ?
    `).get(launchResultId) as unknown as ProjectTaskExecutionLaunchResultRow | undefined;
  }

  private selectLaunchResultByAttemptRow(
    launchAttemptId: string,
  ): ProjectTaskExecutionLaunchResultRow | undefined {
    return this.database.prepare(`
      SELECT launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
             task_id, outcome_class, recorded_at
      FROM project_task_execution_launch_results WHERE launch_attempt_id = ?
    `).get(launchAttemptId) as unknown as ProjectTaskExecutionLaunchResultRow | undefined;
  }

  private selectLaunchResultByInvocationRow(
    invocationId: string,
  ): ProjectTaskExecutionLaunchResultRow | undefined {
    return this.database.prepare(`
      SELECT launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
             task_id, outcome_class, recorded_at
      FROM project_task_execution_launch_results WHERE invocation_id = ?
    `).get(invocationId) as unknown as ProjectTaskExecutionLaunchResultRow | undefined;
  }

  private selectLaunchResultByRunRow(
    executionRunId: string,
  ): ProjectTaskExecutionLaunchResultRow | undefined {
    return this.database.prepare(`
      SELECT launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
             task_id, outcome_class, recorded_at
      FROM project_task_execution_launch_results WHERE execution_run_id = ?
    `).get(executionRunId) as unknown as ProjectTaskExecutionLaunchResultRow | undefined;
  }

  private selectLaunchResultByTaskRow(
    taskId: string,
  ): ProjectTaskExecutionLaunchResultRow | undefined {
    return this.database.prepare(`
      SELECT launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
             task_id, outcome_class, recorded_at
      FROM project_task_execution_launch_results WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskExecutionLaunchResultRow | undefined;
  }

  private selectValidatedProposalSnapshotRow(
    snapshotId: string,
  ): ProjectTaskValidatedProposalSnapshotRow | undefined {
    return this.database.prepare(`
      SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
             execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
             canonical_version, execution_mode, completion_mode,
             requires_human_approval, blocked_actions_json, recorded_at
      FROM project_task_validated_proposal_snapshots WHERE snapshot_id = ?
    `).get(snapshotId) as unknown as ProjectTaskValidatedProposalSnapshotRow | undefined;
  }

  private selectValidatedProposalSnapshotByLaunchResultRow(
    launchResultId: string,
  ): ProjectTaskValidatedProposalSnapshotRow | undefined {
    return this.database.prepare(`
      SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
             execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
             canonical_version, execution_mode, completion_mode,
             requires_human_approval, blocked_actions_json, recorded_at
      FROM project_task_validated_proposal_snapshots WHERE launch_result_id = ?
    `).get(launchResultId) as unknown as ProjectTaskValidatedProposalSnapshotRow | undefined;
  }

  private selectValidatedProposalSnapshotByLaunchAttemptRow(
    launchAttemptId: string,
  ): ProjectTaskValidatedProposalSnapshotRow | undefined {
    return this.database.prepare(`
      SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
             execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
             canonical_version, execution_mode, completion_mode,
             requires_human_approval, blocked_actions_json, recorded_at
      FROM project_task_validated_proposal_snapshots WHERE launch_attempt_id = ?
    `).get(launchAttemptId) as unknown as ProjectTaskValidatedProposalSnapshotRow | undefined;
  }

  private selectValidatedProposalSnapshotByInvocationRow(
    invocationId: string,
  ): ProjectTaskValidatedProposalSnapshotRow | undefined {
    return this.database.prepare(`
      SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
             execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
             canonical_version, execution_mode, completion_mode,
             requires_human_approval, blocked_actions_json, recorded_at
      FROM project_task_validated_proposal_snapshots WHERE invocation_id = ?
    `).get(invocationId) as unknown as ProjectTaskValidatedProposalSnapshotRow | undefined;
  }

  private selectValidatedProposalSnapshotByExecutionRunRow(
    executionRunId: string,
  ): ProjectTaskValidatedProposalSnapshotRow | undefined {
    return this.database.prepare(`
      SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
             execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
             canonical_version, execution_mode, completion_mode,
             requires_human_approval, blocked_actions_json, recorded_at
      FROM project_task_validated_proposal_snapshots WHERE execution_run_id = ?
    `).get(executionRunId) as unknown as ProjectTaskValidatedProposalSnapshotRow | undefined;
  }

  private selectValidatedProposalSnapshotByTaskRow(
    taskId: string,
  ): ProjectTaskValidatedProposalSnapshotRow | undefined {
    return this.database.prepare(`
      SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
             execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
             canonical_version, execution_mode, completion_mode,
             requires_human_approval, blocked_actions_json, recorded_at
      FROM project_task_validated_proposal_snapshots WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskValidatedProposalSnapshotRow | undefined;
  }

  private decodeDispatchRow(row: ProjectTaskDispatchRow): ProjectTaskDispatchRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_DISPATCH_ERRORS.corruptRecord);
    if (typeof row.dispatch_id !== 'string' || !PROJECT_TASK_ID.test(row.dispatch_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (!isNonNegativeInteger(row.created_at) || !Number.isSafeInteger(row.created_at)) throw corrupt();
    const pending = row.consumed_at === null
      && row.consumed_lease_id === null
      && row.consumed_fencing_token === null;
    const consumed = isNonNegativeInteger(row.consumed_at)
      && Number.isSafeInteger(row.consumed_at)
      && row.consumed_at >= row.created_at
      && typeof row.consumed_lease_id === 'string'
      && PROJECT_TASK_ID.test(row.consumed_lease_id)
      && typeof row.consumed_fencing_token === 'number'
      && Number.isSafeInteger(row.consumed_fencing_token)
      && row.consumed_fencing_token >= PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN;
    if (!pending && !consumed) throw corrupt();
    return {
      dispatchId: row.dispatch_id,
      taskId: row.task_id,
      createdAt: row.created_at,
      ...(consumed ? {
        consumedAt: row.consumed_at as number,
        consumedLeaseId: row.consumed_lease_id as string,
        consumedFencingToken: row.consumed_fencing_token as number,
      } : {}),
    };
  }

  private decodeExecutionRunRow(row: ProjectTaskExecutionRunRow): ProjectTaskExecutionRunRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.corruptRecord);
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.dispatch_id !== 'string' || !PROJECT_TASK_ID.test(row.dispatch_id)) throw corrupt();
    if (typeof row.preparation_lease_id !== 'string' || !PROJECT_TASK_ID.test(row.preparation_lease_id)) throw corrupt();
    if (
      typeof row.preparation_fencing_token !== 'number'
      || !Number.isSafeInteger(row.preparation_fencing_token)
      || row.preparation_fencing_token < PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN
      || !isNonNegativeInteger(row.prepared_at)
      || !Number.isSafeInteger(row.prepared_at)
    ) throw corrupt();

    const dispatchRow = this.selectDispatchRow(row.dispatch_id);
    if (dispatchRow === undefined) throw corrupt();
    const dispatch = this.decodeDispatchRow(dispatchRow);
    if (
      dispatch.taskId !== row.task_id
      || dispatch.consumedAt !== row.prepared_at
      || dispatch.consumedLeaseId !== row.preparation_lease_id
      || dispatch.consumedFencingToken !== row.preparation_fencing_token
    ) throw corrupt();
    const leaseRow = this.selectLeaseGenerationRow(
      row.task_id,
      row.preparation_lease_id,
      row.preparation_fencing_token,
    );
    if (leaseRow === undefined) throw corrupt();
    const lease = this.decodeLeaseRow(leaseRow);
    if (row.prepared_at < lease.acquiredAt || row.prepared_at >= lease.leaseExpiresAt) throw corrupt();

    return {
      executionRunId: row.execution_run_id,
      taskId: row.task_id,
      dispatchId: row.dispatch_id,
      preparationLeaseId: row.preparation_lease_id,
      preparationFencingToken: row.preparation_fencing_token,
      preparedAt: row.prepared_at,
    };
  }

  private decodeExecutionInvocationRow(
    row: ProjectTaskExecutionInvocationRow,
  ): ProjectTaskExecutionInvocationRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.corruptRecord);
    if (typeof row.invocation_id !== 'string' || !PROJECT_TASK_ID.test(row.invocation_id)) throw corrupt();
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.reservation_lease_id !== 'string' || !PROJECT_TASK_ID.test(row.reservation_lease_id)) throw corrupt();
    if (
      typeof row.reservation_fencing_token !== 'number'
      || !Number.isSafeInteger(row.reservation_fencing_token)
      || row.reservation_fencing_token < PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN
      || !isNonNegativeInteger(row.reserved_at)
      || !Number.isSafeInteger(row.reserved_at)
    ) throw corrupt();

    const executionRunRow = this.selectExecutionRunRow(row.execution_run_id);
    if (executionRunRow === undefined) throw corrupt();
    const executionRun = this.decodeExecutionRunRow(executionRunRow);
    if (executionRun.taskId !== row.task_id) throw corrupt();
    const leaseRow = this.selectLeaseGenerationRow(
      row.task_id,
      row.reservation_lease_id,
      row.reservation_fencing_token,
    );
    if (leaseRow === undefined) throw corrupt();
    const lease = this.decodeLeaseRow(leaseRow);
    const releasedAt = leaseRow.released_at;
    if (
      row.reserved_at < lease.acquiredAt
      || row.reserved_at >= lease.leaseExpiresAt
      || (typeof releasedAt === 'number' && row.reserved_at > releasedAt)
    ) throw corrupt();

    return {
      invocationId: row.invocation_id,
      executionRunId: row.execution_run_id,
      taskId: row.task_id,
      reservationLeaseId: row.reservation_lease_id,
      reservationFencingToken: row.reservation_fencing_token,
      reservedAt: row.reserved_at,
    };
  }

  private decodeLaunchAttemptRow(
    row: ProjectTaskExecutionLaunchAttemptRow,
  ): ProjectTaskExecutionLaunchAttemptRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.corruptRecord);
    if (typeof row.launch_attempt_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_attempt_id)) throw corrupt();
    if (typeof row.invocation_id !== 'string' || !PROJECT_TASK_ID.test(row.invocation_id)) throw corrupt();
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.launch_lease_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_lease_id)) throw corrupt();
    if (
      typeof row.launch_fencing_token !== 'number'
      || !Number.isSafeInteger(row.launch_fencing_token)
      || row.launch_fencing_token < PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN
      || !isNonNegativeInteger(row.boundary_crossed_at)
      || !Number.isSafeInteger(row.boundary_crossed_at)
    ) throw corrupt();

    const taskRow = this.selectRow(row.task_id);
    if (taskRow === undefined) throw corrupt();
    const invocationRow = this.selectExecutionInvocationRow(row.invocation_id);
    if (invocationRow === undefined) throw corrupt();
    const invocation = this.decodeExecutionInvocationRow(invocationRow);
    if (
      invocation.executionRunId !== row.execution_run_id
      || invocation.taskId !== row.task_id
    ) throw corrupt();
    const executionRunRow = this.selectExecutionRunRow(row.execution_run_id);
    if (executionRunRow === undefined) throw corrupt();
    const executionRun = this.decodeExecutionRunRow(executionRunRow);
    if (executionRun.taskId !== row.task_id) throw corrupt();
    const leaseRow = this.selectLeaseGenerationRow(
      row.task_id,
      row.launch_lease_id,
      row.launch_fencing_token,
    );
    if (leaseRow === undefined) throw corrupt();
    const lease = this.decodeLeaseRow(leaseRow);
    const releasedAt = leaseRow.released_at;
    if (
      row.boundary_crossed_at < lease.acquiredAt
      || row.boundary_crossed_at >= lease.leaseExpiresAt
      || (typeof releasedAt === 'number' && row.boundary_crossed_at > releasedAt)
    ) throw corrupt();

    return {
      launchAttemptId: row.launch_attempt_id,
      invocationId: row.invocation_id,
      executionRunId: row.execution_run_id,
      taskId: row.task_id,
      launchLeaseId: row.launch_lease_id,
      launchFencingToken: row.launch_fencing_token,
      boundaryCrossedAt: row.boundary_crossed_at,
    };
  }

  private decodeLaunchResultRow(
    row: ProjectTaskExecutionLaunchResultRow,
  ): ProjectTaskExecutionLaunchResultRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.corruptRecord);
    if (typeof row.launch_result_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_result_id)) throw corrupt();
    if (typeof row.launch_attempt_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_attempt_id)) throw corrupt();
    if (typeof row.invocation_id !== 'string' || !PROJECT_TASK_ID.test(row.invocation_id)) throw corrupt();
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (
      typeof row.outcome_class !== 'string'
      || !PROJECT_TASK_EXECUTION_LAUNCH_RESULT_OUTCOME_SET.has(row.outcome_class)
    ) throw corrupt();
    if (
      typeof row.recorded_at !== 'number'
      || !Number.isSafeInteger(row.recorded_at)
      || row.recorded_at < 0
    ) throw corrupt();

    const attemptRow = this.selectLaunchAttemptRow(row.launch_attempt_id);
    if (attemptRow === undefined) throw corrupt();
    const attempt = this.decodeLaunchAttemptRow(attemptRow);
    if (
      attempt.invocationId !== row.invocation_id
      || attempt.executionRunId !== row.execution_run_id
      || attempt.taskId !== row.task_id
      || row.recorded_at < attempt.boundaryCrossedAt
    ) throw corrupt();
    const invocationRow = this.selectExecutionInvocationRow(row.invocation_id);
    if (invocationRow === undefined) throw corrupt();
    const invocation = this.decodeExecutionInvocationRow(invocationRow);
    if (
      invocation.executionRunId !== row.execution_run_id
      || invocation.taskId !== row.task_id
    ) throw corrupt();
    const executionRunRow = this.selectExecutionRunRow(row.execution_run_id);
    if (executionRunRow === undefined) throw corrupt();
    const executionRun = this.decodeExecutionRunRow(executionRunRow);
    if (executionRun.taskId !== row.task_id) throw corrupt();
    const taskRow = this.selectRow(row.task_id);
    if (taskRow === undefined) throw corrupt();

    return {
      launchResultId: row.launch_result_id,
      launchAttemptId: row.launch_attempt_id,
      invocationId: row.invocation_id,
      executionRunId: row.execution_run_id,
      taskId: row.task_id,
      outcomeClass: row.outcome_class as ProjectTaskExecutionLaunchResultOutcome,
      recordedAt: row.recorded_at,
    };
  }

  private decodeValidatedProposalSnapshotRow(
    row: ProjectTaskValidatedProposalSnapshotRow,
  ): ProjectTaskValidatedProposalSnapshotRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.corruptRecord);
    if (typeof row.snapshot_id !== 'string' || !PROJECT_TASK_ID.test(row.snapshot_id)) throw corrupt();
    if (typeof row.launch_result_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_result_id)) throw corrupt();
    if (typeof row.launch_attempt_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_attempt_id)) throw corrupt();
    if (typeof row.invocation_id !== 'string' || !PROJECT_TASK_ID.test(row.invocation_id)) throw corrupt();
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.canonical_proposal_json !== 'string' || !isValidCanonicalProposalJson(row.canonical_proposal_json)) {
      throw corrupt();
    }
    if (typeof row.proposal_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.proposal_sha256)) throw corrupt();
    if (row.canonical_version !== PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION) throw corrupt();
    if (typeof row.execution_mode !== 'string' || !SNAPSHOT_EXECUTION_MODES.has(row.execution_mode)) throw corrupt();
    if (typeof row.completion_mode !== 'string' || !SNAPSHOT_COMPLETION_MODES.has(row.completion_mode)) throw corrupt();
    if (row.requires_human_approval !== 0 && row.requires_human_approval !== 1) throw corrupt();
    const blockedActions = this.decodeBlockedActionsJson(row.blocked_actions_json);
    if (
      typeof row.recorded_at !== 'number'
      || !Number.isSafeInteger(row.recorded_at)
      || row.recorded_at < 0
    ) throw corrupt();

    const resultRow = this.selectLaunchResultRow(row.launch_result_id);
    if (resultRow === undefined) throw corrupt();
    const result = this.decodeLaunchResultRow(resultRow);
    if (
      result.outcomeClass !== 'proposal_valid'
      || result.launchAttemptId !== row.launch_attempt_id
      || result.invocationId !== row.invocation_id
      || result.executionRunId !== row.execution_run_id
      || result.taskId !== row.task_id
      || row.recorded_at < result.recordedAt
    ) throw corrupt();
    // decodeLaunchResultRow already verified the full attempt -> invocation ->
    // run -> task lineage chain of the referenced result.
    const taskRow = this.selectRow(row.task_id);
    if (taskRow === undefined) throw corrupt();

    return {
      snapshotId: row.snapshot_id,
      launchResultId: row.launch_result_id,
      launchAttemptId: row.launch_attempt_id,
      invocationId: row.invocation_id,
      executionRunId: row.execution_run_id,
      taskId: row.task_id,
      canonicalProposalJson: row.canonical_proposal_json,
      proposalSha256: row.proposal_sha256,
      canonicalVersion: row.canonical_version,
      executionMode: row.execution_mode as ProjectOrchestrationExecutionMode,
      completionMode: row.completion_mode as AutonomousV1CompletionMode,
      requiresHumanApproval: row.requires_human_approval === 1,
      blockedActions,
      recordedAt: row.recorded_at,
    };
  }

  private decodeBlockedActionsJson(value: unknown): ProjectTaskBlockedCapability[] {
    const corrupt = (): Error => new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.corruptRecord);
    if (typeof value !== 'string' || value.length < 2 || value.length > 512) throw corrupt();
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw corrupt();
    }
    if (!Array.isArray(parsed)) throw corrupt();
    const actions: ProjectTaskBlockedCapability[] = [];
    for (const action of parsed) {
      if (typeof action !== 'string' || !SNAPSHOT_BLOCKED_ACTIONS.has(action)) throw corrupt();
      if (actions.includes(action as ProjectTaskBlockedCapability)) throw corrupt();
      actions.push(action as ProjectTaskBlockedCapability);
    }
    return actions;
  }

  private decodeLeaseRow(row: ProjectTaskLeaseRow): ProjectTaskLeaseRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_LEASE_ERRORS.corruptRecord);
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.lease_id !== 'string' || !PROJECT_TASK_ID.test(row.lease_id)) throw corrupt();
    if (
      typeof row.lease_owner !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(row.lease_owner)
    ) throw corrupt();
    if (
      typeof row.fencing_token !== 'number'
      || !Number.isSafeInteger(row.fencing_token)
      || row.fencing_token < PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN
    ) throw corrupt();
    if (
      typeof row.acquired_at !== 'number'
      || !Number.isSafeInteger(row.acquired_at)
      || row.acquired_at < 0
      || typeof row.lease_expires_at !== 'number'
      || !Number.isSafeInteger(row.lease_expires_at)
      || row.lease_expires_at <= row.acquired_at
      || (row.released_at !== null && (
        typeof row.released_at !== 'number'
        || !Number.isSafeInteger(row.released_at)
        || row.released_at < row.acquired_at
      ))
    ) throw corrupt();
    return {
      taskId: row.task_id,
      leaseOwner: row.lease_owner,
      leaseId: row.lease_id,
      fencingToken: row.fencing_token,
      acquiredAt: row.acquired_at,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  private validateLeaseOwner(leaseOwner: unknown): leaseOwner is string {
    return typeof leaseOwner === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(leaseOwner);
  }

  private validLeaseDuration(durationMs: unknown): durationMs is number {
    return typeof durationMs === 'number'
      && Number.isSafeInteger(durationMs)
      && durationMs >= PROJECT_TASK_LEASE_MIN_DURATION_MS
      && durationMs <= PROJECT_TASK_LEASE_MAX_DURATION_MS;
  }

  private validLeaseAuthority(authority: unknown): authority is ProjectTaskLeaseAuthority {
    if (!isRecord(authority)) return false;
    const keys = Object.keys(authority);
    return keys.length === 4
      && keys.every((key) => ['taskId', 'leaseOwner', 'leaseId', 'fencingToken'].includes(key))
      && typeof authority.taskId === 'string'
      && PROJECT_TASK_ID.test(authority.taskId)
      && this.validateLeaseOwner(authority.leaseOwner)
      && typeof authority.leaseId === 'string'
      && PROJECT_TASK_ID.test(authority.leaseId)
      && typeof authority.fencingToken === 'number'
      && Number.isSafeInteger(authority.fencingToken)
      && authority.fencingToken >= PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN;
  }

  private leaseAuthorityMatches(
    lease: ProjectTaskLeaseRecord,
    authority: ProjectTaskLeaseAuthority,
  ): boolean {
    return lease.taskId === authority.taskId
      && lease.leaseOwner === authority.leaseOwner
      && lease.leaseId === authority.leaseId
      && lease.fencingToken === authority.fencingToken;
  }

  /** Lease V1 acquisition logic for callers already holding BEGIN IMMEDIATE. */
  private acquireTaskLeaseInTransaction(
    input: AcquireProjectTaskLeaseInput,
  ): ProjectTaskLeaseRecord {
    if (!isRecord(input)) throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
    const keys = Object.keys(input);
    if (
      keys.length !== 3
      || !keys.every((key) => ['taskId', 'leaseOwner', 'durationMs'].includes(key))
      || typeof input.taskId !== 'string'
      || !PROJECT_TASK_ID.test(input.taskId)
      || !this.validateLeaseOwner(input.leaseOwner)
      || !this.validLeaseDuration(input.durationMs)
    ) throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);

    const task = this.selectRow(input.taskId);
    if (task === undefined) throw new Error(PROJECT_TASK_LEASE_ERRORS.taskNotFound);
    if (task.terminal_at !== null) throw new Error(PROJECT_TASK_LEASE_ERRORS.taskTerminal);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - input.durationMs) {
      throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
    }

    const currentRow = this.selectCurrentLeaseRow(input.taskId);
    if (currentRow !== undefined) {
      const current = this.decodeLeaseRow(currentRow);
      if (now < current.leaseExpiresAt) {
        if (current.leaseOwner === input.leaseOwner) return current;
        throw new Error(PROJECT_TASK_LEASE_ERRORS.unavailable);
      }
      const released = this.database.prepare(`
        UPDATE project_task_lease_generations SET released_at = ?
        WHERE task_id = ? AND lease_id = ? AND fencing_token = ? AND released_at IS NULL
      `).run(Math.max(now, current.acquiredAt), input.taskId, current.leaseId, current.fencingToken);
      if (Number(released.changes) !== 1) throw new Error(PROJECT_TASK_LEASE_ERRORS.stale);
    }

    const counter = this.database.prepare(`
      SELECT MAX(fencing_token) AS last_token
      FROM project_task_lease_generations WHERE task_id = ?
    `).get(input.taskId) as unknown as { last_token: unknown };
    if (
      counter.last_token !== null
      && (typeof counter.last_token !== 'number'
        || !Number.isSafeInteger(counter.last_token)
        || counter.last_token < PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN)
    ) throw new Error(PROJECT_TASK_LEASE_ERRORS.corruptRecord);
    const fencingToken = counter.last_token === null
      ? PROJECT_TASK_LEASE_INITIAL_FENCING_TOKEN
      : counter.last_token + 1;
    if (!Number.isSafeInteger(fencingToken)) {
      throw new Error(PROJECT_TASK_LEASE_ERRORS.fencingExhausted);
    }
    const leaseId = randomUUID();
    const leaseExpiresAt = now + input.durationMs;
    this.database.prepare(`
      INSERT INTO project_task_lease_generations (
        task_id, lease_id, lease_owner, fencing_token, acquired_at, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.taskId, leaseId, input.leaseOwner, fencingToken, now, leaseExpiresAt);
    const inserted = this.selectCurrentLeaseRow(input.taskId);
    if (inserted === undefined) throw new Error(PROJECT_TASK_LEASE_ERRORS.corruptRecord);
    return this.decodeLeaseRow(inserted);
  }

  private selectGoalRow(goalId: string): ProjectGoalRow | undefined {
    return this.database.prepare(`
      SELECT goal_id, project_id, objective, status, created_at, updated_at, terminal_at,
             current_attempt, max_attempts, continuation_depth_limit, terminal_reason
      FROM project_goals WHERE goal_id = ?
    `).get(goalId) as unknown as ProjectGoalRow | undefined;
  }

  private decodeGoalRow(row: ProjectGoalRow): ProjectGoalRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    if (typeof row.goal_id !== 'string' || !PROJECT_GOAL_ID.test(row.goal_id)) throw corrupt();
    if (typeof row.project_id !== 'string' || row.project_id === '') throw corrupt();
    if (typeof row.objective !== 'string' || row.objective.length === 0 || row.objective.length > 20_000) throw corrupt();
    if (typeof row.status !== 'string' || !GOAL_STATUSES.has(row.status)) throw corrupt();
    if (!isNonNegativeInteger(row.created_at) || !isNonNegativeInteger(row.updated_at) || row.updated_at < row.created_at) throw corrupt();
    if (row.terminal_at !== null && (!isNonNegativeInteger(row.terminal_at) || row.terminal_at < row.created_at)) throw corrupt();
    if (row.current_attempt !== null && !isNonNegativeInteger(row.current_attempt)) throw corrupt();
    if (!isNonNegativeInteger(row.max_attempts) || row.max_attempts < 1 || row.max_attempts > PROJECT_GOAL_MAX_ATTEMPTS_LIMIT) throw corrupt();
    if (!isNonNegativeInteger(row.continuation_depth_limit) || row.continuation_depth_limit > PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT) throw corrupt();
    if (row.terminal_reason !== null && (typeof row.terminal_reason !== 'string' || !GOAL_TERMINAL_REASONS.has(row.terminal_reason))) throw corrupt();

    const terminal = row.status !== 'active';
    if (terminal !== (row.terminal_at !== null) || terminal !== (row.terminal_reason !== null)) throw corrupt();
    const expectedReasonByStatus: Partial<Record<ProjectGoalRecord['status'], ProjectGoalTerminalReason>> = {
      completed: 'objective_completed',
      blocked: 'human_intervention_required',
      exhausted: 'attempt_limit_reached',
      failed: 'unrecoverable_failure',
    };
    if (terminal && row.terminal_reason !== expectedReasonByStatus[row.status as ProjectGoalRecord['status']]) throw corrupt();
    if (row.current_attempt !== null && row.current_attempt >= row.max_attempts) throw corrupt();

    const attempt = this.database.prepare(`
      SELECT MAX(attempt_number) AS latest, COUNT(*) AS total
      FROM project_task_lineage WHERE goal_id = ?
    `).get(row.goal_id) as unknown as { latest: unknown; total: unknown };
    if (!isNonNegativeInteger(attempt.total)) throw corrupt();
    const expectedCurrent = attempt.total === 0 ? null : attempt.latest;
    if (expectedCurrent !== row.current_attempt || attempt.total > row.max_attempts) throw corrupt();

    return {
      goalId: row.goal_id,
      projectId: row.project_id,
      objective: row.objective,
      status: row.status as ProjectGoalRecord['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentAttempt: row.current_attempt,
      maxAttempts: row.max_attempts,
      continuationDepthLimit: row.continuation_depth_limit,
      ...(row.terminal_at !== null ? { terminalAt: row.terminal_at } : {}),
      ...(row.terminal_reason !== null
        ? { terminalReason: row.terminal_reason as ProjectGoalTerminalReason }
        : {}),
    };
  }

  private selectLineageRow(taskId: string): ProjectTaskLineageRow | undefined {
    return this.database.prepare(`
      SELECT task_id, goal_id, parent_task_id, continuation_depth, attempt_number
      FROM project_task_lineage WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskLineageRow | undefined;
  }

  private decodeLineage(taskId: string, taskProjectId: string): ProjectTaskLineage | undefined {
    const first = this.selectLineageRow(taskId);
    if (first === undefined) return undefined;
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    const seen = new Set<string>();
    let cursor: ProjectTaskLineageRow | undefined = first;
    let expectedDepth: number | undefined;
    let expectedAttempt: number | undefined;
    let goalId: string | undefined;

    while (cursor !== undefined) {
      if (typeof cursor.task_id !== 'string' || seen.has(cursor.task_id)) throw corrupt();
      if (typeof cursor.goal_id !== 'string' || cursor.goal_id === '') throw corrupt();
      if (cursor.parent_task_id !== null && typeof cursor.parent_task_id !== 'string') throw corrupt();
      if (!isNonNegativeInteger(cursor.continuation_depth) || !isNonNegativeInteger(cursor.attempt_number)) throw corrupt();
      if (cursor.task_id === cursor.parent_task_id) throw corrupt();
      if (goalId !== undefined && cursor.goal_id !== goalId) throw corrupt();
      if (expectedDepth !== undefined && cursor.continuation_depth !== expectedDepth) throw corrupt();
      if (expectedAttempt !== undefined && cursor.attempt_number !== expectedAttempt) throw corrupt();
      seen.add(cursor.task_id);
      goalId = cursor.goal_id;

      const project = this.database.prepare(`
        SELECT json_extract(intent_json, '$.projectId') AS project_id
        FROM project_tasks WHERE task_id = ?
      `).get(cursor.task_id) as unknown as { project_id: unknown } | undefined;
      if (project?.project_id !== taskProjectId) throw corrupt();

      if (cursor.parent_task_id === null) {
        if (cursor.continuation_depth !== 0 || cursor.attempt_number !== 0) throw corrupt();
        break;
      }
      expectedDepth = cursor.continuation_depth - 1;
      expectedAttempt = cursor.attempt_number - 1;
      cursor = this.selectLineageRow(cursor.parent_task_id);
      if (cursor === undefined) throw corrupt();
    }

    if (goalId === undefined) throw corrupt();
    const goalRow = this.selectGoalRow(goalId);
    if (goalRow === undefined) throw corrupt();
    const goal = this.decodeGoalRow(goalRow);
    if (goal.projectId !== taskProjectId) throw corrupt();
    if (!isNonNegativeInteger(first.continuation_depth) || !isNonNegativeInteger(first.attempt_number)) throw corrupt();
    if (first.attempt_number > (goal.currentAttempt ?? -1) || first.attempt_number >= goal.maxAttempts) throw corrupt();
    if (first.continuation_depth > goal.continuationDepthLimit) throw corrupt();

    return {
      goalId,
      ...(typeof first.parent_task_id === 'string' ? { parentTaskId: first.parent_task_id } : {}),
      continuationDepth: first.continuation_depth,
      attemptNumber: first.attempt_number,
    };
  }

  private selectActiveCompletedStages(taskId: string): readonly ActiveTaskStage[] {
    const trace = this.database.prepare(`
      SELECT completed_stages_json
      FROM project_task_active_stage_traces
      WHERE task_id = ?
    `).get(taskId) as unknown as { completed_stages_json: unknown } | undefined;

    if (trace === undefined) return [];
    if (typeof trace.completed_stages_json !== 'string') {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trace.completed_stages_json);
    } catch {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    }

    if (!isActiveTaskCompletedStages(parsed)) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    }

    // No durable evidence is represented by absence of the sidecar row.
    // Persisting [] is contradictory durable state even though [] remains a
    // valid in-memory representation before any active stage has completed.
    if (parsed.length === 0) {
      throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    }

    return parsed;
  }

  private decodeRow(row: ProjectTaskRow): ProjectTaskRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);

    if (typeof row.task_id !== 'string' || row.task_id === '') throw corrupt();
    if (typeof row.fingerprint !== 'string' || row.fingerprint === '') throw corrupt();
    if (typeof row.intent_json !== 'string') throw corrupt();
    if (typeof row.status !== 'string' || !STAGES.has(row.status)) throw corrupt();
    if (!isNonNegativeInteger(row.created_at) || !isNonNegativeInteger(row.updated_at)) throw corrupt();
    if (row.terminal_at !== null && !isNonNegativeInteger(row.terminal_at)) throw corrupt();
    if (row.receipt_json !== null && typeof row.receipt_json !== 'string') throw corrupt();
    if (row.error_json !== null && typeof row.error_json !== 'string') throw corrupt();

    const activeCompletedStages = this.selectActiveCompletedStages(row.task_id);

    // Active durable evidence must always describe stages strictly earlier
    // than the current active status. Accepted/terminal rows must not retain
    // a transient sidecar trace.
    if (activeCompletedStages.length > 0) {
      const currentStageIndex = ACTIVE_STAGE_INDEX.get(row.status);
      const lastCompletedStage = activeCompletedStages.at(-1);
      const lastCompletedIndex = lastCompletedStage === undefined
        ? undefined
        : ACTIVE_STAGE_INDEX.get(lastCompletedStage);

      if (
        currentStageIndex === undefined
        || lastCompletedIndex === undefined
        || lastCompletedIndex >= currentStageIndex
      ) {
        throw corrupt();
      }
    }

    let intent: unknown;
    try {
      intent = JSON.parse(row.intent_json);
    } catch {
      throw corrupt();
    }
    const intentValidation = validateProjectTaskRequest(intent);
    if (!intentValidation.success) throw corrupt();
    const lineage = this.decodeLineage(row.task_id, intentValidation.request.projectId);

    let receipt: SafeTaskReceipt | undefined;
    if (row.receipt_json !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.receipt_json);
      } catch {
        throw corrupt();
      }
      if (!isSafeTaskReceipt(parsed)) throw corrupt();
      receipt = parsed;
    }

    let error: SafeTaskError | undefined;
    if (row.error_json !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.error_json);
      } catch {
        throw corrupt();
      }
      if (!isSafeTaskError(parsed)) throw corrupt();
      error = parsed;
    }

    const terminalAt = row.terminal_at === null ? undefined : row.terminal_at;
    const terminal = row.status === 'completed' || row.status === 'failed';
    if (terminal !== (terminalAt !== undefined)) throw corrupt();
    if (row.status === 'completed' && (receipt === undefined || error !== undefined)) throw corrupt();
    if (row.status === 'failed' && (error === undefined || receipt !== undefined)) throw corrupt();
    if (terminalAt === undefined && (receipt !== undefined || error !== undefined)) throw corrupt();

    return {
      taskId: row.task_id,
      fingerprint: row.fingerprint,
      intent: intentValidation.request,
      status: row.status as ProjectTaskStage,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(activeCompletedStages.length > 0 ? { completedStages: activeCompletedStages } : {}),
      ...(lineage !== undefined ? { lineage } : {}),
      ...(terminalAt !== undefined ? { terminalAt } : {}),
      ...(receipt !== undefined ? { receipt } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  private selectEvaluationRow(evaluationId: string): ProjectGoalEvaluationRow | undefined {
    return this.database.prepare(`
      SELECT evaluation_id, goal_id, task_id, attempt_number, evaluator_version,
             decision, reason_code, summary, evidence_fingerprint, created_at, applied_at
      FROM project_goal_evaluations WHERE evaluation_id = ?
    `).get(evaluationId) as unknown as ProjectGoalEvaluationRow | undefined;
  }

  private decodeEvaluationRow(row: ProjectGoalEvaluationRow): ProjectGoalEvaluationRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    if (typeof row.evaluation_id !== 'string' || !PROJECT_GOAL_ID.test(row.evaluation_id)) throw corrupt();
    if (typeof row.goal_id !== 'string' || !PROJECT_GOAL_ID.test(row.goal_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (!isNonNegativeInteger(row.attempt_number)) throw corrupt();
    if (row.evaluator_version !== PROJECT_GOAL_EVALUATOR_VERSION) throw corrupt();
    if (typeof row.decision !== 'string' || !EVALUATION_DECISIONS.has(row.decision)) throw corrupt();
    if (typeof row.reason_code !== 'string' || !EVALUATION_REASON_CODES.has(row.reason_code)) throw corrupt();
    if (typeof row.summary !== 'string' || row.summary.length === 0 || row.summary.length > 500) throw corrupt();
    if (typeof row.evidence_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.evidence_fingerprint)) throw corrupt();
    if (!isNonNegativeInteger(row.created_at)) throw corrupt();
    if (row.applied_at !== null && (!isNonNegativeInteger(row.applied_at) || row.applied_at < row.created_at)) throw corrupt();

    const decision = row.decision as ProjectGoalEvaluationDecision;
    const reasonCode = row.reason_code as ProjectGoalEvaluationReasonCode;
    const validReasons: Record<ProjectGoalEvaluationDecision, readonly ProjectGoalEvaluationReasonCode[]> = {
      completed: ['goal_satisfied'],
      retryable: ['partial_result', 'verification_failed', 'visual_verification_failed', 'execution_failed', 'insufficient_evidence'],
      blocked: ['human_approval_required', 'forbidden_capability_required', 'external_dependency'],
      failed: ['execution_failed', 'attempt_budget_exhausted', 'continuation_depth_exhausted'],
    };
    if (!validReasons[decision].includes(reasonCode)) throw corrupt();

    return {
      evaluationId: row.evaluation_id,
      goalId: row.goal_id,
      taskId: row.task_id,
      attemptNumber: row.attempt_number,
      evaluatorVersion: PROJECT_GOAL_EVALUATOR_VERSION,
      decision,
      reasonCode,
      summary: row.summary,
      evidenceFingerprint: row.evidence_fingerprint,
      createdAt: row.created_at,
      ...(row.applied_at !== null ? { appliedAt: row.applied_at } : {}),
    };
  }

  private selectContinuationPlanRow(planId: string): ProjectGoalContinuationPlanRow | undefined {
    return this.database.prepare(`
      SELECT plan_id, goal_id, source_evaluation_id, parent_task_id,
             parent_attempt_number, next_attempt_number, next_continuation_depth,
             planner_version, status, instruction, reason_code, fingerprint,
             source_evidence_fingerprint, created_at, cancelled_at
      FROM project_goal_continuation_plans WHERE plan_id = ?
    `).get(planId) as unknown as ProjectGoalContinuationPlanRow | undefined;
  }

  private decodeContinuationPlanRow(
    row: ProjectGoalContinuationPlanRow,
  ): ProjectGoalContinuationPlanRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    if (typeof row.plan_id !== 'string' || !PROJECT_GOAL_ID.test(row.plan_id)) throw corrupt();
    if (typeof row.goal_id !== 'string' || !PROJECT_GOAL_ID.test(row.goal_id)) throw corrupt();
    if (typeof row.source_evaluation_id !== 'string' || !PROJECT_GOAL_ID.test(row.source_evaluation_id)) throw corrupt();
    if (typeof row.parent_task_id !== 'string' || !PROJECT_TASK_ID.test(row.parent_task_id)) throw corrupt();
    if (!isNonNegativeInteger(row.parent_attempt_number)) throw corrupt();
    if (row.next_attempt_number !== row.parent_attempt_number + 1) throw corrupt();
    if (!isNonNegativeInteger(row.next_continuation_depth) || row.next_continuation_depth === 0) throw corrupt();
    if (row.planner_version !== CONTINUATION_PLANNER_VERSION) throw corrupt();
    // The physical V5 plan state remains planned/cancelled. V6 consumption is
    // normalized into an append-only relation and exposed as the consumed state.
    if (row.status !== 'planned' && row.status !== 'cancelled') throw corrupt();
    if (!isSafeContinuationInstruction(row.instruction)) throw corrupt();
    if (typeof row.reason_code !== 'string' || !CONTINUATION_PLAN_REASON_CODES.has(row.reason_code)) throw corrupt();
    if (typeof row.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.fingerprint)) throw corrupt();
    if (typeof row.source_evidence_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.source_evidence_fingerprint)) throw corrupt();
    if (!isNonNegativeInteger(row.created_at)) throw corrupt();
    if (row.cancelled_at !== null && (!isNonNegativeInteger(row.cancelled_at) || row.cancelled_at < row.created_at)) throw corrupt();
    if ((row.status === 'cancelled') !== (row.cancelled_at !== null)) throw corrupt();

    const consumption = this.database.prepare(`
      SELECT created_task_id, consumed_at
      FROM project_goal_continuation_consumptions WHERE plan_id = ?
    `).get(row.plan_id) as unknown as {
      created_task_id: unknown;
      consumed_at: unknown;
    } | undefined;
    if (
      consumption !== undefined
      && (
        row.status !== 'planned'
        || typeof consumption.created_task_id !== 'string'
        || !PROJECT_TASK_ID.test(consumption.created_task_id)
        || !isNonNegativeInteger(consumption.consumed_at)
        || consumption.consumed_at < row.created_at
      )
    ) throw corrupt();

    const meaning = {
      goalId: row.goal_id,
      sourceEvaluationId: row.source_evaluation_id,
      parentTaskId: row.parent_task_id,
      parentAttemptNumber: row.parent_attempt_number,
      nextAttemptNumber: row.next_attempt_number,
      nextContinuationDepth: row.next_continuation_depth,
      plannerVersion: CONTINUATION_PLANNER_VERSION,
      instruction: row.instruction,
      reasonCode: row.reason_code as ProjectGoalContinuationPlanReasonCode,
      sourceEvidenceFingerprint: row.source_evidence_fingerprint,
    };
    if (fingerprintContinuationPlanMeaning(meaning) !== row.fingerprint) throw corrupt();
    return {
      planId: row.plan_id,
      ...meaning,
      status: consumption === undefined
        ? row.status as ProjectGoalContinuationPlanStatus
        : 'consumed',
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      ...(row.cancelled_at !== null ? { cancelledAt: row.cancelled_at } : {}),
      ...(consumption !== undefined
        ? {
          createdTaskId: consumption.created_task_id as string,
          consumedAt: consumption.consumed_at as number,
        }
        : {}),
    };
  }

  private selectContinuationApprovalRow(
    planId: string,
  ): ProjectGoalContinuationApprovalRow | undefined {
    return this.database.prepare(`
      SELECT approval_id, plan_id, goal_id, source_evaluation_id,
             plan_fingerprint, source_evidence_fingerprint, approver,
             created_at, expires_at, revoked_at
      FROM project_goal_continuation_approvals WHERE plan_id = ?
    `).get(planId) as unknown as ProjectGoalContinuationApprovalRow | undefined;
  }

  private decodeContinuationApprovalRow(
    row: ProjectGoalContinuationApprovalRow,
  ): ProjectGoalContinuationApprovalRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    if (typeof row.approval_id !== 'string' || !PROJECT_GOAL_ID.test(row.approval_id)) throw corrupt();
    if (typeof row.plan_id !== 'string' || !PROJECT_GOAL_ID.test(row.plan_id)) throw corrupt();
    if (typeof row.goal_id !== 'string' || !PROJECT_GOAL_ID.test(row.goal_id)) throw corrupt();
    if (typeof row.source_evaluation_id !== 'string' || !PROJECT_GOAL_ID.test(row.source_evaluation_id)) throw corrupt();
    if (typeof row.plan_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.plan_fingerprint)) throw corrupt();
    if (typeof row.source_evidence_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.source_evidence_fingerprint)) throw corrupt();
    if (
      typeof row.approver !== 'string'
      || row.approver.length < 1
      || row.approver.length > CONTINUATION_APPROVAL_MAX_APPROVER_LENGTH
      || row.approver !== row.approver.trim()
    ) throw corrupt();
    if (!isNonNegativeInteger(row.created_at)) throw corrupt();
    if (row.expires_at !== null && (!isNonNegativeInteger(row.expires_at) || row.expires_at <= row.created_at)) throw corrupt();
    if (row.revoked_at !== null && (!isNonNegativeInteger(row.revoked_at) || row.revoked_at < row.created_at)) throw corrupt();
    return {
      approvalId: row.approval_id,
      planId: row.plan_id,
      goalId: row.goal_id,
      sourceEvaluationId: row.source_evaluation_id,
      planFingerprint: row.plan_fingerprint,
      sourceEvidenceFingerprint: row.source_evidence_fingerprint,
      approver: row.approver,
      createdAt: row.created_at,
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    };
  }

  private selectGoalAutonomyPolicyRow(goalId: string): ProjectGoalAutonomyPolicyRow | undefined {
    return this.database.prepare(`
      SELECT policy_id, goal_id, mode, suspended_at, expires_at, revoked_at,
             max_cycles, elapsed_budget_ms, approver, created_at, updated_at, fingerprint
      FROM project_goal_autonomy_policies WHERE goal_id = ?
    `).get(goalId) as unknown as ProjectGoalAutonomyPolicyRow | undefined;
  }

  private decodeGoalAutonomyPolicyRow(
    row: ProjectGoalAutonomyPolicyRow,
  ): ProjectGoalAutonomyPolicyRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    if (typeof row.policy_id !== 'string' || !PROJECT_GOAL_ID.test(row.policy_id)) throw corrupt();
    if (typeof row.goal_id !== 'string' || !PROJECT_GOAL_ID.test(row.goal_id)) throw corrupt();
    if (typeof row.mode !== 'string' || !AUTONOMY_MODE_SET.has(row.mode)) throw corrupt();
    if (row.suspended_at !== null && !isNonNegativeInteger(row.suspended_at)) throw corrupt();
    if (row.expires_at !== null && (!isNonNegativeInteger(row.expires_at) || row.expires_at === 0)) throw corrupt();
    if (row.revoked_at !== null && !isNonNegativeInteger(row.revoked_at)) throw corrupt();
    if (row.max_cycles !== null && (!isNonNegativeInteger(row.max_cycles) || row.max_cycles < 1 || row.max_cycles > 5)) throw corrupt();
    if (row.elapsed_budget_ms !== null && (!isNonNegativeInteger(row.elapsed_budget_ms) || row.elapsed_budget_ms === 0)) throw corrupt();
    if (
      typeof row.approver !== 'string'
      || row.approver.length < 1
      || row.approver.length > AUTONOMY_POLICY_MAX_APPROVER_LENGTH
      || row.approver !== row.approver.trim()
    ) throw corrupt();
    if (!isNonNegativeInteger(row.created_at) || !isNonNegativeInteger(row.updated_at)) throw corrupt();
    if (row.updated_at < row.created_at) throw corrupt();
    if (typeof row.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.fingerprint)) throw corrupt();

    const mode = row.mode as AutonomyMode;
    const meaning = autonomyPolicyMeaning({
      goalId: row.goal_id,
      mode,
      maxCycles: row.max_cycles === null ? undefined : row.max_cycles,
      elapsedBudgetMs: row.elapsed_budget_ms === null ? undefined : row.elapsed_budget_ms,
      expiresAt: row.expires_at === null ? undefined : row.expires_at,
    });
    if (fingerprintAutonomyPolicy(meaning) !== row.fingerprint) throw corrupt();
    return {
      policyId: row.policy_id,
      goalId: row.goal_id,
      mode,
      approver: row.approver,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      fingerprint: row.fingerprint,
      ...(row.suspended_at !== null ? { suspendedAt: row.suspended_at as number } : {}),
      ...(row.expires_at !== null ? { expiresAt: row.expires_at as number } : {}),
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at as number } : {}),
      ...(row.max_cycles !== null ? { maxCycles: row.max_cycles as number } : {}),
      ...(row.elapsed_budget_ms !== null ? { elapsedBudgetMs: row.elapsed_budget_ms as number } : {}),
    };
  }

  private selectExecutionAuthorizationRowById(
    authorizationId: string,
  ): ProjectGoalContinuationExecutionAuthorizationRow | undefined {
    return this.database.prepare(`
      SELECT authorization_id, goal_id, task_id, plan_id, policy_fingerprint,
             approver, created_at, expires_at, revoked_at, consumed_at, fingerprint
      FROM project_goal_continuation_execution_authorizations WHERE authorization_id = ?
    `).get(authorizationId) as unknown as ProjectGoalContinuationExecutionAuthorizationRow | undefined;
  }

  private selectExecutionAuthorizationRowByTask(
    taskId: string,
  ): ProjectGoalContinuationExecutionAuthorizationRow | undefined {
    return this.database.prepare(`
      SELECT authorization_id, goal_id, task_id, plan_id, policy_fingerprint,
             approver, created_at, expires_at, revoked_at, consumed_at, fingerprint
      FROM project_goal_continuation_execution_authorizations WHERE task_id = ?
    `).get(taskId) as unknown as ProjectGoalContinuationExecutionAuthorizationRow | undefined;
  }

  private decodeExecutionAuthorizationRow(
    row: ProjectGoalContinuationExecutionAuthorizationRow,
  ): ProjectGoalContinuationExecutionAuthorizationRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    if (typeof row.authorization_id !== 'string' || !PROJECT_GOAL_ID.test(row.authorization_id)) throw corrupt();
    if (typeof row.goal_id !== 'string' || !PROJECT_GOAL_ID.test(row.goal_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.plan_id !== 'string' || !PROJECT_GOAL_ID.test(row.plan_id)) throw corrupt();
    if (typeof row.policy_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.policy_fingerprint)) throw corrupt();
    if (
      typeof row.approver !== 'string'
      || row.approver.length < 1
      || row.approver.length > EXECUTION_AUTHORIZATION_MAX_APPROVER_LENGTH
      || row.approver !== row.approver.trim()
    ) throw corrupt();
    if (!isNonNegativeInteger(row.created_at)) throw corrupt();
    if (row.expires_at !== null && (!isNonNegativeInteger(row.expires_at) || row.expires_at <= row.created_at)) throw corrupt();
    if (row.revoked_at !== null && (!isNonNegativeInteger(row.revoked_at) || row.revoked_at < row.created_at)) throw corrupt();
    if (row.consumed_at !== null && (!isNonNegativeInteger(row.consumed_at) || row.consumed_at < row.created_at)) throw corrupt();
    if (row.revoked_at !== null && row.consumed_at !== null) throw corrupt();
    if (typeof row.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.fingerprint)) throw corrupt();
    const fingerprint = fingerprintExecutionAuthorization({
      goalId: row.goal_id,
      taskId: row.task_id,
      planId: row.plan_id,
      policyFingerprint: row.policy_fingerprint,
    });
    if (fingerprint !== row.fingerprint) throw corrupt();
    return {
      authorizationId: row.authorization_id,
      goalId: row.goal_id,
      taskId: row.task_id,
      planId: row.plan_id,
      policyFingerprint: row.policy_fingerprint,
      approver: row.approver,
      createdAt: row.created_at,
      fingerprint: row.fingerprint,
      ...(row.expires_at !== null ? { expiresAt: row.expires_at as number } : {}),
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at as number } : {}),
      ...(row.consumed_at !== null ? { consumedAt: row.consumed_at as number } : {}),
    };
  }

  private prepareGoalEvaluation(input: EvaluateProjectGoalAttemptInput): ProjectGoalEvaluationRecord {
    if (
      !PROJECT_GOAL_ID.test(input.goalId)
      || !PROJECT_TASK_ID.test(input.taskId)
      || !isNonNegativeInteger(input.attemptNumber)
      || input.evaluatorVersion !== PROJECT_GOAL_EVALUATOR_VERSION
      || !isProjectGoalEvaluationEvidence(input.evidence)
    ) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.invalidInput);
    }

    const goalRow = this.selectGoalRow(input.goalId);
    if (goalRow === undefined) throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.goalNotFound);
    const goal = this.decodeGoalRow(goalRow);
    const taskRow = this.selectRow(input.taskId);
    if (taskRow === undefined) throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.taskNotFound);
    const task = this.decodeRow(taskRow);
    if (task.intent.projectId !== goal.projectId) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.taskProjectMismatch);
    }
    if (task.lineage?.goalId !== goal.goalId) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.taskGoalMismatch);
    }
    if (task.lineage.attemptNumber !== input.attemptNumber) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.attemptMismatch);
    }
    if (goal.currentAttempt !== input.attemptNumber) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.staleAttempt);
    }
    if (task.status !== 'completed' && task.status !== 'failed') {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.taskNotTerminal);
    }

    const evaluated = evaluateProjectGoalCompletion({ goal, task }, input.evidence);
    const existingRow = this.database.prepare(`
      SELECT evaluation_id, goal_id, task_id, attempt_number, evaluator_version,
             decision, reason_code, summary, evidence_fingerprint, created_at, applied_at
      FROM project_goal_evaluations
      WHERE goal_id = ? AND task_id = ? AND evaluator_version = ?
    `).get(input.goalId, input.taskId, PROJECT_GOAL_EVALUATOR_VERSION) as unknown as ProjectGoalEvaluationRow | undefined;
    if (existingRow !== undefined) {
      const existing = this.decodeEvaluationRow(existingRow);
      if (existing.evidenceFingerprint !== evaluated.evidenceFingerprint) {
        throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.evidenceConflict);
      }
      return existing;
    }
    if (goal.status !== 'active') throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.terminalGoal);

    const evaluationId = randomUUID();
    const createdAt = this.now();
    this.database.prepare(`
      INSERT INTO project_goal_evaluations (
        evaluation_id, goal_id, task_id, attempt_number, evaluator_version,
        decision, reason_code, summary, evidence_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evaluationId,
      input.goalId,
      input.taskId,
      input.attemptNumber,
      PROJECT_GOAL_EVALUATOR_VERSION,
      evaluated.decision,
      evaluated.reasonCode,
      evaluated.summary,
      evaluated.evidenceFingerprint,
      createdAt,
    );
    const inserted = this.selectEvaluationRow(evaluationId);
    if (inserted === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    return this.decodeEvaluationRow(inserted);
  }

  private applyPreparedGoalEvaluation(evaluationId: string): ProjectGoalRecord {
    if (!PROJECT_GOAL_ID.test(evaluationId)) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.invalidInput);
    }
    const evaluationRow = this.selectEvaluationRow(evaluationId);
    if (evaluationRow === undefined) throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.evaluationNotFound);
    const evaluation = this.decodeEvaluationRow(evaluationRow);
    const goalRow = this.selectGoalRow(evaluation.goalId);
    if (goalRow === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    const goal = this.decodeGoalRow(goalRow);

    const targetStatus = evaluation.decision === 'completed'
      ? 'completed'
      : evaluation.decision === 'blocked'
        ? 'blocked'
        : evaluation.decision === 'failed'
          && (evaluation.reasonCode === 'attempt_budget_exhausted'
            || evaluation.reasonCode === 'continuation_depth_exhausted')
          ? 'exhausted'
          : evaluation.decision === 'failed'
            ? 'failed'
            : undefined;

    if (evaluation.appliedAt !== undefined) {
      if (
        (targetStatus !== undefined && goal.status !== targetStatus)
        || (targetStatus === undefined && goal.status !== 'active')
      ) {
        throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.incompatibleState);
      }
      return goal;
    }
    if (goal.status !== 'active' || goal.currentAttempt !== evaluation.attemptNumber) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.incompatibleState);
    }
    const taskRow = this.selectRow(evaluation.taskId);
    if (taskRow === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    const task = this.decodeRow(taskRow);
    if (
      task.lineage?.goalId !== evaluation.goalId
      || task.lineage.attemptNumber !== evaluation.attemptNumber
      || (task.status !== 'completed' && task.status !== 'failed')
    ) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.incompatibleState);
    }

    const appliedAt = Math.max(this.now(), evaluation.createdAt);
    if (targetStatus !== undefined) {
      const terminalReason: ProjectGoalTerminalReason = targetStatus === 'completed'
        ? 'objective_completed'
        : targetStatus === 'blocked'
          ? 'human_intervention_required'
          : targetStatus === 'exhausted'
            ? 'attempt_limit_reached'
            : 'unrecoverable_failure';
      const changed = this.database.prepare(`
        UPDATE project_goals
        SET status = ?, terminal_reason = ?, updated_at = ?, terminal_at = ?
        WHERE goal_id = ? AND status = 'active' AND current_attempt = ?
      `).run(targetStatus, terminalReason, appliedAt, appliedAt, evaluation.goalId, evaluation.attemptNumber);
      if (Number(changed.changes) !== 1) {
        throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.incompatibleState);
      }
    }
    const applied = this.database.prepare(`
      UPDATE project_goal_evaluations SET applied_at = ?
      WHERE evaluation_id = ? AND applied_at IS NULL
    `).run(appliedAt, evaluationId);
    if (Number(applied.changes) !== 1) {
      throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.incompatibleState);
    }
    const appliedGoalRow = this.selectGoalRow(evaluation.goalId);
    if (appliedGoalRow === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    return this.decodeGoalRow(appliedGoalRow);
  }

  evaluateGoalAttempt(input: EvaluateProjectGoalAttemptInput): ProjectGoalEvaluationRecord {
    return this.inTransaction(() => this.prepareGoalEvaluation(input));
  }

  applyGoalEvaluation(evaluationId: string): ProjectGoalRecord {
    return this.inTransaction(() => this.applyPreparedGoalEvaluation(evaluationId));
  }

  evaluateAndApplyGoalAttempt(input: EvaluateProjectGoalAttemptInput): {
    evaluation: ProjectGoalEvaluationRecord;
    goal: ProjectGoalRecord;
  } {
    return this.inTransaction(() => {
      const prepared = this.prepareGoalEvaluation(input);
      const goal = this.applyPreparedGoalEvaluation(prepared.evaluationId);
      const appliedRow = this.selectEvaluationRow(prepared.evaluationId);
      if (appliedRow === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return { evaluation: this.decodeEvaluationRow(appliedRow), goal };
    });
  }

  readGoalEvaluation(evaluationId: string): ProjectGoalEvaluationRecord | undefined {
    return this.inTransaction(() => {
      const row = this.selectEvaluationRow(evaluationId);
      return row === undefined ? undefined : this.decodeEvaluationRow(row);
    });
  }

  readLatestGoalEvaluation(goalId: string): ProjectGoalEvaluationRecord | undefined {
    return this.inTransaction(() => {
      const row = this.database.prepare(`
        SELECT evaluation_id, goal_id, task_id, attempt_number, evaluator_version,
               decision, reason_code, summary, evidence_fingerprint, created_at, applied_at
        FROM project_goal_evaluations WHERE goal_id = ?
        ORDER BY attempt_number DESC, created_at DESC, evaluation_id DESC LIMIT 1
      `).get(goalId) as unknown as ProjectGoalEvaluationRow | undefined;
      return row === undefined ? undefined : this.decodeEvaluationRow(row);
    });
  }

  listGoalEvaluations(goalId: string): ProjectGoalEvaluationRecord[] {
    return this.inTransaction(() => {
      const goal = this.selectGoalRow(goalId);
      if (goal === undefined) throw new Error(PROJECT_GOAL_EVALUATION_ERRORS.goalNotFound);
      this.decodeGoalRow(goal);
      const rows = this.database.prepare(`
        SELECT evaluation_id, goal_id, task_id, attempt_number, evaluator_version,
               decision, reason_code, summary, evidence_fingerprint, created_at, applied_at
        FROM project_goal_evaluations WHERE goal_id = ?
        ORDER BY attempt_number ASC, created_at ASC, evaluation_id ASC
      `).all(goalId) as unknown as ProjectGoalEvaluationRow[];
      return rows.map((row) => this.decodeEvaluationRow(row));
    });
  }

  private assertContinuationPlanSource(
    goalId: string,
    sourceEvaluationId: string,
    sourceEvidenceFingerprint: string,
  ): {
    goal: ProjectGoalRecord;
    evaluation: ProjectGoalEvaluationRecord;
    parent: ProjectTaskRecord;
  } {
    const evaluationRow = this.selectEvaluationRow(sourceEvaluationId);
    if (evaluationRow === undefined) {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.evaluationNotFound);
    }
    const evaluation = this.decodeEvaluationRow(evaluationRow);
    if (evaluation.goalId !== goalId) {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.goalMismatch);
    }
    if (evaluation.evidenceFingerprint !== sourceEvidenceFingerprint) {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.evidenceConflict);
    }
    if (evaluation.appliedAt === undefined) {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.evaluationNotApplied);
    }
    if (evaluation.decision !== 'retryable') {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.evaluationNotRetryable);
    }
    const goalRow = this.selectGoalRow(goalId);
    if (goalRow === undefined) throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.goalNotFound);
    const goal = this.decodeGoalRow(goalRow);
    if (goal.status !== 'active') throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.terminalGoal);
    const parentRow = this.selectRow(evaluation.taskId);
    if (parentRow === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    const parent = this.decodeRow(parentRow);
    if (parent.intent.projectId !== goal.projectId) {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.projectMismatch);
    }
    if (
      parent.lineage?.goalId !== goalId
      || parent.lineage.attemptNumber !== evaluation.attemptNumber
      || goal.currentAttempt !== evaluation.attemptNumber
    ) {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.staleAttempt);
    }
    if (parent.lineage.attemptNumber + 1 >= goal.maxAttempts) {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.attemptLimit);
    }
    if (parent.lineage.continuationDepth + 1 > goal.continuationDepthLimit) {
      throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.depthLimit);
    }
    return { goal, evaluation, parent };
  }

  createContinuationPlan(
    input: CreateProjectGoalContinuationPlanInput,
  ): ProjectGoalContinuationPlanRecord {
    return this.inTransaction(() => {
      if (
        !isRecord(input)
        || Object.keys(input).length !== 4
        || !Object.keys(input).every((key) => [
          'goalId', 'sourceEvaluationId', 'plannerVersion', 'sourceEvidenceFingerprint',
        ].includes(key))
        || typeof input.goalId !== 'string'
        || !PROJECT_GOAL_ID.test(input.goalId)
        || typeof input.sourceEvaluationId !== 'string'
        || !PROJECT_GOAL_ID.test(input.sourceEvaluationId)
        || input.plannerVersion !== CONTINUATION_PLANNER_VERSION
        || typeof input.sourceEvidenceFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(input.sourceEvidenceFingerprint)
      ) {
        throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.invalidInput);
      }
      const { goal, evaluation, parent } = this.assertContinuationPlanSource(
        input.goalId,
        input.sourceEvaluationId,
        input.sourceEvidenceFingerprint,
      );
      if (parent.lineage === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.staleAttempt);
      }
      const { instruction, reasonCode } = buildDeterministicContinuationInstruction(
        goal,
        evaluation,
        parent,
      );
      const meaning = {
        goalId: goal.goalId,
        sourceEvaluationId: evaluation.evaluationId,
        parentTaskId: parent.taskId,
        parentAttemptNumber: parent.lineage.attemptNumber,
        nextAttemptNumber: parent.lineage.attemptNumber + 1,
        nextContinuationDepth: parent.lineage.continuationDepth + 1,
        plannerVersion: CONTINUATION_PLANNER_VERSION,
        instruction,
        reasonCode,
        sourceEvidenceFingerprint: evaluation.evidenceFingerprint,
      };
      const fingerprint = fingerprintContinuationPlanMeaning(meaning);
      const existingRow = this.database.prepare(`
        SELECT plan_id, goal_id, source_evaluation_id, parent_task_id,
               parent_attempt_number, next_attempt_number, next_continuation_depth,
               planner_version, status, instruction, reason_code, fingerprint,
               source_evidence_fingerprint, created_at, cancelled_at
        FROM project_goal_continuation_plans
        WHERE source_evaluation_id = ? AND planner_version = ?
      `).get(evaluation.evaluationId, CONTINUATION_PLANNER_VERSION) as unknown as ProjectGoalContinuationPlanRow | undefined;
      if (existingRow !== undefined) {
        const existing = this.decodeContinuationPlanRow(existingRow);
        if (
          existing.goalId !== meaning.goalId
          || existing.parentTaskId !== meaning.parentTaskId
          || existing.parentAttemptNumber !== meaning.parentAttemptNumber
          || existing.nextAttemptNumber !== meaning.nextAttemptNumber
          || existing.nextContinuationDepth !== meaning.nextContinuationDepth
          || existing.instruction !== meaning.instruction
          || existing.reasonCode !== meaning.reasonCode
          || existing.sourceEvidenceFingerprint !== meaning.sourceEvidenceFingerprint
          || existing.fingerprint !== fingerprint
        ) {
          throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.incompatiblePlan);
        }
        return existing;
      }

      const planId = randomUUID();
      const createdAt = Math.max(this.now(), evaluation.appliedAt ?? 0);
      this.database.prepare(`
        INSERT INTO project_goal_continuation_plans (
          plan_id, goal_id, source_evaluation_id, parent_task_id,
          parent_attempt_number, next_attempt_number, next_continuation_depth,
          planner_version, status, instruction, reason_code, fingerprint,
          source_evidence_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)
      `).run(
        planId,
        meaning.goalId,
        meaning.sourceEvaluationId,
        meaning.parentTaskId,
        meaning.parentAttemptNumber,
        meaning.nextAttemptNumber,
        meaning.nextContinuationDepth,
        meaning.plannerVersion,
        meaning.instruction,
        meaning.reasonCode,
        fingerprint,
        meaning.sourceEvidenceFingerprint,
        createdAt,
      );
      const inserted = this.selectContinuationPlanRow(planId);
      if (inserted === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeContinuationPlanRow(inserted);
    });
  }

  readContinuationPlan(planId: string): ProjectGoalContinuationPlanRecord | undefined {
    return this.inTransaction(() => {
      if (!PROJECT_GOAL_ID.test(planId)) throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.invalidInput);
      const row = this.selectContinuationPlanRow(planId);
      return row === undefined ? undefined : this.decodeContinuationPlanRow(row);
    });
  }

  readContinuationPlanBySourceEvaluation(
    sourceEvaluationId: string,
    plannerVersion: typeof CONTINUATION_PLANNER_VERSION = CONTINUATION_PLANNER_VERSION,
  ): ProjectGoalContinuationPlanRecord | undefined {
    return this.inTransaction(() => {
      if (!PROJECT_GOAL_ID.test(sourceEvaluationId) || plannerVersion !== CONTINUATION_PLANNER_VERSION) {
        throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.invalidInput);
      }
      const row = this.database.prepare(`
        SELECT plan_id, goal_id, source_evaluation_id, parent_task_id,
               parent_attempt_number, next_attempt_number, next_continuation_depth,
               planner_version, status, instruction, reason_code, fingerprint,
               source_evidence_fingerprint, created_at, cancelled_at
        FROM project_goal_continuation_plans
        WHERE source_evaluation_id = ? AND planner_version = ?
      `).get(sourceEvaluationId, plannerVersion) as unknown as ProjectGoalContinuationPlanRow | undefined;
      return row === undefined ? undefined : this.decodeContinuationPlanRow(row);
    });
  }

  listGoalContinuationPlans(goalId: string): ProjectGoalContinuationPlanRecord[] {
    return this.inTransaction(() => {
      const goal = this.selectGoalRow(goalId);
      if (goal === undefined) throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.goalNotFound);
      this.decodeGoalRow(goal);
      const rows = this.database.prepare(`
        SELECT plan_id, goal_id, source_evaluation_id, parent_task_id,
               parent_attempt_number, next_attempt_number, next_continuation_depth,
               planner_version, status, instruction, reason_code, fingerprint,
               source_evidence_fingerprint, created_at, cancelled_at
        FROM project_goal_continuation_plans WHERE goal_id = ?
        ORDER BY created_at ASC, plan_id ASC
      `).all(goalId) as unknown as ProjectGoalContinuationPlanRow[];
      return rows.map((row) => this.decodeContinuationPlanRow(row));
    });
  }

  assertContinuationPlanUsable(planId: string): ProjectGoalContinuationPlanRecord {
    return this.inTransaction(() => {
      const row = this.selectContinuationPlanRow(planId);
      if (row === undefined) throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.planNotFound);
      const plan = this.decodeContinuationPlanRow(row);
      if (plan.status !== 'planned') throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.planNotUsable);
      let source;
      try {
        source = this.assertContinuationPlanSource(
          plan.goalId,
          plan.sourceEvaluationId,
          plan.sourceEvidenceFingerprint,
        );
      } catch {
        throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.planNotUsable);
      }
      const lineage = source.parent.lineage;
      if (
        lineage === undefined
        || source.parent.taskId !== plan.parentTaskId
        || lineage.attemptNumber !== plan.parentAttemptNumber
        || plan.nextAttemptNumber !== lineage.attemptNumber + 1
        || plan.nextContinuationDepth !== lineage.continuationDepth + 1
      ) {
        throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.planNotUsable);
      }
      const expected = buildDeterministicContinuationInstruction(
        source.goal,
        source.evaluation,
        source.parent,
      );
      if (expected.instruction !== plan.instruction || expected.reasonCode !== plan.reasonCode) {
        throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.planNotUsable);
      }
      return plan;
    });
  }

  materializeContinuation(planId: string): ProjectContinuationMaterializationResult {
    return this.inTransaction(() => {
      if (typeof planId !== 'string' || !PROJECT_GOAL_ID.test(planId)) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.invalidInput);
      }

      const planRow = this.selectContinuationPlanRow(planId);
      if (planRow === undefined) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.planNotFound);
      }
      const plan = this.decodeContinuationPlanRow(planRow);

      // A committed consumption is the idempotency record. Return it before
      // checking now-stale parent/currentAttempt state.
      if (plan.status === 'consumed') {
        if (plan.createdTaskId === undefined) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        const taskRow = this.selectRow(plan.createdTaskId);
        if (taskRow === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        const task = this.decodeRow(taskRow);
        if (
          task.lineage?.goalId !== plan.goalId
          || task.lineage.parentTaskId !== plan.parentTaskId
          || task.lineage.attemptNumber !== plan.nextAttemptNumber
          || task.lineage.continuationDepth !== plan.nextContinuationDepth
        ) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        return { planId, createdTaskId: task.taskId, task };
      }
      if (plan.status !== 'planned') {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.planNotUsable);
      }

      const evaluationRow = this.selectEvaluationRow(plan.sourceEvaluationId);
      if (evaluationRow === undefined) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.sourceConflict);
      }
      const evaluation = this.decodeEvaluationRow(evaluationRow);
      if (
        evaluation.evaluationId !== plan.sourceEvaluationId
        || evaluation.goalId !== plan.goalId
        || evaluation.taskId !== plan.parentTaskId
        || evaluation.attemptNumber !== plan.parentAttemptNumber
        || evaluation.evidenceFingerprint !== plan.sourceEvidenceFingerprint
      ) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.sourceConflict);
      }
      if (evaluation.appliedAt === undefined) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.evaluationNotApplied);
      }
      if (evaluation.decision !== 'retryable') {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.evaluationNotRetryable);
      }

      const goalRow = this.selectGoalRow(plan.goalId);
      if (goalRow === undefined) throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.goalNotFound);
      const goal = this.decodeGoalRow(goalRow);
      if (goal.status !== 'active') throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.goalTerminal);

      const parentRow = this.selectRow(plan.parentTaskId);
      if (parentRow === undefined) throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.parentNotFound);
      const parent = this.decodeRow(parentRow);
      if (parent.intent.projectId !== goal.projectId) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.projectMismatch);
      }
      if (
        parent.lineage?.goalId !== goal.goalId
        || parent.lineage.attemptNumber !== plan.parentAttemptNumber
        || evaluation.attemptNumber !== parent.lineage.attemptNumber
        || goal.currentAttempt !== parent.lineage.attemptNumber
      ) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.staleParent);
      }
      if (plan.nextAttemptNumber !== parent.lineage.attemptNumber + 1) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.incompatiblePlan);
      }
      if (plan.nextAttemptNumber >= goal.maxAttempts) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.attemptLimit);
      }
      if (plan.nextContinuationDepth !== parent.lineage.continuationDepth + 1) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.incompatiblePlan);
      }
      if (plan.nextContinuationDepth > goal.continuationDepthLimit) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.depthLimit);
      }
      const expected = buildDeterministicContinuationInstruction(goal, evaluation, parent);
      if (expected.instruction !== plan.instruction || expected.reasonCode !== plan.reasonCode) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.incompatiblePlan);
      }

      this.pruneExpiredTerminals();
      const counts = this.database.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN terminal_at IS NULL THEN 1 ELSE 0 END) AS active
        FROM project_tasks
      `).get() as unknown as { total: number; active: number | null };
      if (counts.total >= this.options.maxRecords || (counts.active ?? 0) >= this.options.maxActive) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.capacity);
      }

      // Authority is inherited only from the validated parent. Plan metadata
      // contributes instruction/lineage intent, never capabilities.
      const intent: ProjectTaskRequest = {
        projectId: goal.projectId,
        instruction: plan.instruction,
        priority: parent.intent.priority,
        requestedCapabilities: [...parent.intent.requestedCapabilities],
      };
      const validatedIntent = validateProjectTaskRequest(intent);
      if (!validatedIntent.success) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.incompatiblePlan);
      }
      const taskId = randomUUID();
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ runtime: 'continuation-runtime-v1', planId, planFingerprint: plan.fingerprint, intent: validatedIntent.request }))
        .digest('hex');
      const now = Math.max(this.now(), plan.createdAt, evaluation.appliedAt);

      this.database.prepare(`
        INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at)
        VALUES (?, ?, ?, 'accepted', ?, ?)
      `).run(taskId, fingerprint, JSON.stringify(validatedIntent.request), now, now);
      this.database.prepare(`
        INSERT INTO project_task_lineage (
          task_id, goal_id, parent_task_id, continuation_depth, attempt_number
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        taskId,
        goal.goalId,
        parent.taskId,
        plan.nextContinuationDepth,
        plan.nextAttemptNumber,
      );
      this.database.prepare(`
        INSERT INTO project_goal_continuation_consumptions (plan_id, created_task_id, consumed_at)
        VALUES (?, ?, ?)
      `).run(planId, taskId, now);
      const updated = this.database.prepare(`
        UPDATE project_goals SET updated_at = ?
        WHERE goal_id = ? AND status = 'active' AND current_attempt = ?
      `).run(now, goal.goalId, plan.nextAttemptNumber);
      if (Number(updated.changes) !== 1) {
        throw new Error(PROJECT_CONTINUATION_RUNTIME_ERRORS.staleParent);
      }

      const insertedTask = this.selectRow(taskId);
      const consumedPlanRow = this.selectContinuationPlanRow(planId);
      if (insertedTask === undefined || consumedPlanRow === undefined) {
        throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      }
      const task = this.decodeRow(insertedTask);
      const consumedPlan = this.decodeContinuationPlanRow(consumedPlanRow);
      if (consumedPlan.status !== 'consumed' || consumedPlan.createdTaskId !== task.taskId) {
        throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      }
      return { planId, createdTaskId: task.taskId, task };
    });
  }

  cancelContinuationPlan(planId: string): ProjectGoalContinuationPlanRecord {
    return this.inTransaction(() => {
      const row = this.selectContinuationPlanRow(planId);
      if (row === undefined) throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.planNotFound);
      const plan = this.decodeContinuationPlanRow(row);
      if (plan.status === 'cancelled') return plan;
      if (plan.status === 'consumed') {
        throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.planNotUsable);
      }
      const cancelledAt = Math.max(this.now(), plan.createdAt);
      const changed = this.database.prepare(`
        UPDATE project_goal_continuation_plans SET status = 'cancelled', cancelled_at = ?
        WHERE plan_id = ? AND status = 'planned' AND cancelled_at IS NULL
      `).run(cancelledAt, planId);
      if (Number(changed.changes) !== 1) {
        throw new Error(PROJECT_GOAL_CONTINUATION_PLAN_ERRORS.incompatiblePlan);
      }
      const cancelled = this.selectContinuationPlanRow(planId);
      if (cancelled === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeContinuationPlanRow(cancelled);
    });
  }

  approveContinuationPlan(
    input: ApproveContinuationPlanInput,
  ): ProjectGoalContinuationApprovalRecord {
    return this.inTransaction(() => {
      if (
        !isRecord(input)
        || !Object.keys(input).every((key) => ['planId', 'approver', 'expiresAt'].includes(key))
        || typeof input.planId !== 'string'
        || !PROJECT_GOAL_ID.test(input.planId)
        || typeof input.approver !== 'string'
        || input.approver.length < 1
        || input.approver.length > CONTINUATION_APPROVAL_MAX_APPROVER_LENGTH
        || input.approver !== input.approver.trim()
        || (input.expiresAt !== undefined && !isNonNegativeInteger(input.expiresAt))
      ) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.invalidInput);
      }

      const planRow = this.selectContinuationPlanRow(input.planId);
      if (planRow === undefined) throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.planNotFound);
      const plan = this.decodeContinuationPlanRow(planRow);
      if (plan.status !== 'planned') {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.planNotApprovable);
      }

      const existingRow = this.selectContinuationApprovalRow(input.planId);
      if (existingRow !== undefined) {
        const existing = this.decodeContinuationApprovalRow(existingRow);
        // Exact replay (same approver, same effective expiry) is idempotent;
        // a contradictory re-approval (different approver or expiry) fails closed.
        const effectiveExpiresAt = input.expiresAt
          ?? existing.createdAt + CONTINUATION_APPROVAL_DEFAULT_TTL_MS;
        if (existing.approver !== input.approver || existing.expiresAt !== effectiveExpiresAt) {
          throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.contradictory);
        }
        return existing;
      }

      const approvalId = randomUUID();
      const createdAt = Math.max(this.now(), plan.createdAt);
      const expiresAt = input.expiresAt ?? createdAt + CONTINUATION_APPROVAL_DEFAULT_TTL_MS;
      if (expiresAt <= createdAt) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.invalidInput);
      }
      this.database.prepare(`
        INSERT INTO project_goal_continuation_approvals (
          approval_id, plan_id, goal_id, source_evaluation_id, plan_fingerprint,
          source_evidence_fingerprint, approver, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        approvalId,
        plan.planId,
        plan.goalId,
        plan.sourceEvaluationId,
        plan.fingerprint,
        plan.sourceEvidenceFingerprint,
        input.approver,
        createdAt,
        expiresAt,
      );
      const inserted = this.selectContinuationApprovalRow(plan.planId);
      if (inserted === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeContinuationApprovalRow(inserted);
    });
  }

  revokeContinuationApproval(planId: string): ProjectGoalContinuationApprovalRecord {
    return this.inTransaction(() => {
      if (typeof planId !== 'string' || !PROJECT_GOAL_ID.test(planId)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.invalidInput);
      }
      const approvalRow = this.selectContinuationApprovalRow(planId);
      if (approvalRow === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalNotFound);
      }
      const approval = this.decodeContinuationApprovalRow(approvalRow);
      if (approval.revokedAt !== undefined) return approval;
      const planRow = this.selectContinuationPlanRow(planId);
      if (planRow === undefined) throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.planNotFound);
      const plan = this.decodeContinuationPlanRow(planRow);
      if (plan.status !== 'planned') {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.notRevocable);
      }
      const revokedAt = Math.max(this.now(), approval.createdAt);
      const changed = this.database.prepare(`
        UPDATE project_goal_continuation_approvals SET revoked_at = ?
        WHERE plan_id = ? AND revoked_at IS NULL
      `).run(revokedAt, planId);
      if (Number(changed.changes) !== 1) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.notRevocable);
      }
      const updated = this.selectContinuationApprovalRow(planId);
      if (updated === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeContinuationApprovalRow(updated);
    });
  }

  readContinuationApproval(planId: string): ProjectGoalContinuationApprovalRecord | undefined {
    return this.inTransaction(() => {
      if (typeof planId !== 'string' || !PROJECT_GOAL_ID.test(planId)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.invalidInput);
      }
      const row = this.selectContinuationApprovalRow(planId);
      return row === undefined ? undefined : this.decodeContinuationApprovalRow(row);
    });
  }

  assertContinuationApprovalValid(planId: string): ProjectGoalContinuationApprovalRecord {
    return this.inTransaction(() => {
      if (typeof planId !== 'string' || !PROJECT_GOAL_ID.test(planId)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.invalidInput);
      }
      const approvalRow = this.selectContinuationApprovalRow(planId);
      if (approvalRow === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalRequired);
      }
      const approval = this.decodeContinuationApprovalRow(approvalRow);
      if (approval.revokedAt !== undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalRevoked);
      }
      if (approval.expiresAt !== undefined && this.now() >= approval.expiresAt) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalExpired);
      }
      const planRow = this.selectContinuationPlanRow(planId);
      if (planRow === undefined) throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalInvalid);
      const plan = this.decodeContinuationPlanRow(planRow);
      if (
        plan.status !== 'planned'
        || approval.planFingerprint !== plan.fingerprint
        || approval.goalId !== plan.goalId
        || approval.sourceEvaluationId !== plan.sourceEvaluationId
        || approval.sourceEvidenceFingerprint !== plan.sourceEvidenceFingerprint
      ) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalInvalid);
      }
      const evaluationRow = this.selectEvaluationRow(plan.sourceEvaluationId);
      if (evaluationRow === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalInvalid);
      }
      const evaluation = this.decodeEvaluationRow(evaluationRow);
      if (evaluation.appliedAt === undefined || evaluation.decision !== 'retryable') {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalInvalid);
      }
      const goalRow = this.selectGoalRow(plan.goalId);
      if (goalRow === undefined) throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalInvalid);
      const goal = this.decodeGoalRow(goalRow);
      if (goal.status !== 'active') {
        throw new Error(PROJECT_GOAL_CONTINUATION_APPROVAL_ERRORS.approvalInvalid);
      }
      return approval;
    });
  }

  setGoalAutonomyPolicy(input: SetGoalAutonomyPolicyInput): ProjectGoalAutonomyPolicyRecord {
    return this.inTransaction(() => {
      const allowedKeys = ['goalId', 'mode', 'approver', 'maxCycles', 'elapsedBudgetMs', 'expiresAt'];
      if (
        !isRecord(input)
        || !Object.keys(input).every((key) => allowedKeys.includes(key))
        || typeof input.goalId !== 'string'
        || !PROJECT_GOAL_ID.test(input.goalId)
        || typeof input.mode !== 'string'
        || !AUTONOMY_MODE_SET.has(input.mode)
        || typeof input.approver !== 'string'
        || input.approver.length < 1
        || input.approver.length > AUTONOMY_POLICY_MAX_APPROVER_LENGTH
        || input.approver !== input.approver.trim()
        || (input.maxCycles !== undefined && (!isNonNegativeInteger(input.maxCycles) || input.maxCycles < 1 || input.maxCycles > 5))
        || (input.elapsedBudgetMs !== undefined && (!isNonNegativeInteger(input.elapsedBudgetMs) || input.elapsedBudgetMs === 0))
        || (input.expiresAt !== undefined && !isNonNegativeInteger(input.expiresAt))
      ) {
        throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.invalidInput);
      }
      const mode = input.mode as AutonomyMode;
      // Bounds are ONLY meaningful for bounded_autonomous; the schema CHECK
      // mirrors this. Reject early with a clean code.
      if (mode !== 'bounded_autonomous' && (input.maxCycles !== undefined || input.elapsedBudgetMs !== undefined)) {
        throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.invalidBounds);
      }

      const goalRow = this.selectGoalRow(input.goalId);
      if (goalRow === undefined) throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.goalNotFound);
      const goal = this.decodeGoalRow(goalRow);
      if (goal.status !== 'active') throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.goalTerminal);

      // maxCycles is a redundant convenience bound, clamped <= goal.maxAttempts.
      let maxCycles: number | undefined;
      if (input.maxCycles !== undefined) {
        maxCycles = Math.min(input.maxCycles, goal.maxAttempts);
      }
      const elapsedBudgetMs = input.elapsedBudgetMs;

      const now = this.now();
      const createdAt = Math.max(now, goal.createdAt);
      if (input.expiresAt !== undefined && input.expiresAt <= createdAt) {
        throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.invalidInput);
      }
      const meaning = autonomyPolicyMeaning({
        goalId: input.goalId,
        mode,
        maxCycles,
        elapsedBudgetMs,
        expiresAt: input.expiresAt,
      });
      const fingerprint = fingerprintAutonomyPolicy(meaning);

      const existingRow = this.selectGoalAutonomyPolicyRow(input.goalId);
      if (existingRow !== undefined) {
        const existing = this.decodeGoalAutonomyPolicyRow(existingRow);
        // Exact replay (same meaning) is idempotent; a mode transition or bound
        // change is a contradictory re-set and fails closed (operator-only
        // transition must go through an explicit, audited path — v1 conservatism).
        const existingMeaning = autonomyPolicyMeaning(existing);
        if (
          JSON.stringify(existingMeaning) !== JSON.stringify(meaning)
          || existing.approver !== input.approver
        ) {
          throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.contradictory);
        }
        return existing;
      }

      const policyId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_goal_autonomy_policies (
          policy_id, goal_id, mode, suspended_at, expires_at, revoked_at,
          max_cycles, elapsed_budget_ms, approver, created_at, updated_at, fingerprint
        ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        policyId,
        input.goalId,
        mode,
        input.expiresAt ?? null,
        maxCycles ?? null,
        elapsedBudgetMs ?? null,
        input.approver,
        createdAt,
        createdAt,
        fingerprint,
      );
      const inserted = this.selectGoalAutonomyPolicyRow(input.goalId);
      if (inserted === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeGoalAutonomyPolicyRow(inserted);
    });
  }

  readGoalAutonomyPolicy(goalId: string): ProjectGoalAutonomyPolicyRecord | undefined {
    return this.inTransaction(() => {
      if (typeof goalId !== 'string' || !PROJECT_GOAL_ID.test(goalId)) {
        throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.invalidInput);
      }
      const row = this.selectGoalAutonomyPolicyRow(goalId);
      return row === undefined ? undefined : this.decodeGoalAutonomyPolicyRow(row);
    });
  }

  suspendGoalAutonomy(goalId: string): ProjectGoalAutonomyPolicyRecord {
    return this.inTransaction(() => {
      if (typeof goalId !== 'string' || !PROJECT_GOAL_ID.test(goalId)) {
        throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.invalidInput);
      }
      const row = this.selectGoalAutonomyPolicyRow(goalId);
      if (row === undefined) throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.policyNotFound);
      const policy = this.decodeGoalAutonomyPolicyRow(row);
      if (policy.suspendedAt !== undefined) return policy;
      if (policy.revokedAt !== undefined) throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.notSuspended);
      const suspendedAt = Math.max(this.now(), policy.createdAt);
      this.database.prepare(`
        UPDATE project_goal_autonomy_policies SET suspended_at = ?, updated_at = ?
        WHERE goal_id = ? AND suspended_at IS NULL
      `).run(suspendedAt, suspendedAt, goalId);
      const updated = this.selectGoalAutonomyPolicyRow(goalId);
      if (updated === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeGoalAutonomyPolicyRow(updated);
    });
  }

  resumeGoalAutonomy(goalId: string): ProjectGoalAutonomyPolicyRecord {
    return this.inTransaction(() => {
      if (typeof goalId !== 'string' || !PROJECT_GOAL_ID.test(goalId)) {
        throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.invalidInput);
      }
      const row = this.selectGoalAutonomyPolicyRow(goalId);
      if (row === undefined) throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.policyNotFound);
      const policy = this.decodeGoalAutonomyPolicyRow(row);
      if (policy.suspendedAt === undefined) throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.notResumable);
      const resumedAt = Math.max(this.now(), policy.createdAt);
      this.database.prepare(`
        UPDATE project_goal_autonomy_policies SET suspended_at = NULL, updated_at = ?
        WHERE goal_id = ? AND suspended_at IS NOT NULL
      `).run(resumedAt, goalId);
      const updated = this.selectGoalAutonomyPolicyRow(goalId);
      if (updated === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeGoalAutonomyPolicyRow(updated);
    });
  }

  revokeGoalAutonomy(goalId: string): ProjectGoalAutonomyPolicyRecord {
    return this.inTransaction(() => {
      if (typeof goalId !== 'string' || !PROJECT_GOAL_ID.test(goalId)) {
        throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.invalidInput);
      }
      const row = this.selectGoalAutonomyPolicyRow(goalId);
      if (row === undefined) throw new Error(PROJECT_GOAL_AUTONOMY_POLICY_ERRORS.policyNotFound);
      const policy = this.decodeGoalAutonomyPolicyRow(row);
      if (policy.revokedAt !== undefined) return policy;
      const revokedAt = Math.max(this.now(), policy.createdAt);
      this.database.prepare(`
        UPDATE project_goal_autonomy_policies SET revoked_at = ?, updated_at = ?
        WHERE goal_id = ? AND revoked_at IS NULL
      `).run(revokedAt, revokedAt, goalId);
      const updated = this.selectGoalAutonomyPolicyRow(goalId);
      if (updated === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeGoalAutonomyPolicyRow(updated);
    });
  }

  createExecutionAuthorization(
    input: CreateExecutionAuthorizationInput,
  ): ProjectGoalContinuationExecutionAuthorizationRecord {
    return this.inTransaction(() => {
      const allowedKeys = ['goalId', 'taskId', 'planId', 'approver', 'expiresAt'];
      if (
        !isRecord(input)
        || !Object.keys(input).every((key) => allowedKeys.includes(key))
        || typeof input.goalId !== 'string'
        || !PROJECT_GOAL_ID.test(input.goalId)
        || typeof input.taskId !== 'string'
        || !PROJECT_TASK_ID.test(input.taskId)
        || typeof input.planId !== 'string'
        || !PROJECT_GOAL_ID.test(input.planId)
        || typeof input.approver !== 'string'
        || input.approver.length < 1
        || input.approver.length > EXECUTION_AUTHORIZATION_MAX_APPROVER_LENGTH
        || input.approver !== input.approver.trim()
        || (input.expiresAt !== undefined && !isNonNegativeInteger(input.expiresAt))
      ) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.invalidInput);
      }

      // The governing autonomy policy must already be opted into
      // approved_single_step; the authorization binds its exact fingerprint.
      const policyRow = this.selectGoalAutonomyPolicyRow(input.goalId);
      if (policyRow === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.policyRequired);
      }
      const policy = this.decodeGoalAutonomyPolicyRow(policyRow);
      if (policy.mode !== 'approved_single_step') {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.policyModeMismatch);
      }
      if (policy.suspendedAt !== undefined || policy.revokedAt !== undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.policyInvalid);
      }
      if (policy.expiresAt !== undefined && this.now() >= policy.expiresAt) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.policyInvalid);
      }

      // The task must be the exact materialized continuation task: accepted,
      // non-terminal, lineage bound to the goal, plan consumed to this task.
      const taskRow = this.selectRow(input.taskId);
      if (taskRow === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.taskNotFound);
      }
      const task = this.decodeRow(taskRow);
      if (task.status !== 'accepted' || task.terminalAt !== undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.taskNotAccepted);
      }
      if (task.lineage?.goalId !== input.goalId || task.lineage.parentTaskId === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.lineageMismatch);
      }
      const planRow = this.selectContinuationPlanRow(input.planId);
      if (planRow === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.planNotFound);
      }
      const plan = this.decodeContinuationPlanRow(planRow);
      if (plan.status !== 'consumed' || plan.createdTaskId !== input.taskId) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.planNotConsumed);
      }
      if (plan.goalId !== input.goalId) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.lineageMismatch);
      }

      const createdAt = Math.max(this.now(), plan.consumedAt ?? 0, task.createdAt);
      const expiresAt = input.expiresAt ?? createdAt + EXECUTION_AUTHORIZATION_DEFAULT_TTL_MS;
      if (expiresAt <= createdAt) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.invalidInput);
      }
      const fingerprint = fingerprintExecutionAuthorization({
        goalId: input.goalId,
        taskId: input.taskId,
        planId: input.planId,
        policyFingerprint: policy.fingerprint,
      });

      const existingRow = this.selectExecutionAuthorizationRowByTask(input.taskId);
      if (existingRow !== undefined) {
        const existing = this.decodeExecutionAuthorizationRow(existingRow);
        const effectiveExpiresAt = existing.expiresAt ?? existing.createdAt + EXECUTION_AUTHORIZATION_DEFAULT_TTL_MS;
        if (
          existing.approver !== input.approver
          || existing.expiresAt !== effectiveExpiresAt
          || existing.policyFingerprint !== policy.fingerprint
          || existing.planId !== input.planId
        ) {
          throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationContradictory);
        }
        return existing;
      }

      const authorizationId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_goal_continuation_execution_authorizations (
          authorization_id, goal_id, task_id, plan_id, policy_fingerprint,
          approver, created_at, expires_at, revoked_at, consumed_at, fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        authorizationId,
        input.goalId,
        input.taskId,
        input.planId,
        policy.fingerprint,
        input.approver,
        createdAt,
        expiresAt,
        fingerprint,
      );
      const inserted = this.selectExecutionAuthorizationRowByTask(input.taskId);
      if (inserted === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeExecutionAuthorizationRow(inserted);
    });
  }

  revokeExecutionAuthorization(
    authorizationId: string,
  ): ProjectGoalContinuationExecutionAuthorizationRecord {
    return this.inTransaction(() => {
      if (typeof authorizationId !== 'string' || !PROJECT_GOAL_ID.test(authorizationId)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.invalidInput);
      }
      const row = this.selectExecutionAuthorizationRowById(authorizationId);
      if (row === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationNotFound);
      }
      const authorization = this.decodeExecutionAuthorizationRow(row);
      if (authorization.revokedAt !== undefined) return authorization;
      if (authorization.consumedAt !== undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.notRevocable);
      }
      const revokedAt = Math.max(this.now(), authorization.createdAt);
      const changed = this.database.prepare(`
        UPDATE project_goal_continuation_execution_authorizations SET revoked_at = ?
        WHERE authorization_id = ? AND revoked_at IS NULL AND consumed_at IS NULL
      `).run(revokedAt, authorizationId);
      if (Number(changed.changes) !== 1) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.notRevocable);
      }
      const updated = this.selectExecutionAuthorizationRowById(authorizationId);
      if (updated === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeExecutionAuthorizationRow(updated);
    });
  }

  readExecutionAuthorization(
    authorizationId: string,
  ): ProjectGoalContinuationExecutionAuthorizationRecord | undefined {
    return this.inTransaction(() => {
      if (typeof authorizationId !== 'string' || !PROJECT_GOAL_ID.test(authorizationId)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.invalidInput);
      }
      const row = this.selectExecutionAuthorizationRowById(authorizationId);
      return row === undefined ? undefined : this.decodeExecutionAuthorizationRow(row);
    });
  }

  readExecutionAuthorizationByTask(
    taskId: string,
  ): ProjectGoalContinuationExecutionAuthorizationRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.invalidInput);
      }
      const row = this.selectExecutionAuthorizationRowByTask(taskId);
      return row === undefined ? undefined : this.decodeExecutionAuthorizationRow(row);
    });
  }

  consumeExecutionAuthorization(
    authorizationId: string,
  ): ProjectGoalContinuationExecutionAuthorizationRecord {
    return this.inTransaction(() => {
      if (typeof authorizationId !== 'string' || !PROJECT_GOAL_ID.test(authorizationId)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.invalidInput);
      }
      const row = this.selectExecutionAuthorizationRowById(authorizationId);
      if (row === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationNotFound);
      }
      const authorization = this.decodeExecutionAuthorizationRow(row);
      if (authorization.consumedAt !== undefined) return authorization;
      if (authorization.revokedAt !== undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationRevoked);
      }
      if (authorization.expiresAt !== undefined && this.now() >= authorization.expiresAt) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationExpired);
      }
      const consumedAt = Math.max(this.now(), authorization.createdAt);
      const changed = this.database.prepare(`
        UPDATE project_goal_continuation_execution_authorizations SET consumed_at = ?
        WHERE authorization_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
      `).run(consumedAt, authorizationId);
      if (Number(changed.changes) !== 1) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.notConsumable);
      }
      const updated = this.selectExecutionAuthorizationRowById(authorizationId);
      if (updated === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeExecutionAuthorizationRow(updated);
    });
  }

  assertExecutionAuthorizationValid(
    taskId: string,
  ): ProjectGoalContinuationExecutionAuthorizationRecord {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.invalidInput);
      }
      const row = this.selectExecutionAuthorizationRowByTask(taskId);
      if (row === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationRequired);
      }
      const authorization = this.decodeExecutionAuthorizationRow(row);
      if (authorization.revokedAt !== undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationRevoked);
      }
      if (authorization.consumedAt !== undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationConsumed);
      }
      if (authorization.expiresAt !== undefined && this.now() >= authorization.expiresAt) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationExpired);
      }
      // The authorization is only valid if it still binds the exact governing
      // policy fingerprint/version and that policy is still in force.
      const policyRow = this.selectGoalAutonomyPolicyRow(authorization.goalId);
      if (policyRow === undefined) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationInvalid);
      }
      const policy = this.decodeGoalAutonomyPolicyRow(policyRow);
      if (
        policy.fingerprint !== authorization.policyFingerprint
        || policy.mode !== 'approved_single_step'
        || policy.suspendedAt !== undefined
        || policy.revokedAt !== undefined
        || (policy.expiresAt !== undefined && this.now() >= policy.expiresAt)
      ) {
        throw new Error(PROJECT_GOAL_CONTINUATION_EXECUTION_AUTHORIZATION_ERRORS.authorizationInvalid);
      }
      return authorization;
    });
  }

  createGoal(input: CreateProjectGoalInput): ProjectGoalRecord {
    return this.inTransaction(() => this.createGoalInTx(input));
  }

  private createGoalInTx(input: CreateProjectGoalInput): ProjectGoalRecord {
    const maxAttempts = input.maxAttempts ?? PROJECT_GOAL_DEFAULT_MAX_ATTEMPTS;
    const continuationDepthLimit = input.continuationDepthLimit
      ?? PROJECT_GOAL_DEFAULT_CONTINUATION_DEPTH_LIMIT;
    if (
      !PROJECT_GOAL_ID.test(input.goalId)
      || typeof input.projectId !== 'string'
      || input.projectId.trim() === ''
      || typeof input.objective !== 'string'
      || input.objective.trim() === ''
      || input.objective.length > 20_000
      || !Number.isInteger(maxAttempts)
      || maxAttempts < 1
      || maxAttempts > PROJECT_GOAL_MAX_ATTEMPTS_LIMIT
      || !Number.isInteger(continuationDepthLimit)
      || continuationDepthLimit < 0
      || continuationDepthLimit > PROJECT_GOAL_CONTINUATION_DEPTH_LIMIT
    ) {
      throw new Error(PROJECT_GOAL_ERRORS.invalidGoal);
    }
    if (this.selectGoalRow(input.goalId) !== undefined) {
      throw new Error(PROJECT_GOAL_ERRORS.goalExists);
    }

    const now = this.now();
    this.database.prepare(`
      INSERT INTO project_goals (
        goal_id, project_id, objective, status, created_at, updated_at,
        current_attempt, max_attempts, continuation_depth_limit
      ) VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, ?)
    `).run(
      input.goalId,
      input.projectId,
      input.objective,
      now,
      now,
      maxAttempts,
      continuationDepthLimit,
    );
    const row = this.selectGoalRow(input.goalId);
    if (row === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
    return this.decodeGoalRow(row);
  }

  readGoal(goalId: string): ProjectGoalRecord | undefined {
    return this.inTransaction(() => {
      const row = this.selectGoalRow(goalId);
      return row === undefined ? undefined : this.decodeGoalRow(row);
    });
  }

  listActiveGoals(): ProjectGoalRecord[] {
    return this.inTransaction(() => {
      const rows = this.database.prepare(`
        SELECT goal_id, project_id, objective, status, created_at, updated_at, terminal_at,
               current_attempt, max_attempts, continuation_depth_limit, terminal_reason
        FROM project_goals WHERE status = 'active'
        ORDER BY created_at ASC, goal_id ASC
      `).all() as unknown as ProjectGoalRow[];
      return rows.map((row) => this.decodeGoalRow(row));
    });
  }

  /**
   * Bounded operator enumeration (design §A.1). The limit selects the NEWEST N
   * rows by `updated_at DESC, goal_id ASC`; the returned rows are then ordered
   * active-first, `created_at ASC, goal_id ASC` — exactly the `listActiveGoals`
   * order for the active group. Pure read; never writes.
   */
  listGoals(options: ListProjectGoalsOptions = {}): ProjectGoalRecord[] {
    return this.inTransaction(() => {
      const projectId = options.projectId;
      if (
        projectId !== undefined
        && (typeof projectId !== 'string' || projectId.trim() === '' || projectId.length > 120)
      ) {
        throw new Error(PROJECT_GOAL_ERRORS.invalidGoal);
      }
      const includeTerminal = options.includeTerminal !== false;
      const limit = options.limit === undefined
        ? 100
        : Math.min(100, Math.max(1, Math.floor(options.limit)));
      const rows = this.database.prepare(`
        SELECT goal_id, project_id, objective, status, created_at, updated_at, terminal_at,
               current_attempt, max_attempts, continuation_depth_limit, terminal_reason
        FROM (
          SELECT goal_id, project_id, objective, status, created_at, updated_at, terminal_at,
                 current_attempt, max_attempts, continuation_depth_limit, terminal_reason
          FROM project_goals
          WHERE (? = 1 OR status = 'active')
            AND (? IS NULL OR project_id = ?)
          ORDER BY updated_at DESC, goal_id ASC
          LIMIT ?
        )
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at ASC, goal_id ASC
      `).all(
        includeTerminal ? 1 : 0,
        projectId ?? null,
        projectId ?? null,
        limit,
      ) as unknown as ProjectGoalRow[];
      return rows.map((row) => this.decodeGoalRow(row));
    });
  }

  /**
   * Atomic intake composition (design §D/§N): one transaction that runs the
   * EXACT existing `createGoal` + `createGoalAttempt` validations and creates
   * the goal row plus the root attempt (`accepted`, never launched). A
   * non-created task result (capacity) rolls the whole transaction back —
   * creation is all-or-nothing, so the surface can never leave a goal without
   * its root attempt.
   */
  createGoalWithRootAttempt(
    input: CreateGoalWithRootAttemptInput,
  ): CreateGoalWithRootAttemptResult {
    return this.inTransaction(() => {
      const goal = this.createGoalInTx(input.goal);
      const task = this.createGoalAttemptInTx(input.rootAttempt);
      if (task.kind !== 'created') {
        throw new Error(PROJECT_GOAL_ERRORS.capacity);
      }
      return { goal, task };
    });
  }

  private createGoalAttempt(
    input: CreateRootAttemptInput | CreateContinuationAttemptInput,
  ): CreateProjectTaskResult {
    return this.inTransaction(() => this.createGoalAttemptInTx(input));
  }

  private createGoalAttemptInTx(
    input: CreateRootAttemptInput | CreateContinuationAttemptInput,
  ): CreateProjectTaskResult {
    this.pruneExpiredTerminals();
    if (
      !PROJECT_TASK_ID.test(input.taskId)
      || !PROJECT_GOAL_ID.test(input.goalId)
      || typeof input.fingerprint !== 'string'
      || input.fingerprint === ''
      || !isNonNegativeInteger(input.continuationDepth)
      || !isNonNegativeInteger(input.attemptNumber)
    ) {
      throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);
    }
      const intentValidation = validateProjectTaskRequest(input.intent);
      if (!intentValidation.success) throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);

      const goalRow = this.selectGoalRow(input.goalId);
      if (goalRow === undefined) throw new Error(PROJECT_GOAL_ERRORS.goalNotFound);
      const goal = this.decodeGoalRow(goalRow);
      if (goal.status !== 'active') throw new Error(PROJECT_GOAL_ERRORS.goalTerminal);
      if (intentValidation.request.projectId !== goal.projectId) {
        throw new Error(PROJECT_GOAL_ERRORS.parentProjectMismatch);
      }

      const parentTaskId = 'parentTaskId' in input ? input.parentTaskId : undefined;
      if (parentTaskId === input.taskId) throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);

      const existing = this.selectRow(input.taskId);
      if (existing !== undefined) {
        const record = this.decodeRow(existing);
        if (existing.fingerprint !== input.fingerprint) return { kind: 'conflict' };
        const expectedParent = 'parentTaskId' in input ? input.parentTaskId : undefined;
        if (
          record.lineage?.goalId !== input.goalId
          || record.lineage.parentTaskId !== expectedParent
          || record.lineage.continuationDepth !== input.continuationDepth
          || record.lineage.attemptNumber !== input.attemptNumber
        ) {
          throw new Error(PROJECT_GOAL_ERRORS.lineageImmutable);
        }
        return { kind: 'known', record };
      }

      if (parentTaskId === undefined) {
        if (input.continuationDepth !== 0 || input.attemptNumber !== 0 || goal.currentAttempt !== null) {
          throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);
        }
      } else {
        const parentRow = this.selectRow(parentTaskId);
        if (parentRow === undefined) throw new Error(PROJECT_GOAL_ERRORS.parentNotFound);
        const parent = this.decodeRow(parentRow);
        if (parent.intent.projectId !== intentValidation.request.projectId) {
          throw new Error(PROJECT_GOAL_ERRORS.parentProjectMismatch);
        }
        if (parent.lineage?.goalId !== input.goalId) {
          throw new Error(PROJECT_GOAL_ERRORS.parentGoalMismatch);
        }
        if (
          input.continuationDepth !== parent.lineage.continuationDepth + 1
          || input.attemptNumber !== parent.lineage.attemptNumber + 1
          || parent.lineage.attemptNumber !== goal.currentAttempt
        ) {
          throw new Error(PROJECT_GOAL_ERRORS.invalidLineage);
        }
        const parentCapabilities = new Set(parent.intent.requestedCapabilities);
        if (intentValidation.request.requestedCapabilities.some((capability) => !parentCapabilities.has(capability))) {
          throw new Error(PROJECT_GOAL_ERRORS.capabilityExpansion);
        }
      }

      if (input.attemptNumber >= goal.maxAttempts) {
        throw new Error(PROJECT_GOAL_ERRORS.attemptLimit);
      }
      if (input.continuationDepth > goal.continuationDepthLimit) {
        throw new Error(PROJECT_GOAL_ERRORS.depthLimit);
      }

      const counts = this.database.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN terminal_at IS NULL THEN 1 ELSE 0 END) AS active
        FROM project_tasks
      `).get() as unknown as { total: number; active: number | null };
      if (counts.total >= this.options.maxRecords || (counts.active ?? 0) >= this.options.maxActive) {
        return { kind: 'capacity' };
      }

      const now = this.now();
      this.database.prepare(`
        INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at)
        VALUES (?, ?, ?, 'accepted', ?, ?)
      `).run(input.taskId, input.fingerprint, JSON.stringify(intentValidation.request), now, now);
      this.database.prepare(`
        INSERT INTO project_task_lineage (
          task_id, goal_id, parent_task_id, continuation_depth, attempt_number
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.taskId,
        input.goalId,
        parentTaskId ?? null,
        input.continuationDepth,
        input.attemptNumber,
      );
      this.database.prepare('UPDATE project_goals SET updated_at = ? WHERE goal_id = ?')
        .run(now, input.goalId);

      const row = this.selectRow(input.taskId);
      if (row === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return { kind: 'created', record: this.decodeRow(row) };
  }

  createRootAttempt(input: CreateRootAttemptInput): CreateProjectTaskResult {
    return this.createGoalAttempt(input);
  }

  createContinuationAttempt(input: CreateContinuationAttemptInput): CreateProjectTaskResult {
    return this.createGoalAttempt(input);
  }

  listGoalAttempts(goalId: string): ProjectTaskRecord[] {
    return this.inTransaction(() => {
      const goal = this.selectGoalRow(goalId);
      if (goal === undefined) throw new Error(PROJECT_GOAL_ERRORS.goalNotFound);
      this.decodeGoalRow(goal);
      const rows = this.database.prepare(`
        SELECT t.task_id, t.fingerprint, t.intent_json, t.status, t.created_at, t.updated_at,
               t.terminal_at, t.receipt_json, t.error_json
        FROM project_task_lineage AS l
        JOIN project_tasks AS t ON t.task_id = l.task_id
        WHERE l.goal_id = ?
        ORDER BY l.attempt_number ASC, t.created_at ASC, t.task_id ASC
      `).all(goalId) as unknown as ProjectTaskRow[];
      return rows.map((row) => this.decodeRow(row));
    });
  }

  transitionGoal(
    goalId: string,
    status: ProjectGoalTerminalStatus,
    terminalReason?: ProjectGoalTerminalReason,
  ): ProjectGoalRecord {
    return this.inTransaction(() => {
      const row = this.selectGoalRow(goalId);
      if (row === undefined) throw new Error(PROJECT_GOAL_ERRORS.goalNotFound);
      const goal = this.decodeGoalRow(row);
      if (goal.status !== 'active') throw new Error(PROJECT_GOAL_ERRORS.invalidTransition);
      const expectedReasons: Record<ProjectGoalTerminalStatus, ProjectGoalTerminalReason> = {
        completed: 'objective_completed',
        blocked: 'human_intervention_required',
        exhausted: 'attempt_limit_reached',
        failed: 'unrecoverable_failure',
      };
      if (!Object.hasOwn(expectedReasons, status)) throw new Error(PROJECT_GOAL_ERRORS.invalidTransition);
      const reason = terminalReason ?? expectedReasons[status];
      if (reason !== expectedReasons[status]) throw new Error(PROJECT_GOAL_ERRORS.invalidTransition);
      const now = this.now();
      this.database.prepare(`
        UPDATE project_goals
        SET status = ?, terminal_reason = ?, updated_at = ?, terminal_at = ?
        WHERE goal_id = ? AND status = 'active'
      `).run(status, reason, now, now, goalId);
      const terminal = this.selectGoalRow(goalId);
      if (terminal === undefined) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      return this.decodeGoalRow(terminal);
    });
  }

  terminalizeGoal(
    goalId: string,
    status: ProjectGoalTerminalStatus,
    terminalReason?: ProjectGoalTerminalReason,
  ): ProjectGoalRecord {
    return this.transitionGoal(goalId, status, terminalReason);
  }

  createOrGet(taskId: string, fingerprint: string, intent: ProjectTaskRequest): CreateProjectTaskResult {
    return this.inTransaction(() => {
      this.pruneExpiredTerminals();

      const existing = this.selectRow(taskId);
      if (existing !== undefined) {
        const record = this.decodeRow(existing);
        return existing.fingerprint === fingerprint
          ? { kind: 'known', record }
          : { kind: 'conflict' };
      }

      const counts = this.database.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN terminal_at IS NULL THEN 1 ELSE 0 END) AS active
        FROM project_tasks
      `).get() as unknown as { total: number; active: number | null };

      const total = counts.total;
      const active = counts.active ?? 0;
      if (total >= this.options.maxRecords || active >= this.options.maxActive) {
        return { kind: 'capacity' };
      }

      const now = this.now();
      const record: ProjectTaskRecord = {
        taskId,
        fingerprint,
        intent,
        status: 'accepted',
        createdAt: now,
        updatedAt: now,
      };
      this.database.prepare(`
        INSERT INTO project_tasks (task_id, fingerprint, intent_json, status, created_at, updated_at)
        VALUES (?, ?, ?, 'accepted', ?, ?)
      `).run(taskId, fingerprint, JSON.stringify(intent), now, now);
      return { kind: 'created', record };
    });
  }

  get(taskId: string): ProjectTaskRecord | undefined {
    return this.inTransaction(() => {
      this.pruneExpiredTerminals();
      const row = this.selectRow(taskId);
      return row === undefined ? undefined : this.decodeRow(row);
    });
  }

  transition(taskId: string, status: Exclude<ProjectTaskStage, 'accepted' | 'completed' | 'failed'>): void {
    this.inTransaction(() => {
      this.pruneExpiredTerminals();
      const row = this.selectRow(taskId);
      if (row === undefined || row.terminal_at !== null) return;

      const current = this.decodeRow(row);
      let completedStages = [...(current.completedStages ?? [])];
      const currentIndex = ACTIVE_STAGE_INDEX.get(current.status);
      const nextIndex = ACTIVE_STAGE_INDEX.get(status);

      // Delayed/out-of-order observations may never move durable state
      // backwards. Keeping the latest confirmed boundary also keeps the
      // completed-stage evidence semantically consistent.
      if (
        currentIndex !== undefined
        && nextIndex !== undefined
        && nextIndex < currentIndex
      ) {
        return;
      }

      // A stage becomes durably complete only when a later observed stage
      // supersedes it. Canonical gaps remain gaps; they are never filled in.
      if (
        current.status !== status
        && currentIndex !== undefined
        && nextIndex !== undefined
        && currentIndex < nextIndex
      ) {
        const last = completedStages.at(-1);
        const lastIndex = last === undefined ? -1 : (ACTIVE_STAGE_INDEX.get(last) ?? -1);
        if (currentIndex > lastIndex) {
          const observed = ACTIVE_TASK_STAGES.find((stage) => stage === current.status);
          if (observed !== undefined) completedStages = [...completedStages, observed];
        }
      }

      if (!isActiveTaskCompletedStages(completedStages)) {
        throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
      }

      const now = this.now();
      this.database.prepare(`
        UPDATE project_tasks
        SET status = ?, updated_at = ?
        WHERE task_id = ?
      `).run(status, now, taskId);

      if (completedStages.length > 0) {
        this.database.prepare(`
          INSERT INTO project_task_active_stage_traces (task_id, completed_stages_json)
          VALUES (?, ?)
          ON CONFLICT(task_id) DO UPDATE
          SET completed_stages_json = excluded.completed_stages_json
        `).run(taskId, JSON.stringify(completedStages));
      }
    });
  }

  complete(taskId: string, receipt: SafeTaskReceipt): void {
    this.inTransaction(() => {
      this.pruneExpiredTerminals();
      const row = this.selectRow(taskId);
      if (row === undefined || row.terminal_at !== null) return;
      const now = this.now();
      this.database.prepare(`
        UPDATE project_tasks
        SET status = 'completed', receipt_json = ?, updated_at = ?, terminal_at = ?
        WHERE task_id = ?
      `).run(JSON.stringify(receipt), now, now, taskId);

      this.database.prepare(
        'DELETE FROM project_task_active_stage_traces WHERE task_id = ?',
      ).run(taskId);
    });
  }

  fail(taskId: string, error: SafeTaskError): void {
    this.inTransaction(() => {
      this.pruneExpiredTerminals();
      const row = this.selectRow(taskId);
      if (row === undefined || row.terminal_at !== null) return;
      const now = this.now();
      this.database.prepare(`
        UPDATE project_tasks
        SET status = 'failed', error_json = ?, updated_at = ?, terminal_at = ?
        WHERE task_id = ?
      `).run(JSON.stringify(error), now, now, taskId);

      this.database.prepare(
        'DELETE FROM project_task_active_stage_traces WHERE task_id = ?',
      ).run(taskId);
    });
  }

  /**
   * Atomically marks every task that survived a service restart without
   * reaching a terminal stage as failed with the workflow_interrupted error.
   *
   * Identity fields (task_id, fingerprint, intent_json, created_at) are
   * preserved; updated_at/terminal_at become now; any inconsistent receipt is
   * cleared. The operation is idempotent: already-terminal tasks (completed or
   * failed) are never touched and their timestamps stay unchanged.
   */
  reconcileInterruptedTasks(): number {
    return this.inTransaction(() => {
      const now = this.now();
      const interrupted: SafeTaskError = {
        code: 'workflow_interrupted',
        message: SAFE_TASK_ERROR_MESSAGES.workflow_interrupted,
      };
      const result = this.database.prepare(`
        UPDATE project_tasks
        SET status = 'failed',
            error_json = ?,
            receipt_json = NULL,
            updated_at = ?,
            terminal_at = ?
        WHERE status NOT IN ('completed', 'failed')
      `).run(JSON.stringify(interrupted), now, now);

      this.database.prepare(`
        DELETE FROM project_task_active_stage_traces
        WHERE task_id NOT IN (
          SELECT task_id
          FROM project_tasks
          WHERE terminal_at IS NULL
        )
      `).run();

      return Number(result.changes);
    });
  }

  /**
   * Atomically applies the conservative restart-safe recovery matrix.
   * Accepted tasks with an intact pending dispatch or a structurally valid
   * prepared execution run are preserved. A task with a durable launch attempt
   * is treated as an AMBIGUOUS EXTERNAL LAUNCH boundary and fails closed with
   * external_launch_outcome_unknown; it is never relaunched and no attempt,
   * dispatch, run, or lease operation is performed. When a durable launch
   * result exists the external outcome is KNOWN: failure outcomes fail closed
   * with the same safe outcome error, and a proposal_valid result WITHOUT a
   * snapshot (V12-era/historical/corrupt state) fails closed with
   * workflow_interrupted — never resumable, never upgraded. A proposal_valid
   * result WITH a validated snapshot on a PRE-Codex task (status below
   * 'codex', so the Codex call provably did not start) is PRESERVED
   * non-terminal as durably resumable (case 4): status normalized to 'hermes',
   * active trace ['planning','hermes'], zero Hermes, zero Codex, zero
   * attempt/result/lease operations. A proposal_valid result WITH a snapshot
   * on a POST-Codex task (status >= 'codex', Codex MAY have started) is NOT
   * resumable and fails closed with workflow_interrupted (case 9): the
   * snapshot is never replay permission for Codex. Terminal tasks are
   * untouched. All launch-result and snapshot relationships are validated
   * before any task state is mutated; corrupt relationships abort the whole
   * transaction atomically.
   */
  reconcileRestartSafeTasks(): ProjectTaskRestartRecoveryResult {
    return this.inTransaction(() => {
      const rows = this.database.prepare(`
        SELECT task_id, fingerprint, intent_json, status, created_at, updated_at,
               terminal_at, receipt_json, error_json
        FROM project_tasks
        ORDER BY task_id ASC
      `).all() as unknown as ProjectTaskRow[];
      const dispatchRows = this.database.prepare(`
        SELECT dispatch_id, task_id, created_at, consumed_at,
               consumed_lease_id, consumed_fencing_token
        FROM project_task_dispatch_outbox
        ORDER BY task_id ASC
      `).all() as unknown as ProjectTaskDispatchRow[];
      const traceRows = this.database.prepare(`
        SELECT task_id FROM project_task_active_stage_traces
        ORDER BY task_id ASC
      `).all() as unknown as Array<{ task_id: unknown }>;
      const executionRunRows = this.database.prepare(`
        SELECT execution_run_id, task_id, dispatch_id, preparation_lease_id,
               preparation_fencing_token, prepared_at
        FROM project_task_execution_runs
        ORDER BY task_id ASC
      `).all() as unknown as ProjectTaskExecutionRunRow[];
      const invocationRows = this.database.prepare(`
        SELECT invocation_id, execution_run_id, task_id, reservation_lease_id,
               reservation_fencing_token, reserved_at
        FROM project_task_execution_invocations
        ORDER BY task_id ASC
      `).all() as unknown as ProjectTaskExecutionInvocationRow[];
      const launchAttemptRows = this.database.prepare(`
        SELECT launch_attempt_id, invocation_id, execution_run_id, task_id,
               launch_lease_id, launch_fencing_token, boundary_crossed_at
        FROM project_task_execution_launch_attempts
        ORDER BY task_id ASC
      `).all() as unknown as ProjectTaskExecutionLaunchAttemptRow[];
      const launchResultRows = this.database.prepare(`
        SELECT launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
               task_id, outcome_class, recorded_at
        FROM project_task_execution_launch_results
        ORDER BY task_id ASC
      `).all() as unknown as ProjectTaskExecutionLaunchResultRow[];

      // Validate ordinary durable read shapes before making any change. Also
      // reject outbox references that do not resolve to exactly one task.
      const taskIds = new Set(rows.map((row) => row.task_id));
      for (const trace of traceRows) {
        if (typeof trace.task_id !== 'string' || !taskIds.has(trace.task_id)) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
      }
      const dispatchByTask = new Map<string, ProjectTaskDispatchRecord>();
      for (const row of dispatchRows) {
        const dispatch = this.decodeDispatchRow(row);
        if (!taskIds.has(dispatch.taskId) || dispatchByTask.has(dispatch.taskId)) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        if (dispatch.consumedAt !== undefined) {
          const generationRow = this.selectLeaseGenerationRow(
            dispatch.taskId,
            dispatch.consumedLeaseId as string,
            dispatch.consumedFencingToken as number,
          );
          if (generationRow === undefined) {
            throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
          }
          const generation = this.decodeLeaseRow(generationRow);
          if (
            dispatch.consumedAt < generation.acquiredAt
            || dispatch.consumedAt >= generation.leaseExpiresAt
          ) {
            throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
          }
        }
        dispatchByTask.set(dispatch.taskId, dispatch);
      }
      const executionRunByTask = new Map<string, ProjectTaskExecutionRunRecord>();
      for (const row of executionRunRows) {
        const executionRun = this.decodeExecutionRunRow(row);
        if (!taskIds.has(executionRun.taskId) || executionRunByTask.has(executionRun.taskId)) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        const dispatch = dispatchByTask.get(executionRun.taskId);
        if (
          dispatch === undefined
          || dispatch.dispatchId !== executionRun.dispatchId
          || dispatch.consumedAt === undefined
        ) throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        executionRunByTask.set(executionRun.taskId, executionRun);
      }
      const invocationIds = new Set<string>();
      const invocationRunIds = new Set<string>();
      const invocationTaskIds = new Set<string>();
      for (const row of invocationRows) {
        const invocation = this.decodeExecutionInvocationRow(row);
        const executionRun = executionRunByTask.get(invocation.taskId);
        if (
          !taskIds.has(invocation.taskId)
          || executionRun === undefined
          || executionRun.executionRunId !== invocation.executionRunId
          || invocationIds.has(invocation.invocationId)
          || invocationRunIds.has(invocation.executionRunId)
          || invocationTaskIds.has(invocation.taskId)
        ) throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.corruptRecord);
        invocationIds.add(invocation.invocationId);
        invocationRunIds.add(invocation.executionRunId);
        invocationTaskIds.add(invocation.taskId);
      }
      const launchAttemptByTask = new Map<string, ProjectTaskExecutionLaunchAttemptRecord>();
      const launchAttemptInvocationIds = new Set<string>();
      const launchAttemptRunIds = new Set<string>();
      for (const row of launchAttemptRows) {
        const attempt = this.decodeLaunchAttemptRow(row);
        if (
          !taskIds.has(attempt.taskId)
          || !invocationIds.has(attempt.invocationId)
          || !invocationRunIds.has(attempt.executionRunId)
          || launchAttemptByTask.has(attempt.taskId)
          || launchAttemptInvocationIds.has(attempt.invocationId)
          || launchAttemptRunIds.has(attempt.executionRunId)
        ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.corruptRecord);
        launchAttemptByTask.set(attempt.taskId, attempt);
        launchAttemptInvocationIds.add(attempt.invocationId);
        launchAttemptRunIds.add(attempt.executionRunId);
      }
      const launchResultByTask = new Map<string, ProjectTaskExecutionLaunchResultRecord>();
      const launchResultAttemptIds = new Set<string>();
      const launchResultInvocationIds = new Set<string>();
      const launchResultRunIds = new Set<string>();
      for (const row of launchResultRows) {
        const result = this.decodeLaunchResultRow(row);
        const attempt = launchAttemptByTask.get(result.taskId);
        if (
          !taskIds.has(result.taskId)
          || attempt === undefined
          || attempt.launchAttemptId !== result.launchAttemptId
          || attempt.invocationId !== result.invocationId
          || attempt.executionRunId !== result.executionRunId
          || launchResultByTask.has(result.taskId)
          || launchResultAttemptIds.has(result.launchAttemptId)
          || launchResultInvocationIds.has(result.invocationId)
          || launchResultRunIds.has(result.executionRunId)
        ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.corruptRecord);
        launchResultByTask.set(result.taskId, result);
        launchResultAttemptIds.add(result.launchAttemptId);
        launchResultInvocationIds.add(result.invocationId);
        launchResultRunIds.add(result.executionRunId);
      }
      const snapshotRows = this.database.prepare(`
        SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
               execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
               canonical_version, execution_mode, completion_mode,
               requires_human_approval, blocked_actions_json, recorded_at
        FROM project_task_validated_proposal_snapshots
        ORDER BY task_id ASC
      `).all() as unknown as ProjectTaskValidatedProposalSnapshotRow[];
      const resumeDecisionRows = this.database.prepare(`
        SELECT decision_id, task_id, snapshot_id, decision, refusal_reason,
               policy_fingerprint, recorded_at
        FROM project_task_resume_decisions
        ORDER BY task_id ASC
      `).all() as unknown as ProjectTaskResumeDecisionRow[];
      // Layer 13 snapshot pre-pass: EVERY snapshot must resolve to a
      // proposal_valid result with identical lineage, a recomputed
      // sha256(canonical) matching proposal_sha256, and exactly one snapshot
      // per task/attempt/invocation/run/result. ANY violation aborts the WHOLE
      // recovery transaction atomically (fail closed, zero partial
      // terminalization) before any task state is mutated.
      const snapshotByTask = new Map<string, ProjectTaskValidatedProposalSnapshotRecord>();
      const snapshotResultIds = new Set<string>();
      const snapshotAttemptIds = new Set<string>();
      const snapshotInvocationIds = new Set<string>();
      const snapshotRunIds = new Set<string>();
      for (const row of snapshotRows) {
        const snapshot = this.decodeValidatedProposalSnapshotRow(row);
        const result = launchResultByTask.get(snapshot.taskId);
        if (
          !taskIds.has(snapshot.taskId)
          || result === undefined
          || result.outcomeClass !== 'proposal_valid'
          || result.launchResultId !== snapshot.launchResultId
          || result.launchAttemptId !== snapshot.launchAttemptId
          || result.invocationId !== snapshot.invocationId
          || result.executionRunId !== snapshot.executionRunId
          || snapshotByTask.has(snapshot.taskId)
          || snapshotResultIds.has(snapshot.launchResultId)
          || snapshotAttemptIds.has(snapshot.launchAttemptId)
          || snapshotInvocationIds.has(snapshot.invocationId)
          || snapshotRunIds.has(snapshot.executionRunId)
          || createHash('sha256').update(snapshot.canonicalProposalJson).digest('hex')
            !== snapshot.proposalSha256
        ) throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.corruptRecord);
        snapshotByTask.set(snapshot.taskId, snapshot);
        snapshotResultIds.add(snapshot.launchResultId);
        snapshotAttemptIds.add(snapshot.launchAttemptId);
        snapshotInvocationIds.add(snapshot.invocationId);
        snapshotRunIds.add(snapshot.executionRunId);
      }
      // Layer 14 resume decision pre-pass: EVERY resume decision must
      // reference an existing task and an existing snapshot that belongs to
      // that task. One decision per task. Decision must be 'approved' or
      // 'refused'. Policy fingerprint must be 64-char lowercase hex. ANY
      // violation aborts the WHOLE recovery transaction atomically (fail
      // closed, zero partial terminalization) before any task state is
      // mutated.
      const resumeDecisionByTask = new Map<string, ProjectTaskResumeDecisionRecord>();
      const resumeDecisionIds = new Set<string>();
      const resumeDecisionSnapshotIds = new Set<string>();
      for (const row of resumeDecisionRows) {
        const decision = this.decodeResumeDecisionRow(row);
        if (
          !taskIds.has(decision.taskId)
          || !snapshotByTask.has(decision.taskId)
          || snapshotByTask.get(decision.taskId)!.snapshotId !== decision.snapshotId
          || resumeDecisionByTask.has(decision.taskId)
          || resumeDecisionIds.has(decision.decisionId)
          || resumeDecisionSnapshotIds.has(decision.snapshotId)
          || decision.policyFingerprint.length !== 64
          || !/^[0-9a-f]{64}$/.test(decision.policyFingerprint)
        ) throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.corruptRecord);
        resumeDecisionByTask.set(decision.taskId, decision);
        resumeDecisionIds.add(decision.decisionId);
        resumeDecisionSnapshotIds.add(decision.snapshotId);
      }

      // Layer 15 Codex evidence pre-pass: query and validate start and result
      // evidence. EVERY start evidence row must resolve to a complete lineage
      // chain. EVERY result evidence row must reference an existing start.
      // ONE start per task, ONE result per start. ANY violation aborts the
      // WHOLE recovery transaction atomically.
      const startEvidenceRows = this.database.prepare(`
        SELECT codex_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, start_recorded_at
        FROM project_task_codex_start_evidence
        ORDER BY task_id ASC
      `).all() as unknown as CodexStartEvidenceRow[];
      const resultEvidenceRows = this.database.prepare(`
        SELECT codex_result_id, codex_start_id, execution_id, outcome, success,
               error, summary, result_metadata_json, result_recorded_at
        FROM project_task_codex_result_evidence
        ORDER BY codex_start_id ASC
      `).all() as unknown as CodexResultEvidenceRow[];
      const codexStartByTask = new Map<string, CodexStartEvidenceRecord>();
      const codexStartIds = new Set<string>();
      const codexStartTaskIds = new Set<string>();
      for (const row of startEvidenceRows) {
        const start = this.decodeCodexStartEvidenceRow(row);
        if (
          !taskIds.has(start.taskId)
          || codexStartByTask.has(start.taskId)
          || codexStartIds.has(start.codexStartId)
          || codexStartTaskIds.has(start.taskId)
        ) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
        // Validate lineage chain: the start must reference a non-terminal task
        // with status in ('hermes', 'codex', 'verification', 'commit').
        // Later Layers (16/17/18) legitimately advance task status past
        // 'codex' while Codex evidence remains valid; rejecting those
        // statuses here would corrupt otherwise-valid recovery data.
        // Terminal tasks (completed/failed) are already excluded by
        // terminal_at !== null.
        const startTask = rows.find((r) => r.task_id === start.taskId);
        const activeValid = startTask !== undefined
          && startTask.terminal_at === null
          && (startTask.status === "hermes" || startTask.status === "codex" || startTask.status === "verification" || startTask.status === "commit");
        const terminalValid = startTask !== undefined
          && startTask.terminal_at !== null
          && (startTask.status === "completed" || startTask.status === "failed");
        if (activeValid === false && terminalValid === false) {
          throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
        }
        if (!launchAttemptByTask.has(start.taskId)) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
        const startResult = launchResultByTask.get(start.taskId);
        if (
          startResult === undefined
          || startResult.outcomeClass !== 'proposal_valid'
          || startResult.launchResultId !== start.launchResultId
        ) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
        if (!snapshotByTask.has(start.taskId)) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
        const startSnapshot = snapshotByTask.get(start.taskId)!;
        if (startSnapshot.snapshotId !== start.snapshotId) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
        codexStartByTask.set(start.taskId, start);
        codexStartIds.add(start.codexStartId);
        codexStartTaskIds.add(start.taskId);
      }
      const codexResultByStart = new Map<string, CodexResultEvidenceRecord>();
      const codexResultIds = new Set<string>();
      for (const row of resultEvidenceRows) {
        const result = this.decodeCodexResultEvidenceRow(row);
        const start = codexStartByTask.get(
          // Result's start is identified by codex_start_id; find the task via start evidence
          [...codexStartByTask.entries()].find(([, s]) => s.codexStartId === result.codexStartId)?.[0] ?? '',
        );
        if (
          start === undefined
          || !codexStartIds.has(result.codexStartId)
          || codexResultByStart.has(result.codexStartId)
          || codexResultIds.has(result.codexResultId)
        ) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
        codexResultByStart.set(result.codexStartId, result);
        codexResultIds.add(result.codexResultId);
      }

      // Layer 17 verification evidence pre-pass: query and validate start and
      // result evidence. EVERY start must resolve to a complete lineage chain
      // including codex_success. EVERY result must reference an existing start.
      // ONE start per task, ONE result per start. ANY violation aborts the
      // WHOLE recovery transaction atomically.
      const verifyStartRows = this.database.prepare(`
        SELECT verification_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               execution_id, start_recorded_at
        FROM project_task_verification_start_evidence
        ORDER BY task_id ASC
      `).all() as unknown as VerificationStartEvidenceRow[];
      const verifyResultRows = this.database.prepare(`
        SELECT verification_result_id, verification_start_id, status,
               checks_passed, total_checks, technical_checks_passed,
               technical_total_checks, visual_checks_passed, visual_total_checks,
               failure_error, failure_summary, result_recorded_at
        FROM project_task_verification_result_evidence
        ORDER BY verification_start_id ASC
      `).all() as unknown as VerificationResultEvidenceRow[];

      const verifyStartByTask = new Map<string, VerificationStartEvidenceRecord>();
      const verifyStartIds = new Set<string>();
      for (const row of verifyStartRows) {
        const start = this.decodeVerificationStartEvidenceRow(row);
        if (
          !taskIds.has(start.taskId)
          || verifyStartByTask.has(start.taskId)
          || verifyStartIds.has(start.verificationStartId)
        ) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        // Must reference a valid task with compatible status.
        // A task at 'commit' legitimately still has verification
        // evidence (Layer 17: status transitions past 'verification'
        // after evidence is recorded). Terminal tasks are excluded
        // by the terminal_at guard below.
        const verifyTask = rows.find((r) => r.task_id === start.taskId);
        if (
          verifyTask === undefined
          || (
            verifyTask.status !== 'codex'
            && verifyTask.status !== 'verification'
            && verifyTask.status !== 'commit'
          )
          || verifyTask.terminal_at !== null
        ) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        // Must reference a valid codex start with codex_success
        if (!codexStartByTask.has(start.taskId)) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        const codexStart = codexStartByTask.get(start.taskId)!;
        if (codexStart.codexStartId !== start.codexStartId) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        const codexResult = codexResultByStart.get(start.codexStartId);
        if (codexResult === undefined || codexResult.outcome !== 'codex_success') throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        if (codexResult.executionId !== start.executionId) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        // Must reference complete lineage
        if (!launchAttemptByTask.has(start.taskId)) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        const launchResult = launchResultByTask.get(start.taskId);
        if (launchResult === undefined || launchResult.outcomeClass !== 'proposal_valid' || launchResult.launchResultId !== start.launchResultId) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        if (!snapshotByTask.has(start.taskId) || snapshotByTask.get(start.taskId)!.snapshotId !== start.snapshotId) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        verifyStartByTask.set(start.taskId, start);
        verifyStartIds.add(start.verificationStartId);
      }

      const verifyResultByStart = new Map<string, VerificationResultEvidenceRecord>();
      const verifyResultIds = new Set<string>();
      for (const row of verifyResultRows) {
        const result = this.decodeVerificationResultEvidenceRow(row);
        if (
          !verifyStartIds.has(result.verificationStartId)
          || verifyResultByStart.has(result.verificationStartId)
          || verifyResultIds.has(result.verificationResultId)
        ) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        verifyResultByStart.set(result.verificationStartId, result);
        verifyResultIds.add(result.verificationResultId);
      }

      // Layer 17 commit evidence pre-pass: query and validate start and result
      // evidence. EVERY start must reference verified verification + codex_success.
      // EVERY result must reference an existing start. ONE start per task, ONE
      // result per start. ANY violation aborts the WHOLE recovery transaction.
      const commitStartRows = this.database.prepare(`
        SELECT commit_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               verification_start_id, execution_id, start_recorded_at
        FROM project_task_commit_start_evidence
        ORDER BY task_id ASC
      `).all() as unknown as CommitStartEvidenceRow[];
      const commitResultRows = this.database.prepare(`
        SELECT commit_result_id, commit_start_id, status, commit_sha, error,
               summary, result_recorded_at
        FROM project_task_commit_result_evidence
        ORDER BY commit_start_id ASC
      `).all() as unknown as CommitResultEvidenceRow[];

      const commitStartByTask = new Map<string, CommitStartEvidenceRecord>();
      const commitStartIds = new Set<string>();
      for (const row of commitStartRows) {
        const start = this.decodeCommitStartEvidenceRow(row);
        if (
          !taskIds.has(start.taskId)
          || commitStartByTask.has(start.taskId)
          || commitStartIds.has(start.commitStartId)
        ) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        // Must reference verified verification
        if (!verifyStartByTask.has(start.taskId)) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        const verifyStart = verifyStartByTask.get(start.taskId)!;
        if (verifyStart.verificationStartId !== start.verificationStartId) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        const verifyResult = verifyResultByStart.get(start.verificationStartId);
        if (verifyResult === undefined || verifyResult.status !== 'verified') throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        // Must reference codex_start with codex_success
        if (!codexStartByTask.has(start.taskId) || codexStartByTask.get(start.taskId)!.codexStartId !== start.codexStartId) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        if (verifyStart.executionId !== start.executionId) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        // Task must have compatible status
        const commitTask = rows.find((r) => r.task_id === start.taskId);
        if (
          commitTask === undefined
          || (commitTask.status !== 'codex' && commitTask.status !== 'verification' && commitTask.status !== 'commit')
          || commitTask.terminal_at !== null
        ) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        commitStartByTask.set(start.taskId, start);
        commitStartIds.add(start.commitStartId);
      }

      const commitResultByStart = new Map<string, CommitResultEvidenceRecord>();
      const commitResultIds = new Set<string>();
      for (const row of commitResultRows) {
        const result = this.decodeCommitResultEvidenceRow(row);
        if (
          !commitStartIds.has(result.commitStartId)
          || commitResultByStart.has(result.commitStartId)
          || commitResultIds.has(result.commitResultId)
        ) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        commitResultByStart.set(result.commitStartId, result);
        commitResultIds.add(result.commitResultId);
      }

      // Layer 18 completion evidence pre-pass: query and validate.
      // EVERY completion evidence row must reference a valid task with valid
      // receipt JSON. ONE row per task (unique index enforced at table level).
      // ANY violation aborts the WHOLE recovery transaction atomically.
      const completionEvidenceRows = this.database.prepare(`
        SELECT completion_evidence_id, task_id, execution_run_id,
               invocation_id, launch_attempt_id, launch_result_id, snapshot_id,
               codex_start_id, verification_start_id, commit_start_id,
               receipt_json, recorded_at
        FROM project_task_completion_evidence
        ORDER BY task_id ASC
      `).all() as unknown as CompletionEvidenceRow[];

      const completionEvidenceByTask = new Map<string, ProjectTaskCompletionEvidenceRecord>();
      const completionEvidenceIds = new Set<string>();
      for (const row of completionEvidenceRows) {
        const evidence = this.decodeCompletionEvidenceRow(row);
        if (
          !taskIds.has(evidence.taskId)
          || completionEvidenceByTask.has(evidence.taskId)
          || completionEvidenceIds.has(evidence.completionEvidenceId)
        ) throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
        // Validate the receipt JSON parses to a safe receipt
        let receipt: unknown;
        try { receipt = JSON.parse(evidence.receiptJson); } catch { throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord); }
        if (!isSafeTaskReceipt(receipt)) throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
        completionEvidenceByTask.set(evidence.taskId, evidence);
        completionEvidenceIds.add(evidence.completionEvidenceId);
      }

      let restartedCompleted = 0;

      let codexStartNotRecordedTaskIds: string[] = [];
      let codexResultNotRecordedTaskIds: string[] = [];
      let codexSuccessTaskIds: Array<{ taskId: string; codexStartId: string }> = [];
      let codexFailedTaskIds: string[] = [];

      let failedTaskIds: string[] = [];
      let ambiguousLaunchTaskIds: string[] = [];
      let knownOutcomeTaskIds: Array<{ taskId: string; outcomeClass: ProjectTaskExecutionLaunchResultOutcome }> = [];
      let resumableTaskIds: string[] = [];
      let refusedResumeTaskIds: string[] = [];
      let preservedRecoverable = 0;
      let terminalUnchanged = 0;
      for (const row of rows) {
        // A legacy nonterminal receipt is explicitly cleared when that task is
        // failed. It must still be a valid safe receipt, and it is never
        // tolerated on a task that could otherwise be preserved.
        const rawDispatch = typeof row.task_id === 'string'
          ? dispatchByTask.get(row.task_id)
          : undefined;
        const rawExecutionRun = typeof row.task_id === 'string'
          ? executionRunByTask.get(row.task_id)
          : undefined;
        if (rawDispatch?.consumedAt === undefined && rawExecutionRun !== undefined) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        // A launch attempt marks the AMBIGUOUS EXTERNAL LAUNCH boundary: the
        // external launch MAY have occurred before the crash, so the task must
        // never be preserved for automatic relaunch. With a durable launch
        // result the external outcome is KNOWN: recovery still performs zero
        // Hermes/Codex/lease/attempt/result operations and only surfaces the
        // same safe failure (workflow_interrupted for proposal_valid, which
        // has no automatic local resume).
        const isAmbiguousLaunch = typeof row.task_id === 'string'
          && launchAttemptByTask.has(row.task_id);
        const couldBePreserved = !isAmbiguousLaunch
          && row.status === 'accepted'
          && rawDispatch !== undefined
          && (
            rawDispatch.consumedAt === undefined
            || rawExecutionRun !== undefined
          );
        let rowForDecode = row;
        if (!couldBePreserved && row.terminal_at === null && row.receipt_json !== null) {
          if (typeof row.receipt_json !== 'string') {
            throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
          }
          let receipt: unknown;
          try {
            receipt = JSON.parse(row.receipt_json);
          } catch {
            throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
          }
          if (!isSafeTaskReceipt(receipt)) {
            throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
          }
          rowForDecode = { ...row, receipt_json: null };
        }
        const task = this.decodeRow(rowForDecode);
        if (task.status === 'completed' || task.status === 'failed') {
          terminalUnchanged += 1;
          continue;
        }
        // Layer 18: delegate tasks with completion evidence to the
        // post-processing completion bridge (below).  Do NOT classify or
        // terminalize them here — the bridge owns the closed-chain
        // completion decision with full cross-validation.
        if (completionEvidenceByTask.has(task.taskId)) {
          continue;
        }
        if (launchAttemptByTask.has(task.taskId)) {
          // Layer 17: tasks at 'verification' or 'commit' have progressed
          // past the ambiguous-launch boundary.  Delegate to the
          // status-specific evidence handlers below instead of the generic
          // launch-attempt classification path (which would incorrectly
          // terminalize tasks whose evidence chain proves success).
          if (task.status !== 'verification' && task.status !== 'commit') {
            const result = launchResultByTask.get(task.taskId);
            if (result === undefined) {
              ambiguousLaunchTaskIds = [...ambiguousLaunchTaskIds, task.taskId];
            } else if (
              result.outcomeClass === 'proposal_valid'
              && snapshotByTask.has(task.taskId)
              && (
                task.status === 'accepted'
                || task.status === 'planning'
                || task.status === 'hermes'
              )
            ) {
              // Layer 13-14 recovery cases 4/10/11: a pre-Codex task (status
              // below 'codex', so the Codex call is provably NOT started)
              // carrying a validated proposal snapshot.
              // - Case 4 (no resume decision): preserved resumable
              // - Case 10 (refused decision): force-terminalize resume_refused
              // - Case 11 (approved decision): preserved resumable
              const resumeDecision = resumeDecisionByTask.get(task.taskId);
              if (resumeDecision !== undefined && resumeDecision.decision === 'refused') {
                // Case 10: resume decision 'refused' on pre-Codex task but
                // not yet terminalized → force-terminalize with resume_refused.
                refusedResumeTaskIds = [...refusedResumeTaskIds, task.taskId];
              } else {
                // Case 4 (no resume decision) or Case 11 (approved):
                // preserved resumable. Status is normalized to 'hermes' and
                // the active trace to ['planning','hermes'] (idempotent).
                // Zero Hermes, zero Codex, zero new attempt/result/lease
                // operations. Approval and blocked-action facts stay gated
                // via the snapshot.
                resumableTaskIds = [...resumableTaskIds, task.taskId];
              }
            } else if (
              result.outcomeClass === 'proposal_valid'
              && snapshotByTask.has(task.taskId)
            ) {
              // Layer 14 recovery case 12: proposal_valid + snapshot but task
              // status >= 'codex' → Codex MAY have started. Check if there's an
              // approved resume decision (which means we authorized resume but
              // Codex may have started). Either way, fail closed.
              const resumeDecision = resumeDecisionByTask.get(task.taskId);
              if (
                resumeDecision !== undefined
                && resumeDecision.decision === 'approved'
              ) {
                // Case 12: approved + status >= 'codex' → workflow_interrupted.
                knownOutcomeTaskIds = [
                  ...knownOutcomeTaskIds,
                  { taskId: task.taskId, outcomeClass: 'proposal_valid' },
                ];
              } else {
                knownOutcomeTaskIds = [
                  ...knownOutcomeTaskIds,
                  { taskId: task.taskId, outcomeClass: result.outcomeClass },
                ];
              }
            } else {
              knownOutcomeTaskIds = [
                ...knownOutcomeTaskIds,
                { taskId: task.taskId, outcomeClass: result.outcomeClass },
              ];
            }
            continue;
          }
          // Fall through to status-specific handlers for verification/commit
        }
        // Layer 15: status='codex' recovery.
        // The Codex phase has been entered (status transition was durable).
        // Determine whether start/result evidence exists and handle accordingly.
        if (task.status === 'codex') {
          const codexStart = codexStartByTask.get(task.taskId);
          if (codexStart === undefined) {
            // V14-era: status='codex' with no start evidence.
            // Also: crash between 'codex' transition and start INSERT.
            codexStartNotRecordedTaskIds = [...codexStartNotRecordedTaskIds, task.taskId];
            continue;
          }
          const codexResult = codexResultByStart.get(codexStart.codexStartId);
          if (codexResult === undefined) {
            // Start evidence exists, no result evidence.
            // Codex was initiated but outcome unknown.
            codexResultNotRecordedTaskIds = [...codexResultNotRecordedTaskIds, task.taskId];
            continue;
          }
          // Result evidence exists
          if (codexResult.outcome === 'codex_success') {
            // Codex completed successfully. For layer 15, preserve the task
            // for potential verification continuation (section S).
            // Don't terminalize — the result is known good.
            codexSuccessTaskIds = [
              ...codexSuccessTaskIds,
              { taskId: task.taskId, codexStartId: codexStart.codexStartId },
            ];
            continue;
          }
          // codex_failed or codex_interrupted
            codexFailedTaskIds = [...codexFailedTaskIds, task.taskId];
          continue;
        }
        // Layer 17: verification/commit status recovery.
        if (task.status === 'verification') {
          const verifyStart = verifyStartByTask.get(task.taskId);
          if (verifyStart === undefined) {
            // M9: pre-L17 task at verification, no evidence.
            // Terminalize as workflow_interrupted (pre-existing behavior).
            knownOutcomeTaskIds = [
              ...knownOutcomeTaskIds,
              { taskId: task.taskId, outcomeClass: 'proposal_valid' },
            ];
            continue;
          }
          const verifyResult = verifyResultByStart.get(verifyStart.verificationStartId);
          if (verifyResult === undefined) {
            // M1/C1: start evidence exists, no result. Verification was initiated
            // but outcome unknown. Terminalize as verification_result_not_recorded.
            failedTaskIds = [...failedTaskIds, task.taskId];
            continue;
          }
          if (verifyResult.status === 'verified') {
            // M2/M3: verification passed. Preserve resumable.
            const codexStart = codexStartByTask.get(task.taskId);
            if (codexStart !== undefined) {
              codexSuccessTaskIds = [
                ...codexSuccessTaskIds,
                { taskId: task.taskId, codexStartId: codexStart.codexStartId },
              ];
            }
            continue;
          }
          // M4: verification_failed. Terminalize.
          failedTaskIds = [...failedTaskIds, task.taskId];
          continue;
        }
        if (task.status === 'commit') {
          const commitStart = commitStartByTask.get(task.taskId);
          if (commitStart === undefined) {
            // M9: pre-L17 task at commit, no evidence.
            // Terminalize as workflow_interrupted.
            knownOutcomeTaskIds = [
              ...knownOutcomeTaskIds,
              { taskId: task.taskId, outcomeClass: 'proposal_valid' },
            ];
            continue;
          }
          const commitResult = commitResultByStart.get(commitStart.commitStartId);
          if (commitResult === undefined) {
            // M5: start evidence exists, no result. Commit initiated but
            // outcome unknown. Terminalize as commit_result_not_recorded.
            failedTaskIds = [...failedTaskIds, task.taskId];
            continue;
          }
          if (commitResult.status === 'committed') {
            // M6: committed. Preserve resumable.
            const codexStart = codexStartByTask.get(task.taskId);
            if (codexStart !== undefined) {
              codexSuccessTaskIds = [
                ...codexSuccessTaskIds,
                { taskId: task.taskId, codexStartId: codexStart.codexStartId },
              ];
            }
            continue;
          }
          // M7: commit_failed or nothing_to_commit. Terminalize.
          failedTaskIds = [...failedTaskIds, task.taskId];
          continue;
        }
        const dispatch = dispatchByTask.get(task.taskId);
        const executionRun = executionRunByTask.get(task.taskId);
        if (
          task.status === 'accepted'
          && dispatch !== undefined
          && (dispatch.consumedAt === undefined || executionRun !== undefined)
        ) {
          preservedRecoverable += 1;
          continue;
        }
        failedTaskIds = [...failedTaskIds, task.taskId];
      }

      const interrupted: SafeTaskError = {
        code: 'workflow_interrupted',
        message: SAFE_TASK_ERROR_MESSAGES.workflow_interrupted,
      };
      const ambiguousLaunch: SafeTaskError = {
        code: 'external_launch_outcome_unknown',
        message: SAFE_TASK_ERROR_MESSAGES.external_launch_outcome_unknown,
      };
      const knownOutcomeError = (outcomeClass: ProjectTaskExecutionLaunchResultOutcome): SafeTaskError => {
        switch (outcomeClass) {
          case 'timeout':
            return { code: 'timeout', message: SAFE_TASK_ERROR_MESSAGES.timeout };
          case 'execution_failed':
            return { code: 'execution_failed', message: SAFE_TASK_ERROR_MESSAGES.execution_failed };
          case 'empty_response':
            return { code: 'empty_response', message: SAFE_TASK_ERROR_MESSAGES.empty_response };
          case 'invalid_hermes_json':
            return { code: 'invalid_hermes_json', message: SAFE_TASK_ERROR_MESSAGES.invalid_hermes_json };
          case 'invalid_hermes_proposal':
            return { code: 'invalid_hermes_proposal', message: SAFE_TASK_ERROR_MESSAGES.invalid_hermes_proposal };
          case 'proposal_valid':
            // The external phase completed, but Layer 12 deliberately adds no
            // automatic local resume: fail safe with workflow_interrupted.
            return { code: 'workflow_interrupted', message: SAFE_TASK_ERROR_MESSAGES.workflow_interrupted };
        }
      };
      const resumeRefused: SafeTaskError = {
        code: 'resume_refused',
        message: SAFE_TASK_ERROR_MESSAGES.resume_refused,
        stage: 'hermes',
      };
      const now = this.now();
      const fail = this.database.prepare(`
        UPDATE project_tasks
        SET status = 'failed', error_json = ?, receipt_json = NULL,
            updated_at = ?, terminal_at = ?
        WHERE task_id = ? AND status NOT IN ('completed', 'failed')
      `);
      const clearTrace = this.database.prepare(
        'DELETE FROM project_task_active_stage_traces WHERE task_id = ?',
      );
      for (const taskId of failedTaskIds) {
        const result = fail.run(JSON.stringify(interrupted), now, now, taskId);
        if (Number(result.changes) !== 1) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        clearTrace.run(taskId);
      }
      for (const taskId of ambiguousLaunchTaskIds) {
        const result = fail.run(JSON.stringify(ambiguousLaunch), now, now, taskId);
        if (Number(result.changes) !== 1) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        clearTrace.run(taskId);
      }
      for (const { taskId, outcomeClass } of knownOutcomeTaskIds) {
        const result = fail.run(JSON.stringify(knownOutcomeError(outcomeClass)), now, now, taskId);
        if (Number(result.changes) !== 1) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        clearTrace.run(taskId);
      }
      for (const taskId of refusedResumeTaskIds) {
        const result = fail.run(JSON.stringify(resumeRefused), now, now, taskId);
        if (Number(result.changes) !== 1) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        clearTrace.run(taskId);
      }
      // Layer 15: terminalize codex-start-not-recorded tasks as workflow_interrupted.
      // This includes V14-era codex tasks with no start evidence and tasks crashed
      // between the 'codex' transition and the start INSERT.
      const codexStartNotRecorded: SafeTaskError = {
        code: 'workflow_interrupted',
        message: SAFE_TASK_ERROR_MESSAGES.workflow_interrupted,
      };
      for (const taskId of codexStartNotRecordedTaskIds) {
        const result = fail.run(JSON.stringify(codexStartNotRecorded), now, now, taskId);
        if (Number(result.changes) !== 1) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        clearTrace.run(taskId);
      }
      // Layer 15: terminalize codex-result-not-recorded tasks.
      const codexResultNotRecorded: SafeTaskError = {
        code: 'codex_result_not_recorded',
        message: 'Codex inició su ejecución pero LÍA no pudo registrar su resultado de forma duradera.',
        stage: 'codex',
      };
      for (const taskId of codexResultNotRecordedTaskIds) {
        const result = fail.run(JSON.stringify(codexResultNotRecorded), now, now, taskId);
        if (Number(result.changes) !== 1) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        clearTrace.run(taskId);
      }
      // Layer 15: terminalize codex-failed tasks.
      const codexFailed: SafeTaskError = {
        code: 'codex_failed',
        message: 'Codex no pudo completar la ejecución.',
        stage: 'codex',
      };
      for (const taskId of codexFailedTaskIds) {
        const result = fail.run(JSON.stringify(codexFailed), now, now, taskId);
        if (Number(result.changes) !== 1) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        clearTrace.run(taskId);
      }
      // Layer 17: terminalize verification_result_not_recorded tasks.
      // These are tasks with verification_start evidence but no result.
      const verificationResultNotRecorded: SafeTaskError = {
        code: 'verification_result_not_recorded',
        message: 'LÍA inició la verificación pero no pudo registrar el resultado.',
        stage: 'verification',
      };
      // Layer 17: terminalize commit_result_not_recorded tasks.
      // These are tasks with commit_start evidence but no result.
      const commitResultNotRecorded: SafeTaskError = {
        code: 'commit_result_not_recorded',
        message: 'LÍA inició el commit local pero no pudo registrar el resultado.',
        stage: 'commit',
      };
      // Layer 17: terminalize verification_failed tasks.
      const verificationFailed: SafeTaskError = {
        code: 'verification_failed',
        message: 'Verification checks did not pass.',
        stage: 'verification',
      };
      // Layer 17: terminalize commit_failed tasks.
      const commitFailed: SafeTaskError = {
        code: 'commit_failed',
        message: 'The local commit could not be created.',
        stage: 'commit',
      };
      // Layer 15: codex success tasks are preserved (not terminalized).
      // non-terminal (no terminal_at, no error); status is normalized to
      // 'hermes' and the active trace to ['planning'] (the stage BEFORE
      // the current active status; the decode invariant requires completed
      // stages to be strictly earlier than current status).
      const resume = this.database.prepare(`
        UPDATE project_tasks
        SET status = 'hermes', updated_at = ?
        WHERE task_id = ? AND status NOT IN ('completed', 'failed')
      `);
      const upsertTrace = this.database.prepare(`
        INSERT INTO project_task_active_stage_traces (task_id, completed_stages_json)
        VALUES (?, ?)
        ON CONFLICT(task_id) DO UPDATE
        SET completed_stages_json = excluded.completed_stages_json
      `);
      for (const taskId of resumableTaskIds) {
        const result = resume.run(now, taskId);
        if (Number(result.changes) !== 1) {
          throw new Error(PROJECT_TASK_SQLITE_ERRORS.corruptRecord);
        }
        upsertTrace.run(taskId, JSON.stringify(['planning']));
      }

      // Layer 18: Post-processing completion bridge.
      // For non-terminal tasks with valid completion evidence, safely
      // complete them without replaying any prior non-idempotent operation.
      // Evidence is state-only — never authority. Completion only occurs
      // when ALL lineage links + receipt cross-validation pass.
      for (const row of rows) {
        const taskId = row.task_id as string;
        // Skip already-terminal tasks
        if (row.status === 'completed' || row.status === 'failed') continue;
        // Skip tasks without completion evidence (no crash window to close)
        const evidence = completionEvidenceByTask.get(taskId);
        if (evidence === undefined) continue;

        // Validate lineage integrity: every ID in the chain must
        // reference the correct task.
        const executionRun = executionRunByTask.get(taskId);
        if (
          executionRun === undefined
          || executionRun.executionRunId !== evidence.executionRunId
        ) continue; // Fail closed — broken lineage

        // invocation is keyed by executionRunId (unique), we need to verify
        // Find invocation for this task
        let invocationMatch = false;
        for (const invRow of invocationRows) {
          if (invRow.task_id === taskId && invRow.invocation_id === evidence.invocationId && invRow.execution_run_id === evidence.executionRunId) {
            invocationMatch = true;
            break;
          }
        }
        if (!invocationMatch) continue;

        if (!launchAttemptByTask.has(taskId)) continue;
        const launchAttempt = launchAttemptByTask.get(taskId)!;
        if (launchAttempt.invocationId !== evidence.invocationId || launchAttempt.launchAttemptId !== evidence.launchAttemptId) continue;

        if (!launchResultByTask.has(taskId)) continue;
        const launchResult = launchResultByTask.get(taskId)!;
        if (launchResult.launchAttemptId !== evidence.launchAttemptId || launchResult.launchResultId !== evidence.launchResultId) continue;

        if (!snapshotByTask.has(taskId)) continue;
        const snapshot = snapshotByTask.get(taskId)!;
        if (snapshot.launchResultId !== evidence.launchResultId || snapshot.snapshotId !== evidence.snapshotId) continue;

        // Parse and validate receipt
        let receipt: SafeTaskReceipt;
        try {
          const parsed = JSON.parse(evidence.receiptJson);
          if (!isSafeTaskReceipt(parsed)) continue;
          receipt = parsed;
        } catch { continue; }

        // Cross-validate codex evidence if provided
        if (evidence.codexStartId !== null) {
          const codexStart = codexStartByTask.get(taskId);
          if (codexStart === undefined || codexStart.codexStartId !== evidence.codexStartId) continue;
          const codexResult = codexResultByStart.get(evidence.codexStartId);
          if (codexResult === undefined) continue;
          if (receipt.status !== 'analyzed' && codexResult.outcome !== 'codex_success') continue;
        }

        // Cross-validate verification evidence if status requires it
        if (receipt.status === 'verified' || receipt.status === 'committed') {
          if (evidence.verificationStartId === null) continue;
          const verifyStart = verifyStartByTask.get(taskId);
          if (verifyStart === undefined || verifyStart.verificationStartId !== evidence.verificationStartId) continue;
          const verifyResult = verifyResultByStart.get(evidence.verificationStartId);
          if (verifyResult === undefined || verifyResult.status !== 'verified') continue;
          // Cross-validate checksPassed/totalChecks match receipt
          if (receipt.verification !== undefined) {
            if (receipt.verification.checksPassed !== verifyResult.checksPassed) continue;
            if (receipt.verification.totalChecks !== verifyResult.totalChecks) continue;
          }
        }

        // Cross-validate commit evidence if status requires it
        if (receipt.status === 'committed') {
          if (evidence.commitStartId === null) continue;
          const commitStart = commitStartByTask.get(taskId);
          if (commitStart === undefined || commitStart.commitStartId !== evidence.commitStartId) continue;
          const commitResult = commitResultByStart.get(evidence.commitStartId);
          if (commitResult === undefined || commitResult.status !== 'committed') continue;
          // Cross-validate commit SHA
          if (receipt.commit !== undefined && commitResult.commitSha !== receipt.commit) continue;
        }

        // All validations passed — safely complete the task.
        // Do NOT call this.complete() here — we are already inside the
        // reconciliation inTransaction() and complete() starts another
        // inTransaction(), which would cause a nested-transaction error.
        // Perform the equivalent terminal completion UPDATE directly.
        // Atomic, fail-closed: skip already-terminal rows.
        const completionNow = this.now();
        const completionResult = this.database.prepare(`
          UPDATE project_tasks
          SET status = 'completed', receipt_json = ?,
              updated_at = ?, terminal_at = ?
          WHERE task_id = ? AND status NOT IN ('completed', 'failed')
        `).run(JSON.stringify(receipt), completionNow, completionNow, taskId);
        if (Number(completionResult.changes) !== 1) {
          // Task was already terminal or doesn't exist — not an error, skip.
          continue;
        }
        this.database.prepare(
          'DELETE FROM project_task_active_stage_traces WHERE task_id = ?',
        ).run(taskId);
        restartedCompleted += 1;
      }

      return {
        preservedRecoverable,
        failedInterrupted:
          failedTaskIds.length + ambiguousLaunchTaskIds.length
          + knownOutcomeTaskIds.length + refusedResumeTaskIds.length
          + codexStartNotRecordedTaskIds.length
          + codexResultNotRecordedTaskIds.length
          + codexFailedTaskIds.length,
        terminalUnchanged,
        resumableAvailable: resumableTaskIds.length,
      };
    });
  }

  enqueueTaskDispatch(taskId: string): ProjectTaskDispatchRecord {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      }
      const task = this.selectRow(taskId);
      if (task === undefined) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.taskNotFound);
      if (task.status !== 'accepted' || task.terminal_at !== null) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.taskUnavailable);
      }
      const existing = this.database.prepare(`
        SELECT dispatch_id, task_id, created_at, consumed_at,
               consumed_lease_id, consumed_fencing_token
        FROM project_task_dispatch_outbox WHERE task_id = ?
      `).get(taskId) as unknown as ProjectTaskDispatchRow | undefined;
      if (existing !== undefined) return this.decodeDispatchRow(existing);

      const createdAt = this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      }
      const dispatchId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_dispatch_outbox (dispatch_id, task_id, created_at)
        VALUES (?, ?, ?)
      `).run(dispatchId, taskId, createdAt);
      const inserted = this.selectDispatchRow(dispatchId);
      if (inserted === undefined) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.corruptRecord);
      return this.decodeDispatchRow(inserted);
    });
  }

  readTaskDispatch(dispatchId: string): ProjectTaskDispatchRecord | undefined {
    return this.inTransaction(() => {
      if (typeof dispatchId !== 'string' || !PROJECT_TASK_ID.test(dispatchId)) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      }
      const row = this.selectDispatchRow(dispatchId);
      return row === undefined ? undefined : this.decodeDispatchRow(row);
    });
  }

  readTaskDispatchByTask(taskId: string): ProjectTaskDispatchRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      }
      const row = this.database.prepare(`
        SELECT dispatch_id, task_id, created_at, consumed_at,
               consumed_lease_id, consumed_fencing_token
        FROM project_task_dispatch_outbox WHERE task_id = ?
      `).get(taskId) as unknown as ProjectTaskDispatchRow | undefined;
      return row === undefined ? undefined : this.decodeDispatchRow(row);
    });
  }

  listPendingTaskDispatches(limit: number): ProjectTaskDispatchRecord[] {
    return this.inTransaction(() => {
      if (
        typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > PROJECT_TASK_DISPATCH_MAX_LIST_LIMIT
      ) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      const rows = this.database.prepare(`
        SELECT dispatch_id, task_id, created_at, consumed_at,
               consumed_lease_id, consumed_fencing_token
        FROM project_task_dispatch_outbox
        WHERE consumed_at IS NULL
        ORDER BY created_at ASC, dispatch_id ASC
        LIMIT ?
      `).all(limit) as unknown as ProjectTaskDispatchRow[];
      return rows.map((row) => this.decodeDispatchRow(row));
    });
  }

  claimTaskDispatch(input: ClaimProjectTaskDispatchInput): ProjectTaskDispatchClaim {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      const keys = Object.keys(input);
      if (
        keys.length !== 3
        || !keys.every((key) => ['dispatchId', 'leaseOwner', 'durationMs'].includes(key))
        || typeof input.dispatchId !== 'string'
        || !PROJECT_TASK_ID.test(input.dispatchId)
        || !this.validateLeaseOwner(input.leaseOwner)
        || !this.validLeaseDuration(input.durationMs)
      ) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      const row = this.selectDispatchRow(input.dispatchId);
      if (row === undefined) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.dispatchNotFound);
      const dispatch = this.decodeDispatchRow(row);
      if (dispatch.consumedAt !== undefined) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.alreadyConsumed);
      }
      const task = this.selectRow(dispatch.taskId);
      if (task === undefined || task.status !== 'accepted' || task.terminal_at !== null) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.taskUnavailable);
      }
      const lease = this.acquireTaskLeaseInTransaction({
        taskId: dispatch.taskId,
        leaseOwner: input.leaseOwner,
        durationMs: input.durationMs,
      });
      return { dispatch, lease };
    });
  }

  /** Dispatcher consumption logic for callers already holding BEGIN IMMEDIATE. */
  private consumeTaskDispatchInTransaction(
    input: ConsumeProjectTaskDispatchInput,
    operationTime?: number,
  ): ProjectTaskDispatchRecord {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      const keys = Object.keys(input);
      if (
        keys.length !== 5
        || !keys.every((key) => [
          'dispatchId', 'taskId', 'leaseOwner', 'leaseId', 'fencingToken',
        ].includes(key))
        || typeof input.dispatchId !== 'string'
        || !PROJECT_TASK_ID.test(input.dispatchId)
        || !this.validLeaseAuthority({
          taskId: input.taskId,
          leaseOwner: input.leaseOwner,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
        })
      ) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);

      const row = this.selectDispatchRow(input.dispatchId);
      if (row === undefined) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.dispatchNotFound);
      const dispatch = this.decodeDispatchRow(row);
      if (dispatch.taskId !== input.taskId) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.authorityMismatch);
      }

      const authority: ProjectTaskLeaseAuthority = {
        taskId: input.taskId,
        leaseOwner: input.leaseOwner,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
      };
      if (dispatch.consumedAt !== undefined) {
        if (
          dispatch.consumedLeaseId !== input.leaseId
          || dispatch.consumedFencingToken !== input.fencingToken
        ) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.authorityMismatch);
        const generationRow = this.selectLeaseGenerationRow(
          input.taskId,
          input.leaseId,
          input.fencingToken,
        );
        if (generationRow === undefined) {
          throw new Error(PROJECT_TASK_DISPATCH_ERRORS.authorityMismatch);
        }
        const generation = this.decodeLeaseRow(generationRow);
        if (!this.leaseAuthorityMatches(generation, authority)) {
          throw new Error(PROJECT_TASK_DISPATCH_ERRORS.authorityMismatch);
        }
        return dispatch;
      }

      const task = this.selectRow(input.taskId);
      if (task === undefined || task.status !== 'accepted' || task.terminal_at !== null) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.taskUnavailable);
      }
      const currentRow = this.selectCurrentLeaseRow(input.taskId);
      if (currentRow === undefined) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.authorityMismatch);
      const current = this.decodeLeaseRow(currentRow);
      if (!this.leaseAuthorityMatches(current, authority)) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.authorityMismatch);
      }
      const now = operationTime ?? this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.invalidInput);
      }
      const consumedAt = Math.max(now, dispatch.createdAt, current.acquiredAt);
      if (consumedAt >= current.leaseExpiresAt) throw new Error(PROJECT_TASK_LEASE_ERRORS.expired);
      const consumed = this.database.prepare(`
        UPDATE project_task_dispatch_outbox
        SET consumed_at = ?, consumed_lease_id = ?, consumed_fencing_token = ?
        WHERE dispatch_id = ? AND task_id = ? AND consumed_at IS NULL
      `).run(consumedAt, input.leaseId, input.fencingToken, input.dispatchId, input.taskId);
      if (Number(consumed.changes) !== 1) {
        throw new Error(PROJECT_TASK_DISPATCH_ERRORS.authorityMismatch);
      }
      const updated = this.selectDispatchRow(input.dispatchId);
      if (updated === undefined) throw new Error(PROJECT_TASK_DISPATCH_ERRORS.corruptRecord);
      return this.decodeDispatchRow(updated);
  }

  consumeTaskDispatch(input: ConsumeProjectTaskDispatchInput): ProjectTaskDispatchRecord {
    return this.inTransaction(() => this.consumeTaskDispatchInTransaction(input));
  }

  prepareTaskExecutionRun(
    input: PrepareProjectTaskExecutionRunInput,
  ): ProjectTaskExecutionRunRecord {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.invalidInput);
      const keys = Object.keys(input);
      if (
        keys.length !== 5
        || !keys.every((key) => [
          'dispatchId', 'taskId', 'leaseOwner', 'leaseId', 'fencingToken',
        ].includes(key))
        || typeof input.dispatchId !== 'string'
        || !PROJECT_TASK_ID.test(input.dispatchId)
        || !this.validLeaseAuthority({
          taskId: input.taskId,
          leaseOwner: input.leaseOwner,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
        })
      ) throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.invalidInput);

      const authority: ProjectTaskLeaseAuthority = {
        taskId: input.taskId,
        leaseOwner: input.leaseOwner,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
      };
      const existingRow = this.selectExecutionRunByTaskRow(input.taskId);
      if (existingRow !== undefined) {
        const existing = this.decodeExecutionRunRow(existingRow);
        const generationRow = this.selectLeaseGenerationRow(
          existing.taskId,
          existing.preparationLeaseId,
          existing.preparationFencingToken,
        );
        if (generationRow === undefined) throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.corruptRecord);
        const generation = this.decodeLeaseRow(generationRow);
        if (
          existing.dispatchId !== input.dispatchId
          || existing.preparationLeaseId !== input.leaseId
          || existing.preparationFencingToken !== input.fencingToken
          || !this.leaseAuthorityMatches(generation, authority)
        ) throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.authorityMismatch);
        return existing;
      }

      const task = this.selectRow(input.taskId);
      if (task === undefined) throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.taskNotFound);
      if (task.status !== 'accepted' || task.terminal_at !== null) {
        throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.taskUnavailable);
      }
      const dispatchRow = this.selectDispatchRow(input.dispatchId);
      if (dispatchRow === undefined) throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.dispatchNotFound);
      const dispatch = this.decodeDispatchRow(dispatchRow);
      if (dispatch.taskId !== input.taskId) {
        throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.authorityMismatch);
      }
      if (dispatch.consumedAt !== undefined) {
        // Historical consumed rows without a run retain their ambiguity.
        throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.dispatchUnavailable);
      }

      const operationTime = this.now();
      const consumed = this.consumeTaskDispatchInTransaction(input, operationTime);
      if (consumed.consumedAt === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.corruptRecord);
      }
      const executionRunId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_execution_runs (
          execution_run_id, task_id, dispatch_id, preparation_lease_id,
          preparation_fencing_token, prepared_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        executionRunId,
        input.taskId,
        input.dispatchId,
        input.leaseId,
        input.fencingToken,
        consumed.consumedAt,
      );
      const inserted = this.selectExecutionRunRow(executionRunId);
      if (inserted === undefined) throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.corruptRecord);
      return this.decodeExecutionRunRow(inserted);
    });
  }

  readTaskExecutionRun(executionRunId: string): ProjectTaskExecutionRunRecord | undefined {
    return this.inTransaction(() => {
      if (typeof executionRunId !== 'string' || !PROJECT_TASK_ID.test(executionRunId)) {
        throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.invalidInput);
      }
      const row = this.selectExecutionRunRow(executionRunId);
      return row === undefined ? undefined : this.decodeExecutionRunRow(row);
    });
  }

  readTaskExecutionRunByTask(taskId: string): ProjectTaskExecutionRunRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.invalidInput);
      }
      const row = this.selectExecutionRunByTaskRow(taskId);
      return row === undefined ? undefined : this.decodeExecutionRunRow(row);
    });
  }

  listPreparedTaskExecutionRuns(limit: number): ProjectTaskExecutionRunRecord[] {
    return this.inTransaction(() => {
      if (
        typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > PROJECT_TASK_EXECUTION_RUN_MAX_LIST_LIMIT
      ) throw new Error(PROJECT_TASK_EXECUTION_RUN_ERRORS.invalidInput);
      const rows = this.database.prepare(`
        SELECT execution_run_id, task_id, dispatch_id, preparation_lease_id,
               preparation_fencing_token, prepared_at
        FROM project_task_execution_runs
        ORDER BY prepared_at ASC, execution_run_id ASC
        LIMIT ?
      `).all(limit) as unknown as ProjectTaskExecutionRunRow[];
      return rows.map((row) => this.decodeExecutionRunRow(row));
    });
  }

  reserveTaskExecutionInvocation(
    input: ReserveProjectTaskExecutionInvocationInput,
  ): ProjectTaskExecutionInvocationRecord {
    return this.inTransaction(() => {
      if (!isRecord(input)) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.invalidInput);
      }
      const keys = Object.keys(input);
      if (
        keys.length !== 5
        || !keys.every((key) => [
          'executionRunId', 'taskId', 'leaseOwner', 'leaseId', 'fencingToken',
        ].includes(key))
        || typeof input.executionRunId !== 'string'
        || !PROJECT_TASK_ID.test(input.executionRunId)
        || !this.validLeaseAuthority({
          taskId: input.taskId,
          leaseOwner: input.leaseOwner,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
        })
      ) throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.invalidInput);

      const existingByRun = this.selectExecutionInvocationByRunRow(input.executionRunId);
      const existingByTask = this.selectExecutionInvocationByTaskRow(input.taskId);
      if (existingByRun !== undefined || existingByTask !== undefined) {
        if (existingByRun === undefined || existingByTask === undefined) {
          throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.authorityMismatch);
        }
        const byRun = this.decodeExecutionInvocationRow(existingByRun);
        const byTask = this.decodeExecutionInvocationRow(existingByTask);
        if (
          byRun.invocationId !== byTask.invocationId
          || byRun.executionRunId !== input.executionRunId
          || byRun.taskId !== input.taskId
          || byRun.reservationLeaseId !== input.leaseId
          || byRun.reservationFencingToken !== input.fencingToken
        ) throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.authorityMismatch);
        const generationRow = this.selectLeaseGenerationRow(
          byRun.taskId,
          byRun.reservationLeaseId,
          byRun.reservationFencingToken,
        );
        if (generationRow === undefined) {
          throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.corruptRecord);
        }
        const generation = this.decodeLeaseRow(generationRow);
        if (generation.leaseOwner !== input.leaseOwner) {
          throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.authorityMismatch);
        }
        return byRun;
      }

      const task = this.selectRow(input.taskId);
      if (task === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.taskNotFound);
      }
      if (task.status !== 'accepted' || task.terminal_at !== null) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.taskUnavailable);
      }
      const executionRunRow = this.selectExecutionRunRow(input.executionRunId);
      if (executionRunRow === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.executionRunNotFound);
      }
      const executionRun = this.decodeExecutionRunRow(executionRunRow);
      if (executionRun.taskId !== input.taskId) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.runTaskMismatch);
      }

      const authority: ProjectTaskLeaseAuthority = {
        taskId: input.taskId,
        leaseOwner: input.leaseOwner,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
      };
      const currentRow = this.selectCurrentLeaseRow(input.taskId);
      if (currentRow === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.authorityMismatch);
      }
      const current = this.decodeLeaseRow(currentRow);
      if (!this.leaseAuthorityMatches(current, authority)) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.authorityMismatch);
      }
      const latest = this.database.prepare(`
        SELECT MAX(fencing_token) AS latest_token
        FROM project_task_lease_generations WHERE task_id = ?
      `).get(input.taskId) as unknown as { latest_token: unknown };
      if (latest.latest_token !== input.fencingToken) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.authorityMismatch);
      }
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.invalidInput);
      }
      const reservedAt = Math.max(now, current.acquiredAt);
      if (reservedAt >= current.leaseExpiresAt) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.expired);
      }

      const invocationId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_execution_invocations (
          invocation_id, execution_run_id, task_id, reservation_lease_id,
          reservation_fencing_token, reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        invocationId,
        input.executionRunId,
        input.taskId,
        input.leaseId,
        input.fencingToken,
        reservedAt,
      );
      const inserted = this.selectExecutionInvocationRow(invocationId);
      if (inserted === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.corruptRecord);
      }
      return this.decodeExecutionInvocationRow(inserted);
    });
  }

  readTaskExecutionInvocation(
    invocationId: string,
  ): ProjectTaskExecutionInvocationRecord | undefined {
    return this.inTransaction(() => {
      if (typeof invocationId !== 'string' || !PROJECT_TASK_ID.test(invocationId)) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.invalidInput);
      }
      const row = this.selectExecutionInvocationRow(invocationId);
      return row === undefined ? undefined : this.decodeExecutionInvocationRow(row);
    });
  }

  readTaskExecutionInvocationByRun(
    executionRunId: string,
  ): ProjectTaskExecutionInvocationRecord | undefined {
    return this.inTransaction(() => {
      if (typeof executionRunId !== 'string' || !PROJECT_TASK_ID.test(executionRunId)) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.invalidInput);
      }
      const row = this.selectExecutionInvocationByRunRow(executionRunId);
      return row === undefined ? undefined : this.decodeExecutionInvocationRow(row);
    });
  }

  readTaskExecutionInvocationByTask(
    taskId: string,
  ): ProjectTaskExecutionInvocationRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.invalidInput);
      }
      const row = this.selectExecutionInvocationByTaskRow(taskId);
      return row === undefined ? undefined : this.decodeExecutionInvocationRow(row);
    });
  }

  listReservedTaskExecutionInvocations(
    limit: number,
  ): ProjectTaskExecutionInvocationRecord[] {
    return this.inTransaction(() => {
      if (
        typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > PROJECT_TASK_EXECUTION_INVOCATION_MAX_LIST_LIMIT
      ) throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.invalidInput);
      const rows = this.database.prepare(`
        SELECT invocation_id, execution_run_id, task_id, reservation_lease_id,
               reservation_fencing_token, reserved_at
        FROM project_task_execution_invocations
        ORDER BY reserved_at ASC, invocation_id ASC
        LIMIT ?
      `).all(limit) as unknown as ProjectTaskExecutionInvocationRow[];
      return rows.map((row) => this.decodeExecutionInvocationRow(row));
    });
  }

  beginTaskExecutionLaunchAttempt(
    input: BeginProjectTaskExecutionLaunchAttemptInput,
  ): BeginProjectTaskExecutionLaunchAttemptResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invalidInput);
      }
      const keys = Object.keys(input);
      if (
        keys.length !== 6
        || !keys.every((key) => [
          'invocationId', 'executionRunId', 'taskId', 'leaseOwner', 'leaseId', 'fencingToken',
        ].includes(key))
        || typeof input.invocationId !== 'string'
        || !PROJECT_TASK_ID.test(input.invocationId)
        || typeof input.executionRunId !== 'string'
        || !PROJECT_TASK_ID.test(input.executionRunId)
        || !this.validLeaseAuthority({
          taskId: input.taskId,
          leaseOwner: input.leaseOwner,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
        })
      ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invalidInput);

      const existingByInvocation = this.selectLaunchAttemptByInvocationRow(input.invocationId);
      const existingByRun = this.selectLaunchAttemptByRunRow(input.executionRunId);
      const existingByTask = this.selectLaunchAttemptByTaskRow(input.taskId);
      if (
        existingByInvocation !== undefined
        || existingByRun !== undefined
        || existingByTask !== undefined
      ) {
        if (
          existingByInvocation === undefined
          || existingByRun === undefined
          || existingByTask === undefined
        ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.authorityMismatch);
        const byInvocation = this.decodeLaunchAttemptRow(existingByInvocation);
        const byRun = this.decodeLaunchAttemptRow(existingByRun);
        const byTask = this.decodeLaunchAttemptRow(existingByTask);
        if (
          byInvocation.launchAttemptId !== byRun.launchAttemptId
          || byInvocation.launchAttemptId !== byTask.launchAttemptId
          || byInvocation.executionRunId !== input.executionRunId
          || byInvocation.taskId !== input.taskId
          || byInvocation.launchLeaseId !== input.leaseId
          || byInvocation.launchFencingToken !== input.fencingToken
        ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.authorityMismatch);
        const generationRow = this.selectLeaseGenerationRow(
          byInvocation.taskId,
          byInvocation.launchLeaseId,
          byInvocation.launchFencingToken,
        );
        if (generationRow === undefined) {
          throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.corruptRecord);
        }
        const generation = this.decodeLeaseRow(generationRow);
        if (generation.leaseOwner !== input.leaseOwner) {
          throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.authorityMismatch);
        }
        return { launchAttempt: byInvocation, created: false };
      }

      const task = this.selectRow(input.taskId);
      if (task === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.taskNotFound);
      }
      if ((task.status !== 'accepted' && task.status !== 'planning') || task.terminal_at !== null) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.taskUnavailable);
      }
      const invocationRow = this.selectExecutionInvocationRow(input.invocationId);
      if (invocationRow === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invocationNotFound);
      }
      const invocation = this.decodeExecutionInvocationRow(invocationRow);
      if (invocation.executionRunId !== input.executionRunId || invocation.taskId !== input.taskId) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invocationRunMismatch);
      }

      const authority: ProjectTaskLeaseAuthority = {
        taskId: input.taskId,
        leaseOwner: input.leaseOwner,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
      };
      const currentRow = this.selectCurrentLeaseRow(input.taskId);
      if (currentRow === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.authorityMismatch);
      }
      const current = this.decodeLeaseRow(currentRow);
      if (!this.leaseAuthorityMatches(current, authority)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.authorityMismatch);
      }
      const latest = this.database.prepare(`
        SELECT MAX(fencing_token) AS latest_token
        FROM project_task_lease_generations WHERE task_id = ?
      `).get(input.taskId) as unknown as { latest_token: unknown };
      if (latest.latest_token !== input.fencingToken) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.authorityMismatch);
      }
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invalidInput);
      }
      const boundaryCrossedAt = Math.max(now, invocation.reservedAt, current.acquiredAt);
      if (boundaryCrossedAt >= current.leaseExpiresAt) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.expired);
      }

      const launchAttemptId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_execution_launch_attempts (
          launch_attempt_id, invocation_id, execution_run_id, task_id,
          launch_lease_id, launch_fencing_token, boundary_crossed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        launchAttemptId,
        input.invocationId,
        input.executionRunId,
        input.taskId,
        input.leaseId,
        input.fencingToken,
        boundaryCrossedAt,
      );
      const inserted = this.selectLaunchAttemptRow(launchAttemptId);
      if (inserted === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.corruptRecord);
      }
      return { launchAttempt: this.decodeLaunchAttemptRow(inserted), created: true };
    });
  }

  readTaskExecutionLaunchAttempt(
    launchAttemptId: string,
  ): ProjectTaskExecutionLaunchAttemptRecord | undefined {
    return this.inTransaction(() => {
      if (typeof launchAttemptId !== 'string' || !PROJECT_TASK_ID.test(launchAttemptId)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invalidInput);
      }
      const row = this.selectLaunchAttemptRow(launchAttemptId);
      return row === undefined ? undefined : this.decodeLaunchAttemptRow(row);
    });
  }

  readTaskExecutionLaunchAttemptByInvocation(
    invocationId: string,
  ): ProjectTaskExecutionLaunchAttemptRecord | undefined {
    return this.inTransaction(() => {
      if (typeof invocationId !== 'string' || !PROJECT_TASK_ID.test(invocationId)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invalidInput);
      }
      const row = this.selectLaunchAttemptByInvocationRow(invocationId);
      return row === undefined ? undefined : this.decodeLaunchAttemptRow(row);
    });
  }

  readTaskExecutionLaunchAttemptByTask(
    taskId: string,
  ): ProjectTaskExecutionLaunchAttemptRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invalidInput);
      }
      const row = this.selectLaunchAttemptByTaskRow(taskId);
      return row === undefined ? undefined : this.decodeLaunchAttemptRow(row);
    });
  }

  listTaskExecutionLaunchAttempts(
    limit: number,
  ): ProjectTaskExecutionLaunchAttemptRecord[] {
    return this.inTransaction(() => {
      if (
        typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_MAX_LIST_LIMIT
      ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_ATTEMPT_ERRORS.invalidInput);
      const rows = this.database.prepare(`
        SELECT launch_attempt_id, invocation_id, execution_run_id, task_id,
               launch_lease_id, launch_fencing_token, boundary_crossed_at
        FROM project_task_execution_launch_attempts
        ORDER BY boundary_crossed_at ASC, launch_attempt_id ASC
        LIMIT ?
      `).all(limit) as unknown as ProjectTaskExecutionLaunchAttemptRow[];
      return rows.map((row) => this.decodeLaunchAttemptRow(row));
    });
  }

  recordTaskExecutionLaunchResult(
    input: RecordProjectTaskExecutionLaunchResultInput,
  ): RecordProjectTaskExecutionLaunchResultResult {
    return this.inTransaction(() => {
      if (
        !isRecord(input)
        || Object.keys(input).length !== 5
        || !Object.keys(input).every((key) => [
          'launchAttemptId', 'invocationId', 'executionRunId', 'taskId', 'outcomeClass',
        ].includes(key))
        || typeof input.launchAttemptId !== 'string'
        || !PROJECT_TASK_ID.test(input.launchAttemptId)
        || typeof input.invocationId !== 'string'
        || !PROJECT_TASK_ID.test(input.invocationId)
        || typeof input.executionRunId !== 'string'
        || !PROJECT_TASK_ID.test(input.executionRunId)
        || typeof input.taskId !== 'string'
        || !PROJECT_TASK_ID.test(input.taskId)
        || typeof input.outcomeClass !== 'string'
        || !PROJECT_TASK_EXECUTION_LAUNCH_RESULT_OUTCOME_SET.has(input.outcomeClass)
      ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.invalidInput);

      const existingByAttempt = this.selectLaunchResultByAttemptRow(input.launchAttemptId);
      if (existingByAttempt !== undefined) {
        const existing = this.decodeLaunchResultRow(existingByAttempt);
        if (
          existing.invocationId !== input.invocationId
          || existing.executionRunId !== input.executionRunId
          || existing.taskId !== input.taskId
          || existing.outcomeClass !== input.outcomeClass
        ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.contradictory);
        return { launchResult: existing, created: false };
      }
      const existingByInvocation = this.selectLaunchResultByInvocationRow(input.invocationId);
      const existingByRun = this.selectLaunchResultByRunRow(input.executionRunId);
      const existingByTask = this.selectLaunchResultByTaskRow(input.taskId);
      if (
        existingByInvocation !== undefined
        || existingByRun !== undefined
        || existingByTask !== undefined
      ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.contradictory);

      const attemptRow = this.selectLaunchAttemptRow(input.launchAttemptId);
      if (attemptRow === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.launchAttemptNotFound);
      }
      const attempt = this.decodeLaunchAttemptRow(attemptRow);
      if (
        attempt.invocationId !== input.invocationId
        || attempt.executionRunId !== input.executionRunId
        || attempt.taskId !== input.taskId
      ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.lineageMismatch);

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.invalidInput);
      }
      // Recording an already-observed result is NOT authorization for a new
      // external action and does NOT require the launch lease to still be
      // current/unexpired; the Launch Attempt already binds the admitted
      // launch provenance. The result time must never precede the boundary.
      const recordedAt = Math.max(now, attempt.boundaryCrossedAt);
      const launchResultId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_execution_launch_results (
          launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
          task_id, outcome_class, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        launchResultId,
        input.launchAttemptId,
        input.invocationId,
        input.executionRunId,
        input.taskId,
        input.outcomeClass,
        recordedAt,
      );
      const inserted = this.selectLaunchResultRow(launchResultId);
      if (inserted === undefined) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.corruptRecord);
      }
      return { launchResult: this.decodeLaunchResultRow(inserted), created: true };
    });
  }

  readTaskExecutionLaunchResult(
    launchResultId: string,
  ): ProjectTaskExecutionLaunchResultRecord | undefined {
    return this.inTransaction(() => {
      if (typeof launchResultId !== 'string' || !PROJECT_TASK_ID.test(launchResultId)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.invalidInput);
      }
      const row = this.selectLaunchResultRow(launchResultId);
      return row === undefined ? undefined : this.decodeLaunchResultRow(row);
    });
  }

  readTaskExecutionLaunchResultByLaunchAttempt(
    launchAttemptId: string,
  ): ProjectTaskExecutionLaunchResultRecord | undefined {
    return this.inTransaction(() => {
      if (typeof launchAttemptId !== 'string' || !PROJECT_TASK_ID.test(launchAttemptId)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.invalidInput);
      }
      const row = this.selectLaunchResultByAttemptRow(launchAttemptId);
      return row === undefined ? undefined : this.decodeLaunchResultRow(row);
    });
  }

  readTaskExecutionLaunchResultByInvocation(
    invocationId: string,
  ): ProjectTaskExecutionLaunchResultRecord | undefined {
    return this.inTransaction(() => {
      if (typeof invocationId !== 'string' || !PROJECT_TASK_ID.test(invocationId)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.invalidInput);
      }
      const row = this.selectLaunchResultByInvocationRow(invocationId);
      return row === undefined ? undefined : this.decodeLaunchResultRow(row);
    });
  }

  readTaskExecutionLaunchResultByTask(
    taskId: string,
  ): ProjectTaskExecutionLaunchResultRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.invalidInput);
      }
      const row = this.selectLaunchResultByTaskRow(taskId);
      return row === undefined ? undefined : this.decodeLaunchResultRow(row);
    });
  }

  listTaskExecutionLaunchResults(
    limit: number,
  ): ProjectTaskExecutionLaunchResultRecord[] {
    return this.inTransaction(() => {
      if (
        typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > PROJECT_TASK_EXECUTION_LAUNCH_RESULT_MAX_LIST_LIMIT
      ) throw new Error(PROJECT_TASK_EXECUTION_LAUNCH_RESULT_ERRORS.invalidInput);
      const rows = this.database.prepare(`
        SELECT launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
               task_id, outcome_class, recorded_at
        FROM project_task_execution_launch_results
        ORDER BY recorded_at ASC, launch_result_id ASC
        LIMIT ?
      `).all(limit) as unknown as ProjectTaskExecutionLaunchResultRow[];
      return rows.map((row) => this.decodeLaunchResultRow(row));
    });
  }

  /**
   * ATOMIC first-write of the proposal_valid Launch Result AND its matching
   * validated-proposal snapshot in ONE BEGIN IMMEDIATE transaction. The two
   * rows appear together or neither appears; a crash before COMMIT rolls back
   * both and a crash after COMMIT persists both, so a newly-created
   * proposal_valid result can never exist without its V13 snapshot.
   *
   * Evidence only: the snapshot grants no approval, capability, Codex,
   * retry, Hermes-relaunch or any other authority. Recording does NOT require
   * a current/unexpired lease: the Launch Attempt already binds the admitted
   * launch provenance and recorded_at >= boundary_crossed_at, exactly like
   * recordTaskExecutionLaunchResult. Exact replay of the same lineage +
   * canonical hash returns created=false with zero writes; a proposal_valid
   * result WITHOUT a snapshot fails closed with atomicityViolation and is
   * never backfilled into resumable state.
   */
  recordValidatedProposalResult(
    input: RecordValidatedProposalInput,
  ): RecordValidatedProposalResult {
    return this.inTransaction(() => {
      if (
        !isRecord(input)
        || Object.keys(input).length !== 10
        || !Object.keys(input).every((key) => [
          'launchAttemptId', 'invocationId', 'executionRunId', 'taskId',
          'canonicalProposalJson', 'proposalSha256', 'executionMode',
          'completionMode', 'requiresHumanApproval', 'blockedActions',
        ].includes(key))
        || typeof input.launchAttemptId !== 'string'
        || !PROJECT_TASK_ID.test(input.launchAttemptId)
        || typeof input.invocationId !== 'string'
        || !PROJECT_TASK_ID.test(input.invocationId)
        || typeof input.executionRunId !== 'string'
        || !PROJECT_TASK_ID.test(input.executionRunId)
        || typeof input.taskId !== 'string'
        || !PROJECT_TASK_ID.test(input.taskId)
        || typeof input.canonicalProposalJson !== 'string'
        || !isValidCanonicalProposalJson(input.canonicalProposalJson)
        || typeof input.proposalSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(input.proposalSha256)
        || typeof input.executionMode !== 'string'
        || !SNAPSHOT_EXECUTION_MODES.has(input.executionMode)
        || typeof input.completionMode !== 'string'
        || !SNAPSHOT_COMPLETION_MODES.has(input.completionMode)
        || typeof input.requiresHumanApproval !== 'boolean'
        || !Array.isArray(input.blockedActions)
        || !input.blockedActions.every(
          (action) => typeof action === 'string' && SNAPSHOT_BLOCKED_ACTIONS.has(action),
        )
        || input.blockedActions.some((action, index) => input.blockedActions.indexOf(action) !== index)
      ) throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);

      // Canonical-integrity checks: the fingerprint is recomputed in the store
      // over the EXACT stored bytes; a mismatch is an inconsistent input.
      const recomputed = createHash('sha256').update(input.canonicalProposalJson).digest('hex');
      if (recomputed !== input.proposalSha256) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }
      const blockedActionsJson = JSON.stringify(input.blockedActions);
      if (blockedActionsJson.length > 512) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }

      const existingByAttempt = this.selectLaunchResultByAttemptRow(input.launchAttemptId);
      if (existingByAttempt !== undefined) {
        const existing = this.decodeLaunchResultRow(existingByAttempt);
        if (
          existing.invocationId !== input.invocationId
          || existing.executionRunId !== input.executionRunId
          || existing.taskId !== input.taskId
          || existing.outcomeClass !== 'proposal_valid'
        ) throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.contradictory);
        const existingSnapshot = this.selectValidatedProposalSnapshotByLaunchAttemptRow(
          input.launchAttemptId,
        );
        if (existingSnapshot === undefined) {
          // A proposal_valid result WITHOUT a snapshot is V12-era or corrupt
          // state. V13 never produces it and it must NOT be backfilled into a
          // resumable state: fail closed.
          throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.atomicityViolation);
        }
        const snapshot = this.decodeValidatedProposalSnapshotRow(existingSnapshot);
        if (
          snapshot.canonicalProposalJson !== input.canonicalProposalJson
          || snapshot.proposalSha256 !== input.proposalSha256
        ) throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.contradictory);
        return { snapshot, created: false };
      }
      const existingByInvocation = this.selectLaunchResultByInvocationRow(input.invocationId);
      const existingByRun = this.selectLaunchResultByRunRow(input.executionRunId);
      const existingByTask = this.selectLaunchResultByTaskRow(input.taskId);
      if (
        existingByInvocation !== undefined
        || existingByRun !== undefined
        || existingByTask !== undefined
      ) throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.contradictory);

      const attemptRow = this.selectLaunchAttemptRow(input.launchAttemptId);
      if (attemptRow === undefined) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.launchResultNotFound);
      }
      const attempt = this.decodeLaunchAttemptRow(attemptRow);
      if (
        attempt.invocationId !== input.invocationId
        || attempt.executionRunId !== input.executionRunId
        || attempt.taskId !== input.taskId
      ) throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.lineageMismatch);

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }
      const recordedAt = Math.max(now, attempt.boundaryCrossedAt);
      const launchResultId = randomUUID();
      const snapshotId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_execution_launch_results (
          launch_result_id, launch_attempt_id, invocation_id, execution_run_id,
          task_id, outcome_class, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        launchResultId,
        input.launchAttemptId,
        input.invocationId,
        input.executionRunId,
        input.taskId,
        'proposal_valid',
        recordedAt,
      );
      this.database.prepare(`
        INSERT INTO project_task_validated_proposal_snapshots (
          snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
          execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
          canonical_version, execution_mode, completion_mode,
          requires_human_approval, blocked_actions_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        launchResultId,
        input.launchAttemptId,
        input.invocationId,
        input.executionRunId,
        input.taskId,
        input.canonicalProposalJson,
        input.proposalSha256,
        PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION,
        input.executionMode,
        input.completionMode,
        input.requiresHumanApproval ? 1 : 0,
        blockedActionsJson,
        recordedAt,
      );
      const insertedResult = this.selectLaunchResultRow(launchResultId);
      const insertedSnapshot = this.selectValidatedProposalSnapshotRow(snapshotId);
      if (insertedResult === undefined || insertedSnapshot === undefined) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.corruptRecord);
      }
      return { snapshot: this.decodeValidatedProposalSnapshotRow(insertedSnapshot), created: true };
    });
  }

  readValidatedProposalSnapshot(
    snapshotId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined {
    return this.inTransaction(() => {
      if (typeof snapshotId !== 'string' || !PROJECT_TASK_ID.test(snapshotId)) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }
      const row = this.selectValidatedProposalSnapshotRow(snapshotId);
      return row === undefined ? undefined : this.decodeValidatedProposalSnapshotRow(row);
    });
  }

  readValidatedProposalSnapshotByLaunchResult(
    launchResultId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined {
    return this.inTransaction(() => {
      if (typeof launchResultId !== 'string' || !PROJECT_TASK_ID.test(launchResultId)) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }
      const row = this.selectValidatedProposalSnapshotByLaunchResultRow(launchResultId);
      return row === undefined ? undefined : this.decodeValidatedProposalSnapshotRow(row);
    });
  }

  readValidatedProposalSnapshotByLaunchAttempt(
    launchAttemptId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined {
    return this.inTransaction(() => {
      if (typeof launchAttemptId !== 'string' || !PROJECT_TASK_ID.test(launchAttemptId)) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }
      const row = this.selectValidatedProposalSnapshotByLaunchAttemptRow(launchAttemptId);
      return row === undefined ? undefined : this.decodeValidatedProposalSnapshotRow(row);
    });
  }

  readValidatedProposalSnapshotByInvocation(
    invocationId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined {
    return this.inTransaction(() => {
      if (typeof invocationId !== 'string' || !PROJECT_TASK_ID.test(invocationId)) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }
      const row = this.selectValidatedProposalSnapshotByInvocationRow(invocationId);
      return row === undefined ? undefined : this.decodeValidatedProposalSnapshotRow(row);
    });
  }

  readValidatedProposalSnapshotByExecutionRun(
    executionRunId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined {
    return this.inTransaction(() => {
      if (typeof executionRunId !== 'string' || !PROJECT_TASK_ID.test(executionRunId)) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }
      const row = this.selectValidatedProposalSnapshotByExecutionRunRow(executionRunId);
      return row === undefined ? undefined : this.decodeValidatedProposalSnapshotRow(row);
    });
  }

  readValidatedProposalSnapshotByTask(
    taskId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      }
      const row = this.selectValidatedProposalSnapshotByTaskRow(taskId);
      return row === undefined ? undefined : this.decodeValidatedProposalSnapshotRow(row);
    });
  }

  listValidatedProposalSnapshots(
    limit: number,
  ): ProjectTaskValidatedProposalSnapshotRecord[] {
    return this.inTransaction(() => {
      if (
        typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_MAX_LIST_LIMIT
      ) throw new Error(PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS.invalidInput);
      const rows = this.database.prepare(`
        SELECT snapshot_id, launch_result_id, launch_attempt_id, invocation_id,
               execution_run_id, task_id, canonical_proposal_json, proposal_sha256,
               canonical_version, execution_mode, completion_mode,
               requires_human_approval, blocked_actions_json, recorded_at
        FROM project_task_validated_proposal_snapshots
        ORDER BY recorded_at ASC, snapshot_id ASC
        LIMIT ?
      `).all(limit) as unknown as ProjectTaskValidatedProposalSnapshotRow[];
      return rows.map((row) => this.decodeValidatedProposalSnapshotRow(row));
    });
  }

  // --- Resume Decision helpers ---

  private selectResumeDecisionRow(
    decisionId: string,
  ): ProjectTaskResumeDecisionRow | undefined {
    return this.database.prepare(`
      SELECT decision_id, task_id, snapshot_id, decision, refusal_reason,
             policy_fingerprint, recorded_at
      FROM project_task_resume_decisions WHERE decision_id = ?
    `).get(decisionId) as unknown as ProjectTaskResumeDecisionRow | undefined;
  }

  private selectResumeDecisionByTaskRow(
    taskId: string,
  ): ProjectTaskResumeDecisionRow | undefined {
    return this.database.prepare(`
      SELECT decision_id, task_id, snapshot_id, decision, refusal_reason,
             policy_fingerprint, recorded_at
      FROM project_task_resume_decisions WHERE task_id = ?
    `).get(taskId) as unknown as ProjectTaskResumeDecisionRow | undefined;
  }

  private selectResumeDecisionBySnapshotRow(
    snapshotId: string,
  ): ProjectTaskResumeDecisionRow | undefined {
    return this.database.prepare(`
      SELECT decision_id, task_id, snapshot_id, decision, refusal_reason,
             policy_fingerprint, recorded_at
      FROM project_task_resume_decisions WHERE snapshot_id = ?
    `).get(snapshotId) as unknown as ProjectTaskResumeDecisionRow | undefined;
  }

  private decodeResumeDecisionRow(row: ProjectTaskResumeDecisionRow): ProjectTaskResumeDecisionRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.corruptRecord);
    if (typeof row.decision_id !== 'string' || !PROJECT_TASK_ID.test(row.decision_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.snapshot_id !== 'string' || !PROJECT_TASK_ID.test(row.snapshot_id)) throw corrupt();
    if (typeof row.decision !== 'string' || !RESUME_DECISIONS.has(row.decision)) throw corrupt();
    if (row.refusal_reason !== null) {
      if (
        row.decision !== 'refused'
        || typeof row.refusal_reason !== 'string'
        || !RESUME_REFUSAL_REASONS.has(row.refusal_reason)
      ) throw corrupt();
    } else if (row.decision !== 'approved') {
      throw corrupt();
    }
    if (
      typeof row.policy_fingerprint !== 'string'
      || row.policy_fingerprint.length !== 64
      || !/^[0-9a-f]{64}$/.test(row.policy_fingerprint)
    ) throw corrupt();
    if (
      !isNonNegativeInteger(row.recorded_at)
      || !Number.isSafeInteger(row.recorded_at)
      || row.recorded_at > 9007199254740991
    ) throw corrupt();
    return {
      decisionId: row.decision_id,
      taskId: row.task_id,
      snapshotId: row.snapshot_id,
      decision: row.decision as ProjectTaskResumeDecisionRecord['decision'],
      ...(row.refusal_reason !== null ? { refusalReason: row.refusal_reason as ProjectTaskResumeDecisionRecord['refusalReason'] } : {}),
      policyFingerprint: row.policy_fingerprint,
      recordedAt: row.recorded_at,
    };
  }

  // --- Codex evidence decode helpers ---

  private decodeCodexStartEvidenceRow(row: CodexStartEvidenceRow): CodexStartEvidenceRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
    if (typeof row.codex_start_id !== 'string' || !PROJECT_TASK_ID.test(row.codex_start_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.invocation_id !== 'string' || !PROJECT_TASK_ID.test(row.invocation_id)) throw corrupt();
    if (typeof row.launch_attempt_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_attempt_id)) throw corrupt();
    if (typeof row.launch_result_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_result_id)) throw corrupt();
    if (typeof row.snapshot_id !== 'string' || !PROJECT_TASK_ID.test(row.snapshot_id)) throw corrupt();
    if (
      !isNonNegativeInteger(row.start_recorded_at)
      || !Number.isSafeInteger(row.start_recorded_at)
      || row.start_recorded_at > 9007199254740991
    ) throw corrupt();
    return {
      codexStartId: row.codex_start_id,
      taskId: row.task_id,
      executionRunId: row.execution_run_id,
      invocationId: row.invocation_id,
      launchAttemptId: row.launch_attempt_id,
      launchResultId: row.launch_result_id,
      snapshotId: row.snapshot_id,
      startRecordedAt: row.start_recorded_at,
    };
  }

  private decodeCodexResultEvidenceRow(row: CodexResultEvidenceRow): CodexResultEvidenceRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
    if (typeof row.codex_result_id !== 'string' || !PROJECT_TASK_ID.test(row.codex_result_id)) throw corrupt();
    if (typeof row.codex_start_id !== 'string' || !PROJECT_TASK_ID.test(row.codex_start_id)) throw corrupt();
    if (typeof row.execution_id !== 'string' || row.execution_id.length < 1 || row.execution_id.length > 36) throw corrupt();
    if (typeof row.outcome !== 'string' || !CODEX_RESULT_OUTCOMES.includes(row.outcome as typeof CODEX_RESULT_OUTCOMES[number])) throw corrupt();
    if (typeof row.success !== 'number' || !Number.isInteger(row.success) || (row.success !== 0 && row.success !== 1)) throw corrupt();
    if (row.outcome === 'codex_success' && row.error !== null) throw corrupt();
    if (row.outcome === 'codex_failed') {
      if (typeof row.error !== 'string' || ![
        'codex_execution_failed', 'timeout', 'worktree_create_failed',
        'worktree_cleanup_failed', 'prompt_too_large',
        'missing_repository_read', 'missing_isolated_worktree_write',
        'invalid_generated_path',
      ].includes(row.error)) throw corrupt();
    }
    if (row.outcome === 'codex_interrupted' && row.error !== null) throw corrupt();
    if (typeof row.summary !== 'string' || row.summary.length < 1 || row.summary.length > 500 || row.summary !== row.summary.trim()) throw corrupt();
    if (typeof row.result_metadata_json !== 'string') throw corrupt();
    let parsed: unknown;
    try { parsed = JSON.parse(row.result_metadata_json); } catch { throw corrupt(); }
    if (!isRecord(parsed)) throw corrupt();
    if (
      !isNonNegativeInteger(row.result_recorded_at)
      || !Number.isSafeInteger(row.result_recorded_at)
      || row.result_recorded_at > 9007199254740991
    ) throw corrupt();
    return {
      codexResultId: row.codex_result_id,
      codexStartId: row.codex_start_id,
      executionId: row.execution_id,
      outcome: row.outcome as CodexResultEvidenceRecord['outcome'],
      success: row.success as 0 | 1,
      error: row.error as string | null,
      summary: row.summary,
      resultMetadataJson: row.result_metadata_json,
      resultRecordedAt: row.result_recorded_at,
    };
  }

  // --- Resume Decision Store API ---

  recordResumeDecision(input: RecordResumeDecisionInput): RecordResumeDecisionResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      const { taskId, snapshotId, decision, refusalReason, policyFingerprint } = input;
      if (Object.keys(input).length < 4 || Object.keys(input).length > 5) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      if (typeof snapshotId !== 'string' || !PROJECT_TASK_ID.test(snapshotId)) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      if (typeof decision !== 'string' || !RESUME_DECISIONS.has(decision)) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      if (decision === 'refused') {
        if (typeof refusalReason !== 'string' || !RESUME_REFUSAL_REASONS.has(refusalReason)) {
          throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
        }
      } else if (refusalReason !== undefined) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      if (
        typeof policyFingerprint !== 'string'
        || policyFingerprint.length !== 64
        || !/^[0-9a-f]{64}$/.test(policyFingerprint)
      ) throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);

      // Check task existence
      const task = this.selectRow(taskId);
      if (task === undefined) throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.taskNotFound);

      // Check snapshot exists and belongs to task
      const snapshot = this.selectValidatedProposalSnapshotByTaskRow(taskId);
      if (snapshot === undefined || snapshot.snapshot_id !== snapshotId) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.snapshotNotFound);
      }

      // Check task is non-terminal and pre-Codex
      if (
        task.terminal_at !== null
        || task.status === 'completed'
        || task.status === 'failed'
        || !(task.status === 'accepted' || task.status === 'planning' || task.status === 'hermes')
      ) throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.taskNotResumable);

      // Check for existing decision: exact replay or contradictory
      const existing = this.selectResumeDecisionByTaskRow(taskId);
      if (existing !== undefined) {
        const decoded = this.decodeResumeDecisionRow(existing);
        if (
          decoded.decision === decision
          && decoded.snapshotId === snapshotId
          && decoded.policyFingerprint === policyFingerprint
          && (decision === 'approved' || decoded.refusalReason === refusalReason)
        ) {
          // Exact replay
          return { decision: decoded, created: false };
        }
        // Contradictory
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.contradictory);
      }

      const decisionId: string = randomUUID();
      const recordedAt = this.now();
      if (!Number.isSafeInteger(recordedAt) || recordedAt < 0 || recordedAt > 9007199254740991) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      const refusalValue: string | null = decision === 'refused' ? (refusalReason as string) : null;
      const params: import('node:sqlite').SQLInputValue[] = [
        decisionId,
        taskId,
        snapshotId,
        decision,
        refusalValue,
        policyFingerprint,
        recordedAt,
      ];
      this.database.prepare(`
        INSERT INTO project_task_resume_decisions (
          decision_id, task_id, snapshot_id, decision, refusal_reason,
          policy_fingerprint, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(...params);
      const inserted = this.selectResumeDecisionRow(decisionId);
      if (inserted === undefined) throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.corruptRecord);
      return { decision: this.decodeResumeDecisionRow(inserted), created: true };
    });
  }

  readResumeDecision(decisionId: string): ProjectTaskResumeDecisionRecord | undefined {
    return this.inTransaction(() => {
      if (typeof decisionId !== 'string' || !PROJECT_TASK_ID.test(decisionId)) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      const row = this.selectResumeDecisionRow(decisionId);
      return row === undefined ? undefined : this.decodeResumeDecisionRow(row);
    });
  }

  readResumeDecisionByTask(taskId: string): ProjectTaskResumeDecisionRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      const row = this.selectResumeDecisionByTaskRow(taskId);
      return row === undefined ? undefined : this.decodeResumeDecisionRow(row);
    });
  }

  readResumeDecisionBySnapshot(snapshotId: string): ProjectTaskResumeDecisionRecord | undefined {
    return this.inTransaction(() => {
      if (typeof snapshotId !== 'string' || !PROJECT_TASK_ID.test(snapshotId)) {
        throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      }
      const row = this.selectResumeDecisionBySnapshotRow(snapshotId);
      return row === undefined ? undefined : this.decodeResumeDecisionRow(row);
    });
  }

  listResumeDecisions(limit: number): ProjectTaskResumeDecisionRecord[] {
    return this.inTransaction(() => {
      if (
        typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > PROJECT_TASK_RESUME_DECISION_MAX_LIST_LIMIT
      ) throw new Error(PROJECT_TASK_RESUME_DECISION_ERRORS.invalidInput);
      const rows = this.database.prepare(`
        SELECT decision_id, task_id, snapshot_id, decision, refusal_reason,
               policy_fingerprint, recorded_at
        FROM project_task_resume_decisions
        ORDER BY recorded_at ASC, decision_id ASC
        LIMIT ?
      `).all(limit) as unknown as ProjectTaskResumeDecisionRow[];
      return rows.map((row) => this.decodeResumeDecisionRow(row));
    });
  }

  // --- Codex Evidence Store API ---

  recordCodexStartEvidence(input: RecordCodexStartInput): RecordCodexStartResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      const { taskId, executionRunId, invocationId, launchAttemptId, launchResultId, snapshotId } = input;
      if (Object.keys(input).length !== 6) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      if (![taskId, executionRunId, invocationId, launchAttemptId, launchResultId, snapshotId].every(
        (id) => typeof id === 'string' && PROJECT_TASK_ID.test(id),
      )) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);

      // Check existing start evidence for this task
      const existingRow = this.database.prepare(`
        SELECT codex_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, start_recorded_at
        FROM project_task_codex_start_evidence
        WHERE task_id = ?
      `).get(taskId) as unknown as CodexStartEvidenceRow | undefined;

      if (existingRow !== undefined) {
        const existing = this.decodeCodexStartEvidenceRow(existingRow);
        // Idempotency check: exact same lineage
        if (
          existing.executionRunId === executionRunId
          && existing.invocationId === invocationId
          && existing.launchAttemptId === launchAttemptId
          && existing.launchResultId === launchResultId
          && existing.snapshotId === snapshotId
        ) {
          return { codexStart: existing, created: false };
        }
        // Contradiction: same taskId, different lineage
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.contradictory);
      }

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 9007199254740991) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      const codexStartId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_codex_start_evidence
          (codex_start_id, task_id, execution_run_id, invocation_id,
           launch_attempt_id, launch_result_id, snapshot_id, start_recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(codexStartId, taskId, executionRunId, invocationId,
        launchAttemptId, launchResultId, snapshotId, now);

      const inserted = this.database.prepare(`
        SELECT codex_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, start_recorded_at
        FROM project_task_codex_start_evidence
        WHERE codex_start_id = ?
      `).get(codexStartId) as unknown as CodexStartEvidenceRow | undefined;

      if (inserted === undefined) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      return { codexStart: this.decodeCodexStartEvidenceRow(inserted), created: true };
    });
  }

  readCodexStartEvidence(codexStartId: string): CodexStartEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof codexStartId !== 'string' || !PROJECT_TASK_ID.test(codexStartId)) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT codex_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, start_recorded_at
        FROM project_task_codex_start_evidence
        WHERE codex_start_id = ?
      `).get(codexStartId) as unknown as CodexStartEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeCodexStartEvidenceRow(row);
    });
  }

  readCodexStartEvidenceByTask(taskId: string): CodexStartEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT codex_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, start_recorded_at
        FROM project_task_codex_start_evidence
        WHERE task_id = ?
      `).get(taskId) as unknown as CodexStartEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeCodexStartEvidenceRow(row);
    });
  }

  recordCodexResultEvidence(input: RecordCodexResultInput): RecordCodexResultResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      const { codexStartId, executionId, outcome, success, error, summary, resultMetadataJson } = input;
      if (Object.keys(input).length !== 7) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      if (typeof codexStartId !== 'string' || !PROJECT_TASK_ID.test(codexStartId)) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      if (typeof executionId !== 'string' || executionId.length < 1 || executionId.length > 36) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      if (typeof outcome !== 'string' || !CODEX_RESULT_OUTCOMES.includes(outcome as typeof CODEX_RESULT_OUTCOMES[number])) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      if (typeof success !== 'number' || !Number.isInteger(success) || (success !== 0 && success !== 1)) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      if (outcome === 'codex_success' && error !== null) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      if (outcome === 'codex_failed') {
        if (typeof error !== 'string' || ![
          'codex_execution_failed', 'timeout', 'worktree_create_failed',
          'worktree_cleanup_failed', 'prompt_too_large',
          'missing_repository_read', 'missing_isolated_worktree_write',
          'invalid_generated_path',
        ].includes(error)) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      if (outcome === 'codex_interrupted' && error !== null) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      if (typeof summary !== 'string' || summary.length < 1 || summary.length > 500 || summary !== summary.trim()) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      if (typeof resultMetadataJson !== 'string') throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);

      // Check existing result evidence for this start
      const existingRow = this.database.prepare(`
        SELECT codex_result_id, codex_start_id, execution_id, outcome, success,
               error, summary, result_metadata_json, result_recorded_at
        FROM project_task_codex_result_evidence
        WHERE codex_start_id = ?
      `).get(codexStartId) as unknown as CodexResultEvidenceRow | undefined;

      if (existingRow !== undefined) {
        const existing = this.decodeCodexResultEvidenceRow(existingRow);
        // Idempotency check: same outcome
        if (
          existing.outcome === outcome
          && existing.success === success
          && existing.error === error
          && existing.summary === summary
        ) {
          return { codexResult: existing, created: false };
        }
        // Contradiction: same startId, different outcome
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.resultContradictory);
      }

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 9007199254740991) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      const codexResultId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_codex_result_evidence
          (codex_result_id, codex_start_id, execution_id, outcome, success,
           error, summary, result_metadata_json, result_recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(codexResultId, codexStartId, executionId, outcome, success,
        error, summary, resultMetadataJson, now);

      const inserted = this.database.prepare(`
        SELECT codex_result_id, codex_start_id, execution_id, outcome, success,
               error, summary, result_metadata_json, result_recorded_at
        FROM project_task_codex_result_evidence
        WHERE codex_result_id = ?
      `).get(codexResultId) as unknown as CodexResultEvidenceRow | undefined;

      if (inserted === undefined) throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      return { codexResult: this.decodeCodexResultEvidenceRow(inserted), created: true };
    });
  }

  readCodexResultEvidence(codexStartId: string): CodexResultEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof codexStartId !== 'string' || !PROJECT_TASK_ID.test(codexStartId)) {
        throw new Error(PROJECT_TASK_CODEX_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT codex_result_id, codex_start_id, execution_id, outcome, success,
               error, summary, result_metadata_json, result_recorded_at
        FROM project_task_codex_result_evidence
        WHERE codex_start_id = ?
      `).get(codexStartId) as unknown as CodexResultEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeCodexResultEvidenceRow(row);
    });
  }

  // --- Verification Evidence Decode Helpers ---

  private decodeVerificationStartEvidenceRow(row: VerificationStartEvidenceRow): VerificationStartEvidenceRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
    if (typeof row.verification_start_id !== 'string' || !PROJECT_TASK_ID.test(row.verification_start_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.invocation_id !== 'string' || !PROJECT_TASK_ID.test(row.invocation_id)) throw corrupt();
    if (typeof row.launch_attempt_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_attempt_id)) throw corrupt();
    if (typeof row.launch_result_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_result_id)) throw corrupt();
    if (typeof row.snapshot_id !== 'string' || !PROJECT_TASK_ID.test(row.snapshot_id)) throw corrupt();
    if (typeof row.codex_start_id !== 'string' || !PROJECT_TASK_ID.test(row.codex_start_id)) throw corrupt();
    if (typeof row.execution_id !== 'string' || row.execution_id.length < 1 || row.execution_id.length > 36) throw corrupt();
    if (
      !isNonNegativeInteger(row.start_recorded_at)
      || !Number.isSafeInteger(row.start_recorded_at)
      || row.start_recorded_at > 9007199254740991
    ) throw corrupt();
    return {
      verificationStartId: row.verification_start_id,
      taskId: row.task_id,
      executionRunId: row.execution_run_id,
      invocationId: row.invocation_id,
      launchAttemptId: row.launch_attempt_id,
      launchResultId: row.launch_result_id,
      snapshotId: row.snapshot_id,
      codexStartId: row.codex_start_id,
      executionId: row.execution_id,
      startRecordedAt: row.start_recorded_at,
    };
  }

  private decodeVerificationResultEvidenceRow(row: VerificationResultEvidenceRow): VerificationResultEvidenceRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
    if (typeof row.verification_result_id !== 'string' || !PROJECT_TASK_ID.test(row.verification_result_id)) throw corrupt();
    if (typeof row.verification_start_id !== 'string' || !PROJECT_TASK_ID.test(row.verification_start_id)) throw corrupt();
    if (typeof row.status !== 'string' || !VERIFICATION_RESULT_STATUSES.includes(row.status as typeof VERIFICATION_RESULT_STATUSES[number])) throw corrupt();
    if (typeof row.checks_passed !== 'number' || !Number.isInteger(row.checks_passed) || row.checks_passed < 0) throw corrupt();
    if (typeof row.total_checks !== 'number' || !Number.isInteger(row.total_checks) || row.total_checks <= 0 || row.checks_passed > row.total_checks) throw corrupt();
    if (typeof row.technical_checks_passed !== 'number' || !Number.isInteger(row.technical_checks_passed) || row.technical_checks_passed < 0) throw corrupt();
    if (typeof row.technical_total_checks !== 'number' || !Number.isInteger(row.technical_total_checks) || row.technical_total_checks < 0) throw corrupt();
    if (typeof row.visual_checks_passed !== 'number' || !Number.isInteger(row.visual_checks_passed) || row.visual_checks_passed < 0) throw corrupt();
    if (typeof row.visual_total_checks !== 'number' || !Number.isInteger(row.visual_total_checks) || row.visual_total_checks < 0) throw corrupt();
    if (row.checks_passed !== row.technical_checks_passed + row.visual_checks_passed) throw corrupt();
    if (row.total_checks !== row.technical_total_checks + row.visual_total_checks) throw corrupt();
    if (row.technical_checks_passed > row.technical_total_checks) throw corrupt();
    if (row.visual_checks_passed > row.visual_total_checks) throw corrupt();
    if (row.status === 'verified' && row.failure_error !== null) throw corrupt();
    if (row.status === 'verified' && row.failure_summary !== null) throw corrupt();
    if (row.status === 'verification_failed') {
      if (typeof row.failure_error !== 'string' || !VERIFICATION_FAILURE_ERRORS.includes(row.failure_error as typeof VERIFICATION_FAILURE_ERRORS[number])) throw corrupt();
      if (typeof row.failure_summary !== 'string' || row.failure_summary.length < 1 || row.failure_summary.length > 500 || row.failure_summary !== row.failure_summary.trim()) throw corrupt();
    }
    if (
      !isNonNegativeInteger(row.result_recorded_at)
      || !Number.isSafeInteger(row.result_recorded_at)
      || row.result_recorded_at > 9007199254740991
    ) throw corrupt();
    return {
      verificationResultId: row.verification_result_id,
      verificationStartId: row.verification_start_id,
      status: row.status as VerificationResultEvidenceRecord['status'],
      checksPassed: row.checks_passed,
      totalChecks: row.total_checks,
      technicalChecksPassed: row.technical_checks_passed,
      technicalTotalChecks: row.technical_total_checks,
      visualChecksPassed: row.visual_checks_passed,
      visualTotalChecks: row.visual_total_checks,
      failureError: row.failure_error as string | null,
      failureSummary: row.failure_summary as string | null,
      resultRecordedAt: row.result_recorded_at,
    };
  }

  private decodeCommitStartEvidenceRow(row: CommitStartEvidenceRow): CommitStartEvidenceRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
    if (typeof row.commit_start_id !== 'string' || !PROJECT_TASK_ID.test(row.commit_start_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.invocation_id !== 'string' || !PROJECT_TASK_ID.test(row.invocation_id)) throw corrupt();
    if (typeof row.launch_attempt_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_attempt_id)) throw corrupt();
    if (typeof row.launch_result_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_result_id)) throw corrupt();
    if (typeof row.snapshot_id !== 'string' || !PROJECT_TASK_ID.test(row.snapshot_id)) throw corrupt();
    if (typeof row.codex_start_id !== 'string' || !PROJECT_TASK_ID.test(row.codex_start_id)) throw corrupt();
    if (typeof row.verification_start_id !== 'string' || !PROJECT_TASK_ID.test(row.verification_start_id)) throw corrupt();
    if (typeof row.execution_id !== 'string' || row.execution_id.length < 1 || row.execution_id.length > 36) throw corrupt();
    if (
      !isNonNegativeInteger(row.start_recorded_at)
      || !Number.isSafeInteger(row.start_recorded_at)
      || row.start_recorded_at > 9007199254740991
    ) throw corrupt();
    return {
      commitStartId: row.commit_start_id,
      taskId: row.task_id,
      executionRunId: row.execution_run_id,
      invocationId: row.invocation_id,
      launchAttemptId: row.launch_attempt_id,
      launchResultId: row.launch_result_id,
      snapshotId: row.snapshot_id,
      codexStartId: row.codex_start_id,
      verificationStartId: row.verification_start_id,
      executionId: row.execution_id,
      startRecordedAt: row.start_recorded_at,
    };
  }

  private decodeCommitResultEvidenceRow(row: CommitResultEvidenceRow): CommitResultEvidenceRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
    if (typeof row.commit_result_id !== 'string' || !PROJECT_TASK_ID.test(row.commit_result_id)) throw corrupt();
    if (typeof row.commit_start_id !== 'string' || !PROJECT_TASK_ID.test(row.commit_start_id)) throw corrupt();
    if (typeof row.status !== 'string' || !COMMIT_RESULT_STATUSES.includes(row.status as typeof COMMIT_RESULT_STATUSES[number])) throw corrupt();
    if (row.status === 'committed') {
      if (typeof row.commit_sha !== 'string' || row.commit_sha.length < 40 || row.commit_sha.length > 64 || !/^[0-9a-fA-F]+$/.test(row.commit_sha)) throw corrupt();
      if (row.error !== null) throw corrupt();
      if (row.summary !== 'The verified workspace was committed locally.') throw corrupt();
    }
    if (row.status === 'commit_failed') {
      if (row.commit_sha !== null) throw corrupt();
      if (typeof row.error !== 'string' || !COMMIT_FAILURE_ERRORS.includes(row.error as typeof COMMIT_FAILURE_ERRORS[number])) throw corrupt();
      if (typeof row.summary !== 'string' || row.summary.length < 1 || row.summary.length > 500 || row.summary !== row.summary.trim()) throw corrupt();
    }
    if (row.status === 'nothing_to_commit') {
      if (row.commit_sha !== null) throw corrupt();
      if (row.error !== 'nothing_to_commit') throw corrupt();
      if (typeof row.summary !== 'string' || row.summary.length < 1 || row.summary.length > 500 || row.summary !== row.summary.trim()) throw corrupt();
    }
    if (
      !isNonNegativeInteger(row.result_recorded_at)
      || !Number.isSafeInteger(row.result_recorded_at)
      || row.result_recorded_at > 9007199254740991
    ) throw corrupt();
    return {
      commitResultId: row.commit_result_id,
      commitStartId: row.commit_start_id,
      status: row.status as CommitResultEvidenceRecord['status'],
      commitSha: row.commit_sha as string | null,
      error: row.error as string | null,
      summary: row.summary as string | null,
      resultRecordedAt: row.result_recorded_at,
    };
  }

  // --- Verification Evidence Store API ---

  recordVerificationStartEvidence(input: RecordVerificationStartInput): RecordVerificationStartResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      const { taskId, executionRunId, invocationId, launchAttemptId, launchResultId, snapshotId, codexStartId, executionId } = input;
      if (Object.keys(input).length !== 8) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (![taskId, executionRunId, invocationId, launchAttemptId, launchResultId, snapshotId, codexStartId].every(
        (id) => typeof id === 'string' && PROJECT_TASK_ID.test(id),
      )) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (typeof executionId !== 'string' || executionId.length < 1 || executionId.length > 36) {
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      }

      const existingRow = this.database.prepare(`
        SELECT verification_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               execution_id, start_recorded_at
        FROM project_task_verification_start_evidence
        WHERE task_id = ?
      `).get(taskId) as unknown as VerificationStartEvidenceRow | undefined;

      if (existingRow !== undefined) {
        const existing = this.decodeVerificationStartEvidenceRow(existingRow);
        if (
          existing.executionRunId === executionRunId
          && existing.invocationId === invocationId
          && existing.launchAttemptId === launchAttemptId
          && existing.launchResultId === launchResultId
          && existing.snapshotId === snapshotId
          && existing.codexStartId === codexStartId
          && existing.executionId === executionId
        ) {
          return { verificationStart: existing, created: false };
        }
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.contradictory);
      }

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 9007199254740991) {
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      }
      const verificationStartId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_verification_start_evidence
          (verification_start_id, task_id, execution_run_id, invocation_id,
           launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
           execution_id, start_recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(verificationStartId, taskId, executionRunId, invocationId,
        launchAttemptId, launchResultId, snapshotId, codexStartId, executionId, now);

      const inserted = this.database.prepare(`
        SELECT verification_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               execution_id, start_recorded_at
        FROM project_task_verification_start_evidence
        WHERE verification_start_id = ?
      `).get(verificationStartId) as unknown as VerificationStartEvidenceRow | undefined;

      if (inserted === undefined) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      return { verificationStart: this.decodeVerificationStartEvidenceRow(inserted), created: true };
    });
  }

  readVerificationStartEvidence(verificationStartId: string): VerificationStartEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof verificationStartId !== 'string' || !PROJECT_TASK_ID.test(verificationStartId)) {
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT verification_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               execution_id, start_recorded_at
        FROM project_task_verification_start_evidence
        WHERE verification_start_id = ?
      `).get(verificationStartId) as unknown as VerificationStartEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeVerificationStartEvidenceRow(row);
    });
  }

  readVerificationStartEvidenceByTask(taskId: string): VerificationStartEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT verification_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               execution_id, start_recorded_at
        FROM project_task_verification_start_evidence
        WHERE task_id = ?
      `).get(taskId) as unknown as VerificationStartEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeVerificationStartEvidenceRow(row);
    });
  }

  recordVerificationResultEvidence(input: RecordVerificationResultInput): RecordVerificationResultResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      const { verificationStartId, status, checksPassed, totalChecks, technicalChecksPassed, technicalTotalChecks, visualChecksPassed, visualTotalChecks, failureError, failureSummary } = input;
      if (Object.keys(input).length !== 10) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (typeof verificationStartId !== 'string' || !PROJECT_TASK_ID.test(verificationStartId)) {
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      }
      if (typeof status !== 'string' || !VERIFICATION_RESULT_STATUSES.includes(status as typeof VERIFICATION_RESULT_STATUSES[number])) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (typeof checksPassed !== 'number' || !Number.isInteger(checksPassed) || checksPassed < 0) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (typeof totalChecks !== 'number' || !Number.isInteger(totalChecks) || totalChecks <= 0 || checksPassed > totalChecks) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (typeof technicalChecksPassed !== 'number' || !Number.isInteger(technicalChecksPassed) || technicalChecksPassed < 0) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (typeof technicalTotalChecks !== 'number' || !Number.isInteger(technicalTotalChecks) || technicalTotalChecks < 0) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (typeof visualChecksPassed !== 'number' || !Number.isInteger(visualChecksPassed) || visualChecksPassed < 0) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (typeof visualTotalChecks !== 'number' || !Number.isInteger(visualTotalChecks) || visualTotalChecks < 0) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (checksPassed !== technicalChecksPassed + visualChecksPassed) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (totalChecks !== technicalTotalChecks + visualTotalChecks) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (status === 'verified' && failureError !== null) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (status === 'verified' && failureSummary !== null) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      if (status === 'verification_failed') {
        if (typeof failureError !== 'string' || !VERIFICATION_FAILURE_ERRORS.includes(failureError as typeof VERIFICATION_FAILURE_ERRORS[number])) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
        if (typeof failureSummary !== 'string' || failureSummary.length < 1 || failureSummary.length > 500 || failureSummary !== failureSummary.trim()) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      }

      const existingRow = this.database.prepare(`
        SELECT verification_result_id, verification_start_id, status, checks_passed,
               total_checks, technical_checks_passed, technical_total_checks,
               visual_checks_passed, visual_total_checks, failure_error,
               failure_summary, result_recorded_at
        FROM project_task_verification_result_evidence
        WHERE verification_start_id = ?
      `).get(verificationStartId) as unknown as VerificationResultEvidenceRow | undefined;

      if (existingRow !== undefined) {
        const existing = this.decodeVerificationResultEvidenceRow(existingRow);
        if (
          existing.status === status
          && existing.checksPassed === checksPassed
          && existing.totalChecks === totalChecks
          && existing.failureError === failureError
          && existing.failureSummary === failureSummary
        ) {
          return { verificationResult: existing, created: false };
        }
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.resultContradictory);
      }

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 9007199254740991) {
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      }
      const verificationResultId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_verification_result_evidence
          (verification_result_id, verification_start_id, status, checks_passed,
           total_checks, technical_checks_passed, technical_total_checks,
           visual_checks_passed, visual_total_checks, failure_error,
           failure_summary, result_recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(verificationResultId, verificationStartId, status, checksPassed,
        totalChecks, technicalChecksPassed, technicalTotalChecks,
        visualChecksPassed, visualTotalChecks, failureError, failureSummary, now);

      const inserted = this.database.prepare(`
        SELECT verification_result_id, verification_start_id, status, checks_passed,
               total_checks, technical_checks_passed, technical_total_checks,
               visual_checks_passed, visual_total_checks, failure_error,
               failure_summary, result_recorded_at
        FROM project_task_verification_result_evidence
        WHERE verification_result_id = ?
      `).get(verificationResultId) as unknown as VerificationResultEvidenceRow | undefined;

      if (inserted === undefined) throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      return { verificationResult: this.decodeVerificationResultEvidenceRow(inserted), created: true };
    });
  }

  readVerificationResultEvidence(verificationStartId: string): VerificationResultEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof verificationStartId !== 'string' || !PROJECT_TASK_ID.test(verificationStartId)) {
        throw new Error(PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT verification_result_id, verification_start_id, status, checks_passed,
               total_checks, technical_checks_passed, technical_total_checks,
               visual_checks_passed, visual_total_checks, failure_error,
               failure_summary, result_recorded_at
        FROM project_task_verification_result_evidence
        WHERE verification_start_id = ?
      `).get(verificationStartId) as unknown as VerificationResultEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeVerificationResultEvidenceRow(row);
    });
  }

  // --- Completion Evidence Store API ---

  private decodeCompletionEvidenceRow(row: CompletionEvidenceRow): ProjectTaskCompletionEvidenceRecord {
    const corrupt = (): Error => new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
    if (typeof row.completion_evidence_id !== 'string' || !PROJECT_TASK_ID.test(row.completion_evidence_id)) throw corrupt();
    if (typeof row.task_id !== 'string' || !PROJECT_TASK_ID.test(row.task_id)) throw corrupt();
    if (typeof row.execution_run_id !== 'string' || !PROJECT_TASK_ID.test(row.execution_run_id)) throw corrupt();
    if (typeof row.invocation_id !== 'string' || !PROJECT_TASK_ID.test(row.invocation_id)) throw corrupt();
    if (typeof row.launch_attempt_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_attempt_id)) throw corrupt();
    if (typeof row.launch_result_id !== 'string' || !PROJECT_TASK_ID.test(row.launch_result_id)) throw corrupt();
    if (typeof row.snapshot_id !== 'string' || !PROJECT_TASK_ID.test(row.snapshot_id)) throw corrupt();
    if (row.codex_start_id !== null && (typeof row.codex_start_id !== 'string' || !PROJECT_TASK_ID.test(row.codex_start_id))) throw corrupt();
    if (row.verification_start_id !== null && (typeof row.verification_start_id !== 'string' || !PROJECT_TASK_ID.test(row.verification_start_id))) throw corrupt();
    if (row.commit_start_id !== null && (typeof row.commit_start_id !== 'string' || !PROJECT_TASK_ID.test(row.commit_start_id))) throw corrupt();
    if (typeof row.receipt_json !== 'string') throw corrupt();
    let parsed: unknown;
    try { parsed = JSON.parse(row.receipt_json); } catch { throw corrupt(); }
    if (!isSafeTaskReceipt(parsed)) throw corrupt();
    if (
      !isNonNegativeInteger(row.recorded_at)
      || !Number.isSafeInteger(row.recorded_at)
      || row.recorded_at > 9007199254740991
    ) throw corrupt();
    return {
      completionEvidenceId: row.completion_evidence_id,
      taskId: row.task_id,
      executionRunId: row.execution_run_id,
      invocationId: row.invocation_id,
      launchAttemptId: row.launch_attempt_id,
      launchResultId: row.launch_result_id,
      snapshotId: row.snapshot_id,
      codexStartId: row.codex_start_id as string | null,
      verificationStartId: row.verification_start_id as string | null,
      commitStartId: row.commit_start_id as string | null,
      receiptJson: row.receipt_json,
      recordedAt: row.recorded_at,
    };
  }

  recordCompletionEvidence(input: RecordCompletionEvidenceInput): RecordCompletionEvidenceResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      const { taskId, executionRunId, invocationId, launchAttemptId, launchResultId, snapshotId, codexStartId, verificationStartId, commitStartId, receipt } = input;
      if (Object.keys(input).length !== 10) throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      if (![taskId, executionRunId, invocationId, launchAttemptId, launchResultId, snapshotId].every(
        (id) => typeof id === 'string' && PROJECT_TASK_ID.test(id),
      )) throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      if (codexStartId !== null && (typeof codexStartId !== 'string' || !PROJECT_TASK_ID.test(codexStartId))) {
        throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      }
      if (verificationStartId !== null && (typeof verificationStartId !== 'string' || !PROJECT_TASK_ID.test(verificationStartId))) {
        throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      }
      if (commitStartId !== null && (typeof commitStartId !== 'string' || !PROJECT_TASK_ID.test(commitStartId))) {
        throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      }
      if (!isRecord(receipt) || !isSafeTaskReceipt(receipt)) {
        throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      }
      const receiptJson = JSON.stringify(receipt);

      const existingRow = this.database.prepare(`
        SELECT completion_evidence_id, task_id, execution_run_id,
               invocation_id, launch_attempt_id, launch_result_id, snapshot_id,
               codex_start_id, verification_start_id, commit_start_id,
               receipt_json, recorded_at
        FROM project_task_completion_evidence
        WHERE task_id = ?
      `).get(taskId) as unknown as CompletionEvidenceRow | undefined;

      if (existingRow !== undefined) {
        if (existingRow.receipt_json === receiptJson) {
          return { completionEvidence: this.decodeCompletionEvidenceRow(existingRow), created: false };
        }
        throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.contradictory);
      }

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 9007199254740991) {
        throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      }
      const completionEvidenceId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_completion_evidence
          (completion_evidence_id, task_id, execution_run_id, invocation_id,
           launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
           verification_start_id, commit_start_id, receipt_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(completionEvidenceId, taskId, executionRunId, invocationId,
        launchAttemptId, launchResultId, snapshotId, codexStartId,
        verificationStartId, commitStartId, receiptJson, now);

      const inserted = this.database.prepare(`
        SELECT completion_evidence_id, task_id, execution_run_id,
               invocation_id, launch_attempt_id, launch_result_id, snapshot_id,
               codex_start_id, verification_start_id, commit_start_id,
               receipt_json, recorded_at
        FROM project_task_completion_evidence
        WHERE completion_evidence_id = ?
      `).get(completionEvidenceId) as unknown as CompletionEvidenceRow | undefined;

      if (inserted === undefined) throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      return { completionEvidence: this.decodeCompletionEvidenceRow(inserted), created: true };
    });
  }

  readCompletionEvidence(taskId: string): ProjectTaskCompletionEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT completion_evidence_id, task_id, execution_run_id,
               invocation_id, launch_attempt_id, launch_result_id, snapshot_id,
               codex_start_id, verification_start_id, commit_start_id,
               receipt_json, recorded_at
        FROM project_task_completion_evidence
        WHERE task_id = ?
      `).get(taskId) as unknown as CompletionEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeCompletionEvidenceRow(row);
    });
  }

  // --- Commit Evidence Store API ---

  recordCommitStartEvidence(input: RecordCommitStartInput): RecordCommitStartResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      const { taskId, executionRunId, invocationId, launchAttemptId, launchResultId, snapshotId, codexStartId, verificationStartId, executionId } = input;
      if (Object.keys(input).length !== 9) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      if (![taskId, executionRunId, invocationId, launchAttemptId, launchResultId, snapshotId, codexStartId, verificationStartId].every(
        (id) => typeof id === 'string' && PROJECT_TASK_ID.test(id),
      )) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      if (typeof executionId !== 'string' || executionId.length < 1 || executionId.length > 36) {
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }

      const existingRow = this.database.prepare(`
        SELECT commit_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               verification_start_id, execution_id, start_recorded_at
        FROM project_task_commit_start_evidence
        WHERE task_id = ?
      `).get(taskId) as unknown as CommitStartEvidenceRow | undefined;

      if (existingRow !== undefined) {
        const existing = this.decodeCommitStartEvidenceRow(existingRow);
        if (
          existing.executionRunId === executionRunId
          && existing.invocationId === invocationId
          && existing.launchAttemptId === launchAttemptId
          && existing.launchResultId === launchResultId
          && existing.snapshotId === snapshotId
          && existing.codexStartId === codexStartId
          && existing.verificationStartId === verificationStartId
          && existing.executionId === executionId
        ) {
          return { commitStart: existing, created: false };
        }
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.contradictory);
      }

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 9007199254740991) {
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }
      const commitStartId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_commit_start_evidence
          (commit_start_id, task_id, execution_run_id, invocation_id,
           launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
           verification_start_id, execution_id, start_recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(commitStartId, taskId, executionRunId, invocationId,
        launchAttemptId, launchResultId, snapshotId, codexStartId,
        verificationStartId, executionId, now);

      const inserted = this.database.prepare(`
        SELECT commit_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               verification_start_id, execution_id, start_recorded_at
        FROM project_task_commit_start_evidence
        WHERE commit_start_id = ?
      `).get(commitStartId) as unknown as CommitStartEvidenceRow | undefined;

      if (inserted === undefined) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      return { commitStart: this.decodeCommitStartEvidenceRow(inserted), created: true };
    });
  }

  readCommitStartEvidence(commitStartId: string): CommitStartEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof commitStartId !== 'string' || !PROJECT_TASK_ID.test(commitStartId)) {
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT commit_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               verification_start_id, execution_id, start_recorded_at
        FROM project_task_commit_start_evidence
        WHERE commit_start_id = ?
      `).get(commitStartId) as unknown as CommitStartEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeCommitStartEvidenceRow(row);
    });
  }

  readCommitStartEvidenceByTask(taskId: string): CommitStartEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT commit_start_id, task_id, execution_run_id, invocation_id,
               launch_attempt_id, launch_result_id, snapshot_id, codex_start_id,
               verification_start_id, execution_id, start_recorded_at
        FROM project_task_commit_start_evidence
        WHERE task_id = ?
      `).get(taskId) as unknown as CommitStartEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeCommitStartEvidenceRow(row);
    });
  }

  recordCommitResultEvidence(input: RecordCommitResultInput): RecordCommitResultResult {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      const { commitStartId, status, commitSha, error, summary } = input;
      if (Object.keys(input).length !== 5) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      if (typeof commitStartId !== 'string' || !PROJECT_TASK_ID.test(commitStartId)) {
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }
      if (typeof status !== 'string' || !COMMIT_RESULT_STATUSES.includes(status as typeof COMMIT_RESULT_STATUSES[number])) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      if (status === 'committed') {
        if (typeof commitSha !== 'string' || commitSha.length < 40 || commitSha.length > 64 || !/^[0-9a-fA-F]+$/.test(commitSha)) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        if (error !== null) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        if (summary !== 'The verified workspace was committed locally.') throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }
      if (status === 'commit_failed') {
        if (commitSha !== null) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        if (typeof error !== 'string' || !COMMIT_FAILURE_ERRORS.includes(error as typeof COMMIT_FAILURE_ERRORS[number])) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        if (typeof summary !== 'string' || summary.length < 1 || summary.length > 500 || summary !== summary.trim()) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }
      if (status === 'nothing_to_commit') {
        if (commitSha !== null) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        if (error !== 'nothing_to_commit') throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
        if (typeof summary !== 'string' || summary.length < 1 || summary.length > 500 || summary !== summary.trim()) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }

      const existingRow = this.database.prepare(`
        SELECT commit_result_id, commit_start_id, status, commit_sha, error,
               summary, result_recorded_at
        FROM project_task_commit_result_evidence
        WHERE commit_start_id = ?
      `).get(commitStartId) as unknown as CommitResultEvidenceRow | undefined;

      if (existingRow !== undefined) {
        const existing = this.decodeCommitResultEvidenceRow(existingRow);
        if (
          existing.status === status
          && existing.commitSha === commitSha
          && existing.error === error
          && existing.summary === summary
        ) {
          return { commitResult: existing, created: false };
        }
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.resultContradictory);
      }

      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 9007199254740991) {
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }
      const commitResultId = randomUUID();
      this.database.prepare(`
        INSERT INTO project_task_commit_result_evidence
          (commit_result_id, commit_start_id, status, commit_sha, error,
           summary, result_recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(commitResultId, commitStartId, status, commitSha, error, summary, now);

      const inserted = this.database.prepare(`
        SELECT commit_result_id, commit_start_id, status, commit_sha, error,
               summary, result_recorded_at
        FROM project_task_commit_result_evidence
        WHERE commit_result_id = ?
      `).get(commitResultId) as unknown as CommitResultEvidenceRow | undefined;

      if (inserted === undefined) throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      return { commitResult: this.decodeCommitResultEvidenceRow(inserted), created: true };
    });
  }

  readCommitResultEvidence(commitStartId: string): CommitResultEvidenceRecord | undefined {
    return this.inTransaction(() => {
      if (typeof commitStartId !== 'string' || !PROJECT_TASK_ID.test(commitStartId)) {
        throw new Error(PROJECT_TASK_COMMIT_EVIDENCE_ERRORS.corruptRecord);
      }
      const row = this.database.prepare(`
        SELECT commit_result_id, commit_start_id, status, commit_sha, error,
               summary, result_recorded_at
        FROM project_task_commit_result_evidence
        WHERE commit_start_id = ?
      `).get(commitStartId) as unknown as CommitResultEvidenceRow | undefined;
      return row === undefined ? undefined : this.decodeCommitResultEvidenceRow(row);
    });
  }

  acquireTaskLease(input: AcquireProjectTaskLeaseInput): ProjectTaskLeaseRecord {
    return this.inTransaction(() => this.acquireTaskLeaseInTransaction(input));
  }

  renewTaskLease(input: RenewProjectTaskLeaseInput): ProjectTaskLeaseRecord {
    return this.inTransaction(() => {
      if (!isRecord(input)) throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
      const { durationMs, ...authority } = input;
      if (
        Object.keys(input).length !== 5
        || !Object.keys(input).every((key) => [
          'taskId', 'leaseOwner', 'leaseId', 'fencingToken', 'durationMs',
        ].includes(key))
        || !this.validLeaseAuthority(authority)
        || !this.validLeaseDuration(durationMs)
      ) throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
      const task = this.selectRow(input.taskId);
      if (task === undefined) throw new Error(PROJECT_TASK_LEASE_ERRORS.taskNotFound);
      if (task.terminal_at !== null) throw new Error(PROJECT_TASK_LEASE_ERRORS.taskTerminal);
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - durationMs) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
      }
      const currentRow = this.selectCurrentLeaseRow(input.taskId);
      if (currentRow === undefined) throw new Error(PROJECT_TASK_LEASE_ERRORS.notFound);
      const current = this.decodeLeaseRow(currentRow);
      if (!this.leaseAuthorityMatches(current, authority)) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.stale);
      }
      if (now >= current.leaseExpiresAt) throw new Error(PROJECT_TASK_LEASE_ERRORS.expired);
      const leaseExpiresAt = now + durationMs;
      if (leaseExpiresAt <= current.leaseExpiresAt) return current;
      const renewed = this.database.prepare(`
        UPDATE project_task_lease_generations SET lease_expires_at = ?
        WHERE task_id = ? AND lease_id = ? AND fencing_token = ? AND released_at IS NULL
      `).run(leaseExpiresAt, input.taskId, input.leaseId, input.fencingToken);
      if (Number(renewed.changes) !== 1) throw new Error(PROJECT_TASK_LEASE_ERRORS.stale);
      const row = this.selectCurrentLeaseRow(input.taskId);
      if (row === undefined) throw new Error(PROJECT_TASK_LEASE_ERRORS.corruptRecord);
      return this.decodeLeaseRow(row);
    });
  }

  releaseTaskLease(authority: ProjectTaskLeaseAuthority): ProjectTaskLeaseRecord {
    return this.inTransaction(() => {
      if (!this.validLeaseAuthority(authority)) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
      }
      const currentRow = this.selectCurrentLeaseRow(authority.taskId);
      if (currentRow !== undefined) {
        const current = this.decodeLeaseRow(currentRow);
        if (!this.leaseAuthorityMatches(current, authority)) {
          throw new Error(PROJECT_TASK_LEASE_ERRORS.stale);
        }
        const now = this.now();
        if (!Number.isSafeInteger(now) || now < 0) {
          throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
        }
        const invocationReservation = this.database.prepare(`
          SELECT MAX(reserved_at) AS latest_reserved_at
          FROM project_task_execution_invocations
          WHERE task_id = ? AND reservation_lease_id = ?
            AND reservation_fencing_token = ?
        `).get(
          authority.taskId,
          authority.leaseId,
          authority.fencingToken,
        ) as unknown as { latest_reserved_at: unknown };
        if (
          invocationReservation.latest_reserved_at !== null
          && (
            typeof invocationReservation.latest_reserved_at !== 'number'
            || !Number.isSafeInteger(invocationReservation.latest_reserved_at)
            || invocationReservation.latest_reserved_at < current.acquiredAt
          )
        ) throw new Error(PROJECT_TASK_EXECUTION_INVOCATION_ERRORS.corruptRecord);
        const latestReservedAt = typeof invocationReservation.latest_reserved_at === 'number'
          ? invocationReservation.latest_reserved_at
          : 0;
        const released = this.database.prepare(`
          UPDATE project_task_lease_generations SET released_at = ?
          WHERE task_id = ? AND lease_id = ? AND fencing_token = ? AND released_at IS NULL
        `).run(
          Math.max(
            now,
            current.acquiredAt,
            latestReservedAt,
          ),
          authority.taskId,
          authority.leaseId,
          authority.fencingToken,
        );
        if (Number(released.changes) !== 1) throw new Error(PROJECT_TASK_LEASE_ERRORS.stale);
        return current;
      }

      const releasedRow = this.selectLeaseGenerationRow(
        authority.taskId,
        authority.leaseId,
        authority.fencingToken,
      );
      if (releasedRow === undefined) throw new Error(PROJECT_TASK_LEASE_ERRORS.notFound);
      const released = this.decodeLeaseRow(releasedRow);
      if (!this.leaseAuthorityMatches(released, authority) || releasedRow.released_at === null) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.stale);
      }
      const latest = this.database.prepare(`
        SELECT MAX(fencing_token) AS latest_token
        FROM project_task_lease_generations WHERE task_id = ?
      `).get(authority.taskId) as unknown as { latest_token: unknown };
      if (latest.latest_token !== authority.fencingToken) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.stale);
      }
      return released;
    });
  }

  readTaskLease(taskId: string): ProjectTaskLeaseRecord | undefined {
    return this.inTransaction(() => {
      if (typeof taskId !== 'string' || !PROJECT_TASK_ID.test(taskId)) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
      }
      const row = this.selectCurrentLeaseRow(taskId);
      return row === undefined ? undefined : this.decodeLeaseRow(row);
    });
  }

  validateTaskLease(authority: ProjectTaskLeaseAuthority): boolean {
    return this.inTransaction(() => {
      if (!this.validLeaseAuthority(authority)) return false;
      const task = this.selectRow(authority.taskId);
      if (task === undefined || task.terminal_at !== null) return false;
      const row = this.selectCurrentLeaseRow(authority.taskId);
      if (row === undefined) return false;
      const lease = this.decodeLeaseRow(row);
      const now = this.now();
      return Number.isSafeInteger(now)
        && now >= 0
        && now < lease.leaseExpiresAt
        && this.leaseAuthorityMatches(lease, authority);
    });
  }

  assertCurrentTaskLease(authority: ProjectTaskLeaseAuthority): ProjectTaskLeaseRecord {
    return this.inTransaction(() => {
      if (!this.validLeaseAuthority(authority)) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
      }
      const task = this.selectRow(authority.taskId);
      if (task === undefined) throw new Error(PROJECT_TASK_LEASE_ERRORS.taskNotFound);
      if (task.terminal_at !== null) throw new Error(PROJECT_TASK_LEASE_ERRORS.taskTerminal);
      const row = this.selectCurrentLeaseRow(authority.taskId);
      if (row === undefined) throw new Error(PROJECT_TASK_LEASE_ERRORS.notFound);
      const lease = this.decodeLeaseRow(row);
      if (!this.leaseAuthorityMatches(lease, authority)) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.stale);
      }
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error(PROJECT_TASK_LEASE_ERRORS.invalidInput);
      }
      if (now >= lease.leaseExpiresAt) throw new Error(PROJECT_TASK_LEASE_ERRORS.expired);
      return lease;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
