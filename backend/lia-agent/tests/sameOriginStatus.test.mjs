import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createControlledSameOriginStatusRead } from '../dist/contracts/sameOriginStatus.js';

const clientPath = new URL('../../../frontend/src/integrations/liaSameOriginStatusAdapterClient.ts', import.meta.url);
const scaffoldPath = new URL('../../../scripts/lia-controlled-same-origin-status-read-server.mjs', import.meta.url);
const routePath = new URL('../src/routes/sameOriginStatus.ts', import.meta.url);

test('backend exposes a controlled same-origin status read with only safe read-only flags', () => {
  const payload = createControlledSameOriginStatusRead();
  assert.deepEqual(payload, {
    ok: true,
    source: 'lia-agent-backend',
    mode: 'controlled_same_origin_status_read',
    backend: {
      reachable: true,
      service: 'lia-agent-backend',
      healthOk: true,
      version: 'v5.0.1',
    },
    safety: {
      realActionsEnabled: false,
      voiceEnabled: false,
      whatsappEnabled: false,
      memoryWriteEnabled: false,
      externalModelsEnabled: false,
      secretsLoaded: false,
    },
  });
  assert.equal(Object.hasOwn(payload, 'actions'), false);
  assert.equal(Object.hasOwn(payload.backend, 'path'), false);
});

test('backend status read satisfies the frontend same-origin adapter contract', async () => {
  const [client, route] = await Promise.all([readFile(clientPath, 'utf8'), readFile(routePath, 'utf8')]);
  assert.match(route, /router\.route\('\/api\/lia-agent\/health'\)/);
  assert.match(route, /createControlledSameOriginStatusRead\(\)/);
  assert.match(client, /LIA_SAME_ORIGIN_STATUS_ADAPTER_PATH = '\/api\/lia-agent\/health'/);
  assert.match(client, /mode === 'controlled_same_origin_status_read'/);
  for (const flag of [
    'realActionsEnabled',
    'voiceEnabled',
    'whatsappEnabled',
    'memoryWriteEnabled',
    'externalModelsEnabled',
    'secretsLoaded',
  ]) {
    assert.match(client, new RegExp(`${flag} === false`));
  }
});

test('backend status read matches the production controlled adapter success shape', async () => {
  const [scaffold, payload] = await Promise.all([
    readFile(scaffoldPath, 'utf8'),
    Promise.resolve(JSON.stringify(createControlledSameOriginStatusRead())),
  ]);
  assert.match(scaffold, /mode: 'controlled_same_origin_status_read'/);
  assert.match(scaffold, /reachable: true/);
  assert.match(scaffold, /service: 'lia-agent-backend'/);
  assert.match(scaffold, /healthOk: true/);
  assert.match(scaffold, /realActionsEnabled: false/);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.backend.reachable, true);
  assert.equal(parsed.safety.secretsLoaded, false);
});
