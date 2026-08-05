import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { executeProjectTaskWorkflow } from "../dist/services/projectTaskWorkflowService.js";

const config = {
  host: "127.0.0.1", port: 3014, corsOrigins: [], agendaSqlitePath: "", projectRegistryPath: "", hermesRoot: "",
  hermesExecutionEnabled: true, hermesExecutable: "/bin/hermes", hermesHome: "/hermes",
  hermesUser: "hermes", hermesUserHome: "/home/hermes", hermesPath: "/bin",
  hermesProvider: "fake", hermesModel: "fake", hermesTimeoutMs: 100,
  hermesMaxQueryCharacters: 8000, logLevel: "silent",
};

const request = (requestedCapabilities = ["repository_read", "isolated_worktree_write"], overrides = {}) => ({
  projectId: "approved-project",
  instruction: "Implement the approved task.",
  priority: "normal",
  requestedCapabilities,
  ...overrides,
});

const registry = (overrides = {}) => ({
  read: async () => [{
    projectId: "approved-project",
    displayName: "Approved Project",
    repositoryRoot: "/registry/approved-project",
    enabled: true,
    ...overrides,
  }],
});

const verificationRegistry = { resolve: () => ({ projectId: "approved-project", checks: [] }) };
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

function harness(overrides = {}) {
  const calls = { hermes: [], codex: [], verification: [], commit: [], proposalAttempts: [] };
  return {
    calls,
    dependencies: {
      executeHermes: async (...args) => {
        calls.hermes.push(args);
        if (overrides.hermesThrow) throw new Error("PRIVATE");
        const data = JSON.parse(args[1].split("<PROJECT_TASK_DATA>\n")[1].split("\n</PROJECT_TASK_DATA>")[0]);
        return (overrides.hermesSequence?.shift() ?? overrides.hermes) ?? { ok: true, response: JSON.stringify(proposal({
          steps: [{ id: "step-1", title: "Implement", objective: "Change only approved files", role: "implementer", dependsOn: [], requiredCapabilities: data.approvedCapabilities }],
        })) };
      },
      executeCodex: async (...args) => {
        calls.codex.push(args);
        if (overrides.codexThrow) throw new Error("PRIVATE");
        return overrides.codex ?? {
          success: true, executionId: "execution-123", status: "completed", summary: "Codex completed safely.",
          resultText: "Useful completion result.", outcome: "modification_completed",
        };
      },
      executeVerification: async (...args) => {
        calls.verification.push(args);
        if (overrides.verificationThrow) throw new Error("PRIVATE");
        return overrides.verification ?? {
          success: true, executionId: "execution-123", status: "verified",
          checksPassed: 2, totalChecks: 2, summary: "All checks passed.",
        };
      },
      executeCommit: async (...args) => {
        calls.commit.push(args);
        if (overrides.commitThrow) throw new Error("PRIVATE");
        return overrides.commit ?? {
          success: true, executionId: "execution-123", status: "committed",
          commit: "0123456789abcdef0123456789abcdef01234567", summary: "Committed locally.",
        };
      },
      onHermesProposalAttempt: (outcome) => calls.proposalAttempts.push(outcome),
    },
  };
}

const run = (task, fake, source = registry(), verification = verificationRegistry) =>
  executeProjectTaskWorkflow(config, task, source, verification, fake.dependencies);

test("invalid task and registry resolution failures stop during planning", async () => {
  const cases = [
    [request(undefined, { projectId: "../escape" }), registry(), "invalid_task"],
    [request(), { read: async () => { throw new Error("PRIVATE"); } }, "registry_unavailable"],
    [request(), { read: async () => [] }, "project_not_found"],
    [request(), registry({ enabled: false }), "project_disabled"],
  ];
  for (const [task, source, error] of cases) {
    const fake = harness();
    const result = await run(task, fake, source);
    assert.equal(result.stage, "planning");
    assert.equal(result.error, error);
    assert.equal(fake.calls.hermes.length, 0);
    assert.equal(fake.calls.codex.length, 0);
  }
});

