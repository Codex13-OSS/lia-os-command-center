import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ProjectCodexHandoff } from "../contracts/projectCodexHandoff.js";
import type {
  ProjectCodexExecutionError,
  ProjectCodexExecutionResult,
} from "../contracts/projectCodexExecution.js";
import {
  PROJECT_CODEX_WORKTREE_ROOT,
  discardProjectCodexWorkspace,
  resolveProjectCodexWorkspace,
} from "./projectCodexWorkspace.js";

export { PROJECT_CODEX_WORKTREE_ROOT } from "./projectCodexWorkspace.js";
export const PROJECT_CODEX_MAX_PROMPT_CHARS = 16_000;
export const PROJECT_CODEX_MAX_OUTPUT_BYTES = 64 * 1024;
export const PROJECT_CODEX_TIMEOUT_MS = 10 * 60 * 1000;

export interface ProjectCodexProcessRequest {
  file: "git" | "codex";
  args: readonly string[];
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ProjectCodexProcessResult =
  | { success: true; stdout: string; stderr: string }
  | { success: false; reason: "failed" | "timeout"; stdout: string; stderr: string };

export type ProjectCodexProcessRunner = (
  request: ProjectCodexProcessRequest,
) => Promise<ProjectCodexProcessResult>;

export interface ProjectCodexExecutorDependencies {
  gitRunner?: ProjectCodexProcessRunner;
  codexRunner?: ProjectCodexProcessRunner;
  executionIdFactory?: () => string;
  ensureWorktreeRoot?: () => Promise<void>;
  timeoutMs?: number;
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (current.length >= limit) return current;
  return Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
}

export const runProjectCodexProcess: ProjectCodexProcessRunner = (request) =>
  new Promise((resolveResult) => {
    const child = spawn(request.file, [...request.args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: ProjectCodexProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resolveResult(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, request.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, request.maxOutputBytes);
    });
    child.on("error", () => finish({
      success: false,
      reason: timedOut ? "timeout" : "failed",
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
    }));
    child.on("close", (code) => {
      if (timedOut) {
        finish({
          success: false,
          reason: "timeout",
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        });
        return;
      }
      finish({
        success: code === 0,
        ...(code === 0 ? {} : { reason: "failed" as const }),
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      } as ProjectCodexProcessResult);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKillTimer.unref();
    }, request.timeoutMs);
    timer.unref();
  });

function buildPrompt(handoff: ProjectCodexHandoff): string {
  const capabilities = handoff.approvedCapabilities.join(", ");
  const steps = handoff.proposal.steps.map((step, index) =>
    `${index + 1}. ${step.title}\nObjective: ${step.objective}\nRequired capabilities: ${step.requiredCapabilities.join(", ")}`,
  ).join("\n\n");
  return [
    `Project: ${handoff.projectDisplayName} (${handoff.projectId})`,
    `Approved capabilities: ${capabilities}`,
    `Instruction:\n${handoff.instruction}`,
    `Approved proposal summary:\n${handoff.proposal.summary}`,
    `Approved proposal steps:\n${steps}`,
  ].join("\n\n");
}

function failed(
  executionId: string,
  error: ProjectCodexExecutionError,
): ProjectCodexExecutionResult {
  return { success: false, executionId, status: "failed", error, summary: "Codex execution did not complete." };
}

export async function executeProjectCodexHandoff(
  handoff: ProjectCodexHandoff,
  dependencies: ProjectCodexExecutorDependencies = {},
): Promise<ProjectCodexExecutionResult> {
  let executionId: string;
  try {
    executionId = (dependencies.executionIdFactory ?? randomUUID)();
  } catch {
    return failed("unavailable", "invalid_generated_path");
  }
  if (!handoff.approvedCapabilities.includes("repository_read")) {
    return failed(executionId, "missing_repository_read");
  }
  if (!handoff.approvedCapabilities.includes("isolated_worktree_write")) {
    return failed(executionId, "missing_isolated_worktree_write");
  }

  const prompt = buildPrompt(handoff);
  if (prompt.length > PROJECT_CODEX_MAX_PROMPT_CHARS) {
    return failed(executionId, "prompt_too_large");
  }
  const workspace = resolveProjectCodexWorkspace(executionId);
  if (!workspace.success) {
    return failed("invalid-execution-id", "invalid_generated_path");
  }
  const { worktreePath, branch } = workspace;
  const gitRunner = dependencies.gitRunner ?? runProjectCodexProcess;
  const codexRunner = dependencies.codexRunner ?? runProjectCodexProcess;
  const timeoutMs = dependencies.timeoutMs ?? PROJECT_CODEX_TIMEOUT_MS;
  const processOptions = { shell: false as const, timeoutMs, maxOutputBytes: PROJECT_CODEX_MAX_OUTPUT_BYTES };
  let result: ProjectCodexExecutionResult | undefined;
  let worktreeAttempted = false;

  try {
    await (dependencies.ensureWorktreeRoot ?? (() => mkdir(PROJECT_CODEX_WORKTREE_ROOT, { recursive: true })))();
  } catch {
    return failed(executionId, "worktree_create_failed");
  }
  let stage: "create" | "execute" = "create";
  try {
    worktreeAttempted = true;
    const added = await gitRunner({
      file: "git",
      args: ["-C", handoff.repositoryRoot, "worktree", "add", "-b", branch, worktreePath, "HEAD"],
      ...processOptions,
    });
    if (!added.success) {
      result = failed(executionId, added.reason === "timeout" ? "timeout" : "worktree_create_failed");
    } else {
      stage = "execute";
      const executed = await codexRunner({
        file: "codex",
        args: [
          "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
          "-s", "workspace-write", "-C", worktreePath, prompt,
        ],
        ...processOptions,
      });
      result = executed.success
        ? { success: true, executionId, status: "completed", summary: "Codex execution completed in an isolated worktree." }
        : failed(executionId, executed.reason === "timeout" ? "timeout" : "codex_execution_failed");
    }
  } catch {
    result = failed(executionId, stage === "create" ? "worktree_create_failed" : "codex_execution_failed");
  } finally {
    if (worktreeAttempted && !result?.success) {
      const cleaned = await discardProjectCodexWorkspace(handoff.repositoryRoot, executionId, {
        gitRunner,
        timeoutMs,
      });
      if (!cleaned.success) {
        result = failed(executionId, "worktree_cleanup_failed");
      }
    }
  }
  return result ?? failed(executionId, "codex_execution_failed");
}
