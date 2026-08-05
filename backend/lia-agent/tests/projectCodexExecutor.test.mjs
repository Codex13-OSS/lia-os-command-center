import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeProjectCodexHandoff,
  PROJECT_CODEX_MAX_RESULT_CHARS,
  PROJECT_CODEX_MAX_PROMPT_CHARS,
  PROJECT_CODEX_WORKTREE_ROOT,
  sanitizeProjectCodexResult,
} from "../dist/services/projectCodexExecutor.js";
import { loadLiaCodexDeepSeekSecret } from "../dist/services/projectCodexProvider.js";
import { discardProjectCodexWorkspace } from "../dist/services/projectCodexWorkspace.js";

const handoff = (overrides = {}) => ({
  projectId: "safe-project",
  projectDisplayName: "Safe Project",
  repositoryRoot: "/private/repositories/safe-project",
  instruction: "Implement the approved change.",
  priority: "normal",
  approvedCapabilities: ["repository_read", "isolated_worktree_write"],
  effectiveCapabilities: ["repository_read", "isolated_worktree_write"],
  proposal: {
    summary: "Make a contained change",
    steps: [{
      title: "Edit",
      objective: "Modify files only in the isolated worktree",
      requiredCapabilities: ["isolated_worktree_write"],
    }],
  },
  executor: "codex",
  workspaceIsolation: "isolated_worktree_only",
  productionAccess: false,
  databaseWriteAccess: false,
  secretAccess: false,
  ...overrides,
});

function harness({ codexResult, codexResults, gitResults, deepSeekSecretLoader } = {}) {
  const gitCalls = [];
  const codexCalls = [];
  let gitIndex = 0;
  let codexIndex = 0;
  const secretLoader = deepSeekSecretLoader ?? (async () => "sk-test-dont-leak-9f3a");
  return {
    gitCalls,
    codexCalls,
    dependencies: {
      executionIdFactory: () => "execution-123",
      ensureWorktreeRoot: async () => {},
      hydrateDependencies: async () => {},
      gitRunner: async (request) => {
        gitCalls.push(request);
        return gitResults?.[gitIndex++] ?? { success: true, stdout: "", stderr: "" };
      },
      codexRunner: async (request) => {
        codexCalls.push(request);
        if (codexResults !== undefined) {
          return codexResults[codexIndex++]
            ?? { success: false, reason: "failed", stdout: "", stderr: "" };
        }
        return codexResult ?? { success: true, stdout: "done", stderr: "secret" };
      },
      deepSeekSecretLoader: secretLoader,
    },
  };
}

test("isolated Codex execution creates, executes, and retains its worktree", async () => {
  const fake = harness();
  const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
  assert.deepEqual(result, {
    success: true,
    executionId: "execution-123",
    status: "completed",
    summary: "Codex execution completed in an isolated worktree.",
    resultText: "done",
    outcome: "modification_completed",
  });
  assert.equal(fake.gitCalls.length, 1);
  assert.deepEqual(fake.gitCalls[0].args, [
    "-C", "/private/repositories/safe-project", "worktree", "add", "-b",
    "lia/executor/execution-123", `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`, "HEAD",
  ]);
});

test("repository_read-only execution uses repository root and read-only sandbox without worktree or hydration", async () => {
  const fake = harness({ codexResult: { success: true, stdout: "Architecture is sound.", stderr: "private" } });
  let hydrated = false;
  fake.dependencies.hydrateDependencies = async () => { hydrated = true; };
  const result = await executeProjectCodexHandoff(handoff({
    approvedCapabilities: ["repository_read", "isolated_worktree_write", "run_tests", "local_commit"],
    effectiveCapabilities: ["repository_read"],
    proposal: { summary: "Inspect", steps: [{ title: "Inspect", objective: "Analyze only", requiredCapabilities: ["repository_read"] }] },
  }), fake.dependencies);
  assert.equal(result.outcome, "analysis_completed");
  assert.equal(result.resultText, "Architecture is sound.");
  assert.equal(fake.gitCalls.length, 0);
  assert.equal(hydrated, false);
  assert.deepEqual(fake.codexCalls[0].args.slice(0, -1), [
    "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "-c", "model_provider=openai",
    "-s", "read-only", "-C", "/private/repositories/safe-project",
  ]);
});

