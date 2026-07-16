import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, stat, lstat, access, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const EXIT = Object.freeze({
  OK: 0,
  CLI: 2,
  REQUEST: 3,
  PREFLIGHT: 4,
  APPLY_AUTH: 5,
  APPLY_FAILED: 6,
  ROLLBACK_FAILED: 7,
});

const REAL_POLICY = Object.freeze({
  schemaVersion: 'lia-agent-backend-deploy/v1',
  repoRoot: '/opt/executive-platform-demo',
  branch: 'chore/lia-os-v4100b-backend-controlled-deploy-tooling',
  sourceBackendDir: '/opt/executive-platform-demo/backend/lia-agent',
  deployDir: '/opt/lia-agent-backend',
  backupRoot: '/opt/lia-agent-backups',
  pm2ProcessName: 'lia-agent-backend',
  host: '127.0.0.1',
  port: 3014,
  currentVersion: 'v4.4.0-b',
  targetVersion: 'v4.10.0-a',
  currentScript: 'server.mjs',
  targetScript: 'dist/server.js',
  healthPath: '/health',
  statusPath: '/api/status',
  allowedServicePorts: [3004, 3014, 3023],
});

const REQUIRED_FIELDS = [
  'schemaVersion',
  'operationId',
  'expectedRepoRoot',
  'expectedBranch',
  'expectedHead',
  'expectedTag',
  'sourceBackendDir',
  'deployDir',
  'backupRoot',
  'pm2ProcessName',
  'host',
  'port',
  'expectedCurrentVersion',
  'expectedTargetVersion',
  'expectedCurrentScript',
  'expectedTargetScript',
  'healthPath',
  'statusPath',
  'allowedServicePorts',
];

const APPLY_AUTH_PREFIX = 'APPLY:lia-agent-backend:';
const BACKEND_HTTP_TIMEOUT_MS = 1500;
const READINESS_MAX_ATTEMPTS = 6;
const READINESS_INTERVAL_MS = 500;

const PM2_OPERATIONAL_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PM2_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
]);

const PM2_FUNCTIONAL_ENV = Object.freeze({
  LIA_AGENT_HOST: '127.0.0.1',
  LIA_AGENT_PORT: '3014',
  LIA_AGENT_CORS_ORIGINS: '',
  LIA_AGENT_LOG_LEVEL: 'info',
  NODE_ENV: 'production',
});

const SAFE_PM2_ENV_KEYS = Object.freeze([...PM2_OPERATIONAL_ENV_KEYS, ...Object.keys(PM2_FUNCTIONAL_ENV)]);
const SAFE_PM2_ENV_KEY_SET = new Set(SAFE_PM2_ENV_KEYS);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function jsonText(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function exitFor(error) {
  return error.code ?? EXIT.APPLY_FAILED;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(EXIT.REQUEST, `${label}_must_be_object`);
  }
}

function hasTraversal(rawPath) {
  return rawPath.split(/[\\/]+/).includes('..');
}

function assertAbsoluteCleanPath(rawPath, field) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw fail(EXIT.REQUEST, `${field}_must_be_string`);
  }
  if (!path.isAbsolute(rawPath)) {
    throw fail(EXIT.REQUEST, `${field}_must_be_absolute`, { field, value: rawPath });
  }
  if (hasTraversal(rawPath)) {
    throw fail(EXIT.REQUEST, `${field}_must_not_contain_traversal`, { field, value: rawPath });
  }
  return path.resolve(rawPath);
}

function assertPathInside(child, parent, field) {
  const relative = path.relative(parent, child);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw fail(EXIT.REQUEST, `${field}_outside_allowed_root`, { field, value: child, root: parent });
}

