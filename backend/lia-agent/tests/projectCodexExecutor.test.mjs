import assert from "node:assert/strict";
import test from "node:test";
import {
  executeProjectCodexHandoff,
  PROJECT_CODEX_MAX_RESULT_CHARS,
  PROJECT_CODEX_MAX_PROMPT_CHARS,
  PROJECT_CODEX_WORKTREE_ROOT,
} from "../dist/services/projectCodexExecutor.js";
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

function harness({ codexResult, gitResults } = {}) {
  const gitCalls = [];
  const codexCalls = [];
  let index = 0;
  return {
    gitCalls,
    codexCalls,
    dependencies: {
      executionIdFactory: () => "execution-123",
      ensureWorktreeRoot: async () => {},
      hydrateDependencies: async () => {},
      gitRunner: async (request) => {
        gitCalls.push(request);
        return gitResults?.[index++] ?? { success: true, stdout: "", stderr: "" };
      },
      codexRunner: async (request) => {
        codexCalls.push(request);
        return codexResult ?? { success: true, stdout: "done", stderr: "secret" };
      },
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

test("process invocations use fixed safe argv and shell false", async () => {
  const fake = harness();
  await executeProjectCodexHandoff(handoff(), fake.dependencies);
  for (const call of [...fake.gitCalls, ...fake.codexCalls]) assert.equal(call.shell, false);
  assert.deepEqual(fake.codexCalls[0].args.slice(0, -1), [
    "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
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
