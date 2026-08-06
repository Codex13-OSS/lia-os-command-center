import assert from 'node:assert/strict';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { readSafeAgendaContext } from '../dist/services/agendaContextReader.js';
import { initializeAgendaSqliteDatabaseV1 } from '../dist/services/agendaSqliteBootstrap.js';
import { createAgendaSqliteReadSource } from '../dist/services/agendaSqliteReadSource.js';
import {
  AGENDA_SQLITE_SCHEMA_VERSION,
  createAgendaSqliteSchemaV1Sql,
} from '../dist/services/agendaSqliteSchema.js';
import { createProjectTaskSafetyPolicy } from '../dist/contracts/projectExecutor.js';
import { validateProjectTaskRequest } from '../dist/contracts/projectExecutorValidation.js';
import {
  createStaticProjectRegistry,
  resolveAuthorizedProject,
} from '../dist/services/projectRegistry.js';
import { createProjectRegistryFileSource } from '../dist/services/projectRegistryFileSource.js';
import { planProjectTask } from '../dist/services/projectExecutionPlanner.js';
import {
  buildProjectOrchestrationPrompt,
  buildProjectOrchestrationRepairPrompt,
} from '../dist/services/projectOrchestrationPrompt.js';
import { orchestrateProjectTask } from '../dist/services/projectOrchestrationService.js';
import {
  buildHermesReasoningInvocation,
  createHermesReasoningOnlyExecutor,
} from '../dist/services/hermesReasoningExecutor.js';
import { validateProjectOrchestrationProposal } from '../dist/services/projectOrchestrationValidation.js';
import { buildProjectCodexHandoff } from '../dist/services/projectCodexHandoff.js';

function createPermissiveAgendaSqliteTables(database, {
  schemaVersion = AGENDA_SQLITE_SCHEMA_VERSION,
  timezone = 'America/Mexico_City',
} = {}) {
  database.exec(`
    CREATE TABLE agenda_state (
      singleton,
      schema_version,
      global_revision,
      timezone,
      updated_at
    );
    CREATE TABLE agenda_events (
      id TEXT PRIMARY KEY,
      start_time TEXT NOT NULL,
      payload_json
    )
  `);
  database.prepare(`
    INSERT INTO agenda_state (
      singleton,
      schema_version,
      global_revision,
      timezone,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(1, schemaVersion, 0, timezone, '2026-08-02T00:00:00.000Z');
}

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

test('missing or blank Agenda SQLite path configuration resolves to empty string', () => {
  assert.equal(loadConfig({}).agendaSqlitePath, '');
  assert.equal(loadConfig({ LIA_AGENDA_SQLITE_PATH: '   ' }).agendaSqlitePath, '');
});

test('absolute Agenda SQLite path configuration is accepted after trimming', () => {
  assert.equal(
    loadConfig({ LIA_AGENDA_SQLITE_PATH: '  /var/lib/lia/agenda.sqlite  ' }).agendaSqlitePath,
    '/var/lib/lia/agenda.sqlite',
  );
});

test('relative or NUL-containing Agenda SQLite path configuration is rejected', () => {
  for (const agendaSqlitePath of ['./agenda.sqlite', '/var/lib/lia/agenda\0.sqlite']) {
    assert.throws(
      () => loadConfig({ LIA_AGENDA_SQLITE_PATH: agendaSqlitePath }),
      (error) => error instanceof Error && error.message === 'invalid_lia_agenda_sqlite_path',
    );
  }
});

test('missing or blank project registry path configuration resolves to empty string', () => {
  assert.equal(loadConfig({}).projectRegistryPath, '');
  assert.equal(loadConfig({ LIA_PROJECT_REGISTRY_PATH: '   ' }).projectRegistryPath, '');
});

test('absolute project registry path configuration is accepted after trimming', () => {
  assert.equal(
    loadConfig({ LIA_PROJECT_REGISTRY_PATH: '  /etc/lia/projects.json  ' }).projectRegistryPath,
    '/etc/lia/projects.json',
  );
});

test('relative or NUL-containing project registry path configuration is rejected', () => {
  for (const projectRegistryPath of ['./projects.json', '/etc/lia/projects\0.json']) {
    assert.throws(
      () => loadConfig({ LIA_PROJECT_REGISTRY_PATH: projectRegistryPath }),
      (error) => error instanceof Error && error.message === 'invalid_lia_project_registry_path',
    );
  }
});

test('missing or blank project verification path configuration resolves to empty string', () => {
  assert.equal(loadConfig({}).projectVerificationPath, '');
  assert.equal(loadConfig({ LIA_PROJECT_VERIFICATION_PATH: '   ' }).projectVerificationPath, '');
});

test('absolute project verification path configuration is accepted after trimming', () => {
  assert.equal(
    loadConfig({ LIA_PROJECT_VERIFICATION_PATH: '  /etc/lia/verification.json  ' }).projectVerificationPath,
    '/etc/lia/verification.json',
  );
});

test('relative or NUL-containing project verification path configuration is rejected', () => {
  for (const projectVerificationPath of ['./verification.json', '/etc/lia/verification\0.json']) {
    assert.throws(
      () => loadConfig({ LIA_PROJECT_VERIFICATION_PATH: projectVerificationPath }),
      (error) => error instanceof Error && error.message === 'invalid_lia_project_verification_path',
    );
  }
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

test('GET /api/agenda/context returns safe unconfigured read-only context by default', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agenda/context`, {
      headers: { Accept: 'application/json' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'lia-agent-backend');
    assert.equal(body.integration, 'agenda');
    assert.equal(body.mode, 'read_only');
    assert.equal(body.state, 'unconfigured');
    assert.equal(body.timezone, 'America/Mexico_City');
    assert.equal(body.readOnly, true);
    assert.equal(body.realActionsEnabled, false);
    assert.equal(body.hermesDirectAccess, false);
    assert.equal(body.sourceOfTruth, 'lia');
    assert.equal(body.eventCount, 0);
    assert.deepEqual(body.events, []);
  });
});

test('POST /api/agenda/context returns deterministic 405 JSON with Allow', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agenda/context`, {
      method: 'POST',
    });
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(body.ok, false);
    assert.equal(body.error, 'method_not_allowed');
    assert.deepEqual(body.allowedMethods, ['GET']);
  });
});

test('Agenda read source can provide available events without gaining write authority', async () => {
  const source = {
    async read() {
      return {
        state: 'available',
        timezone: 'America/Mexico_City',
        events: [
          {
            id: 'agenda-test-001',
            title: 'Revisión ejecutiva',
            startTime: '2026-08-03T15:00:00.000Z',
            endTime: '2026-08-03T15:30:00.000Z',
            timezone: 'America/Mexico_City',
            mode: 'virtual',
            priority: 'high',
            status: 'confirmed',
            attendees: [],
            responsible: { name: 'Dirección' },
            preparationMinutes: 10,
            parkingMinutes: 0,
            walkingMinutes: 0,
            followUpRequired: true,
            recurrence: { frequency: 'none' },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            source: 'external',
          },
        ],
        realActionsEnabled: true,
        hermesDirectAccess: true,
      };
    },
  };

  const app = createApp(loadConfig({}), { agendaReadSource: source });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agenda/context`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.state, 'available');
    assert.equal(body.eventCount, 1);
    assert.equal(body.events[0].id, 'agenda-test-001');
    assert.equal(body.events[0].title, 'Revisión ejecutiva');

    assert.equal(body.mode, 'read_only');
    assert.equal(body.readOnly, true);
    assert.equal(body.realActionsEnabled, false);
    assert.equal(body.hermesDirectAccess, false);
    assert.equal(body.sourceOfTruth, 'lia');
  });
});

test('Agenda read source failure degrades safely without leaking errors or stale events', async () => {
  const source = {
    async read() {
      throw new Error('SHOULD_NOT_LEAK_AGENDA_SOURCE_FAILURE');
    },
  };

  const app = createApp(loadConfig({}), { agendaReadSource: source });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agenda/context`);
    const rawBody = await response.text();
    const body = JSON.parse(rawBody);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.integration, 'agenda');
    assert.equal(body.mode, 'read_only');
    assert.equal(body.state, 'unavailable');
    assert.equal(body.readOnly, true);
    assert.equal(body.realActionsEnabled, false);
    assert.equal(body.hermesDirectAccess, false);
    assert.equal(body.sourceOfTruth, 'lia');
    assert.equal(body.eventCount, 0);
    assert.deepEqual(body.events, []);
    assert.equal(rawBody.includes('SHOULD_NOT_LEAK_AGENDA_SOURCE_FAILURE'), false);
  });
});

test('Agenda rejects invalid source payloads before they enter LIA context', async () => {
  const source = {
    async read() {
      return {
        state: 'available',
        timezone: 'Invalid/Timezone',
        events: [
          {
            id: 'bad-event',
            title: 'Evento corrupto',
            startTime: '2026-08-03T16:00:00.000Z',
            endTime: '2026-08-03T15:00:00.000Z',
            timezone: 'America/Mexico_City',
            mode: 'virtual',
            priority: 'high',
            status: 'confirmed',
            attendees: [],
            responsible: { name: 'Dirección' },
            preparationMinutes: 0,
            parkingMinutes: 0,
            walkingMinutes: 0,
            followUpRequired: false,
            recurrence: { frequency: 'none' },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            source: 'seed',
          },
        ],
      };
    },
  };

  const app = createApp(loadConfig({}), { agendaReadSource: source });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agenda/context`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.state, 'unavailable');
    assert.equal(body.eventCount, 0);
    assert.deepEqual(body.events, []);
    assert.equal(body.readOnly, true);
    assert.equal(body.realActionsEnabled, false);
    assert.equal(body.hermesDirectAccess, false);
  });
});

