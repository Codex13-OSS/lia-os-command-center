import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const runtimePath = path.join(scriptDir, 'lia-production-same-origin-runtime-server.mjs');
const checks = [];
const evidence = {};

function add(id, passed, detail) {
  checks.push({ id, passed, detail });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => resolve(port));
    });
  });
}

function requestLocal(port, pathname, options = {}) {
  const body = typeof options.body === 'string' ? options.body : '';
  const headers = { ...(options.headers || {}) };

  if (body) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = httpRequest(
      {
        host,
        port,
        path: pathname,
        method: options.method || 'GET',
        headers,
        timeout: options.timeout || 4000,
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          finish({
            ok: true,
            status: response.statusCode || 0,
            body: responseBody,
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
        status: 0,
        body: '',
        error: error.message,
      });
    });

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

async function waitForRuntime(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await requestLocal(port, '/health', { timeout: 600 });

    if (response.status === 200) {
      return true;
    }

    await wait(100);
  }

  return false;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt += 1) {
    await wait(100);
  }

  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

let runtimePort = null;
const backendPort = await freePort();

evidence.backendPort = backendPort;
add(
  'backend-port-available',
  Number.isInteger(backendPort),
  'An ephemeral backend port is available.',
);

let forwarded = null;

const fakeBackend = createServer((request, response) => {
  let body = '';

  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    forwarded = {
      method: request.method,
      url: request.url,
      body,
    };

    let parsedBody = null;

    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = null;
    }

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
    });

    if (parsedBody?.query === 'oversized-response') {
      response.end(
        JSON.stringify({
          ok: true,
          integration: 'hermes',
          model: 'deterministic-test-model',
          response: 'x'.repeat(100 * 1024),
        }),
      );
      return;
    }

    response.end(
      JSON.stringify({
        ok: true,
        integration: 'hermes',
        model: 'deterministic-test-model',
        response: 'LIA_HERMES_BRIDGE_SELF_CHECK_OK',
      }),
    );
  });
});

let child = null;
let childOutput = '';

try {
  await new Promise((resolve, reject) => {
    fakeBackend.once('error', reject);
    fakeBackend.listen(backendPort, host, resolve);
  });

  add(
    'fake-backend-local',
    true,
    `Fake backend listens only on ${host}:${backendPort}.`,
  );

  runtimePort = await freePort();
  evidence.runtimePort = runtimePort;

  add(
    'runtime-port-available',
    Number.isInteger(runtimePort),
    'An ephemeral runtime port is available.',
  );

  child = spawn(process.execPath, [runtimePath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LIA_PRODUCTION_RUNTIME_HOST: host,
      LIA_PRODUCTION_RUNTIME_PORT: String(runtimePort),
      LIA_HERMES_BACKEND_PORT: String(backendPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    childOutput += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    childOutput += chunk.toString();
  });

  const ready = await waitForRuntime(runtimePort);

  add(
    'runtime-ready',
    ready,
    'Runtime started on the isolated local port.',
  );

  const successBody = JSON.stringify({
    query: 'prueba determinista',
  });

  const success = await requestLocal(
    runtimePort,
    '/api/lia-agent/query',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: successBody,
    },
  );

  let successJson = null;

  try {
    successJson = JSON.parse(success.body);
  } catch {
    successJson = null;
  }

  evidence.successStatus = success.status;
  evidence.successModel = successJson?.model || null;

  add(
    'query-success-200',
    success.status === 200,
    'POST query returned 200.',
  );

  add(
    'query-contract-sanitized',
    successJson?.ok === true &&
      successJson?.integration === 'hermes' &&
      successJson?.model === 'deterministic-test-model' &&
      successJson?.response === 'LIA_HERMES_BRIDGE_SELF_CHECK_OK',
    'Same-origin response matches the sanitized Hermes contract.',
  );

  add(
    'query-forwarding-exact',
    forwarded?.method === 'POST' &&
      forwarded?.url === '/api/hermes/query' &&
      forwarded?.body === successBody,
    'Runtime forwarded the exact method, path, and JSON body.',
  );

  const getResponse = await requestLocal(
    runtimePort,
    '/api/lia-agent/query',
  );

  add(
    'query-get-405',
    getResponse.status === 405,
    'GET query returned 405.',
  );

  const wrongType = await requestLocal(
    runtimePort,
    '/api/lia-agent/query',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: 'hola',
    },
  );

  add(
    'query-content-type-415',
    wrongType.status === 415,
    'Non-JSON query returned 415.',
  );

  const invalidQuery = await requestLocal(
    runtimePort,
    '/api/lia-agent/query',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: '',
      }),
    },
  );

  add(
    'query-invalid-400',
    invalidQuery.status === 400,
    'Empty query returned 400.',
  );

  const oversizedResponse = await requestLocal(
    runtimePort,
    '/api/lia-agent/query',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'oversized-response',
      }),
    },
  );

  let oversizedJson = null;

  try {
    oversizedJson = JSON.parse(oversizedResponse.body);
  } catch {
    oversizedJson = null;
  }

  add(
    'query-oversized-upstream-502',
    oversizedResponse.status === 502 &&
      oversizedJson?.ok === false &&
      oversizedJson?.error === 'backend_unavailable',
    'Oversized upstream response was rejected safely with 502.',
  );
} catch (error) {
  add(
    'self-check-execution',
    false,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  await stopChild(child);

  if (fakeBackend.listening) {
    await new Promise((resolve) => {
      fakeBackend.close(() => resolve());
    });
  }
}

const result = {
  ok: checks.every((check) => check.passed),
  mode: 'lia_hermes_same_origin_query_self_check',
  checks,
  evidence,
};

if (!result.ok && childOutput.trim()) {
  result.childOutput = childOutput.trim().slice(0, 1600);
}

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exit(1);
}
