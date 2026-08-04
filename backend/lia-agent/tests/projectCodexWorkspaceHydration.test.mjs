import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { hydrateProjectCodexNodeModules } from "../dist/services/projectCodexWorkspace.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lia-hydration-test-"));
  const sourceRoot = join(root, "source");
  const worktreeRoot = join(root, "worktree");
  await Promise.all([mkdir(sourceRoot), mkdir(worktreeRoot)]);
  return { root, sourceRoot, worktreeRoot };
}

test("hydrates nested repository node_modules with links and no copied tree", async () => {
  const { sourceRoot, worktreeRoot } = await fixture();
  for (const parent of ["frontend", "backend/lia-agent"]) {
    await mkdir(join(sourceRoot, parent, "node_modules", "fixture-package"), { recursive: true });
    await writeFile(join(sourceRoot, parent, "node_modules", "fixture-package", "marker"), "source-only");
    await mkdir(join(worktreeRoot, parent), { recursive: true });
  }

  await hydrateProjectCodexNodeModules({ sourceRoot, worktreeRoot });
  for (const parent of ["frontend", "backend/lia-agent"]) {
    const destination = join(worktreeRoot, parent, "node_modules");
    assert.equal((await realpath(destination)), await realpath(join(sourceRoot, parent, "node_modules")));
    assert.equal((await readlink(destination)), relative(join(worktreeRoot, parent), join(sourceRoot, parent, "node_modules")));
  }
});

test("hydrates a repository-owned node_modules symlink to an external dependency directory", async () => {
  const { root, sourceRoot, worktreeRoot } = await fixture();
  const externalDependencies = join(root, "external", "node_modules");
  const sourceMapping = join(sourceRoot, "frontend", "node_modules");
  const destination = join(worktreeRoot, "frontend", "node_modules");
  await mkdir(externalDependencies, { recursive: true });
  await mkdir(join(sourceRoot, "frontend"));
  await mkdir(join(worktreeRoot, "frontend"));
  await symlink(externalDependencies, sourceMapping, "dir");

  await hydrateProjectCodexNodeModules({ sourceRoot, worktreeRoot });

  assert.equal(await readlink(destination), relative(join(worktreeRoot, "frontend"), sourceMapping));
  assert.equal(await realpath(destination), await realpath(externalDependencies));
});

test("fails closed for invalid repository-owned node_modules symlinks", async () => {
  for (const kind of ["broken", "file", "wrong-basename"]) {
    const { root, sourceRoot, worktreeRoot } = await fixture();
    const sourceMapping = join(sourceRoot, "app", "node_modules");
    await mkdir(join(sourceRoot, "app"));
    await mkdir(join(worktreeRoot, "app"));
    let target = join(root, "missing", "node_modules");
    if (kind === "file") {
      target = join(root, "file-target", "node_modules");
      await mkdir(join(root, "file-target"));
      await writeFile(target, "not dependencies");
    }
    if (kind === "wrong-basename") {
      target = join(root, "dependencies");
      await mkdir(target);
    }
    await symlink(target, sourceMapping, "dir");

    await assert.rejects(hydrateProjectCodexNodeModules({ sourceRoot, worktreeRoot }));
    await assert.rejects(readlink(join(worktreeRoot, "app", "node_modules")), { code: "ENOENT" });
  }
});

test("does not traverse ordinary symlinked directories looking for node_modules", async () => {
  const { root, sourceRoot, worktreeRoot } = await fixture();
  const externalDirectory = join(root, "external-tree");
  await mkdir(join(externalDirectory, "nested", "node_modules"), { recursive: true });
  await mkdir(join(worktreeRoot, "linked", "nested"), { recursive: true });
  await symlink(externalDirectory, join(sourceRoot, "linked"), "dir");

  await hydrateProjectCodexNodeModules({ sourceRoot, worktreeRoot });

  await assert.rejects(readlink(join(worktreeRoot, "linked", "nested", "node_modules")), { code: "ENOENT" });
});

test("is a no-op without source dependencies or without a matching worktree parent", async () => {
  const empty = await fixture();
  await hydrateProjectCodexNodeModules(empty);

  const missingParent = await fixture();
  await mkdir(join(missingParent.sourceRoot, "backend/lia-agent/node_modules"), { recursive: true });
  await hydrateProjectCodexNodeModules(missingParent);
  await assert.rejects(readlink(join(missingParent.worktreeRoot, "backend/lia-agent/node_modules")), { code: "ENOENT" });
});

test("refuses every existing destination type without changing it", async () => {
  for (const kind of ["file", "directory", "symlink", "broken-symlink"]) {
    const { root, sourceRoot, worktreeRoot } = await fixture();
    await mkdir(join(sourceRoot, "app/node_modules"), { recursive: true });
    await mkdir(join(worktreeRoot, "app"));
    const destination = join(worktreeRoot, "app/node_modules");
    if (kind === "file") await writeFile(destination, "keep");
    if (kind === "directory") await mkdir(destination);
    if (kind === "symlink") await symlink(sourceRoot, destination);
    if (kind === "broken-symlink") await symlink(join(root, "absent"), destination);
    await assert.rejects(hydrateProjectCodexNodeModules({ sourceRoot, worktreeRoot }));
    if (kind.endsWith("symlink")) assert.equal(await readlink(destination), kind === "symlink" ? sourceRoot : join(root, "absent"));
  }
});

test("rejects a destination parent symlink escape without writing outside the worktree", async () => {
  const parentEscape = await fixture();
  const outsideWorktree = join(parentEscape.root, "outside-worktree");
  await mkdir(join(parentEscape.sourceRoot, "app/node_modules"), { recursive: true });
  await mkdir(outsideWorktree);
  await symlink(outsideWorktree, join(parentEscape.worktreeRoot, "app"));
  await assert.rejects(hydrateProjectCodexNodeModules(parentEscape));
  await assert.rejects(readlink(join(outsideWorktree, "node_modules")), { code: "ENOENT" });
});

test("rolls back links created earlier in a failed hydration transaction", async () => {
  const { sourceRoot, worktreeRoot } = await fixture();
  for (const parent of ["a", "z"]) {
    await mkdir(join(sourceRoot, parent, "node_modules"), { recursive: true });
    await mkdir(join(worktreeRoot, parent));
  }
  await writeFile(join(worktreeRoot, "z/node_modules"), "do-not-overwrite");
  await assert.rejects(hydrateProjectCodexNodeModules({ sourceRoot, worktreeRoot }));
  await assert.rejects(readlink(join(worktreeRoot, "a/node_modules")), { code: "ENOENT" });
  assert.equal(await (await import("node:fs/promises")).readFile(join(worktreeRoot, "z/node_modules"), "utf8"), "do-not-overwrite");
});
