import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import express from "express";
import httpProxy from "http-proxy";
import { Octokit } from "@octokit/rest";
import { chromium } from "playwright";

dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "raliegh2";
const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_ROOT || "/tmp/raliegh-ai-workspaces",
);
const WORKSPACE_TTL_MS =
  Number(process.env.WORKSPACE_TTL_MINUTES || 60) * 60 * 1000;
const PREVIEW_TTL_MS =
  Number(process.env.PREVIEW_TTL_MINUTES || 30) * 60 * 1000;
const PREVIEW_AUTH_SECRET =
  process.env.PREVIEW_AUTH_SECRET || crypto.randomBytes(32).toString("hex");
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 1_000_000);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES || 200_000);

if (!API_KEY) {
  throw new Error(
    "API_KEY is required. Add a strong API key to the Render environment.",
  );
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const PROJECTS = {
  "raliegh-ai-control-center": {
    owner: GITHUB_OWNER,
    repo: "raliegh-ai-control-center",
  },
  "raliegh-cybersecurity-portfolio": {
    owner: GITHUB_OWNER,
    repo: "raliegh-cybersecurity-portfolio",
  },
  "teachplan-studio": {
    owner: GITHUB_OWNER,
    repo: "teachplan-studio",
  },
  demoralieghrepair: {
    owner: GITHUB_OWNER,
    repo: "demoralieghrepair",
  },
};

const ALLOWED_PROJECT_SCRIPTS = new Set([
  "install",
  "lint",
  "test",
  "build",
  "typecheck",
  "check",
]);

const BLOCKED_PATH_PARTS = new Set([
  ".git",
  "node_modules",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
]);

const LIST_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".bridge-artifacts",
]);

const workspaces = new Map();
const jobs = new Map();
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

proxy.on("error", (error, req, res) => {
  if (res && typeof res.writeHead === "function" && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
  }
  if (res && typeof res.end === "function") {
    res.end(
      JSON.stringify({
        success: false,
        error: `Preview proxy error: ${error.message}`,
      }),
    );
  }
});

function requireApiKey(req, res, next) {
  const providedKey = req.headers["x-api-key"];
  const left = Buffer.from(String(providedKey || ""));
  const right = Buffer.from(API_KEY);

  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized request.",
    });
  }

  next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function projectFor(projectKey) {
  const project = PROJECTS[projectKey];
  if (!project) {
    const error = new Error(`Unknown projectKey: ${projectKey}`);
    error.statusCode = 404;
    throw error;
  }
  return project;
}

function validateWorkspaceId(workspaceId) {
  if (!/^ws_[a-f0-9-]{36}$/.test(workspaceId)) {
    const error = new Error("Invalid workspace ID.");
    error.statusCode = 400;
    throw error;
  }
  return workspaceId;
}

function workspacePathFor(workspaceId) {
  validateWorkspaceId(workspaceId);
  const resolved = path.resolve(WORKSPACE_ROOT, workspaceId);
  if (!resolved.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) {
    const error = new Error("Workspace path escaped the approved root.");
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

function workspaceFor(workspaceId) {
  validateWorkspaceId(workspaceId);
  const workspace = workspaces.get(workspaceId);
  if (!workspace) {
    const error = new Error("Workspace not found or expired.");
    error.statusCode = 404;
    throw error;
  }
  workspace.lastActivityAt = Date.now();
  return workspace;
}

function validateRelativePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.length > 500 ||
    path.isAbsolute(relativePath)
  ) {
    const error = new Error("A valid relative file path is required.");
    error.statusCode = 400;
    throw error;
  }

  const normalized = path.normalize(relativePath).replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    parts.some((part) => part === ".." || BLOCKED_PATH_PARTS.has(part))
  ) {
    const error = new Error("The requested path is not allowed.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

async function safeFilePath(workspace, relativePath, { forWrite = false } = {}) {
  const normalized = validateRelativePath(relativePath);
  const root = workspace.path;
  const target = path.resolve(root, normalized);

  if (!target.startsWith(`${root}${path.sep}`)) {
    const error = new Error("File path escaped the workspace.");
    error.statusCode = 400;
    throw error;
  }

  const segments = normalized.split("/").filter(Boolean);
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        const error = new Error("Symbolic links are not allowed.");
        error.statusCode = 400;
        throw error;
      }
    } catch (error) {
      if (error.code === "ENOENT" && forWrite) break;
      throw error;
    }
  }

  return target;
}

