import type { LiaProjectTaskPriority } from './liaProjectTaskWorkflowClient';

export const LIA_PROJECT_TASKS_PATH = '/api/lia-agent/projects/tasks';
export const LIA_PROJECT_TASK_STORAGE_KEY = 'lia.project-task.pending.v1';
export type LiaProjectTaskStage = 'accepted' | 'planning' | 'hermes' | 'codex' | 'verification' | 'commit' | 'completed' | 'failed';
export type LiaProjectTaskFailureStage = 'planning' | 'hermes' | 'approval' | 'codex' | 'verification' | 'commit';
export type LiaProjectTaskRequest = { projectId: string; instruction: string; priority: LiaProjectTaskPriority; requestedCapabilities: string[] };
export type LiaProjectTaskReceipt = { executionId: string; status: 'analyzed' | 'ready_for_review' | 'verified' | 'committed'; resultText: string; verification?: { status: 'verified'; checksPassed: number; totalChecks: number }; commit?: string };
export type PersistedProjectTask = { taskId: string; request: LiaProjectTaskRequest; createdAt: number; lastStatus: LiaProjectTaskStage };
export type LiaProjectTaskStatus = { kind: 'active'; taskId: string; status: LiaProjectTaskStage } | { kind: 'completed'; taskId: string; status: 'completed'; receipt: LiaProjectTaskReceipt } | { kind: 'failed'; taskId: string; status: 'failed'; stage?: LiaProjectTaskFailureStage; code: string; message: string } | { kind: 'unknown'; taskId: string } | { kind: 'temporary'; taskId: string } | { kind: 'contract'; taskId: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STAGES = new Set<LiaProjectTaskStage>(['accepted', 'planning', 'hermes', 'codex', 'verification', 'commit', 'completed', 'failed']);
const FAILURE_STAGES = new Set<LiaProjectTaskFailureStage>(['planning', 'hermes', 'approval', 'codex', 'verification', 'commit']);
const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  timeout: 'Hermes agotó el tiempo de respuesta.',
  execution_failed: 'Hermes no pudo completar el razonamiento.',
  empty_response: 'Hermes terminó sin producir una respuesta válida.',
  invalid_hermes_json: 'Hermes devolvió una respuesta con formato inválido.',
  invalid_hermes_proposal: 'Hermes produjo un plan que LÍA rechazó por seguridad o estructura.',
  human_approval_required: 'La tarea requiere aprobación antes de continuar.',
};
const CAPABILITIES = ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fetchShort = async (url: string, init: RequestInit, ms: number) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms); try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); } };
export const projectTaskFailureMessage = (code: string): string => FAILURE_MESSAGES[code] ?? 'La ejecución no pudo completarse.';

