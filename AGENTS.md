# Working on Allgather

Code is the only source of truth for product behavior and architecture. Read the
affected implementation, schemas, migrations, and executable tests before changing
behavior. Express intent through clear names, structure, types, and checks.

For R3 feature integration or resuming an integration, use
[`skills/sync-r3-implementation/SKILL.md`](skills/sync-r3-implementation/SKILL.md).

Avoid adding explanatory comments, docstrings, or documentation to the repository.
Keep plans, ADRs, design notes, reviews, and other prose in the gitignored
`workspace/` directory. Archived material there is historical context, not an
authoritative specification.

Development uses a direnv-managed Nix shell; the agent may already be in it, so
`nix develop` is unnecessary when the shell is active. Use `bun --no-env-file` for
automated checks. Run the source-backed development instance with `bun run dev`
(foreground, reloads server and web edits) or `bun run dev:server
start|restart|status|stop`, and reach it with `bun run dev:cli`; these ignore
inherited `ALLGATHER_*` settings and never touch the installed server or its data.
`bun run server ARGS` and `bun run cli ARGS` run the same source against the
installed instance and its normal configuration; a source server applies
unreleased migrations to that database, so use them only when the user asks.
Toolchain versions and dependencies come from the manifests and
locks; dependency changes must keep `bun.lock` and generated `bun.nix` aligned.

Select Tower explicitly with `ALLGATHER_TEST_TOWER` for interoperability checks.
Use synthetic credentials and isolated child HOME/XDG directories. Distinguish
synthetic peers, actual Tower, native CLIs with synthetic providers, and live
provider verification in reports. Publication and deployment require a separate
user request.

Use small, self-contained Conventional Commits with a subsystem scope and an
imperative subject of at most 72 characters, without a final period. Stage only
your own changes by explicit path. Leave `git push` to the user. Preserve existing
authorship metadata. Keep personal identifiers, credentials, and home-directory
paths out of tracked files and commit messages.

Before code commits, run `bun --no-env-file run typecheck`,
`biome check <changed-files>`, and `bun --no-env-file test <affected-test-files>`
for directly affected unit tests. Keep this commit check set under 30 seconds
total; leave full-suite, browser, and packaging runs to CI. Report any check that
exceeds the budget or remains unverified. Commit after the selected checks pass.
For prose-only commits, run only `git diff --check`.
