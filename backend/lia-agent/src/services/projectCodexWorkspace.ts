import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

export const PROJECT_CODEX_WORKTREE_ROOT = "/tmp/lia-project-executor-runs";
const PROJECT_CODEX_WORKSPACE_MAX_OUTPUT_BYTES = 64 * 1024;
const PROJECT_CODEX_WORKSPACE_TIMEOUT_MS = 10 * 60 * 1000;

interface ProjectCodexWorkspaceProcessRequest {
  file: "git" | "codex";
  args: readonly string[];
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

type ProjectCodexWorkspaceProcessResult =
  | { success: true; stdout: string; stderr: string }
  | { success: false; reason: "failed" | "timeout"; stdout: string; stderr: string };

type ProjectCodexWorkspaceProcessRunner = (
  request: ProjectCodexWorkspaceProcessRequest,
) => Promise<ProjectCodexWorkspaceProcessResult>;

export type ProjectCodexWorkspaceResolution =
  | { success: true; executionId: string; worktreePath: string; branch: string }
  | { success: false; executionId: string; error: "invalid_generated_path" };

export type ProjectCodexWorkspaceDiscardResult =
  | { success: true; executionId: string; status: "discarded" }
  | { success: false; executionId: string; status: "failed"; error: "workspace_discard_failed" | "invalid_generated_path" };

export interface ProjectCodexWorkspaceDependencies {
  gitRunner?: ProjectCodexWorkspaceProcessRunner;
  timeoutMs?: number;
}

const runWorkspaceGit: ProjectCodexWorkspaceProcessRunner = (request) => new Promise((resolveResult) => {
  const child = spawn(request.file, [...request.args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let settled = false;
  let timedOut = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout;
  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    resolveResult(success
      ? { success: true, stdout: "", stderr: "" }
      : { success: false, reason: timedOut ? "timeout" : "failed", stdout: "", stderr: "" });
  };
  child.stdout.resume();
  child.stderr.resume();
  child.on("error", () => finish(false));
  child.on("close", (code) => finish(!timedOut && code === 0));
  timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    forceKillTimer.unref();
  }, request.timeoutMs);
  timer.unref();
});

export function resolveProjectCodexWorkspace(executionId: string): ProjectCodexWorkspaceResolution {
  if (!/^[A-Za-z0-9-]+$/.test(executionId)) {
    return { success: false, executionId, error: "invalid_generated_path" };
  }

  const worktreePath = resolve(PROJECT_CODEX_WORKTREE_ROOT, executionId);
  const relativePath = relative(PROJECT_CODEX_WORKTREE_ROOT, worktreePath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { success: false, executionId, error: "invalid_generated_path" };
  }

  return {
    success: true,
    executionId,
    worktreePath,
    branch: `lia/executor/${executionId}`,
  };
}

export async function discardProjectCodexWorkspace(
  repositoryRoot: string,
  executionId: string,
  dependencies: ProjectCodexWorkspaceDependencies = {},
): Promise<ProjectCodexWorkspaceDiscardResult> {
  const workspace = resolveProjectCodexWorkspace(executionId);
  if (!workspace.success) {
    return { success: false, executionId, status: "failed", error: "invalid_generated_path" };
  }

  try {
    const discarded = await (dependencies.gitRunner ?? runWorkspaceGit)({
      file: "git",
      args: ["-C", repositoryRoot, "worktree", "remove", "--force", workspace.worktreePath],
      shell: false,
      timeoutMs: dependencies.timeoutMs ?? PROJECT_CODEX_WORKSPACE_TIMEOUT_MS,
      maxOutputBytes: PROJECT_CODEX_WORKSPACE_MAX_OUTPUT_BYTES,
    });
    if (!discarded.success) {
      return { success: false, executionId, status: "failed", error: "workspace_discard_failed" };
    }
    return { success: true, executionId, status: "discarded" };
  } catch {
    return { success: false, executionId, status: "failed", error: "workspace_discard_failed" };
  }
}
