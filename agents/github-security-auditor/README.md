# GitHub Security Audit Agent

This agent audits selected GitHub repositories, generates vulnerability reports, applies safe automatic fixes, and opens pull requests for review.

## What it checks

- Dependency vulnerabilities in Node.js and Python projects.
- Static-code security findings using Bandit and Semgrep.
- Secret-leakage risk using detect-secrets and environment-file checks.
- Repository hygiene, including missing security workflow, missing Dependabot setup, and weak `.gitignore` coverage.

## What it fixes automatically

The agent only applies safe fixes automatically:

1. Adds or updates `.github/dependabot.yml`.
2. Adds a reusable security workflow at `.github/workflows/security.yml`.
3. Adds `.env*` and related sensitive-file patterns to `.gitignore`.
4. Runs safe dependency lockfile updates where supported.
5. Writes a human-readable Markdown report under `security-reports/`.

Code-level findings from Bandit and Semgrep are documented with remediation guidance. The agent does not blindly rewrite business logic because automated security edits can break an application.

## Required repository secret

In the control repository, add a GitHub Actions secret named:

```text
AUDIT_GITHUB_TOKEN
```

Use a fine-grained GitHub credential with access only to the repositories listed in `repo_targets.yml`. Give it repository contents and pull-request permissions so the agent can create branches and reviewable PRs.

## Running manually

From GitHub Actions, run:

```text
Security Audit Agent -> Run workflow
```

Choose `report` for reporting only or `fix` to generate reports and open safe-fix PRs.

## Local run

```bash
pip install -r agents/github-security-auditor/requirements.txt
export GH_TOKEN="your_github_credential"
python agents/github-security-auditor/security_audit_agent.py --config agents/github-security-auditor/repo_targets.yml --mode fix
```
