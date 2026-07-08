# GitHub Security Audit Agent Operations Manual

This document explains how the audit system works, how to activate it, how to run it safely, and how to troubleshoot or disable it.

## System purpose

The control repository contains one manually triggered GitHub Actions workflow. That workflow installs the audit tools and runs `security_audit_agent.py` against the repositories in `repo_targets.yml` or an operator-provided override list.

The agent is defensive. It scans repositories, creates Markdown reports, and can propose a limited set of safe changes through pull requests. It never exploits findings and never merges its own pull requests.

## Components

| Component | Responsibility |
|---|---|
| `.github/workflows/security-audit-agent.yml` | Manual entry point, runtime setup, token injection, and report artifact upload |
| `security_audit_agent.py` | Repository selection, cloning, project detection, scanning, reporting, safe fixes, branches, commits, and PR creation |
| `repo_targets.yml` | Default target repositories and branch/report naming settings |
| `requirements.txt` | Pinned Python audit tools |
| `AGENT_INSTRUCTIONS.md` | Non-negotiable defensive behavior and safety boundaries |
| `README.md` | Short project overview and command reference |

## End-to-end flow

```text
Operator starts workflow_dispatch
             |
             v
Workflow validates AUDIT_GITHUB_TOKEN
             |
             v
Load repo override or repo_targets.yml
             |
             v
For each repository independently
  default branch -> clone -> detect stack -> run scanners
             |                              |
             |                              v
             |                    collect safe metadata only
             v
Write security-reports/security-audit-YYYY-MM-DD.md
             |
             +---- report mode: stop; upload report artifact
             |
             +---- fix mode: apply safe fixes -> check actual changes
                                      |
                                      +-- no changes: no branch or PR
                                      |
                                      +-- changes: branch -> commit -> push -> PR
                                                                  |
                                                                  v
                                                         human review only
```

One repository failure is recorded as a warning and does not stop the remaining repositories. Reports are written in a `finally` path so a scanner failure still produces an operator-visible result.

## Project detection and tools

| Detection | Checks |
|---|---|
| `package.json` | `npm audit` |
| Python manifest or Python files | `pip-audit` when a supported requirements file exists, plus Bandit |
| Both Node.js and Python indicators | All applicable Node.js and Python checks |
| Any non-empty repository | Semgrep, detect-secrets metadata scan, and hygiene checks |

Missing executables, timeouts, malformed scanner output, and non-success scanner exits become warnings. The agent does not copy arbitrary scanner stderr into reports because source snippets or credentials could appear there.

## Secret handling

The token is supplied to the workflow as `AUDIT_GITHUB_TOKEN` and exposed to GitHub CLI only through the `GH_TOKEN` environment variable. It is not stored in the repository.

If detect-secrets or a filename hygiene check identifies a possible credential, the report contains only:

- repository-relative path;
- line number when safely supplied by the scanner;
- secret category;
- remediation guidance.

The value, source line, hash, and surrounding context are intentionally omitted. A real exposed credential must be rotated and removed from Git history manually.

## Operating modes

### Report mode

Use this first. It clones and scans repositories, writes reports into the temporary audit workspace, and uploads those reports as a workflow artifact. It does not create branches, commits, pushes, or pull requests.

### Fix mode

Fix mode performs the same checks and may additionally:

- add missing sensitive-file entries to `.gitignore`;
- preserve existing Dependabot settings while adding missing npm or pip ecosystems;
- run `npm audit fix --package-lock-only --ignore-scripts` when `package-lock.json` exists.

It does not use `--force`, change Python requirement pins, modify application logic, or merge PRs. The dated report itself is a repository change, so a successful fix-mode audit normally creates a review PR containing the report even when no other safe fix is needed.

## Before activation

The workflow must exist on the repository's default branch before GitHub displays and executes its `workflow_dispatch` trigger. Therefore, PR #4 must be reviewed and merged manually before the workflow can be turned on. The audit agent must not merge that PR itself.

Confirm these prerequisites:

1. PR #4 is reviewed and merged into `main` by a human.
2. GitHub Actions is enabled for `raliegh2/raliegh-ai-control-center`.
3. The account creating the token can access every configured target repository.
4. The control repository has the `AUDIT_GITHUB_TOKEN` Actions secret.

GitHub documents manual workflows at <https://docs.github.com/en/actions/how-tos/manage-workflow-runs> and repository Actions secrets at <https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>.

## Create the fine-grained token

Use a dedicated fine-grained personal access token rather than a broad classic token.

1. In GitHub, open your profile menu.
2. Select **Settings**.
3. Open **Developer settings**.
4. Open **Personal access tokens > Fine-grained tokens**.
5. Select **Generate new token**.
6. Give it a descriptive name such as `security-audit-agent` and set a short expiration date.
7. Set the resource owner to `raliegh2`.
8. Select **Only select repositories** and choose the six target repositories.
9. Set repository permissions:
   - **Contents: Read-only** for report-only operation; or
   - **Contents: Read and write** for fix mode;
   - **Pull requests: Read and write** for fix mode;
   - **Metadata: Read-only** is automatically available.
10. Generate the token and copy it once into a password manager.

Do not add Administration, Actions, Workflows, Secrets, or other unrelated write permissions. If the repository owner is an organization with token approval enabled, complete that approval before running the workflow.

GitHub's fine-grained permission reference is at <https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens>.

## Add `AUDIT_GITHUB_TOKEN`

Browser procedure:

