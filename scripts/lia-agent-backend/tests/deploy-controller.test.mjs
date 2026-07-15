import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeController, jsonText, parseArgs } from '../deploy-controller.mjs';

const HEAD = 'a'.repeat(40);

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lia-deploy-controller-test-'));
  const repoRoot = path.join(root, 'repo');
  const sourceBackendDir = path.join(repoRoot, 'backend', 'lia-agent');
  const deployDir = path.join(root, 'deploy-live');
  const backupRoot = path.join(root, 'backups');
  await mkdir(path.join(sourceBackendDir, 'dist'), { recursive: true });
  await mkdir(deployDir, { recursive: true });
  await writeFile(path.join(sourceBackendDir, 'package.json'), JSON.stringify({ name: 'lia-agent-backend', version: '4.10.0-a' }));
  await writeFile(path.join(sourceBackendDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  await writeFile(path.join(sourceBackendDir, 'dist', 'server.js'), 'console.log("target");\n');
  await writeFile(path.join(sourceBackendDir, 'README.md'), '# target\n');
  await writeFile(path.join(deployDir, 'server.mjs'), 'console.log("legacy");\n');
  await writeFile(path.join(deployDir, 'package.json'), JSON.stringify({ name: 'lia-agent-backend', version: '4.4.0-b' }));

  const policy = {
    allowedServicePorts: [4004, 4014, 4023],
    backupRoot,
    branch: 'test-branch',
    currentScript: 'server.mjs',
    currentVersion: 'v4.4.0-b',
    deployDir,
    healthPath: '/health',
    host: '127.0.0.1',
    pm2ProcessName: 'lia-agent-backend',
    port: 4014,
    repoRoot,
    schemaVersion: 'lia-agent-backend-deploy/v1-test',
    sourceBackendDir,
    statusPath: '/api/status',
    targetScript: 'dist/server.js',
    targetVersion: 'v4.10.0-a',
  };

  const request = {
    allowedServicePorts: policy.allowedServicePorts,
    backupRoot,
    deployDir,
    expectedBranch: policy.branch,
    expectedCurrentScript: policy.currentScript,
    expectedCurrentVersion: policy.currentVersion,
    expectedHead: HEAD,
    expectedRepoRoot: repoRoot,
    expectedTag: 'v-test',
    expectedTargetScript: policy.targetScript,
    expectedTargetVersion: policy.targetVersion,
    healthPath: policy.healthPath,
    host: policy.host,
    operationId: 'test-operation',
    pm2ProcessName: policy.pm2ProcessName,
    port: policy.port,
    schemaVersion: policy.schemaVersion,
    sourceBackendDir,
    statusPath: policy.statusPath,
  };

  return { root, policy, request };
}

function makeRunner({ deployDir = '/tmp/lia-agent-backend', failAfterLiveSwitch = false, pm2 = {} } = {}) {
  const calls = [];
  const state = {
    cwd: pm2.cwd ?? deployDir,
    failAfterLiveSwitch,
    present: pm2.present ?? true,
    script: pm2.script ?? 'server.mjs',
    status: pm2.status ?? 'online',
    version: pm2.version ?? 'v4.4.0-b',
  };
  const processEntry = () => ({
    name: 'lia-agent-backend',
    pm2_env: {
      pm_cwd: state.cwd,
      pm_exec_path: path.resolve(state.cwd, state.script),
      status: state.status,
    },
  });
  const runner = async (command, args, options = {}) => {
    calls.push({ args, command, options });
    assert.notEqual(options.shell, true);
    if (command === 'git' && args.join(' ') === 'rev-parse --abbrev-ref HEAD') return ok('test-branch');
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return ok(HEAD);
    if (command === 'git' && args.join(' ') === 'tag --points-at HEAD') return ok('v-test');
    if (command === 'git' && args.join(' ') === 'status --porcelain') return ok('');
    if (command === 'pm2' && args[0] === 'jlist') {
      return ok(JSON.stringify(state.present ? [processEntry()] : []));
    }
    if (command === 'ss') return ok(`LISTEN 0 511 127.0.0.1:4014 0.0.0.0:* users:(("node",pid=1,fd=1))`);
    if (command === 'npm' && args.join(' ') === 'run self-check') return ok('self-check-ok');
    if (command === 'npm' && args[0] === 'ci') return ok('npm-ci-ok');
    if (command === 'pm2' && args[0] === 'delete') {
      if (args[1] !== 'lia-agent-backend') return { args, code: 1, ok: false, shell: false, stderr: 'process not allowed', stdout: '' };
      if (!state.present) return { args, code: 1, ok: false, shell: false, stderr: 'process not found', stdout: '' };
      state.present = false;
      return ok('deleted');
    }
    if (command === 'pm2' && args[0] === 'start') {
      if (state.present) return { args, code: 1, ok: false, shell: false, stderr: 'process already exists', stdout: '' };
      if (args[3] !== 'lia-agent-backend') return { args, code: 1, ok: false, shell: false, stderr: 'process not allowed', stdout: '' };
      state.present = true;
      state.script = args[1];
      state.cwd = options.cwd;
      state.status = 'online';
      state.version = args[1] === 'server.mjs' ? 'v4.4.0-b' : 'v4.10.0-a';
      return ok('started');
    }
    if (command === 'pm2' && args[0] === 'save') return ok('saved');
    return ok('');
  };
  return { calls, runner, state };
}

function makeRecordingFsApi(overrides = {}) {
  const calls = [];
  const api = {};
  for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'access', 'mkdir', 'cp', 'rm', 'rename', 'realpath']) {
    api[name] = async (...args) => {
      calls.push({ args, name });
      if (name === 'cp' && overrides.failCp) throw new Error('copy_failed_for_test');
      if (name === 'readFile' && overrides.failReadFile?.(args[0])) throw new Error('read_failed_for_test');
      if (name === 'access' && overrides.accessExists?.(args[0])) return undefined;
      if (name === 'stat' && overrides.statDev?.[args[0]]) {
        const value = await fsPromises.stat(...args);
        return new Proxy(value, { get: (target, prop) => (prop === 'dev' ? overrides.statDev[args[0]] : target[prop]) });
      }
      if (name === 'rename' && overrides.failRenameAt === calls.filter((call) => call.name === 'rename').length) {
        throw new Error('rename_failed_for_test');
      }
      return fsPromises[name](...args);
    };
  }
  api.calls = calls;
  return api;
}

