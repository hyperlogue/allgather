import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{40}$/);
const text = z.string().trim().min(1);
const decision = z.object({
  commit: hash,
  status: z.enum(["pending", "integrated", "skipped", "incompatible", "deferred"]),
  reason: z.string(),
  evidence: z.array(z.string()),
  tests: z.array(z.string()),
});
const runSchema = z.object({
  baseline: hash,
  target: hash,
  selection: z.object({ ref: text, reason: z.string() }),
  commits: z.array(decision),
  changedPaths: z.array(z.string()),
  acceptanceTests: z.array(text).min(1),
});
type Run = z.infer<typeof runSchema>;
type Verification = { revision: string; commands: string[][] };
const stateSchema = z.object({
  repository: text,
  baseline: hash,
  bootstrap: z.object({ commit: hash, sourceManifest: text, acceptanceTests: z.array(text) }),
  integrations: z.array(
    runSchema.extend({
      verification: z.object({ revision: hash, commands: z.array(z.array(text)) }),
    }),
  ),
});

function command(cwd: string, args: string[], timeout = 30000) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe", timeout });
  if (result.exitCode !== 0 || result.signalCode)
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stderr.toString()}`);
  return result.stdout.toString();
}

export function git(repo: string, ...args: string[]) {
  const output = command(repo, ["git", "--no-pager", ...args]);
  return args.includes("-z") ? output : output.trim();
}

function revision(repo: string, ref: string) {
  return hash.parse(git(repo, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`));
}

export function inventory(repo: string, baseline: string, target: string) {
  if (revision(repo, baseline) !== baseline || revision(repo, target) !== target)
    throw new Error("Use full commit hashes");
  if (git(repo, "rev-parse", "--is-shallow-repository") !== "false")
    throw new Error("Complete upstream history is required");
  try {
    git(repo, "merge-base", "--is-ancestor", baseline, target);
  } catch {
    throw new Error("Non-fast-forward upstream history: reconcile explicitly; baseline unchanged");
  }
  return {
    commits: git(repo, "rev-list", "--reverse", "--topo-order", `${baseline}..${target}`)
      .split("\n")
      .filter(Boolean),
    changedPaths: git(repo, "diff", "--name-only", "-z", baseline, target, "--")
      .split("\0")
      .filter(Boolean),
  };
}

export function prepare(statePath: string, upstream: string, ref: string, runPath: string) {
  const state = stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
  const target = revision(upstream, ref);
  const changes = inventory(upstream, state.baseline, target);
  if (!changes.commits.length) throw new Error("Target is already integrated");
  const run: Run = {
    baseline: state.baseline,
    target,
    selection: { ref, reason: "" },
    commits: changes.commits.map((commit) => ({
      commit,
      status: "pending",
      reason: "",
      evidence: [],
      tests: [],
    })),
    changedPaths: changes.changedPaths,
    acceptanceTests: ["tests/artifacts.test.ts", "tests/artifact-runtime.test.ts"],
  };
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
  return run;
}

export function validateRun(upstream: string, input: unknown) {
  const run = runSchema.parse(input);
  text.parse(run.selection.reason);
  const actual = inventory(upstream, run.baseline, run.target);
  if (
    JSON.stringify(actual.commits) !== JSON.stringify(run.commits.map((item) => item.commit)) ||
    JSON.stringify(actual.changedPaths) !== JSON.stringify(run.changedPaths)
  )
    throw new Error("Upstream inventory changed or is incomplete");
  if (!actual.commits.length) throw new Error("Empty integration");
  for (const item of run.commits) {
    if (item.status === "pending" || item.status === "deferred")
      throw new Error(`Unfinished upstream commit: ${item.commit}`);
    text.parse(item.reason);
    z.array(text).min(1).parse(item.evidence);
    if (item.status === "integrated") z.array(text).min(1).parse(item.tests);
  }
  const tests = [
    ...new Set([...run.acceptanceTests, ...run.commits.flatMap((item) => item.tests)]),
  ];
  for (const path of tests) {
    if (!/^tests\/(?:[\w-]+\/)*[\w.-]+\.test\.tsx?$/.test(path))
      throw new Error(`Expected a repository test file: ${path}`);
  }
  return { run, tests };
}

