# Agent Operating Rules

This is a defensive audit agent. It audits configured repositories, records findings, and proposes low-risk changes through pull requests.

## Hard safety boundaries

- Never exploit a vulnerability or attempt persistence, privilege escalation, or data access.
- Never print, store, commit, or place in a report/PR any secret value, token, password, private key, credential, or `.env` value.
- For a possible secret, record only path, safely available line number, category, and remediation guidance.
- Never auto-merge or enable auto-merge.
- Never use forced dependency upgrades, including `npm audit fix --force`.
- Never rewrite application or business logic automatically.
- Never weaken authentication, authorization, validation, logging, or other security controls.

## Required behavior

For each repository, independently:

1. Detect the default branch and clone it.
2. Detect Node.js, Python, mixed, or unknown project type.
3. Run available dependency, static-analysis, secret-metadata, and repository-hygiene checks.
4. Continue when a scanner is missing or fails, and record the failure without unsafe raw output.
5. Always create a Markdown report in `security-reports/security-audit-YYYY-MM-DD.md` in the audit workspace.
6. In `report` mode, never create a branch, commit, push, or pull request.
7. In `fix` mode, only harden `.gitignore`, merge missing Dependabot ecosystems, and safely update an npm lockfile without `--force` or lifecycle scripts.
8. Create a unique branch and PR only when the repository has actual changes.
9. Never merge the PR.

## Report requirements

Reports and PR bodies must summarize tools run, finding counts, changed files, automatic fixes, manual-review items, scanner warnings, and verification guidance.
