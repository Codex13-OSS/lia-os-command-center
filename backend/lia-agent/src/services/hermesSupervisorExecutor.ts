import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import type { LiaAgentConfig } from '../config.js';
import type {
  HermesExecutionResult,
  HermesQueryExecutor,
} from './hermesExecutor.js';

const MAX_OUTPUT_BYTES = 64 * 1024;
const TOOL_SURFACE_VIOLATION_MARKER = 'LIA_HERMES_SUPERVISOR_TOOL_SURFACE_VIOLATION';
const UNSAFE_DELEGATION_CONFIG_MARKER = 'LIA_HERMES_SUPERVISOR_UNSAFE_DELEGATION_CONFIG';
const SUPERVISOR_PROFILE_NAME = 'lia-supervisor';

/**
 * Pure Python delegation safety gate for Supervisor Executor V1.
 *
 * Stdlib-only and free of any Hermes imports so it can be unit-tested in
 * isolation (see tests/hermesSupervisorExecutor.test.mjs) and embedded into
 * the supervisor runner verbatim. All decisions are deterministic:
 *
 * - delegation config validation fails closed unless every V1 safety
 *   assumption holds:
 *     - max_concurrent_children is an integer >= 1 and <= 3
 *     - max_spawn_depth == 2
 *     - subagent_auto_approve == false
 * - dispatch normalization forces synchronous-only delegation
 *   (background=False), a top-level Hermes role of "leaf", and every batch
 *   task role of "leaf".
 *
 * The runner installs this gate AROUND the real native Hermes
 * delegate_task; it never reimplements delegation.
 */
export const SUPERVISOR_GATE_SOURCE = String.raw`
def _lia_supervisor_auto_approve_is_safe(value):
    """V1 accepts only the literal boolean False.

    Any other type or value is configuration drift and fails closed.
    Strings such as "false" or "0" are intentionally NOT accepted.
    """
    return isinstance(value, bool) and value is False


def _lia_supervisor_config_int(value, default):
    """Parse a delegation config scalar as int; None means invalid."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except (TypeError, ValueError):
            return None
    if value is None:
        return default
    return None


def supervisor_gate_validate_delegation_config(cfg):
    """Fail closed unless all V1 delegation safety assumptions hold.

    Returns (ok, reason). ok=False means the caller MUST NOT start model
    execution. The bounded profile configuration is
    max_concurrent_children=3, max_spawn_depth=2, orchestrator_enabled=true,
    subagent_auto_approve=false; any drift that weakens the V1 assumptions
    fails closed. The three hard assumptions below are mandatory.
    """
    if not isinstance(cfg, dict):
        return False, "delegation config must be an object"

    max_concurrent = _lia_supervisor_config_int(cfg.get("max_concurrent_children"), 3)
    max_spawn_depth = _lia_supervisor_config_int(cfg.get("max_spawn_depth"), 1)
    if "subagent_auto_approve" not in cfg:
        return False, "subagent_auto_approve must be explicitly false"
    subagent_auto_approve = cfg.get("subagent_auto_approve")

    if max_concurrent is None or max_concurrent < 1 or max_concurrent > 3:
        return False, "max_concurrent_children must be an integer in [1, 3]"
    if max_spawn_depth != 2:
        return False, "max_spawn_depth must equal 2"
    if not _lia_supervisor_auto_approve_is_safe(subagent_auto_approve):
        return False, "subagent_auto_approve must be explicitly false"
    return True, "ok"


def supervisor_gate_normalize_dispatch(role, background, tasks):
    """Deterministic LÍA gate applied before native delegate_task dispatch.

    - Delegation is synchronous only: background is forced to False so no
      detached background child can survive the request.
    - Top-level role is forced to "leaf" so a model-supplied
      "orchestrator" role can never grant nested delegation.
    - Every batch task role is forced to "leaf" (per-task overrides are
      stripped and replaced).

    Returns (ok, payload). On failure payload is an error message; on
    success payload is the normalized dispatch dict passed to the REAL
    native delegate_task.
    """
    safe_tasks = None
    if tasks is not None:
        if not isinstance(tasks, list):
            return False, "tasks must be a list"
        normalized_tasks = []
        for index, task in enumerate(tasks):
            if not isinstance(task, dict):
                return False, "task %d must be an object" % index
            safe_task = dict(task)
            safe_task["role"] = "leaf"
            normalized_tasks.append(safe_task)
        safe_tasks = normalized_tasks
    return True, {"role": "leaf", "background": False, "tasks": safe_tasks}
`;

