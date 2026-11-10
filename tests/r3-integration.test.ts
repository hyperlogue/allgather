import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalize, git, inventory, prepare, validateRun } from "../scripts/r3-integration.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "r3-integration-"));
  directories.push(root);
  git(root, "init", "-b", "main");
  const commit = (body: string) => {
    writeFileSync(join(root, "feature.txt"), body);
    git(root, "add", "feature.txt");
    git(
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      body,
    );
    return git(root, "rev-parse", "HEAD");
  };
  const baseline = commit("baseline");
  const target = commit("new behavior");
  const statePath = join(root, "state.json");
  const runPath = join(root, "run.json");
  const state = {
    repository: "https://example.invalid/r3",
    baseline,
    bootstrap: { commit: baseline, sourceManifest: "source.json", acceptanceTests: [] },
    integrations: [],
  };
  writeFileSync(statePath, JSON.stringify(state));
  const run = prepare(statePath, root, "main", runPath);
  const save = () => writeFileSync(runPath, JSON.stringify(run));
  const finish = () => {
    run.selection.reason = `Selected local synthetic main at ${target}`;
    for (const item of run.commits) {
      item.status = "integrated";
      item.reason = "Equivalent new behavior implemented";
      item.evidence = ["feature.txt", "upstream:feature.txt"];
      item.tests = ["tests/artifacts.test.ts"];
    }
    save();
  };
  const verify = () => ({ revision: target, commands: [["synthetic-verifier"]] });
  return { root, commit, baseline, target, statePath, runPath, state, run, save, finish, verify };
}

test("prepare pins an immutable target and refuses to overwrite partial work", () => {
  const f = fixture();
  expect(f.run.target).toBe(f.target);
  expect(f.run.commits.map((item) => item.commit)).toEqual([f.target]);
  expect(f.run.changedPaths).toEqual(["feature.txt"]);
  f.finish();
  const original = readFileSync(f.runPath, "utf8");
  f.commit("later feature");
  expect(() => prepare(f.statePath, f.root, "main", f.runPath)).toThrow();
  expect(readFileSync(f.runPath, "utf8")).toBe(original);
  expect(validateRun(f.root, f.run).run.target).toBe(f.target);
});

test("all reachable commits are inventoried even when endpoint changes cancel", () => {
  const f = fixture();
  const reverted = f.commit("baseline");
  const result = inventory(f.root, f.baseline, reverted);
  expect(result.commits).toEqual([f.target, reverted]);
  expect(result.changedPaths).toEqual([]);
});

test("non-fast-forward, missing, and shallow history cannot advance the baseline", () => {
  const f = fixture();
  git(f.root, "checkout", "-b", "rewritten", f.baseline);
  const rewritten = f.commit("rewritten behavior");
  expect(() => inventory(f.root, f.target, rewritten)).toThrow("Non-fast-forward");
  expect(() => inventory(f.root, f.baseline, "0".repeat(40))).toThrow();
  writeFileSync(join(f.root, ".git/shallow"), `${rewritten}\n`);
  expect(() => inventory(f.root, f.baseline, rewritten)).toThrow("Complete upstream history");
  expect(JSON.parse(readFileSync(f.statePath, "utf8")).baseline).toBe(f.baseline);
});

test("incomplete, deferred, omitted, duplicate, and unevidenced decisions are rejected", () => {
  const f = fixture();
  f.run.selection.reason = "Pinned synthetic upstream";
  expect(() => validateRun(f.root, f.run)).toThrow("Unfinished");
  f.run.commits[0].status = "deferred";
  expect(() => validateRun(f.root, f.run)).toThrow("Unfinished");
  f.finish();
  expect(() => validateRun(f.root, { ...f.run, commits: [] })).toThrow("incomplete");
  expect(() =>
    validateRun(f.root, { ...f.run, commits: [...f.run.commits, ...f.run.commits] }),
  ).toThrow("incomplete");
  expect(() => validateRun(f.root, { ...f.run, changedPaths: [] })).toThrow("incomplete");
  f.run.commits[0].evidence = [];
  expect(() => validateRun(f.root, f.run)).toThrow();
  f.finish();
  f.run.commits[0].tests = [];
  expect(() => validateRun(f.root, f.run)).toThrow();
});