function applyRequest(request) {
  return { ...request, applyAuthorization: `APPLY:lia-agent-backend:${request.operationId}` };
}

async function runApplyFixture({ fsApi, runnerOptions, httpClient } = {}) {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ ...runnerOptions, deployDir: fixture.policy.deployDir });
  const result = await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: httpClient ?? makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  });
  return { calls, fixture, result, state };
}

function commandIndex(calls, command, firstArg) {
  return calls.findIndex((call) => call.command === command && (!firstArg || call.args[0] === firstArg));
}

function commandCount(calls, command, firstArg) {
  return calls.filter((call) => call.command === command && (!firstArg || call.args[0] === firstArg)).length;
}

async function assertLegacyDeployIntact(fixture) {
  assert.equal(await readFile(path.join(fixture.policy.deployDir, 'server.mjs'), 'utf8'), 'console.log("legacy");\n');
}

function makeHttpClient(state = { version: 'v4.4.0-b' }) {
  return async ({ port, path: requestPath, method }) => {
    if (port === 4004 || port === 4023) return { ok: true, statusCode: 200, body: '{}' };
    if (method === 'POST' && requestPath === '/health') return { ok: true, statusCode: 405, body: '{}' };
    if (requestPath.startsWith('/__missing_')) return { ok: true, statusCode: 404, body: '{}' };
    if (requestPath === '/health') {
      if (state.failAfterLiveSwitch && state.version === 'v4.10.0-a') {
        return { ok: true, statusCode: 500, body: JSON.stringify({ version: state.version }) };
      }
      return { ok: true, statusCode: 200, body: JSON.stringify({ version: state.version }) };
    }
    if (requestPath === '/api/status') return { ok: true, statusCode: 200, body: JSON.stringify({ version: state.version }) };
    return { ok: true, statusCode: 404, body: '{}' };
  };
}

function ok(stdout) {
  return { args: [], code: 0, ok: true, shell: false, stderr: '', stdout };
}