async function assertNoSymlinkPath(targetPath, field, fsApi) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);

  for (const part of parts) {
    current = path.join(current, part);
    try {
      const entry = await fsApi.lstat(current);
      if (entry.isSymbolicLink()) {
        throw fail(EXIT.REQUEST, `${field}_must_not_use_symlink`, { field, path: current });
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function parseArgs(argv) {
  const result = { modes: [], requestPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run' || arg === '--apply' || arg === '--rollback') {
      result.modes.push(arg.slice(2));
    } else if (arg === '--request') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw fail(EXIT.CLI, 'request_argument_missing');
      result.requestPath = next;
      index += 1;
    } else {
      throw fail(EXIT.CLI, 'unknown_argument', { argument: arg });
    }
  }
  if (result.modes.length !== 1) throw fail(EXIT.CLI, 'exactly_one_mode_required', { modes: result.modes });
  if (!result.requestPath) throw fail(EXIT.CLI, 'request_required');
  return { mode: result.modes[0], requestPath: result.requestPath };
}

async function readRequest(requestPath, fsApi) {
  const cleanPath = assertAbsoluteCleanPath(requestPath, 'request');
  await assertNoSymlinkPath(cleanPath, 'request', fsApi);
  const raw = await fsApi.readFile(cleanPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(EXIT.REQUEST, 'request_json_invalid');
  }
}

function normalizeRequest(request, policy) {
  assertPlainObject(request, 'request');
  for (const field of REQUIRED_FIELDS) {
    if (!(field in request)) throw fail(EXIT.REQUEST, 'request_missing_field', { field });
  }

  const normalized = { ...request };
  for (const field of ['expectedRepoRoot', 'sourceBackendDir', 'deployDir', 'backupRoot']) {
    normalized[field] = assertAbsoluteCleanPath(request[field], field);
  }
  for (const field of ['expectedCurrentScript', 'expectedTargetScript']) {
    if (typeof request[field] !== 'string' || path.isAbsolute(request[field]) || hasTraversal(request[field])) {
      throw fail(EXIT.REQUEST, `${field}_must_be_safe_relative_path`, { field, value: request[field] });
    }
    normalized[field] = path.posix.normalize(request[field]);
  }
  if (request.schemaVersion !== policy.schemaVersion) throw fail(EXIT.REQUEST, 'schema_version_not_allowed');
  if (request.expectedRepoRoot !== policy.repoRoot) throw fail(EXIT.REQUEST, 'repo_root_not_allowed');
  if (request.expectedBranch !== policy.branch) throw fail(EXIT.REQUEST, 'branch_not_allowed');
  if (!/^[0-9a-f]{40}$/.test(request.expectedHead)) throw fail(EXIT.REQUEST, 'expected_head_must_be_sha1');
  if (typeof request.expectedTag !== 'string' || request.expectedTag.length < 3) throw fail(EXIT.REQUEST, 'expected_tag_invalid');
  if (request.sourceBackendDir !== policy.sourceBackendDir) throw fail(EXIT.REQUEST, 'source_backend_dir_not_allowed');
  if (request.deployDir !== policy.deployDir) throw fail(EXIT.REQUEST, 'deploy_dir_not_allowed');
  if (request.backupRoot !== policy.backupRoot) throw fail(EXIT.REQUEST, 'backup_root_not_allowed');
  if (request.pm2ProcessName !== policy.pm2ProcessName) throw fail(EXIT.REQUEST, 'pm2_process_not_allowed');
  if (request.host !== policy.host) throw fail(EXIT.REQUEST, 'host_not_allowed');
  if (Number(request.port) !== policy.port) throw fail(EXIT.REQUEST, 'port_not_allowed');
  if (request.expectedCurrentVersion !== policy.currentVersion) throw fail(EXIT.REQUEST, 'current_version_not_allowed');
  if (request.expectedTargetVersion !== policy.targetVersion) throw fail(EXIT.REQUEST, 'target_version_not_allowed');
  if (request.expectedCurrentScript !== policy.currentScript) throw fail(EXIT.REQUEST, 'current_script_not_allowed');
  if (request.expectedTargetScript !== policy.targetScript) throw fail(EXIT.REQUEST, 'target_script_not_allowed');
  if (request.healthPath !== policy.healthPath) throw fail(EXIT.REQUEST, 'health_path_not_allowed');
  if (request.statusPath !== policy.statusPath) throw fail(EXIT.REQUEST, 'status_path_not_allowed');
  if (JSON.stringify(request.allowedServicePorts) !== JSON.stringify(policy.allowedServicePorts)) {
    throw fail(EXIT.REQUEST, 'allowed_service_ports_not_allowed');
  }
  assertPathInside(normalized.sourceBackendDir, normalized.expectedRepoRoot, 'sourceBackendDir');
  return normalized;
}

async function validateRequestPaths(request, fsApi) {
  await Promise.all([
    assertNoSymlinkPath(request.expectedRepoRoot, 'expectedRepoRoot', fsApi),
    assertNoSymlinkPath(request.sourceBackendDir, 'sourceBackendDir', fsApi),
    assertNoSymlinkPath(request.deployDir, 'deployDir', fsApi),
    assertNoSymlinkPath(request.backupRoot, 'backupRoot', fsApi),
  ]);
  if (request.rollback?.backupDir) {
    const backupDir = assertAbsoluteCleanPath(request.rollback.backupDir, 'rollback.backupDir');
    assertPathInside(backupDir, request.backupRoot, 'rollback.backupDir');
    await assertNoSymlinkPath(backupDir, 'rollback.backupDir', fsApi);
  }
}

function createDefaultRunner() {
  return async function run(command, args, options = {}) {
    if (options.shell === true) throw fail(EXIT.REQUEST, 'shell_true_forbidden');
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout ?? 15000,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        shell: false,
      });
      return { ok: true, command, args, stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0, shell: false };
    } catch (error) {
      return {
        ok: false,
        command,
        args,
        stdout: error.stdout?.toString().trim() ?? '',
        stderr: error.stderr?.toString().trim() || error.message,
        code: error.code ?? 1,
        shell: false,
      };
    }
  };
}

function createDefaultHttpClient() {
  return function requestLocal({ host, port, path: requestPath, method = 'GET' }) {
    return new Promise((resolve) => {
      const request = http.request({ host, port, path: requestPath, method, timeout: BACKEND_HTTP_TIMEOUT_MS }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ ok: true, statusCode: response.statusCode ?? 0, body }));
      });
      request.on('timeout', () => request.destroy(new Error('request_timeout')));
      request.on('error', (error) => resolve({ ok: false, statusCode: 0, body: '', error: error.message }));
      request.end();
    });
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const realFs = { readFile, readdir, stat, lstat, access, mkdir, cp, rename, realpath };

function addCheck(checks, id, passed, detail = {}) {
  checks.push({ detail, id, passed });
}

