import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEEPSEEK_API_KEY_ENV,
  DEFAULT_LIA_CODEX_PROVIDER_MODE,
  LIA_CODEX_PROVIDER_MODE_ENV,
  buildLiaCodexExecArgs,
  isLiaCodexQuotaUsageLimitFailure,
  loadLiaCodexDeepSeekSecret,
  normalizeLiaCodexProviderMode,
  resolveLiaCodexProviderMode,
  runLiaCodexProviderAttempts,
} from "../dist/services/projectCodexProvider.js";

test("default provider mode is auto", () => {
  assert.equal(DEFAULT_LIA_CODEX_PROVIDER_MODE, "auto");
  assert.equal(normalizeLiaCodexProviderMode(undefined), "auto");
  assert.equal(normalizeLiaCodexProviderMode(""), "auto");
  assert.equal(normalizeLiaCodexProviderMode("  "), "auto");
  assert.equal(resolveLiaCodexProviderMode({}), "auto");
});

test("secret loader prefers an already-present process env value without reading any file", async () => {
  const value = await loadLiaCodexDeepSeekSecret(
    { [DEEPSEEK_API_KEY_ENV]: "sk-env-only-3a1c" },
    "/definitely/missing/env-file",
  );
  assert.equal(value, "sk-env-only-3a1c");
});

