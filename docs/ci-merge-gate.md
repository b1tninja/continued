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
  "required_status_checks": { "strict": true, "checks": [{ "context": "merge-gate", "app_id": 15368 }] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

The exact recipe, as settings:

- Require a pull request before merging, with **no required reviews** (approving count 0).
- Require the status check `merge-gate`, pinned to the GitHub Actions app (`app_id` 15368), so no other
  app or status can satisfy it by reporting the same name.
- Require branches to be up to date before merging (`strict: true`).
- Allow **squash merging only**: in Settings, General, Pull Requests, untick "Allow merge commits" and
  "Allow rebase merging" (a repository setting, separate from the protection API call above).
- Leave "Do not allow bypassing the above settings" off (`enforce_admins: false`), so admin bypass stays on.
- No merge queue (not available on a user-owned repository, see below). No force pushes, no deletions.

Failure modes to know before enabling it:

- A required check whose workflow is skipped by a **path filter** (`paths` or `paths-ignore` on the
  trigger) never reports, stays Pending and blocks the merge forever. `merge-gate.yml` therefore has no
  path filter and must not get one.
- A job skipped by a job-level `if` reports **success** to branch protection, so a gate skipped that way
  passes silently. `merge-gate` has no job-level `if`; drafts fail inside the job by design.
- Enabling protection before `merge-gate.yml` is on `main` and has run once blocks every PR, because the
  check cannot report. Merge the workflow first, confirm it reported on a PR, then enable protection.
- If Actions is frozen or disabled, `merge-gate` cannot report and every merge is blocked. Admin bypass
  is the escape hatch ("Merge without waiting for requirements", or push as admin).

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

`--combine` (read-only): `node scripts/ci/merge-ready.mjs 518 519 520 --combine` first does a fresh
`git fetch origin` of `main` and every PR head into `refs/combine/*`, then prints a pairwise matrix computed with
`git merge-tree --write-tree` (git 2.38 or newer): does PR A conflict when merged after PR B, which files,
and which of the shared files are hot. Nothing is checked out and the index and working tree are not
touched; it only writes unreferenced objects. It proves textual conflicts only, not that the combined
tree builds or passes tests, so it does not replace "Update branch" plus a green `merge-gate`.

## 6. Building the merged result (CI15)

Evidence: #553 x #557 (TS2741 in core, fixed in #573) and #587 x #588 (`evaluateRules` complexity 53 > 52,
fixed in #592) each passed every check alone and broke `main` together.

What ran on a push to `main` before this section: `Main Branch Build` (`main-build.yaml`) only republishes
the VS Code artifact of the merged PR's check run, and `Publish Extension` runs on release. Neither
type-checks or lints anything. The jobs that lint and type-check core (`core-checks`: `npx tsc --noEmit`
and `npm run lint` in `core`; likewise `gui-checks`, `binary-checks`) run only on `pull_request`, on a
05:23 UTC schedule and on dispatch, so a bad combination stays red until the next night. `merge-gate`
only waits for the PR head's own aggregates, so it cannot see the combination either.

| Option                                                          | Cost                                                                                                                                            | Catches                                                                        | Decision                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| (a) `post-merge-check.yml` on `push` to `main`                  | three small jobs (about the PR check time for tsc and lint, no tests), one issue                                                                | the break within minutes of the merge, with the commit named; does not stop it | built                       |
| (b) `strict: true` (up to date with `main`)                     | owner action; every merge needs "Update branch" and a fresh gate run, which multiplies runs on a slow queue                                     | the break before it lands, for every pair                                      | owner action, command below |
| (c) `merge-ready.mjs --trial`                                   | local, no CI cost; needs a checkout with `node_modules` to run the checks                                                                       | the break before it lands, for the PRs the person lists                        | built                       |
| (d) `merge-gate` re-run through `workflow_run` after each merge | re-runs every open PR's gate per merge and needs a token that can re-run workflows; a re-run proves nothing unless the PR head is updated first | nothing that (b) does not do better                                            | not built                   |

### (a) The post-merge check

`.github/workflows/post-merge-check.yml` runs on `push` to `main` and on dispatch (never on
`pull_request_target`). Jobs `core`, `gui` and `binary` run the same commands and local setup actions as
the PR checks (type-check and lint; no vitest, which takes longest and has not been what broke). A
`report` job keeps one open issue titled `main is red: post-merge check failed`: it comments on it when a
later run fails too, and closes it when a run is green. Permissions are `contents: read` for the
checks, plus `issues: write` in the report job only; there are no new secrets, no new actions and the
report job has no checkout. A newer push cancels the run in flight (only the latest tip matters), and a
cancelled run does not touch the issue. Not a required status: it reports after the merge, so it
shortens the time to notice, not the time to break.

### (c) The trial merge before merging

```sh
node scripts/ci/merge-ready.mjs 593 594 --trial            # plan: conflicts, projects to check
node scripts/ci/merge-ready.mjs 593 594 --trial --run      # type-check and lint the merged result
node scripts/ci/merge-ready.mjs 593 --trial --run --deps D:/code/some-checkout-with-node_modules
```

For each PR it fetches `main` and the head into `refs/combine/*`, merges them with
`git merge-tree --write-tree` (no checkout), and compares what each side changed since the merge base to
pick `core`, `gui` and `binary` (a `core` or `packages` change checks all three; docs-only checks
nothing; a head that already contains `main` needs nothing). With `--run` it creates a temporary
detached worktree of the merged commit, links `node_modules` from `--deps` (default: the current
directory) and runs the PR-check commands; afterwards it removes only the links (never the target), the
worktree and the temporary directory. It exits 1 on a conflict or a failing check. It never installs,
merges, pushes or touches the working tree or index. Run it for the PR you are about to merge after the
previous one landed, instead of waiting for "Update branch" and a full gate.

### (b) Strict mode, owner action (not applied by the PR)

Run after the commands in section 4 are decided. It replaces only the required status checks of the
protection that section 4 creates, so apply section 4 first; `strict` is already `true` there.

Recommendation: keep `strict: true`. `main` broke twice from two individually green PRs merging (#573,
#592), and the post-merge check in (a) only detects that after the fact.

Consequence: merges are serial. Each queued PR whose base has moved needs its branch updated before it
can merge: `gh pr update-branch <n> --repo b1tninja/continuous` (or a small script or loop over the open
PRs), then wait for `merge-gate` on the new head. Auto-merge does not do this. GitHub's documentation
on auto-merge does not say that it updates the branch, so a PR whose base moved stalls until someone or
something updates it. "Always suggest updating pull request branches" only shows the "Update branch"
button; it does not update anything automatically.

Alternative: leave `strict` off (`strict=false` in the command below) and rely on the post-merge check
in (a). Merges then do not need an update step, but a bad combination is found only after it lands.

Merge queue: not recommended until the aggregate test jobs also run on `merge_group`. `merge-gate` passes
on `merge_group` without testing anything (see section 1), so a queue would add no safety.

Sources: GitHub Docs, "Automatically merging a pull request"
(https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request),
"Managing suggestions to update pull request branches"
(https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-suggestions-to-update-pull-request-branches),
"About protected branches"
(https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

```sh
gh api -X PATCH repos/b1tninja/continuous/branches/main/protection/required_status_checks \
  -F strict=true -f 'checks[][context]=merge-gate' -F 'checks[][app_id]=15368'
```

Do not add `post-merge-check` to `contexts`: it only runs on `main`, so a required check by that name
would block every PR.
