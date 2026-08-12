export const PROJECT_TASK_RESUME_DECISION_ERRORS = {
  invalidInput: 'project_task_resume_decision_invalid_input',
  taskNotFound: 'project_task_resume_decision_task_not_found',
  snapshotNotFound: 'project_task_resume_decision_snapshot_not_found',
  taskNotResumable: 'project_task_resume_decision_task_not_resumable',
  contradictory: 'project_task_resume_decision_contradictory',
  corruptRecord: 'project_task_resume_decision_corrupt_record',
} as const;

export const PROJECT_TASK_RESUME_DECISIONS = ['approved', 'refused'] as const;
export type ProjectTaskResumeDecision = (typeof PROJECT_TASK_RESUME_DECISIONS)[number];

export const PROJECT_TASK_RESUME_REFUSAL_REASONS = [
  'human_approval_required',
  'blocked_actions',
  'invalid_proposal_structure',
  'proposal_sha256_mismatch',
  'planning_failed',
  'registry_unavailable',
] as const;
export type ProjectTaskResumeRefusalReason = (typeof PROJECT_TASK_RESUME_REFUSAL_REASONS)[number];

export const PROJECT_TASK_RESUME_DECISION_MAX_LIST_LIMIT = 100;

export type ProjectTaskResumeDecisionRecord = {
  decisionId: string;
  taskId: string;
  snapshotId: string;
  decision: ProjectTaskResumeDecision;
  refusalReason?: ProjectTaskResumeRefusalReason;
  policyFingerprint: string;
  recordedAt: number;
};

export type RecordResumeDecisionInput = {
  taskId: string;
  snapshotId: string;
  decision: ProjectTaskResumeDecision;
  refusalReason?: ProjectTaskResumeRefusalReason;
  policyFingerprint: string;
};

export type RecordResumeDecisionResult = {
  decision: ProjectTaskResumeDecisionRecord;
  created: boolean;
};

export interface ProjectTaskResumeDecisionStore {
  recordResumeDecision(input: RecordResumeDecisionInput): RecordResumeDecisionResult;
  readResumeDecision(decisionId: string): ProjectTaskResumeDecisionRecord | undefined;
  readResumeDecisionByTask(taskId: string): ProjectTaskResumeDecisionRecord | undefined;
  readResumeDecisionBySnapshot(snapshotId: string): ProjectTaskResumeDecisionRecord | undefined;
  listResumeDecisions(limit: number): ProjectTaskResumeDecisionRecord[];
}