test("result sanitizer removes transcript lines and deterministically bounds useful text", async () => {
  const fake = harness({ codexResult: { success: true, stdout: `command: git status\nUseful analysis ${"x".repeat(7000)}`, stderr: "never public" } });
  const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
  assert.equal(result.resultText.startsWith("Useful analysis"), true);
  assert.equal(result.resultText.includes("git status"), false);
  assert.equal(result.resultText.length, PROJECT_CODEX_MAX_RESULT_CHARS);
  assert.equal(JSON.stringify(result).includes("never public"), false);
});

test("result sanitizer redacts absolute paths even after punctuation like = and preserves safe prose", () => {
  const output = sanitizeProjectCodexResult([
    "PATH=/usr/bin",
    "key=/tmp/private/path",
    "repo=/opt/private/project",
    "Useful analysis: the change is safe.",
    "References: /home/hermes/notes, /var/log/app.log.",
    "Docs: https://example.com/guide (unchanged).",
  ].join("\n"));
  for (const leaked of ["/usr/bin", "/tmp/private/path", "/opt/private/project", "/home/hermes", "/var/log"])
    assert.equal(output.includes(leaked), false, leaked);
  assert.equal(output.includes("Useful analysis: the change is safe."), true);
  assert.equal(output.includes("https://example.com/guide"), true);
  assert.equal(output.includes("[ruta omitida]"), true);
});

test("execution result never exposes paths embedded after punctuation like =", async () => {
  const fake = harness({ codexResult: {
    success: true,
    stdout: "PATH=/usr/bin\nkey=/tmp/private/path\nrepo=/opt/private/project\nSafe summary of the change.",
    stderr: "SECRET",
  } });
  const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
  const serialized = JSON.stringify(result);
  for (const leaked of ["/usr/bin", "/tmp/private/path", "/opt/private/project", "SECRET"])
    assert.equal(serialized.includes(leaked), false, leaked);
  assert.equal(result.resultText.includes("Safe summary of the change."), true);
});

test("process invocations use fixed safe argv and shell false", async () => {
  const fake = harness();
  await executeProjectCodexHandoff(handoff(), fake.dependencies);
  for (const call of [...fake.gitCalls, ...fake.codexCalls]) assert.equal(call.shell, false);
  assert.deepEqual(fake.codexCalls[0].args.slice(0, -1), [
    "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "-c", "model_provider=openai",
    "-s", "workspace-write", "-C", `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`,
  ]);
  const everyArg = [...fake.gitCalls, ...fake.codexCalls].flatMap((call) => call.args);
  for (const forbidden of ["push", "merge", "deploy", "reset", "clean", "checkout", "--search", "add-dir", "danger-full-access", "dangerously-bypass-approvals-and-sandbox"])
    assert.equal(everyArg.includes(forbidden), false, forbidden);
});

test("Codex prompt contains only approved handoff content and no execution internals", async () => {
  const fake = harness();
  await executeProjectCodexHandoff(handoff(), fake.dependencies);
  const prompt = fake.codexCalls[0].args.at(-1);
  for (const expected of ["Safe Project", "safe-project", "Implement the approved change.", "Make a contained change", "Edit", "Modify files only in the isolated worktree", "repository_read", "isolated_worktree_write"])
    assert.equal(prompt.includes(expected), true, expected);
  for (const internal of ["/private/repositories/safe-project", PROJECT_CODEX_WORKTREE_ROOT, "lia/executor/execution-123", "execution-123"])
    assert.equal(prompt.includes(internal), false, internal);
});

for (const [name, capabilities, error] of [
  ["repository_read", ["isolated_worktree_write"], "missing_repository_read"],
]) test(`fails closed without ${name} before invoking a runner`, async () => {
  const fake = harness();
  const result = await executeProjectCodexHandoff(handoff({ effectiveCapabilities: capabilities }), fake.dependencies);
  assert.equal(result.error, error);
  assert.equal(fake.gitCalls.length, 0);
  assert.equal(fake.codexCalls.length, 0);
});

