import type { AutonomousV1CompletionMode } from './autonomousAuthority.js';
import type { ProjectTaskBlockedCapability } from './projectExecutor.js';
import type { ProjectOrchestrationExecutionMode } from './projectOrchestration.js';

export const PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_CANONICAL_VERSION = 'validated-proposal-canonical-v1';

export const PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_MAX_LIST_LIMIT = 100;

export const PROJECT_TASK_VALIDATED_PROPOSAL_SNAPSHOT_ERRORS = {
  invalidInput: 'invalid_project_task_validated_proposal_snapshot_input',
  launchResultNotFound: 'project_task_validated_proposal_snapshot_launch_result_not_found',
  lineageMismatch: 'project_task_validated_proposal_snapshot_lineage_mismatch',
  contradictory: 'project_task_validated_proposal_snapshot_contradictory',
  atomicityViolation: 'project_task_validated_proposal_snapshot_atomicity_violation',
  corruptRecord: 'corrupt_project_task_validated_proposal_snapshot_record',
} as const;

/**
 * Immutable durable snapshot of the NORMALIZED VALIDATED proposal that LÍA
 * obtained at the end of the WHOLE admitted live Hermes phase of one Launch
 * Attempt, persisted atomically with its proposal_valid Launch Result.
 *
 * It is evidence/metadata ONLY. It grants nothing: no project authority, no
 * capabilities, no human approval, no retry, no Hermes relaunch, no Codex
 * permission, no push/merge/deploy, no production/database write, no secret
 * access and no arbitrary shell. It never stores raw Hermes responses,
 * prompts, effectiveCapabilities, approvedCapabilities, plan internals,
 * approval receipts, credentials, sessions, subagent ids, paths, commands or
 * output. requiredCapabilities persist as untrusted proposal metadata and are
 * NEVER interpreted as effectiveCapabilities; effectiveCapabilities must
 * always be freshly derived by LÍA from current durable authority.
 */
export type ProjectTaskValidatedProposalSnapshotRecord = {
  snapshotId: string;
  launchResultId: string;
  launchAttemptId: string;
  invocationId: string;
  executionRunId: string;
  taskId: string;
  /** The canonicalized validated proposal (frozen canonical version). */
  canonicalProposalJson: string;
  /** sha256(canonicalProposalJson) as 64 lowercase hex chars. */
  proposalSha256: string;
  /** Frozen canonicalization version; future formats bump this constant. */
  canonicalVersion: string;
  executionMode: ProjectOrchestrationExecutionMode;
  completionMode: AutonomousV1CompletionMode;
  /** Proposal fact only; never an approval receipt. */
  requiresHumanApproval: boolean;
  /** Proposal fact only; never authority. */
  blockedActions: ProjectTaskBlockedCapability[];
  recordedAt: number;
};

export type RecordValidatedProposalInput = {
  launchAttemptId: string;
  invocationId: string;
  executionRunId: string;
  taskId: string;
  canonicalProposalJson: string;
  proposalSha256: string;
  executionMode: ProjectOrchestrationExecutionMode;
  completionMode: AutonomousV1CompletionMode;
  requiresHumanApproval: boolean;
  blockedActions: ProjectTaskBlockedCapability[];
};

/**
 * Non-authoritative result of the first atomic recording operation.
 *
 * created=true  means this process instance performed the durable first
 *               creation of the proposal_valid Launch Result AND its matching
 *               validated-proposal snapshot, atomically.
 * created=false means the atomic tuple already existed (exact replay of the
 *               same launchAttempt + lineage + canonical hash, including
 *               replay after lease release, lease expiry or DB close/reopen).
 *               It is NEVER permission to execute anything and grants no
 *               authority. A proposal_valid result WITHOUT a matching snapshot
 *               fails closed with atomicityViolation and is never backfilled.
 */
export type RecordValidatedProposalResult = {
  snapshot: ProjectTaskValidatedProposalSnapshotRecord;
  created: boolean;
};

export interface ProjectTaskValidatedProposalSnapshotStore {
  recordValidatedProposalResult(input: RecordValidatedProposalInput): RecordValidatedProposalResult;
  readValidatedProposalSnapshot(snapshotId: string): ProjectTaskValidatedProposalSnapshotRecord | undefined;
  readValidatedProposalSnapshotByLaunchResult(
    launchResultId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined;
  readValidatedProposalSnapshotByLaunchAttempt(
    launchAttemptId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined;
  readValidatedProposalSnapshotByInvocation(
    invocationId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined;
  readValidatedProposalSnapshotByExecutionRun(
    executionRunId: string,
  ): ProjectTaskValidatedProposalSnapshotRecord | undefined;
  readValidatedProposalSnapshotByTask(taskId: string): ProjectTaskValidatedProposalSnapshotRecord | undefined;
  listValidatedProposalSnapshots(limit: number): ProjectTaskValidatedProposalSnapshotRecord[];
}
