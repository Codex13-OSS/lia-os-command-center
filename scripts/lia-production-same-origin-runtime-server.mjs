/* LIA_SERVER_INVENTORY_IMPORT_V3 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
/* LIA_SERVER_OS_IMPORT_V2 */
import { cpus, hostname as liaOsHostname, loadavg, totalmem, freemem, uptime as liaOsUptime } from 'node:os';
import { statfsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
/* LIA_PERSONAL_AUTH_RUNTIME_V1 */
import { createLiaPersonalAuthHandler } from './lia-personal-auth-v1.mjs';
import { PROJECT_TASK_ID, sanitizeProjectTaskPayload } from './lia-project-task-public-contract.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'frontend', 'dist');
const DIST_LABEL = 'frontend/dist';
const controlledReadServerPath = path.join(scriptDir, 'lia-controlled-same-origin-status-read-server.mjs');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3424;
const DEFAULT_CONTROLLED_ADAPTER_PORT = 3224;
const NON_LOCALHOST_GATE = 'ALLOW_PRODUCTION_SCAFFOLD_REHEARSAL_ONLY';
const MESSAGING_FLAG = ['whats', 'appEnabled'].join('');
const DEFAULT_INTERNAL_BACKEND_PORT = 3014;
const HERMES_QUERY_PATH = '/api/hermes/query';
const HERMES_STATUS_PATH = '/api/hermes/status';
const SAME_ORIGIN_QUERY_PATH = '/api/lia-agent/query';
const SAME_ORIGIN_HERMES_STATUS_PATH = '/api/lia-agent/hermes/status';
const PROJECT_WORKFLOW_PATH = '/api/projects/tasks/workflow';
const SAME_ORIGIN_PROJECT_WORKFLOW_PATH = '/api/lia-agent/projects/tasks/workflow';
const PROJECT_TASKS_PATH = '/api/projects/tasks';
const SAME_ORIGIN_PROJECT_TASKS_PATH = '/api/lia-agent/projects/tasks';
const PROJECT_GOALS_PATH = '/api/projects/goals';
const PROJECT_GOAL_ESTIMATE_PATH = '/api/projects/goals/effort-estimate';
const PROJECT_SUPERVISOR_PATH = '/api/projects/goals/supervisor';
const PROJECT_OFFICE_PATH = '/api/projects/office';
const SAME_ORIGIN_PROJECT_GOALS_PATH = '/api/lia-agent/projects/goals';
const SAME_ORIGIN_PROJECT_GOAL_ESTIMATE_PATH = '/api/lia-agent/projects/goals/effort-estimate';
const SAME_ORIGIN_PROJECT_SUPERVISOR_PATH = '/api/lia-agent/projects/goals/supervisor';
const SAME_ORIGIN_PROJECT_OFFICE_PATH = '/api/lia-agent/projects/office';
const BOARD_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const BOARD_OUTCOMES = new Set(['approved', 'rejected', 'executed', 'superseded']);
const MAX_QUERY_CHARACTERS = 8_000;
// Accept the same real instructions the frontend (8_000 characters, up to
// ~32 KiB in UTF-8) and the backend (express.json 64kb) already accept. A
// 16 KiB byte cap made the production runtime reject long multi-byte
// instructions that work in dev and are valid for the backend.
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 96 * 1024;
const QUERY_TIMEOUT_MS = 125_000;
const PROJECT_WORKFLOW_TIMEOUT_MS = 20 * 60 * 1_000;
const PROJECT_SUBMIT_TIMEOUT_MS = 8_000;
// Leave enough time for this proxy to return its controlled error before the
// browser's status deadline. Equal deadlines make the browser abort the useful
// proxy response under transient backend delay.
const PROJECT_STATUS_TIMEOUT_MS = 3_000;
const PROJECT_GOAL_SUBMIT_TIMEOUT_MS = 8_000;
const ALLOWED_HERMES_ERRORS = new Set(['invalid_query', 'execution_disabled', 'timeout', 'execution_failed', 'empty_response', 'internal_error']);
const PROJECT_PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const PROJECT_CAPABILITIES = ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'];
const PROJECT_WORKFLOW_STAGES = new Set(['planning', 'hermes', 'approval', 'codex', 'verification', 'commit']);
const PROJECT_WORKFLOW_ERRORS = new Set([
  'invalid_task', 'project_not_found', 'project_disabled', 'registry_unavailable',
  'local_commit_requires_run_tests', 'prompt_too_large', 'execution_disabled', 'timeout',
  'execution_failed', 'empty_response', 'invalid_hermes_json', 'invalid_hermes_proposal',
  'human_approval_required', 'missing_repository_read', 'missing_isolated_worktree_write',
  'invalid_generated_path', 'worktree_create_failed', 'codex_execution_failed',
  'worktree_cleanup_failed', 'verification_unavailable', 'visual_verification_unavailable',
  'check_failed', 'check_timeout', 'visual_check_failed', 'visual_check_timeout',
  'local_commit_not_approved', 'workspace_not_verified', 'nothing_to_commit',
  'git_status_failed', 'git_stage_failed', 'git_commit_failed', 'git_revision_failed',
]);

const host = process.env.LIA_PRODUCTION_RUNTIME_HOST || DEFAULT_HOST;
const rawPort = process.env.LIA_PRODUCTION_RUNTIME_PORT || String(DEFAULT_PORT);
const port = Number.parseInt(rawPort, 10);
const rawInternalBackendPort =
  process.env.LIA_HERMES_BACKEND_PORT || String(DEFAULT_INTERNAL_BACKEND_PORT);
const INTERNAL_BACKEND_PORT = Number.parseInt(rawInternalBackendPort, 10);
const allowNonLocalhost = process.env.LIA_PRODUCTION_RUNTIME_ALLOW_NON_LOCALHOST === NON_LOCALHOST_GATE;
const liaPersonalAuth = createLiaPersonalAuthHandler({
  enabled: process.env.LIA_PERSONAL_ACCOUNTS_ENABLED === 'true',
  databasePath: process.env.LIA_PERSONAL_ACCOUNTS_DB || '',
  secureCookies: process.env.LIA_PERSONAL_COOKIE_SECURE === 'true',
});

let controlledAdapter = null;
let controlledAdapterPort = null;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload, null, 2));
}

function createStartupSnapshot(ok, distExists) {
  return {
    ok,
    mode: 'production_same_origin_runtime_scaffold',
    host,
    port,
    distExists,
    activation: "manual_only",
    replacesCurrentFrontend: false,
    processManagerTouched: false,
    proxyTouched: false,
    publicPortOpened: false,
  };
}