test("optional observer reports only real public workflow boundaries", async () => {
  const fake = harness();
  const stages = [];
  fake.dependencies.onStage = (stage) => stages.push(stage);
  const result = await run(request(["repository_read", "isolated_worktree_write", "run_tests", "local_commit"]), fake);
  assert.equal(result.status, "committed");
  assert.deepEqual(stages, ["planning", "hermes", "codex", "verification", "commit"]);
});

test("Hermes proposal with local_commit without run_tests fails after proposal validation", async () => {
  const fake = harness();
  const result = await run(request(["repository_read", "isolated_worktree_write", "local_commit"]), fake);
  assert.equal(result.stage, "hermes");
  assert.equal(result.error, "invalid_hermes_proposal");
  assert.equal(fake.calls.codex.length, 0);
});

test("Hermes failures and strict invalid JSON stop before Codex", async () => {
  for (const fake of [
    harness({ hermes: { ok: false, error: "timeout" } }),
    harness({ hermesThrow: true }),
    harness({ hermes: { ok: true, response: "```json\n{}\n```" } }),
  ]) {
    const result = await run(request(), fake);
    assert.equal(result.stage, "hermes");
    assert.equal(fake.calls.codex.length, 0);
  }
});

test("one transient Hermes failure is retried with the identical request and then continues", async () => {
  const fake = harness();
  const stages = [];
  fake.dependencies.onStage = (stage) => stages.push(stage);
  const original = fake.dependencies.executeHermes;
  let attempt = 0;
  fake.dependencies.executeHermes = async (...args) => {
    fake.calls.hermes.push(args);
    if (attempt++ === 0) return { ok: false, error: "execution_failed" };
    const data = JSON.parse(args[1].split("<PROJECT_TASK_DATA>\n")[1].split("\n</PROJECT_TASK_DATA>")[0]);
    return { ok: true, response: JSON.stringify(proposal({ steps: [{ id: "step-1", title: "Implement", objective: "Change only approved files", role: "implementer", dependsOn: [], requiredCapabilities: data.approvedCapabilities }] })) };
  };
  void original;
  const result = await run(request(), fake);
  assert.equal(result.ok, true);
  assert.equal(fake.calls.hermes.length, 2);
  assert.strictEqual(fake.calls.hermes[0][0], fake.calls.hermes[1][0]);
  assert.equal(fake.calls.hermes[0][1], fake.calls.hermes[1][1]);
  assert.equal(fake.calls.codex.length, 1);
  assert.deepEqual(stages, ["planning", "hermes", "codex"]);
});

test("two transient Hermes failures terminalize with the safe second error", async () => {
  const fake = harness({ hermes: { ok: false, error: "execution_failed" } });
  const result = await run(request(), fake);
  assert.equal(fake.calls.hermes.length, 2);
  assert.equal(fake.calls.codex.length, 0);
  assert.equal(result.stage, "hermes");
  assert.equal(result.error, "execution_failed");
});

test("valid first Hermes proposal makes exactly one call", async () => {
  const fake = harness();
  const result = await run(request(), fake);
  assert.equal(result.ok, true);
  assert.equal(fake.calls.hermes.length, 1);
  assert.deepEqual(fake.calls.proposalAttempts, []);
});

test("invalid first JSON is repaired once and continues to Codex", async () => {
  const fake = harness({ hermesSequence: [
    { ok: true, response: "not-json" },
    { ok: true, response: JSON.stringify(proposal()) },
  ] });
  const result = await run(request(), fake);
  assert.equal(result.ok, true);
  assert.equal(fake.calls.hermes.length, 2);
  assert.equal(fake.calls.codex.length, 1);
  assert.deepEqual(fake.calls.proposalAttempts, ["initial_invalid_json", "repair_succeeded"]);
});

test("recoverably invalid first proposal is repaired once and continues to Codex", async () => {
  const fake = harness({ hermesSequence: [
    { ok: true, response: JSON.stringify({ ...proposal(), explanation: "extra" }) },
    { ok: true, response: JSON.stringify(proposal()) },
  ] });
  const result = await run(request(), fake);
  assert.equal(result.ok, true);
  assert.equal(fake.calls.codex.length, 1);
  assert.deepEqual(fake.calls.proposalAttempts, ["initial_invalid_structure", "repair_succeeded"]);
});

