import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSafePm2Environment, executeController as rawExecuteController, jsonText, parseArgs, validateSafePm2Environment } from '../deploy-controller.mjs';

const HEAD = 'a'.repeat(40);
const SAFE_PM2_ENV_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LIA_AGENT_CORS_ORIGINS',
  'LIA_AGENT_HOST',
  'LIA_AGENT_LOG_LEVEL',
  'LIA_AGENT_PORT',
  'LOGNAME',
  'NODE_ENV',
  'PATH',
  'PM2_HOME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'USER',
].sort();
const SECRET_ENV_FIXTURE = {
  ANTHROPIC_API_KEY: 'SHOULD_NOT_LEAK_ANTHROPIC',
  DATABASE_URL: 'SHOULD_NOT_LEAK_DATABASE',
  GITHUB_TOKEN: 'SHOULD_NOT_LEAK_GITHUB',
  NODE_OPTIONS: '--require SHOULD_NOT_LEAK_NODE_OPTIONS',
  OPENAI_API_KEY: 'SHOULD_NOT_LEAK_OPENAI',
  RANDOM_SECRET: 'SHOULD_NOT_LEAK_RANDOM_SECRET',
  SUPABASE_SERVICE_ROLE_KEY: 'SHOULD_NOT_LEAK_SUPABASE',
};
const SECRET_VALUES = Object.values(SECRET_ENV_FIXTURE);
const NOOP_SLEEP = async () => {};

function makeRecordingSleep() {
  const calls = [];
  const sleep = async (ms) => {
    calls.push(ms);
  };
  return { calls, sleep };
}

async function executeController(options) {
  return rawExecuteController({ sleep: NOOP_SLEEP, ...options });
}

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
    allowedServicePorts: [3004, 3014, 3023],
    backupRoot,
    branch: 'test-branch',
    currentScript: 'server.mjs',
    currentVersion: 'v4.4.0-b',
    deployDir,
    healthPath: '/health',
    host: '127.0.0.1',
    pm2ProcessName: 'lia-agent-backend',
    port: 3014,
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
    cwd: Object.hasOwn(pm2, 'cwd') ? pm2.cwd : deployDir,
    deleteCount: 0,
    duplicate: pm2.duplicate ?? false,
    failCurrentStart: pm2.failCurrentStart ?? false,
    failAfterLiveSwitch,
    failSave: pm2.failSave ?? false,
    invalidJlistAfterDeleteCount: pm2.invalidJlistAfterDeleteCount ?? 0,
    jlistFailuresAfterDeleteCount: pm2.jlistFailuresAfterDeleteCount ?? 0,
    omitCwdAfterStart: pm2.omitCwdAfterStart ?? false,
    pmExecPath: pm2.pmExecPath ?? path.resolve(deployDir, pm2.script ?? 'server.mjs'),
    present: pm2.present ?? true,
    reappearAfterDelete: pm2.reappearAfterDelete ?? null,
    script: pm2.script ?? 'server.mjs',
    status: pm2.status ?? 'online',
    version: pm2.version ?? 'v4.4.0-b',
  };
  const processEntry = () => {
    const pm2Env = {
      pm_exec_path: state.pmExecPath ?? path.resolve(deployDir, state.script),
      status: state.status,
    };
    if (state.cwd !== undefined) pm2Env.pm_cwd = state.cwd;
    if (state.cwdField !== undefined) pm2Env.cwd = state.cwdField;
    return { name: 'lia-agent-backend', pm2_env: pm2Env };
  };
  const runner = async (command, args, options = {}) => {
    calls.push({ args, command, options });
    assert.notEqual(options.shell, true);
    if (command === 'git' && args.join(' ') === 'rev-parse --abbrev-ref HEAD') return ok('test-branch');
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return ok(HEAD);
    if (command === 'git' && args.join(' ') === 'tag --points-at HEAD') return ok('v-test');
    if (command === 'git' && args.join(' ') === 'status --porcelain') return ok('');
    if (command === 'pm2' && args[0] === 'jlist') {
      if (state.deleteCount > 0 && state.jlistFailuresAfterDeleteCount > 0) {
        state.jlistFailuresAfterDeleteCount -= 1;
        return { args, code: 1, ok: false, shell: false, stderr: 'jlist failed after delete', stdout: '' };
      }
      if (state.deleteCount > 0 && state.invalidJlistAfterDeleteCount > 0) {
        state.invalidJlistAfterDeleteCount -= 1;
        return ok('not-json');
      }
      if (state.duplicate) return ok(JSON.stringify([processEntry(), processEntry()]));
      return ok(JSON.stringify(state.present ? [processEntry()] : []));
    }
    if (command === 'ss') return ok(`LISTEN 0 511 127.0.0.1:3014 0.0.0.0:* users:(("node",pid=1,fd=1))`);
    if (command === 'npm' && args.join(' ') === 'run self-check') return ok('self-check-ok');
    if (command === 'npm' && args[0] === 'ci') return ok('npm-ci-ok');
    if (command === 'pm2' && args[0] === 'delete') {
      if (args[1] !== 'lia-agent-backend') return { args, code: 1, ok: false, shell: false, stderr: 'process not allowed', stdout: '' };
      if (!state.present) return { args, code: 1, ok: false, shell: false, stderr: 'process not found', stdout: '' };
      state.present = false;
      state.deleteCount += 1;
      if (state.reappearAfterDelete) {
        const reappeared = state.reappearAfterDelete;
        Object.assign(state, reappeared, { present: true });
        if (!Object.hasOwn(reappeared, 'pmExecPath')) state.pmExecPath = path.resolve(deployDir, state.script);
        if (!Object.hasOwn(reappeared, 'cwdField')) state.cwdField = undefined;
        state.reappearAfterDelete = null;
      }
      return ok('deleted');
    }
    if (command === 'pm2' && args[0] === 'start') {
      if (state.failCurrentStart && args[1] === 'server.mjs') return { args, code: 1, ok: false, shell: false, stderr: 'start failed for recovery', stdout: '' };
      if (state.present) return { args, code: 1, ok: false, shell: false, stderr: 'process already exists', stdout: '' };
      if (args[3] !== 'lia-agent-backend') return { args, code: 1, ok: false, shell: false, stderr: 'process not allowed', stdout: '' };
      state.present = true;
      state.script = args[1];
      state.cwd = state.omitCwdAfterStart ? undefined : options.cwd;
      state.cwdField = undefined;
      state.pmExecPath = path.resolve(options.cwd, args[1]);
      state.status = 'online';
      state.version = args[1] === 'server.mjs' ? 'v4.4.0-b' : 'v4.10.0-a';
      return ok('started');
    }
    if (command === 'pm2' && args[0] === 'save') {
      if (state.failSave) return { args, code: 1, ok: false, shell: false, stderr: 'save failed for test', stdout: '' };
      return ok('saved');
    }
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

function makeOneShotFailingFsApi({ afterDelete, name, predicate, message }) {
  const fsApi = makeRecordingFsApi();
  let failed = false;
  const original = fsApi[name];
  fsApi[name] = async (...args) => {
    fsApi.calls.push({ args, name });
    if (!failed && afterDelete() && predicate(...args)) {
      failed = true;
      throw new Error(message);
    }
    return fsPromises[name](...args);
  };
  fsApi[`original_${name}`] = original;
  return fsApi;
}

function applyRequest(request) {
  return { ...request, applyAuthorization: `APPLY:lia-agent-backend:${request.operationId}` };
}

async function runApplyFixture({ fsApi, runnerOptions, httpClient, sleep = NOOP_SLEEP } = {}) {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ ...runnerOptions, deployDir: fixture.policy.deployDir });
  const result = await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: httpClient ?? makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep,
  });
  return { calls, fixture, result, state };
}

