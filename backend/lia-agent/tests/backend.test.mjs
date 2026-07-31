import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';

async function listenWithApp(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  assert.equal(address.address, '127.0.0.1');
  assert.notEqual(address.port, 3004);
  assert.notEqual(address.port, 3014);
  assert.notEqual(address.port, 3023);

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function withServer(app, callback) {
  const { server, baseUrl } = await listenWithApp(app);

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test('GET /health returns the compatible safe health contract', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Accept: 'application/json' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'lia-agent-backend');
    assert.equal(body.mode, 'read_only_foundation');
    assert.equal(typeof body.version, 'string');
    assert.equal(body.realActionsEnabled, false);
    assert.equal(body.voiceEnabled, false);
    assert.equal(body.whatsappEnabled, false);
    assert.equal(body.memoryWriteEnabled, false);
    assert.equal(body.externalModelsEnabled, false);
    assert.equal(body.transport, 'local_http_only');
    assert.equal(body.frontendConnected, false);
    assert.equal(body.secretsLoaded, false);
  });
});

test('POST /health returns deterministic 405 JSON with Allow', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { method: 'POST' });
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(body.ok, false);
    assert.equal(body.error, 'method_not_allowed');
    assert.deepEqual(body.allowedMethods, ['GET']);
  });
});

test('GET /api/status returns safe disabled capabilities', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: { Accept: 'application/json' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'lia-agent-backend');
    assert.equal(body.status, 'online');
    assert.equal(body.hostBinding, 'local_loopback_only');
    assert.equal(body.mode, 'read_only_foundation');
    assert.equal(body.transport, 'local_http_only');
    assert.equal(body.integrations, 'disabled');

    for (const capability of [
      'memoryWrite',
      'externalModels',
      'voice',
      'whatsapp',
      'email',
      'documentActions',
      'realActions',
    ]) {
      assert.equal(body.capabilities[capability].enabled, false);
      assert.equal(body.capabilities[capability].status, 'disabled');
    }
  });
});

test('POST /api/status returns deterministic 405 JSON with Allow', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/status`, { method: 'POST' });
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(body.ok, false);
    assert.equal(body.error, 'method_not_allowed');
    assert.deepEqual(body.allowedMethods, ['GET']);
  });
});

test('unknown routes return deterministic 404 JSON', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missing-route`, {
      headers: { Accept: 'application/json' },
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type').includes('application/json'), true);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not_found');
    assert.equal(body.path, '/missing-route');
    assert.equal('stack' in body, false);
  });
});

test('CORS is absent by default', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://not-allowed.example' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});

test('CORS is emitted only for an allowlisted origin', async () => {
  const app = createApp(loadConfig({ LIA_AGENT_CORS_ORIGINS: 'http://allowed.example' }));

  await withServer(app, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://allowed.example' },
    });
    const denied = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://denied.example' },
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://allowed.example');
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});

test('invalid port configuration is rejected', () => {
  assert.throws(() => loadConfig({ LIA_AGENT_PORT: '0' }), /invalid_lia_agent_port/);
  assert.throws(() => loadConfig({ LIA_AGENT_PORT: '65536' }), /invalid_lia_agent_port/);
  assert.throws(() => loadConfig({ LIA_AGENT_PORT: 'not-a-port' }), /invalid_lia_agent_port/);
});

test('non-loopback host configuration is rejected', () => {
  assert.throws(() => loadConfig({ LIA_AGENT_HOST: '0.0.0.0' }), /invalid_lia_agent_host/);
});


test('GET /api/hermes/status is fail-closed when Hermes is not configured', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.integration, 'hermes');
    assert.equal(body.mode, 'read_only_adapter_foundation');
    assert.equal(body.configured, false);
    assert.equal(body.runtimeDetected, false);
    assert.equal(body.state, 'unconfigured');
    assert.equal(body.executionEnabled, false);
    assert.equal(body.toolsEnabled, false);
    assert.equal(body.memoryWriteEnabled, false);
    assert.equal(body.handoffEnabled, false);
    assert.equal(body.multiplexEnabled, false);
    assert.equal(body.isolationStrategy, 'one_process_per_tenant');
  });
});

