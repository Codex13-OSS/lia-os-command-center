import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';

const task = (overrides = {}) => ({
  projectId: 'project-safe-1',
  instruction: 'Implementa la tarea de forma aislada.',
  priority: 'high',
  requestedCapabilities: ['repository_read', 'isolated_worktree_write'],
  ...overrides,
});
const registry = { resolve: () => undefined };

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const post = (baseUrl, body) => fetch(`${baseUrl}/api/projects/tasks/workflow`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const successBase = {
  ok: true,
  projectId: 'project-safe-1',
  executionId: 'execution-safe-1',
  executionSummary: 'Ejecución aislada completa.',
  resultText: 'Cambio completado.',
};

test('workflow route returns exact ready_for_review, verified and committed receipts', async () => {
  const verification = { status: 'verified', checksPassed: 2, totalChecks: 2 };
  const scenarios = [
    [
      { ...successBase, status: 'ready_for_review' },
      { ...successBase, integration: 'project_workflow', mode: 'isolated_codex_workflow', status: 'ready_for_review' },
    ],
    [
      { ...successBase, status: 'verified', verification },
      { ...successBase, integration: 'project_workflow', mode: 'isolated_codex_workflow', status: 'verified', verification },
    ],
    [
      { ...successBase, status: 'committed', verification, commit: 'a'.repeat(40) },
      { ...successBase, integration: 'project_workflow', mode: 'isolated_codex_workflow', status: 'committed', verification, commit: 'a'.repeat(40) },
    ],
  ];

  for (const [result, expected] of scenarios) {
    const app = createApp(loadConfig({}), {
      projectRegistrySource: registry,
      projectTaskWorkflowExecutor: async () => result,
    });
    await withServer(app, async (baseUrl) => {
      const response = await post(baseUrl, task());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    });
  }
});

test('workflow route fails closed without project registry and does not call executor', async () => {
  let calls = 0;
  const app = createApp(loadConfig({}), {
    projectTaskWorkflowExecutor: async () => { calls += 1; throw new Error('must not run'); },
  });
  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, task());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'registry_unavailable' });
  });
  assert.equal(calls, 0);
});

test('workflow route rejects invalid and internal public fields before execution', async () => {
  const forbidden = [
    'repositoryRoot', 'worktreePath', 'branch', 'commands', 'command', 'args',
    'verificationProfile', 'verificationPath', 'commitMessage', 'secrets', 'env',
    'deploy', 'push', 'merge',
  ];
  let calls = 0;
  const app = createApp(loadConfig({}), {
    projectRegistrySource: registry,
    projectTaskWorkflowExecutor: async () => { calls += 1; return successBase; },
  });
  await withServer(app, async (baseUrl) => {
    for (const body of [task({ instruction: '' }), ...forbidden.map((field) => task({ [field]: 'forbidden' }))]) {
      const response = await post(baseUrl, body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        ok: false,
        integration: 'project_workflow',
        stage: 'planning',
        error: 'invalid_task',
      });
    }
  });
  assert.equal(calls, 0);
});

test('workflow route maps every specified workflow error deterministically', async () => {
  const groups = {
    planning: {
      invalid_task: 400, project_not_found: 404, project_disabled: 403,
      registry_unavailable: 503, local_commit_requires_run_tests: 400,
    },
    hermes: {
      prompt_too_large: 413, execution_disabled: 503, timeout: 504,
      execution_failed: 502, empty_response: 502, invalid_hermes_json: 502,
      invalid_hermes_proposal: 502,
    },
    approval: { human_approval_required: 409 },
    codex: {
      missing_repository_read: 403, missing_isolated_worktree_write: 403,
      prompt_too_large: 413, invalid_generated_path: 500, worktree_create_failed: 502,
      codex_execution_failed: 502, timeout: 504, worktree_cleanup_failed: 502,
    },
    verification: {
      verification_unavailable: 503, invalid_generated_path: 500,
      check_failed: 422, check_timeout: 504,
    },
    commit: {
      local_commit_not_approved: 403, workspace_not_verified: 409,
      invalid_generated_path: 500, nothing_to_commit: 409, git_status_failed: 502,
      git_stage_failed: 502, git_commit_failed: 502, git_revision_failed: 502,
    },
  };

  for (const [stage, errors] of Object.entries(groups)) {
    for (const [error, status] of Object.entries(errors)) {
      const result = {
        ok: false, status: 'failed', stage, error,
        projectId: 'project-safe-1', executionId: 'execution-safe-1', summary: 'Safe summary.',
        repositoryRoot: '/secret', stdout: 'secret', stderr: 'secret', prompt: 'secret',
      };
      const app = createApp(loadConfig({}), {
        projectRegistrySource: registry,
        projectTaskWorkflowExecutor: async () => result,
      });
      await withServer(app, async (baseUrl) => {
        const response = await post(baseUrl, task());
        assert.equal(response.status, status, `${stage}:${error}`);
        assert.deepEqual(await response.json(), {
          ok: false, integration: 'project_workflow', stage, error,
          projectId: 'project-safe-1', executionId: 'execution-safe-1', summary: 'Safe summary.',
        });
      });
    }
  }
});

