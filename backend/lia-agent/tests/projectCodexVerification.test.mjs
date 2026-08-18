import assert from "node:assert/strict";
import test from "node:test";
import { createStaticProjectVerificationRegistry } from "../dist/services/projectVerificationRegistry.js";
import { verifyProjectCodexWorkspace } from "../dist/services/projectCodexVerification.js";
import { PROJECT_CODEX_WORKTREE_ROOT } from "../dist/services/projectCodexWorkspace.js";

const profiles = () => [{
  projectId: "safe-project",
  checks: [
    { id: "types", executable: "npm", args: ["run", "typecheck"], timeoutMs: 30_000 },
    { id: "unit", executable: "node", args: ["--test", "dist.test.js"], timeoutMs: 60_000 },
  ],
}];

test("valid profiles are normalized and registry resolutions are independent copies", () => {
  const input = profiles();
  const registry = createStaticProjectVerificationRegistry(input);
  input[0].checks[0].args[0] = "changed";
  const first = registry.resolve("safe-project");
  assert.deepEqual(first, profiles()[0]);
  first.checks[0].args[0] = "mutated";
  first.checks.push({ id: "extra", executable: "npx", args: ["tsc"], timeoutMs: 1_000 });
  assert.deepEqual(registry.resolve("safe-project"), profiles()[0]);
  assert.equal(registry.resolve("other-project"), undefined);
});

test("duplicate projects and duplicate check ids are rejected", () => {
  assert.throws(() => createStaticProjectVerificationRegistry([...profiles(), ...profiles()]), /invalid_project_verification_registry/);
  const duplicateCheck = profiles();
  duplicateCheck[0].checks[1].id = duplicateCheck[0].checks[0].id;
  assert.throws(() => createStaticProjectVerificationRegistry(duplicateCheck), /invalid_project_verification_registry/);
});

test("unallowed executables and forbidden process tools are rejected", () => {
  for (const [executable, args] of [["bash", ["test.sh"]], ["npm", ["curl"]], ["node", ["git"]]]) {
    const value = profiles();
    value[0].checks[0] = { ...value[0].checks[0], executable, args };
    assert.throws(() => createStaticProjectVerificationRegistry(value), /invalid_project_verification_registry/);
  }
});

test("empty, NUL, oversized, and excessive args are rejected", () => {
  const badArgs = [[""], ["  "], ["safe\0unsafe"], ["x".repeat(4_097)], Array.from({ length: 17 }, () => "x")];
  for (const args of badArgs) {
    const value = profiles();
    value[0].checks[0].args = args;
    assert.throws(() => createStaticProjectVerificationRegistry(value), /invalid_project_verification_registry/);
  }
});

function harness(results = []) {
  const calls = [];
  return {
    calls,
    dependencies: {
      runner: async (request) => {
        calls.push(request);
        return results[calls.length - 1] ?? { success: true, stdout: "PRIVATE", stderr: "PRIVATE" };
      },
    },
  };
}

test("two checks succeed using only the derived workspace and exact profile commands", async () => {
  const fake = harness();
  const result = await verifyProjectCodexWorkspace(
    "/must/not/be/used",
    "safe-project",
    "execution-123",
    createStaticProjectVerificationRegistry(profiles()),
    fake.dependencies,
  );
  assert.deepEqual(result, {
    success: true,
    executionId: "execution-123",
    status: "verified",
    checksPassed: 2,
    totalChecks: 2,
    summary: "All preauthorized verification checks passed.",
  });
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls.map(({ file, args }) => ({ file, args })), [
    { file: "npm", args: ["run", "typecheck"] },
    { file: "node", args: ["--test", "dist.test.js"] },
  ]);
  for (const call of fake.calls) {
    assert.equal(call.shell, false);
    assert.equal(call.cwd, `${PROJECT_CODEX_WORKTREE_ROOT}/execution-123`);
    assert.equal(call.maxOutputBytes, 64 * 1024);
  }
});

test("the first failed check stops verification and retains the workspace", async () => {
  const fake = harness([{ success: false, reason: "failed", stdout: "SECRET", stderr: "SECRET" }]);
  const result = await verifyProjectCodexWorkspace("/repo", "safe-project", "execution-123", createStaticProjectVerificationRegistry(profiles()), fake.dependencies);
  assert.deepEqual(result, {
    success: false,
    executionId: "execution-123",
    status: "verification_failed",
    error: "check_failed",
    failedCheckId: "types",
    checksPassed: 0,
    totalChecks: 2,
    summary: "A preauthorized verification check failed.",
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls.some((call) => call.file === "git" || call.args.includes("remove") || call.args.includes("discard")), false);
});

test("timeout is safe and deterministic", async () => {
  const fake = harness([{ success: false, reason: "timeout", stdout: "SECRET", stderr: "SECRET" }]);
  const result = await verifyProjectCodexWorkspace("/repo", "safe-project", "execution-123", createStaticProjectVerificationRegistry(profiles()), fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "check_timeout");
  assert.equal(result.failedCheckId, "types");
  assert.equal(fake.calls.length, 1);
});

test("missing profile executes no process", async () => {
  const fake = harness();
  const result = await verifyProjectCodexWorkspace("/repo", "missing", "execution-123", createStaticProjectVerificationRegistry(profiles()), fake.dependencies);
  assert.equal(result.success, false);
  assert.equal(result.error, "verification_unavailable");
  assert.equal(fake.calls.length, 0);
});

test("dangerous execution ids are rejected before registry or runner", async () => {
  for (const executionId of ["../escape", "/tmp/escape", "nested/path", ""]) {
    const fake = harness();
    let resolved = false;
    const result = await verifyProjectCodexWorkspace("/repo", "safe-project", executionId, {
      resolve() { resolved = true; return profiles()[0]; },
    }, fake.dependencies);
    assert.equal(result.success, false);
    assert.equal(result.error, "invalid_generated_path");
    assert.equal(resolved, false);
    assert.equal(fake.calls.length, 0);
  }
});

test("safe responses never expose paths, output, or commands", async () => {
  for (const result of [
    await verifyProjectCodexWorkspace("/PRIVATE/repo", "safe-project", "execution-123", createStaticProjectVerificationRegistry(profiles()), harness().dependencies),
    await verifyProjectCodexWorkspace("/PRIVATE/repo", "safe-project", "execution-123", createStaticProjectVerificationRegistry(profiles()), harness([{ success: false, reason: "failed", stdout: "SECRET", stderr: "SECRET" }]).dependencies),
  ]) {
    const serialized = JSON.stringify(result);
    for (const forbidden of ["PRIVATE", "SECRET", PROJECT_CODEX_WORKTREE_ROOT, "repositoryRoot", "worktreePath", "branch", "executable", "args", "npm", "typecheck", "stdout", "stderr"])
      assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("verification service contains no workspace discard or git worktree removal", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/services/projectCodexVerification.ts", import.meta.url), "utf8"));
  assert.equal(source.includes("discardProjectCodexWorkspace"), false);
  assert.equal(source.includes("worktree remove"), false);
  assert.equal(source.includes('file: "git"'), false);
});
