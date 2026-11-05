# Working on Allgather

Code is the only source of truth for product behavior and architecture. Read the
affected implementation, schemas, migrations, and executable tests before changing
behavior. Express intent through clear names, structure, types, and checks.

Avoid adding explanatory comments, docstrings, or documentation to the repository.
Keep plans, ADRs, design notes, reviews, and other prose in the gitignored
`workspace/` directory. Archived material there is historical context, not an
authoritative specification. Remove stale comments instead of maintaining a
parallel description of the code. Preserve license/provenance notices and
tool-required directives. Keep this agent guidance brief; `CLAUDE.md` points here.

Use the shared operations in `shared/contracts.ts` through `Workspace.dispatch`.
Evolve persisted data through migrations and verify upgrades using isolated data.
Adapt `server/r3/` as Allgather-owned source while preserving its license and
provenance. Managed-command tests use authenticated fixtures; inspect
`tests/fixtures/tower-controls.ts` and the HTTP integration runners.

Work in `nix develop` or the direnv shell. Use `bun --no-env-file` for automated
checks. Toolchain versions and dependencies come from the manifests and locks;
dependency changes must keep `bun.lock` and generated `bun.nix` aligned.

Use `.github/workflows/ci.yml` for the check recipe. Run focused checks plus
typecheck and lint; use the full suite for shared-contract, authentication,
storage, and cross-domain changes. Browser changes need the relevant browser
runner. Packaging changes need the compiled-package smoke test from an isolated
directory. The development watcher restarts server code; restart after frontend
edits. Documentation moves need reference and whitespace checks.

Select Tower explicitly with `ALLGATHER_TEST_TOWER` for interoperability checks.
Use synthetic credentials and isolated child HOME/XDG directories. Distinguish
synthetic peers, actual Tower, native CLIs with synthetic providers, and live
provider verification in reports. Publication and deployment require a separate
user request.
