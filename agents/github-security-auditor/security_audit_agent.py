#!/usr/bin/env python3
"""Defensive GitHub security audit agent.

Scans selected repositories, creates reports, applies safe dependency/config fixes,
and opens reviewable pull requests.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class Finding:
    severity: str
    category: str
    title: str
    file: str = ""
    line: str = ""
    evidence: str = ""
    fix: str = ""


@dataclass
class RepoResult:
    repo: str
    default_branch: str = "main"
    branch: str = ""
    tools_run: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    fixes_applied: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)
    pr_url: str = ""


def sh(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def add(result: RepoResult, severity: str, category: str, title: str, file: str = "", line: str = "", evidence: str = "", fix: str = "") -> None:
    result.findings.append(Finding(severity, category, title, file, line, evidence[:700], fix))


def load_config(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def parse_repos(config: dict[str, Any], override: str) -> list[str]:
    if override.strip():
        return [r.strip() for r in override.split(",") if r.strip()]
    return list(config.get("repos") or [])


def repo_dir_name(repo: str) -> str:
    return repo.replace("/", "__")


def gh_json(args: list[str]) -> Any:
    p = sh(["gh", "api", *args])
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip())
    return json.loads(p.stdout or "{}")


def clone(repo: str, root: Path) -> Path:
    dest = root / repo_dir_name(repo)
    if dest.exists():
        shutil.rmtree(dest)
    p = sh(["gh", "repo", "clone", repo, str(dest)])
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip())
    return dest


def run_npm(path: Path, result: RepoResult, mode: str) -> None:
    if not (path / "package.json").exists():
        return
    result.tools_run.append("npm audit")
    p = sh(["npm", "audit", "--json"], cwd=path)
    if p.stdout.strip():
        try:
            data = json.loads(p.stdout)
            for package, info in (data.get("vulnerabilities") or {}).items():
                sev = str(info.get("severity", "medium")).title()
                add(result, sev, "Dependency", f"Vulnerable npm package: {package}", "package-lock.json", evidence=f"Fix available: {info.get('fixAvailable')}", fix="Run safe npm audit fix, review lockfile updates, then run build/tests.")
        except Exception as exc:
            result.errors.append(f"Could not parse npm audit output: {exc}")
    if mode == "fix" and (path / "package-lock.json").exists():
        fix = sh(["npm", "audit", "fix", "--package-lock-only", "--ignore-scripts"], cwd=path)
        if fix.returncode == 0:
            result.fixes_applied.append("Ran safe npm audit fix for package-lock.json")
        else:
            result.errors.append("npm audit fix could not complete safely")


def run_pip_audit(path: Path, result: RepoResult, mode: str) -> None:
    if not (path / "requirements.txt").exists():
        return
    result.tools_run.append("pip-audit")
    p = sh(["pip-audit", "-r", "requirements.txt", "--format", "json", "--progress-spinner", "off"], cwd=path)
    if p.stdout.strip():
        try:
            data = json.loads(p.stdout)
            for dep in data.get("dependencies", []):
                for vuln in dep.get("vulns", []):
                    fixed = ", ".join(vuln.get("fix_versions") or [])
                    add(result, "High" if fixed else "Medium", "Dependency", f"Python package vulnerability: {dep.get('name')}", "requirements.txt", evidence=f"ID: {vuln.get('id')}; fixed versions: {fixed or 'not listed'}", fix="Upgrade to a fixed version and run tests.")
        except Exception as exc:
            result.errors.append(f"Could not parse pip-audit output: {exc}")
    if mode == "fix":
        fix = sh(["pip-audit", "-r", "requirements.txt", "--fix", "--progress-spinner", "off"], cwd=path)
        if fix.returncode == 0:
            result.fixes_applied.append("Attempted safe pip-audit dependency fixes")
        else:
            result.errors.append("pip-audit automatic fix could not complete safely")


def run_bandit(path: Path, result: RepoResult) -> None:
    if not any(path.rglob("*.py")):
        return
    result.tools_run.append("bandit")
    report = path / ".bandit-report.json"
    p = sh(["bandit", "-r", ".", "-x", "./.git,./venv,./.venv,./node_modules", "-f", "json", "-o", str(report)], cwd=path)
    if report.exists():
        try:
            data = json.loads(report.read_text(encoding="utf-8"))
            for item in data.get("results", []):
                add(result, str(item.get("issue_severity", "MEDIUM")).title(), "SAST", item.get("test_name", "Bandit finding"), item.get("filename", ""), str(item.get("line_number", "")), item.get("issue_text", ""), "Review the flagged code, remove unsafe calls, validate inputs, and add tests.")
        except Exception as exc:
            result.errors.append(f"Could not parse Bandit output: {exc}")
        report.unlink(missing_ok=True)
    elif p.returncode not in (0, 1):
        result.errors.append("Bandit scan failed")


def run_semgrep(path: Path, result: RepoResult) -> None:
    result.tools_run.append("semgrep")
    report = path / ".semgrep-report.json"
    p = sh(["semgrep", "scan", "--config", "p/ci", "--json", "--output", str(report)], cwd=path)
    if report.exists():
        try:
            data = json.loads(report.read_text(encoding="utf-8"))
            for item in data.get("results", []):
                msg = (item.get("extra") or {}).get("message", item.get("check_id", "Semgrep finding"))
                add(result, "Medium", "SAST", msg, item.get("path", ""), str((item.get("start") or {}).get("line", "")), f"Rule: {item.get('check_id', '')}", "Apply the rule recommendation and add a regression test.")
        except Exception as exc:
            result.errors.append(f"Could not parse Semgrep output: {exc}")
        report.unlink(missing_ok=True)
    elif p.returncode not in (0, 1):
        result.errors.append("Semgrep scan failed")


def apply_safe_fixes(path: Path, result: RepoResult) -> None:
    gitignore = path / ".gitignore"
    current = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    patterns = [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_dsa"]
    missing = [p for p in patterns if p not in current]
    if missing:
        with gitignore.open("a", encoding="utf-8") as f:
            if current and not current.endswith("\n"):
                f.write("\n")
            f.write("\n# Security: prevent sensitive files from being committed\n")
            for p in missing:
                f.write(p + "\n")
        result.fixes_applied.append("Updated .gitignore with sensitive-file patterns")

    updates = []
    if (path / "package.json").exists():
        updates.append('  - package-ecosystem: "npm"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n    open-pull-requests-limit: 5')
    if (path / "requirements.txt").exists() or (path / "pyproject.toml").exists():
        updates.append('  - package-ecosystem: "pip"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n    open-pull-requests-limit: 5')
    if updates:
        dep = path / ".github" / "dependabot.yml"
        dep.parent.mkdir(parents=True, exist_ok=True)
        content = "version: 2\nupdates:\n" + "\n".join(updates) + "\n"
        if not dep.exists() or dep.read_text(encoding="utf-8") != content:
            dep.write_text(content, encoding="utf-8")
            result.fixes_applied.append("Added/updated Dependabot configuration")


def report_markdown(path: Path, result: RepoResult, report_dir: str) -> None:
    outdir = path / report_dir
    outdir.mkdir(parents=True, exist_ok=True)
    today = dt.datetime.utcnow().strftime("%Y-%m-%d")
    outfile = outdir / f"security-audit-{today}.md"
    counts = {s: 0 for s in ["Critical", "High", "Medium", "Low"]}
    for f in result.findings:
        counts[f.severity] = counts.get(f.severity, 0) + 1
    lines = [f"# Security Audit Report — `{result.repo}`", "", f"**Date:** {today} UTC", "", "## Executive Summary", "", f"- Tools run: {', '.join(result.tools_run) if result.tools_run else 'None'}", f"- Total findings: {len(result.findings)}", f"- Automatic fixes applied: {len(result.fixes_applied)}", "", "| Severity | Count |", "|---|---:|"]
    for sev in ["Critical", "High", "Medium", "Low"]:
        lines.append(f"| {sev} | {counts.get(sev, 0)} |")
    lines += ["", "## Fixes Applied", ""]
    lines += [f"- {x}" for x in result.fixes_applied] or ["- No automatic fixes were applied."]
    lines += ["", "## Findings", ""]
    if result.findings:
        order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
        for i, f in enumerate(sorted(result.findings, key=lambda x: order.get(x.severity, 9)), 1):
            lines += [f"### {i}. [{f.severity}] {f.title}", "", f"- **Category:** {f.category}", f"- **File:** `{f.file or 'N/A'}`", f"- **Line:** `{f.line or 'N/A'}`", f"- **Evidence summary:** {f.evidence or 'No additional evidence captured.'}", f"- **How to fix:** {f.fix or 'Review and remediate according to secure coding practice.'}", ""]
    else:
        lines.append("No findings were detected by the configured tools. Continue reviewing business logic manually.")
    lines += ["", "## Verification", "", "Run the app build and tests before merging this PR."]
    if result.errors:
        lines += ["", "## Agent Warnings", ""] + [f"- {e}" for e in result.errors]
    outfile.write_text("\n".join(lines) + "\n", encoding="utf-8")


def changed_files(path: Path) -> list[str]:
    p = sh(["git", "status", "--porcelain"], cwd=path)
    return [line[3:].strip() for line in p.stdout.splitlines() if len(line) > 3]


def commit_and_pr(path: Path, result: RepoResult, mode: str) -> None:
    result.changed_files = changed_files(path)
    if not result.changed_files or mode != "fix":
        return
    sh(["git", "checkout", "-b", result.branch], cwd=path)
    sh(["git", "add", "."], cwd=path)
    commit = sh(["git", "commit", "-m", "security: audit report and safe fixes"], cwd=path)
    if commit.returncode != 0:
        result.errors.append("Nothing was committed or git commit failed")
        return
    push = sh(["git", "push", "--set-upstream", "origin", result.branch], cwd=path)
    if push.returncode != 0:
        result.errors.append("Could not push security branch")
        return
    body = textwrap.dedent(f"""
    ## Security Audit Agent PR

    This PR contains the security audit report and safe automatic fixes.

    ### Files changed
    {chr(10).join(f'- `{f}`' for f in result.changed_files)}

    ### Review required
    The agent does not auto-merge. Run the app, check the report, and confirm tests before merging.
    """).strip()
    pr = sh(["gh", "pr", "create", "--repo", result.repo, "--base", result.default_branch, "--head", result.branch, "--title", "security: audit report and safe fixes", "--body", body], cwd=path)
    if pr.returncode == 0:
        result.pr_url = pr.stdout.strip()
    else:
        result.errors.append("Could not create pull request")


def audit(repo: str, root: Path, config: dict[str, Any], mode: str) -> RepoResult:
    settings = config.get("settings") or {}
    result = RepoResult(repo=repo)
    result.branch = f"{settings.get('branch_prefix', 'security/audit-fixes')}-{dt.datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"
    try:
        result.default_branch = gh_json([f"repos/{repo}"]).get("default_branch", "main")
        path = clone(repo, root)
        run_npm(path, result, mode)
        run_pip_audit(path, result, mode)
        run_bandit(path, result)
        run_semgrep(path, result)
        if mode == "fix":
            apply_safe_fixes(path, result)
        report_markdown(path, result, settings.get("report_dir", "security-reports"))
        commit_and_pr(path, result, mode)
    except Exception as exc:
        result.errors.append(str(exc))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--mode", choices=["report", "fix"], default="fix")
    parser.add_argument("--repos", default="")
    args = parser.parse_args()
    config = load_config(Path(args.config))
    repos = parse_repos(config, args.repos)
    if not repos:
        print("No repositories configured", file=sys.stderr)
        return 1
    root = Path("/tmp/security-audit-agent")
    root.mkdir(parents=True, exist_ok=True)
    results = []
    for repo in repos:
        print(f"Auditing {repo}")
        r = audit(repo, root, config, args.mode)
        results.append(r)
        print(f"{repo}: findings={len(r.findings)} fixes={len(r.fixes_applied)} pr={r.pr_url or 'none'}")
    summary = {"generated_at": dt.datetime.utcnow().isoformat() + "Z", "mode": args.mode, "repositories": [{"repo": r.repo, "findings": len(r.findings), "fixes_applied": r.fixes_applied, "changed_files": r.changed_files, "pr_url": r.pr_url, "errors": r.errors} for r in results]}
    (root / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
