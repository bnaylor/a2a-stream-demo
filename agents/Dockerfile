# syntax=docker/dockerfile:1
FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY protocol/package.json protocol/
COPY agents/common/package.json agents/common/
COPY agents/worker/package.json agents/worker/
COPY agents/chatops/package.json agents/chatops/
RUN npm ci --omit=dev && npm install -g tsx@4
COPY protocol/ protocol/
COPY agents/ agents/
# Non-root: the Agent SDK needs a writable HOME and config dir.
RUN useradd -m -u 1000 agent && mkdir -p /home/agent/.claude && chown -R agent /home/agent /app
USER agent
ENV HOME=/home/agent CLAUDE_CONFIG_DIR=/home/agent/.claude CLAUDE_CODE_DISABLE_AUTO_MEMORY=1

FROM base AS worker
CMD ["tsx", "agents/worker/src/main.ts"]

FROM base AS chatops
CMD ["tsx", "agents/chatops/src/main.ts"]