function commandIndex(calls, command, firstArg) {
  return calls.findIndex((call) => call.command === command && (!firstArg || call.args[0] === firstArg));
}

function commandCount(calls, command, firstArg) {
  return calls.filter((call) => call.command === command && (!firstArg || call.args[0] === firstArg)).length;
}

function lastCommandIndex(calls, command, firstArg) {
  return calls.findLastIndex((call) => call.command === command && (!firstArg || call.args[0] === firstArg));
}

async function assertLegacyDeployIntact(fixture) {
  assert.equal(await readFile(path.join(fixture.policy.deployDir, 'server.mjs'), 'utf8'), 'console.log("legacy");\n');
}

function makeHttpClient(state = { version: 'v4.4.0-b' }) {
  return async ({ port, path: requestPath, method }) => {
    if (port === 3004 || port === 3023) return { ok: true, statusCode: 200, body: '{}' };
    if (method === 'POST' && requestPath === '/health') return { ok: true, statusCode: 405, body: '{}' };
    if (requestPath.startsWith('/__missing_')) return { ok: true, statusCode: 404, body: '{}' };
    if (requestPath === '/health') {
      if (state.failRecoveryHealth && state.deleteCount > 0 && state.version === 'v4.4.0-b') {
        return { ok: true, statusCode: 500, body: JSON.stringify({ version: state.version }) };
      }
      if (state.failAfterLiveSwitch && state.version === 'v4.10.0-a') {
        return { ok: true, statusCode: 500, body: JSON.stringify({ version: state.version }) };
      }
      return { ok: true, statusCode: 200, body: JSON.stringify({ version: state.version }) };
    }
    if (requestPath === '/api/status') {
      return { ok: true, statusCode: state.statusStatusCode ?? 200, body: JSON.stringify({ version: state.version }) };
    }
    return { ok: true, statusCode: 404, body: '{}' };
  };
}

function makeSequencedHttpClient(state, sequences = {}) {
  const calls = [];
  const counters = new Map();
  const base = makeHttpClient(state);
  const nextFor = (key) => {
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    const sequence = sequences[key] ?? [];
    return index < sequence.length ? sequence[index] : undefined;
  };
  const materialize = (entry, request) => {
    if (!entry) return undefined;
    if (entry instanceof Error) throw entry;
    if (entry.error) return { ok: false, statusCode: 0, body: entry.body ?? '', error: entry.error };
    if (entry.statusCode !== undefined || entry.version !== undefined) {
      const statusCode = entry.statusCode ?? 200;
      const version = entry.version ?? state.version;
      return { ok: entry.ok ?? true, statusCode, body: entry.body ?? JSON.stringify({ version }) };
    }
    if (typeof entry === 'function') return entry(request);
    return entry;
  };
  const httpClient = async (request) => {
    calls.push(request);
    if (request.port !== 3014) return base(request);
    const key = `${request.method ?? 'GET'} ${request.path}`;
    const entry = nextFor(key);
    const response = materialize(entry, request);
    return response ?? base(request);
  };
  httpClient.calls = calls;
  return httpClient;
}

function makeRuntimeReadinessHttpClient(state, { originalHealth = [], targetHealth = [], targetStatus = [] } = {}) {
  const calls = [];
  const counters = { originalHealth: 0, targetHealth: 0, targetStatus: 0 };
  const base = makeHttpClient(state);
  const responseFrom = (sequence, counterName, fallback) => {
    const index = counters[counterName];
    counters[counterName] += 1;
    const entry = sequence[index];
    if (!entry) return fallback();
    if (entry instanceof Error) throw entry;
    if (entry.error) return { ok: false, statusCode: 0, body: entry.body ?? '', error: entry.error };
    return {
      ok: entry.ok ?? true,
      statusCode: entry.statusCode ?? 200,
      body: entry.body ?? JSON.stringify({ version: entry.version ?? state.version }),
    };
  };
  const httpClient = async (request) => {
    calls.push(request);
    if (request.port !== 3014) return base(request);
    if (request.method === 'GET' && request.path === '/health' && state.version === 'v4.10.0-a') {
      return responseFrom(targetHealth, 'targetHealth', () => base(request));
    }
    if (request.method === 'GET' && request.path === '/api/status' && state.version === 'v4.10.0-a') {
      return responseFrom(targetStatus, 'targetStatus', () => base(request));
    }
    if (request.method === 'GET' && request.path === '/health' && state.version === 'v4.4.0-b' && state.deleteCount > 0) {
      return responseFrom(originalHealth, 'originalHealth', () => base(request));
    }
    return base(request);
  };
  httpClient.calls = calls;
  return httpClient;
}