function createRuntimeHealth(distExists) {
  return {
    ...createStartupSnapshot(true, distExists),
    service: 'lia-production-same-origin-runtime',
    controlledAdapterStarted: controlledAdapter?.child?.pid !== undefined,
    controlledAdapterPort,
    personalAccounts: {
      enabled: liaPersonalAuth.enabled,
      persistence: liaPersonalAuth.enabled ? 'sqlite_user_scoped' : 'disabled',
    },
  };
}

function createDegradedAdapterPayload() {
  return {
    ok: false,
    source: 'lia-agent-backend',
    mode: 'controlled_same_origin_status_read_degraded',
    backend: {
      reachable: false,
      service: 'lia-agent-backend',
      healthOk: false,
      version: 'unknown',
    },
    safety: {
      realActionsEnabled: false,
      voiceEnabled: false,
      [MESSAGING_FLAG]: false,
      memoryWriteEnabled: false,
      externalModelsEnabled: false,
      secretsLoaded: false,
    },
  };
}

function hasSafeSafetyFlags(payload) {
  return (
    payload?.safety?.realActionsEnabled === false &&
    payload?.safety?.voiceEnabled === false &&
    payload?.safety?.[MESSAGING_FLAG] === false &&
    payload?.safety?.memoryWriteEnabled === false &&
    payload?.safety?.externalModelsEnabled === false &&
    payload?.safety?.secretsLoaded === false
  );
}

function isSanitizedAdapterPayload(payload) {
  const controlledOk =
    payload?.ok === true &&
    payload?.source === 'lia-agent-backend' &&
    payload?.mode === 'controlled_same_origin_status_read' &&
    payload?.backend?.reachable === true &&
    payload?.backend?.healthOk === true;

  const degradedOk =
    payload?.ok === false &&
    payload?.source === 'lia-agent-backend' &&
    payload?.mode === 'controlled_same_origin_status_read_degraded' &&
    payload?.backend?.reachable === false &&
    payload?.backend?.healthOk === false;

  return (controlledOk || degradedOk) && hasSafeSafetyFlags(payload);
}

function parseJsonBody(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

function requestLocal(targetPort, pathname, options = {}) {
  const method = options.method || 'GET';
  const timeout = options.timeout || 1200;
  const requestBody = typeof options.body === 'string' ? options.body : '';
  const headers = { ...(options.headers || {}) };
  const maxResponseBytes =
    Number.isInteger(options.maxResponseBytes) && options.maxResponseBytes > 0
      ? options.maxResponseBytes
      : MAX_RESPONSE_BYTES;

  if (requestBody.length > 0) {
    headers['Content-Length'] = Buffer.byteLength(requestBody);
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = httpRequest(
      {
        host: DEFAULT_HOST,
        port: targetPort,
        method,
        path: pathname,
        timeout,
        headers,
      },
      (response) => {
        let responseBody = '';
        let responseBytes = 0;

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          if (settled) return;

          responseBytes += Buffer.byteLength(chunk, 'utf8');

          if (responseBytes > maxResponseBytes) {
            finish({
              ok: false,
              statusCode: response.statusCode || 0,
              headers: response.headers,
              body: '',
              error: 'response_too_large',
            });
            response.destroy();
            request.destroy();
            return;
          }

          responseBody += chunk;
        });

        response.on('end', () => {
          finish({
            ok: true,
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: responseBody,
          });
        });

        response.on('error', (error) => {
          finish({
            ok: false,
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: '',
            error: error.message,
          });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('request_timeout'));
    });

    request.on('error', (error) => {
      finish({
        ok: false,
        statusCode: 0,
        headers: {},
        body: '',
        error: error.message,
      });
    });

    if (requestBody.length > 0) {
      request.write(requestBody);
    }

    request.end();
  });
}

function readJsonRequestBody(request) {
  return new Promise((resolve) => {
    let body = '';
    let bytes = 0;
    let completed = false;

    const finish = (result) => {
      if (completed) return;
      completed = true;
      resolve(result);
    };

    request.on('data', (chunk) => {
      if (completed) return;

      bytes += chunk.length;

      if (bytes > MAX_REQUEST_BYTES) {
        finish({
          ok: false,
          error: 'payload_too_large',
        });
        return;
      }

      body += chunk.toString('utf8');
    });

    request.on('end', () => {
      if (completed) return;

      try {
        finish({
          ok: true,
          body: JSON.parse(body || '{}'),
        });
      } catch {
        finish({
          ok: false,
          error: 'invalid_json',
        });
      }
    });

    request.on('error', () => {
      finish({
        ok: false,
        error: 'invalid_request',
      });
    });
  });
}

function checkPortAvailable(targetPort) {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once('error', (error) => {
      resolve({
        available: false,
        occupied: error.code === 'EADDRINUSE',
      });
    });

    probe.once('listening', () => {
      probe.close(() => {
        resolve({
          available: true,
          occupied: false,
        });
      });
    });

    probe.listen(targetPort, DEFAULT_HOST);
  });
}

async function findControlledAdapterPort() {
  for (let candidatePort = DEFAULT_CONTROLLED_ADAPTER_PORT; candidatePort < DEFAULT_CONTROLLED_ADAPTER_PORT + 30; candidatePort += 1) {
    const probe = await checkPortAvailable(candidatePort);

    if (probe.available) {
      return candidatePort;
    }
  }

  return null;
}

