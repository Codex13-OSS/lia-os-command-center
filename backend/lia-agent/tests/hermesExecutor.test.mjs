import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHermesQuery } from "../dist/services/hermesExecutor.js";
import {
  HERMES_DEEPSEEK_ENV_FILE,
  isHermesQuotaUsageLimitFailure,
  loadHermesDeepSeekSecret,
} from "../dist/services/hermesDeepSeekFallback.js";

const SECRET = "sk-test-dont-leak-9f3a7c";
const QUERY = "implement the approved task";
const REAL_QUOTA_PHRASE = "API call failed after 3 retries: HTTP 429: The usage limit has been reached";

const config = (overrides = {}) => ({
  host: "127.0.0.1", port: 3014, corsOrigins: [], agendaSqlitePath: "", projectRegistryPath: "",
  projectVerificationPath: "", hermesRoot: "",
  hermesExecutionEnabled: true,
  hermesExecutable: "/home/hermes-agent/.local/bin/hermes",
  hermesHome: "/home/hermes-agent/.hermes",
  hermesUser: "hermes-agent",
  hermesUserHome: "/home/hermes-agent",
  hermesPath: "/home/hermes-agent/.local/bin:/usr/local/bin:/usr/bin:/bin",
  hermesProvider: "openai-codex",
  hermesModel: "gpt-5.6-terra",
  hermesTimeoutMs: 50,
  hermesMaxQueryCharacters: 8000,
  logLevel: "silent",
  ...overrides,
});

function fakeChild({ stdout = "", stderr = "", exitCode = 0, neverClose = false, error = null } = {}) {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = stdoutEmitter;
  child.stderr = stderrEmitter;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  queueMicrotask(() => {
    if (stdout !== "") stdoutEmitter.emit("data", Buffer.from(stdout));
    if (stderr !== "") stderrEmitter.emit("data", Buffer.from(stderr));
    if (neverClose) return;
    if (error) {
      child.emit("error", error instanceof Error ? error : new Error(error));
      return;
    }
    child.emit("close", exitCode);
  });
  return child;
}

function spawnHarness(results) {
  const calls = [];
  let index = 0;
  const spawnProcess = (command, args, options) => {
    const spec = results[Math.min(index, results.length - 1)];
    index += 1;
    const child = fakeChild(spec);
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

function assertSameSafeFrontier(call, cfg) {
  assert.equal(call.command, "/usr/sbin/runuser");
  assert.equal(call.options.shell, false);
  assert.equal(call.options.cwd, cfg.hermesUserHome);
  assert.deepEqual(call.options.env, {
    PATH: "/usr/sbin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  });
  assert.equal(call.args[0], "-u");
  assert.equal(call.args[1], cfg.hermesUser);
  const envStart = call.args.indexOf("env");
  const envEnd = call.args.indexOf(cfg.hermesExecutable);
  const envArgs = call.args.slice(envStart, envEnd);
  assert.equal(envArgs[0], "env");
  assert.equal(envArgs[1], "-i");
  assert.ok(envArgs.includes(`HOME=${cfg.hermesUserHome}`));
  assert.ok(envArgs.includes(`USER=${cfg.hermesUser}`));
  assert.ok(envArgs.includes(`LOGNAME=${cfg.hermesUser}`));
  assert.ok(envArgs.includes(`PATH=${cfg.hermesPath}`));
  assert.ok(envArgs.includes(`HERMES_HOME=${cfg.hermesHome}`));
  assert.ok(envArgs.includes("TERM=dumb"));
  assert.ok(envArgs.includes("NO_COLOR=1"));
  const tail = call.args.slice(envEnd);
  for (const expected of ["chat", "-Q", "--ignore-rules", "--source", "tool", "--max-turns", "1"]) {
    assert.ok(tail.includes(expected));
  }
  assert.equal(call.args.at(-2), "-q");
  assert.equal(call.args.at(-1), QUERY);
}

function assertProviderModel(call, provider, model) {
  const providerIndex = call.args.indexOf("--provider");
  assert.equal(call.args[providerIndex + 1], provider);
  const modelIndex = call.args.indexOf("-m");
  assert.equal(call.args[modelIndex + 1], model);
}

// 1. primary/OpenAI success => only one attempt
test("primary OpenAI success uses a single attempt and returns the cleaned response", async () => {
  const { calls, spawnProcess } = spawnHarness([{ stdout: "  Useful reply  \n" }]);
  const result = await executeHermesQuery(config(), QUERY, { spawnProcess, env: {} });
  assert.deepEqual(result, { ok: true, response: "Useful reply" });
  assert.equal(calls.length, 1);
  assertProviderModel(calls[0], "openai-codex", "gpt-5.6-terra");
  assertSameSafeFrontier(calls[0], config());
});

// 2/13/14/15/16. real phrase => exactly one DeepSeek fallback with the same frontier/query
test("real quota phrase triggers exactly one DeepSeek fallback keeping the same safe frontier and query", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: REAL_QUOTA_PHRASE, exitCode: 1 },
    { stdout: "DeepSeek reply" },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: true, response: "DeepSeek reply" });
  assert.equal(calls.length, 2);
  assertProviderModel(calls[0], "openai-codex", "gpt-5.6-terra");
  assertProviderModel(calls[1], "deepseek", "deepseek-v4-flash");
  assertSameSafeFrontier(calls[0], config());
  assertSameSafeFrontier(calls[1], config());
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(calls[0].args.some((arg) => arg.startsWith("DEEPSEEK_API_KEY=")), false);
  assert.equal(calls[1].args.includes(`DEEPSEEK_API_KEY=${SECRET}`), true);
});