test('Agenda normalizes safe recurrence fields from a valid source', async () => {
  const source = {
    async read() {
      return {
        state: 'available',
        timezone: 'America/Mexico_City',
        events: [
          {
            id: 'recurring-001',
            title: 'Seguimiento semanal',
            startTime: '2026-08-03T15:00:00.000Z',
            endTime: '2026-08-03T15:30:00.000Z',
            timezone: 'America/Mexico_City',
            mode: 'virtual',
            priority: 'medium',
            status: 'confirmed',
            attendees: [],
            responsible: { name: 'Dirección' },
            preparationMinutes: 5,
            parkingMinutes: 0,
            walkingMinutes: 0,
            followUpRequired: true,
            recurrence: {
              frequency: 'weekly',
              interval: 1,
              byWeekday: [3, 1, 3],
              exceptions: ['2026-08-17', '2026-08-10', '2026-08-17'],
            },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            source: 'external',
          },
        ],
      };
    },
  };

  const app = createApp(loadConfig({}), { agendaReadSource: source });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agenda/context`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.state, 'available');
    assert.equal(body.eventCount, 1);
    assert.deepEqual(body.events[0].recurrence.byWeekday, [1, 3]);
    assert.deepEqual(
      body.events[0].recurrence.exceptions,
      ['2026-08-10', '2026-08-17'],
    );
  });
});

test('SQLite agenda source returns valid events in deterministic read-only order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-sqlite-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const database = new DatabaseSync(databasePath);
  const event = (id, title, startTime) => ({
    id,
    title,
    startTime,
    endTime: '2026-08-03T16:30:00.000Z',
    timezone: 'America/Mexico_City',
    mode: 'virtual',
    priority: 'medium',
    status: 'confirmed',
    attendees: [],
    responsible: { name: 'Dirección' },
    preparationMinutes: 0,
    parkingMinutes: 0,
    walkingMinutes: 0,
    followUpRequired: false,
    recurrence: { frequency: 'none' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    source: 'local',
  });

  try {
    createPermissiveAgendaSqliteTables(database, { timezone: 'Etc/UTC' });
    const insert = database.prepare(
      'INSERT INTO agenda_events (id, start_time, payload_json) VALUES (?, ?, ?)',
    );
    insert.run('event-b', '2026-08-03T15:00:00.000Z', JSON.stringify(
      event('event-b', 'Segundo por ID', '2026-08-03T15:00:00.000Z'),
    ));
    insert.run('event-a', '2026-08-03T15:00:00.000Z', JSON.stringify(
      event('event-a', 'Primero por ID', '2026-08-03T15:00:00.000Z'),
    ));
    database.close();

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );

    assert.equal(snapshot.state, 'available');
    assert.equal(snapshot.timezone, 'Etc/UTC');
    assert.equal(snapshot.eventCount, 2);
    assert.deepEqual(snapshot.events.map(({ id }) => id), ['event-a', 'event-b']);
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.sourceOfTruth, 'lia');
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite agenda source excludes seed events while returning local events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-sqlite-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const database = new DatabaseSync(databasePath);
  const event = (id, title, startTime, source) => ({
    id,
    title,
    startTime,
    endTime: '2026-08-03T16:30:00.000Z',
    timezone: 'America/Mexico_City',
    mode: 'virtual',
    priority: 'medium',
    status: 'confirmed',
    attendees: [],
    responsible: { name: 'Dirección' },
    preparationMinutes: 0,
    parkingMinutes: 0,
    walkingMinutes: 0,
    followUpRequired: false,
    recurrence: { frequency: 'none' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    source,
  });

  try {
    createPermissiveAgendaSqliteTables(database);
    const insert = database.prepare(
      'INSERT INTO agenda_events (id, start_time, payload_json) VALUES (?, ?, ?)',
    );
    const seedEvent = event(
      'event-seed',
      'Evento de demostración',
      '2026-08-03T15:00:00.000Z',
      'seed',
    );
    const localEvent = event(
      'event-local',
      'Evento local',
      '2026-08-03T16:00:00.000Z',
      'local',
    );
    insert.run(seedEvent.id, seedEvent.startTime, JSON.stringify(seedEvent));
    insert.run(localEvent.id, localEvent.startTime, JSON.stringify(localEvent));
    database.close();

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );

    assert.equal(snapshot.state, 'available');
    assert.equal(snapshot.eventCount, 1);
    assert.deepEqual(snapshot.events.map(({ id }) => id), ['event-local']);
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite agenda source leaves unknown sources for validation to reject', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-sqlite-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const database = new DatabaseSync(databasePath);
  const event = {
    id: 'event-unexpected-source',
    title: 'Evento con fuente desconocida',
    startTime: '2026-08-03T15:00:00.000Z',
    endTime: '2026-08-03T15:30:00.000Z',
    timezone: 'America/Mexico_City',
    mode: 'virtual',
    priority: 'medium',
    status: 'confirmed',
    attendees: [],
    responsible: { name: 'Dirección' },
    preparationMinutes: 0,
    parkingMinutes: 0,
    walkingMinutes: 0,
    followUpRequired: false,
    recurrence: { frequency: 'none' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    source: 'unexpected',
  };

  try {
    createPermissiveAgendaSqliteTables(database);
    database.prepare(
      'INSERT INTO agenda_events (id, start_time, payload_json) VALUES (?, ?, ?)',
    ).run(event.id, event.startTime, JSON.stringify(event));
    database.close();

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );

    assert.equal(snapshot.state, 'unavailable');
    assert.equal(snapshot.eventCount, 0);
    assert.deepEqual(snapshot.events, []);
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite agenda source corrupt JSON fails closed without events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-sqlite-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const database = new DatabaseSync(databasePath);

  try {
    createPermissiveAgendaSqliteTables(database);
    database.prepare(`
      INSERT INTO agenda_events (id, start_time, payload_json)
      VALUES ('corrupt', '2026-08-03T15:00:00.000Z', '{not-json')
    `).run();
    database.close();

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );

    assert.equal(snapshot.state, 'unavailable');
    assert.equal(snapshot.eventCount, 0);
    assert.deepEqual(snapshot.events, []);
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite agenda source fails closed when row id differs from payload event id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-sqlite-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const database = new DatabaseSync(databasePath);
  const event = {
    id: 'payload-id',
    title: 'Metadata inconsistente',
    startTime: '2026-08-03T15:00:00.000Z',
    endTime: '2026-08-03T15:30:00.000Z',
    timezone: 'America/Mexico_City',
    mode: 'virtual',
    priority: 'medium',
    status: 'confirmed',
    attendees: [],
    responsible: { name: 'Dirección' },
    preparationMinutes: 0,
    parkingMinutes: 0,
    walkingMinutes: 0,
    followUpRequired: false,
    recurrence: { frequency: 'none' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    source: 'local',
  };

  try {
    createPermissiveAgendaSqliteTables(database);
    database.prepare(
      'INSERT INTO agenda_events (id, start_time, payload_json) VALUES (?, ?, ?)',
    ).run('row-id', event.startTime, JSON.stringify(event));
    database.close();

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );

    assert.equal(snapshot.state, 'unavailable');
    assert.equal(snapshot.eventCount, 0);
    assert.deepEqual(snapshot.events, []);
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite agenda source fails closed when row start time differs from payload event start time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-sqlite-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const database = new DatabaseSync(databasePath);
  const event = {
    id: 'event-start-time-mismatch',
    title: 'Metadata inconsistente',
    startTime: '2026-08-03T15:00:00.000Z',
    endTime: '2026-08-03T15:30:00.000Z',
    timezone: 'America/Mexico_City',
    mode: 'virtual',
    priority: 'medium',
    status: 'confirmed',
    attendees: [],
    responsible: { name: 'Dirección' },
    preparationMinutes: 0,
    parkingMinutes: 0,
    walkingMinutes: 0,
    followUpRequired: false,
    recurrence: { frequency: 'none' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    source: 'local',
  };

  try {
    createPermissiveAgendaSqliteTables(database);
    database.prepare(
      'INSERT INTO agenda_events (id, start_time, payload_json) VALUES (?, ?, ?)',
    ).run(event.id, '2026-08-03T16:00:00.000Z', JSON.stringify(event));
    database.close();

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );

    assert.equal(snapshot.state, 'unavailable');
    assert.equal(snapshot.eventCount, 0);
    assert.deepEqual(snapshot.events, []);
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite agenda source fails closed when agenda_state is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-sqlite-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const database = new DatabaseSync(databasePath);

  try {
    database.exec(`
      CREATE TABLE agenda_events (
        id TEXT PRIMARY KEY,
        start_time TEXT NOT NULL,
        payload_json
      )
    `);
    database.prepare(`
      INSERT INTO agenda_events (id, start_time, payload_json)
      VALUES ('event-without-state', '2026-08-03T15:00:00.000Z', '{}')
    `).run();
    database.close();

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );

    assert.equal(snapshot.state, 'unavailable');
    assert.equal(snapshot.eventCount, 0);
    assert.deepEqual(snapshot.events, []);
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite agenda source fails closed for an incompatible schema version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-sqlite-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const database = new DatabaseSync(databasePath);

  try {
    createPermissiveAgendaSqliteTables(database, { schemaVersion: 2 });
    database.close();

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );

    assert.equal(snapshot.state, 'unavailable');
    assert.equal(snapshot.eventCount, 0);
    assert.deepEqual(snapshot.events, []);
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite agenda source rejects relative database paths', () => {
  assert.throws(
    () => createAgendaSqliteReadSource('./agenda.sqlite'),
    /invalid_agenda_sqlite_path/,
  );
});

test('Agenda SQLite bootstrap creates a valid new database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-bootstrap-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const initializedAt = '2026-08-02T12:34:56.000Z';
  let database;

  try {
    initializeAgendaSqliteDatabaseV1(databasePath, initializedAt);

    database = new DatabaseSync(databasePath, { readOnly: true });
    const state = database.prepare(`
      SELECT singleton, schema_version, global_revision, timezone, updated_at
      FROM agenda_state
    `).get();
    const eventCount = database.prepare(
      'SELECT COUNT(*) AS count FROM agenda_events',
    ).get().count;

    assert.deepEqual({ ...state }, {
      singleton: 1,
      schema_version: 1,
      global_revision: 0,
      timezone: 'America/Mexico_City',
      updated_at: initializedAt,
    });
    assert.equal(eventCount, 0);
    database.close();
    database = undefined;

    const snapshot = await readSafeAgendaContext(
      createAgendaSqliteReadSource(databasePath),
    );
    assert.equal(snapshot.state, 'available');
    assert.equal(snapshot.eventCount, 0);
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  } finally {
    if (database?.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Agenda SQLite bootstrap preserves an existing database path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-bootstrap-'));
  const databasePath = join(directory, 'agenda.sqlite');
  const sentinel = Buffer.from('existing-agenda-sentinel\n');

  try {
    await writeFile(databasePath, sentinel);

    assert.throws(
      () => initializeAgendaSqliteDatabaseV1(
        databasePath,
        '2026-08-02T12:34:56.000Z',
      ),
      (error) => error instanceof Error && error.message === 'agenda_sqlite_already_exists',
    );
    assert.deepEqual(await readFile(databasePath), sentinel);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Agenda SQLite bootstrap removes its file after invalid initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-bootstrap-'));
  const databasePath = join(directory, 'agenda.sqlite');

  try {
    assert.throws(
      () => initializeAgendaSqliteDatabaseV1(
        databasePath,
        '2026-02-31T12:34:56.000Z',
      ),
      (error) => error instanceof Error && error.message === 'invalid_agenda_initialized_at',
    );
    await assert.rejects(stat(databasePath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Agenda SQLite Schema v1 initializes its singleton state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-schema-'));
  const database = new DatabaseSync(join(directory, 'agenda.sqlite'));
  const initializedAt = '2026-08-02T12:34:56.000Z';

  try {
    assert.throws(
      () => createAgendaSqliteSchemaV1Sql('2026-02-31T12:34:56.000Z'),
      /invalid_agenda_initialized_at/,
    );

    database.exec(createAgendaSqliteSchemaV1Sql(initializedAt));

    const state = database.prepare(`
      SELECT singleton, schema_version, global_revision, timezone, updated_at
      FROM agenda_state
    `).get();

    assert.deepEqual({ ...state }, {
      singleton: 1,
      schema_version: AGENDA_SQLITE_SCHEMA_VERSION,
      global_revision: 0,
      timezone: 'America/Mexico_City',
      updated_at: initializedAt,
    });
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agenda SQLite Schema v1 accepts an event with source='local'", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-schema-'));
  const database = new DatabaseSync(join(directory, 'agenda.sqlite'));
  const event = {
    id: 'agenda-local-001',
    startTime: '2026-08-03T15:00:00.000Z',
    source: 'local',
  };

  try {
    database.exec(createAgendaSqliteSchemaV1Sql('2026-08-02T00:00:00.000Z'));
    database.prepare(`
      INSERT INTO agenda_events (id, start_time, payload_json)
      VALUES (?, ?, ?)
    `).run(event.id, event.startTime, JSON.stringify(event));

    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM agenda_events').get().count,
      1,
    );
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agenda SQLite Schema v1 rejects an event with source='seed'", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-schema-'));
  const database = new DatabaseSync(join(directory, 'agenda.sqlite'));
  const event = {
    id: 'agenda-seed-001',
    startTime: '2026-08-03T15:00:00.000Z',
    source: 'seed',
  };

  try {
    database.exec(createAgendaSqliteSchemaV1Sql('2026-08-02T00:00:00.000Z'));
    const insert = database.prepare(`
      INSERT INTO agenda_events (id, start_time, payload_json)
      VALUES (?, ?, ?)
    `);

    assert.throws(() => insert.run(event.id, event.startTime, JSON.stringify(event)));
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Agenda SQLite Schema v1 rejects mismatched event metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-agenda-schema-'));
  const database = new DatabaseSync(join(directory, 'agenda.sqlite'));
  const insertSql = `
    INSERT INTO agenda_events (id, start_time, payload_json)
    VALUES (?, ?, ?)
  `;

  try {
    database.exec(createAgendaSqliteSchemaV1Sql('2026-08-02T00:00:00.000Z'));
    const insert = database.prepare(insertSql);

    assert.throws(() => insert.run(
      'agenda-column-id',
      '2026-08-03T15:00:00.000Z',
      JSON.stringify({
        id: 'agenda-payload-id',
        startTime: '2026-08-03T15:00:00.000Z',
        source: 'local',
      }),
    ));
    assert.throws(() => insert.run(
      'agenda-matching-id',
      '2026-08-03T15:00:00.000Z',
      JSON.stringify({
        id: 'agenda-matching-id',
        startTime: '2026-08-03T16:00:00.000Z',
        source: 'local',
      }),
    ));
  } finally {
    if (database.isOpen) {
      database.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Hermes query executor can be injected without changing the public API contract', async () => {
  const calls = [];
  const executor = async (config, query) => {
    calls.push({
      executionEnabled: config.hermesExecutionEnabled,
      query,
    });

    return {
      ok: true,
      response: 'RESPUESTA_HERMES_SIMULADA',
    };
  };

  const app = createApp(
    loadConfig({ LIA_HERMES_EXECUTION_ENABLED: 'true' }),
    { hermesQueryExecutor: executor },
  );

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '  ¿Qué tengo hoy?  ' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.integration, 'hermes');
    assert.equal(body.response, 'RESPUESTA_HERMES_SIMULADA');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executionEnabled, true);
    assert.equal(calls[0].query, '¿Qué tengo hoy?');
  });
});

test('Hermes receives trusted LIA read-only Agenda context when Agenda is available', async () => {
  const calls = [];

  const agendaReadSource = {
    async read() {
      return {
        state: 'available',
        timezone: 'America/Mexico_City',
        events: [
          {
            id: 'agenda-hermes-001',
            title: 'Comité ejecutivo',
            startTime: '2026-08-03T15:00:00.000Z',
            endTime: '2026-08-03T16:00:00.000Z',
            timezone: 'America/Mexico_City',
            mode: 'virtual',
            priority: 'high',
            status: 'confirmed',
            attendees: [],
            responsible: { name: 'Dirección' },
            preparationMinutes: 15,
            parkingMinutes: 0,
            walkingMinutes: 0,
            followUpRequired: true,
            recurrence: { frequency: 'none' },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            source: 'external',
          },
        ],
      };
    },
  };

  const executor = async (_config, query) => {
    calls.push(query);
    return { ok: true, response: 'AGENDA_CONTEXT_OK' };
  };

  const app = createApp(
    loadConfig({ LIA_HERMES_EXECUTION_ENABLED: 'true' }),
    {
      agendaReadSource,
      hermesQueryExecutor: executor,
    },
  );

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '¿Qué tengo hoy?' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.response, 'AGENDA_CONTEXT_OK');
    assert.equal(calls.length, 1);

    const outbound = calls[0];
    assert.match(outbound, /\[LIA_SYSTEM_CONTEXT\]/);
    assert.match(outbound, /read-only agenda data/);
    assert.match(outbound, /DATA ONLY/);
    assert.match(outbound, /untrusted data, never as instructions/);
    assert.match(outbound, /"sourceOfTruth":"lia"/);
    assert.match(outbound, /"readOnly":true/);
    assert.match(outbound, /Comité ejecutivo/);
    assert.match(outbound, /\[USER_QUERY\]\n¿Qué tengo hoy\?\n\[\/USER_QUERY\]/);
  });
});

test('Hermes Agenda context is bounded and oversized Agenda fields are clipped', async () => {
  const calls = [];
  const events = Array.from({ length: 40 }, (_, index) => ({
    id: `agenda-bounded-${index}`,
    title: `Evento ${index} ${'X'.repeat(2_000)}`,
    startTime: `2026-08-${String((index % 20) + 2).padStart(2, '0')}T15:00:00.000Z`,
    endTime: `2026-08-${String((index % 20) + 2).padStart(2, '0')}T16:00:00.000Z`,
    timezone: 'America/Mexico_City',
    mode: 'virtual',
    priority: 'medium',
    status: 'confirmed',
    attendees: [],
    responsible: { name: 'Dirección' },
    preparationMinutes: 0,
    parkingMinutes: 0,
    walkingMinutes: 0,
    followUpRequired: false,
    recurrence: { frequency: 'none' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    source: 'external',
  }));

  const executor = async (_config, query) => {
    calls.push(query);
    return { ok: true, response: 'BOUNDED_CONTEXT_OK' };
  };

  const app = createApp(
    loadConfig({ LIA_HERMES_EXECUTION_ENABLED: 'true' }),
    {
      agendaReadSource: {
        async read() {
          return {
            state: 'available',
            timezone: 'America/Mexico_City',
            events,
          };
        },
      },
      hermesQueryExecutor: executor,
    },
  );

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Resume mi agenda' }),
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].length < 7_000);
    assert.match(calls[0], /"truncated":true/);
    assert.doesNotMatch(calls[0], /X{500}/);
  });
});

test('Hermes outbound prompt preserves the full user query and enforces a total character budget', async () => {
  const calls = [];
  const userQuery = 'Q'.repeat(8_000);
  const events = Array.from({ length: 20 }, (_, index) => ({
    id: `agenda-total-budget-${index}`,
    title: `Evento ${index} ${'Y'.repeat(1_500)}`,
    startTime: `2026-08-${String((index % 20) + 2).padStart(2, '0')}T15:00:00.000Z`,
    endTime: `2026-08-${String((index % 20) + 2).padStart(2, '0')}T16:00:00.000Z`,
    timezone: 'America/Mexico_City',
    mode: 'virtual',
    priority: 'medium',
    status: 'confirmed',
    attendees: [],
    responsible: { name: 'Dirección' },
    preparationMinutes: 0,
    parkingMinutes: 0,
    walkingMinutes: 0,
    followUpRequired: false,
    recurrence: { frequency: 'none' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    source: 'external',
  }));

  const executor = async (_config, query) => {
    calls.push(query);
    return { ok: true, response: 'TOTAL_BUDGET_OK' };
  };

  const app = createApp(
    loadConfig({ LIA_HERMES_EXECUTION_ENABLED: 'true' }),
    {
      agendaReadSource: {
        async read() {
          return {
            state: 'available',
            timezone: 'America/Mexico_City',
            events,
          };
        },
      },
      hermesQueryExecutor: executor,
    },
  );

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hermes/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: userQuery }),
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].length <= 12_000);
    assert.ok(calls[0].includes(userQuery));
    assert.match(calls[0], /"truncated":true/);
  });
});

test('project task request validation normalizes a valid request and deduplicates capabilities', () => {
  const result = validateProjectTaskRequest({
    projectId: '  lia.backend_v1  ',
    instruction: '  Implementa el contrato seguro  ',
    priority: 'high',
    requestedCapabilities: ['run_tests', 'repository_read', 'run_tests', 'local_commit'],
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.request, {
    projectId: 'lia.backend_v1',
    instruction: 'Implementa el contrato seguro',
    priority: 'high',
    requestedCapabilities: ['run_tests', 'repository_read', 'local_commit'],
  });
});

test('project task request validation rejects dangerous project identifiers', () => {
  for (const projectId of ['../repo', 'foo/bar']) {
    const result = validateProjectTaskRequest({
      projectId,
      instruction: 'Inspecciona el proyecto',
      priority: 'normal',
      requestedCapabilities: ['repository_read'],
    });

    assert.equal(result.success, false);
    assert.ok(result.errors.some((error) => error.path === 'projectId'));
  }
});

test('project task request validation rejects a blocked capability', () => {
  const result = validateProjectTaskRequest({
    projectId: 'lia-agent',
    instruction: 'Publica los cambios',
    priority: 'critical',
    requestedCapabilities: ['push'],
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.path === 'requestedCapabilities.0'));
});

test('project task request validation rejects unknown top-level fields', () => {
  const result = validateProjectTaskRequest({
    projectId: 'lia-agent',
    instruction: 'Ejecuta una tarea',
    priority: 'normal',
    requestedCapabilities: ['isolated_worktree_write'],
    repositoryPath: '/opt/algo',
    command: 'rm -rf ...',
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.path === 'repositoryPath'));
  assert.ok(result.errors.some((error) => error.path === 'command'));
});

test('project task safety policy is restrictive and returns independent arrays', () => {
  const policy = createProjectTaskSafetyPolicy();

  assert.equal(policy.orchestrator, 'hermes');
  assert.equal(policy.executor, 'codex');
  assert.equal(policy.workspaceIsolation, 'isolated_worktree_only');
  assert.equal(policy.productionAccess, false);
  assert.equal(policy.databaseWriteAccess, false);
  assert.equal(policy.secretAccess, false);
  assert.equal(policy.humanApprovalRequiredForBlockedActions, true);

  policy.allowedCapabilities.push('repository_read');
  policy.blockedCapabilities.pop();

  const freshPolicy = createProjectTaskSafetyPolicy();
  assert.deepEqual(freshPolicy.allowedCapabilities, [
    'repository_read',
    'isolated_worktree_write',
    'run_tests',
    'local_commit',
  ]);
  assert.deepEqual(freshPolicy.blockedCapabilities, [
    'push',
    'merge',
    'deploy',
    'production_write',
    'database_write',
    'secret_access',
  ]);
});

test('static project registry normalizes and resolves an enabled project', async () => {
  const source = createStaticProjectRegistry([
    {
      projectId: '  lia-agent  ',
      displayName: '  LÍA Agent  ',
      repositoryRoot: '  /srv/projects/lia-agent  ',
      enabled: true,
    },
    {
      projectId: 'lia-web',
      displayName: 'LÍA Web',
      repositoryRoot: '/srv/projects/lia-web',
      enabled: false,
    },
  ]);

  assert.deepEqual(await resolveAuthorizedProject('  lia-agent  ', source), {
    ok: true,
    target: {
      projectId: 'lia-agent',
      displayName: 'LÍA Agent',
      repositoryRoot: '/srv/projects/lia-agent',
    },
  });
});

test('project registry reports an unknown project without exposing entries', async () => {
  const source = createStaticProjectRegistry([{
    projectId: 'lia-agent',
    displayName: 'LÍA Agent',
    repositoryRoot: '/srv/projects/lia-agent',
    enabled: true,
  }]);

  assert.deepEqual(await resolveAuthorizedProject('unknown', source), {
    ok: false,
    error: 'project_not_found',
  });
});

test('project registry rejects a disabled project', async () => {
  const source = createStaticProjectRegistry([{
    projectId: 'lia-agent',
    displayName: 'LÍA Agent',
    repositoryRoot: '/srv/projects/lia-agent',
    enabled: false,
  }]);

  assert.deepEqual(await resolveAuthorizedProject('lia-agent', source), {
    ok: false,
    error: 'project_disabled',
  });
});

test('project registry fails closed for unsafe repository roots', async () => {
  for (const repositoryRoot of ['relative/project', '/']) {
    const source = createStaticProjectRegistry([{
      projectId: 'lia-agent',
      displayName: 'LÍA Agent',
      repositoryRoot,
      enabled: true,
    }]);

    assert.deepEqual(await resolveAuthorizedProject('lia-agent', source), {
      ok: false,
      error: 'registry_unavailable',
    });
  }
});

test('duplicate project IDs fail closed and static registry owns its snapshot', async () => {
  const original = [{
    projectId: '  lia-agent  ',
    displayName: '  LÍA Agent  ',
    repositoryRoot: '  /srv/projects/lia-agent  ',
    enabled: true,
  }];
  const stableSource = createStaticProjectRegistry(original);

  original[0].projectId = 'changed';
  original[0].displayName = 'Changed';
  original[0].repositoryRoot = '/changed';
  original[0].enabled = false;
  original.push({
    projectId: 'added',
    displayName: 'Added',
    repositoryRoot: '/added',
    enabled: true,
  });

  assert.deepEqual(await resolveAuthorizedProject('lia-agent', stableSource), {
    ok: true,
    target: {
      projectId: 'lia-agent',
      displayName: 'LÍA Agent',
      repositoryRoot: '/srv/projects/lia-agent',
    },
  });

  const duplicateSource = createStaticProjectRegistry([
    {
      projectId: ' lia-agent ',
      displayName: 'First',
      repositoryRoot: '/first',
      enabled: true,
    },
    {
      projectId: 'lia-agent',
      displayName: 'Second',
      repositoryRoot: '/second',
      enabled: true,
    },
  ]);
  assert.deepEqual(await resolveAuthorizedProject('lia-agent', duplicateSource), {
    ok: false,
    error: 'registry_unavailable',
  });
});

test('file project registry reads and resolves a valid version 1 registry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-registry-'));
  const registryPath = join(directory, 'projects.json');
  try {
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      projects: [{
        projectId: 'test-project',
        displayName: 'Test Project',
        repositoryRoot: '/srv/test-project',
        enabled: true,
      }],
    }));

    const source = createProjectRegistryFileSource(registryPath);
    assert.deepEqual(await resolveAuthorizedProject('test-project', source), {
      ok: true,
      target: {
        projectId: 'test-project',
        displayName: 'Test Project',
        repositoryRoot: '/srv/test-project',
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file project registry rejects unknown fields, invalid versions, and corrupt JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-registry-'));
  const registryPath = join(directory, 'projects.json');
  const source = createProjectRegistryFileSource(registryPath);
  const invalidContents = [
    JSON.stringify({ version: 1, projects: [], secret: 'forbidden' }),
    JSON.stringify({ version: 2, projects: [] }),
    '{"version":1,"projects":[',
  ];

  try {
    for (const contents of invalidContents) {
      await writeFile(registryPath, contents);
      await assert.rejects(source.read());
      assert.deepEqual(await resolveAuthorizedProject('test-project', source), {
        ok: false,
        error: 'registry_unavailable',
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file project registry rejects files larger than 64 KiB before parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-registry-'));
  const registryPath = join(directory, 'projects.json');
  try {
    await writeFile(registryPath, Buffer.alloc((64 * 1024) + 1, 0x20));
    const source = createProjectRegistryFileSource(registryPath);
    await assert.rejects(source.read());
    assert.deepEqual(await resolveAuthorizedProject('test-project', source), {
      ok: false,
      error: 'registry_unavailable',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file project registry rejects duplicate projects and unsafe repository roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-registry-'));
  const registryPath = join(directory, 'projects.json');
  const source = createProjectRegistryFileSource(registryPath);
  const project = {
    projectId: 'test-project',
    displayName: 'Test Project',
    repositoryRoot: '/srv/test-project',
    enabled: true,
  };

  try {
    const invalidProjects = [
      [project, { ...project }],
      [{ ...project, repositoryRoot: 'relative/project' }],
      [{ ...project, repositoryRoot: '/' }],
      [{ ...project, repositoryRoot: '/srv/project\0escape' }],
      [{ ...project, token: 'forbidden' }],
    ];
    for (const projects of invalidProjects) {
      await writeFile(registryPath, JSON.stringify({ version: 1, projects }));
      assert.deepEqual(await resolveAuthorizedProject('test-project', source), {
        ok: false,
        error: 'registry_unavailable',
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file project registry fails closed when the file does not exist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-registry-'));
  try {
    const source = createProjectRegistryFileSource(join(directory, 'missing.json'));
    await assert.rejects(source.read());
    assert.deepEqual(await resolveAuthorizedProject('test-project', source), {
      ok: false,
      error: 'registry_unavailable',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file project registry returns independent copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lia-project-registry-'));
  const registryPath = join(directory, 'projects.json');
  try {
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      projects: [{
        projectId: 'test-project',
        displayName: 'Test Project',
        repositoryRoot: '/srv/test-project',
        enabled: true,
      }],
    }));
    const source = createProjectRegistryFileSource(registryPath);
    const first = await source.read();
    first[0].displayName = 'Mutated';
    first.push({
      projectId: 'injected',
      displayName: 'Injected',
      repositoryRoot: '/injected',
      enabled: true,
    });

    assert.deepEqual(await source.read(), [{
      projectId: 'test-project',
      displayName: 'Test Project',
      repositoryRoot: '/srv/test-project',
      enabled: true,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('project execution planner creates a safe internal plan from the authorized project', async () => {
  const source = createStaticProjectRegistry([{
    projectId: 'lia-agent',
    displayName: 'LÍA Agent',
    repositoryRoot: '/srv/projects/lia-agent',
    enabled: true,
  }]);

  const result = await planProjectTask({
    projectId: ' lia-agent ',
    instruction: ' Implementa la siguiente fase ',
    priority: 'high',
    requestedCapabilities: ['repository_read', 'run_tests'],
  }, source);

  assert.deepEqual(result, {
    ok: true,
    plan: {
      projectId: 'lia-agent',
      projectDisplayName: 'LÍA Agent',
      repositoryRoot: '/srv/projects/lia-agent',
      instruction: 'Implementa la siguiente fase',
      priority: 'high',
      approvedCapabilities: [
        'repository_read',
        'isolated_worktree_write',
        'run_tests',
        'local_commit',
      ],
      orchestrator: 'hermes',
      executor: 'codex',
      workspaceIsolation: 'isolated_worktree_only',
      requiresHumanApprovalForBlockedActions: true,
      productionAccess: false,
      databaseWriteAccess: false,
      secretAccess: false,
    },
  });
});

test('project execution planner rejects invalid tasks before reading the registry', async () => {
  let reads = 0;
  const source = {
    async read() {
      reads += 1;
      return [];
    },
  };

  const result = await planProjectTask({
    projectId: 'lia-agent',
    instruction: 'Ejecuta una tarea',
    priority: 'normal',
    requestedCapabilities: ['repository_read'],
    repositoryPath: '/request-controlled/path',
    command: 'unsafe command',
  }, source);

  assert.deepEqual(result, { ok: false, error: 'invalid_task' });
  assert.equal(reads, 0);
});

test('project execution planner reports an unknown project', async () => {
  const source = createStaticProjectRegistry([]);

  assert.deepEqual(await planProjectTask({
    projectId: 'unknown',
    instruction: 'Inspecciona el proyecto',
    priority: 'normal',
    requestedCapabilities: ['repository_read'],
  }, source), { ok: false, error: 'project_not_found' });
});

test('project execution planner rejects a disabled project', async () => {
  const source = createStaticProjectRegistry([{
    projectId: 'lia-agent',
    displayName: 'LÍA Agent',
    repositoryRoot: '/srv/projects/lia-agent',
    enabled: false,
  }]);

  assert.deepEqual(await planProjectTask({
    projectId: 'lia-agent',
    instruction: 'Inspecciona el proyecto',
    priority: 'normal',
    requestedCapabilities: ['repository_read'],
  }, source), { ok: false, error: 'project_disabled' });
});

test('project execution planner fails closed for registry errors and owns capability copies', async () => {
  const rawRequest = {
    projectId: 'lia-agent',
    instruction: 'Prueba el proyecto',
    priority: 'normal',
    requestedCapabilities: ['repository_read', 'run_tests'],
  };
  const unavailable = {
    async read() {
      throw new Error('registry failure');
    },
  };

  assert.deepEqual(await planProjectTask(rawRequest, unavailable), {
    ok: false,
    error: 'registry_unavailable',
  });

  const normalized = validateProjectTaskRequest(rawRequest);
  assert.equal(normalized.success, true);
  const available = createStaticProjectRegistry([{
    projectId: 'lia-agent',
    displayName: 'LÍA Agent',
    repositoryRoot: '/srv/projects/lia-agent',
    enabled: true,
  }]);
  const first = await planProjectTask(rawRequest, available);
  assert.equal(first.ok, true);
  first.plan.approvedCapabilities.push('local_commit');

  assert.deepEqual(normalized.request.requestedCapabilities, [
    'repository_read',
    'run_tests',
  ]);
  const second = await planProjectTask(rawRequest, available);
  assert.equal(second.ok, true);
  assert.deepEqual(second.plan.approvedCapabilities, [
    'repository_read',
    'isolated_worktree_write',
    'run_tests',
    'local_commit',
  ]);
});

const AUTONOMOUS_V1_CEILING = [
  'repository_read',
  'isolated_worktree_write',
  'run_tests',
  'local_commit',
];

test('Autonomous V1 approvedCapabilities is the exact backend ceiling regardless of requestedCapabilities', async () => {
  const source = createStaticProjectRegistry([{
    projectId: 'lia-agent',
    displayName: 'LÍA Agent',
    repositoryRoot: '/srv/projects/lia-agent',
    enabled: true,
  }]);

  for (const requestedCapabilities of [[], ['repository_read'], AUTONOMOUS_V1_CEILING]) {
    const result = await planProjectTask({
      projectId: 'lia-agent',
      instruction: 'Inspecciona el proyecto',
      priority: 'normal',
      requestedCapabilities,
    }, source);

    assert.equal(result.ok, true);
    assert.deepEqual(result.plan.approvedCapabilities, AUTONOMOUS_V1_CEILING);
  }
});

test('Autonomous V1 plan never contains forbidden capabilities', async () => {
  const source = createStaticProjectRegistry([{
    projectId: 'lia-agent',
    displayName: 'LÍA Agent',
    repositoryRoot: '/srv/projects/lia-agent',
    enabled: true,
  }]);

  const result = await planProjectTask({
    projectId: 'lia-agent',
    instruction: 'Inspecciona el proyecto',
    priority: 'normal',
    requestedCapabilities: ['repository_read'],
  }, source);

  assert.equal(result.ok, true);
  for (const forbidden of ['push', 'merge', 'deploy', 'production_write', 'database_write', 'secret_access']) {
    assert.equal(result.plan.approvedCapabilities.includes(forbidden), false, forbidden);
  }
});

test('request validation accepts requestedCapabilities as metadata and still rejects unknown capabilities', () => {
  const valid = validateProjectTaskRequest({
    projectId: 'lia-agent',
    instruction: 'Inspecciona el proyecto',
    priority: 'normal',
    requestedCapabilities: [],
  });
  assert.equal(valid.success, true);
  assert.deepEqual(valid.request.requestedCapabilities, []);

  for (const unknown of ['push', 'deploy', 'production_write', 'database_write', 'secret_access', 'totally_unknown']) {
    const result = validateProjectTaskRequest({
      projectId: 'lia-agent',
      instruction: 'Inspecciona el proyecto',
      priority: 'normal',
      requestedCapabilities: [unknown],
    });
    assert.equal(result.success, false, unknown);
    assert.ok(result.errors.some((error) => error.path === 'requestedCapabilities.0'), unknown);
  }
});

test('Hermes cannot introduce a capability outside the backend ceiling into the Codex handoff', () => {
  const result = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: [...AUTONOMOUS_V1_CEILING] }),
    orchestrationProposal({
      steps: [orchestrationStep({ requiredCapabilities: ['push'] })],
    }),
  );
  assert.equal(result.success, false);
});

test('effectiveCapabilities derive only from validated proposal requiredCapabilities', () => {
  const handoff = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: [...AUTONOMOUS_V1_CEILING] }),
    orchestrationProposal({
      steps: [orchestrationStep({ requiredCapabilities: ['repository_read'] })],
    }),
  );
  assert.equal(handoff.success, true);
  assert.deepEqual(handoff.handoff.effectiveCapabilities, ['repository_read']);
});

test('read-only proposal binds only repository_read even under the full ceiling', () => {
  const handoff = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: [...AUTONOMOUS_V1_CEILING] }),
    orchestrationProposal({
      steps: [orchestrationStep({ requiredCapabilities: ['repository_read'] })],
    }),
  );
  assert.equal(handoff.success, true);
  assert.deepEqual(handoff.handoff.effectiveCapabilities, ['repository_read']);
});

test('write proposal binds repository_read + isolated_worktree_write only', () => {
  const handoff = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: [...AUTONOMOUS_V1_CEILING] }),
    orchestrationProposal({
      steps: [orchestrationStep({ requiredCapabilities: ['repository_read', 'isolated_worktree_write'] })],
    }),
  );
  assert.equal(handoff.success, true);
  assert.deepEqual(handoff.handoff.effectiveCapabilities, ['repository_read', 'isolated_worktree_write']);
});

const orchestrationPlan = (approvedCapabilities = ["repository_read", "run_tests"]) => ({
  projectId: "project-safe-1",
  projectDisplayName: "Proyecto Seguro",
  repositoryRoot: "/internal/private/repository-root",
  instruction: "Analiza la tarea sin ejecutar nada.",
  priority: "high",
  approvedCapabilities,
});

const orchestrationStep = (overrides = {}) => ({
  id: "step-1",
  title: "Inspeccionar",
  objective: "Entender la tarea",
  role: "orchestrator",
  dependsOn: [],
  requiredCapabilities: ["repository_read"],
  ...overrides,
});

const orchestrationProposal = (overrides = {}) => ({
  summary: "Propuesta segura",
  steps: [orchestrationStep()],
  executionMode: "direct",
  requiresHumanApproval: false,
  blockedActions: [],
  ...overrides,
});

function createFakeHermesProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

function reasoningConfig(overrides = {}) {
  return {
    ...loadConfig({
      LIA_HERMES_EXECUTION_ENABLED: 'true',
      LIA_HERMES_TIMEOUT_MS: '50',
    }),
    ...overrides,
  };
}

test('project orchestration defaults to the Supervisor executor, not chat Hermes', async () => {
  const source = await readFile(
    new URL('../src/services/projectOrchestrationService.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /executeQuery \?\? executeHermesSupervisor/);
  assert.equal(source.includes('executeHermesReasoningOnly'), false);
  assert.equal(source.includes('executeHermesQuery'), false);
});

test('reasoning executor invokes venv Python directly with an explicit zero-tool agent', () => {
  const invocation = buildHermesReasoningInvocation(reasoningConfig(), 'plan safely');
  const pythonSource = invocation.args.at(-1);

  assert.equal(invocation.command, '/usr/sbin/runuser');
  assert.equal(invocation.args.includes('hermes'), false);
  assert.equal(invocation.args.includes('chat'), false);
  assert.equal(invocation.args.includes('--yolo'), false);
  assert.match(invocation.args.at(-3), /hermes-agent\/venv\/bin\/python$/);
  assert.equal(invocation.args.at(-2), '-c');
  assert.match(pythonSource, /enabled_toolsets=\[\]/);
  assert.match(pythonSource, /disabled_toolsets=\[\]/);
  assert.match(pythonSource, /skip_memory=True/);
  assert.match(pythonSource, /skip_context_files=True/);
  assert.match(pythonSource, /save_trajectories=False/);
  assert.equal(invocation.args.some((arg) => arg.startsWith('HERMES_INTERACTIVE=')), false);
  assert.equal(invocation.args.some((arg) => arg.startsWith('HERMES_YOLO_MODE=')), false);
  assert.equal(invocation.args.some((arg) => arg.startsWith('HERMES_ACCEPT_HOOKS=')), false);
});

test('reasoning Python runner asserts both tool surfaces before model execution', () => {
  const source = buildHermesReasoningInvocation(reasoningConfig(), 'plan').args.at(-1);
  const assertionIndex = source.indexOf('if not isinstance(tools, list)');
  const conversationIndex = source.indexOf('agent.run_conversation');

  assert.notEqual(assertionIndex, -1);
  assert.match(source, /valid_tool_names is None or bool\(valid_tool_names\)/);
  assert.match(source, /LIA_HERMES_REASONING_TOOL_SURFACE_VIOLATION/);
  assert.equal(assertionIndex < conversationIndex, true);
});

test('reasoning executor preserves success, failure, empty and tool-violation contracts', async () => {
  const cases = [
    {
      arrange(child) {
        child.stdout.end('\u001b[32mreasoned\u001b[0m');
        queueMicrotask(() => child.emit('close', 0));
      },
      expected: { ok: true, response: 'reasoned' },
    },
    {
      arrange(child) {
        queueMicrotask(() => child.emit('error', new Error('private failure')));
      },
      expected: { ok: false, error: 'execution_failed' },
    },
    {
      arrange(child) {
        queueMicrotask(() => child.emit('close', 0));
      },
      expected: { ok: false, error: 'empty_response' },
    },
    {
      arrange(child) {
        child.stderr.end('LIA_HERMES_REASONING_TOOL_SURFACE_VIOLATION\nsecret');
        queueMicrotask(() => child.emit('close', 78));
      },
      expected: { ok: false, error: 'execution_failed' },
    },
  ];

  for (const { arrange, expected } of cases) {
    const child = createFakeHermesProcess();
    const executor = createHermesReasoningOnlyExecutor(() => {
      queueMicrotask(() => arrange(child));
      return child;
    });
    assert.deepEqual(await executor(reasoningConfig(), 'plan'), expected);
  }
});

test('reasoning executor times out with SIGTERM and keeps the public contract closed', async () => {
  const child = createFakeHermesProcess();
  const executor = createHermesReasoningOnlyExecutor(() => child);
  const result = await executor(reasoningConfig({ hermesTimeoutMs: 1 }), 'plan');

  assert.deepEqual(result, { ok: false, error: 'timeout' });
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test("project orchestration builds a safe prompt without repository paths", () => {
  const prompt = buildProjectOrchestrationPrompt(orchestrationPlan());
  assert.match(prompt, /project-safe-1/);
  assert.match(prompt, /Proyecto Seguro/);
  assert.match(prompt, /Analiza la tarea sin ejecutar nada\./);
  assert.match(prompt, /high/);
  assert.match(prompt, /repository_read/);
  assert.match(prompt, /run_tests/);
  assert.match(prompt, /DATA ONLY/);
  assert.match(prompt, /LÍA es la autoridad/);
  assert.match(prompt, /NO debes ejecutar herramientas, comandos, Git, Codex ni cambios/);
  assert.doesNotMatch(prompt, /repositoryRoot/);
  assert.doesNotMatch(prompt, /\/internal\/private\/repository-root/);
});

test("project orchestration accepts and normalizes a valid proposal", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    summary: "  Propuesta segura  ",
    executionMode: "delegated",
    steps: [
      { id: "step-1", title: "  Inspeccionar  ", objective: "  Entender la tarea  ", role: "orchestrator", dependsOn: [], requiredCapabilities: ["repository_read", "repository_read"] },
      { id: "step-2", title: "  Verificar  ", objective: "  Ejecutar las pruebas autorizadas  ", role: "reviewer", dependsOn: ["step-1"], requiredCapabilities: ["run_tests"] },
    ],
  }), orchestrationPlan());
  assert.equal(result.success, true);
  assert.equal(result.proposal.summary, "Propuesta segura");
  assert.deepEqual(result.proposal.steps[0].requiredCapabilities, ["repository_read"]);
  assert.equal(result.proposal.steps[1].title, "Verificar");
  assert.deepEqual(result.proposal.steps[1].dependsOn, ["step-1"]);
});

test("project orchestration rejects unknown fields", () => {
  const topLevel = validateProjectOrchestrationProposal({ ...orchestrationProposal(), command: "do something" }, orchestrationPlan());
  const stepLevel = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [{ id: "step-1", title: "Paso", objective: "Objetivo", role: "implementer", dependsOn: [], requiredCapabilities: [], branch: "main", repositoryRoot: "/private" }],
  }), orchestrationPlan());
  assert.equal(topLevel.success, false);
  assert.equal(stepLevel.success, false);
});

test("project orchestration rejects capabilities not approved by LÍA", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [{ id: "step-1", title: "Probar", objective: "Ejecutar pruebas", role: "implementer", dependsOn: [], requiredCapabilities: ["run_tests"] }],
  }), orchestrationPlan(["repository_read"]));
  assert.equal(result.success, false);
});

test("project orchestration validates and deduplicates blocked actions", () => {
  const valid = validateProjectOrchestrationProposal(orchestrationProposal({ blockedActions: ["deploy", "deploy"], requiresHumanApproval: true }), orchestrationPlan());
  const invalid = validateProjectOrchestrationProposal(orchestrationProposal({ blockedActions: ["deploy", "deploy"], requiresHumanApproval: false }), orchestrationPlan());
  assert.equal(valid.success, true);
  assert.deepEqual(valid.proposal.blockedActions, ["deploy"]);
  assert.equal(invalid.success, false);
});

test("project orchestration enforces structural limits", () => {
  const step = { id: "step-1", title: "Paso", objective: "Objetivo", role: "orchestrator", dependsOn: [], requiredCapabilities: [] };
  assert.equal(validateProjectOrchestrationProposal(orchestrationProposal({ steps: [] }), orchestrationPlan()).success, false);
  assert.equal(validateProjectOrchestrationProposal(orchestrationProposal({ steps: Array.from({ length: 13 }, (_, index) => ({ ...step, id: `step-${index}` })) }), orchestrationPlan()).success, false);
  assert.equal(validateProjectOrchestrationProposal(orchestrationProposal({ summary: "   " }), orchestrationPlan()).success, false);
});

test("project orchestration accepts a valid direct proposal", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "direct",
    steps: [orchestrationStep({ role: "orchestrator" })],
  }), orchestrationPlan());
  assert.equal(result.success, true);
  assert.equal(result.proposal.executionMode, "direct");
  assert.equal(result.proposal.steps[0].role, "orchestrator");
  assert.deepEqual(result.proposal.steps[0].dependsOn, []);
});

test("project orchestration accepts a valid delegated proposal with multiple roles", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "research", role: "researcher", dependsOn: [], requiredCapabilities: ["repository_read"] }),
      orchestrationStep({ id: "arch", role: "architect", dependsOn: ["research"], requiredCapabilities: ["repository_read"] }),
      orchestrationStep({ id: "impl", role: "implementer", dependsOn: ["arch"], requiredCapabilities: ["isolated_worktree_write"] }),
      orchestrationStep({ id: "review", role: "reviewer", dependsOn: ["impl"], requiredCapabilities: ["run_tests"] }),
    ],
  }), orchestrationPlan(["repository_read", "isolated_worktree_write", "run_tests"]));
  assert.equal(result.success, true);
  assert.equal(result.proposal.executionMode, "delegated");
  assert.deepEqual(result.proposal.steps.map((step) => step.role), ["researcher", "architect", "implementer", "reviewer"]);
});

test("project orchestration rejects an invalid step role", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [orchestrationStep({ role: "deployer" })],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.path === "$.steps[0].role"));
});

test("project orchestration rejects duplicate step ids", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [
      orchestrationStep(),
      orchestrationStep({ title: "Duplicado", objective: "Mismo id", requiredCapabilities: [] }),
    ],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "must be unique"));
});

test("project orchestration rejects dependsOn referencing a missing step id", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [orchestrationStep({ dependsOn: ["missing-step"] })],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "references an unknown step id"));
});

test("project orchestration rejects self dependency", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [orchestrationStep({ dependsOn: ["step-1"] })],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "must not reference itself"));
});

test("project orchestration rejects a dependency cycle A -> B -> A", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [
      orchestrationStep({ id: "step-a", dependsOn: ["step-b"] }),
      orchestrationStep({ id: "step-b", dependsOn: ["step-a"] }),
    ],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => /dependency cycle/.test(error.message)));
});

test("project orchestration rejects a capability not approved by LÍA even with supervisor metadata", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a", role: "researcher" }),
      orchestrationStep({ id: "step-b", role: "implementer", dependsOn: ["step-a"], requiredCapabilities: ["run_tests"] }),
    ],
  }), orchestrationPlan(["repository_read"]));
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "contains a capability not approved by LÍA"));
});

test("project orchestration rejects forbidden supervisor internals as extra fields", () => {
  const topLevel = validateProjectOrchestrationProposal({
    ...orchestrationProposal(),
    subagent_id: "sub-1",
    child_session_id: "session-1",
    parent_session_id: "session-0",
    transcripts: ["t"],
    shell: "/bin/sh",
    command: "npm test",
  }, orchestrationPlan());
  const stepLevel = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [orchestrationStep({ prompt: "internal", shell: "/bin/sh" })],
  }), orchestrationPlan());
  assert.equal(topLevel.success, false);
  assert.equal(stepLevel.success, false);
});

test("blocked actions still require human approval under the supervisor contract", () => {
  const valid = validateProjectOrchestrationProposal(orchestrationProposal({
    blockedActions: ["deploy"],
    requiresHumanApproval: true,
  }), orchestrationPlan());
  const invalid = validateProjectOrchestrationProposal(orchestrationProposal({
    blockedActions: ["deploy"],
    requiresHumanApproval: false,
  }), orchestrationPlan());
  assert.equal(valid.success, true);
  assert.equal(valid.proposal.requiresHumanApproval, true);
  assert.equal(invalid.success, false);
});

test("supervisor metadata never expands effective capabilities in the Codex handoff", () => {
  const result = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: ["repository_read", "run_tests"] }),
    orchestrationProposal({
      executionMode: "delegated",
      steps: [
        orchestrationStep({ id: "step-a", role: "researcher", dependsOn: [], requiredCapabilities: ["repository_read"] }),
        orchestrationStep({ id: "step-b", role: "reviewer", dependsOn: ["step-a"], requiredCapabilities: ["run_tests"] }),
      ],
    }),
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.handoff.effectiveCapabilities, ["repository_read", "run_tests"]);
  assert.deepEqual(result.handoff.proposal.steps, [
    { title: "Inspeccionar", objective: "Entender la tarea", requiredCapabilities: ["repository_read"] },
    { title: "Inspeccionar", objective: "Entender la tarea", requiredCapabilities: ["run_tests"] },
  ]);
  assert.deepEqual(Object.keys(result.handoff.proposal.steps[0]).sort(), ["objective", "requiredCapabilities", "title"]);
  assert.equal(Object.hasOwn(result.handoff, "executionMode"), false);
  assert.equal(Object.hasOwn(result.handoff, "role"), false);
  assert.equal(Object.hasOwn(result.handoff, "dependsOn"), false);
});

test("direct executionMode rejects more than one step", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "direct",
    steps: [orchestrationStep(), orchestrationStep({ id: "step-2" })],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "direct executionMode must contain exactly 1 step"));
});

test("direct executionMode rejects a dependency", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "direct",
    steps: [orchestrationStep({ dependsOn: ["step-1"] })],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "direct executionMode must not declare dependencies"));
});

test("delegated executionMode rejects a single step", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [orchestrationStep()],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "delegated executionMode must contain at least 2 steps"));
});

test("duplicate normalized ids inside a dependsOn array are rejected", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a" }),
      orchestrationStep({ id: "step-b", dependsOn: ["step-a", "step-a"] }),
    ],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.path === "$.steps[1].dependsOn" && error.message === "must not contain duplicate step ids"));
  const whitespaceNormalized = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a" }),
      orchestrationStep({ id: "step-b", dependsOn: ["step-a", " step-a "] }),
    ],
  }), orchestrationPlan());
  assert.equal(whitespaceNormalized.success, false);
  assert.ok(whitespaceNormalized.errors.some((error) => error.message === "must not contain duplicate step ids"));
});

test("role metadata cannot grant a capability", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a", role: "implementer" }),
      orchestrationStep({ id: "step-b", role: "implementer", dependsOn: ["step-a"], requiredCapabilities: ["local_commit"] }),
    ],
  }), orchestrationPlan(["repository_read"]));
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "contains a capability not approved by LÍA"));
});

test("executionMode metadata cannot grant a capability", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a" }),
      orchestrationStep({ id: "step-b", dependsOn: ["step-a"], requiredCapabilities: ["run_tests"] }),
    ],
  }), orchestrationPlan(["repository_read"]));
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "contains a capability not approved by LÍA"));
});

test("requiresHumanApproval=true with empty blockedActions fails closed", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    requiresHumanApproval: true,
    blockedActions: [],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.path === "$.requiresHumanApproval"));
});

test("step id length boundary: 64 characters valid, 65 rejected", () => {
  const maxId = "a".repeat(64);
  const valid = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [orchestrationStep({ id: maxId })],
  }), orchestrationPlan());
  assert.equal(valid.success, true);
  assert.equal(valid.proposal.steps[0].id, maxId);
  const tooLong = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [orchestrationStep({ id: "a".repeat(65) })],
  }), orchestrationPlan());
  assert.equal(tooLong.success, false);
  assert.ok(tooLong.errors.some((error) => error.path === "$.steps[0].id"));
});

test("step count boundary: 12 steps valid, 13 rejected", () => {
  const twelve = Array.from({ length: 12 }, (_, index) => orchestrationStep({
    id: `step-${index}`,
    dependsOn: index === 0 ? [] : [`step-${index - 1}`],
  }));
  const valid = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: twelve,
  }), orchestrationPlan());
  assert.equal(valid.success, true);
  assert.equal(valid.proposal.steps.length, 12);
  const rejected = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [...twelve, orchestrationStep({ id: "step-12", dependsOn: ["step-11"] })],
  }), orchestrationPlan());
  assert.equal(rejected.success, false);
  assert.ok(rejected.errors.some((error) => error.message === "must contain at most 12 steps"));
});

test("dependsOn boundary: 12 entries pass the length check, 13 are rejected", () => {
  const twelveDependencies = Array.from({ length: 12 }, (_, index) => `missing-${index}`);
  const atLimit = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a" }),
      orchestrationStep({ id: "step-b", dependsOn: twelveDependencies }),
    ],
  }), orchestrationPlan());
  assert.equal(atLimit.success, false);
  assert.equal(atLimit.errors.some((error) => error.message === "must contain at most 12 entries"), false);
  const overLimit = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a" }),
      orchestrationStep({ id: "step-b", dependsOn: [...twelveDependencies, "missing-12"] }),
    ],
  }), orchestrationPlan());
  assert.equal(overLimit.success, false);
  assert.ok(overLimit.errors.some((error) => error.message === "must contain at most 12 entries"));
});

test("blockedActions boundary: 6 entries valid, 7 rejected", () => {
  const all = ["push", "merge", "deploy", "production_write", "database_write", "secret_access"];
  const valid = validateProjectOrchestrationProposal(orchestrationProposal({
    blockedActions: all,
    requiresHumanApproval: true,
  }), orchestrationPlan());
  assert.equal(valid.success, true);
  assert.deepEqual(valid.proposal.blockedActions, all);
  const rejected = validateProjectOrchestrationProposal(orchestrationProposal({
    blockedActions: [...all, "unknown_action"],
    requiresHumanApproval: true,
  }), orchestrationPlan());
  assert.equal(rejected.success, false);
  assert.ok(rejected.errors.some((error) => error.message === "must contain at most 6 actions"));
});

test("summary length boundary: 1200 characters valid, 1201 rejected", () => {
  const valid = validateProjectOrchestrationProposal(orchestrationProposal({
    summary: "a".repeat(1200),
  }), orchestrationPlan());
  assert.equal(valid.success, true);
  const rejected = validateProjectOrchestrationProposal(orchestrationProposal({
    summary: "a".repeat(1201),
  }), orchestrationPlan());
  assert.equal(rejected.success, false);
  assert.ok(rejected.errors.some((error) => error.path === "$.summary"));
});

test("non-string dependsOn entries are rejected", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    steps: [orchestrationStep({ dependsOn: [123] })],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.path === "$.steps[0].dependsOn" && error.message === "must be a string"));
});

test("production_write blocked action cannot be handed off to Codex", () => {
  const result = buildProjectCodexHandoff(
    codexHandoffPlan(),
    orchestrationProposal({
      blockedActions: ["production_write"],
      requiresHumanApproval: true,
    }),
  );
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "blocked actions cannot be handed off to Codex"));
});

test("database_write blocked action cannot be handed off to Codex", () => {
  const result = buildProjectCodexHandoff(
    codexHandoffPlan(),
    orchestrationProposal({
      blockedActions: ["database_write"],
      requiresHumanApproval: true,
    }),
  );
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "blocked actions cannot be handed off to Codex"));
});

test("a longer dependency cycle is rejected", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a", dependsOn: ["step-b"] }),
      orchestrationStep({ id: "step-b", dependsOn: ["step-c"] }),
      orchestrationStep({ id: "step-c", dependsOn: ["step-d"] }),
      orchestrationStep({ id: "step-d", dependsOn: ["step-a"] }),
    ],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => /dependency cycle/.test(error.message)));
});

test("duplicate step ids with a cycle remain fail-closed without index ambiguity", () => {
  const result = validateProjectOrchestrationProposal(orchestrationProposal({
    executionMode: "delegated",
    steps: [
      orchestrationStep({ id: "step-a", dependsOn: [] }),
      orchestrationStep({ id: "step-a", dependsOn: ["step-b"] }),
      orchestrationStep({ id: "step-b", dependsOn: ["step-a"] }),
    ],
  }), orchestrationPlan());
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.message === "must be unique"));
  assert.ok(result.errors.some((error) => error.path === "$.steps[1].id"));
});

test("effectiveCapabilities remains a subset of approvedCapabilities", () => {
  const result = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: ["repository_read", "run_tests", "isolated_worktree_write"] }),
    orchestrationProposal({
      executionMode: "delegated",
      steps: [
        orchestrationStep({ id: "step-a", requiredCapabilities: ["repository_read"] }),
        orchestrationStep({ id: "step-b", dependsOn: ["step-a"], requiredCapabilities: ["run_tests"] }),
      ],
    }),
  );
  assert.equal(result.success, true);
  for (const capability of result.handoff.effectiveCapabilities) {
    assert.ok(result.handoff.approvedCapabilities.includes(capability));
  }
  assert.equal(result.handoff.effectiveCapabilities.length <= result.handoff.approvedCapabilities.length, true);
});

test("id, role, dependsOn and executionMode never become execution authority", () => {
  const first = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: ["repository_read"] }),
    orchestrationProposal({
      executionMode: "delegated",
      steps: [
        orchestrationStep({ id: "step-a", role: "researcher", requiredCapabilities: ["repository_read"] }),
        orchestrationStep({ id: "step-b", role: "reviewer", dependsOn: ["step-a"], requiredCapabilities: ["repository_read"] }),
      ],
    }),
  );
  const second = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: ["repository_read"] }),
    orchestrationProposal({
      executionMode: "delegated",
      steps: [
        orchestrationStep({ id: "x", role: "architect", requiredCapabilities: ["repository_read"] }),
        orchestrationStep({ id: "y", role: "implementer", dependsOn: ["x"], requiredCapabilities: ["repository_read"] }),
      ],
    }),
  );
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.deepEqual(first.handoff.effectiveCapabilities, ["repository_read"]);
  assert.deepEqual(second.handoff.effectiveCapabilities, ["repository_read"]);
  for (const key of ["id", "role", "dependsOn", "executionMode"]) {
    assert.equal(Object.hasOwn(first.handoff, key), false);
    assert.equal(Object.hasOwn(second.handoff, key), false);
    assert.equal(Object.hasOwn(first.handoff.proposal.steps[0], key), false);
    assert.equal(Object.hasOwn(first.handoff.proposal.steps[1], key), false);
  }
});

test("project orchestration prompt includes the supervisor schema", () => {
  const prompt = buildProjectOrchestrationPrompt(orchestrationPlan());
  assert.match(prompt, /"executionMode":"direct"/);
  assert.match(prompt, /"role":"orchestrator"/);
  assert.match(prompt, /"dependsOn":\[\]/);
  assert.match(prompt, /"id":"step-1"/);
  assert.match(prompt, /"requiredCapabilities":\["repository_read"\]/);
  assert.match(prompt, /Valores permitidos para executionMode/);
  assert.match(prompt, /Valores permitidos para role/);
  assert.match(prompt, /La metadata jamás concede capacidades ni autoridad/);
  assert.match(prompt, /se derivan exclusivamente de requiredCapabilities/);
  assert.match(prompt, /subconjunto MÍNIMO de requiredCapabilities/);
  assert.match(prompt, /No solicites el techo completo de approvedCapabilities/);
  assert.doesNotMatch(prompt, /direct\|delegated/);
  assert.doesNotMatch(prompt, /architect\|implementer\|reviewer\|researcher\|orchestrator/);
});

test("project orchestration repair prompt includes the supervisor schema", () => {
  const prompt = buildProjectOrchestrationRepairPrompt(orchestrationPlan());
  assert.match(prompt, /"executionMode":"direct"/);
  assert.match(prompt, /"role":"orchestrator"/);
  assert.match(prompt, /"dependsOn":\[\]/);
  assert.match(prompt, /"id":"step-1"/);
  assert.match(prompt, /"requiredCapabilities":\["repository_read"\]/);
  assert.match(prompt, /Valores permitidos para executionMode/);
  assert.match(prompt, /Valores permitidos para role/);
  assert.match(prompt, /La metadata jamás concede capacidades ni autoridad/);
  assert.match(prompt, /exactamente id, title, objective, role, dependsOn y requiredCapabilities/);
  assert.match(prompt, /No copies el techo completo de approvedCapabilities/);
  assert.doesNotMatch(prompt, /direct \| delegated/);
  assert.doesNotMatch(prompt, /architect \| implementer \| reviewer \| researcher \| orchestrator/);
});

const codexHandoffPlan = (overrides = {}) => ({
  ...orchestrationPlan(),
  orchestrator: "hermes",
  executor: "codex",
  workspaceIsolation: "isolated_worktree_only",
  requiresHumanApprovalForBlockedActions: true,
  productionAccess: false,
  databaseWriteAccess: false,
  secretAccess: false,
  ...overrides,
});

test("internal Codex handoff is derived from validated plan and proposal", () => {
  const result = buildProjectCodexHandoff(codexHandoffPlan(), orchestrationProposal());

  assert.equal(result.success, true);
  assert.deepEqual(result.handoff, {
    projectId: "project-safe-1",
    projectDisplayName: "Proyecto Seguro",
    repositoryRoot: "/internal/private/repository-root",
    instruction: "Analiza la tarea sin ejecutar nada.",
    priority: "high",
    approvedCapabilities: ["repository_read", "run_tests"],
    effectiveCapabilities: ["repository_read"],
    proposal: {
      summary: "Propuesta segura",
      steps: [{
        title: "Inspeccionar",
        objective: "Entender la tarea",
        requiredCapabilities: ["repository_read"],
      }],
    },
    executor: "codex",
    workspaceIsolation: "isolated_worktree_only",
    productionAccess: false,
    databaseWriteAccess: false,
    secretAccess: false,
  });
});

test("internal Codex handoff owns independent capability and step copies", () => {
  const plan = codexHandoffPlan();
  const proposal = orchestrationProposal();
  const result = buildProjectCodexHandoff(plan, proposal);
  assert.equal(result.success, true);

  plan.approvedCapabilities.push("local_commit");
  proposal.steps[0].requiredCapabilities.push("run_tests");
  proposal.steps[0].title = "Mutado";

  assert.deepEqual(result.handoff.approvedCapabilities, ["repository_read", "run_tests"]);
  assert.deepEqual(result.handoff.proposal.steps[0], {
    title: "Inspeccionar",
    objective: "Entender la tarea",
    requiredCapabilities: ["repository_read"],
  });
});

test("internal Codex handoff rejects capability escalation", () => {
  const result = buildProjectCodexHandoff(
    codexHandoffPlan({ approvedCapabilities: ["repository_read"] }),
    orchestrationProposal({
      steps: [orchestrationStep({ requiredCapabilities: ["run_tests"] })],
    }),
  );
  assert.equal(result.success, false);
});

test("internal Codex handoff rejects unknown source fields", () => {
  assert.equal(buildProjectCodexHandoff(
    codexHandoffPlan({ shell: "/bin/sh" }),
    orchestrationProposal(),
  ).success, false);
  assert.equal(buildProjectCodexHandoff(
    codexHandoffPlan(),
    orchestrationProposal({ branch: "main" }),
  ).success, false);
});

test("internal Codex handoff never accepts repositoryRoot or command from proposal", () => {
  for (const field of ["repositoryRoot", "command"]) {
    const result = buildProjectCodexHandoff(
      codexHandoffPlan(),
      orchestrationProposal({ [field]: "untrusted" }),
    );
    assert.equal(result.success, false, field);
  }
});

test("internal Codex handoff blocks proposals that request blocked actions", () => {
  for (const blockedAction of ["push", "merge", "deploy", "secret_access"]) {
    const result = buildProjectCodexHandoff(
      codexHandoffPlan(),
      orchestrationProposal({
        requiresHumanApproval: true,
        blockedActions: [blockedAction],
      }),
    );
    assert.equal(result.success, false, blockedAction);
  }
});

const orchestrationRegistry = () => createStaticProjectRegistry([{
  projectId: 'lia-agent',
  displayName: 'LÍA Agent',
  repositoryRoot: '/private/repos/lia-agent',
  enabled: true,
}]);

const orchestrationTask = (requestedCapabilities = ['repository_read', 'run_tests']) => ({
  projectId: 'lia-agent',
  instruction: 'Inspecciona y verifica el proyecto',
  priority: 'normal',
  requestedCapabilities,
});

test('project orchestration service completes a valid simulated flow without leaking internals', async () => {
  const config = loadConfig({});
  const calls = [];
  const proposal = {
    summary: 'Inspección y verificación seguras',
    executionMode: 'delegated',
    steps: [
      {
        id: 'step-1',
        title: 'Inspeccionar',
        objective: 'Revisar el repositorio',
        role: 'researcher',
        dependsOn: [],
        requiredCapabilities: ['repository_read'],
      },
      {
        id: 'step-2',
        title: 'Verificar',
        objective: 'Ejecutar las pruebas aprobadas',
        role: 'reviewer',
        dependsOn: ['step-1'],
        requiredCapabilities: ['run_tests'],
      },
    ],
    requiresHumanApproval: false,
    blockedActions: [],
  };
  const executeQuery = async (receivedConfig, prompt) => {
    calls.push({ config: receivedConfig, prompt });
    return { ok: true, response: JSON.stringify(proposal) };
  };

  const result = await orchestrateProjectTask(
    config,
    orchestrationTask(),
    orchestrationRegistry(),
    executeQuery,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.proposal, proposal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config, config);
  assert.match(calls[0].prompt, /lia-agent/);
  assert.match(calls[0].prompt, /Inspecciona y verifica el proyecto/);
  assert.match(calls[0].prompt, /repository_read/);
  assert.match(calls[0].prompt, /run_tests/);
  assert.doesNotMatch(calls[0].prompt, /\/private\/repos\/lia-agent/);
  assert.doesNotMatch(calls[0].prompt, /repositoryRoot/);
  assert.equal(Object.hasOwn(result, 'plan'), false);
  assert.equal(Object.hasOwn(result, 'repositoryRoot'), false);
  assert.equal(Object.hasOwn(result, 'response'), false);
});

test('project orchestration service rejects invalid tasks without calling Hermes', async () => {
  let calls = 0;
  const executeQuery = async () => {
    calls += 1;
    return { ok: false, error: 'execution_failed' };
  };

  const result = await orchestrateProjectTask(
    loadConfig({}),
    { ...orchestrationTask(), command: 'npm test' },
    orchestrationRegistry(),
    executeQuery,
  );

  assert.deepEqual(result, { ok: false, error: 'invalid_task' });
  assert.equal(calls, 0);
});

test('project orchestration service propagates executor errors exactly', async () => {
  for (const error of [
    'execution_disabled',
    'timeout',
    'execution_failed',
    'empty_response',
  ]) {
    const result = await orchestrateProjectTask(
      loadConfig({}),
      orchestrationTask(),
      orchestrationRegistry(),
      async () => ({ ok: false, error }),
    );

    assert.deepEqual(result, { ok: false, error });
  }
});

test('project orchestration service rejects non-pure Hermes JSON without repair', async () => {
  for (const response of [
    '```json\n{}\n```',
    'texto antes {"summary":"x"}',
  ]) {
    const result = await orchestrateProjectTask(
      loadConfig({}),
      orchestrationTask(),
      orchestrationRegistry(),
      async () => ({ ok: true, response }),
    );

    assert.deepEqual(result, { ok: false, error: 'invalid_hermes_json' });
  }
});

test('project orchestration service rejects a proposal using a capability outside the backend ceiling', async () => {
  const response = JSON.stringify({
    summary: 'Intento fuera de permisos',
    executionMode: 'delegated',
    steps: [{
      id: 'step-1',
      title: 'Publicar',
      objective: 'Intentar una acción prohibida',
      role: 'implementer',
      dependsOn: [],
      requiredCapabilities: ['push'],
    }],
    requiresHumanApproval: false,
    blockedActions: [],
  });

  const result = await orchestrateProjectTask(
    loadConfig({}),
    orchestrationTask(['repository_read']),
    orchestrationRegistry(),
    async () => ({ ok: true, response }),
  );

  assert.deepEqual(result, { ok: false, error: 'invalid_hermes_proposal' });
});

const postProjectOrchestration = (baseUrl, body) => fetch(
  `${baseUrl}/api/projects/tasks/orchestrate`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  },
);

test('POST project orchestration returns only a validated reasoning proposal', async () => {
  const calls = [];
  const proposal = orchestrationProposal();
  const fakeExecutor = async (config, prompt) => {
    calls.push({ config, prompt });
    return { ok: true, response: JSON.stringify(proposal) };
  };
  const app = createApp(loadConfig({}), {
    projectRegistrySource: orchestrationRegistry(),
    projectOrchestrationExecutor: fakeExecutor,
  });

  await withServer(app, async (baseUrl) => {
    const response = await postProjectOrchestration(baseUrl, orchestrationTask());
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      integration: 'project_orchestration',
      mode: 'reasoning_only',
      proposal,
    });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].prompt, /\/private\/repos\/lia-agent/);
    assert.doesNotMatch(calls[0].prompt, /repositoryRoot/);
    assert.doesNotMatch(serialized, /\/private\/repos\/lia-agent/);
    assert.doesNotMatch(serialized, /repositoryRoot/);
  });
});

test('POST project orchestration fails closed without an internal registry', async () => {
  let calls = 0;
  await withServer(createApp(loadConfig({}), {
    projectOrchestrationExecutor: async () => {
      calls += 1;
      return { ok: false, error: 'execution_failed' };
    },
  }), async (baseUrl) => {
    const response = await postProjectOrchestration(baseUrl, orchestrationTask());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'registry_unavailable' });
  });
  assert.equal(calls, 0);
});

test('POST project orchestration rejects invalid and dangerous fields before Hermes', async () => {
  const dangerousFields = [
    'repositoryRoot', 'command', 'shell', 'branch', 'worktreePath',
    'secrets', 'credentials', 'deploymentData', 'databaseWriteInstructions',
    'unknown',
  ];
  let calls = 0;
  const app = createApp(loadConfig({}), {
    projectRegistrySource: orchestrationRegistry(),
    projectOrchestrationExecutor: async () => {
      calls += 1;
      return { ok: false, error: 'execution_failed' };
    },
  });

  await withServer(app, async (baseUrl) => {
    for (const field of dangerousFields) {
      const response = await postProjectOrchestration(baseUrl, {
        ...orchestrationTask(),
        [field]: 'not allowed',
      });
      assert.equal(response.status, 400, field);
      assert.deepEqual(await response.json(), { ok: false, error: 'invalid_task' });
    }
  });
  assert.equal(calls, 0);
});

test('POST project orchestration maps registry authorization errors safely', async () => {
  for (const scenario of [
    { enabled: true, projectId: 'missing', status: 404, error: 'project_not_found' },
    { enabled: false, projectId: 'lia-agent', status: 403, error: 'project_disabled' },
  ]) {
    let calls = 0;
    const registry = createStaticProjectRegistry([{
      projectId: 'lia-agent',
      displayName: 'LÍA Agent',
      repositoryRoot: '/private/repos/lia-agent',
      enabled: scenario.enabled,
    }]);
    const app = createApp(loadConfig({}), {
      projectRegistrySource: registry,
      projectOrchestrationExecutor: async () => {
        calls += 1;
        return { ok: false, error: 'execution_failed' };
      },
    });

    await withServer(app, async (baseUrl) => {
      const response = await postProjectOrchestration(baseUrl, {
        ...orchestrationTask(),
        projectId: scenario.projectId,
      });
      assert.equal(response.status, scenario.status);
      assert.deepEqual(await response.json(), { ok: false, error: scenario.error });
    });
    assert.equal(calls, 0);
  }
});

test('POST project orchestration maps Hermes failures and invalid output safely', async () => {
  const scenarios = [
    { result: { ok: false, error: 'execution_disabled' }, status: 503, error: 'execution_disabled' },
    { result: { ok: false, error: 'timeout' }, status: 504, error: 'timeout' },
    { result: { ok: true, response: 'not json' }, status: 502, error: 'invalid_hermes_json' },
    { result: { ok: true, response: '{}' }, status: 502, error: 'invalid_hermes_proposal' },
  ];

  for (const scenario of scenarios) {
    let calls = 0;
    const app = createApp(loadConfig({}), {
      projectRegistrySource: orchestrationRegistry(),
      projectOrchestrationExecutor: async () => {
        calls += 1;
        return scenario.result;
      },
    });
    await withServer(app, async (baseUrl) => {
      const response = await postProjectOrchestration(baseUrl, orchestrationTask());
      assert.equal(response.status, scenario.status);
      assert.deepEqual(await response.json(), { ok: false, error: scenario.error });
    });
    assert.equal(calls, 1);
  }
});

test('POST project orchestration maps an oversized escaped prompt to 413', async () => {
  let calls = 0;
  const app = createApp(loadConfig({}), {
    projectRegistrySource: orchestrationRegistry(),
    projectOrchestrationExecutor: async () => {
      calls += 1;
      return { ok: false, error: 'execution_failed' };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await postProjectOrchestration(baseUrl, {
      ...orchestrationTask(),
      instruction: 'x\n'.repeat(4_000),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { ok: false, error: 'prompt_too_large' });
  });
  assert.equal(calls, 0);
});

test('GET project orchestration returns 405 with Allow POST', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/tasks/orchestrate`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.equal((await response.json()).error, 'method_not_allowed');
  });
});

