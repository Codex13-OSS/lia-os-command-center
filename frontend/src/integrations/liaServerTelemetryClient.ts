export type LiaServerTelemetry = {
  ok: true;
  source: 'contabo_host_runtime';
  mode: 'read_only_server_telemetry';
  generatedAt: string;
  node: {
    hostname: string;
    platform: string;
    architecture: string;
  };
  cpu: {
    percent: number;
    cores: number;
    model: string;
    load1: number;
    load5: number;
    load15: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    percent: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    percent: number;
  };
  uptimeSeconds: number;
  safety: {
    readOnly: true;
    actionsEnabled: false;
    processControlEnabled: false;
    fileWritesEnabled: false;
    serviceControlEnabled: false;
  };
};

export async function readLiaServerTelemetry(): Promise<LiaServerTelemetry | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch('/api/lia-agent/server/telemetry', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const value = await response.json() as Partial<LiaServerTelemetry>;

    if (
      value.ok !== true
      || value.mode !== 'read_only_server_telemetry'
      || value.safety?.readOnly !== true
      || value.safety.actionsEnabled !== false
      || typeof value.cpu?.percent !== 'number'
      || typeof value.memory?.percent !== 'number'
      || typeof value.disk?.percent !== 'number'
      || typeof value.uptimeSeconds !== 'number'
      || typeof value.node?.hostname !== 'string'
    ) return null;

    return value as LiaServerTelemetry;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}