function startControlledAdapter(adapterPort) {
  const child = spawn(process.execPath, [controlledReadServerPath], {
    cwd: scriptDir,
    env: {
      ...process.env,
      LIA_CONTROLLED_STATUS_READ_HOST: DEFAULT_HOST,
      LIA_CONTROLLED_STATUS_READ_PORT: String(adapterPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  return {
    child,
    getOutput: () => output,
  };
}

async function waitForControlledAdapter(adapterPort) {
  const startedAt = Date.now();
  const timeoutMs = 5000;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestLocal(adapterPort, '/health');

    if (response.ok && response.statusCode === 200) {
      return response;
    }

    await wait(120);
  }

  return null;
}

async function stopControlledAdapter() {
  const child = controlledAdapter?.child;

  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 1800);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
  };

  return contentTypes[extension] || 'application/octet-stream';
}

function serveStatic(requestUrl, response, distExists) {
  if (!distExists) {
    sendJson(response, 503, {
      ok: false,
      error: 'frontend_dist_missing',
      detail: `Run frontend build before starting this scaffold. Expected ${DIST_LABEL}.`,
    });
    return;
  }

  const decodedPath = decodeURIComponent(requestUrl.pathname);
  const requestedRelativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const candidatePath = path.resolve(distDir, requestedRelativePath);
  const safeDistRoot = path.resolve(distDir);

  if (!candidatePath.startsWith(safeDistRoot)) {
    sendJson(response, 404, {
      ok: false,
      error: 'not_found',
    });
    return;
  }

  if (decodedPath !== '/' && !existsSync(candidatePath)) {
    const hasExtension = path.extname(decodedPath).length > 0;

    if (hasExtension) {
      sendJson(response, 404, {
        ok: false,
        error: 'not_found',
      });
      return;
    }
  }

  const filePath = existsSync(candidatePath) && statSync(candidatePath).isFile()
    ? candidatePath
    : path.join(distDir, 'index.html');

  response.writeHead(200, {
    'Content-Type': getContentType(filePath),
    'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=60',
  });
  createReadStream(filePath).pipe(response);
}

async function readControlledAdapter() {
  if (controlledAdapterPort === null) {
    return createDegradedAdapterPayload();
  }

  const response = await requestLocal(controlledAdapterPort, '/api/lia-agent/health', { timeout: 2200 });

  if (!response.ok || response.statusCode !== 200) {
    return createDegradedAdapterPayload();
  }

  const payload = parseJsonBody(response);
  return isSanitizedAdapterPayload(payload) ? payload : createDegradedAdapterPayload();
}

function createSafeHermesError(error = 'backend_unavailable') {
  return {
    ok: false,
    error,
  };
}

function sanitizeHermesPayload(payload) {
  if (
    payload?.ok === true &&
    payload?.integration === 'hermes' &&
    typeof payload?.model === 'string' &&
    payload.model.length > 0 &&
    payload.model.length <= 128 &&
    typeof payload?.response === 'string' &&
    payload.response.trim().length > 0 &&
    Buffer.byteLength(payload.response, 'utf8') <= 64 * 1024
  ) {
    return {
      ok: true,
      integration: 'hermes',
      model: payload.model,
      response: payload.response.trim(),
    };
  }

  if (
    payload?.ok === false &&
    typeof payload?.error === 'string' &&
    ALLOWED_HERMES_ERRORS.has(payload.error)
  ) {
    return createSafeHermesError(payload.error);
  }

  return null;
}

function sanitizeHermesStatusPayload(payload) {
  if (
    payload?.ok === true
    && payload?.service === 'lia-agent-backend'
    && payload?.integration === 'hermes'
    && payload?.mode === 'guarded_prompt_execution'
    && typeof payload?.configured === 'boolean'
    && typeof payload?.runtimeDetected === 'boolean'
    && ['available', 'unavailable'].includes(payload?.state)
    && Number.isSafeInteger(payload?.requiredMarkers)
    && Number.isSafeInteger(payload?.detectedMarkers)
    && typeof payload?.executionEnabled === 'boolean'
    && typeof payload?.toolsEnabled === 'boolean'
    && typeof payload?.memoryWriteEnabled === 'boolean'
    && typeof payload?.handoffEnabled === 'boolean'
    && typeof payload?.multiplexEnabled === 'boolean'
    && payload?.isolationStrategy === 'one_process_per_tenant'
  ) {
    return {
      ok: true,
      integration: 'hermes',
      mode: payload.mode,
      configured: payload.configured,
      runtimeDetected: payload.runtimeDetected,
      state: payload.state,
      executionEnabled: payload.executionEnabled,
      toolsEnabled: payload.toolsEnabled,
      memoryWriteEnabled: payload.memoryWriteEnabled,
      handoffEnabled: payload.handoffEnabled,
      multiplexEnabled: payload.multiplexEnabled,
      isolationStrategy: payload.isolationStrategy,
    };
  }
  return null;
}

async function proxyHermesStatus(response) {
  const upstream = await requestLocal(
    INTERNAL_BACKEND_PORT,
    HERMES_STATUS_PATH,
    {
      method: 'GET',
      timeout: 2200,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      headers: { Accept: 'application/json' },
    },
  );

  if (!upstream.ok) {
    sendJson(response, 503, {
      ok: false,
      integration: 'hermes',
      error: 'backend_unavailable',
    });
    return;
  }

  const sanitized = sanitizeHermesStatusPayload(parseJsonBody(upstream));

  if (sanitized === null) {
    sendJson(response, 502, {
      ok: false,
      integration: 'hermes',
      error: 'invalid_backend_response',
    });
    return;
  }

  sendJson(response, 200, sanitized);
}

async function proxyGoalRead(pathname, response) {
  const upstreamPath = pathname === SAME_ORIGIN_PROJECT_SUPERVISOR_PATH
    ? PROJECT_SUPERVISOR_PATH
    : pathname === SAME_ORIGIN_PROJECT_OFFICE_PATH
      ? PROJECT_OFFICE_PATH
      : PROJECT_GOALS_PATH;

  const upstream = await requestLocal(INTERNAL_BACKEND_PORT, upstreamPath, {
    method: 'GET',
    timeout: 2200,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json' },
  });

  if (!upstream.ok) {
    sendJson(response, 503, { ok: false, error: 'backend_unavailable' });
    return;
  }

  const payload = parseJsonBody(upstream);
  if (payload?.ok !== true) {
    sendJson(response, 502, { ok: false, error: 'invalid_backend_response' });
    return;
  }

  sendJson(response, 200, payload);
}

const PROJECT_GOAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_GOAL_ERRORS = new Set([
  'invalid_goal', 'invalid_goal_id', 'project_not_found', 'project_disabled',
  'registry_unavailable', 'project_goal_capacity_reached',
  'project_goal_already_exists', 'internal_error',
]);

function safeGoalError(error = 'backend_unavailable') {
  return { ok: false, integration: 'project_goal_control', error };
}

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

async function proxyBoundedControl(request, response, upstreamPath, validateBody, integration) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) return sendJson(response, 415, { ok: false, integration, error: 'unsupported_media_type' });
  const parsed = await readJsonRequestBody(request);
  if (!parsed.ok) return sendJson(response, parsed.error === 'payload_too_large' ? 413 : 400, { ok: false, integration, error: parsed.error });
  const forwarded = validateBody(parsed.body);
  if (forwarded === null) return sendJson(response, 400, { ok: false, integration, error: 'invalid_control_action' });
  const upstream = await requestLocal(INTERNAL_BACKEND_PORT, upstreamPath, {
    method: 'POST', timeout: PROJECT_GOAL_SUBMIT_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(forwarded),
  });
  if (!upstream.ok) return sendJson(response, 503, { ok: false, integration, error: 'backend_unavailable' });
  const payload = parseJsonBody(upstream);
  if (!payload || typeof payload.ok !== 'boolean' || (payload.integration !== undefined && payload.integration !== integration)) return sendJson(response, 502, { ok: false, integration, error: 'invalid_backend_response' });
  if (payload.ok !== true) {
    const error = typeof payload.error === 'string' && /^[a-z0-9_]{1,100}$/.test(payload.error) ? payload.error : 'control_action_failed';
    return sendJson(response, [400, 404, 405, 409, 503].includes(upstream.statusCode) ? upstream.statusCode : 502, { ok: false, integration, error });
  }
  return sendJson(response, upstream.statusCode >= 200 && upstream.statusCode < 300 ? upstream.statusCode : 502, payload);
}

