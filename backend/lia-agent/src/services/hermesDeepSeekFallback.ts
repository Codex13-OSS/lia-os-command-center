import { readFile } from 'node:fs/promises';

export const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';
export const HERMES_DEEPSEEK_PROVIDER = 'deepseek';
export const HERMES_DEEPSEEK_MODEL = 'deepseek-v4-flash';
export const HERMES_DEEPSEEK_ENV_FILE = '/home/hermes-agent/.hermes/.env';

/**
 * Unmistakable exhausted-account or quota conditions only. Bare HTTP 429,
 * generic rate-limit text, timeouts, auth failures and network errors are
 * intentionally not recognized here.
 */
const HERMES_QUOTA_USAGE_LIMIT_MARKERS: readonly string[] = [
  'the usage limit has been reached',
  "you've hit your usage limit",
  'youve hit your usage limit',
  "you've reached your usage limit",
  'insufficient_quota',
  'exceeded your current quota',
  'quota exceeded',
  'workspace credit limit',
  'workspace is out of credits',
];

export function isHermesQuotaUsageLimitFailure(stdout: string, stderr: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return HERMES_QUOTA_USAGE_LIMIT_MARKERS.some((marker) => output.includes(marker));
}

/**
 * Execution-time DeepSeek secret resolution. Prefers DEEPSEEK_API_KEY already
 * present in the given environment; otherwise reads the protected env file and
 * parses only the exact DEEPSEEK_API_KEY= line. Returns undefined (fail closed)
 * when the key is absent or empty. The value is never logged, written to source
 * or exposed through public contracts.
 */
export async function loadHermesDeepSeekSecret(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = HERMES_DEEPSEEK_ENV_FILE,
): Promise<string | undefined> {
  const fromEnv = env[DEEPSEEK_API_KEY_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv;
  }

  let content: string;
  try {
    content = await readFile(envFilePath, 'utf8');
  } catch {
    return undefined;
  }

  const prefix = `${DEEPSEEK_API_KEY_ENV}=`;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) {
      continue;
    }
    let value = line.slice(prefix.length).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value === '' ? undefined : value;
  }

  return undefined;
}
