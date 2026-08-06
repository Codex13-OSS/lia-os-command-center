import assert from "node:assert/strict";
import test from "node:test";
import { executeProjectTask } from "../dist/services/projectTaskExecutionService.js";

const config = {
  host: "127.0.0.1", port: 3014, corsOrigins: [], agendaSqlitePath: "", projectRegistryPath: "", hermesRoot: "",
  hermesExecutionEnabled: true, hermesExecutable: "/bin/hermes", hermesHome: "/hermes",
  hermesUser: "hermes", hermesUserHome: "/home/hermes", hermesPath: "/bin",
  hermesProvider: "fake", hermesModel: "fake", hermesTimeoutMs: 100,
  hermesMaxQueryCharacters: 8000, logLevel: "silent",
};

const request = (overrides = {}) => ({
  projectId: "approved-project",
  instruction: "Implement the approved task.",
  priority: "normal",
  requestedCapabilities: ["repository_read", "isolated_worktree_write"],
  ...overrides,
});

const registry = (overrides = {}) => ({
  read: async () => [{
    projectId: "approved-project",
    displayName: "Approved Project",
    repositoryRoot: "/private/approved-project",
    enabled: true,
    ...overrides,
  }],
});

const proposal = (overrides = {}) => ({
  summary: "Apply a contained change",
  steps: [{
    id: "step-1",
    title: "Implement",
    objective: "Change only approved files",
    role: "implementer",
    dependsOn: [],
    requiredCapabilities: ["isolated_worktree_write"],
  }],
  executionMode: "direct",
  requiresHumanApproval: false,
  blockedActions: [],
  ...overrides,
});

function harness({ hermesResult, codexResult } = {}) {
  const calls = { hermes: [], codex: [] };
  return {
    calls,
    dependencies: {
      executeHermes: async (receivedConfig, prompt) => {
        calls.hermes.push({ receivedConfig, prompt });
        return hermesResult ?? { ok: true, response: JSON.stringify(proposal()) };
      },
      executeCodex: async (handoff) => {
        calls.codex.push(handoff);
        return codexResult ?? {
          success: true,
          executionId: "execution-123",
          status: "completed",
          summary: "Codex execution completed safely.",
        };
      },
    },
  };
}

test("executes the complete internal LÍA -> Hermes -> Codex flow", async () => {
  const fake = harness();
  const result = await executeProjectTask(config, request(), registry(), fake.dependencies);
  assert.deepEqual(result, {
    ok: true,
    status: "completed",
    executionId: "execution-123",
    summary: "Codex execution completed safely.",
  });
  assert.equal(fake.calls.hermes.length, 1);
  assert.equal(fake.calls.codex.length, 1);
  assert.equal(fake.calls.hermes[0].prompt.includes("/private/approved-project"), false);
});

test("Codex receives repositoryRoot internally and only from the authorized registry", async () => {
  const fake = harness();
  await executeProjectTask(config, request(), registry(), fake.dependencies);
  assert.equal(fake.calls.codex[0].repositoryRoot, "/private/approved-project");
  assert.equal(Object.hasOwn(request(), "repositoryRoot"), false);
});

test("fails closed for invalid, unavailable, missing, and disabled projects", async () => {
  const cases = [
    [request({ projectId: "../escape" }), registry(), "invalid_task"],
    [request(), { read: async () => { throw new Error("private registry error"); } }, "registry_unavailable"],
    [request(), { read: async () => [] }, "project_not_found"],
    [request(), registry({ enabled: false }), "project_disabled"],
    [{ projectId: "approved-project" }, registry(), "invalid_task"],
  ];
  for (const [task, source, error] of cases) {
    const fake = harness();
    const result = await executeProjectTask(config, task, source, fake.dependencies);
    assert.deepEqual(result, { ok: false, status: "failed", error });
    assert.equal(fake.calls.hermes.length, 0);
    assert.equal(fake.calls.codex.length, 0);
  }
});

test("propagates safe Hermes errors and never invokes Codex", async () => {
  for (const error of ["execution_disabled", "timeout", "execution_failed", "empty_response"]) {
    const fake = harness({ hermesResult: { ok: false, error } });
    const result = await executeProjectTask(config, request(), registry(), fake.dependencies);
    assert.deepEqual(result, { ok: false, status: "failed", error });
    assert.equal(fake.calls.codex.length, 0);
  }
});

test("uses strict JSON parsing without repair and does not invoke Codex", async () => {
  for (const response of ["```json\n{}\n```", `${JSON.stringify(proposal())}\ntrailing`]) {
    const fake = harness({ hermesResult: { ok: true, response } });
    const result = await executeProjectTask(config, request(), registry(), fake.dependencies);
    assert.equal(result.error, "invalid_hermes_json");
    assert.equal(fake.calls.codex.length, 0);
  }
});

test("rejects capability escalation before Codex", async () => {
  const escalated = proposal({
    steps: [{ id: "step-1", title: "Escalate", objective: "Push changes", role: "implementer", dependsOn: [], requiredCapabilities: ["push"] }],
  });
  const fake = harness({ hermesResult: { ok: true, response: JSON.stringify(escalated) } });
  const result = await executeProjectTask(config, request(), registry(), fake.dependencies);
  assert.deepEqual(result, { ok: false, status: "failed", error: "invalid_hermes_proposal" });
  assert.equal(fake.calls.codex.length, 0);
});

test("requires human approval for blocked actions and never invokes Codex", async () => {
  const blocked = proposal({ requiresHumanApproval: true, blockedActions: ["deploy"] });
  const fake = harness({ hermesResult: { ok: true, response: JSON.stringify(blocked) } });
  const result = await executeProjectTask(config, request(), registry(), fake.dependencies);
  assert.deepEqual(result, { ok: false, status: "failed", error: "human_approval_required" });
  assert.equal(fake.calls.codex.length, 0);
});

test("maps Codex failure without leaking execution internals", async () => {
  const fake = harness({ codexResult: {
    success: false,
    executionId: "execution-failed",
    status: "failed",
    error: "codex_execution_failed",
    summary: "Codex execution did not complete.",
    stdout: "SECRET_STDOUT",
    stderr: "SECRET_STDERR",
    repositoryRoot: "/private/approved-project",
    worktreePath: "/tmp/private-worktree",
    branch: "private-branch",
    prompt: "PRIVATE_PROMPT",
    config: { token: "SECRET_CONFIG" },
    handoff: { secret: "SECRET_HANDOFF" },
  } });
  const result = await executeProjectTask(config, request(), registry(), fake.dependencies);
  assert.deepEqual(result, {
    ok: false,
    status: "failed",
    error: "codex_execution_failed",
    executionId: "execution-failed",
    summary: "Codex execution did not complete.",
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "repositoryRoot", "worktreePath", "branch", "prompt", "stdout", "stderr",
    "config", "secret", "handoff", "/private/approved-project", "PRIVATE", "SECRET",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("never invokes Codex when Hermes executor throws", async () => {
  const fake = harness();
  fake.dependencies.executeHermes = async () => { throw new Error("SECRET"); };
  const result = await executeProjectTask(config, request(), registry(), fake.dependencies);
  assert.deepEqual(result, { ok: false, status: "failed", error: "execution_failed" });
  assert.equal(fake.calls.codex.length, 0);
});
