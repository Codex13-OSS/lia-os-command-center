import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('.env.example documents every LIA_* config variable read by config.ts', async () => {
  const [configSource, exampleSource] = await Promise.all([
    readFile(path.join(backendRoot, 'src', 'config.ts'), 'utf8'),
    readFile(path.join(backendRoot, '.env.example'), 'utf8'),
  ]);

  const configVars = [...configSource.matchAll(/env\.(LIA_[A-Z_]+)/g)].map((match) => match[1]);
  assert.ok(configVars.length >= 15, `expected config vars to be enumerated, got ${configVars.length}`);

  for (const name of [...new Set(configVars)]) {
    assert.ok(
      exampleSource.includes(`${name}=`),
      `config var ${name} is missing from .env.example`,
    );
  }
});

test('.env.example documents the autonomous project workflow runtime contract', async () => {
  const exampleSource = await readFile(path.join(backendRoot, '.env.example'), 'utf8');

  for (const name of [
    'LIA_PROJECT_REGISTRY_PATH',
    'LIA_PROJECT_VERIFICATION_PATH',
    'LIA_PROJECT_TASK_SQLITE_PATH',
    'LIA_HERMES_EXECUTION_ENABLED',
    'LIA_HERMES_PATH',
    'LIA_CODEX_PROVIDER_MODE',
    'DEEPSEEK_API_KEY',
  ]) {
    assert.ok(
      exampleSource.includes(`${name}=`),
      `workflow var ${name} is missing from .env.example`,
    );
  }

  assert.match(exampleSource, /registry_unavailable/);
  assert.match(exampleSource, /verification_unavailable/);
});

test('README documents the autonomous workflow configuration and run flow', async () => {
  const readmeSource = await readFile(path.join(backendRoot, 'README.md'), 'utf8');

  for (const name of [
    'LIA_PROJECT_REGISTRY_PATH',
    'LIA_PROJECT_VERIFICATION_PATH',
    'LIA_HERMES_EXECUTION_ENABLED',
    'LIA_HERMES_PATH',
  ]) {
    assert.ok(readmeSource.includes(name), `README should document ${name}`);
  }

  assert.match(readmeSource, /Flujo de proyecto autónomo/);
  assert.match(readmeSource, /npm run dev:lia/);
});