test("effectiveCapabilities outside the LÍA ceiling fails closed with the capability-authorization error", async () => {
  for (const [approved, effective] of [
    [["repository_read"], ["repository_read", "local_commit"]],
    [["repository_read"], ["repository_read", "isolated_worktree_write"]],
    [["repository_read", "isolated_worktree_write"], ["repository_read", "isolated_worktree_write", "run_tests"]],
  ]) {
    const fake = harness();
    const result = await executeProjectCodexHandoff(
      handoff({ approvedCapabilities: approved, effectiveCapabilities: effective }),
      fake.dependencies,
    );
    assert.equal(result.success, false);
    assert.equal(result.error, "missing_isolated_worktree_write", JSON.stringify(effective));
    assert.equal(fake.gitCalls.length, 0);
    assert.equal(fake.codexCalls.length, 0);
  }
});

test("cleans the worktree after Codex failure and timeout", async () => {
  for (const [reason, expected] of [["failed", "codex_execution_failed"], ["timeout", "timeout"]]) {
    const fake = harness({ codexResult: { success: false, reason, stdout: "", stderr: "private" } });
    const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
    assert.equal(result.error, expected);
    assert.equal(fake.gitCalls.length, 2);
    assert.equal(fake.gitCalls[1].args.includes("remove"), true);
  }
});

test("cleans after worktree creation failure and reports cleanup failure deterministically", async () => {
  const creation = harness({ gitResults: [
    { success: false, reason: "failed", stdout: "", stderr: "private" },
    { success: true, stdout: "", stderr: "" },
  ] });
  assert.equal((await executeProjectCodexHandoff(handoff(), creation.dependencies)).error, "worktree_create_failed");
  assert.equal(creation.gitCalls.length, 2);

  const cleanup = harness({
    codexResult: { success: false, reason: "failed", stdout: "", stderr: "private" },
    gitResults: [
      { success: true, stdout: "", stderr: "" },
      { success: false, reason: "failed", stdout: "", stderr: "private" },
    ],
  });
  assert.equal((await executeProjectCodexHandoff(handoff(), cleanup.dependencies)).error, "worktree_cleanup_failed");
});

test("rejects oversized prompts before creating a worktree", async () => {
  const fake = harness();
  const result = await executeProjectCodexHandoff(
    handoff({ instruction: "x".repeat(PROJECT_CODEX_MAX_PROMPT_CHARS) }),
    fake.dependencies,
  );
  assert.equal(result.error, "prompt_too_large");
  assert.equal(fake.gitCalls.length, 0);
});

test("generated worktree paths remain confined to the fixed root", async () => {
  for (const generatedId of ["../escape", "/tmp/escape", "nested/path", ""] ) {
    const fake = harness();
    fake.dependencies.executionIdFactory = () => generatedId;
    const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
    assert.equal(result.error, "invalid_generated_path", generatedId);
    assert.equal(fake.gitCalls.length, 0);
  }
});

test("LÍA does not run tests or commits even when capabilities are approved", async () => {
  const fake = harness();
  await executeProjectCodexHandoff(handoff({
    approvedCapabilities: ["repository_read", "isolated_worktree_write", "run_tests", "local_commit"],
  }), fake.dependencies);
  assert.equal(fake.gitCalls.length, 1);
  assert.equal(fake.codexCalls.length, 1);
  const programArgs = fake.gitCalls.flatMap((call) => call.args);
  assert.equal(programArgs.includes("commit"), false);
  assert.equal(programArgs.includes("test"), false);
});