function appendLimited(current, chunk) {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  const remaining = MAX_OUTPUT_BYTES - current.length;
  return current + chunk.toString("utf8").slice(0, remaining);
}

function redact(value) {
  let output = String(value || "");
  for (const secret of [
    GITHUB_TOKEN,
    API_KEY,
    process.env.PREVIEW_AUTH_SECRET,
  ].filter(Boolean)) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function runnerEnvironment(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: "/tmp/bridge-runner-home",
    CI: "1",
    NODE_ENV: "development",
    npm_config_cache: "/tmp/bridge-npm-cache",
    npm_config_update_notifier: "false",
    NO_COLOR: "1",
    ...extra,
  };

  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  );
}

function runProcess(
  command,
  args,
  {
    cwd,
    env = runnerEnvironment(),
    timeoutMs = 300_000,
    input,
    onOutput,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
      onOutput?.("stdout", redact(chunk.toString("utf8")));
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
      onOutput?.("stderr", redact(chunk.toString("utf8")));
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function cloneRepository(project, destination) {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  const repositoryUrl = `https://github.com/${project.owner}/${project.repo}.git`;
  let askpassPath;
  const env = {
    ...runnerEnvironment(),
    GIT_TERMINAL_PROMPT: "0",
  };

  if (GITHUB_TOKEN) {
    askpassPath = path.join(
      WORKSPACE_ROOT,
      `.askpass-${crypto.randomUUID()}.sh`,
    );
    await fs.writeFile(
      askpassPath,
      '#!/bin/sh\ncase "$1" in\n  *Username*) echo "x-access-token" ;;\n  *) echo "$GITHUB_TOKEN" ;;\nesac\n',
      { mode: 0o700 },
    );
    env.GIT_ASKPASS = askpassPath;
    env.GITHUB_TOKEN = GITHUB_TOKEN;
  }

  try {
    return await runProcess(
      "git",
      ["clone", "--depth", "1", repositoryUrl, destination],
      {
        cwd: WORKSPACE_ROOT,
        env,
        timeoutMs: 300_000,
      },
    );
  } finally {
    if (askpassPath) {
      await fs.rm(askpassPath, { force: true });
    }
  }
}

async function packageInfo(workspace) {
  const packageJsonPath = path.join(workspace.path, "package.json");
  const raw = await fs.readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(raw);

  let manager = "npm";
  if (fsSync.existsSync(path.join(workspace.path, "pnpm-lock.yaml"))) {
    manager = "pnpm";
  } else if (fsSync.existsSync(path.join(workspace.path, "yarn.lock"))) {
    manager = "yarn";
  }

  return {
    manager,
    packageJson,
    scripts: packageJson.scripts || {},
    dependencies: {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    },
  };
}

function commandForScript(info, scriptName) {
  if (!ALLOWED_PROJECT_SCRIPTS.has(scriptName)) {
    const error = new Error(`Script is not approved: ${scriptName}`);
    error.statusCode = 400;
    throw error;
  }

  if (scriptName === "install") {
    if (info.manager === "pnpm") {
      return ["corepack", ["pnpm", "install", "--frozen-lockfile"]];
    }
    if (info.manager === "yarn") {
      return ["corepack", ["yarn", "install", "--immutable"]];
    }
    if (fsSync.existsSync(path.join(info.workspacePath, "package-lock.json"))) {
      return ["npm", ["ci", "--no-audit", "--no-fund"]];
    }
    return ["npm", ["install", "--no-audit", "--no-fund"]];
  }

  if (!info.scripts[scriptName]) {
    const error = new Error(
      `package.json does not define the "${scriptName}" script.`,
    );
    error.statusCode = 400;
    throw error;
  }

  if (info.manager === "pnpm") {
    return ["corepack", ["pnpm", "run", scriptName]];
  }
  if (info.manager === "yarn") {
    return ["corepack", ["yarn", scriptName]];
  }
  return ["npm", ["run", scriptName]];
}

function createJob(workspace, type, task) {
  const jobId = `job_${crypto.randomUUID()}`;
  const job = {
    jobId,
    workspaceId: workspace.workspaceId,
    type,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stdout: "",
    stderr: "",
    result: null,
    error: null,
  };
  jobs.set(jobId, job);
  workspace.lastJobId = jobId;

  Promise.resolve()
    .then(() =>
      task((stream, text) => {
        const field = stream === "stderr" ? "stderr" : "stdout";
        job[field] = appendLimited(job[field], text);
      }),
    )
    .then((result) => {
      job.result = result;
      job.status = result?.exitCode === 0 || result?.success ? "completed" : "failed";
    })
    .catch((error) => {
      job.status = "failed";
      job.error = redact(error.message);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      workspace.lastActivityAt = Date.now();
    });

  return job;
}

function signWorkspaceCookie(workspaceId) {
  const signature = crypto
    .createHmac("sha256", PREVIEW_AUTH_SECRET)
    .update(workspaceId)
    .digest("hex");
  return `${workspaceId}.${signature}`;
}

function verifyWorkspaceCookie(value) {
  if (typeof value !== "string") return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;

  const workspaceId = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  const expected = crypto
    .createHmac("sha256", PREVIEW_AUTH_SECRET)
    .update(workspaceId)
    .digest("hex");

  const left = Buffer.from(suppliedSignature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return null;
  }

  return workspaceId;
}

function activePreviewFromRequest(req) {
  const workspaceId = verifyWorkspaceCookie(req.cookies.bridge_preview);
  if (!workspaceId) return null;
  const workspace = workspaces.get(workspaceId);
  if (!workspace?.preview || workspace.preview.status !== "running") return null;
  return workspace;
}

function isReservedBridgePath(requestPath) {
  return (
    requestPath === "/health" ||
    requestPath === "/projects" ||
    requestPath === "/create-task" ||
    requestPath === "/create-codex-brief" ||
    requestPath.startsWith("/workspaces") ||
    requestPath.startsWith("/jobs") ||
    requestPath.startsWith("/preview/")
  );
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selected = typeof address === "object" ? address.port : null;
      server.close(() => resolve(selected));
    });
  });
}

