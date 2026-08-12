import type { ProjectTaskStore } from './projectTask.js';
import type { ProjectTaskLeaseStore } from './projectTaskLease.js';
import type { ProjectTaskDispatchStore } from './projectTaskDispatch.js';
import type { ProjectTaskExecutionRunStore } from './projectTaskExecutionRun.js';
import type { ProjectTaskExecutionInvocationStore } from './projectTaskExecutionInvocation.js';
import type { ProjectTaskExecutionLaunchAttemptStore } from './projectTaskExecutionLaunchAttempt.js';
import type { ProjectTaskExecutionLaunchResultStore } from './projectTaskExecutionLaunchResult.js';
import type { ProjectTaskValidatedProposalSnapshotStore } from './projectTaskValidatedProposalSnapshot.js';
import type { ProjectTaskResumeDecisionStore } from './projectTaskResumeDecision.js';
import type { ProjectTaskCodexEvidenceStore } from './projectTaskCodexEvidence.js';
import type { ProjectTaskVerificationEvidenceStore } from './projectTaskVerificationEvidence.js';
import type { ProjectTaskCommitEvidenceStore } from './projectTaskCommitEvidence.js';

/**
 * Narrow composite durable-execution capability assembled from the existing
 * Layers 5-10 store interfaces plus the Layer 12 launch-result evidence store,
 * the Layer 13 validated-proposal snapshot store, the Layer 14 resume-decision
 * store, the Layer 15 Codex evidence store, and the Layer 17 verification/commit
 * evidence stores.
 *
 * It is worker/lease/dispatch/run/invocation provenance plus observed-outcome
 * evidence plus validated-proposal snapshot evidence plus resume-decision
 * evidence plus Codex execution evidence plus verification/commit evidence
 * only. It grants no workflow, external-execution, project, capability,
 * approval, Codex, or retry authority, and it adds no authority metadata of
 * its own.
 */
export type ProjectTaskDurableExecutionStore = ProjectTaskStore
  & ProjectTaskLeaseStore
  & ProjectTaskDispatchStore
  & ProjectTaskExecutionRunStore
  & ProjectTaskExecutionInvocationStore
  & ProjectTaskExecutionLaunchAttemptStore
  & ProjectTaskExecutionLaunchResultStore
  & ProjectTaskValidatedProposalSnapshotStore
  & ProjectTaskResumeDecisionStore
  & ProjectTaskCodexEvidenceStore
  & ProjectTaskVerificationEvidenceStore
  & ProjectTaskCommitEvidenceStore;

export const PROJECT_TASK_DURABLE_EXECUTION_ERRORS = {
  unsupportedStore: 'project_task_durable_execution_store_unsupported',
  taskNotAvailable: 'project_task_durable_execution_task_unavailable',
} as const;

/**
 * Marker error raised by the durable Launch Attempt gate when the boundary is
 * already crossed or its state is contested. It is never retry permission: it
 * means the external outcome is unknown and LÍA must not launch again.
 */
export class ExternalLaunchOutcomeUnknownError extends Error {
  constructor() {
    super('project_task_external_launch_outcome_unknown');
    this.name = 'ExternalLaunchOutcomeUnknownError';
  }
}

export function isExternalLaunchOutcomeUnknownError(error: unknown): boolean {
  return error instanceof ExternalLaunchOutcomeUnknownError;
}