test("safe successful result preserves bounded final output but never stderr or internal fields", async () => {
  const fake = harness({ codexResult: { success: true, stdout: "Useful result", stderr: "SECRET" } });
  const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
  const serialized = JSON.stringify(result);
  assert.equal(result.resultText, "Useful result");
  for (const forbidden of ["SECRET", "repositoryRoot", "worktreePath", "branch", "prompt", "stderr", "/private/repositories"])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("discard uses exact fixed argv, shell false, and a path derived from executionId", async () => {
  const calls = [];
  const result = await discardProjectCodexWorkspace(
    "/private/repositories/safe-project",
    "execution-123",
    { gitRunner: async (request) => {
      calls.push(request);
      return { success: true, stdout: "private", stderr: "private" };
    } },
  );
  assert.deepEqual(result, { success: true, executionId: "execution-123", status: "discarded" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "git");
  assert.equal(calls[0].shell, false);
  assert.deepEqual(calls[0].args, [
    "-C", "/private/repositories/safe-project", "worktree", "remove", "--force",
    `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`,
  ]);
});

test("discard rejects dangerous executionId before invoking its runner", async () => {
  for (const executionId of ["../escape", "/tmp/escape", "nested/path", ""]) {
    let called = false;
    const result = await discardProjectCodexWorkspace("/private/repositories/safe-project", executionId, {
      gitRunner: async () => {
        called = true;
        return { success: true, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(result, { success: false, executionId, status: "failed", error: "invalid_generated_path" });
    assert.equal(called, false);
  }
});

test("discard failure is deterministic and does not expose internals", async () => {
  for (const gitRunner of [
    async () => ({ success: false, reason: "failed", stdout: "SECRET", stderr: "SECRET" }),
    async () => { throw new Error("SECRET"); },
  ]) {
    const result = await discardProjectCodexWorkspace("/private/repositories/safe-project", "execution-123", { gitRunner });
    assert.deepEqual(result, {
      success: false,
      executionId: "execution-123",
      status: "failed",
      error: "workspace_discard_failed",
    });
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(JSON.stringify(result).includes("/private/repositories"), false);
  }
});

test("simulated integration retains the worktree after fake git add and fake Codex success", async () => {
  const fake = harness({ codexResult: { success: true, stdout: "done", stderr: "" } });
  const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
  assert.equal(result.success, true);
  assert.equal(fake.gitCalls.length, 1);
  assert.equal(fake.gitCalls[0].args.includes("add"), true);
  assert.equal(fake.gitCalls.some((call) => call.args.includes("remove")), false);
});

test("hydrates after worktree creation and before Codex execution", async () => {
  const events = [];
  const fake = harness();
  fake.dependencies.gitRunner = async (request) => {
    events.push(request.args.includes("add") ? "worktree" : "cleanup");
    fake.gitCalls.push(request);
    return { success: true, stdout: "", stderr: "" };
  };
  fake.dependencies.hydrateDependencies = async () => { events.push("hydrate"); };
  fake.dependencies.codexRunner = async (request) => {
    events.push("codex");
    fake.codexCalls.push(request);
    return { success: true, stdout: "", stderr: "" };
  };
  assert.equal((await executeProjectCodexHandoff(handoff(), fake.dependencies)).success, true);
  assert.deepEqual(events, ["worktree", "hydrate", "codex"]);
});

test("hydration failure prevents Codex, cleans the worktree, and exposes no internals", async () => {
  const fake = harness();
  fake.dependencies.hydrateDependencies = async () => { throw new Error("SECRET /private/source /tmp/worktree"); };
  const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
  assert.equal(result.error, "worktree_create_failed");
  assert.equal(fake.codexCalls.length, 0);
  assert.equal(fake.gitCalls.length, 2);
  assert.equal(fake.gitCalls[1].args.includes("remove"), true);
  for (const forbidden of ["SECRET", "/private/source", "/tmp/worktree", "repositoryRoot", "worktreePath", "stdout", "stderr"])
    assert.equal(JSON.stringify(result).includes(forbidden), false);
});

// --- Provider routing ---

const PROVIDER_MODE_ENV = "LIA_CODEX_PROVIDER_MODE";

async function withProviderEnv(value, run) {
  const previous = process.env[PROVIDER_MODE_ENV];
  if (value === undefined) delete process.env[PROVIDER_MODE_ENV];
  else process.env[PROVIDER_MODE_ENV] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[PROVIDER_MODE_ENV];
    else process.env[PROVIDER_MODE_ENV] = previous;
  }
}

test("default provider mode executes OpenAI only", async () => {
  const fake = harness();
  const result = await withProviderEnv(undefined, () =>
    executeProjectCodexHandoff(handoff(), fake.dependencies));
  assert.equal(result.success, true);
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), true);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=deepseek"), false);
});

test("explicit openai mode executes OpenAI only", async () => {
  const fake = harness();
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "openai",
  });
  assert.equal(result.success, true);
  assert.equal(fake.codexCalls.length, 1);
  assert.deepEqual(fake.codexCalls[0].args.slice(0, -1), [
    "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "-c", "model_provider=openai",
    "-s", "workspace-write", "-C", `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`,
  ]);
});

test("explicit deepseek mode executes DeepSeek only and never OpenAI first", async () => {
  const fake = harness({ codexResult: { success: true, stdout: "deepseek done", stderr: "" } });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "deepseek",
  });
  assert.equal(result.success, true);
  assert.equal(fake.codexCalls.length, 1);
  assert.deepEqual(fake.codexCalls[0].args.slice(0, -1), [
    "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "-c", "model_provider=deepseek",
    "-c", "model=deepseek-v4-flash",
    "-c", "model_providers.deepseek.name=DeepSeek",
    "-c", "model_providers.deepseek.base_url=https://api.deepseek.com/v1",
    "-c", "model_providers.deepseek.env_key=DEEPSEEK_API_KEY",
    "-c", "model_providers.deepseek.wire_api=responses",
    "-c", "model_providers.deepseek.requires_openai_auth=false",
    "-c", "model_providers.deepseek.supports_websockets=false",
    "-s", "workspace-write", "-C", `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`,
  ]);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), false);
});