function verify(root: string, tests: string[]): Verification {
  const revision = git(root, "rev-parse", "HEAD");
  const clean = () => {
    if (git(root, "status", "--porcelain"))
      throw new Error("Commit implementation and acceptance tests before finalizing");
    if (git(root, "rev-parse", "HEAD") !== revision)
      throw new Error("Checkout changed during verification");
  };
  clean();
  for (const path of tests) git(root, "ls-files", "--error-unmatch", "--", path);
  const commands = [
    ["bun", "--no-env-file", "run", "typecheck"],
    ["bun", "--no-env-file", "test", ...tests],
    ["git", "diff", "--check"],
  ];
  const deadline = Date.now() + 30000;
  for (const args of commands) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Verification exceeded 30 seconds; baseline unchanged");
    command(root, args, remaining);
  }
  if (Date.now() > deadline)
    throw new Error("Verification exceeded 30 seconds; baseline unchanged");
  clean();
  return { revision, commands };
}

export function finalize(
  root: string,
  statePath: string,
  upstream: string,
  runPath: string,
  verifier = verify,
) {
  const lock = resolve(root, git(root, "rev-parse", "--git-path", "allgather-r3-integration.lock"));
  const descriptor = openSync(lock, "wx");
  const temporary = `${statePath}.tmp`;
  try {
    const original = readFileSync(statePath, "utf8");
    const state = stateSchema.parse(JSON.parse(original));
    const { run, tests } = validateRun(upstream, JSON.parse(readFileSync(runPath, "utf8")));
    const prior = state.integrations.find((item) => item.target === run.target);
    if (prior && state.baseline === run.target) {
      const { verification: _, ...completed } = prior;
      if (JSON.stringify(completed) !== JSON.stringify(run))
        throw new Error("Retry differs from the completed integration");
      return state;
    }
    if (state.baseline !== run.baseline) throw new Error("Stale integration baseline");
    const verification = verifier(root, tests);
    const updated = stateSchema.parse({
      ...state,
      baseline: run.target,
      integrations: [...state.integrations, { ...run, verification }],
    });
    if (readFileSync(statePath, "utf8") !== original)
      throw new Error("Baseline changed concurrently");
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, statePath);
    return updated;
  } finally {
    closeSync(descriptor);
    rmSync(lock);
    rmSync(temporary, { force: true });
  }
}

export function auditImport(root: string, upstream: string) {
  const source = JSON.parse(
    readFileSync(resolve(root, "skills/sync-r3-implementation/r3-source.json"), "utf8"),
  );
  const commit = revision(upstream, source.commit);
  const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
  for (const [path, expected] of Object.entries(source.sha256)) {
    const result = Bun.spawnSync(["git", "show", `${commit}:${path}`], { cwd: upstream });
    if (result.exitCode !== 0 || digest(result.stdout) !== expected)
      throw new Error(`Import provenance mismatch: ${path}`);
  }
  return { commit, files: Object.keys(source.sha256).length };
}

if (import.meta.main) {
  const [action, upstream, refOrRun, destination] = process.argv.slice(2);
  const root = resolve(import.meta.dir, "../../..");
  const state = resolve(import.meta.dir, "../r3.json");
  if (!upstream) throw new Error("Supply the upstream checkout path");
  let result: unknown;
  if (action === "audit") result = auditImport(root, upstream);
  else if (action === "prepare" && refOrRun && destination)
    result = prepare(state, upstream, refOrRun, destination);
  else if (action === "finalize" && refOrRun) result = finalize(root, state, upstream, refOrRun);
  else
    throw new Error(
      "Usage: sync.ts audit UPSTREAM | prepare UPSTREAM REF RUN | finalize UPSTREAM RUN",
    );
  console.log(JSON.stringify(result, null, 2));
}
