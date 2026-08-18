/** Layer 17 durable Verification evidence contract. State-only, never authority. */

export const VERIFICATION_RESULT_STATUSES = [
  'verified',
  'verification_failed',
] as const;
export type VerificationResultStatus = (typeof VERIFICATION_RESULT_STATUSES)[number];

export const VERIFICATION_FAILURE_ERRORS = [
  'check_failed',
  'check_timeout',
  'visual_check_failed',
  'visual_check_timeout',
  'visual_verification_unavailable',
  'verification_unavailable',
  'invalid_generated_path',
] as const;
export type VerificationFailureError = (typeof VERIFICATION_FAILURE_ERRORS)[number];

/** Complete lineage chain proving verification belongs to the authorized execution. */
export type VerificationStartEvidenceRecord = {
  verificationStartId: string;
  taskId: string;
  executionRunId: string;
  invocationId: string;
  launchAttemptId: string;
  launchResultId: string;
  snapshotId: string;
  codexStartId: string;
  executionId: string;
  startRecordedAt: number;
};

export type VerificationResultEvidenceRecord = {
  verificationResultId: string;
  verificationStartId: string;
  status: VerificationResultStatus;
  checksPassed: number;
  totalChecks: number;
  technicalChecksPassed: number;
  technicalTotalChecks: number;
  visualChecksPassed: number;
  visualTotalChecks: number;
  failureError: string | null;
  failureSummary: string | null;
  resultRecordedAt: number;
};

export type RecordVerificationStartInput = {
  taskId: string;
  executionRunId: string;
  invocationId: string;
  launchAttemptId: string;
  launchResultId: string;
  snapshotId: string;
  codexStartId: string;
  executionId: string;
};

export type RecordVerificationStartResult = {
  verificationStart: VerificationStartEvidenceRecord;
  created: boolean;
};

export type RecordVerificationResultInput = {
  verificationStartId: string;
  status: VerificationResultStatus;
  checksPassed: number;
  totalChecks: number;
  technicalChecksPassed: number;
  technicalTotalChecks: number;
  visualChecksPassed: number;
  visualTotalChecks: number;
  failureError: string | null;
  failureSummary: string | null;
};

export type RecordVerificationResultResult = {
  verificationResult: VerificationResultEvidenceRecord;
  created: boolean;
};

/** The store interface for Verification evidence. Pure data operations — zero authority. */
export interface ProjectTaskVerificationEvidenceStore {
  recordVerificationStartEvidence(input: RecordVerificationStartInput): RecordVerificationStartResult;
  readVerificationStartEvidence(verificationStartId: string): VerificationStartEvidenceRecord | undefined;
  readVerificationStartEvidenceByTask(taskId: string): VerificationStartEvidenceRecord | undefined;
  recordVerificationResultEvidence(input: RecordVerificationResultInput): RecordVerificationResultResult;
  readVerificationResultEvidence(verificationStartId: string): VerificationResultEvidenceRecord | undefined;
}

export const PROJECT_TASK_VERIFICATION_EVIDENCE_ERRORS = {
  startNotRecorded: 'verification_start_not_recorded',
  resultNotRecorded: 'verification_result_not_recorded',
  contradictory: 'project_task_verification_start_evidence_contradictory',
  resultContradictory: 'project_task_verification_result_evidence_contradictory',
  corruptRecord: 'corrupt_project_task_verification_evidence_record',
  verificationFailed: 'verification_failed',
  unsafeFailureMessage: 'verification_failure_summary_too_long',
} as const;

/**
 * Check if a task has known durable verification success evidence.
 * Returns true only when start evidence exists, result evidence exists,
 * the result references the correct start, and status is 'verified'.
 */
export function hasVerificationSuccessEvidence(
  startEvidence: VerificationStartEvidenceRecord | undefined,
  resultEvidence: VerificationResultEvidenceRecord | undefined,
): resultEvidence is VerificationResultEvidenceRecord {
  return (
    startEvidence !== undefined
    && resultEvidence !== undefined
    && resultEvidence.verificationStartId === startEvidence.verificationStartId
    && resultEvidence.status === 'verified'
  );
}
