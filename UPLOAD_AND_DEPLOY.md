# Secure Workspace and Preview Upgrade

These files are prepared for the current root-level structure of
`raliegh2/raliegh-ai-control-center`.

## Files to replace or add

Replace:

- `server.js`
- `package.json`
- `.env.example`
- `openapi.yaml`

Add:

- `Dockerfile`
- `.dockerignore`

Do **not** upload a real `.env` file or place tokens in GitHub.

## Upload through GitHub

1. Open the repository.
2. Create a branch named `feature/workspace-runner`.
3. Upload the six files from this package to the repository root.
4. Allow replacement of the four existing files.
5. Commit to the feature branch.
6. Review the diff before merging.

The existing `package-lock.json` belongs to the old dependency set. Delete it
before the first Docker deployment, or run `npm install` locally and commit the
newly generated lock file.

## Render configuration

Use a **Docker** web service so the Playwright browser is available.

Set these environment variables in Render:

- `GITHUB_TOKEN`
- `API_KEY`
- `GITHUB_OWNER=raliegh2`
- `PREVIEW_AUTH_SECRET`
- `PUBLIC_BASE_URL=https://raliegh-ai-control-center.onrender.com`
- `WORKSPACE_ROOT=/tmp/raliegh-ai-workspaces`
- `WORKSPACE_TTL_MINUTES=60`
- `PREVIEW_TTL_MINUTES=30`

Generate strong secrets locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use a fine-grained GitHub token restricted to the approved repositories.
Contents read access is enough for workspace cloning. Issue write access is
needed for the existing task/brief operations.

## Update the GPT Action

After Render reports a successful deployment:

1. Replace `YOUR-BRIDGE-SERVICE` in `openapi.yaml` with the real Render host.
2. Open the GPT editor.
3. Open **Actions** and select the current bridge action.
4. Replace the old schema with the new `openapi.yaml`.
5. Configure API-key authentication using the same `API_KEY` value.
6. Save and test `checkBridgeHealth`.
7. Test `createWorkspace` with `teachplan-studio`.
8. Poll `getWorkspaceStatus` until it reports `ready`.
9. Run `runProjectScript` with `install`.
10. Poll `getJobStatus`.
11. Call `startPreview`, then poll `getPreviewStatus`.

## Expected workflow

```text
createWorkspace
getWorkspaceStatus
listWorkspaceFiles / readWorkspaceFile
applyWorkspacePatch
runProjectScript: install
getJobStatus
runProjectScript: build
getJobStatus
startPreview
getPreviewStatus
capturePreviewScreenshot
getGitDiff
stopPreview
cleanupWorkspace
```

## Important security boundary

This upgrade intentionally does not expose an arbitrary shell command. It runs
only approved package scripts and only for repositories in the hard-coded
allowlist.

It is suitable for trusted personal repositories in a temporary Render
container. It is not a complete multi-tenant sandbox. Repository build and
development scripts execute code, so do not add untrusted third-party
repositories to the allowlist. Keep production credentials out of the runner
environment.
