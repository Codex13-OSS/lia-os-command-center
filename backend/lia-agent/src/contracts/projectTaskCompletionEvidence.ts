/** Layer 18 durable Completion Evidence contract. State-only, never authority. */

import type { SafeTaskReceipt } from './projectTask.js';

/** Immutable crash-window safety net record linking a SafeTaskReceipt to the full execution lineage. */
export type ProjectTaskCompletionEvidenceRecord = {
  completionEvidenceId: string;
  taskId: string;
  executionRunId: string;
  invocationId: string;
  launchAttemptId: string;
  launchResultId: string;
  snapshotId: string;
  codexStartId: string | null;
  verificationStartId: string | null;
  commitStartId: string | null;
  receiptJson: string;
  recordedAt: number;
};

export type RecordCompletionEvidenceInput = {
  taskId: string;
  executionRunId: string;
  invocationId: string;
  launchAttemptId: string;
  launchResultId: string;
  snapshotId: string;
  codexStartId: string | null;
  verificationStartId: string | null;
  commitStartId: string | null;
  receipt: SafeTaskReceipt;
};

export type RecordCompletionEvidenceResult = {
  completionEvidence: ProjectTaskCompletionEvidenceRecord;
  created: boolean;
};

/** The store interface for Completion evidence. Pure data operations — zero authority. */
export interface ProjectTaskCompletionEvidenceStore {
  recordCompletionEvidence(input: RecordCompletionEvidenceInput): RecordCompletionEvidenceResult;
  readCompletionEvidence(taskId: string): ProjectTaskCompletionEvidenceRecord | undefined;
}

export const PROJECT_TASK_COMPLETION_EVIDENCE_ERRORS = {
  contradictory: 'project_task_completion_evidence_contradictory',
  corruptRecord: 'corrupt_project_task_completion_evidence_record',
} as const;
