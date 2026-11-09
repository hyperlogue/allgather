# Working on Allgather

Code is the only source of truth for product behavior and architecture. Read the
affected implementation, schemas, migrations, and executable tests before changing
behavior. Express intent through clear names, structure, types, and checks.

Avoid adding explanatory comments, docstrings, or documentation to the repository.
Keep plans, ADRs, design notes, reviews, and other prose in the gitignored
`workspace/` directory. Archived material there is historical context, not an
authoritative specification.

Development uses a direnv-managed Nix shell; the agent may already be in it, so
`nix develop` is unnecessary when the shell is active. Use `bun --no-env-file` for
automated checks. Toolchain versions and dependencies come from the manifests and
locks; dependency changes must keep `bun.lock` and generated `bun.nix` aligned.

Select Tower explicitly with `ALLGATHER_TEST_TOWER` for interoperability checks.
Use synthetic credentials and isolated child HOME/XDG directories. Distinguish
synthetic peers, actual Tower, native CLIs with synthetic providers, and live
provider verification in reports. Publication and deployment require a separate
user request.

Use small, self-contained Conventional Commits with a subsystem scope and an
imperative subject of at most 72 characters, without a final period. Stage only
your own changes by explicit path. Commit after the applicable checks in
`.github/workflows/ci.yml` pass; leave `git push` to the user. Preserve existing
authorship metadata. Keep personal identifiers, credentials, and home-directory
paths out of tracked files and commit messages.