function ok(stdout) {
  return { args: [], code: 0, ok: true, shell: false, stderr: '', stdout };
}

async function withTemporaryEnv(env, callback) {
  const previous = new Map();
  for (const key of Object.keys(env)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    process.env[key] = env[key];
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  assert.ok(result.plan.wouldRun.includes('validate-pm2-environment-allowlist'));
  assert.ok(result.plan.wouldRun.includes('validate-backup-destination-absent'));
  assert.ok(result.plan.wouldRun.includes('recover-original-runtime-in-place-if-pre-swap-failure'));
  assert.ok(result.plan.wouldRun.includes('atomic-rename-live-to-backup'));
  assert.ok(result.plan.wouldRun.includes('atomic-rename-release-to-live'));
  assert.ok(result.plan.wouldRun.includes('automatic-rollback-by-rename'));
  assert.ok(result.plan.wouldRun.includes('pm2-save-after-success'));
  assert.match(jsonText(result), /"mode": "dry-run"/);
  await rm(fixture.root, { recursive: true, force: true });
});

test('constructor de entorno PM2 no propaga process.env completo ni secretos', async () => {
  const { request, root } = await makeFixture();
  const sourceEnv = {
    ...SECRET_ENV_FIXTURE,
    HOME: '/root',
    NODE_PATH: 'SHOULD_NOT_LEAK_NODE_PATH',
    PATH: '/usr/bin:/bin',
    PM2_HOME: '/root/.pm2',
    SENDGRID_API_KEY: 'SHOULD_NOT_LEAK_SENDGRID',
    TWILIO_AUTH_TOKEN: 'SHOULD_NOT_LEAK_TWILIO',
    UNKNOWN_VARIABLE: 'SHOULD_NOT_LEAK_UNKNOWN',
    USER: 'root',
  };
  const env = buildSafePm2Environment(request, sourceEnv);
  assert.deepEqual(Object.keys(env).sort(), [
    'HOME',
    'LIA_AGENT_CORS_ORIGINS',
    'LIA_AGENT_HOST',
    'LIA_AGENT_LOG_LEVEL',
    'LIA_AGENT_PORT',
    'NODE_ENV',
    'PATH',
    'PM2_HOME',
    'USER',
  ].sort());
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/root');
  assert.equal(env.PM2_HOME, '/root/.pm2');
  assert.equal(env.LIA_AGENT_HOST, '127.0.0.1');
  assert.equal(env.LIA_AGENT_PORT, '3014');
  assert.equal(env.LIA_AGENT_CORS_ORIGINS, '');
  assert.equal(env.LIA_AGENT_LOG_LEVEL, 'info');
  assert.equal(env.NODE_ENV, 'production');
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'GITHUB_TOKEN', 'RANDOM_SECRET', 'NODE_OPTIONS', 'NODE_PATH', 'UNKNOWN_VARIABLE']) {
    assert.equal(Object.hasOwn(env, key), false);
  }
  for (const key of Object.keys(env)) assert.ok(SAFE_PM2_ENV_KEYS.includes(key));
  assert.equal(JSON.stringify(env).includes('SHOULD_NOT_LEAK'), false);
  await rm(root, { recursive: true, force: true });
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

test('pm2 start recibe exactamente el entorno seguro y no filtra secretos ficticios', async () => {
  const operationalEnv = {
    HOME: '/root',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
    LOGNAME: 'root',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    PM2_HOME: '/root/.pm2',
    SHELL: '/bin/bash',
    TMPDIR: '/tmp',
    TZ: 'UTC',
    USER: 'root',
  };
  await withTemporaryEnv({ ...operationalEnv, ...SECRET_ENV_FIXTURE }, async () => {
    const { calls, fixture, result } = await runApplyFixture();
    const startCall = calls.find((call) => call.command === 'pm2' && call.args[0] === 'start');
    assert.ok(startCall);
    assert.deepEqual(startCall.args, ['start', 'dist/server.js', '--name', 'lia-agent-backend', '--interpreter', 'node']);
    assert.equal(startCall.options.cwd, fixture.policy.deployDir);
    assert.equal(startCall.options.shell, false);
    assert.deepEqual(Object.keys(startCall.options.env).sort(), SAFE_PM2_ENV_KEYS);
    assert.equal(startCall.options.env.PATH, operationalEnv.PATH);
    assert.equal(startCall.options.env.HOME, operationalEnv.HOME);
    assert.equal(startCall.options.env.PM2_HOME, operationalEnv.PM2_HOME);
    assert.equal(startCall.options.env.LIA_AGENT_HOST, '127.0.0.1');
    assert.equal(startCall.options.env.LIA_AGENT_PORT, '3014');
    assert.equal(startCall.options.env.LIA_AGENT_CORS_ORIGINS, '');
    assert.equal(startCall.options.env.LIA_AGENT_LOG_LEVEL, 'info');
    assert.equal(startCall.options.env.NODE_ENV, 'production');
    for (const key of Object.keys(SECRET_ENV_FIXTURE)) assert.equal(Object.hasOwn(startCall.options.env, key), false);
    const serialized = JSON.stringify({ result, runnerOptions: calls.map((call) => call.options) });
    for (const value of SECRET_VALUES) assert.equal(serialized.includes(value), false);
    await rm(fixture.root, { recursive: true, force: true });
  });
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
    { mutate: (state) => { state.pmExecPath = path.resolve(state.cwd, 'server.mjs'); }, error: /pm2_process_script_mismatch/ },
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
  }), /apply_failed_original_runtime_recovery_failed/);
  assert.equal(calls.some((call) => call.command === 'pm2' && call.args[0] === 'save'), false);
  await rm(fixture.root, { recursive: true, force: true });
});

