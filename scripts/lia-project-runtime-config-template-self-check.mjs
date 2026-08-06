import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Self-check: the checked-in runtime configuration templates for the
 * autonomous project flow must be accepted by the SAME strict parsers the
 * TypeScript backend uses at runtime, and a real task request for
 * `lia-hermes` must resolve during planning.
 *
 * When the runtime environment points to real config files
 * (LIA_PROJECT_REGISTRY_PATH / LIA_PROJECT_VERIFICATION_PATH), they are
 * validated read-only with the same parsers and reported as evidence.
 *
 * Requires the backend TypeScript build:
 *   cd backend/lia-agent && npm run build
 */
const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = resolve(scriptDir, '..');
const registryTemplatePath = join(repoRoot, 'config', 'lia-hermes.projects.example.json');
const verificationTemplatePath = join(repoRoot, 'config', 'lia-hermes.project-verification.example.json');
const dist = join(repoRoot, 'backend', 'lia-agent', 'dist');
const registryFileSourcePath = join(dist, 'services', 'projectRegistryFileSource.js');
const verificationFileSourcePath = join(dist, 'services', 'projectVerificationFileSource.js');
const plannerPath = join(dist, 'services', 'projectExecutionPlanner.js');
const PROJECT_ID = 'lia-hermes';
const REQUESTED_CAPABILITIES = ['repository_read', 'isolated_worktree_write', 'run_tests', 'local_commit'];

function createResult(ok, detail, evidence = {}) {
  return { ok, selfCheck: 'lia-project-runtime-config-template', detail, ...evidence };
}

function fail(detail, evidence = {}) {
  console.log(JSON.stringify(createResult(false, detail, evidence), null, 2));
  process.exit(1);
}

let registrySourceFactory;
let verificationSourceFactory;
let planProjectTask;
try {
  ({ createProjectRegistryFileSource: registrySourceFactory } = await import(registryFileSourcePath));
  ({ createFileProjectVerificationRegistry: verificationSourceFactory } = await import(verificationFileSourcePath));
  ({ planProjectTask } = await import(plannerPath));
} catch (error) {
  fail('backend_dist_missing', {
    requiredBuild: 'cd backend/lia-agent && npm run build',
    cause: error instanceof Error ? error.message : 'unknown_error',
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const validatePlan = async (registrySource, instruction) => {
  const planning = await planProjectTask({
    projectId: PROJECT_ID,
    instruction,
    priority: 'normal',
    requestedCapabilities: REQUESTED_CAPABILITIES,
  }, registrySource);
  if (!planning.ok) {
    fail('real_planning_rejected_config', { error: planning.error });
  }
  return planning.plan;
};

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'lia-config-template-'));
try {
  const templates = {
    registry: JSON.parse(await readFile(registryTemplatePath, 'utf8')),
    verification: JSON.parse(await readFile(verificationTemplatePath, 'utf8')),
  };
  const registryPath = join(temporaryDirectory, 'projects.json');
  const verificationPath = join(temporaryDirectory, 'project-verification.json');
  await writeFile(registryPath, JSON.stringify(templates.registry), 'utf8');
  await writeFile(verificationPath, JSON.stringify(templates.verification), 'utf8');

  const registrySource = registrySourceFactory(registryPath);
  const entries = await registrySource.read();
  const entry = entries.find((candidate) => candidate.projectId === PROJECT_ID);
  if (entry === undefined) {
    fail('registry_template_does_not_contain_lia_hermes', { projectId: PROJECT_ID });
  }
  if (!entry.enabled || !entry.repositoryRoot.startsWith('/')) {
    fail('registry_template_entry_invalid', { entry });
  }

  const verificationRegistry = verificationSourceFactory(verificationPath);
  const profile = verificationRegistry.resolve(PROJECT_ID);
  if (profile === undefined || profile.checks.length < 1 || profile.checks.length > 8) {
    fail('verification_template_profile_invalid', { projectId: PROJECT_ID });
  }

  const templatePlanning = await validatePlan(registrySource, 'Verifica que el flujo autónomo acepta una instrucción real de proyecto.');

  const runtimeRegistryPath = process.env.LIA_PROJECT_REGISTRY_PATH;
  const runtimeVerificationPath = process.env.LIA_PROJECT_VERIFICATION_PATH;
  let runtimeConfig = { configured: false };
  if (runtimeRegistryPath && runtimeVerificationPath && await exists(runtimeRegistryPath) && await exists(runtimeVerificationPath)) {
    const runtimeRegistrySource = registrySourceFactory(runtimeRegistryPath);
    const runtimeEntries = await runtimeRegistrySource.read();
    const runtimeEntry = runtimeEntries.find((candidate) => candidate.projectId === PROJECT_ID);
    if (runtimeEntry === undefined) {
      fail('runtime_registry_does_not_contain_lia_hermes', { projectId: PROJECT_ID, registryPath: runtimeRegistryPath });
    }
    const runtimeProfile = verificationSourceFactory(runtimeVerificationPath).resolve(PROJECT_ID);
    if (runtimeProfile === undefined || runtimeProfile.checks.length < 1) {
      fail('runtime_verification_profile_invalid', { projectId: PROJECT_ID, verificationPath: runtimeVerificationPath });
    }
    const runtimePlanning = await validatePlan(runtimeRegistrySource, 'Verifica que la configuración de runtime acepta una instrucción real de proyecto.');
    runtimeConfig = {
      configured: true,
      registryPath: runtimeRegistryPath,
      verificationPath: runtimeVerificationPath,
      registryEntry: runtimeEntry,
      verificationChecks: runtimeProfile.checks.map((check) => ({ id: check.id, executable: check.executable, args: check.args, timeoutMs: check.timeoutMs })),
      planning: {
        ok: true,
        repositoryRoot: runtimePlanning.repositoryRoot,
        approvedCapabilities: runtimePlanning.approvedCapabilities,
      },
    };
  }

  console.log(JSON.stringify(createResult(true, 'Runtime configuration templates are accepted by the real backend parsers and real planning.', {
    projectId: PROJECT_ID,
    template: {
      registryEntry: entry,
      verificationChecks: profile.checks.map((check) => ({ id: check.id, executable: check.executable, args: check.args, timeoutMs: check.timeoutMs })),
      planning: {
        ok: true,
        repositoryRoot: templatePlanning.repositoryRoot,
        approvedCapabilities: templatePlanning.approvedCapabilities,
      },
    },
    runtime: runtimeConfig,
  }), null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