async function runValidDryRun() {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const result = await executeController({
    argv: ['--dry-run', '--request', path.join(fixture.root, 'request.json')],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: fixture.request,
    runner,
  });
  return { fixture, result };
}

test('dry-run valido produce plan determinista', async () => {
  const { fixture, result } = await runValidDryRun();
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.wouldRun.slice(0, 5), [
    'validate-request',
    'validate-repository',
    'validate-current-runtime',
    'run-source-self-check',
    'prepare-release',
  ]);
  assert.ok(result.plan.wouldRun.includes('validate-same-filesystem'));
  assert.ok(result.plan.wouldRun.includes('validate-backup-destination-absent'));
  assert.ok(result.plan.wouldRun.includes('atomic-rename-live-to-backup'));
  assert.ok(result.plan.wouldRun.includes('atomic-rename-release-to-live'));
  assert.ok(result.plan.wouldRun.includes('automatic-rollback-by-rename'));
  assert.ok(result.plan.wouldRun.includes('pm2-save-after-success'));
  assert.match(jsonText(result), /"mode": "dry-run"/);
  await rm(fixture.root, { recursive: true, force: true });
});

test('request incompleto rechazado', async () => {
  const { policy } = await makeFixture();
  await assert.rejects(() => executeController({ argv: ['--dry-run', '--request', '/tmp/request.json'], policy, request: { schemaVersion: policy.schemaVersion } }), /request_missing_field/);
});

test('ruta relativa rechazada', async () => {
  const { policy, request } = await makeFixture();
  await assert.rejects(() => executeController({ argv: ['--dry-run', '--request', '/tmp/request.json'], policy, request: { ...request, deployDir: 'relative' } }), /deployDir_must_be_absolute/);
});

test('traversal rechazado', async () => {
  const { policy, request } = await makeFixture();
  await assert.rejects(() => executeController({ argv: ['--dry-run', '--request', '/tmp/request.json'], policy, request: { ...request, backupRoot: `${policy.backupRoot}/../bad` } }), /backupRoot_must_not_contain_traversal/);
});

test('symlink rechazado', async () => {
  const { root, policy, request } = await makeFixture();
  const link = path.join(root, 'deploy-link');
  await symlink(policy.deployDir, link);
  await assert.rejects(() => executeController({
    argv: ['--dry-run', '--request', '/tmp/request.json'],
    policy: { ...policy, deployDir: link },
    request: { ...request, deployDir: link },
  }), /deployDir_must_not_use_symlink/);
  await rm(root, { recursive: true, force: true });
});

test('allowlist rechaza deployDir backupRoot pm2 host y puerto', async () => {
  const { policy, request } = await makeFixture();
  await assert.rejects(() => executeController({ argv: ['--dry-run', '--request', '/tmp/request.json'], policy, request: { ...request, deployDir: `${policy.deployDir}-bad` } }), /deploy_dir_not_allowed/);
  await assert.rejects(() => executeController({ argv: ['--dry-run', '--request', '/tmp/request.json'], policy, request: { ...request, backupRoot: `${policy.backupRoot}-bad` } }), /backup_root_not_allowed/);
  await assert.rejects(() => executeController({ argv: ['--dry-run', '--request', '/tmp/request.json'], policy, request: { ...request, pm2ProcessName: 'bad' } }), /pm2_process_not_allowed/);
  await assert.rejects(() => executeController({ argv: ['--dry-run', '--request', '/tmp/request.json'], policy, request: { ...request, host: '0.0.0.0' } }), /host_not_allowed/);
  await assert.rejects(() => executeController({ argv: ['--dry-run', '--request', '/tmp/request.json'], policy, request: { ...request, port: 9999 } }), /port_not_allowed/);
});

test('argumentos desconocidos y multiples modos rechazados', () => {
  assert.throws(() => parseArgs(['--dry-run', '--wat']), /unknown_argument/);
  assert.throws(() => parseArgs(['--dry-run', '--apply', '--request', '/tmp/a.json']), /exactly_one_mode_required/);
});

test('apply sin autorizacion valida rechazado', async () => {
  const { policy, request } = await makeFixture();
  await assert.rejects(() => executeController({ argv: ['--apply', '--request', '/tmp/request.json'], policy, request }), /apply_authorization_required/);
});

