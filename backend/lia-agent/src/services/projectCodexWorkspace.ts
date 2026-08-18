import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { lstat, opendir, readlink, realpath, symlink, unlink } from "node:fs/promises";

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

export interface ProjectCodexDependencyHydrationRequest {
  sourceRoot: string;
  worktreeRoot: string;
}

export type ProjectCodexDependencyHydrator = (
  request: ProjectCodexDependencyHydrationRequest,
) => Promise<void>;

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Hydrates trusted repository dependency mappings and rolls back its own links on failure. */
export const hydrateProjectCodexNodeModules: ProjectCodexDependencyHydrator = async ({
  sourceRoot,
  worktreeRoot,
}) => {
  const sourceCanonical = await realpath(sourceRoot);
  const worktreeCanonical = await realpath(worktreeRoot);
  const candidates: string[] = [];
  const created: Array<{ destination: string; target: string }> = [];

  const discover = async (directory: string): Promise<void> => {
    if (!isContained(sourceCanonical, directory)) throw new Error("unsafe dependency discovery path");
    const directoryResolved = await realpath(directory);
    if (!isContained(sourceCanonical, directoryResolved) || !(await lstat(directory)).isDirectory()) {
      throw new Error("unsafe dependency discovery path");
    }
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const candidate = resolve(directory, entry.name);
      if (!isContained(sourceCanonical, candidate)) throw new Error("unsafe dependency candidate path");
      if (entry.name === "node_modules") {
        candidates.push(candidate);
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const candidateStat = await lstat(candidate);
        if (candidateStat.isDirectory() && !candidateStat.isSymbolicLink()) await discover(candidate);
      }
    }
  };

  try {
    await discover(sourceCanonical);
    candidates.sort();
    for (const source of candidates) {
      const sourceRelative = relative(sourceCanonical, source);
      if (!sourceRelative || isAbsolute(sourceRelative) || sourceRelative.split(/[\\/]/u).some((part) => !part || part === "..")) {
        throw new Error("unsafe dependency relative path");
      }
      const sourceStat = await lstat(source);
      let sourceResolved: string;
      if (sourceStat.isSymbolicLink()) {
        // Inspect the repository-owned mapping itself before resolving its target.
        await readlink(source);
        sourceResolved = await realpath(source);
        if (basename(sourceResolved) !== "node_modules" || !(await lstat(sourceResolved)).isDirectory()) {
          throw new Error("unsafe dependency source");
        }
      } else {
        sourceResolved = await realpath(source);
        if (!sourceStat.isDirectory() || !isContained(sourceCanonical, sourceResolved)
          || !(await lstat(sourceResolved)).isDirectory()) {
          throw new Error("unsafe dependency source");
        }
      }

      const destination = resolve(worktreeCanonical, sourceRelative);
      if (!isContained(worktreeCanonical, destination)) throw new Error("unsafe dependency destination");
      const destinationParent = resolve(destination, "..");
      if (!(await pathExists(destinationParent))) continue;
      const parentResolved = await realpath(destinationParent);
      if (!isContained(worktreeCanonical, parentResolved) || !(await lstat(parentResolved)).isDirectory()) {
        throw new Error("unsafe dependency parent");
      }
      if (await pathExists(destination)) throw new Error("dependency destination already exists");

      // Preserve the repository-owned entry as the trust anchor for external mappings.
      const relativeTarget = relative(destinationParent, source);
      await symlink(relativeTarget, destination, "dir");
      created.push({ destination, target: relativeTarget });
    }
  } catch (error) {
    for (const { destination, target } of created.reverse()) {
      try {
        if (isContained(worktreeCanonical, destination)
          && (await lstat(destination)).isSymbolicLink()
          && (await readlink(destination)) === target) {
          await unlink(destination);
        }
      } catch {
        // The enclosing worktree cleanup remains authoritative if rollback is incomplete.
      }
    }
    throw error;
  }
};

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
