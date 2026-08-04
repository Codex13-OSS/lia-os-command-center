import type { ProjectTaskRequest } from './projectExecutor.js';

export const PROJECT_TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type ProjectTaskStage = 'accepted' | 'planning' | 'hermes' | 'codex' | 'verification' | 'commit' | 'completed' | 'failed';
export type SafeTaskReceipt = {
  executionId: string;
  status: 'ready_for_review' | 'verified' | 'committed';
  verification?: { status: 'verified'; checksPassed: number; totalChecks: number };
  commit?: string;
};
export type SafeTaskError = { code: 'workflow_failed'; message: 'La ejecución no pudo completarse.'; projectId?: string; executionId?: string };
export type ProjectTaskRecord = {
  taskId: string; fingerprint: string; intent: ProjectTaskRequest; status: ProjectTaskStage;
  createdAt: number; updatedAt: number; terminalAt?: number; receipt?: SafeTaskReceipt; error?: SafeTaskError;
};
export type CreateProjectTaskResult = { kind: 'created'; record: ProjectTaskRecord } | { kind: 'known'; record: ProjectTaskRecord } | { kind: 'conflict' } | { kind: 'capacity' };

/** Storage is intentionally replaceable. The in-memory phase loses every record on process restart. */
export interface ProjectTaskStore {
  createOrGet(taskId: string, fingerprint: string, intent: ProjectTaskRequest): CreateProjectTaskResult;
  get(taskId: string): ProjectTaskRecord | undefined;
  transition(taskId: string, status: Exclude<ProjectTaskStage, 'accepted' | 'completed' | 'failed'>): void;
  complete(taskId: string, receipt: SafeTaskReceipt): void;
  fail(taskId: string, error: SafeTaskError): void;
}
