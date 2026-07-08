#!/usr/bin/env python3
"""Defensive, fail-soft GitHub repository security auditor."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import yaml


SEVERITIES = ("Critical", "High", "Medium", "Low")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SAFE_GITIGNORE_PATTERNS = (".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_dsa", "*.p12", "*.pfx")


@dataclass
class Finding:
    severity: str
    category: str
    title: str
    path: str = ""
    line: str = ""
    detail: str = ""
    remediation: str = ""


@dataclass
class RepoResult:
    repo: str
    default_branch: str = ""
    project_type: str = "unknown"
    branch: str = ""
    tools_run: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    fixes_applied: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)
    manual_review: list[str] = field(default_factory=list)
    pr_url: str = ""


def run(command: list[str], cwd: Path | None = None, timeout: int = 900) -> subprocess.CompletedProcess[str]:
    """Run without a shell so repository-controlled strings cannot become commands."""
    try:
        return subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return subprocess.CompletedProcess(command, 127, "", f"tool not found: {command[0]}")
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(command, 124, "", f"command timed out: {command[0]}")
    except OSError as exc:
        return subprocess.CompletedProcess(command, 126, "", f"could not run {command[0]}: {type(exc).__name__}")


def warning(result: RepoResult, tool: str, process: subprocess.CompletedProcess[str]) -> None:
    # Do not copy scanner output into warnings: it may contain source text or credentials.
    reason = "missing" if process.returncode == 127 else "timed out" if process.returncode == 124 else "failed"
    result.warnings.append(f"{tool} {reason} (exit {process.returncode}); review the workflow log and rerun locally.")


def add_finding(result: RepoResult, severity: str, category: str, title: str, path: str = "", line: Any = "", detail: str = "", remediation: str = "") -> None:
    normalized = severity.title()
    if normalized not in SEVERITIES:
        normalized = "Medium"
    result.findings.append(Finding(normalized, category, title, path, str(line or ""), detail, remediation))


def load_config(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError("configuration root must be a mapping")
    return data


def parse_repos(config: dict[str, Any], override: str) -> list[str]:
    raw: Iterable[Any] = override.split(",") if override.strip() else config.get("repos") or []
    repos: list[str] = []
    for value in raw:
        repo = str(value).strip()
        if not repo:
            continue
        if not REPO_RE.fullmatch(repo):
            raise ValueError(f"invalid repository name: {repo!r}; expected owner/repository")
        if repo not in repos:
            repos.append(repo)
    return repos


def safe_repo_dir(repo: str) -> str:
    return repo.replace("/", "__")


def gh(command: list[str], cwd: Path | None = None, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return run(["gh", *command], cwd=cwd, timeout=timeout)


def discover_default_branch(repo: str, result: RepoResult) -> str:
    process = gh(["api", f"repos/{repo}", "--jq", ".default_branch"])
    branch = process.stdout.strip() if process.returncode == 0 else ""
    if branch and re.fullmatch(r"[A-Za-z0-9._/-]+", branch):
        return branch
    warning(result, "GitHub default-branch lookup", process)
    return ""


def clone_repo(repo: str, destination: Path, branch: str, result: RepoResult) -> bool:
    if destination.exists():
        shutil.rmtree(destination)
    command = ["repo", "clone", repo, str(destination), "--", "--depth", "1"]
    if branch:
        command.extend(["--branch", branch])
    process = gh(command, timeout=600)
    if process.returncode != 0:
        warning(result, "repository clone", process)
        destination.mkdir(parents=True, exist_ok=True)
        return False
    if not result.default_branch:
        symbolic = run(["git", "symbolic-ref", "--short", "HEAD"], cwd=destination)
        candidate = symbolic.stdout.strip()
        result.default_branch = candidate if candidate else next((b for b in ("main", "master", "dev") if (destination / ".git" / "refs" / "heads" / b).exists()), "main")
    return True


def detect_project_type(path: Path) -> str:
    node = (path / "package.json").is_file()
    python = any((path / name).is_file() for name in ("requirements.txt", "pyproject.toml", "Pipfile", "setup.py")) or any(path.rglob("*.py"))
    return "mixed" if node and python else "node" if node else "python" if python else "unknown"


def run_npm_audit(path: Path, result: RepoResult) -> None:
    if not (path / "package.json").is_file():
        return
    result.tools_run.append("npm audit")
    process = run(["npm", "audit", "--json", "--ignore-scripts"], cwd=path)
    try:
        data = json.loads(process.stdout) if process.stdout.strip() else {}
        for package, info in (data.get("vulnerabilities") or {}).items():
            add_finding(result, info.get("severity", "medium"), "Dependency", f"Vulnerable npm dependency: {package}", "package-lock.json", detail="A dependency advisory was reported by npm audit.", remediation="Review the advisory and apply a compatible update, then run the full test suite.")
    except (json.JSONDecodeError, AttributeError, TypeError):
        warning(result, "npm audit output parsing", process)
    if process.returncode not in (0, 1):
        warning(result, "npm audit", process)


def python_requirement_file(path: Path) -> Path | None:
    for name in ("requirements.txt", "requirements-dev.txt"):
        candidate = path / name
        if candidate.is_file():
            return candidate
    return None


def run_pip_audit(path: Path, result: RepoResult) -> None:
    requirements = python_requirement_file(path)
    if not requirements:
        result.warnings.append("pip-audit skipped: no supported requirements file was found.")
        return
    result.tools_run.append("pip-audit")
    process = run(["pip-audit", "-r", requirements.name, "--format", "json", "--progress-spinner", "off"], cwd=path)
    try:
        data = json.loads(process.stdout) if process.stdout.strip() else {}
        for dependency in data.get("dependencies", []):
            for vulnerability in dependency.get("vulns", []):
                identifier = vulnerability.get("id", "advisory")
                add_finding(result, "High", "Dependency", f"Python dependency advisory: {identifier}", requirements.name, detail=f"Affected package: {dependency.get('name', 'unknown')}", remediation="Select a compatible fixed version and verify it with application tests.")
    except (json.JSONDecodeError, AttributeError, TypeError):
        warning(result, "pip-audit output parsing", process)
    if process.returncode not in (0, 1):
        warning(result, "pip-audit", process)


def run_bandit(path: Path, result: RepoResult) -> None:
    if not any(path.rglob("*.py")):
        return
    result.tools_run.append("bandit")
    process = run(["bandit", "-r", ".", "-x", ".git,.venv,venv,node_modules", "-f", "json", "-q"], cwd=path)
    try:
        data = json.loads(process.stdout) if process.stdout.strip() else {}
        for item in data.get("results", []):
            add_finding(result, item.get("issue_severity", "medium"), "Static analysis", item.get("test_name", "Bandit finding"), item.get("filename", ""), item.get("line_number", ""), item.get("issue_text", "Security-sensitive Python pattern detected."), "Review the flagged code and add a regression test for the defensive change.")
    except (json.JSONDecodeError, AttributeError, TypeError):
        warning(result, "Bandit output parsing", process)
    if process.returncode not in (0, 1):
        warning(result, "Bandit", process)


def run_semgrep(path: Path, result: RepoResult) -> None:
    if not any(item.is_file() for item in path.iterdir()):
        result.warnings.append("Semgrep skipped: repository is empty.")
        return
    result.tools_run.append("semgrep")
    process = run(["semgrep", "scan", "--config", "p/ci", "--json", "--quiet"], cwd=path, timeout=1200)
    try:
        data = json.loads(process.stdout) if process.stdout.strip() else {}
        for item in data.get("results", []):
            extra = item.get("extra") or {}
            metadata = extra.get("metadata") or {}
            severity = str(extra.get("severity") or metadata.get("impact") or "medium")
            add_finding(result, severity, "Static analysis", item.get("check_id", "Semgrep finding"), item.get("path", ""), (item.get("start") or {}).get("line", ""), "A Semgrep rule matched this location.", "Review the rule guidance, validate reachability, and test any code change manually.")
    except (json.JSONDecodeError, AttributeError, TypeError):
        warning(result, "Semgrep output parsing", process)
    if process.returncode not in (0, 1):
        warning(result, "Semgrep", process)


def run_secret_metadata_scan(path: Path, result: RepoResult) -> None:
    result.tools_run.append("detect-secrets")
    process = run(["detect-secrets", "scan", "--all-files", "--exclude-files", r"(^|/)(\.git|node_modules|\.venv|venv)/"], cwd=path)
    try:
        data = json.loads(process.stdout) if process.stdout.strip() else {}
        for file_path, candidates in (data.get("results") or {}).items():
            for candidate in candidates:
                # Deliberately ignore hashed_secret and all source context.
                add_finding(result, "Critical", "Possible secret", candidate.get("type", "Potential credential"), file_path, candidate.get("line_number", ""), "A possible secret was detected; its value was suppressed.", "Rotate the credential if real, remove it from history, and load it from an approved secret store.")
    except (json.JSONDecodeError, AttributeError, TypeError):
        warning(result, "detect-secrets output parsing", process)
    if process.returncode not in (0, 1):
        warning(result, "detect-secrets", process)


def repository_hygiene(path: Path, result: RepoResult) -> None:
    result.tools_run.append("repository hygiene")
    tracked = run(["git", "ls-files"], cwd=path)
    if tracked.returncode != 0:
        warning(result, "tracked-file hygiene check", tracked)
        names: list[str] = []
    else:
        names = tracked.stdout.splitlines()
    sensitive_names = re.compile(r"(^|/)(\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$", re.I)
    for name in names:
        if sensitive_names.search(name):
            add_finding(result, "Critical", "Repository hygiene", "Sensitive-looking file is tracked", name, detail="Only the filename was inspected; file contents were not reported.", remediation="Confirm whether it contains a credential, rotate if needed, remove it from Git history, and add an ignore rule.")
    if not (path / ".github" / "dependabot.yml").is_file() and not (path / ".github" / "dependabot.yaml").is_file():
        add_finding(result, "Low", "Repository hygiene", "Dependabot configuration is missing", ".github/dependabot.yml", remediation="Enable scheduled dependency update pull requests.")
    gitignore = path / ".gitignore"
    entries = set(gitignore.read_text(encoding="utf-8", errors="replace").splitlines()) if gitignore.is_file() else set()
    missing = [pattern for pattern in SAFE_GITIGNORE_PATTERNS if pattern not in entries]
    if missing:
        add_finding(result, "Low", "Repository hygiene", "Sensitive-file ignore patterns are incomplete", ".gitignore", detail=f"Missing pattern count: {len(missing)}", remediation="Add the standard sensitive-file ignore patterns after checking for already tracked files.")


def merge_dependabot(path: Path, ecosystems: list[str], result: RepoResult) -> None:
    if not ecosystems:
        return
    target = path / ".github" / "dependabot.yml"
    alternate = path / ".github" / "dependabot.yaml"
    target = alternate if alternate.exists() else target
    data: dict[str, Any] = {}
    if target.exists():
        try:
            loaded = yaml.safe_load(target.read_text(encoding="utf-8")) or {}
            if not isinstance(loaded, dict):
                raise ValueError
            data = loaded
        except (yaml.YAMLError, ValueError):
            result.warnings.append(f"Dependabot fix skipped: {target.relative_to(path)} is not a valid mapping.")
            result.manual_review.append("Repair the existing Dependabot YAML manually.")
            return
    updates = data.get("updates")
    if updates is None:
        updates = []
    if not isinstance(updates, list):
        result.warnings.append("Dependabot fix skipped: updates is not a list.")
        return
    existing = {(item.get("package-ecosystem"), item.get("directory", "/")) for item in updates if isinstance(item, dict)}
    changed = False
    for ecosystem in ecosystems:
        if (ecosystem, "/") not in existing:
            updates.append({"package-ecosystem": ecosystem, "directory": "/", "schedule": {"interval": "weekly"}, "open-pull-requests-limit": 5})
            changed = True
    if changed:
        data["version"] = 2
        data["updates"] = updates
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        result.fixes_applied.append("Added missing ecosystems to Dependabot configuration without replacing existing entries.")


def apply_safe_fixes(path: Path, result: RepoResult) -> None:
    gitignore = path / ".gitignore"
    original = gitignore.read_text(encoding="utf-8", errors="replace") if gitignore.exists() else ""
    entries = set(original.splitlines())
    missing = [pattern for pattern in SAFE_GITIGNORE_PATTERNS if pattern not in entries]
    if missing:
        prefix = "" if not original or original.endswith("\n") else "\n"
        block = "\n# Security: local credentials and private keys\n" + "\n".join(missing) + "\n"
        gitignore.write_text(original + prefix + block, encoding="utf-8")
        result.fixes_applied.append("Added missing sensitive-file patterns to .gitignore.")
    ecosystems = []
    if (path / "package.json").is_file():
        ecosystems.append("npm")
    if any((path / name).is_file() for name in ("requirements.txt", "pyproject.toml", "Pipfile")):
        ecosystems.append("pip")
    merge_dependabot(path, ecosystems, result)
    if (path / "package.json").is_file() and (path / "package-lock.json").is_file():
        process = run(["npm", "audit", "fix", "--package-lock-only", "--ignore-scripts"], cwd=path)
        if process.returncode in (0, 1):
            result.fixes_applied.append("Ran npm's non-forced package-lock-only audit fix with lifecycle scripts disabled.")
        else:
            warning(result, "safe npm lockfile update", process)


def git_changed_files(path: Path) -> list[str]:
    process = run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=path)
    if process.returncode != 0:
        return []
    return sorted({line[3:].strip().strip('"') for line in process.stdout.splitlines() if len(line) > 3})


def report_path(path: Path, report_dir: str) -> Path:
    directory = path / report_dir
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"security-audit-{dt.datetime.now(dt.timezone.utc):%Y-%m-%d}.md"


def write_report(path: Path, result: RepoResult, report_dir: str) -> Path:
    counts = {severity: sum(f.severity == severity for f in result.findings) for severity in SEVERITIES}
    lines = [
        f"# Security Audit Report — `{result.repo}`", "",
        f"**Date:** {dt.datetime.now(dt.timezone.utc):%Y-%m-%d} UTC", f"**Default branch:** `{result.default_branch or 'unknown'}`", f"**Project type:** {result.project_type}", "",
        "## Executive Summary", "", f"- Tools run: {', '.join(result.tools_run) or 'None'}", f"- Findings: {len(result.findings)}", f"- Safe fixes applied: {len(result.fixes_applied)}", f"- Scanner warnings: {len(result.warnings)}", "",
        "| Severity | Count |", "|---|---:|",
        *[f"| {severity} | {counts[severity]} |" for severity in SEVERITIES], "",
        "## Fixes Applied", "", *([f"- {item}" for item in result.fixes_applied] or ["- None."]), "",
        "## Findings", "",
    ]
    if result.findings:
        order = {severity: index for index, severity in enumerate(SEVERITIES)}
        for index, finding in enumerate(sorted(result.findings, key=lambda item: order[item.severity]), 1):
            lines.extend([f"### {index}. [{finding.severity}] {finding.title}", "", f"- Category: {finding.category}", f"- Path: `{finding.path or 'N/A'}`", f"- Line: `{finding.line or 'N/A'}`", f"- Detail: {finding.detail or 'No additional non-sensitive detail.'}", f"- Remediation: {finding.remediation or 'Review and remediate manually.'}", ""])
    else:
        lines.extend(["No findings were reported by the available automated checks. This is not proof that the repository is vulnerability-free.", ""])
    lines.extend(["## Manual Review Items", ""])
    manual = result.manual_review or ["Validate business logic, authorization boundaries, deployment configuration, and scanner findings manually."]
    lines.extend(f"- {item}" for item in manual)
    lines.extend(["", "## Scanner Warnings", ""])
    lines.extend([f"- {item}" for item in result.warnings] or ["- None."])
    lines.extend(["", "## Verification", "", "Before merging any proposed changes, run the repository's build, tests, and deployment-specific security checks.", ""])
    output = report_path(path, report_dir)
    output.write_text("\n".join(lines), encoding="utf-8")
    return output


def make_branch_name(prefix: str, repo: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", repo.lower().replace("/", "-"))[:40].strip("-")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{prefix.strip('/')}/{slug}-{stamp}-{uuid.uuid4().hex[:6]}"


def create_pr(path: Path, result: RepoResult) -> None:
    checkout = run(["git", "checkout", "-b", result.branch], cwd=path)
    if checkout.returncode != 0:
        warning(result, "git branch creation", checkout)
        return
    add = run(["git", "add", "--", *result.changed_files], cwd=path)
    if add.returncode != 0:
        warning(result, "git staging", add)
        return
    commit = run(["git", "commit", "-m", "security: add audit report and safe fixes"], cwd=path)
    if commit.returncode != 0:
        warning(result, "git commit", commit)
        return
    push = run(["git", "push", "--set-upstream", "origin", result.branch], cwd=path, timeout=600)
    if push.returncode != 0:
        warning(result, "git push", push)
        return
    counts = ", ".join(f"{severity}: {sum(f.severity == severity for f in result.findings)}" for severity in SEVERITIES)
    body = "\n".join([
        "## Security audit summary", "",
        f"- Tools run: {', '.join(result.tools_run) or 'None'}", f"- Findings: {len(result.findings)} ({counts})", f"- Files changed: {len(result.changed_files)}", "",
        "### Files changed", *[f"- `{name}`" for name in result.changed_files], "",
        "### Safe fixes applied", *([f"- {item}" for item in result.fixes_applied] or ["- None; this PR contains the audit report only."]), "",
        "### Manual review", *[f"- {item}" for item in (result.manual_review or ["Review unresolved findings and run the repository's build and test suite."])], "",
        "This pull request was created for human review. The agent will not merge it.",
    ])
    process = gh(["pr", "create", "--repo", result.repo, "--base", result.default_branch or "main", "--head", result.branch, "--title", "security: audit report and safe fixes", "--body", body], cwd=path)
    if process.returncode == 0:
        result.pr_url = process.stdout.strip()
    else:
        warning(result, "pull request creation", process)


def audit_repo(repo: str, workspace: Path, config: dict[str, Any], mode: str) -> RepoResult:
    result = RepoResult(repo=repo)
    settings = config.get("settings") if isinstance(config.get("settings"), dict) else {}
    report_dir = str(settings.get("report_dir", "security-reports"))
    target = workspace / safe_repo_dir(repo)
    try:
        result.default_branch = discover_default_branch(repo, result)
        cloned = clone_repo(repo, target, result.default_branch, result)
        result.project_type = detect_project_type(target)
        if cloned:
            if result.project_type in ("node", "mixed"):
                run_npm_audit(target, result)
            if result.project_type in ("python", "mixed"):
                run_pip_audit(target, result)
                run_bandit(target, result)
            run_semgrep(target, result)
            run_secret_metadata_scan(target, result)
            repository_hygiene(target, result)
            if mode == "fix":
                apply_safe_fixes(target, result)
        else:
            result.manual_review.append("Resolve repository access or clone failure and rerun the audit.")
    except Exception as exc:  # Per-repository containment is intentional.
        result.warnings.append(f"Unexpected repository error ({type(exc).__name__}); rerun with debug tooling locally.")
    finally:
        write_report(target, result, report_dir)
    if mode == "fix" and (target / ".git").exists():
        result.changed_files = git_changed_files(target)
        if result.changed_files:
            result.branch = make_branch_name(str(settings.get("branch_prefix", "security/audit-fixes")), repo)
            create_pr(target, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit GitHub repositories and optionally open PRs with safe fixes.")
    parser.add_argument("--config", type=Path, required=True, help="YAML file containing repos and settings")
    parser.add_argument("--mode", choices=("report", "fix"), default="report", help="report never writes to remotes; fix may open PRs")
    parser.add_argument("--repos", default="", help="comma-separated owner/repository override list")
    parser.add_argument("--workspace", type=Path, help="audit workspace (defaults to RUNNER_TEMP or system temp)")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        repos = parse_repos(config, args.repos)
    except (OSError, ValueError, yaml.YAMLError) as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2
    if not repos:
        print("Configuration error: no repositories were configured", file=sys.stderr)
        return 2
    base = Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir())
    workspace = (args.workspace or base / "security-audit-agent").resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    results: list[RepoResult] = []
    for repo in repos:
        print(f"Auditing {repo} in {args.mode} mode")
        result = audit_repo(repo, workspace, config, args.mode)
        results.append(result)
        print(f"{repo}: findings={len(result.findings)} warnings={len(result.warnings)} pr={result.pr_url or 'none'}")
    summary = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "mode": args.mode,
        "repositories": [{"repo": item.repo, "project_type": item.project_type, "findings": len(item.findings), "warnings": len(item.warnings), "changed_files": item.changed_files, "pr_url": item.pr_url} for item in results],
    }
    (workspace / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