test('fallo antes de stop no inicia recuperacion original', async () => {
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
  assert.equal(commandCount(calls, 'pm2', 'delete'), 0);
  assert.equal(commandCount(calls, 'pm2', 'start'), 0);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('fallos post-delete antes del primer rename recuperan server.mjs in-place', async () => {
  const scenarios = [
    {
      name: 'assertCriticalDeployPath',
      fsApi: (fixture, deleted) => makeOneShotFailingFsApi({
        afterDelete: () => deleted.value,
        message: 'deploy_lstat_failed_after_stop',
        name: 'lstat',
        predicate: (target) => target === fixture.policy.deployDir,
      }),
    },
    {
      name: 'assertCriticalBackupPath',
      fsApi: (fixture, deleted) => makeOneShotFailingFsApi({
        afterDelete: () => deleted.value,
        message: 'backup_lstat_failed_after_stop',
        name: 'lstat',
        predicate: (target) => target === fixture.policy.backupRoot,
      }),
    },
    {
      name: 'backup destination absent',
      fsApi: (fixture, deleted) => {
        const fsApi = makeRecordingFsApi();
        const originalAccess = fsApi.access;
        let failed = false;
        fsApi.access = async (...args) => {
          fsApi.calls.push({ args, name: 'access' });
          if (!failed && deleted.value && String(args[0]).includes(fixture.request.operationId) && !String(args[0]).includes('.prepared-')) {
            failed = true;
            return undefined;
          }
          return originalAccess(...args);
        };
        return fsApi;
      },
    },
    {
      name: 'symlink validation before rename',
      fsApi: (fixture, deleted) => makeOneShotFailingFsApi({
        afterDelete: () => deleted.value,
        message: 'deploy_tree_lstat_failed_after_stop',
        name: 'lstat',
        predicate: (target) => target === path.join(fixture.policy.deployDir, 'server.mjs'),
      }),
    },
    {
      name: 'first rename',
      fsApi: () => makeRecordingFsApi({ failRenameAt: 1 }),
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await makeFixture();
    const deleted = { value: false };
    const fsApi = scenario.fsApi(fixture, deleted);
    const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
    const trackingRunner = async (command, args, options) => {
      const result = await runner(command, args, options);
      if (command === 'pm2' && args[0] === 'delete' && result.ok) deleted.value = true;
      return result;
    };
    await assert.rejects(() => executeController({
      argv: ['--apply', '--request', '/tmp/request.json'],
      fsApi,
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: applyRequest(fixture.request),
      runner: trackingRunner,
    }), (error) => {
      assert.equal(error.message, 'apply_failed_original_runtime_recovered_in_place', scenario.name);
      assert.match(error.details.originalError, /failed_after_stop|rename_failed_for_test|backupDir_already_exists/);
      assert.equal(error.details.liveMovedToBackup, false);
      assert.equal(error.details.recovery.recoveryMode, 'original-runtime-in-place');
      return true;
    });
    assert.equal(state.script, 'server.mjs', scenario.name);
    assert.equal(state.version, 'v4.4.0-b', scenario.name);
    assert.equal(commandCount(calls, 'pm2', 'start'), 1, scenario.name);
    assert.equal(fsApi.calls.some((call) => call.name === 'cp' && call.args.includes(fixture.policy.deployDir)), false, scenario.name);
    assert.equal(fsApi.calls.some((call) => call.name === 'rm' && call.args[0] === fixture.policy.deployDir), false, scenario.name);
    assert.equal(fsApi.calls.some((call) => call.name === 'rename' && String(call.args[0]).includes(`failed-release-${fixture.request.operationId}`)), false, scenario.name);
    assert.equal(fsApi.calls.some((call) => call.name === 'rename' && call.args[1] === path.join(fixture.policy.backupRoot, `failed-release-${fixture.request.operationId}`)), false, scenario.name);
    assert.equal(calls.some((call) => call.command === 'pm2' && call.args[0] === 'save'), true, scenario.name);
    assert.equal(lastCommandIndex(calls, 'pm2', 'save') > lastCommandIndex(calls, 'ss'), true, scenario.name);
    await assertLegacyDeployIntact(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fallo del primer rename no intenta rollback por rename y deja deploy intacto', async () => {
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
  }), /apply_failed_original_runtime_recovered_in_place/);
  assert.equal(fsApi.calls.filter((call) => call.name === 'rename').length, 1);
  assert.equal(calls.some((call) => call.command === 'pm2' && call.args[0] === 'save'), true);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('recuperacion acepta legado v4.4.0-b sin exigir api status', async () => {
  const fixture = await makeFixture();
  const fsApi = makeRecordingFsApi({ failRenameAt: 1 });
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  state.statusStatusCode = 404;
  const httpCalls = [];
  const httpClient = async (request) => {
    httpCalls.push(request);
    return makeHttpClient(state)(request);
  };
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_original_runtime_recovered_in_place');
    assert.equal(error.details.recovery.recoveryMode, 'original-runtime-in-place');
    assert.equal(error.details.recovery.verification.ok, true);
    assert.equal(error.details.recovery.verification.checks.some((check) => check.id === 'status-200'), false);
    return true;
  });
  assert.equal(httpCalls.some((call) => call.path === '/api/status'), false);
  assert.equal(commandCount(calls, 'pm2', 'save'), 1);
  assert.ok(lastCommandIndex(calls, 'pm2', 'save') > lastCommandIndex(calls, 'ss'));
  await rm(fixture.root, { recursive: true, force: true });
});

test('target TypeScript sigue exigiendo api status 200 y activa rollback', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  state.statusStatusCode = 404;
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_automatic_rollback_succeeded');
    assert.match(error.details.originalError, /target_verification_failed/);
    assert.ok(error.details.rollback.verification.ok);
    assert.equal(error.details.rollback.verification.checks.some((check) => check.id === 'status-200'), false);
    return true;
  });
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('recuperacion maneja jlist roto post-delete y no duplica proceso online correcto', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({
    deployDir: fixture.policy.deployDir,
    pm2: { invalidJlistAfterDeleteCount: 1 },
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), /apply_failed_original_runtime_recovered_in_place/);
  assert.equal(commandCount(calls, 'pm2', 'start'), 1);
  await rm(fixture.root, { recursive: true, force: true });

  const fixture2 = await makeFixture();
  const { calls: calls2, runner: runner2, state: state2 } = makeRunner({
    deployDir: fixture2.policy.deployDir,
    pm2: { reappearAfterDelete: { cwd: fixture2.policy.deployDir, script: 'server.mjs', status: 'online', version: 'v4.4.0-b' } },
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state2),
    policy: fixture2.policy,
    request: applyRequest(fixture2.request),
    runner: runner2,
  }), /apply_failed_original_runtime_recovered_in_place/);
  assert.equal(commandCount(calls2, 'pm2', 'start'), 0);
  assert.equal(calls2.filter((call) => call.command === 'pm2' && call.args[0] === 'jlist').length >= 3, true);
  await rm(fixture2.root, { recursive: true, force: true });
});