function createProjectTaskId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('Secure UUID generation is unavailable.');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function loadPersistedProjectTask(storage: Storage = localStorage): PersistedProjectTask | null {
  try { const value: unknown = JSON.parse(storage.getItem(LIA_PROJECT_TASK_STORAGE_KEY) ?? 'null'); if (!isRecord(value) || !UUID.test(String(value.taskId)) || !isRecord(value.request) || !STAGES.has(value.lastStatus as LiaProjectTaskStage)) return null; return value as unknown as PersistedProjectTask; } catch { return null; }
}
export function clearPersistedProjectTask(taskId: string, storage: Storage = localStorage): void {
  try {
    const persisted = loadPersistedProjectTask(storage);
    if (persisted?.taskId === taskId) storage.removeItem(LIA_PROJECT_TASK_STORAGE_KEY);
  } catch { /* A storage denial must not trap the UI in polling. */ }
}
export function prepareProjectTask(input: { projectId: string; instruction: string; priority: LiaProjectTaskPriority }, storage: Storage = localStorage): PersistedProjectTask {
  const task: PersistedProjectTask = { taskId: createProjectTaskId(), request: { projectId: input.projectId.trim(), instruction: input.instruction.trim(), priority: input.priority, requestedCapabilities: CAPABILITIES }, createdAt: Date.now(), lastStatus: 'accepted' };
  storage.setItem(LIA_PROJECT_TASK_STORAGE_KEY, JSON.stringify(task)); // Must precede the first network request.
  return task;
}
export async function submitProjectTask(task: PersistedProjectTask): Promise<'acknowledged' | 'ambiguous' | 'contract'> {
  try { const response = await fetchShort(LIA_PROJECT_TASKS_PATH, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.taskId, ...task.request }) }, 8_000); const body: unknown = await response.json().catch(() => null); return response.ok && isRecord(body) && body.ok === true && body.taskId === task.taskId ? 'acknowledged' : response.status >= 500 ? 'ambiguous' : 'contract'; } catch { return 'ambiguous'; }
}
export async function getProjectTaskStatus(taskId: string): Promise<LiaProjectTaskStatus> {
  try {
    // Must exceed the same-origin proxy's 3s upstream deadline so a controlled
    // temporary response reaches the poller instead of racing this abort.
    const response = await fetchShort(`${LIA_PROJECT_TASKS_PATH}/${taskId}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } }, 4_000);
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 404 && isRecord(body) && body.error === 'task_not_found') return { kind: 'unknown', taskId };
    if (response.status >= 500) return { kind: 'temporary', taskId };
    if (!response.ok || !isRecord(body) || body.ok !== true || body.taskId !== taskId || !STAGES.has(body.status as LiaProjectTaskStage)) return { kind: 'contract', taskId, message: 'La respuesta de estado no es válida.' };
    if (body.status === 'failed') {
      if (!isRecord(body.error) || typeof body.error.code !== 'string' || (body.error.stage !== undefined && !FAILURE_STAGES.has(body.error.stage as LiaProjectTaskFailureStage))) return { kind: 'contract', taskId, message: 'La respuesta de estado no es válida.' };
      return { kind: 'failed', taskId, status: 'failed', ...(body.error.stage ? { stage: body.error.stage as LiaProjectTaskFailureStage } : {}), code: body.error.code, message: projectTaskFailureMessage(body.error.code) };
    }
    if (body.status === 'completed' && isRecord(body.receipt)) {
      const receipt = body.receipt;
      const status = String(receipt.status);
      const validVerification = isRecord(receipt.verification)
        && receipt.verification.status === 'verified'
        && Number.isSafeInteger(receipt.verification.checksPassed)
        && Number.isSafeInteger(receipt.verification.totalChecks)
        && Number(receipt.verification.checksPassed) >= 0
        && Number(receipt.verification.totalChecks) >= Number(receipt.verification.checksPassed);
      const valid = typeof receipt.executionId === 'string'
        && ['analyzed', 'ready_for_review', 'verified', 'committed'].includes(status)
        && typeof receipt.resultText === 'string' && receipt.resultText.length > 0 && receipt.resultText.length <= 6000
        && ((status === 'verified' || status === 'committed') ? validVerification : receipt.verification === undefined)
        && (status === 'committed' ? typeof receipt.commit === 'string' && /^[0-9a-fA-F]{40,64}$/.test(receipt.commit) : receipt.commit === undefined);
      if (valid) return { kind: 'completed', taskId, status: 'completed', receipt: receipt as LiaProjectTaskReceipt };
      return { kind: 'contract', taskId, message: 'La respuesta de estado no es válida.' };
    }
    if (body.terminal !== false) return { kind: 'contract', taskId, message: 'La respuesta de estado no es válida.' };
    return { kind: 'active', taskId, status: body.status as LiaProjectTaskStage };
  } catch { return { kind: 'temporary', taskId }; }
}
export function persistProjectTaskStatus(task: PersistedProjectTask, status: LiaProjectTaskStage, storage: Storage = localStorage): void {
  try { storage.setItem(LIA_PROJECT_TASK_STORAGE_KEY, JSON.stringify({ ...task, lastStatus: status })); } catch { /* Polling must continue when storage is unavailable. */ }
}
