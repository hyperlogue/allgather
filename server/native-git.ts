import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError, type GitCommit, type Repository } from "../shared/contracts.ts";
import { selectTags } from "./tag-selection.ts";
export function remoteUrl(value: string, allowLocal = false) {
  if (allowLocal && (value.startsWith("/") || value.startsWith("file://"))) return value;
  if (/^[^\s/@:]+@[^\s/:]+:[^\s]+$/.test(value)) return value;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError("invalid_remote", "Use an SSH or HTTPS upstream URL");
  }
  if (
    !["ssh:", "https:"].includes(u.protocol) ||
    u.password ||
    (u.protocol === "https:" && u.username) ||
    u.search ||
    u.hash
  )
    throw new AppError(
      "invalid_remote",
      "Use an SSH or HTTPS URL without embedded secrets, query, or fragment",
    );
  return u.href.replace(/\/$/, "");
}
export function validateSelection(branches: string[], pattern: string | null) {
  for (const b of branches)
    if (
      !b ||
      b.startsWith("-") ||
      /[\s~^:?*[\\]/.test(b) ||
      b.includes("..") ||
      b.includes("@{") ||
      b.endsWith(".") ||
      b.endsWith("/") ||
      b.includes("//") ||
      b.split("/").some((x) => x.startsWith(".") || x.endsWith(".lock"))
    )
      throw new AppError("invalid_branch", `Invalid branch name: ${b}`);
  if (pattern) {
    if (/\\[1-9]|\(\?|\)[+*{]/.test(pattern))
      throw new AppError(
        "invalid_tag_regex",
        "Tag regex cannot use lookaround, backreferences, or repeated groups",
      );
    try {
      new RegExp(pattern);
    } catch {
      throw new AppError("invalid_tag_regex", "Invalid tag regex");
    }
  }
}
export interface GitCollection {
  refs: Record<string, string>;
  commits: GitCommit[];
  truncated: boolean;
  cacheMode: "filtered" | "full";
  checkpoint: { refs: Record<string, string>; depth: number };
}
async function bytes(stream: ReadableStream<Uint8Array>, limit: number, kill: () => void) {
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      length += r.value.length;
      if (length > limit) {
        kill();
        throw new AppError("git_output_limit", "Git output exceeded its bounded collection buffer");
      }
      parts.push(r.value);
    }
    return Buffer.concat(parts);
  } finally {
    reader.releaseLock();
  }
}
export class NativeGit {
  constructor(
    readonly root: string,
    readonly allowLocal = false,
  ) {}
  path(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id))
      throw new AppError("invalid_repository", "Invalid repository identity");
    return join(this.root, id);
  }
  async command(args: string[], signal: AbortSignal, input?: string, max = 64 * 1024 * 1024) {
    if (signal.aborted) throw new AppError("cancelled", "Git collection cancelled", 409);
    const proc = Bun.spawn(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "protocol.file.allow=" + (this.allowLocal ? "always" : "never"),
        ...args,
      ],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" },
        stdin: input === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const abort = () => proc.kill();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const out = bytes(proc.stdout, max, abort),
        err = bytes(proc.stderr, 1024 * 1024, abort);
      if (input !== undefined && proc.stdin && typeof proc.stdin !== "number") {
        proc.stdin.write(input);
        proc.stdin.end();
      }
      const [stdout, stderr, code] = await Promise.all([out, err, proc.exited]);
      if (code !== 0)
        throw new AppError(
          "git_failed",
          signal.aborted
            ? "Git collection cancelled"
            : `Git ${args.includes("fetch") ? "fetch" : "command"} failed: ${stderr.toString().slice(-1200)}`,
          502,
        );
      return { stdout, stderr: stderr.toString() };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async clear(id: string) {
    await rm(this.path(id), { recursive: true, force: true });
  }
  async collect(
    repo: Repository,
    checkpoint: { refs: Record<string, string>; depth: number } | null,
    signal: AbortSignal,
  ): Promise<GitCollection> {
    const url = remoteUrl(repo.upstream_url!, this.allowLocal);
    validateSelection(repo.branches, repo.tag_regex);
    const listing = (
        await this.command(
          ["ls-remote", "--heads", "--tags", "--", url],
          signal,
          undefined,
          8 * 1024 * 1024,
        )
      ).stdout.toString(),
      known = new Map<string, string>();
    for (const line of listing.trim().split("\n")) {
      const [hash, ref] = line.split("\t");
      if (/^[a-f0-9]{40,64}$/.test(hash ?? "") && ref) known.set(ref, hash);
    }
    const selected: Record<string, string> = {};
    for (const branch of repo.branches) {
      const ref = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
      const hash = known.get(ref);
      if (!hash) throw new AppError("missing_ref", `Upstream branch is missing: ${branch}`, 409);
      selected[ref] = hash;
    }
    if (repo.tag_regex) {
      const tags = [...known.keys()]
        .filter((ref) => ref.startsWith("refs/tags/") && !ref.endsWith("^{}") && ref.length <= 1100)
        .map((ref) => ref.slice(10));
      for (const tag of await selectTags(repo.tag_regex, tags, signal)) {
        const ref = "refs/tags/" + tag;
        selected[ref] = known.get(ref + "^{}") ?? known.get(ref)!;
      }
    }
    if (Object.keys(selected).length > 1000)
      throw new AppError("ref_limit", "The selection matches more than 1,000 refs");
    const path = this.path(repo.id);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await this.command(["init", "--bare", path], signal);
    await this.command(["--git-dir", path, "config", "remote.origin.url", url], signal);
    await this.command(["--git-dir", path, "config", "remote.origin.promisor", "true"], signal);
    await this.command(
      ["--git-dir", path, "config", "remote.origin.partialclonefilter", "blob:none"],
      signal,
    );
    const depth = Math.min(
      repo.max_indexed_commits ?? Infinity,
      Math.max(repo.initial_fetch_limit, (checkpoint?.depth ?? 0) + repo.backfill_count),
    );
    // A bounded shallow fetch limits supporting history even after an unrelated force push.
    const advertisedUnchanged =
      checkpoint && JSON.stringify(selected) === JSON.stringify(checkpoint.refs);
    const fetchDepth =
      checkpoint && !repo.backfill_count && !advertisedUnchanged
        ? Math.min(
            repo.max_indexed_commits ?? Infinity,
            Math.max(depth, checkpoint.depth + repo.initial_fetch_limit),
          )
        : depth;
    const specs = Object.keys(selected).map((ref, i) => `+${ref}:refs/allgather/${i}`);
    const oldRefs = (
      await this.command(
        ["--git-dir", path, "for-each-ref", "--format=%(refname)", "refs/allgather/"],
        signal,
      )
    ).stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const ref of oldRefs)
      await this.command(["--git-dir", path, "update-ref", "-d", ref], signal);
    const fetched = await this.command(
      [
        "--git-dir",
        path,
        "fetch",
        "--no-tags",
        "--force",
        `--depth=${Math.max(1, fetchDepth)}`,
        "--filter=blob:none",
        "--",
        "origin",
        ...specs,
      ],
      signal,
    );
    const types = (
      await this.command(
        ["--git-dir", path, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"],
        signal,
        undefined,
        32 * 1024 * 1024,
      )
    ).stdout.toString();
    const full =
      types.split("\n").includes("blob") ||
      /filtering not recognized|does not support filter/i.test(fetched.stderr);
    if (full && repo.cache_policy === "metadata_only") {
      await this.clear(repo.id);
      throw new AppError(
        "filter_unsupported",
        "Upstream did not provide a metadata-only fetch. Allow a full cache or use a filtering-capable upstream.",
        409,
      );
    }
    const refs: Record<string, string> = {};
    for (const [i, ref] of Object.keys(selected).entries()) {
      const hash = (
        await this.command(["--git-dir", path, "rev-parse", `refs/allgather/${i}^{commit}`], signal)
      ).stdout
        .toString()
        .trim();
      refs[ref] = hash;
    }
    const exclusions: string[] = [];
    if (checkpoint && !repo.backfill_count)
      for (const hash of Object.values(checkpoint.refs)) {
        try {
          await this.command(["--git-dir", path, "cat-file", "-e", hash], signal);
          exclusions.push("^" + hash);
        } catch {
          if (signal.aborted) throw new AppError("cancelled", "Git collection cancelled");
        }
      }
    const unchanged =
      checkpoint &&
      JSON.stringify(refs) === JSON.stringify(checkpoint.refs) &&
      !repo.backfill_count;
    const limit = checkpoint
      ? (repo.max_indexed_commits ?? Infinity)
      : Math.min(repo.initial_fetch_limit, repo.max_indexed_commits ?? Infinity);
    const hashes = unchanged
      ? []
      : (
          await this.command(
            [
              "--git-dir",
              path,
              "rev-list",
              "--date-order",
              ...(Number.isFinite(limit) ? [`--max-count=${limit + 1}`] : []),
              ...Object.values(refs),
              ...exclusions,
              "--",
            ],
            signal,
          )
        ).stdout
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean);
    const truncated =
      hashes.length > limit ||
      !!(
        await this.command(["--git-dir", path, "rev-parse", "--is-shallow-repository"], signal)
      ).stdout
        .toString()
        .includes("true");
    const commits: GitCommit[] = [];
    for (let i = 0; i < Math.min(hashes.length, limit); i += 128) {
      const batch = hashes.slice(i, Math.min(i + 128, limit));
      const data = (
        await this.command(
          ["--git-dir", path, "cat-file", "--batch"],
          signal,
          batch.join("\n") + "\n",
        )
      ).stdout;
      let offset = 0;
      for (const expected of batch) {
        const end = data.indexOf(10, offset);
        if (end < 0) throw new AppError("git_parse", "Incomplete Git object header");
        const [hash, kind, sizeText] = data.subarray(offset, end).toString().split(" "),
          size = Number(sizeText);
        if (
          hash !== expected ||
          kind !== "commit" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > 1024 * 1024 ||
          end + 1 + size > data.length
        )
          throw new AppError("git_parse", "Invalid or oversized commit object");
        const raw = data.subarray(end + 1, end + 1 + size).toString();
        offset = end + size + 2;
        const split = raw.indexOf("\n\n"),
          headers = raw.slice(0, split).split("\n");
        const identity = (kind: string) => {
          const line = headers.find((l) => l.startsWith(kind + " ")) ?? "",
            m = /^\w+ (.*) <([^>]*)> (-?\d+) ([+-]\d{4})$/.exec(line);
          if (!m) throw new AppError("git_parse", "Invalid commit identity");
          const date = new Date(Number(m[3]) * 1000);
          if (!Number.isFinite(date.getTime()))
            throw new AppError("git_parse", "Invalid commit timestamp");
          return { name: m[1], email: m[2], at: date.toISOString() };
        };
        const author = identity("author"),
          committer = identity("committer"),
          parents = headers.filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
        const commit: GitCommit = {
          id: hash,
          parents,
          message: raw.slice(split + 2),
          author: { name: author.name, email: author.email },
          committer: { name: committer.name, email: committer.email },
          authored_at: author.at,
          committed_at: committer.at,
          files: [],
          files_complete: false,
          files_observed: false,
        };
        try {
          const diff = (
            await this.command(
              [
                "--git-dir",
                path,
                "diff-tree",
                "--no-commit-id",
                "--no-renames",
                "--name-status",
                "-r",
                "-z",
                ...(parents.length ? [parents[0], hash] : ["--root", hash]),
                "--",
              ],
              signal,
              undefined,
              8 * 1024 * 1024,
            )
          ).stdout
            .toString()
            .split("\0");
          for (let j = 0; j + 1 < diff.length; j += 2) {
            const status = diff[j],
              file = diff[j + 1];
            if (!status || !file) continue;
            commit.files.push({
              path: file,
              change:
                status === "A"
                  ? "added"
                  : status === "D"
                    ? "deleted"
                    : status === "T"
                      ? "type_changed"
                      : "modified",
              additions: null,
              deletions: null,
            });
          }
          commit.files_complete = true;
          commit.files_observed = true;
        } catch {
          if (signal.aborted) throw new AppError("cancelled", "Git collection cancelled");
        }
        commits.push(commit);
      }
    }
    return {
      refs,
      commits,
      truncated,
      cacheMode: full ? "full" : "filtered",
      checkpoint: {
        refs,
        depth: Math.min(fetchDepth, Math.max(depth, repo.initial_fetch_limit + commits.length)),
      },
    };
  }
  async prune(repo: Repository, signal: AbortSignal) {
    const path = this.path(repo.id);
    await this.command(["--git-dir", path, "reflog", "expire", "--expire=now", "--all"], signal);
    await this.command(["--git-dir", path, "repack", "-Ad"], signal);
    await this.command(["--git-dir", path, "prune", "--expire=now"], signal);
  }
}
