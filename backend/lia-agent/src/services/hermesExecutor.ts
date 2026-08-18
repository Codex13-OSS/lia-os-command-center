import { spawn } from 'node:child_process';
import type { LiaAgentConfig } from '../config.js';
import {
  DEEPSEEK_API_KEY_ENV,
  HERMES_DEEPSEEK_ENV_FILE,
  HERMES_DEEPSEEK_MODEL,
  HERMES_DEEPSEEK_PROVIDER,
  isHermesQuotaUsageLimitFailure,
  loadHermesDeepSeekSecret,
} from './hermesDeepSeekFallback.js';

export type HermesExecutionResult =
  | { ok: true; response: string }
  | { ok: false; error: 'execution_disabled' | 'timeout' | 'execution_failed' | 'empty_response' };

export type HermesQueryExecutor = (
  config: LiaAgentConfig,
  query: string,
) => Promise<HermesExecutionResult>;

export type HermesExecutorDependencies = {
  spawnProcess?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  secretEnvFile?: string;
  secretLoader?: () => Promise<string | undefined>;
};

const MAX_OUTPUT_BYTES = 64 * 1024;

function cleanOutput(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/^session_id:.*$/gim, '')
    .replace(/^\s*⚠.*$/gim, '')
    .trim();
}

type HermesAttemptOutcome =
  | { kind: 'timeout' }
  | { kind: 'empty' }
  | { kind: 'success'; response: string }
  | { kind: 'failed'; stdout: string; stderr: string };

function outcomeToResult(outcome: HermesAttemptOutcome): HermesExecutionResult {
  switch (outcome.kind) {
    case 'timeout':
      return { ok: false, error: 'timeout' };
    case 'empty':
      return { ok: false, error: 'empty_response' };
    case 'success':
      return { ok: true, response: outcome.response };
    case 'failed':
      return { ok: false, error: 'execution_failed' };
  }
}

function runHermesAttempt(
  config: LiaAgentConfig,
  query: string,
  provider: string,
  model: string,
  extraEnvArgs: readonly string[],
  spawnProcess: typeof spawn,
): Promise<HermesAttemptOutcome> {
  const args = [
    '-u',
    config.hermesUser,
    '--',
    'env',
    '-i',
    `HOME=${config.hermesUserHome}`,
    `USER=${config.hermesUser}`,
    `LOGNAME=${config.hermesUser}`,
    `PATH=${config.hermesPath}`,
    `HERMES_HOME=${config.hermesHome}`,
    'TERM=dumb',
    'NO_COLOR=1',
    ...extraEnvArgs,
    config.hermesExecutable,
    'chat',
    '-Q',
    '--ignore-rules',
    '--provider',
    provider,
    '-m',
    model,
    '--source',
    'tool',
    '--max-turns',
    '1',
    '-q',
    query,
  ];

  return new Promise((resolve) => {
    const child = spawnProcess('/usr/sbin/runuser', args, {
      cwd: config.hermesUserHome,
      env: {
        PATH: '/usr/sbin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (outcome: HermesAttemptOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const appendBounded = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
      return (current + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on('error', () => finish({ kind: 'failed', stdout, stderr }));

    child.on('close', (code) => {
      if (settled) return;

      if (code !== 0) {
        finish({ kind: 'failed', stdout, stderr });
        return;
      }

      const response = cleanOutput(stdout || stderr);

      if (response === '') {
        finish({ kind: 'empty' });
        return;
      }

      finish({ kind: 'success', response });
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      finish({ kind: 'timeout' });
    }, config.hermesTimeoutMs);

    timer.unref();
  });
}

export async function executeHermesQuery(
  config: LiaAgentConfig,
  query: string,
  dependencies: HermesExecutorDependencies = {},
): Promise<HermesExecutionResult> {
  if (!config.hermesExecutionEnabled) {
    return { ok: false, error: 'execution_disabled' };
  }

  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const secretLoader = dependencies.secretLoader
    ?? (() => loadHermesDeepSeekSecret(dependencies.env, dependencies.secretEnvFile ?? HERMES_DEEPSEEK_ENV_FILE));

  const primary = await runHermesAttempt(
    config,
    query,
    config.hermesProvider,
    config.hermesModel,
    [],
    spawnProcess,
  );

  if (primary.kind !== 'failed') {
    return outcomeToResult(primary);
  }

  if (isHermesQuotaUsageLimitFailure(primary.stdout, primary.stderr)) {
    const secret = await secretLoader();
    if (secret !== undefined && secret.trim() !== '') {
      const fallback = await runHermesAttempt(
        config,
        query,
        HERMES_DEEPSEEK_PROVIDER,
        HERMES_DEEPSEEK_MODEL,
        [`${DEEPSEEK_API_KEY_ENV}=${secret}`],
        spawnProcess,
      );
      return outcomeToResult(fallback);
    }
  }

  return { ok: false, error: 'execution_failed' };
}