test('workflow route uses 500 for an unknown safe error code', async () => {
  const app = createApp(loadConfig({}), {
    projectRegistrySource: registry,
    projectTaskWorkflowExecutor: async () => ({
      ok: false, status: 'failed', stage: 'codex', error: 'unknown_workflow_error', summary: 'Safe summary.',
    }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, task());
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      ok: false, integration: 'project_workflow', stage: 'codex',
      error: 'unknown_workflow_error', summary: 'Safe summary.',
    });
  });
});

test('workflow route strips malicious executor fields from success receipts', async () => {
  const malicious = {
    repositoryRoot: '/secret', worktreePath: '/secret/worktree', branch: 'secret',
    stdout: 'secret', stderr: 'secret', prompt: 'secret', proposal: {}, handoff: {},
    command: 'rm', commands: ['rm'], args: ['-rf'], env: {}, secrets: {},
    verificationPath: '/secret/verification', projectVerificationPath: '/secret/project',
    registryEntries: [{ secret: true }],
  };
  const app = createApp(loadConfig({}), {
    projectRegistrySource: registry,
    projectTaskWorkflowExecutor: async () => ({
      ...successBase, status: 'committed',
      verification: { status: 'verified', checksPassed: 1, totalChecks: 1 },
      commit: 'b'.repeat(40), ...malicious,
    }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, task());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.commit, 'b'.repeat(40));
    for (const field of Object.keys(malicious)) assert.equal(field in body, false, field);
  });
});

test('workflow app wiring passes registry and optional verification registry to fake executor', async () => {
  for (const projectVerificationRegistry of [{ resolve: () => undefined }, undefined]) {
    const calls = [];
    const app = createApp(loadConfig({}), {
      projectRegistrySource: registry,
      ...(projectVerificationRegistry ? { projectVerificationRegistry } : {}),
      projectTaskWorkflowExecutor: async (...args) => {
        calls.push(args);
        return { ...successBase, status: 'ready_for_review' };
      },
    });
    await withServer(app, async (baseUrl) => {
      assert.equal((await post(baseUrl, task())).status, 200);
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/projects/tasks/execute`)).status, 405);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], registry);
    assert.equal(calls[0][3], projectVerificationRegistry);
  }
});

test('GET workflow route returns deterministic 405 with Allow POST', async () => {
  await withServer(createApp(loadConfig({})), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/tasks/workflow`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.deepEqual(await response.json(), {
      ok: false, error: 'method_not_allowed', allowedMethods: ['POST'],
    });
  });
});

test('workflow route and server wiring contain no execution side channels at startup', async () => {
  const routeSource = await readFile(new URL('../src/routes/projectTaskWorkflow.ts', import.meta.url), 'utf8');
  const serverSource = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(routeSource.includes('discard'), false);
  assert.equal(routeSource.includes('child_process'), false);
  assert.doesNotMatch(routeSource, /\b(push|merge|deploy)\b/i);
  assert.match(serverSource, /createFileProjectVerificationRegistry/);
  assert.match(serverSource, /config\.projectVerificationPath === ''/);
  assert.match(serverSource, /createFileProjectVerificationRegistry\(config\.projectVerificationPath\)/);
  assert.equal(serverSource.includes('executeProjectTaskWorkflow'), false);
  assert.equal(serverSource.includes('writeFile'), false);
});
