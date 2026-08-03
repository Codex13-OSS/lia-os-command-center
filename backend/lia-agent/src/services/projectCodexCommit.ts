import { spawn } from "node:child_process";
import type { ProjectCodexCommitError, ProjectCodexCommitResult } from "../contracts/projectCodexCommit.js";
import type { ProjectTaskRequestedCapability } from "../contracts/projectExecutor.js";
import type { ProjectCodexVerificationResult } from "./projectCodexVerification.js";
import { resolveProjectCodexWorkspace } from "./projectCodexWorkspace.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 120_000;
const FORCE_KILL_DELAY_MS = 1_000;

export interface ProjectCodexCommitProcessRequest {
  file: "git";
  args: readonly string[];
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ProjectCodexCommitProcessResult =
  | { success: true; stdout: string; stderr: string }
  | { success: false; reason: "failed" | "timeout" | "output_limit"; stdout: string; stderr: string };

export type ProjectCodexCommitProcessRunner = (
  request: ProjectCodexCommitProcessRequest,
) => Promise<ProjectCodexCommitProcessResult>;

export interface ProjectCodexCommitDependencies {
  runner?: ProjectCodexCommitProcessRunner;
}

function appendBounded(current: Buffer, chunk: Buffer, remaining: number): Buffer {
  if (remaining <= 0) return current;
  return Buffer.concat([current, chunk.subarray(0, remaining)]);
}

const runCommitProcess: ProjectCodexCommitProcessRunner = (request) => new Promise((resolveResult) => {
  const child = spawn(request.file, [...request.args], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let capturedBytes = 0;
  let failure: "timeout" | "output_limit" | undefined;
  let settled = false;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const terminate = (reason: "timeout" | "output_limit") => {
    if (failure !== undefined) return;
    failure = reason;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
    forceKillTimer.unref();
  };
  const capture = (target: "stdout" | "stderr", value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = request.maxOutputBytes - capturedBytes;
    const accepted = Math.min(remaining, chunk.length);
    if (target === "stdout") stdout = appendBounded(stdout, chunk, remaining);
    else stderr = appendBounded(stderr, chunk, remaining);
    capturedBytes += accepted;
    if (chunk.length > remaining) terminate("output_limit");
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

  const timer = setTimeout(() => terminate("timeout"), request.timeoutMs);
  timer.unref();
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    const output = { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
    if (failure !== undefined) resolveResult({ success: false, reason: failure, ...output });
    else if (code === 0) resolveResult({ success: true, ...output });
    else resolveResult({ success: false, reason: "failed", ...output });
  };
  child.once("error", () => finish(null));
  child.once("close", finish);
});

function failed(executionId: string, error: ProjectCodexCommitError): ProjectCodexCommitResult {
  const summaries: Record<ProjectCodexCommitError, string> = {
    local_commit_not_approved: "Local commit was not approved.",
    workspace_not_verified: "The retained workspace has not been verified.",
    invalid_generated_path: "The retained workspace could not be resolved safely.",
    nothing_to_commit: "The verified workspace has no changes to commit.",
    git_status_failed: "The verified workspace status could not be inspected.",
    git_stage_failed: "The verified workspace changes could not be staged.",
    git_commit_failed: "The local commit could not be created.",
    git_revision_failed: "The local commit revision could not be validated.",
  };
  return { success: false, executionId, status: "commit_failed", error, summary: summaries[error] };
}

export async function commitVerifiedProjectCodexWorkspace(
  repositoryRoot: string,
  executionId: string,
  approvedCapabilities: readonly ProjectTaskRequestedCapability[],
  verificationResult: ProjectCodexVerificationResult,
  dependencies: ProjectCodexCommitDependencies = {},
): Promise<ProjectCodexCommitResult> {
  void repositoryRoot;
  if (!approvedCapabilities.includes("local_commit")) return failed(executionId, "local_commit_not_approved");
  if (!verificationResult.success || verificationResult.status !== "verified" || verificationResult.executionId !== executionId) {
    return failed(executionId, "workspace_not_verified");
  }

  const workspace = resolveProjectCodexWorkspace(executionId);
  if (!workspace.success) return failed(executionId, "invalid_generated_path");

  const runner = dependencies.runner ?? runCommitProcess;
  const run = (args: readonly string[]) => runner({
    file: "git",
    args,
    shell: false,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });

  let stage: "status" | "add" | "commit" | "revision" = "status";
  try {
    const status = await run(["-C", workspace.worktreePath, "status", "--porcelain"]);
    if (!status.success) return failed(executionId, "git_status_failed");
    if (status.stdout.length === 0) return failed(executionId, "nothing_to_commit");

    stage = "add";
    const staged = await run(["-C", workspace.worktreePath, "add", "-A"]);
    if (!staged.success) return failed(executionId, "git_stage_failed");

    stage = "commit";
    const committed = await run([
      "-C", workspace.worktreePath, "commit", "-m", `lia: complete isolated task ${executionId}`,
    ]);
    if (!committed.success) return failed(executionId, "git_commit_failed");

    stage = "revision";
    const revision = await run(["-C", workspace.worktreePath, "rev-parse", "HEAD"]);
    if (!revision.success) return failed(executionId, "git_revision_failed");
    const commit = revision.stdout.trim();
    if (!/^[0-9a-fA-F]{40,64}$/.test(commit)) return failed(executionId, "git_revision_failed");

    return {
      success: true,
      executionId,
      status: "committed",
      commit,
      summary: "The verified workspace was committed locally.",
    };
  } catch {
    return failed(executionId, stage === "status"
      ? "git_status_failed"
      : stage === "add"
        ? "git_stage_failed"
        : stage === "commit"
          ? "git_commit_failed"
          : "git_revision_failed");
  }
}