test("auto + OpenAI success executes once and never invokes DeepSeek", async () => {
  const fake = harness({ codexResult: { success: true, stdout: "done", stderr: "" } });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), true);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=deepseek"), false);
});

test("auto + real OpenAI usage-limit output causes exactly one DeepSeek attempt with the key", async () => {
  const secret = "sk-test-fallback-5d10";
  let loaderCalls = 0;
  const fake = harness({ codexResults: [
    { success: false, reason: "failed", stdout: "Error: You've hit your usage limit", stderr: "" },
    { success: true, stdout: "deepseek done", stderr: "" },
  ], deepSeekSecretLoader: async () => {
    loaderCalls += 1;
    return secret;
  } });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(result.resultText, "deepseek done");
  assert.equal(fake.codexCalls.length, 2);
  assert.equal(loaderCalls, 1);
  assert.equal(fake.codexCalls[0].env, undefined);
  assert.equal(fake.codexCalls[1].env.DEEPSEEK_API_KEY, secret);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), true);
  const deepseekArgs = fake.codexCalls[1].args;
  for (const expected of [
    "model_provider=deepseek",
    "model=deepseek-v4-flash",
    "model_providers.deepseek.name=DeepSeek",
    "model_providers.deepseek.base_url=https://api.deepseek.com/v1",
    "model_providers.deepseek.env_key=DEEPSEEK_API_KEY",
    "model_providers.deepseek.wire_api=responses",
    "model_providers.deepseek.requires_openai_auth=false",
    "model_providers.deepseek.supports_websockets=false",
  ]) assert.equal(deepseekArgs.includes(expected), true, expected);
  assert.equal(deepseekArgs.includes("wire_api=chat"), false);
  assert.equal(deepseekArgs.some((arg) => arg.includes(secret)), false);
  assert.equal(fake.gitCalls.length, 1);
});

test("auto + generic OpenAI failure does not fall back", async () => {
  const fake = harness({ codexResult: { success: false, reason: "failed", stdout: "internal compiler error", stderr: "" } });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.error, "codex_execution_failed");
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), true);
});

test("auto + bare HTTP 429 does not fall back", async () => {
  const fake = harness({ codexResult: { success: false, reason: "failed", stdout: "", stderr: "HTTP 429 Too Many Requests" } });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.error, "codex_execution_failed");
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), true);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=deepseek"), false);
});

test("auto + generic rate-limit text does not fall back", async () => {
  const fake = harness({ codexResult: { success: false, reason: "failed", stdout: "Rate limit exceeded. Try again later.", stderr: "" } });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.error, "codex_execution_failed");
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), true);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=deepseek"), false);
});

