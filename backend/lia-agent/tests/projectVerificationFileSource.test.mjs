import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileProjectVerificationRegistry } from '../dist/services/projectVerificationFileSource.js';

const validProfile = () => ({
  projectId: 'project-id',
  checks: [{ id: 'typecheck', executable: 'npm', args: ['run', 'typecheck'], timeoutMs: 120_000 }],
});

async function withFile(value, run, raw = false) {
  const directory = await mkdtemp(join(tmpdir(), 'lia-verification-'));
  const path = join(directory, 'verification.json');
  try {
    await writeFile(path, raw ? value : JSON.stringify(value), 'utf8');
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('valid version 1 file resolves independent profile copies', async () => {
  await withFile({ version: 1, profiles: [validProfile()] }, (path) => {
    const registry = createFileProjectVerificationRegistry(path);
    const first = registry.resolve('project-id');
    assert.deepEqual(first, validProfile());
    first.checks[0].args[0] = 'changed';
    assert.deepEqual(registry.resolve('project-id'), validProfile());
  });
});

test('missing and corrupt files fail closed without leaking paths', async () => {
  const secretPath = join(tmpdir(), 'lia-secret-verification-does-not-exist.json');
  const missing = createFileProjectVerificationRegistry(secretPath);
  assert.equal(missing.resolve('project-id'), undefined);
  assert.equal(JSON.stringify(missing).includes(secretPath), false);

  await withFile('{broken', (path) => {
    const registry = createFileProjectVerificationRegistry(path);
    assert.equal(registry.resolve('project-id'), undefined);
    assert.equal(JSON.stringify(registry).includes(path), false);
  }, true);
});

test('invalid versions, fields, and profile counts fail closed', async () => {
  const cases = [
    { version: 2, profiles: [validProfile()] },
    { version: 1, profiles: [validProfile()], extra: true },
    { version: 1, profiles: [{ ...validProfile(), extra: true }] },
    { version: 1, profiles: [{ ...validProfile(), checks: [{ ...validProfile().checks[0], extra: true }] }] },
    { version: 1, profiles: Array.from({ length: 101 }, (_, index) => ({ ...validProfile(), projectId: `p-${index}` })) },
  ];
  for (const value of cases) {
    await withFile(value, (path) => assert.equal(createFileProjectVerificationRegistry(path).resolve('project-id'), undefined));
  }
});

test('files larger than 64 KiB fail closed', async () => {
  await withFile('x'.repeat((64 * 1024) + 1), (path) => {
    assert.equal(createFileProjectVerificationRegistry(path).resolve('project-id'), undefined);
  }, true);
});

test('duplicate project or check ids fail closed', async () => {
  const duplicateCheck = validProfile();
  duplicateCheck.checks.push({ ...duplicateCheck.checks[0] });
  for (const profiles of [[validProfile(), validProfile()], [duplicateCheck]]) {
    await withFile({ version: 1, profiles }, (path) => {
      assert.equal(createFileProjectVerificationRegistry(path).resolve('project-id'), undefined);
    });
  }
});

test('unsafe executable, args, and timeout fail closed', async () => {
  const checks = [
    { ...validProfile().checks[0], executable: 'bash' },
    { ...validProfile().checks[0], args: ['curl'] },
    { ...validProfile().checks[0], timeoutMs: 999 },
  ];
  for (const check of checks) {
    await withFile({ version: 1, profiles: [{ ...validProfile(), checks: [check] }] }, (path) => {
      assert.equal(createFileProjectVerificationRegistry(path).resolve('project-id'), undefined);
    });
  }
});

test('relative paths are rejected with a path-free error', () => {
  assert.throws(
    () => createFileProjectVerificationRegistry('./secret-verification.json'),
    (error) => error instanceof Error
      && error.message === 'invalid_project_verification_path'
      && !error.message.includes('secret-verification.json'),
  );
});

test('blank path is an unconfigured fail-closed registry', () => {
  const registry = createFileProjectVerificationRegistry('');
  assert.equal(registry.resolve('project-id'), undefined);
});

test('file source contains no process, shell, network, or write capabilities', async () => {
  const source = await readFile(
    new URL('../src/services/projectVerificationFileSource.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    'child_process', 'exec(', 'spawn(', 'shell', 'fetch(', 'node:http', 'node:https',
    'writeFile', 'mkdir', 'chmod', 'chown', 'curl', 'wget',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden capability: ${forbidden}`);
  }
});
