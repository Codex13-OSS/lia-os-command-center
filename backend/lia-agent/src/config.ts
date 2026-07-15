export type LiaAgentConfig = {
  host: string;
  port: number;
  corsOrigins: string[];
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
    logLevel: parseLogLevel(env.LIA_AGENT_LOG_LEVEL),
  };
}
