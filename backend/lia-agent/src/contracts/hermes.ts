export type HermesIntegrationState = 'unconfigured' | 'available' | 'unavailable';

export type HermesRuntimeProbe = {
  configured: boolean;
  runtimeDetected: boolean;
  state: HermesIntegrationState;
  requiredMarkers: number;
  detectedMarkers: number;
};

export type HermesStatusSnapshot = {
  ok: true;
  service: 'lia-agent-backend';
  integration: 'hermes';
  mode: 'read_only_adapter_foundation';
  configured: boolean;
  runtimeDetected: boolean;
  state: HermesIntegrationState;
  requiredMarkers: number;
  detectedMarkers: number;
  executionEnabled: false;
  toolsEnabled: false;
  memoryWriteEnabled: false;
  handoffEnabled: false;
  multiplexEnabled: false;
  isolationStrategy: 'one_process_per_tenant';
};

export type HermesContractsSnapshot = {
  ok: true;
  service: 'lia-agent-backend';
  integration: 'hermes';
  adapterMode: 'external_process_boundary';
  tenantIsolation: 'one_process_per_tenant';
  failClosed: true;
  directDatabaseAccess: false;
  secretsInherited: false;
  pluginAllowlistRequired: true;
  handoffEnabled: false;
  multiplexEnabled: false;
  capabilities: {
    runtimeProbe: true;
    promptExecution: false;
    toolExecution: false;
    memoryWrite: false;
    channelDelivery: false;
  };
};

export function createHermesStatusSnapshot(probe: HermesRuntimeProbe): HermesStatusSnapshot {
  return {
    ok: true,
    service: 'lia-agent-backend',
    integration: 'hermes',
    mode: 'read_only_adapter_foundation',
    configured: probe.configured,
    runtimeDetected: probe.runtimeDetected,
    state: probe.state,
    requiredMarkers: probe.requiredMarkers,
    detectedMarkers: probe.detectedMarkers,
    executionEnabled: false,
    toolsEnabled: false,
    memoryWriteEnabled: false,
    handoffEnabled: false,
    multiplexEnabled: false,
    isolationStrategy: 'one_process_per_tenant',
  };
}

export function createHermesContractsSnapshot(): HermesContractsSnapshot {
  return {
    ok: true,
    service: 'lia-agent-backend',
    integration: 'hermes',
    adapterMode: 'external_process_boundary',
    tenantIsolation: 'one_process_per_tenant',
    failClosed: true,
    directDatabaseAccess: false,
    secretsInherited: false,
    pluginAllowlistRequired: true,
    handoffEnabled: false,
    multiplexEnabled: false,
    capabilities: {
      runtimeProbe: true,
      promptExecution: false,
      toolExecution: false,
      memoryWrite: false,
      channelDelivery: false,
    },
  };
}