const postProjectTaskExecution = (baseUrl, body) => fetch(
  `${baseUrl}/api/projects/tasks/execute`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  },
);

test('POST project task execution returns the exact safe success contract', async () => {
  const calls = [];
  const app = createApp(loadConfig({}), {
    projectRegistrySource: orchestrationRegistry(),
    projectTaskExecutionExecutor: async (config, task, registry) => {
      calls.push({ config, task, registry });
      return {
        ok: true,
        status: 'completed',
        executionId: 'execution-safe-001',
        summary: 'Tarea completada de forma aislada.',
        repositoryRoot: '/private/repos/lia-agent',
        stdout: 'secret output',
        handoff: { prompt: 'internal prompt' },
      };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await postProjectTaskExecution(baseUrl, orchestrationTask());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      integration: 'project_execution',
      mode: 'isolated_codex_execution',
      status: 'completed',
      executionId: 'execution-safe-001',
      summary: 'Tarea completada de forma aislada.',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].task, orchestrationTask());
    assert.doesNotMatch(JSON.stringify(body), /repositoryRoot|stdout|handoff|prompt|private/);
  });
});

test('POST project task execution fails closed without a registry and does not call the fake', async () => {
  let calls = 0;
  const app = createApp(loadConfig({}), {
    projectTaskExecutionExecutor: async () => {
      calls += 1;
      return { ok: false, status: 'failed', error: 'execution_failed' };
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await postProjectTaskExecution(baseUrl, orchestrationTask());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'registry_unavailable' });
  });
  assert.equal(calls, 0);
});

