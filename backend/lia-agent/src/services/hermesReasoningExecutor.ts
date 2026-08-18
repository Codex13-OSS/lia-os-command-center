import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import type { LiaAgentConfig } from '../config.js';
import type {
  HermesExecutionResult,
  HermesQueryExecutor,
} from './hermesExecutor.js';

const MAX_OUTPUT_BYTES = 64 * 1024;
const TOOL_SURFACE_VIOLATION_MARKER = 'LIA_HERMES_REASONING_TOOL_SURFACE_VIOLATION';

const REASONING_ONLY_RUNNER = String.raw`
import json
import logging
import os
import sys

for name in ("HERMES_INTERACTIVE", "HERMES_YOLO_MODE", "HERMES_ACCEPT_HOOKS"):
    os.environ.pop(name, None)

logging.disable(logging.CRITICAL)

from hermes_cli.config import load_config
from hermes_cli.fallback_config import get_fallback_chain
from hermes_cli.runtime_provider import resolve_runtime_provider
from run_agent import AIAgent

request = json.load(sys.stdin)
model = request["model"]
provider = request["provider"]
config = load_config()
runtime = resolve_runtime_provider(requested=provider, target_model=model)
fallback_chain = get_fallback_chain(config)

agent = None
try:
    agent = AIAgent(
        api_key=runtime.get("api_key"),
        base_url=runtime.get("base_url"),
        provider=runtime.get("provider"),
        requested_provider=runtime.get("requested_provider"),
        api_mode=runtime.get("api_mode"),
        model=model,
        enabled_toolsets=[],
        disabled_toolsets=[],
        quiet_mode=True,
        skip_memory=True,
        skip_context_files=True,
        save_trajectories=False,
        platform="cli",
        credential_pool=runtime.get("credential_pool"),
        fallback_model=fallback_chain or None,
    )

    tools = getattr(agent, "tools", None)
    valid_tool_names = getattr(agent, "valid_tool_names", None)
    if not isinstance(tools, list) or tools or valid_tool_names is None or bool(valid_tool_names):
        sys.stderr.write("${TOOL_SURFACE_VIOLATION_MARKER}\n")
        raise SystemExit(78)

    agent.suppress_status_output = True
    agent.stream_delta_callback = None
    agent.tool_gen_callback = None
    result = agent.run_conversation(request["query"])
    response = result.get("final_response") or ""
    sys.stdout.write(response)
finally:
    if agent is not None:
        try:
            agent.close()
        except Exception:
            pass
`;

export type HermesReasoningInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
};

export function buildHermesReasoningInvocation(
  config: LiaAgentConfig,
  query: string,
): HermesReasoningInvocation {
  const pythonExecutable = join(
    config.hermesHome,
    'hermes-agent',
    'venv',
    'bin',
    'python',
  );

  return {
    command: '/usr/sbin/runuser',
    args: [
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
      pythonExecutable,
      '-c',
      REASONING_ONLY_RUNNER,
    ],
    cwd: config.hermesUserHome,
    env: {
      PATH: '/usr/sbin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
    input: JSON.stringify({
      query,
      provider: config.hermesProvider,
      model: config.hermesModel,
    }),
  };
}

function cleanOutput(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/^session_id:.*$/gim, '')
    .replace(/^\s*⚠.*$/gim, '')
    .trim();
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  return Buffer.from(current + chunk.toString('utf8'))
    .subarray(0, MAX_OUTPUT_BYTES)
    .toString('utf8');
}

type SpawnProcess = typeof spawn;

export function createHermesReasoningOnlyExecutor(
  spawnProcess: SpawnProcess,
): HermesQueryExecutor {
  return async (config, query) => {
    if (!config.hermesExecutionEnabled) {
      return { ok: false, error: 'execution_disabled' };
    }

    const invocation = buildHermesReasoningInvocation(config, query);

    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnProcess(invocation.command, invocation.args, {
          cwd: invocation.cwd,
          env: invocation.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        resolve({ ok: false, error: 'execution_failed' });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: HermesExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.stdin.on('error', () => {
        finish({ ok: false, error: 'execution_failed' });
      });
      child.on('error', () => finish({ ok: false, error: 'execution_failed' }));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0 || stderr.includes(TOOL_SURFACE_VIOLATION_MARKER)) {
          finish({ ok: false, error: 'execution_failed' });
          return;
        }

        const response = cleanOutput(stdout);
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

      child.stdin.end(invocation.input);
    });
  };
}

export const executeHermesReasoningOnly = createHermesReasoningOnlyExecutor(spawn);
