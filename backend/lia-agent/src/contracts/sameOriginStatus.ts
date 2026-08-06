import { createHealthSnapshot, LIA_AGENT_BACKEND_VERSION } from './health.js';

export type LiaSameOriginSafetySnapshot = {
  realActionsEnabled: false;
  voiceEnabled: false;
  whatsappEnabled: false;
  memoryWriteEnabled: false;
  externalModelsEnabled: false;
  secretsLoaded: false;
};

export type LiaSameOriginBackendSnapshot = {
  reachable: true;
  service: 'lia-agent-backend';
  healthOk: true;
  version: string;
};

export type LiaControlledSameOriginStatusRead = {
  ok: true;
  source: 'lia-agent-backend';
  mode: 'controlled_same_origin_status_read';
  backend: LiaSameOriginBackendSnapshot;
  safety: LiaSameOriginSafetySnapshot;
};

/**
 * Controlled same-origin status read served by the TypeScript backend at
 * GET /api/lia-agent/health. Mirrors the production scaffold contract so the
 * frontend same-origin adapter can verify real backend connectivity in the
 * vite dev/preview path, where the scaffold's separate controlled adapter is
 * not running. Only read-only flags are exposed; nothing here grants actions.
 */
export function createControlledSameOriginStatusRead(): LiaControlledSameOriginStatusRead {
  const health = createHealthSnapshot();
  return {
    ok: true,
    source: 'lia-agent-backend',
    mode: 'controlled_same_origin_status_read',
    backend: {
      reachable: true,
      service: 'lia-agent-backend',
      healthOk: health.ok,
      version: LIA_AGENT_BACKEND_VERSION,
    },
    safety: {
      realActionsEnabled: health.realActionsEnabled,
      voiceEnabled: health.voiceEnabled,
      whatsappEnabled: health.whatsappEnabled,
      memoryWriteEnabled: health.memoryWriteEnabled,
      externalModelsEnabled: health.externalModelsEnabled,
      secretsLoaded: health.secretsLoaded,
    },
  };
}
