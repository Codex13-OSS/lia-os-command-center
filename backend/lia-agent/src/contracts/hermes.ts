export type HermesIntegrationState =
  | 'unconfigured'
  | 'available'
  | 'unavailable';

export type HermesAdapterMode =
  | 'read_only_adapter_foundation'
  | 'guarded_prompt_execution';

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
  mode: HermesAdapterMode;
  configured: boolean;
  runtimeDetected: boolean;
  state: HermesIntegrationState;
  requiredMarkers: number;
  detectedMarkers: number;
  executionEnabled: boolean;
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
    promptExecution: boolean;
    toolExecution: false;
    memoryWrite: false;
    channelDelivery: false;
  };
};

export function createHermesStatusSnapshot(
  probe: HermesRuntimeProbe,
  executionEnabled: boolean,
): HermesStatusSnapshot {
  return {
    ok: true,
    service: 'lia-agent-backend',
    integration: 'hermes',
    mode: executionEnabled
      ? 'guarded_prompt_execution'
      : 'read_only_adapter_foundation',
    configured: probe.configured,
    runtimeDetected: probe.runtimeDetected,
    state: probe.state,
    requiredMarkers: probe.requiredMarkers,
    detectedMarkers: probe.detectedMarkers,
    executionEnabled,
    toolsEnabled: false,
    memoryWriteEnabled: false,
    handoffEnabled: false,
    multiplexEnabled: false,
    isolationStrategy: 'one_process_per_tenant',
  };
}

export function createHermesContractsSnapshot(
  executionEnabled: boolean,
): HermesContractsSnapshot {
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
      promptExecution: executionEnabled,
      toolExecution: false,
      memoryWrite: false,
      channelDelivery: false,
    },
  };
}
