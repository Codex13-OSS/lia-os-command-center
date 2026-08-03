import {
  createSafeSameOriginStatusAdapterFallback,
  type LiaSameOriginStatusAdapterState,
  type LiaSameOriginStatusAdapterViewModel,
} from './liaSameOriginStatusAdapterContract';

export const LIA_SAME_ORIGIN_STATUS_ADAPTER_PATH = '/lia/api/lia-agent/health';
export const LIA_SAME_ORIGIN_STATUS_ADAPTER_TIMEOUT_MS = 1200;

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function hasSafeSafetyFlags(safety: Record<string, unknown>) {
  return (
    safety.realActionsEnabled === false &&
    safety.voiceEnabled === false &&
    safety.whatsappEnabled === false &&
    safety.memoryWriteEnabled === false &&
    safety.externalModelsEnabled === false &&
    safety.secretsLoaded === false
  );
}

function toViewModel(
  state: LiaSameOriginStatusAdapterState,
  backendReachable: boolean,
  backendVersion: string | null,
): LiaSameOriginStatusAdapterViewModel {
  const statusLabel: Record<LiaSameOriginStatusAdapterState, LiaSameOriginStatusAdapterViewModel['statusLabel']> = {
    connected_safe: 'Conectado seguro',
    degraded_safe: 'Degradado seguro',
    fallback_safe: 'Lectura preparada',
  };

  return {
    state,
    statusLabel: statusLabel[state],
    sourceLabel: state === 'connected_safe' ? 'Adapter same-origin' : 'Fallback seguro',
    summary: 'Lectura de estado preparada sin comandos, sin escritura y con acciones reales protegidas.',
    backendReachable,
    backendVersion,
    safety: {
      realActionsProtected: true,
      voiceProtected: true,
      channelsProtected: true,
      memoryProtected: true,
      modelsProtected: true,
      credentialsProtected: true,
    },
  };
}

function normalizeControlledSameOriginStatus(input: unknown): LiaSameOriginStatusAdapterViewModel {
  if (!isRecord(input)) {
    return createSafeSameOriginStatusAdapterFallback('degraded_safe');
  }

  const backend = input.backend;
  const safety = input.safety;

  if (!isRecord(backend) || !isRecord(safety) || !hasSafeSafetyFlags(safety)) {
    return createSafeSameOriginStatusAdapterFallback('degraded_safe');
  }

  const isControlledRead =
    input.ok === true &&
    input.source === 'lia-agent-backend' &&
    input.mode === 'controlled_same_origin_status_read' &&
    backend.reachable === true &&
    backend.service === 'lia-agent-backend' &&
    backend.healthOk === true;

  const isMockRead =
    input.ok === true &&
    input.source === 'lia-agent-backend' &&
    input.mode === 'read_only_status_adapter' &&
    backend.reachable === true &&
    backend.service === 'lia-agent-backend' &&
    backend.healthOk === true;

  if (isControlledRead || isMockRead) {
    return toViewModel(
      'connected_safe',
      true,
      typeof backend.version === 'string' && backend.version.length > 0 ? backend.version : null,
    );
  }

  return createSafeSameOriginStatusAdapterFallback('degraded_safe');
}

function createAbortController() {
  if (typeof AbortController === 'undefined') {
    return null;
  }

  return new AbortController();
}

export function getLiaSameOriginStatusAdapterClientSafetyProbe() {
  return [
    LIA_SAME_ORIGIN_STATUS_ADAPTER_PATH,
    String(LIA_SAME_ORIGIN_STATUS_ADAPTER_TIMEOUT_MS),
    hasSafeSafetyFlags.toString(),
    normalizeControlledSameOriginStatus.toString(),
    createAbortController.toString(),
    readLiaSameOriginStatusAdapter.toString(),
  ].join('\n');
}

export async function readLiaSameOriginStatusAdapter(): Promise<LiaSameOriginStatusAdapterViewModel> {
  if (typeof fetch !== 'function') {
    return createSafeSameOriginStatusAdapterFallback('fallback_safe');
  }

  const controller = createAbortController();
  const timeoutId =
    controller && typeof window !== 'undefined'
      ? window.setTimeout(() => controller.abort(), LIA_SAME_ORIGIN_STATUS_ADAPTER_TIMEOUT_MS)
      : null;

  try {
    const response = await fetch(LIA_SAME_ORIGIN_STATUS_ADAPTER_PATH, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller?.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return createSafeSameOriginStatusAdapterFallback('degraded_safe');
    }

    const body: unknown = await response.json();
    return normalizeControlledSameOriginStatus(body);
  } catch {
    return createSafeSameOriginStatusAdapterFallback('degraded_safe');
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}
