import type {
  ProjectRegistryEntry,
  ProjectRegistrySource,
  ProjectResolutionResult,
} from '../contracts/projectRegistry.js';

const SAFE_PROJECT_ID = /^[A-Za-z0-9._-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const projectId = value.trim();
  if (
    projectId.length === 0
    || projectId.length > 120
    || !SAFE_PROJECT_ID.test(projectId)
    || projectId.includes('..')
  ) {
    return undefined;
  }

  return projectId;
}

function normalizeEntry(value: unknown): ProjectRegistryEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const projectId = normalizeProjectId(value.projectId);
  const displayName = typeof value.displayName === 'string'
    ? value.displayName.trim()
    : '';
  const repositoryRoot = typeof value.repositoryRoot === 'string'
    ? value.repositoryRoot.trim()
    : '';

  if (
    projectId === undefined
    || displayName.length === 0
    || displayName.length > 160
    || !repositoryRoot.startsWith('/')
    || repositoryRoot === '/'
    || repositoryRoot.includes('\0')
    || typeof value.enabled !== 'boolean'
  ) {
    return undefined;
  }

  return {
    projectId,
    displayName,
    repositoryRoot,
    enabled: value.enabled,
  };
}

export function normalizeProjectRegistry(value: unknown): ProjectRegistryEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries: ProjectRegistryEntry[] = [];
  const projectIds = new Set<string>();

  for (const valueEntry of value) {
    const entry = normalizeEntry(valueEntry);
    if (entry === undefined || projectIds.has(entry.projectId)) {
      return undefined;
    }

    projectIds.add(entry.projectId);
    entries.push(entry);
  }

  return entries;
}

function copyEntries(entries: readonly ProjectRegistryEntry[]): ProjectRegistryEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function createStaticProjectRegistry(
  entries: readonly ProjectRegistryEntry[],
): ProjectRegistrySource {
  const snapshot = normalizeProjectRegistry(entries);

  return {
    async read() {
      if (snapshot === undefined) {
        throw new Error('invalid_project_registry');
      }

      return copyEntries(snapshot);
    },
  };
}

export async function resolveAuthorizedProject(
  projectId: string,
  source: ProjectRegistrySource,
): Promise<ProjectResolutionResult> {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (normalizedProjectId === undefined) {
    return { ok: false, error: 'project_not_found' };
  }

  let entries: ProjectRegistryEntry[] | undefined;
  try {
    entries = normalizeProjectRegistry(await source.read());
  } catch {
    return { ok: false, error: 'registry_unavailable' };
  }

  if (entries === undefined) {
    return { ok: false, error: 'registry_unavailable' };
  }

  const entry = entries.find((candidate) => candidate.projectId === normalizedProjectId);
  if (entry === undefined) {
    return { ok: false, error: 'project_not_found' };
  }
  if (!entry.enabled) {
    return { ok: false, error: 'project_disabled' };
  }

  return {
    ok: true,
    target: {
      projectId: entry.projectId,
      displayName: entry.displayName,
      repositoryRoot: entry.repositoryRoot,
    },
  };
}
