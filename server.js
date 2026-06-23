import express from "express";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Approved GitHub repositories
// The projectKey is what your Custom GPT will use.
// The repo value must match the actual GitHub repository name.
const PROJECTS = {
  "raliegh-ai-control-center": {
    owner: process.env.GITHUB_OWNER || "raliegh2",
    repo: "raliegh-ai-control-center",
  },

  "raliegh-cybersecurity-portfolio": {
    owner: process.env.GITHUB_OWNER || "raliegh2",
    repo: "raliegh-cybersecurity-portfolio",
  },

  "teachplan-studio": {
    owner: process.env.GITHUB_OWNER || "raliegh2",
    repo: "teachplan-studio",
  },

  "demoralieghrepair": {
    owner: process.env.GITHUB_OWNER || "raliegh2",
    repo: "demoralieghrepair",
  },
};

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const providedKey = req.headers["x-api-key"];

  if (providedKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized request.",
    });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "GPT-Codex Bridge is running.",
    endpoints: ["/health", "/projects", "/create-task", "/create-codex-brief"],
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "GPT-Codex Bridge is running.",
  });
});

app.get("/projects", requireApiKey, (req, res) => {
  res.json({
    success: true,
    projects: Object.keys(PROJECTS),
  });
});

app.post("/create-task", requireApiKey, async (req, res) => {
  try {
    const { projectKey, title, body, priority } = req.body;

    if (!projectKey || !title || !body) {
      return res.status(400).json({
        success: false,
        error: "projectKey, title, and body are required.",
      });
    }

    const project = PROJECTS[projectKey];

    if (!project) {
      return res.status(404).json({
        success: false,
        error: `Unknown projectKey: ${projectKey}`,
      });
    }

    const labels = ["codex-task"];

    if (priority) {
      labels.push(`priority-${priority}`);
    }

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
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/create-codex-brief", requireApiKey, async (req, res) => {
  try {
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

    const project = PROJECTS[projectKey];

    if (!project) {
      return res.status(404).json({
        success: false,
        error: `Unknown projectKey: ${projectKey}`,
      });
    }

    const body = `
## Objective
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
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`GPT-Codex Bridge running on port ${PORT}`);
});