test('recuperacion no acepta proceso online con script correcto y cwd ausente', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({
    deployDir: fixture.policy.deployDir,
    pm2: {
      reappearAfterDelete: {
        cwd: undefined,
        pmExecPath: path.resolve(fixture.policy.deployDir, 'server.mjs'),
        script: 'server.mjs',
        status: 'online',
        version: 'v4.4.0-b',
      },
    },
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_original_runtime_recovered_in_place');
    assert.equal(error.details.recovery.pm2Action, 'delete-and-start-original');
    assert.equal(error.details.recovery.pm2.cwd, fixture.policy.deployDir);
    return true;
  });
  assert.equal(commandCount(calls, 'pm2', 'delete'), 2);
  assert.equal(commandCount(calls, 'pm2', 'start'), 1);
  await rm(fixture.root, { recursive: true, force: true });
});

test('recuperacion falla cerrado si PM2 no informa cwd despues del start', async () => {
  const fixture = await makeFixture();
  const fsApi = makeRecordingFsApi({ failRenameAt: 1 });
  const { calls, runner, state } = makeRunner({
    deployDir: fixture.policy.deployDir,
    pm2: { omitCwdAfterStart: true },
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_original_runtime_recovery_failed');
    assert.match(error.details.originalError, /rename_failed_for_test/);
    assert.match(error.details.recoveryError, /pm2_process_cwd_missing/);
    assert.equal(error.details.liveMovedToBackup, false);
    return true;
  });
  assert.equal(commandCount(calls, 'pm2', 'save'), 0);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('recuperacion elimina proceso con cwd incorrecto y reinicia sin duplicar', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({
    deployDir: fixture.policy.deployDir,
    pm2: {
      reappearAfterDelete: {
        cwd: '/tmp/wrong-cwd',
        pmExecPath: path.resolve(fixture.policy.deployDir, 'server.mjs'),
        script: 'server.mjs',
        status: 'online',
        version: 'v4.4.0-b',
      },
    },
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_original_runtime_recovered_in_place');
    assert.equal(error.details.recovery.pm2Action, 'delete-and-start-original');
    assert.equal(error.details.recovery.pm2.cwd, fixture.policy.deployDir);
    return true;
  });
  assert.equal(commandCount(calls, 'pm2', 'delete'), 2);
  assert.equal(commandCount(calls, 'pm2', 'start'), 1);
  assert.equal(state.script, 'server.mjs');
  assert.equal(state.cwd, fixture.policy.deployDir);
  await rm(fixture.root, { recursive: true, force: true });
});

test('recuperacion elimina proceso errored o script incorrecto y falla cerrado con duplicados', async () => {
  for (const reappearAfterDelete of [
    { script: 'server.mjs', status: 'errored', version: 'v4.4.0-b' },
    { script: 'dist/server.js', status: 'online', version: 'v4.10.0-a' },
  ]) {
    const fixture = await makeFixture();
    const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir, pm2: { reappearAfterDelete: { cwd: fixture.policy.deployDir, ...reappearAfterDelete } } });
    await assert.rejects(() => executeController({
      argv: ['--apply', '--request', '/tmp/request.json'],
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: applyRequest(fixture.request),
      runner,
    }), /apply_failed_original_runtime_recovered_in_place/);
    assert.equal(commandCount(calls, 'pm2', 'delete'), 2);
    assert.equal(commandCount(calls, 'pm2', 'start'), 1);
    assert.equal(state.script, 'server.mjs');
    await rm(fixture.root, { recursive: true, force: true });
  }

  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({
    deployDir: fixture.policy.deployDir,
    pm2: { reappearAfterDelete: { duplicate: true, script: 'server.mjs', status: 'online' } },
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_original_runtime_recovery_failed');
    assert.match(error.details.originalError, /pm2_process_duplicate/);
    assert.match(error.details.recoveryError, /pm2_process_duplicate/);
    return true;
  });
  assert.equal(commandCount(calls, 'pm2', 'start'), 0);
  await rm(fixture.root, { recursive: true, force: true });
});