test("intentional differences retain evidence and verification when finalized", () => {
  const f = fixture();
  f.finish();
  f.run.commits[0].status = "incompatible";
  f.run.commits[0].reason = "Retain Allgather authorization";
  f.run.commits[0].tests = [];
  f.save();
  const updated = finalize(f.root, f.statePath, f.root, f.runPath, f.verify);
  expect(updated.baseline).toBe(f.target);
  expect(updated.integrations[0]?.commits[0]?.status).toBe("incompatible");
  expect(updated.integrations[0]?.verification.revision).toBe(f.target);
  expect(updated.bootstrap.commit).toBe(f.baseline);
});

test("failed verification preserves baseline and allows an identical successful retry", () => {
  const f = fixture();
  f.finish();
  const original = readFileSync(f.statePath, "utf8");
  expect(() =>
    finalize(f.root, f.statePath, f.root, f.runPath, () => {
      throw new Error("acceptance failed");
    }),
  ).toThrow("acceptance failed");
  expect(readFileSync(f.statePath, "utf8")).toBe(original);
  const updated = finalize(f.root, f.statePath, f.root, f.runPath, f.verify);
  expect(
    finalize(f.root, f.statePath, f.root, f.runPath, () => {
      throw new Error("completed retry must not rerun checks");
    }),
  ).toEqual(updated);
  f.run.commits[0].reason = "different decision";
  f.save();
  expect(() => finalize(f.root, f.statePath, f.root, f.runPath, f.verify)).toThrow("Retry differs");
});

test("stale and concurrent baseline writes are rejected", () => {
  const f = fixture();
  f.finish();
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, baseline: f.target }));
  expect(() => finalize(f.root, f.statePath, f.root, f.runPath, f.verify)).toThrow("Stale");
  writeFileSync(f.statePath, JSON.stringify(f.state));
  expect(() =>
    finalize(f.root, f.statePath, f.root, f.runPath, () => {
      expect(() => finalize(f.root, f.statePath, f.root, f.runPath, f.verify)).toThrow();
      writeFileSync(f.statePath, JSON.stringify({ ...f.state, baseline: f.target }));
      return f.verify();
    }),
  ).toThrow("concurrently");
});

test("test paths cannot escape the repository and real verification requires committed work", () => {
  const f = fixture();
  f.finish();
  f.run.acceptanceTests = ["tests/../../outside.test.ts"];
  expect(() => validateRun(f.root, f.run)).toThrow("repository test file");
  f.run.acceptanceTests = ["tests/artifacts.test.ts"];
  f.save();
  expect(() => finalize(f.root, f.statePath, f.root, f.runPath)).toThrow("Commit implementation");
});

test("real acceptance failure preserves the baseline; passing checks record the verified commit", () => {
  const f = fixture();
  f.finish();
  mkdirSync(join(f.root, "tests"));
  writeFileSync(join(f.root, ".gitignore"), "state.json\nrun.json\n");
  writeFileSync(
    join(f.root, "package.json"),
    JSON.stringify({ scripts: { typecheck: "bun --version" } }),
  );
  const testPath = join(f.root, "tests/artifacts.test.ts");
  writeFileSync(
    testPath,
    'import { test, expect } from "bun:test"; test("acceptance", () => expect(1).toBe(2));',
  );
  git(f.root, "add", ".gitignore", "package.json", "tests/artifacts.test.ts");
  f.commit("failing acceptance");
  const original = readFileSync(f.statePath, "utf8");
  expect(() => finalize(f.root, f.statePath, f.root, f.runPath)).toThrow("Command failed");
  expect(readFileSync(f.statePath, "utf8")).toBe(original);
  writeFileSync(
    testPath,
    'import { test, expect } from "bun:test"; test("acceptance", () => expect(1).toBe(1));',
  );
  git(f.root, "add", "tests/artifacts.test.ts");
  const verified = f.commit("passing acceptance");
  const updated = finalize(f.root, f.statePath, f.root, f.runPath);
  expect(updated.baseline).toBe(f.target);
  expect(updated.integrations[0]?.verification.revision).toBe(verified);
  expect(updated.integrations[0]?.verification.commands).toContainEqual([
    "bun",
    "--no-env-file",
    "test",
    "tests/artifacts.test.ts",
  ]);
});