const SUPERVISOR_RUNNER = String.raw`
${SUPERVISOR_GATE_SOURCE}

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

# Fail-closed delegation config gate, BEFORE any model execution.
config = load_config()
gate_ok, gate_reason = supervisor_gate_validate_delegation_config(config.get("delegation") or {})
if not gate_ok:
    sys.stderr.write("${UNSAFE_DELEGATION_CONFIG_MARKER}\n")
    raise SystemExit(77)

runtime = resolve_runtime_provider(requested=provider, target_model=model)
fallback_chain = get_fallback_chain(config)


def _supervisor_noop_print(*args, **kwargs):
    """Silence status/progress lines (including delegate_task progress) so
    stdout stays machine-readable and never leaks paths or session ids."""
    return None


def _install_supervisor_delegation_gate():
    """Wrap the REAL native Hermes delegate_task with the deterministic LÍA
    safety gate. Both native dispatch paths (run_agent._dispatch_delegate_task
    and the registry handler) resolve the module-global delegate_task at call
    time, so this single patch covers every model-facing dispatch. No
    replacement delegation engine is introduced."""
    import tools.delegate_tool as _delegate_module

    _original_delegate_task = _delegate_module.delegate_task

    def _lia_supervisor_delegate_task(goal=None, context=None, tasks=None, max_iterations=None, role=None, background=None, parent_agent=None):
        gate_ok, normalized = supervisor_gate_normalize_dispatch(role, background, tasks)
        if not gate_ok:
            return _delegate_module.tool_error(normalized)
        return _original_delegate_task(
            goal=goal,
            context=context,
            tasks=normalized["tasks"],
            max_iterations=max_iterations,
            role=normalized["role"],
            background=normalized["background"],
            parent_agent=parent_agent,
        )

    _delegate_module.delegate_task = _lia_supervisor_delegate_task


agent = None
try:
    agent = AIAgent(
        api_key=runtime.get("api_key"),
        base_url=runtime.get("base_url"),
        provider=runtime.get("provider"),
        requested_provider=runtime.get("requested_provider"),
        api_mode=runtime.get("api_mode"),
        model=model,
        enabled_toolsets=["delegation"],
        disabled_toolsets=[],
        quiet_mode=True,
        skip_memory=True,
        skip_context_files=True,
        save_trajectories=False,
        platform="cli",
        credential_pool=runtime.get("credential_pool"),
        fallback_model=fallback_chain or None,
    )

    # Fail-closed tool-surface assertion: the Supervisor agent must expose
    # EXACTLY delegate_task. Anything else aborts before model execution.
    tools = getattr(agent, "tools", None)
    valid_tool_names = getattr(agent, "valid_tool_names", None)
    actual_names = set(valid_tool_names) if valid_tool_names is not None else set()
    if (
        not isinstance(tools, list)
        or len(tools) != 1
        or actual_names != {"delegate_task"}
    ):
        sys.stderr.write("${TOOL_SURFACE_VIOLATION_MARKER}\n")
        raise SystemExit(78)

    agent.suppress_status_output = True
    agent.stream_delta_callback = None
    agent.tool_gen_callback = None
    agent._print_fn = _supervisor_noop_print

    # Depth defense: the supervisor parent sits at delegation depth 1, so
    # native Hermes creates every child at depth 2. With the profile's
    # max_spawn_depth=2, orchestrator_ok = orchestrator_enabled and
    # child_depth < max_spawn_depth is FALSE, so native Hermes degrades any
    # requested orchestrator child to leaf, and grandchildren are blocked
    # (depth >= max_spawn_depth). The dispatch gate forcing role=leaf above
    # remains mandatory regardless.
    agent._delegate_depth = 1

    _install_supervisor_delegation_gate()

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

export type HermesSupervisorInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
};

export function buildHermesSupervisorInvocation(
  config: LiaAgentConfig,
  query: string,
): HermesSupervisorInvocation {
  const pythonExecutable = join(
    config.hermesHome,
    'hermes-agent',
    'venv',
    'bin',
    'python',
  );
  const supervisorProfileHome = join(
    config.hermesHome,
    'profiles',
    SUPERVISOR_PROFILE_NAME,
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
      `HERMES_HOME=${supervisorProfileHome}`,
      'TERM=dumb',
      'NO_COLOR=1',
      pythonExecutable,
      '-c',
      SUPERVISOR_RUNNER,
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

export function createHermesSupervisorExecutor(
  spawnProcess: SpawnProcess,
): HermesQueryExecutor {
  return async (config, query) => {
    if (!config.hermesExecutionEnabled) {
      return { ok: false, error: 'execution_disabled' };
    }

    const invocation = buildHermesSupervisorInvocation(config, query);

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
        if (
          code !== 0
          || stderr.includes(TOOL_SURFACE_VIOLATION_MARKER)
          || stderr.includes(UNSAFE_DELEGATION_CONFIG_MARKER)
        ) {
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

export const executeHermesSupervisor = createHermesSupervisorExecutor(spawn);
