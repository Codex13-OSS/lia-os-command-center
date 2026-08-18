import { LIA_AGENT_BACKEND_VERSION } from './health.js';

export type DisabledCapability = {
  enabled: false;
  status: 'disabled';
};

export type LiaAgentBackendCapabilities = {
  memoryWrite: DisabledCapability;
  externalModels: DisabledCapability;
  voice: DisabledCapability;
  whatsapp: DisabledCapability;
  email: DisabledCapability;
  documentActions: DisabledCapability;
  realActions: DisabledCapability;
};

export type LiaAgentBackendStatus = {
  ok: true;
  service: 'lia-agent-backend';
  status: 'online';
  version: string;
  hostBinding: 'local_loopback_only';
  mode: 'read_only_foundation';
  transport: 'local_http_only';
  integrations: 'disabled';
  capabilities: LiaAgentBackendCapabilities;
};

const disabledCapability: DisabledCapability = {
  enabled: false,
  status: 'disabled',
};

export function createStatusSnapshot(): LiaAgentBackendStatus {
  return {
    ok: true,
    service: 'lia-agent-backend',
    status: 'online',
    version: LIA_AGENT_BACKEND_VERSION,
    hostBinding: 'local_loopback_only',
    mode: 'read_only_foundation',
    transport: 'local_http_only',
    integrations: 'disabled',
    capabilities: {
      memoryWrite: { ...disabledCapability },
      externalModels: { ...disabledCapability },
      voice: { ...disabledCapability },
      whatsapp: { ...disabledCapability },
      email: { ...disabledCapability },
      documentActions: { ...disabledCapability },
      realActions: { ...disabledCapability },
    },
  };
}
