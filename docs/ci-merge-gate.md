# CI merge gate, nightly combination run, and serial merges

Problem this solves: PRs that were each green were merged one after another and broke `main` on the
combination (ignored `lib/` directories, a test vs a wrapper, a leak test vs new fixtures, a review
eval vs a guidance change). Causes: `main` is not branch-protected; the PR check workflows use
`paths-ignore` (docs, plans, markdown), so a docs-only PR has no checks and a required check would
never report; and a push to `main` only runs the short "Main Branch Build".

## 1. `merge-gate` (CI1)

`.github/workflows/merge-gate.yml` has one job, `merge-gate`, that always reports:

- `pull_request` (all paths, not draft), `merge_group` and `workflow_dispatch` triggers.
- Docs-only PR (every changed file, including a rename's old name, matches the `paths-ignore` list of
  the PR workflows): passes in seconds.
- Code PR: polls the checks API for the PR head SHA until `require-all-checks-to-pass` and
  `require-all-checks-to-pass-cli` have both completed. Any conclusion other than `success` fails
  the gate immediately. If those jobs have not started yet (they are queued, or the workflows have
  not been created yet) it keeps polling rather than passing. After 200 minutes (`GATE_TIMEOUT_MIN`)
  it fails with a message; re-run the job after the aggregates finish.
- Uses only the preinstalled `gh` and the built-in `GITHUB_TOKEN` with `checks: read`. No third
  party action, so there is nothing new to pin.
- Why not `needs:`: `needs` only connects jobs inside one workflow file, and the aggregates live in
  `pr-checks.yaml` and `cli-pr-checks.yml`. Why not require the aggregates directly: they never run
  for docs-only PRs, so a required check would block them forever.
- Cost: while it waits it holds one small runner. With a slow queue this can be hours; the gate job
  itself is also queued behind others. A new push cancels the previous gate run for that PR.
- `merge_group`: the PR workflows have no `merge_group` trigger, so in a merge queue the gate passes
  immediately (the PR was already gated). Do not rely on it as a merge-queue test run.

## 2. Full-suite run on `main` (CI2)

Decision: nightly plus manual dispatch, not every push.

`PR Checks` and `CLI PR Checks` already have `schedule` (05:23 and 05:41 UTC) and `workflow_dispatch`
triggers, so the nightly full suite on `main` exists and needs no `workflow_call` plumbing: the
scheduled run executes the same jobs as a PR, against the tip of `main`. Run it on demand from the
Actions tab (or `gh workflow run "PR Checks" --ref main`) after a burst of merges.

Why not on every push to `main`: jobs have been queued for hours, so a per-push full run would
queue behind itself, cancel nothing useful, and report on a SHA that is already several merges old.
With serial merges (below) plus the up-to-date requirement, the combination of two PRs is tested
before it lands; the nightly run is the backstop for whatever slips through, and a failing nightly
points at a window of at most one day of merges to bisect.

## 3. Serial-merge protocol (CI3)

Hot files that several branches touch: dialect tables, enum and registry, `loadYaml.ts`,
`evaluate.ts`, `extensions/cli/src/index.ts`, `plans/ROADMAP.md`, the recovery docs page.

1. List the PRs you intend to merge and run `node scripts/ci/merge-ready.mjs 518 519 520`. It only
   reads: per PR it shows whether the head is up to date with `main`, the `merge-gate` state and
   conflicts, then the safe order and which PRs must be updated after each merge.
2. Merge ONE PR. Do not click merge on a second one yet.
3. For each remaining PR that shares files with it (the script lists them, hot files flagged), use
   "Update branch", wait for `merge-gate` to go green again on the new head, then merge it.
4. PRs that share no files can be merged in any order, but "Update branch" is still required once
   branch protection has `strict: true`.
5. Before pushing a new directory, run `node scripts/ci/check-ignored.mjs`: it lists ignored
   directories that contain source files (the `lib/` trap that hit `bench/research/lib` and
   `bench/lab/lib`). It only sees a working tree, so it cannot run in CI.

## 4. Enabling branch protection (owner action, not applied by the PR)

Run once `merge-gate` has reported green on at least one PR (a required check that has never run
cannot be selected):

```sh
gh api -X PUT repos/b1tninja/continuous/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["merge-gate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Risks: a stuck or never-reporting required check blocks every merge. Because `enforce_admins` is
false, the owner can still merge through the "Merge without waiting for requirements" option or by
pushing; to remove the rule entirely run
`gh api -X DELETE repos/b1tninja/continuous/branches/main/protection`. `strict: true` means every
merge needs the branch updated first, which is the point, but it multiplies runs on a slow queue.
The gate itself fails after 200 minutes of waiting; re-run it.

Merge queue: it is available only for repositories owned by an organization. `b1tninja/continuous`
is user-owned (`gh api repos/b1tninja/continuous` reports owner type `User`), and
`gh api repos/b1tninja/continuous/rulesets` returns an empty list, so rulesets are readable but no
merge queue rule can be added here. If the repository moves to an organization, create a ruleset
with the `merge_queue` rule, add `merge_group` triggers to `pr-checks.yaml` and `cli-pr-checks.yml`,
and the gate will then be able to wait on real queue runs.