test('rollback fuera de backupRoot rechazado', async () => {
  const { policy, request } = await makeFixture();
  await assert.rejects(() => executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    policy,
    request: { ...request, rollback: { backupDir: path.join(path.dirname(policy.backupRoot), 'outside') } },
  }), /rollback\.backupDir_outside_allowed_root/);
});

test('rollback automatico simulado tras fallo posterior al cambio vivo', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir, failAfterLiveSwitch: true });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: { ...fixture.request, applyAuthorization: `APPLY:lia-agent-backend:${fixture.request.operationId}` },
    runner,
  }), /apply_failed_automatic_rollback_succeeded/);
  assert.equal(state.script, 'server.mjs');
  assert.equal(state.version, 'v4.4.0-b');
  assert.ok(calls.some((call) => call.command === 'pm2' && call.args[0] === 'save'));
  assert.equal(calls.some((call) => call.options.shell === true), false);
  await rm(fixture.root, { recursive: true, force: true });
});

test('apply valido usa rename y nunca elimina deployDir ni backup seleccionado', async () => {
  const fsApi = makeRecordingFsApi();
  const { calls, fixture, result } = await runApplyFixture({ fsApi });
  assert.equal(result.ok, true);
  assert.equal(fsApi.calls.filter((call) => call.name === 'rename').length, 2);
  assert.equal(commandCount(calls, 'pm2', 'delete'), 1);
  assert.equal(commandCount(calls, 'pm2', 'start'), 1);
  assert.equal(commandIndex(calls, 'pm2', 'delete') < commandIndex(calls, 'pm2', 'start'), true);
  assert.equal(fsApi.calls.some((call) => call.name === 'rm' && call.args[0] === fixture.policy.deployDir), false);
  assert.equal(fsApi.calls.some((call) => call.name === 'rm' && call.args[0] === result.backupDir), false);
  assert.equal(await readFile(path.join(fixture.policy.deployDir, 'dist', 'server.js'), 'utf8'), 'console.log("target");\n');
  assert.equal(await readFile(path.join(result.backupDir, 'server.mjs'), 'utf8'), 'console.log("legacy");\n');
  await rm(fixture.root, { recursive: true, force: true });
});

test('runner falso rechaza doble delete y el controlador lo evita', async () => {
  const fixture = await makeFixture();
  const { calls, runner } = makeRunner({ deployDir: fixture.policy.deployDir });
  assert.equal((await runner('pm2', ['delete', 'lia-agent-backend'], { shell: false })).ok, true);
  assert.equal((await runner('pm2', ['delete', 'lia-agent-backend'], { shell: false })).ok, false);

  const apply = await runApplyFixture();
  assert.equal(commandCount(apply.calls, 'pm2', 'delete'), 1);
  assert.equal(commandCount(apply.calls, 'pm2', 'start'), 1);
  await rm(fixture.root, { recursive: true, force: true });
  await rm(apply.fixture.root, { recursive: true, force: true });
});

