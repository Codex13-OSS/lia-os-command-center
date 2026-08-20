export const LIA_HERMES_STATUS_PATH = '/api/lia-agent/hermes/status';

const LIA_HERMES_STATUS_TIMEOUT_MS = 2_500;

export type LiaHermesUiStatus =
  | { state: 'available'; label: 'Hermes disponible' }
  | { state: 'unavailable'; label: 'Hermes no disponible' }
  | { state: 'checking'; label: 'Comprobando Hermes…' };

export type LiaHermesRuntimeStatus = {
  state: 'available' | 'unavailable';
  configured: boolean;
  runtimeDetected: boolean;
  executionEnabled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readHermesStatusBody(): Promise<Record<string, unknown> | null> {
  if (typeof fetch !== 'function') return null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller && typeof window !== 'undefined'
    ? window.setTimeout(() => controller.abort(), LIA_HERMES_STATUS_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(LIA_HERMES_STATUS_PATH, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
    });
    const body: unknown = await response.json().catch(() => null);
    return response.ok && isRecord(body) && body.ok === true && body.integration === 'hermes' ? body : null;
  } catch {
    return null;
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}

export async function readLiaHermesStatus(): Promise<LiaHermesRuntimeStatus> {
  const body = await readHermesStatusBody();
  const configured = body?.configured === true;
  const runtimeDetected = body?.runtimeDetected === true;
  const executionEnabled = body?.executionEnabled === true;
  return {
    state: body?.state === 'available' && configured && runtimeDetected && executionEnabled ? 'available' : 'unavailable',
    configured,
    runtimeDetected,
    executionEnabled,
  };
}

export async function readLiaHermesUiStatus(): Promise<LiaHermesUiStatus> {
  const status = await readLiaHermesStatus();
  return status.state === 'available'
    ? { state: 'available', label: 'Hermes disponible' }
    : { state: 'unavailable', label: 'Hermes no disponible' };
}
