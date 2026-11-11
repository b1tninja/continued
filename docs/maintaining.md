# Maintaining the fork

## Watching upstream (continuedev/continue)

Upstream is no longer maintained (see `plans/upstream-signals.md`), but it is not archived, and issues, advisories and the odd release can still appear. Nothing here writes to the repository: a person reads, then opens an issue or pull request by hand.

Sources, all read-only:

- Security advisories: `gh api repos/continuedev/continue/security-advisories` (an empty list on 2026-11-10) and <https://github.com/continuedev/continue/security/advisories>.
- Release and tag feeds: <https://github.com/continuedev/continue/releases.atom> and <https://github.com/continuedev/continue/tags.atom>.
- Releases: `gh api repos/continuedev/continue/releases --jq '.[0:3][] | .tag_name, .published_at'` (newest on 2026-11-10: `v2.1.0-vscode`, 2026-06-19).
- Archive status: `gh api repos/continuedev/continue --jq '.archived, .pushed_at'`.
- Our own dependencies: Dependabot alerts and the `dependency-review` job on this repository (`docs/supply-chain.md`). An upstream advisory about a dependency we share shows up there first.

Monthly checklist (first week of the month):

1. Run the commands above. Note anything new since the previous check.
2. For an advisory or a security-labelled release: find the fixed commits, check whether the code exists in this fork (`git log -S"<symbol>" origin/main`), and open an issue here with the result either way. Port a fix by rewriting it with a test, and credit the upstream commit or pull request in the message (Apache-2.0 section 4(c)).
3. If upstream was archived or published again, update "State of upstream" in `plans/upstream-signals.md`.
4. Review Dependabot pull requests older than 30 days.
5. Record the check date in the issue or pull request that resulted, or in the next release checklist when there is nothing to report.

Reporting a vulnerability in this fork is covered by `SECURITY.md`.
