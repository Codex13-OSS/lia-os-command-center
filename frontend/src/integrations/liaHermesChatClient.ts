export const LIA_HERMES_CHAT_PATH = '/lia/api/lia-agent/query';

const LIA_HERMES_CHAT_TIMEOUT_MS = 125_000;
const LIA_HERMES_MAX_QUERY_CHARACTERS = 8_000;

export type LiaHermesChatResult =
  | {
      ok: true;
      model: string;
      response: string;
    }
  | {
      ok: false;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mapHermesError(error: unknown): string {
  switch (error) {
    case 'invalid_query':
      return 'La instrucción está vacía o supera el límite permitido.';
    case 'execution_disabled':
      return 'El núcleo de LÍA está temporalmente en modo seguro.';
    case 'timeout':
      return 'La consulta tardó más de lo permitido. Intenta nuevamente.';
    case 'empty_response':
      return 'LÍA no recibió una respuesta utilizable.';
    case 'execution_failed':
      return 'LÍA no pudo completar esta consulta.';
    case 'backend_unavailable':
      return 'El núcleo interno de LÍA no está disponible en este momento.';
    default:
      return 'No fue posible completar la consulta.';
  }
}

export async function requestLiaHermesResponse(query: string): Promise<LiaHermesChatResult> {
  const cleanQuery = query.trim();

  if (
    cleanQuery.length === 0 ||
    cleanQuery.length > LIA_HERMES_MAX_QUERY_CHARACTERS
  ) {
    return {
      ok: false,
      message: mapHermesError('invalid_query'),
    };
  }

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(),
    LIA_HERMES_CHAT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(LIA_HERMES_CHAT_PATH, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: cleanQuery,
      }),
    });

    const body: unknown = await response.json().catch(() => null);

    if (
      response.ok &&
      isRecord(body) &&
      body.ok === true &&
      body.integration === 'hermes' &&
      typeof body.model === 'string' &&
      typeof body.response === 'string' &&
      body.response.trim().length > 0
    ) {
      return {
        ok: true,
        model: body.model,
        response: body.response.trim(),
      };
    }

    return {
      ok: false,
      message: mapHermesError(isRecord(body) ? body.error : null),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof DOMException && error.name === 'AbortError'
          ? mapHermesError('timeout')
          : mapHermesError('backend_unavailable'),
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