async function proxyBoundedRead(upstreamPath, response, integration) {
  const upstream = await requestLocal(INTERNAL_BACKEND_PORT, upstreamPath, {
    method: 'GET', timeout: 2200, maxResponseBytes: MAX_RESPONSE_BYTES, headers: { Accept: 'application/json' },
  });
  if (!upstream.ok) return sendJson(response, 503, { ok: false, integration, error: 'backend_unavailable' });
  const payload = parseJsonBody(upstream);
  if (!payload || typeof payload.ok !== 'boolean' || (payload.integration !== undefined && payload.integration !== integration)) return sendJson(response, 502, { ok: false, integration, error: 'invalid_backend_response' });
  if (!payload.ok) {
    const error = typeof payload.error === 'string' && /^[a-z0-9_]{1,100}$/.test(payload.error) ? payload.error : 'read_failed';
    return sendJson(response, [400, 404, 409, 503].includes(upstream.statusCode) ? upstream.statusCode : 502, { ok: false, integration, error });
  }
  return sendJson(response, 200, payload);
}

async function proxyGoalSubmit(request, response) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    sendJson(response, 415, safeGoalError('unsupported_media_type'));
    return;
  }
  const parsed = await readJsonRequestBody(request);
  if (!parsed.ok) {
    sendJson(response, parsed.error === 'payload_too_large' ? 413 : 400, safeGoalError(parsed.error));
    return;
  }
  const body = parsed.body;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const objective = typeof body?.objective === 'string' ? body.objective.trim() : '';
  const baseKeys = ['goalId', 'projectId', 'objective', 'priority'];
  const boundedKeys = [...baseKeys, 'maxAttempts', 'continuationDepthLimit', 'autonomy'];
  const isSupervised = keys.length === baseKeys.length && baseKeys.every((key) => keys.includes(key));
  const autonomy = body?.autonomy;
  const isBounded = keys.length === boundedKeys.length
    && boundedKeys.every((key) => keys.includes(key))
    && Number.isInteger(body?.maxAttempts) && body.maxAttempts >= 1 && body.maxAttempts <= 5
    && Number.isInteger(body?.continuationDepthLimit) && body.continuationDepthLimit >= 0 && body.continuationDepthLimit <= 4
    && autonomy && typeof autonomy === 'object' && !Array.isArray(autonomy)
    && Object.keys(autonomy).length === 4
    && ['mode', 'approver', 'maxCycles', 'elapsedBudgetMs'].every((key) => Object.hasOwn(autonomy, key))
    && autonomy.mode === 'bounded_autonomous'
    && autonomy.approver === 'lia-ui-operator'
    && Number.isInteger(autonomy.maxCycles) && autonomy.maxCycles >= 1 && autonomy.maxCycles <= Math.min(5, body.maxAttempts)
    && Number.isSafeInteger(autonomy.elapsedBudgetMs) && autonomy.elapsedBudgetMs > 0 && autonomy.elapsedBudgetMs <= 24 * 60 * 60 * 1000;
  if (
    (!isSupervised && !isBounded)
    || !PROJECT_GOAL_ID.test(body?.goalId)
    || body?.projectId !== 'lia-hermes'
    || objective.length === 0
    || objective.length > MAX_QUERY_CHARACTERS
    || !PROJECT_PRIORITIES.has(body?.priority)
  ) {
    sendJson(response, 400, safeGoalError('invalid_goal'));
    return;
  }

  const forwarded = {
    goalId: body.goalId,
    projectId: body.projectId,
    objective,
    priority: body.priority,
  };
  if (isBounded) {
    forwarded.maxAttempts = body.maxAttempts;
    forwarded.continuationDepthLimit = body.continuationDepthLimit;
    forwarded.autonomy = {
      mode: autonomy.mode,
      approver: autonomy.approver,
      maxCycles: autonomy.maxCycles,
      elapsedBudgetMs: autonomy.elapsedBudgetMs,
    };
  }
  const forwardedBody = JSON.stringify(forwarded);
  const upstream = await requestLocal(INTERNAL_BACKEND_PORT, PROJECT_GOALS_PATH, {
    method: 'POST',
    timeout: PROJECT_GOAL_SUBMIT_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: forwardedBody,
  });
  if (!upstream.ok) {
    sendJson(response, 503, safeGoalError('backend_unavailable'));
    return;
  }
  const payload = parseJsonBody(upstream);
  if (
    payload?.ok === true
    && payload?.integration === 'project_goal_control'
    && payload?.goal?.goalId === body.goalId
    && payload?.goal?.projectId === body.projectId
    && typeof payload?.alreadyKnown === 'boolean'
    && (upstream.statusCode === 200 || upstream.statusCode === 202)
  ) {
    sendJson(response, upstream.statusCode, {
      ok: true,
      integration: 'project_goal_control',
      alreadyKnown: payload.alreadyKnown,
      goal: { goalId: body.goalId, projectId: body.projectId },
    });
    return;
  }
  if (payload?.ok === false && PROJECT_GOAL_ERRORS.has(payload?.error)) {
    const statusCode = [400, 403, 404, 409, 503].includes(upstream.statusCode) ? upstream.statusCode : 502;
    sendJson(response, statusCode, safeGoalError(payload.error));
    return;
  }
  sendJson(response, 502, safeGoalError('invalid_backend_response'));
}

async function proxyGoalEffortEstimate(request, response) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) return sendJson(response, 415, safeGoalError('unsupported_media_type'));
  const parsed = await readJsonRequestBody(request);
  if (!parsed.ok) return sendJson(response, parsed.error === 'payload_too_large' ? 413 : 400, safeGoalError(parsed.error));
  const body = parsed.body;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const objective = typeof body?.objective === 'string' ? body.objective.trim() : '';
  if (keys.length !== 3 || !['projectId', 'objective', 'priority'].every((key) => keys.includes(key))
    || body?.projectId !== 'lia-hermes' || objective.length < 1 || objective.length > MAX_QUERY_CHARACTERS
    || !PROJECT_PRIORITIES.has(body?.priority)) return sendJson(response, 400, safeGoalError('invalid_goal'));
  const upstream = await requestLocal(INTERNAL_BACKEND_PORT, PROJECT_GOAL_ESTIMATE_PATH, {
    method: 'POST', timeout: PROJECT_GOAL_SUBMIT_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: body.projectId, objective, priority: body.priority }),
  });
  const payload = upstream.ok ? parseJsonBody(upstream) : null;
  const estimate = payload?.estimate;
  if (upstream.statusCode !== 200 || payload?.ok !== true || !['low', 'medium', 'high', 'critical'].includes(estimate?.complexity)
    || !Number.isInteger(estimate?.recommendedMaxAttempts) || !Number.isInteger(estimate?.recommendedContinuationDepth)
    || !Number.isInteger(estimate?.recommendedMaxCycles) || !Number.isSafeInteger(estimate?.recommendedElapsedBudgetMs)
    || !Array.isArray(estimate?.riskFactors) || !Array.isArray(estimate?.rationale)
    || typeof estimate?.confidence !== 'number') return sendJson(response, 502, safeGoalError('invalid_backend_response'));
  sendJson(response, 200, { ok: true, integration: 'project_goal_control', estimate });
}

