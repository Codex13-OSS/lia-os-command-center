import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
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
const executeFile = promisify(execFile);

async function git(cwd, ...args) {
  return executeFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function createCommittedWorkspace(id) {
  const worktree = `${PROJECT_CODEX_WORKTREE_ROOT}/${id}`;
  await rm(worktree, { recursive: true, force: true });
  await mkdir(worktree, { recursive: true });
  await git(worktree, "init");
  await git(worktree, "config", "user.name", "LIA Test");
  await git(worktree, "config", "user.email", "lia-test@example.invalid");
  await writeFile(`${worktree}/source.txt`, "before\n");
  await git(worktree, "add", "--", "source.txt");
  await git(worktree, "commit", "-m", "initial");
  return worktree;
}

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
  // Even a rich binding set that lacks local_commit (write + run_tests present)
  // must not authorize a commit: only local_commit itself in the binding set does.
  const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["repository_read", "isolated_worktree_write", "run_tests"], verified, fake.dependencies);
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

test("empty status returns nothing_to_commit after status and staged-index inspection", async () => {
  const fake = harness([
    { success: true, stdout: "", stderr: "PRIVATE" },
    { success: true, stdout: "", stderr: "PRIVATE" },
  ]);
  const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["local_commit"], verified, fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "nothing_to_commit");
  assert.equal(fake.calls.length, 2);
});

