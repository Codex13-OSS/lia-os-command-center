import { spawn } from 'node:child_process';
import type { LiaAgentConfig } from '../config.js';

export type HermesExecutionResult =
  | { ok: true; response: string }
  | { ok: false; error: 'execution_disabled' | 'timeout' | 'execution_failed' | 'empty_response' };

const MAX_OUTPUT_BYTES = 64 * 1024;

function cleanOutput(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/^session_id:.*$/gim, '')
    .replace(/^\s*⚠.*$/gim, '')
    .trim();
}

export async function executeHermesQuery(
  config: LiaAgentConfig,
  query: string,
): Promise<HermesExecutionResult> {
  if (!config.hermesExecutionEnabled) {
    return { ok: false, error: 'execution_disabled' };
  }

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
    config.hermesExecutable,
    'chat',
    '-Q',
    '--ignore-rules',
    '--provider',
    config.hermesProvider,
    '-m',
    config.hermesModel,
    '--source',
    'tool',
    '--max-turns',
    '1',
    '-q',
    query,
  ];

  return new Promise((resolve) => {
    const child = spawn('/usr/sbin/runuser', args, {
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

    const finish = (result: HermesExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
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

    child.on('error', () => finish({ ok: false, error: 'execution_failed' }));

    child.on('close', (code) => {
      if (settled) return;

      if (code !== 0) {
        finish({ ok: false, error: 'execution_failed' });
        return;
      }

      const response = cleanOutput(stdout || stderr);

      if (response === '') {
        finish({ ok: false, error: 'empty_response' });
        return;
      }

      finish({ ok: true, response });
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      finish({ ok: false, error: 'timeout' });
    }, config.hermesTimeoutMs);

    timer.unref();
  });
}