async function waitForPort(port, timeoutMs = 30_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection(
        { host: "127.0.0.1", port },
        () => {
          socket.destroy();
          resolve(true);
        },
      );
      socket.on("error", () => resolve(false));
      socket.setTimeout(1_000, () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

function previewCommand(info, port) {
  if (!info.scripts.dev) {
    const error = new Error('package.json must define a "dev" script.');
    error.statusCode = 400;
    throw error;
  }

  let args;
  if (info.manager === "pnpm") args = ["pnpm", "run", "dev", "--"];
  else if (info.manager === "yarn") args = ["yarn", "dev"];
  else args = ["run", "dev", "--"];

  const command = info.manager === "npm" ? "npm" : "corepack";
  const scriptText = String(info.scripts.dev);

  if (scriptText.includes("next")) {
    args.push("--hostname", "127.0.0.1", "--port", String(port));
  } else if (scriptText.includes("vite")) {
    args.push("--host", "127.0.0.1", "--port", String(port));
  }

  return [command, args];
}

async function stopPreviewProcess(workspace) {
  const preview = workspace.preview;
  if (!preview?.process) {
    if (preview) preview.status = "stopped";
    return;
  }

  preview.status = "stopping";
  preview.process.kill("SIGTERM");

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      preview.process.kill("SIGKILL");
      resolve();
    }, 5_000);
    preview.process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  preview.process = null;
  preview.status = "stopped";
}

async function listRepositoryFiles(directory, maxDepth = 6) {
  const results = [];

  async function walk(current, depth) {
    if (depth > maxDepth || results.length >= 2_000) return;
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= 2_000) break;
      if (LIST_SKIP_DIRS.has(entry.name)) continue;

      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).replaceAll("\\", "/");

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        results.push({ path: relative, type: "directory" });
        await walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        results.push({ path: relative, type: "file", size: stat.size });
      }
    }
  }

  await walk(directory, 0);
  return results;
}