test("auto + OpenAI timeout does not fall back even with quota-like text", async () => {
  const fake = harness({ codexResult: { success: false, reason: "timeout", stdout: "insufficient_quota", stderr: "" } });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.error, "timeout");
  assert.equal(fake.codexCalls.length, 1);
});

test("auto + quota failure + DeepSeek failure cleans the worktree and reports failure", async () => {
  const fake = harness({ codexResults: [
    { success: false, reason: "failed", stdout: "insufficient_quota", stderr: "" },
    { success: false, reason: "failed", stdout: "deepseek error", stderr: "" },
  ] });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.error, "codex_execution_failed");
  assert.equal(fake.codexCalls.length, 2);
  assert.equal(fake.gitCalls.length, 2);
  assert.equal(fake.gitCalls[1].args.includes("remove"), true);
});

test("auto fallback in a writable execution reuses the exact same isolated worktree", async () => {
  const fake = harness({ codexResults: [
    { success: false, reason: "failed", stdout: "You've hit your usage limit", stderr: "" },
    { success: true, stdout: "done", stderr: "" },
  ] });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(result.outcome, "modification_completed");
  assert.equal(fake.gitCalls.length, 1);
  assert.equal(fake.gitCalls.some((call) => call.args.includes("remove")), false);
  const worktreePath = `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`;
  const targets = fake.codexCalls.map((call) => call.args[call.args.indexOf("-C") + 1]);
  assert.deepEqual(targets, [worktreePath, worktreePath]);
  const prompts = fake.codexCalls.map((call) => call.args.at(-1));
  assert.equal(prompts[0], prompts[1]);
  const sandboxModes = fake.codexCalls.map((call) => call.args[call.args.indexOf("-s") + 1]);
  assert.deepEqual(sandboxModes, ["workspace-write", "workspace-write"]);
});

test("auto fallback preserves the same prompt and sandbox policy in read-only mode", async () => {
  const fake = harness({ codexResults: [
    { success: false, reason: "failed", stdout: "You've reached your usage limit", stderr: "" },
    { success: true, stdout: "analysis", stderr: "" },
  ] });
  const result = await executeProjectCodexHandoff(handoff({
    approvedCapabilities: ["repository_read", "isolated_worktree_write"],
    effectiveCapabilities: ["repository_read"],
    proposal: { summary: "Inspect", steps: [{ title: "Inspect", objective: "Analyze only", requiredCapabilities: ["repository_read"] }] },
  }), { ...fake.dependencies, providerMode: "auto" });
  assert.equal(result.success, true);
  assert.equal(result.outcome, "analysis_completed");
  assert.equal(fake.gitCalls.length, 0);
  assert.equal(fake.codexCalls.length, 2);
  const prompts = fake.codexCalls.map((call) => call.args.at(-1));
  assert.equal(prompts[0], prompts[1]);
  const sandboxModes = fake.codexCalls.map((call) => call.args[call.args.indexOf("-s") + 1]);
  assert.deepEqual(sandboxModes, ["read-only", "read-only"]);
  const targets = fake.codexCalls.map((call) => call.args[call.args.indexOf("-C") + 1]);
  assert.deepEqual(targets, ["/private/repositories/safe-project", "/private/repositories/safe-project"]);
});

test("fixed safe provider argv and --ignore-user-config remain present", async () => {
  for (const providerMode of ["openai", "deepseek"]) {
    const fake = harness();
    await executeProjectCodexHandoff(handoff(), { ...fake.dependencies, providerMode });
    const call = fake.codexCalls[0];
    assert.equal(call.file, "codex");
    assert.equal(call.shell, false);
    assert.equal(call.args.includes("--ignore-user-config"), true);
    assert.equal(call.args.includes("-c"), true);
    assert.equal(call.args.includes(`model_provider=${providerMode}`), true);
    const everyArg = [...fake.gitCalls, ...fake.codexCalls].flatMap((item) => item.args);
    for (const forbidden of ["push", "merge", "deploy", "reset", "clean", "checkout", "--search", "add-dir", "danger-full-access", "dangerously-bypass-approvals-and-sandbox"])
      assert.equal(everyArg.includes(forbidden), false, forbidden);
  }
});

