export const PROJECT_TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PROJECT_TASK_STAGES = new Set(['accepted', 'planning', 'hermes', 'codex', 'verification', 'commit', 'completed', 'failed']);
export const PROJECT_TASK_FAILURE_STAGES = new Set(['planning', 'hermes', 'approval', 'codex', 'verification', 'commit']);
export const PROJECT_TASK_SAFE_STAGES = ['planning', 'hermes', 'codex', 'verification', 'visualQa', 'commit'];
const isSafeTaskStages = (value) => Array.isArray(value) && value.length > 0 && value.every((item, index) => item === PROJECT_TASK_SAFE_STAGES[index]);
export const PROJECT_TASK_ERROR_MESSAGES = new Map([
  ['invalid_task', 'La tarea no es válida.'],
  ['project_not_found', 'El proyecto solicitado no existe.'],
  ['project_disabled', 'El proyecto solicitado está deshabilitado.'],
  ['registry_unavailable', 'El registro de proyectos no está disponible.'],
  ['local_commit_requires_run_tests', 'El commit local requiere verificación previa.'],
  ['prompt_too_large', 'La tarea es demasiado extensa para Hermes.'],
  ['execution_disabled', 'La ejecución de Hermes está deshabilitada.'],
  ['timeout', 'Hermes agotó el tiempo de respuesta.'],
  ['execution_failed', 'Hermes no pudo completar el razonamiento.'],
  ['empty_response', 'Hermes terminó sin producir una respuesta válida.'],
  ['invalid_hermes_json', 'Hermes devolvió una respuesta con formato inválido.'],
  ['invalid_hermes_proposal', 'Hermes produjo un plan que LÍA rechazó por seguridad o estructura.'],
  ['human_approval_required', 'La tarea requiere aprobación antes de continuar.'],
  ['missing_repository_read', 'La tarea requiere acceso de lectura al repositorio.'],
  ['missing_isolated_worktree_write', 'La tarea requiere escritura aislada autorizada.'],
  ['invalid_generated_path', 'El espacio de trabajo generado no pudo validarse de forma segura.'],
  ['worktree_create_failed', 'No se pudo preparar el espacio de trabajo aislado.'],
  ['codex_execution_failed', 'Codex no pudo completar la ejecución.'],
  ['worktree_cleanup_failed', 'No se pudo finalizar de forma segura el espacio de trabajo.'],
  ['verification_unavailable', 'La verificación no está disponible para este proyecto.'],
  ['check_failed', 'Una verificación de la tarea falló.'],
  ['check_timeout', 'La verificación agotó el tiempo permitido.'],
  ['local_commit_not_approved', 'El commit local no fue autorizado.'],
  ['workspace_not_verified', 'El espacio de trabajo no fue verificado.'],
  ['nothing_to_commit', 'La tarea no produjo cambios para guardar.'],
  ['git_status_failed', 'No se pudo comprobar el estado de los cambios.'],
  ['git_stage_failed', 'No se pudieron preparar los cambios verificados.'],
  ['git_commit_failed', 'No se pudo crear el commit local.'],
  ['git_revision_failed', 'No se pudo validar el commit local.'],
  ['workflow_failed', 'La ejecución no pudo completarse.'],
  ['workflow_interrupted', 'La tarea fue interrumpida por un reinicio del servicio y debe ejecutarse nuevamente.'],
]);

const safeTaskError = (error = 'backend_unavailable') => ({ ok: false, integration: 'project_task', error });

export function sanitizeProjectTaskPayload(payload) {
  if (payload?.ok === false && ['invalid_task_id', 'invalid_task', 'project_not_found', 'project_disabled', 'registry_unavailable', 'task_id_conflict', 'task_registry_full', 'task_not_found'].includes(payload.error)) return safeTaskError(payload.error);
  if (payload?.ok !== true || payload.integration !== 'project_task' || !PROJECT_TASK_ID.test(payload.taskId) || !PROJECT_TASK_STAGES.has(payload.status)) return null;
  if (typeof payload.alreadyKnown === 'boolean') return { ok: true, integration: 'project_task', taskId: payload.taskId, status: payload.status, alreadyKnown: payload.alreadyKnown };
  if (typeof payload.terminal !== 'boolean') return null;
  const base = { ok: true, integration: 'project_task', taskId: payload.taskId, status: payload.status, terminal: payload.terminal };
  if (!payload.terminal) return base;
  if (payload.status === 'failed') {
    const expectedMessage = PROJECT_TASK_ERROR_MESSAGES.get(payload.error?.code);
    if (payload.error?.code === 'workflow_interrupted' && payload.error?.stage !== undefined) return null;
    const legacyGeneric = (payload.error?.code === 'workflow_failed' || payload.error?.code === 'workflow_interrupted') && payload.error?.stage === undefined;
    if (!expectedMessage || payload.error?.message !== expectedMessage || (!legacyGeneric && !PROJECT_TASK_FAILURE_STAGES.has(payload.error?.stage))) return null;
    if (payload.error.completedStages !== undefined && !isSafeTaskStages(payload.error.completedStages)) return null;
    return { ...base, error: { ...(legacyGeneric ? {} : { stage: payload.error.stage }), code: payload.error.code, message: expectedMessage, ...(typeof payload.error.projectId === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(payload.error.projectId) ? { projectId: payload.error.projectId } : {}), ...(typeof payload.error.executionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.error.executionId) ? { executionId: payload.error.executionId } : {}), ...(payload.error.completedStages !== undefined ? { completedStages: payload.error.completedStages } : {}) } };
  }
  const r = payload.receipt;
  if (payload.status !== 'completed' || typeof r?.executionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.executionId) || !['analyzed', 'ready_for_review', 'verified', 'committed'].includes(r.status) || typeof r.resultText !== 'string' || r.resultText.length < 1 || r.resultText.length > 6000) return null;
  const receipt = { executionId: r.executionId, status: r.status, resultText: r.resultText };
  if (r.stages !== undefined) {
    if (!isSafeTaskStages(r.stages)) return null;
    receipt.stages = r.stages;
  }
  if (r.verification !== undefined) {
    if (r.verification.status !== 'verified' || !Number.isSafeInteger(r.verification.checksPassed) || !Number.isSafeInteger(r.verification.totalChecks) || r.verification.checksPassed < 0 || r.verification.totalChecks < r.verification.checksPassed) return null;
    receipt.verification = { status: 'verified', checksPassed: r.verification.checksPassed, totalChecks: r.verification.totalChecks };
  }
  if (r.commit !== undefined) { if (!/^[0-9a-fA-F]{40,64}$/.test(r.commit)) return null; receipt.commit = r.commit; }
  if ((r.status === 'verified' || r.status === 'committed') !== (r.verification !== undefined)) return null;
  if ((r.status === 'committed') !== (r.commit !== undefined)) return null;
  return { ...base, receipt };
}
