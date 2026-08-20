export type LiaServerInventory = {
  ok: true;
  source: 'contabo_host_runtime';
  mode: 'read_only_server_inventory';
  generatedAt: string;
  capabilities: {
    pm2: boolean;
    systemd: boolean;
    docker: boolean;
    ports: boolean;
    filesystem: boolean;
  };
  pm2: Array<{
    name: string;
    status: string;
    pid: number;
    cpuPercent: number;
    memoryBytes: number;
  }>;
  systemServices: string[];
  containers: Array<{
    name: string;
    status: string;
    image: string;
  }>;
  ports: number[];
  roots: Array<{
    path: string;
    entries: Array<{
      name: string;
      type: 'directory' | 'file' | 'link' | 'other';
    }>;
  }>;
  safety: {
    readOnly: true;
    actionsEnabled: false;
    processControlEnabled: false;
    serviceControlEnabled: false;
    fileWritesEnabled: false;
    shellExecutionExposed: false;
    arbitraryPathReadEnabled: false;
  };
};

export async function readLiaServerInventory(): Promise<LiaServerInventory | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4500);

  try {
    const response = await fetch('/api/lia-agent/server/inventory', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const value = await response.json() as Partial<LiaServerInventory>;

    if (
      value.ok !== true ||
      value.mode !== 'read_only_server_inventory' ||
      value.safety?.readOnly !== true ||
      value.safety.actionsEnabled !== false ||
      value.safety.fileWritesEnabled !== false ||
      !Array.isArray(value.pm2) ||
      !Array.isArray(value.systemServices) ||
      !Array.isArray(value.containers) ||
      !Array.isArray(value.ports) ||
      !Array.isArray(value.roots)
    ) return null;

    return value as LiaServerInventory;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}
