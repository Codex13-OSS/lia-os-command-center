import type {
  ProjectVerificationCheck,
  ProjectVerificationExecutable,
  ProjectVerificationProfile,
  ProjectVerificationRegistry,
} from "../contracts/projectVerification.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const EXECUTABLES = new Set<ProjectVerificationExecutable>(["npm", "node", "npx"]);
const FORBIDDEN_ARGUMENTS = new Set(["push", "merge", "deploy", "git", "ssh", "curl", "wget", "bash", "sh"]);
const MAX_ARGUMENT_CHARS = 4_096;
const MAX_TOTAL_ARGUMENT_CHARS = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && Object.keys(value).length === keys.length;
}

function safeIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && SAFE_IDENTIFIER.test(value)
    && !value.includes("..");
}

function normalizeCheck(value: unknown): ProjectVerificationCheck | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "executable", "args", "timeoutMs"])) return undefined;
  if (!safeIdentifier(value.id, 80)) return undefined;
  if (typeof value.executable !== "string" || !EXECUTABLES.has(value.executable as ProjectVerificationExecutable)) return undefined;
  if (!Array.isArray(value.args) || value.args.length > 16) return undefined;
  if (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 1_000 || (value.timeoutMs as number) > 300_000) return undefined;

  let totalChars = 0;
  const args: string[] = [];
  for (const arg of value.args) {
    if (typeof arg !== "string" || arg.length === 0 || arg.trim().length === 0 || arg.includes("\0") || arg.length > MAX_ARGUMENT_CHARS) return undefined;
    totalChars += arg.length;
    if (totalChars > MAX_TOTAL_ARGUMENT_CHARS || FORBIDDEN_ARGUMENTS.has(arg.toLowerCase())) return undefined;
    args.push(arg);
  }

  return {
    id: value.id,
    executable: value.executable as ProjectVerificationExecutable,
    args,
    timeoutMs: value.timeoutMs as number,
  };
}

function normalizeProfile(value: unknown): ProjectVerificationProfile | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["projectId", "checks"])) return undefined;
  if (!safeIdentifier(value.projectId, 120) || !Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 8) return undefined;

  const checks: ProjectVerificationCheck[] = [];
  const ids = new Set<string>();
  for (const checkValue of value.checks) {
    const check = normalizeCheck(checkValue);
    if (check === undefined || ids.has(check.id)) return undefined;
    ids.add(check.id);
    checks.push(check);
  }
  return { projectId: value.projectId, checks };
}

function copyProfile(profile: ProjectVerificationProfile): ProjectVerificationProfile {
  return {
    projectId: profile.projectId,
    checks: profile.checks.map((check) => ({ ...check, args: [...check.args] })),
  };
}

export function createStaticProjectVerificationRegistry(profiles: unknown): ProjectVerificationRegistry {
  if (!Array.isArray(profiles)) throw new Error("invalid_project_verification_registry");

  const snapshot = new Map<string, ProjectVerificationProfile>();
  for (const value of profiles) {
    const profile = normalizeProfile(value);
    if (profile === undefined || snapshot.has(profile.projectId)) {
      throw new Error("invalid_project_verification_registry");
    }
    snapshot.set(profile.projectId, profile);
  }

  return {
    resolve(projectId) {
      if (!safeIdentifier(projectId, 120)) return undefined;
      const profile = snapshot.get(projectId);
      return profile === undefined ? undefined : copyProfile(profile);
    },
  };
}
