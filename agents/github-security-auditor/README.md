# GitHub Security Audit Agent

The agent audits configured GitHub repositories and produces reviewable Markdown reports. In `fix` mode it can propose narrowly scoped hygiene and dependency-lock changes through pull requests; it never merges them.

## Checks and safe fixes

Checks are selected by detected project type:

- Node.js: `npm audit`
- Python: `pip-audit` and Bandit
- Any non-empty repository: Semgrep, detect-secrets metadata, and repository hygiene checks

Scanner failures and missing tools are warnings, not whole-run failures. Possible secrets are reported only by path, line number, category, and remediation guidance. Values are never included.

Automatic fixes are limited to:

- adding missing sensitive-file patterns to `.gitignore`;
- preserving existing `.github/dependabot.yml` settings while adding missing npm/pip entries;
- running `npm audit fix --package-lock-only --ignore-scripts` when a lockfile exists (never `--force`).

The agent does not rewrite application code or automatically update Python requirement pins.

## Required GitHub secret

Create an Actions secret named `AUDIT_GITHUB_TOKEN` in `raliegh2/raliegh-ai-control-center`. It is required even for report mode because the agent clones other repositories.

Use a fine-grained token scoped only to the target repositories. Report mode needs repository Contents read access. Fix mode needs Contents read/write and Pull requests read/write. Do not place the token in configuration, logs, commits, or PR text.

## Run with GitHub Actions

1. Open **Actions → Security Audit Agent → Run workflow**.
2. Select `report` for scans only or `fix` to create review PRs.
3. Optionally enter a comma-separated override such as `raliegh2/visitorcounter,raliegh2/m5-bridge`. Leave it blank to use `repo_targets.yml`.
4. Download the `security-audit-reports-*` artifact after the run.

`report` mode does not create branches, commits, or PRs. `fix` mode creates a unique branch and PR only when the report or a safe fix changes the target repository. PRs are never merged automatically.

## Local setup and run

Prerequisites: Python 3.11+, Git, GitHub CLI authenticated for the target repositories, and Node.js/npm for Node audits.

PowerShell:

```powershell
python -m pip install -r agents/github-security-auditor/requirements.txt
$env:GH_TOKEN = "<fine-grained-token>"
python agents/github-security-auditor/security_audit_agent.py --config agents/github-security-auditor/repo_targets.yml --mode report
```

Bash:

```bash
python -m pip install -r agents/github-security-auditor/requirements.txt
export GH_TOKEN='<fine-grained-token>'
python agents/github-security-auditor/security_audit_agent.py --config agents/github-security-auditor/repo_targets.yml --mode report
```

Run one or more overrides with `--repos owner/repo,owner/repo`. Use `--workspace PATH` to choose the local audit workspace. If omitted, the agent uses `$RUNNER_TEMP/security-audit-agent` on Actions and the operating-system temporary directory locally.

## Validation

```bash
python -m py_compile agents/github-security-auditor/security_audit_agent.py
python agents/github-security-auditor/security_audit_agent.py --help
```

Review every generated PR, run the repository's build/tests, and manually address unresolved findings before merging.
