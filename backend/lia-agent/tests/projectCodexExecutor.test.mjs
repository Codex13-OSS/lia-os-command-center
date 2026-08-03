import assert from "node:assert/strict";
import test from "node:test";
import {
  executeProjectCodexHandoff,
  PROJECT_CODEX_MAX_PROMPT_CHARS,
  PROJECT_CODEX_WORKTREE_ROOT,
} from "../dist/services/projectCodexExecutor.js";

const handoff = (overrides = {}) => ({
  projectId: "safe-project",
  projectDisplayName: "Safe Project",
  repositoryRoot: "/private/repositories/safe-project",
  instruction: "Implement the approved change.",
  priority: "normal",
  approvedCapabilities: ["repository_read", "isolated_worktree_write"],
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

test("isolated Codex execution creates, executes, and cleans its worktree", async () => {
  const fake = harness();
  const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
  assert.deepEqual(result, {
    success: true,
    executionId: "execution-123",
    status: "completed",
    summary: "Codex execution completed in an isolated worktree.",
  });
  assert.equal(fake.gitCalls.length, 2);
  assert.deepEqual(fake.gitCalls[0].args, [
    "-C", "/private/repositories/safe-project", "worktree", "add", "-b",
    "lia/executor/execution-123", `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`, "HEAD",
  ]);
  assert.deepEqual(fake.gitCalls[1].args, [
    "-C", "/private/repositories/safe-project", "worktree", "remove", "--force",
    `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`,
  ]);
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
  ["isolated_worktree_write", ["repository_read"], "missing_isolated_worktree_write"],
]) test(`fails closed without ${name} before invoking a runner`, async () => {
  const fake = harness();
  const result = await executeProjectCodexHandoff(handoff({ approvedCapabilities: capabilities }), fake.dependencies);
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

  const cleanup = harness({ gitResults: [
    { success: true, stdout: "", stderr: "" },
    { success: false, reason: "failed", stdout: "", stderr: "private" },
  ] });
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
  assert.equal(fake.gitCalls.length, 2);
  assert.equal(fake.codexCalls.length, 1);
  const programArgs = fake.gitCalls.flatMap((call) => call.args);
  assert.equal(programArgs.includes("commit"), false);
  assert.equal(programArgs.includes("test"), false);
});

test("safe result never exposes process output or internal fields", async () => {
  const fake = harness({ codexResult: { success: false, reason: "failed", stdout: "SECRET", stderr: "SECRET" } });
  const result = await executeProjectCodexHandoff(handoff(), fake.dependencies);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["SECRET", "repositoryRoot", "worktreePath", "branch", "prompt", "stderr", "/private/repositories"])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});

