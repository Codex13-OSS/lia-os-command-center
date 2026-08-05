import type { ProjectTaskRequest } from './projectExecutor.js';
import type { ProjectTaskWorkflowError, ProjectTaskWorkflowStage } from './projectTaskWorkflow.js';

export const PROJECT_TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type ProjectTaskStage = 'accepted' | 'planning' | 'hermes' | 'codex' | 'verification' | 'commit' | 'completed' | 'failed';
export type SafeTaskReceipt = {
  executionId: string;
  status: 'analyzed' | 'ready_for_review' | 'verified' | 'committed';
  resultText: string;
  verification?: { status: 'verified'; checksPassed: number; totalChecks: number };
  commit?: string;
};
export const SAFE_TASK_ERROR_MESSAGES = {
  invalid_task: 'La tarea no es válida.',
  project_not_found: 'El proyecto solicitado no existe.',
  project_disabled: 'El proyecto solicitado está deshabilitado.',
  registry_unavailable: 'El registro de proyectos no está disponible.',
  local_commit_requires_run_tests: 'El commit local requiere verificación previa.',
  prompt_too_large: 'La tarea es demasiado extensa para Hermes.',
  execution_disabled: 'La ejecución de Hermes está deshabilitada.',
  timeout: 'Hermes agotó el tiempo de respuesta.',
  execution_failed: 'Hermes no pudo completar el razonamiento.',
  empty_response: 'Hermes terminó sin producir una respuesta válida.',
  invalid_hermes_json: 'Hermes devolvió una respuesta con formato inválido.',
  invalid_hermes_proposal: 'Hermes produjo un plan que LÍA rechazó por seguridad o estructura.',
  human_approval_required: 'La tarea requiere aprobación antes de continuar.',
  missing_repository_read: 'La tarea requiere acceso de lectura al repositorio.',
  missing_isolated_worktree_write: 'La tarea requiere escritura aislada autorizada.',
  invalid_generated_path: 'El espacio de trabajo generado no pudo validarse de forma segura.',
  worktree_create_failed: 'No se pudo preparar el espacio de trabajo aislado.',
  codex_execution_failed: 'Codex no pudo completar la ejecución.',
  worktree_cleanup_failed: 'No se pudo finalizar de forma segura el espacio de trabajo.',
  verification_unavailable: 'La verificación no está disponible para este proyecto.',
  check_failed: 'Una verificación de la tarea falló.',
  check_timeout: 'La verificación agotó el tiempo permitido.',
  local_commit_not_approved: 'El commit local no fue autorizado.',
  workspace_not_verified: 'El espacio de trabajo no fue verificado.',
  nothing_to_commit: 'La tarea no produjo cambios para guardar.',
  git_status_failed: 'No se pudo comprobar el estado de los cambios.',
  git_stage_failed: 'No se pudieron preparar los cambios verificados.',
  git_commit_failed: 'No se pudo crear el commit local.',
  git_revision_failed: 'No se pudo validar el commit local.',
  workflow_failed: 'La ejecución no pudo completarse.',
  workflow_interrupted: 'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.',
} as const satisfies Record<
  ProjectTaskWorkflowError | 'workflow_failed' | 'workflow_interrupted',
  string
>;
export type SafeTaskErrorCode = keyof typeof SAFE_TASK_ERROR_MESSAGES;
type SafeTaskErrorDetails = {
  stage?: ProjectTaskWorkflowStage;
  projectId?: string;
  executionId?: string;
};
export type SafeTaskError = ({
  [Code in SafeTaskErrorCode]: { code: Code; message: (typeof SAFE_TASK_ERROR_MESSAGES)[Code] }
})[SafeTaskErrorCode] & SafeTaskErrorDetails;
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

/**
 * Optional durable reconciliation capability. Stores that survive restarts
 * expose it so the bootstrap can mark tasks interrupted by a service restart
 * as failed before the server starts listening.
 */
export interface ProjectTaskReconciler {
  reconcileInterruptedTasks(): number;
}