test("success uses the exact fixed argv in the exclusively derived worktree", async () => {
  const fake = harness([
    { success: true, stdout: " M secret-name.txt\0", stderr: "" },
    { success: true, stdout: "PRIVATE ADD", stderr: "" },
    { success: true, stdout: "secret-name.txt\0", stderr: "" },
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
    ["-C", worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ["-C", worktree, "add", "-A", "--", "secret-name.txt"],
    ["-C", worktree, "diff", "--cached", "--name-only", "-z"],
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

test("root, nested, and hydration-like node_modules entries are excluded while nested source stages", async () => {
  const fake = harness([
    { success: true, stdout: [
      "?? node_modules", "?? backend/lia-agent/node_modules", "?? frontend/node_modules",
      "?? packages/app/node_modules/generated.js", " M packages/app/src/view.ts", "",
    ].join("\0"), stderr: "" },
    { success: true, stdout: "", stderr: "" },
    { success: true, stdout: "packages/app/src/view.ts\0", stderr: "" },
    { success: true, stdout: "", stderr: "" },
    { success: true, stdout: `${hash}\n`, stderr: "" },
  ]);

  const result = await commitVerifiedProjectCodexWorkspace("/unused", executionId, ["local_commit"], verified, fake.dependencies);
  assert.equal(result.success, true);
  const addCalls = fake.calls.filter((call) => call.args[2] === "add");
  assert.deepEqual(addCalls.map((call) => call.args.slice(5)), [["packages/app/src/view.ts"]]);
  assert.equal(fake.calls.some((call) => call.args.some((arg) => arg.split("/").includes("node_modules"))), false);
});

test("only excluded hydration artifacts returns nothing_to_commit", async () => {
  const fake = harness([
    { success: true, stdout: "?? node_modules\0?? backend/lia-agent/node_modules\0", stderr: "" },
    { success: true, stdout: "", stderr: "" },
  ]);
  const result = await commitVerifiedProjectCodexWorkspace("/unused", executionId, ["local_commit"], verified, fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "nothing_to_commit");
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].args.slice(2), ["diff", "--cached", "--name-only", "-z"]);
});

test("staged-index defense rejects a dependency artifact before commit", async () => {
  const fake = harness([
    { success: true, stdout: " M src/safe.ts\0", stderr: "" },
    { success: true, stdout: "", stderr: "" },
    { success: true, stdout: "src/safe.ts\0vendor/node_modules\0", stderr: "" },
  ]);
  const result = await commitVerifiedProjectCodexWorkspace("/unused", executionId, ["local_commit"], verified, fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "git_stage_failed");
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls.some((call) => call.args[2] === "commit"), false);
});

test("rename touching node_modules is excluded as one change", async () => {
  const fake = harness([
    { success: true, stdout: "R  src/safe.ts\0src/node_modules/safe.ts\0", stderr: "" },
    { success: true, stdout: "", stderr: "" },
  ]);
  const result = await commitVerifiedProjectCodexWorkspace("/unused", executionId, ["local_commit"], verified, fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "nothing_to_commit");
  assert.equal(fake.calls.length, 2);
});

test("real hydration symlinks are excluded and only the legitimate edit is committed", async (context) => {
  const id = "commit-artifact-symlink-test";
  const worktree = await createCommittedWorkspace(id);
  context.after(() => rm(worktree, { recursive: true, force: true }));
  const target = "/tmp/lia-commit-artifact-dependencies";
  await mkdir(target, { recursive: true });
  context.after(() => rm(target, { recursive: true, force: true }));
  await mkdir(`${worktree}/backend/lia-agent`, { recursive: true });
  await mkdir(`${worktree}/frontend`, { recursive: true });
  await symlink(target, `${worktree}/node_modules`, "dir");
  await symlink(target, `${worktree}/backend/lia-agent/node_modules`, "dir");
  await symlink(target, `${worktree}/frontend/node_modules`, "dir");
  await writeFile(`${worktree}/source.txt`, "after\n");

  const result = await commitVerifiedProjectCodexWorkspace("/unused", id, ["local_commit"], { ...verified, executionId: id });
  assert.equal(result.success, true);
  const shown = await git(worktree, "show", "--format=", "--name-only", "-z", result.commit);
  const names = shown.stdout.split("\0").filter(Boolean);
  assert.deepEqual(names, ["source.txt"]);
  assert.equal(names.some((name) => name.split("/").includes("node_modules")), false);
});

test("real workspace containing only a hydration symlink returns nothing_to_commit", async (context) => {
  const id = "commit-artifact-only-test";
  const worktree = await createCommittedWorkspace(id);
  context.after(() => rm(worktree, { recursive: true, force: true }));
  const target = "/tmp/lia-commit-artifact-only-dependencies";
  await mkdir(target, { recursive: true });
  context.after(() => rm(target, { recursive: true, force: true }));
  await symlink(target, `${worktree}/node_modules`, "dir");
  const before = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();

  const result = await commitVerifiedProjectCodexWorkspace("/unused", id, ["local_commit"], { ...verified, executionId: id });
  assert.equal(result.success, false);
  assert.equal(result.error, "nothing_to_commit");
  assert.equal((await git(worktree, "rev-parse", "HEAD")).stdout.trim(), before);
});

test("real root and nested node_modules files and directories are excluded", async (context) => {
  const id = "commit-artifact-file-test";
  const worktree = await createCommittedWorkspace(id);
  context.after(() => rm(worktree, { recursive: true, force: true }));
  await mkdir(`${worktree}/nested`, { recursive: true });
  await mkdir(`${worktree}/deep/node_modules`, { recursive: true });
  await writeFile(`${worktree}/node_modules`, "root artifact\n");
  await writeFile(`${worktree}/nested/node_modules`, "nested artifact\n");
  await writeFile(`${worktree}/deep/node_modules/artifact.js`, "artifact\n");
  await writeFile(`${worktree}/source.txt`, "after\n");

  const result = await commitVerifiedProjectCodexWorkspace("/unused", id, ["local_commit"], { ...verified, executionId: id });
  assert.equal(result.success, true);
  const shown = await git(worktree, "show", "--format=", "--name-only", "-z", result.commit);
  assert.deepEqual(shown.stdout.split("\0").filter(Boolean), ["source.txt"]);
});

for (const [name, position, error] of [
  ["status", 0, "git_status_failed"],
  ["add", 1, "git_stage_failed"],
  ["index", 2, "git_stage_failed"],
  ["commit", 3, "git_commit_failed"],
  ["rev-parse", 4, "git_revision_failed"],
]) {
  test(`${name} failure is mapped safely and stops the sequence`, async () => {
    const results = [
      { success: true, stdout: " M private.txt\0", stderr: "" },
      { success: true, stdout: "", stderr: "" },
      { success: true, stdout: "private.txt\0", stderr: "" },
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
    { success: true, stdout: "?? private.txt\0", stderr: "" },
    { success: true, stdout: "", stderr: "" },
    { success: true, stdout: "private.txt\0", stderr: "" },
    { success: true, stdout: "", stderr: "" },
    { success: true, stdout: "not-a-hash\n", stderr: "" },
  ]);
  const result = await commitVerifiedProjectCodexWorkspace("/private/repo", executionId, ["local_commit"], verified, fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "git_revision_failed");
});

test("safe results expose no process, workspace, or filename details and retain the workspace", async () => {
  const fake = harness([
    { success: true, stdout: "?? secret-name.txt\0", stderr: "SECRET" },
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