test("two invalid JSON responses fail closed after one repair", async () => {
  const fake = harness({ hermesSequence: [
    { ok: true, response: "not-json" }, { ok: true, response: "still-not-json" },
  ] });
  const result = await run(request(), fake);
  assert.equal(result.error, "invalid_hermes_json");
  assert.equal(fake.calls.hermes.length, 2);
  assert.equal(fake.calls.codex.length, 0);
  assert.deepEqual(fake.calls.proposalAttempts, ["initial_invalid_json", "repair_invalid_json"]);
});

test("two structurally invalid proposals fail closed after one repair", async () => {
  const fake = harness({ hermesSequence: [
    { ok: true, response: "{}" }, { ok: true, response: JSON.stringify({ summary: "still invalid" }) },
  ] });
  const result = await run(request(), fake);
  assert.equal(result.error, "invalid_hermes_proposal");
  assert.equal(fake.calls.hermes.length, 2);
  assert.equal(fake.calls.codex.length, 0);
  assert.deepEqual(fake.calls.proposalAttempts, ["initial_invalid_structure", "repair_invalid_structure"]);
});

test("capability escalation is rejected before Codex", async () => {
  const fake = harness({ hermes: { ok: true, response: JSON.stringify(proposal({
    steps: [{ id: "step-1", title: "Escalate", objective: "Run tests", role: "implementer", dependsOn: [], requiredCapabilities: ["run_tests"] }],
  })) } });
  const result = await run(request(), fake);
  assert.equal(result.stage, "hermes");
  assert.equal(result.error, "invalid_hermes_proposal");
  assert.equal(fake.calls.hermes.length, 1);
  assert.equal(fake.calls.codex.length, 0);
});

test("human approval blocks Codex", async () => {
  const fake = harness({ hermes: { ok: true, response: JSON.stringify(proposal({
    requiresHumanApproval: true, blockedActions: ["deploy"],
  })) } });
  const result = await run(request(), fake);
  assert.equal(result.stage, "approval");
  assert.equal(result.error, "human_approval_required");
  assert.equal(fake.calls.hermes.length, 1);
  assert.equal(fake.calls.codex.length, 0);
});

test("blocked actions never retry or reach Codex", async () => {
  const fake = harness({ hermes: { ok: true, response: JSON.stringify(proposal({
    requiresHumanApproval: true, blockedActions: ["deploy"],
  })) } });
  const result = await run(request(), fake);
  assert.equal(result.error, "human_approval_required");
  assert.equal(fake.calls.hermes.length, 1);
  assert.equal(fake.calls.codex.length, 0);
});

test("repair prompt preserves the same task data and never expands approved capabilities", async () => {
  const fake = harness({ hermesSequence: [
    { ok: true, response: "not-json" }, { ok: true, response: JSON.stringify(proposal({
      steps: [{ id: "step-1", title: "Read", objective: "Inspect", role: "researcher", dependsOn: [], requiredCapabilities: ["repository_read"] }],
    })) },
  ] });
  await run(request(["repository_read"]), fake);
  const taskData = (prompt) => JSON.parse(prompt.split("<PROJECT_TASK_DATA>\n")[1].split("\n</PROJECT_TASK_DATA>")[0]);
  assert.deepEqual(taskData(fake.calls.hermes[1][1]), taskData(fake.calls.hermes[0][1]));
  assert.deepEqual(taskData(fake.calls.hermes[1][1]).approvedCapabilities, ["repository_read"]);
  assert.doesNotMatch(fake.calls.hermes[1][1], /isolated_worktree_write|run_tests|local_commit/);
  assert.equal(fake.calls.codex[0][0].effectiveCapabilities.includes("repository_read"), true);
});

test("Codex safe failure is preserved", async () => {
  const fake = harness({ codex: {
    success: false, executionId: "execution-failed", status: "failed",
    error: "codex_execution_failed", summary: "Codex execution did not complete.",
  } });
  const result = await run(request(), fake);
  assert.deepEqual(result, {
    ok: false, projectId: "approved-project", executionId: "execution-failed", status: "failed",
    stage: "codex", error: "codex_execution_failed", summary: "Codex execution did not complete.",
  });
});