test('fallos de start o health durante recuperacion reportan error original y de recuperacion', async () => {
  for (const scenario of ['start', 'health']) {
    const fixture = await makeFixture();
    const fsApi = makeRecordingFsApi({ failRenameAt: 1 });
    const { calls, runner, state } = makeRunner({
      deployDir: fixture.policy.deployDir,
      pm2: { failCurrentStart: scenario === 'start' },
    });
    if (scenario === 'health') state.failRecoveryHealth = true;
    await assert.rejects(() => executeController({
      argv: ['--apply', '--request', '/tmp/request.json'],
      fsApi,
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: applyRequest(fixture.request),
      runner,
    }), (error) => {
      assert.equal(error.message, 'apply_failed_original_runtime_recovery_failed');
      assert.match(error.details.originalError, /rename_failed_for_test/);
      assert.match(error.details.recoveryError, scenario === 'start' ? /pm2-start_failed/ : /original_runtime_recovery_verification_failed/);
      assert.equal(error.details.liveMovedToBackup, false);
      return true;
    });
    assert.equal(calls.some((call) => call.command === 'pm2' && call.args[0] === 'save'), false);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fallo de pm2 save durante recuperacion preserva error original y no hace rollback por rename', async () => {
  const fixture = await makeFixture();
  const fsApi = makeRecordingFsApi({ failRenameAt: 1 });
  const { calls, runner, state } = makeRunner({
    deployDir: fixture.policy.deployDir,
    pm2: { failSave: true },
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: makeHttpClient(state),
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_original_runtime_recovery_failed');
    assert.match(error.details.originalError, /rename_failed_for_test/);
    assert.equal(error.details.recoveryError, 'pm2-save-original-recovery_failed');
    assert.equal(error.details.liveMovedToBackup, false);
    assert.deepEqual(Object.keys(error.details.pm2State).sort(), ['cwd', 'present', 'script', 'status']);
    assert.equal(error.details.pm2State.cwd, fixture.policy.deployDir);
    return true;
  });
  assert.equal(commandCount(calls, 'pm2', 'save'), 1);
  assert.equal(fsApi.calls.some((call) => call.name === 'rename' && String(call.args[1]).includes(`failed-release-${fixture.request.operationId}`)), false);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('start de recuperacion usa exactamente entorno seguro sin secretos ni NODE_PATH', async () => {
  const operationalEnv = {
    HOME: '/root',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    PM2_HOME: '/root/.pm2',
    USER: 'root',
  };
  await withTemporaryEnv({ ...operationalEnv, ...SECRET_ENV_FIXTURE, NODE_PATH: 'SHOULD_NOT_LEAK_NODE_PATH' }, async () => {
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
    }), /apply_failed_original_runtime_recovered_in_place/);
    const startCall = calls.find((call) => call.command === 'pm2' && call.args[0] === 'start' && call.args[1] === 'server.mjs');
    assert.ok(startCall);
    assert.equal(startCall.options.cwd, fixture.policy.deployDir);
    assert.equal(startCall.options.shell, false);
    assert.deepEqual(Object.keys(startCall.options.env).sort(), Object.keys(buildSafePm2Environment(fixture.request)).sort());
    for (const key of Object.keys(startCall.options.env)) assert.ok(SAFE_PM2_ENV_KEYS.includes(key));
    for (const key of [...Object.keys(SECRET_ENV_FIXTURE), 'NODE_PATH']) {
      assert.equal(Object.hasOwn(startCall.options.env, key), false);
    }
    await rm(fixture.root, { recursive: true, force: true });
  });
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

test('readiness target listo en primer intento queda reportado sin sleep', async () => {
  const sleeps = makeRecordingSleep();
  const { fixture, result } = await runApplyFixture({ sleep: sleeps.sleep });
  assert.equal(result.ok, true);
  assert.equal(result.readiness.target.kind, 'target');
  assert.equal(result.readiness.target.attempts, 1);
  assert.equal(result.readiness.target.outcome, 'immediate');
  assert.deepEqual(sleeps.calls, []);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness target maneja ECONNREFUSED simulado y segundo intento exitoso', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const refused = new Error('SHOULD_NOT_LEAK_BODY');
  refused.code = 'ECONNREFUSED';
  const httpClient = makeRuntimeReadinessHttpClient(state, { targetHealth: [refused, { version: 'v4.10.0-a' }] });
  const sleeps = makeRecordingSleep();
  const result = await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: sleeps.sleep,
  });
  assert.equal(result.readiness.target.outcome, 'transient-success');
  assert.equal(result.readiness.target.attempts, 2);
  assert.deepEqual(sleeps.calls, [500]);
  assert.equal(JSON.stringify(result.readiness).includes('SHOULD_NOT_LEAK'), false);
  assert.ok(commandCount(calls, 'pm2', 'save') === 1);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness target soporta varios fallos transitorios antes de exito', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: [{ statusCode: 503 }, { statusCode: 502 }, { statusCode: 200, version: 'v4.10.0-a' }],
  });
  const sleeps = makeRecordingSleep();
  const result = await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: sleeps.sleep,
  });
  assert.equal(result.readiness.target.attempts, 3);
  assert.deepEqual(sleeps.calls, [500, 500]);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness target exige version correcta tras health 200 con version incorrecta', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: [{ statusCode: 200, version: 'v4.4.0-b' }, { statusCode: 200, version: 'v4.10.0-a' }],
  });
  const sleeps = makeRecordingSleep();
  const result = await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: sleeps.sleep,
  });
  assert.equal(result.readiness.target.attempts, 2);
  assert.equal(result.readiness.target.lastObservation.versionMatched, true);
  assert.equal(httpClient.calls.filter((call) => call.path === '/api/status').length, 2);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness target retrasa status temporalmente no disponible hasta status 200', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetStatus: [{ statusCode: 503 }, { statusCode: 200 }],
  });
  const sleeps = makeRecordingSleep();
  const result = await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: sleeps.sleep,
  });
  assert.equal(result.readiness.target.attempts, 2);
  assert.equal(result.readiness.target.lastObservation.statusStatusCode, 200);
  assert.deepEqual(sleeps.calls, [500]);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness target agotado produce target_verification_failed y evidencia', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: Array.from({ length: 6 }, () => ({ statusCode: 503 })),
  });
  const sleeps = makeRecordingSleep();
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: sleeps.sleep,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_automatic_rollback_succeeded');
    assert.equal(error.details.originalError, 'target_verification_failed');
    assert.equal(error.details.originalDetails.readiness.outcome, 'exhausted');
    assert.equal(error.details.originalDetails.readiness.attempts, 6);
    return true;
  });
  assert.deepEqual(sleeps.calls, [500, 500, 500, 500, 500]);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness target agotado conserva rollback automatico', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: Array.from({ length: 6 }, () => ({ statusCode: 500 })),
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: NOOP_SLEEP,
  }), /apply_failed_automatic_rollback_succeeded/);
  assert.equal(state.script, 'server.mjs');
  assert.equal(commandCount(calls, 'pm2', 'delete'), 2);
  await assertLegacyDeployIntact(fixture);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness original recovery supera fallos transitorios', async () => {
  const fixture = await makeFixture();
  const fsApi = makeRecordingFsApi({ failRenameAt: 1 });
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    originalHealth: [{ statusCode: 503 }, { statusCode: 200, version: 'v4.4.0-b' }],
  });
  const sleeps = makeRecordingSleep();
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: sleeps.sleep,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_original_runtime_recovered_in_place');
    assert.equal(error.details.recovery.readiness.outcome, 'transient-success');
    assert.equal(error.details.recovery.readiness.attempts, 2);
    return true;
  });
  assert.deepEqual(sleeps.calls, [500]);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness original recovery agotado falla cerrado', async () => {
  const fixture = await makeFixture();
  const fsApi = makeRecordingFsApi({ failRenameAt: 1 });
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    originalHealth: Array.from({ length: 6 }, () => ({ statusCode: 503 })),
  });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: NOOP_SLEEP,
  }), (error) => {
    assert.equal(error.message, 'apply_failed_original_runtime_recovery_failed');
    assert.equal(error.details.recoveryError, 'original_runtime_recovery_verification_failed');
    assert.equal(error.details.recoveryDetails.readiness.outcome, 'exhausted');
    return true;
  });
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness rollback original supera fallos transitorios', async () => {
  const fixture = await makeFixture();
  const backupDir = path.join(fixture.policy.backupRoot, 'selected-backup-readiness');
  await mkdir(fixture.policy.backupRoot, { recursive: true });
  await fsPromises.rename(fixture.policy.deployDir, backupDir);
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    originalHealth: [{ statusCode: 503 }, { statusCode: 200, version: 'v4.4.0-b' }],
  });
  const sleeps = makeRecordingSleep();
  const result = await executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: { ...fixture.request, rollback: { backupDir } },
    runner,
    sleep: sleeps.sleep,
  });
  assert.equal(result.rollback.readiness.outcome, 'transient-success');
  assert.deepEqual(sleeps.calls, [500]);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness rollback original agotado falla cerrado', async () => {
  const fixture = await makeFixture();
  const backupDir = path.join(fixture.policy.backupRoot, 'selected-backup-readiness-fail');
  await mkdir(fixture.policy.backupRoot, { recursive: true });
  await fsPromises.rename(fixture.policy.deployDir, backupDir);
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    originalHealth: Array.from({ length: 6 }, () => ({ statusCode: 503 })),
  });
  await assert.rejects(() => executeController({
    argv: ['--rollback', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: { ...fixture.request, rollback: { backupDir } },
    runner,
    sleep: NOOP_SLEEP,
  }), (error) => {
    assert.equal(error.message, 'rollback_verification_failed');
    assert.equal(error.details.readiness.outcome, 'exhausted');
    return true;
  });
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness no duerme despues de exito transitorio', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: [{ statusCode: 503 }, { statusCode: 200, version: 'v4.10.0-a' }],
  });
  const sleeps = makeRecordingSleep();
  const result = await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: sleeps.sleep,
  });
  assert.equal(result.readiness.target.attempts, 2);
  assert.deepEqual(sleeps.calls, [500]);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness agotado duerme exactamente attempts menos uno', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: Array.from({ length: 6 }, () => ({ statusCode: 503 })),
  });
  const sleeps = makeRecordingSleep();
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: sleeps.sleep,
  }), /apply_failed_automatic_rollback_succeeded/);
  assert.deepEqual(sleeps.calls, [500, 500, 500, 500, 500]);
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness no ejecuta acciones PM2 durante la espera', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: [{ statusCode: 503 }, { statusCode: 200, version: 'v4.10.0-a' }],
  });
  const pm2CountsDuringSleep = [];
  const sleep = async () => {
    const before = calls.filter((call) => call.command === 'pm2').length;
    await Promise.resolve();
    const after = calls.filter((call) => call.command === 'pm2').length;
    pm2CountsDuringSleep.push({ after, before });
  };
  await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep,
  });
  assert.equal(pm2CountsDuringSleep.length, 1);
  assert.equal(pm2CountsDuringSleep[0].after, pm2CountsDuringSleep[0].before);
  assert.equal(pm2CountsDuringSleep[0].before < calls.filter((call) => call.command === 'pm2').length, true);
  await rm(fixture.root, { recursive: true, force: true });
});

