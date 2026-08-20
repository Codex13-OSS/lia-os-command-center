import type { LiaUserProfile } from '../domain/liaUserProfile';

export type LiaPersonalUser = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
};

export type LiaPersonalAccount = {
  user: LiaPersonalUser;
  profile: LiaUserProfile;
};

export type LiaPersonalSession =
  | { authenticated: false }
  | ({ authenticated: true } & LiaPersonalAccount);

export class LiaPersonalAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'LiaPersonalAuthError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(`/api/lia-agent/personal-auth/${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw new LiaPersonalAuthError('invalid_server_response');
  }

  if (!response.ok || payload.ok === false) {
    throw new LiaPersonalAuthError(
      typeof payload.error === 'string' ? payload.error : 'request_failed',
    );
  }

  return payload as T;
}

export function readLiaPersonalSession(): Promise<LiaPersonalSession> {
  return request<LiaPersonalSession>('session');
}

export function registerLiaPersonalAccount(input: {
  email: string;
  password: string;
  displayName: string;
  profile: LiaUserProfile;
}): Promise<LiaPersonalAccount> {
  return request<LiaPersonalAccount>('register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function loginLiaPersonalAccount(input: {
  email: string;
  password: string;
}): Promise<LiaPersonalAccount> {
  return request<LiaPersonalAccount>('login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function saveLiaPersonalProfile(
  profile: LiaUserProfile,
): Promise<LiaPersonalAccount> {
  return request<LiaPersonalAccount>('profile', {
    method: 'PUT',
    body: JSON.stringify({ profile }),
  });
}

export async function logoutLiaPersonalAccount(): Promise<void> {
  await request<{ ok: true }>('logout', { method: 'POST' });
}

export function explainLiaPersonalAuthError(error: unknown): string {
  const code = error instanceof LiaPersonalAuthError ? error.code : '';

  const messages: Record<string, string> = {
    invalid_email: 'Escribe un correo electrónico válido.',
    invalid_password: 'La contraseña debe tener entre 10 y 128 caracteres.',
    invalid_display_name: 'Escribe tu nombre.',
    invalid_profile: 'La configuración del perfil está incompleta.',
    email_already_registered: 'Ese correo ya tiene una cuenta. Inicia sesión.',
    invalid_credentials: 'El correo o la contraseña no son correctos.',
    unauthenticated: 'Tu sesión terminó. Vuelve a iniciar sesión.',
    origin_rejected: 'La solicitud no pertenece a este entorno de LÍA.',
    rate_limited: 'Demasiados intentos. Espera unos minutos.',
    personal_accounts_disabled: 'Las cuentas personales todavía no están activas.',
    invalid_server_response: 'LÍA recibió una respuesta no válida.',
  };

  return messages[code] ?? 'No fue posible completar la operación. Intenta nuevamente.';
}
