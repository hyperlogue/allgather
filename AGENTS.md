# Working on Allgather

Code is the only source of truth for product behavior and architecture. Read the
affected implementation, schemas, migrations, and executable tests before changing
behavior. Express intent through clear names, structure, types, and checks.

For R3 feature integration or resuming an integration, use
[`.agents/skills/sync-r3-implementation/SKILL.md`](.agents/skills/sync-r3-implementation/SKILL.md).

Avoid adding explanatory comments, docstrings, or documentation to the repository.
Keep plans, ADRs, design notes, reviews, and other prose in the gitignored
`workspace/` directory. Archived material there is historical context, not an
authoritative specification.

Development uses a direnv-managed Nix shell; the agent may already be in it, so
`nix develop` is unnecessary when the shell is active. Use `bun --no-env-file` for
automated checks. Toolchain versions and dependencies come from the manifests and
locks; dependency changes must keep `bun.lock` and generated `bun.nix` aligned.

This machine runs the owner's production instance: `allgather-server` on port
4390, data in `~/.local/state/allgather` (or the `dataDir` saved in
`~/.config/allgather/server.json`), and CLI credentials in `~/.config/allgather`.
`bun run server`, `bun run cli`, and the installed or `dist/` binaries all reach
it. Treat it as the owner's live data:

- Read and update tasks on it through the CLI as the user directs.
- Start, stop, restart, or `run` a server on it, or change its configuration,
  passkeys, or backups, only when the user asks for that action. A source server
  applies unreleased migrations irreversibly, so save a fresh
  `bun run server backup FILE` first.
- Reach its data only through the server or CLI; leave the data directory and
  its SQLite files untouched.
- Give every test or verification server fresh temporary `ALLGATHER_DATA_DIR`,
  `ALLGATHER_CONFIG_DIR`, HOME, and XDG directories, `ALLGATHER_PORT=0`, and
  unset `ALLGATHER_URL` and `ALLGATHER_TOKEN`.

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
