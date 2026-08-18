import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ProjectVerificationRegistry } from '../contracts/projectVerification.js';
import { createStaticProjectVerificationRegistry } from './projectVerificationRegistry.js';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_PROFILES = 100;
const TOP_LEVEL_FIELDS = new Set(['version', 'profiles']);
const PROFILE_FIELDS = new Set(['projectId', 'checks']);
const CHECK_FIELDS = new Set(['id', 'executable', 'args', 'timeoutMs']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactFields(value: Record<string, unknown>, fields: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function unavailableRegistry(): ProjectVerificationRegistry {
  return { resolve: () => undefined };
}

function parseFile(contents: Buffer): ProjectVerificationRegistry {
  if (contents.byteLength > MAX_FILE_BYTES) {
    throw new Error('invalid_project_verification_file');
  }

  let value: unknown;
  try {
    value = JSON.parse(contents.toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid_project_verification_file');
  }

  if (
    !isRecord(value)
    || !hasExactFields(value, TOP_LEVEL_FIELDS)
    || value.version !== 1
    || !Array.isArray(value.profiles)
    || value.profiles.length > MAX_PROFILES
    || value.profiles.some((profile) => (
      !isRecord(profile)
      || !hasExactFields(profile, PROFILE_FIELDS)
      || !Array.isArray(profile.checks)
      || profile.checks.some((check) => !isRecord(check) || !hasExactFields(check, CHECK_FIELDS))
    ))
  ) {
    throw new Error('invalid_project_verification_file');
  }

  return createStaticProjectVerificationRegistry(value.profiles);
}

export function createFileProjectVerificationRegistry(path: string): ProjectVerificationRegistry {
  if (path === '') {
    return unavailableRegistry();
  }
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('invalid_project_verification_path');
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
      return unavailableRegistry();
    }
    return parseFile(readFileSync(descriptor));
  } catch {
    return unavailableRegistry();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Resolution remains fail-closed even if closing the read-only descriptor fails.
      }
    }
  }
}