async function proxyHermesQuery(request, response) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();

  if (!contentType.includes('application/json')) {
    sendJson(response, 415, createSafeHermesError('unsupported_media_type'));
    return;
  }

  const parsedRequest = await readJsonRequestBody(request);

  if (!parsedRequest.ok) {
    const statusCode = parsedRequest.error === 'payload_too_large' ? 413 : 400;
    sendJson(response, statusCode, createSafeHermesError(parsedRequest.error));
    return;
  }

  const query = typeof parsedRequest.body?.query === 'string'
    ? parsedRequest.body.query.trim()
    : '';

  if (query.length === 0 || query.length > MAX_QUERY_CHARACTERS) {
    sendJson(response, 400, {
      ...createSafeHermesError('invalid_query'),
      maxCharacters: MAX_QUERY_CHARACTERS,
    });
    return;
  }

  const upstream = await requestLocal(
    INTERNAL_BACKEND_PORT,
    HERMES_QUERY_PATH,
    {
      method: 'POST',
      timeout: QUERY_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
  );

  if (!upstream.ok) {
    sendJson(response, 502, createSafeHermesError('backend_unavailable'));
    return;
  }

  const sanitized = sanitizeHermesPayload(parseJsonBody(upstream));

  if (sanitized === null) {
    sendJson(response, 502, createSafeHermesError('invalid_backend_response'));
    return;
  }

  const allowedStatusCodes = new Set([200, 400, 502, 503]);
  const statusCode = allowedStatusCodes.has(upstream.statusCode)
    ? upstream.statusCode
    : 502;

  sendJson(response, statusCode, sanitized);
}

function createSafeProjectWorkflowError(error = 'backend_unavailable', stage) {
  return {
    ok: false,
    integration: 'project_workflow',
    ...(PROJECT_WORKFLOW_STAGES.has(stage) ? { stage } : {}),
    error,
  };
}

function sanitizeProjectWorkflowPayload(payload) {
  if (
    payload?.ok === true
    && payload?.integration === 'project_workflow'
    && payload?.projectId === 'lia-hermes'
    && typeof payload?.executionId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(payload.executionId)
    && ['analyzed', 'ready_for_review', 'verified', 'committed'].includes(payload?.status)
    && typeof payload?.resultText === 'string'
    && payload.resultText.length > 0
    && payload.resultText.length <= 6000
  ) {
    const receipt = {
      ok: true,
      integration: 'project_workflow',
      mode: 'isolated_codex_workflow',
      projectId: 'lia-hermes',
      executionId: payload.executionId,
      status: payload.status,
      resultText: payload.resultText,
      executionSummary: payload.status === 'committed'
        ? 'La tarea terminó, fue verificada y quedó guardada en un commit local.'
        : payload.status === 'verified'
          ? 'La tarea terminó y superó las verificaciones configuradas.'
          : 'La tarea terminó y está lista para revisión.',
    };
    if (payload.status !== 'ready_for_review' && payload.status !== 'analyzed') {
      const verification = payload.verification;
      if (
        verification?.status !== 'verified'
        || !Number.isSafeInteger(verification?.checksPassed)
        || !Number.isSafeInteger(verification?.totalChecks)
        || verification.checksPassed < 0
        || verification.totalChecks < verification.checksPassed
      ) return null;
      receipt.verification = {
        status: 'verified',
        checksPassed: verification.checksPassed,
        totalChecks: verification.totalChecks,
      };
    }
    if (payload.status === 'committed') {
      if (typeof payload.commit !== 'string' || !/^[0-9a-fA-F]{40,64}$/.test(payload.commit)) return null;
      receipt.commit = payload.commit;
    }
    return receipt;
  }

  if (
    payload?.ok === false
    && (payload?.integration === undefined || payload.integration === 'project_workflow')
    && PROJECT_WORKFLOW_ERRORS.has(payload?.error)
  ) {
    return createSafeProjectWorkflowError(payload.error, payload.stage);
  }
  return null;
}

async function proxyProjectTaskWorkflow(request, response) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    sendJson(response, 415, createSafeProjectWorkflowError('unsupported_media_type'));
    return;
  }
  const parsedRequest = await readJsonRequestBody(request);
  if (!parsedRequest.ok) {
    sendJson(response, parsedRequest.error === 'payload_too_large' ? 413 : 400, createSafeProjectWorkflowError(parsedRequest.error));
    return;
  }
  const body = parsedRequest.body;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
  const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
  const validCapabilities = Array.isArray(body?.requestedCapabilities)
    && body.requestedCapabilities.length === PROJECT_CAPABILITIES.length
    && PROJECT_CAPABILITIES.every((capability) => body.requestedCapabilities.includes(capability));
  if (
    keys.length !== 4
    || !['projectId', 'instruction', 'priority', 'requestedCapabilities'].every((key) => keys.includes(key))
    || projectId !== 'lia-hermes'
    || instruction.length === 0
    || instruction.length > MAX_QUERY_CHARACTERS
    || !PROJECT_PRIORITIES.has(body?.priority)
    || !validCapabilities
  ) {
    sendJson(response, 400, createSafeProjectWorkflowError('invalid_task', 'planning'));
    return;
  }

  const upstream = await requestLocal(INTERNAL_BACKEND_PORT, PROJECT_WORKFLOW_PATH, {
    method: 'POST',
    timeout: PROJECT_WORKFLOW_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, instruction, priority: body.priority, requestedCapabilities: PROJECT_CAPABILITIES }),
  });
  if (!upstream.ok) {
    sendJson(response, 502, createSafeProjectWorkflowError('backend_unavailable'));
    return;
  }
  const sanitized = sanitizeProjectWorkflowPayload(parseJsonBody(upstream));
  if (sanitized === null) {
    sendJson(response, 502, createSafeProjectWorkflowError('invalid_backend_response'));
    return;
  }
  const statusCode = upstream.statusCode >= 200 && upstream.statusCode <= 504 ? upstream.statusCode : 502;
  sendJson(response, statusCode, sanitized);
}