test('GET /api/hermes/status reports guarded prompt execution when enabled', async () => {
  const hermesRoot = await mkdtemp(join(tmpdir(), 'lia-hermes-runtime-'));
  const markers = [
    'run_agent.py',
    'hermes_state.py',
    'tools/registry.py',
    'gateway/run.py',
  ];

  try {
    for (const marker of markers) {
      const path = join(hermesRoot, marker);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '# test marker\n', 'utf8');
    }

    const app = createApp(loadConfig({
      LIA_HERMES_ROOT: hermesRoot,
      LIA_HERMES_EXECUTION_ENABLED: 'true',
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/hermes/status`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.configured, true);
      assert.equal(body.runtimeDetected, true);
      assert.equal(body.state, 'available');
      assert.equal(body.requiredMarkers, 4);
      assert.equal(body.detectedMarkers, 4);
      assert.equal(body.mode, 'guarded_prompt_execution');
      assert.equal(body.executionEnabled, true);
      assert.equal(body.toolsEnabled, false);
      assert.equal(body.memoryWriteEnabled, false);
      assert.equal('hermesRoot' in body, false);
    });
  } finally {
    await rm(hermesRoot, { recursive: true, force: true });
  }
});

test('GET /api/hermes/contracts exposes the disabled integration boundary', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/contracts`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.integration, 'hermes');
    assert.equal(body.adapterMode, 'external_process_boundary');
    assert.equal(body.tenantIsolation, 'one_process_per_tenant');
    assert.equal(body.failClosed, true);
    assert.equal(body.directDatabaseAccess, false);
    assert.equal(body.secretsInherited, false);
    assert.equal(body.pluginAllowlistRequired, true);
    assert.equal(body.capabilities.runtimeProbe, true);
    assert.equal(body.capabilities.promptExecution, false);
    assert.equal(body.capabilities.toolExecution, false);
    assert.equal(body.capabilities.memoryWrite, false);
    assert.equal(body.capabilities.channelDelivery, false);
  });
});


test('GET /api/hermes/contracts reports prompt execution when enabled', async () => {
  const app = createApp(loadConfig({
    LIA_HERMES_EXECUTION_ENABLED: 'true',
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/contracts`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.capabilities.runtimeProbe, true);
    assert.equal(body.capabilities.promptExecution, true);
    assert.equal(body.capabilities.toolExecution, false);
    assert.equal(body.capabilities.memoryWrite, false);
    assert.equal(body.capabilities.channelDelivery, false);
  });
});

test('POST /api/hermes/status returns deterministic 405 JSON', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/status`, { method: 'POST' });
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(body.error, 'method_not_allowed');
  });
});

test('relative Hermes root configuration is rejected', () => {
  assert.throws(
    () => loadConfig({ LIA_HERMES_ROOT: './hermes-agent' }),
    /invalid_lia_hermes_root/,
  );
});


test('POST /api/hermes/query is disabled by default', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Hola' }),
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'execution_disabled');
  });
});

test('POST /api/hermes/query rejects missing and oversized queries', async () => {
  const app = createApp(loadConfig({ LIA_HERMES_MAX_QUERY_CHARACTERS: '5' }));

  await withServer(app, async (baseUrl) => {
    for (const payload of [{}, { query: '' }, { query: '123456' }]) {
      const response = await fetch(`${baseUrl}/api/hermes/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.equal(body.error, 'invalid_query');
      assert.equal(body.maxCharacters, 5);
    }
  });
});

test('GET /api/hermes/query returns deterministic 405 JSON', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/query`);
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.equal(body.error, 'method_not_allowed');
  });
});

test('invalid Hermes execution limits are rejected', () => {
  assert.throws(
    () => loadConfig({ LIA_HERMES_TIMEOUT_MS: '0' }),
    /invalid_lia_hermes_timeout/,
  );
  assert.throws(
    () => loadConfig({ LIA_HERMES_MAX_QUERY_CHARACTERS: 'abc' }),
    /invalid_lia_hermes_max_query_characters/,
  );
});