// When a browser has an authenticated preview cookie, proxy non-bridge paths
// to that workspace's local development server. This makes absolute asset
// paths used by Vite/Next work without exposing extra Render ports.
app.use((req, res, next) => {
  const workspace = activePreviewFromRequest(req);
  if (!workspace || isReservedBridgePath(req.path)) return next();

  return proxy.web(req, res, {
    target: `http://127.0.0.1:${workspace.preview.port}`,
  });
});

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "GPT-Codex Bridge is running.",
    endpoints: [
      "/health",
      "/projects",
      "/create-task",
      "/create-codex-brief",
      "/workspaces",
      "/jobs/:jobId",
    ],
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "GPT-Codex Bridge is running.",
    workspaceCount: workspaces.size,
    activePreviewCount: [...workspaces.values()].filter(
      (item) => item.preview?.status === "running",
    ).length,
  });
});

app.get("/projects", requireApiKey, (req, res) => {
  res.json({ success: true, projects: Object.keys(PROJECTS) });
});

app.post(
  "/create-task",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const { projectKey, title, body, priority } = req.body;
    if (!projectKey || !title || !body) {
      return res.status(400).json({
        success: false,
        error: "projectKey, title, and body are required.",
      });
    }

    const project = projectFor(projectKey);
    const labels = ["codex-task"];
    if (priority) labels.push(`priority-${priority}`);

    const issue = await octokit.issues.create({
      owner: project.owner,
      repo: project.repo,
      title,
      body,
      labels,
    });

    res.json({
      success: true,
      issueUrl: issue.data.html_url,
      issueNumber: issue.data.number,
    });
  }),
);

app.post(
  "/create-codex-brief",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const {
      projectKey,
      featureName,
      objective,
      requirements = [],
      acceptanceCriteria = [],
      securityRequirements = [],
      testingInstructions = [],
    } = req.body;

    if (!projectKey || !featureName || !objective) {
      return res.status(400).json({
        success: false,
        error: "projectKey, featureName, and objective are required.",
      });
    }

    const project = projectFor(projectKey);
    const body = `## Objective
${objective}

## Requirements
${requirements.map((item) => `- ${item}`).join("\n")}

## Acceptance Criteria
${acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

## Security Requirements
${securityRequirements.map((item) => `- ${item}`).join("\n")}

## Testing Instructions
${testingInstructions.map((item) => `- ${item}`).join("\n")}
`;

    const issue = await octokit.issues.create({
      owner: project.owner,
      repo: project.repo,
      title: `Codex Brief: ${featureName}`,
      body,
      labels: ["codex-task", "codex-brief"],
    });

    res.json({
      success: true,
      issueUrl: issue.data.html_url,
      issueNumber: issue.data.number,
    });
  }),
);

app.post(
  "/workspaces",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const { projectKey, branchPrefix = "ai-workspace" } = req.body;
    const project = projectFor(projectKey);
    const workspaceId = `ws_${crypto.randomUUID()}`;
    const workspacePath = workspacePathFor(workspaceId);
    const safePrefix = String(branchPrefix)
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .slice(0, 30);
    const branch = `${safePrefix || "ai-workspace"}-${Date.now()}`;

    const workspace = {
      workspaceId,
      projectKey,
      path: workspacePath,
      branch,
      status: "creating",
      error: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      preview: null,
      lastJobId: null,
    };
    workspaces.set(workspaceId, workspace);

    Promise.resolve()
      .then(async () => {
        const clone = await cloneRepository(project, workspacePath);
        if (clone.exitCode !== 0) {
          throw new Error(clone.stderr || "Repository clone failed.");
        }

        const checkout = await runProcess(
          "git",
          ["checkout", "-b", branch],
          { cwd: workspacePath },
        );
        if (checkout.exitCode !== 0) {
          throw new Error(checkout.stderr || "Branch creation failed.");
        }

        workspace.status = "ready";
        workspace.lastActivityAt = Date.now();
      })
      .catch(async (error) => {
        workspace.status = "failed";
        workspace.error = redact(error.message);
        await fs.rm(workspacePath, { recursive: true, force: true });
      });

    res.status(202).json({
      success: true,
      workspaceId,
      projectKey,
      branch,
      status: workspace.status,
    });
  }),
);