test("no secret appears in argv, resultText, summary, or public result", async () => {
  const secret = "sk-test-dont-leak-9f3a";
  const previous = process.env.DEEPSEEK_API_KEY;
  const fake = harness({ codexResults: [
    { success: false, reason: "failed", stdout: `insufficient_quota ${secret}`, stderr: "" },
    { success: true, stdout: "completed without leaks", stderr: "" },
  ], deepSeekSecretLoader: async () => secret });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  const serialized = JSON.stringify(result);
  const everyArg = [...fake.gitCalls, ...fake.codexCalls].flatMap((call) => call.args);
  assert.equal(serialized.includes(secret), false);
  assert.equal(everyArg.includes(secret), false);
  assert.equal(result.resultText.includes(secret), false);
  assert.equal(result.summary.includes(secret), false);
  assert.equal(fake.codexCalls[1].args.includes("model_providers.deepseek.env_key=DEEPSEEK_API_KEY"), true);
  assert.equal(everyArg.includes(`model_providers.deepseek.env_key=${secret}`), false);
  assert.equal(fake.codexCalls[1].env.DEEPSEEK_API_KEY, secret);
  assert.equal(process.env.DEEPSEEK_API_KEY, previous);
});

test("invalid LIA_CODEX_PROVIDER_MODE fails closed without invoking runners", async () => {
  const fake = harness();
  const result = await withProviderEnv("bogus", () =>
    executeProjectCodexHandoff(handoff(), fake.dependencies));
  assert.equal(result.error, "codex_execution_failed");
  assert.equal(fake.gitCalls.length, 0);
  assert.equal(fake.codexCalls.length, 0);
});

test("default auto routing with OpenAI success never reads the DeepSeek secret", async () => {
  let loaderCalls = 0;
  const fake = harness({
    codexResult: { success: true, stdout: "done", stderr: "" },
    deepSeekSecretLoader: async () => {
      loaderCalls += 1;
      throw new Error("secret must not be loaded for an OpenAI-only attempt");
    },
  });
  const result = await withProviderEnv(undefined, () =>
    executeProjectCodexHandoff(handoff(), fake.dependencies));
  assert.equal(result.success, true);
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), true);
  assert.equal(fake.codexCalls[0].env, undefined);
  assert.equal(loaderCalls, 0);
});

test("DeepSeek fallback receives DEEPSEEK_API_KEY in the child env and preserves the parent environment", async () => {
  const secret = "sk-test-child-env-7f2c";
  const fake = harness({
    codexResults: [
      { success: false, reason: "failed", stdout: "You've hit your usage limit", stderr: "" },
      { success: true, stdout: "deepseek done", stderr: "" },
    ],
    deepSeekSecretLoader: async () => secret,
  });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(fake.codexCalls.length, 2);
  assert.equal(fake.codexCalls[0].env, undefined);
  assert.equal(fake.codexCalls[1].env.DEEPSEEK_API_KEY, secret);
  assert.equal(fake.codexCalls[1].env.PATH, process.env.PATH);
  assert.equal(fake.codexCalls[1].env.HOME, process.env.HOME);
  const deepseekArgs = fake.codexCalls[1].args;
  assert.equal(deepseekArgs.some((arg) => arg.includes(secret)), false);
  assert.equal(deepseekArgs.includes("model_providers.deepseek.env_key=DEEPSEEK_API_KEY"), true);
});

