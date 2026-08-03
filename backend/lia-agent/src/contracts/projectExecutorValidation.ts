import type {
  ProjectTaskPriority,
  ProjectTaskRequest,
  ProjectTaskRequestedCapability,
} from './projectExecutor.js';

export type ProjectTaskValidationError = {
  path: string;
  message: string;
};

export type ProjectTaskValidationResult =
  | { success: true; request: ProjectTaskRequest }
  | { success: false; errors: ProjectTaskValidationError[] };

const REQUEST_KEYS = new Set([
  'projectId',
  'instruction',
  'priority',
  'requestedCapabilities',
]);

const PRIORITIES: readonly ProjectTaskPriority[] = [
  'low',
  'normal',
  'high',
  'critical',
];

const ALLOWED_CAPABILITIES: readonly ProjectTaskRequestedCapability[] = [
  'repository_read',
  'isolated_worktree_write',
  'run_tests',
  'local_commit',
];

const SAFE_PROJECT_ID = /^[A-Za-z0-9._-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateProjectTaskRequest(
  value: unknown,
): ProjectTaskValidationResult {
  if (!isRecord(value)) {
    return {
      success: false,
      errors: [{ path: '$', message: 'Debe ser un objeto' }],
    };
  }

  const errors: ProjectTaskValidationError[] = [];

  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) {
      errors.push({ path: key, message: 'Campo no permitido' });
    }
  }

  let projectId: string | undefined;
  if (typeof value.projectId !== 'string') {
    errors.push({ path: 'projectId', message: 'Debe ser texto' });
  } else {
    projectId = value.projectId.trim();
    if (projectId.length === 0) {
      errors.push({ path: 'projectId', message: 'No puede estar vacío' });
    } else if (projectId.length > 120) {
      errors.push({ path: 'projectId', message: 'Máximo 120 caracteres' });
    } else if (!SAFE_PROJECT_ID.test(projectId) || projectId.includes('..')) {
      errors.push({ path: 'projectId', message: 'Identificador de proyecto inválido' });
    }
  }

  let instruction: string | undefined;
  if (typeof value.instruction !== 'string') {
    errors.push({ path: 'instruction', message: 'Debe ser texto' });
  } else {
    instruction = value.instruction.trim();
    if (instruction.length === 0) {
      errors.push({ path: 'instruction', message: 'No puede estar vacía' });
    } else if (instruction.length > 8_000) {
      errors.push({ path: 'instruction', message: 'Máximo 8000 caracteres' });
    }
  }

  let priority: ProjectTaskPriority | undefined;
  if (!PRIORITIES.includes(value.priority as ProjectTaskPriority)) {
    errors.push({ path: 'priority', message: 'Prioridad inválida' });
  } else {
    priority = value.priority as ProjectTaskPriority;
  }

  let requestedCapabilities: ProjectTaskRequestedCapability[] | undefined;
  if (!Array.isArray(value.requestedCapabilities)) {
    errors.push({ path: 'requestedCapabilities', message: 'Debe ser un array' });
  } else if (value.requestedCapabilities.length > 4) {
    errors.push({ path: 'requestedCapabilities', message: 'Máximo 4 elementos' });
  } else {
    requestedCapabilities = [];
    for (const [index, capability] of value.requestedCapabilities.entries()) {
      if (!ALLOWED_CAPABILITIES.includes(capability as ProjectTaskRequestedCapability)) {
        errors.push({
          path: `requestedCapabilities.${index}`,
          message: 'Capability no permitida',
        });
      } else if (!requestedCapabilities.includes(capability as ProjectTaskRequestedCapability)) {
        requestedCapabilities.push(capability as ProjectTaskRequestedCapability);
      }
    }
  }

  if (
    errors.length > 0
    || projectId === undefined
    || instruction === undefined
    || priority === undefined
    || requestedCapabilities === undefined
  ) {
    return { success: false, errors };
  }

  return {
    success: true,
    request: {
      projectId,
      instruction,
      priority,
      requestedCapabilities,
    },
  };
}