function safeTaskError(error = 'backend_unavailable') { return { ok: false, integration: 'project_task', error }; }
async function proxyProjectTaskSubmit(request, response) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) return sendJson(response, 415, safeTaskError('unsupported_media_type'));
  const parsed = await readJsonRequestBody(request);
  if (!parsed.ok) return sendJson(response, parsed.error === 'payload_too_large' ? 413 : 400, safeTaskError(parsed.error));
  const body = parsed.body;
  if (!PROJECT_TASK_ID.test(body?.taskId)) return sendJson(response, 400, safeTaskError('invalid_task_id'));
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
  const validCapabilities = Array.isArray(body?.requestedCapabilities)
    && body.requestedCapabilities.length === PROJECT_CAPABILITIES.length
    && PROJECT_CAPABILITIES.every((capability) => body.requestedCapabilities.includes(capability));
  if (keys.length !== 5 || !['taskId', 'projectId', 'instruction', 'priority', 'requestedCapabilities'].every((key) => keys.includes(key)) || body.projectId !== 'lia-hermes' || instruction.length === 0 || instruction.length > MAX_QUERY_CHARACTERS || !PROJECT_PRIORITIES.has(body.priority) || !validCapabilities) return sendJson(response, 400, safeTaskError('invalid_task'));
  const upstream = await requestLocal(INTERNAL_BACKEND_PORT, PROJECT_TASKS_PATH, { method: 'POST', timeout: PROJECT_SUBMIT_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!upstream.ok) return sendJson(response, 503, safeTaskError('backend_unavailable'));
  const sanitized = sanitizeProjectTaskPayload(parseJsonBody(upstream));
  sendJson(response, sanitized ? upstream.statusCode : 502, sanitized ?? safeTaskError('invalid_backend_response'));
}

async function proxyProjectTaskStatus(taskId, response) {
  const upstream = await requestLocal(INTERNAL_BACKEND_PORT, `${PROJECT_TASKS_PATH}/${taskId}`, { timeout: PROJECT_STATUS_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES, headers: { Accept: 'application/json' } });
  if (!upstream.ok) return sendJson(response, 503, safeTaskError('backend_unavailable'));
  const sanitized = sanitizeProjectTaskPayload(parseJsonBody(upstream));
  sendJson(response, sanitized ? upstream.statusCode : 502, sanitized ?? safeTaskError('invalid_backend_response'));
}


/* LIA_SERVER_TELEMETRY_RUNTIME_V2 */

function liaCpuSample() {
  const cpuList = cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpuList) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  return { idle, total };
}

async function createLiaServerTelemetrySnapshot() {
  const before = liaCpuSample();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const after = liaCpuSample();

  const totalDelta = Math.max(1, after.total - before.total);
  const idleDelta = Math.max(0, after.idle - before.idle);
  const cpuPercent = Math.max(
    0,
    Math.min(100, Math.round((100 * (1 - idleDelta / totalDelta)) * 10) / 10),
  );

  const memoryTotalBytes = totalmem();
  const memoryAvailableBytes = freemem();
  const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryAvailableBytes);
  const memoryPercent = memoryTotalBytes > 0
    ? Math.round((memoryUsedBytes / memoryTotalBytes) * 1000) / 10
    : 0;

  let disk = {
    totalBytes: 0,
    usedBytes: 0,
    availableBytes: 0,
    percent: 0,
  };

  try {
    const fs = statfsSync('/');
    const totalBytes = Number(fs.blocks) * Number(fs.bsize);
    const availableBytes = Number(fs.bavail) * Number(fs.bsize);
    const usedBytes = Math.max(0, totalBytes - availableBytes);

    disk = {
      totalBytes,
      usedBytes,
      availableBytes,
      percent: totalBytes > 0
        ? Math.round((usedBytes / totalBytes) * 1000) / 10
        : 0,
    };
  } catch {
    // Fail closed: disk remains unavailable rather than fabricated.
  }

  const cpuList = cpus();
  const loads = loadavg();

  return {
    ok: true,
    source: 'contabo_host_runtime',
    mode: 'read_only_server_telemetry',
    generatedAt: new Date().toISOString(),
    node: {
      hostname: liaOsHostname(),
      platform: process.platform,
      architecture: process.arch,
    },
    cpu: {
      percent: cpuPercent,
      cores: cpuList.length,
      model: cpuList[0]?.model || 'unknown',
      load1: Math.round(loads[0] * 100) / 100,
      load5: Math.round(loads[1] * 100) / 100,
      load15: Math.round(loads[2] * 100) / 100,
    },
    memory: {
      totalBytes: memoryTotalBytes,
      usedBytes: memoryUsedBytes,
      availableBytes: memoryAvailableBytes,
      percent: memoryPercent,
    },
    disk,
    uptimeSeconds: Math.floor(liaOsUptime()),
    safety: {
      readOnly: true,
      actionsEnabled: false,
      processControlEnabled: false,
      fileWritesEnabled: false,
      serviceControlEnabled: false,
    },
  };
}

/* END LIA_SERVER_TELEMETRY_RUNTIME_V2 */


/* LIA_SERVER_INVENTORY_RUNTIME_V3 */

function liaInventoryRun(command, args) {
  try {
    return {
      available: true,
      output: execFileSync(command, args, {
        encoding: 'utf8',
        timeout: 2200,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    };
  } catch {
    return { available: false, output: '' };
  }
}

function liaSafeName(value) {
  return typeof value === 'string'
    ? value.replace(/[^\p{L}\p{N}._:@+ -]/gu, '').slice(0, 120)
    : '';
}

function liaReadDirectory(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => ({
        name: liaSafeName(entry.name),
        type: entry.isDirectory() ? 'directory'
          : entry.isFile() ? 'file'
          : entry.isSymbolicLink() ? 'link'
          : 'other',
      }))
      .filter((entry) => entry.name.length > 0)
      .sort((a,b) => a.name.localeCompare(b.name))
      .slice(0, 60);
  } catch {
    return [];
  }
}