test("Codex success without run_tests is ready for review", async () => {
  const fake = harness();
  const result = await run(request(), fake);
  assert.deepEqual(result, {
    ok: true, projectId: "approved-project", executionId: "execution-123",
    status: "ready_for_review", executionSummary: "Codex completed safely.", resultText: "Useful completion result.",
  });
  assert.equal(fake.calls.verification.length, 0);
  assert.equal(fake.calls.commit.length, 0);
});

test("all-capability ceiling with repository_read-only proposal succeeds as analyzed without verification or commit", async () => {
  const fake = harness({ hermes: { ok: true, response: JSON.stringify(proposal({
    summary: "Inspect only",
    steps: [{ id: "step-1", title: "Inspect", objective: "Report findings", role: "researcher", dependsOn: [], requiredCapabilities: ["repository_read"] }],
  })) }, codex: {
    success: true, executionId: "execution-123", status: "completed", summary: "Codex analysis completed.",
    resultText: "Useful repository analysis.", outcome: "analysis_completed",
  } });
  const result = await run(request(["repository_read", "isolated_worktree_write", "run_tests", "local_commit"]), fake);
  assert.deepEqual(result, {
    ok: true, projectId: "approved-project", executionId: "execution-123", status: "analyzed",
    executionSummary: "Codex analysis completed.", resultText: "Useful repository analysis.",
  });
  assert.deepEqual(fake.calls.codex[0][0].effectiveCapabilities, ["repository_read"]);
  assert.equal(fake.calls.verification.length, 0);
  assert.equal(fake.calls.commit.length, 0);
});

test("missing verification registry retains the execution and does not commit", async () => {
  const fake = harness();
  const result = await executeProjectTaskWorkflow(
    config,
    request(["repository_read", "isolated_worktree_write", "run_tests"]),
    registry(),
    undefined,
    fake.dependencies,
  );
  assert.equal(result.stage, "verification");
  assert.equal(result.error, "verification_unavailable");
  assert.equal(result.executionId, "execution-123");
  assert.equal(fake.calls.verification.length, 0);
  assert.equal(fake.calls.commit.length, 0);
});

test("verification failure retains execution and never commits", async () => {
  const fake = harness({ verification: {
    success: false, executionId: "execution-123", status: "verification_failed", error: "check_failed",
    failedCheckId: "unit", checksPassed: 1, totalChecks: 2, summary: "A check failed.",
  } });
  const result = await run(request(["repository_read", "isolated_worktree_write", "run_tests", "local_commit"]), fake);
  assert.equal(result.stage, "verification");
  assert.equal(result.error, "check_failed");
  assert.equal(result.executionId, "execution-123");
  assert.equal(fake.calls.commit.length, 0);
});

test("verification success without local_commit returns verified", async () => {
  const fake = harness();
  const result = await run(request(["repository_read", "isolated_worktree_write", "run_tests"]), fake);
  assert.deepEqual(result, {
    ok: true, projectId: "approved-project", executionId: "execution-123", status: "verified",
    executionSummary: "Codex completed safely.",
    resultText: "Useful completion result.",
    verification: { status: "verified", checksPassed: 2, totalChecks: 2 },
  });
  assert.equal(fake.calls.commit.length, 0);
});

test("approved ceiling with local_commit never commits unless the binding effective set includes it", async () => {
  const fake = harness({ hermes: { ok: true, response: JSON.stringify(proposal({
    steps: [{
      id: "step-1", title: "Implement", objective: "Change only approved files",
      role: "implementer", dependsOn: [], requiredCapabilities: ["isolated_worktree_write", "run_tests"],
    }],
  })) } });
  const result = await run(request(["repository_read", "isolated_worktree_write", "run_tests", "local_commit"]), fake);
  assert.equal(result.status, "verified");
  assert.equal(fake.calls.commit.length, 0);
  assert.deepEqual(fake.calls.codex[0][0].effectiveCapabilities, ["isolated_worktree_write", "run_tests"]);
  assert.equal(fake.calls.codex[0][0].approvedCapabilities.includes("local_commit"), true);
});