// 3. "You've hit your usage limit" => fallback
test("'You've hit your usage limit' triggers the DeepSeek fallback", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: "You've hit your usage limit for the OpenAI model.", exitCode: 1 },
    { stdout: "DeepSeek reply" },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: true, response: "DeepSeek reply" });
  assert.equal(calls.length, 2);
  assertProviderModel(calls[1], "deepseek", "deepseek-v4-flash");
});

// 4. insufficient_quota => fallback
test("insufficient_quota triggers the DeepSeek fallback", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: '{"error":{"message":"insufficient_quota"}}', exitCode: 1 },
    { stdout: "DeepSeek reply" },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: true, response: "DeepSeek reply" });
  assert.equal(calls.length, 2);
});

// 5. generic HTTP 429 => NO fallback
test("generic HTTP 429 Too Many Requests does NOT trigger a fallback", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: "HTTP 429 Too Many Requests", exitCode: 1 },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: false, error: "execution_failed" });
  assert.equal(calls.length, 1);
});

// 6. temporary rate limit => NO fallback
test("temporary rate limit text does NOT trigger a fallback", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: "Rate limit reached for model gpt-5.6-terra. Please retry later.", exitCode: 1 },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: false, error: "execution_failed" });
  assert.equal(calls.length, 1);
});

// 7. timeout => NO fallback, same SIGTERM/SIGKILL behavior
test("timeout does NOT trigger a fallback and keeps SIGTERM/SIGKILL", async () => {
  const { calls, spawnProcess } = spawnHarness([{ neverClose: true }]);
  const execution = executeHermesQuery(config({ hermesTimeoutMs: 30 }), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  // The executor's timeout timer is unref'd; keep the event loop alive until it fires.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await execution;
  assert.deepEqual(result, { ok: false, error: "timeout" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("openai-codex"));
  assert.deepEqual(calls[0].child.signals, ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.deepEqual(calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
});

// 8. auth failure => NO fallback
test("authentication failure does NOT trigger a fallback", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: "401 Unauthorized: invalid API key", exitCode: 1 },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: false, error: "execution_failed" });
  assert.equal(calls.length, 1);
});

// 9. network failure => NO fallback
test("network failure does NOT trigger a fallback", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: "Error: connect ECONNREFUSED 127.0.0.1:443", exitCode: 1 },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: false, error: "execution_failed" });
  assert.equal(calls.length, 1);
});

// 10. generic failure => NO fallback
test("generic failure does NOT trigger a fallback", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: "Something unexpected went wrong.", exitCode: 1 },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: false, error: "execution_failed" });
  assert.equal(calls.length, 1);
});

// 11. DeepSeek secret missing => fail closed, no second insecure child
test("missing DeepSeek secret fails closed without a second child", async () => {
  let loaderCalls = 0;
  const { calls, spawnProcess } = spawnHarness([
    { stderr: REAL_QUOTA_PHRASE, exitCode: 1 },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    secretLoader: async () => {
      loaderCalls += 1;
      return undefined;
    },
  });
  assert.deepEqual(result, { ok: false, error: "execution_failed" });
  assert.equal(calls.length, 1);
  assert.equal(loaderCalls, 1);
});

