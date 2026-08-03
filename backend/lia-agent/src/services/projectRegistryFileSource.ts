import { open } from 'node:fs/promises';
import type {
  ProjectRegistryEntry,
  ProjectRegistrySource,
} from '../contracts/projectRegistry.js';
import { normalizeProjectRegistry } from './projectRegistry.js';

const MAX_REGISTRY_BYTES = 64 * 1024;
const TOP_LEVEL_FIELDS = new Set(['version', 'projects']);
const PROJECT_FIELDS = new Set([
  'projectId',
  'displayName',
  'repositoryRoot',
  'enabled',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactFields(value: Record<string, unknown>, fields: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function parseRegistryFile(contents: Buffer): ProjectRegistryEntry[] {
  if (contents.byteLength > MAX_REGISTRY_BYTES) {
    throw new Error('invalid_project_registry_file');
  }

  let value: unknown;
  try {
    value = JSON.parse(contents.toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid_project_registry_file');
  }

  if (
    !isRecord(value)
    || !hasExactFields(value, TOP_LEVEL_FIELDS)
    || value.version !== 1
    || !Array.isArray(value.projects)
    || value.projects.some((project) => (
      !isRecord(project) || !hasExactFields(project, PROJECT_FIELDS)
    ))
  ) {
    throw new Error('invalid_project_registry_file');
  }

  const entries = normalizeProjectRegistry(value.projects);
  if (entries === undefined) {
    throw new Error('invalid_project_registry_file');
  }

  return entries;
}

export function createProjectRegistryFileSource(path: string): ProjectRegistrySource {
  return {
    async read() {
      const file = await open(path, 'r');
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_REGISTRY_BYTES) {
          throw new Error('invalid_project_registry_file');
        }

        const entries = parseRegistryFile(await file.readFile());
        return entries.map((entry) => ({ ...entry }));
      } finally {
        await file.close();
      }
    },
  };
}
