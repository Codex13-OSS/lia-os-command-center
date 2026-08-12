import type { ProjectTaskRequest } from './projectExecutor.js';
import type { ProjectTaskWorkflowError, ProjectTaskWorkflowStage } from './projectTaskWorkflow.js';

export const PROJECT_TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type ProjectTaskStage = 'accepted' | 'planning' | 'hermes' | 'codex' | 'verification' | 'commit' | 'completed' | 'failed';

/**
 * Safe public stages that may be observed while a durable task is active.
 *
 * Unlike SafeTaskStage terminal traces, active traces may contain canonical
 * gaps because the store records only stages that were actually observed and
 * later superseded. It must never invent a missing workflow phase.
 */
export const ACTIVE_TASK_STAGES = [
  'planning',
  'hermes',
  'codex',
  'verification',
  'commit',
] as const;
export type ActiveTaskStage = (typeof ACTIVE_TASK_STAGES)[number];

const ACTIVE_TASK_STAGE_INDEX = new Map<string, number>(
  ACTIVE_TASK_STAGES.map((stage, index) => [stage, index]),
);

/**
 * Validates an active completed-stage trace.
 *
 * Empty is valid. Non-empty traces must contain only fixed public names,
 * without duplicates and in strictly increasing canonical order. Gaps are
 * intentionally allowed so the trace never fabricates an unobserved stage.
 */
export function isActiveTaskCompletedStages(value: unknown): value is readonly ActiveTaskStage[] {
  if (!Array.isArray(value)) return false;
  let previousIndex = -1;
  for (const stage of value) {
    if (typeof stage !== 'string') return false;
    const index = ACTIVE_TASK_STAGE_INDEX.get(stage);
    if (index === undefined || index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

/**
 * Safe, durable trace of the autonomous workflow phases that completed.
 *
 * Only fixed public phase names are allowed; the trace never carries prompts,
 * commands, output, paths, subagent identifiers, sessions, credentials or
 * secrets. The values follow canonical workflow order so an operator can
 * distinguish, without reading internal logs: planning, Hermes Supervisor,
 * Codex, technical verification, Visual QA and the local commit.
 */
export const SAFE_TASK_STAGES = [
  'planning',
  'hermes',
  'codex',
  'verification',
  'visualQa',
  'commit',
] as const;
export type SafeTaskStage = (typeof SAFE_TASK_STAGES)[number];

/** Validates a durable stage trace: a non-empty canonical-order prefix of SAFE_TASK_STAGES. */
export function isSafeTaskStages(value: unknown): value is readonly SafeTaskStage[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== SAFE_TASK_STAGES[index]) return false;
  }
  return true;
}

export type SafeTaskReceipt = {
  executionId: string;
  status: 'analyzed' | 'ready_for_review' | 'verified' | 'committed';
  resultText: string;
  verification?: { status: 'verified'; checksPassed: number; totalChecks: number };
  commit?: string;
  /** Completed workflow phases in canonical order (present for new tasks; absent for legacy receipts). */
  stages?: readonly SafeTaskStage[];
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
  visual_verification_unavailable: 'La verificación visual no está disponible para este proyecto.',
  check_failed: 'Una verificación de la tarea falló.',
  check_timeout: 'La verificación agotó el tiempo permitido.',
  visual_check_failed: 'La verificación visual del resultado no fue satisfactoria.',
  visual_check_timeout: 'La verificación visual agotó el tiempo permitido.',
  local_commit_not_approved: 'El commit local no fue autorizado.',
  workspace_not_verified: 'El espacio de trabajo no fue verificado.',
  nothing_to_commit: 'La tarea no produjo cambios para guardar.',
  git_status_failed: 'No se pudo comprobar el estado de los cambios.',
  git_stage_failed: 'No se pudieron preparar los cambios verificados.',
  git_commit_failed: 'No se pudo crear el commit local.',
  git_revision_failed: 'No se pudo validar el commit local.',
  workflow_failed: 'La ejecución no pudo completarse.',
  workflow_interrupted: 'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.',
  external_launch_outcome_unknown: 'El lanzamiento externo quedó interrumpido y su resultado es desconocido; LÍA no lo relanza automáticamente.',
  local_resume_available: 'Existe una propuesta validada almacenada de forma duradera; la tarea permanece en estado resumible pendiente de reevaluación de LÍA.',
  resume_refused: 'LÍA rechazó la continuación local después de reevaluar la política actual.',
  codex_start_not_recorded: 'LÍA no pudo registrar el inicio de la ejecución de Codex de forma duradera.',
  codex_result_not_recorded: 'Codex inició su ejecución pero LÍA no pudo registrar su resultado de forma duradera.',
  codex_failed: 'Codex no pudo completar la ejecución.',
} as const satisfies Record<
  ProjectTaskWorkflowError | 'workflow_failed' | 'workflow_interrupted' | 'external_launch_outcome_unknown' | 'local_resume_available' | 'resume_refused' | 'codex_start_not_recorded' | 'codex_result_not_recorded' | 'codex_failed',
  string
>;
export type SafeTaskErrorCode = keyof typeof SAFE_TASK_ERROR_MESSAGES;
type SafeTaskErrorDetails = {
  stage?: ProjectTaskWorkflowStage;
  projectId?: string;
  executionId?: string;
  /** Phases completed before the terminal failure, in canonical order (absent for legacy errors). */
  completedStages?: readonly SafeTaskStage[];
};
export type SafeTaskError = ({
  [Code in SafeTaskErrorCode]: { code: Code; message: (typeof SAFE_TASK_ERROR_MESSAGES)[Code] }
})[SafeTaskErrorCode] & SafeTaskErrorDetails;
export type ProjectTaskLineage = {
  goalId: string;
  parentTaskId?: string;
  continuationDepth: number;
  attemptNumber: number;
};
export type ProjectTaskRecord = {
  taskId: string; fingerprint: string; intent: ProjectTaskRequest; status: ProjectTaskStage;
  createdAt: number; updatedAt: number;
  /** Active workflow phases confirmed complete by observed durable transitions. */
  completedStages?: readonly ActiveTaskStage[];
  /** Durable mission lineage only. It carries no executable authority. */
  lineage?: ProjectTaskLineage;
  terminalAt?: number; receipt?: SafeTaskReceipt; error?: SafeTaskError;
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

/** Aggregate-only restart recovery outcome. It conveys no execution authority. */
export type ProjectTaskRestartRecoveryResult = {
  preservedRecoverable: number;
  failedInterrupted: number;
  terminalUnchanged: number;
  /**
   * Tasks preserved non-terminal with a validated proposal snapshot (Layer 13
   * recovery case 4). They are durably "local resume available": zero Hermes,
   * zero Codex, zero new attempt/result/lease operations were performed. The
   * snapshot is evidence only; fresh LÍA policy evaluation is still mandatory
   * before any later action.
   */
  resumableAvailable: number;
};

/** Optional durable, restart-safe recovery capability. */
export interface ProjectTaskRestartSafeReconciler {
  reconcileRestartSafeTasks(): ProjectTaskRestartRecoveryResult;
}