test('pm2 jlist invalido y proceso duplicado son rechazados', async () => {
  for (const stdout of ['not-json', JSON.stringify([
    { name: 'lia-agent-backend', pm2_env: { status: 'online' } },
    { name: 'lia-agent-backend', pm2_env: { status: 'online' } },
  ])]) {
    const fixture = await makeFixture();
    const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
    const badRunner = async (command, args, options) => (
      command === 'pm2' && args[0] === 'jlist' ? ok(stdout) : runner(command, args, options)
    );
    await assert.rejects(() => executeController({
      argv: ['--dry-run', '--request', '/tmp/request.json'],
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: fixture.request,
      runner: badRunner,
    }), /pm2_jlist_json_invalid|pm2_process_duplicate/);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('start valida estado online script y cwd PM2', async () => {
  const scenarios = [
    { mutate: (state) => { state.status = 'errored'; }, error: /pm2_process_not_online_after_start/ },
    { mutate: (state) => { state.script = 'server.mjs'; }, error: /pm2_process_script_mismatch/ },
    { mutate: (state) => { state.cwd = '/tmp/wrong-cwd'; }, error: /pm2_process_cwd_mismatch/ },
  ];

  for (const scenario of scenarios) {
    const fixture = await makeFixture();
    const fsApi = makeRecordingFsApi();
    const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
    const mutatingRunner = async (command, args, options) => {
      const result = await runner(command, args, options);
      if (command === 'pm2' && args[0] === 'start' && args[1] === fixture.request.expectedTargetScript && result.ok) {
        scenario.mutate(state);
      }
      return result;
    };
    await assert.rejects(() => executeController({
      argv: ['--apply', '--request', '/tmp/request.json'],
      fsApi,
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: applyRequest(fixture.request),
      runner: mutatingRunner,
    }), /apply_failed_automatic_rollback_succeeded/);
    await assertLegacyDeployIntact(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fallos preparando release npm ci y hashes dejan deploy intacto', async () => {
  for (const fsApi of [
    makeRecordingFsApi({ failCp: true }),
    null,
    makeRecordingFsApi({ failReadFile: (target) => String(target).endsWith(path.join('dist', 'server.js')) }),
  ]) {
    const fixture = await makeFixture();
    const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
    const effectiveFsApi = fsApi ?? makeRecordingFsApi();
    const runnerWithNpmFailure = fsApi === null
      ? async (command, args, options) => (command === 'npm' && args[0] === 'ci' ? { args, code: 1, ok: false, shell: false, stderr: 'npm failed', stdout: '' } : runner(command, args, options))
      : runner;
    await assert.rejects(() => executeController({
      argv: ['--apply', '--request', '/tmp/request.json'],
      fsApi: effectiveFsApi,
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: applyRequest(fixture.request),
      runner: runnerWithNpmFailure,
    }));
    assert.equal(effectiveFsApi.calls.some((call) => call.name === 'rename'), false);
    await assertLegacyDeployIntact(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('backup y release preexistentes se rechazan antes de PM2', async () => {
  const fixture = await makeFixture();
  await mkdir(fixture.policy.backupRoot, { recursive: true });
  const fsApi = makeRecordingFsApi({ accessExists: (target) => path.basename(String(target)).endsWith(fixture.request.operationId) && !path.basename(String(target)).startsWith('.prepared-') });
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), /backupDir_already_exists/);
  assert.equal(commandIndex(calls, 'pm2', 'delete'), -1);
  await rm(fixture.root, { recursive: true, force: true });

  const fixture2 = await makeFixture();
  await mkdir(path.join(fixture2.policy.backupRoot, `.prepared-${fixture2.request.operationId}`), { recursive: true });
  const { calls: calls2, runner: runner2, state: state2 } = makeRunner({ deployDir: fixture2.policy.deployDir });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state2),
    policy: fixture2.policy,
    request: applyRequest(fixture2.request),
    runner: runner2,
  }), /releaseDir_already_exists/);
  assert.equal(commandIndex(calls2, 'pm2', 'delete'), -1);
  await rm(fixture2.root, { recursive: true, force: true });
});

test('filesystem distinto se rechaza antes de PM2', async () => {
  const fixture = await makeFixture();
  const fsApi = makeRecordingFsApi({ statDev: { [fixture.policy.backupRoot]: 999999 } });
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), /same_filesystem_required/);
  assert.equal(commandIndex(calls, 'pm2', 'delete'), -1);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('symlink introducido antes del rename es detectado', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const mutatingRunner = async (command, args, options) => {
    const result = await runner(command, args, options);
    if (command === 'pm2' && args[0] === 'delete') {
      await rm(fixture.policy.deployDir, { recursive: true, force: true });
      await symlink(fixture.policy.sourceBackendDir, fixture.policy.deployDir);
    }
    return result;
  };
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner: mutatingRunner,
  }), /deployDir_must_not_use_symlink/);
  assert.equal(calls.some((call) => call.command === 'pm2' && call.args[0] === 'save'), false);
  await rm(fixture.root, { recursive: true, force: true });
});

