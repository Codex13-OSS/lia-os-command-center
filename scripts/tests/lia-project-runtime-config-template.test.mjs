import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const registryPath = new URL('../../config/lia-hermes.projects.example.json', import.meta.url);
const verificationPath = new URL('../../config/lia-hermes.project-verification.example.json', import.meta.url);
const PROJECT_ID = 'lia-hermes';
const ALLOWED_EXECUTABLES = new Set(['npm', 'node', 'npx']);
const FORBIDDEN_ARGUMENTS = new Set(['push', 'merge', 'deploy', 'git', 'ssh', 'curl', 'wget', 'bash', 'sh']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactFields = (value, fields) => {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
};

test('registry template matches the strict backend project registry contract', async () => {
  const value = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.equal(isRecord(value), true);
  assert.deepEqual(Object.keys(value).sort(), ['projects', 'version']);
  assert.equal(value.version, 1);
  assert.equal(Array.isArray(value.projects), true);
  assert.equal(value.projects.length, 1);
  const project = value.projects[0];
  assert.equal(isRecord(project), true);
  assert.deepEqual(Object.keys(project).sort(), ['displayName', 'enabled', 'projectId', 'repositoryRoot']);
  assert.equal(project.projectId, PROJECT_ID);
  assert.equal(SAFE_IDENTIFIER.test(project.projectId), true);
  assert.equal(project.projectId.includes('..'), false);
  assert.equal(typeof project.displayName, 'string');
  assert.ok(project.displayName.trim().length > 0 && project.displayName.trim().length <= 160);
  assert.equal(typeof project.repositoryRoot, 'string');
  assert.ok(project.repositoryRoot.startsWith('/'));
  assert.notEqual(project.repositoryRoot, '/');
  assert.equal(project.enabled, true);
});

test('verification template matches the strict backend verification profile contract', async () => {
  const value = JSON.parse(await readFile(verificationPath, 'utf8'));
  assert.equal(isRecord(value), true);
  assert.deepEqual(Object.keys(value).sort(), ['profiles', 'version']);
  assert.equal(value.version, 1);
  assert.equal(Array.isArray(value.profiles), true);
  assert.equal(value.profiles.length, 1);
  const profile = value.profiles[0];
  assert.equal(isRecord(profile), true);
  assert.deepEqual(Object.keys(profile).sort(), ['checks', 'projectId']);
  assert.equal(profile.projectId, PROJECT_ID);
  assert.equal(SAFE_IDENTIFIER.test(profile.projectId), true);
  assert.equal(Array.isArray(profile.checks), true);
  assert.ok(profile.checks.length >= 1 && profile.checks.length <= 8);
  const ids = new Set();
  for (const check of profile.checks) {
    assert.equal(isRecord(check), true);
    assert.deepEqual(Object.keys(check).sort(), ['args', 'executable', 'id', 'timeoutMs']);
    assert.equal(SAFE_IDENTIFIER.test(check.id), true);
    assert.ok(check.id.length > 0 && check.id.length <= 80);
    assert.ok(ALLOWED_EXECUTABLES.has(check.executable));
    assert.equal(Array.isArray(check.args), true);
    assert.ok(check.args.length > 0 && check.args.length <= 16);
    assert.equal(Number.isInteger(check.timeoutMs), true);
    assert.ok(check.timeoutMs >= 1000 && check.timeoutMs <= 300000);
    let totalChars = 0;
    for (const arg of check.args) {
      assert.equal(typeof arg, 'string');
      assert.ok(arg.length > 0 && arg.trim().length > 0);
      assert.equal(arg.includes('\0'), false);
      assert.ok(arg.length <= 4096);
      totalChars += arg.length;
      assert.ok(totalChars <= 16384);
      assert.equal(FORBIDDEN_ARGUMENTS.has(arg.toLowerCase()), false);
    }
    assert.equal(ids.has(check.id), false);
    ids.add(check.id);
  }
});

test('templates target the autonomous project used by the Projects interface', async () => {
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
  assert.equal(registry.projects[0].projectId, PROJECT_ID);
  assert.equal(verification.profiles[0].projectId, PROJECT_ID);
  const request = {
    projectId: PROJECT_ID,
    instruction: 'plantilla',
    priority: 'normal',
    requestedCapabilities: ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'],
  };
  assert.deepEqual(Object.keys(request).sort(), ['instruction', 'priority', 'projectId', 'requestedCapabilities']);
});