app.get(
  "/workspaces/:workspaceId",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    res.json({
      success: true,
      workspace: {
        workspaceId: workspace.workspaceId,
        projectKey: workspace.projectKey,
        branch: workspace.branch,
        status: workspace.status,
        error: workspace.error,
        createdAt: new Date(workspace.createdAt).toISOString(),
        lastActivityAt: new Date(workspace.lastActivityAt).toISOString(),
        lastJobId: workspace.lastJobId,
        previewStatus: workspace.preview?.status || "not-started",
      },
    });
  }),
);

app.get(
  "/workspaces/:workspaceId/files",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    if (workspace.status !== "ready") {
      return res.status(409).json({
        success: false,
        error: `Workspace is ${workspace.status}.`,
      });
    }

    const maxDepth = Math.min(
      Math.max(Number(req.query.maxDepth || 6), 1),
      10,
    );
    const files = await listRepositoryFiles(workspace.path, maxDepth);
    res.json({ success: true, files });
  }),
);

app.get(
  "/workspaces/:workspaceId/file",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    const target = await safeFilePath(workspace, String(req.query.path || ""));
    const stat = await fs.stat(target);

    if (!stat.isFile()) {
      return res.status(400).json({
        success: false,
        error: "The requested path is not a file.",
      });
    }
    if (stat.size > MAX_FILE_BYTES) {
      return res.status(413).json({
        success: false,
        error: `File exceeds the ${MAX_FILE_BYTES}-byte read limit.`,
      });
    }

    const content = await fs.readFile(target, "utf8");
    res.json({
      success: true,
      path: path.relative(workspace.path, target).replaceAll("\\", "/"),
      content,
    });
  }),
);

app.post(
  "/workspaces/:workspaceId/patch",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    const { changes } = req.body;

    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 20) {
      return res.status(400).json({
        success: false,
        error: "changes must contain between 1 and 20 file replacements.",
      });
    }

    const changedPaths = [];
    for (const change of changes) {
      if (typeof change?.content !== "string") {
        return res.status(400).json({
          success: false,
          error: "Every change requires string path and content fields.",
        });
      }
      if (Buffer.byteLength(change.content, "utf8") > MAX_FILE_BYTES) {
        return res.status(413).json({
          success: false,
          error: `A file exceeds the ${MAX_FILE_BYTES}-byte write limit.`,
        });
      }

      const target = await safeFilePath(workspace, change.path, {
        forWrite: true,
      });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, change.content, "utf8");
      changedPaths.push(validateRelativePath(change.path));
    }

    res.json({ success: true, changedPaths });
  }),
);

app.post(
  "/workspaces/:workspaceId/scripts",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    const scriptName = String(req.body.script || "");
    const info = await packageInfo(workspace);
    info.workspacePath = workspace.path;
    const [command, args] = commandForScript(info, scriptName);

    const job = createJob(workspace, `script:${scriptName}`, (onOutput) =>
      runProcess(command, args, {
        cwd: workspace.path,
        timeoutMs: scriptName === "install" ? 900_000 : 600_000,
        onOutput,
      }),
    );

    res.status(202).json({
      success: true,
      jobId: job.jobId,
      status: job.status,
    });
  }),
);

app.get(
  "/jobs/:jobId",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found or expired.",
      });
    }
    res.json({ success: true, job });
  }),
);

app.get(
  "/workspaces/:workspaceId/diff",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    const result = await runProcess(
      "git",
      ["diff", "--no-ext-diff", "--"],
      { cwd: workspace.path, timeoutMs: 30_000 },
    );
    res.json({
      success: result.exitCode === 0,
      diff: result.stdout,
      stderr: result.stderr,
    });
  }),
);

