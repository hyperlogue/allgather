---
name: sync-r3-implementation
description: Selectively integrate R3 features into Allgather, or resume an unfinished integration using its recorded upstream baseline.
---

Work from the Allgather repository root. `.agents/skills/sync-r3-implementation/r3.json` is the
processed upstream baseline and decision history. R3 is a behavior and code
reference; the implementation belongs to Allgather. `.agents/skills/sync-r3-implementation/r3-source.json`
records historical upstream hashes, not a requirement for local files to remain
identical. The root `LICENSE` preserves the upstream attribution and license.

## Select and inventory

1. Read current adapters, schema migrations, and tests before choosing changes.
   Start with `server/artifacts.ts`, `server/artifact-api.ts`,
   `server/artifact-migration.ts`, `cli/artifacts.ts`, and their callers.
   Run `bun --no-env-file .agents/skills/sync-r3-implementation/scripts/sync.ts audit "$R3_CHECKOUT"` to
   verify the historical source provenance against the reference checkout.
   Its hashes do not describe current Allgather files.
2. Resolve the intended upstream revision. Honor a requested branch, tag, or
   commit. Otherwise use the remote's default branch, discovered with
   `git ls-remote --symref "$R3_REPOSITORY" HEAD`, where `R3_REPOSITORY` comes from
   the integration ledger. Fetch that ref into an isolated checkout under
   `workspace/`; resolve it to a full commit. Compare the fetched hash to the
   advertised hash, retry discovery if the branch moved, and pin the result.
   A sibling checkout is useful evidence but its HEAD is not proof of latest.
   On access failure, preserve the baseline and report the failed operation.
   An explicit offline or pinned-revision request may use available objects;
   record that limitation instead of describing them as current upstream.
3. Prepare a run with
   `bun --no-env-file .agents/skills/sync-r3-implementation/scripts/sync.ts prepare "$R3_CHECKOUT" "$R3_REF" workspace/r3-integration/run.json`.
   Use a new filename for a new target. An existing file is never overwritten:
   resume its pinned target and decisions. Fill `selection.reason` with the
   source/ref, observed full hash, observation date, and why this revision is
   intended. Keep credentials and personal paths out of retained evidence.
4. Read every commit in the generated range, including merge resolutions,
   upstream tests, and the endpoint diff. The inventory includes commits whose
   changes were later reverted; explain cancellations rather than porting them.
   Synthesize features across commits and map them to Allgather behavior before
   editing. Put design notes and the transition plan under `workspace/`.

Missing objects or shallow history require obtaining the complete relevant
history first. A non-descendant target is rejected. For rewritten history,
retain the old baseline and compare both sides from their merge base, including
patch equivalence, removed changes, and retained local behavior. Present the
reconciliation and obtain the user's choice of lineage before an explicit
baseline migration; this command intentionally has no force/reset switch.

## Integrate and account

Implement equivalent behavior at Allgather's existing boundaries. Retain its
owner/session authorization, project grants, audit and receipt transactions,
shared blobs, task links, notification delivery, navigation, and packaging.
Use R3 code to understand requirements, edge cases and algorithms, then implement
them in Allgather-owned modules. Preserve attribution when reusing source. Keep
server behavior in `server/`, contracts in `shared/`, capture tools in `cli/`, and
artifact UI in `web/artifact/`. Reuse Allgather authentication, storage, theme and
navigation. Remove unused upstream application scaffolding and duplicate helpers.
Do not introduce an R3 runtime directory, compatibility wrapper tree, or parallel
application. Acceptance is observable Allgather behavior, not upstream file parity.
Adapt upstream schema changes into Allgather's migration sequence and verify
existing data upgrades, rather than replacing the initial schema snapshot.

For every commit, fill the run's `status`, `reason`, `evidence`, and `tests`:

- `integrated`: all relevant behavior is implemented or already present. Name
  the behavior, Allgather implementation paths or commits, upstream acceptance
  evidence, and executable Allgather test files. If one commit spans several
  features, account for each in its reason and evidence.
- `skipped`: intentionally outside product scope, superseded, or reverted.
  Explain the product decision with upstream and local evidence.
- `incompatible`: retain an intentional Allgather difference. Explain the
  conflict and the behavior kept, with supporting paths or tests.
- `pending` or `deferred`: unfinished work. Preserve the run and partial code
  commits, report what remains, and keep the baseline unchanged. A desired but
  postponed feature is deferred, not skipped.

The ledger's baseline means every commit through it has a final disposition,
not that Allgather implements all R3 behavior. Skipped and incompatible decisions
remain in history so later runs can revisit them. Each upstream commit must
appear exactly once; keep the generated changed-path inventory intact.

Test behavior through Allgather's adapters. Translate relevant upstream tests
into acceptance cases, covering success, rejection, persistence, and intentional
differences. Keep `tests/artifact-runtime.test.ts` in the acceptance set so runtime
modules remain independent of an upstream source tree. `acceptanceTests` covers
shared regressions; integrated entries'
`tests` identify their focused acceptance files. List paths under `tests/`.
Browser-dependent changes also need actual browser evidence recorded in the
entry before finalization; unit tests alone cannot establish visual behavior.

## Verify and advance

Follow repository commit checks for implementation and acceptance changes, then
commit them. Keep the editable run in ignored `workspace/`; keep the checkout
otherwise clean. Run
`bun --no-env-file .agents/skills/sync-r3-implementation/scripts/sync.ts finalize "$R3_CHECKOUT" workspace/r3-integration/run.json`.
It rechecks the pinned range and completeness, rejects stale baselines and
unfinished decisions, runs typecheck and the listed tests within a 30-second
budget, and records the verified Allgather commit before atomically advancing
the ledger. Check failure leaves the baseline untouched. Longer verification
needs a separately designed CI evidence path; do not bypass the gate.

Review and commit the resulting ledger. A retry of the identical completed run
is a no-op; changed retry contents are rejected. If interrupted, inspect Git
status and the ledger before retrying. Remove a leftover `.lock` or `.tmp` only
after establishing that its writer is gone; do not overwrite another run.
Report the pinned revision, implemented features, retained differences, test
results, and remaining work. Publication and deployment remain separate actions.