async function exists(fsApi, targetPath) {
  try {
    await fsApi.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertAbsent(fsApi, targetPath, field) {
  if (await exists(fsApi, targetPath)) throw fail(EXIT.APPLY_FAILED, `${field}_already_exists`, { path: targetPath });
}

async function assertExistingDirectorySafe(fsApi, targetPath, field) {
  const resolved = path.resolve(targetPath);
  const parent = path.dirname(resolved);
  let entry;
  let parentEntry;
  try {
    [entry, parentEntry] = await Promise.all([fsApi.lstat(resolved), fsApi.lstat(parent)]);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail(EXIT.REQUEST, `${field}_missing`, { path: resolved });
    throw error;
  }
  if (entry.isSymbolicLink()) throw fail(EXIT.REQUEST, `${field}_must_not_use_symlink`, { path: resolved });
  if (parentEntry.isSymbolicLink()) throw fail(EXIT.REQUEST, `${field}_parent_must_not_use_symlink`, { path: parent });
  if (!entry.isDirectory()) throw fail(EXIT.REQUEST, `${field}_must_be_directory`, { path: resolved });
  const [actual, actualParent] = await Promise.all([fsApi.realpath(resolved), fsApi.realpath(parent)]);
  if (actual !== resolved) throw fail(EXIT.REQUEST, `${field}_realpath_mismatch`, { actual, expected: resolved });
  if (actualParent !== parent) throw fail(EXIT.REQUEST, `${field}_parent_realpath_mismatch`, { actual: actualParent, expected: parent });
  return { path: resolved, stat: await fsApi.stat(resolved) };
}

async function assertCriticalDeployPath(request, fsApi) {
  const checked = await assertExistingDirectorySafe(fsApi, request.deployDir, 'deployDir');
  if (checked.path !== request.deployDir) throw fail(EXIT.REQUEST, 'deploy_dir_not_allowed');
  return checked;
}

async function assertCriticalBackupPath(request, fsApi, backupDir, { mustExist }) {
  const clean = assertAbsoluteCleanPath(backupDir, 'backupDir');
  assertPathInside(clean, request.backupRoot, 'backupDir');
  if (clean === request.backupRoot) throw fail(EXIT.REQUEST, 'backupDir_must_not_equal_backupRoot');
  await assertExistingDirectorySafe(fsApi, request.backupRoot, 'backupRoot');
  if (!mustExist) {
    await assertAbsent(fsApi, clean, 'backupDir');
    return { path: clean, stat: null };
  }
  return assertExistingDirectorySafe(fsApi, clean, 'backupDir');
}

async function assertCriticalReleasePath(request, fsApi, releaseDir, { mustExist }) {
  const clean = assertAbsoluteCleanPath(releaseDir, 'releaseDir');
  assertPathInside(clean, request.backupRoot, 'releaseDir');
  if (clean === request.backupRoot || clean === request.deployDir) throw fail(EXIT.REQUEST, 'releaseDir_not_allowed');
  await assertExistingDirectorySafe(fsApi, request.backupRoot, 'backupRoot');
  if (!mustExist) {
    await assertAbsent(fsApi, clean, 'releaseDir');
    return { path: clean, stat: null };
  }
  return assertExistingDirectorySafe(fsApi, clean, 'releaseDir');
}

function assertSameFilesystem(statsByName) {
  const entries = Object.entries(statsByName);
  const first = entries[0]?.[1]?.dev;
  if (first === undefined) throw fail(EXIT.APPLY_FAILED, 'filesystem_stat_missing');
  const mismatched = entries.filter(([, value]) => value.dev !== first).map(([name]) => name);
  if (mismatched.length > 0) throw fail(EXIT.APPLY_FAILED, 'same_filesystem_required', { mismatched });
}

async function assertTreeNoSymlinks(fsApi, root, field) {
  await assertExistingDirectorySafe(fsApi, root, field);
  const entries = await fsApi.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const item = await fsApi.lstat(fullPath);
    if (item.isSymbolicLink()) throw fail(EXIT.REQUEST, `${field}_must_not_contain_symlink`, { path: fullPath });
    if (item.isDirectory()) await assertTreeNoSymlinks(fsApi, fullPath, field);
  }
}

async function assertReleaseComplete(fsApi, request, releaseDir) {
  const packagePath = path.join(releaseDir, 'package.json');
  const lockPath = path.join(releaseDir, 'package-lock.json');
  const targetScript = path.join(releaseDir, request.expectedTargetScript);
  if (!(await exists(fsApi, packagePath))) throw fail(EXIT.APPLY_FAILED, 'release_package_json_missing');
  if (!(await exists(fsApi, lockPath))) throw fail(EXIT.APPLY_FAILED, 'release_package_lock_json_missing');
  if (!(await exists(fsApi, targetScript))) throw fail(EXIT.APPLY_FAILED, 'release_target_script_missing');
  const version = await readPackageVersion(fsApi, packagePath);
  if (version !== request.expectedTargetVersion.replace(/^v/, '')) {
    throw fail(EXIT.APPLY_FAILED, 'release_version_mismatch', { actual: version, expected: request.expectedTargetVersion });
  }
  await assertTreeNoSymlinks(fsApi, releaseDir, 'releaseDir');
}

async function assertBackupComplete(fsApi, request, backupDir) {
  if (!(await exists(fsApi, path.join(backupDir, 'package.json')))) throw fail(EXIT.ROLLBACK_FAILED, 'backup_package_json_missing');
  if (!(await exists(fsApi, path.join(backupDir, request.expectedCurrentScript)))) throw fail(EXIT.ROLLBACK_FAILED, 'backup_expected_script_missing');
  const version = await readPackageVersion(fsApi, path.join(backupDir, 'package.json'));
  if (version !== request.expectedCurrentVersion.replace(/^v/, '')) {
    throw fail(EXIT.ROLLBACK_FAILED, 'backup_version_mismatch', { actual: version, expected: request.expectedCurrentVersion });
  }
  await assertTreeNoSymlinks(fsApi, backupDir, 'backupDir');
}

async function readPackageVersion(fsApi, packagePath) {
  try {
    const pkg = JSON.parse(await fsApi.readFile(packagePath, 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function sha256File(fsApi, filePath) {
  const content = await fsApi.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function collectCriticalHashes(fsApi, root, files) {
  const hashes = [];
  for (const file of files) {
    const fullPath = path.join(root, file);
    if (await exists(fsApi, fullPath)) {
      hashes.push({ file, sha256: await sha256File(fsApi, fullPath) });
    }
  }
  return hashes;
}

async function runRequired(runner, command, args, options, id) {
  if (options?.shell === true) throw fail(EXIT.REQUEST, 'shell_true_forbidden', { id });
  const result = await runner(command, args, { ...options, shell: false });
  if (result.shell === true) throw fail(EXIT.REQUEST, 'runner_shell_true_forbidden', { id });
  if (!result.ok) throw fail(EXIT.APPLY_FAILED, `${id}_failed`, { command, args, stderr: result.stderr, code: result.code });
  return result;
}

function parsePm2List(stdout) {
  try {
    const list = JSON.parse(stdout || '[]');
    if (!Array.isArray(list)) throw new Error('pm2_jlist_not_array');
    return list;
  } catch {
    throw fail(EXIT.APPLY_FAILED, 'pm2_jlist_json_invalid');
  }
}

function pm2Script(processInfo) {
  return processInfo?.pm2_env?.pm_exec_path ?? null;
}

function pm2Cwd(processInfo) {
  return processInfo?.pm2_env?.pm_cwd ?? processInfo?.pm2_env?.cwd ?? null;
}

function pm2Status(processInfo) {
  return processInfo?.pm2_env?.status ?? processInfo?.status ?? null;
}

async function getAuthorizedPm2ProcessState(request, deps) {
  const result = await runRequired(deps.runner, 'pm2', ['jlist'], { shell: false }, 'pm2-jlist');
  const matches = parsePm2List(result.stdout).filter((item) => item?.name === request.pm2ProcessName);
  if (matches.length > 1) {
    throw fail(EXIT.APPLY_FAILED, 'pm2_process_duplicate', { processName: request.pm2ProcessName, count: matches.length });
  }
  if (matches.length === 0) {
    return { present: false, online: false, process: null, status: 'absent' };
  }
  const processInfo = matches[0];
  const status = pm2Status(processInfo) ?? 'unknown';
  return {
    cwd: pm2Cwd(processInfo),
    online: status === 'online',
    present: true,
    process: processInfo,
    script: pm2Script(processInfo),
    status,
  };
}

async function stopAuthorizedRuntimeIfPresent(request, deps, stopState = null) {
  if (stopState) stopState.runtimeStopAttempted = true;
  const before = await getAuthorizedPm2ProcessState(request, deps);
  if (stopState) {
    stopState.runtimeWasPresent = before.present;
    stopState.runtimeAlreadyAbsent = !before.present;
  }
  if (!before.present) return { deleted: false, runtimeWasPresent: false, status: 'absent' };
  await runRequired(deps.runner, 'pm2', ['delete', request.pm2ProcessName], { shell: false }, 'pm2-delete');
  if (stopState) stopState.runtimeDeleted = true;
  const after = await getAuthorizedPm2ProcessState(request, deps);
  if (after.present) {
    throw fail(EXIT.APPLY_FAILED, 'pm2_process_still_present_after_delete', {
      processName: request.pm2ProcessName,
      status: after.status,
    });
  }
  return { deleted: true, previousStatus: before.status, runtimeWasPresent: true, status: 'deleted' };
}

function isExpectedPm2Script(actualScript, request, script) {
  if (!actualScript) return false;
  return path.resolve(actualScript) === path.resolve(request.deployDir, script);
}

async function verifyPm2TargetState(request, deps, script, { requireExactCwd = false } = {}) {
  const state = await getAuthorizedPm2ProcessState(request, deps);
  if (!state.present) throw fail(EXIT.APPLY_FAILED, 'pm2_process_missing_after_start', { processName: request.pm2ProcessName });
  if (!state.online) throw fail(EXIT.APPLY_FAILED, 'pm2_process_not_online_after_start', { status: state.status });
  if (!isExpectedPm2Script(state.script, request, script)) {
    throw fail(EXIT.APPLY_FAILED, 'pm2_process_script_mismatch', {
      actual: state.script,
      expected: path.resolve(request.deployDir, script),
    });
  }
  if (requireExactCwd && !state.cwd) {
    throw fail(EXIT.APPLY_FAILED, 'pm2_process_cwd_missing', { expected: request.deployDir });
  }
  if (state.cwd && path.resolve(state.cwd) !== path.resolve(request.deployDir)) {
    throw fail(EXIT.APPLY_FAILED, 'pm2_process_cwd_mismatch', { actual: state.cwd, expected: request.deployDir });
  }
  return state;
}

function parseJsonBody(response) {
  try {
    return JSON.parse(response.body || '{}');
  } catch {
    return null;
  }
}

function isVersionMatch(body, expectedVersion) {
  return body?.version === expectedVersion || body?.service?.version === expectedVersion || body?.data?.version === expectedVersion;
}

function sanitizeLocalError(error) {
  if (!error) return null;
  const raw = typeof error === 'string' ? error : error.code || error.message || String(error);
  return String(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 160);
}

function readinessBudget(kind) {
  const requestsPerAttempt = kind === 'target' ? 2 : 1;
  return (READINESS_MAX_ATTEMPTS * requestsPerAttempt * BACKEND_HTTP_TIMEOUT_MS)
    + ((READINESS_MAX_ATTEMPTS - 1) * READINESS_INTERVAL_MS);
}

function emptyReadinessObservation() {
  return {
    healthStatusCode: null,
    localError: null,
    statusStatusCode: null,
    versionMatched: false,
  };
}

async function observeRuntimeReadiness(request, deps, kind) {
  const expectedVersion = kind === 'target' ? request.expectedTargetVersion : request.expectedCurrentVersion;
  const observation = emptyReadinessObservation();
  let health;
  try {
    health = await deps.httpClient({ host: request.host, port: request.port, path: request.healthPath, method: 'GET' });
  } catch (error) {
    observation.localError = sanitizeLocalError(error);
    return { ok: false, observation };
  }

  observation.healthStatusCode = Number.isInteger(health?.statusCode) ? health.statusCode : null;
  if (!health?.ok && health?.error) observation.localError = sanitizeLocalError(health.error);
  observation.versionMatched = isVersionMatch(parseJsonBody(health ?? {}), expectedVersion);
  if (!health?.ok || health.statusCode !== 200 || !observation.versionMatched) {
    return { ok: false, observation };
  }

  if (kind === 'original') return { ok: true, observation };

  try {
    const status = await deps.httpClient({ host: request.host, port: request.port, path: request.statusPath, method: 'GET' });
    observation.statusStatusCode = Number.isInteger(status?.statusCode) ? status.statusCode : null;
    if (!status?.ok && status?.error) observation.localError = sanitizeLocalError(status.error);
    return { ok: Boolean(status?.ok && status.statusCode === 200), observation };
  } catch (error) {
    observation.localError = sanitizeLocalError(error);
    return { ok: false, observation };
  }
}

async function waitForRuntimeReadiness(request, deps, kind) {
  let lastObservation = emptyReadinessObservation();
  for (let attempt = 1; attempt <= READINESS_MAX_ATTEMPTS; attempt += 1) {
    const result = await observeRuntimeReadiness(request, deps, kind);
    lastObservation = result.observation;
    if (result.ok) {
      return {
        approximateBudgetMs: readinessBudget(kind),
        attempts: attempt,
        intervalMs: READINESS_INTERVAL_MS,
        kind,
        lastObservation,
        maxAttempts: READINESS_MAX_ATTEMPTS,
        outcome: attempt === 1 ? 'immediate' : 'transient-success',
        perRequestTimeoutMs: BACKEND_HTTP_TIMEOUT_MS,
      };
    }
    if (attempt < READINESS_MAX_ATTEMPTS) await deps.sleep(READINESS_INTERVAL_MS);
  }
  return {
    approximateBudgetMs: readinessBudget(kind),
    attempts: READINESS_MAX_ATTEMPTS,
    intervalMs: READINESS_INTERVAL_MS,
    kind,
    lastObservation,
    maxAttempts: READINESS_MAX_ATTEMPTS,
    outcome: 'exhausted',
    perRequestTimeoutMs: BACKEND_HTTP_TIMEOUT_MS,
  };
}

async function runPreflight(request, deps) {
  const { fsApi, runner, httpClient } = deps;
  const checks = [];

  const branch = await runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: request.expectedRepoRoot, shell: false });
  addCheck(checks, 'git-branch', branch.ok && branch.stdout === request.expectedBranch, { actual: branch.stdout, expected: request.expectedBranch });

  const head = await runner('git', ['rev-parse', 'HEAD'], { cwd: request.expectedRepoRoot, shell: false });
  addCheck(checks, 'git-head', head.ok && head.stdout === request.expectedHead, { actual: head.stdout, expected: request.expectedHead });

  const tag = await runner('git', ['tag', '--points-at', 'HEAD'], { cwd: request.expectedRepoRoot, shell: false });
  const tags = tag.stdout.split('\n').filter(Boolean).sort();
  addCheck(checks, 'git-tag', tag.ok && tags.includes(request.expectedTag), { actual: tags, expected: request.expectedTag });

  const status = await runner('git', ['status', '--porcelain'], { cwd: request.expectedRepoRoot, shell: false });
  addCheck(checks, 'git-working-tree-clean', status.ok && status.stdout === '', { clean: status.stdout === '' });

  const packagePath = path.join(request.sourceBackendDir, 'package.json');
  const lockPath = path.join(request.sourceBackendDir, 'package-lock.json');
  const distPath = path.join(request.sourceBackendDir, 'dist', 'server.js');
  const deployCurrentScript = path.join(request.deployDir, request.expectedCurrentScript);

  addCheck(checks, 'source-backend-dir', await exists(fsApi, request.sourceBackendDir), { path: request.sourceBackendDir });
  addCheck(checks, 'source-package-json', await exists(fsApi, packagePath), { path: packagePath });
  addCheck(checks, 'source-package-lock-json', await exists(fsApi, lockPath), { path: lockPath });
  addCheck(checks, 'source-dist-server', await exists(fsApi, distPath), { path: distPath });
  addCheck(checks, 'deploy-dir', await exists(fsApi, request.deployDir), { path: request.deployDir });
  addCheck(checks, 'legacy-runtime-script', await exists(fsApi, deployCurrentScript), { path: deployCurrentScript });

  const sourceVersion = await readPackageVersion(fsApi, packagePath);
  addCheck(checks, 'target-version', sourceVersion === request.expectedTargetVersion.replace(/^v/, ''), { actual: sourceVersion, expected: request.expectedTargetVersion });

  const pm2State = await getAuthorizedPm2ProcessState(request, deps);
  addCheck(checks, 'pm2-process', pm2State.present, { processName: request.pm2ProcessName, status: pm2State.status });
  addCheck(checks, 'pm2-current-script', isExpectedPm2Script(pm2State.script, request, request.expectedCurrentScript), {
    actual: pm2State.script,
    expected: path.resolve(request.deployDir, request.expectedCurrentScript),
  });

  const health = await httpClient({ host: request.host, port: request.port, path: request.healthPath, method: 'GET' });
  const healthBody = parseJsonBody(health);
  addCheck(checks, 'current-health', health.ok && health.statusCode === 200, { statusCode: health.statusCode });
  addCheck(checks, 'current-version', isVersionMatch(healthBody, request.expectedCurrentVersion), {
    expected: request.expectedCurrentVersion,
  });

  const ss = await runner('ss', ['-ltnp'], { shell: false });
  const portLines = ss.stdout.split('\n').map((line) => line.trim()).filter((line) => line.includes(`:${request.port}`));
  addCheck(checks, 'backend-loopback-only', ss.ok && portLines.length > 0 && portLines.every((line) => line.includes(`${request.host}:${request.port}`)), { portLines });

  const protectedPorts = request.allowedServicePorts.filter((servicePort) => servicePort !== request.port).sort((a, b) => a - b);
  const frontend = await httpClient({ host: request.host, port: protectedPorts[0], path: '/', method: 'GET' });
  const generator = await httpClient({ host: request.host, port: protectedPorts[1], path: '/', method: 'GET' });
  addCheck(checks, `frontend-${protectedPorts[0]}-health`, frontend.ok && frontend.statusCode === 200, { statusCode: frontend.statusCode });
  addCheck(checks, `generator-${protectedPorts[1]}-health`, generator.ok && generator.statusCode === 200, { statusCode: generator.statusCode });
  const pm2EnvironmentKeys = validateSafePm2Environment(request, buildSafePm2Environment(request));
  addCheck(checks, 'pm2-environment-allowlist', true, { keys: pm2EnvironmentKeys });

  const operations = [
    'validate-request',
    'validate-repository',
    'validate-current-runtime',
    'run-source-self-check',
    'prepare-release',
    'copy-runtime-artifacts',
    'install-production-dependencies',
    'validate-release-manifest',
    'validate-release-no-symlinks',
    'record-critical-hashes',
    'validate-same-filesystem',
    'validate-pm2-environment-allowlist',
    'validate-backup-destination-absent',
    'inspect-authorized-pm2-process',
    'stop-authorized-pm2-process-if-present',
    'recover-original-runtime-in-place-if-pre-swap-failure',
    'atomic-rename-live-to-backup',
    'atomic-rename-release-to-live',
    'start-target-runtime-without-delete',
    'verify-pm2-target-state',
    'wait-for-target-runtime-readiness-bounded',
    'verify-target',
    'automatic-rollback-stop-if-present',
    'start-original-runtime-without-delete',
    'wait-for-original-runtime-readiness-bounded',
    'automatic-rollback-by-rename',
    'pm2-save-after-success',
    'write-json-report',
  ];

  return {
    ok: checks.every((check) => check.passed),
    mode: 'dry-run',
    operationId: request.operationId,
    checks,
    plan: {
      backupRoot: request.backupRoot,
      rollbackConditions: ['atomic-rename-release-to-live-failed', 'pm2-switch-failed', 'health-failed', 'status-failed', 'method-check-failed', 'not-found-check-failed', 'loopback-check-failed', 'protected-service-check-failed'],
      releaseDir: path.join(request.backupRoot, `.prepared-${request.operationId}`),
      wouldRun: operations,
    },
  };
}

function assertApplyAuthorized(request) {
  if (request.applyAuthorization !== `${APPLY_AUTH_PREFIX}${request.operationId}`) {
    throw fail(EXIT.APPLY_AUTH, 'apply_authorization_required', {
      expected: `${APPLY_AUTH_PREFIX}${request.operationId}`,
    });
  }
}

async function copyReleaseArtifacts(fsApi, request, releaseDir) {
  await fsApi.cp(path.join(request.sourceBackendDir, 'package.json'), path.join(releaseDir, 'package.json'));
  await fsApi.cp(path.join(request.sourceBackendDir, 'package-lock.json'), path.join(releaseDir, 'package-lock.json'));
  await fsApi.cp(path.join(request.sourceBackendDir, 'dist'), path.join(releaseDir, 'dist'), { recursive: true });
  const readme = path.join(request.sourceBackendDir, 'README.md');
  if (await exists(fsApi, readme)) await fsApi.cp(readme, path.join(releaseDir, 'README.md'));
}

async function verifyBackendHttp(request, deps, expectedVersion, { requireStatusEndpoint }) {
  const { runner, httpClient } = deps;
  const checks = [];
  const health = await httpClient({ host: request.host, port: request.port, path: request.healthPath, method: 'GET' });
  addCheck(checks, 'health-200', health.ok && health.statusCode === 200, { statusCode: health.statusCode });
  addCheck(checks, 'health-version', isVersionMatch(parseJsonBody(health), expectedVersion), { expected: expectedVersion });
  if (requireStatusEndpoint) {
    const statusResponse = await httpClient({ host: request.host, port: request.port, path: request.statusPath, method: 'GET' });
    addCheck(checks, 'status-200', statusResponse.ok && statusResponse.statusCode === 200, { statusCode: statusResponse.statusCode });
  }
  const method = await httpClient({ host: request.host, port: request.port, path: request.healthPath, method: 'POST' });
  addCheck(checks, 'health-post-405', method.ok && method.statusCode === 405, { statusCode: method.statusCode });
  const missing = await httpClient({ host: request.host, port: request.port, path: `/__missing_${request.operationId}`, method: 'GET' });
  addCheck(checks, 'missing-404', missing.ok && missing.statusCode === 404, { statusCode: missing.statusCode });
  const ss = await runner('ss', ['-ltnp'], { shell: false });
  const portLines = ss.stdout.split('\n').map((line) => line.trim()).filter((line) => line.includes(`:${request.port}`));
  addCheck(checks, 'loopback-only', ss.ok && portLines.length > 0 && portLines.every((line) => line.includes(`${request.host}:${request.port}`)), { portLines });
  const protectedPorts = request.allowedServicePorts.filter((servicePort) => servicePort !== request.port).sort((a, b) => a - b);
  const frontend = await httpClient({ host: request.host, port: protectedPorts[0], path: '/', method: 'GET' });
  const generator = await httpClient({ host: request.host, port: protectedPorts[1], path: '/', method: 'GET' });
  addCheck(checks, `frontend-${protectedPorts[0]}-200`, frontend.ok && frontend.statusCode === 200, { statusCode: frontend.statusCode });
  addCheck(checks, `generator-${protectedPorts[1]}-200`, generator.ok && generator.statusCode === 200, { statusCode: generator.statusCode });
  return { ok: checks.every((check) => check.passed), checks, health };
}

async function verifyTarget(request, deps) {
  return verifyBackendHttp(request, deps, request.expectedTargetVersion, { requireStatusEndpoint: true });
}

async function verifyOriginalRuntime(request, deps) {
  return verifyBackendHttp(request, deps, request.expectedCurrentVersion, { requireStatusEndpoint: false });
}

function buildSafePm2Environment(request, sourceEnv = process.env) {
  const env = {};
  for (const key of PM2_OPERATIONAL_ENV_KEYS) {
    if (Object.hasOwn(sourceEnv, key) && sourceEnv[key] !== undefined) {
      env[key] = String(sourceEnv[key]);
    }
  }
  return { ...env, ...PM2_FUNCTIONAL_ENV };
}

function validateSafePm2Environment(request, env) {
  assertPlainObject(env, 'pm2Environment');
  const keys = Object.keys(env).sort();
  const unexpected = keys.filter((key) => !SAFE_PM2_ENV_KEY_SET.has(key));
  if (unexpected.length > 0) throw fail(EXIT.APPLY_FAILED, 'pm2_environment_unexpected_keys', { keys: unexpected });
  for (const [key, value] of Object.entries(PM2_FUNCTIONAL_ENV)) {
    if (env[key] !== value) throw fail(EXIT.APPLY_FAILED, 'pm2_environment_functional_value_invalid', { key });
  }
  if (request.host !== PM2_FUNCTIONAL_ENV.LIA_AGENT_HOST) throw fail(EXIT.APPLY_FAILED, 'pm2_environment_host_request_mismatch');
  if (String(request.port) !== PM2_FUNCTIONAL_ENV.LIA_AGENT_PORT) throw fail(EXIT.APPLY_FAILED, 'pm2_environment_port_request_mismatch');
  return keys;
}

async function startRuntime(request, deps, script) {
  const env = buildSafePm2Environment(request);
  validateSafePm2Environment(request, env);
  await runRequired(
    deps.runner,
    'pm2',
    ['start', script, '--name', request.pm2ProcessName, '--interpreter', 'node'],
    { cwd: request.deployDir, env, shell: false },
    'pm2-start',
  );
  return verifyPm2TargetState(request, deps, script, { requireExactCwd: true });
}

async function assertOriginalRuntimeStillInPlace(request, deps) {
  await assertCriticalDeployPath(request, deps.fsApi);
  await assertTreeNoSymlinks(deps.fsApi, request.deployDir, 'deployDir');
  const scriptPath = path.join(request.deployDir, request.expectedCurrentScript);
  if (!(await exists(deps.fsApi, scriptPath))) {
    throw fail(EXIT.APPLY_FAILED, 'original_runtime_script_missing', { script: scriptPath });
  }
  const version = await readPackageVersion(deps.fsApi, path.join(request.deployDir, 'package.json'));
  if (version !== request.expectedCurrentVersion.replace(/^v/, '')) {
    throw fail(EXIT.APPLY_FAILED, 'original_runtime_version_mismatch', {
      actual: version,
      expected: request.expectedCurrentVersion,
    });
  }
}

function isExpectedPm2Cwd(actualCwd, request) {
  return Boolean(actualCwd) && path.resolve(actualCwd) === path.resolve(request.deployDir);
}

async function recoverOriginalRuntimeInPlace(request, deps, context) {
  if (context.liveMovedToBackup) {
    throw fail(EXIT.APPLY_FAILED, 'original_runtime_recovery_not_allowed_after_live_backup', {
      deployDir: request.deployDir,
    });
  }

  await assertOriginalRuntimeStillInPlace(request, deps);
  let state = await getAuthorizedPm2ProcessState(request, deps);
  let pm2Action = 'none';

  if (
    state.present
    && state.online
    && isExpectedPm2Script(state.script, request, request.expectedCurrentScript)
    && isExpectedPm2Cwd(state.cwd, request)
  ) {
    await verifyPm2TargetState(request, deps, request.expectedCurrentScript, { requireExactCwd: true });
    pm2Action = 'already-online';
  } else {
    if (state.present) {
      await stopAuthorizedRuntimeIfPresent(request, deps);
      pm2Action = 'delete-and-start-original';
    } else {
      pm2Action = 'start-original';
    }
    state = await startRuntime(request, deps, request.expectedCurrentScript);
  }

  const readiness = await waitForRuntimeReadiness(request, deps, 'original');
  if (readiness.outcome === 'exhausted') {
    throw fail(EXIT.APPLY_FAILED, 'original_runtime_recovery_verification_failed', {
      readiness,
    });
  }
  try {
    state = await verifyPm2TargetState(request, deps, request.expectedCurrentScript, { requireExactCwd: true });
  } catch (pm2Error) {
    throw fail(EXIT.APPLY_FAILED, 'original_runtime_recovery_verification_failed', {
      pm2Details: pm2Error.details ?? {},
      pm2Error: pm2Error.message,
      readiness,
    });
  }
  const verification = await verifyOriginalRuntime(request, deps);
  if (!verification.ok) {
    throw fail(EXIT.APPLY_FAILED, 'original_runtime_recovery_verification_failed', {
      checks: verification.checks,
      readiness,
    });
  }
  await runRequired(deps.runner, 'pm2', ['save'], { shell: false }, 'pm2-save-original-recovery');
  return {
    deployDir: request.deployDir,
    operationId: request.operationId,
    pm2Action,
    readiness,
    recoveryMode: 'original-runtime-in-place',
    script: path.resolve(request.deployDir, request.expectedCurrentScript),
    verification,
    pm2: {
      cwd: state.cwd,
      script: state.script,
      status: state.status,
    },
  };
}

async function moveFailedReleaseEvidence(request, deps) {
  if (!(await exists(deps.fsApi, request.deployDir))) return null;
  const evidenceDir = path.join(request.backupRoot, `failed-release-${request.operationId}`);
  await assertCriticalReleasePath(request, deps.fsApi, evidenceDir, { mustExist: false });
  await assertCriticalDeployPath(request, deps.fsApi);
  await deps.fsApi.rename(request.deployDir, evidenceDir);
  return evidenceDir;
}

async function restoreBackupByRename(request, backupDir, deps, { moveFailedRelease }) {
  const fsApi = deps.fsApi;
  await stopAuthorizedRuntimeIfPresent(request, deps);
  const backup = await assertCriticalBackupPath(request, fsApi, backupDir, { mustExist: true });
  await assertBackupComplete(fsApi, request, backupDir);
  const backupRoot = await assertExistingDirectorySafe(fsApi, request.backupRoot, 'backupRoot');
  assertSameFilesystem({ backup: backup.stat, backupRoot: backupRoot.stat });
  let failedReleaseDir = null;
  if (moveFailedRelease) {
    failedReleaseDir = await moveFailedReleaseEvidence(request, deps, backupDir);
  } else if (await exists(fsApi, request.deployDir)) {
    throw fail(EXIT.ROLLBACK_FAILED, 'deployDir_ambiguous_before_explicit_rollback', { path: request.deployDir });
  }
  await assertCriticalBackupPath(request, fsApi, backupDir, { mustExist: true });
  await fsApi.rename(backupDir, request.deployDir);
  await assertCriticalDeployPath(request, fsApi);
  await startRuntime(request, deps, request.expectedCurrentScript);
  const readiness = await waitForRuntimeReadiness(request, deps, 'original');
  if (readiness.outcome === 'exhausted') {
    throw fail(EXIT.ROLLBACK_FAILED, 'rollback_verification_failed', { failedReleaseDir, readiness });
  }
  try {
    await verifyPm2TargetState(request, deps, request.expectedCurrentScript, { requireExactCwd: true });
  } catch (pm2Error) {
    throw fail(EXIT.ROLLBACK_FAILED, 'rollback_verification_failed', {
      failedReleaseDir,
      pm2Details: pm2Error.details ?? {},
      pm2Error: pm2Error.message,
      readiness,
    });
  }
  const verification = await verifyOriginalRuntime(request, deps);
  if (!verification.ok) throw fail(EXIT.ROLLBACK_FAILED, 'rollback_verification_failed', { checks: verification.checks, failedReleaseDir, readiness });
  await runRequired(deps.runner, 'pm2', ['save'], { shell: false }, 'pm2-save-rollback');
  return { failedReleaseDir, readiness, script: request.expectedCurrentScript, verification };
}

async function runRollback(request, deps) {
  const backupDir = assertAbsoluteCleanPath(request.rollback?.backupDir ?? '', 'rollback.backupDir');
  assertPathInside(backupDir, request.backupRoot, 'rollback.backupDir');
  await assertNoSymlinkPath(backupDir, 'rollback.backupDir', deps.fsApi);
  const deployExists = await exists(deps.fsApi, request.deployDir);
  if (deployExists) throw fail(EXIT.ROLLBACK_FAILED, 'deployDir_ambiguous_before_explicit_rollback', { path: request.deployDir });
  const rollback = await restoreBackupByRename(request, backupDir, deps, { moveFailedRelease: false });
  return { ok: true, mode: 'rollback', operationId: request.operationId, restoredBackup: backupDir, rollback };
}

async function runApply(request, deps) {
  assertApplyAuthorized(request);
  const preflight = await runPreflight(request, deps);
  if (!preflight.ok) throw fail(EXIT.PREFLIGHT, 'preflight_failed', { checks: preflight.checks });

  let backupDir = path.join(request.backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${request.operationId}`);
  let liveMovedToBackup = false;
  const runtimeStopState = {
    liveMovedToBackup: false,
    runtimeAlreadyAbsent: false,
    runtimeDeleted: false,
    runtimeStopAttempted: false,
    runtimeWasPresent: false,
  };
  const releaseDir = path.join(request.backupRoot, `.prepared-${request.operationId}`);
  const report = { backupDir, hashes: [], mode: 'apply', operationId: request.operationId, readiness: {}, releaseDir, steps: [] };

  try {
    await runRequired(deps.runner, 'npm', ['run', 'self-check'], { cwd: request.sourceBackendDir, shell: false }, 'source-self-check');
    report.steps.push('source-self-check');
    await assertCriticalDeployPath(request, deps.fsApi);
    await deps.fsApi.mkdir(request.backupRoot, { recursive: true });
    await assertCriticalBackupPath(request, deps.fsApi, backupDir, { mustExist: false });
    await assertCriticalReleasePath(request, deps.fsApi, releaseDir, { mustExist: false });
    const deployStat = await deps.fsApi.stat(request.deployDir);
    const backupRootStat = await deps.fsApi.stat(request.backupRoot);
    assertSameFilesystem({ backupRoot: backupRootStat, deployDir: deployStat });
    await deps.fsApi.mkdir(releaseDir, { recursive: false });
    await copyReleaseArtifacts(deps.fsApi, request, releaseDir);
    report.steps.push('prepare-release');
    await runRequired(
      deps.runner,
      'npm',
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: releaseDir, shell: false },
      'npm-ci-production',
    );
    report.steps.push('npm-ci-production');
    await assertReleaseComplete(deps.fsApi, request, releaseDir);
    report.steps.push('release-validated');
    const releaseStat = await deps.fsApi.stat(releaseDir);
    assertSameFilesystem({ backupRoot: backupRootStat, deployDir: deployStat, releaseDir: releaseStat });
    await assertCriticalBackupPath(request, deps.fsApi, backupDir, { mustExist: false });
    await assertCriticalReleasePath(request, deps.fsApi, releaseDir, { mustExist: true });
    report.hashes = {
      current: await collectCriticalHashes(deps.fsApi, request.deployDir, ['server.mjs', 'package.json', 'dist/server.js']),
      release: await collectCriticalHashes(deps.fsApi, releaseDir, ['package.json', 'package-lock.json', 'dist/server.js']),
    };
    report.steps.push('hashes-recorded');
    await stopAuthorizedRuntimeIfPresent(request, deps, runtimeStopState);
    report.steps.push('stop-authorized-pm2-process-if-present');
    await assertCriticalDeployPath(request, deps.fsApi);
    await assertTreeNoSymlinks(deps.fsApi, request.deployDir, 'deployDir');
    await assertCriticalBackupPath(request, deps.fsApi, backupDir, { mustExist: false });
    await deps.fsApi.rename(request.deployDir, backupDir);
    liveMovedToBackup = true;
    runtimeStopState.liveMovedToBackup = true;
    report.steps.push('atomic-rename-live-to-backup');
    await assertCriticalReleasePath(request, deps.fsApi, releaseDir, { mustExist: true });
    if (await exists(deps.fsApi, request.deployDir)) throw fail(EXIT.APPLY_FAILED, 'deployDir_unexpectedly_exists_before_release_rename');
    await deps.fsApi.rename(releaseDir, request.deployDir);
    report.steps.push('atomic-rename-release-to-live');
    await startRuntime(request, deps, request.expectedTargetScript);
    report.steps.push('pm2-target-started');
    const readiness = await waitForRuntimeReadiness(request, deps, 'target');
    report.readiness.target = readiness;
    if (readiness.outcome === 'exhausted') {
      throw fail(EXIT.APPLY_FAILED, 'target_verification_failed', { readiness });
    }
    try {
      await verifyPm2TargetState(request, deps, request.expectedTargetScript, { requireExactCwd: true });
    } catch (pm2Error) {
      throw fail(EXIT.APPLY_FAILED, 'target_verification_failed', {
        pm2Details: pm2Error.details ?? {},
        pm2Error: pm2Error.message,
        readiness,
      });
    }
    report.steps.push('pm2-target-revalidated-after-readiness');
    const verification = await verifyTarget(request, deps);
    if (!verification.ok) throw fail(EXIT.APPLY_FAILED, 'target_verification_failed', { checks: verification.checks, readiness });
    await runRequired(deps.runner, 'pm2', ['save'], { shell: false }, 'pm2-save-apply');
    report.steps.push('pm2-save');
    return { ...report, backupDir, ok: true, verification };
  } catch (error) {
    if (liveMovedToBackup && backupDir) {
      let rollback;
      try {
        rollback = await restoreBackupByRename(request, backupDir, deps, { moveFailedRelease: true });
      } catch (rollbackError) {
        throw fail(EXIT.ROLLBACK_FAILED, 'apply_failed_automatic_rollback_failed', {
          backupDir,
          failedReleaseDir: path.join(request.backupRoot, `failed-release-${request.operationId}`),
          originalDetails: error.details ?? {},
          originalError: error.message,
          rollbackDetails: rollbackError.details ?? {},
          rollbackError: rollbackError.message,
        });
      }
      throw fail(EXIT.APPLY_FAILED, 'apply_failed_automatic_rollback_succeeded', {
        backupDir,
        failedReleaseDir: rollback.failedReleaseDir,
        originalDetails: error.details ?? {},
        originalError: error.message,
        rollback,
      });
    }
    if (!liveMovedToBackup && runtimeStopState.runtimeStopAttempted && runtimeStopState.runtimeDeleted) {
      try {
        const recovery = await recoverOriginalRuntimeInPlace(request, deps, runtimeStopState);
        throw fail(EXIT.APPLY_FAILED, 'apply_failed_original_runtime_recovered_in_place', {
          deployDir: request.deployDir,
          expectedCurrentScript: path.resolve(request.deployDir, request.expectedCurrentScript),
          liveMovedToBackup,
          originalDetails: error.details ?? {},
          originalError: error.message,
          recovery,
        });
      } catch (recoveryOrFinalError) {
        if (recoveryOrFinalError.message === 'apply_failed_original_runtime_recovered_in_place') throw recoveryOrFinalError;
        let pm2State;
        try {
          const state = await getAuthorizedPm2ProcessState(request, deps);
          pm2State = {
            cwd: state.cwd,
            present: state.present,
            script: state.script,
            status: state.status,
          };
        } catch (pm2Error) {
          pm2State = { error: pm2Error.message };
        }
        throw fail(EXIT.APPLY_FAILED, 'apply_failed_original_runtime_recovery_failed', {
          deployDir: request.deployDir,
          expectedCurrentScript: path.resolve(request.deployDir, request.expectedCurrentScript),
          liveMovedToBackup,
          originalDetails: error.details ?? {},
          originalError: error.message,
          pm2State,
          recoveryDetails: recoveryOrFinalError.details ?? {},
          recoveryError: recoveryOrFinalError.message,
        });
      }
    }
    throw error;
  }
}

export async function executeController({ argv, request, policy = REAL_POLICY, runner = createDefaultRunner(), httpClient = createDefaultHttpClient(), fsApi = realFs, sleep = defaultSleep } = {}) {
  const parsed = argv ? parseArgs(argv) : null;
  const mode = parsed?.mode ?? argv?.mode ?? request?.mode;
  let loadedRequest = request;
  if (!loadedRequest && parsed?.requestPath) loadedRequest = await readRequest(parsed.requestPath, fsApi);
  if (!mode) throw fail(EXIT.CLI, 'mode_required');
  const normalized = normalizeRequest(loadedRequest, policy);
  await validateRequestPaths(normalized, fsApi);

  if (mode === 'dry-run') return runPreflight(normalized, { fsApi, runner, httpClient });
  if (mode === 'apply') return runApply(normalized, { fsApi, runner, httpClient, sleep });
  if (mode === 'rollback') return runRollback(normalized, { fsApi, runner, httpClient, sleep });
  throw fail(EXIT.CLI, 'mode_not_supported', { mode });
}

export { EXIT, REAL_POLICY, buildSafePm2Environment, jsonText, parseArgs, validateSafePm2Environment };

async function main() {
  try {
    const result = await executeController({ argv: process.argv.slice(2) });
    process.stdout.write(jsonText(result));
    process.exitCode = result.ok ? EXIT.OK : EXIT.PREFLIGHT;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(jsonText({ details: error.details ?? {}, error: error.message, ok: false }));
    process.exitCode = exitFor(error);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  await main();
}
