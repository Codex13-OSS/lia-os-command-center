import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { loadConfig } from '../dist/config.js';
import {
  buildHermesSupervisorInvocation,
  createHermesSupervisorExecutor,
  SUPERVISOR_GATE_SOURCE,
} from '../dist/services/hermesSupervisorExecutor.js';
import {
  buildHermesReasoningInvocation,
  createHermesReasoningOnlyExecutor,
} from '../dist/services/hermesReasoningExecutor.js';
import { executeHermesQuery } from '../dist/services/hermesExecutor.js';
import { orchestrateProjectTask } from '../dist/services/projectOrchestrationService.js';
import { executeProjectTask } from '../dist/services/projectTaskExecutionService.js';
import { executeProjectTaskWorkflow } from '../dist/services/projectTaskWorkflowService.js';
import { buildProjectCodexHandoff } from '../dist/services/projectCodexHandoff.js';

const TOOL_SURFACE_MARKER = 'LIA_HERMES_SUPERVISOR_TOOL_SURFACE_VIOLATION';
const UNSAFE_CONFIG_MARKER = 'LIA_HERMES_SUPERVISOR_UNSAFE_DELEGATION_CONFIG';

const config = {
  host: '127.0.0.1',
  port: 3014,
  corsOrigins: [],
  agendaSqlitePath: '',
  projectRegistryPath: '',
  hermesRoot: '',
  hermesExecutionEnabled: true,
  hermesExecutable: '/bin/hermes',
  hermesHome: '/hermes',
  hermesUser: 'hermes-agent',
  hermesUserHome: '/home/hermes-agent',
  hermesPath: '/bin',
  hermesProvider: 'fake',
  hermesModel: 'fake',
  hermesTimeoutMs: 100,
  hermesMaxQueryCharacters: 8000,
  logLevel: 'silent',
};

function createFakeHermesProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

function runnerSource() {
  return buildHermesSupervisorInvocation(config, 'plan safely').args.at(-1);
}

function reasoningRunnerSource() {
  return buildHermesReasoningInvocation(config, 'plan safely').args.at(-1);
}

function supervisorPython() {
  const venv = '/home/hermes-agent/.hermes/hermes-agent/venv/bin/python';
  return existsSync(venv) ? venv : 'python3';
}

const GATE_HARNESS = `
import json
import sys

_payload = json.load(sys.stdin)
_command = _payload.get("command")
if _command == "validate_delegation_config":
    _ok, _reason = supervisor_gate_validate_delegation_config(_payload.get("config"))
    json.dump({"ok": _ok, "reason": _reason}, sys.stdout)
elif _command == "normalize_dispatch":
    _ok, _result = supervisor_gate_normalize_dispatch(
        _payload.get("role"), _payload.get("background"), _payload.get("tasks")
    )
    json.dump({"ok": _ok, "result": _result}, sys.stdout)
else:
    json.dump({"ok": False, "reason": "unknown command"}, sys.stdout)
`;

