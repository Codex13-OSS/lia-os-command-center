import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { LiaAgentConfig } from '../config.js';
import { validateProjectTaskRequest } from '../contracts/projectExecutorValidation.js';
import type { ProjectTaskRequest } from '../contracts/projectExecutor.js';
import { PROJECT_TASK_ID, type ProjectTaskStage, type ProjectTaskStore, type SafeTaskReceipt } from '../contracts/projectTask.js';
import type { ProjectRegistrySource } from '../contracts/projectRegistry.js';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import type { ProjectTaskWorkflowResult } from '../contracts/projectTaskWorkflow.js';
import { methodNotAllowed } from '../middleware/methodNotAllowed.js';
import { resolveAuthorizedProject } from '../services/projectRegistry.js';
import { executeProjectTaskWorkflow } from '../services/projectTaskWorkflowService.js';

type ObservableStage = Extract<ProjectTaskStage, 'planning' | 'hermes' | 'codex' | 'verification' | 'commit'>;
export type AsyncWorkflowExecutor = (onStage: (stage: ObservableStage) => void) => Promise<ProjectTaskWorkflowResult>;
export type ProjectTasksDependencies = { store: ProjectTaskStore; registry?: ProjectRegistrySource; verificationRegistry?: ProjectVerificationRegistry; executeWorkflow?: (request: ProjectTaskRequest, onStage: (stage: ObservableStage) => void) => Promise<ProjectTaskWorkflowResult> };

const fingerprint = (request: { projectId: string; instruction: string; priority: string; requestedCapabilities: string[] }) => createHash('sha256').update(JSON.stringify({ projectId: request.projectId, instruction: request.instruction, priority: request.priority, requestedCapabilities: [...request.requestedCapabilities].sort() })).digest('hex');
const safeReceipt = (result: Extract<ProjectTaskWorkflowResult, { ok: true }>): SafeTaskReceipt | undefined => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.executionId)) return undefined;
  if ((result.status === 'verified' || result.status === 'committed') && (!result.verification || !Number.isSafeInteger(result.verification.checksPassed) || !Number.isSafeInteger(result.verification.totalChecks) || result.verification.checksPassed < 0 || result.verification.totalChecks < result.verification.checksPassed)) return undefined;
  if (result.status === 'committed' && (!result.commit || !/^[0-9a-fA-F]{40,64}$/.test(result.commit))) return undefined;
  return ({ executionId: result.executionId, status: result.status,
  ...(result.verification ? { verification: { status: 'verified', checksPassed: result.verification.checksPassed, totalChecks: result.verification.totalChecks } } : {}),
  ...(result.commit ? { commit: result.commit } : {}),
  });
};

export function createProjectTasksRouter(config: LiaAgentConfig, dependencies: ProjectTasksDependencies): Router {
  const router = Router();
  router.route('/api/projects/tasks').post(async (req, res) => {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body) || !PROJECT_TASK_ID.test(req.body.taskId)) return void res.status(400).json({ ok: false, integration: 'project_task', error: 'invalid_task_id' });
    const { taskId, ...body } = req.body;
    const validation = validateProjectTaskRequest(body);
    if (!validation.success) return void res.status(400).json({ ok: false, integration: 'project_task', error: 'invalid_task' });
    if (!dependencies.registry) return void res.status(503).json({ ok: false, integration: 'project_task', error: 'registry_unavailable' });
    const authorization = await resolveAuthorizedProject(validation.request.projectId, dependencies.registry);
    if (!authorization.ok) return void res.status(authorization.error === 'project_not_found' ? 404 : authorization.error === 'project_disabled' ? 403 : 503).json({ ok: false, integration: 'project_task', error: authorization.error });
    const reserved = dependencies.store.createOrGet(taskId, fingerprint(validation.request), validation.request);
    if (reserved.kind === 'conflict') return void res.status(409).json({ ok: false, integration: 'project_task', error: 'task_id_conflict' });
    if (reserved.kind === 'capacity') return void res.status(503).json({ ok: false, integration: 'project_task', error: 'task_registry_full' });
    if (reserved.kind === 'created') setImmediate(() => {
      const observe = (stage: ObservableStage) => dependencies.store.transition(taskId, stage);
      const run = dependencies.executeWorkflow
        ? dependencies.executeWorkflow(validation.request, observe)
        : executeProjectTaskWorkflow(config, validation.request, dependencies.registry!, dependencies.verificationRegistry, { onStage: observe });
      void run.then((result) => {
        if (result.ok) { const receipt = safeReceipt(result); if (receipt) dependencies.store.complete(taskId, receipt); else dependencies.store.fail(taskId, { code: 'workflow_failed', message: 'La ejecución no pudo completarse.' }); }
        else dependencies.store.fail(taskId, { code: 'workflow_failed', message: 'La ejecución no pudo completarse.', ...(result.projectId && /^[A-Za-z0-9._-]{1,120}$/.test(result.projectId) ? { projectId: result.projectId } : {}), ...(result.executionId && /^[A-Za-z0-9_-]{1,128}$/.test(result.executionId) ? { executionId: result.executionId } : {}) });
      }).catch(() => dependencies.store.fail(taskId, { code: 'workflow_failed', message: 'La ejecución no pudo completarse.' }));
    });
    const receiptStatus = reserved.record.status;
    res.status(reserved.kind === 'created' ? 202 : 200).json({ ok: true, integration: 'project_task', taskId, status: receiptStatus, alreadyKnown: reserved.kind === 'known' });
  }).all(methodNotAllowed(['POST']));

  router.route('/api/projects/tasks/:taskId').get((req, res) => {
    if (!PROJECT_TASK_ID.test(req.params.taskId)) return void res.status(400).json({ ok: false, integration: 'project_task', error: 'invalid_task_id' });
    const record = dependencies.store.get(req.params.taskId);
    if (!record) return void res.status(404).json({ ok: false, integration: 'project_task', error: 'task_not_found' });
    if (record.status === 'completed') return void res.json({ ok: true, integration: 'project_task', taskId: record.taskId, status: record.status, terminal: true, receipt: record.receipt });
    if (record.status === 'failed') return void res.json({ ok: true, integration: 'project_task', taskId: record.taskId, status: record.status, terminal: true, error: record.error });
    res.json({ ok: true, integration: 'project_task', taskId: record.taskId, status: record.status, terminal: false });
  }).all(methodNotAllowed(['GET']));
  return router;
}
