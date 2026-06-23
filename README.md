# GPT-Codex Bridge

This small Node.js app lets a Custom GPT create GitHub issues and Codex-ready briefs for your projects.

## Setup

Install dependencies:

```bash
npm install
```

Create your environment file:

```bash
cp .env.example .env
```

Edit `.env` and add your GitHub token:

```env
GITHUB_TOKEN=your_github_token_here
API_KEY=change_this_to_a_strong_secret
PORT=3000
```

## Configure projects

Open `server.js` and replace `YOUR_GITHUB_USERNAME` with your actual GitHub username.

Example:

```js
const projects = {
  "church-visitor-app": {
    owner: "ralieghsamuelbarnett",
    repo: "church-visitor-app",
  },
};
```

Add more projects as needed.

## Run locally

```bash
npm start
```

Test the server:

```bash
curl http://localhost:3000/health
```

Create a task:

```bash
curl -X POST http://localhost:3000/create-task \
-H "Content-Type: application/json" \
-H "x-api-key: change_this_to_a_strong_secret" \
-d '{
  "projectKey": "church-visitor-app",
  "title": "Build secure login system",
  "body": "Create a login system with test credentials, hashed passwords, session protection, and role-based access.",
  "priority": "high"
}'
```

## Deploy

Deploy this folder to Render, Railway, Fly.io, or another Node.js hosting platform.

After deployment, update `openapi.yaml`:

```yaml
servers:
  - url: https://YOUR-DEPLOYED-BRIDGE-URL.com
```

Then paste the OpenAPI schema into your Custom GPT Action settings.

## Custom GPT instruction

Use this instruction in your Custom GPT:

```text
You are my project manager and Codex task controller.

When I ask to build or modify an app:
1. Break the request into clear development tasks.
2. Use the createCodexTask or createCodexBrief action to create GitHub issues.
3. Each task must include objective, files likely affected, acceptance criteria, security requirements, and testing instructions.
4. Do not write vague tasks.
5. Prioritize authentication, data protection, input validation, and role-based access.
6. After Codex completes a task, review the changes and create follow-up tasks if needed.
```