test("key can come from the secure env-file loader when absent from process env", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  const dir = await mkdtemp(join(tmpdir(), "lia-codex-secret-"));
  try {
    const file = join(dir, ".env");
    await writeFile(file, `DEEPSEEK_API_KEY="sk-file-loaded-4b1e"\n`);
    const fake = harness({
      codexResults: [
        { success: false, reason: "failed", stdout: "insufficient_quota", stderr: "" },
        { success: true, stdout: "done", stderr: "" },
      ],
      deepSeekSecretLoader: () => loadLiaCodexDeepSeekSecret({}, file),
    });
    const result = await executeProjectCodexHandoff(handoff(), {
      ...fake.dependencies,
      providerMode: "auto",
    });
    assert.equal(result.success, true);
    assert.equal(fake.codexCalls[1].env.DEEPSEEK_API_KEY, "sk-file-loaded-4b1e");
    assert.equal(process.env.DEEPSEEK_API_KEY, previous);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider routing never mutates the global process.env", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  const fake = harness({
    codexResults: [
      { success: false, reason: "failed", stdout: "insufficient_quota", stderr: "" },
      { success: true, stdout: "done", stderr: "" },
    ],
    deepSeekSecretLoader: async () => "sk-process-env-unchanged-7e19",
  });
  await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(process.env.DEEPSEEK_API_KEY, previous);
  assert.equal(fake.codexCalls[1].env.DEEPSEEK_API_KEY, "sk-process-env-unchanged-7e19");
});

test("missing DeepSeek key fails closed after OpenAI quota exhaustion", async () => {
  const fake = harness({
    codexResults: [{ success: false, reason: "failed", stdout: "You've hit your usage limit", stderr: "" }],
    deepSeekSecretLoader: async () => undefined,
  });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "auto",
  });
  assert.equal(result.error, "codex_execution_failed");
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), true);
  assert.equal(fake.codexCalls.some((call) => call.args.includes("model_provider=deepseek")), false);
  assert.equal(fake.gitCalls.length, 2);
  assert.equal(fake.gitCalls[1].args.includes("remove"), true);
});

test("missing DeepSeek key fails closed in read-only mode without spawning a DeepSeek child", async () => {
  const fake = harness({
    codexResults: [{ success: false, reason: "failed", stdout: "insufficient_quota", stderr: "" }],
    deepSeekSecretLoader: async () => "",
  });
  const result = await executeProjectCodexHandoff(handoff({
    approvedCapabilities: ["repository_read", "isolated_worktree_write"],
    effectiveCapabilities: ["repository_read"],
    proposal: { summary: "Inspect", steps: [{ title: "Inspect", objective: "Analyze only", requiredCapabilities: ["repository_read"] }] },
  }), { ...fake.dependencies, providerMode: "auto" });
  assert.equal(result.error, "codex_execution_failed");
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.gitCalls.length, 0);
});

test("explicit openai mode never accesses the DeepSeek secret", async () => {
  let loaderCalls = 0;
  const fake = harness({
    codexResult: { success: true, stdout: "done", stderr: "" },
    deepSeekSecretLoader: async () => {
      loaderCalls += 1;
      throw new Error("secret must not be loaded in explicit openai mode");
    },
  });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "openai",
  });
  assert.equal(result.success, true);
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].env, undefined);
  assert.equal(loaderCalls, 0);
});

test("explicit deepseek mode loads the secret and invokes DeepSeek only", async () => {
  const secret = "sk-explicit-deepseek-2c8a";
  let loaderCalls = 0;
  const fake = harness({
    codexResult: { success: true, stdout: "deepseek done", stderr: "" },
    deepSeekSecretLoader: async () => {
      loaderCalls += 1;
      return secret;
    },
  });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "deepseek",
  });
  assert.equal(result.success, true);
  assert.equal(result.resultText, "deepseek done");
  assert.equal(loaderCalls, 1);
  assert.equal(fake.codexCalls.length, 1);
  assert.equal(fake.codexCalls[0].env.DEEPSEEK_API_KEY, secret);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=deepseek"), true);
  assert.equal(fake.codexCalls[0].args.includes("model_provider=openai"), false);
});

test("explicit deepseek mode fails closed when the key is missing", async () => {
  const fake = harness({ deepSeekSecretLoader: async () => undefined });
  const result = await executeProjectCodexHandoff(handoff(), {
    ...fake.dependencies,
    providerMode: "deepseek",
  });
  assert.equal(result.error, "codex_execution_failed");
  assert.equal(fake.codexCalls.length, 0);
  assert.equal(fake.gitCalls.length, 2);
  assert.equal(fake.gitCalls[1].args.includes("remove"), true);
});
