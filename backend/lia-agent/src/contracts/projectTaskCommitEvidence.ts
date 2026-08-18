/** Layer 17 durable Commit evidence contract. State-only, never authority. */

export const COMMIT_RESULT_STATUSES = [
  'committed',
  'commit_failed',
  'nothing_to_commit',
] as const;
export type CommitResultStatus = (typeof COMMIT_RESULT_STATUSES)[number];

export const COMMIT_FAILURE_ERRORS = [
  'git_status_failed',
  'git_stage_failed',
  'git_commit_failed',
  'git_revision_failed',
  'nothing_to_commit',
  'invalid_generated_path',
  'workspace_not_verified',
  'local_commit_not_approved',
  'commit_contradictory_evidence',
] as const;
export type CommitFailureError = (typeof COMMIT_FAILURE_ERRORS)[number];

/** Complete lineage chain proving the commit belongs to the authorized execution. */
export type CommitStartEvidenceRecord = {
  commitStartId: string;
  taskId: string;
  executionRunId: string;
  invocationId: string;
  launchAttemptId: string;
  launchResultId: string;
  snapshotId: string;
  codexStartId: string;
  verificationStartId: string;
  executionId: string;
  startRecordedAt: number;
};

export type CommitResultEvidenceRecord = {
  commitResultId: string;
  commitStartId: string;
  status: CommitResultStatus;
  commitSha: string | null;
  error: string | null;
  summary: string | null;
  resultRecordedAt: number;
};

export type RecordCommitStartInput = {
  taskId: string;
  executionRunId: string;
  invocationId: string;
  launchAttemptId: string;
  launchResultId: string;
  snapshotId: string;
  codexStartId: string;
  verificationStartId: string;
  executionId: string;
};

export type RecordCommitStartResult = {
  commitStart: CommitStartEvidenceRecord;
  created: boolean;
};

export type RecordCommitResultInput = {
  commitStartId: string;
  status: CommitResultStatus;
  commitSha: string | null;
  error: string | null;
  summary: string | null;
};

export type RecordCommitResultResult = {
  commitResult: CommitResultEvidenceRecord;
  created: boolean;
};

/** The store interface for Commit evidence. Pure data operations — zero authority. */
export interface ProjectTaskCommitEvidenceStore {
  recordCommitStartEvidence(input: RecordCommitStartInput): RecordCommitStartResult;
  readCommitStartEvidence(commitStartId: string): CommitStartEvidenceRecord | undefined;
  readCommitStartEvidenceByTask(taskId: string): CommitStartEvidenceRecord | undefined;
  recordCommitResultEvidence(input: RecordCommitResultInput): RecordCommitResultResult;
  readCommitResultEvidence(commitStartId: string): CommitResultEvidenceRecord | undefined;
}

export const PROJECT_TASK_COMMIT_EVIDENCE_ERRORS = {
  startNotRecorded: 'commit_start_not_recorded',
  resultNotRecorded: 'commit_result_not_recorded',
  contradictory: 'project_task_commit_start_evidence_contradictory',
  resultContradictory: 'project_task_commit_result_evidence_contradictory',
  corruptRecord: 'corrupt_project_task_commit_evidence_record',
  commitFailed: 'commit_failed',
} as const;

/**
 * Check if a task has known durable commit success evidence.
 * Returns true only when start evidence exists, result evidence exists,
 * the result references the correct start, and status is 'committed'.
 */
export function hasCommitSuccessEvidence(
  startEvidence: CommitStartEvidenceRecord | undefined,
  resultEvidence: CommitResultEvidenceRecord | undefined,
): resultEvidence is CommitResultEvidenceRecord {
  return (
    startEvidence !== undefined
    && resultEvidence !== undefined
    && resultEvidence.commitStartId === startEvidence.commitStartId
    && resultEvidence.status === 'committed'
  );
}
