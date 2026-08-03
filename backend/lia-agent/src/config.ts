import { isAbsolute } from 'node:path';

export type LiaAgentConfig = {
  host: string;
  port: number;
  corsOrigins: string[];
  agendaSqlitePath: string;
  projectRegistryPath: string;
  hermesRoot: string;
  hermesExecutionEnabled: boolean;
  hermesExecutable: string;
  hermesHome: string;
  hermesUser: string;
  hermesUserHome: string;
  hermesPath: string;
  hermesProvider: string;
  hermesModel: string;
  hermesTimeoutMs: number;
  hermesMaxQueryCharacters: number;
  logLevel: 'silent' | 'error' | 'warn' | 'info';
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3014;
const ALLOWED_LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info']);
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

function parsePort(rawPort: string | undefined): number {
  const candidate = rawPort === undefined || rawPort.trim() === '' ? String(DEFAULT_PORT) : rawPort.trim();

  if (!/^\d+$/.test(candidate)) {
    throw new Error('invalid_lia_agent_port');
  }

  const port = Number.parseInt(candidate, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid_lia_agent_port');
  }

  return port;
}

function parseCorsOrigins(rawOrigins: string | undefined): string[] {
  if (rawOrigins === undefined || rawOrigins.trim() === '') {
    return [];
  }

  return rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parseAgendaSqlitePath(rawPath: string | undefined): string {
  const candidate = rawPath?.trim() ?? '';

  if (candidate === '') {
    return '';
  }

  if (!isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error('invalid_lia_agenda_sqlite_path');
  }

  return candidate;
}

function parseProjectRegistryPath(rawPath: string | undefined): string {
  const candidate = rawPath?.trim() ?? '';

  if (candidate === '') {
    return '';
  }

  if (!isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error('invalid_lia_project_registry_path');
  }

  return candidate;
}

function parseHermesRoot(rawRoot: string | undefined): string {
  const candidate = rawRoot?.trim() ?? '';

  if (candidate === '') {
    return '';
  }

  if (!isAbsolute(candidate) || candidate.includes('\\0')) {
    throw new Error('invalid_lia_hermes_root');
  }

  return candidate;
}

function parseBoolean(rawValue: string | undefined): boolean {
  return rawValue?.trim().toLowerCase() === 'true';
}

function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
  errorCode: string,
): number {
  if (rawValue === undefined || rawValue.trim() === '') {
    return fallback;
  }

  if (!/^\d+$/.test(rawValue.trim())) {
    throw new Error(errorCode);
  }

  const value = Number.parseInt(rawValue.trim(), 10);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(errorCode);
  }

  return value;
}

function parseAbsolutePath(rawValue: string | undefined, fallback: string): string {
  const candidate = rawValue?.trim() || fallback;

  if (!isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error('invalid_lia_hermes_path');
  }

  return candidate;
}

function parseIdentifier(rawValue: string | undefined, fallback: string): string {
  const candidate = rawValue?.trim() || fallback;

  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(candidate)) {
    throw new Error('invalid_lia_hermes_identifier');
  }

  return candidate;
}

function parseLogLevel(rawLogLevel: string | undefined): LiaAgentConfig['logLevel'] {
  const candidate = rawLogLevel === undefined || rawLogLevel.trim() === '' ? 'info' : rawLogLevel.trim();

  if (ALLOWED_LOG_LEVELS.has(candidate)) {
    return candidate as LiaAgentConfig['logLevel'];
  }

  return 'info';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LiaAgentConfig {
  const host = env.LIA_AGENT_HOST?.trim() || DEFAULT_HOST;

  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error('invalid_lia_agent_host');
  }

  return {
    host,
    port: parsePort(env.LIA_AGENT_PORT),
    corsOrigins: parseCorsOrigins(env.LIA_AGENT_CORS_ORIGINS),
    agendaSqlitePath: parseAgendaSqlitePath(env.LIA_AGENDA_SQLITE_PATH),
    projectRegistryPath: parseProjectRegistryPath(env.LIA_PROJECT_REGISTRY_PATH),
    hermesRoot: parseHermesRoot(env.LIA_HERMES_ROOT),
    hermesExecutionEnabled: parseBoolean(env.LIA_HERMES_EXECUTION_ENABLED),
    hermesExecutable: parseAbsolutePath(
      env.LIA_HERMES_EXECUTABLE,
      '/home/hermes-agent/.local/bin/hermes',
    ),
    hermesHome: parseAbsolutePath(env.LIA_HERMES_HOME, '/home/hermes-agent/.hermes'),
    hermesUser: parseIdentifier(env.LIA_HERMES_USER, 'hermes-agent'),
    hermesUserHome: parseAbsolutePath(env.LIA_HERMES_USER_HOME, '/home/hermes-agent'),
    hermesPath: env.LIA_HERMES_PATH?.trim()
      || '/home/hermes-agent/.local/bin:/usr/local/bin:/usr/bin:/bin',
    hermesProvider: parseIdentifier(env.LIA_HERMES_PROVIDER, 'openai-codex'),
    hermesModel: parseIdentifier(env.LIA_HERMES_MODEL, 'gpt-5.6-terra'),
    hermesTimeoutMs: parsePositiveInteger(
      env.LIA_HERMES_TIMEOUT_MS,
      120_000,
      'invalid_lia_hermes_timeout',
    ),
    hermesMaxQueryCharacters: parsePositiveInteger(
      env.LIA_HERMES_MAX_QUERY_CHARACTERS,
      8_000,
      'invalid_lia_hermes_max_query_characters',
    ),
    logLevel: parseLogLevel(env.LIA_AGENT_LOG_LEVEL),
  };
}