test('revalidacion PM2 ocurre despues de readiness target', async () => {
  const fixture = await makeFixture();
  const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: [{ statusCode: 503 }, { statusCode: 200, version: 'v4.10.0-a' }],
  });
  const result = await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: NOOP_SLEEP,
  });
  const lastReadinessHttp = httpClient.calls.findLastIndex((call) => call.path === '/api/status' && call.method === 'GET');
  const postStep = result.steps.indexOf('pm2-target-revalidated-after-readiness');
  assert.ok(lastReadinessHttp >= 0);
  assert.ok(postStep > result.steps.indexOf('pm2-target-started'));
  assert.equal(commandCount(calls, 'pm2', 'jlist') >= 3, true);
  await rm(fixture.root, { recursive: true, force: true });
});

test('pm2 save ocurre despues de readiness revalidacion PM2 y verificacion final', async () => {
  const { calls, fixture, result } = await runApplyFixture();
  assert.ok(result.steps.indexOf('pm2-target-revalidated-after-readiness') < result.steps.indexOf('pm2-save'));
  assert.ok(lastCommandIndex(calls, 'pm2', 'save') > lastCommandIndex(calls, 'ss'));
  await rm(fixture.root, { recursive: true, force: true });
});

test('dry-run no ejecuta sleep ni HTTP adicional de readiness', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeHttpClient(state);
  let sleepCalled = false;
  const result = await executeController({
    argv: ['--dry-run', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: fixture.request,
    runner,
    sleep: async () => { sleepCalled = true; },
  });
  assert.equal(result.ok, true);
  assert.equal(sleepCalled, false);
  assert.equal(result.checks.filter((check) => check.id === 'current-health').length, 1);
  await rm(fixture.root, { recursive: true, force: true });
});