test("secret loader reads only the exact DEEPSEEK_API_KEY line from the secure env file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lia-codex-secret-"));
  try {
    const file = join(dir, ".env");
    await writeFile(file, [
      "LIA_OTHER=sk-not-the-key",
      "  DEEPSEEK_API_KEY = ignored (space before =)",
      `${DEEPSEEK_API_KEY_ENV}="sk-from-file-9f3a"`,
      "DEEPSEEK_API_KEY_EXTRA=sk-extra-suffix",
    ].join("\n"));
    assert.equal(await loadLiaCodexDeepSeekSecret({}, file), "sk-from-file-9f3a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret loader fails closed when the key is absent or empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lia-codex-secret-"));
  try {
    const file = join(dir, ".env");
    await writeFile(file, "LIA_OTHER=x\nDEEPSEEK_API_KEY=\n");
    assert.equal(await loadLiaCodexDeepSeekSecret({}, file), undefined);
    await writeFile(file, "LIA_OTHER=x\n");
    assert.equal(await loadLiaCodexDeepSeekSecret({}, file), undefined);
    assert.equal(await loadLiaCodexDeepSeekSecret({ [DEEPSEEK_API_KEY_ENV]: "   " }, file), undefined);
    assert.equal(await loadLiaCodexDeepSeekSecret({ [DEEPSEEK_API_KEY_ENV]: "" }, "/missing/file"), undefined);
    assert.equal(await loadLiaCodexDeepSeekSecret({}, "/missing/file"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit provider modes resolve strictly", () => {
  assert.equal(resolveLiaCodexProviderMode({ [LIA_CODEX_PROVIDER_MODE_ENV]: "openai" }), "openai");
  assert.equal(resolveLiaCodexProviderMode({ [LIA_CODEX_PROVIDER_MODE_ENV]: "deepseek" }), "deepseek");
  assert.equal(resolveLiaCodexProviderMode({ [LIA_CODEX_PROVIDER_MODE_ENV]: "auto" }), "auto");
  assert.equal(resolveLiaCodexProviderMode({ [LIA_CODEX_PROVIDER_MODE_ENV]: "  deepseek  " }), "deepseek");
});

test("invalid provider mode is rejected strictly", () => {
  assert.throws(() => normalizeLiaCodexProviderMode("bogus"), /invalid_lia_codex_provider_mode/);
  assert.throws(() => resolveLiaCodexProviderMode({ [LIA_CODEX_PROVIDER_MODE_ENV]: "openai/deepseek" }), /invalid_lia_codex_provider_mode/);
  assert.throws(() => resolveLiaCodexProviderMode({ [LIA_CODEX_PROVIDER_MODE_ENV]: "OpenAI" }), /invalid_lia_codex_provider_mode/);
});

test("fixed safe provider argv is explicit and never shells out", () => {
  assert.deepEqual(buildLiaCodexExecArgs({ provider: "openai", sandbox: "read-only", cwd: "/repo", prompt: "p" }), [
    "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "-c", "model_provider=openai",
    "-s", "read-only", "-C", "/repo", "p",
  ]);
  assert.deepEqual(buildLiaCodexExecArgs({ provider: "deepseek", sandbox: "workspace-write", cwd: "/wt", prompt: "p2" }), [
    "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "-c", "model_provider=deepseek",
    "-c", "model=deepseek-v4-flash",
    "-c", "model_providers.deepseek.name=DeepSeek",
    "-c", "model_providers.deepseek.base_url=https://api.deepseek.com/v1",
    "-c", "model_providers.deepseek.env_key=DEEPSEEK_API_KEY",
    "-c", "model_providers.deepseek.wire_api=responses",
    "-c", "model_providers.deepseek.requires_openai_auth=false",
    "-c", "model_providers.deepseek.supports_websockets=false",
    "-s", "workspace-write", "-C", "/wt", "p2",
  ]);
});

test("quota detection recognizes only clear usage-limit failures", () => {
  for (const output of [
    { stdout: "You've hit your usage limit", stderr: "" },
    { stdout: "Youve hit your usage limit", stderr: "" },
    { stdout: "You've reached your usage limit", stderr: "" },
    { stdout: "Error: insufficient_quota", stderr: "" },
    { stdout: "You exceeded your current quota", stderr: "" },
    { stdout: "quota exceeded for this workspace", stderr: "" },
    { stdout: "", stderr: "Your workspace credit limit has been reached" },
    { stdout: "this workspace is out of credits", stderr: "" },
    { stdout: "Error: insufficient_quota - You exceeded your current quota", stderr: "" },
  ]) assert.equal(isLiaCodexQuotaUsageLimitFailure(output), true);

  for (const output of [
    { stdout: "", stderr: "HTTP 429 Too Many Requests" },
    { stdout: "status 429", stderr: "" },
    { stdout: "Error code: 429", stderr: "" },
    { stdout: "rate limit exceeded", stderr: "" },
    { stdout: "", stderr: "Rate limit reached. Try again in 30 seconds." },
    { stdout: "rate_limit_exceeded", stderr: "" },
    { stdout: "temporarily rate limited", stderr: "" },
    { stdout: "request timed out", stderr: "" },
    { stdout: "401 Unauthorized: invalid_api_key", stderr: "" },
    { stdout: "network error: connection refused", stderr: "" },
    { stdout: "malformed json output", stderr: "" },
    { stdout: "internal error", stderr: "" },
    { stdout: "command not found", stderr: "" },
    { stdout: "1429 tokens processed", stderr: "" },
    { stdout: "", stderr: "" },
  ]) assert.equal(isLiaCodexQuotaUsageLimitFailure(output), false);
});

test("deepseek argv references only the env key name and never a key value", () => {
  const argv = buildLiaCodexExecArgs({ provider: "deepseek", sandbox: "read-only", cwd: "/repo", prompt: "p" });
  assert.equal(argv.includes("model_providers.deepseek.env_key=DEEPSEEK_API_KEY"), true);
  assert.equal(argv.includes("model_providers.deepseek.env_key=sk-test-dont-leak-9f3a"), false);
  assert.equal(argv.some((arg) => arg.includes("sk-")), false);
  assert.equal(argv.includes("wire_api=chat"), false);
  assert.equal(argv.some((arg) => arg.includes("wire_api=responses")), true);
});

const ok = { success: true, stdout: "ok", stderr: "" };
const genericFailure = { success: false, reason: "failed", stdout: "boom", stderr: "" };
const quotaFailure = { success: false, reason: "failed", stdout: "insufficient_quota", stderr: "" };
const timeoutFailure = { success: false, reason: "timeout", stdout: "", stderr: "" };
const realUsageLimitFailure = {
  success: false,
  reason: "failed",
  stdout: "Error: You've hit your usage limit. Please check your plan and billing details.",
  stderr: "",
};
const bare429Failure = { success: false, reason: "failed", stdout: "", stderr: "HTTP 429 Too Many Requests" };
const rateLimitFailure = { success: false, reason: "failed", stdout: "rate limit exceeded", stderr: "" };

test("openai mode executes only OpenAI and never falls back", async () => {
  const providers = [];
  const { result, attempts } = await runLiaCodexProviderAttempts("openai", async (provider) => {
    providers.push(provider);
    return quotaFailure;
  });
  assert.deepEqual(providers, ["openai"]);
  assert.deepEqual(attempts, ["openai"]);
  assert.equal(result, quotaFailure);
});

test("deepseek mode executes only DeepSeek and never attempts OpenAI", async () => {
  const providers = [];
  const { result, attempts } = await runLiaCodexProviderAttempts("deepseek", async (provider) => {
    providers.push(provider);
    return ok;
  });
  assert.deepEqual(providers, ["deepseek"]);
  assert.deepEqual(attempts, ["deepseek"]);
  assert.equal(result, ok);
});

test("auto + success executes OpenAI once with no DeepSeek", async () => {
  const providers = [];
  const { result, attempts } = await runLiaCodexProviderAttempts("auto", async (provider) => {
    providers.push(provider);
    return ok;
  });
  assert.deepEqual(providers, ["openai"]);
  assert.deepEqual(attempts, ["openai"]);
  assert.equal(result, ok);
});

test("auto + recognized quota failure retries DeepSeek exactly once", async () => {
  const providers = [];
  const second = { success: true, stdout: "deepseek", stderr: "" };
  const { result, attempts } = await runLiaCodexProviderAttempts("auto", async (provider) => {
    providers.push(provider);
    return providers.length === 1 ? quotaFailure : second;
  });
  assert.deepEqual(providers, ["openai", "deepseek"]);
  assert.deepEqual(attempts, ["openai", "deepseek"]);
  assert.equal(result, second);
});

test("auto + real 'You've hit your usage limit' failure retries DeepSeek exactly once", async () => {
  const providers = [];
  const second = { success: true, stdout: "deepseek", stderr: "" };
  const { result, attempts } = await runLiaCodexProviderAttempts("auto", async (provider) => {
    providers.push(provider);
    return providers.length === 1 ? realUsageLimitFailure : second;
  });
  assert.deepEqual(providers, ["openai", "deepseek"]);
  assert.deepEqual(attempts, ["openai", "deepseek"]);
  assert.equal(result, second);
});

test("auto + bare HTTP 429 does not fall back", async () => {
  const providers = [];
  const { result, attempts } = await runLiaCodexProviderAttempts("auto", async (provider) => {
    providers.push(provider);
    return bare429Failure;
  });
  assert.deepEqual(providers, ["openai"]);
  assert.deepEqual(attempts, ["openai"]);
  assert.equal(result, bare429Failure);
});

test("auto + generic rate-limit text does not fall back", async () => {
  const providers = [];
  const { result, attempts } = await runLiaCodexProviderAttempts("auto", async (provider) => {
    providers.push(provider);
    return rateLimitFailure;
  });
  assert.deepEqual(providers, ["openai"]);
  assert.deepEqual(attempts, ["openai"]);
  assert.equal(result, rateLimitFailure);
});

test("auto + generic failure does not fall back", async () => {
  const providers = [];
  const { result, attempts } = await runLiaCodexProviderAttempts("auto", async (provider) => {
    providers.push(provider);
    return genericFailure;
  });
  assert.deepEqual(providers, ["openai"]);
  assert.deepEqual(attempts, ["openai"]);
  assert.equal(result, genericFailure);
});

test("auto + timeout does not fall back", async () => {
  const providers = [];
  const { result, attempts } = await runLiaCodexProviderAttempts("auto", async (provider) => {
    providers.push(provider);
    return timeoutFailure;
  });
  assert.deepEqual(providers, ["openai"]);
  assert.deepEqual(attempts, ["openai"]);
  assert.equal(result, timeoutFailure);
});

test("auto allows at most one fallback attempt", async () => {
  const providers = [];
  const { result, attempts } = await runLiaCodexProviderAttempts("auto", async () => {
    providers.push("x");
    return quotaFailure;
  });
  assert.equal(providers.length, 2);
  assert.deepEqual(attempts, ["openai", "deepseek"]);
  assert.equal(result, quotaFailure);
});