test('fallo del primer rename no intenta rollback y deja deploy intacto', async () => {
  const fixture = await makeFixture();
  const fsApi = makeRecordingFsApi({ failRenameAt: 1 });
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), /rename_failed_for_test/);
  assert.equal(fsApi.calls.filter((call) => call.name === 'rename').length, 1);
  assert.equal(calls.some((call) => call.command === 'pm2' && call.args[0] === 'save'), false);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('fallos del segundo rename start y health activan rollback por rename', async () => {
  for (const scenario of ['second-rename', 'pm2-start', 'health']) {
    const fixture = await makeFixture();
    const fsApi = scenario === 'second-rename' ? makeRecordingFsApi({ failRenameAt: 2 }) : makeRecordingFsApi();
    const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
    if (scenario === 'health') state.failAfterLiveSwitch = true;
    const scenarioRunner = async (command, args, options) => {
      if (scenario === 'pm2-start' && command === 'pm2' && args[0] === 'start' && args[1] === 'dist/server.js') {
        return { args, code: 1, ok: false, shell: false, stderr: 'start failed', stdout: '' };
      }
      return runner(command, args, options);
    };
    await assert.rejects(() => executeController({
      argv: ['--apply', '--request', '/tmp/request.json'],
      fsApi,
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: applyRequest(fixture.request),
      runner: scenarioRunner,
    }), /apply_failed_automatic_rollback_succeeded/);
    if (scenario === 'second-rename' || scenario === 'pm2-start') {
      assert.equal(commandCount(calls, 'pm2', 'delete'), 1);
    }
    if (scenario === 'health') {
      assert.equal(commandCount(calls, 'pm2', 'delete'), 2);
      assert.equal(commandIndex(calls.slice(commandIndex(calls, 'pm2', 'start') + 1), 'pm2', 'delete') >= 0, true);
    }
    await assertLegacyDeployIntact(fixture);
    assert.ok(fsApi.calls.filter((call) => call.name === 'rename').length >= 2);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback conserva evidencia fallida y reporta fallo sin ocultar error original', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir, failAfterLiveSwitch: true });
  await assert.rejects(async () => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_automatic_rollback_succeeded');
    assert.match(error.details.originalError, /target_verification_failed/);
    assert.ok(error.details.failedReleaseDir.endsWith(`failed-release-${fixture.request.operationId}`));
    return true;
  });
  assert.equal(await readFile(path.join(fixture.policy.backupRoot, `failed-release-${fixture.request.operationId}`, 'dist', 'server.js'), 'utf8'), 'console.log("target");\n');
  await rm(fixture.root, { recursive: true, force: true });

  const fixture2 = await makeFixture();
  const fsApi = makeRecordingFsApi({ failRenameAt: 3 });
  const { runner: runner2, state: state2 } = makeRunner({ deployDir: fixture2.policy.deployDir, failAfterLiveSwitch: true });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: makeHttpClient(state2),
    policy: fixture2.policy,
    request: applyRequest(fixture2.request),
    runner: runner2,
  }), /apply_failed_automatic_rollback_failed/);
  await rm(fixture2.root, { recursive: true, force: true });
});

test('pm2 save ocurre solo despues de validacion exitosa en apply y rollback', async () => {
  const { calls, fixture } = await runApplyFixture();
  assert.ok(commandIndex(calls, 'pm2', 'save') > commandIndex(calls, 'ss'));
  await rm(fixture.root, { recursive: true, force: true });

  const fixture2 = await makeFixture();
  const backupDir = path.join(fixture2.policy.backupRoot, 'selected-backup');
  await mkdir(fixture2.policy.backupRoot, { recursive: true });
  await fsPromises.rename(fixture2.policy.deployDir, backupDir);
  const { calls: calls2, runner: runner2, state: state2 } = makeRunner({ deployDir: fixture2.policy.deployDir });
  const result = await executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state2),
    policy: fixture2.policy,
    request: { ...fixture2.request, rollback: { backupDir } },
    runner: runner2,
  });
  assert.equal(result.ok, true);
  assert.ok(commandIndex(calls2, 'pm2', 'save') > commandIndex(calls2, 'ss'));
  await rm(fixture2.root, { recursive: true, force: true });
});

