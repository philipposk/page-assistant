# Standalone @page-assistant/server (LLM + voice proxy, optional /v1/agent + llm.txt).
#
# Build:  docker build -t page-assistant .
# Run:    docker run -p 8787:8787 \
#           -e OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY / OPENROUTER_API_KEY
#           -e PA_AUTH_TOKEN=long-secret \  # protect spend + agent routes in prod
#           -e PA_CORS_ORIGIN=https://yourapp.com \
#           page-assistant
#
# This image runs the plain proxy (no /v1/agent, no llm.txt). To serve capabilities,
# see the "Deploying" section in README.md — mount your own config with the CLI or
# import createServer() in your own entrypoint.

FROM node:22-alpine AS build
WORKDIR /app

# Install with the committed lockfile for reproducible builds. Copy the manifests for
# every workspace first so npm can resolve the workspace graph before the sources land
# (keeps this layer cached when only source changes).
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/widget/package.json packages/widget/
COPY packages/server/package.json packages/server/
COPY packages/mcp/package.json packages/mcp/
COPY packages/cli/package.json packages/cli/
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime image: ship node_modules + built dist only, no toolchain. ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The server listens on PORT (default 8787). Override at run time with -e PORT=...
ENV PORT=8787

# Run as the non-root user shipped in the node image.
COPY --from=build --chown=node:node /app /app
USER node

EXPOSE 8787

# The server bin reads PORT from the environment and binds 0.0.0.0.
CMD ["node", "packages/server/dist/bin.js"]