test('POST project task execution rejects dangerous request fields before execution', async () => {
  const dangerousFields = [
    'repositoryRoot', 'branch', 'worktreePath', 'command', 'shell', 'prompt',
    'secrets', 'credentials', 'config',
  ];
  let calls = 0;
  const app = createApp(loadConfig({}), {
    projectRegistrySource: orchestrationRegistry(),
    projectTaskExecutionExecutor: async () => {
      calls += 1;
      return { ok: false, status: 'failed', error: 'execution_failed' };
    },
  });
  await withServer(app, async (baseUrl) => {
    for (const field of dangerousFields) {
      const response = await postProjectTaskExecution(baseUrl, {
        ...orchestrationTask(),
        [field]: 'not allowed',
      });
      assert.equal(response.status, 400, field);
      assert.deepEqual(await response.json(), { ok: false, error: 'invalid_task' });
    }
  });
  assert.equal(calls, 0);
});

test('POST project task execution rejects an invalid public task before execution', async () => {
  let calls = 0;
  const app = createApp(loadConfig({}), {
    projectRegistrySource: orchestrationRegistry(),
    projectTaskExecutionExecutor: async () => {
      calls += 1;
      return { ok: false, status: 'failed', error: 'execution_failed' };
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await postProjectTaskExecution(baseUrl, {
      ...orchestrationTask(),
      instruction: '',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid_task' });
  });
  assert.equal(calls, 0);
});

test('POST project task execution maps safe deterministic errors', async () => {
  const scenarios = [
    ['invalid_task', 400],
    ['project_not_found', 404],
    ['project_disabled', 403],
    ['human_approval_required', 409],
    ['timeout', 504],
    ['codex_execution_failed', 502],
    ['missing_repository_read', 403],
    ['missing_isolated_worktree_write', 403],
  ];
  for (const [error, status] of scenarios) {
    let calls = 0;
    const app = createApp(loadConfig({}), {
      projectRegistrySource: orchestrationRegistry(),
      projectTaskExecutionExecutor: async () => {
        calls += 1;
        return {
          ok: false,
          status: 'failed',
          error,
          repositoryRoot: '/private/repos/lia-agent',
          stderr: 'internal failure',
        };
      },
    });
    await withServer(app, async (baseUrl) => {
      const response = await postProjectTaskExecution(baseUrl, orchestrationTask());
      assert.equal(response.status, status, error);
      assert.deepEqual(await response.json(), { ok: false, error });
    });
    assert.equal(calls, 1, error);
  }
});

test('GET project task execution returns 405 with Allow POST', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/tasks/execute`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.equal((await response.json()).error, 'method_not_allowed');
  });
});