test('rollback explicito detiene proceso presente y omite delete si esta ausente', async () => {
  for (const present of [true, false]) {
    const fixture = await makeFixture();
    const backupDir = path.join(fixture.policy.backupRoot, `selected-backup-${present}`);
    await mkdir(fixture.policy.backupRoot, { recursive: true });
    await fsPromises.rename(fixture.policy.deployDir, backupDir);
    const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir, pm2: { present } });
    const result = await executeController({
      argv: ['--rollback', '--request', '/tmp/request.json'],
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: { ...fixture.request, rollback: { backupDir } },
      runner,
    });
    assert.equal(result.ok, true);
    assert.equal(commandCount(calls, 'pm2', 'delete'), present ? 1 : 0);
    assert.equal(commandCount(calls, 'pm2', 'start'), 1);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('pm2 save no ocurre ante fallo y los comandos PM2 usan solo el nombre autorizado', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const failingRunner = async (command, args, options) => (
    command === 'npm' && args[0] === 'ci'
      ? { args, code: 1, ok: false, shell: false, stderr: 'npm failed', stdout: '' }
      : runner(command, args, options)
  );
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner: failingRunner,
  }), /npm-ci-production_failed/);
  assert.equal(calls.some((call) => call.command === 'pm2' && call.args[0] === 'save'), false);
  for (const call of calls.filter((item) => item.command === 'pm2')) {
    if (call.args[0] === 'delete') assert.equal(call.args[1], 'lia-agent-backend');
    if (call.args[0] === 'start') assert.deepEqual(call.args.slice(2, 4), ['--name', 'lia-agent-backend']);
    assert.equal(call.options.shell, false);
  }
  await rm(fixture.root, { recursive: true, force: true });
});

test('rollback explicito rechaza backup symlink inexistente incompleto y version distinta', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir, pm2: { present: false } });
  await mkdir(fixture.policy.backupRoot, { recursive: true });
  const missingBackup = path.join(fixture.policy.backupRoot, 'missing');
  await rm(fixture.policy.deployDir, { recursive: true, force: true });
  await assert.rejects(() => executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: { ...fixture.request, rollback: { backupDir: missingBackup } },
    runner,
  }), /backupDir_missing/);

  const linkBackup = path.join(fixture.policy.backupRoot, 'link-backup');
  await symlink(fixture.policy.sourceBackendDir, linkBackup);
  await assert.rejects(() => executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: { ...fixture.request, rollback: { backupDir: linkBackup } },
    runner,
  }), /rollback\.backupDir_must_not_use_symlink/);
  await rm(linkBackup, { force: true });

  const incompleteBackup = path.join(fixture.policy.backupRoot, 'incomplete');
  await mkdir(incompleteBackup);
  await assert.rejects(() => executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: { ...fixture.request, rollback: { backupDir: incompleteBackup } },
    runner,
  }), /backup_package_json_missing/);

  await writeFile(path.join(incompleteBackup, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  await assert.rejects(() => executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: { ...fixture.request, rollback: { backupDir: incompleteBackup } },
    runner,
  }), /backup_expected_script_missing/);

  await writeFile(path.join(incompleteBackup, 'server.mjs'), 'console.log("legacy");\n');
  await assert.rejects(() => executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: { ...fixture.request, rollback: { backupDir: incompleteBackup } },
    runner,
  }), /backup_version_mismatch/);
  await rm(fixture.root, { recursive: true, force: true });
});

test('dry-run no llama mkdir cp rm rename writeFile ni comandos mutables', async () => {
  const fixture = await makeFixture();
  const fsApi = makeRecordingFsApi();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const result = await executeController({
    argv: ['--dry-run', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: fixture.request,
    runner,
  });
  assert.equal(result.ok, true);
  assert.equal(fsApi.calls.some((call) => ['mkdir', 'cp', 'rm', 'rename', 'writeFile'].includes(call.name)), false);
  assert.equal(calls.some((call) => call.command === 'npm' || (call.command === 'pm2' && call.args[0] !== 'jlist')), false);
  await rm(fixture.root, { recursive: true, force: true });
});

test('ningun comando usa shell y salida JSON estable', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const result = await executeController({
    argv: ['--dry-run', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: fixture.request,
    runner,
  });
  assert.equal(calls.every((call) => call.options.shell === false), true);
  assert.equal(jsonText(result), jsonText(result));
  await rm(fixture.root, { recursive: true, force: true });
});
