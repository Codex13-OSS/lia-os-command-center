export const LIA_PROJECT_TASK_WORKFLOW_PATH = '/api/lia-agent/projects/tasks/workflow';

const WORKFLOW_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_INSTRUCTION_CHARACTERS = 8_000;

export type LiaProjectTaskPriority = 'low' | 'normal' | 'high' | 'critical';

export type LiaProjectTaskWorkflowReceipt = {
  status: 'ready_for_review' | 'verified' | 'committed';
  executionId: string;
  executionSummary: string;
  verification?: {
    status: 'verified';
    checksPassed: number;
    totalChecks: number;
  };
  commit?: string;
};

export type LiaProjectTaskWorkflowResult =
  | { ok: true; receipt: LiaProjectTaskWorkflowReceipt }
  | { ok: false; message: string };

const REQUESTED_CAPABILITIES = [
  'repository_read',
  'isolated_worktree_write',
  'run_tests',
  'local_commit',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function mapWorkflowError(error: unknown, stage?: unknown): string {
  const messages: Record<string, string> = {
    invalid_task: 'Revisa la instrucción y la prioridad antes de ejecutar.',
    project_not_found: 'El proyecto solicitado no está registrado.',
    project_disabled: 'Este proyecto no está habilitado para ejecutar tareas.',
    registry_unavailable: 'El registro de proyectos no está disponible en este momento.',
    execution_disabled: 'La ejecución de proyectos está temporalmente deshabilitada.',
    timeout: 'La ejecución superó el tiempo permitido. Revisa el estado antes de intentarlo de nuevo.',
    execution_failed: 'Hermes no pudo preparar esta tarea.',
    empty_response: 'Hermes no devolvió una propuesta utilizable.',
    invalid_hermes_json: 'Hermes devolvió una propuesta que no pudo validarse.',
    invalid_hermes_proposal: 'La propuesta de Hermes no cumple el contrato de ejecución.',
    human_approval_required: 'La tarea requiere aprobación humana y no fue ejecutada.',
    codex_execution_failed: 'Codex no pudo completar la tarea en el worktree aislado.',
    worktree_create_failed: 'No fue posible preparar el worktree aislado.',
    worktree_cleanup_failed: 'La ejecución terminó, pero no pudo cerrarse el entorno aislado.',
    check_failed: 'La verificación del cambio no fue satisfactoria.',
    check_timeout: 'Las pruebas superaron el tiempo permitido.',
    verification_unavailable: 'La verificación del proyecto no está disponible.',
    nothing_to_commit: 'La tarea no produjo cambios para guardar.',
    git_commit_failed: 'Los cambios se verificaron, pero no pudieron guardarse en un commit local.',
    backend_unavailable: 'El ejecutor de proyectos no está disponible en este momento.',
  };

  if (typeof error === 'string' && messages[error]) return messages[error];
  if (stage === 'verification') return 'No fue posible verificar la ejecución.';
  if (stage === 'commit') return 'No fue posible completar el commit local.';
  return 'No fue posible completar la tarea del proyecto.';
}

function parseReceipt(body: unknown): LiaProjectTaskWorkflowReceipt | null {
  if (!isRecord(body) || body.ok !== true || body.integration !== 'project_workflow') return null;
  if (!['ready_for_review', 'verified', 'committed'].includes(String(body.status))) return null;
  if (typeof body.executionId !== 'string' || body.executionId.length === 0) return null;
  if (typeof body.executionSummary !== 'string' || body.executionSummary.trim().length === 0) return null;

  let verification: LiaProjectTaskWorkflowReceipt['verification'];
  if (body.verification !== undefined) {
    if (
      !isRecord(body.verification) || body.verification.status !== 'verified'
      || !isSafeInteger(body.verification.checksPassed)
      || !isSafeInteger(body.verification.totalChecks)
      || body.verification.checksPassed > body.verification.totalChecks
    ) return null;
    verification = {
      status: 'verified',
      checksPassed: body.verification.checksPassed,
      totalChecks: body.verification.totalChecks,
    };
  }

  const status = body.status as LiaProjectTaskWorkflowReceipt['status'];
  if ((status === 'verified' || status === 'committed') && verification === undefined) return null;
  if (body.commit !== undefined && (typeof body.commit !== 'string' || !/^[0-9a-fA-F]{40,64}$/.test(body.commit))) return null;
  if (status === 'committed' && typeof body.commit !== 'string') return null;

  return {
    status,
    executionId: body.executionId,
    executionSummary: body.executionSummary.trim(),
    ...(verification ? { verification } : {}),
    ...(typeof body.commit === 'string' ? { commit: body.commit } : {}),
  };
}

export async function requestLiaProjectTaskWorkflow(input: {
  projectId: string;
  instruction: string;
  priority: LiaProjectTaskPriority;
}): Promise<LiaProjectTaskWorkflowResult> {
  const projectId = input.projectId.trim();
  const instruction = input.instruction.trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(projectId) || projectId.includes('..')) {
    return { ok: false, message: 'El identificador del proyecto no es válido.' };
  }
  if (instruction.length === 0 || instruction.length > MAX_INSTRUCTION_CHARACTERS) {
    return { ok: false, message: `La instrucción debe contener entre 1 y ${MAX_INSTRUCTION_CHARACTERS} caracteres.` };
  }
  if (!['low', 'normal', 'high', 'critical'].includes(input.priority)) {
    return { ok: false, message: 'Selecciona una prioridad válida.' };
  }

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), WORKFLOW_TIMEOUT_MS);
  try {
    const response = await fetch(LIA_PROJECT_TASK_WORKFLOW_PATH, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, instruction, priority: input.priority, requestedCapabilities: REQUESTED_CAPABILITIES }),
    });
    const body: unknown = await response.json().catch(() => null);
    const receipt = response.ok ? parseReceipt(body) : null;
    if (receipt) return { ok: true, receipt };
    return { ok: false, message: mapWorkflowError(isRecord(body) ? body.error : null, isRecord(body) ? body.stage : null) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof DOMException && error.name === 'AbortError'
        ? mapWorkflowError('timeout')
        : mapWorkflowError('backend_unavailable'),
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
