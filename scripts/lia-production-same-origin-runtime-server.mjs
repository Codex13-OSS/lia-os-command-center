import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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
const SAME_ORIGIN_QUERY_PATH = '/api/lia-agent/query';
const MAX_QUERY_CHARACTERS = 8_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 96 * 1024;
const QUERY_TIMEOUT_MS = 125_000;
const ALLOWED_HERMES_ERRORS = new Set(['invalid_query', 'execution_disabled', 'timeout', 'execution_failed', 'empty_response', 'internal_error']);

const host = process.env.LIA_PRODUCTION_RUNTIME_HOST || DEFAULT_HOST;
const rawPort = process.env.LIA_PRODUCTION_RUNTIME_PORT || String(DEFAULT_PORT);
const port = Number.parseInt(rawPort, 10);
const rawInternalBackendPort =
  process.env.LIA_HERMES_BACKEND_PORT || String(DEFAULT_INTERNAL_BACKEND_PORT);
const INTERNAL_BACKEND_PORT = Number.parseInt(rawInternalBackendPort, 10);
const allowNonLocalhost = process.env.LIA_PRODUCTION_RUNTIME_ALLOW_NON_LOCALHOST === NON_LOCALHOST_GATE;

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

function createRuntimeServer(distExists) {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);

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
