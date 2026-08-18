export const LIA_HERMES_STATUS_PATH = '/api/lia-agent/hermes/status';

const LIA_HERMES_STATUS_TIMEOUT_MS = 2_500;

export type LiaHermesUiStatus =
  | {
      state: 'available';
      label: 'Hermes disponible';
    }
  | {
      state: 'unavailable';
      label: 'Hermes no disponible';
    }
  | {
      state: 'checking';
      label: 'Comprobando Hermes…';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function readLiaHermesUiStatus(): Promise<LiaHermesUiStatus> {
  if (typeof fetch !== 'function') {
    return {
      state: 'unavailable',
      label: 'Hermes no disponible',
    };
  }

  const controller =
    typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;

  const timeoutId =
    controller && typeof window !== 'undefined'
      ? window.setTimeout(
          () => controller.abort(),
          LIA_HERMES_STATUS_TIMEOUT_MS,
        )
      : null;

  try {
    const response = await fetch(LIA_HERMES_STATUS_PATH, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller?.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    const body: unknown = await response.json().catch(() => null);

    if (
      response.ok &&
      isRecord(body) &&
      body.ok === true &&
      body.integration === 'hermes' &&
      body.state === 'available' &&
      body.configured === true &&
      body.runtimeDetected === true &&
      body.executionEnabled === true
    ) {
      return {
        state: 'available',
        label: 'Hermes disponible',
      };
    }

    return {
      state: 'unavailable',
      label: 'Hermes no disponible',
    };
  } catch {
    return {
      state: 'unavailable',
      label: 'Hermes no disponible',
    };
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}