app.post(
  "/workspaces/:workspaceId/preview",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    if (workspace.preview?.status === "running") {
      return res.json({
        success: true,
        status: "running",
        previewUrl: workspace.preview.url,
      });
    }

    const info = await packageInfo(workspace);
    if (!fsSync.existsSync(path.join(workspace.path, "node_modules"))) {
      return res.status(409).json({
        success: false,
        error:
          'Dependencies are not installed. Run the approved "install" script first.',
      });
    }

    const port = await findFreePort();
    const [command, args] = previewCommand(info, port);
    const previewToken = crypto.randomBytes(24).toString("hex");
    const baseUrl = (
      process.env.PUBLIC_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      `${req.protocol}://${req.get("host")}`
    ).replace(/\/$/, "");
    const previewUrl = `${baseUrl}/preview/${workspace.workspaceId}/access?token=${previewToken}`;

    const child = spawn(command, args, {
      cwd: workspace.path,
      env: runnerEnvironment({
        HOST: "127.0.0.1",
        PORT: String(port),
        BROWSER: "none",
      }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    workspace.preview = {
      status: "starting",
      port,
      process: child,
      token: previewToken,
      url: previewUrl,
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
      expiresAt: Date.now() + PREVIEW_TTL_MS,
    };

    child.stdout.on("data", (chunk) => {
      workspace.preview.stdout = appendLimited(
        workspace.preview.stdout,
        redact(chunk.toString("utf8")),
      );
    });
    child.stderr.on("data", (chunk) => {
      workspace.preview.stderr = appendLimited(
        workspace.preview.stderr,
        redact(chunk.toString("utf8")),
      );
    });
    child.on("close", (code, signal) => {
      if (workspace.preview?.status !== "stopping") {
        workspace.preview.status = code === 0 ? "stopped" : "failed";
      }
      workspace.preview.exitCode = code;
      workspace.preview.signal = signal;
      workspace.preview.process = null;
    });

    Promise.resolve()
      .then(() => waitForPort(port))
      .then((ready) => {
        if (!workspace.preview) return;
        workspace.preview.status = ready ? "running" : "failed";
        if (!ready) {
          workspace.preview.stderr = appendLimited(
            workspace.preview.stderr,
            "\nPreview server did not become ready within 30 seconds.",
          );
          child.kill("SIGTERM");
        }
      });

    res.status(202).json({
      success: true,
      status: "starting",
      previewUrl,
      expiresAt: new Date(workspace.preview.expiresAt).toISOString(),
    });
  }),
);

app.get(
  "/workspaces/:workspaceId/preview",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    const preview = workspace.preview;

    res.json({
      success: true,
      preview: preview
        ? {
            status: preview.status,
            previewUrl: preview.url,
            startedAt: new Date(preview.startedAt).toISOString(),
            expiresAt: new Date(preview.expiresAt).toISOString(),
            exitCode: preview.exitCode ?? null,
          }
        : { status: "not-started" },
    });
  }),
);

app.get(
  "/workspaces/:workspaceId/preview/logs",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    res.json({
      success: true,
      status: workspace.preview?.status || "not-started",
      stdout: workspace.preview?.stdout || "",
      stderr: workspace.preview?.stderr || "",
    });
  }),
);

app.delete(
  "/workspaces/:workspaceId/preview",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    await stopPreviewProcess(workspace);
    res.json({ success: true, status: "stopped" });
  }),
);

app.post(
  "/workspaces/:workspaceId/screenshots",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    if (workspace.preview?.status !== "running") {
      return res.status(409).json({
        success: false,
        error: "The preview must be running before a screenshot is captured.",
      });
    }

    const routePath = String(req.body.path || "/");
    if (!routePath.startsWith("/") || routePath.startsWith("//")) {
      return res.status(400).json({
        success: false,
        error: "Screenshot path must be a local route beginning with /.",
      });
    }

    const width = Math.min(
      Math.max(Number(req.body.viewport?.width || 1440), 320),
      2000,
    );
    const height = Math.min(
      Math.max(Number(req.body.viewport?.height || 1000), 480),
      3000,
    );

    const artifactDirectory = path.join(
      workspace.path,
      ".bridge-artifacts",
    );
    await fs.mkdir(artifactDirectory, { recursive: true });

    const filename = `screenshot-${Date.now()}-${width}x${height}.png`;
    const destination = path.join(artifactDirectory, filename);
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      await page.goto(
        `http://127.0.0.1:${workspace.preview.port}${routePath}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        },
      );
      await page.waitForTimeout(1_000);
      await page.screenshot({ path: destination, fullPage: true });
    } finally {
      await browser.close();
    }

    const baseUrl = (
      process.env.PUBLIC_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      `${req.protocol}://${req.get("host")}`
    ).replace(/\/$/, "");
    const screenshotUrl =
      `${baseUrl}/workspaces/${workspace.workspaceId}/screenshots/` +
      `${filename}?token=${workspace.preview.token}`;

    res.json({
      success: true,
      filename,
      viewport: { width, height },
      screenshotUrl,
    });
  }),
);

