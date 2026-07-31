export type LiaAgentBackendHealthSnapshot = {
  ok: true;
  service: 'lia-agent-backend';
  mode: 'read_only_foundation';
  version: string;
  realActionsEnabled: false;
  voiceEnabled: false;
  whatsappEnabled: false;
  memoryWriteEnabled: false;
  externalModelsEnabled: false;
  transport: 'local_http_only';
  frontendConnected: false;
  secretsLoaded: false;
};

export const LIA_AGENT_BACKEND_VERSION = 'v5.0.1';

export function createHealthSnapshot(): LiaAgentBackendHealthSnapshot {
  return {
    ok: true,
    service: 'lia-agent-backend',
    mode: 'read_only_foundation',
    version: LIA_AGENT_BACKEND_VERSION,
    realActionsEnabled: false,
    voiceEnabled: false,
    whatsappEnabled: false,
    memoryWriteEnabled: false,
    externalModelsEnabled: false,
    transport: 'local_http_only',
    frontendConnected: false,
    secretsLoaded: false,
  };
}