function createLiaServerInventorySnapshot() {
  const pm2Read = liaInventoryRun('pm2', ['jlist']);
  let pm2 = [];

  if (pm2Read.available && pm2Read.output) {
    try {
      const rows = JSON.parse(pm2Read.output);
      if (Array.isArray(rows)) {
        pm2 = rows.slice(0, 80).map((row) => ({
          name: liaSafeName(row?.name),
          status: liaSafeName(row?.pm2_env?.status || 'unknown'),
          pid: Number.isSafeInteger(row?.pid) ? row.pid : 0,
          cpuPercent: typeof row?.monit?.cpu === 'number' ? row.monit.cpu : 0,
          memoryBytes: typeof row?.monit?.memory === 'number' ? row.monit.memory : 0,
        })).filter((row) => row.name);
      }
    } catch {
      pm2 = [];
    }
  }

  const systemRead = liaInventoryRun('systemctl', [
    'list-units',
    '--type=service',
    '--state=running',
    '--no-pager',
    '--no-legend',
    '--plain',
  ]);

  const systemServices = systemRead.output
    .split('\n')
    .map((line) => liaSafeName(line.trim().split(/\s+/)[0] || ''))
    .filter(Boolean)
    .slice(0, 80);

  const dockerRead = liaInventoryRun('docker', [
    'ps',
    '--format',
    '{{.Names}}\t{{.Status}}\t{{.Image}}',
  ]);

  const containers = dockerRead.output
    .split('\n')
    .filter(Boolean)
    .slice(0, 60)
    .map((line) => {
      const [name='', status='', image=''] = line.split('\t');
      return {
        name: liaSafeName(name),
        status: liaSafeName(status),
        image: liaSafeName(image),
      };
    })
    .filter((row) => row.name);

  const portsRead = liaInventoryRun('ss', ['-lntH']);
  const ports = [...new Set(
    portsRead.output
      .split('\n')
      .map((line) => {
        const fields=line.trim().split(/\s+/);
        const local=fields[3] || '';
        const match=local.match(/:(\d+)$/);
        return match ? Number(match[1]) : NaN;
      })
      .filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535)
  )].sort((a,b)=>a-b).slice(0,120);

  const roots = ['/opt','/var/www','/home'].map((path) => ({
    path,
    entries: liaReadDirectory(path),
  }));

  return {
    ok: true,
    source: 'contabo_host_runtime',
    mode: 'read_only_server_inventory',
    generatedAt: new Date().toISOString(),
    capabilities: {
      pm2: pm2Read.available,
      systemd: systemRead.available,
      docker: dockerRead.available,
      ports: portsRead.available,
      filesystem: true,
    },
    pm2,
    systemServices,
    containers,
    ports,
    roots,
    safety: {
      readOnly: true,
      actionsEnabled: false,
      processControlEnabled: false,
      serviceControlEnabled: false,
      fileWritesEnabled: false,
      shellExecutionExposed: false,
      arbitraryPathReadEnabled: false,
    },
  };
}

/* END LIA_SERVER_INVENTORY_RUNTIME_V3 */