test("complete simulated LÍA -> Hermes -> Codex -> verification -> local commit flow", async () => {
  const fake = harness();
  const result = await run(request(["repository_read", "isolated_worktree_write", "run_tests", "local_commit"]), fake);
  assert.deepEqual(result, {
    ok: true, projectId: "approved-project", executionId: "execution-123", status: "committed",
    executionSummary: "Codex completed safely.",
    resultText: "Final verified result: 2/2 checks passed and local commit 0123456789abcdef0123456789abcdef01234567 was created and validated.",
    verification: { status: "verified", checksPassed: 2, totalChecks: 2 },
    commit: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(fake.calls.verification[0][0], "/registry/approved-project");
  assert.equal(fake.calls.verification[0][2], "execution-123");
  assert.equal(fake.calls.commit[0][0], "/registry/approved-project");
  assert.equal(fake.calls.commit[0][1], "execution-123");
  assert.equal(fake.calls.commit[0][3].executionId, "execution-123");
  assert.equal(fake.calls.codex[0][0].repositoryRoot, "/registry/approved-project");
});

test("committed receipt excludes a conflicting earlier Codex report from visible resultText", async () => {
  const fake = harness({ codex: {
    success: true, executionId: "execution-123", status: "completed", summary: "Codex completed safely.",
    resultText: "The commit could not be created because Git could not write index.lock.",
    outcome: "modification_completed",
  } });
  const result = await run(request(["repository_read", "isolated_worktree_write", "run_tests", "local_commit"]), fake);

  assert.equal(result.status, "committed");
  assert.equal(result.commit, "0123456789abcdef0123456789abcdef01234567");
  assert.deepEqual(result.verification, { status: "verified", checksPassed: 2, totalChecks: 2 });
  assert.equal(result.resultText, "Final verified result: 2/2 checks passed and local commit 0123456789abcdef0123456789abcdef01234567 was created and validated.");
  assert.equal(result.resultText.includes("index.lock"), false);
  assert.equal(result.resultText.includes("could not be created"), false);
  assert.equal(result.resultText.length <= 6000, true);
});

test("commit failure is safe and retains the execution", async () => {
  const fake = harness({ commit: {
    success: false, executionId: "execution-123", status: "commit_failed",
    error: "git_commit_failed", summary: "The local commit could not be created.",
  } });
  const result = await run(request(["repository_read", "isolated_worktree_write", "run_tests", "local_commit"]), fake);
  assert.equal(result.stage, "commit");
  assert.equal(result.error, "git_commit_failed");
  assert.equal(result.executionId, "execution-123");
});

test("executor identity and commit hash are validated at workflow boundaries", async () => {
  const capabilities = request(["repository_read", "isolated_worktree_write", "run_tests", "local_commit"]);
  const wrongVerification = harness({ verification: {
    success: true, executionId: "other-execution", status: "verified",
    checksPassed: 2, totalChecks: 2, summary: "All checks passed.",
  } });
  const verificationResult = await run(capabilities, wrongVerification);
  assert.equal(verificationResult.stage, "verification");
  assert.equal(verificationResult.executionId, "execution-123");
  assert.equal(wrongVerification.calls.commit.length, 0);

  const invalidCommit = harness({ commit: {
    success: true, executionId: "execution-123", status: "committed",
    commit: "NOT_A_HASH", summary: "Committed locally.",
  } });
  const commitResult = await run(capabilities, invalidCommit);
  assert.equal(commitResult.stage, "commit");
  assert.equal(commitResult.error, "git_revision_failed");
  assert.equal(JSON.stringify(commitResult).includes("NOT_A_HASH"), false);
});

test("all workflow receipts exclude internal and process data", async () => {
  const results = [];
  for (const capabilities of [
    ["repository_read", "isolated_worktree_write"],
    ["repository_read", "isolated_worktree_write", "run_tests"],
    ["repository_read", "isolated_worktree_write", "run_tests", "local_commit"],
  ]) results.push(await run(request(capabilities), harness()));
  for (const result of results) {
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "repositoryRoot", "worktreePath", "branch", "prompt", "proposal", "handoff", "stdout", "stderr",
      "output", "commands", "args", "env", "secrets", "Agenda", "registry/approved-project",
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("workflow adds no discard, push, merge, deploy, production, database, or shell execution", async () => {
  const source = await readFile(new URL("../src/services/projectTaskWorkflowService.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "discardProjectCodexWorkspace", "child_process", "spawn(", "exec(", "push(", "merge(", "deploy(",
    "production_write", "database_write",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