1. Open `raliegh2/raliegh-ai-control-center` on GitHub.
2. Select **Settings**.
3. Select **Secrets and variables > Actions**.
4. Select **New repository secret**.
5. Enter the exact name `AUDIT_GITHUB_TOKEN`.
6. Paste the fine-grained token as the value.
7. Select **Add secret**.

CLI alternative, run locally without putting the value in shell history:

```bash
gh secret set AUDIT_GITHUB_TOKEN --repo raliegh2/raliegh-ai-control-center
```

The command prompts for the value. Verify only the secret's presence, never its value:

```bash
gh secret list --repo raliegh2/raliegh-ai-control-center
```

## Turn on and run the agent

After PR #4 is merged to the default branch:

1. Open `raliegh2/raliegh-ai-control-center`.
2. Select **Actions**.
3. Select **Security Audit Agent** in the workflow list.
4. Select **Run workflow**.
5. Select the `main` branch.
6. Select `report` mode for the first run.
7. Leave **repos** blank to audit all configured targets, or enter a comma-separated subset such as `raliegh2/visitorcounter,raliegh2/m5-bridge`.
8. Select the final **Run workflow** button.

CLI equivalent for a single report-mode target:

```bash
gh workflow run security-audit-agent.yml \
  --repo raliegh2/raliegh-ai-control-center \
  --ref main \
  -f mode=report \
  -f repos=raliegh2/visitorcounter
```

Watch the newest run:

```bash
gh run watch --repo raliegh2/raliegh-ai-control-center
```

## First-run procedure

Use this rollout sequence:

1. Run `report` mode against one small repository with the override input.
2. Confirm the workflow completes and uploads `security-audit-reports-<run-id>`.
3. Download the artifact and inspect the report for secret-value suppression and sensible findings.
4. Run `report` mode against all configured targets.
5. Resolve token access or tool warnings.
6. Run `fix` mode against one repository.
7. Review the generated target-repository branch and PR. Confirm only the report, `.gitignore`, Dependabot file, or safe npm lockfile change appears.
8. Run that repository's build and test suite before manually merging.
9. Expand fix-mode use to the remaining repositories only after the pilot PR is acceptable.

## Reading results

Every report contains:

- project type and detected default branch;
- tools run;
- finding totals by severity;
- safe fixes applied;
- path, safe line number, category, non-sensitive detail, and remediation for each finding;
- manual-review items;
- scanner warnings;
- verification guidance.

Workflow artifacts are retained for 30 days. In fix mode, the same dated report is committed to the target repository under `security-reports/`.

## Reviewing generated pull requests

Before merging any generated PR:

1. Confirm the base branch is the target repository's real default branch.
2. Read the security report and validate findings manually.
3. Confirm no credential value or sensitive source context appears.
4. Inspect every changed file.
5. Reject unexpected application-code changes; the agent is not designed to make them.
6. Check Dependabot configuration was merged rather than replaced.
7. Review lockfile changes for major-version or transitive surprises.
8. Run build, test, lint, and deployment checks.
9. Merge manually only when the changes are acceptable.

## Target repository management

Edit `repo_targets.yml` to change the default list. Each entry must use `owner/repository` syntax. The workflow `repos` input replaces the configured list for that run; it does not append to it.

After adding a private repository, also add it to the fine-grained token's repository selection. Otherwise that repository will produce a clone/access warning while other targets continue.

## Troubleshooting

### Run workflow button is missing

- Confirm PR #4 has been merged and the workflow file exists on the default branch.
- Confirm Actions is enabled in repository settings.
- Confirm you have write access to manually dispatch the workflow.

### Required secret is not configured

Create the repository secret with the exact case-sensitive name `AUDIT_GITHUB_TOKEN`.

### Clone or default-branch lookup fails

- Confirm the target is selected in the fine-grained token.
- Confirm the token has not expired or been revoked.
- Confirm the repository name in `repo_targets.yml` is correct.
- For fix mode, confirm Contents and Pull requests are both read/write.

### A scanner is missing or fails

Open the workflow step log and the report's **Scanner Warnings** section. The agent continues other scanners and repositories. Re-run after correcting dependency installation or a transient registry/network failure.

### No PR appears in fix mode

Check the report and workflow summary. A PR is created only after cloning succeeds and Git reports changed files. Verify token write permissions and inspect warnings for branch, push, or PR creation failures.

### Semgrep rules cannot download

The `p/ci` ruleset requires network access during the run. Treat failure as incomplete static-analysis coverage, not a clean result, and rerun when network access is available.

## Token rotation

Rotate the token before expiration and immediately after suspected exposure:

1. Generate a replacement with the same minimal repository selection and permissions.
2. Replace the `AUDIT_GITHUB_TOKEN` secret value.
3. Run one repository in report mode.
4. Revoke the old token after the new run succeeds.

Never print the old or new token while troubleshooting.

## Disable or shut down

To stop new runs immediately, disable the workflow from **Actions > Security Audit Agent > ... > Disable workflow**, or use:

```bash
gh workflow disable security-audit-agent.yml --repo raliegh2/raliegh-ai-control-center
```

Then revoke or delete the fine-grained token. Disabling the workflow does not close existing target-repository PRs; review or close those manually. The workflow has no schedule, so it runs only when an authorized operator explicitly dispatches it.

## Security invariants

- No automatic merge or auto-merge enablement.
- No vulnerability exploitation.
- No arbitrary application-code rewrites.
- No forced npm upgrades.
- No automatic Python dependency pin changes.
- No secret values in reports, summaries, PRs, or normal logs.
- No whole-run failure solely because one target or scanner fails.
- No remote writes in report mode.
