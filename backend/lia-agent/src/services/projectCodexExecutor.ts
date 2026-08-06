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
  hydrateProjectCodexNodeModules,
  resolveProjectCodexWorkspace,
  type ProjectCodexDependencyHydrator,
} from "./projectCodexWorkspace.js";
import {
  buildLiaCodexExecArgs,
  DEEPSEEK_API_KEY_ENV,
  loadLiaCodexDeepSeekSecret,
  normalizeLiaCodexProviderMode,
  resolveLiaCodexProviderMode,
  runLiaCodexProviderAttempts,
  type LiaCodexDeepSeekSecretLoader,
  type LiaCodexProvider,
  type LiaCodexProviderMode,
} from "./projectCodexProvider.js";

export { PROJECT_CODEX_WORKTREE_ROOT } from "./projectCodexWorkspace.js";
export const PROJECT_CODEX_MAX_PROMPT_CHARS = 16_000;
export const PROJECT_CODEX_MAX_OUTPUT_BYTES = 64 * 1024;
export const PROJECT_CODEX_MAX_RESULT_CHARS = 6_000;
export const PROJECT_CODEX_TIMEOUT_MS = 20 * 60 * 1000;

export interface ProjectCodexProcessRequest {
  file: "git" | "codex";
  args: readonly string[];
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Optional explicit child environment; defaults to inheriting the parent process env. */
  env?: NodeJS.ProcessEnv;
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
  hydrateDependencies?: ProjectCodexDependencyHydrator;
  timeoutMs?: number;
  /** Explicit routing override; defaults to LIA_CODEX_PROVIDER_MODE (auto). */
  providerMode?: LiaCodexProviderMode;
  /**
   * Execution-time DeepSeek secret loader. Defaults to the secure loader that
   * checks process.env and then the protected env file; only invoked when the
   * executor is about to run DeepSeek. Injected in tests so no real secret is
   * ever required.
   */
  deepSeekSecretLoader?: LiaCodexDeepSeekSecretLoader;
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
      ...(request.env === undefined ? {} : { env: request.env }),
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
  const capabilities = handoff.effectiveCapabilities.join(", ");
  const steps = handoff.proposal.steps.map((step, index) =>
    `${index + 1}. ${step.title}\nObjective: ${step.objective}\nRequired capabilities: ${step.requiredCapabilities.join(", ")}`,
  ).join("\n\n");
  return [
    `Project: ${handoff.projectDisplayName} (${handoff.projectId})`,
    `Effective capabilities: ${capabilities}`,
    `Instruction:\n${handoff.instruction}`,
    `Approved proposal summary:\n${handoff.proposal.summary}`,
    `Approved proposal steps:\n${steps}`,
  ].join("\n\n");
}