function runPythonWithInput(python, source, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', source], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`gate python exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

async function runGate(payload) {
  const source = `${SUPERVISOR_GATE_SOURCE}\n${GATE_HARNESS}`;
  const stdout = await runPythonWithInput(
    supervisorPython(),
    source,
    JSON.stringify(payload),
  );
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// 1. reasoning-only executor remains zero-tool and unchanged in behavior.
// ---------------------------------------------------------------------------
test('reasoning-only executor remains zero-tool and unchanged in behavior', async () => {
  const source = await readFile(
    new URL('../src/services/hermesReasoningExecutor.ts', import.meta.url),
    'utf8',
  );
  // The reasoning executor must not have been turned into a tool-enabled
  // executor and must not reference the supervisor or delegation.
  assert.equal(source.includes('Supervisor'), false);
  assert.equal(source.includes('delegate_task'), false);
  assert.match(source, /enabled_toolsets=\[\]/);
  assert.match(source, /valid_tool_names is None or bool\(valid_tool_names\)/);

  // Behavior unchanged: a clean zero-tool run still yields the response.
  const child = createFakeHermesProcess();
  const executor = createHermesReasoningOnlyExecutor(() => {
    queueMicrotask(() => {
      child.stdout.end('\u001b[32mreasoned\u001b[0m');
      queueMicrotask(() => child.emit('close', 0));
    });
    return child;
  });
  assert.deepEqual(await executor(config, 'plan'), { ok: true, response: 'reasoned' });

  // Zero-tool means the runner's tool-surface check is still enforced.
  const reasoningRunner = reasoningRunnerSource();
  assert.match(reasoningRunner, /enabled_toolsets=\[\]/);
  assert.match(reasoningRunner, /LIA_HERMES_REASONING_TOOL_SURFACE_VIOLATION/);
});

// ---------------------------------------------------------------------------
// 2. Supervisor invocation uses lia-supervisor HERMES_HOME.
// ---------------------------------------------------------------------------
test('supervisor invocation uses the lia-supervisor profile as HERMES_HOME', () => {
  const invocation = buildHermesSupervisorInvocation(config, 'plan safely');

  assert.equal(invocation.command, '/usr/sbin/runuser');
  assert.equal(invocation.args.includes('chat'), false);
  assert.equal(invocation.args.includes('hermes'), false);
  assert.equal(invocation.args.includes('--yolo'), false);
  assert.equal(invocation.args.at(-2), '-c');

  const hermesHomeArg = invocation.args.find((arg) => arg.startsWith('HERMES_HOME='));
  assert.equal(hermesHomeArg, 'HERMES_HOME=/hermes/profiles/lia-supervisor');
  assert.match(invocation.args.at(-3), /hermes-agent\/venv\/bin\/python$/);

  // Clean isolated env: no host env, no HERMES_* leakage through spawn env.
  assert.deepEqual(Object.keys(invocation.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
  assert.equal(invocation.args.some((arg) => arg.startsWith('HERMES_INTERACTIVE=')), false);
  assert.equal(invocation.args.some((arg) => arg.startsWith('HERMES_YOLO_MODE=')), false);
  assert.equal(invocation.args.some((arg) => arg.startsWith('HERMES_ACCEPT_HOOKS=')), false);

  const input = JSON.parse(invocation.input);
  assert.deepEqual(Object.keys(input).sort(), ['model', 'provider', 'query']);
});

// ---------------------------------------------------------------------------
// 3. Supervisor AIAgent requests enabled_toolsets=["delegation"] only.
// ---------------------------------------------------------------------------
test('supervisor AIAgent requests enabled_toolsets=["delegation"] only', () => {
  const runner = runnerSource();
  assert.match(runner, /enabled_toolsets=\["delegation"\]/);
  assert.match(runner, /disabled_toolsets=\[\]/);
  assert.equal(runner.match(/enabled_toolsets=\[/g).length, 1);
});

// ---------------------------------------------------------------------------
// 4. Runtime verifies effective tool names are exactly delegate_task.
// ---------------------------------------------------------------------------
test('runtime verifies effective tool names are exactly delegate_task', () => {
  const runner = runnerSource();
  assert.match(runner, /actual_names != \{"delegate_task"\}/);
  assert.match(runner, /len\(tools\) != 1/);
  assert.match(runner, /not isinstance\(tools, list\)/);
});

// ---------------------------------------------------------------------------
// 5. Extra effective tool -> fail closed before model execution.
// ---------------------------------------------------------------------------
test('extra effective tool fails closed before model execution', async () => {
  const runner = runnerSource();
  const assertionIndex = runner.indexOf('actual_names != {"delegate_task"}');
  const conversationIndex = runner.indexOf('agent.run_conversation');
  assert.notEqual(assertionIndex, -1);
  assert.equal(assertionIndex < conversationIndex, true);

  // Executor maps a tool-surface violation to the deterministic error.
  const child = createFakeHermesProcess();
  const executor = createHermesSupervisorExecutor(() => {
    queueMicrotask(() => {
      child.stderr.end(`${TOOL_SURFACE_MARKER}\nsecret detail`);
      queueMicrotask(() => child.emit('close', 78));
    });
    return child;
  });
  assert.deepEqual(await executor(config, 'plan'), { ok: false, error: 'execution_failed' });
  assert.equal(child.signals.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Missing delegate_task -> fail closed.
// ---------------------------------------------------------------------------
test('missing delegate_task fails closed before model execution', async () => {
  const child = createFakeHermesProcess();
  const executor = createHermesSupervisorExecutor(() => {
    queueMicrotask(() => {
      child.stderr.end(`${TOOL_SURFACE_MARKER}\n`);
      queueMicrotask(() => child.emit('close', 78));
    });
    return child;
  });
  assert.deepEqual(await executor(config, 'plan'), { ok: false, error: 'execution_failed' });

  const runner = runnerSource();
  assert.match(runner, /valid_tool_names is not None else set\(\)/);
});

// ---------------------------------------------------------------------------
// 7. Supervisor sets _delegate_depth=1.
// ---------------------------------------------------------------------------
test('supervisor sets _delegate_depth=1 for depth defense', () => {
  const runner = runnerSource();
  assert.match(runner, /agent\._delegate_depth = 1/);
  assert.equal(runner.match(/_delegate_depth = 1/g).length, 1);
  // Depth defense must be installed before the model runs.
  assert.equal(
    runner.indexOf('agent._delegate_depth = 1') < runner.indexOf('agent.run_conversation'),
    true,
  );
});

// ---------------------------------------------------------------------------
// 8. Profile max_spawn_depth other than 2 -> fail closed.
// ---------------------------------------------------------------------------
test('delegation gate fails closed when max_spawn_depth is not 2', async () => {
  const valid = await runGate({
    command: 'validate_delegation_config',
    config: { max_concurrent_children: 3, max_spawn_depth: 2, orchestrator_enabled: true, subagent_auto_approve: false },
  });
  assert.deepEqual(valid, { ok: true, reason: 'ok' });

  for (const max_spawn_depth of [1, 3, 0, '2.5', null]) {
    const result = await runGate({
      command: 'validate_delegation_config',
      config: { max_concurrent_children: 3, max_spawn_depth, subagent_auto_approve: false },
    });
    assert.equal(result.ok, false, `max_spawn_depth=${max_spawn_depth}`);
  }

  // Missing delegation config entirely must also fail closed (native default
  // would be max_spawn_depth=1 — drift must never be trusted silently).
  const missing = await runGate({ command: 'validate_delegation_config', config: {} });
  assert.equal(missing.ok, false);

  // Executor maps the unsafe-config marker to the deterministic error.
  const child = createFakeHermesProcess();
  const executor = createHermesSupervisorExecutor(() => {
    queueMicrotask(() => {
      child.stderr.end(`${UNSAFE_CONFIG_MARKER}\n`);
      queueMicrotask(() => child.emit('close', 77));
    });
    return child;
  });
  assert.deepEqual(await executor(config, 'plan'), { ok: false, error: 'execution_failed' });
});

// ---------------------------------------------------------------------------
// 9. max_concurrent_children >3 -> fail closed.
// ---------------------------------------------------------------------------
test('delegation gate fails closed when max_concurrent_children exceeds 3', async () => {
  for (const max_concurrent_children of [4, 10, '4']) {
    const result = await runGate({
      command: 'validate_delegation_config',
      config: { max_concurrent_children, max_spawn_depth: 2, subagent_auto_approve: false },
    });
    assert.equal(result.ok, false, `max_concurrent_children=${max_concurrent_children}`);
    assert.match(result.reason, /max_concurrent_children/);
  }
});

// ---------------------------------------------------------------------------
// 10. max_concurrent_children <=0 -> fail closed.
// ---------------------------------------------------------------------------
test('delegation gate fails closed when max_concurrent_children is <= 0', async () => {
  for (const max_concurrent_children of [0, -1, -100]) {
    const result = await runGate({
      command: 'validate_delegation_config',
      config: { max_concurrent_children, max_spawn_depth: 2, subagent_auto_approve: false },
    });
    assert.equal(result.ok, false, `max_concurrent_children=${max_concurrent_children}`);
  }
});

// ---------------------------------------------------------------------------
// 11. subagent_auto_approve=true -> fail closed.
// ---------------------------------------------------------------------------
test('delegation gate fails closed when subagent_auto_approve is true', async () => {
  for (const subagent_auto_approve of [true, 'true', 'yes', '1', 'on']) {
    const result = await runGate({
      command: 'validate_delegation_config',
      config: { max_concurrent_children: 3, max_spawn_depth: 2, subagent_auto_approve },
    });
    assert.equal(result.ok, false, `subagent_auto_approve=${subagent_auto_approve}`);
  }
  // Explicit false and the string "false" remain acceptable.
  for (const subagent_auto_approve of [false]) {
    const result = await runGate({
      command: 'validate_delegation_config',
      config: { max_concurrent_children: 3, max_spawn_depth: 2, subagent_auto_approve },
    });
    assert.equal(result.ok, true, `subagent_auto_approve=${subagent_auto_approve}`);
  }
});

// ---------------------------------------------------------------------------
// 12. Dispatch gate forces top-level Hermes role to leaf.
// ---------------------------------------------------------------------------
test('dispatch gate forces the top-level Hermes role to leaf', async () => {
  const result = await runGate({
    command: 'normalize_dispatch',
    role: 'orchestrator',
    background: true,
    tasks: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.role, 'leaf');
  assert.equal(result.result.background, false);
  assert.equal(result.result.tasks, null);

  const resultLeaf = await runGate({ command: 'normalize_dispatch', role: 'leaf', tasks: null });
  assert.equal(resultLeaf.result.role, 'leaf');
});

// ---------------------------------------------------------------------------
// 13. Dispatch gate forces every batch task role to leaf.
// ---------------------------------------------------------------------------
test('dispatch gate forces every batch task role to leaf', async () => {
  const result = await runGate({
    command: 'normalize_dispatch',
    role: 'orchestrator',
    background: true,
    tasks: [
      { goal: 'g1', role: 'orchestrator' },
      { goal: 'g2', context: 'ctx', role: 'orchestrator' },
      { goal: 'g3', role: 'leaf' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.role, 'leaf');
  assert.equal(result.result.background, false);
  assert.deepEqual(result.result.tasks.map((task) => task.role), ['leaf', 'leaf', 'leaf']);
  // Legitimate task fields survive; only role is normalized.
  assert.equal(result.result.tasks[0].goal, 'g1');
  assert.equal(result.result.tasks[1].context, 'ctx');

  // Malformed batch inputs fail closed instead of reaching native dispatch.
  const badTasks = await runGate({
    command: 'normalize_dispatch',
    role: 'leaf',
    tasks: 'not-a-list',
  });
  assert.equal(badTasks.ok, false);
  const badEntry = await runGate({ command: 'normalize_dispatch', role: 'leaf', tasks: [42] });
  assert.equal(badEntry.ok, false);
});

// ---------------------------------------------------------------------------
// 14. background=true cannot create detached delegation.
// ---------------------------------------------------------------------------
test('background=true cannot create detached delegation', async () => {
  const result = await runGate({
    command: 'normalize_dispatch',
    role: 'leaf',
    background: true,
    tasks: [{ goal: 'g' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.background, false);

  const runner = runnerSource();
  assert.match(runner, /"background": False/);
  // The wrapper hands the forced background value to native dispatch only.
  assert.match(runner, /background=normalized\["background"\]/);
});

// ---------------------------------------------------------------------------
// 15. Model-supplied orchestrator role cannot survive to native dispatch.
// ---------------------------------------------------------------------------
test('model-supplied orchestrator role cannot survive to native dispatch', async () => {
  const runner = runnerSource();
  // The wrapper passes the normalized role (never the raw model role) to the
  // original native delegate_task.
  assert.match(runner, /role=normalized\["role"\]/);
  assert.match(runner, /safe_task\["role"\] = "leaf"/);
  assert.match(runner, /"role": "leaf"/);

  const result = await runGate({
    command: 'normalize_dispatch',
    role: 'orchestrator',
    background: true,
    tasks: [{ goal: 'g', role: 'orchestrator' }],
  });
  assert.equal(result.result.role, 'leaf');
  assert.equal(result.result.tasks[0].role, 'leaf');
});

// ---------------------------------------------------------------------------
// 16. Native dispatch remains the underlying delegate mechanism.
// ---------------------------------------------------------------------------
test('native dispatch remains the underlying delegate mechanism', () => {
  const runner = runnerSource();
  // The gate wraps the real Hermes tool module; it never reimplements it.
  assert.match(runner, /import tools\.delegate_tool as _delegate_module/);
  assert.match(runner, /_original_delegate_task = _delegate_module\.delegate_task/);
  assert.match(runner, /return _original_delegate_task\(/);
  assert.match(runner, /goal=goal/);
  assert.match(runner, /context=context/);
  assert.match(runner, /tasks=normalized\["tasks"\]/);
  assert.match(runner, /parent_agent=parent_agent/);
  // No replacement delegation engine: the only new function is the wrapper.
  assert.equal(runner.includes('def delegate_task('), false);
  assert.equal(runner.includes('def _lia_supervisor_delegate_task('), true);
  // The patch is installed before the conversation starts.
  assert.equal(
    runner.indexOf('_install_supervisor_delegation_gate()') < runner.indexOf('agent.run_conversation'),
    true,
  );
});

// ---------------------------------------------------------------------------
// 17. No terminal/file/web/code/git/memory/MCP/kanban tools on Supervisor.
// ---------------------------------------------------------------------------
test('no dangerous toolsets are enabled on the Supervisor agent', () => {
  const runner = runnerSource();
  for (const forbidden of [
    '"terminal"',
    '"file"',
    '"web"',
    '"code_execution"',
    '"memory"',
    '"kanban"',
    '"mcp-',
    'execute_code',
    '"git"',
  ]) {
    assert.equal(runner.includes(forbidden), false, forbidden);
  }
  assert.equal(runner.includes('enabled_toolsets=["delegation"]'), true);
  assert.equal(runner.includes('disabled_toolsets=[]'), true);

  // Any tool-surface deviation fails closed at runtime (see test 5).
  const child = createFakeHermesProcess();
  const executor = createHermesSupervisorExecutor(() => {
    queueMicrotask(() => {
      child.stderr.end(`${TOOL_SURFACE_MARKER}\n`);
      queueMicrotask(() => child.emit('close', 78));
    });
    return child;
  });
  return executor(config, 'plan').then((result) => {
    assert.deepEqual(result, { ok: false, error: 'execution_failed' });
  });
});

// ---------------------------------------------------------------------------
// 18. Planning/workflow defaults use the Supervisor Executor.
// ---------------------------------------------------------------------------
test('planning/workflow defaults use the Supervisor Executor', async () => {
  for (const file of [
    'projectOrchestrationService.ts',
    'projectTaskExecutionService.ts',
    'projectTaskWorkflowService.ts',
  ]) {
    const source = await readFile(new URL(`../src/services/${file}`, import.meta.url), 'utf8');
    assert.match(source, /executeHermesSupervisor/, file);
    assert.equal(source.includes('executeHermesReasoningOnly'), false, file);
    assert.equal(source.includes('executeHermesQuery'), false, file);
  }
});

// ---------------------------------------------------------------------------
// 19. General Hermes query/chat wiring is unchanged.
// ---------------------------------------------------------------------------
test('general Hermes query/chat wiring is unchanged', async () => {
  const executorSource = await readFile(
    new URL('../src/services/hermesExecutor.ts', import.meta.url),
    'utf8',
  );
  const queryRouteSource = await readFile(
    new URL('../src/routes/hermesQuery.ts', import.meta.url),
    'utf8',
  );

  assert.equal(executorSource.includes('Supervisor'), false);
  assert.equal(executorSource.includes('ReasoningOnly'), false);
  assert.match(executorSource, /export async function executeHermesQuery/);
  assert.equal(queryRouteSource.includes('Supervisor'), false);
  assert.match(queryRouteSource, /executeQuery \?\? executeHermesQuery/);

  // executeHermesQuery still honors execution_disabled without spawning.
  assert.deepEqual(
    await executeHermesQuery({ ...config, hermesExecutionEnabled: false }, 'query'),
    { ok: false, error: 'execution_disabled' },
  );
});

// ---------------------------------------------------------------------------
// 20. Invalid Supervisor response still fails the existing LÍA validator.
// ---------------------------------------------------------------------------
const registry = (overrides = {}) => ({
  read: async () => [{
    projectId: 'approved-project',
    displayName: 'Approved Project',
    repositoryRoot: '/private/approved-project',
    enabled: true,
    ...overrides,
  }],
});

const taskRequest = (overrides = {}) => ({
  projectId: 'approved-project',
  instruction: 'Implement the approved task.',
  priority: 'normal',
  requestedCapabilities: ['repository_read', 'isolated_worktree_write'],
  ...overrides,
});

const proposal = (overrides = {}) => ({
  summary: 'Apply a contained change',
  steps: [{
    id: 'step-1',
    title: 'Implement',
    objective: 'Change only approved files',
    role: 'implementer',
    dependsOn: [],
    requiredCapabilities: ['isolated_worktree_write'],
  }],
  executionMode: 'direct',
  requiresHumanApproval: false,
  blockedActions: [],
  ...overrides,
});

function executionHarness(hermesResult) {
  const calls = { hermes: 0, codex: 0 };
  return {
    calls,
    dependencies: {
      executeHermes: async () => {
        calls.hermes += 1;
        return hermesResult;
      },
      executeCodex: async () => {
        calls.codex += 1;
        return { success: true, executionId: 'execution-123', status: 'completed', summary: 'ok' };
      },
    },
  };
}

test('invalid Supervisor responses still fail the existing LÍA validator', async () => {
  // Non-JSON text.
  const invalidJson = executionHarness({ ok: true, response: '```json\n{}\n```' });
  const resultJson = await executeProjectTask(
    config,
    taskRequest(),
    registry(),
    invalidJson.dependencies,
  );
  assert.deepEqual(resultJson, { ok: false, status: 'failed', error: 'invalid_hermes_json' });
  assert.equal(invalidJson.calls.codex, 0);

  // Valid JSON, invalid proposal structure.
  const invalidProposal = executionHarness({
    ok: true,
    response: JSON.stringify(proposal({ summary: '   ' })),
  });
  const resultProposal = await executeProjectTask(
    config,
    taskRequest(),
    registry(),
    invalidProposal.dependencies,
  );
  assert.deepEqual(resultProposal, {
    ok: false,
    status: 'failed',
    error: 'invalid_hermes_proposal',
  });
  assert.equal(invalidProposal.calls.codex, 0);

  // Orchestration path maps the same way.
  const orchestration = await orchestrateProjectTask(
    config,
    taskRequest(),
    registry(),
    async () => ({ ok: true, response: 'not json at all' }),
  );
  assert.deepEqual(orchestration, { ok: false, error: 'invalid_hermes_json' });
});

// ---------------------------------------------------------------------------
// 21. Capability escalation still fails before Codex.
// ---------------------------------------------------------------------------
test('capability escalation still fails before Codex', async () => {
  const escalated = proposal({
    steps: [{
      id: 'step-1',
      title: 'Escalate',
      objective: 'Push changes',
      role: 'implementer',
      dependsOn: [],
      requiredCapabilities: ['push'],
    }],
  });
  const fake = executionHarness({ ok: true, response: JSON.stringify(escalated) });
  const result = await executeProjectTask(config, taskRequest(), registry(), fake.dependencies);
  assert.deepEqual(result, { ok: false, status: 'failed', error: 'invalid_hermes_proposal' });
  assert.equal(fake.calls.codex, 0);

  // Workflow path with a delegated proposal attempting escalation.
  const workflowEscalation = {
    summary: 'Escalate',
    steps: [
      { id: 'step-a', title: 'Read', objective: 'Read', role: 'researcher', dependsOn: [], requiredCapabilities: ['repository_read'] },
      { id: 'step-b', title: 'Deploy', objective: 'Deploy', role: 'implementer', dependsOn: ['step-a'], requiredCapabilities: ['push'] },
    ],
    executionMode: 'delegated',
    requiresHumanApproval: false,
    blockedActions: [],
  };
  const workflowHarness = {
    executeHermes: async () => ({ ok: true, response: JSON.stringify(workflowEscalation) }),
    executeCodex: async () => {
      throw new Error('must not be called');
    },
  };
  const workflowResult = await executeProjectTaskWorkflow(
    config,
    taskRequest(),
    registry(),
    undefined,
    workflowHarness,
  );
  assert.equal(workflowResult.stage, 'hermes');
  assert.equal(workflowResult.error, 'invalid_hermes_proposal');
});

// ---------------------------------------------------------------------------
// 22. Supervisor/subagent/session/internal fields cannot enter the public
//     proposal.
// ---------------------------------------------------------------------------
test('supervisor/subagent/session/internal fields cannot enter the public proposal', async () => {
  const poisoned = proposal({
    subagent_id: 'sa-0-abcdef12',
    child_session_id: 'session-internal-1',
    parent_session_id: 'session-internal-0',
    transcripts: ['internal transcript'],
    tool_traces: [{ tool: 'terminal' }],
    shell: '/bin/sh',
    delegation_results: [{ summary: 'internal' }],
  });
  const fake = executionHarness({ ok: true, response: JSON.stringify(poisoned) });
  const result = await executeProjectTask(config, taskRequest(), registry(), fake.dependencies);
  assert.deepEqual(result, { ok: false, status: 'failed', error: 'invalid_hermes_proposal' });
  assert.equal(fake.calls.codex, 0);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['subagent_id', 'child_session_id', 'parent_session_id', 'transcripts', 'tool_traces', 'shell', 'delegation_results', 'sa-0-abcdef12']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const stepPoisoned = executionHarness({
    ok: true,
    response: JSON.stringify(proposal({
      steps: [{
        id: 'step-1',
        title: 'Implement',
        objective: 'Change only approved files',
        role: 'implementer',
        dependsOn: [],
        requiredCapabilities: ['isolated_worktree_write'],
        subagent_id: 'sa-internal',
      }],
    })),
  });
  const stepResult = await executeProjectTask(
    config,
    taskRequest(),
    registry(),
    stepPoisoned.dependencies,
  );
  assert.deepEqual(stepResult, { ok: false, status: 'failed', error: 'invalid_hermes_proposal' });
});

// ---------------------------------------------------------------------------
// 23. No role or delegate usage expands effectiveCapabilities.
// ---------------------------------------------------------------------------
test('no role or delegate usage expands effectiveCapabilities', () => {
  const plan = {
    projectId: 'approved-project',
    projectDisplayName: 'Approved Project',
    repositoryRoot: '/private/approved-project',
    instruction: 'Implement the approved task.',
    priority: 'normal',
    approvedCapabilities: ['repository_read', 'isolated_worktree_write'],
    orchestrator: 'hermes',
    executor: 'codex',
    workspaceIsolation: 'isolated_worktree_only',
    requiresHumanApprovalForBlockedActions: true,
    productionAccess: false,
    databaseWriteAccess: false,
    secretAccess: false,
  };
  const delegated = proposal({
    executionMode: 'delegated',
    steps: [
      { id: 'step-a', title: 'Research', objective: 'Research', role: 'researcher', dependsOn: [], requiredCapabilities: ['repository_read'] },
      { id: 'step-b', title: 'Orchestrate', objective: 'Coordinate', role: 'orchestrator', dependsOn: ['step-a'], requiredCapabilities: ['isolated_worktree_write'] },
    ],
  });
  const handoff = buildProjectCodexHandoff(plan, delegated);
  assert.equal(handoff.success, true);
  assert.deepEqual(handoff.handoff.effectiveCapabilities, ['repository_read', 'isolated_worktree_write']);
  assert.equal(handoff.handoff.effectiveCapabilities.includes('run_tests'), false);
  assert.equal(handoff.handoff.effectiveCapabilities.includes('local_commit'), false);
});

// ---------------------------------------------------------------------------
// 24. No background subagent survives the timeout/error path.
// ---------------------------------------------------------------------------
test('no background subagent survives the timeout/error path', async () => {
  // Timeout: the single subprocess is terminated; delegation inside it is
  // synchronous-only (background forced to false by the gate), so nothing
  // detached can outlive it.
  const timeoutChild = createFakeHermesProcess();
  const timeoutExecutor = createHermesSupervisorExecutor(() => timeoutChild);
  const timeoutResult = await timeoutExecutor({ ...config, hermesTimeoutMs: 1 }, 'plan');
  assert.deepEqual(timeoutResult, { ok: false, error: 'timeout' });
  assert.deepEqual(timeoutChild.signals, ['SIGTERM']);

  // Error path: spawn/process failure maps closed and never resolves ok.
  const errorChild = createFakeHermesProcess();
  const errorExecutor = createHermesSupervisorExecutor(() => {
    queueMicrotask(() => errorChild.emit('error', new Error('private')));
    return errorChild;
  });
  assert.deepEqual(await errorExecutor(config, 'plan'), { ok: false, error: 'execution_failed' });

  // Spawn throw maps closed as well.
  const throwingExecutor = createHermesSupervisorExecutor(() => {
    throw new Error('spawn failed');
  });
  assert.deepEqual(await throwingExecutor(config, 'plan'), { ok: false, error: 'execution_failed' });

  // The gate itself forces background=False (synchronous-only) and the
  // runner installs it before the model can dispatch anything.
  const runner = runnerSource();
  assert.match(runner, /"background": False/);
  assert.equal(
    runner.indexOf('_install_supervisor_delegation_gate()') < runner.indexOf('agent.run_conversation'),
    true,
  );
});

// ---------------------------------------------------------------------------
// 25. Subprocess uses shell:false and bounded stdout/stderr.
// ---------------------------------------------------------------------------
test('subprocess uses shell:false and bounded stdout/stderr', async () => {
  let capturedOptions;
  const child = createFakeHermesProcess();
  const executor = createHermesSupervisorExecutor((command, args, options) => {
    capturedOptions = { command, args, options };
    queueMicrotask(() => {
      child.stdout.end('x'.repeat(200 * 1024));
      queueMicrotask(() => child.emit('close', 0));
    });
    return child;
  });

  const result = await executor(config, 'plan');
  assert.equal(result.ok, true);
  assert.equal(result.response.length, 64 * 1024);
  assert.equal(capturedOptions.options.shell, false);
  assert.equal(capturedOptions.options.cwd, '/home/hermes-agent');
  assert.deepEqual(Object.keys(capturedOptions.options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);

  // Huge stderr without markers stays bounded and does not leak into the
  // public response.
  const noisyChild = createFakeHermesProcess();
  const noisyExecutor = createHermesSupervisorExecutor(() => {
    queueMicrotask(() => {
      noisyChild.stderr.end('y'.repeat(200 * 1024));
      noisyChild.stdout.end('clean');
      queueMicrotask(() => noisyChild.emit('close', 0));
    });
    return noisyChild;
  });
  assert.deepEqual(await noisyExecutor(config, 'plan'), { ok: true, response: 'clean' });
});

// ---------------------------------------------------------------------------
// Executor contract parity: success, empty, disabled.
// ---------------------------------------------------------------------------
test('supervisor executor preserves the safe success/empty/disabled contract', async () => {
  // execution_disabled never spawns.
  let spawns = 0;
  const disabled = await createHermesSupervisorExecutor(() => {
    spawns += 1;
    return createFakeHermesProcess();
  })({ ...config, hermesExecutionEnabled: false }, 'plan');
  assert.deepEqual(disabled, { ok: false, error: 'execution_disabled' });
  assert.equal(spawns, 0);

  // Empty response.
  const emptyChild = createFakeHermesProcess();
  const empty = await createHermesSupervisorExecutor(() => {
    queueMicrotask(() => emptyChild.emit('close', 0));
    return emptyChild;
  })(config, 'plan');
  assert.deepEqual(empty, { ok: false, error: 'empty_response' });

  // Success with ANSI/session noise cleaned from the final text.
  const cleanChild = createFakeHermesProcess();
  const ok = await createHermesSupervisorExecutor(() => {
    queueMicrotask(() => {
      cleanChild.stdout.end('\u001b[32mplan ok\u001b[0m\nsession_id: secret-session\n');
      queueMicrotask(() => cleanChild.emit('close', 0));
    });
    return cleanChild;
  })(config, 'plan');
  assert.deepEqual(ok, { ok: true, response: 'plan ok' });
});


test("Supervisor V1 accepts only literal boolean false for subagent_auto_approve", async () => {
  const safe = await runGate({
    command: "validate_delegation_config",
    config: {
      max_concurrent_children: 3,
      max_spawn_depth: 2,
      subagent_auto_approve: false,
    },
  });

  assert.equal(safe.ok, true);

  for (const unsafeValue of [
    true,
    "true",
    "false",
    "0",
    "1",
    "yes",
    "no",
    "on",
    "off",
    "",
    0,
    1,
    null,
    [],
    {},
  ]) {
    const result = await runGate({
      command: "validate_delegation_config",
      config: {
        max_concurrent_children: 3,
        max_spawn_depth: 2,
        subagent_auto_approve: unsafeValue,
      },
    });

    assert.equal(
      result.ok,
      false,
      `subagent_auto_approve=${JSON.stringify(unsafeValue)} must fail closed`,
    );
  }
});

test("Supervisor V1 fails closed when subagent_auto_approve is absent", async () => {
  const result = await runGate({
    command: "validate_delegation_config",
    config: {
      max_concurrent_children: 3,
      max_spawn_depth: 2,
    },
  });

  assert.equal(result.ok, false);
});

test("Supervisor falls back exactly once to DeepSeek on unmistakable OpenAI quota exhaustion", async () => {
  const calls = [];
  const stdinPayloads = [];
  const quota =
    "API call failed after 3 retries: HTTP 429: The usage limit has been reached";

  const fallbackJson = JSON.stringify({
    summary: "ok",
    steps: [{
      id: "step-1",
      title: "Implementar",
      objective: "Aplicar",
      role: "implementer",
      dependsOn: [],
      requiredCapabilities: [
        "repository_read",
        "isolated_worktree_write",
      ],
    }],
    executionMode: "direct",
    completionMode: "complete",
    requiresHumanApproval: false,
    blockedActions: [],
  });

  const fakeSpawn = (...args) => {
    const callIndex = calls.length;
    calls.push(args);

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => {};

    child.stdin.end = (payload) => {
      stdinPayloads[callIndex] = String(payload ?? "");
    };

    process.nextTick(() => {
      if (callIndex === 0) {
        child.stdout.emit("data", Buffer.from(quota));
        child.emit("close", 0);
        return;
      }

      child.stdout.emit("data", Buffer.from(fallbackJson));
      child.emit("close", 0);
    });

    return child;
  };

  let secretLoads = 0;

  const execute = createHermesSupervisorExecutor(fakeSpawn, {
    deepSeekSecretLoader: async () => {
      secretLoads += 1;
      return "test-secret-never-logged";
    },
  });

  const result = await execute({
    hermesExecutionEnabled: true,
    hermesUser: "hermes-agent",
    hermesUserHome: "/home/hermes-agent",
    hermesHome: "/home/hermes-agent/.hermes",
    hermesPath: "/usr/local/bin:/usr/bin:/bin",
    hermesProvider: "openai-codex",
    hermesModel: "gpt-5.6-terra",
    hermesTimeoutMs: 120000,
  }, "test");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(secretLoads, 1);

  const firstInput = JSON.parse(stdinPayloads[0]);
  const secondInput = JSON.parse(stdinPayloads[1]);

  assert.equal(firstInput.provider, "openai-codex");
  assert.equal(firstInput.model, "gpt-5.6-terra");
  assert.equal(secondInput.provider, "deepseek");
  assert.equal(secondInput.model, "deepseek-v4-flash");

  assert.equal(calls[0][2].env.DEEPSEEK_API_KEY, undefined);
  assert.equal(calls[1][2].env.DEEPSEEK_API_KEY, "test-secret-never-logged");

  const everyArg = calls
    .flatMap((call) => call[1] ?? [])
    .map(String)
    .join("\n");

  assert.equal(everyArg.includes("test-secret-never-logged"), false);
});

test("Supervisor does not fall back on bare generic HTTP 429", async () => {
  const calls = [];

  const fakeSpawn = (...args) => {
    calls.push(args);

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};

    process.nextTick(() => {
      child.stderr.emit("data", Buffer.from("HTTP 429 Too Many Requests"));
      child.emit("close", 1);
    });

    return child;
  };

  const { createHermesSupervisorExecutor } =
    await import("../dist/services/hermesSupervisorExecutor.js");

  let secretLoads = 0;

  const execute = createHermesSupervisorExecutor(fakeSpawn, {
    deepSeekSecretLoader: async () => {
      secretLoads += 1;
      return "must-not-be-used";
    },
  });

  const result = await execute({
    hermesExecutionEnabled: true,
    hermesUser: "hermes-agent",
    hermesUserHome: "/home/hermes-agent",
    hermesHome: "/home/hermes-agent/.hermes",
    hermesPath: "/usr/local/bin:/usr/bin:/bin",
    hermesProvider: "openai-codex",
    hermesModel: "gpt-5.6-terra",
    hermesTimeoutMs: 120000,
  }, "test");

  assert.equal(result.ok, false);
  assert.equal(result.error, "execution_failed");
  assert.equal(calls.length, 1);
  assert.equal(secretLoads, 0);
});