function createRuntimeServer(distExists) {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);

    if (await liaPersonalAuth(request, response, requestUrl)) {
      return;
    }

    if (requestUrl.pathname === '/health') {
      if (request.method !== 'GET') {
        sendJson(response, 405, {
          ok: false,
          error: 'method_not_allowed',
          allowedMethods: ['GET'],
        });
        return;
      }

      sendJson(response, 200, createRuntimeHealth(distExists));
      return;
    }

    if (requestUrl.pathname === '/api/lia-agent/server/inventory') {
      if (request.method !== 'GET') {
        sendJson(response, 405, {
          ok: false,
          error: 'method_not_allowed',
          allowedMethods: ['GET'],
        });
        return;
      }

      if (requestUrl.search !== '') {
        sendJson(response, 400, {
          ok: false,
          error: 'invalid_server_inventory_query',
        });
        return;
      }

      try {
        sendJson(response, 200, createLiaServerInventorySnapshot());
      } catch {
        sendJson(response, 503, {
          ok: false,
          error: 'server_inventory_unavailable',
        });
      }
      return;
    }

    if (requestUrl.pathname === '/api/lia-agent/server/telemetry') {
      if (request.method !== 'GET') {
        sendJson(response, 405, {
          ok: false,
          error: 'method_not_allowed',
          allowedMethods: ['GET'],
        });
        return;
      }

      if (requestUrl.search !== '') {
        sendJson(response, 400, {
          ok: false,
          error: 'invalid_server_telemetry_query',
        });
        return;
      }

      try {
        sendJson(response, 200, await createLiaServerTelemetrySnapshot());
      } catch {
        sendJson(response, 503, {
          ok: false,
          error: 'server_telemetry_unavailable',
        });
      }
      return;
    }

    if (requestUrl.pathname === '/api/lia-agent/health') {
      if (request.method !== 'GET') {
        sendJson(response, 405, {
          ok: false,
          error: 'method_not_allowed',
          allowedMethods: ['GET'],
        });
        return;
      }

      sendJson(response, 200, await readControlledAdapter());
      return;
    }

    if (requestUrl.pathname === SAME_ORIGIN_HERMES_STATUS_PATH) {
      if (request.method !== 'GET') {
        sendJson(response, 405, {
          ok: false,
          error: 'method_not_allowed',
          allowedMethods: ['GET'],
        });
        return;
      }

      if (requestUrl.search !== '') {
        sendJson(response, 400, {
          ok: false,
          integration: 'hermes',
          error: 'invalid_request',
        });
        return;
      }

      await proxyHermesStatus(response);
      return;
    }

    if (requestUrl.pathname === SAME_ORIGIN_QUERY_PATH) {
      if (request.method !== 'POST') {
        sendJson(response, 405, {
          ok: false,
          error: 'method_not_allowed',
          allowedMethods: ['POST'],
        });
        return;
      }

      await proxyHermesQuery(request, response);
      return;
    }

    if (requestUrl.pathname === SAME_ORIGIN_PROJECT_SUPERVISOR_PATH) {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['GET'] });
        return;
      }
      await proxyGoalRead(requestUrl.pathname, response);
      return;
    }

    if (requestUrl.pathname === SAME_ORIGIN_PROJECT_OFFICE_PATH) {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['GET'] });
        return;
      }
      if (requestUrl.search !== '') {
        sendJson(response, 400, { ok: false, error: 'invalid_office_query' });
        return;
      }
      await proxyGoalRead(requestUrl.pathname, response);
      return;
    }

    if (requestUrl.pathname === SAME_ORIGIN_PROJECT_GOAL_ESTIMATE_PATH) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['POST'] });
        return;
      }
      if (requestUrl.search !== '') return sendJson(response, 400, safeGoalError('invalid_goal'));
      await proxyGoalEffortEstimate(request, response);
      return;
    }

    if (requestUrl.pathname === SAME_ORIGIN_PROJECT_GOALS_PATH) {
      if (request.method === 'GET') {
        await proxyGoalRead(requestUrl.pathname, response);
        return;
      }
      if (request.method === 'POST') {
        if (requestUrl.search !== '') {
          sendJson(response, 400, safeGoalError('invalid_goal'));
          return;
        }
        await proxyGoalSubmit(request, response);
        return;
      }
      sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['GET', 'POST'] });
      return;
    }

    const goalControlMatch = requestUrl.pathname.match(/^\/api\/lia-agent\/projects\/goals\/([^/]+)\/(suspend|resume|continuation|autonomy|continuation\/approve|continuation\/refuse|continuation\/approval\/revoke|execution\/authorize|execution\/revoke)$/);
    if (goalControlMatch) {
      const [, goalId, action] = goalControlMatch;
      if (!PROJECT_GOAL_ID.test(goalId)) return sendJson(response, 400, safeGoalError('invalid_goal_id'));
      if (requestUrl.search !== '') return sendJson(response, 400, safeGoalError('invalid_control_action'));
      const readOnly = action === 'continuation' || action === 'autonomy';
      if (readOnly) {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['GET'] });
        await proxyBoundedRead(`/api/projects/goals/${goalId}/${action}`, response, 'project_goal_control'); return;
      }
      if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['POST'] });
      const emptyAction = ['suspend', 'resume', 'continuation/refuse', 'continuation/approval/revoke'].includes(action);
      const approverAction = ['continuation/approve', 'execution/authorize'].includes(action);
      const validate = emptyAction
        ? (body) => exactObject(body, []) ? {} : null
        : approverAction
          ? (body) => exactObject(body, ['approver']) && body.approver === 'lia-ui-operator' ? { approver: 'lia-ui-operator' } : null
          : (body) => exactObject(body, ['authorizationId']) && PROJECT_GOAL_ID.test(body.authorizationId) ? { authorizationId: body.authorizationId } : null;
      await proxyBoundedControl(request, response, `/api/projects/goals/${goalId}/${action}`, validate, 'project_goal_control'); return;
    }

    const boardListMatch = requestUrl.pathname.match(/^\/api\/lia-agent\/projects\/([^/]+)\/board-decisions$/);
    if (boardListMatch) {
      const projectId = boardListMatch[1];
      if (!BOARD_SEGMENT.test(projectId)) return sendJson(response, 400, { ok: false, error: 'invalid_executive_board_query' });
      if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['GET'] });
      const limit = requestUrl.searchParams.get('limit');
      if (requestUrl.searchParams.size > 1 || (requestUrl.searchParams.size === 1 && !requestUrl.searchParams.has('limit'))
        || (limit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit))) return sendJson(response, 400, { ok: false, error: 'invalid_executive_board_query' });
      await proxyBoundedRead(`/api/projects/${projectId}/board-decisions${requestUrl.search}`, response, 'lia_executive_board_v1'); return;
    }

    const boardLearningMatch = requestUrl.pathname.match(/^\/api\/lia-agent\/projects\/([^/]+)\/board-learning$/);
    if (boardLearningMatch) {
      const projectId = boardLearningMatch[1];
      if (!BOARD_SEGMENT.test(projectId)) return sendJson(response, 400, { ok: false, error: 'invalid_decision_learning_query' });
      if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['GET'] });
      const limit = requestUrl.searchParams.get('limit');
      if (requestUrl.searchParams.size > 1 || (requestUrl.searchParams.size === 1 && !requestUrl.searchParams.has('limit'))
        || (limit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit))) return sendJson(response, 400, { ok: false, error: 'invalid_decision_learning_query' });
      await proxyBoundedRead(`/api/projects/${projectId}/board-learning${requestUrl.search}`, response, 'lia_decision_learning_v1'); return;
    }

    const boardTransitionMatch = requestUrl.pathname.match(/^\/api\/lia-agent\/projects\/([^/]+)\/board-decisions\/([^/]+)\/outcome-transitions$/);
    if (boardTransitionMatch) {
      const [, projectId, decisionId] = boardTransitionMatch;
      if (!BOARD_SEGMENT.test(projectId) || !BOARD_SEGMENT.test(decisionId)) return sendJson(response, 400, { ok: false, error: 'invalid_control_action' });
      if (requestUrl.search !== '') return sendJson(response, 400, { ok: false, error: 'invalid_control_action' });
      if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['POST'] });
      const validate = (body) => {
        const keys = body?.summary === undefined ? ['requestKey', 'status', 'evidence'] : ['requestKey', 'status', 'summary', 'evidence'];
        if (!exactObject(body, keys) || !BOARD_SEGMENT.test(body.requestKey) || !BOARD_OUTCOMES.has(body.status)
          || !Array.isArray(body.evidence) || body.evidence.length !== 0
          || (body.summary !== undefined && (typeof body.summary !== 'string' || body.summary.length > 2_000))) return null;
        return { requestKey: body.requestKey, status: body.status, ...(body.summary ? { summary: body.summary } : {}), evidence: [] };
      };
      await proxyBoundedControl(request, response, `/api/projects/${projectId}/board-decisions/${decisionId}/outcome-transitions`, validate, 'lia_executive_board_v1'); return;
    }

    if (requestUrl.pathname === SAME_ORIGIN_PROJECT_WORKFLOW_PATH) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['POST'] });
        return;
      }
      await proxyProjectTaskWorkflow(request, response);
      return;
    }

    if (requestUrl.pathname === SAME_ORIGIN_PROJECT_TASKS_PATH) {
      if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['POST'] });
      if (requestUrl.search !== '') return sendJson(response, 400, safeTaskError('invalid_task'));
      await proxyProjectTaskSubmit(request, response); return;
    }
    const taskStatusMatch = requestUrl.pathname.match(/^\/api\/lia-agent\/projects\/tasks\/([^/]+)$/);
    if (taskStatusMatch) {
      if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method_not_allowed', allowedMethods: ['GET'] });
      if (requestUrl.search !== '') return sendJson(response, 400, safeTaskError('invalid_task_id'));
      if (!PROJECT_TASK_ID.test(taskStatusMatch[1])) return sendJson(response, 400, safeTaskError('invalid_task_id'));
      await proxyProjectTaskStatus(taskStatusMatch[1], response); return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      sendJson(response, 404, {
        ok: false,
        error: 'not_found',
        path: requestUrl.pathname,
      });
      return;
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, {
        ok: false,
        error: 'method_not_allowed',
        allowedMethods: ['GET'],
      });
      return;
    }

    serveStatic(requestUrl, response, distExists);
  });
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}

async function shutdownAndExit(server, exitCode = 0) {
  await new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());
  });
  await stopControlledAdapter();
  process.exit(exitCode);
}

if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isInteger(INTERNAL_BACKEND_PORT) ||
  INTERNAL_BACKEND_PORT < 1 ||
  INTERNAL_BACKEND_PORT > 65535
) {
  console.error(JSON.stringify(createStartupSnapshot(false, existsSync(path.join(distDir, 'index.html'))), null, 2));
  process.exit(1);
}

if (host !== DEFAULT_HOST && !allowNonLocalhost) {
  console.error(JSON.stringify(createStartupSnapshot(false, existsSync(path.join(distDir, 'index.html'))), null, 2));
  process.exit(1);
}

const distExists = existsSync(path.join(distDir, 'index.html'));
controlledAdapterPort = await findControlledAdapterPort();

if (controlledAdapterPort !== null) {
  controlledAdapter = startControlledAdapter(controlledAdapterPort);
  await waitForControlledAdapter(controlledAdapterPort);
}

const server = createRuntimeServer(distExists);

process.on('SIGTERM', () => {
  void shutdownAndExit(server, 0);
});
process.on('SIGINT', () => {
  void shutdownAndExit(server, 0);
});

await listenServer(server);

console.log(JSON.stringify(createStartupSnapshot(true, distExists), null, 2));