// 12. at most one fallback
test("at most one fallback attempt happens even when DeepSeek also fails", async () => {
  const { calls, spawnProcess } = spawnHarness([
    { stderr: REAL_QUOTA_PHRASE, exitCode: 1 },
    { stderr: REAL_QUOTA_PHRASE, exitCode: 1 },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: false, error: "execution_failed" });
  assert.equal(calls.length, 2);
  assertProviderModel(calls[1], "deepseek", "deepseek-v4-flash");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

// 17. secret is never printed
test("DeepSeek secret is never printed to any console output", async () => {
  const originals = {
    log: console.log, error: console.error, warn: console.warn, info: console.info,
  };
  const captured = [];
  for (const method of ["log", "error", "warn", "info"]) {
    console[method] = (...args) => captured.push(args.join(" "));
  }
  try {
    const { calls, spawnProcess } = spawnHarness([
      { stderr: REAL_QUOTA_PHRASE, exitCode: 1 },
      { stdout: "DeepSeek reply" },
    ]);
    const result = await executeHermesQuery(config(), QUERY, {
      spawnProcess,
      env: { DEEPSEEK_API_KEY: SECRET },
    });
    assert.deepEqual(result, { ok: true, response: "DeepSeek reply" });
    assert.equal(calls.length, 2);
  } finally {
    for (const method of ["log", "error", "warn", "info"]) {
      console[method] = originals[method];
    }
  }
  assert.equal(captured.join("\n").includes(SECRET), false);
});

// 18. global process.env is never mutated
test("global process.env is never mutated by the DeepSeek fallback", async () => {
  const before = process.env.DEEPSEEK_API_KEY;
  const { calls, spawnProcess } = spawnHarness([
    { stderr: REAL_QUOTA_PHRASE, exitCode: 1 },
    { stdout: "DeepSeek reply" },
  ]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    env: { DEEPSEEK_API_KEY: SECRET },
  });
  assert.deepEqual(result, { ok: true, response: "DeepSeek reply" });
  assert.equal(calls.length, 2);
  assert.equal(process.env.DEEPSEEK_API_KEY, before);
});

// 19. OpenAI success never attempts to load the secret
test("primary success never attempts to load the DeepSeek secret", async () => {
  let loaderCalls = 0;
  const { calls, spawnProcess } = spawnHarness([{ stdout: "Primary reply" }]);
  const result = await executeHermesQuery(config(), QUERY, {
    spawnProcess,
    secretLoader: async () => {
      loaderCalls += 1;
      return SECRET;
    },
  });
  assert.deepEqual(result, { ok: true, response: "Primary reply" });
  assert.equal(calls.length, 1);
  assert.equal(loaderCalls, 0);
});

// secret loaded from the protected env file only when fallback is about to run
test("secret is read from the exact DEEPSEEK_API_KEY line of the env file for the fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-secret-"));
  const envFile = join(directory, ".env");
  try {
    await writeFile(envFile, `OTHER=value\nDEEPSEEK_API_KEY='${SECRET}'\nANOTHER=1\n`);
    const { calls, spawnProcess } = spawnHarness([
      { stderr: "You've hit your usage limit", exitCode: 1 },
      { stdout: "DeepSeek reply" },
    ]);
    const result = await executeHermesQuery(config(), QUERY, {
      spawnProcess,
      env: {},
      secretEnvFile: envFile,
    });
    assert.deepEqual(result, { ok: true, response: "DeepSeek reply" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.includes(`DEEPSEEK_API_KEY=${SECRET}`), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// detector unit coverage
test("quota detector recognizes only unmistakable quota/usage-limit signals", () => {
  assert.equal(isHermesQuotaUsageLimitFailure("", REAL_QUOTA_PHRASE), true);
  assert.equal(isHermesQuotaUsageLimitFailure("You've hit your usage limit", ""), true);
  assert.equal(isHermesQuotaUsageLimitFailure("You've reached your usage limit", ""), true);
  assert.equal(isHermesQuotaUsageLimitFailure("", "insufficient_quota"), true);
  assert.equal(isHermesQuotaUsageLimitFailure("exceeded your current quota", ""), true);
  assert.equal(isHermesQuotaUsageLimitFailure("quota exceeded", ""), true);
  assert.equal(isHermesQuotaUsageLimitFailure("workspace credit limit reached", ""), true);
  assert.equal(isHermesQuotaUsageLimitFailure("workspace is out of credits", ""), true);
  assert.equal(isHermesQuotaUsageLimitFailure("HTTP 429 Too Many Requests", ""), false);
  assert.equal(isHermesQuotaUsageLimitFailure("Rate limit reached for model", ""), false);
  assert.equal(isHermesQuotaUsageLimitFailure("request timed out after 60s", ""), false);
  assert.equal(isHermesQuotaUsageLimitFailure("401 invalid api key", ""), false);
  assert.equal(isHermesQuotaUsageLimitFailure("connect ECONNREFUSED", ""), false);
  assert.equal(isHermesQuotaUsageLimitFailure("something generic went wrong", ""), false);
});

// loader unit coverage
test("secret loader prefers the environment and only reads the exact DEEPSEEK_API_KEY line", async () => {
  assert.equal(await loadHermesDeepSeekSecret({ DEEPSEEK_API_KEY: SECRET }, "/nonexistent/.env"), SECRET);
  assert.equal(await loadHermesDeepSeekSecret({}, "/nonexistent/.env"), undefined);
  assert.equal(
    await loadHermesDeepSeekSecret({ DEEPSEEK_API_KEY: "   " }, "/nonexistent/.env"),
    undefined,
  );

  const directory = await mkdtemp(join(tmpdir(), "hermes-loader-"));
  const envFile = join(directory, ".env");
  try {
    await writeFile(envFile, `# comment\nDEEPSEEK_API_KEY="${SECRET}"\nOTHER=x\n`);
    assert.equal(await loadHermesDeepSeekSecret({}, envFile), SECRET);
    await writeFile(envFile, "DEEPSEEK_API_KEY=\n");
    assert.equal(await loadHermesDeepSeekSecret({}, envFile), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(HERMES_DEEPSEEK_ENV_FILE, "/home/hermes-agent/.hermes/.env");
});
