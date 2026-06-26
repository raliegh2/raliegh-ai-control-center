FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /tmp/raliegh-ai-workspaces \
    /tmp/bridge-runner-home \
    /tmp/bridge-npm-cache \
    && chown -R pwuser:pwuser /app \
    /tmp/raliegh-ai-workspaces \
    /tmp/bridge-runner-home \
    /tmp/bridge-npm-cache

USER pwuser

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