/** Convert Codex's final stdout into bounded display text without process transcripts. */
export function sanitizeProjectCodexResult(value: string): string {
  const normalized = value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:stderr:|stdout:|env(?:ironment)?:|command:|cmd:|\$\s|>\s*(?:git|npm|node|codex)\b)/i.test(line))
    .join("\n")
    // Redact absolute Unix paths even when immediately preceded by common
    // punctuation (whitespace, "(", "=", quotes, brackets, separators).
    // ":" is intentionally excluded so prose URLs like https://example.com
    // survive; only absolute filesystem paths are removed.
    .replace(/(^|[\s(=,;<>\[\]{}"'!?])\/(?:[^\s)]+\/)*[^\s),.;]*/g, "$1[ruta omitida]")
    .trim().replace(/\n{3,}/g, "\n\n");
  return normalized.slice(0, PROJECT_CODEX_MAX_RESULT_CHARS)
    || "Análisis completado sin observaciones adicionales.";
}

interface LiaCodexProviderAttemptContext {
  sandbox: "read-only" | "workspace-write";
  cwd: string;
  prompt: string;
}

/**
 * Runs one Codex provider attempt. DeepSeek loads its secret here, at
 * execution time only, and receives it through the child process environment
 * without mutating the global process.env or placing the value in argv.
 */
async function runLiaCodexProviderAttempt(
  provider: LiaCodexProvider,
  context: LiaCodexProviderAttemptContext,
  dependencies: {
    codexRunner: ProjectCodexProcessRunner;
    deepSeekSecretLoader: LiaCodexDeepSeekSecretLoader;
    processOptions: Pick<ProjectCodexProcessRequest, "shell" | "timeoutMs" | "maxOutputBytes">;
  },
): Promise<ProjectCodexProcessResult> {
  let env: NodeJS.ProcessEnv | undefined;
  if (provider === "deepseek") {
    const secret = await dependencies.deepSeekSecretLoader();
    if (secret === undefined || secret.trim() === "") {
      return { success: false, reason: "failed", stdout: "", stderr: "" };
    }
    env = { ...process.env, [DEEPSEEK_API_KEY_ENV]: secret };
  }
  return dependencies.codexRunner({
    file: "codex",
    args: buildLiaCodexExecArgs({
      provider,
      sandbox: context.sandbox,
      cwd: context.cwd,
      prompt: context.prompt,
    }),
    ...dependencies.processOptions,
    ...(env === undefined ? {} : { env }),
  });
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
  if (!handoff.effectiveCapabilities.includes("repository_read")) {
    return failed(executionId, "missing_repository_read");
  }
  // Capability-boundary invariant: effectiveCapabilities MUST remain a subset
  // of the LÍA-approved ceiling. A violation means the binding set contains a
  // capability LÍA never authorized, so this is an authorization failure, not
  // a missing read. Fail closed with the existing capability-authorization
  // error contract (missing_isolated_worktree_write) rather than the
  // misleading missing_repository_read.
  if (handoff.effectiveCapabilities.some((capability) => !handoff.approvedCapabilities.includes(capability))) {
    return failed(executionId, "missing_isolated_worktree_write");
  }

  const prompt = buildPrompt(handoff);
  if (prompt.length > PROJECT_CODEX_MAX_PROMPT_CHARS) {
    return failed(executionId, "prompt_too_large");
  }
  let providerMode: LiaCodexProviderMode;
  try {
    providerMode = dependencies.providerMode === undefined
      ? resolveLiaCodexProviderMode()
      : normalizeLiaCodexProviderMode(dependencies.providerMode);
  } catch {
    return failed(executionId, "codex_execution_failed");
  }
  const workspace = resolveProjectCodexWorkspace(executionId);
  if (!workspace.success) {
    return failed("invalid-execution-id", "invalid_generated_path");
  }
  const { worktreePath, branch } = workspace;
  const gitRunner = dependencies.gitRunner ?? runProjectCodexProcess;
  const codexRunner = dependencies.codexRunner ?? runProjectCodexProcess;
  const deepSeekSecretLoader = dependencies.deepSeekSecretLoader ?? loadLiaCodexDeepSeekSecret;
  const timeoutMs = dependencies.timeoutMs ?? PROJECT_CODEX_TIMEOUT_MS;
  const processOptions = { shell: false as const, timeoutMs, maxOutputBytes: PROJECT_CODEX_MAX_OUTPUT_BYTES };
  const mayWrite = handoff.effectiveCapabilities.includes("isolated_worktree_write");
  if (!mayWrite) {
    try {
      const executed = await runLiaCodexProviderAttempts(providerMode, (provider) =>
        runLiaCodexProviderAttempt(provider, {
          sandbox: "read-only",
          cwd: handoff.repositoryRoot,
          prompt,
        }, { codexRunner, deepSeekSecretLoader, processOptions }));
      return executed.result.success
        ? {
            success: true, executionId, status: "completed",
            summary: "Codex analysis completed.",
            resultText: sanitizeProjectCodexResult(executed.result.stdout),
            outcome: "analysis_completed",
          }
        : failed(executionId, executed.result.reason === "timeout" ? "timeout" : "codex_execution_failed");
    } catch {
      return failed(executionId, "codex_execution_failed");
    }
  }
  let result: ProjectCodexExecutionResult | undefined;
  let worktreeAttempted = false;

  try {
    await (dependencies.ensureWorktreeRoot ?? (() => mkdir(PROJECT_CODEX_WORKTREE_ROOT, { recursive: true })))();
  } catch {
    return failed(executionId, "worktree_create_failed");
  }
  let stage: "create" | "hydrate" | "execute" = "create";
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
      stage = "hydrate";
      await (dependencies.hydrateDependencies ?? hydrateProjectCodexNodeModules)({
        sourceRoot: handoff.repositoryRoot,
        worktreeRoot: worktreePath,
      });
      stage = "execute";
      const executed = await runLiaCodexProviderAttempts(providerMode, (provider) =>
        runLiaCodexProviderAttempt(provider, {
          sandbox: "workspace-write",
          cwd: worktreePath,
          prompt,
        }, { codexRunner, deepSeekSecretLoader, processOptions }));
      result = executed.result.success
        ? {
            success: true, executionId, status: "completed",
            summary: "Codex execution completed in an isolated worktree.",
            resultText: sanitizeProjectCodexResult(executed.result.stdout),
            outcome: "modification_completed",
          }
        : failed(executionId, executed.result.reason === "timeout" ? "timeout" : "codex_execution_failed");
    }
  } catch {
    result = failed(executionId, stage === "execute" ? "codex_execution_failed" : "worktree_create_failed");
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