test('dry-run contiene operaciones bounded target y original en orden', async () => {
  const { fixture, result } = await runValidDryRun();
  const plan = result.plan.wouldRun;
  assert.ok(plan.indexOf('verify-pm2-target-state') < plan.indexOf('wait-for-target-runtime-readiness-bounded'));
  assert.ok(plan.indexOf('wait-for-target-runtime-readiness-bounded') < plan.indexOf('verify-target'));
  assert.ok(plan.indexOf('start-original-runtime-without-delete') < plan.indexOf('wait-for-original-runtime-readiness-bounded'));
  assert.ok(plan.indexOf('wait-for-original-runtime-readiness-bounded') < plan.indexOf('automatic-rollback-by-rename'));
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness usa exclusivamente host y port autorizados', async () => {
  const fixture = await makeFixture();
  const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
  const httpClient = makeRuntimeReadinessHttpClient(state, {
    targetHealth: [{ statusCode: 503 }, { statusCode: 200, version: 'v4.10.0-a' }],
  });
  await executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    httpClient,
    policy: fixture.policy,
    request: applyRequest(fixture.request),
    runner,
    sleep: NOOP_SLEEP,
  });
  const readinessCalls = httpClient.calls.filter((call) => call.path === '/health' || call.path === '/api/status');
  assert.ok(readinessCalls.every((call) => call.host === '127.0.0.1' && call.port === 3014));
  await rm(fixture.root, { recursive: true, force: true });
});

test('readiness evidencia no contiene bodies headers env ni secretos', async () => {
  await withTemporaryEnv(SECRET_ENV_FIXTURE, async () => {
    const fixture = await makeFixture();
    const { runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
    const refused = new Error('HTTP body SHOULD_NOT_LEAK_OPENAI header authorization');
    refused.code = 'ECONNREFUSED';
    const httpClient = makeRuntimeReadinessHttpClient(state, {
      targetHealth: [refused, { statusCode: 200, version: 'v4.10.0-a' }],
    });
    const result = await executeController({
      argv: ['--apply', '--request', '/tmp/request.json'],
      httpClient,
      policy: fixture.policy,
      request: applyRequest(fixture.request),
      runner,
      sleep: NOOP_SLEEP,
    });
    const serialized = JSON.stringify(result.readiness);
    assert.equal(serialized.includes('SHOULD_NOT_LEAK'), false);
    assert.equal(serialized.includes('authorization'), false);
    assert.equal(serialized.includes('headers'), false);
    for (const key of Object.keys(SECRET_ENV_FIXTURE)) assert.equal(serialized.includes(key), false);
    await rm(fixture.root, { recursive: true, force: true });
  });
});

test('checks finales existentes permanecen con semantica target y original', async () => {
  const { fixture, result } = await runApplyFixture();
  const targetIds = result.verification.checks.map((check) => check.id);
  for (const id of ['health-200', 'health-version', 'status-200', 'health-post-405', 'missing-404', 'loopback-only', 'frontend-3004-200', 'generator-3023-200']) {
    assert.ok(targetIds.includes(id), id);
  }
  await rm(fixture.root, { recursive: true, force: true });

  const fixture2 = await makeFixture();
  const fsApi = makeRecordingFsApi({ failRenameAt: 1 });
  const { runner, state } = makeRunner({ deployDir: fixture2.policy.deployDir });
  await assert.rejects(() => executeController({
    argv: ['--apply', '--request', '/tmp/request.json'],
    fsApi,
    httpClient: makeHttpClient(state),
    policy: fixture2.policy,
    request: applyRequest(fixture2.request),
    runner,
    sleep: NOOP_SLEEP,
  }), (error) => {
    const originalIds = error.details.recovery.verification.checks.map((check) => check.id);
    for (const id of ['health-200', 'health-version', 'health-post-405', 'missing-404', 'loopback-only', 'frontend-3004-200', 'generator-3023-200']) {
      assert.ok(originalIds.includes(id), id);
    }
    assert.equal(originalIds.includes('status-200'), false);
    return true;
  });
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

test('dry-run no imprime ni reporta variables sensibles del entorno', async () => {
  await withTemporaryEnv(SECRET_ENV_FIXTURE, async () => {
    const fixture = await makeFixture();
    const { calls, runner, state } = makeRunner({ deployDir: fixture.policy.deployDir });
    const result = await executeController({
      argv: ['--dry-run', '--request', '/tmp/request.json'],
      httpClient: makeHttpClient(state),
      policy: fixture.policy,
      request: fixture.request,
      runner,
    });
    const stdoutJson = jsonText(result);
    assert.equal(result.ok, true);
    assert.ok(result.checks.some((check) => check.id === 'pm2-environment-allowlist'));
    assert.equal(calls.some((call) => call.options.env), false);
    for (const value of SECRET_VALUES) assert.equal(stdoutJson.includes(value), false);
    for (const key of Object.keys(SECRET_ENV_FIXTURE)) assert.equal(stdoutJson.includes(key), false);
    await rm(fixture.root, { recursive: true, force: true });
  });
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

test('self-check estatico impide reintroducir spread completo de process.env', async () => {
  const source = await readFile(new URL('../deploy-controller.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('...process.env'), false);
});


test('custom functional PM2 environment is isolated and validated', () => {
  const functionalEnv = {
    LIA_AGENT_CORS_ORIGINS: '',
    LIA_AGENT_HOST: '127.0.0.1',
    LIA_AGENT_LOG_LEVEL: 'info',
    LIA_AGENT_PORT: '3014',
    LIA_HERMES_EXECUTION_ENABLED: 'true',
    LIA_HERMES_HOME: '/home/hermes-agent/.hermes',
    LIA_HERMES_MODEL: 'gpt-5.6-terra',
    LIA_HERMES_PROVIDER: 'openai-codex',
    NODE_ENV: 'production',
  };

  const env = buildSafePm2Environment(
    { host: '127.0.0.1', port: 3014 },
    {
      HOME: '/root',
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'must-not-leak',
      RANDOM_SECRET: 'must-not-leak',
    },
    functionalEnv,
  );

  assert.equal(env.LIA_HERMES_EXECUTION_ENABLED, 'true');
  assert.equal(env.LIA_HERMES_PROVIDER, 'openai-codex');
  assert.equal(env.LIA_HERMES_MODEL, 'gpt-5.6-terra');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.RANDOM_SECRET, undefined);

  assert.doesNotThrow(() => validateSafePm2Environment(
    { host: '127.0.0.1', port: 3014 },
    env,
    functionalEnv,
  ));
});
