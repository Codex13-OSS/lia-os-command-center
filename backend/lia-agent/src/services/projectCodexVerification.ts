import { spawn } from "node:child_process";
import type { ProjectVerificationExecutable, ProjectVerificationRegistry } from "../contracts/projectVerification.js";
import { resolveProjectCodexWorkspace } from "./projectCodexWorkspace.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export interface ProjectCodexVerificationProcessRequest {
  file: ProjectVerificationExecutable;
  args: readonly string[];
  cwd: string;
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ProjectCodexVerificationProcessResult =
  | { success: true; stdout?: string; stderr?: string }
  | { success: false; reason: "failed" | "timeout" | "output_limit"; stdout?: string; stderr?: string };

export type ProjectCodexVerificationProcessRunner = (
  request: ProjectCodexVerificationProcessRequest,
) => Promise<ProjectCodexVerificationProcessResult>;

export interface ProjectCodexVerificationDependencies {
  runner?: ProjectCodexVerificationProcessRunner;
}

export type ProjectCodexVerificationResult =
  | {
    success: true;
    executionId: string;
    status: "verified";
    checksPassed: number;
    totalChecks: number;
    summary: string;
  }
  | {
    success: false;
    executionId: string;
    status: "verification_failed";
    error: "check_failed" | "check_timeout" | "verification_unavailable" | "invalid_generated_path";
    failedCheckId?: string;
    checksPassed: number;
    totalChecks: number;
    summary: string;
  };

const runVerificationProcess: ProjectCodexVerificationProcessRunner = (request) => new Promise((resolveResult) => {
  const child = spawn(request.file, [...request.args], {
    cwd: request.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputBytes = 0;
  let reason: "failed" | "timeout" | "output_limit" | undefined;
  let settled = false;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const terminate = (failure: "timeout" | "output_limit") => {
    if (reason !== undefined) return;
    reason = failure;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
    forceKillTimer.unref();
  };
  const countOutput = (chunk: Buffer | string) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > request.maxOutputBytes) terminate("output_limit");
  };
  child.stdout.on("data", countOutput);
  child.stderr.on("data", countOutput);

  const timer = setTimeout(() => terminate("timeout"), request.timeoutMs);
  timer.unref();
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if (reason !== undefined) resolveResult({ success: false, reason });
    else if (code === 0) resolveResult({ success: true });
    else resolveResult({ success: false, reason: "failed" });
  };
  child.once("error", () => finish(null));
  child.once("close", finish);
});

function failure(
  executionId: string,
  error: "check_failed" | "check_timeout" | "verification_unavailable" | "invalid_generated_path",
  checksPassed: number,
  totalChecks: number,
  failedCheckId?: string,
): ProjectCodexVerificationResult {
  return {
    success: false,
    executionId,
    status: "verification_failed",
    error,
    ...(failedCheckId === undefined ? {} : { failedCheckId }),
    checksPassed,
    totalChecks,
    summary: error === "verification_unavailable"
      ? "Verification is not available for this project."
      : error === "invalid_generated_path"
        ? "The retained workspace could not be resolved safely."
        : error === "check_timeout"
          ? "A preauthorized verification check timed out."
          : "A preauthorized verification check failed.",
  };
}

export async function verifyProjectCodexWorkspace(
  repositoryRoot: string,
  projectId: string,
  executionId: string,
  verificationRegistry: ProjectVerificationRegistry,
  dependencies: ProjectCodexVerificationDependencies = {},
): Promise<ProjectCodexVerificationResult> {
  void repositoryRoot;
  const workspace = resolveProjectCodexWorkspace(executionId);
  if (!workspace.success) return failure(executionId, "invalid_generated_path", 0, 0);

  let profile;
  try {
    profile = verificationRegistry.resolve(projectId);
  } catch {
    return failure(executionId, "verification_unavailable", 0, 0);
  }
  if (profile === undefined) return failure(executionId, "verification_unavailable", 0, 0);

  const runner = dependencies.runner ?? runVerificationProcess;
  let checksPassed = 0;
  for (const check of profile.checks) {
    let result: ProjectCodexVerificationProcessResult;
    try {
      result = await runner({
        file: check.executable,
        args: [...check.args],
        cwd: workspace.worktreePath,
        shell: false,
        timeoutMs: check.timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch {
      return failure(executionId, "verification_unavailable", checksPassed, profile.checks.length, check.id);
    }
    if (!result.success) {
      return failure(
        executionId,
        result.reason === "timeout" ? "check_timeout" : "check_failed",
        checksPassed,
        profile.checks.length,
        check.id,
      );
    }
    checksPassed += 1;
  }

  return {
    success: true,
    executionId,
    status: "verified",
    checksPassed,
    totalChecks: profile.checks.length,
    summary: "All preauthorized verification checks passed.",
  };
}
