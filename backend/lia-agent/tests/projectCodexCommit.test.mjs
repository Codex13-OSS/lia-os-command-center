import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { commitVerifiedProjectCodexWorkspace } from "../dist/services/projectCodexCommit.js";
import { PROJECT_CODEX_WORKTREE_ROOT } from "../dist/services/projectCodexWorkspace.js";

const executionId = "execution-123";
const verified = {
  success: true,
  executionId,
  status: "verified",
  checksPassed: 2,
  totalChecks: 2,
  summary: "verified",
};
const hash = "a".repeat(40);

function harness(results = []) {
  const calls = [];
  return {
    calls,
    dependencies: {
      runner: async (request) => {
        calls.push(request);
        return results[calls.length - 1] ?? { success: true, stdout: "", stderr: "" };
      },
    },
  };
}

test("local_commit is required before any process runs", async () => {
  const fake = harness();
  const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["repository_read"], verified, fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "local_commit_not_approved");
  assert.equal(fake.calls.length, 0);
});

test("failed or mismatched verification runs no process", async () => {
  for (const verification of [
    { success: false, executionId, status: "verification_failed", error: "check_failed", checksPassed: 0, totalChecks: 2, summary: "PRIVATE" },
    { ...verified, executionId: "execution-other" },
  ]) {
    const fake = harness();
    const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["local_commit"], verification, fake.dependencies);
    assert.equal(result.success, false);
    assert.equal(result.error, "workspace_not_verified");
    assert.equal(fake.calls.length, 0);
  }
});

test("dangerous execution ids are rejected before running a process", async () => {
  for (const dangerousId of ["../escape", "/tmp/escape", "nested/path", ""]) {
    const fake = harness();
    const result = await commitVerifiedProjectCodexWorkspace("/private/repo", dangerousId, ["local_commit"], { ...verified, executionId: dangerousId }, fake.dependencies);
    assert.equal(result.success, false);
    assert.equal(result.error, "invalid_generated_path");
    assert.equal(fake.calls.length, 0);
  }
});

test("empty status returns nothing_to_commit after exactly one call", async () => {
  const fake = harness([{ success: true, stdout: "", stderr: "PRIVATE" }]);
  const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["local_commit"], verified, fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "nothing_to_commit");
  assert.equal(fake.calls.length, 1);
});

test("success uses the exact fixed argv in the exclusively derived worktree", async () => {
  const fake = harness([
    { success: true, stdout: " M secret-name.txt\n", stderr: "" },
    { success: true, stdout: "PRIVATE ADD", stderr: "" },
    { success: true, stdout: "PRIVATE COMMIT", stderr: "" },
    { success: true, stdout: `${hash}\n`, stderr: "PRIVATE REVISION" },
  ]);
  const result = await commitVerifiedProjectCodexWorkspace("/must/not/be/used", executionId, ["local_commit"], verified, fake.dependencies);
  assert.deepEqual(result, {
    success: true,
    executionId,
    status: "committed",
    commit: hash,
    summary: "The verified workspace was committed locally.",
  });
  const worktree = `${PROJECT_CODEX_WORKTREE_ROOT}/${executionId}`;
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["-C", worktree, "status", "--porcelain"],
    ["-C", worktree, "add", "-A"],
    ["-C", worktree, "commit", "-m", `lia: complete isolated task ${executionId}`],
    ["-C", worktree, "rev-parse", "HEAD"],
  ]);
  for (const call of fake.calls) {
    assert.equal(call.file, "git");
    assert.equal(call.shell, false);
    assert.equal(call.timeoutMs, 120_000);
    assert.equal(call.maxOutputBytes, 64 * 1024);
    assert.equal(call.args[1], worktree);
    assert.equal(call.args.includes("/must/not/be/used"), false);
  }
});

for (const [name, position, error] of [
  ["status", 0, "git_status_failed"],
  ["add", 1, "git_stage_failed"],
  ["commit", 2, "git_commit_failed"],
  ["rev-parse", 3, "git_revision_failed"],
]) {
  test(`${name} failure is mapped safely and stops the sequence`, async () => {
    const results = [
      { success: true, stdout: " M private.txt\n", stderr: "" },
      { success: true, stdout: "", stderr: "" },
      { success: true, stdout: "", stderr: "" },
      { success: true, stdout: hash, stderr: "" },
    ];
    results[position] = { success: false, reason: "timeout", stdout: "PRIVATE", stderr: "SECRET" };
    const fake = harness(results);
    const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["local_commit"], verified, fake.dependencies);
    assert.equal(result.success, false);
    assert.equal(result.error, error);
    assert.equal(fake.calls.length, position + 1);
  });
}

test("invalid revision text is rejected", async () => {
  const fake = harness([
    { success: true, stdout: "?? private.txt\n", stderr: "" },
    { success: true, stdout: "", stderr: "" },
    { success: true, stdout: "", stderr: "" },
    { success: true, stdout: "not-a-hash\n", stderr: "" },
  ]);
  const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["local_commit"], verified, fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "git_revision_failed");
});

test("safe results expose no process, workspace, or filename details and retain the workspace", async () => {
  const fake = harness([
    { success: true, stdout: "?? secret-name.txt\n", stderr: "SECRET" },
    { success: false, reason: "failed", stdout: "PRIVATE", stderr: "SECRET" },
  ]);
  const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["local_commit"], verified, fake.dependencies);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["private", "PRIVATE", "SECRET", "secret-name", PROJECT_CODEX_WORKTREE_ROOT, "worktreePath", "branch", "stdout", "stderr", "args", "command", "env", "prompt"])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(fake.calls.some((call) => call.args.includes("remove")), false);
});

test("commit service source contains no forbidden git operations or workspace removal", async () => {
  const source = await readFile(new URL("../src/services/projectCodexCommit.ts", import.meta.url), "utf8");
  for (const forbidden of ["push", "merge", "deploy", "reset", "clean", "rebase", "fetch", "pull", "remote", "worktree remove", "discardProjectCodexWorkspace"])
    assert.equal(source.includes(forbidden), false, forbidden);
});