app.get(
  "/workspaces/:workspaceId/screenshots/:filename",
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    if (
      !workspace.preview?.token ||
      req.query.token !== workspace.preview.token ||
      !/^screenshot-[0-9]+-[0-9]+x[0-9]+\.png$/.test(req.params.filename)
    ) {
      return res.status(401).json({
        success: false,
        error: "Invalid screenshot access token.",
      });
    }

    const file = path.join(
      workspace.path,
      ".bridge-artifacts",
      req.params.filename,
    );
    res.sendFile(file);
  }),
);

app.get(
  "/preview/:workspaceId/access",
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    if (
      workspace.preview?.status !== "running" ||
      req.query.token !== workspace.preview.token
    ) {
      return res.status(401).send("Preview link is invalid or has expired.");
    }

    res.cookie("bridge_preview", signWorkspaceCookie(workspace.workspaceId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: PREVIEW_TTL_MS,
      path: "/",
    });
    res.redirect("/");
  }),
);

app.get("/preview/exit", (req, res) => {
  res.clearCookie("bridge_preview", { path: "/" });
  res.json({ success: true, message: "Preview cookie cleared." });
});

app.delete(
  "/workspaces/:workspaceId",
  requireApiKey,
  asyncRoute(async (req, res) => {
    const workspace = workspaceFor(req.params.workspaceId);
    await stopPreviewProcess(workspace);
    await fs.rm(workspace.path, { recursive: true, force: true });
    workspaces.delete(workspace.workspaceId);

    for (const [jobId, job] of jobs.entries()) {
      if (job.workspaceId === workspace.workspaceId) jobs.delete(jobId);
    }

    res.json({ success: true, status: "deleted" });
  }),
);

app.use((error, req, res, next) => {
  console.error(redact(error.stack || error.message));
  if (res.headersSent) return next(error);
  res.status(error.statusCode || 500).json({
    success: false,
    error: redact(error.message || "Unexpected server error."),
  });
});

await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
await fs.mkdir("/tmp/bridge-runner-home", { recursive: true });
await fs.mkdir("/tmp/bridge-npm-cache", { recursive: true });

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  const cookieHeader = req.headers.cookie || "";
  const cookie = Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((parts) => parts.length === 2),
  );
  const workspaceId = verifyWorkspaceCookie(
    decodeURIComponent(cookie.bridge_preview || ""),
  );
  const workspace = workspaceId ? workspaces.get(workspaceId) : null;

  if (!workspace?.preview || workspace.preview.status !== "running") {
    socket.destroy();
    return;
  }

  proxy.ws(req, socket, head, {
    target: `ws://127.0.0.1:${workspace.preview.port}`,
  });
});

setInterval(async () => {
  const now = Date.now();

  for (const workspace of workspaces.values()) {
    const previewExpired =
      workspace.preview &&
      workspace.preview.status !== "stopped" &&
      workspace.preview.expiresAt <= now;

    if (previewExpired) {
      await stopPreviewProcess(workspace).catch(() => {});
    }

    if (now - workspace.lastActivityAt > WORKSPACE_TTL_MS) {
      await stopPreviewProcess(workspace).catch(() => {});
      await fs.rm(workspace.path, { recursive: true, force: true });
      workspaces.delete(workspace.workspaceId);
    }
  }

  for (const [jobId, job] of jobs.entries()) {
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : null;
    if (finished && now - finished > WORKSPACE_TTL_MS) jobs.delete(jobId);
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`GPT-Codex Bridge running on port ${PORT}`);
});
