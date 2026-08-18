import type { ProjectCodexProcessResult } from "./projectCodexExecutor.js";
import { readFile } from "node:fs/promises";

/** Concrete model providers the executor may invoke. */
export type LiaCodexProvider = "openai" | "deepseek";

/** Executor provider routing modes. */
export type LiaCodexProviderMode = LiaCodexProvider | "auto";

export const LIA_CODEX_PROVIDER_MODE_ENV = "LIA_CODEX_PROVIDER_MODE";
export const DEFAULT_LIA_CODEX_PROVIDER_MODE: LiaCodexProviderMode = "auto";

export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
export const LIA_CODEX_DEEPSEEK_ENV_FILE = "/home/hermes-agent/.hermes/.env";

/** Resolves the DeepSeek secret only when the executor is about to invoke DeepSeek. */
export type LiaCodexDeepSeekSecretLoader = () => Promise<string | undefined>;

const LIA_CODEX_PROVIDER_MODES: ReadonlySet<string> = new Set([
  "openai",
  "deepseek",
  "auto",
]);

export function isLiaCodexProviderMode(value: string): value is LiaCodexProviderMode {
  return LIA_CODEX_PROVIDER_MODES.has(value);
}

/** Strict validation with default auto. Unset or empty defaults; anything else must be exact. */
export function normalizeLiaCodexProviderMode(value: string | undefined): LiaCodexProviderMode {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_LIA_CODEX_PROVIDER_MODE;
  }
  const candidate = value.trim();
  if (!isLiaCodexProviderMode(candidate)) {
    throw new Error("invalid_lia_codex_provider_mode");
  }
  return candidate;
}

export function resolveLiaCodexProviderMode(
  env: NodeJS.ProcessEnv = process.env,
): LiaCodexProviderMode {
  return normalizeLiaCodexProviderMode(env[LIA_CODEX_PROVIDER_MODE_ENV]);
}

/**
 * Execution-time DeepSeek secret resolution. Prefers DEEPSEEK_API_KEY already
 * present in the given environment; otherwise reads the secure env file and
 * parses only the exact DEEPSEEK_API_KEY= line. Returns undefined (fail closed)
 * when the key is absent or empty. The value is never logged, placed in argv,
 * written to source, or exposed through public contracts.
 */
export async function loadLiaCodexDeepSeekSecret(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = LIA_CODEX_DEEPSEEK_ENV_FILE,
): Promise<string | undefined> {
  const fromEnv = env[DEEPSEEK_API_KEY_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  let content: string;
  try {
    content = await readFile(envFilePath, "utf8");
  } catch {
    return undefined;
  }
  const prefix = `${DEEPSEEK_API_KEY_ENV}=`;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) continue;
    let value = line.slice(prefix.length).trim();
    if (
      value.length >= 2
      && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value === "" ? undefined : value;
  }
  return undefined;
}

/**
 * Explicit provider argv applied after --ignore-user-config, which disables
 * config-file provider selection. Only the DEEPSEEK_API_KEY environment
 * variable NAME is referenced; the key value is never read or placed in argv.
 */
const LIA_CODEX_PROVIDER_ARGV: Readonly<Record<LiaCodexProvider, readonly string[]>> = {
  openai: ["-c", "model_provider=openai"],
  deepseek: [
    "-c", "model_provider=deepseek",
    "-c", "model=deepseek-v4-flash",
    "-c", "model_providers.deepseek.name=DeepSeek",
    "-c", "model_providers.deepseek.base_url=https://api.deepseek.com/v1",
    "-c", "model_providers.deepseek.env_key=DEEPSEEK_API_KEY",
    "-c", "model_providers.deepseek.wire_api=responses",
    "-c", "model_providers.deepseek.requires_openai_auth=false",
    "-c", "model_providers.deepseek.supports_websockets=false",
  ],
};

/**
 * Fixed safe Codex argv for one provider. The provider is explicit on the command
 * line because --ignore-user-config disables config-file provider selection.
 */
export function buildLiaCodexExecArgs(options: {
  provider: LiaCodexProvider;
  sandbox: "read-only" | "workspace-write";
  cwd: string;
  prompt: string;
}): readonly string[] {
  return [
    "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    ...LIA_CODEX_PROVIDER_ARGV[options.provider],
    "-s", options.sandbox, "-C", options.cwd, options.prompt,
  ];
}

const QUOTA_USAGE_LIMIT_MARKERS: readonly string[] = [
  "you've hit your usage limit",
  "youve hit your usage limit",
  "you've reached your usage limit",
  "insufficient_quota",
  "exceeded your current quota",
  "quota exceeded",
  "workspace credit limit",
  "workspace is out of credits",
];

/**
 * Recognizes only unmistakable exhausted-account or quota conditions. Bare
 * HTTP 429, generic rate-limit text, timeouts, auth and network errors are
 * intentionally NOT fallback triggers.
 */
export function isLiaCodexQuotaUsageLimitFailure(
  result: Pick<ProjectCodexProcessResult, "stdout" | "stderr">,
): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return QUOTA_USAGE_LIMIT_MARKERS.some((marker) => output.includes(marker));
}

export interface LiaCodexProviderAttemptsResult {
  result: ProjectCodexProcessResult;
  /** Providers actually invoked, in order. At most two entries and at most one fallback. */
  attempts: readonly LiaCodexProvider[];
}

/**
 * Runs Codex per the provider mode. Only auto mode may fall back, only on a clearly
 * recognized quota or usage-limit failure, and only to DeepSeek exactly once.
 */
export async function runLiaCodexProviderAttempts(
  mode: LiaCodexProviderMode,
  run: (provider: LiaCodexProvider) => Promise<ProjectCodexProcessResult>,
): Promise<LiaCodexProviderAttemptsResult> {
  const primary: LiaCodexProvider = mode === "deepseek" ? "deepseek" : "openai";
  const fallback: LiaCodexProvider | undefined = mode === "auto" ? "deepseek" : undefined;

  const first = await run(primary);
  if (
    first.success
    || fallback === undefined
    || first.reason === "timeout"
    || !isLiaCodexQuotaUsageLimitFailure(first)
  ) {
    return { result: first, attempts: [primary] };
  }

  const second = await run(fallback);
  return { result: second, attempts: [primary, fallback] };
}
