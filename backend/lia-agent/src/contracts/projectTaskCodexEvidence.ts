import type { ProjectCodexExecutionError, ProjectCodexExecutionResult } from './projectCodexExecution.js';

/** Layer 15 durable Codex evidence contract. State-only, never authority. */

export const CODEX_RESULT_OUTCOMES = [
  'codex_success',
  'codex_failed',
  'codex_interrupted',
] as const;
export type CodexResultOutcome = (typeof CODEX_RESULT_OUTCOMES)[number];

/** Complete lineage chain proving the Codex execution is the direct continuation of the LÍA-authorized validated proposal. */
export type CodexStartEvidenceRecord = {
  codexStartId: string;
  taskId: string;
  executionRunId: string;
  invocationId: string;
  launchAttemptId: string;
  launchResultId: string;
  snapshotId: string;
  startRecordedAt: number;
};

export type CodexResultEvidenceRecord = {
  codexResultId: string;
  codexStartId: string;
  executionId: string;
  outcome: CodexResultOutcome;
  success: 0 | 1;
  error: string | null;
  summary: string;
  resultMetadataJson: string;
  resultRecordedAt: number;
};

export type RecordCodexStartInput = {
  taskId: string;
  executionRunId: string;
  invocationId: string;
  launchAttemptId: string;
  launchResultId: string;
  snapshotId: string;
};

export type RecordCodexStartResult = {
  codexStart: CodexStartEvidenceRecord;
  created: boolean;
};

export type RecordCodexResultInput = {
  codexStartId: string;
  executionId: string;
  outcome: CodexResultOutcome;
  success: 0 | 1;
  error: string | null;
  summary: string;
  resultMetadataJson: string;
};

export type RecordCodexResultResult = {
  codexResult: CodexResultEvidenceRecord;
  created: boolean;
};

/** The store interface for Codex execution evidence. Pure data operations — zero authority. */
export interface ProjectTaskCodexEvidenceStore {
  recordCodexStartEvidence(input: RecordCodexStartInput): RecordCodexStartResult;
  readCodexStartEvidence(codexStartId: string): CodexStartEvidenceRecord | undefined;
  readCodexStartEvidenceByTask(taskId: string): CodexStartEvidenceRecord | undefined;
  recordCodexResultEvidence(input: RecordCodexResultInput): RecordCodexResultResult;
  readCodexResultEvidence(codexStartId: string): CodexResultEvidenceRecord | undefined;
}

export const PROJECT_TASK_CODEX_EVIDENCE_ERRORS = {
  startNotRecorded: 'codex_start_not_recorded',
  resultNotRecorded: 'codex_result_not_recorded',
  codexFailed: 'codex_failed',
  contradictory: 'project_task_codex_start_evidence_contradictory',
  resultContradictory: 'project_task_codex_result_evidence_contradictory',
  corruptRecord: 'corrupt_project_task_codex_evidence_record',
} as const;

/**
 * Safe mapping from raw ProjectCodexExecutionResult to the evidence vocabulary.
 * Never exposes paths, transcripts, credentials, or raw output.
 */
export function mapCodexResultToEvidence(result: ProjectCodexExecutionResult): {
  outcome: CodexResultOutcome;
  success: 0 | 1;
  error: string | null;
  summary: string;
  resultMetadataJson: string;
} {
  const summary = (result.summary ?? '').slice(0, 500).trim() || 'Codex execution completed.';
  if (result.success) {
    return {
      outcome: 'codex_success',
      success: 1,
      error: null,
      summary,
      resultMetadataJson: JSON.stringify({
        outcome: result.outcome,
        resultTextLength: (result.resultText ?? '').length,
        executionId: result.executionId,
      }),
    };
  }
  return {
    outcome: 'codex_failed',
    success: 0,
    error: result.error,
    summary,
    resultMetadataJson: JSON.stringify({
      executionId: result.executionId,
    }),
  };
}

/** Check if a task has known durable Codex success evidence. */
export function hasCodexSuccessEvidence(
  startEvidence: CodexStartEvidenceRecord | undefined,
  resultEvidence: CodexResultEvidenceRecord | undefined,
): resultEvidence is CodexResultEvidenceRecord {
  return (
    startEvidence !== undefined
    && resultEvidence !== undefined
    && resultEvidence.codexStartId === startEvidence.codexStartId
    && resultEvidence.outcome === 'codex_success'
  );
}
